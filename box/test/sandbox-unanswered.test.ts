import "./safety"
import { expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A command an agent asks to run outside the sandbox while nobody's at a client: once the box
// stops waiting it runs nothing, and the agent hears that nobody answered, never that the user said
// no (it would tell them they refused something they never saw).

// (Bun has it; the pinned @types/bun doesn't say so yet.)
const clock = jest as unknown as { advanceTimersByTime(ms: number): void }

test("an ask nobody answers runs nothing and isn't taken for the user's no", async () => {
  const home = mkdtempSync(join(tmpdir(), "kuvo-sandbox-"))
  const before = process.env.KUVO_HOME
  process.env.KUVO_HOME = home
  const { callSandboxTool, listSandboxAsks } = await import("../src/link/fence/outside")
  jest.useFakeTimers()
  try {
    const called = callSandboxTool("sandbox_ask", { command: "touch made.txt", why: "To mark the build." }, { folder: home } as never)
    expect(listSandboxAsks().map(each => each.command)).toEqual(["touch made.txt"])
    clock.advanceTimersByTime(16 * 60_000)
    const answer = await called
    expect(answer.text).toStartWith("Nobody answered in time")
    expect(answer.text).not.toContain("said no")
    expect(listSandboxAsks()).toEqual([])
    expect(await Bun.file(join(home, "made.txt")).exists()).toBe(false)
  } finally {
    jest.useRealTimers()
    if (before === undefined) delete process.env.KUVO_HOME
    else process.env.KUVO_HOME = before
    rmSync(home, { recursive: true, force: true })
  }
})
