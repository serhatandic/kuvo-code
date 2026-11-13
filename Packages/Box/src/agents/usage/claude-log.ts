// Claude Code's session logs (`<its settings folder>/projects/**/*.jsonl`), as what each request
// used: UsageKit's `ClaudeLogUsageScanner`, which ports ccusage's rules, kept the same while both
// exist (test/fixtures/usage/claude, `UsageClaudeParityTests`):
// - a line counts once it carries `"usage":{`, parses, has a valid timestamp, carries no `null`
//   where Claude never writes one, and passes the validity checks (a semver-ish `version`, no
//   empty ids or model);
// - entries are told apart by `(message.id, requestId)`, and a second pass catches a sidechain's
//   log replaying a parent's message under a new request id: the parent's wins, then the larger
//   total, then the one with a `speed`;
// - an advisor's work (`usage.iterations[]` of type `advisor_message`) counts as its own model's;
// - a line's `costUSD` where it has one, else its tokens priced (`pricing.ts`); one that can't be
//   priced counts nowhere but as an unknown model.

import type { Tokens } from "./pricing"

export interface ClaudeEntry {
  /** When, in ms. */
  at: number
  tokens: Tokens
  message?: string
  request?: string
  sidechain: boolean
  /** The line had a `speed` at all (the tiebreak); `tokens.fast`, that it was "fast". */
  speed: boolean
  cost?: number
  /** None for a line without one, or `<synthetic>`. */
  model?: string
}

const USAGE = Buffer.from('"usage":{')
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const int = (value: unknown) => (isNumber(value) ? Math.trunc(value) : 0)

/** One line's entries (none for a line that isn't one). */
export function claudeLine(line: Buffer): ClaudeEntry[] {
  if (line.indexOf(USAGE) < 0) return []
  let object: unknown
  try {
    object = JSON.parse(line.toString("utf8"))
  } catch {
    return []
  }
  return claudeEntries(object)
}

export function claudeEntries(object: unknown): ClaudeEntry[] {
  if (!isObject(object) || typeof object.timestamp !== "string") return []
  const at = timestamp(object.timestamp)
  const message = object.message
  if (at === undefined || !isObject(message) || !isObject(message.usage)) return []
  const usage = message.usage
  if (nullWhereNever(object, message, usage)) return []
  const parsed = tokensOf(usage)
  if (!parsed || !valid(object, message)) return []
  const model = typeof message.model === "string" && message.model !== "<synthetic>" ? message.model : undefined
  const parent: ClaudeEntry = {
    at,
    tokens: parsed.tokens,
    ...(typeof message.id === "string" ? { message: message.id } : {}),
    ...(typeof object.requestId === "string" ? { request: object.requestId } : {}),
    sidechain: object.isSidechain === true,
    speed: parsed.speed,
    ...(isNumber(object.costUSD) ? { cost: object.costUSD } : {}),
    ...(model !== undefined ? { model } : {}),
  }
  const iterations = usage.iterations
  if (!Array.isArray(iterations) || !iterations.every(isObject)) return [parent]
  const entries = [parent]
  let advisor = 0
  for (const iteration of iterations) {
    if (iteration.type !== "advisor_message" || typeof iteration.model !== "string" || !iteration.model) continue
    const own = tokensOf(iteration)
    if (!own) continue
    entries.push({
      at,
      tokens: own.tokens,
      ...(parent.message !== undefined ? { message: `${parent.message}:advisor:${advisor}` } : {}),
      ...(parent.request !== undefined ? { request: parent.request } : {}),
      sidechain: parent.sidechain,
      speed: own.speed,
      model: iteration.model,
    })
    advisor++
  }
  return entries
}

function tokensOf(usage: Record<string, any>): { tokens: Tokens; speed: boolean } | undefined {
  if (!isNumber(usage.input_tokens) || !isNumber(usage.output_tokens)) return undefined
  // A `speed` outside what Claude writes is a log this doesn't understand: left out (as ccusage does).
  const speed = typeof usage.speed === "string" ? usage.speed : undefined
  if (speed !== undefined && speed !== "fast" && speed !== "standard") return undefined
  // Cache writes: the 5-minute/1-hour split where it's given (1-hour bills at twice input), else all 5-minute.
  let cacheWrite5m = 0
  let cacheWrite1h = 0
  if (isObject(usage.cache_creation)) {
    cacheWrite5m = int(usage.cache_creation.ephemeral_5m_input_tokens)
    cacheWrite1h = int(usage.cache_creation.ephemeral_1h_input_tokens)
  } else cacheWrite5m = int(usage.cache_creation_input_tokens)
  return {
    tokens: { input: Math.trunc(usage.input_tokens), cacheWrite5m, cacheWrite1h, cacheRead: int(usage.cache_read_input_tokens), output: Math.trunc(usage.output_tokens), ...(speed === "fast" ? { fast: true } : {}) },
    speed: speed !== undefined,
  }
}

