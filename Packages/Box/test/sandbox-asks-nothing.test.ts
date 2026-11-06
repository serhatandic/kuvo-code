import "./safety"
import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FencePolicy } from "../src/link/fence/policy"

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

test("a personal folder that can't be opened keeps its wall where its link leads", () => {
  const root = scratch()
  const home = join(root, "home")
  const desk = join(root, "elsewhere", "desk")
  mkdirSync(home, { recursive: true })
  mkdirSync(desk, { recursive: true })
  symlinkSync(desk, join(home, "Desktop"))
  // As macOS has it for a process it hasn't asked you about yet: there, and refused if it's opened.
  chmodSync(desk, 0)
  const ran = Bun.spawnSync([process.execPath, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy.ts"))}; console.log(JSON.stringify(fencePolicy()))`],
    { env: { ...environment(home), KUVO_HOME: join(root, "kuvo") }, cwd: root })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  const policy = JSON.parse(ran.stdout.toString()) as FencePolicy
  expect(policy.personal).toContain(desk)
})

test("a box says where it is without opening a personal folder, iCloud Drive or another app's data", async () => {
  const root = scratch()
  const home = join(root, "home")
  const kuvo = join(root, "kuvo")
  mkdirSync(home, { recursive: true })
  mkdirSync(kuvo, { recursive: true })
  const opened = join(root, "opened")
  // What a Mac would stop for, in your account's home and the box's (never let through to the system:
  // this test mustn't ask either), noted as the box's own code asks to open it.
  const preload = join(root, "note-opens.cjs")
  writeFileSync(preload, `
const fs = require("fs")
const noted = ${JSON.stringify(opened)}
const guarded = /\\/(Desktop|Documents|Downloads|Pictures|Movies|Music|Library\\/Mobile Documents|Library\\/Containers\\/|Library\\/Group Containers\\/)/
for (const name of ["realpathSync", "openSync", "readFileSync", "readdirSync", "opendirSync"]) {
  const real = fs[name]
  const stopped = function (where, ...rest) {
    if (typeof where === "string" && guarded.test(where)) {
      fs.appendFileSync(noted, name + " " + where + "\\n")
      throw Object.assign(new Error("ENOENT: " + where), { code: "ENOENT" })
    }
    return real.call(this, where, ...rest)
  }
  fs[name] = Object.assign(stopped, real)
}
const native = fs.realpathSync.native
fs.realpathSync.native = function (where, ...rest) {
  if (typeof where === "string" && guarded.test(where)) {
    fs.appendFileSync(noted, "realpathSync.native " + where + "\\n")
    throw Object.assign(new Error("ENOENT: " + where), { code: "ENOENT" })
  }
  return native.call(this, where, ...rest)
}
`)
  writeFileSync(opened, "")
  const box = Bun.spawn([process.execPath, "run", "--config=/dev/null", "--no-env-file", "--preload", preload, join(import.meta.dir, "..", "src", "link", "main.ts"), "serve"], {
    env: { ...environment(home), KUVO_HOME: kuvo, KUVO_BOX: "mac", KUVO_TEST_NO_PEERS: "1", KUVO_ENGINE_CONFIG: join(root, "config"), KUVO_ENGINE_DATA: join(root, "data"), KUVO_INTEGRATIONS: join(root, "integrations"), KUVO_BOTS: join(root, "bots"), KUVO_WAKES: join(root, "wakes"), KUVO_CHATS: join(root, "chats") },
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
    expect(await Bun.file(opened).text()).toBe("")
  } finally {
    box.kill(9)
    await box.exited
  }
}, 30_000)
