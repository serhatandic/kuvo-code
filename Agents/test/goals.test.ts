import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineLink } from "../src/engine"
import { emit, subscribe } from "../src/events"
import { server } from "../src/groups/api"
import { goalRoutes, Goals, quietLimit, transcript, type Goal, type GoalPlaces } from "../src/goals"
import type { ServerEvent } from "../src/wire"

// Goals as a box runs them: a conversation given a goal works toward it turn after turn, checked
// after each one, until it's met; against a stand-in engine (its HTTP API and live event feed),
// through the bridge's real link to it, and as the bridge runs one of the coding agents'.

type Turn = { text?: string; tool?: boolean; outcome?: "succeeded" | "failed" | "interrupted"; error?: string }

/** The engine: a turn for each note, as `turns` script them, and the goal check's verdicts in turn. */
class StandIn {
  readonly conversations = new Map<string, any[]>()
  readonly synthetic: { session: string; text: string; description?: string }[] = []
  /** Each check asked: afresh on the session's model (`fresh`), or in the session's own context (`own`). */
  readonly checks: { kind: "fresh" | "own"; prompt: string; model?: any }[] = []
  verdicts: string[] = []
  turns: Turn[] = []
  /** Turns that wait for `finish` rather than ending at once. */
  holding = false
  /** Goal checks that wait for `answerChecks`. */
  holdingChecks = false
  /** Its model is one of OpenCode's free ones, which answer a check only in the session's own context. */
  freeModel = false
  /** A note sent while a turn runs waits for it to end (as the bridge's sessions take them), rather than joining it. */
  queuesNotes = false
  /** Sessions whose parent is another (a subagent's). */
  readonly parents = new Map<string, string>()
  /** Titles given to sessions, by session. */
  readonly titles = new Map<string, string>()
  /** Its events go out as the bridge's own (`emit`), not on its feed. */
  emitsAsBridge = false
  private held: (() => void)[] = []
  private heldChecks: (() => void)[] = []
  private queued = new Map<string, { text: string; description?: string }[]>()
  private busy = new Set<string>()
  private feeds = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private next = 1
  private server: ReturnType<typeof Bun.serve>

