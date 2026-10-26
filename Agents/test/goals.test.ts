import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineLink } from "../src/engine"
import { subscribe } from "../src/events"
import { goalRoutes, Goals, quietLimit, type Goal } from "../src/goals"
import type { ServerEvent } from "../src/wire"

// Goals as a box runs them: a conversation on the engine given a goal works toward it turn after
// turn, checked after each one, until it's met; against a stand-in engine (its HTTP API and live
// event feed), through the bridge's real link to it.

type Turn = { text?: string; tool?: boolean; outcome?: "succeeded" | "failed" | "interrupted"; error?: string }

/** The engine: a turn for each message, as `turns` script them, and the goal check's verdicts in turn. */
class StandIn {
  readonly conversations = new Map<string, any[]>()
  readonly synthetic: { session: string; text: string; description?: string }[] = []
  readonly checks: string[] = []
  verdicts: string[] = []
  turns: Turn[] = []
  /** Turns that wait for `finish` rather than ending at once. */
  holding = false
  private held: (() => void)[] = []
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

  /** Goal checks that wait for `answerChecks` rather than answering at once. */
  holdingChecks = false
  private heldChecks: (() => void)[] = []
  answerChecks() {
    for (const answer of this.heldChecks.splice(0)) answer()
  }

  /** The turns held, ended. */
  finish() {
    for (const end of this.held.splice(0)) end()
  }

  emit(type: string, data: any) {
    const line = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${this.next++}`, type, data })}\n\n`)
    for (const feed of this.feeds) feed.enqueue(line)
  }

  private add(session: string, message: any) {
    const conversation = this.conversations.get(session)!
    conversation.push({ id: `msg_${String(this.next++).padStart(4, "0")}`, time: { created: Date.now() }, ...message })
  }

  private turn(session: string) {
    const turn = this.turns.shift() ?? { tool: true, text: "Working on it." }
    this.emit("session.execution.started", { sessionID: session })
    const end = () => {
      const content = [...(turn.tool ? [{ type: "tool", name: "bash", state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "1 failing" }] } }] : []), ...(turn.text ? [{ type: "text", text: turn.text }] : [])]
      if (content.length) this.add(session, { type: "assistant", content })
      const outcome = turn.outcome ?? "succeeded"
      this.add(session, { type: "idle", outcome, ...(turn.error ? { error: { message: turn.error } } : {}) })
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
    const [, , session, what] = parts
    const conversation = this.conversations.get(session)
    if (!conversation) return Response.json({ message: "No such session." }, { status: 404 })
    const body: any = request.method === "POST" ? await request.json() : undefined
    try {
      if (what === "message") return Response.json({ data: [...conversation].reverse() })
      if (what === "synthetic") {
        this.synthetic.push({ session, text: body.text, description: body.description })
        this.add(session, { type: "synthetic", text: body.text, description: body.description })
        this.turn(session)
        return Response.json({ data: {} })
      }
      if (what === "generate") {
        this.checks.push(body.prompt)
        this.beat()
        if (this.holdingChecks) await new Promise<void>((resolve) => this.heldChecks.push(resolve))
        // Met, once the script runs out.
        return Response.json({ data: { text: this.verdicts.shift() ?? `{"verdict": "met", "reason": "Done."}` } })
      }
      return Response.json({ data: {} })
    } finally {
      this.beat()
    }
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

function makeGoals() {
  const made = new Goals(join(root, "goals.json"), {
    engine: { api: link, listen: (session, told) => link.listen(session, { event: (event) => told.event(event.type, event.data), reconnected: told.reconnected }) },
    bridge: { api: link, listen: () => () => {} },
    isBridge: () => false,
  })
  made.onSettled = () => {
    settled += 1
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
    await until(() => goal()?.state === "met")
    // Not met after its first turn: told what's left, it took another; met after that.
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: 2 tests in test/auth still fail."])
    expect(nudges()[0].text).toContain("Keep working toward the goal: all tests in test/auth pass")
    expect(goal()).toMatchObject({ state: "met", turns: 2, last: { verdict: "met", reason: "npm test exits 0." } })
    expect(goal()!.ended).toBeNumber()
    // The check read what the agent did and what its commands printed.
    expect(engine.checks[0]).toContain("<goal>\nall tests in test/auth pass\n</goal>")
    expect(engine.checks[0]).toContain("Agent ran bash")
    expect(engine.checks[0]).toContain("1 failing")
    // Clients heard each change, the last one met.
    expect(told()).toMatchObject({ state: "met" })
    expect(engine.synthetic).toHaveLength(2)
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
    expect(goal()).toMatchObject({ state: "paused", pausedBy: "you", note: "You stopped it." })
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

  test("pauses on a turn that failed, with the error", async () => {
    engine.turns = [{ outcome: "failed", error: "Rate limited by the provider." }]
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

  test("never checks a turn twice, when its end is heard again", async () => {
    engine.verdicts = [`{"verdict": "met", "reason": "Done."}`]
    await goals.set("ses_work", "README says hello")
    await until(() => goal()?.state === "met")
    const before = settled
    engine.emit("session.execution.succeeded", { sessionID: "ses_work" })
    engine.emit("session.execution.succeeded", { sessionID: "ses_work" })
    await until(() => settled >= before + 1)
    expect(engine.checks).toHaveLength(1)
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

  test("goes with its conversation", async () => {
    await goals.set("ses_work", "the build is green")
    engine.emit("session.deleted", { sessionID: "ses_work" })
    await until(() => told() === null)
    expect(goal()).toBeUndefined()
  })
})

describe("its routes", () => {
  const route = (method: string, path: string, value?: unknown) => goalRoutes(goals, method, path.split("/").filter(Boolean), async () => value)

  test("set, read, pause, resume and clear one, with what a client is told when it can't", async () => {
    expect((await route("GET", "")).status).toBe(200)
    expect(await (await route("GET", "")).json()).toEqual({ data: [] })
    expect((await route("GET", "ses_work")).status).toBe(404)
    expect((await route("PUT", "ses_work", { condition: "  " })).status).toBe(400)
    expect((await route("PUT", "ses_work", { condition: "x".repeat(4_001) })).status).toBe(400)
    expect(await (await route("PUT", "ses_nowhere", { condition: "tests pass" })).json()).toEqual({ message: "There's no such conversation here." })
    engine.holding = true
    const set = await route("PUT", "ses_work", { condition: "tests pass" })
    expect(set.status).toBe(200)
    expect((await set.json()).data).toMatchObject({ session: "ses_work", state: "working" })
    expect((await (await route("POST", "ses_work/pause")).json()).data.state).toBe("paused")
    expect((await (await route("GET", "")).json()).data).toHaveLength(1)
    expect((await route("DELETE", "ses_work")).status).toBe(200)
    expect(told()).toBeNull()
    expect((await route("POST", "ses_work/resume")).status).toBe(404)
  })

  test("a goal that's over can't be resumed: it's set again", async () => {
    engine.verdicts = [`{"verdict": "met", "reason": "Done."}`]
    await route("PUT", "ses_work", { condition: "tests pass" })
    await until(() => goal()?.state === "met")
    const resumed = await route("POST", "ses_work/resume")
    expect(resumed.status).toBe(409)
  })
})
