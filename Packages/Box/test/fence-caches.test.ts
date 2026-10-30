// On Linux, a tool's cache that isn't there yet (a fresh machine's first `npm install` or `go
// build`): the sandbox's commands make it as the tool first runs, as they do on a Mac.

import { afterAll, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realFence } from "./agents/support/fence"

const linux = process.platform === "linux"
const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-fence-caches-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test.skipIf(!linux)("a tool's cache that isn't there yet is made as the tool first runs, and only for a tool that's there", () => {
  const home = join(root, "home")
  const project = join(root, "project")
  const tools = join(root, "tools")
  for (const folder of [home, project, tools]) mkdirSync(folder, { recursive: true })
  // npm is installed; Maven isn't.
  writeFileSync(join(tools, "npm"), "#!/bin/sh\nmkdir -p \"$HOME/.npm/_cacache\" && echo installed\n", { mode: 0o755 })
  const npm = join(home, ".npm")
  const m2 = join(home, ".m2")
  const folder = realFence(join(root, "kuvo"), [], {
    writable: ["/dev", npm, m2],
    made: [{ folder: npm, programs: ["npm"] }, { folder: m2, programs: ["mvn"] }],
  })
  const ran = spawnSync(join(root, "kuvo", "bin", "kuvo-fence"), ["-c", "npm install"], {
    cwd: project, encoding: "utf8",
    env: { PATH: `${tools}:/usr/bin:/bin`, HOME: home, KUVO_FENCE_WORK: project, KUVO_FENCE_RUNTIME: process.execPath },
  })
  expect(ran.stdout + ran.stderr).toContain("installed")
  expect(ran.status).toBe(0)
  expect(existsSync(join(npm, "_cacache"))).toBe(true)
  expect(existsSync(m2)).toBe(false)
  expect(existsSync(join(folder, "on"))).toBe(true)
})
