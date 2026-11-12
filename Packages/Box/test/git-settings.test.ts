import "./safety"
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Settings › Git, each computer's own, as a box updated before your Mac takes it: the branch prefix
// a box from before kept (the one a phone's worktrees there started with) stays yours, once, and a
// Mac with nothing to give doesn't turn a later one's away. The box's own settings, git and worktree
// route; its engine a stand-in that makes worktrees with git, as the real one does.

const home = process.env.KUVO_HOME!
const settingsFile = join(home, "box", "opencode.json")
const gitFile = join(home, "box", "git.json")
const worktreesFile = join(home, "box", "worktrees.json")
const before: Record<string, string | null> = {}

let root: string, project: string
let engine: ReturnType<typeof Bun.serve>
let made = 0
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" }
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim()
const put = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}
const settings = async () => (await import("../src/link/areas/config")).readSettings(settingsFile).settings ?? {}
const kept = () => JSON.parse(readFileSync(gitFile, "utf8"))

beforeAll(() => {
  for (const file of [settingsFile, gitFile, worktreesFile]) before[file] = existsSync(file) ? readFileSync(file, "utf8") : null
  root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-git-settings-")))
  project = join(root, "shop")
  mkdirSync(project)
  git(project, "init", "-q", "-b", "main")
  writeFileSync(join(project, "README.md"), "# Shop\n")
  git(project, "add", "-A")
  git(project, "commit", "-q", "-m", "First")
  // The engine: one project, worktrees made beside it with git, left on no branch.
  engine = Bun.serve({
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
      return Response.json({}, { status: 404 })
    },
  })
})

afterEach(() => {
  for (const file of [settingsFile, gitFile, worktreesFile]) rmSync(file, { force: true })
})

afterAll(() => {
  engine.stop(true)
  for (const [file, text] of Object.entries(before)) if (text !== null) writeFileSync(file, text)
  rmSync(root, { recursive: true, force: true })
})

/** A worktree a phone asks for: no branch prefix given, so the box's own. */
async function phonesWorktree() {
  const { answerWorktrees } = await import("../src/link/areas/worktrees")
  const answer = await answerWorktrees("POST", "kuvo/worktrees", { project }, { port: engine.port!, password: "pw" }, undefined, null)
  expect(answer.status).toBe(200)
  return answer.value as { branch: string }
}

test("a box updated before your Mac keeps the branch prefix its worktrees started with, once: a phone's starts as yours did", async () => {
  // The box from before: its settings its own, and the prefix a client last made a worktree with.
  put(settingsFile, {})
  put(gitFile, { branchPrefix: "ada/" })
  const { keepOldBranchPrefix } = await import("../src/link/areas/git-words")
  keepOldBranchPrefix()

  expect((await phonesWorktree()).branch).toMatch(/^ada\/brave-otter-\d+$/)
  expect((await settings()).branch_prefix).toBe("ada/")
  expect(kept().branchPrefix).toBeUndefined()

  // Cleared in Settings › Git since: the next start brings nothing back.
  const { changeSettings } = await import("../src/link/areas/config")
  expect(changeSettings([{ path: ["branch_prefix"], value: null }], settingsFile).status).toBe(200)
  keepOldBranchPrefix()
  expect((await settings()).branch_prefix).toBeUndefined()
  expect((await phonesWorktree()).branch).toMatch(/^kuvo\/brave-otter-\d+$/)
})

test("a box whose settings weren't its own as it started takes its old branch prefix when your Mac moves its Settings › Git there", async () => {
  put(gitFile, { branchPrefix: "ada/" })
  const { keepOldBranchPrefix, moveGitSettings } = await import("../src/link/areas/git-words")
  keepOldBranchPrefix()
  expect(existsSync(settingsFile)).toBe(false)
  expect(kept().branchPrefix).toBe("ada/")

  // Its settings its own now; a Mac that never set a prefix gives its instructions.
  put(settingsFile, {})
  const moved = moveGitSettings({ commitInstructions: "From the Mac." })
  expect(moved).toEqual({ status: 200, moved: true })
  expect(await settings()).toEqual({ branch_prefix: "ada/", commit_instructions: "From the Mac." })
  expect((await phonesWorktree()).branch).toMatch(/^ada\/brave-otter-\d+$/)
})

test("a Mac with nothing to give doesn't turn a later Mac's Settings › Git away", async () => {
  put(settingsFile, {})
  const { moveGitSettings } = await import("../src/link/areas/git-words")
  expect(moveGitSettings({ commitInstructions: "", pullRequestInstructions: "  " })).toEqual({ status: 200, moved: false })
  expect(await settings()).toEqual({})

  // Another Mac, with instructions of its own: they move, and only once.
  expect(moveGitSettings({ pullRequestInstructions: "Link the issue." })).toEqual({ status: 200, moved: true })
  expect(moveGitSettings({ commitInstructions: "A third Mac's." })).toEqual({ status: 200, moved: false })
  expect(await settings()).toEqual({ pull_request_instructions: "Link the issue." })
})
