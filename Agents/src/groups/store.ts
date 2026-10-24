// What a group chat on a machine keeps, in Kuvo Code's folder there (`~/.kuvo-code/groups`): each
// chat's own folder (its record and its messages, as the Mac writes them, and `awake` while it has a
// meeting coming or is talking or working, which keeps the engine up), and the settings the Mac
// gives every chat there. Its bots are read from their own folders (`~/.kuvo-code/bots`), as they
// are now: a bot changed from elsewhere (its job, from the phone) is as it is.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ModelRef } from "../wire"
import type { SeatResult } from "./seat"
import { jobInMemory, type Group, type GroupMessage, type Rule, type SeatBot } from "./rules"

/** Goes up only when what's kept changes in a way an older runner can't follow. */
export const version = 1

/** "held": brought here, not yet started (a move under way); "active": talking here. */
export type Status = "held" | "active"

export interface Kept {
  group: Group
  status: Status
  /** Talking when the runner last stopped: it says so, and waits for Keep Going. */
  talking?: boolean
  messages: GroupMessage[]
}

/** What the Mac says for every chat on this machine. */
export interface Settings {
  /** What each personality tells a bot, by its ID. */
  personalities: Record<string, string>
  /** Who sets what about a bot (the Mac's Bots.identityNote). */
  identityNote: string
  /** Ask First: seats don't fetch pages. */
  askFirst: boolean
  /** What Settings › Permissions denies. */
  denies: Rule[]
  /** The user's time zone, for meetings, and how they write dates. */
  timeZone?: string
  locale?: string
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string")
const stringMap = (value: unknown): value is Record<string, string> =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((item) => typeof item === "string")
const isDate = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value))

/** A chat as the Mac writes one, `id` its own; what the runner reads it by checked (a move brings it whole). */
export function isGroup(value: any, id: string): value is Group {
  if (!value || value.id !== id || typeof value.name !== "string" || !strings(value.members) || !isDate(value.created)) return false
  if (!stringMap(value.seats) || !stringMap(value.heard)) return false
  if (value.seatBoxes !== undefined && !stringMap(value.seatBoxes)) return false
  if (value.purpose !== undefined && value.purpose !== null && typeof value.purpose !== "string") return false
  if (value.agentSeats !== undefined && !strings(value.agentSeats)) return false
  if (value.retracted !== undefined && value.retracted !== null && !stringMap(value.retracted)) return false
  if (value.viewed !== undefined && !isDate(value.viewed)) return false
  return value.meeting === undefined || value.meeting === null || isMeeting(value.meeting)
}

export function isMeeting(value: any): boolean {
  if (!value || !isDate(value.next) || typeof value.topic !== "string") return false
  if (value.every !== undefined && value.every !== null && typeof value.every !== "string") return false
  if (value.at !== undefined && value.at !== null && typeof value.at !== "number") return false
  return value.weekday === undefined || value.weekday === null || typeof value.weekday === "number"
}

const kinds = new Set(["message", "wrapUp", "note", "meeting"])
const states = new Set(["proposed", "waiting", "working", "done", "failed"])

export function isMessages(value: unknown): value is GroupMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (message: any) =>
        message &&
        typeof message.id === "string" &&
        typeof message.text === "string" &&
        isDate(message.time) &&
        kinds.has(message.kind) &&
        (message.author === undefined || message.author === null || typeof message.author === "string") &&
        (message.tasks === undefined ||
          (Array.isArray(message.tasks) &&
            message.tasks.every((task: any) => task && typeof task.id === "string" && typeof task.bot === "string" && typeof task.task === "string" && states.has(task.state)))),
    )
  )
}

/** A chat on another computer, as a bot here remembers it. */
export interface PeerMemory {
  name: string
  with: string[]
  recap: string
  /** Its transcript, in the bot's folder. */
  file: string
  /** When it last moved on. */
  time: string
  /** When its computer said this (its clock, milliseconds): what it says later is newer. */
  at?: number
}

/** How long a chat a bot forgot is remembered as forgotten: longer than its computer's mail is sent again. */
const forgottenFor = 3 * 86_400_000

/** A part of a chat on another computer, given to a bot here. */
export interface PeerWork {
  /** The chat's computer, by key. */
  host: string
  chat: string
  wrapUp: string
  bot: string
  /** Its message in the bot's own conversation, once it went there. */
  prompt?: string
  started: string
  /** Done, how it went and when: told again whenever the part is given again, for as long as it's remembered. */
  done?: boolean
  result?: SeatResult
  finished?: string
}

