// Keeping an agent's own program current, as T3 Code does: which version you have, the newest
// one, and the way to update it, through the installer that owns it. The agent's models come
// from its program (an old Claude Code lists old Claude models), so an old one is worth knowing
// about.
//
// Who owns an install is read from where the program really is (links followed): a Homebrew keg
// or cask is updated by that Homebrew (`brew upgrade`), an npm global by the npm of that prefix,
// an agent's own installer by the agent's updater (`claude update`, `codex update`, `grok
// update`). A program under some other `node_modules` (a project's, a version manager's) is left
// to you. Nothing runs until you ask; an update counts only if the version changed.

import { existsSync, realpathSync } from "node:fs"
import { basename, join } from "node:path"
import { ownEnvironment } from "./machine"
import { plain, refreshLoginPath, run, runGroup, which } from "./proc"

export interface Maintenance {
  /** The version you have, as the program says. */
  installed?: string
  /** The newest you can update to, when it's known. */
  latest?: string
  /** What updating runs; none when it's yours to do (Kuvo Code can't tell who installed it). */
  command?: string[]
  /** That command as you'd type it. */
  shown?: string
  env?: Record<string, string>
}

export interface MaintenanceDefinition {
  name: string
  executable: string
  npmPackage: string
  /**
   * The agent's own updater, how to tell its own installer put the program there, and the npm
   * dist-tag it updates to (its channel), when not `latest`.
   */
  nativeUpdate?: { args: string[]; isNative: (realPath: string) => boolean; distTag?: () => string }
}

const checked = new Map<string, { at: number; value: Maintenance }>()
const newest = new Map<string, { at: number; value?: string }>()
/** Each program's install or update under way, by its name. */
const underWay = new Map<string, { kind: "install" | "update"; done: Promise<unknown> }>()

/**
 * One install or update at a time for each program: the same one asked again is the one under
 * way; the other waits for it (an install and an update writing the same files at once).
 */
function oneAtATime<T>(name: string, kind: "install" | "update", task: () => Promise<T>): Promise<T> {
  const running = underWay.get(name)
  if (running?.kind === kind) return running.done as Promise<T>
  const done = (async () => {
    await running?.done.catch(() => {})
    return task()
  })()
  const entry = { kind, done }
  underWay.set(name, entry)
  void done.catch(() => {}).finally(() => {
    if (underWay.get(name) === entry) underWay.delete(name)
  })
  return done
}

/** What you have, the newest, and how to update, asked at most every ten minutes unless `fresh`. */
export async function maintenance(definition: MaintenanceDefinition, fresh = false): Promise<Maintenance> {
  const kept = checked.get(definition.executable)
  if (!fresh && kept && Date.now() - kept.at < 10 * 60_000) return kept.value
  const [installed, updater] = await Promise.all([installedVersion(definition.executable), resolveUpdater(definition)])
  // Homebrew's own newest, or none known: npm's may not have reached it.
  const latest = updater.homebrew ? updater.latest : (updater.latest ?? (await npmLatest(definition.npmPackage, fresh, updater.distTag)))
  const value: Maintenance = { installed, latest, command: updater.command, shown: updater.shown, env: updater.env }
  checked.set(definition.executable, { at: Date.now(), value })
  return value
}

/** True when there's a newer version than yours. */
export function isOutdated(maintenance: Maintenance): boolean {
  return Boolean(maintenance.installed && maintenance.latest && compareVersions(maintenance.installed, maintenance.latest) < 0)
}

export interface UpdateResult {
  updated: boolean
  version?: string
  /** What went wrong, in the program's words (its last lines). */
  message?: string
}

