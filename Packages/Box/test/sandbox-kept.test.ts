import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownNamespace } from "../src/link/fence/landlock"
import { canFence } from "./agents/support/fence"

// The box keeps the sandbox as it set it up, round by round (every 10 seconds; each minute for what
// takes longer): the engine's plugin put back once it's gone, commands' temporary folders cleared a
// week after their conversation's last command, and on Linux, commands given a namespace of their
// own once the machine lets them after all. Each round here is run by hand, in a box of its own.

const box = join(import.meta.dir, "..", "src", "link", "fence", "state.ts")

/** Runs `steps` in a box of its own (`fence`: its state.ts; `round()`: its next round, done once
 * what it set going is; `folder`: its sandbox folder), and gives back what they said. */
function inBox(steps: string): Record<string, unknown> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-kept-")))
  try {
    for (const folder of ["kuvo", "home"]) mkdirSync(join(root, folder))
    const script = `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const fence = await import(${JSON.stringify(box)});
      const rounds = [];
      fence.keepFence(each => rounds.push(each));
      const round = rounds[0];
      const folder = fence.fenceFiles.folder;
      const said = {};
      ${steps}
      console.log(JSON.stringify(said));`
    const ran = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: join(root, "kuvo"), BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } })
    expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    return JSON.parse(ran.stdout.toString().trim().split("\n").at(-1) ?? "{}")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test.skipIf(!canFence)("the engine's plugin, gone, is back on the box's next round; a conversation's temporary folder goes a week after its last command", () => {
  const said = inBox(`
    const plugin = fence.fenceFiles.plugin;
    said.setUp = fs.existsSync(plugin);
    fs.rmSync(plugin);
    // Two conversations' temporary folders: one's last command eight days ago, the other's now.
    const temporary = fs.readFileSync(path.join(folder, "temporary"), "utf8").split("\\n")[0];
    for (const name of ["0ld0ld00", "n0wn0wn0"]) fs.mkdirSync(path.join(temporary, name), { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(temporary, "0ld0ld00"), old, old);
    round();
    said.back = fs.existsSync(plugin);
    said.kept = fs.readdirSync(temporary).sort();
    fs.rmSync(temporary, { recursive: true, force: true });`)
  expect(said).toEqual({ setUp: true, back: true, kept: ["n0wn0wn0"] })
})

// (Where the machine lets commands have a namespace of their own: the box found it couldn't when it
// set up, as on a machine that allowed user namespaces only since.)
const namespaces = process.platform === "linux" && (() => {
  const own = mkdtempSync(join(tmpdir(), "kuvo-sandbox-kept-ns-"))
  try { return ownNamespace(own) !== null } finally { rmSync(own, { recursive: true, force: true }) }
})()

test.skipIf(!canFence || !namespaces)("commands get a namespace of their own on the minute's check once the machine lets them, not before", () => {
  const said = inBox(`
    const { spawnSync } = await import("node:child_process");
    // Whether a command runs in a namespace of its own: its user namespace isn't the box's.
    const work = path.join(path.dirname(folder), "..", "..", "work");
    fs.mkdirSync(work, { recursive: true });
    const ownNamespace = () => spawnSync(fence.fenceFiles.launcher, ["-c", "readlink /proc/self/ns/user"], { cwd: work, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, KUVO_FENCE_WORK: work } }).stdout.trim() !== fs.readlinkSync("/proc/self/ns/user");
    fence.setUpFence(null);
    said.atFirst = ownNamespace();
    for (let each = 0; each < 5; each++) round();
    said.before = ownNamespace();
    // The sixth round's check runs while the box goes on: its answer, once it's set up again.
    await round();
    said.after = ownNamespace();`)
  expect(said).toEqual({ atFirst: false, before: false, after: true })
})
