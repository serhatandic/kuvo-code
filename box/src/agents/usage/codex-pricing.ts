// What a Codex request costs: the catalogs' rates (pricing.ts) with Codex's own rules over them,
// UsageKit's `CodexUsagePricing`, kept the same while both exist (test/fixtures/usage/codex,
// `UsageBoxParityTests`):
// - `codex-auto-review` is free from 2026-10-06 (UTC) on, and before then priced as the model it
//   ran on at the time (by the day each was released);
// - `gpt-reserve` (Luna Reserve, once regular use runs out) is priced as `gpt-5.6-luna`;
// - the newer GPT models' higher rates above 272k prompt tokens, for the whole request;
// - cached input at the full input rate where a model has no cache discount, or the catalog didn't
//   say its cache-read rate;
// - the priority (fast) tier's multiplier per model, and GPT-6 Astra's 6x Ultrafast;
// - a `-fast` alias priced off its base model with the tier's multiplier once.

import { costDollars, type ModelRates, type Pricing, type Tokens } from "./pricing"

export const AUTO_REVIEW = "codex-auto-review"
/** The day auto-review became free (an announcement's calendar day, at its UTC start). */
export const AUTO_REVIEW_FREE_SINCE = Date.parse("2026-10-06T00:00:00Z")
/** Luna Reserve's slug, priced as Luna. */
export const RESERVE = "gpt-reserve"
export const RESERVE_PRICED_AS = "gpt-5.6-luna"

/** The model auto-review ran on, by the day each was released, newest first. */
const AUTO_REVIEW_RAN_ON: [number, string][] = (
  [
    ["2026-07-09", "gpt-5.6-luna"],
    ["2026-04-23", "gpt-5.5"],
    ["2026-03-05", "gpt-5.4"],
    ["2026-02-05", "gpt-5.3-codex"],
    ["2025-12-11", "gpt-5.2-codex"],
    ["2025-11-13", "gpt-5.1-codex"],
    ["2025-09-15", "gpt-5-codex"],
    ["2025-08-07", "gpt-5"],
  ] as const
).map(([day, model]) => [Date.parse(`${day}T00:00:00Z`), model])

export const isFreeAutoReview = (model: string, at: number) => model === AUTO_REVIEW && at >= AUTO_REVIEW_FREE_SINCE

/** The model a request is priced as: auto-review's of its time, else its own. */
export function pricingModelOf(model: string, at: number): string {
  if (model !== AUTO_REVIEW || at >= AUTO_REVIEW_FREE_SINCE) return model
  return AUTO_REVIEW_RAN_ON.find(([released]) => at >= released)?.[1] ?? "gpt-5"
}

export interface RateResolution {
  rates?: ModelRates
  /** The unscaled base model, whose name picks Codex's long-context and priority rules. */
  rateModel: string
  fastAlias: boolean
  /** The base model had rates of its own: the tier's multiplier applies to them once. */
  baseRates: boolean
}

const FREE: ModelRates = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cacheReadIsExplicit: true, longContextThreshold: 200_000, fast: 1 }

export function resolveCodexRates(pricing: Pricing, model: string, at: number): RateResolution {
  if (isFreeAutoReview(model, at)) return { rates: FREE, rateModel: model, fastAlias: false, baseRates: true }
  const effective = pricingModelOf(model, at)
  const canonical = pricing.canonicalName(effective)
  const fastAlias = canonical.endsWith("-fast")
  const rateModel = fastAlias ? canonical.slice(0, -"-fast".length) : canonical
  const base = pricing.resolve(rateModel)
  return { rates: base ?? pricing.resolve(effective), rateModel, fastAlias, baseRates: base !== undefined }
}

/** Rates with Codex's rules for `model` over them, and whether a request of it runs the priority tier. */
export interface Prepared {
  rates: ModelRates
  fast: boolean
}

export function prepareCodex(pricing: Pricing, model: string, at: number): Prepared | undefined {
  const resolution = resolveCodexRates(pricing, model, at)
  if (!resolution.rates) return undefined
  return { rates: adjusted(resolution.rates, resolution.rateModel), fast: resolution.fastAlias && resolution.baseRates }
}

/** A request's cost (its input not counting what was cached: the buckets are apart). */
export function preparedCost(prepared: Prepared, tokens: Tokens): number {
  return costDollars(prepared.rates, { ...tokens, fast: prepared.fast })
}

/** A request's cost at `rates` resolved for `model`, on the priority or Ultrafast tier. */
export function codexCost(rates: ModelRates, tokens: Tokens, model: string, fast: boolean, ultrafast = false): number {
  const prepared: Prepared = { rates: adjusted(rates, model), fast: fast || ultrafast }
  const multiplier = ultrafast ? ultrafastMultiplier(datedBaseModel(model)) : undefined
  if (multiplier !== undefined) prepared.rates = { ...prepared.rates, fast: multiplier }
  return preparedCost(prepared, tokens)
}

export const ultrafastMultiplier = (base: string) => (base === "gpt-6-astra" ? 6 : undefined)

/** Every model-named Codex rule, at once. */
function adjusted(rates: ModelRates, model: string): ModelRates {
  const base = datedBaseModel(model)
  const effective: ModelRates = { ...rates }
  const long = LONG_CONTEXT[base]
  if (long) {
    effective.inputAbove = long[0]
    effective.outputAbove = long[1]
    effective.cacheReadAbove = long[2]
    effective.longContextThreshold = 272_000
  }
  // No cache discount at all, or none the catalog said: cached input at the full input rate.
  if (NO_CACHE_DISCOUNT.has(base) || !rates.cacheReadIsExplicit) {
    effective.cacheRead = effective.input
    effective.cacheReadAbove = effective.inputAbove
  }
  effective.fast = priorityMultiplier(base, rates)
  return effective
}

function priorityMultiplier(base: string, rates: ModelRates): number {
  if (base === "gpt-5.5" || base === "gpt-5.5-pro") return 2.5
  if (["gpt-5.4", "gpt-5.4-pro", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"].includes(base)) return 2
  return rates.fast === 1 ? 2 : rates.fast
}

const NO_CACHE_DISCOUNT = new Set(["gpt-5.4-pro", "gpt-5.5-pro"])

/** Above 272k prompt tokens: input, output and cache-read rates per million. */
const LONG_CONTEXT: Record<string, [number, number, number]> = {
  "gpt-5.4": [5, 22.5, 0.5],
  "gpt-5.4-pro": [60, 270, 60],
  "gpt-5.5": [10, 45, 1],
  "gpt-5.5-pro": [60, 270, 60],
  "gpt-5.6-sol": [8, 30, 0.8],
  "gpt-5.6-terra": [4, 18, 0.4],
  "gpt-5.6-luna": [0.4, 1.8, 0.04],
  // Above 272k: 2x input and cache, 1.5x output (developers.openai.com/api/docs/models/gpt-6-astra).
  "gpt-6-astra": [20, 75, 2],
  "gpt-6.1-sol": [4, 15, 0.2],
  "gpt-6-sol": [4, 15, 0.4],
  "gpt-6-luna": [0.2, 0.75, 0.02],
}

/** A model without its trailing `-YYYY-MM-DD` or `-YYYYMMDD` snapshot date. */
export function datedBaseModel(model: string): string {
  for (const pattern of [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/]) {
    // (Something before the date: Swift's `model.count > pattern.count`.)
    const match = pattern.exec(model)
    if (match && match.index > 0) return model.slice(0, match.index)
  }
  return model
}
