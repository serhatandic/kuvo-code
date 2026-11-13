// Grok's session transcripts (`<its home>/sessions/**/updates.jsonl`), as what each completed turn
// used: UsageKit's `GrokLogUsageScanner`, kept the same while both exist (test/fixtures/usage/grok,
// `UsageBoxParityTests`):
// - a line counts when it holds `turn_completed` and is a `turn_completed` session update (under
//   `params.update`, else `update`) with `usage.modelUsage` and a time: `_meta.agentTimestampMs`
//   (under `params`, else the line's own), else the line's `timestamp` (seconds, or ISO 8601);
// - each model in `modelUsage` with input tokens is an entry of its own: cached reads and cache
//   writes come out of the input (never more than it), reasoning is already in the output;
// - Grok's own cost (`costUsdTicks`, 1e-10 dollars; the turn's when it ran only one model) where it
//   says one, else its tokens priced (`pricing.ts`); one that can't be priced counts nowhere but as
//   an unknown model;
// - an event (`_meta.eventId`) copied into another session's transcript counts once per model.
// The debug log (`logs/unified.jsonl`) is capped, so it's never read.

import { addUnknown, add, noSlots, slotOf, type Slots } from "./history"
import { timestamp } from "./claude-log"
import { totalTokens, type Pricing, type Tokens } from "./pricing"

export interface GrokEntry {
  /** When, in ms. */
  at: number
  event?: string
  model: string
  tokens: Tokens
  /** What Grok said it cost, in dollars. */
  cost?: number
}

const MARKER = Buffer.from("turn_completed")
/** A token count past this is corrupt: held to it. */
const MOST_TOKENS = 1_000_000_000_000

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)

/** `ProviderParse.number`: a number (not a boolean), or text that is one; finite. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value)) {
    const found = Number(value)
    return Number.isFinite(found) ? found : undefined
  }
  return undefined
}

function bounded(value: unknown): number {
  const found = numberOf(value)
  if (found === undefined || found <= 0) return 0
  return found > MOST_TOKENS ? MOST_TOKENS : Math.trunc(found)
}

/** One line's entries (none for a line that isn't a completed turn). */
export function grokLine(line: Buffer): GrokEntry[] {
  if (line.indexOf(MARKER) < 0) return []
  let object: unknown
  try {
    object = JSON.parse(line.toString("utf8"))
  } catch {
    return []
  }
  return isObject(object) ? grokEntries(object) : []
}

export function grokEntries(object: Record<string, any>): GrokEntry[] {
  const params = isObject(object.params) ? object.params : undefined
  const update = isObject(params?.update) ? params.update : isObject(object.update) ? object.update : undefined
  if (!update || update.sessionUpdate !== "turn_completed") return []
  const usage = update.usage
  if (!isObject(usage) || !isObject(usage.modelUsage)) return []
  const at = timeOf(object, params)
  if (at === undefined) return []
  const meta = isObject(params?._meta) ? params._meta : isObject(object._meta) ? object._meta : undefined
  const event = typeof meta?.eventId === "string" ? meta.eventId.trim() : undefined
  const models = Object.keys(usage.modelUsage)
  const turnTicks = numberOf(usage.costUsdTicks)
  const entries: GrokEntry[] = []
  // (By name, in code-unit order, as Swift sorts a dictionary's keys.)
  for (const raw of models.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const model = raw.trim()
    const values = usage.modelUsage[raw]
    const inputValue = isObject(values) ? numberOf(values.inputTokens) : undefined
    if (!model || !isObject(values) || inputValue === undefined || inputValue < 0) continue
    const input = bounded(inputValue)
    const cacheRead = Math.min(bounded(values.cachedReadTokens), input)
    const cacheWrite = Math.min(bounded(values.cacheCreationTokens), input - cacheRead)
    const ticks = numberOf(values.costUsdTicks) ?? (models.length === 1 ? turnTicks : undefined)
    entries.push({
      at,
      ...(event ? { event } : {}),
      model,
      tokens: { input: input - cacheRead - cacheWrite, cacheWrite5m: cacheWrite, cacheWrite1h: 0, cacheRead, output: bounded(values.outputTokens) },
      ...(ticks !== undefined && ticks >= 0 ? { cost: ticks / 10_000_000_000 } : {}),
    })
  }
  return entries
}

function timeOf(object: Record<string, any>, params: Record<string, any> | undefined): number | undefined {
  for (const meta of [params?._meta, object._meta]) {
    if (!isObject(meta)) continue
    const ms = numberOf(meta.agentTimestampMs)
    if (ms !== undefined && ms > 0) return ms
  }
  const seconds = numberOf(object.timestamp)
  if (seconds !== undefined && seconds > 0) return seconds * 1000
  // (Text that isn't a number: a time, as OpenUsage reads one.)
  if (typeof object.timestamp === "string" && numberOf(object.timestamp) === undefined) return timestamp(object.timestamp)
  return undefined
}

/** An event copied into another transcript, once per model: the first. Entries without one all count. */
export function dedupGrok(entries: GrokEntry[]): GrokEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (entry.event === undefined) return true
    const key = entry.event + "\u0000" + entry.model
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Grok's entries (deduplicated) by the slot: its own cost where it said one, else priced. */
export function grokSlots(entries: GrokEntry[], pricing: Pricing, since: number): Slots {
  const slots = noSlots()
  for (const entry of entries) {
    if (entry.at < since) continue
    const slot = slotOf(entry.at)
    const cost = entry.cost ?? pricing.cost(entry.model, entry.tokens)
    if (cost === undefined) {
      if (totalTokens(entry.tokens) > 0) addUnknown(slots, slot, entry.model)
      continue
    }
    add(slots, slot, entry.model, totalTokens(entry.tokens), cost)
  }
  return slots
}

// What's kept of each transcript's entries (jsonl.ts), small: [at, event, model, input, cache
// writes, cache reads, output, cost].
export type KeptGrokEntry = [number, string | null, string, number, number, number, number, number | null]

export function keptGrok(entry: GrokEntry): KeptGrokEntry {
  const { input, cacheWrite5m, cacheRead, output } = entry.tokens
  return [entry.at, entry.event ?? null, entry.model, input, cacheWrite5m, cacheRead, output, entry.cost ?? null]
}

export function fromKeptGrok(kept: KeptGrokEntry): GrokEntry {
  const [at, event, model, input, cacheWrite5m, cacheRead, output, cost] = kept
  return { at, ...(event !== null ? { event } : {}), model, tokens: { input, cacheWrite5m, cacheWrite1h: 0, cacheRead, output }, ...(cost !== null ? { cost } : {}) }
}
