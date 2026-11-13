import "./safety"
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRIDGE_VERSION } from "../src/link/version"
import { askRehome, rehomeReady } from "../src/link/rehome/move"
import { rehomeStatus } from "../src/link/rehome/state"

// Moving this Mac's box out of its app's folder into a home of its own (#333 piece 2a,
// `kuvo-link.js rehome`), run as the keeper runs it: a process of its own, in a home folder of the
// test's own, the app's folder laid out as the app lays it out. A crash at each step (killed, as a
// power cut would), then `--resume`: before the old place is cleared it ends exactly as before;
// from then on, exactly as a clean move.
const mac = process.platform === "darwin"
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-rehome-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const MAIN = join(import.meta.dir, "..", "src", "link", "main.ts")
const APP_VERSION = "9.9.9"
const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("KUVO_"))) as Record<string, string>

interface World { home: string; S: string; K: string; release: string }

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}

/** A Mac whose app's box ran in its folder (`S`, as the app's tests name it), with nothing in its
 * `~/.kuvo-code` yet but what `given` puts there. */
let worlds = 0
function world(given: (w: World) => void = () => {}): World {
  const home = join(root, `w${worlds++}`)
  const S = join(home, "Support")
  const w = { home, S, K: join(home, ".kuvo-code"), release: join(home, "release") }
  mkdirSync(join(home, "tmp"), { recursive: true })
  // The box's own folder.
  put(join(S, "box", "run", "setup-card.json"), JSON.stringify({ self: { key: "k", name: "Mac", kind: "mac" }, app: true }))
  put(join(S, "box", "run", "link.json"), "{\"name\":\"Mac\"}")
  put(join(S, "box", "run", "mac-link.json"), "{\"on\":true}")
  put(join(S, "box", "run", "engine.json"), "{\"pid\":999999,\"port\":1}")
  put(join(S, "box", "run", "serve.json"), "{\"pid\":999998}")
  put(join(S, "box", "run", "keeper.json"), "{}")
  put(join(S, "box", "run", "socket.key"), "0".repeat(64))
  put(join(S, "box", "run", "served.json"), JSON.stringify({ app: APP_VERSION, bridge: BRIDGE_VERSION, at: 1 }))
  put(join(S, "box", "run", "fence", "agents.md"), "the sandbox")
  put(join(S, "box", "box", "projects.json"), "[{\"name\":\"p\"}]")
  put(join(S, "box", "box", "work.json"), "{\"projectsFolder\":null}")
  symlinkSync("projects.json", join(S, "box", "box", "projects-link"))
  put(join(S, "box", "machines.json"), "[]")
  put(join(S, "box", "artifacts", "a1.json"), "{}")
  put(join(S, "box", "trash", "t1", "f"), "trashed")
  put(join(S, "box", "updates", "rollback", "restore.sh"), "#!/bin/sh\n")
  put(join(S, "box", "attachments", "ses_1", "a.png"), "box's a")
  put(join(S, "box", "bin", "mcp-catalog.json"), "{}")
  // Beside it, the app's.
  put(join(S, "opencode", "data", "opencode", "opencode.db"), "the database")
  put(join(S, "opencode", "data", "opencode", "snapshot", "s1"), "snapshot")
  put(join(S, "opencode", "config", "opencode", "opencode.json"), "{}")
  put(join(S, "opencode", "state", "x"), "state")
  put(join(S, "opencode", "cache", "x"), "cache")
  mkdirSync(join(S, "opencode", "workspace"), { recursive: true })
  put(join(S, "engine", "2.2.6", "opencode"), "engine")
  put(join(S, "integrations", "notion", "x"), "sign-in")
  put(join(S, "bots", "b1", "opencode.json"), "{}")
  put(join(S, "wakes", "ses_1", "directory"), "/somewhere")
  put(join(S, "groups", "g1", "chat.json"), "{}")
  put(join(S, "Chats", "c1", "notes.md"), "chat")
  put(join(S, "Attachments", "ses_1", "b.png"), "app's b")
  put(join(S, "Attachments", "ses_1", "a.png"), "app's a, the same name")
  put(join(S, "Attachments", "ses_2", "c.png"), "app's c")
  put(join(S, "agents", "store.json"), "{}")
  put(join(S, "phone-link.json"), "{\"machines\":[]}")
  // The app's own, which stays.
  put(join(S, "Browser", "x"), "browser")
  put(join(S, "bots.json"), "[]")
  // The box's own files, as the app brings them.
  put(join(w.release, "bin", "kuvo-start"), "#!/bin/sh\n")
  put(join(w.release, "bin", "kuvo-link.js"), "// the link")
  given(w)
  return w
}

