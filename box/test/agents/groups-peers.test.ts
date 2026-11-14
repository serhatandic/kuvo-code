import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../../src/agents/events"
import { server } from "../../src/agents/groups/api"
import { SeatServer, activityEvery, aliveEvery, askAgainAfter, awayAfter, awayKept, reportBytes, type Clock, type PeerBot, type SeatMail } from "../../src/agents/groups/peer"
import { clientMessage, joinable } from "../../src/agents/groups/link"
import { LinkDirectory, PeerPost, gaveUp, peerRoutes, receive, type PeerParts } from "../../src/agents/groups/post"
import { GroupRunner, transcriptMailBytes } from "../../src/agents/groups/runner"
import { stamp, type Group, type GroupMessage } from "../../src/agents/groups/rules"
import { GroupStore } from "../../src/agents/groups/store"
import { queueFiles, readQueues, waitingFile } from "../../src/shared/queues"
import { Engine } from "./support/engine"

// Group chats across your computers (PROTOCOL.md, "Peers": seat): a chat lives on one computer and
// runs there, and a bot that lives on another takes its turn there, in a seat of that computer's
// own, with only the words going between them. Here, in-memory computers, each with its real
// bridge parts (its post, its directory of your other computers, its seats and its chats) and a
// stand-in engine whose seats answer with their bot's next line, on a stand-in relay that plays
// each box's link: it follows what the post sends, and can lose, hold back, reorder and repeat it.

/** Waits that look again only when something happened: a runner told something, an engine was asked something, or mail went. */
const wakes = new Set<() => void>()
function beat() {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) {
    await new Promise<void>((resolve) => {
      const wake = () => {
        wakes.delete(wake)
        resolve()
      }
      wakes.add(wake)
    })
  }
}

/** A clock a test moves on by hand: what comes due goes in its order, what that sets up too. */
class HandClock implements Clock {
  private time = Date.now()
  private timers: { at: number; work: () => void }[] = []
  now() {
    return this.time
  }
  setTimeout(work: () => void, ms: number) {
    const timer = { at: this.time + ms, work }
    this.timers.push(timer)
    return timer
  }
  clearTimeout(timer: unknown) {
    this.timers = this.timers.filter((each) => each !== timer)
  }
  advance(ms: number) {
    const end = this.time + ms
    for (;;) {
      const due = this.timers.filter((each) => each.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((each) => each !== due)
      this.time = due.at
      due.work()
    }
    this.time = end
  }
}

interface Carried {
  from: string
  to: string
  mail: SeatMail
  durable: boolean
}

/**
 * The relay, and each box's link on it: what a box's post sends goes to the box it's for. What goes
 * now is lost when it's away (or when a test loses it); what mustn't be lost waits for a box that's
 * away, and can be held back to come later, out of order, or come twice.
 */
class Relay {
  boxes = new Map<string, Box>()
  away = new Set<string>()
  /** Every mail sent, by whom to whom. */
  sent: Carried[] = []
  /** Mail that goes now, lost on the way: the first that each of these matches. */
  loses: ((each: Carried) => boolean)[] = []
  lost: Carried[] = []
  /** What mustn't be lost, held back while this matches it (`release` gives it), and given twice. */
  holding?: (each: Carried) => boolean
  held: Carried[] = []
  twice = false
  private waiting: Carried[] = []

  carry(each: Carried) {
    this.sent.push(structuredClone(each))
    beat()
    if (!each.durable) {
      const lose = this.loses.findIndex((test) => test(each))
      if (lose >= 0) {
        this.loses.splice(lose, 1)
        this.lost.push(each)
        return
      }
      if (!this.away.has(each.to)) this.give(each)
      return
    }
    if (this.holding?.(each)) return void this.held.push(each)
    if (this.away.has(each.to)) return void this.waiting.push(each)
    this.give(each)
  }

  /** What was held back, given now: as it was sent, or the other way round. */
  release(order: "as sent" | "reversed") {
    const held = order === "reversed" ? [...this.held].reverse() : this.held
    this.held = []
    this.holding = undefined
    for (const each of held) this.give(each)
  }

  private give(each: Carried) {
    for (let time = 0; time < (each.durable && this.twice ? 2 : 1); time++) {
      queueMicrotask(() => this.boxes.get(each.to)?.receive(each.from, structuredClone(each.mail)))
    }
  }

  back(box: string) {
    this.away.delete(box)
    for (const each of this.waiting.filter((one) => one.to === box)) this.give(each)
    this.waiting = this.waiting.filter((one) => one.to !== box)
  }

  /** Mail as if from `from`, whatever it says. */
  forge(from: string, to: string, mail: SeatMail) {
    this.boxes.get(to)?.receive(from, mail)
  }
}

/** A box's real store, which says when it kept how a turn for a chat elsewhere went, for a test to look again. */
class Store extends GroupStore {
  override keepPeerTurns(turns: Parameters<GroupStore["keepPeerTurns"]>[0]) {
    super.keepPeerTurns(turns)
    beat()
  }
}

/** One of your computers: its engine, its bots, its group chats, and its bridge's part in chats across them. */
class Box {
  readonly root = mkdtempSync(join(tmpdir(), "kuvo-peers-"))
  readonly engine = new Engine(beat)
  readonly store: GroupStore
  readonly runner: GroupRunner
  readonly post: PeerPost
  readonly directory: LinkDirectory
  /** Its box's queues: a conversation you stop there is noted in them. */
  readonly queues = queueFiles(join(this.root, "run"))
  parts: PeerParts
  private following = new AbortController()
  /** Whether its seats' bridge as it runs now is heard: one restarted stands in for the last, which says nothing more. */
  private bridge = { on: true }

  constructor(
    readonly key: string,
    readonly relay: Relay,
    readonly clock?: Clock,
  ) {
    this.store = new Store(join(this.root, "groups"), join(this.root, "bots"))
    this.post = new PeerPost(join(this.root, "peer-outbox.json"))
    this.directory = new LinkDirectory(this.post, clock)
    this.runner = new GroupRunner({
      store: this.store, engine: server(this.engine.url, "x"), bridge: () => undefined, trash: join(this.root, "trash"), pace: 0.05, place: key, peers: this.directory, queues: this.queues,
    })
    this.parts = { post: this.post, directory: this.directory, server: this.seatServer(), runner: this.runner }
    relay.boxes.set(key, this)
    void this.link()
  }

  private seatServer() {
    const bridge = this.bridge
    const transport = { send: (to: string, mail: SeatMail, durable: boolean) => void (bridge.on && this.post.send(to, mail, durable)) }
    return new SeatServer(this.runner.seats, transport, { store: this.store, remembered: (from, memory) => this.runner.remembered(from, memory) }, this.clock)
  }

  /** Its bridge's seats started again, as after the bridge restarted: what it held only in memory is gone, and the one before says nothing more. */
  restartSeats() {
    this.bridge.on = false
    this.bridge = { on: true }
    this.parts.server = this.seatServer()
    this.parts.server.start()
  }

