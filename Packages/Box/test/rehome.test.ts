import "./safety"
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BRIDGE_VERSION } from "../src/link/version"
import { askRehome, rehomeReady } from "../src/link/rehome/move"
import { rehomeStatus } from "../src/link/rehome/state"
import { clearUpdateStaging } from "../src/link/updates/update"

// Moving this Mac's box out of its app's folder into a home of its own (#333 pieces 2a and 2b,
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

interface World { home: string; S: string; K: string; release: string; repository: string; worktree: string; rootCommit: string }

const put = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, text)
}
const sha = (kind: "sha1" | "sha256", text: string) => createHash(kind).update(text).digest("hex")

// The Keychain the move copies an added Claude Code account's sign-in in: a test's own file, never
// in your search list, nor your login keychain.
const KEYCHAIN = join(root, "rehome-test.keychain-db")
if (mac) {
  spawnSync("/usr/bin/security", ["create-keychain", "-p", "test", KEYCHAIN])
  spawnSync("/usr/bin/security", ["unlock-keychain", "-p", "test", KEYCHAIN])
  afterAll(() => { spawnSync("/usr/bin/security", ["delete-keychain", KEYCHAIN]) })
}
const keychainItem = (service: string): string | null => {
  const found = spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-w", KEYCHAIN], { encoding: "utf8" })
  return found.status === 0 ? found.stdout.replace(/\n$/, "") : null
}
/** Claude Code's names, worked out here as it does: a folder's history (`projects/<slug>`), an
 * account's sign-in (by its folder's hash). */
const claudeSlug = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, "-")
const claudeItem = (folder: string) => `Claude Code-credentials-${sha("sha256", folder).slice(0, 8)}`
const CLAUDE_ACCOUNT = "ab12cd34"

const git = (cwd: string, args: string[]) => {
  const ran = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...clean, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout.trim()
}

/** The engine's database as the pinned engine (2.2.6) made it with real model turns: sessions in a
 * repository of yours and in its engine worktree in the box, a chat outside git in the box (its
 * project's ID by its folder), one in a folder of yours outside git, a fork, an edit undone (its
 * `revert`), a shell command, a permission kept, files sent (their URLs written plainly and with
 * `%20`), a queued message; recorded once (`fixtures/rehome/engine-2.2.6.sql`) with its folders
 * as placeholders, laid out here where this world's are. What 2.2.6 left empty after those turns
 * (`summary_diffs`, `permission` of a session) is filled here in its schema's shape. */
function engineDatabase(file: string, { S, home, rootCommit }: { S: string; home: string; rootCommit: string }) {
  let sql = readFileSync(join(import.meta.dir, "fixtures", "rehome", "engine-2.2.6.sql"), "utf8")
    .replaceAll("@S_URL@", pathToFileURL(S).href.slice("file://".length)).replaceAll("@S@", S).replaceAll("@HOME@", home)
    .replaceAll("@ROOT6@", rootCommit.slice(0, 6)).replaceAll("@ROOT@", rootCommit)
  sql = sql.replace(/@ID:([^@]+)@/g, (_, folder: string) => sha("sha1", `directory:${folder}`))
  mkdirSync(join(file, ".."), { recursive: true })
  const db = new Database(file)
  db.exec(sql)
  // (A diff whose text names the chat's folder, and a rule a command names it in: words, not paths.)
  db.query("UPDATE session_v2 SET summary_diffs = ?, permission = ? WHERE directory = ?").run(
    JSON.stringify([{ file: "notes.md", patch: `--- a/notes.md\n+++ b/notes.md\n+see ${S}/Chats/c1/notes.md\n`, additions: 1, deletions: 0, status: "modified" }]),
    JSON.stringify([{ action: "edit", resource: `${S}/Chats/c1/*`, effect: "allow" }]), `${S}/Chats/c1`)
  db.query("INSERT INTO permission VALUES ('psv_words', ?, 'shell', ?, 1, 1)").run(sha("sha1", `directory:${S}/Chats/c1`), `cd ${S}/Chats/c1 && npm test*`)
  db.close()
}

/** A Mac whose app's box ran in its folder (`S`, as the app's tests name it, with a space as the
 * real one has), with nothing in its `~/.kuvo-code` yet but what `given` puts there. */
