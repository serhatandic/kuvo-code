// The box's sandbox, as the coding agents' own programs run their commands in it (PROTOCOL.md,
// "Sandbox"): the rules the box writes for its launcher (`run/fence/policy.json`), while it has the
// sandbox on here (`run/fence/on`). Claude Code runs its commands through the launcher, as the
// engine does; Codex runs whole in it.

import { createHash, randomBytes } from "node:crypto"
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
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
    if (link.isSymbolicLink()) return ""
    if (link.isDirectory()) return isRepository(git) ? realOr(git) : ""
    try {
      const named = readFileSync(git, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!named) return ""
      const own = realOr(resolve(at, named))
      if (!own || basename(dirname(own)) !== "worktrees") return ""
      if (realOr(readFileSync(join(own, "gitdir"), "utf8").trim()) !== realOr(git)) return ""
      const common = realOr(resolve(own, readFileSync(join(own, "commondir"), "utf8").trim()))
      return common && common === dirname(dirname(own)) && isRepository(common) ? common : ""
    } catch {
      return ""
    }
  }
  return ""
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

/** How many homes of its own, and folders it only reads, an agent run whole has (each; link/fence/seatbelt.ts). */
const AGENT_FOLDERS = 4

/** An agent's own places, as it runs whole in the sandbox (`fenceAgent`). */
export interface AgentPlaces {
  /** Its homes: what's at their top read and written, but `kept`; their folders only read, but `state`. */
  homes: string[]
  /** The folders in its homes it writes whole (its databases, conversations, logs), by name. */
  state: string[]
  /** What at its homes' top it never writes (its settings), by name (`*` for any letters). */
  kept: string[]
  /** Folders it only reads (in Kuvo Code's, hidden from commands: the skills it's given). */
  read: string[]
  /** Its Kuvo Code tools' port (the relay's). */
  port?: number
}

/**
 * For an agent run whole in the sandbox (Codex): the launcher that runs it (`run/fence/shell/run`)
 * and what it's told: its program, the conversation's folder and repository, and its own places.
 * (On a Mac, its homes but their state and the files at their top only read: what runs outside
 * the sandbox when you use it yourself, its plugins and skills, stays as it was. On Linux, its
 * homes whole: Landlock can't keep folders apart inside one it lets the agent make files in.)
 * Undefined while the sandbox is off here.
 */
export function fenceAgent(program: string, directory: string, mine: AgentPlaces): { command: string; env: Record<string, string> } | undefined {
  const where = folder()
  if (!where || !fenceRules()) return undefined
  const command = join(where, "shell", "run")
  if (!existsSync(command)) return undefined
  const work = real(directory)
  // By their real place, which the sandbox goes by (one not made yet, as it's named).
  const places = (list: string[]) => [...new Set(list.map(real))].slice(0, AGENT_FOLDERS).join("\n")
  const names = (list: string[]) => list.filter((name) => name && !name.includes("/") && !name.includes("\n")).join("\n")
  return {
    command,
    env: {
      KUVO_FENCE_SHELL: program,
      KUVO_FENCE_WORK: work,
      KUVO_FENCE_GIT: repositoryOf(work),
      KUVO_FENCE_OWN: places(mine.homes),
      KUVO_FENCE_READ: places(mine.read),
      KUVO_FENCE_STATE: names(mine.state),
      KUVO_FENCE_KEPT: names(mine.kept),
      KUVO_FENCE_PORT: String(mine.port ?? 0),
    },
  }
}

/**
 * Where the files you attach in a conversation are copied for an agent run whole in the sandbox
 * (`fenceCopy`): in the sandbox's folder, which only the box writes, given to the agent to read.
 * Undefined while the sandbox is off here.
 */
export function fenceAttachments(directory: string): string | undefined {
  const where = folder()
  if (!where || !fenceRules()) return undefined
  const attached = join(where, "attachments", sum(real(directory)))
  try {
    mkdirSync(attached, { recursive: true, mode: 0o700 })
    return attached
  } catch {
    return undefined
  }
}

/**
 * A file you attached, for an agent run whole in the sandbox, which hides Kuvo Code's folder where
 * it's kept: a copy it reads (`fenceAttachments`), made anew each time. The file itself where that
 * can't be made.
 */
export function fenceCopy(directory: string, file: string): string {
  const attached = fenceAttachments(directory)
  if (!attached) return file
  const copy = join(attached, `${randomBytes(8).toString("hex")}-${basename(file)}`)
  // Copies made more than a week ago go (their turns are long done; by when each was made: a
  // copy may keep its file's own times).
  try {
    for (const name of readdirSync(attached)) if (Date.now() - statSync(join(attached, name)).ctimeMs > 7 * 86_400_000) rmSync(join(attached, name), { force: true })
  } catch {}
  try {
    copyFileSync(file, copy, constants.COPYFILE_EXCL)
    return copy
  } catch {
    return file
  }
}
