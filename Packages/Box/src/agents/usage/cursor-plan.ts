// Cursor's plan limits (limits.ts): its total usage, its two model pools, Grok Bot's own week, the
// on-demand spend against its cap, a request-based plan's requests, and the credits left, read with
// Kuvo Code's own Cursor sign-in (cursor-api.ts). UsageKit's `CursorProvider.probe`,
// `CursorUsageMapper` and `CursorUsageSummaryMapper`, ported (#631 piece D1): `cursorLines` gives the
// lines as UsageKit's mapper does (the parity fixtures hold both to them), `readingOf` the windows.

import { LimitsProblem, retryAt, type LimitExtra, type LimitReading, type LimitWindow } from "../limits"
import { numberOf } from "./numbers"
import { CursorClient, cursorSession, type CursorAnswer } from "./cursor-api"

const DAY_MS = 24 * 60 * 60_000
/** `MetricPeriod.monthMs`, Cursor's billing period when it doesn't say. */
export const BILLING_PERIOD_MS = 30 * DAY_MS
const WEEK_MS = 7 * DAY_MS

/** A line as UsageKit's `MetricLine` has it: a meter, or an amount alone. */
export type CursorLine =
  | { label: string; kind: "progress"; used: number; limit: number; format: "percent" | "dollars" | "count"; suffix?: string; resetsAt?: number; periodMs?: number }
  | { label: string; kind: "dollars"; amount: number }

export interface CursorMapped {
  plan?: string
  lines: CursorLine[]
}

/** Why Cursor's answer couldn't be read as a plan (`CursorUsageError`). */
export class CursorPlanError extends Error {}

const ORG = new Set(["enterprise", "team"])
const text = (value: unknown) => (typeof value === "string" ? value : undefined)
const trimmed = (value: unknown) => {
  const found = text(value)?.trim()
  return found ? found : undefined
}
const object = (value: unknown): Record<string, any> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined)
const clampPercent = (value: number) => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : 0)
const dollars = (cents: number) => Math.round(cents) / 100
const titled = (value: string) =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1))
    .join(" ")

/** `OpenUsageISO8601.date`: an ISO time as UsageKit reads it (a missing zone is UTC), in ms. */
export function isoTime(value: unknown): number | undefined {
  let s = text(value)?.trim()
  if (!s) return undefined
  if (s.includes(" ") && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) s = s.slice(0, 10) + "T" + s.slice(11)
  if (s.endsWith(" UTC")) s = s.slice(0, -4) + "Z"
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (!match) return undefined
  const fraction = match[2] ? "." + match[2].slice(1, 4).padEnd(3, "0") : ""
  const at = Date.parse(match[1] + fraction + (match[3] ?? "Z"))
  return Number.isFinite(at) ? at : undefined
}

/** `CursorPlanUsageFacts`: what the three decisions read off Cursor's `usage` payload. */
export function planFacts(usage: Record<string, any>) {
  const isEnabled = usage.enabled !== false
  const planUsage = object(usage.planUsage)
  const limit = planUsage ? numberOf(planUsage.limit) : undefined
  const totalPercentUsed = planUsage ? numberOf(planUsage.totalPercentUsed) : undefined
  const auto = planUsage ? numberOf(planUsage.autoPercentUsed) : undefined
  const api = planUsage ? numberOf(planUsage.apiPercentUsed) : undefined
  const spent = (planUsage ? numberOf(planUsage.totalSpend) : undefined) ?? (limit ?? 0) - ((planUsage ? numberOf(planUsage.remaining) : undefined) ?? limit ?? 0)
  const hasModelPools = auto !== undefined && api !== undefined && auto >= 0 && api >= 0 ? auto > 0 || api > 0 || spent === 0 : false
  const spendLimitUsage = object(usage.spendLimitUsage)
  const spendLimitType = text(spendLimitUsage?.limitType)?.toLowerCase()
  const pooledLimit = numberOf(spendLimitUsage?.pooledLimit) ?? 0
  const hasPlanUsage = planUsage !== undefined
  const hasLimit = limit !== undefined
  const hasTotalUsagePercent = totalPercentUsed !== undefined
  const planUsageLimitMissing = hasPlanUsage && !hasLimit
  return {
    isEnabled,
    hasPlanUsage,
    limit,
    totalPercentUsed,
    hasModelPools,
    hasLimit,
    hasTotalUsagePercent,
    planUsageLimitMissing,
    planUsageUnusable: !hasPlanUsage || (planUsageLimitMissing && !hasModelPools),
    isTeamByShape: spendLimitType === "team" || pooledLimit > 0,
    shouldTryGenericRequestFallback: isEnabled && hasPlanUsage && !hasLimit && !hasTotalUsagePercent && !hasModelPools,
  }
}