interface Ran { status: number | null; signal: string | null; said: Record<string, any> | null; errors: string }

function rehome(w: World, args: string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [MAIN, "rehome", ".kuvo-code", ...args], {
    cwd: w.home, encoding: "utf8", timeout: 60_000,
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(w.S, "box"), KUVO_APP_VERSION: APP_VERSION, ...env },
  })
  const line = result.stdout.trim().split("\n").pop() ?? ""
  let said = null
  try { said = JSON.parse(line) } catch {}
  return { status: result.status, signal: result.signal, said, errors: result.stderr }
}
const move = (w: World, env: Record<string, string> = {}, more: string[] = []) => rehome(w, ["--release", w.release, ...more], env)

/** What `here` says on this Mac, as the app asks it. */
function here(w: World): Record<string, any> {
  const result = spawnSync(process.execPath, [MAIN, "here", ".kuvo-code"], {
    cwd: w.home, encoding: "utf8", timeout: 60_000,
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(w.S, "box"), KUVO_ENGINE_DATA: join(w.S, "opencode", "data", "opencode") },
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout.trim().split("\n").pop()!)
}

/** Every file and folder in `folder`: its kind, mode and what it holds (a link's target). */
function snapshot(folder: string, leave: (relative: string) => boolean = () => false): Record<string, string> {
  const seen: Record<string, string> = {}
  const walk = (at: string, relative: string) => {
    for (const name of readdirSync(at).sort()) {
      const file = join(at, name), here = relative ? `${relative}/${name}` : name
      if (leave(here)) continue
      const kind = lstatSync(file)
      const mode = (kind.mode & 0o777).toString(8)
      if (kind.isSymbolicLink()) seen[here] = `link ${readlinkSync(file)}`
      else if (kind.isDirectory()) { seen[here] = `folder ${mode}`; walk(file, here) }
      else if (kind.isFile()) seen[here] = `file ${mode} ${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)}`
      else seen[here] = "other"
    }
  }
  if (existsSync(folder)) walk(folder, "")
  return seen
}
// (The move's own folder, apart.)
const boxOnly = (relative: string) => relative === "updates/rehome"

const POINTS_BACK = ["after-plan", "after-install", "after-clone", "after-rewrite", "after-check", "in-place", "in-merge", "after-place", "after-fix"]
const POINTS_FORWARD = ["in-clear", "after-clear"]

// A clean move, to hold the others to.
let cleanMove: { K: Record<string, string>; S: Record<string, string> } | null = null
function cleanResult() {
  if (cleanMove) return cleanMove
  const w = world()
  const moved = move(w)
  expect(moved.status, moved.errors).toBe(0)
  cleanMove = { K: snapshot(w.K, boxOnly), S: snapshot(w.S) }
  return cleanMove
}

