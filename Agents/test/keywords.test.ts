import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sideQuestionRoutes, SideQuestions } from "../src/btw"
import { EngineLink } from "../src/engine"
import { subscribe } from "../src/events"
import type { GoalPlaces } from "../src/goals"
import { server } from "../src/groups/api"
import { handoffMarker, handoffRoutes, Handoffs } from "../src/handoff"
import { run } from "../src/proc"
import { gitChanges, reviewRoutes, Reviews } from "../src/reviews"
import type { ServerEvent } from "../src/wire"
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

function places(bridge = false): GoalPlaces {
  return {
    engine: { api: link, listen: () => () => {} },
    bridge: { api: server(engine.url, "x"), listen: () => () => {} },
    isBridge: () => bridge,
  }
}

/** What the conversation was told (a note or a message), which a side question never is. */
const told = (session = "ses_work") => engine.synthetic.filter((note) => note.session === session).length + engine.prompts(session).length

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-keywords-"))
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
    const handoff = await handoffs.handoff("ses_work", "Write the test for it.")
    expect(handoff).toMatchObject({ from: "ses_work", title: "Pause on blur (continued)" })
    // Written from inside the old conversation.
    expect(engine.checks.map((check) => check.session)).toEqual(["ses_work"])
    // The new one: same folder and model, given the note and the next step, as a note the
    // conversation shows as the handoff's.
    expect(engine.made[0]).toMatchObject({ title: "Pause on blur (continued)", location: { directory: "/tmp/project" }, model: { providerID: "p", id: "m" } })
    const note = engine.synthetic.find((each) => each.session === handoff.to)!
    expect(note.text).toStartWith(handoffMarker)
    expect(note.text).toContain("The timer pauses on blur. Left: a test for it.")
    expect(note.text).toContain("What to do next: Write the test for it.")
    expect(note.description).toBe("Carried on from “Pause on blur”")
    expect(engine.metadata.get(handoff.to)).toEqual({ kuvo: { handoffFrom: "ses_work" } })
    expect(engine.metadata.get("ses_work")).toEqual({ kuvo: { handoffTo: handoff.to } })
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
    expect(review.fix).toContain("Bug in src/timer.ts:40: The interval isn't cleared on pause.")
    expect(told()).toBe(0)
    expect((events.filter((event) => event.type === "kuvo.review.updated").at(-1)?.data as any)?.review.state).toBe("done")
  })

  test("with nothing to review says so; one under way is waited for; put away, it's gone", async () => {
    const reviews = new Reviews(join(root, "reviews.json"), places(), changes(""))
    reviews.onEnded = beat
    await reviews.start("ses_work")
    await until(() => reviews.get("ses_work")?.state === "done")
    expect(reviews.get("ses_work")).toMatchObject({ summary: "There are no changes to review: everything is committed.", findings: [] })
    expect(engine.checks).toHaveLength(0)

    const busy = new Reviews(join(root, "busy.json"), places(), changes("+x\n"))
    engine.holdingChecks = true
    await busy.start("ses_work")
    const route = (method: string) => reviewRoutes(busy, method, ["ses_work"], async () => ({}))
    expect((await route("POST")).status).toBe(409)
    engine.answerChecks()
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
})
