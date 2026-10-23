// Running the agents' own programs (`claude`, `codex`, `grok`…), found where your login shell
// would find them: the app hands the bridge that shell's PATH (on a machine, it's read there).

import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { ownEnvironment } from "./machine"

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

let pathRead = 0

/**
 * Your login shell's PATH again, so a tool installed since the bridge started (`npm install -g`,
 * Homebrew, an installer that adds a folder to your profile) is found. Asked when you refresh,
 * at most every few seconds (`now`: again, after an install). On a machine too, with its own
 * folders: a command over SSH gets less than its terminal does (`~/.local/bin` comes from the
 * profile).
 */
export async function refreshLoginPath(now = false): Promise<void> {
  if (!now && Date.now() - pathRead < 5_000) return
  pathRead = Date.now()
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  for (const flags of ["-ilc", "-lc"]) {
    try {
      const ran = await run(shell, [flags, 'printf "__KUVO_PATH__%s__KUVO_END__" "$PATH"'], { timeout: 8_000, env: { ...ownEnvironment(), DISABLE_AUTO_UPDATE: "true" } })
      const found = ran.stdout.match(/__KUVO_PATH__([\s\S]*?)__KUVO_END__/)?.[1]
      if (found?.trim()) {
        // Kuvo Code's own commands (kuvo-wake) first, as the app gave them.
        process.env.PATH = [process.env.KUVO_BIN, found.trim()].filter(Boolean).join(":")
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