/** Runs the update, once at a time per program, and says whether the version changed. */
export function update(definition: MaintenanceDefinition, temporary: string): Promise<UpdateResult> {
  return oneAtATime(definition.name, "update", async (): Promise<UpdateResult> => {
    const before = await maintenance(definition, true)
    if (!before.command) return { updated: false, version: before.installed, message: `Update ${definition.name} the way you installed it.` }
    // As you'd run it in your terminal (on a machine, with its own folders, not Kuvo Code's).
    const ran = await runGroup(before.command[0], before.command.slice(1), { cwd: temporary, env: { ...ownEnvironment(), ...before.env }, timeout: 10 * 60_000 })
    const after = await maintenance(definition, true)
    const changed = Boolean(after.installed && after.installed !== before.installed)
    if (changed || (after.installed && !isOutdated(after))) return { updated: changed, version: after.installed }
    const output = plain(ran.stderr + "\n" + ran.stdout).trim().split("\n").slice(-6).join("\n").trim()
    return {
      updated: false,
      version: after.installed,
      message: `${definition.name} is still ${after.installed ?? "the same version"} after \`${before.shown}\`.${output ? `\n\n${output}` : ""}`,
    }
  })
}

export interface InstallResult {
  installed: boolean
  version?: string
  /** What went wrong, in the installer's words (its last lines). */
  message?: string
}

/**
 * Installs an agent's program with its maker's own installer, the command it shows (`curl … |
 * bash`), run as you'd run it in your terminal (on a machine, with its own folders): it goes where
 * that installer puts it, as if you had, which may add its folder to your shell's profile. Once
 * at a time per agent, and not while it updates; then whether `found` finds it. One that's there
 * already isn't installed again. `readPath`: reads your login shell's PATH (`now`: again).
 */
export function install(name: string, command: string, temporary: string, found: () => string | undefined, readPath: (now?: boolean) => Promise<void> = refreshLoginPath): Promise<InstallResult> {
  return oneAtATime(name, "install", async (): Promise<InstallResult> => {
    // Your login shell's PATH first (Codex's installer leaves your profile alone when its folder is on it).
    await readPath()
    const there = found()
    if (there) return { installed: true, version: await installedVersion(there) }
    const ran = await runGroup("/bin/sh", ["-c", command], { cwd: temporary, env: ownEnvironment(), timeout: 10 * 60_000 })
    // Where it went (a folder the installer added to your PATH), read again.
    await readPath(true)
    const executable = found()
    if (executable) return { installed: true, version: await installedVersion(executable) }
    const output = plain(ran.stderr + "\n" + ran.stdout).trim().split("\n").slice(-6).join("\n").trim()
    return { installed: false, message: `${name} isn't installed after \`${command}\`.${output ? `\n\n${output}` : ""}` }
  })
}

async function installedVersion(executable: string): Promise<string | undefined> {
  const ran = await run(executable, ["--version"], { timeout: 15_000 }).catch(() => undefined)
  return ran ? versionIn(plain(ran.stdout + " " + ran.stderr)) : undefined
}

/** The first version number in some text: "2.1.156 (Claude Code)", "codex-cli 0.159.3". */
export function versionIn(text: string): string | undefined {
  return text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/)?.[1]
}

/** -1, 0 or 1, comparing the numbers part by part (a pre-release before its release). */
export function compareVersions(a: string, b: string): number {
  const [mainA, preA] = a.split("-", 2)
  const [mainB, preB] = b.split("-", 2)
  const partsA = mainA.split(".").map(Number)
  const partsB = mainB.split(".").map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const difference = (partsA[i] ?? 0) - (partsB[i] ?? 0)
    if (difference) return Math.sign(difference)
  }
  if (preA === preB) return 0
  if (!preA) return 1
  if (!preB) return -1
  return preA < preB ? -1 : 1
}