test.if(mac)("the move puts this Mac's box in a home of its own, laid out as a machine's, and clears the app's folder of it", () => {
  const w = world()
  expect(here(w)).toMatchObject({ use: "own" })
  const moved = move(w, {}, ["--keeps-awake", "off"])
  expect(moved.status, moved.errors).toBe(0)
  expect(moved.said).toMatchObject({ result: "done", status: { state: "done", way: "move", owed: ["keychain", "agent"], tries: 0, failed: null } })
  const { K } = w
  const read = (file: string) => readFileSync(join(K, file), "utf8")
  // Its kind, a Mac's; Keep This Mac Awake off as the app had it.
  expect(read("box/kind")).toBe("mac\n")
  expect(JSON.parse(read("box/work.json"))).toEqual({ projectsFolder: null, keepsAwake: false })
  expect(readlinkSync(join(K, "box", "projects-link"))).toBe("projects.json")
  // The box's own, by the same names; what's beside it, where a machine keeps it.
  expect(read("machines.json")).toBe("[]")
  expect(read("updates/rollback/restore.sh")).toBe("#!/bin/sh\n")
  expect(read("data/opencode/opencode.db")).toBe("the database")
  expect(read("config/opencode/opencode.json")).toBe("{}")
  expect(read("engine/2.2.6/opencode")).toBe("engine")
  expect(read("chats/c1/notes.md")).toBe("chat")
  expect(read("phone-link.json")).toBe("{\"machines\":[]}")
  for (const each of ["state/x", "cache/x", "integrations/notion/x", "bots/b1/opencode.json", "wakes/ses_1/directory", "groups/g1/chat.json", "agents/store.json"]) expect(existsSync(join(K, each))).toBe(true)
  // Both folders of sent files, merged: a name in both keeps both.
  expect(snapshot(join(K, "attachments"))).toMatchObject({ "ses_1/a.png": expect.any(String), "ses_1/a 2.png": expect.any(String), "ses_1/b.png": expect.any(String), "ses_2/c.png": expect.any(String) })
  expect(read("attachments/ses_1/a.png")).toBe("box's a")
  expect(read("attachments/ses_1/a 2.png")).toBe("app's a, the same name")
  // Its run state, not its processes' records; its files from its release, not the app's bin.
  expect(readdirSync(join(K, "run")).sort()).toEqual(["fence", "link.json", "mac-link.json", "setup-card.json"])
  expect(readdirSync(join(K, "bin")).sort()).toEqual(["kuvo-link.js", "kuvo-start"])
  // The app's folder keeps only what's the app's; the originals are kept, for 30 days.
  expect(readdirSync(w.S).sort()).toEqual(["Browser", "bots.json"])
  const kept = moved.said!.status
  expect(kept.keptUntil - kept.movedAt).toBe(30 * 86_400_000)
  const keptFolder = join(K, "updates", "rehome", "kept")
  const [stamp] = readdirSync(keptFolder)
  expect(readdirSync(join(keptFolder, stamp)).sort()).toEqual(["Attachments", "Chats", "agents", "bots", "box", "engine", "groups", "integrations", "opencode", "phone-link.json", "wakes"])
  expect(readFileSync(join(keptFolder, stamp, "box", "run", "engine.json"), "utf8")).toContain("999999")
  // Nothing left of the move but its state.
  expect(readdirSync(join(K, "updates", "rehome")).sort()).toEqual(["journal.acts", "journal.json", "kept", "state.json"])
  // And Kuvo Code, opening now, attaches to it in place.
  expect(here(w)).toMatchObject({ use: "attach" })
}, 60_000)

for (const point of POINTS_BACK) {
  test.if(mac)(`stopped at ${point}, it goes back: the app's folder as it was, nothing new in ~/.kuvo-code`, () => {
    const w = world()
    const before = snapshot(w.S)
    const stopped = move(w, { KUVO_TEST_REHOME_STOP: point })
    expect(stopped.signal).toBe("SIGKILL")
    // Until it's finished, neither the app nor its keeper starts a box.
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
    // (It didn't move: the keeper starts the old box again, as it was.)
    const resumed = rehome(w, ["--resume"])
    expect(resumed.status, resumed.errors).toBe(1)
    expect(resumed.said).toMatchObject({ result: "failed", status: { state: "failed", tries: 1, failed: { step: expect.any(String) } } })
    expect(snapshot(w.S)).toEqual(before)
    expect(readdirSync(w.K)).toEqual(["updates"])
    expect(readdirSync(join(w.K, "updates", "rehome"))).toEqual(["state.json"])
    expect(here(w)).toMatchObject({ use: "own" })
    // Twice in a row: the second finds nothing to finish.
    expect(rehome(w, ["--resume"]).said).toMatchObject({ result: "nothing" })
  }, 60_000)
}

