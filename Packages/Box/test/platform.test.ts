import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

// The PATH a box's engine and agents get: your login shell's, as a terminal there has it, not the
// bare one a start over SSH or from cron gets. A home folder as a Debian or Ubuntu account has it:
// `.profile` adds ~/.local/bin and reads `.bashrc`, which stops early unless the shell is
// interactive, before the lines nvm's installer adds at its end.
function home() {
  const folder = join(root, "home")
  const nvm = join(folder, ".nvm/versions/node/v22.11.0/bin")
  mkdirSync(join(folder, ".local/bin"), { recursive: true })
  mkdirSync(nvm, { recursive: true })
  writeFileSync(join(nvm, "node"), "#!/bin/sh\n")
  chmodSync(join(nvm, "node"), 0o755)
  writeFileSync(join(folder, ".profile"), [
    'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'PATH="$HOME/.local/bin:$PATH"',
  ].join("\n") + "\n")
  writeFileSync(join(folder, ".bashrc"), [
    "case $- in *i*) ;; *) return;; esac",
    "echo 'Welcome back'",
    'export NVM_DIR="$HOME/.nvm"',
    'PATH="$NVM_DIR/versions/node/v22.11.0/bin:$PATH"',
  ].join("\n") + "\n")
  return { folder, local: join(folder, ".local/bin"), nvm }
}

/** What a box program prints, run as the machine's start runs it: from cron's bare environment, with the shell you log in with. */
function ran(args: string[], folder: string, more: Record<string, string> = {}) {
  const box = resolve(import.meta.dir, "..")
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: box,
    env: { HOME: folder, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", KUVO_HOME: join(folder, ".kuvo-code"), BUN_BE_BUN: "1", ...more },
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.stdout.toString()
}

test("on both: a machine's engine starts with the PATH your login shell sets up, nvm's node and ~/.local/bin on it", () => {
  const { folder, local, nvm } = home()
  // As the start script asks the box's link (`kuvo-link.js login-path`).
  const found = ran(["src/link/main.ts", "login-path"], folder).split(":")
  expect(found).toContain(nvm)
  expect(found).toContain(local)
  expect(found).toContain("/usr/bin")
})

test("on both: the coding agents' bridge on a machine finds nvm's node too", () => {
  const { folder, nvm } = home()
  const script = 'import { refreshLoginPath, which } from "./src/agents/proc"; await refreshLoginPath(true); process.stdout.write(which("node") ?? "none")'
  expect(ran(["-e", script], folder, { KUVO_AGENTS_REMOTE: "1" })).toBe(join(nvm, "node"))
})
