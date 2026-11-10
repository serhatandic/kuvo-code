import "../safety"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sideQuestionRoutes, SideQuestions } from "../../src/agents/btw"
import { EngineLink } from "../../src/agents/engine"
import { subscribe } from "../../src/agents/events"
import type { GoalPlaces } from "../../src/agents/goals"
import { server } from "../../src/agents/groups/api"
import { branchRoutes } from "../../src/agents/branch"
import { handoffMarker, handoffRoutes, Handoffs } from "../../src/agents/handoff"
import { run } from "../../src/agents/proc"
import { gitChanges, readScope, reviewChoices, reviewRoutes, Reviews, type Parts } from "../../src/agents/reviews"
import type { ServerEvent } from "../../src/agents/wire"
import { StandIn } from "./support/standin"

// The box's keywords besides /goal, as a box runs them for a conversation on the engine or with
// the coding agents: side questions (/btw), handoffs (/handoff) and reviews with fresh eyes
// (/review), against a stand-in engine through the bridge's real link to it.

let root: string
let engine: StandIn
let link: EngineLink
let events: ServerEvent[]
let unsubscribe: () => void

const wakes = new Set<() => void>()
function beat() {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) await new Promise<void>((resolve) => wakes.add(() => (wakes.delete(resolve as any), resolve())))
}

/** Who's following which conversation's events, so a test can delete one. */
let following: { session: string; event(type: string, data: any): void }[] = []
const listen = (session: string, told: { event(type: string, data: any): void }) => {
  const entry = { session, event: told.event }
  following.push(entry)
  return () => void (following = following.filter((each) => each !== entry))
}
/** The conversation deleted, as its place says. */
function deleted(session: string) {
  for (const each of following.filter((each) => each.session === session)) each.event("session.deleted", { sessionID: session })
}

function places(bridge = false): GoalPlaces {
  return {
    engine: { api: link, listen },
    bridge: { api: server(engine.url, "x"), listen },
    isBridge: () => bridge,
  }
}

/** As `places`, the engine's events heard through its real link (a session under another is
 * heard through its parent's feed, as on a box). */
function linkedPlaces(): GoalPlaces {
  // As the box's own (agents/main.ts) hears it.
  return { ...places(), engine: { api: link, listen: (session, told) => link.listen(session, { event: (event) => told.event(event.type, event.data), reconnected: told.reconnected }) } }
}

/** What the conversation was told (a note or a message), which a side question never is. */
const told = (session = "ses_work") => engine.synthetic.filter((note) => note.session === session).length + engine.prompts(session).length

// git as it is, without your own settings (a global ignore file would hide what a test makes).
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-keywords-"))
  following = []
  engine = new StandIn(beat)
  // Its events reach those following them.
  engine.onEmit = (type, data) => {
    // A session under another is heard through its parent's feed too, as the engine's link does.
    const parent = engine.made.find((each) => each.id === data?.sessionID)?.parentID
    for (const each of following.filter((each) => each.session === data?.sessionID || (parent && each.session === parent))) each.event(type, data)
  }
  engine.session("ses_work", [
    { id: "msg_0001", type: "user", text: "Make the timer pause on blur.", time: { created: 1 } },
    { id: "msg_0002", type: "assistant", content: [{ type: "text", text: "Done: it pauses when the window loses focus." }], time: { created: 2 } },
    { id: "msg_0003", type: "idle", outcome: "succeeded", time: { created: 3 } },
  ])
  engine.titles.set("ses_work", "Pause on blur")
  link = new EngineLink()
  link.configure(engine.url, "x")
  events = []
  unsubscribe = subscribe((event) => {
    events.push(event)
    beat()
  })
})

