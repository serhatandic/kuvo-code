import "./safety"
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HangWatch, isBridge, isEngine, MOST_ENDED } from "../src/shared/hang"
import { endsWithRun } from "./ends-with-run"
import { processUse } from "../src/shared/platform"

// A server of the box that hung while running is ended, and only one that did: killing a live one
// loses what it has under way. The servers here are real processes, really hung, spinning or
// answering, looked at for real (their sockets, their state, their CPU); only the watch's clock is
// the test's, so ten minutes pass in a few looks.

// (Each look at a silent server takes as long as it's given to answer.)
setDefaultTimeout(60_000)

const EVERY = 30_000
/** Four looks, one apart, make it so far: the first is where it starts counting. */
const HUNG_AFTER = 3 * EVERY

let root = ""
let run = ""
let record = ""
let now = 1_800_000_000_000
const started: ChildProcess[] = []
/** What ends each one's watchdog (ends-with-run.ts), which ends it if the run is cut off. */
const watchdogs: (() => void)[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-box-hang-"))
  run = join(root, "run")
  mkdirSync(run)
  record = join(run, "engine.json")
})

afterEach(() => {
  // (Each leads a process group, with what it started: nothing's left running after a test.)
  for (const child of started.splice(0)) {
    try { process.kill(-child.pid!, "SIGKILL") } catch {}
  }
  for (const stop of watchdogs.splice(0)) stop()
  rmSync(root, { recursive: true, force: true })
})

