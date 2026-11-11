// How long a coding agents' bridge looks for a quiet moment to make way for a newer one put in its
// place, before new turns wait for it (agents/renewal.ts): an hour, then the night's window where
// you are; a day at most, whatever the hour. Whose own build comes back in place lets go of what it
// held.

import "../safety"
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchLets, Renewal, renewalTiming } from "../../src/agents/renewal"
import { keeperEngine } from "../../src/shared/engines"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-renewal-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const HOUR = 3_600_000
const own = "a".repeat(64)
const newer = "b".repeat(64)

function bundle(file: string, build: string) {
  writeFileSync(file + ".new", `console.log(1)\n// Built from Packages/Box/src/agents ${build}\n// kuvo-agents ${build.slice(0, 16)}\n`)
  renameSync(file + ".new", file)
}

/** A bridge running `own`, on a clock the test moves, in Istanbul, with turns under way while `busy`. */
function bridge(name: string, start: string) {
  const script = join(base, name)
  bundle(script, own)
  let now = Date.parse(start)
  const held: boolean[] = []
  const told: unknown[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: true, other: false }), hold: (on) => held.push(on), renew: () => {}, told: (state) => told.push(state), now: () => now, zone: "Europe/Istanbul" })
  return {
    renewal,
    held,
    told,
    install: (build: string) => bundle(script, build),
    at: (iso: string) => void (now = Date.parse(iso)),
  }
}

test("a box that's never quiet: new turns wait from the night after its first hour, and after a day whatever the hour", () => {
  // Seen at 21:00 there: 22:00 and on, the day's still on; the night's window (02:00) holds them.
  const evening = bridge("evening.js", "2026-11-11T18:00:00Z")
  evening.install(newer)
  evening.renewal.look()
  expect(evening.renewal.state).toEqual({ since: Date.parse("2026-11-11T18:00:00Z"), holding: false, waits: "quiet" })
  evening.at("2026-11-11T20:30:00Z")
  evening.renewal.look()
  expect(evening.held).toEqual([])
  evening.at("2026-11-11T23:00:00Z")
  evening.renewal.look()
  expect(evening.held).toEqual([true])
  expect(evening.renewal.state?.holding).toBe(true)

  // Seen at 02:30 there: within its first hour it doesn't hold; at 03:30, still the night, it does.
  const night = bridge("night.js", "2026-11-11T23:30:00Z")
  night.install(newer)
  night.renewal.look()
  night.at("2026-11-12T00:15:00Z")
  night.renewal.look()
  expect(night.held).toEqual([])
  night.at("2026-11-12T00:31:00Z")
  night.renewal.look()
  expect(night.held).toEqual([true])

  // Seen at 05:00 there: it waits out the day and the evening, then holds at the next night.
  const morning = bridge("morning.js", "2026-11-12T02:00:00Z")
  morning.install(newer)
  morning.renewal.look()
  morning.at("2026-11-12T22:59:00Z")
  morning.renewal.look()
  expect(morning.held).toEqual([])
  morning.at("2026-11-12T23:00:00Z")
  morning.renewal.look()
  expect(morning.held).toEqual([true])

  expect(renewalTiming.longest).toBe(24 * HOUR)
})

test("with no night where it is (an unknown zone), new turns wait after a day", () => {
  const box = bridge("nowhere.js", "2026-11-12T09:00:00Z")
  const renewal = new Renewal({ script: join(base, "nowhere.js"), build: own, work: () => ({ turns: true, other: false }), hold: (on) => box.held.push(on), renew: () => {}, told: () => {}, now: () => Date.parse("2026-11-13T08:59:00Z"), zone: "Nowhere/Else" })
  box.install(newer)
  renewal.look()
  expect(box.held).toEqual([])
  expect(renewal.holdsNow(Date.parse("2026-11-12T09:00:00Z"), Date.parse("2026-11-13T09:00:00Z"))).toBe(true)
})

