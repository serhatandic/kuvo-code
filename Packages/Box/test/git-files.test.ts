import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
  expect(listed).toEqual({
    repository: true, root: top, branch: "main", uncommitted: true,
    files: [
      { path: "app/Form.tsx", group: "staged", status: "modified", scope: "staged", additions: 1, deletions: 1 },
      { path: "app/new.ts", oldPath: "app/old.ts", group: "staged", status: "renamed", scope: "staged", additions: 0, deletions: 0 },
      { path: "app/Form.tsx", group: "unstaged", status: "modified", scope: "unstaged", additions: 1, deletions: 0 },
      { path: "README.md", group: "unstaged", status: "deleted", scope: "unstaged", additions: 0, deletions: 1 },
      { path: "docs/Plan 2.md", group: "untracked", status: "added", scope: "unstaged" },
    ],
  })

  // From a folder in it: only that folder's, by their paths in the repository.
  const inApp = await files(join(top, "app"))
  expect(inApp.files.map((file: any) => `${file.group} ${file.path}`)).toEqual(["staged app/Form.tsx", "staged app/new.ts", "unstaged app/Form.tsx"])

  // Nothing changed: an empty list, nothing uncommitted; outside a repository, none.
  const clean = repository("clean")
  expect(await files(clean)).toEqual({ repository: true, root: clean, branch: "main", files: [], uncommitted: false })
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
