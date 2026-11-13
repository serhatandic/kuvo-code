import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { askedEnv, forgetLoginEnv, loginEnvRead } from "../src/link/run-command"

// What you ask git for yourself (Commit, Push, Merge into…) runs with your login shell's
// environment as it is now on a Mac, read again once it's a minute old, never waiting long for a
// slow one: in a box that runs for days, a startup file you changed counts. A login shell of the
// test's own, whose startup file says what it sets; the time each read happens at is given.

const folders: string[] = []
// (Other files' tests in this process read it too.)
beforeEach(() => forgetLoginEnv())
afterEach(async () => {
  await forgetLoginEnv()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function login() {
  const folder = mkdtempSync(join(tmpdir(), "kuvo-asked-env-"))
  folders.push(folder)
  const profile = join(folder, "profile")
  const shell = join(folder, "shell")
  writeFileSync(shell, `#!/bin/sh\n. "${profile}"\nshift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 })
  const sets = (tty: string, more = "") => writeFileSync(profile, `${more}export GPG_TTY=${tty}\nexport DYLD_INSERT_LIBRARIES=/nowhere\nexport NODE_OPTIONS=--require=/nowhere\nexport KUVO_HOST_PASSWORD=secret\nexport BUN_BE_BUN=1\n`)
  const from = { HOME: folder, SHELL: shell, PATH: "/usr/bin:/bin", BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(folder, "box") }
  return { folder, sets, from }
}

test("a startup file changed since counts once the last read is a minute old, and none of the box's own variables or what runs before a program's code ever does", async () => {
  const { sets, from } = login()
  const start = Date.now()
  sets("/dev/ttys041")
  const first = await askedEnv(from, "darwin", start, 30_000)
  expect(first.GPG_TTY).toBe("/dev/ttys041")
  for (const name of ["BUN_BE_BUN", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "KUVO_HOST_PASSWORD", "KUVO_HOME"]) expect(first[name]).toBeUndefined()

  sets("/dev/ttys042")
  expect((await askedEnv(from, "darwin", start + 30_000, 30_000)).GPG_TTY).toBe("/dev/ttys041")
  expect((await askedEnv(from, "darwin", start + 61_000, 30_000)).GPG_TTY).toBe("/dev/ttys042")
})

test("a slow startup file isn't waited on: the last read stands until the new one's done", async () => {
  const { folder, sets, from } = login()
  const start = Date.now()
  sets("/dev/ttys041")
  expect((await askedEnv(from, "darwin", start, 30_000)).GPG_TTY).toBe("/dev/ttys041")
  // Its next read held until the test lets it go.
  const gate = join(folder, "gate")
  execFileSync("mkfifo", [gate])
  sets("/dev/ttys043", `read held < "${gate}"\n`)
  expect((await askedEnv(from, "darwin", start + 61_000, 0)).GPG_TTY).toBe("/dev/ttys041")
  writeFileSync(gate, "go\n")
  await loginEnvRead()
  expect((await askedEnv(from, "darwin", start + 62_000, 0)).GPG_TTY).toBe("/dev/ttys043")
})

test("on Linux, without a home, or in a test's box told not to: the environment the box started with", async () => {
  const { sets, from } = login()
  sets("/dev/ttys041")
  expect((await askedEnv(from, "linux", Date.now(), 30_000)).GPG_TTY).toBeUndefined()
  expect((await askedEnv({ ...from, HOME: undefined }, "darwin", Date.now(), 30_000)).GPG_TTY).toBeUndefined()
  expect((await askedEnv({ ...from, KUVO_TEST_LOGIN_ENV: "off" }, "darwin", Date.now(), 30_000)).GPG_TTY).toBeUndefined()
  expect((await askedEnv(from, "linux", Date.now(), 30_000)).BUN_BE_BUN).toBeUndefined()
})
