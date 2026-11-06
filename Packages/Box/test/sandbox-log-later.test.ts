import "./safety"
import { afterAll, expect, jest, mock, test } from "bun:test"
import * as childProcess from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
    queueMicrotask(() => {
      if (lines.length) child.stdout.emit("data", lines.map(line => JSON.stringify({ eventMessage: line })).join("\n") + "\n")
      child.emit("close", 0)
    })
    return child
  },
}))

// (Bun has it; the pinned @types/bun doesn't say so yet.)
const clock = jest as unknown as { advanceTimersByTime(ms: number): void }

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-log-later-")))
// The engine, with the conversation in Ask First (a stand-in for its HTTP API), where the link
// reads it; what was there before comes back after.
const engine = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/session/ses_shop"
  ? Response.json({ data: { id: "ses_shop", permissions: [{ action: "shell", resource: "*", effect: "ask" }], metadata: { kuvo: { approval: "askFirst", applied: "askFirst" } }, time: { created: Date.now() } } })
  : Response.json({ message: "No such session." }, { status: 404 }) })
const { ENGINE_FILE } = await import("../src/link/home")
const engineBefore = existsSync(ENGINE_FILE) ? readFileSync(ENGINE_FILE, "utf8") : null
mkdirSync(dirname(ENGINE_FILE), { recursive: true })
writeFileSync(ENGINE_FILE, JSON.stringify({ pid: process.pid, port: engine.port, password: "pw", version: "test" }))
afterAll(() => {
  logReads = null
  engine.stop(true)
  if (engineBefore === null) rmSync(ENGINE_FILE, { force: true })
  else writeFileSync(ENGINE_FILE, engineBefore)
  rmSync(root, { recursive: true, force: true })
})

test.skipIf(process.platform !== "darwin")("an ask made before macOS logs what the sandbox stopped fills it in, and Always, once the log has it", async () => {
  // (A home of its own, which the folder outside the project is in, as a user's would be.)
  const before = process.env.HOME
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
  const when = (seen: () => boolean) => new Promise<void>(resolve => {
    const stop = onSandboxAsksChanged(() => { if (seen()) { stop(); resolve() } })
  })
  const up = when(() => listSandboxAsks().length > 0)
  const filled = when(() => listSandboxAsks().some(ask => ask.stopped?.length))
  jest.useFakeTimers()
  try {
    const call = callSandboxTool("sandbox_ask", { command, why: "To fill the shared cache." }, { session: "ses_shop", root: "ses_shop", folder: project })
    await up
    expect(listSandboxAsks()[0].stopped).toBeUndefined()
    // (macOS has it by the box's next look.)
    clock.advanceTimersByTime(1000)
    await filled
    const [ask] = listSandboxAsks()
    expect(ask.command).toBe(command)
    expect(ask.stopped).toEqual([{ kind: "write", path: join(cache, "kept.txt") }])
    expect(ask.always).toEqual({ kind: "write", path: cache })
    answerSandboxAsk(ask.id, { answer: "no" })
    expect((await call).text).toStartWith("The user said no")
    expect(listSandboxAsks()).toEqual([])
  } finally {
    jest.useRealTimers()
    logReads = null
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
})