let worlds = 0
function world(given: (w: World) => void = () => {}, { appFolder = "App Support", at }: { appFolder?: string; at?: string } = {}): World {
  const home = join(root, at ?? `w${String(worlds++).padStart(3, "0")}`)
  const S = join(home, appFolder)
  const repository = join(home, "proj")
  mkdirSync(join(home, "tmp"), { recursive: true })
  // A repository of yours, and the engine's worktree of it in the box.
  mkdirSync(repository, { recursive: true })
  git(repository, ["init", "-q", "-b", "main"])
  git(repository, ["commit", "-q", "--allow-empty", "-m", "root"])
  put(join(repository, "a.txt"), "line one\nline two\n")
  git(repository, ["add", "a.txt"])
  git(repository, ["commit", "-q", "-m", "a"])
  const rootCommit = git(repository, ["rev-list", "--max-parents=0", "HEAD"])
  const worktree = join(S, "opencode", "data", "opencode", "worktree", rootCommit.slice(0, 6), "feature one")
  mkdirSync(join(worktree, ".."), { recursive: true })
  git(repository, ["worktree", "add", "-q", "--detach", worktree])
  // And one of a repository that links its worktrees by relative paths (`worktree.useRelativePaths`), in the box too.
  const relativeRepository = join(home, "proj-relative")
  mkdirSync(relativeRepository, { recursive: true })
  git(relativeRepository, ["init", "-q", "-b", "main"])
  git(relativeRepository, ["config", "worktree.useRelativePaths", "true"])
  git(relativeRepository, ["commit", "-q", "--allow-empty", "-m", "root"])
  git(relativeRepository, ["worktree", "add", "-q", "--detach", join(S, "opencode", "data", "opencode", "worktree", "relative", "relative one")])
  const w = { home, S, K: join(home, ".kuvo-code"), release: join(home, "release"), repository, worktree, rootCommit }
  const chat = join(S, "Chats", "c1")
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
  put(join(S, "box", "box", "projects.json"), JSON.stringify({ projects: [{ name: "p", directory: repository, folders: [chat] }] }))
  put(join(S, "box", "box", "worktrees.json"), JSON.stringify({ worktrees: [{ root: repository, folder: worktree, project: repository }], removed: { [`${S}/Chats/gone`]: repository } }))
  put(join(S, "box", "box", "work.json"), "{\"projectsFolder\":null}")
  put(join(S, "box", "box", "branch-backups", sha("sha1", worktree).slice(0, 20), "backups.json"), JSON.stringify({ repository: worktree }))
  symlinkSync("projects.json", join(S, "box", "box", "projects-link"))
  put(join(S, "box", "machines.json"), "[]")
  put(join(S, "box", "artifacts", "a1.json"), "{}")
  put(join(S, "box", "artifacts", "log", "2026-11.jsonl"), JSON.stringify({ a: { id: "art_" + sha("sha256", `${chat}/hello.txt`).slice(0, 24), path: `${chat}/hello.txt`, where: { project: chat, bots: [], sessions: [], groups: [] } } }) + "\n")
  put(join(S, "box", "trash", "t1", "f"), "trashed")
  put(join(S, "box", "updates", "rollback", "restore.sh"), "#!/bin/sh\n")
  put(join(S, "box", "attachments", "ses_1", "a.png"), "box's a")
  // (One the box was sent under the same name as a file a message names in the app's: merged beside it.)
  put(join(S, "box", "attachments", "ses_a", "b.png"), "the box's own b")
  put(join(S, "box", "bin", "mcp-catalog.json"), "{}")
  // Beside it, the app's: the engine's data, as its engine made it.
  const data = join(S, "opencode", "data", "opencode")
  engineDatabase(join(data, "opencode.db"), { S, home, rootCommit })
  // Its snapshots of each worktree (by the worktree's path), borrowing your repository's objects.
  for (const folder of [repository, worktree]) {
    const snapshot = join(data, "snapshot", rootCommit, sha("sha1", folder))
    put(join(snapshot, "config"), `[core]\n\tbare = false\n\tworktree = ${folder}\n`)
    put(join(snapshot, "objects", "info", "alternates"), `${repository}/.git/objects\n`)
  }
  put(join(data, "shell", sha("sha1", `directory:${chat}`), "sh_1.out"), "pwd\n")
  put(join(S, "opencode", "config", "opencode", "opencode.json"), JSON.stringify({ instructions: [`${S}/opencode/config/opencode/AGENTS.md`] }))
  put(join(S, "opencode", "state", "x"), "state")
  put(join(S, "opencode", "cache", "x"), "cache")
  mkdirSync(join(S, "opencode", "workspace"), { recursive: true })
  // Its engine: here a stand-in that answers the engine's API from its database.
  put(join(S, "engine", "2.2.6", "opencode"), `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures", "rehome", "engine-stand-in.ts")}' "$@"\n`)
  chmodSync(join(S, "engine", "2.2.6", "opencode"), 0o755)
  put(join(S, "integrations", "notion", "x"), "sign-in")
  put(join(S, "bots", "b1", "directory"), join(S, "bots", "b1", "workspace") + "\n")
  put(join(S, "bots", "b1", "workspace", "notes.md"), `a bot's words naming ${S}/bots/b1`)
  put(join(S, "wakes", "ses_1", "directory"), chat)
  put(join(S, "groups", "g1", "chat.json"), "{}")
  put(join(chat, "notes.md"), "chat")
  // A chat that's a repository of its own, with a worktree of it outside the box.
  const chatRepository = join(S, "Chats", "c2")
  mkdirSync(chatRepository, { recursive: true })
  git(chatRepository, ["init", "-q", "-b", "main"])
  git(chatRepository, ["commit", "-q", "--allow-empty", "-m", "root"])
  git(chatRepository, ["worktree", "add", "-q", "--detach", join(home, "elsewhere")])
  // And one inside it, where Claude Code makes them.
  git(chatRepository, ["worktree", "add", "-q", "--detach", join(chatRepository, ".claude", "worktrees", "x")])
  put(join(home, "Projects", "plain", "p.txt"), "plain")
  put(join(S, "Attachments", "ses_1", "b.png"), "app's b")
  put(join(S, "Attachments", "ses_1", "a.png"), "app's a, the same name")
  put(join(S, "Attachments", "ses_2", "c.png"), "app's c")
  put(join(S, "Attachments", "ses_a", "b.png"), "sent")
  // The coding agents' bridge: its sessions, an added Claude Code account (its history of the chat,
  // and its sign-in in the Keychain), Cursor's record of its agents' folders, an added Grok
  // account's sessions, usage's place in a log, its snapshots of the chat.
  const agents = join(S, "agents")
  const account = join(agents, "claude", "accounts", CLAUDE_ACCOUNT)
  put(join(agents, "store.json"), "{}")
  put(join(agents, "sessions", "agt_1", "session.json"), JSON.stringify({ id: "agt_1", location: { directory: chat } }))
  put(join(account, "projects", claudeSlug(chat), "c.jsonl"), "{}\n")
  put(join(agents, "cursor", "agents", "agents.ndjson"), JSON.stringify({ id: "cur_1", cwd: chat }) + "\n")
  put(join(agents, "grok", "accounts", "g1", "sessions", encodeURIComponent(chat), "s1", "meta.json"), "{}")
  const log = join(account, "projects", claudeSlug(chat), "c.jsonl")
  put(join(agents, "usage", "claude-files", sha("sha256", log).slice(0, 32) + ".json"), JSON.stringify({ version: 1, path: log, record: { items: [], offset: 0, size: 0 } }))
  put(join(agents, "snapshots", sha("sha1", chat).slice(0, 20), "HEAD"), "ref: refs/heads/main\n")
  if (mac) spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "you", "-s", claudeItem(account), "-X", Buffer.from("{\"token\":\"t\"}").toString("hex"), KEYCHAIN])
  // Kuvo Code's own Anthropic Console sign-in, in a folder of its own too.
  const console_ = join(agents, "claude", "console")
  put(join(console_, "projects", claudeSlug(worktree), "c.jsonl"), "{}\n")
  if (mac) spawnSync("/usr/bin/security", ["add-generic-password", "-U", "-a", "you", "-s", claudeItem(console_), "-X", Buffer.from("{\"console\":true}").toString("hex"), KEYCHAIN])
  put(join(S, "phone-link.json"), "{\"machines\":[]}")
  // Your own Claude Code's and Grok's history of the chat and the worktree, in your home.
  put(join(home, ".claude", "projects", claudeSlug(chat), "c.jsonl"), "{}\n")
  put(join(home, ".claude", "projects", claudeSlug(worktree), "w.jsonl"), "{}\n")
  put(join(home, ".grok", "sessions", encodeURIComponent(worktree), "s1", "meta.json"), "{}")
  // Grok's index of its sessions, naming their folders, there and in the added account's home.
  put(join(home, ".grok", "sessions", "session_search.sqlite"), `cwd ${worktree}`)
  put(join(agents, "grok", "accounts", "g1", "sessions", "session_search.sqlite"), `cwd ${chat}`)
  // The app's own, which stays.
  put(join(S, "Browser", "x"), "browser")
  put(join(S, "bots.json"), "[]")
  // The box's own files, as the app brings them.
  put(join(w.release, "bin", "kuvo-start"), "#!/bin/sh\n")
  put(join(w.release, "bin", "kuvo-link.js"), "// the link")
  given(w)
  return w
}

