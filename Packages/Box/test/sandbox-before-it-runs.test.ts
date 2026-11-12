import "./safety"
import { ownPath } from "../../KuvoLink/Tests/Bridge/test-safety.js"
import { expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// The launcher sets each command up outside the sandbox before it runs: so it runs only the
// system's programs, never one a command put on your PATH in a folder it writes (yarn's installer
// puts `~/.yarn/bin` first, and commands write `~/.yarn`), which would run there, outside it. The
// command itself still has your PATH.

// Each test sets a whole sandbox up and runs programs in it (Bun, the sandbox, tmux) in processes of
// its own, waiting on them: about 1 to 2 s on a quiet machine, and over Bun's 5 s when it is busy,
// where Bun then stops the process being waited on and the test sees nothing. So a busy machine
// gets as long as the work takes, not 5 s.
setDefaultTimeout(30_000)

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
  const server = ownPath(join(yours, `kuvo-test-${root.slice(-6)}`))
  if (made) ownPath(yours)
  try {
    const kuvo = join(root, "kuvo")
    const project = join(root, "project")
    for (const folder of [kuvo, project]) mkdirSync(folder, { recursive: true })
    // (Another run beside this one may make it too.)
    if (made) mkdirSync(yours, { mode: 0o700, recursive: true })
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
    // (Only once it's empty: another run's server may be in it still.)
    if (made) try { rmdirSync(yours) } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

// The commands' own tmux servers, whatever happened, in their conversations' temporary folders.
function stopServers(kuvo: string) {
  for (const temporary of [join(kuvo, "run", "fence", "tmp"), join(kuvo, "t")]) {
    if (existsSync(temporary)) for (const name of readdirSync(temporary)) Bun.spawnSync([tmux!, "kill-server"], { env: { TMUX_TMPDIR: join(temporary, name) } })
  }
}

// The longest Kuvo Code folder whose commands' tmux fits (its socket at `<kuvo>/t/<8>/tmux-<uid>/default`):
// on a machine, a home folder's path of 67 letters.
const SOCKET_PATH = process.platform === "darwin" ? 103 : 107
const longestFitting = SOCKET_PATH - "/t/12345678/tmux-/default".length - String(process.getuid?.() ?? 0).length

/** A box set up in a Kuvo Code folder `length` letters long, in a folder of its own: `run` runs a
 * command in the sandbox in one of its projects (`one`, `two`), `note` is what its agents are told. */
function boxOfLength(length: number) {
  const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "kst-")))
  const kuvo = `${root}/${"k".repeat(length - root.length - 1)}`
  if (kuvo.length !== length) throw new Error(`This test's folder is too deep for its own (${root}): run it with a shorter TMPDIR.`)
  for (const folder of [kuvo, join(root, "one"), join(root, "two"), join(root, "home")]) mkdirSync(folder, { recursive: true })
  const box = join(import.meta.dir, "..", "src", "link", "fence", "state.ts")
  const home = join(import.meta.dir, "..", "src", "link", "home.ts")
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: kuvo, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
  // (Agents told as once the engine has loaded the sandbox's plugin, which isn't running here.)
  const setUp = Bun.spawnSync([process.execPath, "-e", `const fs = await import("node:fs"); const fence = await import(${JSON.stringify(box)}); const home = await import(${JSON.stringify(home)}); fence.setUpFence(); fence.tellAgents(true); console.log(JSON.stringify(fs.readFileSync(home.SANDBOX_NOTE, "utf8")))`], { cwd: root, env })
  expect(setUp.exitCode, setUp.stderr.toString()).toBe(0)
  const note: string = JSON.parse(setUp.stdout.toString().trim().split("\n").at(-1) ?? '""')
  const run = (project: "one" | "two", script: string) => {
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: join(root, project), env: { PATH: `${tmux!.slice(0, -"/tmux".length)}:/usr/bin:/bin`, HOME: join(root, "home"), KUVO_FENCE_WORK: join(root, project) } })
    return (ran.stdout.toString() + ran.stderr.toString()).trim().split("\n")
  }
  return { root, kuvo, note, run }
}

// On a machine whose home folder's path is long, the conversation's temporary folder stays in Kuvo
// Code's own (`~/.kuvo-code/t`), as near its top as it can be: a command's tmux starts there under a
// home folder's path of up to 67 letters, and another conversation's command can't reach it.
test.skipIf(!canFence || !tmux)("a command's tmux starts in the longest Kuvo Code folder it fits in, kept in it, and reaches no other conversation's", () => {
  let kuvo: string | undefined
  let root: string | undefined
  try {
    const box = boxOfLength(longestFitting)
    ;({ kuvo, root } = box)
    expect(readFileSync(join(kuvo, "run", "fence", "temporary"), "utf8").split("\n")[0]).toBe(join(kuvo, "t"))
    expect(box.note).not.toContain("too long")
    expect(box.run("one", `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`)).toEqual(["started: yes"])
    expect(box.run("one", `tmux has-session -t own 2>/dev/null && echo "own: reached" || echo "own: gone"`)).toEqual(["own: reached"])
    const [first] = readdirSync(join(kuvo, "t")).filter(name => existsSync(join(kuvo!, "t", name, `tmux-${process.getuid!()}`)))
    expect(first).toBeDefined()
    // Another conversation's command: nothing of the first's, not even its name. (Where a machine
    // gives commands no namespace of their own, the sandbox's state says so, and only the name it
    // can't list keeps it from the first's: Landlock doesn't refuse a socket.)
    const fenced = process.platform === "darwin" || readFileSync(join(kuvo, "run", "fence", "namespace"), "utf8").startsWith("/")
    expect(box.run("two", `ls -A "${kuvo}/t" 2>/dev/null | grep -qx "${first}" && echo "name: seen" || echo "name: unseen"; TMUX_TMPDIR="${kuvo}/t/${first}" tmux has-session -t own 2>/dev/null && echo "theirs: reached" || echo "theirs: refused"`))
      .toEqual(["name: unseen", fenced ? "theirs: refused" : "theirs: reached"])
    expect(box.run("one", "tmux kill-server; echo done")).toEqual(["done"])
  } finally {
    if (kuvo) stopServers(kuvo)
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

// One letter longer, tmux's socket can't be made: it says so plainly, commands still run, and agents
// are told why (nothing goes to `/tmp` instead).
test.skipIf(!canFence || !tmux)("under a Kuvo Code folder too long for tmux's socket, tmux says why, commands still run, and agents are told", () => {
  let kuvo: string | undefined
  let root: string | undefined
  try {
    const box = boxOfLength(longestFitting + 1)
    ;({ kuvo, root } = box)
    expect(readFileSync(join(kuvo, "run", "fence", "temporary"), "utf8").split("\n")[0]).toBe(join(kuvo, "t"))
    expect(box.note).toContain("home folder's path is too long for tmux")
    const said = box.run("one", `tmux new-session -d -s own "sleep 600" && echo "started: yes" || echo "started: no"`)
    expect(said).toContain("started: no")
    expect(said.join("\n")).toContain("File name too long")
    expect(box.run("one", "echo ran")).toEqual(["ran"])
  } finally {
    if (kuvo) stopServers(kuvo)
    if (root) rmSync(root, { recursive: true, force: true })
  }
})
