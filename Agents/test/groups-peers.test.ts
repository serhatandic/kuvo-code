import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../src/events"
import { server } from "../src/groups/api"
import { SeatServer, activityEvery, askAgainAfter, awayAfter, type Clock, type PeerBot, type SeatMail } from "../src/groups/peer"
import { LinkDirectory, PeerPost, receive, type PeerParts } from "../src/groups/post"
import { GroupRunner, transcriptMailBytes } from "../src/groups/runner"
import { stamp, type Group, type GroupMessage } from "../src/groups/rules"
import { GroupStore } from "../src/groups/store"
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
  private now = 0
  private timers: { at: number; work: () => void }[] = []
  setTimeout(work: () => void, ms: number) {
    const timer = { at: this.now + ms, work }
    this.timers.push(timer)
    return timer
  }
  clearTimeout(timer: unknown) {
    this.timers = this.timers.filter((each) => each !== timer)
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const due = this.timers.filter((each) => each.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((each) => each !== due)
      this.now = due.at
      due.work()
    }
    this.now = end
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

/** One of your computers: its engine, its bots, its group chats, and its bridge's part in chats across them. */
class Box {
  readonly root = mkdtempSync(join(tmpdir(), "kuvo-peers-"))
  readonly engine = new Engine(beat)
  readonly store: GroupStore
  readonly runner: GroupRunner
  readonly post: PeerPost
  readonly directory: LinkDirectory
  readonly parts: PeerParts
  private following = new AbortController()

  constructor(
    readonly key: string,
    readonly relay: Relay,
    readonly clock?: Clock,
  ) {
    this.store = new GroupStore(join(this.root, "groups"), join(this.root, "bots"))
    this.post = new PeerPost(join(this.root, "peer-outbox.json"))
    this.directory = new LinkDirectory(this.post, clock)
    this.runner = new GroupRunner({
      store: this.store, engine: server(this.engine.url, "x"), bridge: () => undefined, trash: join(this.root, "trash"), pace: 0.05, place: key, peers: this.directory,
    })
    const seats = new SeatServer(this.runner.seats, this.post, { store: this.store, remembered: (from, memory) => this.runner.remembered(from, memory) })
    this.parts = { post: this.post, directory: this.directory, server: seats, runner: this.runner }
    relay.boxes.set(key, this)
    void this.link()
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

  receive(from: string, mail: SeatMail) {
    receive(this.parts, from, mail)
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

/** The chat's computer (this Mac's stand-in, `key_mac`), with Ada; Ben lives on lokum. */
function hostWith(clock?: Clock) {
  const box = new Box("key_mac", relay, clock)
  box.bot("bot_ada", "Ada")
  box.knows([{ key: "key_lokum", name: "lokum", bots: [{ id: "bot_ben", name: "Ben", job: "Ben's job", box: "key_lokum", session: "ses_own_Ben" }] }])
  return box
}

beforeEach(() => {
  relay = new Relay()
  home = new Box("key_lokum", relay)
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
    expect(kept.seatBoxes).toEqual({ bot_ben: "key_lokum" })
    expect(kept.heard.bot_ben).toBeDefined()
    // Only the words went between them.
    expect(relay.sent.every((each) => ["turn", "state", "result"].includes(each.mail.kind))).toBe(true)
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
  })

  test("a bot that moved to a third computer: its seat on the one it left goes, and its next turn there hears the whole chat", async () => {
    const third = new Box("key_spare", relay)
    try {
      third.knows([{ key: "key_mac", name: "mac" }])
      host.engine.lines = { Ada: ["PASS", "PASS"] }
      home.engine.lines = { Ben: ["Hi from lokum."] }
      host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
      host.runner.send(id, "Hello?")
      await over(host, () => said(host).some((message) => message.text === "Hi from lokum."))
      const first = host.runner.get(id)!.group.seats.bot_ben
      // It lives on the third one now.
      host.knows([{ key: "key_lokum", name: "lokum" }, { key: "key_spare", name: "spare", bots: [third.bot("bot_ben", "Ben")] }])
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
    relay.away.add("key_lokum")
    host.engine.lines = { Ada: ["Hello.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => turns().length === 1)
    clock.advance(askAgainAfter)
    await until(() => turns().length === 2)
    expect(turns().map((each) => (each.mail as any).turn.id)).toEqual(Array(2).fill((turns()[0].mail as any).turn.id))
    clock.advance(awayAfter - askAgainAfter)
    await over(host, () => said(host).some((message) => message.author === "bot_ada"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben is on lokum, which can’t be reached now, so it sat this out."])
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
    expect(host.runner.get(id)!.group.seatBoxes).toEqual({ bot_ben: "key_lokum" })
    host.runner.send(id, "Two?")
    await over(host, () => said(host).some((message) => message.text === "Second."))
    expect(home.engine.seatsMade().filter((title) => title.startsWith("Ben in"))).toEqual(["Ben in Team"])
    expect(home.engine.prompts(seat).length).toBe(2)
  })

  test("a computer that doesn't take seats yet says so, rather than going without a word", async () => {
    host.knows([{ key: "key_lokum", name: "lokum", seats: false, bots: [{ id: "bot_ben", name: "Ben", job: "", box: "key_lokum" }] }])
    host.engine.lines = { Ada: ["Hello.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await over(host, () => said(host).some((message) => message.author === "bot_ada"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben is on lokum, which needs an update to take part."])
    expect(relay.sent).toEqual([])
  })

  test("a turn asked twice is taken once: the second is told how it went", async () => {
    home.engine.lines = { Ben: ["Once."] }
    const turn = { id: "trn_twice", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_lokum", { kind: "turn", turn })
    await until(() => relay.sent.some((each) => each.mail.kind === "result"))
    relay.forge("key_mac", "key_lokum", { kind: "turn", turn })
    await until(() => relay.sent.filter((each) => each.mail.kind === "result").length === 2)
    expect(home.engine.prompts().length).toBe(1)
    expect(relay.sent.filter((each) => each.mail.kind === "result").map((each) => (each.mail as any).result.text)).toEqual(["Once.", "Once."])
  })

  test("what another computer asks of a conversation that isn't that bot's seat in that chat isn't done: nothing of it deleted or changed", async () => {
    home.engine.lines = { Ben: ["In a seat of my own."] }
    const turn = { id: "trn_foreign", chat: { id, name: "Team", members: [{ id: "bot_ben", name: "Ben", job: "" }] }, bot: "bot_ben", seat: "ses_own_Ben", agentsSeat: false, kind: "turn" as const, text: "Your turn." }
    relay.forge("key_mac", "key_lokum", { kind: "turn", turn })
    await until(() => relay.sent.some((each) => each.mail.kind === "result"))
    // Its own conversation's rules, instructions and model as they were; it answered in a seat made for it.
    const touched = home.engine.requests.filter((request) => request.path.startsWith("/api/session/ses_own_Ben") || request.path.startsWith("/api/experimental/session/ses_own_Ben"))
    expect(touched.filter((request) => request.method !== "GET")).toEqual([])
    expect(home.engine.seatsMade()).toEqual(["Ben in Team"])
    const answer = relay.sent.find((each) => each.mail.kind === "result")!.mail as any
    expect(answer.result).toMatchObject({ ok: true, text: "In a seat of my own.", replaced: "ses_own_Ben" })
    const seat = answer.result.seat as string
    // Dropping it, its own conversation, or its seat as another chat's: none goes. Its seat in this chat, as said, does.
    relay.forge("key_mac", "key_lokum", { kind: "drop", seat: "ses_own_Ben", agents: false, bot: "bot_ben", chat: id })
    relay.forge("key_mac", "key_lokum", { kind: "drop", seat, agents: false, bot: "bot_ben", chat: "grp_other00001" })
    relay.forge("key_mac", "key_lokum", { kind: "drop", seat, agents: false })
    relay.forge("key_mac", "key_lokum", { kind: "drop", seat, agents: false, bot: "bot_ben", chat: id })
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

  test("a part given to its bot's computer before the bot moved, and before the chat's computer started again: given there again, and its report taken from there", async () => {
    home.engine.reports = { Ben: "Build fixed." }
    // Ben lives on spare now, as the chat's computer has heard; the part went to lokum.
    host.knows([{ key: "key_lokum", name: "lokum" }, { key: "key_spare", name: "spare", bots: [{ id: "bot_ben", name: "Ben", job: "", box: "key_spare" }] }])
    const wrapUp: GroupMessage = {
      id: "gm_wrap", author: "bot_ada", text: "Ben fixes the build.", time: stamp(), kind: "wrapUp",
      tasks: [{ id: "gt_build", bot: "bot_ben", task: "Fix the build", state: "working", started: stamp(), prompt: "peer:key_lokum" }],
    }
    host.runner.put(team(), [{ id: "gm_ask", text: "Ship it?", time: stamp(), kind: "message" }, wrapUp], "active", false)
    await until(() => said(host).some((message) => message.report === "gt_build"))
    expect(relay.sent.filter((each) => each.mail.kind === "work").map((each) => each.to)).toEqual(["key_lokum"])
    expect(said(host).find((message) => message.report === "gt_build")).toMatchObject({ author: "bot_ben", text: "Build fixed." })
    expect(said(host).find((message) => message.id === "gm_wrap")!.tasks![0].state).toBe("done")
    // Given there again, it's done there once.
    expect(home.engine.prompts("ses_own_Ben").length).toBe(1)
  }, 20_000)

  test("it remembers the chat in its own conversation there, beside its own computer's chats, in one instruction", async () => {
    home.bot("bot_cy", "Cy")
    home.engine.lines = { Ben: ["Here from lokum.", "Here too."], Cy: ["PASS"] }
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
