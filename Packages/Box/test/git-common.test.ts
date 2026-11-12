import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Where git takes a repository's settings and hooks from: its `commondir`, when it has one. A
// repository's own names none, or itself (`.`, which the sandbox gives one on Linux, #429), and a
// linked worktree's names the repository it's one of. One that leads anywhere else was put there to
// have git run another's settings' programs and hooks, so the box runs no git there that could
// start one: neither what it reads by itself nor what you ask for (Changes' Commit).

let box: string
let shared: typeof import("../src/shared/git")
let changes: typeof import("../src/link/areas/changes")
beforeAll(async () => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-git-common-")))
  shared = await import("../src/shared/git")
  changes = await import("../src/link/areas/changes")
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

const AUTHOR = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
function git(folder: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: folder, env: { ...process.env, ...AUTHOR }, encoding: "utf8" })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout.trim()
}

let made = 0
/** A repository with a commit and a file changed since; `commondir`, what its own says, if anything. */
function repository(commondir?: string): string {
  const top = join(box, `repo-${++made}`)
  mkdirSync(top)
  git(top, "init", "-q")
  writeFileSync(join(top, "a.txt"), "one\n")
  git(top, "add", ".")
  git(top, "commit", "-q", "-m", "first")
  writeFileSync(join(top, "a.txt"), "two\n")
  if (commondir !== undefined) writeFileSync(join(top, ".git", "commondir"), commondir)
  return top
}

/** A copy of `top`'s repository whose settings and hooks leave a mark when they run, and that mark. */
function planted(top: string): { elsewhere: string; mark: string } {
  const elsewhere = join(box, `elsewhere-${made}`)
  const mark = join(box, `mark-${made}`)
  git(top, "clone", "-q", "--bare", ".", elsewhere)
  git(elsewhere, "config", "core.bare", "false")
  git(elsewhere, "config", "core.fsmonitor", `touch '${mark}'; false`)
  for (const hook of ["pre-commit", "post-commit", "commit-msg"]) {
    writeFileSync(join(elsewhere, "hooks", hook), `#!/bin/sh\ntouch '${mark}'\n`)
    chmodSync(join(elsewhere, "hooks", hook), 0o755)
  }
  return { elsewhere, mark }
}

test("a repository whose commondir leads to another's: the box runs no git there that could start a program", async () => {
  const top = repository()
  const { elsewhere, mark } = planted(top)
  writeFileSync(join(top, ".git", "commondir"), `${elsewhere}\n`)
  expect(shared.ownArgs(["status", "--porcelain"], top)).toBeUndefined()
  expect(await shared.ownArgsLater(["-C", top, "diff"])).toBeUndefined()
  expect(shared.askedArgs(["commit", "-m", "x"], top)).toBeUndefined()
  expect(await shared.askedArgsLater(["commit", "-m", "x"], top)).toBeUndefined()
  expect(await changes.commit(top, "second", false, AUTHOR)).toMatchObject({ committed: false })
  await changes.changesIn(top, "uncommitted")
  expect(existsSync(mark)).toBe(false)
  // (git itself, as your terminal runs it, would have.)
  spawnSync("git", ["status"], { cwd: top, env: { ...process.env, ...AUTHOR } })
  expect(existsSync(mark)).toBe(true)
})

test("a folder whose broken .git has a bare repository made around it: the box runs no git there that could start a program", async () => {
  const top = repository()
  const { elsewhere, mark } = planted(top)
  writeFileSync(join(top, ".git", "HEAD"), "broken\n")
  for (const name of ["HEAD", "config", "hooks", "objects", "refs"]) spawnSync("cp", ["-R", join(elsewhere, name), join(top, name)])
  git(top, "--git-dir=.", "config", "core.bare", "false")
  git(top, "--git-dir=.", "config", "core.worktree", top)
  expect(shared.askedArgs(["commit", "-m", "x"], top)).toBeUndefined()
  expect(await shared.askedArgsLater(["commit", "-m", "x"], top)).toBeUndefined()
  expect(await changes.commit(top, "second", false, AUTHOR)).toMatchObject({ committed: false })
  expect(existsSync(mark)).toBe(false)
  // (git itself, as your terminal runs it, takes it for one.)
  spawnSync("git", ["status"], { cwd: top, env: { ...process.env, ...AUTHOR } })
  expect(existsSync(mark)).toBe(true)
})

test("a repository's own commondir naming itself, or none, and a worktree's naming its repository, are as ever", async () => {
  const own = repository(".\n")
  const none = repository()
  const tree = join(box, "tree")
  git(none, "worktree", "add", "-q", "-b", "try", tree)
  for (const folder of [own, none, tree]) {
    expect(shared.ownArgs(["status", "--porcelain"], folder)).toBeDefined()
    expect(await shared.askedArgsLater(["commit", "-m", "x"], folder)).toBeDefined()
  }
  expect(await changes.commit(own, "second", false, AUTHOR)).toBeNull()
  writeFileSync(join(tree, "a.txt"), "three\n")
  expect(await changes.commit(tree, "in the worktree", false, AUTHOR)).toBeNull()
  // A worktree whose own folder's commondir leads to another repository isn't.
  const { elsewhere } = planted(none)
  writeFileSync(join(none, ".git", "worktrees", "tree", "commondir"), `${elsewhere}\n`)
  expect(shared.askedArgs(["commit", "-m", "x"], tree)).toBeUndefined()
  // Nor does one that makes a repository have any to ask about.
  expect(shared.askedArgs(["clone", "--quiet", "--", own, join(box, "cloned")], own)).toBeDefined()
})
