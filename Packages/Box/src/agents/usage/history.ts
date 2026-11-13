// An account's usage by the quarter hour: what its requests used and cost in each 15 minutes (UTC),
// by model, and the models that couldn't be priced. Kept that finely, not by the day, so any client
// gets its own days (`daysIn`, a time zone's calendar days, as UsageKit's `DailyUsageAccumulator`
// keys them): every zone's midnight falls on a quarter hour (India's +5:30, Nepal's +5:45). And
// every box's slots of one account add up (`usageRows`).

import { totalTokens, type Pricing } from "./pricing"
import type { ClaudeEntry } from "./claude-log"

/** A slot: a quarter hour. */
export const SLOT = 15 * 60_000
const DAY = 24 * 60 * 60_000

/** How far back a box keeps and shares an account's slots: a month and a few days, so a client's 31 days are whole in any zone. */
export const KEPT_DAYS = 35

/** One model's tokens and dollars in a slot. */
export type Use = [tokens: number, cost: number]

export interface Slots {
  /** Each slot's start (ms, UTC) to each model's use in it. */
  used: Map<number, Map<string, Use>>
  /** Each slot's start to the models in it that couldn't be priced (and counted nowhere). */
  unknown: Map<number, Set<string>>
}

export const noSlots = (): Slots => ({ used: new Map(), unknown: new Map() })

/** What `Unattributed` is in UsageKit: a line with a cost of its own but no model. */
export const UNATTRIBUTED = "Unattributed"

export const slotOf = (at: number) => Math.floor(at / SLOT) * SLOT

/** Claude's entries (deduplicated) by the slot, priced (a line's own `costUSD` first). */
export function claudeSlots(entries: ClaudeEntry[], pricing: Pricing, since: number): Slots {
  const slots = noSlots()
  for (const entry of entries) {
    if (entry.at < since) continue
    const slot = slotOf(entry.at)
    // One trimmed name for the price, the unknown model and the breakdown alike.
    const model = entry.model?.trim() || undefined
    let cost = entry.cost
    if (cost === undefined && model !== undefined) cost = pricing.cost(model, entry.tokens)
    if (cost === undefined) {
      if (model !== undefined && totalTokens(entry.tokens) > 0) addUnknown(slots, slot, model)
      continue
    }
    add(slots, slot, model ?? UNATTRIBUTED, totalTokens(entry.tokens), cost)
  }
  return slots
}

export function add(slots: Slots, slot: number, model: string, tokens: number, cost: number) {
  let models = slots.used.get(slot)
  if (!models) slots.used.set(slot, (models = new Map()))
  const use = models.get(model)
  if (use) {
    use[0] += tokens
    use[1] += cost
  } else models.set(model, [tokens, cost])
}

export function addUnknown(slots: Slots, slot: number, model: string) {
  let models = slots.unknown.get(slot)
  if (!models) slots.unknown.set(slot, (models = new Set()))
  models.add(model)
}

/** Several boxes' (or accounts') slots, added up. */
export function summed(all: Slots[]): Slots {
  const sum = noSlots()
  for (const slots of all) {
    for (const [slot, models] of slots.used) for (const [model, [tokens, cost]] of models) add(sum, slot, model, tokens, cost)
    for (const [slot, models] of slots.unknown) for (const model of models) addUnknown(sum, slot, model)
  }
  return sum
}

/** Slots older than what's kept, let go. */
export function trimmed(slots: Slots, now: number): Slots {
  const since = now - KEPT_DAYS * DAY
  const kept = noSlots()
  for (const [slot, models] of slots.used) if (slot >= since) kept.used.set(slot, models)
  for (const [slot, models] of slots.unknown) if (slot >= since) kept.unknown.set(slot, models)
  return kept
}

// --- As days, in a time zone ---

/** One day's usage, as a client draws it (UsageKit's `DailyUsageEntry` with its models and unknown ones). */
export interface Day {
  /** `yyyy-MM-dd` in the zone asked for. */
  date: string
  tokens: number
  cost: number
  models: { model: string; tokens: number; cost: number }[]
  /** Models used that day that couldn't be priced (counted nowhere). */
  unknown?: string[]
}

const formats = new Map<string, Intl.DateTimeFormat>()

/** A time zone's IANA name, if this computer knows it. */
export function knownZone(zone: string | null | undefined): string | undefined {
  if (!zone || zone.length > 64) return undefined
  try {
    dayFormat(zone)
    return zone
  } catch {
    return undefined
  }
}

/** This computer's own time zone. */
export const ownZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

function dayFormat(zone: string) {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" })
    formats.set(zone, format)
  }
  return format
}