afterEach(() => {
  unsubscribe()
  link.configure(undefined, undefined)
  engine.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("a side question", () => {
  test("is answered from the conversation's own context, kept in its list, and the conversation is told nothing", async () => {
    const questions = new SideQuestions(join(root, "btw.json"), places())
    questions.onAnswered = beat
    engine.answers = ["It uses the visibilitychange event."]
    const asked = await questions.ask("ses_work", "  Which event does it listen for?  ")
    expect(asked).toMatchObject({ question: "Which event does it listen for?", state: "answering" })
    await until(() => questions.list("ses_work")[0]?.state === "answered")
    expect(questions.list("ses_work")[0].answer).toBe("It uses the visibilitychange event.")
    // From inside the conversation (its own context), the question in the prompt.
    expect(engine.checks.map((check) => [check.kind, check.session])).toEqual([["own", "ses_work"]])
    expect(engine.checks[0].prompt).toContain("<question>\nWhich event does it listen for?\n</question>")
    expect(told()).toBe(0)
    // Clients heard it asked, then answered; the list beside the conversations has it.
    expect(events.filter((event) => event.type === "kuvo.btw.updated").map((event) => (event.data as any).question.state)).toEqual(["answering", "answered"])
    expect(questions.summary()).toMatchObject([{ session: "ses_work", count: 1, latest: { answer: "It uses the visibilitychange event." } }])
  })

  test("a follow-up follows on from its side thread; a new one starts afresh; a thread goes whole", async () => {
    const questions = new SideQuestions(join(root, "btw.json"), places())
    questions.onAnswered = beat
    engine.answers = ["visibilitychange.", "Safari 14 and later.", "A regex for durations."]
    const first = await questions.ask("ses_work", "Which event?")
    expect(first.thread).toBe(first.id)
    await until(() => questions.list("ses_work")[0]?.state === "answered")
    const followUp = (await (await sideQuestionRoutes(questions, "POST", ["ses_work"], async () => ({ question: "Which browsers have it?", thread: first.id }))).json() as any).data
    expect(followUp.thread).toBe(first.id)
    await until(() => questions.list("ses_work")[1]?.state === "answered")
    expect(engine.checks[1].prompt).toContain("Q: Which event?\nA: visibilitychange.")
    // Another /btw: a thread of its own, told nothing of the first.
    const other = await questions.ask("ses_work", "What does parseDuration match?")
    await until(() => questions.list("ses_work")[2]?.state === "answered")
    expect(other.thread).toBe(other.id)
    expect(engine.checks[2].prompt).not.toContain("visibilitychange")
    expect(questions.summary()).toEqual([expect.objectContaining({ session: "ses_work", count: 3, threads: 2 })])
    // A thread that isn't there, and a whole one taken away.
    expect((await sideQuestionRoutes(questions, "POST", ["ses_work"], async () => ({ question: "And?", thread: "btw_gone" }))).status).toBe(404)
    expect((await sideQuestionRoutes(questions, "DELETE", ["ses_work", "threads", first.id], async () => ({}))).status).toBe(200)
    expect(questions.list("ses_work").map((each) => each.question)).toEqual(["What does parseDuration match?"])
    expect((await sideQuestionRoutes(questions, "DELETE", ["ses_work", "threads", first.id], async () => ({}))).status).toBe(404)
  })

  test("a follow-up asked while the one before it is answered (from another client) still sees it", async () => {
    const questions = new SideQuestions(join(root, "btw.json"), places())
    questions.onAnswered = beat
    engine.holdingChecks = true
    const first = await questions.ask("ses_work", "Which event?")
    await until(() => engine.checks.length === 1)
    await questions.ask("ses_work", "And which browsers?", first.id)
    await until(() => engine.checks.length === 2)
    expect(engine.checks[1].prompt).toContain("Q: Which event?\nA: (not answered yet)")
    engine.answerChecks()
    questions.stopAll()
  })

  test("about a coding agent's conversation is answered with the conversation in the question", async () => {
    const questions = new SideQuestions(join(root, "btw.json"), places(true))
    questions.onAnswered = beat
    engine.answers = ["The timer pauses."]
    await questions.ask("ses_work", "What changed?")
    await until(() => questions.list("ses_work")[0]?.state === "answered")
    expect(engine.checks[0].prompt).toContain("<conversation>")
    expect(engine.checks[0].prompt).toContain("Person: Make the timer pause on blur.")
  })

  test("waiting as the box stopped is answered once it's back; routes say what can't be", async () => {
    const before = new SideQuestions(join(root, "btw.json"), places())
    engine.holdingChecks = true
    await before.ask("ses_work", "Which event?")
    await until(() => engine.checks.length === 1)
    before.stopAll()
    engine.holdingChecks = false
    engine.answers = ["Answered after the restart."]
    const after = new SideQuestions(join(root, "btw.json"), places())
    after.onAnswered = beat
    expect(after.list("ses_work")[0].state).toBe("answering")
    after.start()
    await until(() => after.list("ses_work")[0]?.state === "answered")
    expect(after.list("ses_work")[0].answer).toBe("Answered after the restart.")
    engine.answerChecks()

    const route = (method: string, path: string, value?: unknown) => sideQuestionRoutes(after, method, path.split("/").filter(Boolean), async () => value)
    expect((await route("POST", "ses_work", { question: " " })).status).toBe(400)
    expect((await route("POST", "ses_nowhere", { question: "Hi?" })).status).toBe(404)
    expect(((await (await route("GET", "ses_work")).json()) as any).data).toHaveLength(1)
    expect((await route("DELETE", "ses_work/" + after.list("ses_work")[0].id)).status).toBe(200)
    expect(after.list("ses_work")).toHaveLength(0)
    expect((await route("DELETE", "ses_work")).status).toBe(404)
  })
})

describe("a handoff", () => {
  test("starts a fresh conversation from a note the old one writes, linked both ways, with what to do next", async () => {
    const handoffs = new Handoffs(places())
    engine.answers = ["## Handoff\nThe timer pauses on blur. Left: a test for it."]
    // What else the conversation's metadata says stays, even what changed while the note was written.
    engine.metadata.set("ses_work", { pinned: true, kuvo: { goal: "g" } })
    engine.details.set("ses_work", { model: { providerID: "p", id: "m", variant: "high" }, agent: "plan", permissions: [{ permission: "bash", action: "allow", pattern: "*" }] })
    engine.holdingChecks = true
    const started = await handoffs.start("ses_work", "Write the test for it.")
    expect(started).toEqual({ from: "ses_work", state: "writing" })
    // One being written isn't started again.
    expect((await handoffRoutes(handoffs, "POST", ["ses_work"], async () => ({}))).status).toBe(409)
    await until(() => engine.checks.length === 1)
    engine.metadata.set("ses_work", { pinned: true, color: "blue", kuvo: { goal: "g" } })
    engine.answerChecks()
    await until(() => handoffs.get("ses_work")?.state !== "writing")
    const handoff = handoffs.get("ses_work")!
    expect(handoff).toMatchObject({ from: "ses_work", state: "done", title: "Pause on blur (continued)" })
    // Clients hear when it's done, with the new conversation to open.
    expect((events.filter((event) => event.type === "kuvo.handoff").at(-1)?.data as any)?.handoff).toMatchObject({ state: "done", to: handoff.to })
    expect(((await (await handoffRoutes(handoffs, "GET", ["ses_work"], async () => ({}))).json()) as any).data.to).toBe(handoff.to)
    // Written from inside the old conversation.
    expect(engine.checks.map((check) => check.session)).toEqual(["ses_work"])
    // The new one: same folder and model, given the note and the next step, as a note the
    // conversation shows as the handoff's.
    // On the same model and effort, agent and permissions.
    expect(engine.made[0]).toMatchObject({ title: "Pause on blur (continued)", location: { directory: "/tmp/project" }, model: { providerID: "p", id: "m", variant: "high" }, agent: "plan", permissions: [{ permission: "bash", action: "allow", pattern: "*" }] })
    const note = engine.synthetic.find((each) => each.session === handoff.to!)!
    expect(note.text).toStartWith(handoffMarker)
    expect(note.text).toContain("The timer pauses on blur. Left: a test for it.")
    expect(note.text).toContain("What to do next: Write the test for it.")
    expect(note.description).toBe("Carried on from “Pause on blur”")
    expect(engine.metadata.get(handoff.to!)).toEqual({ kuvo: { handoffFrom: "ses_work" } })
    expect(engine.metadata.get("ses_work")).toEqual({ pinned: true, color: "blue", kuvo: { goal: "g", handoffTo: handoff.to } })
    // The old conversation is told nothing.
    expect(told("ses_work")).toBe(0)
  })

  test("isn't made of a subagent's conversation, nor of one that isn't there", async () => {
    const handoffs = new Handoffs(places())
    engine.session("ses_child")
    engine.parents.set("ses_child", "ses_work")
    const route = (path: string) => handoffRoutes(handoffs, "POST", path.split("/").filter(Boolean), async () => ({}))
    expect((await route("ses_child")).status).toBe(409)
    expect((await route("ses_nowhere")).status).toBe(404)
    expect(engine.made).toHaveLength(0)
  })

  test("asked twice at once, it starts once", async () => {
    const handoffs = new Handoffs(places())
    engine.answers = ["## Handoff\nNote."]
    const both = await Promise.all([handoffRoutes(handoffs, "POST", ["ses_work"], async () => ({})), handoffRoutes(handoffs, "POST", ["ses_work"], async () => ({}))])
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 409])
    await until(() => handoffs.get("ses_work")?.state === "done")
    expect(engine.made).toHaveLength(1)
  })

  test("the agent set to work while the note was written: no new conversation beside it", async () => {
    const handoffs = new Handoffs(places())
    engine.answers = ["## Handoff\nNote."]
    engine.holdingChecks = true
    await handoffs.start("ses_work")
    await until(() => engine.checks.length === 1)
    engine.holding = true
    engine.write("ses_work", "One more thing.")
    engine.answerChecks()
    await until(() => handoffs.get("ses_work")?.state !== "writing")
    expect(handoffs.get("ses_work")?.error).toContain("started working while the note was written")
    expect(engine.made).toHaveLength(0)
    engine.finish()
  })

  test("its note reads what you first asked, however long the conversation has grown", async () => {
    const handoffs = new Handoffs(places(true))
    const long = Array.from({ length: 300 }, (_, index) => ({ id: `msg_${1000 + index}`, type: "assistant", content: [{ type: "text", text: `Step ${index}: ` + "x".repeat(600) }], time: { created: 10 + index } }))
    engine.session("ses_work", [{ id: "msg_0001", type: "user", text: "Make the timer pause on blur.", time: { created: 1 } }, ...long])
    engine.answers = ["## Handoff\nNote."]
    await handoffs.start("ses_work")
    await until(() => handoffs.get("ses_work")?.state !== "writing")
    const asked = engine.checks[0].prompt
    expect(asked.split("Person: Make the timer pause on blur.")).toHaveLength(2)
    expect(asked).toContain("[…earlier turns left out]")
    expect(asked).toContain("Step 299")
  })

  test("waits for the agent's turn to end: two agents at work in one folder would get in each other's way", async () => {
    const handoffs = new Handoffs(places())
    engine.holding = true
    engine.write("ses_work", "Keep going.")
    const answer = await handoffRoutes(handoffs, "POST", ["ses_work"], async () => ({}))
    expect(answer.status).toBe(409)
    expect(((await answer.json()) as any).message).toContain("working now")
    engine.finish()
    expect(engine.made).toHaveLength(0)
  })

  test("one whose note can't be written says why, and can be asked for again", async () => {
    const handoffs = new Handoffs(places())
    engine.answers = [""]
    await handoffs.start("ses_work")
    await until(() => handoffs.get("ses_work")?.state !== "writing")
    expect(handoffs.get("ses_work")).toMatchObject({ state: "failed", error: "The model wrote no handoff note." })
    expect(engine.made).toHaveLength(0)
    expect((await handoffs.start("ses_work")).state).toBe("writing")
    await until(() => handoffs.get("ses_work")?.state !== "writing")
  })
})

