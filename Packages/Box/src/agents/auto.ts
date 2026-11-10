// Auto: your own orders of models to work with, each a list with a name (one for bugfixes, one
// for features); a session on Auto runs on one of them, named by its model's ID. A session on Auto runs each message on the first
// one in your list that isn't at a limit; when one reaches a usage limit partway, the message goes
// on with the next (the conversation carried over). A limit on a whole account (a plan's 5-hour
// window) skips every model of that provider; a limit on one model (Claude's weekly Opus
// allowance) skips only that model. A limit lasts until its reset, when the agent says when that
// is, and otherwise half an hour (a few minutes for requests too close together).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { emit } from "./events"
export { resetsIn, resetTime } from "../shared/limits"
import { resetsIn } from "../shared/limits"

export const autoProvider = "auto"

export interface AutoEntry {
  providerID: string
  modelID: string
  /** Its effort (thinking) level, if you chose one. */
  variant?: string
}

/** One of your lists: its ID (a session's model names it), its name, and its models in order. */
export interface AutoList {
  id: string
  name: string
  entries: AutoEntry[]
}

/** The first list's ID, which Auto had before there were lists. */
export const firstList = "auto"

/**
 * `entries` as the models they name: one named by another id its model is known by (Claude Code's
 * `default`, whichever model it recommends now) under that model's own id (`own`'s, undefined for
 * none), and one that's then the same model at the same effort as one before it left out.
 */
export function foldEntries(entries: AutoEntry[], own: (entry: AutoEntry) => string | undefined): AutoEntry[] {
  const seen = new Set<string>()
  return entries.flatMap((entry) => {
    const named = { ...entry, modelID: own(entry) ?? entry.modelID }
    const key = `${named.providerID}/${named.modelID}/${named.variant ?? ""}`
    if (seen.has(key)) return []
    seen.add(key)
    return [named]
  })
}

export interface Limit {
  /** A whole account or plan (`provider`), or one model of it (`model`). */
  scope: "provider" | "model"
  /** When it resets, if the agent said (milliseconds since 1970). */
  resetsAt?: number
  /** The agent's own words for it. */
  message?: string
  /** A short one (requests too close together), not a plan's allowance: held a few minutes. */
  brief?: boolean
}

interface Held {
  key: string
  until: number
  scope: "provider" | "model"
  known: boolean
}

const unknownReset = 30 * 60_000
const briefReset = 3 * 60_000

export class Auto {
  private lists: AutoList[] = [{ id: firstList, name: "Custom Auto", entries: [] }]
  private held: Held[] = []