/** What a server does once it listens on a port of its own, by its program's lines. */
const OPEN = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const server = net.createServer(socket => socket.on("data", () => socket.end("HTTP/1.1 401 Unauthorized\\r\\ncontent-length: 0\\r\\n\\r\\n")));
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n", () => setTimeout(afterListening, 20));
});
const asleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`
const BEHAVIOR = {
  /** Its event loop stuck, asleep: what a deadlock looks like. */
  hangs: "asleep();",
  /** As that, and it takes no notice of being told to stop. */
  hangsDeaf: `process.on("SIGTERM", () => {}); setTimeout(asleep, 20);`,
  /** Long work: as deaf, at full CPU. */
  spins: "while (true) {}",
  /** Hung, with a long command at work under it. */
  hangsOverWork: `spawn("/bin/sh", ["-c", 'while [ ! -e "$0" ]; do :; done', process.argv[3]], { stdio: "ignore" }); setTimeout(asleep, 50);`,
  /** Hung, with something asleep under it (an idle MCP server). */
  hangsOverIdle: `spawn("/bin/sleep", ["600"], { stdio: "ignore" }); setTimeout(asleep, 50);`,
  answers: "",
} as const

/** A real server, recorded as it would be, once what it does has begun. */
async function server(behavior: keyof typeof BEHAVIOR, argument = "serve"): Promise<{ child: ChildProcess; pid: number; port: number; gone: Promise<unknown> }> {
  const script = join(root, `server-${started.length}.js`)
  writeFileSync(script, `${OPEN}\nfunction afterListening() { ${BEHAVIOR[behavior]} }\n`)
  const child = spawn(process.execPath, [script, argument, join(root, "work-over")], { stdio: ["ignore", "pipe", "ignore"], detached: true })
  started.push(child)
  watchdogs.push(endsWithRun(child))
  const gone = new Promise(resolve => child.once("exit", resolve))
  const line = await new Promise<string>(resolve => child.stdout!.once("data", chunk => resolve(String(chunk))))
  const { port } = JSON.parse(line)
  writeFileSync(record, JSON.stringify({ pid: child.pid, port, password: "x" }))
  // Past the moment it starts: once it's as it will be.
  if (behavior !== "answers") await until(() => isDeaf(port))
  if (behavior !== "answers" && behavior !== "spins") await until(async () => (await processUse(child.pid!))?.waiting === true)
  return { child, pid: child.pid!, port, gone }
}

/** Whether it says nothing to a question, as a hung server does. */
function isDeaf(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(true)
    }, 150)
    socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))
    socket.once("data", () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(false)
    })
  })
}

async function until(condition: () => Promise<boolean>) {
  while (!(await condition())) await Bun.sleep(10)
}

function watch(options: Partial<ConstructorParameters<typeof HangWatch>[0]> = {}) {
  return new HangWatch({ name: "engine", run, record, isIt: isEngine, every: EVERY, answerWithin: 400, hungAfter: HUNG_AFTER, timeToGo: 50, now: () => now, ...options })
}

/** `count` looks, each on time. */
async function looks(hang: HangWatch, count: number) {
  for (let index = 0; index < count; index++) {
    now += EVERY
    await hang.look()
  }
}

const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

test("a server that takes connections and says nothing, asleep and using no CPU, is ended after the whole wait", async () => {
  const hung = await server("hangs")
  const hang = watch()
  await looks(hang, 3)
  expect(alive(hung.child)).toBe(true)
  await looks(hang, 1)
  await hung.gone
  expect(hung.child.signalCode).toBe("SIGTERM")
  expect(JSON.parse(readFileSync(join(run, "hung-engine.json"), "utf8"))).toEqual([now])
})

test("one that takes no notice of being told to stop is made to, once it's had its time", async () => {
  const hung = await server("hangsDeaf")
  await looks(watch(), 4)
  await hung.gone
  expect(hung.child.signalCode).toBe("SIGKILL")
})

test("one hung with only what's idle under it is ended too", async () => {
  const hung = await server("hangsOverIdle")
  await looks(watch(), 4)
  await hung.gone
})

test("a server that answers is never ended, an error's an answer", async () => {
  const live = await server("answers")
  await looks(watch(), 12)
  expect(alive(live.child)).toBe(true)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
})

test("a server at long work, as deaf at full CPU, is never ended", async () => {
  const busy = await server("spins")
  expect((await processUse(busy.pid))?.waiting).toBe(false)
  await looks(watch(), 12)
  expect(alive(busy.child)).toBe(true)
})

test("a server hung over a long command at work is left until that's over", async () => {
  const over = await server("hangsOverWork")
  const hang = watch()
  await looks(hang, 12)
  expect(alive(over.child)).toBe(true)
  writeFileSync(join(root, "work-over"), "")
  await until(async () => (await processUse(over.pid))?.below.running === false)
  await looks(hang, 4)
  await over.gone
})

test("one paused (a debugger, you) is never ended", async () => {
  const paused = await server("answers")
  process.kill(paused.pid, "SIGSTOP")
  await until(() => isDeaf(paused.port))
  await looks(watch(), 12)
  expect(alive(paused.child)).toBe(true)
})

test("a sleep of the computer starts the count again, whatever the clock says", async () => {
  const hung = await server("hangs")
  const hang = watch()
  await looks(hang, 3)
  // The Mac slept: nothing was looked at for an hour. The server wakes as deaf as it went to sleep,
  // as one will for a moment, but that says nothing of what it was doing.
  now += 3_600_000
  await hang.look()
  await looks(hang, 2)
  expect(alive(hung.child)).toBe(true)
  // And held up on one look, by a machine that's starved, or a Mac dozing for moments at a time.
  now += EVERY * 3
  await hang.look()
  await looks(hang, 2)
  expect(alive(hung.child)).toBe(true)
  // The clock set back says nothing either.
  now -= 3_600_000
  await hang.look()
  await looks(hang, 2)
  expect(alive(hung.child)).toBe(true)
  // Then the whole wait, without a break.
  await looks(hang, 1)
  await hung.gone
})

test("a sleep in the middle of a look starts the count from when it woke", async () => {
  const hung = await server("hangs")
  let sleeps = false
  const hang = watch({ use: pid => {
    // The lid closes while it asks: it wakes hours later, in the same look.
    if (sleeps) now += 8 * 3_600_000
    sleeps = false
    return processUse(pid)
  } })
  sleeps = true
  await looks(hang, 3)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
  // And once it's counting.
  sleeps = true
  await looks(hang, 3)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
  expect(alive(hung.child)).toBe(true)
  await looks(hang, 1)
  await hung.gone
})

test("an answer starts the count again", async () => {
  const hung = await server("hangs")
  const live = await server("answers")
  const hang = watch()
  const asHung = JSON.stringify({ pid: hung.pid, port: hung.port, password: "x" })
  writeFileSync(record, asHung)
  await looks(hang, 3)
  // It answers, once, however deaf it was. (The same process, at another port for the test's sake.)
  writeFileSync(record, JSON.stringify({ pid: hung.pid, port: live.port, password: "x" }))
  await looks(hang, 1)
  writeFileSync(record, asHung)
  await looks(hang, 3)
  expect(alive(hung.child)).toBe(true)
  await looks(hang, 1)
  await hung.gone
})

test("CPU it used since the last look, asleep at each one, is work: the count starts again", async () => {
  const hung = await server("hangs")
  let extra = 0
  let extraBelow = 0
  const hang = watch({ use: async pid => {
    const use = await processUse(pid)
    return use && { ...use, seconds: use.seconds + extra, below: { ...use.below, seconds: use.below.seconds + extraBelow } }
  } })
  await looks(hang, 3)
  extra += 5
  await looks(hang, 3)
  expect(alive(hung.child)).toBe(true)
  extraBelow += 30
  await looks(hang, 3)
  expect(alive(hung.child)).toBe(true)
  await looks(hang, 1)
  await hung.gone
})

test("nothing listening where it says isn't a hang", async () => {
  const quiet = await server("hangs")
  writeFileSync(record, JSON.stringify({ pid: quiet.pid, port: 9, password: "x" }))
  await looks(watch(), 12)
  expect(alive(quiet.child)).toBe(true)
})

test("what took its number is never ended: its command line isn't the server's", async () => {
  const other = await server("hangs", "something-else")
  await looks(watch(), 12)
  expect(alive(other.child)).toBe(true)
})

for (const purpose of ["stopped", ".launching", ".updating", ".system-asking"]) {
  test(`stopped, starting or updating on purpose, or macOS asking you something (run/${purpose}): nothing's judged`, async () => {
    const hung = await server("hangs")
    writeFileSync(join(run, purpose), "")
    const hang = watch()
    await looks(hang, 12)
    expect(alive(hung.child)).toBe(true)
    // And it counts from when that's over.
    rmSync(join(run, purpose))
    await looks(hang, 3)
    expect(alive(hung.child)).toBe(true)
    await looks(hang, 1)
    await hung.gone
  })
}