/** Every row of every table of a database, as it reads. */
function rows(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true })
  try {
    const all: Record<string, unknown[]> = {}
    for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]) {
      all[name] = db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()
    }
    return all
  } finally {
    db.close()
  }
}

interface Ran { status: number | null; signal: string | null; said: Record<string, any> | null; errors: string }

function rehome(w: World, args: string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync(process.execPath, [MAIN, "rehome", ".kuvo-code", ...args], {
    cwd: w.home, encoding: "utf8", timeout: 60_000,
    env: { ...clean, HOME: w.home, TMPDIR: join(w.home, "tmp"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: join(w.S, "box"), KUVO_APP_VERSION: APP_VERSION, KUVO_TEST_REHOME_KEYCHAIN: KEYCHAIN, ...env },
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

// A clean move, to hold the others to: made where the world it's held to will be (what's rewritten
// names its folders), then cleared away for it.
function cleanResult(at: string) {
  const w = world(() => {}, { at })
  const moved = move(w)
  expect(moved.status, moved.errors).toBe(0)
  const result = { K: snapshot(w.K, boxOnly), S: snapshot(w.S), outside: outside(w) }
  rmSync(w.home, { recursive: true, force: true })
  // (Its copy of the sign-in too: the world held to it must make its own.)
  for (const folder of [join(w.K, "agents", "claude", "accounts", CLAUDE_ACCOUNT), join(w.K, "agents", "claude", "console")]) spawnSync("/usr/bin/security", ["delete-generic-password", "-s", claudeItem(folder), KEYCHAIN])
  return result
}

/** What the move changes outside the box: your own Claude Code's and Grok's history, the repository's
 * links to its worktree (and the one of a chat's repository outside the box), the added account's
 * sign-in under its new name. */
function outside(w: World) {
  const links: Record<string, string> = {}
  for (const repository of [w.repository, join(w.home, "proj-relative")]) {
    for (const name of readdirSync(join(repository, ".git", "worktrees"))) links[`${repository}:${name}`] = readFileSync(join(repository, ".git", "worktrees", name, "gitdir"), "utf8")
  }
  return {
    claude: snapshot(join(w.home, ".claude")),
    grok: snapshot(join(w.home, ".grok")),
    links,
    elsewhere: readFileSync(join(w.home, "elsewhere", ".git"), "utf8"),
    signIn: keychainItem(claudeItem(join(w.K, "agents", "claude", "accounts", CLAUDE_ACCOUNT))),
    original: keychainItem(claudeItem(join(w.S, "agents", "claude", "accounts", CLAUDE_ACCOUNT))),
    console: [keychainItem(claudeItem(join(w.K, "agents", "claude", "console"))), keychainItem(claudeItem(join(w.S, "agents", "claude", "console")))],
  }
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
  // The engine's database names the new places: its sessions', projects' and worktrees' folders,
  // the files sent (as they were written: plainly, or with `%20`), a rule's folder; a chat's
  // project, whose ID is its folder's, under its new folder's ID, with all that refers to it.
  const S = w.S, chat = join(S, "Chats", "c1"), newChat = join(K, "chats", "c1")
  const worktree = join(K, "data", "opencode", "worktree", w.rootCommit.slice(0, 6), "feature one")
  const db = rows(join(K, "data", "opencode", "opencode.db"))
  const chatID = sha("sha1", `directory:${newChat}`)
  expect((db.session_v2 as any[]).map(each => each.directory).sort()).toEqual([join(w.home, "Projects", "plain"), w.repository, newChat, newChat, worktree].sort())
  expect((db.project as any[]).map(each => [each.id, each.worktree]).sort()).toEqual([[w.rootCommit, w.repository], [chatID, newChat], [sha("sha1", `directory:${join(w.home, "Projects", "plain")}`), join(w.home, "Projects", "plain")]].sort())
  expect((db.session_v2 as any[]).filter(each => each.directory === newChat).map(each => each.project_id)).toEqual([chatID, chatID])
  expect((db.permission as any[]).map(each => each.project_id)).toEqual([chatID, chatID])
  expect((db.worktree as any[]).map(each => each.directory).sort()).toEqual([w.repository, worktree].sort())
  const sent = (db.session_inbox as any[]).flatMap(each => JSON.parse(each.payload).files ?? []).map((each: any) => each.source.uri)
  // (The app's file, merged beside the box's of the same name as `b 2.png`: named so.)
  expect(sent.sort()).toEqual([`file://${join(K, "attachments", "ses_a", "b 2.png")}`, pathToFileURL(join(K, "attachments", "ses_a", "b 2.png")).href, pathToFileURL(join(K, "attachments", "ses_a", "b 2.png")).href].sort())
  expect(read("attachments/ses_a/b 2.png")).toBe("sent")
  expect(read("attachments/ses_a/b.png")).toBe("the box's own b")
  expect(JSON.parse((db.session_v2 as any[]).find(each => each.directory === newChat && each.permission).permission)).toEqual([{ action: "edit", resource: `${newChat}/*`, effect: "allow" }])
  // What a person or an agent wrote is as it was: said for support, never rewritten.
  expect(JSON.stringify(db.session_message)).toContain(`${S}/Chats/c1`)
  expect(moved.said!.status).toBeDefined()
  const record = JSON.parse(readFileSync(join(K, "updates", "rehome", "state.json"), "utf8"))
  expect(record.leftovers).toEqual(expect.arrayContaining([expect.stringContaining("instruction_blob.value"), expect.stringContaining("session_message.data"),
    expect.stringContaining("session_v2.summary_diffs"), expect.stringContaining("permission.resource"), "bots/b1/workspace/notes.md"]))
  // Its folders kept by a path: the worktree's snapshots by its new path, their links rewritten;
  // the chat's commands' output under its project's new ID.
  const snapshots = join(K, "data", "opencode", "snapshot", w.rootCommit)
  expect(readdirSync(snapshots).sort()).toEqual([sha("sha1", w.repository), sha("sha1", worktree)].sort())
  expect(read(`data/opencode/snapshot/${w.rootCommit}/${sha("sha1", worktree)}/config`)).toContain(`worktree = ${worktree}\n`)
  expect(read(`data/opencode/snapshot/${w.rootCommit}/${sha("sha1", worktree)}/objects/info/alternates`)).toBe(`${w.repository}/.git/objects\n`)
  expect(readdirSync(join(K, "data", "opencode", "shell"))).toEqual([chatID])
  // The worktree, from both ends.
  expect(git(worktree, ["status", "--porcelain"])).toBe("")
  expect(git(w.repository, ["worktree", "list", "--porcelain"])).toContain(`worktree ${worktree}\n`)
  expect(git(w.repository, ["status", "--porcelain"])).toBe("")
  // A chat's repository that moved, from its worktree outside the box too.
  expect(readFileSync(join(w.home, "elsewhere", ".git"), "utf8")).toBe(`gitdir: ${join(K, "chats", "c2", ".git", "worktrees", "elsewhere")}\n`)
  expect(git(join(w.home, "elsewhere"), ["status", "--porcelain"])).toBe("")
  expect(git(join(K, "chats", "c2"), ["worktree", "list", "--porcelain"])).toContain(`worktree ${join(w.home, "elsewhere")}\n`)
  // One linked by relative paths, as it was.
  const relative = join(K, "data", "opencode", "worktree", "relative", "relative one")
  expect(git(relative, ["status", "--porcelain"])).toBe("")
  expect(readFileSync(join(relative, ".git"), "utf8")).toStartWith("gitdir: ../")
  expect(git(join(w.home, "proj-relative"), ["worktree", "list", "--porcelain"])).toContain(`worktree ${relative}\n`)
  // And a worktree inside the chat's repository, which moved with it.
  expect(git(join(K, "chats", "c2", ".claude", "worktrees", "x"), ["status", "--porcelain"])).toBe("")
  expect(git(join(K, "chats", "c2"), ["worktree", "list", "--porcelain"])).toContain(`worktree ${join(K, "chats", "c2", ".claude", "worktrees", "x")}\n`)
  // The box's own files.
  expect(JSON.parse(read("box/projects.json"))).toEqual({ projects: [{ name: "p", directory: w.repository, folders: [newChat] }] })
  expect(JSON.parse(read("box/worktrees.json"))).toEqual({ worktrees: [{ root: w.repository, folder: worktree, project: w.repository }], removed: { [join(K, "chats", "gone")]: w.repository } })
  expect(read("wakes/ses_1/directory")).toBe(newChat)
  expect(read("bots/b1/directory")).toBe(join(K, "bots", "b1", "workspace") + "\n")
  expect(JSON.parse(read("config/opencode/opencode.json"))).toEqual({ instructions: [join(K, "config", "opencode", "AGENTS.md")] })
  expect(JSON.parse(read("artifacts/log/2026-11.jsonl"))).toMatchObject({ a: { id: "art_" + sha("sha256", `${newChat}/hello.txt`).slice(0, 24), path: `${newChat}/hello.txt`, where: { project: newChat } } })
  expect(readdirSync(join(K, "box", "branch-backups"))).toEqual([sha("sha1", worktree).slice(0, 20)])
  // The coding agents': the bridge's sessions, Cursor's records, its snapshots and usage, an added
  // account's history and sessions; its sign-in under its folder's new name (the original gone).
  const account = join(K, "agents", "claude", "accounts", CLAUDE_ACCOUNT)
  expect(JSON.parse(read("agents/sessions/agt_1/session.json")).location.directory).toBe(newChat)
  expect(JSON.parse(read("agents/cursor/agents/agents.ndjson"))).toEqual({ id: "cur_1", cwd: newChat })
  expect(readdirSync(join(K, "agents", "snapshots"))).toEqual([sha("sha1", newChat).slice(0, 20)])
  const log = join(account, "projects", claudeSlug(newChat), "c.jsonl")
  expect(readdirSync(join(K, "agents", "usage", "claude-files"))).toEqual([sha("sha256", log).slice(0, 32) + ".json"])
  expect(JSON.parse(read(`agents/usage/claude-files/${sha("sha256", log).slice(0, 32)}.json`)).path).toBe(log)
  expect(existsSync(log)).toBe(true)
  expect(readdirSync(join(K, "agents", "grok", "accounts", "g1", "sessions"))).toEqual([encodeURIComponent(newChat)])
  expect(keychainItem(claudeItem(account))).toBe("{\"token\":\"t\"}")
  expect(keychainItem(claudeItem(join(K, "agents", "claude", "console")))).toBe("{\"console\":true}")
  expect(keychainItem(claudeItem(join(S, "agents", "claude", "console")))).toBeNull()
  expect(readdirSync(join(K, "agents", "claude", "console", "projects"))).toEqual([claudeSlug(worktree)])
  expect(keychainItem(claudeItem(join(S, "agents", "claude", "accounts", CLAUDE_ACCOUNT)))).toBeNull()
  // Your own Claude Code's and Grok's history of the folders that moved.
  expect(readdirSync(join(w.home, ".claude", "projects")).sort()).toEqual([claudeSlug(newChat), claudeSlug(worktree)].sort())
  // (Grok's indexes of them gone, for Grok to make anew with their new folders.)
  expect(readdirSync(join(w.home, ".grok", "sessions"))).toEqual([encodeURIComponent(worktree)])
  expect(existsSync(join(K, "engine", "2.2.6", "opencode"))).toBe(true)
  expect(read("chats/c1/notes.md")).toBe("chat")
  expect(read("phone-link.json")).toBe("{\"machines\":[]}")
  for (const each of ["state/x", "cache/x", "integrations/notion/x", "bots/b1/workspace/notes.md", "wakes/ses_1/directory", "groups/g1/chat.json", "agents/store.json"]) expect(existsSync(join(K, each))).toBe(true)
  // Both folders of sent files, merged: a name in both keeps both.
  expect(snapshot(join(K, "attachments"))).toMatchObject({ "ses_1/a.png": expect.any(String), "ses_1/a 2.png": expect.any(String), "ses_1/b.png": expect.any(String), "ses_2/c.png": expect.any(String), "ses_a/b.png": expect.any(String), "ses_a/b 2.png": expect.any(String) })
  expect(read("attachments/ses_1/a.png")).toBe("box's a")
  expect(read("attachments/ses_1/a 2.png")).toBe("app's a, the same name")
  // Its run state, not its processes' records; its files from its release, not the app's bin.
  expect(readdirSync(join(K, "run")).sort()).toEqual(["fence", "link.json", "mac-link.json", "setup-card.json"])
  // (With what the app put in its box's bin that the release doesn't bring: its catalog.)
  expect(readdirSync(join(K, "bin")).sort()).toEqual(["kuvo-link.js", "kuvo-start", "mcp-catalog.json"])
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
    const before = { S: snapshot(w.S), outside: outside(w) }
    const stopped = move(w, { KUVO_TEST_REHOME_STOP: point })
    expect(stopped.signal).toBe("SIGKILL")
    // Until it's finished, neither the app nor its keeper starts a box.
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
    // (It didn't move: the keeper starts the old box again, as it was.)
    const resumed = rehome(w, ["--resume"])
    expect(resumed.status, resumed.errors).toBe(1)
    expect(resumed.said).toMatchObject({ result: "failed", status: { state: "failed", tries: 1, failed: { step: expect.any(String) } } })
    expect(snapshot(w.S)).toEqual(before.S)
    // What it changed outside the box, as it was: git's links, your agents' history, no copy of the
    // sign-in left.
    expect(outside(w)).toEqual(before.outside)
    expect(readdirSync(w.K)).toEqual(["updates"])
    expect(readdirSync(join(w.K, "updates", "rehome"))).toEqual(["state.json"])
    expect(here(w)).toMatchObject({ use: "own" })
    // Twice in a row: the second finds nothing to finish.
    expect(rehome(w, ["--resume"]).said).toMatchObject({ result: "nothing" })
  }, 60_000)
}

for (const point of POINTS_FORWARD) {
  test.if(mac)(`stopped at ${point}, it goes forward: as a clean move ends`, () => {
    const ideal = cleanResult(`forward-${point}`)
    const w = world(() => {}, { at: `forward-${point}` })
    const stopped = move(w, { KUVO_TEST_REHOME_STOP: point })
    expect(stopped.signal).toBe("SIGKILL")
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
    const resumed = rehome(w, ["--resume"])
    expect(resumed.status, resumed.errors).toBe(0)
    expect(resumed.said).toMatchObject({ result: "done", status: { state: "done" } })
    expect(snapshot(w.K, boxOnly)).toEqual(ideal.K)
    expect(snapshot(w.S)).toEqual(ideal.S)
    expect(outside(w)).toEqual(ideal.outside)
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
  const database = join(w.S, "opencode", "data", "opencode", "opencode.db")
  const beforeRows = rows(database)
  const beforeOutside = outside(w)
  const signIn = keychainItem(claudeItem(join(w.S, "agents", "claude", "accounts", CLAUDE_ACCOUNT)))
  expect(move(w).status).toBe(0)
  // Used in its home meanwhile.
  put(join(w.K, "data", "opencode", "since"), "a session made since")
  put(join(w.K, "attachments", "ses_3", "d.png"), "sent since")
  // (Its keeper runs it, as it would: its own record is no refusal.)
  const keeper = Bun.spawn(["/bin/sh", "-c", "read line", "kuvo-start"], { stdin: "pipe" })
  put(join(w.K, "run", "box.pid"), String(keeper.pid))
  const back = rehome(w, ["--back"])
  keeper.stdin.end()
  await keeper.exited
  expect(back.status, JSON.stringify(back.said) + back.errors).toBe(0)
  expect(back.said).toMatchObject({ result: "back", status: { state: "back", way: "back", owed: ["keychain", "agent"] } })
  // As it was (its processes' records and the app's own bin aside, which the app makes anew as it
  // starts its box), with what was made since where it belongs; never its kind.
  // (The engine's database is compared row by row.)
  const made = (relative: string) => /^box\/run\/(engine\.json|serve\.json|served\.json|keeper\.json|socket\.key)$/.test(relative) || relative.startsWith("box/bin") || relative === "opencode/data/opencode/opencode.db"
  const now = snapshot(w.S)
  expect(Object.fromEntries(Object.entries(before).filter(([file]) => !made(file) && !file.includes("session_search")))).toEqual(Object.fromEntries(Object.entries(now).filter(([file]) =>
    !["opencode/data/opencode/since", "opencode/data/opencode/opencode.db", "box/attachments/ses_3", "box/attachments/ses_3/d.png", "box/run/box.pid"].includes(file))))
  // (A file sent, by the file its URL names: written plainly or with `%20` where it was, which
  // ~/.kuvo-code's, the same both ways, doesn't keep.)
  const byFile = (all: Record<string, unknown[]>) => JSON.parse(JSON.stringify(all).replace(/file:\/\/[^"\\]+/g, url => pathToFileURL(fileURLToPath(url)).href))
  expect(byFile(rows(database))).toEqual(byFile(beforeRows))
  // What's outside the box names it where it is again: git's links, your agents' history; the
  // sign-in back under its old name, the copy gone.
  // (Grok's index of its sessions isn't back: a cache, it's made anew with their folders.)
  const noIndex = (seen: ReturnType<typeof outside>) => ({ ...seen, signIn: null, console: null, grok: Object.fromEntries(Object.entries(seen.grok).filter(([file]) => !file.includes("session_search"))) })
  expect(existsSync(join(w.home, ".grok", "sessions", "session_search.sqlite"))).toBe(false)
  expect(noIndex(outside(w))).toEqual(noIndex(beforeOutside))
  expect(keychainItem(claudeItem(join(w.S, "agents", "claude", "accounts", CLAUDE_ACCOUNT)))).toBe(signIn)
  expect(keychainItem(claudeItem(join(w.K, "agents", "claude", "accounts", CLAUDE_ACCOUNT)))).toBeNull()
  expect(git(w.worktree, ["status", "--porcelain"])).toBe("")
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
  const ideal = cleanResult("stuck")
  const w = world(() => {}, { at: "stuck" })
  // (Where it keeps the originals can't be written.)
  mkdirSync(join(w.K, "updates", "rehome", "kept"), { recursive: true, mode: 0o700 })
  chmodSync(join(w.K, "updates", "rehome", "kept"), 0o500)
  try {
    const stuck = move(w)
    expect(stuck.status).toBe(3)
    expect(stuck.said).toMatchObject({ result: "stuck", status: { state: "clearing", step: "clear", failed: { step: "clear" } } })
    expect(here(w)).toMatchObject({ verdict: "moving", use: "wait" })
  } finally {
    chmodSync(join(w.K, "updates", "rehome", "kept"), 0o700)
  }
  const resumed = rehome(w, ["--resume"])
  expect(resumed.status).toBe(0)
  expect(resumed.said).toMatchObject({ result: "done" })
  expect(snapshot(w.K, boxOnly)).toEqual(ideal.K)
  expect(outside(w)).toEqual(ideal.outside)
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

test.if(mac)("what goes wrong before a move begins says it failed, for the box where it was to start as it was", () => {
  const w = world()
  // (Asked without the app's box: nothing begins.)
  const wrong = rehome(w, ["--release", w.release], { KUVO_HOME: w.K })
  expect([wrong.status, wrong.said?.result]).toEqual([1, "failed"])
  expect(readdirSync(w.S)).toContain("box")
}, 60_000)

test.if(mac)("what's written where it moves from as it moves, or a box that starts meanwhile, sends it back before it clears: nothing is left only in its kept copy", async () => {
  const w = world()
  const before = snapshot(w.S)
  // You send a file as it clones: the app keeps it in its Attachments.
  const sent = move(w, { KUVO_TEST_REHOME_WRITE_AT: "after-fix", KUVO_TEST_REHOME_WRITE_FILE: join(w.S, "Attachments", "ses_9", "new.png"), KUVO_TEST_REHOME_WRITE_TEXT: "sent meanwhile" })
  expect([sent.status, sent.said?.result]).toEqual([1, "failed"])
  expect(sent.said!.message).toContain("changed as it moved")
  expect(readFileSync(join(w.S, "Attachments", "ses_9", "new.png"), "utf8")).toBe("sent meanwhile")
  expect(Object.fromEntries(Object.entries(snapshot(w.S)).filter(([file]) => !file.startsWith("Attachments/ses_9") && file !== "Attachments"))).toEqual(Object.fromEntries(Object.entries(before).filter(([file]) => file !== "Attachments")))
  expect(readdirSync(w.K)).toEqual(["updates"])

  const started = world()
  const engine = Bun.spawn(["/bin/sh", "-c", "read line", "opencode"], { stdin: "pipe" })
  try {
    const moved = move(started, { KUVO_TEST_REHOME_WRITE_AT: "after-fix", KUVO_TEST_REHOME_WRITE_FILE: join(started.S, "box", "run", "engine.json"), KUVO_TEST_REHOME_WRITE_TEXT: JSON.stringify({ pid: engine.pid, port: 1 }) })
    expect(moved.said).toMatchObject({ result: "failed", status: { state: "failed", failed: { step: "fix" } } })
    expect(moved.said!.message).toContain("Something started in the box as it moved (its engine)")
    expect(readdirSync(started.S)).toContain("box")
    expect(readdirSync(started.K)).toEqual(["updates"])
  } finally {
    engine.stdin.end()
    await engine.exited
  }
}, 60_000)

test.if(mac)("an engine database of a schema the move wasn't tried with refuses it, saying so, and changes nothing", () => {
  const w = world(v => {
    const db = new Database(join(v.S, "opencode", "data", "opencode", "opencode.db"))
    db.exec("INSERT INTO migration VALUES ('20261201000000_newer', 1)")
    db.close()
  })
  const before = snapshot(w.S)
  const refused = move(w)
  expect([refused.status, refused.said?.message]).toEqual([1, "The engine's database (opencode.db) is of a version this box can't move yet (60 20261201000000_newer): it moves once the box updates."])
  expect(snapshot(w.S)).toEqual(before)
  expect(readdirSync(w.K)).toEqual(["updates"])
}, 60_000)

test("an update's tidying of its folder leaves a move's state and kept copies alone", () => {
  const updates = join(root, "updates")
  for (const file of ["rollback/restore.sh", "installed.json", "rehome/state.json", "rehome/kept/x/box/f", "1.2.3/bin/kuvo-link.js"]) put(join(updates, file), "x")
  clearUpdateStaging(updates)
  expect(readdirSync(updates).sort()).toEqual(["installed.json", "rehome", "rollback"])
  expect(existsSync(join(updates, "rehome", "kept", "x", "box", "f"))).toBe(true)
})

test.if(mac)("a list the app makes for the first time where it moves from, as it moves, sends it back too; the app's own records in run don't", () => {
  const w = world(v => rmSync(join(v.S, "box", "machines.json")))
  const added = move(w, { KUVO_TEST_REHOME_WRITE_AT: "after-fix", KUVO_TEST_REHOME_WRITE_FILE: join(w.S, "box", "machines.json"), KUVO_TEST_REHOME_WRITE_TEXT: "[\"added meanwhile\"]" })
  expect(added.said).toMatchObject({ result: "failed" })
  expect(readFileSync(join(w.S, "box", "machines.json"), "utf8")).toBe("[\"added meanwhile\"]")

  const opened = world()
  const moved = move(opened, { KUVO_TEST_REHOME_WRITE_AT: "after-fix", KUVO_TEST_REHOME_WRITE_FILE: join(opened.S, "box", "run", "host.json"), KUVO_TEST_REHOME_WRITE_TEXT: "{}" })
  expect(moved.said).toMatchObject({ result: "done" })
}, 60_000)

// The engine itself (the pinned one, named by KUVO_TEST_ENGINE where it's there: never the real
// Kuvo Code's), in place of the stand-in: the move's check starts it on the staged data, and once
// moved it starts on the box's new home with every session in its new folder.
const ENGINE = process.env.KUVO_TEST_ENGINE
test.if(mac && !!ENGINE && existsSync(ENGINE))("with the engine itself, the move checks the moved data with it, and it opens the moved box with every session in its new folder", async () => {
  const w = world(v => {
    rmSync(join(v.S, "engine", "2.2.6", "opencode"))
    const cloned = spawnSync("/bin/cp", ["-c", ENGINE!, join(v.S, "engine", "2.2.6", "opencode")])
    expect(cloned.status).toBe(0)
  })
  const moved = move(w)
  expect(moved.said, moved.errors).toMatchObject({ result: "done" })
  // Started as the box starts it, in its home of its own.
  const K = w.K, password = "engine-test"
  const engine = Bun.spawn([join(K, "engine", "2.2.6", "opencode"), "serve", "--stdio", "--port", "0"], {
    cwd: join(K, "workspace"), stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { PATH: "/usr/bin:/bin", HOME: join(w.home, "engine-home"), TMPDIR: join(w.home, "tmp") + "/", XDG_DATA_HOME: join(K, "data"), XDG_CONFIG_HOME: join(w.home, "engine-config"),
      XDG_STATE_HOME: join(K, "state"), XDG_CACHE_HOME: join(K, "cache"), OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" },
  })
  try {
    const reader = engine.stdout.getReader()
    let said = ""
    while (!/"url"/.test(said)) {
      const { value, done } = await reader.read()
      if (done) break
      said += new TextDecoder().decode(value)
    }
    const url = /"url":"([^"]+)"/.exec(said)![1]
    const ask = async (route: string) => (await fetch(url + route, { headers: { authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") } })).json() as any
    const sessions = (await ask("/api/session?limit=100")).data as any[]
    const newChat = join(K, "chats", "c1"), worktree = join(K, "data", "opencode", "worktree", w.rootCommit.slice(0, 6), "feature one")
    expect(sessions.map(each => each.location.directory).sort()).toEqual([join(w.home, "Projects", "plain"), w.repository, newChat, newChat, worktree].sort())
    expect(sessions.filter(each => each.location.directory === newChat).map(each => each.projectID)).toEqual([sha("sha1", `directory:${newChat}`), sha("sha1", `directory:${newChat}`)])
    // Its projects, by their new folders, and none made anew for the old ones.
    const projects = (await ask("/api/project")) as any[]
    expect((projects.map(each => each.canonical) as string[]).filter(folder => folder.startsWith(w.home)).sort()).toEqual([join(w.home, "Projects", "plain"), w.repository, newChat].sort())
  } finally {
    engine.stdin.end()
    await engine.exited
  }
}, 120_000)

test.if(mac)("a check that finds the moved data wrong sends it back, saying why: the engine that won't start on it, or one that lists fewer sessions", () => {
  for (const [engine, why] of [["exit 3", "The engine stopped as it started on the moved data"], [`STAND_IN_LOSES_ONE=1 exec '${process.execPath}' '${join(import.meta.dir, "fixtures", "rehome", "engine-stand-in.ts")}' "$@"`, "The engine on the moved data lists 4 sessions, not 5."]]) {
    const w = world(v => put(join(v.S, "engine", "2.2.6", "opencode"), `#!/bin/sh\n${engine}\n`))
    const before = { S: snapshot(w.S), outside: outside(w) }
    const refused = move(w)
    expect([refused.status, refused.said?.result], refused.errors).toEqual([1, "failed"])
    expect(refused.said).toMatchObject({ status: { state: "failed", failed: { step: "check" } } })
    expect(refused.said!.message).toContain(why)
    expect(snapshot(w.S)).toEqual(before.S)
    expect(outside(w)).toEqual(before.outside)
    expect(readdirSync(w.K)).toEqual(["updates"])
  }
}, 60_000)

test.if(mac)("Move Back is refused while the engine's database is of a schema the move wasn't tried with, and the box stays where it is", () => {
  const w = world()
  expect(move(w).status).toBe(0)
  const db = new Database(join(w.K, "data", "opencode", "opencode.db"))
  db.exec("INSERT INTO migration VALUES ('20261201000000_newer', 1)")
  db.close()
  const back = rehome(w, ["--back"])
  expect([back.status, back.said?.message]).toEqual([1, "The engine's database (opencode.db) is of a version this box can't move yet (60 20261201000000_newer): it moves once the box updates."])
  expect(back.said).toMatchObject({ status: { state: "done", way: "move" } })
  expect(existsSync(join(w.K, "box", "kind"))).toBe(true)
}, 60_000)

test.if(mac && !!ENGINE && existsSync(ENGINE))("with the engine itself, a box of hundreds of sessions, some archived, is checked page by page", () => {
  const w = world(v => {
    rmSync(join(v.S, "engine", "2.2.6", "opencode"))
    expect(spawnSync("/bin/cp", ["-c", ENGINE!, join(v.S, "engine", "2.2.6", "opencode")]).status).toBe(0)
    const db = new Database(join(v.S, "opencode", "data", "opencode", "opencode.db"))
    const chat = db.query("SELECT * FROM session_v2 WHERE directory = ? ORDER BY id LIMIT 1").get(join(v.S, "Chats", "c1")) as Record<string, unknown>
    const columns = Object.keys(chat)
    const insert = db.query(`INSERT INTO session_v2 (${columns.map(each => `"${each}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    for (let i = 0; i < 250; i++) {
      const id = `ses_e2c1${String(i).padStart(4, "0")}ffeMoreSessions${String(i).padStart(2, "0").slice(-2)}`.slice(0, 30)
      insert.run(...columns.map(each => each === "id" ? id : each === "time_updated" ? 1794556100000 + i : each === "time_archived" ? (i % 50 === 0 ? 1794556200000 : null) : each === "slug" ? `more-${i}` : chat[each]) as never[])
    }
    db.close()
  })
  const moved = move(w)
  expect(moved.said, moved.errors).toMatchObject({ result: "done" })
  const db = rows(join(w.K, "data", "opencode", "opencode.db"))
  expect(db.session_v2.length).toBe(255)
}, 120_000)
