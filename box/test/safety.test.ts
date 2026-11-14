import "./safety"
// What test/safety.ts promises on Bun's runner, which a box's tests run on: test-safety.test.js holds
// Node's. Decoys stand for the real folders, as `mktemp` in another process, so they aren't a test's own.
import { afterAll, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs, { copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

const decoys: string[] = []
afterAll(() => {
  for (const decoy of decoys) execFileSync("rm", ["-rf", decoy])
})
function decoy() {
  const folder = execFileSync("mktemp", ["-d", join(tmpdir(), "kuvo-decoy.XXXXXX")], { encoding: "utf8" }).trim()
  decoys.push(folder)
  mkdirSync(join(folder, "wakes"))
  writeFileSync(join(folder, "wakes", "keep"), "mine")
  return folder
}
const untouched = (folder: string) => expect(readdirSync(join(folder, "wakes"))).toEqual(["keep"])

test("deleting or moving outside the test's own folders throws, however it's imported, and leaves it", async () => {
  const folder = decoy()
  const wakes = join(folder, "wakes")
  const own = mkdtempSync(join(tmpdir(), "own-"))
  for (const attempt of [
    () => rmSync(wakes, { recursive: true, force: true }),
    () => fs.rmSync(wakes, { recursive: true, force: true }),
    () => renameSync(wakes, join(folder, "gone")),
    () => renameSync(own, join(wakes, "keep")),
  ]) {
    expect(attempt).toThrow(/Refusing to .*test-safety/)
    untouched(folder)
  }
  expect(() => rm(wakes, { recursive: true, force: true })).toThrow(/Refusing to .*test-safety/)
  untouched(folder)
  // What the test made is its own to delete.
  rmSync(own, { recursive: true })
  expect(existsSync(own)).toBe(false)
})

test("a test's home is its own, by either way of asking, and in it the box's", () => {
  const real = process.env.KUVO_TEST_REAL_HOME!
  expect(process.env.HOME).not.toBe(real)
  expect(homedir()).toBe(process.env.HOME!)
  expect(process.env.KUVO_HOME!.startsWith(`${process.env.HOME}/`)).toBe(true)
})

// `bun test` reads a bunfig.toml only in the folder it starts in, so from any other there's no preload.
test("run from another folder, a test is kept from what its shell names, and has no real home", () => {
  const folder = decoy()
  const scratch = mkdtempSync(join(tmpdir(), "elsewhere-"))
  const box = resolve(import.meta.dir, "..")
  const printed = `printf '%s|%s' "$HOME" "$KUVO_WAKES"`
  writeFileSync(join(scratch, "run.test.ts"), `
    import "${join(box, "test", "safety")}"
    import { rmSync, writeFileSync } from "node:fs"
    import { execSync } from "node:child_process"
    import { test } from "bun:test"
    test("as a test would", async () => {
      // (As the tests that judge your own home do, before they load the link.)
      const own = process.env.HOME
      process.env.HOME = process.env.KUVO_TEST_REAL_HOME
      const { K, ENGINE_FILE } = await import("${join(box, "src", "link", "home")}")
      process.env.HOME = own
      let refused = false
      try { rmSync(${JSON.stringify(join(folder, "wakes"))}, { recursive: true, force: true }) } catch { refused = true }
      // What it starts, every way there is. (Bun's own hand on the environment the process started with.)
      const printed = ${JSON.stringify(printed)}
      const started = {
        spawnSync: Bun.spawnSync(["/bin/sh", "-c", printed]).stdout.toString(),
        spawn: await new Response(Bun.spawn(["/bin/sh", "-c", printed]).stdout).text(),
        spawnOfOptions: await new Response(Bun.spawn({ cmd: ["/bin/sh", "-c", printed] }).stdout).text(),
        shell: await Bun.$\`/bin/sh -c \${printed}\`.text(),
        execSync: execSync(printed, { encoding: "utf8" }),
      }
      writeFileSync(${JSON.stringify(join(scratch, "seen.json"))}, JSON.stringify({ K, ENGINE_FILE, wakes: process.env.KUVO_WAKES, refused, own, started }))
    })
  `)
  const named = { KUVO_WAKES: join(folder, "wakes"), KUVO_BOTS: join(folder, "wakes"), KUVO_HOME: join(folder, "wakes"), KUVO_TEST_REAL_HOME: scratch }
  const run = Bun.spawnSync([process.execPath, "test", "./run.test.ts"], { cwd: scratch, env: { ...process.env, ...named } })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  untouched(folder)
  const seen = JSON.parse(readFileSync(join(scratch, "seen.json"), "utf8"))
  expect(seen.refused).toBe(true)
  expect(seen.wakes).toBeUndefined()
  const tests = join(fs.realpathSync(scratch), ".kuvo-code-test")
  expect(seen.K.startsWith(`${tests}/ku-`)).toBe(true)
  expect(seen.ENGINE_FILE.startsWith(`${tests}/ku-`)).toBe(true)
  for (const [how, printed] of Object.entries(seen.started)) expect([how, printed]).toEqual([how, `${seen.own}|`])
  rmSync(scratch, { recursive: true, force: true })
})

// The files of a run share one process, in an order of the system's (by name on a Mac, not on Linux):
// one that names a KUVO_HOME of its own before it loads the link, whichever comes first, still gets
// the run's.
test("a test that names a KUVO_HOME of its own before it loads the link gets the run's", () => {
  const scratch = mkdtempSync(join(tmpdir(), "first-"))
  const box = resolve(import.meta.dir, "..")
  writeFileSync(join(scratch, "first.test.ts"), `
    import "${join(box, "test", "safety")}"
    import { writeFileSync } from "node:fs"
    import { test } from "bun:test"
    test("first to load the link", async () => {
      const run = process.env.KUVO_HOME
      process.env.KUVO_HOME = ${JSON.stringify(join(scratch, "its-own"))}
      const { K } = await import("${join(box, "src", "link", "home")}")
      process.env.KUVO_HOME = run
      writeFileSync(${JSON.stringify(join(scratch, "seen.json"))}, JSON.stringify({ K, run }))
    })
  `)
  const run = Bun.spawnSync([process.execPath, "test", "./first.test.ts"], { cwd: scratch, env: { ...process.env, KUVO_TEST_REAL_HOME: scratch } })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  const seen = JSON.parse(readFileSync(join(scratch, "seen.json"), "utf8"))
  expect(seen.K).toBe(seen.run)
  expect(seen.K.startsWith(`${join(fs.realpathSync(scratch), ".kuvo-code-test")}/ku-`)).toBe(true)
  rmSync(scratch, { recursive: true, force: true })
})

// Bun's own `os.userInfo()` follows HOME, so the guard asks the system (the box's lookup, home.ts, does the same).
test("under Bun the account's own home is found from the system, whatever HOME says, and can't be a test's own", () => {
  const scratch = mkdtempSync(join(tmpdir(), "account-"))
  const entry = process.platform === "darwin"
    ? execFileSync("/usr/bin/id", ["-P"], { encoding: "utf8" }).trim().split(":")[8]
    : execFileSync("/usr/bin/getent", ["passwd", String(process.getuid!())], { encoding: "utf8" }).trim().split(":")[5]
  const script = `import { accountHome, ownPath } from ${JSON.stringify(join(import.meta.dir, "../bridge-tests/test-safety.js"))}
    let refused = false
    try { ownPath(${JSON.stringify(join(entry, ".kuvo-code", "x"))}) } catch { refused = true }
    console.log(JSON.stringify({ accountHome, refused }))`
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: scratch, env: { ...process.env, HOME: scratch, KUVO_TEST_REAL_HOME: scratch } })
  expect(run.exitCode, run.stderr.toString()).toBe(0)
  expect(JSON.parse(run.stdout.toString())).toEqual({ accountHome: entry, refused: true })
  expect(entry).not.toBe(scratch)
  rmSync(scratch, { recursive: true, force: true })
})

