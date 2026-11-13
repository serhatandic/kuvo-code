import "./safety"
import { afterEach, expect, test } from "bun:test"
import { existsSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kuvoPorts } from "../src/link/fence/state"
import { RUN } from "../src/link/home"
import { APP_FILE, GONE, NEEDS_APP, NOT_READY, REST, UPDATING_FILE, WAIT, appStatus, couldntOpen, noteUpdating, openApp, readApp, registerApp } from "../src/link/mac/app"
import type { OpenWays } from "../src/link/mac/app"

// A browser call on a Mac's own box while its app is closed (#333 piece 3, carrying over #211's
// `AppOpener`): the box decides to open the app, and every call meanwhile waits on that one
// opening; 30 seconds for the app to register, then the agent hears why not; no other opening for
// five minutes after one that failed; never one while an update of the app installs. The box's
// own code, on the run's own `run` folder, with the host's opening and the clock as stand-ins:
// the wait ends when the test says (the app registered, or its time ran out), never by a timer.

const files = ["app.json", "app-opening.json", "app-open-failed.json", "app-updating"]
afterEach(() => { for (const file of files) rmSync(join(RUN, file), { force: true }) })

const TOOLS = { url: "http://127.0.0.1:4567/mcp", token: "t".repeat(32) }
const BUNDLE = "/Applications/Kuvo Code.app"

/** The host and the clock as a test runs them: what the host was asked to open (and answers, by
 * `opens`), the time (`at`, moved by the test), and the calls waiting for the app, which go on
 * once it registers (`registers`) or its time runs out (`expire`). */
function stage(opens: (bundle: string) => string | null | Promise<string | null> = () => null) {
  const asked: string[] = []
  const waiting: (() => void)[] = []
  const world: { at: number; asked: string[]; waiting: (() => void)[]; registers: () => void; expire: () => void; ways: OpenWays } = {
    at: 1_000_000,
    asked,
    waiting,
    registers() {
      registerApp({ tools: TOOLS }, world.at)
      for (const go of waiting.splice(0)) go()
    },
    expire() {
      for (const go of waiting.splice(0)) go()
    },
    ways: {
      open: async (bundle: string) => { asked.push(bundle); return await opens(bundle) },
      now: () => world.at,
      until: (ready: () => boolean) => new Promise<void>(resolve => { if (ready()) resolve(); else waiting.push(resolve) }),
    } as OpenWays,
  }
  return world
}

/** Until `count` calls wait for the app (each turn of the loop lets them get there). */
async function waitingFor(world: ReturnType<typeof stage>, count: number) {
  for (let turns = 0; turns < 1000 && world.waiting.length < count; turns++) await new Promise(resolve => setImmediate(resolve))
  expect(world.waiting.length).toBe(count)
}

test("many browser calls while the app is closed: one opening, of the app where it registered, and each goes on once it's there", async () => {
  registerApp({ tools: TOOLS, bundle: BUNDLE })
  registerApp({ tools: null })
  expect(readApp()).toMatchObject({ bundle: BUNDLE, tools: null })
  const world = stage()
  const calls = [openApp(undefined, world.ways), openApp(undefined, world.ways), openApp(undefined, world.ways)]
  await waitingFor(world, 3)
  expect(world.asked).toEqual([BUNDLE])
  expect(appStatus(world.at).opening).toBe(true)
  world.registers()
  expect(await Promise.all(calls)).toEqual([null, null, null])
  expect(appStatus(world.at)).toMatchObject({ open: true, opening: false, failed: null, bundle: BUNDLE })
  // Open: a call goes straight on, nothing opened.
  expect(await openApp(undefined, world.ways)).toBeNull()
  expect(world.asked).toEqual([BUNDLE])
})

test("an app that doesn't register within 30 seconds: every call waiting hears so, and none opens it again for five minutes", async () => {
  registerApp({ tools: null, bundle: BUNDLE })
  const world = stage()
  const calls = [openApp(undefined, world.ways), openApp(undefined, world.ways)]
  await waitingFor(world, 2)
  world.at += WAIT
  world.expire()
  expect(await Promise.all(calls)).toEqual([NOT_READY, NOT_READY])
  expect(NOT_READY).toContain("within 30 seconds")
  // Resting: told the same, and not asked of the host.
  world.at += REST - 1
  expect(await openApp(undefined, world.ways)).toBe(NOT_READY)
  expect(world.asked).toEqual([BUNDLE])
  expect(appStatus(world.at).failed?.message).toBe(NOT_READY)
  // Its rest over: opened again.
  world.at += 1
  const again = openApp(undefined, world.ways)
  await waitingFor(world, 1)
  expect(world.asked).toEqual([BUNDLE, BUNDLE])
  world.registers()
  expect(await again).toBeNull()
  expect(appStatus(world.at).failed).toBeNull()
})

