import "./safety"
import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FencePolicy } from "../src/link/fence/policy"
import { accountHome } from "../src/link/home"

// Setting up the sandbox's walls is the first thing a box does, and it answers no one until that's
// done, so it must never wait on anything. On a Mac, opening your Desktop, Documents, iCloud Drive or
// another app's data holds a process until you answer macOS's prompt (nobody may be there); only
// asking about a name (`lstat`) doesn't. Bun's `fs.realpathSync` opens what it's given.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, "elsewhere", "desk"), 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-asks-nothing-")))
  roots.push(root)
  return root
}
const environment = (home: string) => ({ HOME: home, PATH: "/usr/bin:/bin", TMPDIR: tmpdir(), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" })

/** Loaded before the box's code: what would open a folder macOS guards in your account's home (all of
 * ~/Library: it guards more of it than it says) is noted in `noted`, and never reaches the system, so
 * these tests can't ask either, whatever the code does. This checkout is its own, wherever it is. */
function guard(root: string): { preload: string; noted: string } {
  const preload = join(root, "note-opens.cjs")
  const noted = join(root, "opened")
  writeFileSync(noted, "")
  // (But for listing your Keychain's folder, to wall off the system's keychains in it: macOS doesn't guard that.)
  const names = "Desktop|Documents|Downloads|Pictures|Movies|Music|Library(?!/Keychains$)"
  const checkout = join(import.meta.dir, "..", "..", "..")
  writeFileSync(preload, `
const fs = require("fs")
const guarded = where => typeof where === "string" && !where.startsWith(${JSON.stringify(checkout + "/")}) && new RegExp(${JSON.stringify(`^${accountHome()}/(${names})(/|$)`)}, "i").test(where)
const stop = (name, where) => {
  fs.appendFileSync(${JSON.stringify(noted)}, name + " " + where + "\\n")
  return Object.assign(new Error("ENOENT: " + where), { code: "ENOENT" })
}
const wrap = (on, name, label) => {
  const real = on[name]
  on[name] = Object.assign(function (where, ...rest) {
    if (guarded(where)) throw stop(label + name, where)
    return real.call(this, where, ...rest)
  }, real)
}
for (const name of ["openSync", "readFileSync", "readdirSync", "opendirSync", "watch"]) wrap(fs, name, "")
wrap(fs.realpathSync, "native", "realpathSync.")
wrap(fs, "realpathSync", "")
for (const name of ["open", "readFile", "readdir", "opendir", "realpath"]) wrap(fs.promises, name, "promises.")
`)
  return { preload, noted }
}

test("a personal folder that can't be opened keeps its wall where its link leads", async () => {
  const root = scratch()
  const home = join(root, "home")
  const desk = join(root, "elsewhere", "desk")
  mkdirSync(home, { recursive: true })
  mkdirSync(desk, { recursive: true })
  symlinkSync(desk, join(home, "Desktop"))
  // As macOS has it for a process it hasn't asked you about yet: there, and refused if it's opened.
  chmodSync(desk, 0)
  // And one reached as a dotfiles manager links them: relative, through a link, with `..` after it.
  const docs = join(root, "elsewhere", "deep", "docs")
  mkdirSync(join(root, "elsewhere", "deep", "inner"), { recursive: true })
  mkdirSync(docs)
  symlinkSync(join("deep", "inner"), join(root, "elsewhere", "through"))
  symlinkSync("../elsewhere/through/../docs", join(home, "Documents"))
  const { preload, noted } = guard(root)
  const ran = Bun.spawnSync([process.execPath, "--preload", preload, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy.ts"))}; console.log(JSON.stringify(fencePolicy()))`],
    { env: { ...environment(home), KUVO_HOME: join(root, "kuvo") }, cwd: root })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  const policy = JSON.parse(ran.stdout.toString()) as FencePolicy
  expect(policy.personal).toContain(desk)
  expect(policy.personal).toContain(docs)
  if (process.platform === "darwin") expect(await Bun.file(noted).text()).toBe("")
})

test.skipIf(process.platform !== "darwin")("a box says where it is without opening a personal folder, iCloud Drive or another app's data", async () => {
  const root = scratch()
  const home = join(root, "home")
  const kuvo = join(root, "kuvo")
  mkdirSync(home, { recursive: true })
  mkdirSync(join(kuvo, "box"), { recursive: true })
  // With a project there that has a folder of its own allowed, whose rule the box tells its launcher.
  const project = join(accountHome(), "Documents", "kuvo-asks-nothing-test")
  writeFileSync(join(kuvo, "box", "sandbox-allowed.json"), JSON.stringify({ allowed: [{ id: "al_1", project, kind: "write", path: join(project, "more"), at: 1 }] }))
  const { preload, noted } = guard(root)
  const box = Bun.spawn([process.execPath, "run", "--config=/dev/null", "--no-env-file", "--preload", preload, join(import.meta.dir, "..", "src", "link", "main.ts"), "serve"], {
    env: { ...environment(home), KUVO_HOME: kuvo, KUVO_BOX: "mac", KUVO_TEST_NO_PEERS: "1", KUVO_ENGINE_CONFIG: join(root, "config") },
    cwd: kuvo, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  try {
    box.stdin.write('{"password":"test"}\n')
    box.stdin.flush()
    const reader = box.stdout.getReader()
    let said = ""
    while (!said.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) break
      said += new TextDecoder().decode(value)
    }
    expect(said).toContain('"url"')
    expect(await Bun.file(noted).text()).toBe("")
  } finally {
    box.kill(9)
    await box.exited
  }
}, 30_000)
