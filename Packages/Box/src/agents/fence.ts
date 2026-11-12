// The box's sandbox, as the coding agents' own programs run their commands in it (PROTOCOL.md,
// "Sandbox"): the rules the box writes for its launcher (`run/fence/policy.json`), while it has the
// sandbox on here (`run/fence/on`). The coding agents run whole in it, through its launcher.

import { createHash, randomBytes } from "node:crypto"
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { processRuns, sandboxGeneration } from "../shared/platform"
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

/**
 * Where the app's own server for Kuvo Code's tools is (as the app says), noted for the box's link
 * (`run/tools.json`), whose sandbox refuses it as Kuvo Code's other servers: only an agent's relay
 * reaches it, with its password.
 */
export function noteToolServer(url: string | undefined) {
  const where = folder()
  if (!where) return
  const record = join(dirname(where), "tools.json")
  let port = 0
  try {
    port = Number(new URL(url ?? "").port)
  } catch {}
  try {
    if (!port) return rmSync(record, { force: true })
    writeFileSync(record + ".new", JSON.stringify({ port }), { mode: 0o600 })
    renameSync(record + ".new", record)
  } catch {}
}

/** For the keys an agent's process is started again by: " full" while the box has `session` in
 * Full Access here (`run/fence/full/<session>`), which the launcher runs outside the sandbox. */
export function fullAccessMark(session: string | undefined): string {
  const where = folder()
  return where && session && /^ses_[A-Za-z0-9_]+$/.test(session) && existsSync(join(where, "full", session)) ? " full" : ""
}

/**
 * Whether this box has a sandbox here that isn't on now (taken away after a failed check, or
 * turned off): a conversation whose rules were made while it was on (Auto) asks before its
 * commands until the box makes them again, so none runs outside it unasked meanwhile.
 */
export function fenceOff(): boolean {
  const where = folder()
  return Boolean(where) && existsSync(where!) && !fenceOn()
}

/** Whether the box's sandbox is on here: its commands run in it. */
export function fenceOn(): boolean {
  const where = folder()
  return Boolean(where) && process.env.KUVO_SANDBOX !== "off" && existsSync(join(where!, "on"))
}

/**
 * Until the box that runs here now has set up its sandbox, or found it can't run here
 * (`run/fence/decided`, naming it): a coding agent started before then would run outside it until
 * it stops. Not while it's off (Kuvo Code's kill switch), there's no sandbox folder, or on a machine
 * no box runs or starts, and no longer than `bound`, for a box that doesn't start: then the agents
 * start as the sandbox is.
 */
export async function untilSandboxDecided(bound = 30_000): Promise<void> {
  const where = folder()
  if (!where || process.env.KUVO_SANDBOX === "off") return
  const run = dirname(where)
  // On a machine, only while its box runs or its keeper starts it (`run/link.needed`): one with
  // nothing to answer doesn't run, so nothing would say. (This Mac's app starts its box first.)
  if (!process.env.KUVO_FENCE && !existsSync(join(run, "link.needed")) && !boxRuns(join(run, "link.pid"))) return
  // Said by the box that runs now: not one that stopped since (a restart, a crash).
  const decided = () => boxRuns(join(where, "decided"))
  if (decided()) return
  console.error("Waiting for the box to set up its sandbox before starting any coding agent.")
  const until = Date.now() + bound
  await new Promise<void>((done) => {
    const look = setInterval(() => {
      if (!decided() && Date.now() < until) return
      if (!decided()) console.error("The box didn't set up its sandbox in time: the coding agents start as it is.")
      clearInterval(look)
      done()
    }, 100)
  })
}

/** Whether the process a record names (`{pid}`, or the number alone) is the box's link. */
const boxRuns = (record: string) => {
  try {
    const text = readFileSync(record, "utf8")
    return processRuns(/^\d+$/.test(text.trim()) ? Number(text) : JSON.parse(text).pid, "kuvo-link")
  } catch {
    return false
  }
}

/**
 * Tells the box's link whether every agent's process here runs in the sandbox (`run/fence/agents`:
 * this bridge, for the sandbox as it is now), which opens the vault to agents; `outside` while one
 * started before it was on still runs (the box asks you once to restart them); gone while it's off.
 */
