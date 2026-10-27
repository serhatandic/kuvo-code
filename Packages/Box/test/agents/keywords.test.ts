import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sideQuestionRoutes, SideQuestions } from "../../src/agents/btw"
import { EngineLink } from "../../src/agents/engine"
import { subscribe } from "../../src/agents/events"
import type { GoalPlaces } from "../../src/agents/goals"
import { server } from "../../src/agents/groups/api"
import { handoffMarker, handoffRoutes, Handoffs } from "../../src/agents/handoff"
import { run } from "../../src/agents/proc"
import { gitChanges, readScope, reviewRoutes, Reviews } from "../../src/agents/reviews"
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

/** What the conversation was told (a note or a message), which a side question never is. */
const told = (session = "ses_work") => engine.synthetic.filter((note) => note.session === session).length + engine.prompts(session).length

// git as it is, without your own settings (a global ignore file would hide what a test makes).
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-keywords-"))
  following = []
  engine = new StandIn(beat)
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

  test("follows on from the ones before it", async () => {
    const questions = new SideQuestions(join(root, "btw.json"), places())
    questions.onAnswered = beat
    engine.answers = ["visibilitychange.", "Safari 14 and later."]
    await questions.ask("ses_work", "Which event?")
    await until(() => questions.list("ses_work")[0]?.state === "answered")
    await questions.ask("ses_work", "Which browsers have it?")
    await until(() => questions.list("ses_work")[1]?.state === "answered")
    expect(engine.checks[1].prompt).toContain("Q: Which event?\nA: visibilitychange.")
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
      if (event.type === "kuvo.review.updated" && told) progress.push(`${told.read}/${told.of}`)
    }
    expect(progress).toEqual(["0/3", "1/3", "2/3", "3/3"])

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

  test("on a free model, in a session of the engine's own that's gone after", async () => {
    engine.freeModel = true
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes("+x\n"))
    reviews.onEnded = beat
    engine.answers = [`{"summary": "Fine.", "findings": []}`]
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(engine.made[0]?.metadata).toEqual({ kuvo: { engineFor: "ses_work" } })
    expect(engine.conversations.has(engine.made[0].id)).toBe(false)
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
    const project = (await readScope(folder, { kind: "project" })) as string[]
    expect(project).toHaveLength(1)
    expect(project[0]).toContain("=== src/auth/login.ts ===\n1  check(password)\n2  log(password)\n")
    expect(project[0]).toContain("=== README.md ===")
    for (const out of ["built", "package-lock", "binary", "the key"]) expect(project[0]).not.toContain(out)
    // How much it would read, before it's asked for (the branch: its two files and the new lock file).
    engine.directory = folder
    const reviews = new Reviews(join(root, "reviews.json"), places())
    const measure = async (scope: any) => (await (await reviewRoutes(reviews, "POST", ["ses_work", "measure"], async () => ({ scope }))).json()).data
    expect(await measure({ kind: "project" })).toEqual({ files: 3, parts: 1, leftOut: 0 })
    expect(await measure({ kind: "branch" })).toEqual({ files: 3, parts: 1, leftOut: 0 })
    reviews.stopAll()
    const auth = (await readScope(folder, { kind: "folder", path: "src/auth" })) as string[]
    expect(auth.join("")).toContain("=== src/auth/login.ts ===")
    expect(auth.join("")).not.toContain("README")
    // Never out of the project, through a link either.
    symlinkSync(root, join(folder, "outside"))
    await expect(readScope(folder, { kind: "folder", path: "outside" })).rejects.toThrow("isn't in this project")
    await expect(readScope(folder, { kind: "folder", path: "missing" })).rejects.toThrow("There's no missing in this project.")
  })

  test("a big project is read in parts, and a folder that isn't a repository still has its files read", async () => {
    const folder = join(root, "plain")
    mkdirSync(join(folder, "node_modules"), { recursive: true })
    writeFileSync(join(folder, "node_modules", "dep.js"), "theirs\n")
    for (let each = 0; each < 6; each++) writeFileSync(join(folder, `file${each}.ts`), `const line = ${each}\n`.repeat(2_000))
    const parts = (await readScope(folder, { kind: "project" })) as string[]
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
