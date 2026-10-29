// The box's sandbox, as the coding agents' own programs run their commands in it (PROTOCOL.md,
// "Sandbox"): the rules the box writes for its launcher (`run/fence/policy.json`), while it has the
// sandbox on here (`run/fence/on`). Each agent puts them in its own terms: Codex as a permission
// profile of its own sandbox.

import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { machineHome } from "./machine"

/** What commands may do: everything read but `hidden`; written only in the session's folder and
 * `writable`; inside those, `readOnly` only read; `readable`, inside `hidden`, read. */
export interface FenceRules {
  hidden: string[]
  readable: string[]
  writable: string[]
  readOnly: string[]
}

/** The box's sandbox folder: this Mac's (the app names it), or a machine's in `~/.kuvo-code`. */
const folder = () => process.env.KUVO_FENCE ?? (machineHome ? join(machineHome, "run", "fence") : undefined)

/** Whether the box's sandbox is on here: its commands run in it. */
export function fenceOn(): boolean {
  const where = folder()
  return Boolean(where) && process.env.KUVO_SANDBOX !== "off" && existsSync(join(where!, "on"))
}

/** The box's rules, while its sandbox is on here; undefined when it's off, or can't be read. */
export function fenceRules(): FenceRules | undefined {
  const where = folder()
  if (!where || process.env.KUVO_SANDBOX === "off" || !existsSync(join(where, "on"))) return undefined
  try {
    const read = JSON.parse(readFileSync(join(where, "policy.json"), "utf8"))
    const paths = (value: unknown) => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string" && each.startsWith("/")) : [])
    return { hidden: paths(read.hidden), readable: paths(read.readable), writable: paths(read.writable), readOnly: paths(read.readOnly) }
  } catch {
    return undefined
  }
}

const real = (place: string) => {
  try {
    return realpathSync(place)
  } catch {
    return place
  }
}

/**
 * The folders you let a project's commands write in too (Also Allowed, `link/fence/allowed.ts`), as
 * the box tells its launcher: by its real path's sum, one a line. Each by the real path it was
 * given: one that's become a link since isn't.
 */
export function allowedFolders(directory: string): string[] {
  const where = folder()
  if (!where) return []
  try {
    return readFileSync(join(where, "allowed", sum(real(directory))), "utf8").split("\n").filter((line) => line.startsWith("/") && real(line) === line).slice(0, 8)
  } catch {
    return []
  }
}

/** What changes with the rules, to tell when an agent's program must start again with new ones. */
export const fenceKey = () => JSON.stringify(fenceRules() ?? null)

/**
 * In a git worktree, the parts of its repository's own folder a commit writes (`objects`, `refs`,
 * `logs`, and the worktree's own folder in it), which are outside the session's folder; none
 * elsewhere. Only a real worktree's, as `gitOf` checks it: a command can write a `.git` file naming
 * any other repository.
 */
export function worktreeGitFolders(directory: string): string[] {
  const git = gitOf(real(directory))
  if (!git.common || !git.own) return []
  return [join(git.common, "objects"), join(git.common, "refs"), join(git.common, "logs"), git.own]
}

/** The launcher's sum for a folder (its real path), as `sha256sum | cut -c 1-32` makes it. */
const sum = (place: string) => createHash("sha256").update(place).digest("hex").slice(0, 32)

/** Whether `git` is a repository's own folder, not a link. */
function isRepository(git: string): boolean {
  try {
    if (lstatSync(git).isSymbolicLink() || !statSync(join(git, "HEAD")).isFile()) return false
    return statSync(join(git, "objects")).isDirectory() && statSync(join(git, "refs")).isDirectory()
  } catch {
    return false
  }
}

/**
 * A folder's git repository, which its commands may write too, as the engine's plugin finds it
 * (`pluginScript` in link/fence/files.ts; keep the two the same): its `.git`, or for a worktree the
 * repository's own folder, from the folder upwards. Only a real one, a worktree the repository names
 * back; "" for none (its commands write only the folder).
 */
