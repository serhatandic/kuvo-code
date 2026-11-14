import "./safety"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
 * ~/Library: it guards more of it than it says) by that name is noted in `noted`, and doesn't reach the
 * system. This checkout is its own, wherever it is. The box also reads your SSH and GitHub settings in
 * your real home, which may link to or name a guarded folder: those it finds empty here. */
function guard(root: string): { preload: string; noted: string } {
  const preload = join(root, "note-opens.cjs")
  const noted = join(root, "opened")
  writeFileSync(noted, "")
  // (But for listing your Keychain's folder, to wall off the system's keychains in it: macOS doesn't guard that.)
  const names = "Desktop|Documents|Downloads|Pictures|Movies|Music|Library(?!/Keychains$)"
  const checkout = join(import.meta.dir, "..", "..")
  const yours = `^${accountHome()}/(\\.ssh|\\.config/gh)(/|$)`
  writeFileSync(preload, `
const fs = require("fs")
const empty = where => typeof where === "string" && new RegExp(${JSON.stringify(yours)}).test(where)
const guarded = where => typeof where === "string" && !where.startsWith(${JSON.stringify(checkout + "/")}) && new RegExp(${JSON.stringify(`^${accountHome()}/(${names})(/|$)`)}, "i").test(where)
const stop = (name, where) => {
  fs.appendFileSync(${JSON.stringify(noted)}, name + " " + where + "\\n")
  return Object.assign(new Error("ENOENT: " + where), { code: "ENOENT" })
}
const wrap = (on, name, label) => {
  const real = on[name]
  on[name] = Object.assign(function (where, ...rest) {
    if (guarded(where)) throw stop(label + name, where)
    if (empty(where)) throw Object.assign(new Error("ENOENT: " + where), { code: "ENOENT" })
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
    // And its rule reached the launcher, named for the project as the launcher names it.
    const sum = createHash("sha256").update(project).digest("hex").slice(0, 32)
    expect(existsSync(join(kuvo, "run", "fence", "allowed", sum))).toBe(true)
  } finally {
    box.kill(9)
    await box.exited
  }
}, 30_000)

// What macOS does for a folder it asks about, as far as the box sees it: one opened before you've
// answered holds whoever opened it (here two seconds, noted), one asked about off the box's thread
// (fs.promises) is answered a moment later, and from then on it opens at once. Those in `places`
// stand in for such folders, by names under /Volumes (other drives, which macOS asks about), each
// with a real folder of the test's behind it; one named `held` is never answered. A link that leads
// there counts as there, as it does for macOS; only asking about names (`lstat`) never waits.
function asking(root: string, places: Record<string, string>, held: string): { preload: string; noted: string } {
  const preload = join(root, "model-macos.cjs")
  const noted = join(root, "held")
  writeFileSync(noted, "")
  const yours = `^${accountHome()}/(\\.ssh|\\.config/gh)(/|$)`
  writeFileSync(preload, `
const fs = require("fs")
const path = require("path")
const PLACES = ${JSON.stringify(places)}
const HELD = ${JSON.stringify(held)}
const answered = new Set()
const lstat = fs.lstatSync, readlink = fs.readlinkSync, append = fs.appendFileSync
const placeOf = where => [...Object.keys(PLACES), HELD].find(place => where === place || where.startsWith(place + "/"))
// Where a path leads through its links, asking about names only.
function leads(where) {
  let at = "/", rest = path.resolve(String(where)).split("/").filter(Boolean)
  for (let links = 0; rest.length && links < 40;) {
    const name = rest.shift()
    if (name === ".") continue
    if (name === "..") { at = path.dirname(at); continue }
    const next = path.join(at, name)
    if (placeOf(next)) return path.join(next, ...rest)
    let link
    try { link = lstat(next).isSymbolicLink() ? readlink(next) : undefined } catch { return path.join(next, ...rest) }
    if (link === undefined) { at = next; continue }
    links++
    if (link.startsWith("/")) at = "/"
    rest = [...link.split("/").filter(Boolean), ...rest]
  }
  return at
}
const error = (code, where) => Object.assign(new Error(code + ": " + where), { code })
const empty = where => typeof where === "string" && new RegExp(${JSON.stringify(yours)}).test(where)
const pause = new Int32Array(new SharedArrayBuffer(4))
// Its answer once it's in: the real folder behind it (a path inside it for realpath).
function opened(name, real, where, rest) {
  const to = leads(where), place = placeOf(to)
  if (place === HELD || !answered.has(place)) {
    append(${JSON.stringify(noted)}, name + " " + where + "\\n")
    Atomics.wait(pause, 0, 0, 2000)
    throw error("EPERM", where)
  }
  const behind = PLACES[place] + to.slice(place.length)
  if (name.startsWith("realpath")) { lstat(behind); return to }
  return real(behind, ...rest)
}
const wrapSync = (on, name, label) => {
  const real = on[name]
  on[name] = Object.assign(function (where, ...rest) {
    if (empty(where)) throw error("ENOENT", where)
    if (typeof where !== "string" || !placeOf(leads(where))) return real.call(this, where, ...rest)
    return opened(label + name, real.bind(this), where, rest)
  }, real)
}
const wrapAsync = (on, name, sync) => {
  const real = on[name]
  on[name] = Object.assign(function (where, ...rest) {
    if (empty(where)) return Promise.reject(error("ENOENT", where))
    const place = typeof where === "string" ? placeOf(leads(where)) : undefined
    if (!place) return real.call(this, where, ...rest)
    if (place === HELD) return new Promise(() => {})
    return new Promise(resolve => setTimeout(resolve, 30)).then(() => {
      answered.add(place)
      return opened(name, sync, where, rest)
    })
  }, real)
}
const sync = { readFile: fs.readFileSync, readdir: fs.readdirSync, realpath: fs.realpathSync }
for (const name of ["openSync", "readFileSync", "readdirSync", "opendirSync", "watch"]) wrapSync(fs, name, "")
wrapSync(fs.realpathSync, "native", "realpathSync.")
wrapSync(fs, "realpathSync", "")
for (const name of ["readFile", "readdir", "realpath"]) wrapAsync(fs.promises, name, sync[name])
for (const name of ["open", "opendir"]) wrapAsync(fs.promises, name, () => { throw error("EPERM", "unmodelled") })
`)
  return { preload, noted }
}

test.skipIf(process.platform !== "darwin")("your SSH and GitHub settings linked into a folder macOS asks about are read off the box's thread, and the walls take them in once they're read", async () => {
  const root = scratch()
  const home = join(root, "home")
  const id = root.split("-").at(-1)
  const place = `/Volumes/kuvo-asks-${id}`
  const behind = join(root, "behind")
  mkdirSync(join(behind, "dotfiles"), { recursive: true })
  writeFileSync(join(behind, "dotfiles", "ssh_config"), "Host *\n  ControlPath ~/.ssh/cm/%C\n")
  writeFileSync(join(behind, "dotfiles", "hosts.yml"), "github.com:\n  user: me\n")
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(join(home, ".config", "gh"), { recursive: true })
  symlinkSync(join(place, "dotfiles", "ssh_config"), join(home, ".ssh", "config"))
  symlinkSync(join(place, "dotfiles"), join(home, ".ssh", "config.d"))
  symlinkSync(join(place, "dotfiles", "hosts.yml"), join(home, ".config", "gh", "hosts.yml"))
  // And a personal folder linked to one that isn't there (yet): only its name is asked about.
  symlinkSync(join(place, "gone"), join(home, "Documents"))
  const { preload, noted } = asking(root, { [place]: behind }, `/Volumes/kuvo-asks-held-${id}`)
  const script = join(root, "policy.ts")
  writeFileSync(script, `
import * as policy from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy.ts"))}
const started = performance.now()
const first = policy.fencePolicy()
const took = performance.now() - started
await policy.readsLate?.()
const second = policy.fencePolicy()
console.log(JSON.stringify({ took, first, second }))
`)
  const ran = Bun.spawnSync([process.execPath, "--preload", preload, script], { env: { ...environment(home), KUVO_HOME: join(root, "kuvo") }, cwd: root })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  const { took, first, second } = JSON.parse(ran.stdout.toString()) as { took: number; first: FencePolicy; second: FencePolicy }
  expect(await Bun.file(noted).text()).toBe("")
  expect(took).toBeLessThan(1500)
  const hosts = join(home, ".config", "gh", "hosts.yml")
  const sockets = join(home, ".ssh", "cm")
  // Until they're read, gh's sign-in is hidden, as it may hold the token; then as it says.
  expect(first.secrets).toContain(hosts)
  expect(first.sockets).not.toContain(sockets)
  expect(second.secrets).not.toContain(hosts)
  expect(second.sockets).toContain(sockets)
  expect(second.personal).toContain(join(home, "Documents"))
}, 30_000)

test.skipIf(process.platform !== "darwin")("a project in a folder macOS asks about is checked off the box's thread: only the request that needs your answer waits for it", async () => {
  const root = scratch()
  const home = join(root, "home")
  mkdirSync(home, { recursive: true })
  const id = root.split("-").at(-1)
  const place = `/Volumes/kuvo-asks-${id}`
  const held = `/Volumes/kuvo-asks-held-${id}`
  const behind = join(root, "behind")
  for (const folder of ["shop", "shop-data", "blog"]) mkdirSync(join(behind, folder), { recursive: true })
  // (And another such folder, with a script in it.)
  const tools = `/Volumes/kuvo-asks-tools-${id}`
  mkdirSync(join(root, "tools"))
  writeFileSync(join(root, "tools", "build.sh"), "echo built\n")
  const { preload, noted } = asking(root, { [place]: behind, [tools]: join(root, "tools") }, held)
  const script = join(root, "rules.ts")
  writeFileSync(script, `
import { addRule, allowedFor, listed } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "allowed.ts"))}
import { keptFromSessions, review } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "work", "reviewer.ts"))}
const said: Record<string, unknown> = {}
// One nobody answers about: it waits, and the box goes on meanwhile.
let ticks = 0
const ticking = setInterval(() => ticks++, 20)
let settled = false
Promise.resolve(addRule({ project: ${JSON.stringify(held + "/blog")}, kind: "write", path: ${JSON.stringify(held + "/blog-data")} })).finally(() => { settled = true })
await new Promise(resolve => setTimeout(resolve, 400))
said.heldSettled = settled
said.ticked = ticks >= 10
clearInterval(ticking)
const rule = await addRule({ project: ${JSON.stringify(place + "/shop")}, kind: "write", path: ${JSON.stringify(place + "/shop-data")} })
said.rule = { project: rule.project, path: rule.path }
said.listed = (await listed(await allowedFor(${JSON.stringify(place + "/shop")}))).map(each => each.owner)
said.kept = await keptFromSessions(${JSON.stringify(place + "/blog")})
// Auto's reviewer, on a command that runs a script there, from a project elsewhere.
const judged = await review({ kind: "command", command: "bash " + ${JSON.stringify(tools + "/build.sh")}, folder: ${JSON.stringify(root)} },
  { session: "ses_auto", said: [] }, { model: async () => { throw new Error("no model here") } })
said.judged = judged.decision
console.log(JSON.stringify(said))
process.exit(0)
`)
  const ran = Bun.spawnSync([process.execPath, "--preload", preload, script], { env: { ...environment(home), KUVO_HOME: join(root, "kuvo") }, cwd: root })
  expect(ran.exitCode, ran.stderr.toString()).toBe(0)
  expect(JSON.parse(ran.stdout.toString())).toEqual({
    heldSettled: false, ticked: true,
    rule: { project: `${place}/shop`, path: `${place}/shop-data` },
    listed: [{ kind: "project", name: "shop" }],
    kept: null, judged: "refuse",
  })
  expect(await Bun.file(noted).text()).toBe("")
}, 30_000)
