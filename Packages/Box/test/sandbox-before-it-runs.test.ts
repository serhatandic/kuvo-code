import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
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
    const run = (script: string, inherited: Record<string, string> = {}) => {
      const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { ...inherited, PATH: `${tmux!.slice(0, -"/tmux".length)}:/usr/bin:/bin`, HOME: root, KUVO_FENCE_WORK: project } })
      return (ran.stdout.toString() + ran.stderr.toString()).trim().split("\n").filter(line => /^[a-z]+: /.test(line))
    }
    expect(run([
      `tmux -S ${server} has-session -t yours 2>/dev/null && echo "yours: reached" || echo "yours: refused"`,
      `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`,
    ].join("\n"))).toEqual(["yours: refused", "started: yes"])
    expect(run(`tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"; tmux kill-server`)).toEqual(["own: reached"])
    // Kuvo Code started from a terminal in your tmux: what it hands its engine names your server
    // (and the pane it ran in), which a command's tmux would take over its own.
    const inYours = { TMUX: `${server},${process.pid},0`, TMUX_PANE: "%0" }
    expect(run([
      `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`,
      `tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"`,
      `echo "pane: \${TMUX_PANE-none}"`,
      "tmux kill-server",
    ].join("\n"), inYours)).toEqual(["started: yes", "own: reached", "pane: none"])
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

// A socket's path is short (107 letters on Linux, 103 on macOS), and a command's tmux puts its
// server's in the conversation's temporary folder: so that folder's path is short too, however long
// the path of the home folder Kuvo Code's is in (a machine's `/home/<a long name>/.kuvo-code`).
test.skipIf(!canFence || !tmux)("a command's tmux starts in a box whose folder's path is long", () => {
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "kst-")))
  // Kuvo Code's folder, 60 letters long: a home folder's path of 49, as `/home/<name>` is with a long name.
  const kuvo = root.length + 2 <= 60 ? `${root}/${"k".repeat(59 - root.length)}` : null
  try {
    if (!kuvo) throw new Error(`This test's folder is too deep for its own (${root}): run it with a shorter TMPDIR.`)
    const project = join(root, "project")
    for (const folder of [kuvo, project, join(root, "home")]) mkdirSync(folder, { recursive: true })
    // The box sets it up as it starts (here in a process of its own, as it finds its folders as it
    // loads; the engine isn't running, so the box only checks it later).
    const box = join(import.meta.dir, "..", "src", "link", "fence", "state.ts")
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: kuvo, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
    const setUp = Bun.spawnSync([process.execPath, "-e", `const fence = await import(${JSON.stringify(box)}); console.log(JSON.stringify(fence.setUpFence()))`], { cwd: root, env })
    expect(setUp.exitCode, setUp.stderr.toString()).toBe(0)
    expect(JSON.parse(setUp.stdout.toString().trim().split("\n").at(-1) ?? "{}").reason).toBe("engineDown")
    const run = (script: string) => {
      const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: `${tmux!.slice(0, -"/tmux".length)}:/usr/bin:/bin`, HOME: join(root, "home"), KUVO_FENCE_WORK: project } })
      return (ran.stdout.toString() + ran.stderr.toString()).trim().split("\n")
    }
    expect(run(`tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`)).toEqual(["started: yes"])
    expect(run(`tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"; tmux kill-server`)).toEqual(["own: reached"])
  } finally {
    if (kuvo) stopServers(kuvo)
    rmSync(root, { recursive: true, force: true })
  }
})

// The commands' own tmux servers, whatever happened, in their conversations' temporary folders; and
// the box's short folder in `/tmp`, where it made one.
function stopServers(kuvo: string) {
  let short = ""
  try { short = readFileSync(join(kuvo, "run", "fence", "temporary"), "utf8").split("\n")[0]! } catch {}
  for (const temporary of [join(kuvo, "run", "fence", "tmp"), short]) {
    if (temporary && existsSync(temporary)) for (const name of readdirSync(temporary)) Bun.spawnSync([tmux!, "kill-server"], { env: { TMUX_TMPDIR: join(temporary, name) } })
  }
  if (/^\/tmp\/kuvo-code-\d+-[0-9a-f]{6}$/.test(short)) rmSync(short, { recursive: true, force: true })
}

// Under a home folder's path longer still, the conversation's temporary folder can't be in Kuvo
// Code's own (`~/.kuvo-code`) and stay short enough: the box keeps them in a short folder of its own
// in `/tmp`, yours alone, where each command sees only its own conversation's, so it still can't
// reach another conversation's tmux. (This Mac's box keeps them in the app's temporary folder.)
test.skipIf(!canFence || !tmux || process.platform !== "linux")("a command's tmux starts on a machine whose home folder's path is long, and reaches no other conversation's", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kst-")))
  // Kuvo Code's folder, 100 letters long: a home folder's path of 89.
  const kuvo = root.length + 2 <= 100 ? `${root}/${"k".repeat(99 - root.length)}` : null
  try {
    if (!kuvo) throw new Error(`This test's folder is too deep for its own (${root}): run it with a shorter TMPDIR.`)
    const [one, two] = [join(root, "one"), join(root, "two")]
    for (const folder of [kuvo, one, two, join(root, "home")]) mkdirSync(folder, { recursive: true })
    const box = join(import.meta.dir, "..", "src", "link", "fence", "state.ts")
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: kuvo, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
    const setUp = Bun.spawnSync([process.execPath, "-e", `const fence = await import(${JSON.stringify(box)}); console.log(JSON.stringify(fence.setUpFence()))`], { cwd: root, env })
    expect(setUp.exitCode, setUp.stderr.toString()).toBe(0)
    const short = readFileSync(join(kuvo, "run", "fence", "temporary"), "utf8").split("\n")[0]!
    expect(short).toMatch(new RegExp(`^/tmp/kuvo-code-${process.getuid!()}-[0-9a-f]{6}$`))
    // (Made only as a command needs it.)
    expect(existsSync(short)).toBe(false)
    const run = (project: string, script: string) => {
      const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: `${tmux!.slice(0, -"/tmux".length)}:/usr/bin:/bin`, HOME: join(root, "home"), KUVO_FENCE_WORK: project } })
      return (ran.stdout.toString() + ran.stderr.toString()).trim().split("\n")
    }
    expect(run(one, `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`)).toEqual(["started: yes"])
    expect({ mode: statSync(short).mode & 0o777, uid: statSync(short).uid }).toEqual({ mode: 0o700, uid: process.getuid!() })
    expect(run(one, `tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"`)).toEqual(["own: reached"])
    // Another conversation's command: its own folder in it, and nothing of the first's.
    const theirs = readdirSync(short).filter(name => existsSync(join(short, name, `tmux-${process.getuid!()}`)))
    expect(theirs.length).toBe(1)
    // (Where the machine gives commands no namespace of their own, the sandbox's state says what
    // they can reach: everything in `/tmp`, your own tmux too.)
    const fenced = readFileSync(join(kuvo, "run", "fence", "namespace"), "utf8").trim() !== "-"
    const seen = run(two, `basename "$TMPDIR"; ls -A "${short}"; TMUX_TMPDIR="${short}/${theirs[0]}" tmux has-session -t own 2>/dev/null && echo "theirs: reached" || echo "theirs: refused"`)
    if (fenced) expect(seen).toEqual([seen[0]!, seen[0]!, "theirs: refused"])
    expect(run(one, "tmux kill-server; echo done")).toEqual(["done"])
  } finally {
    if (kuvo) stopServers(kuvo)
    rmSync(root, { recursive: true, force: true })
  }
})
