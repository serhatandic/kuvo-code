import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// What your shell runs as it starts, in folders commands write (the files rustup's, deno's and bun's
// installers have your shell profile source), runs outside the sandbox the next time you open a
// terminal: so commands can't change it.

test.skipIf(!canFence)("a command can't change what your shell runs as it starts, in the caches it writes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-runs-later-")))
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    // The box's own rules, as they'd be in this home folder.
    const policy = fencePolicy()
    const inHome = (paths: string[]) => paths.filter(each => each.startsWith(policy.home + "/")).map(each => join(home, each.slice(policy.home.length + 1)))
    const names = [".cargo/env", ".cargo/env.fish", ".deno/env", ".bun/_bun"]
    const startUp = names.map(name => join(home, name))
    for (const file of startUp) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, "export PATH\n")
    }
    realFence(kuvo, [], { writable: ["/dev", ...inHome(policy.writable)], readOnly: inHome(policy.readOnly) })
    const script = names.map(name => `if ( echo planted >> ${join(home, name)} ) 2>/dev/null; then echo "${name}: allowed"; else echo "${name}: refused"; fi`).join("\n")
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual(Object.fromEntries(names.map(name => [name, "refused"])))
    for (const file of startUp) expect(readFileSync(file, "utf8")).toBe("export PATH\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
