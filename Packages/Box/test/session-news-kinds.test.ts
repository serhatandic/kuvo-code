import "./safety"
import { expect, test } from "bun:test"
import { stoppedLine, wakeLine, wakeLineShown } from "../src/link/work/wakes"
import { writtenByYou } from "../src/link/engine/queue"
import { boxNoteOf } from "../src/shared/queues"

// A lead hears a session finished only once nothing it left running goes on (#553), so a finish
// never says what still runs, and is never "still working" (#420), though a line kept from a box
// before those is still read. One the user stopped says only that.
const session = { id: "ses_1", title: "Tests", directory: "/tmp/kuvo-news-kinds", time: { created: Date.now() - 5 * 60_000, updated: Date.now() - 5 * 60_000 } }
const target = { kind: "engine" } as never
const done = { type: "session.execution.succeeded", data: { sessionID: "ses_1" } } as never

test("a finish is 'finished', and never says what still runs", async () => {
  const line = (await wakeLine(done, session, target))!
  expect(line).toStartWith('[Session finished] "Tests"')
  expect(line).not.toContain("still working")
  expect(line).not.toContain("Still running")
  expect(wakeLineShown([line])).toBe("“Tests” finished")
  expect(boxNoteOf(line, undefined)?.line).toBe("“Tests” finished")
})

// What a session said goes to its lead, and onto the card both apps draw of it, as Markdown on one
// line: a reply that opens with a heading (a quote, a list) isn't drawn as one big heading there,
// and what's inline in it (a path in code, a link) reaches its lead as it was written (#606).
test("a finish says the start of what the session said on one line, its block marks taken off and the rest as written", async () => {
  let reply = ""
  const engine = Bun.serve({
    port: 0,
    fetch: () => Response.json({ data: [{ id: "msg_1", type: "assistant", time: { created: 1, completed: 2 }, content: [{ type: "text", text: reply }] }] }),
  })
  const said = async (text: string) => {
    reply = text
    const line = (await wakeLine(done, session, { port: engine.port, password: "x" } as never))!
    return line.slice(line.indexOf(":\n") + 2)
  }
  try {
    expect(await said("## Review of #144: merge after fixes\n\nThe core design is **sound**: see [the PR](https://example.com/144).\n\n- Fixed `src/__tests__/a.ts`\n1. Then merge\n> Quoted"))
      .toBe("Review of #144: merge after fixes The core design is **sound**: see [the PR](https://example.com/144). Fixed `src/__tests__/a.ts` Then merge Quoted")
    expect(await said("> ## Summary\nFixed it")).toBe("Summary Fixed it")
    expect(await said("- ## Done\nok")).toBe("Done ok")
    expect(await said("#\nFoo bar")).toBe("Foo bar")
    expect(await said(">Note: all good\n\n---\n\n```ts\nconst a = 1\n```\nDone")).toBe("Note: all good const a = 1 Done")
    // Not marks: a number, an issue, a minus.
    expect(await said("#144 is merged\n-1 failing test left")).toBe("#144 is merged -1 failing test left")
  } finally {
    engine.stop(true)
  }
})

test("one the user stopped reads as that, for its lead and on its card", () => {
  const line = stoppedLine(session)
  expect(line).toStartWith('[Session stopped] "Tests"')
  expect(line).toContain("(address ses_1) was stopped by the user.")
  expect(wakeLineShown([line])).toBe("“Tests” stopped by you")
  expect(boxNoteOf(line, undefined)?.line).toBe("“Tests” stopped by you")
  expect(writtenByYou(line, undefined)).toBe(false)
  expect(wakeLineShown([line, line])).toBe("2 updates from its sessions")
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
