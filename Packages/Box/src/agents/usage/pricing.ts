// What a model's tokens cost, for the spend a box estimates from its agents' logs (usage.ts). Three
// sources, as OpenUsage (UsageKit's `Pricing/`) and ccusage resolve them: OpenUsage's supplement
// (its own prices, fast-variant multipliers, and rules naming a log's model by its catalog key),
// LiteLLM's catalog, and models.dev's. Each ships with the bridge as a snapshot, and is fetched
// again hourly from its feed (stale while it revalidates), kept in the bridge's folder: a client
// never waits on a feed. No sign-in, nothing of yours goes: they're public price lists.
//
// Kept the same as UsageKit's while both exist (test/fixtures/usage, `UsagePricingParityTests`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import litellmSnapshot from "./pricing/pricing_litellm_snapshot.json"
import modelsDevSnapshot from "./pricing/pricing_models_dev_snapshot.json"
import supplementSnapshot from "./pricing/pricing_supplement.json"

/** Per-million-token US dollars for one model, as `ModelRates`. */
export interface ModelRates {
  input: number
  output: number
  /** 5-minute cache writes (the input rate where a maker has none of its own). */
  cacheWrite: number
  cacheRead: number
  /** A whole request's rates once its prompt passes `longContextThreshold` (catalogs' `above_200k`). */
  inputAbove?: number
  outputAbove?: number
  cacheWriteAbove?: number
  cacheReadAbove?: number
  /** Whether the source said the cache-read rate (else 10% of input, made up). */
  cacheReadIsExplicit: boolean
  longContextThreshold: number
  /** The "fast" variant's multiplier (1 for none). */
  fast: number
}

/** A request's tokens, by what prices them differently (`TokenBreakdown`). */
export interface Tokens {
  input: number
  cacheWrite5m: number
  /** 1-hour cache writes: twice the input rate. */
  cacheWrite1h: number
  cacheRead: number
  output: number
  /** It ran the model's fast variant (Claude's `speed: "fast"`). */
  fast?: boolean
}

export const totalTokens = (tokens: Tokens) => tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead + tokens.output
const promptTokens = (tokens: Tokens) => tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead

/** One request's cost at these rates: the long-context tier for the whole request, and the fast multiplier. */
export function costDollars(rates: ModelRates, tokens: Tokens, longContext = true): number {
  const above = longContext && promptTokens(tokens) > rates.longContextThreshold
  const pick = (base: number, tier: number | undefined) => (above ? (tier ?? base) : base)
  const input = pick(rates.input, rates.inputAbove)
  const cost =
    (tokens.input * input) / 1_000_000 +
    (tokens.output * pick(rates.output, rates.outputAbove)) / 1_000_000 +
    (tokens.cacheWrite5m * pick(rates.cacheWrite, rates.cacheWriteAbove)) / 1_000_000 +
    (tokens.cacheWrite1h * input * 2) / 1_000_000 +
    (tokens.cacheRead * pick(rates.cacheRead, rates.cacheReadAbove)) / 1_000_000
  return cost * (tokens.fast ? rates.fast : 1)
}

function scaled(rates: ModelRates, factor: number): ModelRates {
  const times = (value: number | undefined) => (value === undefined ? undefined : value * factor)
  return {
    input: rates.input * factor,
    output: rates.output * factor,
    cacheWrite: rates.cacheWrite * factor,
    cacheRead: rates.cacheRead * factor,
    inputAbove: times(rates.inputAbove),
    outputAbove: times(rates.outputAbove),
    cacheWriteAbove: times(rates.cacheWriteAbove),
    cacheReadAbove: times(rates.cacheReadAbove),
    cacheReadIsExplicit: rates.cacheReadIsExplicit,
    longContextThreshold: rates.longContextThreshold,
    fast: 1,
  }
}

const rates = (input: number, output: number, cacheWrite: number, cacheRead: number, cacheReadIsExplicit: boolean, fast = 1): ModelRates => ({ input, output, cacheWrite, cacheRead, cacheReadIsExplicit, longContextThreshold: 200_000, fast })

const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)

// --- A catalog: a model's key to its rates, with ccusage's fuzzy match (`PricingCatalog`) ---

export class Catalog {
  constructor(readonly entries: Map<string, ModelRates> = new Map()) {}

  exact(model: string): [string, ModelRates] | undefined {
    const found = this.entries.get(model)
    return found ? [model, found] : undefined
  }