/** A turn a chat on another computer gave a bot here, as far as it got: its seat, its message there and when it went, and how it ended. */
export interface PeerTurn {
  /** The chat's computer, by key. */
  host: string
  at: number
  seat?: string
  agents?: boolean
  prompt?: string
  sent?: number
  result?: SeatAnswerKept
}

/** How a turn ended, with the seat it ended in (`SeatAnswer` in peer.ts). */
export type SeatAnswerKept = SeatResult & { seat?: string; agents?: boolean; replaced?: string }

/** One of the machine's bots, as its folder has it. */
export interface MachineBot extends SeatBot {
  sessionID: string
  directory: string
  model?: ModelRef
  personality?: string
  /** Its conversation runs with the coding agents (this bridge), not the engine. */
  agents: boolean
  /** How it looks, as its description has it (BotLook: color, shape, face). */
  look?: unknown
  /** When it was made. */
  created?: string
}

const read = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

const text = (file: string): string | undefined => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Written whole or not at all, only this user can read it. */
function write(file: string, value: unknown) {
  writeFileSync(file + ".new", JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(file + ".new", file)
}

export class GroupStore {
  constructor(
    readonly root: string,
    readonly bots: string,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  private folder(id: string) {
    return join(this.root, id)
  }

  /** Every chat kept here that this runner can read (one from a newer version is left as it is). */
  load(): Map<string, Kept> {
    const all = new Map<string, Kept>()
    let names: string[] = []
    try {
      names = readdirSync(this.root)
    } catch {}
    for (const id of names) {
      if (!/^grp_[a-z0-9]+$/.test(id)) continue
      const kept = this.read(id)
      if (kept) all.set(id, kept)
    }
    return all
  }

  read(id: string): Kept | undefined {
    const record = read(join(this.folder(id), "group.json"))
    if (!record || typeof record.kuvo !== "number" || record.kuvo > version || !isGroup(record.group, id)) return undefined
    const messages = read(join(this.folder(id), "messages.json")) ?? []
    // One whose messages won't read is left as it is, for a newer version or a person to look at.
    if (!isMessages(messages)) return undefined
    return { group: record.group, status: record.status === "held" ? "held" : "active", talking: record.talking === true, messages }
  }

  saveGroup(kept: Kept) {
    mkdirSync(this.folder(kept.group.id), { recursive: true, mode: 0o700 })
    write(join(this.folder(kept.group.id), "group.json"), { kuvo: version, status: kept.status, ...(kept.talking ? { talking: true } : {}), group: kept.group })
  }

  saveMessages(kept: Kept) {
    mkdirSync(this.folder(kept.group.id), { recursive: true, mode: 0o700 })
    write(join(this.folder(kept.group.id), "messages.json"), kept.messages)
  }

  /** Whether the chat keeps the engine up: a meeting coming, a discussion or work under way. */
  setAwake(id: string, awake: boolean) {
    const file = join(this.folder(id), "awake")
    if (awake && !existsSync(file) && existsSync(this.folder(id))) writeFileSync(file, "")
    if (!awake) rmSync(file, { force: true })
  }

  /** The chat's folder, to Kuvo Code's trash on the machine. */
  trash(id: string, trash: string) {
    if (!existsSync(this.folder(id))) return
    const into = join(trash, `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "")}-group-${id}`)
    mkdirSync(into, { recursive: true, mode: 0o700 })
    renameSync(this.folder(id), join(into, id))
  }

  settings(): Settings | undefined {
    const value = read(join(this.root, "settings.json"))
    if (!value || typeof value !== "object") return undefined
    return {
      personalities: value.personalities && typeof value.personalities === "object" ? value.personalities : {},
      identityNote: typeof value.identityNote === "string" ? value.identityNote : "",
      askFirst: value.askFirst === true,
      denies: Array.isArray(value.denies) ? value.denies.filter((rule: any) => rule?.effect === "deny" && typeof rule.action === "string") : [],
      timeZone: typeof value.timeZone === "string" ? value.timeZone : undefined,
      locale: typeof value.locale === "string" ? value.locale : undefined,
    }
  }

  writeSettings(settings: Settings) {
    write(join(this.root, "settings.json"), { kuvo: version, ...settings })
  }

  /** Every bot on this machine, as their folders have them now. */
  allBots(): MachineBot[] {
    let names: string[] = []
    try {
      names = readdirSync(this.bots)
    } catch {}
    return names.flatMap((name) => this.bot(name) ?? [])
  }

  /** A bot as its folder has it now; undefined for one that isn't on this machine. */
  bot(id: string): MachineBot | undefined {
    if (!/^bot_[A-Za-z0-9]+$/.test(id)) return undefined
    const folder = join(this.bots, id)
    const described = read(join(folder, "bot.json"))
    const sessionID = text(join(folder, "session"))?.trim()
    if (!described?.name || !sessionID) return undefined
    const memory = text(join(folder, "MEMORY.md"))
    const job = memory ? jobInMemory(memory) : undefined
    const directory = text(join(folder, "directory"))?.trim() || join(folder, "workspace")
    return {
      id,
      name: String(described.name),
      job: job?.line ?? String(described.job ?? ""),
      instructions: job?.section ?? "",
      memoryFile: join(folder, "MEMORY.md"),
      folder,
      sessionID,
      directory,
      model: described.model?.id && described.model?.providerID ? described.model : undefined,
      personality: typeof described.personality === "string" ? described.personality : undefined,
      agents: text(join(folder, "via"))?.trim() === "bridge",
      ...(described.look !== undefined ? { look: described.look } : {}),
      ...(typeof described.created === "string" ? { created: described.created } : {}),
    }
  }

  // MARK: Chats on your other computers

  /** What chats on other computers said a bot here remembers of them, by `<computer>/<chat>`. */
  peerMemory(bot: string): Record<string, PeerMemory> {
    const entries = this.peerEntries(bot)
    return Object.fromEntries(Object.entries(entries).filter(([, entry]) => !entry.forgotten)) as Record<string, PeerMemory>
  }

  /** When its computer last said what a bot here remembers of a chat there (`<computer>/<chat>`), or that it forgets it: what's older is refused. */
  peerMemoryAt(bot: string, key: string): number {
    const at = this.peerEntries(bot)[key]?.at
    return typeof at === "number" ? at : 0
  }

  private peerEntries(bot: string): Record<string, any> {
    const all = read(join(this.root, "peer-memory.json"))
    const entries = all && typeof all === "object" ? all[bot] : undefined
    return entries && typeof entries === "object" ? entries : {}
  }

  keepPeerMemory(bot: string, key: string, memory: PeerMemory) {
    this.changePeerMemory(bot, (entries) => (entries[key] = memory))
  }

  /** Forgotten: what comes of it later, but said before (`at`), is refused for a while. */
  forgetPeerMemory(bot: string, key: string, at?: number) {
    this.changePeerMemory(bot, (entries) => {
      if (typeof at === "number" && at > 0) entries[key] = { forgotten: true, at, time: new Date().toISOString() }
      else delete entries[key]
    })
  }

  private changePeerMemory(bot: string, change: (entries: Record<string, any>) => void) {
    const all = read(join(this.root, "peer-memory.json")) ?? {}
    const entries: Record<string, any> = { ...(all[bot] ?? {}) }
    change(entries)
    for (const [key, entry] of Object.entries(entries)) if (entry?.forgotten && !(Date.now() - Date.parse(entry.time) < forgottenFor)) delete entries[key]
    if (Object.keys(entries).length === 0) delete all[bot]
    else all[bot] = entries
    write(join(this.root, "peer-memory.json"), all)
  }

  /** Parts of chats on other computers that bots here are doing, followed until they report (across restarts), by the part's id. */
  peerWork(): Record<string, PeerWork> {
    const all = read(join(this.root, "peer-work.json"))
    return all && typeof all === "object" ? all : {}
  }

  keepPeerWork(task: string, work: PeerWork | undefined) {
    const all = this.peerWork()
    if (work) all[task] = work
    else delete all[task]
    write(join(this.root, "peer-work.json"), all)
  }

  /** Turns that chats on other computers gave bots here, by the turn's id: so one asked again after the bridge restarted goes on where it was. */
  peerTurns(): Record<string, PeerTurn> {
    const all = read(join(this.root, "peer-turns.json"))
    return all && typeof all === "object" ? all : {}
  }

  keepPeerTurns(turns: Record<string, PeerTurn>) {
    write(join(this.root, "peer-turns.json"), turns)
  }

  /** A chat's transcript in a bot's folder, for it to read (written whole, only this user can read it). */
  writeFile(path: string, contents: string) {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path + ".new", contents, { mode: 0o600 })
    renameSync(path + ".new", path)
  }

  removeFile(path: string) {
    rmSync(path, { force: true })
  }
}