// "Branch from here": its place makes the copy, and the box marks where it came from, so every
// client shows it under that conversation, as it does a handoff's.
describe("a branch", () => {
  const route = (session: string, before?: string, bridge = false) => branchRoutes(places(bridge), "POST", [session], async () => (before ? { before } : {}))

  test("has the words before the message, and says where it came from, on the engine and with the coding agents alike", async () => {
    for (const bridge of [false, true]) {
      const answer = await route("ses_work", "msg_0002", bridge)
      expect(answer.status).toBe(200)
      const made = ((await answer.json()) as any).data
      expect(engine.conversations.get(made.id)!.map((message) => message.id)).toEqual(["msg_0001"])
      expect(made.metadata).toEqual({ kuvo: { branchedFrom: "ses_work" } })
      expect(engine.metadata.get(made.id)).toEqual({ kuvo: { branchedFrom: "ses_work" } })
    }
  })

  test("a branch of a pinned, handed-off conversation came from that one, and starts unpinned", async () => {
    engine.metadata.set("ses_work", { "kuvo.pinned": true, color: "blue", kuvo: { handoffFrom: "ses_old", handoffTo: "ses_new", branchedFrom: "ses_older", kuvoAgent: "claude" } })
    const made = ((await (await route("ses_work", "msg_0002", true)).json()) as any).data
    expect(engine.metadata.get(made.id)).toEqual({ color: "blue", kuvo: { kuvoAgent: "claude", branchedFrom: "ses_work" } })
    expect(engine.metadata.get("ses_work").kuvo.handoffTo).toBe("ses_new")
  })

  test("a branch of a session an agent started came from the one it's branched from, and opens nowhere by itself", async () => {
    engine.metadata.set("ses_work", { kuvo: { startedBy: "ses_lead", beside: true } })
    const made = ((await (await route("ses_work", "msg_0002")).json()) as any).data
    expect(made.metadata).toEqual({ kuvo: { branchedFrom: "ses_work" } })
    expect(engine.metadata.get(made.id)).toEqual({ kuvo: { branchedFrom: "ses_work" } })
  })

  test("a subagent's, a message that isn't there, and no message at all are turned away", async () => {
    engine.session("ses_sub", [{ id: "msg_0001", type: "user", text: "Find it.", time: { created: 1 } }])
    engine.parents.set("ses_sub", "ses_work")
    expect((await route("ses_sub", "msg_0001")).status).toBe(409)
    expect((await route("ses_work", "msg_9999")).status).toBe(404)
    expect((await route("ses_work")).status).toBe(400)
    expect((await route("ses_gone", "msg_0001")).status).toBe(404)
    expect([...engine.conversations.keys()].filter((id) => id.startsWith("ses_fork"))).toHaveLength(0)
  })
})

