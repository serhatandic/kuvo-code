import "./safety"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A bot answers two of its sessions' asks at once (parallel tool calls), which on this Mac's box
// run in its one process: each answer is kept on its session, and neither holds up the box while
// the other waits on the engine.

test("two answers kept at once on a session are both kept, without holding up the box", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuvo-answers-"))
  const before = process.env.KUVO_HOME
  process.env.KUVO_HOME = home
  // The engine: a session whose notes it keeps whole, as it's sent them.
  let metadata: Record<string, unknown> = {}
  const engine = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === "PATCH") metadata = ((await request.json()) as { metadata: Record<string, unknown> }).metadata
      return Response.json({ data: { id: "ses_work", metadata } })
    },
  })
  try {
    const { answersOn, keepAnswer } = await import("../src/link/work/answers")
    const target = { port: engine.port, password: "x" } as never
    const answer = (ask: string) => ({ ask, what: "Run npm install", decision: "allow" as const, reason: "Part of the plan.", by: { bot: "bot_pixel", name: "Pixel" }, at: 1 })
    await Promise.all([keepAnswer(target, "ses_work", answer("per_1")), keepAnswer(target, "ses_work", answer("per_2"))])
    expect(answersOn(metadata).map(each => each.ask).sort()).toEqual(["per_1", "per_2"])
  } finally {
    engine.stop(true)
    if (before === undefined) delete process.env.KUVO_HOME
    else process.env.KUVO_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})

// However long the engine takes over one (past the lock's wait, `wait: 0` here), a second change in
// this process waits its turn, rather than going ahead and writing over the first.
test("a session's notes changed twice at once in this process are changed one after the other, however long the first takes", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuvo-answers-"))
  try {
    const { lockedWhile } = await import("../src/link/files")
    const lock = join(home, ".notes.lock")
    const order: string[] = []
    let release = () => {}
    const engine = new Promise<void>(resolve => { release = resolve })
    const first = lockedWhile(lock, async () => { order.push("first starts"); await engine; order.push("first ends") }, { wait: 0 })
    const second = lockedWhile(lock, async () => { order.push("second starts") }, { wait: 0 })
    // Everything this process has to do now, done: the second hasn't started.
    await new Promise(resolve => setImmediate(resolve))
    expect(order).toEqual(["first starts"])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(["first starts", "first ends", "second starts"])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