const progress = (label: string, used: number, limit: number, format: "percent" | "dollars" | "count", resetsAt?: number, periodMs?: number, suffix?: string): CursorLine => ({
  label,
  kind: "progress",
  used,
  limit,
  format,
  ...(suffix !== undefined ? { suffix } : {}),
  ...(resetsAt !== undefined ? { resetsAt } : {}),
  ...(periodMs !== undefined ? { periodMs } : {}),
})

/** `CursorUsageMapper.mapGrokBotUsage`: Grok Bot's own weekly allowance, where the account has one of its own. */
export function grokBotLine(usage: Record<string, any>): CursorLine | undefined {
  if (usage.usesPooledEnterpriseAllowance === true || usage.hasNonZeroIncludedLimit === false || usage.includedLimitZero === true) return undefined
  const percent = numberOf(usage.usagePercent)
  if (percent === undefined || percent < 0) return undefined
  const reset = isoTime(usage.nextResetTimestampUtc)
  const start = isoTime(usage.currentPeriodStart)
  const period = start !== undefined && reset !== undefined && reset > start ? reset - start : WEEK_MS
  return progress("Grok Bot usage", clampPercent(percent), 100, "percent", reset, period)
}

function billingCycle(usage: Record<string, any>): { resetsAt?: number; periodMs: number } {
  const start = numberOf(usage.billingCycleStart)
  const end = numberOf(usage.billingCycleEnd)
  if (start === undefined || end === undefined || !(end > start)) return { ...(end !== undefined ? { resetsAt: end } : {}), periodMs: BILLING_PERIOD_MS }
  return { resetsAt: end, periodMs: end - start }
}

function onDemandSpendCents(spendLimitUsage: Record<string, any>, limit: number, remaining: number): number {
  const reported = [numberOf(spendLimitUsage.individualUsed), numberOf(spendLimitUsage.pooledUsed), numberOf(spendLimitUsage.totalSpend)].filter((each): each is number => each !== undefined)
  const positive = reported.find((each) => each > 0)
  if (positive !== undefined) return positive
  const inferred = Math.max(0, limit - remaining)
  return inferred > 0 ? inferred : (reported[0] ?? 0)
}

function creditsLine(creditGrants: Record<string, any> | undefined, stripeBalanceCents: number): CursorLine | undefined {
  const hasCreditGrants = creditGrants?.hasCreditGrants === true
  const grantTotal = hasCreditGrants ? (numberOf(creditGrants?.totalCents) ?? 0) : 0
  const grantUsed = hasCreditGrants ? (numberOf(creditGrants?.usedCents) ?? 0) : 0
  const valid = hasCreditGrants && grantTotal > 0
  const total = (valid ? grantTotal : 0) + stripeBalanceCents
  if (!(total > 0)) return undefined
  return { label: "Credits", kind: "dollars", amount: dollars(Math.max(0, total - (valid ? grantUsed : 0))) }
}

