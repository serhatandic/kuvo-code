import "./safety"
import { expect, test } from "bun:test"
import { wakeLine, wakeLineShown } from "../src/link/work/wakes"
import { writtenByYou } from "../src/link/engine/queue"
import { boxNoteOf } from "../src/shared/queues"

// A lead told of a session whose turn ended while what it left running goes on (the hold ran out)
// hears it as finished, saying what runs: never "still working" (#420), though a line kept from a box
// before that is still read.
const session = { id: "ses_1", title: "Tests", directory: "/tmp/kuvo-news-kinds", time: { created: Date.now() - 5 * 60_000, updated: Date.now() - 5 * 60_000 } }
const target = { kind: "engine" } as never
const running = { commands: [{ id: "sh_1", command: "npm test", started: Date.now() }], subagents: [], tasks: [] } as never
const done = { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } as never

test("a session told while its command runs says so; it is 'finished', never 'still working'", async () => {
  const line = (await wakeLine(done, session, target, running))!
  expect(line).toStartWith('[Session finished] "Tests"')
  expect(line).not.toContain("still working")
  expect(line).toContain("Still running in the background")
  expect(wakeLineShown([line])).toBe("“Tests” finished")
  expect(boxNoteOf(line, undefined)?.line).toBe("“Tests” finished")
  const plain = (await wakeLine(done, session, target, null))!
  expect(plain).toStartWith('[Session finished] "Tests"')
  expect(plain).not.toContain("Still running")
})

test("a line kept from a box that told 'still working' is still read", () => {
  const old = '[Session still working] "Tests" in x (address ses_1):\nok\n(Still running in the background: the command `npm test`.)'
  expect(wakeLineShown([old])).toBe("“Tests” still working")
  expect(boxNoteOf(old, undefined)?.line).toBe("“Tests” still working")
  expect(writtenByYou(old, undefined)).toBe(false)
})

test("several updates, one of them still working, are counted", () => {
  const lines = ['[Session still working] "A" in x (address ses_1):\nok', '[Session asks] "B" in x (address ses_2) asks: a name (ask f1).']
  expect(wakeLineShown(lines)).toBe("2 updates from its sessions")
  expect(boxNoteOf(lines.join("\n\n"), undefined)?.line).toBe("2 updates from its sessions")
})
