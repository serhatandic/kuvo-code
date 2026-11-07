import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { loginPath, processRuns, promptedFolders } from "../src/shared/platform"

// Where macOS and Linux differ, each side tested on whichever system runs this: a box tells its own
// programs from whatever took their process's number after a crash (Linux by /proc, a stand-in
// folder here; a Mac, without one, by what `ps` says), and leaves the folders a Mac asks you
// about out of what it looks into.

// A number no process has (past either system's highest).
const gone = 99_999_999
let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kuvo-box-platform-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A /proc of the test's own, with `pid`'s command line. */
function proc(pid: number, ...argv: string[]) {
  const folder = join(root, "proc")
  mkdirSync(join(folder, String(pid)), { recursive: true })
  writeFileSync(join(folder, String(pid), "cmdline"), argv.join("\0") + "\0")
  return folder
}

test("Linux: a process is the program its command line names, and no other", () => {
  const folder = proc(process.pid, "/opt/engine/opencode", "/home/you/.kuvo-code/bin/kuvo-agents.js")
  expect(processRuns(process.pid, "kuvo-agents", folder)).toBe(true)
  // Its number taken by something else after a crash.
  expect(processRuns(process.pid, "kuvo-browser", folder)).toBe(false)
  // Alive (this test's parent), but not listed there.
  expect(process.ppid).toBeGreaterThan(1)
  expect(processRuns(process.ppid, "kuvo-agents", folder)).toBe(false)
})

test("Linux: a process that ended isn't running, whatever its command line said", () => {
  const folder = proc(gone, "kuvo-agents.js")
  expect(processRuns(gone, "kuvo-agents", folder)).toBe(false)
})

test("without /proc (a Mac): a program's own command line says, so another program that took its number isn't it", () => {
  const none = join(root, "no-proc")
  const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
  try {
    expect(processRuns(other.pid, "sleep", none)).toBe(true)
    expect(processRuns(other.pid, "kuvo-agents", none)).toBe(false)
  } finally {
    other.kill()
  }
  expect(processRuns(gone, "kuvo-agents", none)).toBe(false)
})