  /** The longest key that matches at word boundaries (then the first in order), after an exact miss. */
  fuzzy(model: string): [string, ModelRates] | undefined {
    const normalized = normalizedKey(model)
    let best: [string, ModelRates] | undefined
    for (const [key, value] of this.entries) {
      if (!keyMatches(key, model, normalized)) continue
      if (!best || key.length > best[0].length || (key.length === best[0].length && key < best[0])) best = [key, value]
    }
    return best
  }

  /** This one with `other`'s entries over it. */
  merging(other: Catalog): Catalog {
    return new Catalog(new Map([...this.entries, ...other.entries]))
  }
}

/** `.` and `@` as `-` (`grok-4.3` → `grok-4-3`). */
export const normalizedKey = (value: string) => (value.includes(".") || value.includes("@") ? value.replaceAll(".", "-").replaceAll("@", "-") : value)

function keyMatches(candidate: string, model: string, normalizedModel: string) {
  if (containsKey(model, candidate) || containsKey(candidate, model)) return true
  const normalizedCandidate = normalizedKey(candidate)
  return containsKey(normalizedModel, normalizedCandidate) || containsKey(normalizedCandidate, normalizedModel)
}

const isDigit = (code: number | undefined) => code !== undefined && code >= 48 && code <= 57
const isAlphanumeric = (code: number | undefined) => code !== undefined && (isDigit(code) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90))

/** `key` in `value` with no letter or digit before it, and nothing after it that continues it or its version number. */
function containsKey(value: string, key: string): boolean {
  if (!key || key.length > value.length) return false
  for (let start = value.indexOf(key); start >= 0; start = value.indexOf(key, start + 1)) {
    if (start > 0 && isAlphanumeric(value.charCodeAt(start - 1))) continue
    if (suffixAllows(key, value.slice(start + key.length))) return true
  }
  return false
}

function suffixAllows(key: string, suffix: string): boolean {
  if (!suffix) return true
  if (isAlphanumeric(suffix.charCodeAt(0))) return false
  // A numeric key followed by `-5…` continues its version (`claude-sonnet-4` isn't `claude-sonnet-4-5`); `-20250514`, a date, doesn't.
  if (!isDigit(key.charCodeAt(key.length - 1))) return true
  if (suffix[0] !== "-" && suffix[0] !== ".") return true
  let digits = 0
  while (isDigit(suffix.charCodeAt(1 + digits))) digits++
  if (digits === 0) return true
  const after = suffix.charCodeAt(1 + digits)
  const date = digits === 8 && (Number.isNaN(after) || !isAlphanumeric(after))
  return date
}

// --- The feeds' formats (`PricingCatalogCodecs`) ---

/** LiteLLM's `model_prices_and_context_window.json`: per-token costs, kept per million. */
export function catalogFromLiteLLM(root: unknown): Catalog {
  if (!isObject(root)) throw new Error("Pricing feed is not a JSON object.")
  const entries = new Map<string, ModelRates>()
  for (const [key, entry] of Object.entries(root)) {
    if (!isObject(entry)) continue
    const input = number(entry.input_cost_per_token)
    const output = number(entry.output_cost_per_token)
    if (input === undefined || output === undefined) continue
    const cacheWrite = number(entry.cache_creation_input_token_cost)
    const cacheRead = number(entry.cache_read_input_token_cost)
    const value = rates(input * 1e6, output * 1e6, (cacheWrite ?? input) * 1e6, (cacheRead ?? input * 0.1) * 1e6, cacheRead !== undefined)
    const million = (field: string) => {
      const found = number(entry[field])
      return found === undefined ? undefined : found * 1e6
    }
    value.inputAbove = million("input_cost_per_token_above_200k_tokens")
    value.outputAbove = million("output_cost_per_token_above_200k_tokens")
    value.cacheWriteAbove = million("cache_creation_input_token_cost_above_200k_tokens")
    value.cacheReadAbove = million("cache_read_input_token_cost_above_200k_tokens")
    const fast = isObject(entry.provider_specific_entry) ? number(entry.provider_specific_entry.fast) : undefined
    if (fast !== undefined) value.fast = fast
    entries.set(key, value)
  }
  if (!entries.size) throw new Error("Pricing feed contained no usable model entries.")
  return new Catalog(entries)
}