/** `CursorUsageMapper.mapUsage`. */
export function mapUsage(usage: Record<string, any>, planName: string | undefined, creditGrants: Record<string, any> | undefined, stripeBalanceCents: number): CursorMapped {
  const facts = planFacts(usage)
  const planUsage = object(usage.planUsage)
  if (!facts.isEnabled || !planUsage) throw new CursorPlanError("No active Cursor subscription.")
  const normalizedPlan = planName?.trim().toLowerCase() ?? ""
  if (!facts.hasLimit && !facts.hasTotalUsagePercent && !facts.hasModelPools) throw new CursorPlanError("Total usage limit missing from API response.")
  const lines: CursorLine[] = []
  const credits = creditsLine(creditGrants, stripeBalanceCents)
  if (credits) lines.push(credits)
  const planUsedCents = numberOf(planUsage.totalSpend) ?? (facts.limit ?? 0) - (numberOf(planUsage.remaining) ?? 0)
  const computedPercentUsed = facts.limit !== undefined && facts.limit > 0 ? (planUsedCents / facts.limit) * 100 : 0
  const totalUsagePercent = facts.totalPercentUsed ?? computedPercentUsed
  const cycle = billingCycle(usage)
  const spendLimitUsage = object(usage.spendLimitUsage)
  const isTeam = normalizedPlan === "team" || facts.isTeamByShape
  if (isTeam && facts.hasModelPools) {
    // (Modern Teams seats still report the old $20 allowance: the pools win, and no total is made up.)
    if (facts.totalPercentUsed !== undefined) lines.push(progress("Total usage", facts.totalPercentUsed, 100, "percent", cycle.resetsAt, cycle.periodMs))
  } else if (isTeam) {
    if (facts.limit !== undefined) lines.push(progress("Total usage", dollars(planUsedCents), dollars(facts.limit), "dollars", cycle.resetsAt, cycle.periodMs))
    else if (facts.totalPercentUsed !== undefined) lines.push(progress("Total usage", facts.totalPercentUsed, 100, "percent", cycle.resetsAt, cycle.periodMs))
    else throw new CursorPlanError("Cursor request-based usage data unavailable. Try again later.")
  } else {
    lines.push(progress("Total usage", totalUsagePercent, 100, "percent", cycle.resetsAt, cycle.periodMs))
  }
  const auto = numberOf(planUsage.autoPercentUsed)
  if (auto !== undefined) lines.push(progress("Cursor Models", auto, 100, "percent", cycle.resetsAt, cycle.periodMs))
  const api = numberOf(planUsage.apiPercentUsed)
  if (api !== undefined) lines.push(progress("Other Models", api, 100, "percent", cycle.resetsAt, cycle.periodMs))
  if (spendLimitUsage) {
    const limit = numberOf(spendLimitUsage.individualLimit) ?? numberOf(spendLimitUsage.pooledLimit) ?? 0
    const remaining = numberOf(spendLimitUsage.individualRemaining) ?? numberOf(spendLimitUsage.pooledRemaining) ?? 0
    const spent = onDemandSpendCents(spendLimitUsage, limit, remaining)
    if (limit > 0) lines.push(progress("On-demand", dollars(spent), dollars(limit), "dollars"))
    else if (spent > 0) lines.push({ label: "On-demand", kind: "dollars", amount: dollars(spent) })
  }
  return { ...(planLabel(planName) ? { plan: planLabel(planName) } : {}), lines }
}

/** `CursorUsageMapper.mapRequestBasedUsage`. */
export function mapRequestBasedUsage(usage: Record<string, any> | undefined, planName: string | undefined, unavailable: string): CursorMapped {
  const lines: CursorLine[] = []
  const gpt4 = object(usage?.["gpt-4"])
  const limit = numberOf(gpt4?.maxRequestUsage)
  if (gpt4 && limit !== undefined && limit > 0) {
    const cycleStart = isoTime(usage?.startOfMonth)
    lines.push(progress("Requests", numberOf(gpt4.numRequests) ?? 0, limit, "count", cycleStart !== undefined ? cycleStart + BILLING_PERIOD_MS : undefined, BILLING_PERIOD_MS, "requests"))
  }
  if (!lines.length) throw new CursorPlanError(unavailable)
  return { ...(planLabel(planName) ? { plan: planLabel(planName) } : {}), lines }
}

/** `CursorUsageMapper.shouldUseRequestBasedFallback`: the message, when it should. */
export function requestBasedFallback(usage: Record<string, any>, planName: string | undefined, planInfoUnavailable: boolean): string | undefined {
  const facts = planFacts(usage)
  if (!facts.isEnabled) return undefined
  const plan = planName?.trim().toLowerCase() ?? ""
  const unusable = facts.planUsageUnusable && !facts.hasTotalUsagePercent
  if (unusable && plan === "enterprise") return "Enterprise usage data unavailable. Try again later."
  if (unusable && plan === "team") return "Team request-based usage data unavailable. Try again later."
  if (unusable && plan === "" && planInfoUnavailable) return "Cursor request-based usage data unavailable. Try again later."
  if (facts.isTeamByShape && facts.planUsageLimitMissing && !facts.hasModelPools) return "Cursor request-based usage data unavailable. Try again later."
  return undefined
}