/** The calendar day `at` falls on in `zone`, as `yyyy-MM-dd`. */
export function dayIn(at: number, zone: string): string {
  const parts = dayFormat(zone).formatToParts(at)
  const part = (type: string) => parts.find((each) => each.type === type)?.value ?? "00"
  return `${part("year")}-${part("month")}-${part("day")}`
}

/** Today and the 30 days before it in `zone` (UsageKit's window: `UsageHistoryWindow`), newest first. */
export function windowDays(now: number, zone: string, previous = 30): string[] {
  const [year, month, day] = dayIn(now, zone).split("-").map(Number) as [number, number, number]
  const noon = Date.UTC(year, month - 1, day, 12)
  return Array.from({ length: previous + 1 }, (_, back) => new Date(noon - back * DAY).toISOString().slice(0, 10))
}

/**
 * The slots as days in `zone`, within today and the 30 days before: newest first, only days with
 * priced use listed with their totals (as UsageKit's series), a day with only unknown models listed
 * with none. Models in each day by name.
 */
export function daysIn(slots: Slots, zone: string, now: number): Day[] {
  const window = new Set(windowDays(now, zone))
  const days = new Map<string, { models: Map<string, Use>; unknown: Set<string> }>()
  const dayOf = (date: string) => {
    let found = days.get(date)
    if (!found) days.set(date, (found = { models: new Map(), unknown: new Set() }))
    return found
  }
  for (const [slot, models] of slots.used) {
    const date = dayIn(slot, zone)
    if (!window.has(date)) continue
    const day = dayOf(date)
    for (const [model, [tokens, cost]] of models) {
      const use = day.models.get(model)
      if (use) {
        use[0] += tokens
        use[1] += cost
      } else day.models.set(model, [tokens, cost])
    }
  }
  for (const [slot, models] of slots.unknown) {
    const date = dayIn(slot, zone)
    if (!window.has(date)) continue
    for (const model of models) dayOf(date).unknown.add(model)
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, { models, unknown }]) => {
      const listed = [...models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([model, [tokens, cost]]) => ({ model, tokens, cost }))
      return {
        date,
        tokens: listed.reduce((sum, each) => sum + each.tokens, 0),
        cost: listed.reduce((sum, each) => sum + each.cost, 0),
        models: listed,
        ...(unknown.size ? { unknown: [...unknown].sort() } : {}),
      }
    })
}

// --- Kept and told: compact ---

/** Slots as JSON: models named once, each use `[slot (quarter hours since 1970), model's index, tokens, dollars]`. */
export interface KeptSlots {
  models: string[]
  used: [number, number, number, number][]
  unknown?: [number, number][]
}

export function keptSlots(slots: Slots): KeptSlots {
  const models: string[] = []
  const index = (model: string) => {
    let at = models.indexOf(model)
    if (at < 0) at = models.push(model) - 1
    return at
  }
  const used: KeptSlots["used"] = []
  for (const [slot, uses] of [...slots.used].sort(([a], [b]) => a - b)) for (const [model, [tokens, cost]] of uses) used.push([slot / SLOT, index(model), tokens, Math.round(cost * 1e6) / 1e6])
  const unknown: [number, number][] = []
  for (const [slot, names] of [...slots.unknown].sort(([a], [b]) => a - b)) for (const model of names) unknown.push([slot / SLOT, index(model)])
  return { models, used, ...(unknown.length ? { unknown } : {}) }
}

/** Kept or told slots back, checked: what isn't one is left out (tokens are whole numbers); at most `most` uses. */
export function slotsFrom(given: unknown, most = 50_000): Slots {
  const slots = noSlots()
  if (!given || typeof given !== "object") return slots
  const kept = given as Partial<KeptSlots>
  const models = Array.isArray(kept.models) ? kept.models.map((model) => (typeof model === "string" ? model.slice(0, 200) : undefined)) : []
  const slotAt = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 1e9 ? value * SLOT : undefined)
  for (const use of (Array.isArray(kept.used) ? kept.used : []).slice(0, most)) {
    if (!Array.isArray(use)) continue
    const [slot, model, tokens, cost] = [slotAt(use[0]), typeof use[1] === "number" ? models[use[1]] : undefined, use[2], use[3]]
    if (slot === undefined || model === undefined || !Number.isSafeInteger(tokens) || tokens < 0 || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue
    add(slots, slot, model, tokens, cost)
  }
  for (const each of (Array.isArray(kept.unknown) ? kept.unknown : []).slice(0, most)) {
    if (!Array.isArray(each)) continue
    const [slot, model] = [slotAt(each[0]), typeof each[1] === "number" ? models[each[1]] : undefined]
    if (slot !== undefined && model !== undefined) addUnknown(slots, slot, model)
  }
  return slots
}
