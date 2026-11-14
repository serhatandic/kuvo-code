import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ask, follow } from "./route-answer"

// A Changes panel's list, as every client draws it (PROTOCOL.md, "Changes", `git.files`): what git
// says changed in a session's folder, grouped (conflicts, staged, unstaged, new), a file partly
// staged in both; one file's diff alone (`git.changes.path`), a new file's too; and where a
// worktree's branch goes back (`git.branches.worktree`). Real repositories, in folders of their own.

const { engineHandler } = await import("../src/link/server/router")
const handler = engineHandler(() => { throw new Error("no engine") }, { name: "test" }, () => { throw new Error("none") })

let box: string
beforeAll(() => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-git-files-")))
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

const git = (folder: string, ...args: string[]) => {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false", ...args], {
    cwd: folder, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8",
  })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
  return ran.stdout
}

/** A repository with one commit: `app/Form.tsx` (three lines), `app/old.ts`, `README.md`. */
function repository(name: string) {
  const top = join(box, name)
  mkdirSync(join(top, "app"), { recursive: true })
  git(top, "init", "-q")
  writeFileSync(join(top, "app", "Form.tsx"), "one\ntwo\nthree\n")
  writeFileSync(join(top, "app", "old.ts"), "export const old = 1\n")
  writeFileSync(join(top, "README.md"), "# App\n")
  git(top, "add", "-A")
  git(top, "commit", "-q", "-m", "First")
  return top
}

const files = async (directory: string) => (await ask(handler, "GET", `kuvo/git/files?directory=${encodeURIComponent(directory)}`)).json

test("a folder's changes come grouped, a file partly staged in both groups, each with its scope and its lines", async () => {
  const top = repository("grouped")
  // Staged, then changed again: in both groups.
  writeFileSync(join(top, "app", "Form.tsx"), "one\n2\nthree\n")
  git(top, "add", "app/Form.tsx")
  writeFileSync(join(top, "app", "Form.tsx"), "one\n2\nthree\nfour\n")
  // Moved, staged.
  git(top, "mv", "app/old.ts", "app/new.ts")
  // Deleted, not staged.
  rmSync(join(top, "README.md"))
  // New, in a folder of its own.
  mkdirSync(join(top, "docs"))
  writeFileSync(join(top, "docs", "Plan 2.md"), "plan\n")

  const listed = await files(top)
  // A stamp for each that can be discarded, which a discard sends back.
  for (const file of listed.files) expect(typeof file.stamp).toBe("string")
  for (const file of listed.files) delete file.stamp
  expect(listed).toEqual({
    repository: true, root: top, branch: "main", uncommitted: true, commits: "staged", stagedElsewhere: 0,
    files: [
      { path: "app/Form.tsx", group: "staged", status: "modified", scope: "staged", additions: 1, deletions: 1, discard: "head" },
      { path: "app/new.ts", oldPath: "app/old.ts", group: "staged", status: "renamed", scope: "staged", additions: 0, deletions: 0, discard: "head" },
      { path: "app/Form.tsx", group: "unstaged", status: "modified", scope: "unstaged", additions: 1, deletions: 0, discard: "unstaged" },
      { path: "README.md", group: "unstaged", status: "deleted", scope: "unstaged", additions: 0, deletions: 1, discard: "unstaged" },
      { path: "docs/Plan 2.md", group: "untracked", status: "added", scope: "unstaged", discard: "trash" },
    ],
  })

  // From a folder in it: only that folder's, by their paths in the repository.
  const inApp = await files(join(top, "app"))
  expect(inApp.files.map((file: any) => `${file.group} ${file.path}`)).toEqual(["staged app/Form.tsx", "staged app/new.ts", "unstaged app/Form.tsx"])

  // Nothing changed: an empty list, nothing uncommitted; outside a repository, none.
  const clean = repository("clean")
  expect(await files(clean)).toEqual({ repository: true, root: clean, branch: "main", files: [], uncommitted: false, commits: "all", stagedElsewhere: 0 })
  mkdirSync(join(box, "plain"))
  expect(await files(join(box, "plain"))).toEqual({ repository: false })
  expect((await ask(handler, "GET", `kuvo/git/files?directory=${encodeURIComponent(join(box, "gone"))}`)).status).toBe(404)
})

test("a file both sides changed in a merge is a conflict, once, and nothing else lists it", async () => {
  const top = repository("conflict")
  git(top, "switch", "-q", "-c", "other")
  writeFileSync(join(top, "app", "Form.tsx"), "one\nTWO\nthree\n")
  git(top, "commit", "-q", "-am", "Other")
  git(top, "switch", "-q", "main")
  writeFileSync(join(top, "app", "Form.tsx"), "one\nzwei\nthree\n")
  git(top, "commit", "-q", "-am", "Main")
  spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "other"], { cwd: top, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })

  const listed = await files(top)
  expect(listed.files).toEqual([{ path: "app/Form.tsx", group: "conflicted", status: "modified", scope: "uncommitted" }])
  expect(listed.underway).toBe("merging")
})