export function repositoryOf(folder: string): string {
  return gitOf(folder).common
}

/** A folder's repository (`common`, "" for none) and, in a worktree, the worktree's own folder in it. */
function gitOf(folder: string): { common: string; own?: string } {
  const realOr = (place: string) => {
    try {
      return realpathSync(place)
    } catch {
      return ""
    }
  }
  for (let at = folder; at && at !== dirname(at); at = dirname(at)) {
    const git = join(at, ".git")
    let link
    try {
      link = lstatSync(git)
    } catch {
      continue
    }
    if (link.isSymbolicLink()) return { common: "" }
    if (link.isDirectory()) return { common: isRepository(git) ? realOr(git) : "" }
    try {
      const named = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!named) return { common: "" }
      const own = realOr(resolve(at, named))
      if (!own || basename(dirname(own)) !== "worktrees") return { common: "" }
      if (realOr(readFileSync(join(own, "gitdir"), "utf8").trim()) !== realOr(git)) return { common: "" }
      const common = realOr(resolve(own, readFileSync(join(own, "commondir"), "utf8").trim()))
      return common && common === dirname(dirname(own)) && isRepository(common) ? { common, own } : { common: "" }
    } catch {
      return { common: "" }
    }
  }
  return { common: "" }
}

/**
 * For an agent whose commands run through a shell it's given (Claude Code): the box's shell that
 * runs them in the sandbox (the user's own, zsh or bash, by name), what the launcher's told (the
 * conversation's folder and its repository), and the commands' temporary folder, which they write.
 * Undefined while the sandbox is off here.
 */
export function fenceShell(directory: string): { shell: string; work: string; git: string; temporary: string } | undefined {
  const where = folder()
  if (!where || !fenceRules()) return undefined
  const mine = basename(process.env.SHELL ?? "")
  const shell = [mine, "zsh", "bash"].filter((name) => name === "zsh" || name === "bash").map((name) => join(where, "shell", name)).find((place) => existsSync(place))
  if (!shell) return undefined
  const work = real(directory)
  const temporary = join(where, "tmp", sum(work))
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  return { shell, work, git: repositoryOf(work), temporary }
}

// Where Kuvo Code keeps conversations' wake-ups: a bot's in its own folder, any other's in the
// wakes folder (the agents' bridge's main says where: on this Mac, the app's).
let wakePlaces: { bots?: string; wakes?: string } = {}
export function setWakePlaces(places: { bots?: string; wakes?: string }) {
  wakePlaces = places
}

/**
 * A conversation's wake-up folder, as the launcher finds or makes it for its commands (kuvo-wake;
 * `launcherScript` in link/fence/files.ts, keep the two the same): its bot's folder, or its own in
 * the wakes folder, made with the folder it works in.
 */
export function wakeFolder(sessionID: string, directory: string): string | undefined {
  if (!/^ses_[A-Za-z0-9_]+$/.test(sessionID)) return undefined
  const { bots, wakes } = wakePlaces
  let own: string | undefined
  try {
    for (const bot of bots ? readdirSync(bots) : []) {
      try {
        if (readFileSync(join(bots!, bot, "session"), "utf8") === sessionID) {
          own = join(bots!, bot)
          break
        }
      } catch {}
    }
    if (!own) {
      if (!wakes) return undefined
      own = join(wakes, sessionID)
      if (!existsSync(join(own, "session"))) {
        mkdirSync(own, { recursive: true, mode: 0o700 })
        writeFileSync(join(own, "session"), sessionID, { mode: 0o600 })
        writeFileSync(join(own, "directory"), real(directory), { mode: 0o600 })
      }
    }
    for (const part of ["wakes", "watches", "inbox"]) mkdirSync(join(own, part), { recursive: true, mode: 0o700 })
    return realpathSync(own)
  } catch {
    return undefined
  }
}