/** `CursorUsageMapper.stripeBalanceCents`: prepaid credit is a negative customer balance. */
export function stripeBalanceCents(body: Record<string, any> | undefined): number {
  const balance = numberOf(body?.customerBalance)
  return balance !== undefined && balance < 0 ? Math.abs(balance) : 0
}

const normalizedMembership = (value: string | undefined) => value?.trim().toLowerCase() || undefined

/** `CursorUsageMapper.routingPlanName`. */
export function routingPlanName(planInfoName: string | undefined, membership: string | undefined): string | undefined {
  const member = normalizedMembership(membership)
  if (member && ORG.has(member)) return member
  return planInfoName?.trim() || undefined
}

/** `CursorUsageMapper.resolvedPlanName`. */
export function resolvedPlanName(planInfoName: string | undefined, membership: string | undefined): string | undefined {
  const member = normalizedMembership(membership)
  const planInfo = planInfoName?.trim() || undefined
  if (member && ORG.has(member) && (planInfo === undefined || ["pro", "pro plan"].includes(planInfo.toLowerCase()))) return member
  return planInfo ?? member
}

/** `CursorUsageMapper.preferredMembership`. */
export function preferredMembership(local: string | undefined, summary: string | undefined): string | undefined {
  const mine = normalizedMembership(local)
  const theirs = normalizedMembership(summary)
  if (mine && ORG.has(mine)) return mine
  if (theirs && ORG.has(theirs)) return theirs
  return mine ?? theirs
}

function planLabel(value: string | undefined): string | undefined {
  const found = value?.trim()
  return found ? titled(found) : undefined
}

export const resolvedPlanLabel = (planInfoName: string | undefined, membership: string | undefined) => planLabel(resolvedPlanName(planInfoName, membership))

// --- usage-summary and request-based usage together (`CursorUsageSummaryMapper`) ---

function summaryCycle(summary: Record<string, any> | undefined, requestUsage: Record<string, any> | undefined): { resetsAt?: number; periodMs: number } {
  const start = isoTime(summary?.billingCycleStart)
  const end = isoTime(summary?.billingCycleEnd)
  if (start !== undefined && end !== undefined && end > start) return { resetsAt: end, periodMs: end - start }
  const requestStart = isoTime(requestUsage?.startOfMonth)
  return { ...(requestStart !== undefined ? { resetsAt: requestStart + BILLING_PERIOD_MS } : {}), periodMs: BILLING_PERIOD_MS }
}

function dollarMeter(value: unknown): { used: number; limit: number } | undefined {
  const bucket = object(value)
  if (!bucket || bucket.enabled === false) return undefined
  const limit = numberOf(bucket.limit)
  if (limit === undefined || !(limit > 0)) return undefined
  const reported = numberOf(bucket.used)
  const inferred = Math.max(0, limit - (numberOf(bucket.remaining) ?? limit))
  const used = reported !== undefined && reported > 0 ? reported : inferred
  return { used: Math.max(0, used), limit }
}

function usableDollarBucket(value: unknown): boolean {
  const bucket = object(value)
  if (!bucket || bucket.enabled === false) return false
  return dollarMeter(bucket) !== undefined || (numberOf(bucket.used) ?? 0) > 0
}

/** `CursorUsageSummaryMapper.hasUsableSummaryPayload`. */
export function hasUsableSummary(summary: Record<string, any>): boolean {
  const start = isoTime(summary.billingCycleStart)
  const end = isoTime(summary.billingCycleEnd)
  if (start !== undefined && end !== undefined && end > start) return true
  const individual = object(summary.individualUsage)
  const team = object(summary.teamUsage)
  const plan = object(individual?.plan)
  if (["totalPercentUsed", "autoPercentUsed", "apiPercentUsed"].some((key) => numberOf(plan?.[key]) !== undefined)) return true
  return [individual?.onDemand, individual?.overall, team?.onDemand, team?.pooled].some(usableDollarBucket)
}

/** `CursorUsageSummaryMapper.hasUsableRequestPayload`. */
export function hasUsableRequests(usage: Record<string, any>): boolean {
  const requests = object(usage["gpt-4"])
  const limit = numberOf(requests?.maxRequestUsage)
  if (limit !== undefined && limit > 0) return true
  return isoTime(usage.startOfMonth) !== undefined
}