test("with the preload, the run's home is gone as the run ends", () => {
  const scratch = mkdtempSync(join(tmpdir(), "with-preload-"))
  const box = resolve(import.meta.dir, "..")
  writeFileSync(join(scratch, "run.test.ts"), `import { test } from "bun:test"\ntest("nothing", () => {})\n`)
  const run = Bun.spawnSync([process.execPath, "test", join(scratch, "run.test.ts")], { cwd: box, env: { ...process.env, KUVO_TEST_REAL_HOME: scratch } })
  expect(run.exitCode).toBe(0)
  expect(existsSync(join(scratch, ".kuvo-code-test"))).toBe(false)
  rmSync(scratch, { recursive: true, force: true })
})

// A run on the engine (`BUN_BE_BUN=1 <engine> test`, as on a machine) hands BUN_BE_BUN to all it
// starts: a program that isn't Bun may still have your home (as a test judging it gives git and the
// shell), and Bun, the run's own runtime, by a link, a hard link or a copy, never does.
test("on the engine, what isn't Bun may have your real home and the run's own runtime never does", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "on-engine-")))
  symlinkSync(process.execPath, join(scratch, "engine"))
  linkSync(process.execPath, join(scratch, "engine-linked"))
  copyFileSync(process.execPath, join(scratch, "engine-copy"))
  const script = `import ${JSON.stringify(join(import.meta.dir, "../bridge-tests/test-safety.js"))}
    import { spawnSync } from "node:child_process"
    const env = { ...process.env, HOME: process.env.KUVO_TEST_REAL_HOME }
    const seen = {}
    for (const [name, program, args] of [["shell", "/bin/sh", ["-c", "true"]], ["git", "git", ["--version"]], ["runtime", process.execPath, ["-e", "0"]], ["runtime by a link", ${JSON.stringify(join(scratch, "engine"))}, ["-e", "0"]], ["runtime by a hard link", ${JSON.stringify(join(scratch, "engine-linked"))}, ["-e", "0"]], ["a copy of it", ${JSON.stringify(join(scratch, "engine-copy"))}, ["-e", "0"]]]) {
      try { spawnSync(program, args, { env }); seen[name] = "allowed" } catch { seen[name] = "refused" }
    }
    console.log(JSON.stringify(seen))`
  const run = Bun.spawnSync([process.execPath, "-e", script], { cwd: scratch, env: { ...process.env, BUN_BE_BUN: "1", HOME: scratch, KUVO_TEST_REAL_HOME: scratch } })
  expect(JSON.parse(run.stdout.toString() || "{}"), run.stderr.toString()).toEqual({ shell: "allowed", git: "allowed", runtime: "refused", "runtime by a link": "refused", "runtime by a hard link": "refused", "a copy of it": "refused" })
  expect(run.exitCode).toBe(1)
  expect(run.stderr.toString()).toContain("this run reached your real coding agents 4 time(s)")
  rmSync(scratch, { recursive: true, force: true })
})

