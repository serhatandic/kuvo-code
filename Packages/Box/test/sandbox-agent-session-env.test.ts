import "./safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fenceAgent } from "../src/agents/fence"
import { canFence, realFence } from "./agents/support/fence"

// Claude Code makes `session-env/<conversation>` in its settings folder before each SessionStart
// hook, names the hook a file there, and runs what's in that folder before each command. Your own
// Claude Code, outside the sandbox, runs the same files if you open that conversation yourself. So
// in the sandbox that folder is only there, made by the bridge (claude.ts `environment`): making it
// again works, so the hook starts, and nothing can be written in it, its neighbours or beside them.
test.skipIf(!canFence || process.platform !== "darwin")("Claude Code finds its conversation's environment made, so its hooks start, and can't leave anything there for your own Claude Code to run", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-session-env-")))
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home", ".claude")
    const project = join(root, "project")
    const environments = join(home, "session-env")
    const mine = join(environments, "mine-1")
    const yours = join(environments, "yours-2")
    for (const folder of [kuvo, project, mine, yours]) mkdirSync(folder, { recursive: true })
    writeFileSync(join(yours, "sessionstart-hook-0.sh"), "export YOURS=1\n")
    // (As the box has it: your Claude Code's folder is what runs later.)
    const fenceFolder = realFence(kuvo, [], { readOnly: [home] })
    process.env.KUVO_FENCE = fenceFolder
    const fence = fenceAgent("/bin/sh", project, { homes: [home], state: ["projects"], kept: ["settings*.json", "hooks"], read: [], session: "ses_test" })!
    delete process.env.KUVO_FENCE
    // Made the way Claude Code makes it, on the same runtime.
    const make = `${JSON.stringify(process.execPath)} -e 'require("fs").mkdirSync(process.argv[1], { recursive: true })' ${mine}`
    const tries = [
      ["make it again", make],
      ["a hook writes its file", `echo 'export PLANTED=1' >> ${mine}/sessionstart-hook-0.sh`],
      ["a link in it", `ln -s ${project} ${mine}/planted`],
      ["remove it", `rmdir ${mine}`],
      ["replace it", `mv ${mine} ${join(environments, "moved")}`],
      ["make a new one", `mkdir ${join(environments, "another-3")}`],
      ["change another's", `echo planted >> ${yours}/sessionstart-hook-0.sh`],
      ["add to another's", `echo planted > ${yours}/filechanged-hook-9.sh`],
      ["write beside them", `echo planted > ${join(environments, "planted")}`],
    ]
    const script = tries.map(([what, command]) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([fence.command, "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), ...fence.env, ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: process.env.BUN_BE_BUN } : {}) } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter((line) => /: (allowed|refused)$/.test(line)).map((line) => line.split(": ")))).toEqual({
      "make it again": "allowed",
      "a hook writes its file": "refused",
      "a link in it": "refused",
      "remove it": "refused",
      "replace it": "refused",
      "make a new one": "refused",
      "change another's": "refused",
      "add to another's": "refused",
      "write beside them": "refused",
    })
    expect(readdirSync(mine)).toEqual([])
    expect(readdirSync(environments).sort()).toEqual(["mine-1", "yours-2"])
    expect(readFileSync(join(yours, "sessionstart-hook-0.sh"), "utf8")).toBe("export YOURS=1\n")
    expect(existsSync(join(home, "planted"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