function onDemandBucket(value: unknown, cycle: { resetsAt?: number; periodMs: number }, lines: CursorLine[]): boolean {
  const bucket = object(value)
  if (!bucket || bucket.enabled === false) return false
  const meter = dollarMeter(bucket)
  if (meter) {
    lines.push(progress("On-demand", dollars(meter.used), dollars(meter.limit), "dollars", cycle.resetsAt, cycle.periodMs))
    return true
  }
  const used = numberOf(bucket.used)
  if (used !== undefined && used > 0) {
    lines.push({ label: "On-demand", kind: "dollars", amount: dollars(used) })
    return true
  }
  return false
}

function summaryOnDemand(summary: Record<string, any> | undefined, cycle: { resetsAt?: number; periodMs: number }, lines: CursorLine[]) {
  if (onDemandBucket(object(summary?.individualUsage)?.onDemand, cycle, lines)) return
  onDemandBucket(object(summary?.teamUsage)?.onDemand, cycle, lines)
}

/** `CursorUsageSummaryMapper.appendMissingOnDemand`. */
export function appendMissingOnDemand(summary: Record<string, any>, lines: CursorLine[]) {
  if (lines.some((line) => line.label === "On-demand")) return
  summaryOnDemand(summary, summaryCycle(summary, undefined), lines)
}

/** `CursorUsageSummaryMapper.map`. */
export function mapSummary(summary: Record<string, any> | undefined, requestUsage: Record<string, any> | undefined, planName: string | undefined, unavailable: string): CursorMapped {
  const cycle = summaryCycle(summary, requestUsage)
  const lines: CursorLine[] = []
  const requests = object(requestUsage?.["gpt-4"])
  const limit = numberOf(requests?.maxRequestUsage)
  const hasRequests = !!requests && limit !== undefined && limit > 0
  if (hasRequests) {
    const used = Math.max(0, numberOf(requests!.numRequests) ?? numberOf(requests!.numRequestsTotal) ?? 0)
    for (const label of ["Total usage", "Requests"]) lines.push(progress(label, used, limit!, "count", cycle.resetsAt, cycle.periodMs, "requests"))
  } else {
    const individual = object(summary?.individualUsage)
    const team = object(summary?.teamUsage)
    const limitType = text(summary?.limitType)?.toLowerCase()
    const dollarTotal = (meter: { used: number; limit: number }) => lines.push(progress("Total usage", dollars(meter.used), dollars(meter.limit), "dollars", cycle.resetsAt, cycle.periodMs))
    const pooled = dollarMeter(team?.pooled)
    const percent = numberOf(object(individual?.plan)?.totalPercentUsed)
    const overall = dollarMeter(individual?.overall)
    if (limitType === "team" && pooled) dollarTotal(pooled)
    else if (percent !== undefined) lines.push(progress("Total usage", percent, 100, "percent", cycle.resetsAt, cycle.periodMs))
    else if (overall) dollarTotal(overall)
    else if (pooled) dollarTotal(pooled)
  }
  const plan = object(object(summary?.individualUsage)?.plan)
  for (const [key, label] of [
    ["autoPercentUsed", "Cursor Models"],
    ["apiPercentUsed", "Other Models"],
  ] as const) {
    const percent = numberOf(plan?.[key])
    if (percent !== undefined) lines.push(progress(label, percent, 100, "percent", cycle.resetsAt, cycle.periodMs))
  }
  summaryOnDemand(summary, cycle, lines)
  if (!lines.length) throw new CursorPlanError(unavailable)
  const summaryMembership = text(summary?.membershipType)
  const label = resolvedPlanLabel(planName, preferredMembership(undefined, summaryMembership)) ?? planLabel(planName) ?? planLabel(summaryMembership)
  return { ...(label ? { plan: label } : {}), lines }
}

// --- As the box states it ---

/** Each line's window: its id, and what clients call it (UsageKit's labels, so its card finds them). */
const WINDOWS: Record<string, string> = {
  "Total usage": "total",
  "Cursor Models": "auto",
  "Other Models": "api",
  "Grok Bot usage": "grok_bot",
  "On-demand": "on_demand",
  Requests: "requests",
}