  constructor(private readonly beat: () => void) {
    this.server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (request) => this.answer(request) })
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`
  }

  get listening() {
    return this.feeds.size > 0
  }

  stop() {
    for (const feed of this.feeds) feed.close()
    this.server.stop(true)
  }

  session(id: string, messages: any[] = []) {
    this.conversations.set(id, messages)
  }

  /** You (or another client) wrote to it: it takes a turn. */
  write(session: string, text: string) {
    this.add(session, { type: "user", text })
    this.turn(session)
  }

  /** The turns held, ended. */
  finish() {
    for (const end of this.held.splice(0)) end()
  }

  /** A note that waited for the turn before it: its own turn now. */
  deliver(session: string) {
    const waiting = this.queued.get(session)?.shift()
    if (!waiting) return
    this.add(session, { type: "synthetic", text: waiting.text, description: waiting.description })
    this.turn(session)
  }

  answerChecks() {
    for (const answer of this.heldChecks.splice(0)) answer()
  }

  emit(type: string, data: any) {
    if (this.emitsAsBridge) return void emit(type, data)
    const line = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${this.next++}`, type, data })}\n\n`)
    for (const feed of this.feeds) feed.enqueue(line)
  }

  private add(session: string, message: any) {
    this.conversations.get(session)!.push({ id: `msg_${String(this.next++).padStart(4, "0")}`, time: { created: Date.now() }, ...message })
  }

  private note(session: string, text: string, description?: string) {
    this.synthetic.push({ session, text, description })
    this.add(session, { type: "synthetic", text, description })
  }

  private turn(session: string) {
    const turn = this.turns.shift() ?? { tool: true, text: "Working on it." }
    this.busy.add(session)
    this.emit("session.execution.started", { sessionID: session })
    const end = () => {
      const content = [...(turn.tool ? [{ type: "tool", name: "bash", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "1 failing" }] } }] : []), ...(turn.text ? [{ type: "text", text: turn.text }] : [])]
      if (content.length) this.add(session, { type: "assistant", content })
      const outcome = turn.outcome ?? "succeeded"
      this.add(session, { type: "idle", outcome, ...(turn.error ? { error: { message: turn.error } } : {}) })
      this.busy.delete(session)
      this.emit(`session.execution.${outcome}`, { sessionID: session })
      this.beat()
    }
    if (this.holding) this.held.push(end)
    else end()
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/api/event") {
      let controller: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({
        start: (feed) => {
          controller = feed
          this.feeds.add(feed)
          this.beat()
        },
        cancel: () => void this.feeds.delete(controller),
      })
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
    }
    const body: any = request.method === "POST" ? await request.json() : undefined
    try {
      if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...this.busy].map((id) => [id, { type: "busy" }])) })
      if (url.pathname === "/api/experimental/generate") {
        if (this.freeModel) return Response.json({ message: "Free usage limit reached." }, { status: 503 })
        return await this.check("fresh", body.prompt, body.model)
      }
      const [, , session, what] = parts
      const conversation = this.conversations.get(session)
      if (!conversation) return Response.json({ message: "No such session." }, { status: 404 })
      if (!what && request.method === "PATCH") {
        const { title } = (await request.json()) as any
        this.titles.set(session, title)
        return Response.json({ data: {} })
      }
      if (!what) return Response.json({ data: { id: session, model: { providerID: "p", id: "m" }, ...(this.titles.has(session) ? { title: this.titles.get(session) } : {}), ...(this.parents.has(session) ? { parentID: this.parents.get(session) } : {}) } })
      if (what === "message") return Response.json({ data: [...conversation].reverse() })
      if (what === "synthetic") {
        if (this.busy.has(session) && this.queuesNotes) {
          this.synthetic.push({ session, text: body.text, description: body.description })
          this.queued.set(session, [...(this.queued.get(session) ?? []), { text: body.text, description: body.description }])
        } else if (this.busy.has(session)) {
          // Steered into the turn under way: the agent reads it at its next step.
          this.note(session, body.text, body.description)
        } else {
          this.note(session, body.text, body.description)
          this.turn(session)
        }
        return Response.json({ data: {} })
      }
      if (what === "generate") return await this.check("own", body.prompt)
      return Response.json({ data: {} })
    } finally {
      this.beat()
    }
  }

  private async check(kind: "fresh" | "own", prompt: string, model?: any) {
    this.checks.push({ kind, prompt, ...(model ? { model } : {}) })
    this.beat()
    if (this.holdingChecks) await new Promise<void>((resolve) => this.heldChecks.push(resolve))
    // Met, once the script runs out.
    return Response.json({ data: { text: this.verdicts.shift() ?? `{"verdict": "met", "reason": "Done."}` } })
  }
}

let root: string
let engine: StandIn
let link: EngineLink
let goals: Goals
let events: ServerEvent[]
let unsubscribe: () => void
/** Looks at goals that have ended (one for each event that started one). */
let settled = 0

/** Waits that look again only when something happened: the engine was asked, an event went out, or a look at a goal ended. */
const wakes = new Set<() => void>()
function beat() {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) await new Promise<void>((resolve) => wakes.add(() => (wakes.delete(resolve as any), resolve())))
}

/** The engine's sessions, through the bridge's real link to it; `bridge`: a coding agent's, as the bridge itself runs them. */
function places(bridge = false): GoalPlaces {
  return {
    engine: { api: link, listen: (session, told) => link.listen(session, { event: (event) => told.event(event.type, event.data), reconnected: told.reconnected }) },
    bridge: { api: server(engine.url, "x"), listen: (session, told) => subscribe((event) => event.data?.sessionID === session && told.event(event.type, event.data)) },
    isBridge: () => bridge,
  }
}

function makeGoals(bridge = false) {
  const made = new Goals(join(root, "goals.json"), places(bridge))
  // (A runner a test stopped may still finish a look: only the one in use counts.)
  made.onSettled = () => {
    if (goals === made) settled += 1
    beat()
  }
  return made
}

const goal = (session = "ses_work") => goals.get(session)
const nudges = (session = "ses_work") => engine.synthetic.filter((message) => message.session === session && message.text.startsWith("[Goal] Not met yet"))
/** The goal as clients last heard it. */
const told = (session = "ses_work") => events.filter((event) => event.type === "kuvo.goal.updated" && event.data.sessionID === session).at(-1)?.data.goal as Goal | null | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kuvo-goals-"))
  engine = new StandIn(beat)
  engine.session("ses_work", [{ id: "msg_0000", type: "idle", outcome: "succeeded", time: { created: 1 } }])
  link = new EngineLink()
  link.configure(engine.url, "x")
  events = []
  unsubscribe = subscribe((event) => {
    events.push(event)
    beat()
  })
  await until(() => engine.listening)
  goals = makeGoals()
})

afterEach(() => {
  unsubscribe()
  goals.stopAll()
  link.configure(undefined, undefined)
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("a goal", () => {
  test("starts the agent on it, keeps it going while it isn't met, and stops once a check finds it met", async () => {
    engine.verdicts = [`{"verdict": "not_met", "reason": "2 tests in test/auth still fail."}`, `{"verdict": "met", "reason": "npm test exits 0."}`]
    const set = await goals.set("ses_work", "all tests in test/auth pass")
    expect(set).toMatchObject({ state: "working", condition: "all tests in test/auth pass", turns: 0 })
    // The agent is given the goal, as a note the conversation shows as the goal's.
    expect(engine.synthetic[0]).toMatchObject({ session: "ses_work", description: "Goal: all tests in test/auth pass" })
    expect(engine.synthetic[0].text).toStartWith("[Goal] all tests in test/auth pass")
    // A conversation with nothing of yours to be named from is named after its goal; one named already keeps its name.
    expect(engine.titles.get("ses_work")).toBe("all tests in test/auth pass")
    await until(() => goal()?.state === "met")
    // Not met after its first turn: told what's left, it took another; met after that.
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: 2 tests in test/auth still fail."])
    expect(nudges()[0].text).toContain("Keep working toward the goal: all tests in test/auth pass")
    expect(goal()).toMatchObject({ state: "met", turns: 2, last: { verdict: "met", reason: "npm test exits 0." } })
    expect(goal()!.ended).toBeNumber()
    // Checked afresh on the session's model, apart from the agent: shown what it did and what its commands printed.
    expect(engine.checks.map((check) => check.kind)).toEqual(["fresh", "fresh"])
    expect(engine.checks[0].model).toEqual({ providerID: "p", id: "m" })
    expect(engine.checks[0].prompt).toContain("<goal>\nall tests in test/auth pass\n</goal>")
    expect(engine.checks[0].prompt).toContain("Agent ran bash")
    expect(engine.checks[0].prompt).toContain("1 failing")
    // Clients heard each change, the last one met.
    expect(told()).toMatchObject({ state: "met" })
    expect(engine.synthetic).toHaveLength(2)
    // A goal set again keeps the name it has.
    await goals.set("ses_work", "and the lint is clean")
    expect(engine.titles.get("ses_work")).toBe("all tests in test/auth pass")
  })

  test("on one of OpenCode's free models, is checked in the session's own context, which can answer", async () => {
    engine.freeModel = true
    engine.verdicts = [`{"verdict": "met", "reason": "Done."}`]
    await goals.set("ses_work", "README says hello")
    await until(() => goal()?.state === "met")
    expect(engine.checks.map((check) => check.kind)).toEqual(["own"])
    // It reads the conversation it's part of: it isn't sent it again.
    expect(engine.checks[0].prompt).not.toContain("<conversation>")
  })

  test("that can't be met as asked ends, saying why", async () => {
    engine.verdicts = [`{"verdict": "impossible", "reason": "It needs a production API key only you have."}`]
    await goals.set("ses_work", "deploy to production")
    await until(() => goal()?.state === "unmet")
    expect(goal()).toMatchObject({ state: "unmet", note: "It needs a production API key only you have." })
    expect(nudges()).toHaveLength(0)
  })

  test("pauses when you stop the agent, and carries on once resumed", async () => {
    engine.turns = [{ tool: true, outcome: "interrupted" }]
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "paused")
    expect(goal()).toMatchObject({ state: "paused", pausedBy: "you", note: "The turn was stopped." })
    // Nothing checked, nothing sent while it's paused.
    expect(engine.checks).toHaveLength(0)
    expect(nudges()).toHaveLength(0)
    engine.verdicts = [`{"verdict": "not_met", "reason": "The build still fails."}`, `{"verdict": "met", "reason": "The build passed."}`]
    expect((await goals.resume("ses_work")).state).toBe("working")
    await until(() => goal()?.state === "met")
    // Resumed, the turn you stopped was checked, and the agent told what's left.
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: The build still fails."])
  })

  test("paused by you while a turn runs lets that turn end, and starts no other", async () => {
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    expect(goals.pauseByYou("ses_work")).toMatchObject({ state: "paused", pausedBy: "you" })
    const before = settled
    engine.finish()
    await until(() => settled > before)
    expect(engine.checks).toHaveLength(0)
    expect(goal()?.state).toBe("paused")
  })

  test("paused and resumed while a turn is checked, checks it again and tells the agent once", async () => {
    engine.verdicts = [`{"verdict": "not_met", "reason": "Asked before the pause: let go of."}`, `{"verdict": "not_met", "reason": "Tests still fail."}`]
    engine.holdingChecks = true
    await goals.set("ses_work", "the build is green")
    await until(() => engine.checks.length === 1)
    goals.pauseByYou("ses_work")
    await goals.resume("ses_work")
    // The check asked before the pause comes back, and changes nothing; resumed, the turn is checked anew.
    engine.holdingChecks = false
    engine.answerChecks()
    await until(() => goal()?.state === "met")
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: Tests still fail."])
  })

  test("pauses on a turn that failed, with the error", async () => {
    engine.turns = [{ outcome: "failed", error: "Rate limited by the provider" }]
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "paused")
    expect(goal()).toMatchObject({ pausedBy: "error", note: "The turn failed: Rate limited by the provider." })
  })

  test(`pauses once the agent does nothing for ${quietLimit} turns in a row`, async () => {
    engine.turns = Array.from({ length: quietLimit }, () => ({ tool: false, text: "I think it's done." }))
    engine.verdicts = Array.from({ length: quietLimit }, () => `{"verdict": "not_met", "reason": "The build still fails."}`)
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "paused")
    expect(goal()).toMatchObject({ pausedBy: "stalled", turns: quietLimit })
    expect(nudges()).toHaveLength(quietLimit - 1)
  })

  test("waits for a turn you started while it was checked, rather than sending another", async () => {
    engine.verdicts = [`{"verdict": "not_met", "reason": "Tests still fail."}`, `{"verdict": "not_met", "reason": "The README is left."}`]
    engine.holdingChecks = true
    await goals.set("ses_work", "the build is green and the README says how")
    await until(() => engine.checks.length === 1)
    // You write while its first turn is checked; your turn ends before the check does.
    engine.write("ses_work", "Also update the README.")
    engine.holdingChecks = false
    engine.answerChecks()
    await until(() => goal()?.state === "met")
    // The first check's "not met" sent nothing (your turn was under way); your turn was checked,
    // and only then was the agent told what's left.
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: The README is left."])
    expect(engine.checks).toHaveLength(3)
  })

  test("never checks a turn twice, when its end is heard again while it's checked", async () => {
    engine.verdicts = [`{"verdict": "not_met", "reason": "Tests still fail."}`, `{"verdict": "met", "reason": "Done."}`]
    engine.holdingChecks = true
    await goals.set("ses_work", "the build is green")
    await until(() => engine.checks.length === 1)
    engine.emit("session.execution.succeeded", { sessionID: "ses_work" })
    engine.emit("session.execution.succeeded", { sessionID: "ses_work" })
    engine.holdingChecks = false
    engine.answerChecks()
    await until(() => goal()?.state === "met")
    expect(engine.checks).toHaveLength(2)
    expect(nudges()).toHaveLength(1)
  })

  test("set while an earlier turn runs, checks only the turns that are the goal's", async () => {
    // Notes wait for the turn under way to end, as the bridge's sessions take them.
    engine.queuesNotes = true
    engine.holding = true
    engine.write("ses_work", "Look around the project first.")
    await goals.set("ses_work", "the build is green")
    engine.holding = false
    const before = settled
    engine.finish()
    // Your turn ended, and was looked at: it isn't the goal's.
    await until(() => settled > before)
    expect(engine.checks).toHaveLength(0)
    engine.deliver("ses_work")
    await until(() => goal()?.state === "met")
    // Your earlier turn wasn't counted: one check, of the goal's own turn.
    expect(engine.checks).toHaveLength(1)
    expect(goal()?.turns).toBe(1)
  })

  test("goes on where it was after the box starts again: a turn that ended meanwhile is checked once", async () => {
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    // The box stops while the turn runs; the turn ends meanwhile.
    goals.stopAll()
    engine.finish()
    engine.verdicts = [`{"verdict": "met", "reason": "Green."}`]
    goals = makeGoals()
    expect(goal()).toMatchObject({ state: "working", checking: false })
    goals.start()
    await until(() => goal()?.state === "met")
    expect(engine.checks).toHaveLength(1)
  })

  test("the box stopping while a turn is checked: started again, it checks that turn and tells the agent", async () => {
    engine.holdingChecks = true
    await goals.set("ses_work", "the build is green")
    await until(() => engine.checks.length === 1)
    goals.stopAll()
    goals = makeGoals()
    engine.holdingChecks = false
    engine.verdicts = [`{"verdict": "not_met", "reason": "Tests still fail."}`]
    goals.start()
    await until(() => nudges().length === 1)
    // The check the stopped box asked for, answered now, changes nothing.
    engine.answerChecks()
    await until(() => goal()?.state === "met")
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: Tests still fail."])
  })

  test("a turn cut short as the box stopped is checked once it starts again, not taken as you stopping it", async () => {
    engine.turns = [{ tool: true, outcome: "interrupted" }]
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    goals.stopAll()
    engine.finish()
    goals = makeGoals()
    goals.start()
    await until(() => goal()?.state === "met")
    expect(engine.checks).toHaveLength(1)
  })

  test("can't be set on a subagent's conversation: it's the conversation it works for that has one", async () => {
    engine.session("ses_child")
    engine.parents.set("ses_child", "ses_work")
    await expect(goals.set("ses_child", "the build is green")).rejects.toMatchObject({ status: 409 })
    expect(engine.synthetic).toHaveLength(0)
  })

  test("goes with its conversation", async () => {
    await goals.set("ses_work", "the build is green")
    engine.emit("session.deleted", { sessionID: "ses_work" })
    await until(() => told() === null)
    expect(goal()).toBeUndefined()
  })
})

describe("a goal in a coding agent's conversation", () => {
  test("runs the same, checked by the bridge's own one-off answer", async () => {
    goals.stopAll()
    engine.emitsAsBridge = true
    goals = makeGoals(true)
    engine.verdicts = [`{"verdict": "not_met", "reason": "Tests still fail."}`, `{"verdict": "met", "reason": "Done."}`]
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "met")
    expect(nudges()).toHaveLength(1)
    expect(engine.checks.map((check) => check.kind)).toEqual(["own", "own"])
    // That answer starts afresh: it's shown the conversation.
    expect(engine.checks[0].prompt).toContain("<conversation>")
  })
})

describe("what the check reads", () => {
  test("includes commands you ran yourself, with what they printed", () => {
    const read = transcript([{ id: "m1", type: "shell", time: { created: 5 }, command: "npm test", exit: 0, output: { output: "all tests passed", truncated: false } }], 0)
    expect(read).toContain("You ran: npm test (exit 0)")
    expect(read).toContain("all tests passed")
  })
})

describe("its routes", () => {
  const route = (method: string, path: string, value?: unknown) => goalRoutes(goals, method, path.split("/").filter(Boolean), async () => value)
  const read = async (response: Response) => (await response.json()) as any

  test("set, read, pause, resume and clear one, with what a client is told when it can't", async () => {
    expect((await route("GET", "")).status).toBe(200)
    expect(await read(await route("GET", ""))).toEqual({ data: [] })
    expect((await route("GET", "ses_work")).status).toBe(404)
    expect((await route("PUT", "ses_work", { condition: "  " })).status).toBe(400)
    expect((await route("PUT", "ses_work", { condition: "x".repeat(4_001) })).status).toBe(400)
    expect(await read(await route("PUT", "ses_nowhere", { condition: "tests pass" }))).toEqual({ message: "There's no such conversation here." })
    engine.holding = true
    const set = await route("PUT", "ses_work", { condition: "tests pass" })
    expect(set.status).toBe(200)
    expect((await read(set)).data).toMatchObject({ session: "ses_work", state: "working" })
    expect((await read(await route("POST", "ses_work/pause"))).data.state).toBe("paused")
    expect((await read(await route("GET", ""))).data).toHaveLength(1)
    expect((await route("DELETE", "ses_work")).status).toBe(200)
    expect(told()).toBeNull()
    expect((await route("POST", "ses_work/resume")).status).toBe(404)
  })

  test("a goal that's over can't be resumed: it's set again", async () => {
    engine.verdicts = [`{"verdict": "met", "reason": "Done."}`]
    await route("PUT", "ses_work", { condition: "tests pass" })
    await until(() => goal()?.state === "met")
    expect((await route("POST", "ses_work/resume")).status).toBe(409)
  })
})