describe("a review with fresh eyes", () => {
  const changes = (diff: string) => async () => diff

  test("reads the changes apart from the agent and keeps what it found, bugs first, with what to tell the agent", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+  setTimeout(tick, 1000)\n"))
    reviews.onEnded = beat
    engine.answers = [`Looks like:\n{"summary": "Mostly fine.", "findings": [
      {"file": "src/timer.ts", "line": 12, "severity": "nit", "note": "Name the constant."},
      {"file": "src/timer.ts", "line": 40, "severity": "bug", "note": "The interval isn't cleared on pause."}]}`]
    const started = await reviews.start("ses_work")
    expect(started.state).toBe("reviewing")
    await until(() => reviews.get("ses_work")?.state === "done")
    const review = reviews.get("ses_work")!
    // Afresh on the session's model, shown the changes.
    expect(engine.checks.map((check) => check.kind)).toEqual(["fresh"])
    expect(engine.checks[0].prompt).toContain("setTimeout(tick, 1000)")
    expect(review.summary).toBe("Mostly fine.")
    expect(review.findings.map((each) => each.severity)).toEqual(["bug", "nit"])
    expect(review.fix).toContain("Bug: The interval isn't cleared on pause (src/timer.ts:40).")
    expect(told()).toBe(0)
    expect((events.filter((event) => event.type === "kuvo.review.updated").at(-1)?.data as any)?.review.state).toBe("done")
  })

  test("a finding can be in several places or in none; each has a title and says why", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+  setTimeout(tick, 1000)\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Two problems.", "findings": [
      {"title": "No test covers the paused timer", "explanation": "Nothing checks that pausing stops the ticks.", "severity": "risk", "locations": []},
      {"title": "Pausing twice skips a second", "explanation": "Both handlers clear the interval, then both start it again.", "severity": "bug",
       "locations": [{"file": "src/timer.ts", "line": 88, "endLine": 92}, {"file": "src/pause.ts", "line": 12}, {"file": "src/timer.ts"}]},
      {"file": "README.md", "line": 3, "severity": "nit", "note": "Says five minutes; the code says four. Make them agree."}]}`]
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    const [bug, risk, nit] = reviews.get("ses_work")!.findings
    expect(bug).toMatchObject({ title: "Pausing twice skips a second", severity: "bug", explanation: "Both handlers clear the interval, then both start it again." })
    expect(bug.locations).toEqual([{ file: "src/timer.ts", line: 88, endLine: 92 }, { file: "src/pause.ts", line: 12 }, { file: "src/timer.ts" }])
    expect(risk).toMatchObject({ title: "No test covers the paused timer", locations: [] })
    // An answer in the old shape is still read: its first sentence is the title.
    expect(nit).toMatchObject({ title: "Says five minutes; the code says four.", explanation: "Make them agree.", locations: [{ file: "README.md", line: 3 }] })
    expect(new Set([bug.id, risk.id, nit.id]).size).toBe(3)
    // The agent is told each, with every place it's in.
    const fix = reviews.get("ses_work")!.fix!
    expect(fix).toContain("Bug: Pausing twice skips a second (src/timer.ts:88-92, src/pause.ts:12, src/timer.ts). Both handlers clear the interval")
    expect(fix).toContain("Risk: No test covers the paused timer. Nothing checks")
  })

  test("what a model writes loosely is still read: places as text, a place twice, its own ids, a note beside a title", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+x\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Loose.", "findings": [
      {"id": "1", "title": "Pausing twice skips a second!?", "note": "Both handlers clear the interval.", "severity": "bug",
       "locations": ["src/timer.ts:88-92", "src/pause.ts:12", {"file": "src/pause.ts", "line": 12}, "README.md"]},
      {"id": "1", "title": "Another one", "severity": "nit", "locations": []}]}`]
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    const [bug, nit] = reviews.get("ses_work")!.findings
    expect(bug.locations).toEqual([{ file: "src/timer.ts", line: 88, endLine: 92 }, { file: "src/pause.ts", line: 12 }, { file: "README.md" }])
    expect(bug.explanation).toBe("Both handlers clear the interval.")
    expect(bug.id).not.toBe(nit.id)
    expect(reviews.get("ses_work")!.fix).toContain("Bug: Pausing twice skips a second (src/timer.ts:88-92, src/pause.ts:12, README.md). Both")

    // Kept and read again, each finding is still the same one.
    const again = new Reviews(join(root, "reviews.json"), places(), changes(""))
    expect(again.get("ses_work")!.findings.map((each) => each.id)).toEqual([bug.id, nit.id])
  })

  test("a review kept in the first shape is read in this one, and keeps its findings' ids", async () => {
    writeFileSync(join(root, "reviews.json"), JSON.stringify([{ id: "rev_1", session: "ses_work", state: "done", findings: [{ file: "src/a.ts", line: 3, severity: "bug", note: "It breaks. Fix it." }], started: 1, ended: 2 }]))
    const first = new Reviews(join(root, "reviews.json"), places(), changes(""))
    const [finding] = first.get("ses_work")!.findings
    expect(finding).toMatchObject({ title: "It breaks.", explanation: "Fix it.", locations: [{ file: "src/a.ts", line: 3 }] })
    first.stopAll()
    const second = new Reviews(join(root, "reviews.json"), places(), changes(""))
    expect(second.get("ses_work")!.findings[0].id).toBe(finding.id)
    second.stopAll()
  })

  test("what to tell an agent to fix them: all of them, or the ones you pick", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+x\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Two.", "findings": [
      {"title": "Pausing twice skips a second", "explanation": "Both handlers restart it.", "severity": "bug", "locations": [{"file": "src/timer.ts", "line": 88}]},
      {"title": "No test covers pausing", "explanation": "", "severity": "risk", "locations": []}]}`]
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    const [bug, risk] = reviews.get("ses_work")!.findings
    const fix = async (body: any) => (await (await reviewRoutes(reviews, "POST", ["ses_work", "fix"], async () => body)).json()) as any

    expect((await fix({})).data.text).toBe(reviews.get("ses_work")!.fix)
    const one = (await fix({ findings: [risk.id] })).data.text
    expect(one).toContain("- Risk: No test covers pausing.")
    expect(one).not.toContain("Pausing twice")
    expect((await reviewRoutes(reviews, "POST", ["ses_work", "fix"], async () => ({ findings: ["fnd_gone"] }))).status).toBe(404)
    expect(bug.id).toBeTruthy()
  })

  test("a scope: the branch, commits, a folder or the whole project, read in parts with progress", async () => {
    const asked: any[] = []
    const reviews = new Reviews(join(root, "reviews.json"), places(), async (_directory, scope) => {
      asked.push(scope)
      return scope.kind === "project" ? ["=== a.ts ===\n1  one", "=== b.ts ===\n1  two", "=== c.ts ===\n1  three"] : "+x\n"
    })
    reviews.onEnded = beat
    const progress: string[] = []
    const seen = events.length
    engine.answers = [
      `{"summary": "Part one.", "findings": [{"title": "Secret in a.ts", "explanation": "", "severity": "bug", "locations": [{"file": "a.ts", "line": 1}]}]}`,
      `{"summary": "Part two.", "findings": []}`,
      `{"summary": "Part three.", "findings": [{"title": "Slow loop in c.ts", "explanation": "", "severity": "nit", "locations": []}]}`,
    ]
    const route = (body: any) => reviewRoutes(reviews, "POST", ["ses_work"], async () => body)
    expect((await route({ scope: { kind: "project" }, focus: "security" })).status).toBe(200)
    await until(() => reviews.get("ses_work")?.state === "done")
    const review = reviews.get("ses_work")!
    expect(asked).toEqual([{ kind: "project" }])
    expect(review.scope).toEqual({ kind: "project" })
    // Each part read apart, the reviewer told which, what to look for in plain words.
    expect(engine.checks.map((check) => check.prompt.match(/part (\d) of 3/)?.[1])).toEqual(["1", "2", "3"])
    expect(engine.checks[0].prompt).toContain("secrets")
    // Its findings, all together, bugs first; how far along it was, as it went.
    expect(review.findings.map((each) => each.title)).toEqual(["Secret in a.ts", "Slow loop in c.ts"])
    for (const event of events.slice(seen)) {
      const told = (event.data as any)?.review?.progress
      // (Told again as each part's state changes: each step once.)
      if (event.type === "kuvo.review.updated" && told && progress.at(-1) !== `${told.read}/${told.of}`) progress.push(`${told.read}/${told.of}`)
    }
    expect(progress).toEqual(["0/3", "1/3", "2/3"])
    expect(review.progress).toBeUndefined()

    // The branch against its base, and a range of commits, go as they're asked.
    for (const scope of [{ kind: "branch", base: "main" }, { kind: "commits", from: "abc123", to: "def456" }, { kind: "folder", path: "src/auth" }]) {
      engine.answers = [`{"summary": "Fine.", "findings": []}`]
      expect((await route({ scope })).status).toBe(200)
      await until(() => reviews.get("ses_work")?.state === "done")
      expect(asked.at(-1)).toEqual(scope)
    }
    // One that makes no sense is refused, saying why.
    expect((await route({ scope: { kind: "folder", path: "../outside" } })).status).toBe(400)
    expect((await route({ scope: { kind: "commits" } })).status).toBe(400)
    expect((await route({ scope: { kind: "everything" } })).status).toBe(400)
  })

  test("read by the model you pick, looking where you say", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+  setTimeout(tick, 1000)\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Fine.", "findings": []}`]
    const response = await reviewRoutes(reviews, "POST", ["ses_work"], async () => ({ model: { providerID: "deepseek", id: "v4.1-flash" }, focus: "  the pause handling\n" }))
    expect(response.status).toBe(200)
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(engine.checks[0].model).toEqual({ providerID: "deepseek", id: "v4.1-flash" })
    expect(engine.checks[0].prompt).toContain("Look especially at what the user asked: the pause handling")
    expect(reviews.get("ses_work")).toMatchObject({ model: { providerID: "deepseek", id: "v4.1-flash" }, focus: "the pause handling" })
  })

  test("with nothing to review says so; one under way is waited for; put away, it's gone", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes(""))
    reviews.onEnded = beat
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(reviews.get("ses_work")).toMatchObject({ summary: "There are no changes to review: everything is committed.", findings: [] })
    expect(engine.checks).toHaveLength(0)

    const busy = new Reviews(join(root, "busy.json"), places(), changes("+x\n"))
    busy.onEnded = beat
    engine.holdingChecks = true
    engine.answers = [`{"summary": "Fine.", "findings": []}`]
    await busy.start("ses_work")
    await until(() => engine.checks.length === 1)
    const route = (method: string) => reviewRoutes(busy, method, ["ses_work"], async () => ({}))
    expect((await route("POST")).status).toBe(409)
    expect(busy.get("ses_work")?.state).toBe("reviewing")
    engine.answerChecks()
    await until(() => busy.get("ses_work")?.state === "done")
    reviews.dismiss("ses_work")
    expect(reviews.get("ses_work")).toBeUndefined()
  })

  test("on a free model, read in its part's session as on any other (no one-off answer, which free models don't give)", async () => {
    engine.freeModel = true
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+x\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Fine.", "findings": []}`]
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(reviews.get("ses_work")!.summary).toBe("Fine.")
    expect(engine.made.map((each) => Object.keys(each.metadata.kuvo))).toEqual([["reviewPart", "messages"]])
  })

  test("reads a folder's changes from its git: tracked files' diffs and new files whole", async () => {
    const folder = join(root, "repo")
    await run("git", ["init", "-q", folder])
    writeFileSync(join(folder, "a.txt"), "one\n")
    await run("git", ["-C", folder, "add", "-A"])
    await run("git", ["-C", folder, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "a"])
    writeFileSync(join(folder, "a.txt"), "one\ntwo\n")
    writeFileSync(join(folder, "b.txt"), "new file\n")
    const diff = await gitChanges(folder)
    expect(diff).toContain("+two")
    expect(diff).toContain("+++ b/b.txt")
    expect(diff).toContain("+new file")
  })

  test("in a repository with no commits yet, everything in it is new; links, big files and other folders' changes stay out", async () => {
    const folder = join(root, "fresh")
    await run("git", ["init", "-q", folder])
    mkdirSync(join(folder, "app"))
    mkdirSync(join(folder, "other"))
    writeFileSync(join(folder, "app", "main.ts"), "console.log(1)\n")
    await run("git", ["-C", folder, "add", "app/main.ts"])
    writeFileSync(join(folder, "app", "dump.bin"), "x".repeat(400_000))
    writeFileSync(join(root, "secret.txt"), "the key\n")
    symlinkSync(join(root, "secret.txt"), join(folder, "app", "link.txt"))
    writeFileSync(join(folder, "other", "theirs.ts"), "elsewhere\n")
    await run("git", ["-C", folder, "add", "other/theirs.ts"])
    const diff = await gitChanges(join(folder, "app"))
    expect(diff).toContain("+console.log(1)")
    expect(diff).toContain("dump.bin\n[a new file of 391 KB, not shown]")
    expect(diff).not.toContain("xxxx")
    expect(diff).not.toContain("the key")
    expect(diff).not.toContain("elsewhere")
  })

  test("a folder that isn't a repository says so", async () => {
    await expect(gitChanges(root)).rejects.toThrow("This folder isn't a git repository")
  })

  // (About twenty git commands, each a process of its own: over Bun's 5 s on a busy machine, though
  // it takes 2 s on a quiet one.)
  test("reads a branch against main, a range of commits, and a folder's or the project's files from its git", async () => {
    const folder = join(root, "work")
    const git = (...args: string[]) => run("git", ["-C", folder, "-c", "user.email=t@example.com", "-c", "user.name=T", ...args])
    await run("git", ["init", "-q", "-b", "main", folder])
    mkdirSync(join(folder, "src", "auth"), { recursive: true })
    writeFileSync(join(folder, "src", "auth", "login.ts"), "check(password)\n")
    writeFileSync(join(folder, "README.md"), "hello\n")
    writeFileSync(join(folder, ".gitignore"), "build/\n")
    await git("add", "-A")
    await git("commit", "-qm", "first")
    const first = (await git("rev-parse", "HEAD")).stdout.trim()
    await git("checkout", "-qb", "feature")
    writeFileSync(join(folder, "src", "auth", "login.ts"), "check(password)\nlog(password)\n")
    await git("commit", "-qam", "log it")
    writeFileSync(join(folder, "README.md"), "hello\nnot committed\n")

    // The branch: what it changed since main, with what isn't committed yet.
    const branch = (await readScope(folder, { kind: "branch" })) as string
    expect(branch).toContain("+log(password)")
    expect(branch).toContain("+not committed")
    // Commits: only what they changed.
    const commits = (await readScope(folder, { kind: "commits", from: first })) as string
    expect(commits).toContain("+log(password)")
    expect(commits).not.toContain("not committed")
    await expect(readScope(folder, { kind: "commits", from: "nothere" })).rejects.toThrow("There's no commit nothere here.")
    await expect(readScope(folder, { kind: "branch", base: "nothere" })).rejects.toThrow("no commit in common")

    // Files: numbered, those git ignores, lock files, links and what isn't text left out.
    mkdirSync(join(folder, "build"))
    writeFileSync(join(folder, "build", "out.js"), "built\n")
    writeFileSync(join(folder, "package-lock.json"), "{}\n")
    writeFileSync(join(folder, "icon.png"), "\0\x01binary")
    writeFileSync(join(root, "private.txt"), "the key\n")
    symlinkSync(join(root, "private.txt"), join(folder, "src", "linked.txt"))
    const project = ((await readScope(folder, { kind: "project" })) as Parts).parts
    expect(project).toHaveLength(1)
    expect(project[0]).toContain("=== src/auth/login.ts ===\n1  check(password)\n2  log(password)\n")
    expect(project[0]).toContain("=== README.md ===")
    for (const out of ["built", "package-lock", "binary", "the key"]) expect(project[0]).not.toContain(out)
    // How much it would read, before it's asked for (the branch: its two files and the new lock file).
    engine.directory = folder
    const reviews = new Reviews(join(root, "reviews.json"), places())
    const measure = async (scope: any) => (await (await reviewRoutes(reviews, "POST", ["ses_work", "measure"], async () => ({ scope }))).json() as any).data
    expect(await measure({ kind: "project" })).toEqual({ files: 3, parts: 1, leftOut: 0 })
    expect(await measure({ kind: "branch" })).toEqual({ files: 3, parts: 1, leftOut: 0, commits: 1 })
    // "since" the first commit: it and every one after, from nothing before it.
    expect(await measure({ kind: "commits", from: first + "^" })).toEqual({ files: 3, parts: 1, leftOut: 0, commits: 2 })
    expect(JSON.stringify(await readScope(folder, { kind: "commits", from: first + "^" }))).toContain("+check(password)")
    await expect(readScope(folder, { kind: "commits", from: "nothere^" })).rejects.toThrow("There's no commit nothere here.")

    // What "What to review" offers: the branch with its own commits, the latest commits, the folders.
    const choices = (await (await reviewRoutes(reviews, "GET", ["ses_work", "choices"], async () => ({}))).json() as any).data
    expect(choices.repository).toBe(true)
    expect(choices.branch).toEqual({ name: "feature", base: "main", commits: 1 })
    expect(choices.commits.map((each: any) => each.title)).toEqual(["log it", "first"])
    expect(choices.commits[0].short.length).toBeGreaterThanOrEqual(4)
    // (src has the link to a private file too: listed, never read.)
    expect(choices.folders).toEqual([{ path: "src", files: 2 }, { path: "src/auth", files: 1 }])
    // On main itself there's no branch of its own to offer.
    await git("checkout", "-q", "main")
    expect((await reviewChoices(folder)).branch).toBeUndefined()
    await git("checkout", "-q", "feature")
    reviews.stopAll()
    const auth = ((await readScope(folder, { kind: "folder", path: "src/auth" })) as Parts).parts
    expect(auth.join("")).toContain("=== src/auth/login.ts ===")
    expect(auth.join("")).not.toContain("README")
    // Never out of the project, through a link either.
    symlinkSync(root, join(folder, "outside"))
    await expect(readScope(folder, { kind: "folder", path: "outside" })).rejects.toThrow("isn't in this project")
    await expect(readScope(folder, { kind: "folder", path: "missing" })).rejects.toThrow("There's no missing in this project.")

    // A folder named like a pattern is that folder alone (Next.js's app/[id]), and a branch named
    // like a folder is the branch.
    mkdirSync(join(folder, "app", "[id]"), { recursive: true })
    writeFileSync(join(folder, "app", "[id]", "page.tsx"), "page\n")
    writeFileSync(join(folder, "app", "d"), "not in it\n")
    const page = (await readScope(folder, { kind: "folder", path: "app/[id]" })) as any
    expect(JSON.stringify(page)).toContain("=== app/[id]/page.tsx ===")
    expect(JSON.stringify(page)).not.toContain("not in it")
    mkdirSync(join(folder, "docs"))
    writeFileSync(join(folder, "docs", "a.md"), "doc\n")
    await git("branch", "docs", first)
    expect(JSON.stringify(await readScope(folder, { kind: "commits", from: "docs" }))).toContain("+log(password)")
  }, 30_000)

  test("a branch is compared with main as origin has it, when that's newer than your own main", async () => {
    const folder = join(root, "fetched")
    const git = (...args: string[]) => run("git", ["-C", folder, "-c", "user.email=t@example.com", "-c", "user.name=T", ...args])
    await run("git", ["init", "-q", "-b", "main", folder])
    writeFileSync(join(folder, "a.txt"), "one\n")
    await git("add", "-A")
    await git("commit", "-qm", "first")
    // Someone else's work reached origin's main, fetched but not pulled into yours.
    await git("checkout", "-qb", "theirs")
    writeFileSync(join(folder, "theirs.txt"), "their work\n")
    await git("add", "-A")
    await git("commit", "-qm", "theirs")
    await git("update-ref", "refs/remotes/origin/main", "HEAD")
    await git("checkout", "-q", "main")
    await git("branch", "-qD", "theirs")
    // Your branch, with origin's main merged in.
    await git("checkout", "-qb", "feature")
    await git("merge", "-q", "--no-edit", "origin/main")
    writeFileSync(join(folder, "mine.txt"), "my work\n")
    await git("add", "-A")
    await git("commit", "-qm", "mine")
    const branch = JSON.stringify(await readScope(folder, { kind: "branch" }))
    expect(branch).toContain("+my work")
    expect(branch).not.toContain("their work")
  })

  test("a project bigger than a review reads says how much it left out, and one stopped before reading says so", async () => {
    const folder = join(root, "huge")
    mkdirSync(folder)
    for (let each = 0; each < 40; each++) writeFileSync(join(folder, `f${String(each).padStart(2, "0")}.ts`), "x\n".repeat(30_000))
    engine.directory = folder
    const reviews = new Reviews(join(root, "reviews.json"), places())
    reviews.onEnded = beat
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => reviews.get("ses_work")?.state === "done")
    const review = reviews.get("ses_work")!
    expect(review.summary).toMatch(/^It read \d+ files\. .* (\d+) more files were left out: that's more than a review reads\.$/)
    expect(review.progress).toBeUndefined()

    const held = new Reviews(join(root, "held.json"), places(), changes("+x\n"))
    held.onEnded = beat
    engine.holdingChecks = true
    await held.start("ses_work")
    await until(() => engine.checks.length === 31)
    expect(held.stop("ses_work").summary).toBe("Stopped before it read anything.")
    engine.answerChecks()
    held.stopAll()
  })

  test("each part is read in a session of its own under the conversation, which can be watched as it reads and looked at after", async () => {
    const parts: Parts = { parts: ["=== src/a.ts ===\n1  a()\n", "=== src/b.ts ===\n1  b()\n=== src/c.ts ===\n1  c()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    engine.directory = "/tmp/project"
    engine.holdingChecks = true
    engine.answers = [
      `{"summary": "One.", "findings": [{"title": "a() throws", "explanation": "", "severity": "bug", "locations": [{"file": "src/a.ts", "line": 1}]}]}`,
      `{"summary": "Fine.", "findings": []}`,
    ]
    // The engine's feed open, as a box's is long before a review: the conversation is followed.
    const following = link.listen("ses_work", { event: () => {}, reconnected: () => {} })
    await until(() => engine.listening)
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    // The plan: each part, with the files it reads, waiting until its turn.
    await until(() => !!reviews.get("ses_work")?.parts?.[0]?.session)
    const first = reviews.get("ses_work")!.parts!
    expect(first.map((part) => ({ n: part.n, of: part.of, files: part.files, state: part.state }))).toEqual([
      { n: 1, of: 2, files: ["src/a.ts"], state: "reading" },
      { n: 2, of: 2, files: ["src/b.ts", "src/c.ts"], state: "waiting" },
    ])
    // Its session: the conversation's, hidden from lists, read-only, and told the part.
    const made = engine.made.find((each) => each.id === first[0].session)!
    expect(made.parentID).toBe("ses_work")
    expect(made.metadata.kuvo.reviewPart).toEqual({ review: reviews.get("ses_work")!.id, part: 1, of: 2 })
    expect(made.agent).toBe("plan")
    expect(made.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    // Read-only whatever was saved for the project: its session is in a project of its own (the
    // box's, a git repository with one empty commit), which no "Always allow" was ever saved for,
    // and from there it may only read, the project's folder too.
    expect(made.location.directory).toBe(join(root, "reviewers"))
    expect((await run("git", ["-C", join(root, "reviewers"), "log", "--format=%s"])).stdout.trim()).toBe("Kuvo Code's reviewers read projects from here")
    expect(made.permissions.filter((rule: any) => rule.effect === "allow").map((rule: any) => `${rule.action} ${rule.resource}`)).toEqual([
      "read *", "grep *", "glob *", "list *", "external_directory /tmp/project", "external_directory /tmp/project/*",
    ])
    await until(() => engine.prompts(first[0].session!).length === 1)
    expect(engine.prompts(first[0].session!)[0].text).toContain("=== src/a.ts ===")
    expect(engine.prompts(first[0].session!)[0].text).toContain("The project is in /tmp/project")

    // What it's doing now, as it goes: the file it reads, by its path in the project.
    engine.emit("session.tool.input.started", { sessionID: first[0].session, id: "t1", name: "read" })
    engine.emit("session.tool.called", { sessionID: first[0].session, id: "t1", input: { filePath: "/tmp/project/src/a.ts" } })
    await until(() => reviews.get("ses_work")?.parts?.[0]?.now === "Reading src/a.ts")
    engine.emit("session.reasoning.started", { sessionID: first[0].session })
    await until(() => reviews.get("ses_work")?.parts?.[0]?.now === "Thinking")

    // Done, the next one reads; what each found is counted, and its line is gone.
    engine.answerChecks()
    await until(() => !!reviews.get("ses_work")?.parts?.[1]?.session && engine.checks.length === 2)
    engine.answerChecks()
    await until(() => reviews.get("ses_work")?.state === "done")
    const review = reviews.get("ses_work")!
    expect(review.findings.map((each) => each.title)).toEqual(["a() throws"])
    expect(review.parts!.map((part) => ({ state: part.state, found: part.found, now: part.now }))).toEqual([
      { state: "done", found: 1, now: undefined },
      { state: "done", found: 0, now: undefined },
    ])
    // Kept while the review is, gone with it.
    const sessions = review.parts!.map((part) => part.session!)
    expect(sessions.every((id) => engine.conversations.has(id))).toBe(true)
    reviews.dismiss("ses_work")
    await until(() => sessions.every((id) => engine.deleted.includes(id)))
    engine.holdingChecks = false
    following()
    reviews.stopAll()
  })

  test("a part whose end went by while the engine's feed was away is read once it's back, from how its turn ended", async () => {
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    const following = link.listen("ses_work", { event: () => {}, reconnected: () => {} })
    await until(() => engine.listening)
    engine.silentParts = true
    engine.answers = [`{"summary": "One.", "findings": [{"title": "a() throws", "explanation": "", "severity": "bug", "locations": []}]}`]
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => engine.checks.length === 1 && engine.conversations.get(reviews.get("ses_work")!.parts![0].session!)?.some((each) => each.type === "idle") === true)
    // The link comes back (as when the engine started again): the part's end is read from its session.
    link.configure(engine.url + "/", "x")
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(reviews.get("ses_work")!.parts![0].state).toBe("done")
    expect(reviews.get("ses_work")!.findings.map((each) => each.title)).toEqual(["a() throws"])
    engine.silentParts = false
    following()
    reviews.stopAll()
  })

  test("stopped while a part reads, its session is stopped too; the parts after it are never read", async () => {
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n", "=== b.ts ===\n1  b()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    engine.holdingChecks = true
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => engine.checks.length === 1)
    const reading = reviews.get("ses_work")!.parts![0].session!
    reviews.stop("ses_work")
    await until(() => engine.interrupted.includes(reading))
    expect(reviews.get("ses_work")!.parts!.map((part) => part.state)).toEqual(["stopped", "waiting"])
    engine.holdingChecks = false
    engine.answerChecks()
    reviews.stopAll()
  })

  test("stopped while a part's prompt is on its way, its turn is stopped once it begins", async () => {
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    engine.holdingPrompts = true
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => !!reviews.get("ses_work")?.parts?.[0]?.session && engine.prompts(reviews.get("ses_work")!.parts![0].session!).length === 1)
    const reading = reviews.get("ses_work")!.parts![0].session!
    // Stopped before the engine began its turn: that interrupt finds nothing to stop…
    reviews.stop("ses_work")
    await until(() => engine.interrupted.includes(reading))
    // …so it's stopped again once the turn has begun.
    engine.beginPrompts()
    await until(() => engine.interrupted.filter((each) => each === reading).length === 2)
    reviews.stopAll()
  })

  test("stopped while a part's prompt is on its way and its turn begins only after it's answered, its turn is still stopped", async () => {
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    engine.holdingPrompts = true
    engine.turnsBeginLate = true
    engine.holdingChecks = true
    engine.interruptEndsParts = true
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => !!reviews.get("ses_work")?.parts?.[0]?.session && engine.prompts(reviews.get("ses_work")!.parts![0].session!).length === 1)
    const reading = reviews.get("ses_work")!.parts![0].session!
    reviews.stop("ses_work")
    // Its prompt answered, its turn not yet begun: the interrupts so far find nothing to stop.
    engine.beginPrompts()
    await until(() => engine.interrupted.filter((each) => each === reading).length === 2)
    engine.beginTurns()
    await until(() => engine.conversations.get(reading)!.at(-1)?.type === "idle")
    expect(engine.conversations.get(reading)!.at(-1)!.outcome).toBe("interrupted")
    engine.answerChecks()
    reviews.stopAll()
  })

  test("a review starting as the box starts again keeps its part's session, while one no review records is deleted", async () => {
    const orphan = (await link.request("POST", "/api/session", { title: "Review · part", parentID: "ses_work", location: { directory: join(root, "reviewers") }, metadata: { kuvo: { reviewPart: { review: "rev_gone", part: 1, of: 1 } } } })).data.id
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    // Its part's session made, its answer back only once the box has listed the sessions.
    engine.answersMadeOnListing = true
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => engine.made.length === 2)
    reviews.resume()
    await until(() => reviews.get("ses_work")?.state !== "reviewing")
    expect(reviews.get("ses_work")!.state).toBe("done")
    const read = reviews.get("ses_work")!.parts![0].session!
    expect(engine.deleted).not.toContain(read)
    // Nothing being made any more: the next start deletes the one no review records.
    reviews.resume()
    await until(() => engine.deleted.includes(orphan))
    expect(engine.deleted).toEqual([orphan])
    reviews.stopAll()
  })

  test("reviews whose first parts start together both read them, from one project of their own", async () => {
    engine.session("ses_other")
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    await Promise.all([reviews.start("ses_work", undefined, undefined, { kind: "project" }), reviews.start("ses_other", undefined, undefined, { kind: "project" })])
    await until(() => reviews.get("ses_work")?.state !== "reviewing" && reviews.get("ses_other")?.state !== "reviewing")
    expect([reviews.get("ses_work")!.state, reviews.get("ses_other")!.state]).toEqual(["done", "done"])
    expect(engine.made.map((each) => each.location.directory)).toEqual([join(root, "reviewers"), join(root, "reviewers")])
    expect((await run("git", ["-C", join(root, "reviewers"), "log", "--format=%s"])).stdout.trim()).toBe("Kuvo Code's reviewers read projects from here")
    reviews.stopAll()
  })

  test("the only part stopped from its own session leaves the review stopped, not failed", async () => {
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    engine.holdingChecks = true
    engine.interruptEndsParts = true
    const following = link.listen("ses_work", { event: () => {}, reconnected: () => {} })
    await until(() => engine.listening)
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => engine.checks.length === 1)
    // Its Stop, in its own view.
    await link.request("POST", `/api/session/${reviews.get("ses_work")!.parts![0].session}/interrupt`)
    await until(() => reviews.get("ses_work")?.state !== "reviewing")
    const review = reviews.get("ses_work")!
    expect({ state: review.state, summary: review.summary, error: review.error }).toEqual({ state: "done", summary: "Stopped before it read anything.", error: undefined })
    expect(review.parts!.map((part) => part.state)).toEqual(["stopped"])
    engine.answerChecks()
    following()
    reviews.stopAll()
  })

  test("parts read from a project of their own though your git signs commits, and a folder left without its commit is set up again", async () => {
    // Your own git: every commit signed (by a program that can't sign here), and a hook that fails.
    const config = join(root, "gitconfig")
    mkdirSync(join(root, "hooks"))
    writeFileSync(join(root, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    writeFileSync(config, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[core]\n\thooksPath = ${join(root, "hooks")}\n`)
    const before = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      // Left from before: a repository without its commit.
      mkdirSync(join(root, "reviewers"))
      await run("git", ["-C", join(root, "reviewers"), "init", "-q"])
      const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
      const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
      reviews.onEnded = beat
      await reviews.start("ses_work", undefined, undefined, { kind: "project" })
      await until(() => reviews.get("ses_work")?.state !== "reviewing")
      expect(reviews.get("ses_work")!.state).toBe("done")
      expect(engine.made[0].location.directory).toBe(join(root, "reviewers"))
      expect((await run("git", ["-C", join(root, "reviewers"), "log", "--format=%s"])).stdout.trim()).toBe("Kuvo Code's reviewers read projects from here")
      reviews.stopAll()
    } finally {
      if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before
    }
  })

  test("a part isn't read when its project of its own can't be set up, and the review says why", async () => {
    // Where the folder would be, a file.
    writeFileSync(join(root, "reviewers"), "")
    const parts: Parts = { parts: ["=== a.ts ===\n1  a()\n"], leftOut: 0 }
    const reviews = new Reviews(join(root, "reviews.json"), linkedPlaces(), async () => parts)
    reviews.onEnded = beat
    await reviews.start("ses_work", undefined, undefined, { kind: "project" })
    await until(() => reviews.get("ses_work")?.state !== "reviewing")
    expect(reviews.get("ses_work")!.state).toBe("failed")
    expect(reviews.get("ses_work")!.error).toContain("couldn't set up the folder its reviewers read from")
    expect(engine.made).toEqual([])
    expect(engine.checks).toEqual([])
    reviews.stopAll()
  })

  test("once the engine's there after the box starts again, a part left reading is stopped and parts' sessions no review records are deleted", async () => {
    const folder = join(root, "reviewers")
    const part = (n: number) => ({ title: "Review · part", parentID: "ses_work", location: { directory: folder }, metadata: { kuvo: { reviewPart: { review: "rev_1", part: n, of: 2 } } } })
    const recorded = (await link.request("POST", "/api/session", part(1))).data.id
    const orphan = (await link.request("POST", "/api/session", part(2))).data.id
    const elsewhere = (await link.request("POST", "/api/session", { ...part(2), location: { directory: "/tmp/project" } })).data.id
    const plain = (await link.request("POST", "/api/session", { title: "Yours", location: { directory: folder } })).data.id
    writeFileSync(join(root, "reviews.json"), JSON.stringify([{ id: "rev_1", session: "ses_work", state: "reviewing", findings: [], started: 1, parts: [
      { n: 1, of: 2, files: ["a.ts"], fileCount: 1, state: "reading", found: 0, session: recorded },
      { n: 2, of: 2, files: ["b.ts"], fileCount: 1, state: "waiting", found: 0 },
    ] }]))
    // The box starts before it knows where the engine is.
    const late = new EngineLink()
    const reviews = new Reviews(join(root, "reviews.json"), { ...places(), engine: { api: late, listen } }, async () => ({ parts: [], leftOut: 0 }))
    const starting = late.whenReady().then(() => reviews.resume())
    expect(engine.interrupted).toEqual([])
    late.configure(engine.url, "x")
    await starting
    await until(() => engine.interrupted.includes(recorded) && engine.deleted.includes(orphan))
    expect(engine.deleted).toEqual([orphan])
    expect([recorded, elsewhere, plain].every((id) => engine.conversations.has(id))).toBe(true)
    late.configure(undefined, undefined)
    reviews.stopAll()
  })

  test("out of a repository, What to review offers only the folders", async () => {
    const folder = join(root, "loose")
    mkdirSync(join(folder, "lib", "deep"), { recursive: true })
    writeFileSync(join(folder, "lib", "a.ts"), "a\n")
    writeFileSync(join(folder, "lib", "deep", "b.ts"), "b\n")
    expect(await reviewChoices(folder)).toEqual({ repository: false, commits: [], folders: [{ path: "lib", files: 2 }, { path: "lib/deep", files: 1 }], describes: true })
  })

  test("what you describe in words is read as the files the model finds for it, measured first, the same ones reviewed", async () => {
    const folder = join(root, "described")
    const git = (...args: string[]) => run("git", ["-C", folder, "-c", "user.email=t@example.com", "-c", "user.name=T", ...args])
    await run("git", ["init", "-q", "-b", "main", folder])
    mkdirSync(join(folder, "src", "auth"), { recursive: true })
    mkdirSync(join(folder, "test"))
    writeFileSync(join(folder, "src", "auth", "login.ts"), "check(password)\n")
    writeFileSync(join(folder, "src", "auth", "session.ts"), "keep(token)\n")
    writeFileSync(join(folder, "test", "login.test.ts"), "expect(login())\n")
    writeFileSync(join(folder, "src", "billing.ts"), "charge()\n")
    writeFileSync(join(folder, ".env"), "KEY=secret\n")
    await git("add", "-A")
    await git("commit", "-qm", "first")
    writeFileSync(join(folder, "src", "billing.ts"), "charge(twice)\n")
    engine.directory = folder
    const reviews = new Reviews(join(root, "reviews.json"), places())
    reviews.onEnded = beat
    const measure = (scope: any) => reviewRoutes(reviews, "POST", ["ses_work", "measure"], async () => ({ scope }))

    // The model picks from the project's files, told what changed lately; a folder is each file
    // in it, and one it made up, one out of the project or a secret is never read.
    engine.answers = [`{"paths": ["src/auth/", "test/login.test.ts", "src/made-up.ts", "../outside.ts", ".env"]}`]
    const size = (await (await measure({ kind: "described", words: "the auth module and its tests" })).json() as any).data
    expect(size).toEqual({ files: 3, parts: 1, leftOut: 0, found: ["src/auth/login.ts", "src/auth/session.ts", "test/login.test.ts"] })
    const asked = engine.checks.at(-1)!.prompt
    expect(asked).toContain("<words>\nthe auth module and its tests\n</words>")
    expect(asked).toContain("src/billing.ts")
    expect(asked).toContain("Not committed yet:\nsrc/billing.ts")

    // Asked for soon after, it reads those same files, without asking again, and keeps them.
    const checks = engine.checks.length
    engine.answers = [`{"summary": "Fine.", "findings": []}`]
    await reviewRoutes(reviews, "POST", ["ses_work"], async () => ({ scope: { kind: "described", words: "the auth module and its tests", paths: ["src/billing.ts"] } }))
    await until(() => reviews.get("ses_work")?.state === "done")
    const review = reviews.get("ses_work")!
    expect(review.scope).toEqual({ kind: "described", words: "the auth module and its tests", paths: ["src/auth/login.ts", "src/auth/session.ts", "test/login.test.ts"] })
    expect(engine.checks.length).toBe(checks + 1)
    const read = engine.checks.at(-1)!.prompt
    expect(read).toContain("=== src/auth/session.ts ===")
    expect(read).not.toContain("charge")
    expect(read).not.toContain("KEY=secret")

    // Words that fit nothing are said so; none at all aren't a scope.
    engine.answers = [`{"paths": []}`]
    const none = await measure({ kind: "described", words: "the payment gateway" })
    expect(none.status).toBe(422)
    expect(((await none.json()) as any).message).toBe("No files in this project fit that. Say it another way, or pick a folder.")
    expect((await measure({ kind: "described", words: "  " })).status).toBe(400)

    // Files that fit but can't be read (a picture) are said so before a review is asked for, and
    // only the ones it reads are named.
    writeFileSync(join(folder, "logo.png"), "\0\x01binary")
    writeFileSync(join(folder, "package-lock.json"), "{}\n")
    await git("add", "-A")
    await git("commit", "-qm", "more")
    engine.answers = [`{"paths": ["logo.png", "package-lock.json"]}`]
    const unreadable = await measure({ kind: "described", words: "the logo" })
    expect(unreadable.status).toBe(422)
    expect(((await unreadable.json()) as any).message).toBe("None of the files that fit can be reviewed: they aren't text, or they're too big.")
    engine.answers = [`{"paths": ["src/billing.ts", "package-lock.json"]}`]
    expect(((await (await measure({ kind: "described", words: "billing" })).json()) as any).data).toEqual({ files: 1, parts: 1, leftOut: 0, found: ["src/billing.ts"] })
    reviews.stopAll()
  })

  test("a review asked for while its words' files are still being found waits for them, and reads the same ones", async () => {
    const folder = join(root, "pending")
    await run("git", ["init", "-q", "-b", "main", folder])
    writeFileSync(join(folder, "a.ts"), "a()\n")
    writeFileSync(join(folder, "b.ts"), "b()\n")
    engine.directory = folder
    const reviews = new Reviews(join(root, "reviews.json"), places())
    reviews.onEnded = beat
    engine.holdingChecks = true
    const measuring = reviewRoutes(reviews, "POST", ["ses_work", "measure"], async () => ({ scope: { kind: "described", words: "the a file" } }))
    await until(() => engine.checks.length === 1)
    await reviewRoutes(reviews, "POST", ["ses_work"], async () => ({ scope: { kind: "described", words: "the a file" } }))
    engine.answers = [`{"paths": ["a.ts"]}`, `{"summary": "Fine.", "findings": []}`]
    engine.holdingChecks = false
    engine.answerChecks()
    expect(((await (await measuring).json()) as any).data.found).toEqual(["a.ts"])
    await until(() => reviews.get("ses_work")?.state === "done")
    // One question for the files, one for the review.
    expect(engine.checks.length).toBe(2)
    expect(reviews.get("ses_work")!.scope).toEqual({ kind: "described", words: "the a file", paths: ["a.ts"] })
    reviews.stopAll()
  })

  test("a big project is read in parts, and a folder that isn't a repository still has its files read", async () => {
    const folder = join(root, "plain")
    mkdirSync(join(folder, "node_modules"), { recursive: true })
    writeFileSync(join(folder, "node_modules", "dep.js"), "theirs\n")
    for (let each = 0; each < 6; each++) writeFileSync(join(folder, `file${each}.ts`), `const line = ${each}\n`.repeat(2_000))
    const { parts } = (await readScope(folder, { kind: "project" })) as Parts
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((part) => part.length <= 81_000)).toBe(true)
    const all = parts.join("")
    for (let each = 0; each < 6; each++) expect(all).toContain(`=== file${each}.ts ===`)
    expect(all).not.toContain("theirs")
  })

  test("stopped while it reads, it keeps what it found so far", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), async () => ["=== a.ts ===\n1  one", "=== b.ts ===\n1  two"])
    let ended = 0
    reviews.onEnded = () => (ended++, beat())
    engine.answers = [`{"summary": "One.", "findings": [{"title": "Leak in a.ts", "explanation": "", "severity": "risk", "locations": []}]}`, `{"summary": "Two.", "findings": [{"title": "Too late", "explanation": "", "severity": "bug", "locations": []}]}`]
    engine.holdingChecks = true
    await reviewRoutes(reviews, "POST", ["ses_work"], async () => ({ scope: { kind: "project" } }))
    await until(() => engine.checks.length === 1)
    engine.answerChecks()
    await until(() => reviews.get("ses_work")?.progress?.read === 1 && engine.checks.length === 2)
    const stopped = await reviewRoutes(reviews, "POST", ["ses_work", "stop"], async () => ({}))
    expect(stopped.status).toBe(200)
    // The part it was reading when stopped, answered after: not taken.
    engine.answerChecks()
    await until(() => ended === 1)
    const review = reviews.get("ses_work")!
    expect(review.state).toBe("done")
    expect(review.summary).toBe("Stopped after 1 of 2 parts. It found 1 thing to fix.")
    expect(review.stopped).toEqual({ read: 1, of: 2 })
    expect(review.findings.map((each) => each.title)).toEqual(["Leak in a.ts"])
    expect(review.fix).toContain("Leak in a.ts")
    expect((await reviewRoutes(reviews, "POST", ["ses_work", "stop"], async () => ({}))).status).toBe(409)
  })
})

describe("a conversation deleted", () => {
  test("takes its side questions and its review with it", async () => {
    const questions = new SideQuestions(join(root, "side-questions.json"), places())
    questions.onAnswered = beat
    engine.answers = ["It pauses on blur.", `{"summary": "Fine.", "findings": []}`]
    await questions.ask("ses_work", "What does it do?")
    await until(() => questions.list("ses_work")[0]?.state === "answered")
    const reviews = new Reviews(join(root, "reviews.json"), places(), async () => "+x\n")
    reviews.onEnded = beat
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    deleted("ses_work")
    expect(questions.list("ses_work")).toHaveLength(0)
    expect(reviews.get("ses_work")).toBeUndefined()
    expect(following).toHaveLength(0)
    expect((events.filter((event) => event.type === "kuvo.review.updated").at(-1)?.data as any)?.review).toBeNull()
    // Gone after a restart too.
    const after = new Reviews(join(root, "reviews.json"), places(), async () => "")
    expect(after.get("ses_work")).toBeUndefined()
  })

  test("while the box was stopped, they go once it's back", async () => {
    const question = { id: "btw_1", session: "ses_gone", question: "Why?", state: "answered", answer: "Because.", asked: 1, answered: 2 }
    writeFileSync(join(root, "side-questions.json"), JSON.stringify([question, { ...question, id: "btw_2", session: "ses_work" }]))
    writeFileSync(join(root, "reviews.json"), JSON.stringify([{ id: "rev_1", session: "ses_gone", state: "done", findings: [], started: 1, ended: 2 }]))
    const questions = new SideQuestions(join(root, "side-questions.json"), places())
    const reviews = new Reviews(join(root, "reviews.json"), places(), async () => "")
    await until(() => questions.list("ses_gone").length === 0 && reviews.get("ses_gone") === undefined)
    expect(questions.list("ses_work")).toHaveLength(1)
  })
})
