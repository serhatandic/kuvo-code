// Codex's session logs (`<CODEX_HOME>/sessions/**/*.jsonl` and `archived_sessions/`), as what each
// turn used: UsageKit's `CodexLogUsageScanner` and `CodexLogFileParser`, which port ccusage's Codex
// rules, kept the same while both exist (test/fixtures/usage/codex, `UsageBoxParityTests`):
// - a `turn_context` line names the session's model from then on; an `event_msg` `token_count`
//   line carries a turn's use: its `last_token_usage`, else what its running `total_token_usage`
//   grew by since the line before;
// - a running total the same as the last is a snapshot said again, not a turn: left out;
// - a child session's log (a subagent's, a fork's) first replays its parent's turns: those only
//   carry the running total on, until the first turn it started itself (a `task_started` at or
//   after the session's own start);
// - `thread_settings_applied` names the service tier its turns ran on (priority, Ultrafast);
// - a session that never named a model is `gpt-5`;
// - a turn the same as another (when, model, tokens), in this log or another, counts once;
// - priced as Codex prices it (codex-pricing.ts), with the box's fallback model for a model that
//   can't be priced, when one's chosen.

import { timestamp } from "./claude-log"
import { RESERVE, RESERVE_PRICED_AS, AUTO_REVIEW, codexCost, resolveCodexRates } from "./codex-pricing"
import { add, addFallback, addUnknown, noSlots, slotOf, type Slots } from "./history"
import type { Pricing } from "./pricing"

/** One turn's use, its running totals already taken apart. */
export interface CodexEvent {
  /** When, in ms. */
  at: number
  model: string
  /** What it's priced as, when not its own (`gpt-reserve`'s). */
  pricingModel?: string
  /** Input, counting what was cached. */
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
  fast: boolean
  ultrafast: boolean
}

/** A `token_count`'s numbers, in any of the spellings ccusage takes. */
export interface RawUsage {
  input: number
  cached: number
  output: number
  reasoning: number
  total: number
}

/** What a log's lines so far say of what follows, kept with the log (jsonl.ts) so it's read on from there. */
export interface CodexState {
  previous: RawUsage | null
  model: string | null
  fast: boolean
  ultrafast: boolean
  sawMeta: boolean
  /** A child session's replay, until: its own start (in whole seconds), or a turn started at its own line's second. */
  gate: { startedAt: number } | { selfTimed: true } | null
}

export const codexState = (): CodexState => ({ previous: null, model: null, fast: false, ultrafast: false, sawMeta: false, gate: null })

const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)

/** An NSNumber's `intValue`, as Swift reads one out of JSON (a boolean is 1 or 0). */
function intOf(value: unknown): number | undefined {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  return undefined
}

export function rawUsage(json: Record<string, any>): RawUsage {
  const int = (...keys: string[]) => {
    for (const key of keys) {
      const found = intOf(json[key])
      if (found !== undefined) return found
    }
    return undefined
  }
  const input = int("input_tokens", "prompt_tokens", "input") ?? 0
  const cached = int("cached_input_tokens", "cache_read_input_tokens", "cached_tokens") ?? 0
  const output = int("output_tokens", "completion_tokens", "output") ?? 0
  const reasoning = int("reasoning_output_tokens", "reasoning_tokens") ?? 0
  const reported = int("total_tokens") ?? 0
  const recomputed = input + output + reasoning
  return { input, cached, output, reasoning, total: reported > 0 || recomputed === 0 ? reported : recomputed }
}

const sameCounts = (a: RawUsage, b: RawUsage) => a.input === b.input && a.cached === b.cached && a.output === b.output && a.reasoning === b.reasoning && a.total === b.total

const minus = (a: RawUsage, b: RawUsage | null): RawUsage => ({
  input: Math.max(0, a.input - (b?.input ?? 0)),
  cached: Math.max(0, a.cached - (b?.cached ?? 0)),
  output: Math.max(0, a.output - (b?.output ?? 0)),
  reasoning: Math.max(0, a.reasoning - (b?.reasoning ?? 0)),
  total: Math.max(0, a.total - (b?.total ?? 0)),
})

/** Swift's `.whitespaces`: spaces and tabs, not line breaks. */
const trimmed = (text: string) => text.replace(/^[ \t   -   　]+|[ \t   -   　]+$/g, "")

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const text = trimmed(value)
  return text ? text : undefined
}

function modelName(json: Record<string, any>): string | undefined {
  return textOf(json.model) ?? textOf(json.model_name) ?? (isObject(json.metadata) ? textOf(json.metadata.model) : undefined)
}

