import "./safety"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A bot's seat in a group chat runs no commands (no shell), so the sandbox never stops one of its
// own: its sandbox_ask would only be a way to run a command outside the sandbox, from a seat the
// user can't open. It asks nobody, runs nothing, and the bot hears why.

test("a group chat's seat can't have a command run outside the sandbox", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuvo-sandbox-seat-"))
  const before = process.env.KUVO_HOME
  process.env.KUVO_HOME = home
  try {
    const { answerSandboxAsk, callSandboxTool, listSandboxAsks, onSandboxAsksChanged } = await import("../src/link/fence/outside")
    // Whichever comes first: its answer, or an ask to the user (answered no, so nothing hangs).
    let stop = () => {}
    const asked = new Promise<"asked">(resolve => { stop = onSandboxAsksChanged(() => resolve("asked")) })
    const called = callSandboxTool("sandbox_ask", { command: "touch made.txt", why: "To mark the build." }, { folder: home, root: "ses_seat", bot: "bot_scout", botName: "Scout", seat: true })
    const first = await Promise.race([called.then(() => "answered" as const), asked])
    stop()
    for (const each of listSandboxAsks()) answerSandboxAsk(each.id, { answer: "no" })
    const answer = await called
    expect(first).toBe("answered")
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain("group chat")
    expect(listSandboxAsks()).toEqual([])
    expect(await Bun.file(join(home, "made.txt")).exists()).toBe(false)
  } finally {
    if (before === undefined) delete process.env.KUVO_HOME
    else process.env.KUVO_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})