for (const point of POINTS_FORWARD) {
  test.if(mac)(`stopped at ${point}, it goes forward: as a clean move ends`, () => {
    const w = world()
    const stopped = move(w, { KUVO_TEST_REHOME_STOP: point })
    expect(stopped.signal).toBe("SIGKILL")
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
    const resumed = rehome(w, ["--resume"])
    expect(resumed.status, resumed.errors).toBe(0)
    expect(resumed.said).toMatchObject({ result: "done", status: { state: "done" } })
    const ideal = cleanResult()
    expect(snapshot(w.K, boxOnly)).toEqual(ideal.K)
    expect(snapshot(w.S)).toEqual(ideal.S)
    expect(here(w)).toMatchObject({ use: "attach" })
    expect(rehome(w, ["--resume"]).said).toMatchObject({ result: "nothing" })
  }, 60_000)
}

test.if(mac)("a box its Mac removed from ~/.kuvo-code is set aside first, and put back where the move goes back", () => {
  const gone = (w: World) => {
    put(join(w.K, "run", "off"), "")
    put(join(w.K, "run", "link.json"), "{\"name\":\"Old\"}")
    put(join(w.K, "updates", "rollback", "old"), "old")
    put(join(w.K, "trash", "old-one"), "old trash")
  }
  const back = world(gone)
  const before = { S: snapshot(back.S), K: snapshot(back.K) }
  const stoppedBack = move(back, { KUVO_TEST_REHOME_STOP: "after-place" })
  expect(stoppedBack.signal, JSON.stringify(stoppedBack.said)).toBe("SIGKILL")
  rehome(back, ["--resume"])
  expect(snapshot(back.S)).toEqual(before.S)
  expect(snapshot(back.K, boxOnly)).toEqual(before.K)

  const w = world(gone)
  expect(move(w).status).toBe(0)
  const [aside] = readdirSync(join(w.K, "trash")).filter(name => name.startsWith("earlier-box-"))
  expect(readFileSync(join(w.K, "trash", aside, "run", "link.json"), "utf8")).toContain("Old")
  expect(readFileSync(join(w.K, "trash", aside, "updates", "rollback", "old"), "utf8")).toBe("old")
  expect(readFileSync(join(w.K, "trash", aside, "trash", "old-one"), "utf8")).toBe("old trash")
  // (And the moved box's own trash beside it.)
  expect(existsSync(join(w.K, "trash", "t1", "f"))).toBe(true)
}, 60_000)

test.if(mac)("a second resume waits for the lock the first holds, then finishes the move itself: back, as it stopped before clearing", async () => {
  const w = world()
  expect(move(w, { KUVO_TEST_REHOME_STOP: "in-place" }).signal).toBe("SIGKILL")
  // One holds the lock (a resume, by its command line), as a keeper's would.
  const holder = Bun.spawn(["/bin/sh", "-c", "read line", "rehome"], { stdin: "pipe" })
  writeFileSync(join(w.K, "updates", "rehome", "lock", "pid"), String(holder.pid))
  const second = Bun.spawn([process.execPath, MAIN, "rehome", ".kuvo-code", "--resume"], {
    cwd: w.home, stdout: "pipe", stderr: "pipe",
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(w.S, "box") },
  })
  // It says it waits, and does nothing meanwhile.
  const reader = second.stderr.getReader()
  let said = ""
  while (!said.includes("waits for it")) {
    const { value, done } = await reader.read()
    if (done) break
    said += new TextDecoder().decode(value)
  }
  expect(said).toContain("waits for it")
  expect(existsSync(join(w.K, "updates", "rehome", "journal.json"))).toBe(true)
  holder.stdin.end()
  await holder.exited
  expect(await second.exited).toBe(1)
  expect(JSON.parse((await new Response(second.stdout).text()).trim())).toMatchObject({ result: "failed", status: { state: "failed" } })
  expect(readdirSync(w.K)).toEqual(["updates"])
}, 60_000)

