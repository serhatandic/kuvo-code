import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A repository whose own settings name programs (an fsmonitor, hooks, filters, diff programs, a
// pager, a signature check), as a downloaded folder or an agent outside the sandbox could leave
// one: the box reading its changes, keeping it and taking it back starts none of them; what you
// ask for yourself (staging, a commit) runs its hooks and filters as your terminal would. Real
// repositories, in folders of their own.

let box: string
let changes: typeof import("../src/link/areas/changes")
let backups: typeof import("../src/link/work/backups")
let reviews: typeof import("../src/agents/reviews")
let snapshots: typeof import("../src/agents/snapshots")
beforeAll(async () => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-git-programs-")))
  changes = await import("../src/link/areas/changes")
  backups = await import("../src/link/work/backups")
  reviews = await import("../src/agents/reviews")
  snapshots = await import("../src/agents/snapshots")
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
const AUTHOR = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }
function git(folder: string, ...args: string[]): string {
  // (Never starting the programs planted: what's marked, the box started.)
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "-c", "hook.planted.enabled=false", "-c", "core.fsmonitor=false", ...args], { cwd: folder, env: { ...ENV, PATH: process.env.PATH }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout.trim()
}

let made = 0
/** A repository with a commit, then its settings naming a program for everything git can start,
 * each leaving a mark when it runs (a filter or diff program passing what it's given through),
 * and a file changed since. `driver`: the name its attributes give the file's programs. */
function planted(driver = "evil") {
  const top = join(box, `project-${++made}`)
  const programs = join(box, `programs-${made}`)
  const marks = join(box, `marks-${made}`)
  for (const folder of [top, programs, marks, join(programs, "hooks")]) mkdirSync(folder)
  git(top, "init", "-q")
  writeFileSync(join(top, "a.txt"), "one\n")
  writeFileSync(join(top, ".gitattributes"), `a.txt filter=${driver} diff=${driver} merge=${driver}\n`)
  git(top, "add", "-A")
  git(top, "commit", "-qm", "first")
  const program = (name: string, then = "exit 0") => {
    const file = join(programs, name)
    writeFileSync(file, `#!/bin/sh\ntouch "${marks}/${name.replace("/", "-")}"\n${then}\n`)
    chmodSync(file, 0o755)
    return file
  }
  for (const hook of ["pre-commit", "post-commit", "post-checkout", "pre-auto-gc", "reference-transaction"]) program(`hooks/${hook}`)
  git(top, "config", "core.fsmonitor", program("fsmonitor"))
  git(top, "config", "core.hooksPath", join(programs, "hooks"))
  // And hooks named in its settings (git 2.54 and later run them), for whatever writes a ref or the index.
  git(top, "config", "hook.planted.command", program("hook-setting"))
  for (const event of ["reference-transaction", "post-index-change", "pre-commit", "post-checkout"]) git(top, "config", "--add", "hook.planted.event", event)
  git(top, "config", "core.pager", program("pager", "cat"))
  git(top, "config", "diff.external", program("external"))
  git(top, "config", "log.showSignature", "true")
  git(top, "config", "gpg.program", program("gpg"))
  git(top, "config", `filter.${driver}.clean`, program("clean", "cat"))
  git(top, "config", `filter.${driver}.smudge`, program("smudge", "cat"))
  git(top, "config", `filter.${driver}.required`, "true")
  git(top, "config", `merge.${driver}.driver`, program("merge"))
  // Its diff programs in a file its settings include, as a repository's own too.
  writeFileSync(join(programs, "more.config"), `[diff "${driver}"]\n\ttextconv = ${program("textconv", 'cat "$1"')}\n\tcommand = ${program("command")}\n`)
  git(top, "config", "include.path", join(programs, "more.config"))
  writeFileSync(join(top, "a.txt"), "one\ntwo, longer\n")
  return { top, marks, ran: () => readdirSync(marks).sort() }
}

// Whether this git runs hooks named in settings.
const settingsHooks = (() => {
  const folder = mkdtempSync(join(tmpdir(), "kuvo-git-hooks-"))
  try {
    spawnSync("git", ["init", "-q"], { cwd: folder })
    const ran = spawnSync("git", ["-c", "hook.probe.command=echo ran", "-c", "hook.probe.event=reference-transaction", "update-ref", "refs/probe", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"], { cwd: folder, encoding: "utf8" })
    return ran.stdout.includes("ran") || ran.stderr.includes("ran")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})()

test("the repository's programs are really there: git itself runs them", () => {
  const { top, ran } = planted()
  spawnSync("git", ["status", "--porcelain"], { cwd: top, stdio: "ignore" })
  spawnSync("git", ["diff"], { cwd: top, stdio: "ignore" })
  spawnSync("git", ["branch", "control"], { cwd: top, stdio: "ignore" })
  expect(ran()).toEqual(expect.arrayContaining(["clean", "command", "fsmonitor", ...(settingsHooks ? ["hook-setting"] : [])]))
})

test("Changes reads what changed in it without starting any of them", async () => {
  const { top, ran } = planted()
  const found = await changes.changesIn(top, "uncommitted")
  expect(JSON.stringify(found)).toContain("a.txt")
  expect((await changes.commitDiff(top)).diff).toContain("+two, longer")
  expect(await changes.countIn(top, "uncommitted")).toMatchObject({ repository: true, files: 1, additions: 1, deletions: 0 })
  expect(ran()).toEqual([])
})

test("a review reads its changes without starting any of them", async () => {
  const { top, ran } = planted()
  const read = await reviews.readScope(top, { kind: "uncommitted" })
  expect(JSON.stringify(read)).toContain("two, longer")
  expect(ran()).toEqual([])
})

test("Undo keeps its files and puts them back without starting any of them", async () => {
  const { top, ran } = planted()
  const kept = new snapshots.Snapshots(join(box, `snapshots-${made}`))
  const tree = await kept.take(top)
  writeFileSync(join(top, "a.txt"), "three\n")
  await kept.restore(top, tree!, ["a.txt"])
  expect(readFileSync(join(top, "a.txt"), "utf8")).toBe("one\ntwo, longer\n")
  expect(ran()).toEqual([])
})

test("its branches are backed up and taken back without starting any of them", async () => {
  const { top, ran } = planted()
  const root = join(box, `backups-${made}`)
  git(top, "branch", "feature")
  expect(await backups.takeBackup(top, root, 1_000)).not.toBeNull()
  git(top, "branch", "-qD", "feature")
  const listed = await backups.listBackups(top, root)
  expect(listed.backups[0]?.gone).toEqual(["feature"])
  const restored = await backups.restoreBackup(top, listed.backups[0]!.id, root)
  expect(restored.branches).toEqual([{ name: "feature", as: "feature" }])
  expect(ran()).toEqual([])
})

test("what you stage and commit yourself runs its filters and hooks, as your terminal would, but no fsmonitor or pager", async () => {
  const { top, ran } = planted()
  expect(await changes.perform("stage", top, { path: "a.txt", status: "modified" }, "unstaged")).toBeNull()
  expect(await changes.commit(top, "second", false, AUTHOR)).toBeNull()
  expect(ran()).toEqual(expect.arrayContaining(["clean", "hooks-pre-commit", "hooks-post-commit", ...(settingsHooks ? ["hook-setting"] : [])]))
  expect(ran()).not.toContain("fsmonitor")
  expect(ran()).not.toContain("pager")
})

test("a file git-lfs or git-crypt keeps isn't shown as changed when it isn't, and a program of the same name elsewhere doesn't run", async () => {
  const { top, ran } = planted()
  const marks = join(box, `marks-${made}`)
  // git-lfs as installed (what it keeps is stored as it makes it, here in capitals), and one the
  // repository brought along under the same name.
  const tools = join(box, `tools-${made}`)
  const brought = join(box, `brought-${made}`)
  for (const folder of [tools, brought]) mkdirSync(folder)
  writeFileSync(join(tools, "git-lfs"), `#!/bin/sh\ncase "$1" in clean) tr a-z A-Z ;; *) cat ;; esac\n`)
  writeFileSync(join(brought, "git-lfs"), `#!/bin/sh\ntouch "${marks}/brought"\ncat\n`)
  for (const folder of [tools, brought]) chmodSync(join(folder, "git-lfs"), 0o755)
  const was = process.env.PATH
  process.env.PATH = `${tools}:${was}`
  try {
    git(top, "config", "filter.kept.clean", "git-lfs clean -- %f")
    git(top, "config", "filter.kept.smudge", "git-lfs smudge -- %f")
    git(top, "config", "filter.kept.required", "true")
    git(top, "config", "filter.other.clean", `"${join(brought, "git-lfs")}" clean -- %f`)
    writeFileSync(join(top, ".gitattributes"), "big.bin filter=kept\nother.txt filter=other\n")
    writeFileSync(join(top, "big.bin"), "big\n")
    writeFileSync(join(top, "other.txt"), "other\n")
    git(top, "add", "-A")
    git(top, "commit", "-qm", "kept by git-lfs")
    expect(git(top, "cat-file", "blob", "HEAD:big.bin")).toBe("BIG")
    // Touched since, unchanged: only the filter tells.
    for (const file of ["big.bin", "other.txt"]) utimesSync(join(top, file), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))
    rmSync(marks, { recursive: true })
    mkdirSync(marks)

    expect(await changes.changesIn(top, "uncommitted")).toMatchObject({ repository: true, patch: "", untracked: [] })
    expect(ran()).toEqual([])
  } finally {
    process.env.PATH = was
  }
})

test("one whose program has a name its settings can't switch off isn't read at all", async () => {
  const { top, ran } = planted("x=y")
  spawnSync("git", ["-c", "core.fsmonitor=false", "diff", "--no-ext-diff"], { cwd: top, stdio: "ignore" })
  expect(ran()).toContain("textconv")
  rmSync(join(top, "..", `marks-${made}`), { recursive: true })
  mkdirSync(join(top, "..", `marks-${made}`))

  const found = await changes.changesIn(top, "uncommitted")
  expect(JSON.stringify(found ?? {})).not.toContain("two, longer")
  expect(ran()).toEqual([])
})
