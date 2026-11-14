import "./safety"
import { afterAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// New Session in a new worktree, cut short (the client went away while its session was being
// made): the worktree made for it and its branch go again, as they do when the engine refuses it,
// not kept for good with no session in it. The box's own start and worktree route; its engine a
// stand-in that makes worktrees with git, as the real one does.

const home = process.env.KUVO_HOME!
const worktreesFile = join(home, "box", "worktrees.json")
const before = existsSync(worktreesFile) ? readFileSync(worktreesFile, "utf8") : null
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim()

const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-start-cancelled-")))
const project = join(root, "shop")
mkdirSync(project)
git(project, "init", "-q", "-b", "main")
writeFileSync(join(project, "README.md"), "# Shop\n")
git(project, "add", "-A")
git(project, "commit", "-q", "-m", "First")

// The start's client, gone as its session is asked for; with `makes`, after the engine made it
// (its answer lost).
let client = new AbortController()
let makes = false
const listed: { id: string; location: { directory: string } }[] = []
let made = 0
const engine = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/api/location") return Response.json({ directory: project, project: { id: "prj_shop" } })
    if (url.pathname === "/api/worktree" && request.method === "POST") {
      const folder = join(root, "worktrees", `brave-otter-${++made}`)
      git(project, "worktree", "add", "--detach", folder)
      return Response.json({ directory: folder })
    }
    if (url.pathname === "/api/worktree" && request.method === "DELETE") {
      const { directory } = (await request.json()) as { directory: string }
      git(project, "worktree", "remove", "--force", directory)
      return Response.json(true)
    }
    if (url.pathname === "/api/session" && request.method === "GET") return Response.json({ data: listed })
    if (url.pathname === "/api/session/active") return Response.json({ data: {} })
    if (url.pathname === "/api/session" && request.method === "POST") {
      const { location } = (await request.json()) as { location: { directory: string } }
      if (makes) listed.push({ id: "ses_made", location })
      client.abort()
      return Response.json({ message: "Cut short." }, { status: 500 })
    }
    return Response.json({}, { status: 404 })
  },
})

afterAll(() => {
  engine.stop(true)
  if (before !== null) writeFileSync(worktreesFile, before)
  else rmSync(worktreesFile, { force: true })
  rmSync(root, { recursive: true, force: true })
})

test("a New Session in a new worktree cut short leaves no worktree or branch behind", async () => {
  const { startSession } = await import("../src/link/letters/start")
  const outcome = await startSession({ folder: project, worktree: true }, null, { readEngine: () => ({ port: engine.port!, password: "pw" }) as never, bridge: () => null, signal: client.signal })
  expect("refused" in outcome).toBe(true)
  expect(made).toBe(1)
  expect(existsSync(join(root, "worktrees", "brave-otter-1"))).toBe(false)
  expect(git(project, "branch", "--list", "kuvo/*")).toBe("")
  const kept = existsSync(worktreesFile) ? JSON.parse(readFileSync(worktreesFile, "utf8")) : {}
  expect(kept.worktrees ?? []).toEqual([])
  expect(kept.restorable ?? []).toEqual([])
})

test("one the engine made before the start was cut short keeps its worktree", async () => {
  const { startSession } = await import("../src/link/letters/start")
  client = new AbortController()
  makes = true
  const outcome = await startSession({ folder: project, worktree: true }, null, { readEngine: () => ({ port: engine.port!, password: "pw" }) as never, bridge: () => null, signal: client.signal })
  expect("refused" in outcome).toBe(true)
  expect(listed.map(each => each.location.directory)).toEqual([join(root, "worktrees", "brave-otter-2")])
  expect(existsSync(join(root, "worktrees", "brave-otter-2"))).toBe(true)
})
