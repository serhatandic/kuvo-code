import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Every file under a folder (`kuvo/folders/tree`), past its cap: still git's list, so what the
// repository ignores (an install, a build) never fills it. A real repository, in a folder of its own.

let box: string
let folders: typeof import("../src/link/areas/folders")
let gitTools: typeof import("../src/link/git")
beforeAll(async () => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-folder-tree-")))
  folders = await import("../src/link/areas/folders")
  gitTools = await import("../src/link/git")
})
afterAll(() => rmSync(box, { recursive: true, force: true }))

const git = (folder: string, ...args: string[]) => {
  const ran = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: folder, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" })
  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`)
}

test("a repository with more files than the list takes lists as many of git's, none it ignores", async () => {
  const top = join(box, "big")
  mkdirSync(join(top, "node_modules", "pkg"), { recursive: true })
  git(top, "init", "-q")
  writeFileSync(join(top, ".gitignore"), "node_modules/\n")
  for (let at = 0; at < 50; at++) writeFileSync(join(top, `file-${at}.txt`), `${at}\n`)
  for (let at = 0; at < 50; at++) writeFileSync(join(top, "node_modules", "pkg", `dep-${at}.js`), `${at}\n`)
  const listed = await folders.listTree(`kuvo/folders/tree?path=${encodeURIComponent(top)}`, 10)
  expect(listed.status).toBe(200)
  const value = listed.value as { files: string[]; git: boolean }
  expect(value.git).toBe(true)
  expect(value.files.length).toBe(10)
  expect(value.files.filter(name => name.startsWith("node_modules/"))).toEqual([])
})

/** A repository whose git waits for good (its index a FIFO no one writes), with a new file a walk
 * would list. */
function stuck(name: string) {
  const top = join(box, name)
  mkdirSync(top, { recursive: true })
  git(top, "init", "-q")
  writeFileSync(join(top, "new.txt"), "new\n")
  rmSync(join(top, ".git", "index"), { force: true })
  const made = spawnSync("mkfifo", [join(top, ".git", "index")])
  expect(made.status, made.error?.message ?? made.stderr?.toString() ?? "").toBe(0)
  return top
}

test("git that runs out of time is stopped, and what it gave is the list, never a walk that lists what it ignores", async () => {
  const top = stuck("slow")
  const ran = await gitTools.gitNamesLater(top, ["ls-files", "-z", "--cached", "--others"], 10, undefined, 200)
  expect(ran).toEqual({ names: [], complete: false })
  const listed = await folders.listTree(`kuvo/folders/tree?path=${encodeURIComponent(top)}`, 10, undefined, 200)
  expect(listed).toEqual({ status: 200, value: { path: top, files: [], git: true } })
}, 10_000)

test("a list no one asks for any longer stops git, and walks nothing", async () => {
  const top = stuck("gone")
  const asker = new AbortController()
  const listing = folders.listTree(`kuvo/folders/tree?path=${encodeURIComponent(top)}&dated=1`, 10, asker.signal)
  // Once git is waiting on its index (opening the FIFO to write meets git's reading), it's stopped.
  const writer = await open(join(top, ".git", "index"), "w")
  asker.abort()
  expect((await listing).status).toBe(503)
  await writer.close()
  const again = new AbortController()
  const ran = gitTools.gitNamesLater(top, ["ls-files", "-z", "--cached", "--others"], 10, again.signal)
  const second = await open(join(top, ".git", "index"), "w")
  again.abort()
  expect(await ran).toBeNull()
  await second.close()
  // Asked already stopped: git never starts.
  expect(await folders.listTree(`kuvo/folders/tree?path=${encodeURIComponent(top)}`, 10, asker.signal)).toMatchObject({ status: 503 })
}, 10_000)