/**
 * Lines as plan limits' windows (`LimitWindow`): each meter its share used, with its amount where
 * it's dollars or requests; the credits left as the account's balance. A request-based plan's
 * `Requests` line that only says again what its total says is left out (one bar, not two); an
 * on-demand spend with no cap, which is no limit, is what the plan has beyond its windows
 * (`extras`: spent, in dollars), as UsageKit's card shows it ("Extra Usage", spent).
 */
export function readingOf(mapped: CursorMapped, identity: string | undefined): LimitReading {
  const windows: LimitReading["windows"] = []
  let balance: LimitReading["balance"]
  const extras: LimitExtra[] = []
  for (const line of mapped.lines) {
    if (line.kind === "dollars") {
      if (line.label === "Credits") balance = { left: line.amount, unit: "usd" }
      if (line.label === "On-demand") extras.push({ id: "on_demand", name: line.label, kind: "spent", amount: line.amount, unit: "usd" })
      continue
    }
    const id = WINDOWS[line.label]
    if (!id) continue
    const window: Omit<LimitWindow, "read" | "source"> = { id, used: line.limit > 0 ? line.used / line.limit : 0, name: line.label }
    if (line.resetsAt !== undefined) window.resetsAt = line.resetsAt
    if (line.periodMs !== undefined) window.minutes = Math.round(line.periodMs / 60_000)
    if (line.format === "dollars") window.amount = { used: line.used, limit: line.limit, unit: "usd" }
    if (line.format === "count") window.amount = { used: line.used, limit: line.limit, unit: "requests" }
    if (id === "requests" && windows.some((each) => each.id === "total" && each.amount?.unit === "requests" && each.amount.used === line.used && each.amount.limit === line.limit)) continue
    windows.push(window)
  }
  // (Spent this billing cycle: it starts over with the plan's total, where Cursor said when.)
  const cycleEnd = mapped.lines.find((line) => line.kind === "progress" && line.label === "Total usage" && line.resetsAt !== undefined)
  if (cycleEnd?.kind === "progress") for (const extra of extras) extra.resetsAt ??= cycleEnd.resetsAt
  return { windows, ...(mapped.plan ? { plan: mapped.plan } : {}), ...(balance ? { balance } : {}), ...(extras.length ? { extras } : {}), ...(identity ? { identity } : {}) }
}

/**
 * An optional endpoint's JSON object, or nothing (it doesn't fail the read). But a 429 holds every
 * read of the account off for as long as it says, and ends this one as held (a `LimitsProblem`), as
 * does Cursor being held off or the key turned away meanwhile: what was read last stays whole,
 * rather than a reading without what the held reads would have said (credits, Grok Bot's week).
 */
async function optional(client: CursorClient, request: () => Promise<CursorAnswer> | undefined): Promise<Record<string, any> | undefined> {
  let answer: CursorAnswer | undefined
  try {
    answer = await request()
  } catch (error) {
    if (error instanceof LimitsProblem) throw error
    return undefined
  }
  if (answer?.status === 429) throw new LimitsProblem("rate-limited", "Cursor is turning reads away for now.", client.holdFor(answer.headers.get("retry-after")) ?? client.heldUntil())
  if (!answer || answer.status < 200 || answer.status >= 300) return undefined
  return object(answer.body)
}

/**
 * Reads an account's plan from Cursor (`CursorProvider.probe`, its Grok Bot week and its credits
 * included; its spend history is the usage history's, `cursor-history.ts`): the lines, and who the
 * account is (`cursor:<user>`). Throws a `LimitsProblem` where it can't.
 */
