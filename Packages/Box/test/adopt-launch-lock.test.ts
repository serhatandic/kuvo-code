// `box adopt` (a Mac connecting to a machine an older Kuvo Code set up) takes the engine's launch's
// lock as the box's own scripts do (OpenCodeKit's RebootTests say more of those): one whose holder
// runs is waited for however old it is, and never taken away from it; one whose holder is gone is
// taken at once, and let go of.
import "./safety"
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const main = join(import.meta.dir, "../src/link/main.ts")
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-adopt-launch-lock-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Those that start real processes, however busy the computer.
const SPAWNS = 60_000

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

const adopt = (env: Record<string, string>) => Bun.spawn([process.execPath, main, "box", "adopt"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test("a start under way holds it, half a minute already: adopt waits for it, and never takes it away", async () => {
  const { lock, said, env } = machine()
  // A start at work there, as the scripts are (its command line names Kuvo Code's).
  const holder = Bun.spawn(["/bin/sh", "-c", "while :; do sleep 1; done", "kuvo-start"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  try {
    mkdirSync(lock)
    const then = new Date(Date.now() - 30_000)
    utimesSync(lock, then, then)
    writeFileSync(said, `${holder.pid}\n`)
    const adopting = adopt(env)
    await pause(2_000)
    expect(adopting.exitCode).toBeNull()
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(said, "utf8")).toBe(`${holder.pid}\n`)
    // The start lets go of it, as it does.
    rmSync(said)
    rmSync(lock, { recursive: true })
    expect(JSON.parse(await new Response(adopting.stdout).text()).status).toBe("own")
    expect(await adopting.exited).toBe(0)
    expect(existsSync(lock)).toBe(false)
  } finally {
    holder.kill()
  }
}, SPAWNS)

test("one an older script holds (it says nothing), half a minute already: waited for too", async () => {
  const { lock, env } = machine()
  mkdirSync(lock)
  const then = new Date(Date.now() - 30_000)
  utimesSync(lock, then, then)
  const adopting = adopt(env)
  await pause(2_000)
  expect(adopting.exitCode).toBeNull()
  expect(existsSync(lock)).toBe(true)
  rmSync(lock, { recursive: true })
  expect(await adopting.exited).toBe(0)
}, SPAWNS)

test("one whose holder is gone is taken at once, and let go of", async () => {
  const { lock, said, env } = machine()
  const gone = Bun.spawn(["/usr/bin/true"])
  await gone.exited
  mkdirSync(lock)
  writeFileSync(said, `${gone.pid}\n`)
  const adopting = adopt(env)
  expect(JSON.parse(await new Response(adopting.stdout).text()).status).toBe("own")
  expect(await adopting.exited).toBe(0)
  expect(existsSync(lock)).toBe(false)
  expect(existsSync(said)).toBe(false)
}, SPAWNS)