test.if(mac)("a move back brings the box back into the app's folder as it is now, sessions made since too", async () => {
  const w = world()
  const before = snapshot(w.S)
  expect(move(w).status).toBe(0)
  // Used in its home meanwhile.
  put(join(w.K, "data", "opencode", "since"), "a session made since")
  put(join(w.K, "attachments", "ses_3", "d.png"), "sent since")
  put(join(w.K, "run", "box.pid"), "999997")
  const back = rehome(w, ["--back"])
  expect(back.status, JSON.stringify(back.said) + back.errors).toBe(0)
  expect(back.said).toMatchObject({ result: "back", status: { state: "back", way: "back", owed: ["keychain", "agent"] } })
  // As it was (its processes' records and the app's own bin aside, which the app makes anew as it
  // starts its box), with what was made since where it belongs; never its kind.
  const made = (relative: string) => /^box\/run\/(engine\.json|serve\.json|served\.json|keeper\.json|socket\.key)$/.test(relative) || relative.startsWith("box/bin")
  const now = snapshot(w.S)
  expect(Object.fromEntries(Object.entries(before).filter(([file]) => !made(file)))).toEqual(Object.fromEntries(Object.entries(now).filter(([file]) =>
    !["opencode/data/opencode/since", "box/attachments/ses_3", "box/attachments/ses_3/d.png", "box/run/box.pid"].includes(file))))
  expect(readFileSync(join(w.S, "opencode", "data", "opencode", "since"), "utf8")).toBe("a session made since")
  expect(readFileSync(join(w.S, "box", "attachments", "ses_3", "d.png"), "utf8")).toBe("sent since")
  expect(existsSync(join(w.S, "box", "box", "kind"))).toBe(false)
  // ~/.kuvo-code holds no box any more (its files kept, for support), and the app uses its own.
  expect(readdirSync(w.K)).toEqual(["updates"])
  expect(readdirSync(join(w.K, "updates"))).toEqual(["rehome"])
  expect(here(w)).toMatchObject({ use: "own", verdict: "free" })
  // It moves again only on Move Now: never by itself, undoing your Move Back.
  put(join(w.S, "box", "run", "served.json"), JSON.stringify({ app: APP_VERSION, bridge: BRIDGE_VERSION, at: 2 }))
  expect(await rehomeReady(w.K, w.S, { busy: async () => false })).toMatchObject({ ready: false, why: "It was moved back: it moves again only on Move Now." })
  expect(askRehome(w.K, "now")).toBeNull()
  expect(await rehomeReady(w.K, w.S, { busy: async () => false })).toMatchObject({ ready: true, how: "move" })
  expect(move(w).said).toMatchObject({ result: "done" })
}, 60_000)

test.if(mac)("it refuses while something runs in the box, before the box started since an update, and without room", async () => {
  const runs = world()
  const engine = Bun.spawn(["/bin/sh", "-c", "read line", "opencode"], { stdin: "pipe" })
  try {
    put(join(runs.S, "box", "run", "engine.json"), JSON.stringify({ pid: engine.pid, port: 1 }))
    const before = snapshot(runs.S)
    const refused = move(runs)
    expect(refused.status).toBe(1)
    expect(refused.said).toMatchObject({ result: "refused", status: { state: "failed", tries: 1 } })
    expect(refused.said!.message).toContain("Something is running in this Mac's box")
    expect(snapshot(runs.S)).toEqual(before)
    expect(readdirSync(join(runs.K, "updates", "rehome"))).toEqual(["state.json"])
  } finally {
    engine.stdin.end()
    await engine.exited
  }

  const updated = world(w => put(join(w.S, "box", "run", "served.json"), JSON.stringify({ app: "9.9.8", bridge: BRIDGE_VERSION, at: 1 })))
  expect(move(updated).said!.message).toBe("This Mac's box hasn't started since Kuvo Code updated: it moves once it has.")
  const never = world(w => rmSync(join(w.S, "box", "run", "served.json")))
  expect(move(never).said!.message).toBe("This Mac's box hasn't started since Kuvo Code updated: it moves once it has.")

  const full = world()
  const refused = move(full, { KUVO_TEST_REHOME_FREE: "1000" })
  expect(refused.said!.message).toContain("There isn't room to move this Mac's box")
  expect(readdirSync(full.S)).toContain("box")

  const live = world(w => {
    put(join(w.K, "run", "setup-card.json"), JSON.stringify({ self: { key: "m", name: "Mini", kind: "machine" } }))
    put(join(w.K, "bin", "kuvo-start"), "")
  })
  expect(move(live).said!.message).toBe("There's a box in this Mac's ~/.kuvo-code already: both keep running as they are.")
  expect(existsSync(join(live.K, "bin", "kuvo-start"))).toBe(true)
}, 60_000)

