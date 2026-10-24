import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { subscribe } from "../src/events"
import { server } from "../src/groups/api"
import { RemoteHome, SeatServer, activityEvery, askAgainAfter, awayAfter, type Clock, type PeerBot, type PeerDirectory, type SeatMail } from "../src/groups/peer"
import { GroupRunner } from "../src/groups/runner"
import { stamp, type Group } from "../src/groups/rules"
import { GroupStore } from "../src/groups/store"
import { Engine } from "./support/engine"

// Group chats across your computers (PROTOCOL.md, "Peers": seat): a chat lives on one computer and
// runs there, and a bot that lives on another takes its turn there, in a seat of that computer's
// own, with only the words going between them. Here, in-memory computers on a stand-in relay, each
// with a stand-in engine whose seats answer with their bot's next line.

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

/** A clock a test moves on by hand. */
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
    this.now += ms
    for (const timer of this.timers.filter((each) => each.at <= this.now)) {
      this.timers = this.timers.filter((each) => each !== timer)
      timer.work()
    }
  }
}

/** The relay between computers: mail from one to another, a moment later; a computer that's away gets none of it (what mustn't be lost waits for it). */
class Relay {
  boxes = new Map<string, Box>()
  away = new Set<string>()
  /** Every mail sent, by whom to whom. */
  sent: { from: string; to: string; mail: SeatMail; durable: boolean }[] = []
  private waiting: { from: string; to: string; mail: SeatMail }[] = []

  send(from: string, to: string, mail: SeatMail, durable: boolean) {
    this.sent.push({ from, to, mail: structuredClone(mail), durable })
    beat()
    if (this.away.has(to)) {
      if (durable) this.waiting.push({ from, to, mail })
      return
    }
    queueMicrotask(() => this.boxes.get(to)?.receive(from, structuredClone(mail)))
  }

  back(box: string) {
    this.away.delete(box)
    for (const each of this.waiting.filter((one) => one.to === box)) this.boxes.get(box)?.receive(each.from, each.mail)
    this.waiting = this.waiting.filter((one) => one.to !== box)
  }

  /** Mail as if from `from`, whatever it says. */
  forge(from: string, to: string, mail: SeatMail) {
    this.boxes.get(to)?.receive(from, mail)
  }
}

/** One of your computers: its engine, its bots, its group chats, and what it knows of the others. */
class Box {
  readonly root = mkdtempSync(join(tmpdir(), "kuvo-peers-"))
  readonly engine = new Engine(beat)
  readonly store: GroupStore
  readonly runner: GroupRunner
  readonly server: SeatServer
  private homes = new Map<string, RemoteHome>()
  /** Other computers' bots, as they'd say. */
  theirs: PeerBot[] = []
  names: Record<string, string> = {}
  noSeats = new Set<string>()

  constructor(
    readonly key: string,
    readonly relay: Relay,
    readonly clock?: Clock,
  ) {
    this.store = new GroupStore(join(this.root, "groups"), join(this.root, "bots"))
    const transport = { send: (to: string, mail: SeatMail, durable: boolean) => relay.send(key, to, mail, durable) }
    const directory: PeerDirectory = {
      bots: () => this.theirs,
      name: (box) => this.names[box] ?? box,
      takesSeats: (box) => !this.noSeats.has(box),
      home: (box) => {
        let home = this.homes.get(box)
        if (!home) this.homes.set(box, (home = new RemoteHome(box, transport, () => this.names[box] ?? box, this.clock)))
        return home
      },
    }
    this.runner = new GroupRunner({
      store: this.store, engine: server(this.engine.url, "x"), bridge: () => undefined, trash: join(this.root, "trash"), pace: 0.05, place: key, peers: directory,
    })
    this.server = new SeatServer(this.runner.seats, transport, { store: this.store, remembered: (from, memory) => this.runner.remembered(from, memory) })
    relay.boxes.set(key, this)
  }

  receive(from: string, mail: SeatMail) {
    if (mail.kind === "state" || mail.kind === "result") this.homes.get(from)?.take(from, mail)
    else if (mail.kind === "report") this.runner.reported(from, mail)
    else this.server.take(from, mail)
    beat()
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

beforeEach(() => {
  relay = new Relay()
  host = new Box("key_mac", relay)
  home = new Box("key_lokum", relay)
  host.bot("bot_ada", "Ada")
  host.theirs = [home.bot("bot_ben", "Ben")]
  host.names = { key_lokum: "lokum" }
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
      host.names.key_spare = "spare"
      host.engine.lines = { Ada: ["PASS", "PASS"] }
      home.engine.lines = { Ben: ["Hi from lokum."] }
      host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
      host.runner.send(id, "Hello?")
      await over(host, () => said(host).some((message) => message.text === "Hi from lokum."))
      const first = host.runner.get(id)!.group.seats.bot_ben
      // It lives on the third one now.
      host.theirs = [third.bot("bot_ben", "Ben")]
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

  test("its computer away: asked again once, then the chat says so, and goes on without it", async () => {
    relay.boxes.delete("key_mac")
    host.stop()
    const clock = new HandClock()
    host = new Box("key_mac", relay, clock)
    host.bot("bot_ada", "Ada")
    host.theirs = [home.bot("bot_ben", "Ben")]
    host.names = { key_lokum: "lokum" }
    relay.away.add("key_lokum")
    host.engine.lines = { Ada: ["Hello.", "PASS"] }
    host.runner.put(team(["bot_ben", "bot_ada"]), [], "active", false)
    host.runner.send(id, "Anyone?")
    await until(() => relay.sent.filter((each) => each.mail.kind === "turn").length === 1)
    clock.advance(askAgainAfter)
    expect(relay.sent.filter((each) => each.mail.kind === "turn").length).toBe(2)
    expect(relay.sent.filter((each) => each.mail.kind === "turn").map((each) => (each.mail as any).turn.id)).toEqual(Array(2).fill((relay.sent[0].mail as any).turn.id))
    clock.advance(awayAfter - askAgainAfter)
    await over(host, () => said(host).some((message) => message.author === "bot_ada"))
    expect(said(host).filter((message) => message.kind === "note").map((message) => message.text)).toEqual(["Ben is on lokum, which can’t be reached now, so it sat this out."])
  })

  test("a computer that doesn't take seats yet says so, rather than going without a word", async () => {
    host.noSeats.add("key_lokum")
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

  test("what it's doing goes to the chat's computer at most every 1.5 s, the latest of it", async () => {
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
    server.take("key_mac", { kind: "turn", turn: { id: "trn_busy", chat: { id, name: "Team", members: [] }, bot: "bot_ben", kind: "turn", text: "Go." } })
    const activities = () => sent.flatMap((mail) => (mail.kind === "state" && mail.state.phase === "activity" ? [mail.state.activity] : []))
    expect(activities()).toEqual([[{ kind: "thinking", text: "one" }]])
    clock.advance(activityEvery)
    expect(activities()).toEqual([[{ kind: "thinking", text: "one" }], [{ kind: "writing" }]])
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
      await until(() => relay.sent.some((each) => each.mail.kind === "turn"))
      const turnID = (relay.sent.find((each) => each.mail.kind === "turn")!.mail as any).turn.id
      relay.forge("key_stranger", "key_mac", { kind: "result", id: turnID, result: { ok: true, text: "Forged words.", steps: [] } })
      await over(host, () => said(host).some((message) => message.author === "bot_ben"))
      expect(said(host).map((message) => message.text)).not.toContain("Forged words.")
      expect(said(host).find((message) => message.author === "bot_ben")?.text).toBe("The real answer.")
    } finally {
      forger.stop()
    }
  })
})