  constructor(private readonly root: string) {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"))
      // (One list, as Auto had before: the first.)
      const lists = Array.isArray(saved.lists) ? saved.lists : [{ id: firstList, name: "Custom Auto", entries: saved.entries ?? [] }]
      const read = Auto.clean(lists)
      if (read.length) this.lists = read
      this.held = (saved.limits ?? []).filter((held: Held) => held?.key && held.until > Date.now())
    } catch {}
    this.schedule()
  }

  private expiry?: ReturnType<typeof setTimeout>

  /** As the first hold ends, it's let go and said (the app's marks of accounts at a limit go then). */
  private schedule() {
    clearTimeout(this.expiry)
    if (!this.held.length) return
    const next = Math.min(...this.held.map((held) => held.until))
    this.expiry = setTimeout(() => {
      this.prune()
      emit("kuvo.auto.updated", {})
      this.schedule()
    }, Math.min(Math.max(next - Date.now(), 0) + 500, 2 ** 31 - 1))
    ;(this.expiry as any).unref?.()
  }

  /** Lists as given, kept to what one can be: an ID, a name, models (not Auto itself). */
  private static clean(lists: any[]): AutoList[] {
    const seen = new Set<string>()
    return lists
      .filter((list) => list && typeof list.id === "string" && /^[\w-]{1,64}$/.test(list.id) && !seen.has(list.id) && seen.add(list.id))
      .map((list) => ({
        id: list.id,
        name: typeof list.name === "string" && list.name.trim() ? list.name.trim().slice(0, 60) : "Custom Auto",
        entries: (Array.isArray(list.entries) ? list.entries : [])
          .filter((entry: AutoEntry) => entry && typeof entry.providerID === "string" && typeof entry.modelID === "string" && entry.providerID !== autoProvider)
          .map((entry: AutoEntry) => ({ providerID: entry.providerID, modelID: entry.modelID, ...(entry.variant ? { variant: entry.variant } : {}) })),
      }))
  }

  private get file() {
    return join(this.root, "auto.json")
  }

  /** A list's models, in order: the one with that ID, or the first (one deleted since). */
  list(id?: string): AutoEntry[] {
    const list = this.lists.find((list) => list.id === id) ?? this.lists[0]
    return (list?.entries ?? []).map((entry) => ({ ...entry }))
  }

  /** Every list, in your order. */
  all(): AutoList[] {
    return this.lists.map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry })) }))
  }

  /** The first list's models (Auto as it was before there were lists). */
  set(entries: AutoEntry[]) {
    const [first, ...rest] = this.lists
    this.lists = [...Auto.clean([{ ...first, entries }]), ...rest]
    this.save()
  }

  /** Your lists, as they are now (one at least). */
  setLists(lists: unknown[]) {
    const kept = Auto.clean(lists)
    if (!kept.length) throw new Error("Keep one list at least.")
    this.lists = kept
    this.save()
  }

  /** What's held back now, and until when. */
  limits(): { key: string; until: number; scope: string; known: boolean }[] {
    this.prune()
    return this.held.map((held) => ({ ...held }))
  }

  clearLimits() {
    this.held = []
    this.save()
    this.schedule()
  }

  /**
   * An account's holds go (its sign-in changed: another account, or a new sign-in): it's tried
   * again. True when it had any.
   */
  release(providerID: string): boolean {
    const before = this.held.length
    this.held = this.held.filter((held) => held.key !== providerID && !held.key.startsWith(providerID + "/"))
    if (this.held.length === before) return false
    this.save()
    this.schedule()
    return true
  }

  private prune() {
    const before = this.held.length
    this.held = this.held.filter((held) => held.until > Date.now())
    if (this.held.length !== before) this.save()
  }

  static providerKey(providerID: string) {
    return providerID
  }

  static modelKey(entry: { providerID: string; modelID: string }) {
    return `${entry.providerID}/${entry.modelID}`
  }

  /** Held back: its provider, or the model itself, is at a limit. */
  isHeld(entry: AutoEntry): Held | undefined {
    this.prune()
    return this.held.find((held) => held.key === Auto.providerKey(entry.providerID) || held.key === Auto.modelKey(entry))
  }

  hold(entry: AutoEntry, limit: Limit) {
    const key = limit.scope === "provider" ? Auto.providerKey(entry.providerID) : Auto.modelKey(entry)
    const known = Boolean(limit.resetsAt && limit.resetsAt > Date.now())
    const until = known ? limit.resetsAt! : Date.now() + (limit.brief ? briefReset : unknownReset)
    this.held = this.held.filter((held) => held.key !== key)
    this.held.push({ key, until, scope: limit.scope, known })
    this.save()
    this.schedule()
  }

  private save() {
    // (Not kept now, a full disk say: held all the same, and kept with the next change. A hold's
    // end and a limit hit mid-turn save from a timer or a turn, which mustn't stop the bridge.)
    try {
      mkdirSync(this.root, { recursive: true })
      writeFileSync(this.file + ".new", JSON.stringify({ lists: this.lists, limits: this.held }, null, 2))
      renameSync(this.file + ".new", this.file)
    } catch (error) {
      console.error("Custom Auto not kept:", error)
    }
  }
}