test("the agents' bridge: beside this Mac's app it takes a process that's alive as its program, and on a Mac machine goes by what ps says", () => {
  const none = join(root, "no-proc")
  const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" })
  const before = { home: process.env.KUVO_AGENTS_HOME, remote: process.env.KUVO_AGENTS_REMOTE }
  process.env.KUVO_AGENTS_HOME = root
  try {
    delete process.env.KUVO_AGENTS_REMOTE
    expect(processRuns(other.pid, "kuvo-link", none)).toBe(true)
    process.env.KUVO_AGENTS_REMOTE = "1"
    expect(processRuns(other.pid, "kuvo-link", none)).toBe(false)
  } finally {
    other.kill()
    for (const [name, value] of [["KUVO_AGENTS_HOME", before.home], ["KUVO_AGENTS_REMOTE", before.remote]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test("this Mac's app's box: a process that's alive is taken as the program it's said to be", () => {
  const none = join(root, "no-proc")
  const before = process.env.KUVO_BOX
  process.env.KUVO_BOX = "mac"
  try {
    expect(processRuns(process.pid, "kuvo-agents", none)).toBe(true)
    expect(processRuns(gone, "kuvo-agents", none)).toBe(false)
  } finally {
    if (before === undefined) delete process.env.KUVO_BOX
    else process.env.KUVO_BOX = before
  }
})

test("on both: no number, or the system's own, is never a program of the box's", () => {
  const none = join(root, "no-proc")
  for (const pid of [undefined, null, "123", 1.5, 0, 1, -4]) expect(processRuns(pid, "kuvo-agents", none)).toBe(false)
})

test("a Mac asks before an app looks into Desktop, Documents and the rest; Linux asks about none", () => {
  expect([...promptedFolders("darwin")].sort()).toEqual(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"])
  expect(promptedFolders("linux").size).toBe(0)
})

// The PATH a box's engine and agents get: your login shell's, as a terminal there has it, not the
// bare one a start over SSH or from cron gets. A home folder as a Debian or Ubuntu account has it:
// `.profile` adds ~/.local/bin and reads `.bashrc`, which stops early unless the shell is
// interactive, before the lines nvm's installer adds at its end.
function home() {
  const folder = join(root, "home")
  const nvm = join(folder, ".nvm/versions/node/v22.11.0/bin")
  mkdirSync(join(folder, ".local/bin"), { recursive: true })
  mkdirSync(nvm, { recursive: true })
  writeFileSync(join(nvm, "node"), "#!/bin/sh\n")
  chmodSync(join(nvm, "node"), 0o755)
  writeFileSync(join(folder, ".profile"), [
    'if [ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    'PATH="$HOME/.local/bin:$PATH"',
  ].join("\n") + "\n")
  writeFileSync(join(folder, ".bashrc"), [
    "case $- in *i*) ;; *) return;; esac",
    "echo 'Welcome back'",
    'export NVM_DIR="$HOME/.nvm"',
    'PATH="$NVM_DIR/versions/node/v22.11.0/bin:$PATH"',
  ].join("\n") + "\n")
  return { folder, local: join(folder, ".local/bin"), nvm }
}

/** What a box program prints, run as the machine's start runs it: from cron's bare environment, with the shell you log in with. */
function ran(args: string[], folder: string, more: Record<string, string> = {}) {
  const box = resolve(import.meta.dir, "..")
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: box,
    env: { HOME: folder, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", KUVO_HOME: join(folder, ".kuvo-code"), BUN_BE_BUN: "1", ...more },
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.stdout.toString()
}

test("on both: a machine's engine starts with the PATH your login shell sets up, nvm's node and ~/.local/bin on it", () => {
  const { folder, local, nvm } = home()
  // As the start script asks the box's link (`kuvo-link.js login-path`).
  const found = ran(["src/link/main.ts", "login-path"], folder).split(":")
  expect(found).toContain(nvm)
  expect(found).toContain(local)
  expect(found).toContain("/usr/bin")
})

test("on both: the coding agents' bridge on a machine finds nvm's node too", () => {
  const { folder, nvm } = home()
  const script = 'import { refreshLoginPath, which } from "./src/agents/proc"; await refreshLoginPath(true); process.stdout.write(which("node") ?? "none")'
  expect(ran(["-e", script], folder, { KUVO_AGENTS_REMOTE: "1" })).toBe(join(nvm, "node"))
})

test("on both: a startup file that leaves a program running in the background doesn't hold up the engine's start", async () => {
  const { folder, nvm } = home()
  // Like an agent some .bashrc starts: on its own, apart from the shell, still holding what it printed to.
  writeFileSync(join(folder, ".bashrc"), readFileSync(join(folder, ".bashrc"), "utf8") +
    `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "$ENV{HOME}/daemon.pid.new"); print F $$; close F; rename("$ENV{HOME}/daemon.pid.new", "$ENV{HOME}/daemon.pid"); sleep 30' &\n` +
    `until [ -f "$HOME/daemon.pid" ]; do :; done\n`)
  const box = resolve(import.meta.dir, "..")
  const child = Bun.spawn([process.execPath, "src/link/main.ts", "login-path"], {
    cwd: box,
    env: { HOME: folder, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", KUVO_HOME: join(folder, ".kuvo-code"), BUN_BE_BUN: "1" },
    stdout: "pipe",
  })
  try {
    const printed = await new Response(child.stdout).text()
    await child.exited
    expect(printed.split(":")).toContain(nvm)
  } finally {
    child.kill()
    try { process.kill(Number(readFileSync(join(folder, "daemon.pid"), "utf8"))) } catch {}
  }
})

test("on both: reading it doesn't start another SSH agent where you have one", () => {
  const { folder, nvm } = home()
  // The usual .bashrc lines that start an agent when there's none (here, it only notes that it would).
  writeFileSync(join(folder, ".bashrc"), readFileSync(join(folder, ".bashrc"), "utf8") + `[ -n "$SSH_AUTH_SOCK" ] || echo started >>"$HOME/agents"\n`)
  expect(ran(["src/link/main.ts", "login-path"], folder, { SSH_AUTH_SOCK: join(folder, "agent.sock") }).split(":")).toContain(nvm)
  expect(existsSync(join(folder, "agents"))).toBe(false)
})

test("on a machine: the engine's start reads it once, and the agents' bridge and link go by that, reading again only after an install", () => {
  const { folder, nvm } = home()
  // No SSH agent there: the usual .bashrc lines start one with each read (here, they note it).
  writeFileSync(join(folder, ".bashrc"), readFileSync(join(folder, ".bashrc"), "utf8") + `[ -n "$SSH_AUTH_SOCK" ] || echo started >>"$HOME/agents"\n`)
  const agents = () => (existsSync(join(folder, "agents")) ? readFileSync(join(folder, "agents"), "utf8").trim().split("\n").length : 0)
  ran(["src/link/main.ts", "login-path"], folder)
  expect(agents()).toBe(1)
  // The bridge starts, and Settings › Accounts refreshes, twice.
  const bridge = 'import { refreshLoginPath, useSavedLoginPath, which } from "./src/agents/proc"; useSavedLoginPath(); await refreshLoginPath(); await refreshLoginPath(); process.stdout.write(which("node") ?? "none")'
  expect(ran(["-e", bridge], folder, { KUVO_AGENTS_REMOTE: "1" })).toBe(join(nvm, "node"))
  expect(agents()).toBe(1)
  // An install reads it again.
  ran(["-e", 'import { refreshLoginPath } from "./src/agents/proc"; await refreshLoginPath(true)'], folder, { KUVO_AGENTS_REMOTE: "1" })
  expect(agents()).toBe(2)
})

test("on both: the folders the start had stay on it, after your login shell's, when a profile sets PATH outright", () => {
  const { folder, nvm, local } = home()
  // As Debian's /etc/profile does.
  writeFileSync(join(folder, ".profile"), 'PATH="/usr/bin:/bin"\n' + readFileSync(join(folder, ".profile"), "utf8"))
  const found = ran(["src/link/main.ts", "login-path"], folder, { PATH: "/opt/kuvo-start/bin:/usr/bin:/bin" }).split(":")
  expect(found.slice(0, 2).sort()).toEqual([nvm, local].sort())
  expect(found.at(-1)).toBe("/opt/kuvo-start/bin")
  expect(found.filter(folder => folder === "/usr/bin")).toHaveLength(1)
})

/**
 * A login shell of the test's own that does as it's told, on cue: `answer` runs the command with a
 * folder of its own on PATH; `hang` answers so only once the test releases it; `exit` starts a program
 * apart from it that holds what it prints to until the test lets it go, and exits without
 * answering. It notes its process (`shell.pid`) as it starts.
 */
function shell(folder: string, interactive: "answer" | "hang" | "exit", login: "answer" | "hang") {
  const step = (what: string, name: string) => ({
    answer: `PATH="/${name}/bin:$PATH" exec /bin/sh -c "$2"`,
    hang: `until [ -f "$HOME/released" ]; do sleep 0.05; done; PATH="/${name}/bin:$PATH" exec /bin/sh -c "$2"`,
    exit: `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "$ENV{HOME}/holder.pid.new"); print F $$; close F; rename("$ENV{HOME}/holder.pid.new", "$ENV{HOME}/holder.pid"); sleep 1 until -e "$ENV{HOME}/released"' &
      until [ -f "$HOME/holder.pid" ]; do :; done
      exit 0`,
  })[what]
  const file = join(folder, "fake-shell")
  writeFileSync(file, `#!/bin/sh\necho $$ >"$HOME/shell.pid"\ncase "$1" in\n-ilc) ${step(interactive, "interactive")} ;;\n-lc) ${step(login, "login")} ;;\nesac\n`)
  chmodSync(file, 0o755)
  return file
}

/** Lets what the fake shell started go: a shell that's waiting, a program holding its output (stopped). */
function release(folder: string) {
  writeFileSync(join(folder, "released"), "")
  try { process.kill(Number(readFileSync(join(folder, "holder.pid"), "utf8"))) } catch {}
}

const running = (pidFile: string) => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0)
    return true
  } catch {
    return false
  }
}

test("on both: a shell that exits without answering, leaving something running that holds its output, gives way to the login one, not waiting for it", async () => {
  const folder = join(root, "home")
  mkdirSync(folder, { recursive: true })
  const env = { HOME: folder, SHELL: shell(folder, "exit", "answer"), PATH: "/usr/bin:/bin" }
  // The program lets go after a while anyway: a read that waited for it is over then, too late.
  const later = setTimeout(() => release(folder), 3_000)
  try {
    // However long the interactive one may take: it's gone.
    const found = await loginPath(env, { interactive: 600_000, login: 600_000 })
    expect(running(join(folder, "holder.pid"))).toBe(true)
    expect(found?.split(":")[0]).toBe("/login/bin")
  } finally {
    clearTimeout(later)
    release(folder)
  }
})

test("on both: an interactive shell that never answers gives way to the login one; with neither answering there's none, and the start keeps its own", async () => {
  const folder = join(root, "home")
  mkdirSync(folder, { recursive: true })
  try {
    let env = { HOME: folder, SHELL: shell(folder, "hang", "answer"), PATH: "/usr/bin:/bin" }
    expect((await loginPath(env, { interactive: 100, login: 600_000 }))?.split(":")[0]).toBe("/login/bin")
    env = { ...env, SHELL: shell(folder, "hang", "hang") }
    expect(await loginPath(env, { interactive: 100, login: 100 })).toBeUndefined()
  } finally {
    release(folder)
  }
})

/** A .bashrc that hangs for an interactive shell, taking no notice of being asked to stop, as a
 * real one waiting on something can: it notes its shell (`shell.pid`) first. */
function hangingBashrc(folder: string) {
  writeFileSync(join(folder, ".bashrc"), readFileSync(join(folder, ".bashrc"), "utf8") + `trap '' TERM HUP INT\necho $$ >"$HOME/shell.pid.new"; mv "$HOME/shell.pid.new" "$HOME/shell.pid"\nwhile :; do :; done\n`)
}

/** Whether the process `pidFile` names has stopped (or never started), given a while to: a
 * failure answers within the test, so its `finally` stops what's left (a test the runner times
 * out never gets there). */
async function stopped(pidFile: string) {
  for (const begun = Date.now(); Date.now() - begun < 10_000; await Bun.sleep(20)) if (!existsSync(pidFile) || !running(pidFile)) return true
  return false
}

const stopShell = (pidFile: string) => {
  try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL") } catch {}
}

test("on both: a .bashrc that hangs, deaf to being stopped, is given up on for the login shell's PATH, and stopped", async () => {
  const { folder, local, nvm } = home()
  hangingBashrc(folder)
  try {
    const found = (await loginPath({ HOME: folder, SHELL: "/bin/bash", PATH: "/usr/bin:/bin" }, { interactive: 1_000, login: 600_000 }))?.split(":")
    expect(found).toContain(local)
    expect(found).not.toContain(nvm)
    expect(await stopped(join(folder, "shell.pid"))).toBe(true)
  } finally {
    stopShell(join(folder, "shell.pid"))
  }
}, 30_000)

test("on both: a shell that moves into a process group of its own as it starts (fish, interactive) and hangs is stopped too", async () => {
  const folder = join(root, "home")
  mkdirSync(folder, { recursive: true })
  const shell = join(folder, "fake-shell")
  const pidFile = join(folder, "own.pid")
  writeFileSync(shell, `#!/bin/sh\ncase "$1" in\n-ilc) exec perl -e 'setpgrp(0, 0); $SIG{TERM} = $SIG{HUP} = "IGNORE"; open(F, ">", "$ENV{HOME}/own.pid.new"); print F $$; close F; rename("$ENV{HOME}/own.pid.new", "$ENV{HOME}/own.pid"); sleep 1 while 1' ;;\n-lc) PATH="/login/bin:$PATH" exec /bin/sh -c "$2" ;;\nesac\n`)
  chmodSync(shell, 0o755)
  try {
    // Given up on once it's started (however long that takes here), for the login one.
    const found = loginPath({ HOME: folder, SHELL: shell, PATH: "/usr/bin:/bin" }, { interactive: 1_000, login: 600_000 })
    expect((await found)?.split(":")[0]).toBe("/login/bin")
    expect(await stopped(pidFile)).toBe(true)
  } finally {
    stopShell(pidFile)
  }
}, 30_000)

test("on both: a read still going when the box's process stops (stopped, crashed) stops with it, never left running", async () => {
  const { folder } = home()
  hangingBashrc(folder)
  const pidFile = join(folder, "shell.pid")
  const box = Bun.spawn([process.execPath, "src/link/main.ts", "login-path"], {
    cwd: resolve(import.meta.dir, ".."),
    env: { HOME: folder, SHELL: "/bin/bash", PATH: "/usr/bin:/bin", KUVO_HOME: join(folder, ".kuvo-code"), BUN_BE_BUN: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    while (!existsSync(pidFile)) await Bun.sleep(20)
    box.kill("SIGKILL")
    await box.exited
    expect(await stopped(pidFile)).toBe(true)
  } finally {
    box.kill("SIGKILL")
    stopShell(pidFile)
  }
}, 30_000)

test("this Mac: Settings › Accounts' refresh answers while a slow .zshrc is still being read, and the read carries on", () => {
  const folder = join(root, "home")
  mkdirSync(folder, { recursive: true })
  // The refresh answers while the shell hangs; the shell then answers, and the next refresh has it.
  const script = `import { refreshLoginPath } from "./src/agents/proc"; import { writeFileSync } from "node:fs"
    await refreshLoginPath()
    writeFileSync(process.env.HOME + "/released", "")
    await refreshLoginPath()
    process.stdout.write(process.env.PATH!.split(":")[0])`
  try {
    expect(ran(["-e", script], folder, { SHELL: shell(folder, "hang", "hang") })).toBe("/interactive/bin")
  } finally {
    release(folder)
  }
}, 30_000)

const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(existsSync)
test.skipIf(!zsh)("zsh: nvm's node from .zshrc and ~/.local/bin from .zprofile", () => {
  const { folder, nvm, local } = home()
  writeFileSync(join(folder, ".zprofile"), 'path=("$HOME/.local/bin" $path)\n')
  writeFileSync(join(folder, ".zshrc"), 'export NVM_DIR="$HOME/.nvm"\nPATH="$NVM_DIR/versions/node/v22.11.0/bin:$PATH"\n')
  const found = ran(["src/link/main.ts", "login-path"], folder, { SHELL: zsh! }).split(":")
  expect(found).toContain(nvm)
  expect(found).toContain(local)
})

// Your account's shell, as /etc/passwd names it on Linux.
const account = process.platform === "linux"
  ? readFileSync("/etc/passwd", "utf8").split("\n").map(line => line.split(":")).find(fields => fields[2] === String(process.getuid?.()))?.[6]
  : undefined
test.skipIf(!account?.endsWith("/bash"))("Linux: a start from cron, whose shell is plain sh, reads your account's shell's PATH", () => {
  const { folder, nvm } = home()
  expect(ran(["src/link/main.ts", "login-path"], folder, { SHELL: "/bin/sh" }).split(":")).toContain(nvm)
})
