import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// What an agent's turn can take from a repository, taken back from the box's backups: a hard reset,
// a deleted branch, dropped stashes, and `rm -rf .git`. Real repositories in folders of their own.

let box: string
let backups: typeof import("../src/link/work/backups")
beforeAll(async () => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-branch-backups-")))
  backups = await import("../src/link/work/backups")
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
function git(folder: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: folder, env: ENV, encoding: "utf8" })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout.trim()
}

let made = 0
/** A repository with two commits on main and a feature branch, and the store's folder of its own. */
function repository() {
  const top = join(box, `project-${++made}`)
  mkdirSync(top)
  git(top, "init", "-q")
  writeFileSync(join(top, "a.txt"), "one\n")
  git(top, "add", "-A")
  git(top, "commit", "-qm", "first")
  writeFileSync(join(top, "a.txt"), "two\n")
  git(top, "commit", "-qam", "second")
  git(top, "branch", "feature")
  git(top, "remote", "add", "origin", "https://someone:secret-token@example.com/project.git")
  return { top, root: join(box, `store-${made}`) }
}

test("a hard reset is taken back beside the branch, which stays where it is", async () => {
  const { top, root } = repository()
  const before = git(top, "rev-parse", "main")
  expect(await backups.takeBackup(top, root, 1_000)).not.toBeNull()
  git(top, "reset", "-q", "--hard", "HEAD~1")
  git(top, "branch", "-qD", "feature")
  // (Gone from what the repository keeps, as an agent's cleanup might leave it.)
  git(top, "reflog", "expire", "--expire=now", "--all")
  git(top, "gc", "-q", "--prune=now")
  expect(spawnSync("git", ["cat-file", "-e", before], { cwd: top }).status).not.toBe(0)

  const listed = await backups.listBackups(top, root)
  expect(listed.backups[0]).toMatchObject({ moved: ["main"], gone: ["feature"] })
  const restored = await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(restored.branches).toEqual([{ name: "feature", as: "feature" }, { name: "main", as: "main-restored-19700101-0000" }])
  expect(git(top, "rev-parse", "main-restored-19700101-0000")).toBe(before)
  expect(git(top, "rev-parse", "main")).not.toBe(before)
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("one\n")
})

test("a deleted branch comes back under its own name", async () => {
  const { top, root } = repository()
  writeFileSync(join(top, "b.txt"), "feature work\n")
  git(top, "switch", "-q", "feature")
  git(top, "add", "-A")
  git(top, "commit", "-qm", "feature work")
  const tip = git(top, "rev-parse", "feature")
  git(top, "switch", "-q", "main")
  await backups.takeBackup(top, root, 1_000)
  git(top, "branch", "-qD", "feature")

  const listed = await backups.listBackups(top, root)
  expect(listed.backups[0]?.gone).toEqual(["feature"])
  const restored = await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(restored.branches).toEqual([{ name: "feature", as: "feature" }])
  expect(git(top, "rev-parse", "feature")).toBe(tip)
})

test("dropped stashes come back on the list, newest on top, older ones too", async () => {
  const { top, root } = repository()
  writeFileSync(join(top, "a.txt"), "older change\n")
  git(top, "stash", "push", "-qm", "older")
  writeFileSync(join(top, "a.txt"), "newer change\n")
  git(top, "stash", "push", "-qm", "newer")
  await backups.takeBackup(top, root, 1_000)
  git(top, "stash", "clear")
  git(top, "gc", "-q", "--prune=now")

  const listed = await backups.listBackups(top, root)
  expect(listed.backups[0]?.stashesGone).toBe(2)
  expect((await backups.restoreBackup(top, listed.backups[0]!.id, root)).stashes).toBe(2)
  expect(git(top, "stash", "list", "--format=%gs")).toBe("On main: newer\nOn main: older")
  git(top, "stash", "pop", "-q", "stash@{1}")
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("older change\n")
})