  /** The box's link: follows what its post sends, carries it on the relay, and says it has what mustn't be lost. */
  private async link() {
    const reader = this.post.follow(this.following.signal).body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (line.durable) this.post.sent([line.id])
        this.relay.carry({ from: this.key, to: line.to, mail: line.mail, durable: line.durable })
      }
    }
  }

  /** What came to it, as it came. */
  readonly got: SeatMail[] = []

  receive(from: string, mail: SeatMail) {
    this.got.push(mail)
    receive(this.parts, from, mail)
    beat()
  }

  /** Its link gave up a letter to `to` (sent at `at`): too long without that computer saying it has it. */
  gaveUp(to: string, mail: SeatMail, at = Date.now()) {
    gaveUp(this.parts, to, mail, at)
    beat()
  }

  /** Who its link says your other computers and their bots are. */
  knows(computers: { key: string; name: string; seats?: boolean; bots?: PeerBot[] }[]) {
    this.directory.set({
      boxes: computers.map(({ key, name, seats }) => ({ key, name, seats: seats ?? true })),
      bots: computers.flatMap((computer) => computer.bots ?? []),
    })
  }

  bot(id: string, name: string) {
    const folder = join(this.root, "bots", id)
    mkdirSync(join(folder, "workspace"), { recursive: true })
    writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id, name, job: `${name}'s job`, look: { color: "mint", shape: "round", face: "calm" }, model: { id: "m", providerID: "p" }, created: stamp(), updated: stamp() }))
    writeFileSync(join(folder, "session"), "ses_own_" + name)
    writeFileSync(join(folder, "MEMORY.md"), `# ${name}'s memory\n`)
    return { id, name, job: `${name}'s job`, box: this.key } satisfies PeerBot
  }

  stop() {
    this.following.abort()
    this.engine.stop()
    rmSync(this.root, { recursive: true, force: true })
  }
}

const team = (members = ["bot_ada", "bot_ben"]): Group => ({ id: "grp_team000001", name: "Team", members, seats: {}, heard: {}, created: stamp() })
const id = "grp_team000001"

let relay: Relay
let host: Box
let home: Box
let unsubscribe: () => void

/** The chat's computer (this Mac's stand-in, `key_mac`), with Ada; Ben lives on devbox. */
function hostWith(clock?: Clock) {
  const box = new Box("key_mac", relay, clock)
  box.bot("bot_ada", "Ada")
  box.knows([{ key: "key_devbox", name: "devbox", bots: [{ id: "bot_ben", name: "Ben", job: "Ben's job", box: "key_devbox", session: "ses_own_Ben" }] }])
  return box
}

beforeEach(() => {
  relay = new Relay()
  home = new Box("key_devbox", relay)
  home.bot("bot_ben", "Ben")
  home.knows([{ key: "key_mac", name: "mac" }])
  host = hostWith()
  unsubscribe = subscribe(() => beat())
})

afterEach(() => {
  unsubscribe()
  host.runner.stop(id)
  host.stop()
  home.stop()
})

const said = (box: Box) => box.runner.get(id)?.messages ?? []
const over = (box: Box, done: () => boolean) => until(() => !box.runner.talk(id).discussing && done())
const turns = () => relay.sent.filter((each) => each.mail.kind === "turn")

/** The host on a clock of the test's, Ben's computer as it was. */
function hostOnClock() {
  relay.boxes.delete("key_mac")
  host.stop()
  const clock = new HandClock()
  host = hostWith(clock)
  return clock
}

/** Ben's computer on a clock of the test's, as it was otherwise. */
function homeOnClock() {
  relay.boxes.delete("key_devbox")
  home.stop()
  const clock = new HandClock()
  home = new Box("key_devbox", relay, clock)
  home.bot("bot_ben", "Ben")
  home.knows([{ key: "key_mac", name: "mac" }])
  return clock
}

const day = 86_400_000
const reports = () => relay.sent.filter((each) => each.mail.kind === "report").map((each) => (each.mail as any).result)

