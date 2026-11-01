import { afterAll, expect, mock, test } from "bun:test"
import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// On a busy Mac, macOS writes what its sandbox refused to its log seconds after the command was
// stopped, so an agent can ask to run it outside before the log says why. The ask goes up at once,
// and once the log has it, the ask you see fills in what was stopped and Always for that folder;
// the ask is never left saying nothing was stopped. (macOS's `log` is what's stubbed here: what it
// has, as it has it; until the first read, the real one.)

const real = childProcess.spawn
// What `log show` prints for each read, in turn (none: nothing yet); null: the real one.
let logReads: string[][] | null = null
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: (command: string, ...rest: unknown[]) => {
    if (command !== "/usr/bin/log" || !logReads) return (real as (...args: unknown[]) => unknown)(command, ...rest)
    const lines = logReads.shift() ?? []
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() { return this } }), kill() {} })
    setImmediate(() => {
      if (lines.length) child.stdout.emit("data", lines.map(line => JSON.stringify({ eventMessage: line })).join("\n") + "\n")
      child.emit("close", 0)
    })
    return child
  },
}))

mkdirSync(join(homedir(), ".kuvo-code-test"), { recursive: true })
const root = mkdtempSync(join(homedir(), ".kuvo-code-test", "log-later-"))
afterAll(() => {
  logReads = null
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform !== "darwin")("an ask made before macOS logs what the sandbox stopped fills it in, and Always, once the log has it", async () => {
  const before = { KUVO_HOME: process.env.KUVO_HOME, HOME: process.env.HOME }
  process.env.KUVO_HOME = join(root, "box")
  process.env.HOME = join(root, "home")
  const project = join(root, "home", "shop")
  const cache = join(root, "home", "outside", "cache")
  mkdirSync(project, { recursive: true })
  mkdirSync(cache, { recursive: true })
  const { callSandboxTool, listSandboxAsks, onSandboxAsksChanged, answerSandboxAsk, commandSum } = await import("../src/link/fence/outside")
  const command = `echo hi > ${join(cache, "kept.txt")}`
  const refusal = `Sandbox: bash(4242) deny(1) file-write-create ${join(cache, "kept.txt")}\nkuvo-sandbox ses_shop ${commandSum(command)}`
  // The ask's own read finds nothing yet; the next has it.
  logReads = [[], [refusal]]
  const filled = new Promise<void>(resolve => {
    const stop = onSandboxAsksChanged(() => {
      if (listSandboxAsks().some(ask => ask.stopped?.length)) { stop(); resolve() }
    })
  })
  try {
    const call = callSandboxTool("sandbox_ask", { command, why: "To fill the shared cache." }, { session: "ses_shop", root: "ses_shop", folder: project })
    await filled
    const [ask] = listSandboxAsks()
    expect(ask.command).toBe(command)
    expect(ask.stopped).toEqual([{ kind: "write", path: join(cache, "kept.txt") }])
    expect(ask.always).toEqual({ kind: "write", path: cache })
    answerSandboxAsk(ask.id, { answer: "no" })
    expect((await call).text).toStartWith("The user said no")
    expect(listSandboxAsks()).toEqual([])
  } finally {
    logReads = null
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