let noted = ""
export function noteAgentsInside(inside: boolean) {
  const where = folder()
  if (!where) return
  const on = process.env.KUVO_SANDBOX === "off" ? "" : sandboxGeneration(join(where, "on"))
  const note = on ? JSON.stringify({ pid: process.pid, on, ...(inside ? {} : { outside: true }) }) : ""
  if (note === noted) return
  const record = join(where, "agents")
  try {
    if (note) {
      writeFileSync(record + ".new", note, { mode: 0o600 })
      renameSync(record + ".new", record)
    } else rmSync(record, { force: true })
    noted = note
  } catch {}
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
 * the box tells its launcher: by its real path's sum, one a line; a worktree of a repository (a
 * session's branch) by its repository's folder, the project's, as the launcher reads it. Each by
 * the real path it was given: one that's become a link since isn't.
 */
export function allowedFolders(directory: string): string[] {
  const where = folder()
  if (!where) return []
  const work = real(directory)
  const git = repositoryOf(work)
  let project = work
  try {
    if (statSync(join(work, ".git")).isFile() && git.endsWith("/.git")) project = dirname(git)
  } catch {}
  try {
    return readFileSync(join(where, "allowed", sum(project)), "utf8").split("\n").filter((line) => line.startsWith("/") && real(line) === line).slice(0, 8)
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

/** How many homes of its own, and folders it only reads, an agent run whole has (each; link/fence/seatbelt.ts). */
const AGENT_FOLDERS = 4

/** An agent's own places, as it runs whole in the sandbox (`fenceAgent`). */
export interface AgentPlaces {
  /** Its homes: read, and written only in its state (on a Mac; on Linux, whole). The first is where
   * its sign-in is: a secret of yours there is its own (your Codex's `auth.json`), never in another. */
  homes: string[]
  /** What at its homes' top it writes (its sign-in, databases, conversations, logs): files, or folders whole, by name (`*` for any letters). */
  state: string[]
  /** What it never writes anywhere in its homes (settings it keeps in its state), by name (`*` for any letters). */
  kept: string[]
  /** Folders it only reads (in Kuvo Code's, hidden from commands: the skills it's given). */
  read: string[]
  /** Its Kuvo Code tools' port (the relay's). */
  port?: number
  /** The conversation it runs, by its id: as the engine names its own commands' (a bot's own folder
   * is found by it, for its memory and wake-ups). */
  session?: string
  /** The bot whose seat in a group chat it is (`seatBot`), for that bot's memory. */
  bot?: string
}

/** The bot a conversation is the seat of in a group chat, as its box marked it. */
export const seatBot = (session: { metadata?: Record<string, unknown> } | undefined): string | undefined => {
  const bot = (session?.metadata?.kuvo as { seat?: { bot?: unknown } } | undefined)?.seat?.bot
  return typeof bot === "string" && /^bot_[A-Za-z0-9]+$/.test(bot) ? bot : undefined
}

/**
 * For an agent run whole in the sandbox (Claude Code, Codex, Grok, Cursor): the launcher that runs it
 * (`run/fence/shell/run`) and what it's told: its program, the conversation's folder and
 * repository, and its own places. (On a Mac, its homes only read but their state: what runs
 * outside the sandbox when you use it yourself, its settings, plugins and skills, stays as it was.
 * On Linux, its homes whole: Landlock can't keep folders apart inside one it lets the agent make
 * files in; a machine's agents' homes are Kuvo Code's own there.)
 * Undefined while the sandbox is off here.
 */
export function fenceAgent(program: string, directory: string, mine: AgentPlaces): { command: string; env: Record<string, string>; ended: () => void } | undefined {
  const where = folder()
  if (!where || !fenceRules()) return undefined
  // What an earlier run left (one that stopped with the box).
  unlinked(mine.homes, mine.state)
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
      // (Not one in a home of its own, which it reads already: each place counts.)
      KUVO_FENCE_READ: places(mine.read.filter((place) => !mine.homes.some((home) => real(place) === real(home) || real(place).startsWith(real(home) + "/")))),
      KUVO_FENCE_STATE: names(mine.state),
      KUVO_FENCE_KEPT: names(mine.kept),
      KUVO_FENCE_PORT: String(mine.port ?? 0),
      ...(mine.session && /^ses_[A-Za-z0-9]+$/.test(mine.session) ? { OPENCODE_SESSION_ID: mine.session } : {}),
      ...(mine.bot && /^bot_[A-Za-z0-9]+$/.test(mine.bot) ? { KUVO_FENCE_BOT: mine.bot } : {}),
    },
    // As it stops (call it then).
    ended: () => unlinked(mine.homes, mine.state),
  }
}

/**
 * For one of the computer's MCP servers an agent reaches through the relay (toolrelay.ts): the
 * launcher that runs its command in the sandbox as the conversation's own commands run (in its
 * folder and repository, nothing of an agent's own). Undefined while the sandbox is off here.
 */
export const fenceServer = (program: string, directory: string, own: { homes: string[]; read: string[] }) => fenceAgent(program, directory, { homes: own.homes, state: own.homes.length ? ["*"] : [], kept: [], read: own.read })

/**
 * The links inside an agent's state folders, taken away (by the box, outside the sandbox): the
 * agents make none there, and a command can't make one either, but can move in a folder with one
 * inside, which your own agent, outside the sandbox, would write through to elsewhere. (A state
 * folder that is itself a link, yours, stays.)
 */
function unlinked(homes: string[], state: string[]) {
  const named = new RegExp(`^(${state.map((name) => name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})$`)
  const entries = (folder: string): Dirent[] => {
    try {
      return readdirSync(folder, { withFileTypes: true })
    } catch {
      return []
    }
  }
  const inside = (folder: string) => {
    for (const entry of entries(folder)) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) inside(path)
      else if (entry.isSymbolicLink())
        try {
          unlinkSync(path)
        } catch {}
    }
  }
  for (const home of homes) for (const entry of entries(home)) if (entry.isDirectory() && named.test(entry.name)) inside(join(home, entry.name))
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