describe("a group chat with a bot on another of your computers", () => {
  test("the bot takes its turn on its own computer, in a seat there, and its words reach the chat", async () => {
    host.engine.lines = { Ada: ["&Ben, is the build green?", "PASS"] }
    home.engine.lines = { Ben: ["Green since this morning."] }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Ready to ship?")
    await over(host, () => said(host).some((message) => message.author === "bot_ben"))
    expect(said(host).filter((message) => message.kind === "message").map((message) => [message.author ?? "you", message.text])).toEqual([
      ["you", "Ready to ship?"],
      ["bot_ada", "&Ben, is the build green?"],
      ["bot_ben", "Green since this morning."],
    ])
    // Its seat is on its own computer's engine, told who it is and who it's with; none here.
    expect(home.engine.seatsMade()).toEqual(["Ben in Team"])
    expect(host.engine.seatsMade()).not.toContain("Ben in Team")
    const told = home.engine.requests.find((request) => request.method === "PUT" && request.path.endsWith("/instructions/entries/kuvo.seat"))!
    expect(told.body.value).toContain("You are Ben, one of the user's bots in Kuvo Code: Ben's job.")
    expect(told.body.value).toContain("Ada (Ada's job), and you. Ada leads it.")
    const kept = host.runner.get(id)!.group
    expect(kept.seatBoxes).toEqual({ bot_ben: "key_devbox" })
    expect(kept.heard.bot_ben).toBeDefined()
    // Only the words went between them.
    expect(relay.sent.every((each) => ["turn", "state", "result"].includes(each.mail.kind))).toBe(true)
  })

  test("a bot a move holds on its own computer sits its turn out there, and the chat says why", async () => {
    writeFileSync(join(home.root, "bots", "bot_ben", "paused"), "moving")
    host.engine.lines = { Ada: ["&Ben, is the build green?", "PASS"] }
    home.engine.lines = { Ben: ["Green since this morning."] }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Ready to ship?")
    await over(host, () => said(host).some((message) => message.kind === "note"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toContain("Ben is moving to another computer, so it sat this out.")
    expect(home.engine.seatsMade()).toEqual([])
  })

  test("your message while it talks there reaches it straight away", async () => {
    home.engine.slow.set("Ben", 800)
    host.engine.lines = { Ada: ["PASS", "PASS"] }
    home.engine.lines = { Ben: ["On it.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Ship it?")
    await until(() => host.runner.talk(id).speaking === "bot_ben" && home.engine.prompts().length > 0 && Boolean(host.runner.get(id)!.group.seats.bot_ben))
    const seat = home.engine.prompts()[0].path.split("/")[3]
    const message = host.runner.send(id, "Also, check the build.")!
    await until(() => home.engine.prompts(seat).some((request) => request.body.delivery === "steer"))
    expect(home.engine.prompts(seat).find((request) => request.body.delivery === "steer")!.body.text).toBe("The user, just now: Also, check the build.")
    await until(() => host.runner.get(id)!.group.heard.bot_ben === message.id)
    await over(host, () => true)
  })

  test("stopped while it talks there: its seat there stops too, and what it says doesn't reach the chat", async () => {
    home.engine.slow.set("Ben", 60_000)
    home.engine.lines = { Ben: ["A long answer."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Go")
    await until(() => home.engine.prompts().length > 0)
    host.runner.stop(id)
    await until(() => home.engine.requests.some((request) => request.path.endsWith("/interrupt")))
    expect(said(host).map((message) => message.author ?? "you")).toEqual(["you"])
    expect(relay.sent.some((each) => each.mail.kind === "stop")).toBe(true)
    // Its turn there settled (kept as stopped) before its computer's folders go.
    await until(() => Object.values(home.store.peerTurns()).some((turn) => turn.ended !== undefined))
    expect(Object.values(home.store.peerTurns()).map((turn) => turn.result && !turn.result.ok && turn.result.why)).toEqual(["it was stopped."])
  })

  test("a bot that moved to a third computer: its seat on the one it left goes, and its next turn there hears the whole chat", async () => {
    const third = new Box("key_spare", relay)
    try {
      third.knows([{ key: "key_mac", name: "mac" }])
      host.engine.lines = { Ada: ["PASS", "PASS"] }
      home.engine.lines = { Ben: ["Hi from devbox."] }
      host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
      host.runner.send(id, "Hello?")
      await over(host, () => said(host).some((message) => message.text === "Hi from devbox."))
      const first = host.runner.get(id)!.group.seats.bot_ben
      // It lives on the third one now.
      host.knows([{ key: "key_devbox", name: "devbox" }, { key: "key_spare", name: "spare", bots: [third.bot("bot_ben", "Ben")] }])
      third.engine.lines = { Ben: ["Hi from spare."] }
      host.runner.send(id, "Again?")
      await over(host, () => said(host).some((message) => message.text === "Hi from spare."))
      await until(() => home.engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${first}`))
      expect(relay.sent.find((each) => each.mail.kind === "drop")?.durable).toBe(true)
      expect(third.engine.prompts()[0].body.text).toStartWith(`Everything said in "Team" so far, from the start:`)
      expect(host.runner.get(id)!.group.seatBoxes).toEqual({ bot_ben: "key_spare" })
    } finally {
      third.stop()
    }
  })

  test("its computer away: asked again while it says nothing, then the chat says so, and goes on without it", async () => {
    const clock = hostOnClock()
    relay.away.add("key_devbox")
    host.engine.lines = { Ada: ["Hello.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => turns().length === 1)
    clock.advance(askAgainAfter)
    await until(() => turns().length === 2)
    expect(turns().map((each) => (each.mail as any).turn.id)).toEqual(Array(2).fill((turns()[0].mail as any).turn.id))
    clock.advance(awayAfter - askAgainAfter)
    await over(host, () => said(host).some((message) => message.author === "bot_ada"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben is on devbox, which can’t be reached now, so it sat this out."])
  })

  test("its computer away: its bots sit out at once while it stays away, not after a wait at every message; a while on it's asked again", async () => {
    const clock = hostOnClock()
    relay.away.add("key_devbox")
    host.engine.lines = { Ada: ["Hello.", "Again.", "Third."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => turns().length === 1)
    clock.advance(askAgainAfter)
    await until(() => turns().length === 2)
    clock.advance(awayAfter - askAgainAfter)
    await over(host, () => said(host).some((message) => message.text === "Hello."))
    const asked = turns().length
    const notes = () => said(host).filter((message) => message.kind === "note").length

    // Another message while it's still away: Ben sits it out at once, the clock never moving.
    host.runner.send(id, "Still there?")
    await over(host, () => said(host).some((message) => message.text === "Again."))
    expect(turns().length).toBe(asked)
    expect(notes()).toBe(2)

    // A while on, it's back: asked again.
    relay.back("key_devbox")
    clock.advance(awayKept)
    host.runner.send(id, "Back?")
    await until(() => turns().length > asked)
  })

  test("its computer away, then heard from again (any mail of its, not only about a turn): its bots are asked at once, not after the five minutes", async () => {
    const clock = hostOnClock()
    relay.away.add("key_devbox")
    host.engine.lines = { Ada: ["Hello.", "Again."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => turns().length === 1)
    clock.advance(askAgainAfter)
    await until(() => turns().length === 2)
    clock.advance(awayAfter - askAgainAfter)
    await over(host, () => said(host).some((message) => message.text === "Hello."))
    const asked = turns().length

    // Back, and it says something of a chat of its own (it stops a turn it gave this Mac), the clock not moving.
    relay.back("key_devbox")
    host.receive("key_devbox", { kind: "stop", id: "turn_elsewhere" })
    host.runner.send(id, "Back?")
    await until(() => turns().length > asked || said(host).some((message) => message.text === "Again."))
    expect(turns().length).toBeGreaterThan(asked)
  })

  test("its words lost on the way after its computer took the turn: asked again, they're said again, and reach the chat", async () => {
    const clock = hostOnClock()
    relay.loses.push((each) => each.mail.kind === "result")
    host.engine.lines = { Ada: ["PASS"] }
    home.engine.lines = { Ben: ["Here, after all."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => relay.lost.length === 1)
    // Nothing more comes; the chat asks again, by the same turn, and isn't answered twice.
    clock.advance(askAgainAfter)
    await over(host, () => said(host).some((message) => message.author === "bot_ben"))
    expect(said(host).filter((message) => message.author === "bot_ben").map((message) => message.text)).toEqual(["Here, after all."])
    const first = (turns()[0].mail as any).turn.id
    expect(turns().filter((each) => (each.mail as any).turn.id === first).length).toBe(2)
    expect(said(host).some((message) => message.kind === "note")).toBe(false)
  })

  test("its computer's bridge restarted while it talked: asked again, its turn goes on where it was, never given twice", async () => {
    const clock = hostOnClock()
    home.engine.held.add("Ben")
    home.engine.lines = { Ben: ["Once, after all."] }
    host.engine.lines = { Ada: ["PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => home.engine.prompts().length === 1)
    const seat = home.engine.prompts()[0].path.split("/")[3]
    home.restartSeats()
    clock.advance(askAgainAfter)
    await until(() => turns().length === 2)
    home.engine.release("Ben")
    await over(host, () => said(host).some((message) => message.author === "bot_ben"))
    expect(said(host).filter((message) => message.author === "bot_ben").map((message) => message.text)).toEqual(["Once, after all."])
    expect(home.engine.seatsMade().filter((title) => title.startsWith("Ben in"))).toEqual(["Ben in Team"])
    expect(home.engine.prompts(seat).length).toBe(1)
  })

  test("its seat said made, but lost on the way: the chat keeps it from how the turn ended, and its next turn is there", async () => {
    relay.loses.push((each) => each.mail.kind === "state" && each.mail.state.phase === "seated")
    host.engine.lines = { Ada: ["PASS", "PASS"] }
    // Ben leads: after its first word it lists who does what (nobody), in a conversation of its own for it.
    home.engine.lines = { Ben: ["First.", "PASS", "Second."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "One?")
    await over(host, () => said(host).some((message) => message.text === "First."))
    expect(relay.lost.length).toBe(1)
    const seat = home.engine.prompts()[0].path.split("/")[3]
    expect(host.runner.get(id)!.group.seats.bot_ben).toBe(seat)
    expect(host.runner.get(id)!.group.seatBoxes).toEqual({ bot_ben: "key_devbox" })
    host.runner.send(id, "Two?")
    await over(host, () => said(host).some((message) => message.text === "Second."))
    expect(home.engine.seatsMade().filter((title) => title.startsWith("Ben in"))).toEqual(["Ben in Team"])
    expect(home.engine.prompts(seat).length).toBe(2)
  })

  test("a computer that doesn't take seats yet says so, rather than going without a word", async () => {
    host.knows([{ key: "key_devbox", name: "devbox", seats: false, bots: [{ id: "bot_ben", name: "Ben", job: "", box: "key_devbox" }] }])
    host.engine.lines = { Ada: ["Hello.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await over(host, () => said(host).some((message) => message.author === "bot_ada"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben is on devbox, which needs an update to take part."])
    expect(relay.sent).toEqual([])
  })

  test("a turn asked twice is taken once: the second is told how it went", async () => {
    home.engine.lines = { Ben: ["Once."] }
    const turn = { id: "trn_twice", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_devbox", { kind: "turn", turn })
    await until(() => relay.sent.some((each) => each.mail.kind === "result"))
    relay.forge("key_mac", "key_devbox", { kind: "turn", turn })
    await until(() => relay.sent.filter((each) => each.mail.kind === "result").length === 2)
    expect(home.engine.prompts().length).toBe(1)
    expect(relay.sent.filter((each) => each.mail.kind === "result").map((each) => (each.mail as any).result.text)).toEqual(["Once.", "Once."])
  })

  test("what another computer asks of a conversation that isn't that bot's seat in that chat isn't done: nothing of it deleted or changed", async () => {
    home.engine.lines = { Ben: ["In a seat of my own."] }
    const turn = { id: "trn_foreign", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", seat: "ses_own_Ben", agentsSeat: false, kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_devbox", { kind: "turn", turn })
    await until(() => relay.sent.some((each) => each.mail.kind === "result"))
    // Its own conversation's rules, instructions and model as they were; it answered in a seat made for it.
    const touched = home.engine.requests.filter((request) => request.path.startsWith("/api/session/ses_own_Ben") || request.path.startsWith("/api/experimental/session/ses_own_Ben"))
    expect(touched.filter((request) => request.method !== "GET")).toEqual([])
    expect(home.engine.seatsMade()).toEqual(["Ben in Team"])
    const answer = relay.sent.find((each) => each.mail.kind === "result")!.mail as any
    expect(answer.result).toMatchObject({ ok: true, text: "In a seat of my own.", replaced: "ses_own_Ben" })
    const seat = answer.result.seat as string
    // Dropping it, its own conversation, or its seat as another chat's: none goes. Its seat in this chat, as said, does.
    relay.forge("key_mac", "key_devbox", { kind: "drop", seat: "ses_own_Ben", agents: false, bot: "bot_ben", chat: id })
    relay.forge("key_mac", "key_devbox", { kind: "drop", seat, agents: false, bot: "bot_ben", chat: "grp_other00001" })
    relay.forge("key_mac", "key_devbox", { kind: "drop", seat, agents: false })
    relay.forge("key_mac", "key_devbox", { kind: "drop", seat, agents: false, bot: "bot_ben", chat: id })
    await until(() => home.engine.requests.some((request) => request.method === "DELETE" && request.path === `/api/session/${seat}`))
    expect(home.engine.requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual([`/api/session/${seat}`])
  })

  test("its part of the work is done in its own conversation on its own computer, and its report comes back to the chat", async () => {
    host.engine.lines = { Ada: ["Let's ship. &Ben, the build?", "Agreed.", "PASS", "We ship Friday; Ben fixes the build.", "&Ada: write the notes\n&Ben (after &Ada): fix the build\nGO"] }
    home.engine.lines = { Ben: ["Build is red; I'll fix it.", "Done soon."] }
    host.engine.reports = { Ada: "Notes written." }
    home.engine.reports = { Ben: "Build fixed." }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Should we ship this week? Go ahead and do it.")
    await until(() => said(host).some((message) => message.report !== undefined && message.author === "bot_ben"))
    expect(said(host).filter((message) => message.report !== undefined).map((message) => [message.author, message.text])).toEqual([
      ["bot_ada", "Notes written."],
      ["bot_ben", "Build fixed."],
    ])
    // Ben's part went to his own conversation there, with Ada's report, and nothing of it was lost on the way.
    const part = home.engine.prompts("ses_own_Ben")[0]?.body.text as string
    expect(part).toContain("[Work from Team · grp_team000001]")
    expect(part).toContain("**Ada**: Notes written.")
    expect(relay.sent.filter((each) => each.mail.kind === "work" || each.mail.kind === "report").every((each) => each.durable)).toBe(true)
    expect(host.runner.get(id)!.messages.find((message) => message.kind === "wrapUp")!.tasks!.map((task) => task.state)).toEqual(["done", "done"])
  }, 20_000)

  test("its part done on its own computer with nothing to report, a pass: the part's done in the chat, and nothing's said there", async () => {
    host.engine.lines = { Ada: ["We'll split it.", "&Ben: fix the build\nGO"] }
    home.engine.reports = { Ben: " Pass \n" }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Split it and go ahead.")
    await until(() => host.runner.get(id)!.messages.find((message) => message.tasks)?.tasks?.[0].state === "done")
    expect(reports()).toMatchObject([{ ok: true }])
    expect(said(host).filter((message) => message.report !== undefined)).toEqual([])
    expect(said(host).some((message) => /^\W*pass\W*$/i.test(message.text))).toBe(false)
  }, 20_000)

  test("its part waiting on its conversation there, stopped by you: the chat's computer says so, until it goes on and reports", async () => {
    mkdirSync(join(home.root, "run"), { recursive: true })
    writeFileSync(home.queues.file, JSON.stringify({ ses_own_Ben: { paused: true, held: [] } }))
    host.engine.lines = { Ada: ["We'll split it.", "&Ben: fix the build\nGO"] }
    home.engine.reports = { Ben: "Build fixed." }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Split it and go ahead.")
    await until(() => host.runner.talk(id).stopped !== undefined)
    expect(host.runner.talk(id).stopped).toEqual(["bot_ben"])
    // Said as it changes, not kept to send again: it says nothing once the part's done.
    expect(relay.sent.filter((each) => each.mail.kind === "held").every((each) => !each.durable)).toBe(true)
    // Resumed there: what waited goes, the part's done, and the chat says nothing waits any more.
    const waiting = readQueues(home.queues).ses_own_Ben.waiting![0]
    const whole = JSON.parse(readFileSync(waitingFile(home.queues, waiting.id), "utf8"))
    writeFileSync(home.queues.file, JSON.stringify({}))
    await server(home.engine.url, "x").request("POST", "/api/session/ses_own_Ben/prompt", whole)
    await until(() => said(host).some((message) => message.report !== undefined && message.author === "bot_ben"))
    expect(host.runner.talk(id).stopped).toBeUndefined()
  }, 20_000)

  test("its part waiting on its conversation there, stopped by you, the word lost on the way: said again, so the chat still says so", async () => {
    mkdirSync(join(home.root, "run"), { recursive: true })
    writeFileSync(home.queues.file, JSON.stringify({ ses_own_Ben: { paused: true, held: [] } }))
    host.engine.lines = { Ada: ["We'll split it.", "&Ben: fix the build\nGO"] }
    relay.loses = [(each) => each.mail.kind === "held" && each.mail.stopped === true]
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Split it and go ahead.")
    await until(() => host.runner.talk(id).stopped !== undefined)
    expect(relay.lost.map((each) => each.mail.kind)).toEqual(["held"])
    expect(host.runner.talk(id).stopped).toEqual(["bot_ben"])
  }, 20_000)

  test("its part waiting on its conversation there, stopped by you, then taken back with Undo: the chat doesn't say it waits any more", async () => {
    mkdirSync(join(home.root, "run"), { recursive: true })
    writeFileSync(home.queues.file, JSON.stringify({ ses_own_Ben: { paused: true, held: [] } }))
    host.engine.lines = { Ada: ["We'll split it.", "&Ben: fix the build\nGO"] }
    host.runner.put(team(), [], "active", false)
    host.runner.send(id, "Split it and go ahead.")
    await until(() => host.runner.talk(id).stopped !== undefined)
    const yours = said(host).find((message) => message.author === undefined && message.kind === "message")!
    expect(host.runner.undo(id, yours.id)).toBe("Split it and go ahead.")
    expect(host.runner.talk(id).stopped).toBeUndefined()
  }, 20_000)

  test("a part given to its bot's computer before the bot moved, and before the chat's computer started again: given there again, and its report taken from there", async () => {
    home.engine.reports = { Ben: "Build fixed." }
    // Ben lives on spare now, as the chat's computer has heard; the part went to devbox.
    host.knows([{ key: "key_devbox", name: "devbox" }, { key: "key_spare", name: "spare", bots: [{ id: "bot_ben", name: "Ben", job: "", box: "key_spare" }] }])
    const wrapUp: GroupMessage = {
      id: "gm_wrap", author: "bot_ada", text: "Ben fixes the build.", time: stamp(), kind: "wrapUp",
      tasks: [{ id: "gt_build", bot: "bot_ben", task: "Fix the build", state: "working", started: stamp(), prompt: "peer:key_devbox" }],
    }
    host.runner.put(team(), [{ id: "gm_ask", text: "Ship it?", time: stamp(), kind: "message" }, wrapUp], "active", false)
    await until(() => said(host).some((message) => message.report === "gt_build"))
    expect(relay.sent.filter((each) => each.mail.kind === "work").map((each) => each.to)).toEqual(["key_devbox"])
    expect(said(host).find((message) => message.report === "gt_build")).toMatchObject({ author: "bot_ben", text: "Build fixed." })
    expect(said(host).find((message) => message.id === "gm_wrap")!.tasks![0].state).toBe("done")
    // Given there again, it's done there once.
    expect(home.engine.prompts("ses_own_Ben").length).toBe(1)
  }, 20_000)

  test("it remembers the chat in its own conversation there, beside its own computer's chats, in one instruction", async () => {
    home.bot("bot_cy", "Cy")
    home.engine.lines = { Ben: ["Here from devbox.", "Here too."], Cy: ["PASS"] }
    host.engine.lines = { Ada: ["PASS", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    home.runner.put({ ...team(["bot_ben", "bot_cy"]), id: "grp_local00001", name: "Lokum crew" }, [], "active", false)
    host.runner.send(id, "Hello?")
    home.runner.send("grp_local00001", "And here?")
    const instruction = () =>
      home.engine.requests.filter((request) => request.method === "PUT" && request.path === "/api/experimental/session/ses_own_Ben/instructions/entries/kuvo.groups.machine").at(-1)?.body.value as string | undefined
    await until(() => (instruction()?.includes(`"Team"`) ?? false) && (instruction()?.includes(`"Lokum crew"`) ?? false))
    expect(instruction()).toContain(`/groups/key_mac-grp_team000001.md`)
    expect(existsSync(join(home.root, "bots", "bot_ben", "groups", "key_mac-grp_team000001.md"))).toBe(true)
    expect(relay.sent.filter((each) => each.mail.kind === "memory").every((each) => each.durable)).toBe(true)
    // Taken out of it: it forgets it there, and remembers its own computer's chat still.
    await host.runner.update(id, { members: ["bot_ada"] })
    await until(() => !existsSync(join(home.root, "bots", "bot_ben", "groups", "key_mac-grp_team000001.md")))
    await until(() => !(instruction()?.includes(`"Team"`) ?? true))
    expect(instruction()).toContain(`"Lokum crew"`)
    home.runner.stop("grp_local00001")
  }, 20_000)

  test("what it remembers, come late, out of order and twice: it doesn't remember a chat it left, and the newest of each wins", async () => {
    host.bot("bot_cy", "Cy")
    const memoryFile = join(home.root, "bots", "bot_ben", "groups", "key_mac-grp_team000001.md")
    // What its own conversation's instruction says now (none once it was taken away).
    const instruction = () => {
      const last = home.engine.requests.filter((request) => request.path === "/api/experimental/session/ses_own_Ben/instructions/entries/kuvo.groups.machine").at(-1)
      return last?.method === "PUT" ? (last.body.value as string) : ""
    }
    const opening: GroupMessage[] = [{ id: "gm_1", text: "Ship it?", time: stamp(), kind: "message" }]
    host.runner.put(team(["bot_ada", "bot_ben", "bot_cy"]), opening, "active", false)
    host.runner.put({ ...team(["bot_ada", "bot_ben"]), id: "grp_two0000001", name: "Two" }, opening, "active", false)
    relay.holding = (each) => each.mail.kind === "memory"
    relay.twice = true
    // It remembers the chat renamed, then forgets it as it's taken out; then the other chat is renamed.
    await host.runner.update(id, { name: "Renamed" })
    await host.runner.update(id, { members: ["bot_ada", "bot_cy"] })
    await host.runner.update("grp_two0000001", { name: "Second" })
    const held = relay.held.filter((each) => (each.mail as any).memory.bot === "bot_ben")
    expect(held.map((each) => [(each.mail as any).memory.chat, Boolean((each.mail as any).memory.forget)])).toEqual([
      [id, false], ["grp_two0000001", false],
      [id, true],
      ["grp_two0000001", false],
    ])
    // They come the other way round (the newest of the other chat last, so its taking says the rest were looked at).
    const newest = relay.held.pop()!
    relay.release("reversed")
    relay.held = [newest]
    relay.release("as sent")
    await until(() => instruction().includes(`"Second"`))
    expect(existsSync(memoryFile)).toBe(false)
    expect(instruction()).not.toContain(`"Renamed"`)
    expect(instruction()).not.toContain(`grp_team000001`)
  }, 20_000)

  test("what it's told it remembers of a long chat is its latest messages, within what mail carries", async () => {
    const long: GroupMessage[] = Array.from({ length: 300 }, (_, index) => ({ id: `gm_${index}`, text: `Message ${index}: ` + "words ".repeat(400), time: stamp(), kind: "message" }))
    host.runner.put(team(["bot_ada", "bot_ben"]), long, "active", false)
    await host.runner.update(id, { name: "Long" })
    await until(() => relay.sent.some((each) => each.mail.kind === "memory"))
    const memory = (relay.sent.find((each) => each.mail.kind === "memory")!.mail as any).memory
    expect(new TextEncoder().encode(memory.transcript).length).toBeLessThanOrEqual(transcriptMailBytes)
    expect(memory.transcript).toContain("Message 299: ")
    expect(memory.transcript).not.toContain("Message 0: ")
    expect(memory.transcript).toContain("Earlier messages aren’t here")
    // There, it's kept as it came.
    const file = join(home.root, "bots", "bot_ben", "groups", "key_mac-grp_team000001.md")
    await until(() => existsSync(file) && readFileSync(file, "utf8") === memory.transcript)
  }, 20_000)

  test("what it's doing goes to the chat's computer at most every 1.5 s, the latest of it, and asked again, only the latest is said again", async () => {
    const clock = new HandClock()
    let finish = () => {}
    const seats = {
      turn: async (_turn: any, report: (state: any) => void) => {
        report({ phase: "activity", activity: [{ kind: "thinking", text: "one" }] })
        report({ phase: "activity", activity: [{ kind: "thinking", text: "two" }] })
        report({ phase: "activity", activity: [{ kind: "writing" }] })
        await new Promise<void>((resolve) => (finish = resolve))
        return { ok: true, text: "Done.", steps: [] }
      },
    } as any
    const sent: SeatMail[] = []
    const server = new SeatServer(seats, { send: (_to, mail) => { sent.push(mail); beat() } }, undefined, clock)
    const turn = { id: "trn_busy", chat: { id, name: "Team", members: [] }, bot: "bot_ben", kind: "turn" as const, text: "Go." }
    server.take("key_mac", { kind: "turn", turn })
    const activities = () => sent.flatMap((mail) => (mail.kind === "state" && mail.state.phase === "activity" ? [mail.state.activity] : []))
    expect(activities()).toEqual([[{ kind: "thinking", text: "one" }]])
    clock.advance(activityEvery)
    expect(activities()).toEqual([[{ kind: "thinking", text: "one" }], [{ kind: "writing" }]])
    sent.length = 0
    server.take("key_mac", { kind: "turn", turn })
    expect(sent).toEqual([
      { kind: "state", id: "trn_busy", state: { phase: "taken" } },
      { kind: "state", id: "trn_busy", state: { phase: "activity", activity: [{ kind: "writing" }] } },
    ])
    finish()
    await until(() => sent.some((mail) => mail.kind === "result"))
  })

  test("a part given again after the chat's computer was off for days: told again how it went, not done again", async () => {
    const clock = homeOnClock()
    home.engine.reports = { Ben: "Build fixed." }
    const work = { task: "gt_build", wrapUp: "gm_wrap", chat: id, bot: "bot_ben", text: "Fix the build.", started: stamp() }
    relay.forge("key_mac", "key_devbox", { kind: "work", work })
    await until(() => reports().length === 1)
    // Its report's letter given up while the chat's computer was off; Ben's computer's bridge
    // restarted meanwhile. The chat's computer starts again, and gives the part again.
    clock.advance(3 * day)
    home.restartSeats()
    relay.forge("key_mac", "key_devbox", { kind: "work", work })
    await until(() => reports().length === 2)
    expect(reports().map((result) => result.text)).toEqual(["Build fixed.", "Build fixed."])
    expect(relay.sent.filter((each) => each.mail.kind === "report").every((each) => each.durable && each.to === "key_mac")).toBe(true)
    expect(home.engine.prompts("ses_own_Ben").length).toBe(1)
  })

  test("a report's letter given up before the chat's computer had it is sent again", async () => {
    home.engine.reports = { Ben: "Build fixed." }
    const work = { task: "gt_build", wrapUp: "gm_wrap", chat: id, bot: "bot_ben", text: "Fix the build.", started: stamp() }
    relay.forge("key_mac", "key_devbox", { kind: "work", work })
    await until(() => reports().length === 1)
    home.gaveUp("key_mac", relay.sent.find((each) => each.mail.kind === "report")!.mail)
    await until(() => reports().length === 2)
    expect(reports()[1]).toEqual(reports()[0])
  })

  /** Ben's part of a wrap-up, given to devbox while devbox is away. */
  async function partWhileAway() {
    relay.away.add("key_devbox")
    home.engine.reports = { Ben: "Build fixed." }
    const wrapUp: GroupMessage = {
      id: "gm_wrap", author: "bot_ada", text: "Ben fixes the build.", time: stamp(), kind: "wrapUp",
      tasks: [{ id: "gt_build", bot: "bot_ben", task: "Fix the build", state: "proposed" }],
    }
    host.runner.put(team(), [{ id: "gm_ask", text: "Ship it?", time: stamp(), kind: "message" }, wrapUp], "active", false)
    host.runner.startWork("gm_wrap", id)
    await until(() => relay.sent.some((each) => each.mail.kind === "work"))
  }
  const part = () => said(host).find((message) => message.id === "gm_wrap")!.tasks![0]

  test("a part whose letter is given up while its bot's computer is still one of yours: given again, and its report taken when it comes", async () => {
    await partWhileAway()
    host.gaveUp("key_devbox", relay.sent.find((each) => each.mail.kind === "work")!.mail)
    await until(() => relay.sent.filter((each) => each.mail.kind === "work").length === 2)
    expect(relay.sent.filter((each) => each.mail.kind === "work").every((each) => each.durable && each.to === "key_devbox")).toBe(true)
    expect(part().state).toBe("working")
    // Lokum back: the part, given twice, is done there once, and its report reaches the chat.
    relay.back("key_devbox")
    await until(() => said(host).some((message) => message.report === "gt_build"))
    expect(part().state).toBe("done")
    expect(said(host).filter((message) => message.kind === "note")).toEqual([])
    expect(home.engine.prompts("ses_own_Ben").length).toBe(1)
  })

  test("a part whose letter is given up, its bot's computer no longer one of yours: the part fails, and a report that comes after all is still taken", async () => {
    await partWhileAway()
    host.knows([])
    host.gaveUp("key_devbox", relay.sent.find((each) => each.mail.kind === "work")!.mail)
    await until(() => part().state === "failed")
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["A bot couldn’t do its part: another computer couldn’t be reached for two days, so it was given up."])
    // Lokum is yours again, and did the part after all.
    host.knows([{ key: "key_devbox", name: "devbox", bots: [{ id: "bot_ben", name: "Ben", job: "", box: "key_devbox" }] }])
    relay.back("key_devbox")
    await until(() => said(host).some((message) => message.report === "gt_build"))
    expect(said(host).find((message) => message.report === "gt_build")).toMatchObject({ author: "bot_ben", text: "Build fixed." })
    expect(part().state).toBe("done")
    expect(clientMessage(said(host).find((message) => message.id === "gm_wrap"))!.tasks![0]).not.toHaveProperty("lost")
  })

  test("a seat gone or what a bot remembers, its letter given up: sent again while that computer is one of yours, as it is now", async () => {
    host.runner.put(team(), [{ id: "gm_ask", text: "Ship it?", time: stamp(), kind: "message" }], "active", false)
    host.gaveUp("key_devbox", { kind: "drop", seat: "ses_seat9", agents: false, bot: "bot_ben", chat: id })
    host.gaveUp("key_devbox", { kind: "memory", memory: { chat: id, bot: "bot_ben", at: 1, name: "Old name" } })
    await until(() => relay.sent.some((each) => each.mail.kind === "drop") && relay.sent.some((each) => each.mail.kind === "memory"))
    expect(relay.sent.map((each) => [each.mail.kind, each.to, each.durable])).toEqual([["drop", "key_devbox", true], ["memory", "key_devbox", true]])
    expect((relay.sent[1].mail as any).memory).toMatchObject({ chat: id, bot: "bot_ben", name: "Team" })
    // Not one of yours any more: let go.
    host.knows([])
    host.gaveUp("key_devbox", { kind: "drop", seat: "ses_seat9", agents: false, bot: "bot_ben", chat: id })
    host.gaveUp("key_devbox", relay.sent[1].mail)
    expect(relay.sent.length).toBe(2)
  })

  test("a report's letter given up to a computer that's no longer one of yours, or for a part done over 30 days ago, isn't sent again", async () => {
    const clock = homeOnClock()
    home.engine.reports = { Ben: "Build fixed." }
    const work = { task: "gt_build", wrapUp: "gm_wrap", chat: id, bot: "bot_ben", text: "Fix the build.", started: stamp() }
    relay.forge("key_mac", "key_devbox", { kind: "work", work })
    await until(() => reports().length === 1)
    const report = relay.sent.find((each) => each.mail.kind === "report")!.mail
    home.knows([])
    home.gaveUp("key_mac", report)
    home.knows([{ key: "key_mac", name: "mac" }])
    clock.advance(31 * day)
    home.gaveUp("key_mac", report)
    expect(reports().length).toBe(1)
    expect(home.store.peerWork()).toEqual({})
  })

  test("its link told a letter was given up before it said who your computers are: not heard yet, so it's told again", async () => {
    home.engine.reports = { Ben: "Build fixed." }
    relay.forge("key_mac", "key_devbox", { kind: "work", work: { task: "gt_build", wrapUp: "gm_wrap", chat: id, bot: "bot_ben", text: "Fix the build.", started: stamp() } })
    await until(() => reports().length === 1)
    const report = relay.sent.find((each) => each.mail.kind === "report")!.mail
    const started = { ...home.parts, directory: new LinkDirectory(home.post) }
    const told = await peerRoutes(started, "POST", ["gaveup"], async () => ({ to: "key_mac", mail: report, at: Date.now() }))
    expect(told.status).toBe(503)
    expect(reports().length).toBe(1)
    started.directory.set({ boxes: [{ key: "key_mac", name: "mac", seats: true }], bots: [] })
    expect((await peerRoutes(started, "POST", ["gaveup"], async () => ({ to: "key_mac", mail: report, at: Date.now() }))).status).toBe(200)
    await until(() => reports().length === 2)
  })

  test("a bot at work on a long, quiet step: its computer says it's still at it, so it's neither asked again nor taken for away", async () => {
    const clock = hostOnClock()
    const homeClock = homeOnClock()
    home.engine.held.add("Ben")
    home.engine.lines = { Ben: ["Done, at last."] }
    host.engine.lines = { Ada: ["PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Take your time.")
    await until(() => host.got.some((mail) => mail.kind === "state" && mail.state.phase === "started"))
    const stillAt = () => host.got.filter((mail) => mail.kind === "state" && mail.state.phase === "working").length
    // A minute of nothing but that.
    for (let beats = 1; beats <= 6; beats++) {
      homeClock.advance(aliveEvery)
      await until(() => stillAt() === beats)
      clock.advance(aliveEvery)
    }
    expect(turns().length).toBe(1)
    home.engine.release("Ben")
    await over(host, () => said(host).some((message) => message.author === "bot_ben"))
    expect(said(host).filter((message) => message.kind === "note")).toEqual([])
    expect(said(host).find((message) => message.author === "bot_ben")?.text).toBe("Done, at last.")
  })

  test("asked again once its words are with its seat, the whole chat isn't sent again", async () => {
    const clock = hostOnClock()
    host.engine.lines = { Ada: ["PASS", "PASS"] }
    // Ben leads: after its first word it lists who does what (nobody), in a conversation of its own for it.
    home.engine.lines = { Ben: ["First.", "PASS", "Second."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "One?")
    await over(host, () => said(host).some((message) => message.text === "First."))
    home.engine.held.add("Ben")
    host.runner.send(id, "Two?")
    const second = () => turns().filter((each) => (each.mail as any).turn.text.includes("Two?"))
    await until(() => second().length === 1 && host.got.some((mail) => mail.kind === "state" && mail.id === (second()[0].mail as any).turn.id && mail.state.phase === "started"))
    // Nothing more comes from it for a while: asked again.
    relay.away.add("key_devbox")
    clock.advance(askAgainAfter)
    await until(() => second().length === 2)
    const [first, again] = second().map((each) => (each.mail as any).turn)
    expect(first.fresh).toStartWith(`Everything said in "Team" so far, from the start:`)
    expect(again.fresh).toBeUndefined()
    expect({ ...again, fresh: first.fresh }).toEqual(first)
    relay.back("key_devbox")
    home.engine.release("Ben")
    await over(host, () => said(host).some((message) => message.text === "Second."))
  })

  test("a chat too big to send to the bot's computer: said, rather than sent and never answered", async () => {
    host.engine.lines = { Ada: ["PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Read this: " + "long words ".repeat(60_000))
    await over(host, () => said(host).some((message) => message.kind === "note"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben couldn’t answer: the chat is too big to send to devbox."])
    expect(turns()).toEqual([])
  })

  test("many long replies while it was quiet: its turn still goes, the whole chat left out and what it hasn't heard cut to its latest", async () => {
    host.engine.lines = { Ada: ["PASS"] }
    home.engine.lines = { Ben: ["Caught up."] }
    // Forty long code replies from Ada since Ben last spoke, in a seat it has there.
    const long: GroupMessage[] = Array.from({ length: 40 }, (_, index) => ({ id: `gm_${index}`, author: "bot_ada", text: `Reply ${index}:\n` + "const x = 1;\n".repeat(1_600), time: stamp(), kind: "message" }))
    const group = { ...team(["bot_ben", "bot_ada"]), seats: { bot_ben: "ses_seat_old" }, seatBoxes: { bot_ben: "key_devbox" }, heard: { bot_ben: "gm_0" } }
    host.runner.put(group, long, "active", false)
    host.runner.send(id, "Ben, what do you think?")
    await over(host, () => said(host).some((message) => message.author === "bot_ben"))
    expect(said(host).filter((message) => message.kind === "note")).toEqual([])
    expect(said(host).find((message) => message.author === "bot_ben")?.text).toBe("Caught up.")
    const sent = (turns()[0].mail as any).turn
    expect(new TextEncoder().encode(JSON.stringify(turns()[0].mail)).length).toBeLessThanOrEqual(512 * 1024)
    expect(sent.fresh).toBeUndefined()
    expect(sent.text).toContain("Ben, what do you think?")
    expect(sent.text).toContain("Reply 39:")
    expect(sent.text).not.toContain("Reply 1:\n")
    expect(sent.text).toContain("(Earlier messages left out.)")
  })

  test("its seat there deleted while its computer's bridge restarted: its turn goes on in a seat made anew that hears the whole chat", async () => {
    const clock = hostOnClock()
    host.engine.lines = { Ada: ["PASS", "PASS"] }
    // Ben leads: after its first word it lists who does what (nobody), in a conversation of its own for it.
    home.engine.lines = { Ben: ["First.", "PASS", "Gone with its seat.", "Second."] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "One?")
    await over(host, () => said(host).some((message) => message.text === "First."))
    const seat = host.runner.get(id)!.group.seats.bot_ben
    home.engine.held.add("Ben")
    host.runner.send(id, "Two?")
    await until(() => home.engine.prompts(seat).length === 2 && host.got.some((mail) => mail.kind === "state" && mail.state.phase === "started" && mail.id === (turns().at(-1)!.mail as any).turn.id))
    // Its computer's bridge restarts, and its seat is deleted meanwhile.
    home.restartSeats()
    await fetch(`${home.engine.url}/api/session/${seat}`, { method: "DELETE" })
    clock.advance(askAgainAfter)
    await until(() => home.engine.seatsMade().filter((title) => title.startsWith("Ben in")).length === 2)
    home.engine.release("Ben")
    await over(host, () => said(host).some((message) => message.text === "Second."))
    expect(said(host).filter((message) => message.kind === "note")).toEqual([])
    const now = host.runner.get(id)!.group.seats.bot_ben
    expect(now).not.toBe(seat)
    expect(home.engine.prompts(now).map((request) => request.body.text.split("\n")[0])).toEqual([`Everything said in "Team" so far, from the start:`])
    expect(home.engine.prompts(now)[0].body.text).toContain("Two?")
  })

  test("what's kept on disk of a turn it took is light: its steps left out, and how it ended only for a while, though it's never taken twice", async () => {
    const clock = new HandClock()
    const root = mkdtempSync(join(tmpdir(), "kuvo-turns-"))
    try {
      const store = new GroupStore(join(root, "groups"), join(root, "bots"))
      let ran = 0
      const steps = Array.from({ length: 50 }, (_, index) => ({ id: `call_${index}`, name: "read", input: { path: "big.txt" }, output: "x".repeat(4_000) }))
      const seats = { turn: async () => ({ ok: true, text: `Answer ${++ran}.`, steps }) } as any
      const sent: SeatMail[] = []
      const server = new SeatServer(seats, { send: (_to, mail) => { sent.push(mail); beat() } }, { store, remembered: async () => {} }, clock)
      const turn = (turnID: string) => ({ id: turnID, chat: { id, name: "Team", members: [] }, bot: "bot_ben", kind: "turn" as const, text: "Go." })
      const kept = () => JSON.parse(readFileSync(join(root, "groups", "peer-turns.json"), "utf8"))
      server.take("key_mac", { kind: "turn", turn: turn("trn_one") })
      await until(() => sent.some((mail) => mail.kind === "result") && kept().trn_one?.result !== undefined)
      expect((sent.find((mail) => mail.kind === "result") as any).result.steps.length).toBe(50)
      expect(kept().trn_one.result).toEqual({ ok: true, text: "Answer 1.", steps: [] })
      // A quarter of an hour on, another turn: how the first ended isn't kept any more, and asked again, it isn't taken twice.
      clock.advance(16 * 60_000)
      server.take("key_mac", { kind: "turn", turn: turn("trn_two") })
      await until(() => kept().trn_two?.result !== undefined)
      expect(kept().trn_one).not.toHaveProperty("result")
      sent.length = 0
      server.take("key_mac", { kind: "turn", turn: turn("trn_one") })
      new SeatServer(seats, { send: (_to, mail) => void sent.push(mail) }, { store, remembered: async () => {} }, clock).take("key_mac", { kind: "turn", turn: turn("trn_one") })
      expect(sent).toEqual([])
      expect(ran).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a part too big to send to the bot's computer fails, and the chat says why", async () => {
    const wrapUp: GroupMessage = {
      id: "gm_wrap", author: "bot_ada", text: "Ben fixes the build. " + "Details. ".repeat(70_000), time: stamp(), kind: "wrapUp",
      tasks: [{ id: "gt_build", bot: "bot_ben", task: "Fix the build", state: "proposed" }],
    }
    host.runner.put(team(), [{ id: "gm_ask", text: "Ship it?", time: stamp(), kind: "message" }, wrapUp], "active", false)
    host.runner.startWork("gm_wrap", id)
    await until(() => said(host).find((message) => message.id === "gm_wrap")!.tasks![0].state === "failed")
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben couldn’t do its part: its part is too big to send to devbox."])
    expect(relay.sent.filter((each) => each.mail.kind === "work")).toEqual([])
  })

  test("a long answer or report comes back cut to what mail carries, said to be cut", async () => {
    home.engine.lines = { Ben: ["Answer. ".repeat(80_000)] }
    home.engine.reports = { Ben: "Report. ".repeat(80_000) }
    const turn = { id: "trn_long", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_devbox", { kind: "turn", turn })
    relay.forge("key_mac", "key_devbox", { kind: "work", work: { task: "gt_build", wrapUp: "gm_wrap", chat: id, bot: "bot_ben", text: "Fix the build.", started: stamp() } })
    await until(() => relay.sent.some((each) => each.mail.kind === "result") && reports().length === 1)
    const answer = (relay.sent.find((each) => each.mail.kind === "result")!.mail as any).result
    for (const text of [answer.text as string, reports()[0].text as string]) {
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(reportBytes)
      expect(text).toEndWith("[Cut here: the rest is in its own conversation on its computer.]")
    }
  })

  test("your message before its computer checked the seat it was asked to use isn't steered into that conversation", async () => {
    home.engine.held.add("Ben")
    home.engine.lines = { Ben: ["In a seat of my own."] }
    // Ben's own conversation, at work on something of its own.
    await fetch(`${home.engine.url}/api/session/ses_own_Ben/prompt`, { method: "POST", body: JSON.stringify({ id: "msg_own", text: "Your own work.", delivery: "queue" }) })
    const turn = { id: "trn_steer", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", seat: "ses_own_Ben", agentsSeat: false, kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_devbox", { kind: "turn", turn })
    relay.forge("key_mac", "key_devbox", { kind: "steer", id: "trn_steer", text: "The user, just now: hurry.", message: "gm_hurry" })
    const steers = () => home.engine.prompts().filter((request) => request.body.delivery === "steer")
    await until(() => steers().length === 1)
    expect(steers()[0].path).not.toBe("/api/session/ses_own_Ben/prompt")
    const seat = (relay.sent.find((each) => each.mail.kind === "state" && each.mail.state.phase === "seated")!.mail as any).state.seat
    expect(steers().map((request) => request.path)).toEqual([`/api/session/${seat}/prompt`])
    await until(() => relay.sent.some((each) => each.mail.kind === "state" && each.mail.state.phase === "steered"))
    home.engine.release("Ben")
    await until(() => relay.sent.some((each) => each.mail.kind === "result"))
    expect(home.engine.prompts("ses_own_Ben").map((request) => request.body.id)).toEqual(["msg_own"])
  })

  test("a bot whose computer says it looks a way this one doesn't know is shown plain in what it doesn't know", async () => {
    host.knows([{ key: "key_devbox", name: "devbox", bots: [
      { id: "bot_ben", name: "Ben", job: "", box: "key_devbox", look: { color: "ultraviolet", shape: "gem", face: "smirk" } },
      { id: "bot_cy", name: "Cy", job: "", box: "key_devbox", look: { color: "sky", shape: "bloom", face: "wink" } },
      { id: "bot_dee", name: "Dee", job: "", box: "key_devbox", look: "sparkly" },
    ] }])
    const looks = Object.fromEntries(joinable(host.runner, host.store).map((member) => [member.id, member.look]))
    expect(looks.bot_ben).toEqual({ color: "graphite", shape: "gem", face: "calm" })
    expect(looks.bot_cy).toEqual({ color: "sky", shape: "bloom", face: "wink" })
    expect(looks.bot_dee).toEqual({ color: "graphite", shape: "round", face: "calm" })
  })

  test("what another computer says of a turn it wasn't asked is taken from nobody", async () => {
    const forger = new Box("key_stranger", relay)
    try {
      home.engine.slow.set("Ben", 1000)
      home.engine.lines = { Ben: ["The real answer."] }
      host.engine.lines = { Ada: ["PASS"] }
      host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
      host.runner.send(id, "Go")
      await until(() => turns().length > 0)
      const turnID = (turns()[0].mail as any).turn.id
      relay.forge("key_stranger", "key_mac", { kind: "result", id: turnID, result: { ok: true, text: "Forged words.", steps: [] } })
      await over(host, () => said(host).some((message) => message.author === "bot_ben"))
      expect(said(host).map((message) => message.text)).not.toContain("Forged words.")
      expect(said(host).find((message) => message.author === "bot_ben")?.text).toBe("The real answer.")
    } finally {
      forger.stop()
    }
  })
})