test.if(mac)("it waits for a quiet moment, three tries, three days, or Move Now", async () => {
  const w = world()
  const appFolder = w.S
  const t = 1_800_000_000_000
  // Something works: not now, waiting since then; three days on, overdue.
  expect(await rehomeReady(w.K, appFolder, { now: t, busy: async () => true })).toMatchObject({ ready: false, why: "It moves when nothing's running." })
  expect(rehomeStatus(w.K, t + 3 * 86_400_000 - 1)).toMatchObject({ state: "waiting", waitingSince: t, overdue: false })
  expect(rehomeStatus(w.K, t + 3 * 86_400_000)).toMatchObject({ overdue: true })
  expect(await rehomeReady(w.K, appFolder, { now: t + 1, busy: async () => false })).toMatchObject({ ready: true, how: "move" })
  // Three that failed: it waits for Move Now, asked by Kuvo Code on this Mac.
  for (let i = 0; i < 3; i++) move(w, { KUVO_TEST_REHOME_FREE: "1000" })
  const status = rehomeStatus(w.K)
  expect(status).toMatchObject({ state: "failed", tries: 3, failed: { step: "plan" } })
  expect(await rehomeReady(w.K, appFolder, { now: status.nextTry! + 1, busy: async () => false })).toMatchObject({ ready: false, why: "It didn't move after three tries: it waits for Move Now." })
  const asked = spawnSync(process.execPath, [MAIN, "box", "route"], {
    cwd: w.home, encoding: "utf8", timeout: 60_000, input: JSON.stringify({ method: "POST", path: "kuvo/box/rehome", body: { now: true } }),
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(w.S, "box"), KUVO_BOX: "mac",
      KUVO_ENGINE_CONFIG: join(w.S, "opencode", "config"), KUVO_MACHINE_ROOT: ".kuvo-code" },
  })
  const answer = JSON.parse(asked.stdout.trim().split("\n").pop()!)
  expect(answer.status, asked.stderr).toBe(200)
  expect(JSON.parse(answer.body)).toMatchObject({ asked: "now", tries: 3 })
  expect(await rehomeReady(w.K, appFolder, { now: status.nextTry! + 1, busy: async () => true })).toMatchObject({ ready: true, how: "move" })
  // Done, Move Now's ask goes with it; the box in its home says so itself.
  expect(move(w).said).toMatchObject({ result: "done", status: { asked: null, tries: 0 } })
  const read = spawnSync(process.execPath, [MAIN, "box", "route"], {
    cwd: w.home, encoding: "utf8", timeout: 60_000, input: JSON.stringify({ method: "GET", path: "kuvo/box/rehome" }),
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: w.K },
  })
  expect(JSON.parse(JSON.parse(read.stdout.trim().split("\n").pop()!).body)).toMatchObject({ state: "done", way: "move" })
}, 60_000)