test("names with spaces are read whole, a move's both sides; a new file staged goes to the Trash; a repository inside says so", async () => {
  const top = repository("spaces")
  writeFileSync(join(top, "app", "My Form.tsx"), "a\n")
  git(top, "add", "-A")
  git(top, "commit", "-q", "-m", "Spaces")
  git(top, "mv", "app/My Form.tsx", "app/Your  Form.tsx")
  writeFileSync(join(top, "a b.ts"), "x\n")
  git(top, "add", "a b.ts")
  mkdirSync(join(top, "web"))
  git(join(top, "web"), "init", "-q")
  writeFileSync(join(top, "web", "index.html"), "<p>hi</p>\n")
  git(join(top, "web"), "add", "-A")
  git(join(top, "web"), "commit", "-q", "-m", "Web")

  const listed = await files(top)
  for (const file of listed.files) delete file.stamp
  expect(listed.files).toEqual([
    { path: "a b.ts", group: "staged", status: "added", scope: "staged", additions: 1, deletions: 0, discard: "trash" },
    { path: "app/Your  Form.tsx", oldPath: "app/My Form.tsx", group: "staged", status: "renamed", scope: "staged", additions: 0, deletions: 0, discard: "head" },
    { path: "web/", group: "untracked", status: "added", scope: "unstaged", discard: "trash", repository: true },
  ])
})

test("one file's diff comes alone, a move with where it was, and a new file as all its lines", async () => {
  const top = repository("one-file")
  writeFileSync(join(top, "app", "Form.tsx"), "one\n2\nthree\n")
  writeFileSync(join(top, "README.md"), "# App\nMore.\n")
  git(top, "mv", "app/old.ts", "app/new.ts")
  writeFileSync(join(top, "notes.txt"), "first\nsecond\n")

  const diff = async (body: Record<string, unknown>) => (await ask(handler, "POST", "kuvo/git/changes", { directory: top, ...body })).json
  const form = await diff({ scope: "unstaged", path: "app/Form.tsx" })
  expect(form.patch).toContain("diff --git a/app/Form.tsx b/app/Form.tsx")
  expect(form.patch).toContain("-two\n+2\n")
  expect(form.patch).not.toContain("README.md")
  expect(form.untracked).toEqual([])

  const moved = await diff({ scope: "staged", path: "app/new.ts", oldPath: "app/old.ts" })
  expect(moved.patch).toContain("rename from app/old.ts")
  expect(moved.patch).toContain("rename to app/new.ts")

  const added = await diff({ scope: "unstaged", path: "notes.txt" })
  expect(added.patch).toContain("new file mode")
  expect(added.patch).toContain("+first\n+second\n")

  // Binary, and too big to show.
  writeFileSync(join(top, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 1]))
  expect((await diff({ scope: "unstaged", path: "logo.png" })).patch).toContain("Binary files")
  writeFileSync(join(top, "huge.txt"), "x".repeat(5 * 1024 * 1024))
  expect(await diff({ scope: "unstaged", path: "huge.txt" })).toMatchObject({ patch: "", big: true })

  // Not one in the repository: refused, saying so.
  expect((await ask(handler, "POST", "kuvo/git/changes", { directory: top, path: "../elsewhere" })).status).toBe(400)
})

test("a worktree's branches say where Merge into… takes it; the project's own folder says nothing of one", async () => {
  const top = repository("project")
  const tree = join(box, "project-tree")
  git(top, "worktree", "add", "-q", "-b", "kuvo/fix-form", tree)

  const branches = async (directory: string) => (await ask(handler, "POST", "kuvo/git/branches", { directory })).json
  const inTree = await branches(tree)
  expect(inTree.current).toBe("kuvo/fix-form")
  expect(inTree.worktree).toEqual({ into: "main" })
  const inProject = await branches(top)
  expect(inProject.current).toBe("main")
  expect(inProject.worktree).toBeUndefined()
})

test("followed, the list comes again as soon as something is staged", async () => {
  const top = repository("followed")
  writeFileSync(join(top, "README.md"), "# App\nMore.\n")
  const stream = follow(handler, `kuvo/git/files/events?directory=${encodeURIComponent(top)}`)
  try {
    expect((await stream.next()).files.map((file: any) => file.group)).toEqual(["unstaged"])
    git(top, "add", "README.md")
    expect((await stream.next()).files.map((file: any) => file.group)).toEqual(["staged"])
  } finally {
    stream.stop()
  }
})

test("a Files panel's folder leaves out version control's own folder, and says why one can't be read", async () => {
  const top = repository("listed")
  writeFileSync(join(top, ".env"), "X=1\n")
  const { json } = await ask(handler, "GET", `kuvo/folders?path=${encodeURIComponent(top)}&files=1&hidden=1`)
  expect(json.folders).toEqual([{ name: "app" }])
  expect(json.files).toEqual([".env", "README.md"])
  // Asked for folders alone (a folder to choose), `.git` is still there.
  const chosen = await ask(handler, "GET", `kuvo/folders?path=${encodeURIComponent(top)}&hidden=1`)
  expect(chosen.json.folders.map((folder: any) => folder.name)).toEqual([".git", "app"])
  const gone = await ask(handler, "GET", `kuvo/folders?path=${encodeURIComponent(join(top, "nowhere"))}&files=1`)
  expect(gone.status).toBe(404)
  expect(gone.json.reason).toBe("No such folder")
})

