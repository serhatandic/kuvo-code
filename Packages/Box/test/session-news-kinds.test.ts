import "./safety"
import { expect, test } from "bun:test"
import { wakeLine, wakeLineShown } from "../src/link/work/wakes"
import { writtenByYou } from "../src/link/engine/queue"
import { boxNoteOf } from "../src/shared/queues"

// A lead told of a session whose turn ended while what it left running goes on hears it's still
// working, not finished; what is shown for it, and how an old message is read, agree.
const session = { id: "ses_1", title: "Tests", directory: "/tmp/kuvo-news-kinds", time: { created: Date.now() - 5 * 60_000 } }
const target = { kind: "engine" } as never
const running = { commands: [{ id: "sh_1", command: "npm test", started: Date.now() }], subagents: [], tasks: [] } as never
const done = { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } as never

test("a session told while its command runs is 'still working'; the same without one is 'finished'", async () => {
  const still = (await wakeLine(done, session, target, running, true))!
  expect(still).toStartWith('[Session still working] "Tests"')
  expect(still).toContain("Still running in the background")
  expect(wakeLineShown([still])).toBe("“Tests” still working")
  expect(boxNoteOf(still, undefined)?.line).toBe("“Tests” still working")
  expect(writtenByYou(still, undefined)).toBe(false)
  const finished = (await wakeLine(done, session, target, null, false))!
  expect(finished).toStartWith('[Session finished] "Tests"')
  expect(wakeLineShown([finished])).toBe("“Tests” finished")
  expect(boxNoteOf(finished, undefined)?.line).toBe("“Tests” finished")
})

test("a dev server from before the question doesn't make an answered turn 'still working'", async () => {
  const line = (await wakeLine(done, session, target, running, false))!
  expect(line).toStartWith('[Session finished] "Tests"')
  expect(line).toContain("Still running in the background")
})

test("several updates, one of them still working, are counted", () => {
  const lines = ['[Session still working] "A" in x (address ses_1):\nok', '[Session asks] "B" in x (address ses_2) asks: a name (ask f1).']
  expect(wakeLineShown(lines)).toBe("2 updates from its sessions")
  expect(boxNoteOf(lines.join("\n\n"), undefined)?.line).toBe("2 updates from its sessions")
})