export async function readCursorPlan(client: CursorClient, now: () => number = Date.now): Promise<{ mapped: CursorMapped; identity?: string }> {
  let access = await client.accessToken()
  // Its usage, its token exchanged again once if Cursor turns it away (`ProviderAuthRetry.fetch`).
  const attempt = async (token: string) => {
    try {
      return await client.dashboard("GetCurrentPeriodUsage", token)
    } catch (error) {
      if (error instanceof LimitsProblem) throw error
      throw new LimitsProblem("failed", "Couldn't reach Cursor. Check your connection.")
    }
  }
  let answer = await attempt(access)
  if (answer.status === 401 || answer.status === 403) {
    access = await client.accessToken(true)
    answer = await attempt(access)
    if (answer.status === 401 || answer.status === 403) throw new LimitsProblem("expired", "Cursor turned its sign-in away: sign in to Cursor again in Settings › Accounts.")
  }
  // (As long as it says; where it doesn't, the plan's own wait doubles with each, Limits'.)
  if (answer.status === 429) throw new LimitsProblem("rate-limited", "Cursor is turning reads away for now.", client.holdFor(answer.headers.get("retry-after")))
  if (answer.status < 200 || answer.status >= 300) throw new LimitsProblem("failed", `Cursor answered ${answer.status}.`)
  const usage = object(answer.body)
  if (!usage) throw new LimitsProblem("failed", "Cursor's answer wasn't one it gives.")
  const user = cursorSession(access)?.user
  const identity = user ? `cursor:${user.toLowerCase()}` : undefined
  // (A coding agent's sign-in has no editor's membership row: Cursor's own answers say the plan.)
  const membership: string | undefined = undefined
  const planBody = await optional(client, () => client.dashboard("GetPlanInfo", access))
  const planInfoName = trimmed(object(planBody?.planInfo)?.planName)
  const planInfoUnavailable = planInfoName === undefined
  const routing = routingPlanName(planInfoName, membership)
  const display = resolvedPlanName(planInfoName, membership)
  const grokBot = async (lines: CursorLine[]) => {
    const body = await optional(client, () => client.dashboard("GetSandUsageStatus", access))
    const line = body ? grokBotLine(body) : undefined
    if (line) lines.push(line)
  }
  const fallback = requestBasedFallback(usage, routing, planInfoUnavailable)
  const summary = () => optional(client, () => client.website("/api/usage-summary", access))
  const requests = () => {
    const who = cursorSession(access)?.user
    return optional(client, () => (who ? client.website("/api/usage", access, { query: { user: who } }) : undefined))
  }
  try {
    if (fallback !== undefined) {
      const found = await summary()
      const mapped = mapSummary(found, await requests(), display ?? routing, fallback)
      await grokBot(mapped.lines)
      return { mapped, ...(identity ? { identity } : {}) }
    }
    if (planFacts(usage).shouldTryGenericRequestFallback) {
      try {
        const body = await requests()
        if (!body) throw new CursorPlanError("Cursor request-based usage data unavailable. Try again later.")
        const mapped = mapRequestBasedUsage(body, display ?? routing, "Cursor request-based usage data unavailable. Try again later.")
        await grokBot(mapped.lines)
        return { mapped, ...(identity ? { identity } : {}) }
      } catch {}
    }
    const grants = await optional(client, () => client.dashboard("GetCreditGrantsBalance", access))
    const credits = grants && typeof grants.hasCreditGrants === "boolean" && (!grants.hasCreditGrants || ((numberOf(grants.totalCents) ?? 0) > 0 && (numberOf(grants.usedCents) ?? -1) >= 0)) ? grants : undefined
    const stripe = await optional(client, () => client.website("/api/auth/stripe", access))
    const mapped = mapUsage(usage, planInfoName, credits, stripe && numberOf(stripe.customerBalance) !== undefined ? stripeBalanceCents(stripe) : 0)
    const label = resolvedPlanLabel(planInfoName, membership)
    if (label) mapped.plan = label
    else delete mapped.plan
    // Org seats' on-demand, which usage-summary has where the usage omits it.
    const facts = planFacts(usage)
    const localIsOrg = membership !== undefined && ORG.has(membership)
    if (localIsOrg || facts.isTeamByShape) {
      const needsOnDemand = !mapped.lines.some((line) => line.label === "On-demand")
      if (!(localIsOrg && !needsOnDemand)) {
        const found = await summary()
        if (found && hasUsableSummary(found)) {
          if (needsOnDemand) appendMissingOnDemand(found, mapped.lines)
          const summaryMembership = text(found.membershipType)?.trim().toLowerCase()
          const better = resolvedPlanLabel(planInfoName, preferredMembership(membership, summaryMembership))
          if (better) mapped.plan = better
        }
      }
    }
    await grokBot(mapped.lines)
    return { mapped, ...(identity ? { identity } : {}) }
  } catch (error) {
    if (error instanceof CursorPlanError) throw new LimitsProblem("failed", error.message)
    throw error
  }
}

