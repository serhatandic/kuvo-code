import "./safety"
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence } from "./agents/support/fence"

// The box sets the sandbox up as it starts, and on Linux checks each minute whether commands can
// have a namespace of their own. Neither leaves anything outside Kuvo Code's folder on the machine:
// here the box's temporary folder can't be written at all, and the sandbox still sets up whole.

// (Where Linux has no Landlock, the sandbox can't run, and the box says so instead.)
const lsm = "/sys/kernel/security/lsm"
const landlock = canFence && process.platform === "linux" && (existsSync("/sys/kernel/security/landlock") || (existsSync(lsm) && /landlock/.test(readFileSync(lsm, "utf8"))))

test.skipIf(!landlock)("setting the sandbox up writes nothing outside Kuvo Code's folder", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-contained-")))
  const temporary = join(root, "tmp")
  try {
    for (const folder of ["kuvo", "home", "tmp"]) mkdirSync(join(root, folder))
    chmodSync(temporary, 0o500)
    const box = join(import.meta.dir, "..", "src", "link", "fence", "state.ts")
    // (A box of its own, in a process of its own: the link finds its folders as it loads. Run as Bun
    // where the tests run on the engine's own runtime, as a machine does, and without Bun's cache of
    // the source it compiles here, which the built box has no need for.)
    const script = `const fence = await import(${JSON.stringify(box)}); const state = fence.setUpFence(); console.log(JSON.stringify({ reason: state.reason ?? null, why: state.why ?? null, whole: fence.fenceWhole() }))`
    const ran = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: join(root, "kuvo"), TMPDIR: temporary, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } })
    const said = ran.stdout.toString().trim().split("\n").at(-1) ?? ""
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    const state = JSON.parse(said)
    // Checked and set up (only the engine isn't running here), as it would be with a temporary
    // folder to write; and the commands' namespace folder it used, inside Kuvo Code's, left empty.
    expect({ reason: state.reason, why: state.why }).toEqual({ reason: "engineDown", why: "The engine isn't running." })
    expect(readdirSync(temporary)).toEqual([])
    expect(readdirSync(join(root, "home"))).toEqual([])
    expect(readdirSync(join(root, "kuvo", "run", "fence", "ns"))).toEqual([])
  } finally {
    chmodSync(temporary, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