test.if(!mac)("a machine's box is in its home already: rehome refuses, saying so", () => {
  const home = join(root, "machine")
  mkdirSync(join(home, ".kuvo-code"), { recursive: true })
  const run = (args: string[]) => spawnSync(process.execPath, [MAIN, "rehome", ".kuvo-code", ...args], {
    cwd: home, encoding: "utf8", timeout: 60_000,
    env: { ...clean, HOME: home, TMPDIR: tmpdir(), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(home, ".kuvo-code") },
  })
  for (const args of [[], ["--back"]]) {
    const refused = run(args)
    expect(refused.status).toBe(1)
    expect(JSON.parse(refused.stdout.trim())).toMatchObject({ result: "refused", message: "This machine's box is in its own home already: there's nothing to move." })
  }
  expect(JSON.parse(run(["--ready"]).stdout.trim())).toMatchObject({ ready: false, why: "This machine's box is in its own home already: there's nothing to move." })
  expect(readdirSync(join(home, ".kuvo-code"))).toEqual([])
}, 60_000)

test.if(mac)("a move back that stops part way goes back to the box moved, or on to the box back, as a move does", () => {
  for (const [point, ends] of [["in-place", "moved"], ["in-merge", "moved"], ["in-clear", "back"]] as const) {
    const w = world()
    expect(move(w).status).toBe(0)
    // (The app made one of its files again meanwhile: what goes back merges with it.)
    put(join(w.S, "box", "machines.json"), "[\"the app's\"]")
    const moved = { K: snapshot(w.K, boxOnly), S: snapshot(w.S) }
    const stopped = rehome(w, ["--back"], { KUVO_TEST_REHOME_STOP: point })
    expect(stopped.signal, `${point}: ${JSON.stringify(stopped.said)}`).toBe("SIGKILL")
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
    const resumed = rehome(w, ["--resume"])
    if (ends === "moved") {
      expect(resumed.said).toMatchObject({ result: "failed", status: { state: "done", way: "move", failed: { step: "place" } } })
      expect(snapshot(w.K, boxOnly)).toEqual(moved.K)
      expect(snapshot(w.S)).toEqual(moved.S)
    } else {
      expect(resumed.said).toMatchObject({ result: "back", status: { state: "back" } })
      expect(readdirSync(w.K)).toEqual(["updates"])
      // The box's own list keeps its name; the one the app made meanwhile is kept beside it.
      expect(readFileSync(join(w.S, "box", "machines.json"), "utf8")).toBe("[]")
      expect(readFileSync(join(w.S, "box", "machines 2.json"), "utf8")).toBe("[\"the app's\"]")
      expect(here(w)).toMatchObject({ use: "own" })
    }
  }
}, 60_000)

test.if(mac)("going back, stopped part way itself, goes back again from the start: the app's folder as it was", () => {
  const w = world()
  const before = snapshot(w.S)
  expect(move(w, { KUVO_TEST_REHOME_STOP: "after-place" }).signal).toBe("SIGKILL")
  expect(rehome(w, ["--resume"], { KUVO_TEST_REHOME_STOP: "in-undo" }).signal).toBe("SIGKILL")
  expect(here(w)).toMatchObject({ verdict: "moving" })
  expect(rehome(w, ["--resume"]).said).toMatchObject({ result: "failed", status: { state: "failed", tries: 1 } })
  expect(snapshot(w.S)).toEqual(before)
  expect(readdirSync(w.K)).toEqual(["updates"])
}, 60_000)

test.if(mac)("a move that can't finish clearing says it's stuck, starts nothing, and carries on once it can", () => {
  const w = world()
  // (Where it keeps the originals can't be written.)
  mkdirSync(join(w.K, "updates", "rehome", "kept"), { recursive: true, mode: 0o700 })
  chmodSync(join(w.K, "updates", "rehome", "kept"), 0o500)
  const stuck = move(w)
  expect(stuck.status).toBe(3)
  expect(stuck.said).toMatchObject({ result: "stuck", status: { state: "clearing", step: "clear", failed: { step: "clear" } } })
  expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
  chmodSync(join(w.K, "updates", "rehome", "kept"), 0o700)
  const resumed = rehome(w, ["--resume"])
  expect(resumed.status).toBe(0)
  expect(resumed.said).toMatchObject({ result: "done" })
  expect(snapshot(w.K, boxOnly)).toEqual(cleanResult().K)
}, 60_000)

