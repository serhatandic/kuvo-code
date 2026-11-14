// `box adopt` (a Mac connecting to a machine an older Kuvo Code set up) takes the engine's launch's
// lock as the box's own scripts do (OpenCodeKit's RebootTests say more of those): one whose holder
// runs is waited for however old it is, never taken away from it nor gone ahead without; one whose
// holder is gone is taken at once, and let go of; a taking away left by one that's gone is taken
// over by one alone.
import "./safety"
import { afterAll, afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchLocked, LaunchLockBusy } from "../src/link/compat/launch-lock"
import { RUN } from "../src/link/home"

const main = join(import.meta.dir, "../src/link/main.ts")
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-adopt-launch-lock-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Those that start real processes, however busy the computer.
const SPAWNS = 60_000

const lock = join(RUN, ".launching")
const said = join(RUN, ".launching.pid")
const breaking = join(RUN, ".launching.breaking")
// This run's own box: what each test leaves goes.
afterEach(() => {
  for (const name of [".launching", ".launching.pid", ".launching.breaking"]) rmSync(join(RUN, name), { recursive: true, force: true })
  for (const name of existsSync(RUN) ? readdirSync(RUN) : []) {
    if (name.startsWith(".launching.breaking.")) rmSync(join(RUN, name), { recursive: true, force: true })
  }
})

/** A process at work as the box's scripts are (`kuvo-start` in its command line). */
const atWork = () => Bun.spawn(["/bin/sh", "-c", "while :; do sleep 1; done", "kuvo-start"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
/** A number that ran and has ended. */
async function ended() {
  const gone = Bun.spawn(["/usr/bin/true"])
  await gone.exited
  return gone.pid
}
const aged = (file: string, seconds: number) => {
  const then = new Date(Date.now() - seconds * 1000)
  utimesSync(file, then, then)
}

test("a start under way holds it, half a minute already: never taken away from it, nor gone ahead without", () => {
  const holder = atWork()
  try {
    mkdirSync(RUN, { recursive: true })
    mkdirSync(lock)
    aged(lock, 30)
    writeFileSync(said, `${holder.pid}\n`)
    let ran = false
    expect(() => launchLocked(() => { ran = true }, { wait: 500 })).toThrow(LaunchLockBusy)
    expect(ran).toBe(false)
    expect(readFileSync(said, "utf8")).toBe(`${holder.pid}\n`)
  } finally {
    holder.kill()
  }
})

test("one an older script holds (it says nothing), half a minute already: the same", () => {
  mkdirSync(RUN, { recursive: true })
  mkdirSync(lock)
  aged(lock, 30)
  let ran = false
  expect(() => launchLocked(() => { ran = true }, { wait: 500 })).toThrow(LaunchLockBusy)
  expect(ran).toBe(false)
  expect(existsSync(lock)).toBe(true)
})

test("one whose holder is gone is taken at once, said to be this one's while held, and let go of", async () => {
  mkdirSync(RUN, { recursive: true })
  mkdirSync(lock)
  writeFileSync(said, `${await ended()}\n`)
  const holder = launchLocked(() => readFileSync(said, "utf8"), { wait: 500 })
  expect(holder).toBe(`${process.pid}\n`)
  expect(existsSync(lock)).toBe(false)
  expect(existsSync(said)).toBe(false)
})

test("a taking away left by one that's gone is taken over by one alone: not once another has", async () => {
  mkdirSync(RUN, { recursive: true })
  mkdirSync(lock)
  writeFileSync(said, `${await ended()}\n`)
  const taker = await ended()
  mkdirSync(breaking)
  writeFileSync(join(breaking, "pid"), `${taker}\n`)
  // Another has taken it over (it's at it now).
  mkdirSync(`${breaking}.gone-${taker}`)
  expect(() => launchLocked(() => {}, { wait: 500 })).toThrow(LaunchLockBusy)
  expect(readFileSync(join(breaking, "pid"), "utf8")).toBe(`${taker}\n`)
  // None has: this one does, and takes the lock.
  rmSync(`${breaking}.gone-${taker}`, { recursive: true })
  expect(launchLocked(() => "had", { wait: 500 })).toBe("had")
  expect(existsSync(`${breaking}.gone-${taker}`)).toBe(true)
  expect(existsSync(lock)).toBe(false)
})

test("one whose taker is still at it, a minute already, is left to it", async () => {
  const taker = atWork()
  try {
    mkdirSync(RUN, { recursive: true })
    mkdirSync(lock)
    writeFileSync(said, `${await ended()}\n`)
    mkdirSync(breaking)
    writeFileSync(join(breaking, "pid"), `${taker.pid}\n`)
    aged(breaking, 120)
    expect(() => launchLocked(() => {}, { wait: 500 })).toThrow(LaunchLockBusy)
    expect(readFileSync(join(breaking, "pid"), "utf8")).toBe(`${taker.pid}\n`)
    expect(existsSync(lock)).toBe(true)
  } finally {
    taker.kill()
  }
})

/** A machine whose box has its own settings already (`adopt` says "own"), and its launch's lock. */
function machine() {
  const machineRoot = realpathSync(mkdtempSync(join(root, "m-")))
  const home = join(machineRoot, ".kuvo-code")
  mkdirSync(join(home, "run"), { recursive: true })
  mkdirSync(join(home, "box"), { recursive: true })
  writeFileSync(join(home, "box", "opencode.json"), "{}")
  const env = { PATH: process.env.PATH!, HOME: machineRoot, KUVO_HOME: home, TMPDIR: tmpdir(), ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }
  return { lock: join(home, "run", ".launching"), said: join(home, "run", ".launching.pid"), env }
}

test("box adopt takes a lock whose holder is gone, and lets go of it", async () => {
  const { lock, said, env } = machine()
  mkdirSync(lock)
  writeFileSync(said, `${await ended()}\n`)
  const adopting = Bun.spawn([process.execPath, main, "box", "adopt"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect(JSON.parse(await new Response(adopting.stdout).text()).status).toBe("own")
  expect(await adopting.exited).toBe(0)
  expect(existsSync(lock)).toBe(false)
  expect(existsSync(said)).toBe(false)
}, SPAWNS)