function valid(object: Record<string, any>, message: Record<string, any>) {
  if (typeof object.version === "string" && !/^\d+\.\d+\.\d/.test(object.version)) return false
  for (const value of [object.sessionId, object.requestId, message.id, message.model]) if (value === "") return false
  return true
}

function nullWhereNever(object: Record<string, any>, message: Record<string, any>, usage: Record<string, any>) {
  const levels: [Record<string, any>, string[]][] = [
    [object, ["cwd", "costUSD", "version", "sessionId", "requestId", "isApiErrorMessage"]],
    [message, ["id", "model"]],
    [usage, ["speed", "cache_read_input_tokens", "cache_creation_input_tokens"]],
  ]
  return levels.some(([container, fields]) => fields.some((field) => container[field] === null))
}

/**
 * An ISO 8601 time as OpenUsage reads one (`OpenUsageISO8601`): `T` or a space, fractions to the
 * millisecond, `Z`, an offset or ` UTC`, and none taken as UTC; undefined for anything else.
 */
export function timestamp(raw: string): number | undefined {
  let text = raw.trim()
  if (!text) return undefined
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) text = text.slice(0, 10) + "T" + text.slice(11)
  if (text.endsWith(" UTC")) text = text.slice(0, -4) + "Z"
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(text)
  if (!match) return undefined
  const fraction = (match[2] ?? "").slice(1, 4).padEnd(match[2] ? 3 : 0, "0")
  const at = Date.parse(`${match[1]}${fraction ? "." + fraction : ""}${match[3] ?? "Z"}`)
  return Number.isFinite(at) ? at : undefined
}

const total = (entry: ClaudeEntry) => entry.tokens.input + entry.tokens.cacheWrite5m + entry.tokens.cacheWrite1h + entry.tokens.cacheRead + entry.tokens.output

/** A replayed line's entry left out, as ccusage does (above); entries without a message ID all kept. */
export function dedupClaude(entries: ClaudeEntry[]): ClaudeEntry[] {
  const kept: ClaudeEntry[] = []
  const exact = new Map<string, number>()
  const byMessage = new Map<string, number[]>()
  const keyOf = (message: string, request: string | undefined) => `${message}\u0000${request ?? "\u0001"}`
  for (const entry of entries) {
    if (entry.message === undefined) {
      kept.push(entry)
      continue
    }
    const key = keyOf(entry.message, entry.request)
    const collision = exact.get(key) ?? byMessage.get(entry.message)?.find((index) => entry.sidechain || kept[index]!.sidechain)
    if (collision !== undefined) {
      if (replaces(entry, kept[collision]!)) {
        const old = kept[collision]!
        exact.delete(keyOf(old.message!, old.request))
        kept[collision] = entry
        exact.set(key, collision)
      }
      continue
    }
    exact.set(key, kept.length)
    byMessage.set(entry.message, [...(byMessage.get(entry.message) ?? []), kept.length])
    kept.push(entry)
  }
  return kept
}

function replaces(candidate: ClaudeEntry, existing: ClaudeEntry) {
  if (candidate.sidechain !== existing.sidechain) return existing.sidechain
  const [a, b] = [total(candidate), total(existing)]
  if (a !== b) return a > b
  return candidate.speed && !existing.speed
}

// What's kept of each file's entries (jsonl.ts), small: [at, message, request, flags, model, input,
// 5m writes, 1h writes, reads, output, cost]; flags: 1 sidechain, 2 speed, 4 fast.
export type KeptClaudeEntry = [number, string | null, string | null, number, string | null, number, number, number, number, number, number | null]

export function keptClaude(entry: ClaudeEntry): KeptClaudeEntry {
  const flags = (entry.sidechain ? 1 : 0) | (entry.speed ? 2 : 0) | (entry.tokens.fast ? 4 : 0)
  const { input, cacheWrite5m, cacheWrite1h, cacheRead, output } = entry.tokens
  return [entry.at, entry.message ?? null, entry.request ?? null, flags, entry.model ?? null, input, cacheWrite5m, cacheWrite1h, cacheRead, output, entry.cost ?? null]
}

export function fromKeptClaude(kept: KeptClaudeEntry): ClaudeEntry {
  const [at, message, request, flags, model, input, cacheWrite5m, cacheWrite1h, cacheRead, output, cost] = kept
  return {
    at,
    tokens: { input, cacheWrite5m, cacheWrite1h, cacheRead, output, ...(flags & 4 ? { fast: true } : {}) },
    ...(message !== null ? { message } : {}),
    ...(request !== null ? { request } : {}),
    sidechain: !!(flags & 1),
    speed: !!(flags & 2),
    ...(cost !== null ? { cost } : {}),
    ...(model !== null ? { model } : {}),
  }
}