test.if(mac)("a journal that can't be read is a move under way that no one finishes by guessing", async () => {
  const w = world()
  put(join(w.K, "updates", "rehome", "journal.json"), "")
  expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
  const resumed = rehome(w, ["--resume"])
  expect([resumed.status, resumed.said?.result]).toEqual([3, "stuck"])
  expect(move(w).said).toMatchObject({ result: "stuck" })
  expect(await rehomeReady(w.K, w.S, { busy: async () => false })).toMatchObject({ ready: false })
  expect(readdirSync(w.S)).toContain("box")
}, 60_000)

test.if(mac)("it's ready with the box running, as the keeper asks before it stops it: the box's running is the keeper's to stop", async () => {
  const w = world()
  const engine = Bun.spawn(["/bin/sh", "-c", "read line", "opencode"], { stdin: "pipe" })
  try {
    put(join(w.S, "box", "run", "engine.json"), JSON.stringify({ pid: engine.pid, port: 1 }))
    expect(await rehomeReady(w.K, w.S, { busy: async () => false })).toMatchObject({ ready: true, how: "move" })
    expect(await rehomeReady(w.K, w.S, { busy: async () => true })).toMatchObject({ ready: false, why: "It moves when nothing's running." })
  } finally {
    engine.stdin.end()
    await engine.exited
  }
  // What keeps it from moving at all isn't waiting for a quiet moment: never overdue for it.
  const two = world(v => {
    put(join(v.K, "run", "setup-card.json"), JSON.stringify({ self: { key: "m", name: "Mini", kind: "machine" } }))
    put(join(v.K, "bin", "kuvo-start"), "")
  })
  expect(await rehomeReady(two.K, two.S, { busy: async () => false })).toMatchObject({ ready: false, status: { state: null, waitingSince: null } })
}, 60_000)

test.if(mac)("Move Back refused for good is answered once: the keeper isn't sent to stop the box for it again", async () => {
  const w = world()
  expect(move(w).status).toBe(0)
  expect(askRehome(w.K, "back")).toBeNull()
  // The app made a box of its own in its folder again.
  put(join(w.S, "box", "run", "link.json"), "{}")
  const ready = await rehomeReady(w.K, null)
  expect(ready).toMatchObject({ ready: false, why: "Kuvo Code has a box of its own in its folder again: this one can't move back beside it.", status: { asked: null, state: "done" } })
  expect(await rehomeReady(w.K, null)).toMatchObject({ ready: false, why: "This Mac's box has moved." })
}, 60_000)

test.if(mac)("a copy of the app that isn't the real one never reads or asks the real ~/.kuvo-code's move", () => {
  const home = join(root, "demo")
  const S = join(home, "Library", "Application Support", "run.kuvo.code.demo")
  mkdirSync(join(S, "box"), { recursive: true })
  const ask = (request: unknown) => {
    const asked = spawnSync(process.execPath, [MAIN, "box", "route"], {
      cwd: home, encoding: "utf8", timeout: 60_000, input: JSON.stringify(request),
      env: { ...clean, HOME: home, TMPDIR: tmpdir(), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(S, "box"), KUVO_BOX: "mac", KUVO_ENGINE_CONFIG: join(S, "opencode", "config") },
    })
    return JSON.parse(asked.stdout.trim().split("\n").pop()!)
  }
  expect(JSON.parse(ask({ method: "GET", path: "kuvo/box/rehome" }).body)).toMatchObject({ state: null, from: null })
  expect(ask({ method: "POST", path: "kuvo/box/rehome", body: { now: true } }).status).toBe(409)
  expect(existsSync(join(home, ".kuvo-code"))).toBe(false)
}, 60_000)