/** models.dev's `api.json`: `{provider: {models: {id: {cost}}}}`, per million already; a bare id's first provider by name wins. */
export function catalogFromModelsDev(root: unknown): Catalog {
  if (!isObject(root)) throw new Error("Pricing feed is not a JSON object.")
  const entries = new Map<string, ModelRates>()
  for (const name of Object.keys(root).sort()) {
    const models = isObject(root[name]) ? root[name].models : undefined
    if (!isObject(models)) continue
    for (const [id, model] of Object.entries(models)) {
      if (entries.has(id) || !isObject(model) || !isObject(model.cost)) continue
      const input = number(model.cost.input)
      const output = number(model.cost.output)
      if (input === undefined || output === undefined) continue
      entries.set(id, rates(input, output, number(model.cost.cache_write) ?? input, number(model.cost.cache_read) ?? input * 0.1, "cache_read" in model.cost))
    }
  }
  if (!entries.size) throw new Error("Pricing feed contained no usable model entries.")
  return new Catalog(entries)
}

/** The compact form the snapshots and the cache are kept in (`i`, `o`, `cw`, `cr`, `ia`…, `cre`, `fast`). */
export function catalogFromCompact(root: unknown): Catalog {
  if (!isObject(root) || !isObject(root.models)) throw new Error("Pricing catalog is not compact JSON.")
  const entries = new Map<string, ModelRates>()
  for (const [key, model] of Object.entries(root.models)) {
    if (!isObject(model)) continue
    const [i, o, cw, cr] = [number(model.i), number(model.o), number(model.cw), number(model.cr)]
    if (i === undefined || o === undefined || cw === undefined || cr === undefined) continue
    const value = rates(i, o, cw, cr, model.cre !== false, number(model.fast) ?? 1)
    value.inputAbove = number(model.ia)
    value.outputAbove = number(model.oa)
    value.cacheWriteAbove = number(model.cwa)
    value.cacheReadAbove = number(model.cra)
    entries.set(key, value)
  }
  return new Catalog(entries)
}