test("no record, no server: nothing to do", async () => {
  await looks(watch(), 3)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
})

test("another server in its place (started over meanwhile) starts the count again", async () => {
  const first = await server("hangs")
  const hang = watch()
  await looks(hang, 3)
  const second = await server("hangs")
  await looks(hang, 3)
  expect(alive(first.child)).toBe(true)
  expect(alive(second.child)).toBe(true)
  await looks(hang, 1)
  await second.gone
  expect(alive(first.child)).toBe(true)
})

test("started over during the very look that would end the old one: that isn't ended", async () => {
  const first = await server("hangs")
  let startedOver = false
  const hang = watch({
    use: pid => {
      if (startedOver) writeFileSync(record, JSON.stringify({ pid: process.pid, port: first.port + 1, password: "x" }))
      return processUse(pid)
    },
  })
  await looks(hang, 3)
  startedOver = true
  await looks(hang, 1)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
  expect(alive(first.child)).toBe(true)
})

test("what can't be counted isn't ended: the limit always holds", async () => {
  // (Where it notes that: taken, as a full disk or a folder gone read-only would have it.)
  mkdirSync(join(run, "hung-engine.json.new"))
  const hung = await server("hangs")
  await looks(watch(), 6)
  expect(alive(hung.child)).toBe(true)
  expect(existsSync(join(run, "hung-engine.json"))).toBe(false)
})

test("a count that can't be read isn't taken for none", async () => {
  writeFileSync(join(run, "hung-engine.json"), "{ not this")
  const hung = await server("hangs")
  await looks(watch(), 6)
  expect(alive(hung.child)).toBe(true)
})

test("it ends only so many in a while, in case it's wrong: then it's left for you to restart", async () => {
  const file = join(run, "hung-engine.json")
  writeFileSync(file, JSON.stringify(Array.from({ length: MOST_ENDED }, (_, index) => now - index)))
  const hung = await server("hangs")
  const hang = watch()
  await looks(hang, 8)
  expect(alive(hung.child)).toBe(true)
  // Those long ago count no more.
  writeFileSync(file, JSON.stringify(Array.from({ length: MOST_ENDED }, () => now - 7 * 3_600_000)))
  await looks(hang, 4)
  await hung.gone
})

test("each server goes by its own program", () => {
  expect(isEngine("/Users/you/Library/Application Support/run.kuvo.code/engine/2.2.0/opencode serve --stdio --port 0")).toBe(true)
  expect(isEngine("/home/you/.kuvo-code/engine/2.2.0/opencode serve --port 4000 --hostname 127.0.0.1")).toBe(true)
  expect(isEngine("opencode run --config=/dev/null --no-env-file /x/kuvo-link.js serve")).toBe(false)
  expect(isEngine("opencode run --config=/dev/null /x/kuvo-agents.js")).toBe(false)
  expect(isBridge("/home/you/.kuvo-code/engine/2.2.0/opencode --config=/dev/null --no-env-file /home/you/.kuvo-code/bin/kuvo-agents.js")).toBe(true)
  expect(isBridge("sh -c n=0; while kill -0")).toBe(false)
})

