import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineLink } from "../../src/agents/engine"
import { subscribe } from "../../src/agents/events"
import { server } from "../../src/agents/groups/api"
import { goalRoutes, Goals, quietLimit, transcript, type Goal, type GoalPlaces } from "../../src/agents/goals"
import type { ServerEvent } from "../../src/agents/wire"
import { PAUSED_BY_YOU } from "../../src/shared/goals"
import { StandIn } from "./support/standin"

// Goals as a box runs them: a conversation given a goal works toward it turn after turn, checked
// after each one, until it's met; against a stand-in engine (its HTTP API and live event feed),
// through the bridge's real link to it, and as the bridge runs one of the coding agents'.

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
/** Writes to the conversation, and waits until the goal has looked at the turn that takes. */
async function turnOn(text: string, session = "ses_work") {
  const before = settled
  engine.write(session, text)
  await until(() => settled > before)
}
const nudges = (session = "ses_work") => engine.synthetic.filter((message) => message.session === session && message.text.startsWith("[Goal] Not met yet"))
/** The goal as clients last heard it. */
const told = (session = "ses_work") => events.filter((event) => event.type === "kuvo.goal.updated" && event.data.sessionID === session).at(-1)?.data.goal as Goal | null | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "kuvo-goals-"))
  settled = 0
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
  test("a summary asked for after a turn isn't taken for the turn: that turn is still what's checked", async () => {
    engine.verdicts = [`{"verdict": "met", "reason": "npm test exits 0."}`]
    engine.holding = true
    await goals.set("ses_work", "all tests pass")
    await until(() => engine.synthetic.length === 1)
    engine.holdingReads = true
    engine.finish()
    // Read only once the summary has ended too (its stream dropped, say).
    await until(() => engine.conversations.get("ses_work")!.at(-1)?.type === "idle")
    engine.conversations.get("ses_work")!.push({ id: "msg_zzsum", type: "compaction", status: "completed", reason: "manual", time: { created: 2 } }, { id: "msg_zzend", type: "idle", outcome: "succeeded", time: { created: 3 } })
    engine.answerReads()
    await until(() => goal()?.state === "met")
    expect(engine.checks).toHaveLength(1)
  })

  test("a summary taken during a turn on the engine is part of that turn: the turn is what's checked", async () => {
    engine.verdicts = [`{"verdict": "met", "reason": "npm test exits 0."}`]
    // A step of it, the summary at the next, and its end, with nothing written after.
    engine.turns.push({ tool: false, text: "" })
    engine.holding = true
    await goals.set("ses_work", "all tests pass")
    await until(() => engine.synthetic.length === 1)
    engine.conversations.get("ses_work")!.push(
      { id: "msg_zstep", type: "assistant", content: [{ type: "text", text: "Tests pass." }], time: { created: 2 } },
      { id: "msg_zmid", type: "compaction", status: "completed", reason: "manual", time: { created: 2 } },
    )
    engine.finish()
    await until(() => goal()?.state === "met")
    expect(engine.checks).toHaveLength(1)
  })

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

  test("is checked after a turn longer than a page of the conversation (hundreds of steps), and kept going", async () => {
    engine.turns = [{ steps: 450, tool: true, text: "Still two to fix." }]
    engine.verdicts = [`{"verdict": "not_met", "reason": "2 tests in test/auth still fail."}`, `{"verdict": "met", "reason": "npm test exits 0."}`]
    await goals.set("ses_work", "all tests in test/auth pass")
    await until(() => goal()?.state === "met")
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: 2 tests in test/auth still fail."])
    expect(goal()).toMatchObject({ state: "met", turns: 2 })
  })

  test("on one of OpenCode's free models, is checked afresh all the same", async () => {
    engine.freeModel = true
    engine.verdicts = [`{"verdict": "met", "reason": "Done."}`]
    await goals.set("ses_work", "README says hello")
    await until(() => goal()?.state === "met")
    // Still apart from the agent: in a session of the engine's own, shown the conversation,
    // hidden from lists, and gone once it answered.
    expect(engine.checks.map((check) => check.kind)).toEqual(["own"])
    expect(engine.checks[0].session).not.toBe("ses_work")
    expect(engine.checks[0].prompt).toContain("<conversation>")
    expect(engine.made[0]?.metadata).toEqual({ kuvo: { engineFor: "ses_work" } })
    expect(engine.conversations.has(engine.checks[0].session!)).toBe(false)
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

  test("waits while its conversation is archived, as its wake-ups do, and carries on once it's back", async () => {
    engine.verdicts = [`{"verdict": "not_met", "reason": "Tests still fail."}`, `{"verdict": "met", "reason": "Green."}`]
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    // Archived while the agent works on it: the turn under way ends, and nothing more goes.
    engine.metadata.set("ses_work", { "kuvo.archived": true })
    const before = settled
    engine.finish()
    await until(() => settled > before)
    expect(engine.checks).toHaveLength(0)
    expect(nudges()).toHaveLength(0)
    expect(goal()?.state).toBe("working")
    // Brought back: that turn is checked, and the agent told what's left.
    engine.holding = false
    engine.metadata.set("ses_work", { "kuvo.archived": false })
    engine.emit("session.metadata.updated", { sessionID: "ses_work" })
    await until(() => goal()?.state === "met")
    expect(nudges().map((message) => message.description)).toEqual(["Not met yet: Tests still fail."])
  })

  test("archived, and its turn cut short as the box stopped: brought back, that turn is checked, not taken as you stopping it", async () => {
    engine.turns = [{ tool: true, outcome: "interrupted" }]
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    engine.metadata.set("ses_work", { "kuvo.archived": true })
    goals.stopAll()
    engine.finish()
    goals = makeGoals()
    const before = settled
    goals.start()
    await until(() => settled > before)
    expect(engine.checks).toHaveLength(0)
    engine.metadata.set("ses_work", { "kuvo.archived": false })
    engine.emit("session.metadata.updated", { sessionID: "ses_work" })
    await until(() => goal()?.state !== "working")
    expect(goal()?.state).toBe("met")
  })

  test("pauses on a turn that failed, with the error", async () => {
    engine.turns = [{ outcome: "failed", error: "The model refused the request" }]
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "paused")
    expect(goal()).toMatchObject({ pausedBy: "error", note: "The turn failed: The model refused the request." })
  })

  test("waits at a model's limit until it resets, and carries on by itself then, a restart in between too, without checking the turn that failed", async () => {
    let clock = Date.parse("2026-10-29T12:00:00Z")
    goals.stopAll()
    const timed = (now: () => number) => {
      const made = new Goals(join(root, "goals.json"), places(), now)
      made.onSettled = () => {
        if (goals === made) settled += 1
        beat()
      }
      return made
    }
    goals = timed(() => clock)
    engine.turns = [{ outcome: "failed", error: "You've hit your usage limit. Try again in 2h 30m." }, { tool: true, text: "Carrying on." }]
    await goals.set("ses_work", "the site is live")
    await until(() => goal()?.state === "paused")
    const resumesAt = goal()!.resumesAt!
    expect(goal()!.pausedBy).toBe("limit")
    // From when the turn ended, not when the box noticed.
    expect(Math.abs(resumesAt - (Date.now() + 2.5 * 3_600_000))).toBeLessThan(10_000)
    expect(goal()!.note).toStartWith("Paused until ")
    expect(told()).toMatchObject({ pausedBy: "limit", resumesAt })
    // The box stops while it waits, and starts again once the reset has come: it carries on.
    goals.stopAll()
    clock = resumesAt + 60_000
    goals = timed(() => clock)
    goals.start()
    await until(() => goal()?.state === "working" && engine.synthetic.some((message) => message.description === "The limit has reset"))
    expect(goal()!.resumesAt).toBeUndefined()
    expect(engine.synthetic.at(-1)!.text).toContain("The model's limit has reset: carry on where you stopped.")
  })

  test("a check that meets a model's limit waits for the reset too, rather than stopping the goal", async () => {
    engine.verdictError = "429 Too Many Requests: rate limit reached"
    await goals.set("ses_work", "the site is live")
    await until(() => goal()?.state === "paused")
    expect(goal()!.pausedBy).toBe("limit")
    expect(goal()!.resumesAt).toBeGreaterThan(Date.now())
  })

  test("a limit that doesn't say when it resets is tried again in a while, and pausing it yourself holds it", async () => {
    engine.turns = [{ outcome: "failed", error: "429 Too Many Requests" }]
    await goals.set("ses_work", "the site is live")
    await until(() => goal()?.state === "paused")
    expect(goal()!.pausedBy).toBe("limit")
    expect(goal()!.resumesAt! - Date.now()).toBeGreaterThan(25 * 60_000)
    expect(goals.pauseByYou("ses_work")).toMatchObject({ pausedBy: "you" })
    expect(goal()!.resumesAt).toBeUndefined()
  })

  test("a bot's long goal is only kept, its plan telling the bot what's next: its turns aren't checked, nudged or paused for being quiet, and it isn't briefed twice", async () => {
    engine.turns = Array.from({ length: quietLimit + 1 }, () => ({ tool: false, text: "Waiting on the sessions." }))
    await goals.set("ses_work", "the site is live", { long: true })
    expect(engine.synthetic).toHaveLength(0)
    for (let turn = 0; turn < quietLimit + 1; turn++) await turnOn(`[Session finished] ${turn}`)
    expect(nudges()).toHaveLength(0)
    expect(engine.checks).toHaveLength(0)
    expect(goal()).toMatchObject({ state: "working", long: true, turns: 0 })
  })

  test("a bot's long goal isn't paused by a turn that failed or was stopped, which its plan tells the bot to carry on from: it stays at work, and you can still pause it", async () => {
    engine.turns = [{ tool: true, outcome: "failed", error: "Internal server error" }, { tool: true, outcome: "interrupted" }]
    await goals.set("ses_work", "the site is live", { long: true })
    await turnOn("[Goal] Carry on.")
    await turnOn("[Goal] Carry on.")
    expect(goal()).toMatchObject({ state: "working", long: true })
    expect(goals.pauseByYou("ses_work")).toMatchObject({ state: "paused", pausedBy: "you" })
  })

  test("a bot's long goal kept paused by a turn that failed or was stopped (by a box from before) is at work again once the box starts; one you paused stays paused", async () => {
    goals.stopAll()
    const kept = (session: string, pausedBy: string, note: string) => ({ session, condition: "the site is live", long: true, state: "paused", pausedBy, note, started: 1, turns: 0, checking: false, quiet: 0, limit: 50 })
    for (const session of ["ses_failed", "ses_stopped", "ses_held"]) engine.session(session, [{ id: "msg_0000", type: "idle", outcome: "succeeded", time: { created: 1 } }])
    writeFileSync(join(root, "goals.json"), JSON.stringify([kept("ses_failed", "error", "The turn failed: Internal server error."), kept("ses_stopped", "you", "The turn was stopped."), kept("ses_held", "you", PAUSED_BY_YOU)]))
    goals = makeGoals()
    expect(goal("ses_failed")).toMatchObject({ state: "working" })
    expect(goal("ses_stopped")).toMatchObject({ state: "working" })
    expect(goal("ses_held")).toMatchObject({ state: "paused", pausedBy: "you" })
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

  test("that's over goes with its conversation too", async () => {
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "met")
    engine.emit("session.deleted", { sessionID: "ses_work" })
    await until(() => told() === null)
    expect(goal()).toBeUndefined()
  })

  test("over or paused, goes once the box starts again when its conversation was deleted meanwhile", async () => {
    engine.session("ses_other", [{ id: "msg_0000", type: "idle", outcome: "succeeded", time: { created: 1 } }])
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "met")
    await goals.set("ses_other", "the lint is clean")
    goals.pauseByYou("ses_other")
    await until(() => goal("ses_other")?.state === "paused" && engine.checks.length === 1)
    goals.stopAll()
    engine.conversations.delete("ses_work")
    engine.conversations.delete("ses_other")
    goals = makeGoals()
    goals.start()
    await until(() => goals.list().length === 0)
    expect([told("ses_work"), told("ses_other")]).toEqual([null, null])
  })

  test("a look under way as the box stops keeps and tells nothing as it ends, though its conversation is gone by then", async () => {
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    engine.holdingReads = true
    engine.finish()
    await until(() => engine.readsHeld === 1)
    goals.stopAll()
    engine.conversations.delete("ses_work")
    const before = settled
    engine.answerReads()
    await until(() => settled > before)
    // The box started again finds it gone and says so; the stopped one leaves that to it.
    expect(told()?.state).toBe("working")
    expect(JSON.parse(readFileSync(join(root, "goals.json"), "utf8")).map((kept: Goal) => kept.session)).toEqual(["ses_work"])
  })

  test("is left as it is by a box that has stopped, whatever the engine answers it late", async () => {
    engine.holding = true
    await goals.set("ses_work", "the build is green")
    engine.holdingMessages = true
    engine.finish()
    await until(() => engine.heldMessages === 1)
    // The box stops while its look at the turn waits on the engine, and the conversation goes meanwhile.
    const stopped = goals
    let looked = false
    stopped.onSettled = () => {
      looked = true
      beat()
    }
    stopped.stopAll()
    engine.conversations.delete("ses_work")
    engine.answerMessages()
    await until(() => looked)
    expect(told()).toMatchObject({ condition: "the build is green", state: "working" })
    // Kept for the box that starts next, which finds the conversation gone itself.
    expect(JSON.parse(readFileSync(join(root, "goals.json"), "utf8"))).toMatchObject([{ session: "ses_work" }])
  })

  test("over, goes when its conversation was deleted while the engine was away", async () => {
    await goals.set("ses_work", "the build is green")
    await until(() => goal()?.state === "met")
    engine.conversations.delete("ses_work")
    // The engine started again (a new password): the bridge's link to it is told where it is anew.
    link.configure(engine.url, "y")
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