function serviceTier(payload: Record<string, any> | undefined): string | undefined {
  if (!payload) return undefined
  return (isObject(payload.thread_settings) ? textOf(payload.thread_settings.service_tier) : undefined) ?? textOf(payload.service_tier)
}

/** A value JSON gave (not missing, not `null`, not blank text). */
const given = (value: unknown) => value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "")

/** A `session_meta` that makes the log a child session's (a subagent's or a fork's). */
export function isChildMeta(payload: Record<string, any>): boolean {
  if (given(payload.forked_from_id) || given(payload.parent_thread_id)) return true
  if (payload.thread_source === "subagent") return true
  return isObject(payload.source) && given(payload.source.subagent)
}

const seconds = (raw: unknown) => {
  if (typeof raw !== "string") return undefined
  const at = timestamp(trimmed(raw))
  return at === undefined ? undefined : Math.floor(at / 1000)
}

// The lines worth parsing, found by their bytes first (Codex writes JSON without spaces).
const TYPE = Buffer.from('"type":"')
const MARKS = ["turn_context", "token_count", "session_meta", "task_started", "thread_settings_applied"].map((name) => [name, Buffer.from(name + '"')] as const)

/** One line's turn (none for a line that isn't one), `state` carried on. */
export function codexLine(line: Buffer, state: CodexState): CodexEvent[] {
  const sees = new Set<string>()
  for (let at = line.indexOf(TYPE); at >= 0; at = line.indexOf(TYPE, at + TYPE.length)) {
    const after = at + TYPE.length
    for (const [name, mark] of MARKS) {
      if (line.length - after >= mark.length && line.compare(mark, 0, mark.length, after, after + mark.length) === 0) {
        sees.add(name)
        break
      }
    }
  }
  const wanted = sees.has("turn_context") || (!state.sawMeta && sees.has("session_meta")) || (state.gate !== null && sees.has("task_started")) || sees.has("thread_settings_applied") || sees.has("token_count")
  if (!wanted) return []
  let object: unknown
  try {
    object = JSON.parse(line.toString("utf8"))
  } catch {
    return []
  }
  if (!isObject(object)) return []
  const type = object.type
  const payload = isObject(object.payload) ? object.payload : undefined

  if (type === "turn_context") {
    const model = payload ? modelName(payload) : undefined
    if (model !== undefined) state.model = model
    return []
  }
  // A child's log replays its parent's metadata too: only its first is its own.
  if (type === "session_meta" && !state.sawMeta) {
    state.sawMeta = true
    if (payload && isChildMeta(payload)) {
      const created = seconds(object.timestamp)
      state.gate = created !== undefined ? { startedAt: created } : { selfTimed: true }
    }
    return []
  }
  if (sees.has("thread_settings_applied") && type === "event_msg" && payload?.type === "thread_settings_applied") {
    const tier = serviceTier(payload)
    if (tier !== undefined) {
      state.ultrafast = tier === "ultrafast"
      state.fast = tier === "fast" || tier === "priority"
    }
    return []
  }
  if (type !== "event_msg" || !payload) return []

  // A replayed task start has its parent's older start: the first live turn opens the gate.
  if (payload.type === "task_started") {
    const startedAt = typeof payload.started_at === "number" ? payload.started_at : typeof payload.started_at === "boolean" ? Number(payload.started_at) : undefined
    if (state.gate && startedAt !== undefined) {
      const gate = "startedAt" in state.gate ? state.gate.startedAt : seconds(object.timestamp)
      if (gate !== undefined && startedAt >= gate) state.gate = null
    }
    return []
  }
  if (payload.type !== "token_count" || typeof object.timestamp !== "string") return []
  const at = timestamp(trimmed(object.timestamp))
  if (at === undefined) return []

  const info = isObject(payload.info) ? payload.info : undefined
  const totals = isObject(info?.total_token_usage) ? rawUsage(info.total_token_usage) : undefined
  // The parent's history carries the running total on, but is never the child's own use.
  if (state.gate) {
    if (totals) state.previous = totals
    return []
  }
  // Codex can say the same running total again without another turn.
  if (totals && state.previous && sameCounts(totals, state.previous)) return []
  let usage: RawUsage
  if (isObject(info?.last_token_usage)) usage = rawUsage(info.last_token_usage)
  else if (totals) usage = minus(totals, state.previous)
  else return []
  if (totals) state.previous = totals
  if (!(usage.input > 0 || usage.cached > 0 || usage.output > 0 || usage.reasoning > 0)) return []

  const parsed = modelName(payload) ?? (info ? modelName(info) : undefined)
  if (parsed !== undefined) state.model = parsed
  else if (state.model === null) state.model = "gpt-5"
  const model = parsed ?? state.model!
  return [
    {
      at,
      model,
      ...(model === RESERVE ? { pricingModel: RESERVE_PRICED_AS } : {}),
      input: usage.input,
      cached: Math.min(usage.cached, usage.input),
      output: usage.output,
      reasoning: usage.reasoning,
      total: usage.total,
      fast: state.fast,
      ultrafast: state.ultrafast,
    },
  ]
}