const discard = async (file: any, stamp = file.stamp) =>
  ask(handler, "POST", "kuvo/git/discard", { root: file.root, path: file.path, status: file.status, scope: file.scope, ...(stamp ? { stamp } : {}) })

test("what a commit takes is said for the whole repository, a staged file outside the folder counted", async () => {
  const top = repository("inside")
  mkdirSync(join(top, "other"))
  writeFileSync(join(top, "other", "x.ts"), "x\n")
  git(top, "add", "other/x.ts")
  writeFileSync(join(top, "app", "Form.tsx"), "changed\n")
  // Only the folder's own file changed, but another folder's is staged: a commit takes that one.
  const app = await files(join(top, "app"))
  expect(app.files.map((file: any) => file.group)).toEqual(["unstaged"])
  expect(app.commits).toBe("staged")
  expect(app.stagedElsewhere).toBe(1)
  // Staged in both: it takes both, one of them outside.
  git(top, "add", "app/Form.tsx")
  const both = await files(join(top, "app"))
  expect([both.commits, both.stagedElsewhere, both.files.length]).toEqual(["staged", 1, 1])
})

test("a discard is refused once its file changed since it was listed, and a new file committed since isn't trashed", async () => {
  const top = repository("stale")
  writeFileSync(join(top, "notes.txt"), "mine\n")
  writeFileSync(join(top, "README.md"), "# App\nOne edit.\n")
  const listed = await files(top)
  const note = { ...listed.files.find((file: any) => file.path === "notes.txt"), root: top }
  const readme = { ...listed.files.find((file: any) => file.path === "README.md"), root: top }

  // An agent commits the new file, then edits the README again.
  git(top, "add", "notes.txt")
  git(top, "commit", "-q", "-m", "Notes")
  writeFileSync(join(top, "README.md"), "# App\nOne edit.\nThe agent's later edit.\n")
  const trashed = await discard(note, undefined)
  expect(trashed.status).toBe(409)
  expect(readFileSync(join(top, "notes.txt"), "utf8")).toBe("mine\n")
  const edited = await discard(readme)
  expect(edited.status).toBe(409)
  expect(readFileSync(join(top, "README.md"), "utf8")).toContain("The agent's later edit.")

  // Listed again, as it is now: it goes.
  const again = { ...(await files(top)).files.find((file: any) => file.path === "README.md"), root: top }
  expect((await discard(again)).status).toBe(200)
  expect(readFileSync(join(top, "README.md"), "utf8")).toBe("# App\n")
})

test("discarding a staged deletion of a file still there keeps what was on disk in the Trash", async () => {
  const top = repository("deleted")
  const trash = join(box, "trash")
  process.env.KUVO_CHANGES_TRASH = trash
  try {
    git(top, "rm", "-q", "--cached", "README.md")
    writeFileSync(join(top, "README.md"), "# App\nEdits of mine.\n")
    const row = { ...(await files(top)).files.find((file: any) => file.group === "staged"), root: top }
    expect([row.status, row.discard]).toEqual(["deleted", "head"])
    expect((await discard(row)).status).toBe(200)
    expect(readFileSync(join(top, "README.md"), "utf8")).toBe("# App\n")
    const kept = spawnSync("grep", ["-rl", "Edits of mine.", trash], { encoding: "utf8" }).stdout.trim()
    expect(kept).not.toBe("")
  } finally {
    delete process.env.KUVO_CHANGES_TRASH
  }
})

test("new files past the most a list names are counted, and a big file's diff isn't read", async () => {
  const top = repository("many")
  mkdirSync(join(top, "out"))
  for (let at = 0; at < 1_005; at++) writeFileSync(join(top, "out", `f${at}.txt`), "x\n")
  const listed = await files(top)
  expect(listed.files.length).toBe(1_000)
  expect(listed.more).toBe(5)
  rmSync(join(top, "out"), { recursive: true, force: true })
  writeFileSync(join(top, "big.txt"), "x\n".repeat(3 * 1024 * 1024))
  git(top, "add", "big.txt")
  git(top, "commit", "-q", "-m", "Big")
  writeFileSync(join(top, "big.txt"), "y\n".repeat(3 * 1024 * 1024))
  const diff = (await ask(handler, "POST", "kuvo/git/changes", { directory: top, scope: "unstaged", path: "big.txt" })).json
  expect(diff).toMatchObject({ patch: "", big: true })
})

test("a linked worktree's .git file isn't listed in its Files", async () => {
  const top = repository("linked")
  const tree = join(box, "linked-tree")
  git(top, "worktree", "add", "-q", "-b", "side", tree)
  const { json } = await ask(handler, "GET", `kuvo/folders?path=${encodeURIComponent(tree)}&files=1&hidden=1`)
  expect(json.files).toEqual(["README.md"])
})
