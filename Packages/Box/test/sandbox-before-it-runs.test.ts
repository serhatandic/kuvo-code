import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// The launcher sets each command up outside the sandbox before it runs: so it runs only the
// system's programs, never one a command put on your PATH in a folder it writes (yarn's installer
// puts `~/.yarn/bin` first, and commands write `~/.yarn`), which would run there, outside it. The
// command itself still has your PATH.

const SYSTEM = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"]
const TOOLS = ["cat", "cut", "id", "mkdir", "mkfifo", "mount", "sed", "sha256sum", "shasum", "sleep", "stat", "timeout", "touch", "unshare"]

test.skipIf(!canFence)("setting a command up never runs a program a command put on your PATH", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-path-")))
  try {
    const kuvo = join(root, "kuvo")
    const project = join(root, "project")
    const planted = join(project, "bin")
    for (const folder of [kuvo, planted]) mkdirSync(folder, { recursive: true })
    realFence(kuvo)
    // Each notes it ran where only something outside the sandbox can write (Kuvo Code's folder,
    // hidden from commands), then does what the real one does.
    const ran = join(kuvo, "planted-ran")
    for (const tool of TOOLS) {
      const real = SYSTEM.map(folder => join(folder, tool)).find(existsSync)
      if (!real) continue
      writeFileSync(join(planted, tool), `#!/bin/sh\necho ${tool} >> ${JSON.stringify(ran)} 2>/dev/null\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 })
    }
    const result = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", `echo "path: $PATH"`], { cwd: project, env: { PATH: `${planted}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: root, KUVO_FENCE_WORK: project } })
    const out = result.stdout.toString() + result.stderr.toString()
    expect(out).toContain(`path: ${planted}:`)
    expect(existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : []).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// tmux's server types into the terminals attached to it. So a command can't reach yours (on Linux,
// your tmux's folder is empty in its namespace; on a Mac, its socket refuses), and one it starts is
// its conversation's own: the next command reaches it, and your terminals never attach to it.
const tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync)
const uid = process.getuid?.() ?? -1

test.skipIf(!canFence || !tmux)("a command can't reach your tmux, and the one it starts stays its conversation's", () => {
  // (Short folders: a socket's path has to be.)
  const root = realpathSync(mkdtempSync("/tmp/kst-"))
  const yours = `${realpathSync("/tmp")}/tmux-${uid}`
  const made = !existsSync(yours)
  // A server of yours, in your tmux's folder, by a name of its own (never your own sessions).
  const server = join(yours, `kuvo-test-${root.slice(-6)}`)
  try {
    const kuvo = join(root, "kuvo")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    if (made) mkdirSync(yours, { mode: 0o700 })
    expect(Bun.spawnSync([tmux!, "-S", server, "new-session", "-d", "-s", "yours", "sleep 600"]).exitCode).toBe(0)
    // (The box's rules for your sockets: on a Mac, your tmux's folder's.)
    const policy = fencePolicy()
    realFence(kuvo, [], { writable: ["/dev", realpathSync("/tmp")], socketPatterns: policy.socketPatterns, socketFolders: policy.socketFolders })
    const run = (script: string) => {
      const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: `${tmux!.slice(0, -"/tmux".length)}:/usr/bin:/bin`, HOME: root, KUVO_FENCE_WORK: project } })
      return (ran.stdout.toString() + ran.stderr.toString()).trim().split("\n").filter(line => /^[a-z]+: /.test(line))
    }
    expect(run([
      `tmux -S ${server} has-session -t yours 2>/dev/null && echo "yours: reached" || echo "yours: refused"`,
      `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`,
    ].join("\n"))).toEqual(["yours: refused", "started: yes"])
    expect(run(`tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"; tmux kill-server`)).toEqual(["own: reached"])
    // (And yours never sees it.)
    expect(Bun.spawnSync([tmux!, "-S", server, "has-session", "-t", "own"]).exitCode).not.toBe(0)
  } finally {
    Bun.spawnSync([tmux!, "-S", server, "kill-server"])
    // (And the command's own, whatever happened: in its conversation's temporary folder.)
    const own = join(root, "kuvo", "run", "fence", "tmp", createHash("sha256").update(join(root, "project")).digest("hex").slice(0, 32))
    Bun.spawnSync([tmux!, "kill-server"], { env: { TMUX_TMPDIR: own } })
    rmSync(server, { force: true })
    if (made) rmSync(yours, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