/** What makes two turns the same one (but for its tier): Codex's copied logs count once. */
export const codexKey = (event: CodexEvent) => JSON.stringify([event.at, event.model, event.pricingModel ?? null, event.input, event.cached, event.output, event.reasoning, event.total])

/**
 * Turns by the slot, priced, each the same as one before it left out: a model with no price of
 * its own by the `fallback` model's rates when one's chosen (and its rates are known), noted as
 * that model's estimate; else counted nowhere, but as an unknown model.
 */
export function codexSlots(events: CodexEvent[], pricing: Pricing, since: number, fallback?: string): Slots {
  const slots = noSlots()
  const fallbackRates = fallback ? pricing.fallbackRates(fallback, "codex") : undefined
  const seen = new Set<string>()
  for (const event of events) {
    if (event.at < since) continue
    const key = codexKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    const slot = slotOf(event.at)
    // One trimmed name for the price, the unknown model and the breakdown alike.
    const model = event.model.trim()
    if (!model) continue
    // (Auto-review is priced by its date, whatever was kept as its pricing model.)
    const pricingModel = model === AUTO_REVIEW ? model : (event.pricingModel ?? model)
    const resolution = resolveCodexRates(pricing, pricingModel, event.at)
    let rates = resolution.rates
    let rateModel = resolution.rateModel
    let fast = resolution.fastAlias ? resolution.baseRates : event.fast
    let ultrafast = event.ultrafast && (!resolution.fastAlias || resolution.baseRates)
    let used: string | undefined
    if (!rates && event.total > 0) addUnknown(slots, slot, model)
    if (!rates && fallback && fallbackRates) {
      rates = fallbackRates
      rateModel = fallback
      fast = resolution.fastAlias || event.fast
      ultrafast = event.ultrafast
      used = fallback
    }
    if (!rates) continue
    const cost = codexCost(rates, { input: Math.max(0, event.input - event.cached), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: event.cached, output: event.output }, rateModel, fast, ultrafast)
    add(slots, slot, model, event.total, cost)
    if (used) addFallback(slots, slot, used)
  }
  return slots
}

// What's kept of each log's turns (jsonl.ts), small: [at, model, pricing model, input, cached,
// output, reasoning, total, flags]; flags: 1 fast, 2 Ultrafast.
export type KeptCodexEvent = [number, string, string | null, number, number, number, number, number, number]

export const keptCodex = (event: CodexEvent): KeptCodexEvent => [event.at, event.model, event.pricingModel ?? null, event.input, event.cached, event.output, event.reasoning, event.total, (event.fast ? 1 : 0) | (event.ultrafast ? 2 : 0)]

export function fromKeptCodex(kept: KeptCodexEvent): CodexEvent {
  const [at, model, pricingModel, input, cached, output, reasoning, total, flags] = kept
  return { at, model, ...(pricingModel !== null ? { pricingModel } : {}), input, cached, output, reasoning, total, fast: !!(flags & 1), ultrafast: !!(flags & 2) }
}

/** A log's state, as it was kept (anything else: a log read again whole). */
export function codexStateFrom(value: unknown): CodexState | undefined {
  if (!isObject(value)) return undefined
  const raw = (given: unknown): RawUsage | null | undefined => {
    if (given === null) return null
    if (!isObject(given)) return undefined
    const all = ["input", "cached", "output", "reasoning", "total"].map((key) => given[key])
    if (!all.every((each) => Number.isSafeInteger(each))) return undefined
    const [input, cached, output, reasoning, total] = all as number[]
    return { input: input!, cached: cached!, output: output!, reasoning: reasoning!, total: total! }
  }
  const previous = raw(value.previous)
  const gate = value.gate === null ? null : isObject(value.gate) && Number.isFinite(value.gate.startedAt) ? { startedAt: value.gate.startedAt as number } : isObject(value.gate) && value.gate.selfTimed === true ? { selfTimed: true as const } : undefined
  if (previous === undefined || gate === undefined || (value.model !== null && typeof value.model !== "string")) return undefined
  if (typeof value.fast !== "boolean" || typeof value.ultrafast !== "boolean" || typeof value.sawMeta !== "boolean") return undefined
  return { previous, model: value.model, fast: value.fast, ultrafast: value.ultrafast, sawMeta: value.sawMeta, gate }
}