export function compactOf(catalog: Catalog): string {
  const models: Record<string, Record<string, number | boolean>> = {}
  for (const [key, value] of [...catalog.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    models[key] = {
      i: value.input,
      o: value.output,
      cw: value.cacheWrite,
      cr: value.cacheRead,
      ...(value.inputAbove !== undefined ? { ia: value.inputAbove } : {}),
      ...(value.outputAbove !== undefined ? { oa: value.outputAbove } : {}),
      ...(value.cacheWriteAbove !== undefined ? { cwa: value.cacheWriteAbove } : {}),
      ...(value.cacheReadAbove !== undefined ? { cra: value.cacheReadAbove } : {}),
      ...(value.cacheReadIsExplicit ? {} : { cre: false }),
      ...(value.fast !== 1 ? { fast: value.fast } : {}),
    }
  }
  return JSON.stringify({ models })
}

// --- OpenUsage's supplement (`PricingSupplement`) ---

export interface Supplement {
  pricing: Map<string, ModelRates>
  fastMultipliers: Map<string, number>
  aliases: { pattern: RegExp; canonical: string }[]
  updatedAt?: string
}

/** The supplement's JSON (the snapshot, or its feed); a rule whose pattern doesn't compile is left out. */
export function supplementFrom(root: unknown): Supplement {
  if (!isObject(root) || !isObject(root.pricing) || !Array.isArray(root.alias_rules)) throw new Error("The pricing supplement isn't one.")
  const fastMultipliers = new Map<string, number>()
  if (isObject(root.fast_multipliers)) for (const [model, value] of Object.entries(root.fast_multipliers)) if (number(value) !== undefined) fastMultipliers.set(model, value as number)
  const pricing = new Map<string, ModelRates>()
  for (const [model, entry] of Object.entries(root.pricing)) {
    if (!isObject(entry)) throw new Error("The pricing supplement isn't one.")
    const input = number(entry.input_per_million)
    const output = number(entry.output_per_million)
    if (input === undefined || output === undefined) throw new Error("The pricing supplement isn't one.")
    const cacheRead = number(entry.cache_read_per_million)
    // (Its multiplier on the entry itself: a request flagged fast prices its base model, never a `-fast` one.)
    pricing.set(model, rates(input, output, number(entry.cache_write_per_million) ?? input, cacheRead ?? input * 0.1, cacheRead !== undefined, fastMultipliers.get(model) ?? 1))
  }
  const aliases: Supplement["aliases"] = []
  for (const rule of root.alias_rules) {
    if (!isObject(rule) || typeof rule.pattern !== "string" || typeof rule.canonical !== "string") throw new Error("The pricing supplement isn't one.")
    // ICU's leading `(?i)` (NSRegularExpression's) is JavaScript's `i` flag.
    const insensitive = rule.pattern.startsWith("(?i)")
    try {
      aliases.push({ pattern: new RegExp(insensitive ? rule.pattern.slice(4) : rule.pattern, insensitive ? "i" : ""), canonical: rule.canonical })
    } catch {}
  }
  return { pricing, fastMultipliers, aliases, ...(typeof root.updated_at === "string" ? { updatedAt: root.updated_at } : {}) }
}

function canonicalOf(supplement: Supplement, model: string): string | undefined {
  return supplement.aliases.find((rule) => rule.pattern.test(model))?.canonical
}

function fastMultiplierOf(supplement: Supplement, model: string): number | undefined {
  const exact = supplement.fastMultipliers.get(model)
  if (exact !== undefined) return exact
  for (const part of normalizedKey(model).split(/[/:]/)) {
    if (!part) continue
    for (const [base, multiplier] of supplement.fastMultipliers) {
      const key = normalizedKey(base)
      const at = part.lastIndexOf(key)
      if (at < 0) continue
      const rest = part.slice(at + key.length)
      if (!rest || rest.startsWith("-")) return multiplier
    }
  }
  return undefined
}

// --- Resolving a model (`ModelPricing`) ---

/**
 * A model's rates: the supplement's alias first (the raw name as a fallback), then the supplement's
 * own price, LiteLLM exact, a `-fast` slug off its base with a known multiplier, LiteLLM fuzzy (not
 * for `-fast`), models.dev exact. Undefined: not priced (shown as an unknown model, never $0).
 */
export class Pricing {
  private memo = new Map<string, ModelRates | null>()

  constructor(
    readonly supplement: Supplement,
    readonly primary: Catalog,
    readonly secondary: Catalog,
  ) {}

  resolve(model: string): ModelRates | undefined {
    const known = this.memo.get(model)
    if (known !== undefined) return known ?? undefined
    const canonical = canonicalOf(this.supplement, model)
    const found = canonical !== undefined && canonical !== model ? (this.lookup(canonical) ?? this.lookup(model)) : this.lookup(model)
    this.memo.set(model, found ?? null)
    return found
  }

  /** What `tokens` of `model` cost, or undefined when it can't be priced. */
  cost(model: string, tokens: Tokens, longContext = true): number | undefined {
    const found = this.resolve(model)
    return found ? costDollars(found, tokens, longContext) : undefined
  }

  private lookup(name: string): ModelRates | undefined {
    const own = this.supplement.pricing.get(name)
    if (own) return own
    const exact = this.primary.exact(name)
    if (exact) return exact[1]
    const fast = this.fastVariant(name)
    if (fast) return fast
    if (name.endsWith("-fast")) return this.secondary.exact(name)?.[1]
    return this.primary.fuzzy(name)?.[1] ?? this.secondary.exact(name)?.[1]
  }

  private fastVariant(name: string): ModelRates | undefined {
    if (!name.endsWith("-fast")) return undefined
    const base = name.slice(0, -"-fast".length)
    if (!base) return undefined
    const own = this.supplement.pricing.get(base)
    const entry: [string, ModelRates] | undefined = own ? [base, own] : (this.primary.exact(base) ?? this.primary.fuzzy(base) ?? this.secondary.exact(base))
    if (!entry) return undefined
    const multiplier = entry[1].fast !== 1 ? entry[1].fast : (fastMultiplierOf(this.supplement, entry[0]) ?? fastMultiplierOf(this.supplement, base))
    return multiplier === undefined ? undefined : scaled(entry[1], multiplier)
  }
}

// --- Kept current (`ModelPricingStore`) ---

type Source = "litellm" | "models_dev" | "supplement"
const SOURCES: Source[] = ["litellm", "models_dev", "supplement"]

export const PRICING_FEEDS: Record<Source, string> = {
  litellm: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  models_dev: "https://models.dev/api.json",
  supplement: "https://robinebers.github.io/openusage/pricing_supplement.json",
}

const HOUR = 3_600_000
/** A source that failed is tried again after this long. */
const RETRY = 30 * 60_000
/** A feed's answer at most this big (LiteLLM's is a few MB). */
const MOST_BYTES = 64 * 1024 * 1024

interface SourceState {
  etag?: string
  fetchedAt?: number
  failedAt?: number
}

/** What fetches a feed (fetch itself; a stand-in in tests). */
export type PricingFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

/**
 * The prices as they are now: the bundled snapshots with what was fetched over them (a fetched
 * catalog's entries win, the snapshot's others stay; the supplement whose `updated_at` is newer
 * wins). `current()` never waits: what's due is fetched behind it and used from the next call.
 */
export class PricingStore {
  private pricing?: Pricing
  private states: Partial<Record<Source, SourceState>> = {}
  private refreshing?: Promise<void>
  /** Told once new prices are in (the next scan prices with them). */
  onChange?: () => void

  constructor(
    /** Where the fetched feeds are kept (`usage/pricing` in the bridge's folder); none: only the snapshots. */
    private readonly folder?: string,
    private readonly fetcher: PricingFetch | undefined = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {
    if (folder) {
      try {
        this.states = JSON.parse(readFileSync(join(folder, "state.json"), "utf8"))
      } catch {}
    }
  }

  current(): Pricing {
    this.pricing ??= this.build()
    if (this.fetcher && this.folder && !this.refreshing && SOURCES.some((source) => this.due(source))) this.refreshing = this.refreshDue().finally(() => (this.refreshing = undefined))
    return this.pricing
  }

  /** Fetches what's due and waits for it (tests). */
  async refreshNow() {
    this.current()
    await this.refreshing
  }

  private due(source: Source) {
    const state = this.states[source] ?? {}
    if (state.failedAt !== undefined && this.now() - state.failedAt < RETRY) return false
    return state.fetchedAt === undefined || this.now() - state.fetchedAt >= HOUR
  }

  private async refreshDue() {
    let changed = false
    for (const source of SOURCES) if (this.due(source) && (await this.fetchOne(source))) changed = true
    if (changed) {
      this.pricing = this.build()
      this.onChange?.()
    }
    this.write("state.json", JSON.stringify(this.states))
  }

  private async fetchOne(source: Source): Promise<boolean> {
    const state = this.states[source] ?? {}
    try {
      const response = await this.fetcher!(PRICING_FEEDS[source], { headers: state.etag ? { "If-None-Match": state.etag } : {}, signal: AbortSignal.timeout(30_000) })
      if (response.status === 304) {
        this.states[source] = { ...state, fetchedAt: this.now(), failedAt: undefined }
        return false
      }
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const length = Number(response.headers.get("content-length") ?? 0)
      if (length > MOST_BYTES) throw new Error("too big")
      const text = await response.text()
      if (text.length > MOST_BYTES) throw new Error("too big")
      const body = JSON.parse(text)
      // What doesn't parse never takes a good cache's place.
      const kept = source === "litellm" ? compactOf(catalogFromLiteLLM(body)) : source === "models_dev" ? compactOf(catalogFromModelsDev(body)) : (supplementFrom(body), text)
      this.write(`${source}.json`, kept)
      const etag = response.headers.get("etag") ?? undefined
      this.states[source] = { ...(etag ? { etag } : {}), fetchedAt: this.now() }
      return true
    } catch {
      this.states[source] = { ...state, failedAt: this.now() }
      return false
    }
  }

  private read(name: string): unknown {
    if (!this.folder) return undefined
    try {
      return JSON.parse(readFileSync(join(this.folder, name), "utf8"))
    } catch {
      return undefined
    }
  }

  private write(name: string, text: string) {
    if (!this.folder) return
    try {
      mkdirSync(this.folder, { recursive: true })
      writeFileSync(join(this.folder, name + ".new"), text)
      renameSync(join(this.folder, name + ".new"), join(this.folder, name))
    } catch {}
  }

  private build(): Pricing {
    const catalog = (snapshot: unknown, source: Source) => {
      let built = catalogFromCompact(snapshot)
      const cached = this.read(`${source}.json`)
      if (cached !== undefined) {
        try {
          built = built.merging(catalogFromCompact(cached))
        } catch {}
      }
      return built
    }
    const bundled = supplementFrom(supplementSnapshot)
    let supplement = bundled
    const cached = this.read("supplement.json")
    if (cached !== undefined) {
      try {
        const fetched = supplementFrom(cached)
        // (The bundled one wins only when strictly newer: a newer bridge ships newer prices.)
        if (!(bundled.updatedAt !== undefined && (fetched.updatedAt === undefined || bundled.updatedAt > fetched.updatedAt))) supplement = fetched
      } catch {}
    }
    return new Pricing(supplement, catalog(litellmSnapshot, "litellm"), catalog(modelsDevSnapshot, "models_dev"))
  }
}

/** The bundled prices alone (tests; and a box with no folder). */
export function bundledPricing(): Pricing {
  return new PricingStore(undefined, undefined).current()
}