test("its own build put back in place: it no longer waits, and what it held goes", () => {
  const box = bridge("back.js", "2026-11-11T23:30:00Z")
  box.install(newer)
  box.renewal.look()
  box.at("2026-11-12T00:31:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true])
  box.install(own)
  box.renewal.look()
  expect(box.held).toEqual([true, false])
  expect(box.renewal.state).toBeNull()
  expect(box.told.at(-1)).toBeNull()
})

test("a turn that won't end while it holds (one waiting on you overnight): after half an hour what it held goes, and it holds again from the next night", () => {
  const box = bridge("stuck.js", "2026-11-11T22:00:00Z")
  box.install(newer)
  box.renewal.look()
  box.at("2026-11-11T23:00:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true])
  box.at("2026-11-11T23:29:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true])
  box.at("2026-11-11T23:30:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true, false])
  expect(box.renewal.state).toEqual({ since: Date.parse("2026-11-11T22:00:00Z"), holding: false, waits: "quiet" })
  // Still the night an hour on (03:30 there): it holds again.
  box.at("2026-11-12T00:29:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true, false])
  box.at("2026-11-12T00:30:00Z")
  box.renewal.look()
  expect(box.held).toEqual([true, false, true])
  expect(renewalTiming.holding).toBe(30 * 60_000)
})

test("a bundle brought with an engine that hasn't started yet: it doesn't make way for it, nor hold anything, until that engine runs it", () => {
  const script = join(base, "engine.js")
  bundle(script, own)
  let ready = false
  const held: boolean[] = []
  const told: unknown[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: true, other: false }), hold: (on) => held.push(on), renew: () => {}, told: (state) => told.push(state), ready: () => ready, now: () => Date.parse("2026-11-12T00:00:00Z"), holdAfter: 0 })
  bundle(script, newer)
  renewal.look()
  expect(renewal.state?.waits).toBe("engine")
  expect(renewal.state?.holding).toBe(false)
  expect(held).toEqual([])
  ready = true
  renewal.look()
  expect(renewal.state?.holding).toBe(true)
  expect(held).toEqual([true])
})

test("what keeps it running starts it again: a launch since October 2026 always; one from before only while it has started fewer than four times", () => {
  const loop = `sh -c n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 5 ]; do s=$(date +%s); "$2" … ; [ $(($(date +%s) - s)) -ge 600 ] && n=0; n=$((n + 1)); sleep 5; done kuvo-agents`
  const older = `sh -c n=0; while kill -0 "$1" 2>/dev/null && [ $n -lt 5 ]; do "$2" … ; n=$((n + 1)); sleep 5; done kuvo-agents`
  const starts = (count: number) => () => '{"url": "http://127.0.0.1:1"}\n'.repeat(count)
  expect(launchLets(loop, starts(9))).toBe(true)
  expect(launchLets(older, starts(3))).toBe(true)
  expect(launchLets(older, starts(4))).toBe(false)
  // One it can't read is taken for one from before; a log it can't read, for a full one.
  expect(launchLets(undefined, starts(4))).toBe(false)
  expect(launchLets(older, () => undefined)).toBe(false)
})

test("a launch that wouldn't start it again: it waits for a restart, and holds nothing for it", () => {
  const script = join(base, "spent.js")
  bundle(script, own)
  const held: boolean[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: false, other: false }), hold: (on) => held.push(on), renew: () => {}, told: () => {}, lets: () => false, now: () => Date.parse("2026-11-12T00:00:00Z"), holdAfter: 0 })
  bundle(script, newer)
  renewal.look()
  expect(renewal.state?.waits).toBe("restart")
  expect(held).toEqual([])
})

test("it goes only once it has run eleven minutes (a launch counts a shorter run as one that failed)", () => {
  const script = join(base, "young.js")
  bundle(script, own)
  let uptime = 10 * 60_000
  const held: boolean[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: false, other: false }), hold: (on) => held.push(on), renew: () => {}, told: () => {}, uptime: () => uptime, settle: 0, now: () => Date.parse("2026-11-12T12:00:00Z") })
  bundle(script, newer)
  renewal.look()
  expect(held).toEqual([])
  uptime = 11 * 60_000
  renewal.look()
  expect(held).toEqual([true])
  renewal.stop()
})

test("a quiet moment counts once nothing has run for half a minute: a turn that ended meanwhile starts it again", () => {
  const script = join(base, "settle.js")
  bundle(script, own)
  let now = Date.parse("2026-11-12T12:00:00Z")
  let turns = true
  const held: boolean[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns, other: false }), hold: (on) => held.push(on), renew: () => {}, told: () => {}, now: () => now })
  bundle(script, newer)
  renewal.look()
  turns = false
  renewal.look()
  now += 20_000
  // A turn came and went between two looks.
  renewal.busied()
  renewal.look()
  now += 29_000
  renewal.look()
  expect(held).toEqual([])
  now += 1_000
  renewal.look()
  expect(held).toEqual([true])
  renewal.stop()
})

test("an update of the box that never finished doesn't keep it holding: after half an hour what waited goes", () => {
  const script = join(base, "paused.js")
  bundle(script, own)
  let now = Date.parse("2026-11-12T12:00:00Z")
  let paused = false
  const held: boolean[] = []
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: true, other: false }), hold: (on) => held.push(on), renew: () => {}, told: () => {}, paused: () => paused, now: () => now, holdAfter: 0 })
  bundle(script, newer)
  renewal.look()
  expect(held).toEqual([true])
  paused = true
  now += 30 * 60_000
  renewal.look()
  expect(held).toEqual([true, false])
  expect(renewal.state?.holding).toBe(false)
})

test("a bundle that doesn't run here: it waits for a restart, holding nothing", async () => {
  const script = join(base, "broken.js")
  bundle(script, own)
  const held: boolean[] = []
  let checked: () => void = () => {}
  const answered = new Promise<void>((done) => (checked = done))
  const renewal = new Renewal({ script, build: own, work: () => ({ turns: false, other: false }), hold: (on) => held.push(on), renew: () => {}, told: () => {}, check: async () => (setTimeout(checked, 0), false), now: () => Date.parse("2026-11-12T00:00:00Z"), holdAfter: 0 })
  bundle(script, newer)
  renewal.look()
  await answered
  renewal.look()
  expect(renewal.state?.waits).toBe("restart")
  expect(renewal.state?.holding).toBe(false)
  expect(held).toEqual([])
})

test("the engine a machine's keeper starts: the one its script names while it's there, else the newest there", () => {
  const root = join(base, "machine")
  for (const version of ["2.2.5", "2.10.0", "2.9.1"]) {
    mkdirSync(join(root, "engine", version), { recursive: true })
    writeFileSync(join(root, "engine", version, "opencode"), "", { mode: 0o755 })
  }
  mkdirSync(join(root, "bin"), { recursive: true })
  writeFileSync(join(root, "bin", "kuvo-start"), "#!/bin/sh\nV=2.2.5\n")
  expect(keeperEngine(root)).toBe("2.2.5")
  // A Mac named a newer one it didn't bring (sessions were at work): the newest there.
  writeFileSync(join(root, "bin", "kuvo-start"), "#!/bin/sh\nV=2.11.0\n")
  expect(keeperEngine(root)).toBe("2.10.0")
})