test("an app that couldn't be opened, or isn't where it was installed: the agent hears why, and the rest holds", async () => {
  registerApp({ tools: null, bundle: BUNDLE })
  const refused = stage(() => couldntOpen("macOS refused"))
  expect(await openApp(undefined, refused.ways)).toBe(couldntOpen("macOS refused"))
  expect(couldntOpen("macOS refused")).toBe("Kuvo Code couldn't be opened in the background on this Mac for its browser (macOS refused). Ask the user to open Kuvo Code, then try again.")
  expect(await openApp(undefined, refused.ways)).toBe(couldntOpen("macOS refused"))
  expect(refused.asked).toEqual([BUNDLE])
  // The app opened by you meanwhile: registered, the rest forgotten, and calls go on.
  refused.registers()
  expect(appStatus(refused.at).failed).toBeNull()
  expect(await openApp(undefined, refused.ways)).toBeNull()

  for (const file of files) rmSync(join(RUN, file), { force: true })
  registerApp({ tools: null, bundle: BUNDLE })
  const gone = stage(() => GONE)
  expect(await openApp(undefined, gone.ways)).toBe(GONE)
})

test("an app that never registered with this box: nothing to open, and the agent's told to ask for it", async () => {
  const world = stage()
  expect(await openApp(undefined, world.ways)).toBe(NEEDS_APP)
  expect(world.asked).toEqual([])
})

test("while an update of the app installs, it isn't opened over it: calls wait for it to open by itself", async () => {
  registerApp({ tools: TOOLS, bundle: BUNDLE })
  noteUpdating()
  expect(appStatus()).toMatchObject({ open: false, updating: true })
  const world = stage()
  world.at = Date.now()
  const calls = [openApp(undefined, world.ways), openApp(undefined, world.ways)]
  await waitingFor(world, 2)
  expect(world.asked).toEqual([])
  // Sparkle opened it again: it registered, and the note's gone.
  world.registers()
  expect(await Promise.all(calls)).toEqual([null, null])
  expect(existsSync(UPDATING_FILE())).toBe(false)

  // A note left from an update that never opened again (more than two minutes old) holds nothing.
  registerApp({ tools: null })
  writeFileSync(UPDATING_FILE(), "")
  const old = new Date(Date.now() - 3 * 60_000)
  utimesSync(UPDATING_FILE(), old, old)
  const later = stage()
  later.at = Date.now()
  const call = openApp(undefined, later.ways)
  await waitingFor(later, 1)
  expect(later.asked).toEqual([BUNDLE])
  later.registers()
  expect(await call).toBeNull()
})

test("a call that gives up while it waits stops waiting; the opening goes on for the others", async () => {
  registerApp({ tools: null, bundle: BUNDLE })
  const world = stage()
  const first = openApp(undefined, world.ways)
  await waitingFor(world, 1)
  const stop = new AbortController()
  const ways: OpenWays = { ...world.ways, until: (ready, deadline, signal) => new Promise(resolve => { signal?.addEventListener("abort", () => resolve(), { once: true }); world.ways.until(ready, deadline, signal).then(resolve) }) }
  const second = openApp(stop.signal, ways)
  await waitingFor(world, 2)
  stop.abort()
  expect(await second).toBe("The call was stopped.")
  world.registers()
  expect(await first).toBeNull()
  expect(world.asked).toEqual([BUNDLE])
})

test("the app's registration: where its tools answer only on this Mac, and its place kept while it's closed", () => {
  registerApp({ tools: TOOLS, bundle: BUNDLE })
  expect(readApp()).toMatchObject({ bundle: BUNDLE, tools: TOOLS })
  registerApp({ tools: null })
  expect(readApp()).toMatchObject({ bundle: BUNDLE, tools: null })
  // Written for its owner alone.
  expect(statSync(APP_FILE()).mode & 0o777).toBe(0o600)
  // A file that names its tools elsewhere is read as no tools at all.
  writeFileSync(APP_FILE(), JSON.stringify({ bundle: BUNDLE, tools: { url: "http://example.com/mcp", token: TOOLS.token }, at: 1 }))
  expect(readApp()?.tools).toBeNull()
  writeFileSync(APP_FILE(), JSON.stringify({ bundle: "Kuvo Code.app", tools: null, at: 1 }))
  expect(readApp()?.bundle).toBeNull()
})

test("agents' commands in the sandbox are refused the app's tools and its own host, as it registered them", () => {
  registerApp({ tools: { url: "http://127.0.0.1:41001/mcp", token: "t".repeat(32) }, host: { url: "http://127.0.0.1:41002", password: "p".repeat(32) } })
  expect(kuvoPorts()).toEqual(expect.arrayContaining([41001, 41002]))
  // Quit: neither is the app's any more.
  registerApp({ tools: null })
  expect(kuvoPorts()).not.toContain(41002)
})