/** The newest release on npm (on a dist-tag: a channel), which an agent's own updater and npm installs follow. */
async function npmLatest(name: string, fresh: boolean, tag = "latest"): Promise<string | undefined> {
  const key = `${name}@${tag}`
  const kept = newest.get(key)
  if (!fresh && kept && Date.now() - kept.at < 6 * 60 * 60_000) return kept.value
  try {
    const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${tag}`, { signal: AbortSignal.timeout(10_000) })
    const value = response.ok ? (((await response.json()) as { version?: string }).version ?? undefined) : undefined
    newest.set(key, { at: Date.now(), value })
    return value
  } catch {
    return kept?.value
  }
}

interface Updater {
  command?: string[]
  shown?: string
  env?: Record<string, string>
  /** What that installer can deliver, when it isn't npm's newest (Homebrew trails it). */
  latest?: string
  /** Homebrew's: only it knows its newest. */
  homebrew?: boolean
  /** The npm dist-tag its updater follows. */
  distTag?: string
}

async function resolveUpdater(definition: MaintenanceDefinition): Promise<Updater> {
  let realPath = definition.executable
  try {
    realPath = realpathSync(definition.executable)
  } catch {}
  const name = basename(definition.executable)
  const native = definition.nativeUpdate
  const nativeUpdater: Updater = native ? { command: [definition.executable, ...native.args], shown: [name, ...native.args].join(" "), distTag: native.distTag?.() } : {}
  if (native?.isNative(realPath) || (native && native.isNative(definition.executable))) return nativeUpdater

  // npm names the package, so it outranks a Homebrew keg the path passes through (a Homebrew
  // Node keeps its globals in its own keg).
  const prefix = npmGlobalPrefix(realPath, definition.npmPackage)
  if (prefix) {
    const npm = existsSync(join(prefix, "bin", "npm")) ? join(prefix, "bin", "npm") : "npm"
    return {
      command: [npm, "install", "-g", "--prefix", prefix, `--allow-scripts=${definition.npmPackage}`, `${definition.npmPackage}@latest`],
      shown: `npm install -g ${definition.npmPackage}@latest`,
      // That npm's own Node first.
      env: { PATH: `${join(prefix, "bin")}:${process.env.PATH ?? ""}` },
    }
  }

  const keg = homebrewKeg(realPath)
  if (keg && keg.name.toLowerCase() !== "mise") {
    const brew = existsSync(join(keg.prefix, "bin", "brew")) ? join(keg.prefix, "bin", "brew") : which("brew")
    if (brew) {
      const said = (await run(brew, ["--prefix"], { timeout: 15_000 }).catch(() => undefined))?.stdout.trim()
      let brewPrefix = said
      try {
        if (said) brewPrefix = realpathSync(said)
      } catch {}
      if (brewPrefix && brewPrefix === keg.prefix) {
        const cask = keg.kind === "cask"
        const info = await run(brew, ["info", "--json=v2", ...(cask ? ["--cask"] : []), keg.name], { timeout: 30_000, env: { HOMEBREW_NO_AUTO_UPDATE: "1" } }).catch(() => undefined)
        return {
          command: [brew, "upgrade", ...(cask ? ["--cask"] : []), keg.name],
          shown: `brew upgrade ${cask ? "--cask " : ""}${keg.name}`,
          latest: info ? homebrewLatest(info.stdout, cask) : undefined,
          homebrew: true,
        }
      }
    }
  }
  // Under someone else's node_modules (a project's, a version manager's): yours to update.
  if (realPath.includes("/node_modules/") || realPath.includes("/mise/")) return {}
  return nativeUpdater
}

/** The npm prefix whose global install this is: `<prefix>/lib/node_modules/<package>/…`. */
export function npmGlobalPrefix(realPath: string, packageName: string): string | undefined {
  const segment = `/lib/node_modules/${packageName.toLowerCase()}/`
  const at = realPath.toLowerCase().lastIndexOf(segment)
  if (at < 0 || realPath.slice(0, at).toLowerCase().includes("/node_modules/")) return undefined
  // Mise's npm backend lays tools out the same way; globals of its Node are npm's.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(realPath.slice(0, at).toLowerCase())?.[1]
  if (miseTool && miseTool !== "node") return undefined
  return at === 0 ? "/" : realPath.slice(0, at)
}

/** A Homebrew formula's keg (`…/Cellar/<name>/<version>/…`) or cask (`…/Caskroom/<name>/…`). */
export function homebrewKeg(realPath: string): { kind: "formula" | "cask"; name: string; prefix: string } | undefined {
  const match = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//i.exec(realPath)
  if (!match) return undefined
  return { kind: match[2].toLowerCase() === "cellar" ? "formula" : "cask", name: match[3], prefix: match[1] }
}

function homebrewLatest(json: string, cask: boolean): string | undefined {
  try {
    const info = JSON.parse(json)
    const raw: string | undefined = cask ? info.casks?.[0]?.version?.split(",", 1)[0] : info.formulae?.[0]?.versions?.stable
    return raw && raw !== "latest" ? raw : undefined
  } catch {
    return undefined
  }
}