test("rm -rf .git: the repository is made again around the files as they are", async () => {
  const { top, root } = repository()
  writeFileSync(join(top, "a.txt"), "uncommitted\n")
  await backups.takeBackup(top, root, 1_000)
  const main = git(top, "rev-parse", "main")
  rmSync(join(top, ".git"), { recursive: true, force: true })
  mkdirSync(join(top, "sub"))

  // Found from a folder in it, too.
  const listed = await backups.listBackups(join(top, "sub"), root)
  expect(listed).toMatchObject({ repository: top, exists: false })
  const restored = await backups.restoreBackup(join(top, "sub"), listed.backups[0]!.id, root)
  expect(restored.remade).toBe(true)
  expect(git(top, "rev-parse", "main")).toBe(main)
  expect(git(top, "rev-parse", "feature")).toBe(main)
  expect(git(top, "symbolic-ref", "HEAD")).toBe("refs/heads/main")
  // The files untouched, shown as the change they are; the remote without its sign-in.
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("uncommitted\n")
  expect(git(top, "status", "--porcelain", "--untracked-files=no")).toBe("M a.txt")
  expect(git(top, "remote", "get-url", "origin")).toBe("https://example.com/project.git")
})

test("a backup is taken only when something changed, and none is kept of what isn't a repository", async () => {
  const { top, root } = repository()
  expect(await backups.takeBackup(top, root, 1_000)).not.toBeNull()
  expect(await backups.takeBackup(top, root, 2_000)).toBeNull()
  git(top, "branch", "another")
  expect(await backups.takeBackup(top, root, 3_000)).not.toBeNull()
  expect((await backups.listBackups(top, root)).backups.map(each => each.at)).toEqual([3_000, 1_000])
  // The token in the remote's address is never kept.
  expect(readFileSync(join(root, readdirOne(root), "backups.json"), "utf8")).not.toContain("secret-token")

  const plain = join(box, "plain")
  mkdirSync(plain)
  expect(await backups.takeBackup(plain, join(box, "store-plain"), 1_000)).toBeNull()
  expect(existsSync(join(box, "store-plain"))).toBe(false)
})

test("a linked worktree's backups are its repository's", async () => {
  const { top, root } = repository()
  const linked = join(box, `linked-${made}`)
  git(top, "worktree", "add", "-q", "-b", "side", linked)
  await backups.takeBackup(linked, root, 1_000)
  expect((await backups.listBackups(top, root)).backups[0]?.branches).toBe(3)
})

test("old backups go, and what only they kept goes from the store", async () => {
  const { top, root } = repository()
  const day = 24 * 60 * 60 * 1000
  const shortLived = git(top, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "short-lived")
  git(top, "branch", "short-lived", shortLived)
  await backups.takeBackup(top, root, 0)
  git(top, "branch", "-qD", "short-lived")
  await backups.takeBackup(top, root, 31 * day)
  expect((await backups.listBackups(top, root)).backups.map(each => each.at)).toEqual([31 * day])
  const store = join(root, readdirOne(root), "store")
  expect(spawnSync("git", ["--git-dir", store, "show-ref", "--verify", "-q", `refs/kuvo/keep/${shortLived}`]).status).not.toBe(0)
})

test("a conversation's run backs up the repository it works in, from the folder the engine has for it", async () => {
  const { top } = repository()
  mkdirSync(join(top, "app"))
  // The engine's answer for the conversation, as it has it.
  const engine = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/session/ses_run"
    ? Response.json({ data: { id: "ses_run", location: { directory: join(top, "app") } } })
    : new Response("", { status: 404 }) })
  try {
    await backups.backUpSession({ port: engine.port!, password: "x" } as never, "ses_run")
    await backups.backUpSession({ port: engine.port!, password: "x" } as never, "ses_other")
  } finally {
    engine.stop(true)
  }
  const listed = await backups.listBackups(top)
  expect(listed.backups.length).toBe(1)
  expect(listed.backups[0]).toMatchObject({ head: "main", branches: 2, gone: [], moved: [] })
})

function readdirOne(folder: string): string {
  const found = spawnSync("ls", [folder], { encoding: "utf8" }).stdout.trim().split("\n")
  expect(found.length).toBe(1)
  return found[0]!
}
