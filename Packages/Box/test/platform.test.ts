import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { processRuns, promptedFolders } from "../src/shared/platform"

// Where macOS and Linux differ, each side tested on whichever system runs this: a box tells its own
// programs from whatever took their process's number after a crash (Linux by /proc, a stand-in
// folder here; macOS, without one, by their being alive), and leaves the folders a Mac asks you
// about out of what it looks into.

// A number no process has (past either system's highest).
const gone = 99_999_999
let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-box-platform-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A /proc of the test's own, with `pid`'s command line. */
function proc(pid: number, ...argv: string[]) {
  const folder = join(root, "proc")
  mkdirSync(join(folder, String(pid)), { recursive: true })
  writeFileSync(join(folder, String(pid), "cmdline"), argv.join("\0") + "\0")
  return folder
}

test("Linux: a process is the program its command line names, and no other", () => {
  const folder = proc(process.pid, "/opt/engine/opencode", "/home/you/.kuvo-code/bin/kuvo-agents.js")
  expect(processRuns(process.pid, "kuvo-agents", folder)).toBe(true)
  // Its number taken by something else after a crash.
  expect(processRuns(process.pid, "kuvo-browser", folder)).toBe(false)
  // Alive (this test's parent), but not listed there.
  expect(process.ppid).toBeGreaterThan(1)
  expect(processRuns(process.ppid, "kuvo-agents", folder)).toBe(false)
})

test("Linux: a process that ended isn't running, whatever its command line said", () => {
  const folder = proc(gone, "kuvo-agents.js")
  expect(processRuns(gone, "kuvo-agents", folder)).toBe(false)
})

test("macOS, without /proc: a process that's alive is taken as the program it's said to be", () => {
  const none = join(root, "no-proc")
  expect(processRuns(process.pid, "kuvo-agents", none)).toBe(true)
  expect(processRuns(gone, "kuvo-agents", none)).toBe(false)
})

test("on both: no number, or the system's own, is never a program of the box's", () => {
  const none = join(root, "no-proc")
  for (const pid of [undefined, null, "123", 1.5, 0, 1, -4]) expect(processRuns(pid, "kuvo-agents", none)).toBe(false)
})

test("a Mac asks before an app looks into Desktop, Documents and the rest; Linux asks about none", () => {
  expect([...promptedFolders("darwin")].sort()).toEqual(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"])
  expect(promptedFolders("linux").size).toBe(0)
})
