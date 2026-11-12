import "./safety"
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// What an agent's turn can take from a repository, taken back from the box's backups: a hard reset,
// a deleted branch, dropped stashes, and `rm -rf .git`. Real repositories in folders of their own.

// Each test runs a dozen git programs of its own, waiting on each: about 0.2–0.7 s on a quiet Mac,
// and over Bun's 5 s when it is busy (24 copies at once on this 12-core Mac: 1 of 24 runs timed out
// at 5.0 s, "a hard reset is taken back…", its file's tests reaching 18.8 s). So a busy machine gets
// as long as the work takes, not 5 s.
setDefaultTimeout(30_000)

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
  git(top, "remote", "add", "origin", "https://someone:secret@token@example.com/project.git?access_token=secret-token")
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

// What a tampered repository could make the box run, as backups are taken and taken back.
function planted(name: string): { script: string; marker: string } {
  const marker = join(box, `${name}-ran`)
  const script = join(box, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  return { script, marker }
}

test("a tampered repository's settings run nothing as a backup is taken", async () => {
  const { top, root } = repository()
  const { script, marker } = planted("signature")
  // A stash entry with a signature, and settings that would check it with a program of its own.
  const tree = git(top, "rev-parse", "HEAD^{tree}")
  const parent = git(top, "rev-parse", "HEAD")
  const signed = `tree ${tree}\nparent ${parent}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n x\n -----END PGP SIGNATURE-----\n\nsigned\n`
  const commit = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: top, input: signed, encoding: "utf8", env: ENV }).stdout.trim()
  git(top, "update-ref", "--create-reflog", "-m", "On main: signed", "refs/stash", commit)
  git(top, "config", "log.showSignature", "true")
  git(top, "config", "gpg.program", script)
  expect(await backups.takeBackup(top, root, 1_000)).not.toBeNull()
  expect(existsSync(marker)).toBe(false)
})

test("taking one back reaches only the box's store, whatever the repository's settings say", async () => {
  const { top, root } = repository()
  const main = git(top, "rev-parse", "main")
  await backups.takeBackup(top, root, 1_000)
  git(top, "branch", "-qD", "feature")
  const { marker } = planted("transport")
  const store = join(root, readdirOne(root), "store")
  git(top, "config", "protocol.ext.allow", "always")
  git(top, "config", `url.ext::sh -c touch% ${marker}% #.insteadOf`, store)
  const listed = await backups.listBackups(top, root)
  await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(existsSync(marker)).toBe(false)
  expect(git(top, "rev-parse", "feature")).toBe(main)
})

test("a branch that would clash with one you have now comes back under a name of its own, and all of it comes back", async () => {
  const { top, root } = repository()
  writeFileSync(join(top, "a.txt"), "stashed\n")
  git(top, "stash", "push", "-qm", "kept")
  git(top, "branch", "other")
  await backups.takeBackup(top, root, 1_000)
  git(top, "branch", "-qD", "feature")
  git(top, "branch", "-qD", "other")
  git(top, "branch", "feature/x")
  git(top, "stash", "clear")
  const listed = await backups.listBackups(top, root)
  const restored = await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(restored.branches).toEqual([{ name: "feature", as: "feature-2" }, { name: "other", as: "other" }])
  expect(restored.stashes).toBe(1)
  expect(git(top, "stash", "list", "--format=%gs")).toBe("On main: kept")
  expect(git(top, "for-each-ref", "--format=%(refname)", "refs/kuvo-restoring")).toBe("")
})

test("rm -rf .git in a SHA-256 repository: made again as one", async () => {
  const top = join(box, `project-${++made}`)
  const root = join(box, `store-${made}`)
  mkdirSync(top)
  git(top, "init", "-q", "--object-format=sha256")
  writeFileSync(join(top, "a.txt"), "one\n")
  git(top, "add", "-A")
  git(top, "commit", "-qm", "first")
  const main = git(top, "rev-parse", "main")
  await backups.takeBackup(top, root, 1_000)
  rmSync(join(top, ".git"), { recursive: true, force: true })
  const listed = await backups.listBackups(top, root)
  expect((await backups.restoreBackup(top, listed.backups[0]!.id, root)).remade).toBe(true)
  expect(git(top, "rev-parse", "main")).toBe(main)
  expect(git(top, "status", "--porcelain")).toBe("")
})

test("rm -rf .git in a shallow clone: made again, as shallow as it was", async () => {
  const { top: source } = repository()
  const top = join(box, `shallow-${made}`)
  const root = join(box, `store-shallow-${made}`)
  git(box, "clone", "-q", "--depth=1", `file://${source}`, top)
  const main = git(top, "rev-parse", "main")
  await backups.takeBackup(top, root, 1_000)
  rmSync(join(top, ".git"), { recursive: true, force: true })
  const listed = await backups.listBackups(top, root)
  expect((await backups.restoreBackup(top, listed.backups[0]!.id, root)).remade).toBe(true)
  expect(git(top, "rev-parse", "main")).toBe(main)
  expect(git(top, "log", "--format=%s")).toBe("second")
  expect(git(top, "status", "--porcelain")).toBe("")
})

test("a linked worktree's detached checkout is kept too, and comes back as a branch", async () => {
  const { top, root } = repository()
  const linked = join(box, `detached-${made}`)
  git(top, "worktree", "add", "-q", "--detach", linked)
  writeFileSync(join(linked, "c.txt"), "agent work\n")
  git(linked, "add", "-A")
  git(linked, "commit", "-qm", "work on no branch")
  const work = git(linked, "rev-parse", "HEAD")
  await backups.takeBackup(linked, root, 1_000)
  git(top, "worktree", "remove", "--force", linked)
  const listed = await backups.listBackups(top, root)
  const restored = await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(restored.branches).toEqual([{ name: "", as: "detached-restored-19700101-0000" }])
  expect(git(top, "rev-parse", "detached-restored-19700101-0000")).toBe(work)
})

function readdirOne(folder: string): string {
  const found = spawnSync("ls", [folder], { encoding: "utf8" }).stdout.trim().split("\n")
  expect(found.length).toBe(1)
  return found[0]!
}