// The real servers, each started as a box starts it, on a quick clock (test/quick-hang.ts): that they
// watch at all.
function realServer(script: string, argument: string[], env: Record<string, string>): ChildProcess {
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const child = spawn(process.execPath, ["--preload", join(import.meta.dir, "quick-hang.ts"), join(import.meta.dir, "..", "src", script), ...argument], {
    // (Its standard input stays open: it stops once that closes.)
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
    cwd: root,
    env: { HOME: home, PATH: process.env.PATH!, TMPDIR: root, OPENCODE_PASSWORD: "x", ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } : {}), ...env },
  })
  started.push(child)
  watchdogs.push(endsWithRun(child))
  return child
}

test("the coding agents' bridge ends this box's hung engine", async () => {
  const hung = await server("hangs")
  realServer(join("agents", "main.ts"), [], { KUVO_AGENTS_HOME: join(root, "agents"), KUVO_RUN: run, KUVO_SANDBOX: "off" })
  await hung.gone
  expect(existsSync(join(run, "hung-engine.json"))).toBe(true)
})

// As a machine runs it, a Mac among them (`KUVO_AGENTS_REMOTE`): no app there to say macOS is asking,
// and its keeper is what starts it again.
test("on a machine, its bridge ends its hung engine", async () => {
  const hung = await server("hangs")
  const free = net.createServer()
  await new Promise<void>(resolve => free.listen(0, "127.0.0.1", resolve))
  const port = (free.address() as net.AddressInfo).port
  await new Promise(resolve => free.close(resolve))
  realServer(join("agents", "main.ts"), [], {
    KUVO_AGENTS_REMOTE: "1",
    KUVO_AGENTS_HOME: join(root, "agents"),
    KUVO_HOME: root,
    KUVO_AGENTS_PORT: String(port),
    KUVO_AGENTS_PASSWORD: "x",
    KUVO_ENGINE_PORT: String(hung.port),
    KUVO_ENGINE_PID: String(hung.pid),
    KUVO_SANDBOX: "off",
  })
  await hung.gone
  expect(existsSync(join(run, "hung-engine.json"))).toBe(true)
})

test("the link ends this box's hung coding agents' bridge", async () => {
  record = join(run, "bridge.json")
  const hung = await server("hangs", "kuvo-agents")
  realServer(join("link", "main.ts"), ["serve"], { KUVO_HOME: root, KUVO_TEST_NO_PEERS: "1" })
  await hung.gone
  expect(existsSync(join(run, "hung-bridge.json"))).toBe(true)
})

// A run cut off before its afterEach (killed, its time up) leaves none of its servers running: here
// a run of its own, killed outright, with a server spinning at full CPU, as one left behind did for a
// day. (Its watchdog looks once a second.)
test("a run cut off leaves none of the servers it started running", async () => {
  const spinner = join(root, "spinner.js")
  writeFileSync(spinner, "while (true) {}\n")
  const runner = join(root, "runner.ts")
  writeFileSync(runner, `
import { spawn } from "node:child_process"
import { endsWithRun } from ${JSON.stringify(join(import.meta.dir, "ends-with-run.ts"))}
const child = spawn(process.execPath, [${JSON.stringify(spinner)}], { stdio: "ignore", detached: true })
endsWithRun(child)
console.log(child.pid)
setInterval(() => {}, 1000)
`)
  // (Its own, like the servers: whatever happens here, afterEach ends it, and with it its server.)
  const run = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "ignore"], detached: true, env: { PATH: process.env.PATH!, HOME: root, TMPDIR: root, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) } })
  started.push(run)
  watchdogs.push(endsWithRun(run))
  const pid = Number(await new Promise<string>(resolve => run.stdout!.once("data", chunk => resolve(String(chunk)))))
  const isRunning = () => { try { process.kill(pid, 0); return true } catch { return false } }
  expect(isRunning()).toBe(true)
  run.kill("SIGKILL")
  await until(async () => !isRunning())
  expect(isRunning()).toBe(false)
})
