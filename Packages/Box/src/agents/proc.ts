// Running the agents' own programs (`claude`, `codex`, `grok`…), found where your login shell
// would find them: the app hands the bridge that shell's PATH (on a machine, it's read there).

import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { GIT_QUIET, ownArgsLater } from "../shared/git"
import { joinPath, loginPath, saveLoginPath, savedLoginPath } from "../shared/platform"
import { machineHome, onMachine } from "./machine"

/** The program's path on PATH (or the extra places given), if it's there. */
export function which(name: string, extra: string[] = []): string | undefined {
  // (A test's run says to look in the system's folders only through its PATH, which has none of your
  // agents' programs: never the ones you installed there, beside it.)
  const skipped = process.env.KUVO_TEST_PATH_ONLY === "1" ? new Set(["/opt/homebrew/bin", "/usr/local/bin"]) : new Set<string>()
  const folders = [...(process.env.PATH ?? "").split(delimiter), ...extra.filter((folder) => !skipped.has(folder))].filter(Boolean)
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
  /** It ran past its `timeout` and was stopped. */
  timedOut?: boolean
}

/** Runs a program to its end, or until `timeout` (then it's stopped: SIGTERM, then SIGKILL if it takes no notice). An `env` value left `undefined` is unset. */
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
  let timedOut = false
  let hard: ReturnType<typeof setTimeout> | undefined
  const timer = options.timeout
    ? setTimeout(() => {
        timedOut = true
        child.kill()
        hard = setTimeout(() => child.kill("SIGKILL"), 3_000)
      }, options.timeout)
    : undefined
  let stdout = ""
  let stderr = ""
  const reads = Promise.all([new Response(child.stdout).text().then((text) => (stdout = text)), new Response(child.stderr).text().then((text) => (stderr = text))])
  const code = await child.exited
  clearTimeout(timer)
  clearTimeout(hard)
  // Something it started may keep its output open (a shell's startup files starting a program):
  // what came by a moment after it ended is all.
  await Promise.race([reads, Bun.sleep(2_000)])
  return { code, stdout, stderr, ...(timedOut ? { timedOut } : {}) }
}

/** git as the box runs it by itself (`../shared/git`): never starting a program the repository's
 * own settings name. One that names a program it can't switch off isn't run (code 128). */
export async function runGit(args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number; input?: string } = {}): Promise<Ran> {
  const own = await ownArgsLater(args, options.cwd)
  if (!own) return { code: 128, stdout: "", stderr: "This repository's own settings name a program Kuvo Code won't run for it." }
  return run("git", own, { ...options, env: { ...GIT_QUIET, ...options.env } })
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

/** On a machine, the PATH its engine's start read (`run/login-path`), after Kuvo Code's own commands: what the bridge goes by until an install reads it again. */
export function useSavedLoginPath() {
  const saved = machineHome ? savedLoginPath(machineHome) : undefined
  if (saved) process.env.PATH = joinPath(process.env.KUVO_BIN, join(machineHome!, "bin"), saved)
}

/**
 * Your login shell's PATH again, so a tool installed since the bridge started (`npm install -g`,
 * Homebrew, an installer that adds a folder to your profile) is found. On this Mac, asked when you
 * refresh, at most every few seconds, one read at a time, answering within a second while a slow
 * one carries on (`now`: again, after an install, waiting for it). On a
 * machine, where a command over SSH gets less than its terminal does (`~/.local/bin` comes from the
 * profile, nvm's node from .bashrc), its engine's start read it once (`useSavedLoginPath`), and
 * only an install reads it again: there's no SSH agent there, and a .bashrc that starts one when
 * there's none would leave one more running with each read.
 */
export async function refreshLoginPath(now = false): Promise<void> {
  if (onMachine && !now) return
  if (reading) {
    if (!now) return answerSoon(reading)
    await reading
  } else if (!now && Date.now() - pathRead < 5_000) return
  const read = (reading = readLoginPath().finally(() => {
    pathRead = Date.now()
    reading = undefined
  }))
  await (now ? read : answerSoon(read))
}

/** A refresh answers within a second (Settings › Accounts waits on it): a slow .zshrc is read on in the background, for the next. */
async function answerSoon(read: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([read, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1_000)))])
  clearTimeout(timer)
}

async function readLoginPath() {
  const found = await loginPath({ ...process.env, PATH: startPath })
  if (!found) return
  // Kuvo Code's own commands (kuvo-wake) first, as the app gave them.
  process.env.PATH = joinPath(process.env.KUVO_BIN, found)
  if (onMachine && machineHome) saveLoginPath(machineHome, found)
}

/** Finds the first web address in some text (a sign-in page a program printed). */
export function firstURL(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'<>]+/)?.[0]
}

/** Text with terminal colors and cursor codes taken out; a move along the line (how a terminal UI
 * spaces its words) is a space, and a move to another line a line break. */
export function plain(text: string): string {
  return text
    .replace(/\x1b\[(\d*)C/g, (_, count) => " ".repeat(Math.min(Number(count || 1), 80)))
    .replace(/\x1b\[\d*G/g, " ")
    // A move to another line (a terminal UI's next line) is a line break.
    .replace(/\x1b\[[0-9;]*[BEFHfd]/g, "\n")
    // Any other control sequence: colors, keyboard modes and queries (`ESC[<u`, `ESC[>0q`).
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Strings: a title, a link, a query's answer.
    .replace(/\x1b[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // A character set (`ESC(B`), and the rest of the short ones.
    .replace(/\x1b[ -/]+[0-~]/g, "")
    .replace(/\x1b[0-~]/g, "")
}