// (Every file `bun test` takes for a test, anywhere under its root, test/ (bunfig.toml): *.test,
// *_test, *.spec, *_spec, in any of its script extensions, in test/'s subfolders too. The bridge's
// tests, in bridge-tests/, run on Node and load its own guard, test-safety.js.)
test("every box test file loads test/safety.ts before anything else", () => {
  const box = resolve(import.meta.dir, "..")
  expect(readFileSync(join(box, "bunfig.toml"), "utf8")).toMatch(/^root = "test"$/m)
  const files = (readdirSync(join(box, "test"), { recursive: true }) as string[]).filter(name => !name.split(sep).includes("node_modules") && /[._](test|spec)\.[cm]?[jt]sx?$/.test(name)).map(name => join("test", name))
  expect(files.length).toBeGreaterThan(50)
  expect(files.some(name => name.split(sep).length > 2)).toBe(true)
  const missing = files.filter(name => {
    const first = readFileSync(join(box, name), "utf8").split("\n").find(line => line.trim() && !line.startsWith("//"))
    const safety = relative(dirname(join(box, name)), join(box, "test", "safety"))
    return first !== `import "${safety.startsWith(".") ? safety : `./${safety}`}"`
  })
  expect(missing).toEqual([])
})

// A bridge a box test starts with an environment it made (test/hang.test.ts runs the bridge's
// main.ts so) prices usage with what it ships, never with the feeds on the web: either way of
// starting it.
test("what a box test starts, with an environment of its own, is told to fetch no prices", () => {
  const script = "process.stdout.write(String(process.env.KUVO_TEST_PRICE_FEEDS))"
  // (On the engine, Bun is the engine's program told to be Bun.)
  const env = { PATH: "/usr/bin:/bin", ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }
  expect(spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env }).stdout).toBe("off")
  expect(Bun.spawnSync([process.execPath, "-e", script], { env }).stdout.toString()).toBe("off")
  expect(process.env.KUVO_TEST_PRICE_FEEDS).toBe("off")
})
