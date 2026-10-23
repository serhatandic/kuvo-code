// Running the agents' own programs (`claude`, `codex`, `grok`…), found where your login shell
// would find them: the app hands the bridge that shell's PATH (on a machine, it's read there).

import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { onMachine, ownEnvironment } from "./machine"

/** The program's path on PATH (or the extra places given), if it's there. */
export function which(name: string, extra: string[] = []): string | undefined {
  const folders = [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(Boolean)
  for (const folder of folders) {
    const path = join(folder, name)
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {}
  }
  return undefined
}

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** Runs a program to its end, or until `timeout` (then it's stopped). An `env` value left `undefined` is unset. */
export async function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; input?: string } = {}): Promise<Ran> {
  const env = { ...process.env, ...options.env }
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name]
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env,
    stdin: options.input !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.input !== undefined && child.stdin) {
    child.stdin.write(options.input)
    child.stdin.end()
  }
  const timer = options.timeout ? setTimeout(() => child.kill(), options.timeout) : undefined
  let stdout = ""
  let stderr = ""
  const reads = Promise.all([new Response(child.stdout).text().then((text) => (stdout = text)), new Response(child.stderr).text().then((text) => (stderr = text))])
  const code = await child.exited
  // Something it started may keep its output open (a shell's startup files starting a program):
  // what came by a moment after it ended is all.
  await Promise.race([reads, Bun.sleep(2_000)])
  if (timer) clearTimeout(timer)
  return { code, stdout, stderr }
}

/** Runs a program as a process group of its own (an installer piping `curl` into `bash`): on `timeout`, all of it stops. */
export function runGroup(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}): Promise<Ran> {
  const env = { ...process.env, ...options.env }
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name]
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, env: env as Record<string, string>, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += chunk))
    child.stderr?.on("data", (chunk) => (stderr += chunk))
    const stop = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {}
    }
    const timer = options.timeout
      ? setTimeout(() => {
          stop("SIGTERM")
          setTimeout(() => stop("SIGKILL"), 3_000)
        }, options.timeout)
      : undefined
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(error) })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** The PATH the bridge started with, which each read of your login shell's starts from (a profile that adds to it would add again). */
const startPath = process.env.PATH ?? ""
let pathRead = 0
let reading: Promise<void> | undefined

/**
 * Your login shell's PATH again, so a tool installed since the bridge started (`npm install -g`,
 * Homebrew, an installer that adds a folder to your profile) is found. Asked when you refresh,
 * at most every few seconds (`now`: again, after an install), one read at a time. On a machine
 * too, with its own folders: a command over SSH gets less than its terminal does (`~/.local/bin`
 * comes from the profile); there a login shell that isn't interactive, as a terminal's commands
 * over SSH would have it, so nothing it starts for you stays running.
 */
export async function refreshLoginPath(now = false): Promise<void> {
  if (reading) {
    await reading
    if (!now) return
  }
  if (!now && Date.now() - pathRead < 5_000) return
  reading = readLoginPath().finally(() => {
    pathRead = Date.now()
    reading = undefined
  })
  await reading
}

async function readLoginPath() {
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  for (const flags of onMachine ? ["-lc"] : ["-ilc", "-lc"]) {
    try {
      const ran = await run(shell, [flags, 'printf "__KUVO_PATH__%s__KUVO_END__" "$PATH"'], { timeout: 8_000, env: { ...ownEnvironment(), PATH: startPath, DISABLE_AUTO_UPDATE: "true" } })
      const found = ran.stdout.match(/__KUVO_PATH__([\s\S]*?)__KUVO_END__/)?.[1]
      if (found?.trim()) {
        // Kuvo Code's own commands (kuvo-wake) first, as the app gave them; each folder once.
        process.env.PATH = [...new Set([process.env.KUVO_BIN, ...found.trim().split(":")].filter(Boolean))].join(":")
        return
      }
    } catch {}
  }
}

/** Finds the first web address in some text (a sign-in page a program printed). */
export function firstURL(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0]
}

/** Text with terminal colors and cursor codes taken out. */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
}
