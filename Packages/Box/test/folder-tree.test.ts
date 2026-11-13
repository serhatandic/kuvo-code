import "./safety"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Every file under a folder (`kuvo/folders/tree`), past its cap: still git's list, so what the
// repository ignores (an install, a build) never fills it. A real repository, in a folder of its own.

let box: string
let folders: typeof import("../src/link/areas/folders")
beforeAll(async () => {
  box = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-folder-tree-")))
  folders = await import("../src/link/areas/folders")
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
