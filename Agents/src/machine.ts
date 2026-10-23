// The bridge on one of your machines (Linux, over SSH), beside the machine's engine: everything it
// and its agents keep is in Kuvo Code's folder there (`~/.kuvo-code/agents`). The agents' programs
// are the machine's own, as on a Mac: found on its PATH (your login shell's), installed and
// updated with their makers' installers, which put them where they would for you.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** It runs on a machine, not on this Mac. */
export const onMachine = process.env.KUVO_AGENTS_REMOTE === "1"

/** The machine's Kuvo Code folder (`~/.kuvo-code`). */
export const machineHome = process.env.KUVO_HOME

/**
 * The machine's own folders (XDG_…, npm's cache, Bun's), as they were before its engine's launch
 * pointed them into Kuvo Code's folder (`KUVO_OWN_…`; undefined: not set). The agents keep theirs
 * there (Claude Code's caches and logs, say); only the commands they run get these back, as the
 * engine's commands do, so tools find their sign-ins and settings (`gh`, git's own).
 */
export const ownFolders: Record<string, string | undefined> = {}

/** Takes them out of the environment, into `ownFolders`. */
export function takeOwnFolders() {
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith("KUVO_OWN_")) continue
    const name = key.slice("KUVO_OWN_".length)
    if (name) ownFolders[name] = process.env[key] || undefined
    delete process.env[key]
  }
}

/**
 * An agent's environment with the machine's own config and data folders back (`XDG_CONFIG_HOME`,
 * `XDG_DATA_HOME`), for an agent whose commands can't be given them alone (Grok's, Antigravity's):
 * `gh` and git find their settings; its caches and state stay in Kuvo Code's folder, and its own
 * sign-in and conversations are in its home there anyway.
 */
export function withOwnFolders(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!onMachine) return env
  const result = { ...env }
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
    if (!(name in ownFolders)) continue
    if (ownFolders[name]) result[name] = ownFolders[name]
    else delete result[name]
  }
  return result
}

/**
 * The environment a command runs with as in your own terminal there: every one of the machine's
 * own folders back (unset: `undefined`, for `run` to leave out). An agent's installer and updater
 * run so, and put it where they would for you. On this Mac, nothing to give back.
 */
export function ownEnvironment(): Record<string, string | undefined> {
  return onMachine ? { ...ownFolders } : {}
}

/** A script that gives a command them back (Claude Code sources it before each: `CLAUDE_ENV_FILE`). */
export function ownFoldersScript(folder: string): string | undefined {
  const names = Object.keys(ownFolders)
  if (!names.length) return undefined
  const quoted = (value: string) => "'" + value.replace(/'/g, `'\\''`) + "'"
  const text = names.map((name) => (ownFolders[name] ? `export ${name}=${quoted(ownFolders[name]!)}` : `unset ${name}`)).join("\n") + "\n"
  const file = join(folder, "own-folders.sh")
  try {
    if (readFileSync(file, "utf8") === text) return file
  } catch {}
  mkdirSync(folder, { recursive: true })
  writeFileSync(file, text, { mode: 0o600 })
  return file
}

/** The same for Codex, as settings of a thread's commands (`shell_environment_policy`). */
export function ownFoldersConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [name, value] of Object.entries(ownFolders)) {
    if (value) config[`shell_environment_policy.set.${name}`] = value
    else unset.push(name)
  }
  if (unset.length) config["shell_environment_policy.exclude"] = unset
  return config
}

/** The machine's engine, as its launch wrote it down (`run/engine.json`): its process, where it listens, its password. */
export function machineEngine(): { pid: number; url: string; password: string } | undefined {
  if (!machineHome) return undefined
  try {
    const record = JSON.parse(readFileSync(join(machineHome, "run", "engine.json"), "utf8"))
    if (typeof record.port !== "number" || typeof record.password !== "string") return undefined
    return { pid: record.pid, url: `http://127.0.0.1:${record.port}`, password: record.password }
  } catch {
    return undefined
  }
}

/**
 * What earlier bridges installed of the agents' programs on a machine, before it used the ones on
 * the machine's PATH (installed with their makers' installers): Codex's and Grok's packages, and
 * the Claude Agent SDK's build of Claude Code (the SDK stays: it runs whichever Claude Code).
 */
export function dropOwnPrograms(runtime: string) {
  for (const agent of ["codex", "grok"]) rmSync(join(runtime, agent), { recursive: true, force: true })
  const scope = join(runtime, "claude", "node_modules", "@anthropic-ai")
  try {
    for (const name of readdirSync(scope)) if (name.startsWith("claude-agent-sdk-linux-")) rmSync(join(scope, name), { recursive: true, force: true })
  } catch {}
}

/**
 * Sign-ins a Mac carried over to this machine before each machine signed in on its own (each
 * marked `<file>.from-mac`): gone, with their marks. A sign-in made here stays.
 */
export function dropCarriedSignIns(home: string) {
  const visit = (folder: string, depth: number) => {
    let names: string[] = []
    try {
      names = readdirSync(folder)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(folder, name)
      if (name.endsWith(".from-mac")) {
        rmSync(path.slice(0, -".from-mac".length), { force: true })
        rmSync(path, { force: true })
      } else if (depth < 5 && name !== "runtime" && name !== "sessions" && name !== "snapshots") {
        try {
          if (statSync(path).isDirectory()) visit(path, depth + 1)
        } catch {}
      }
    }
  }
  visit(home, 0)
}
