import "./safety"
import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { linkedWorktrees, projectWorktrees, repositoryOf } from "../src/link/work/project-trees"

// A project's git worktrees count as the project's own (#422) only as its own repository lists
// them: never another repository's, put in its place by a link (a command can't in the sandbox on a
// Mac, but can on Linux, and the agent's own file tools aren't in it), and never by reading what
// would hold the box (a FIFO where git keeps a file).

const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-project-trees-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
function git(folder: string, ...args: string[]) {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args], { cwd: folder, env: ENV, encoding: "utf8" })
  if (ran.status !== 0) throw new Error(ran.stderr)
}
function repository(name: string, ...trees: string[]): string {
  const top = join(root, name)
  mkdirSync(top)
  writeFileSync(join(top, "README.md"), "hi\n")
  git(top, "init", "-q")
  git(top, "add", "-A")
  git(top, "commit", "-qm", "first")
  for (const tree of trees) git(top, "worktree", "add", "-q", "-b", `b-${tree}`, join(root, tree))
  return top
}

test("a project's worktrees are its repository's own, and none of another's linked in their place", async () => {
  const mine = repository("mine", "mine-try")
  const theirs = repository("theirs", "theirs-try")
  expect(await linkedWorktrees(mine)).toEqual([join(root, "mine-try")])
  expect(await projectWorktrees(mine)).toEqual([join(root, "mine-try")])
  expect(await repositoryOf(join(root, "mine-try"))).toEqual({ top: join(root, "mine-try"), main: mine })
  // Its `.git/worktrees` traded for a link to another repository's: none of those is its.
  renameSync(join(mine, ".git", "worktrees"), join(mine, ".git", "wt"))
  symlinkSync(join(theirs, ".git", "worktrees"), join(mine, ".git", "worktrees"))
  expect(await linkedWorktrees(mine)).toEqual([])
  // Nor one entry in it linked to another's.
  rmSync(join(mine, ".git", "worktrees"))
  renameSync(join(mine, ".git", "wt"), join(mine, ".git", "worktrees"))
  symlinkSync(join(theirs, ".git", "worktrees", "theirs-try"), join(mine, ".git", "worktrees", "theirs-try"))
  expect(await linkedWorktrees(mine)).toEqual([join(root, "mine-try")])
})

test.skipIf(process.platform === "win32")("a FIFO where git keeps a worktree's file is never read: nothing waits on it", async () => {
  const fifo = repository("fifo")
  mkdirSync(join(fifo, ".git", "worktrees", "stuck"), { recursive: true })
  const made = spawnSync("mkfifo", [join(fifo, ".git", "worktrees", "stuck", "gitdir")])
  expect(made.status).toBe(0)
  expect(await linkedWorktrees(fifo)).toEqual([])
  // And a folder whose `.git` is one.
  mkdirSync(join(root, "fake"))
  expect(spawnSync("mkfifo", [join(root, "fake", ".git")]).status).toBe(0)
  expect(await repositoryOf(join(root, "fake"))).toBeNull()
}, 10_000)
