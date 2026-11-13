// Claude's plan limits for one account (limits.ts), read as Claude Code reads them for its /usage:
// `GET /api/oauth/usage` with the account's own sign-in, Kuvo Code's (on a Mac its token from
// `claude setup-token`; on Linux Claude Code's own file in Kuvo Code's folder), never yours in
// Terminal, and never renewed here: Claude Code renews its own as it runs. Only on Linux: a Mac's
// token can only run Claude (`setup-token` grants no more), and Anthropic answered every read of
// it with a 429 for hours. Anthropic limits these reads hard, for the whole computer rather than a
// sign-in, so the box reads each account at most every 15 minutes, one at a time, and waits out a
// 429 for as long as it says. What a turn hears (Claude Code's rate-limit events, each window as
// every response's headers give it) keeps them current between reads, and is all a Mac has.

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { LimitsProblem, retryAt, type LimitExtra, type LimitReading, type LimitWindow, type ResetAttempt, type ResetOutcome } from "../limits"

/** Where the reads go: Anthropic's, or a test's stand-in. */
export const claudeUsage = { url: "https://api.anthropic.com/api/oauth/usage" }

/** Fifteen minutes between two reads of an account. */
export const CLAUDE_LIMITS_EVERY = 15 * 60_000

/** An hour between two reads of an account's reset grants. */
export const CLAUDE_GRANTS_EVERY = 60 * 60_000

/** Why a Mac's Claude token shows no extra usage or resets. */
export const MAC_TOKEN_CANT = "This Mac's Claude sign-in can only run Claude, so its extra usage and resets show only from a computer of yours signed in to Claude Code with the same account."

/** A sign-in to read with: its token, and what Claude Code kept of it beside. */
export interface ClaudeSignIn {
  token: string
  /** "max", "pro"…, as Claude Code kept it as it signed in. */
  subscription?: string
  /** "default_claude_max_20x"…: its plan's size. */
  tier?: string
  /** When the token lapses, in ms. */
  expiresAt?: number
  /** What it was granted; reading the plan's limits takes `user:profile`. */
  scopes?: string[]
}

/** Claude Code's own sign-in file in a settings folder (Linux; a Mac's is in the Keychain, never read here). */
export function credentialsIn(configHome: string): ClaudeSignIn | undefined {
  try {
    const oauth = JSON.parse(readFileSync(join(configHome, ".credentials.json"), "utf8"))?.claudeAiOauth
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return undefined
    return {
      token: oauth.accessToken,
      ...(typeof oauth.subscriptionType === "string" ? { subscription: oauth.subscriptionType } : {}),
      ...(typeof oauth.rateLimitTier === "string" ? { tier: oauth.rateLimitTier } : {}),
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt } : {}),
      ...(Array.isArray(oauth.scopes) ? { scopes: oauth.scopes.filter((scope: unknown) => typeof scope === "string") } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Who a Claude Code sign-in is in a settings folder: the account and the organization whose plan it
 * uses (one account can have a personal plan and a team's, each with its own limits), as
 * `anthropic:<account>|<organization>`, the same however it's signed in.
 * - Claude Code's own sign-in (Linux): as it keeps it beside the sign-in (`.claude.json`'s `oauthAccount`).
 * - Kuvo Code's token (`token`, a Mac's, from `claude setup-token`), which says nothing of who it's
 *   for and leaves `oauthAccount` out: as Anthropic says in the policy record Claude Code fetches
 *   with it as it runs (`tokenIdentity`). None until it has run with this token.
 */
export function claudeIdentity(configHome: string, token?: string): string | undefined {
  if (token !== undefined) return tokenIdentity(configHome, token)
  const file = join(configHome, ".claude.json")
  try {
    // (It keeps each project's state too, and can be large: read again only when it changed.)
    const { mtimeMs, size } = statSync(file)
    const known = identities.get(file)
    if (known && known.mtimeMs === mtimeMs && known.size === size) return known.identity
    const identity = identityIn(readFileSync(file, "utf8"))
    identities.set(file, { mtimeMs, size, identity })
    return identity
  } catch {
    return undefined
  }
}

const identities = new Map<string, { mtimeMs: number; size: number; identity: string | undefined }>()

function identityIn(text: string): string | undefined {
  try {
    const account = JSON.parse(text)?.oauthAccount
    const uuid = typeof account?.accountUuid === "string" ? account.accountUuid.trim().toLowerCase() : ""
    if (!uuid) return undefined
    const organization = typeof account.organizationUuid === "string" ? account.organizationUuid.trim().toLowerCase() : ""
    return `anthropic:${uuid}|${organization}`
  } catch {
    return undefined
  }
}

/**
 * Who Kuvo Code's token is for, from the record of the organization's policies Claude Code fetches
 * with it as it runs and keeps in its settings folder, signed by Anthropic for the sign-in that
 * asked (`policy-limits.json.signature.json`: a JSON Web Signature whose `aud` is the organization
 * and `sub` the account, as Claude Code itself reads them). Taken only where Claude Code's note
 * beside it (`policy-limits.json.stamp.json`) says that record was fetched with this very token
 * (its `identity`, a hash of the token's own, as Claude Code makes it) and is the one signed (its
 * `sha`): another sign-in using the folder (yours in Terminal, in `~/.claude`) or one before keeps a
 * record of its own there, which isn't this one's. The token itself is only hashed, as Claude Code
 * does, and nothing is checked with Anthropic.
 *
 * These are Claude Code's own files, as 2.1.319 writes them (version 1 of the note); where they
 * change, or a sign-in is stamped otherwise (`CLAUDE_CODE_ORGANIZATION_UUID` makes it the
 * organization's), it's none and the account's row is its computer's own, as before, said once in
 * the bridge's log. Another sign-in's record written over this one's in the instant between Claude
 * Code writing the note and the record could be taken for this one's until it's next read (a minute).
 */
function tokenIdentity(configHome: string, token: string): string | undefined {
  try {
    // (Both are small: read each time, never kept.)
    return recordIdentity(configHome, readFileSync(join(configHome, "policy-limits.json.stamp.json"), "utf8"), readFileSync(join(configHome, "policy-limits.json.signature.json"), "utf8"), token)
  } catch {
    return undefined
  }
}

function recordIdentity(configHome: string, stampText: string, signatureText: string, token: string): string | undefined {
  try {
    const stamp = JSON.parse(stampText)
    if (stamp?.v !== 1 || typeof stamp.identity !== "string") return unread(configHome, "its policy note isn't one this version reads")
    // Claude Code's principal for a token: `token:` and the first half of its SHA-256; the stamp keeps
    // that principal's SHA-256.
    const principal = `token:${createHash("sha256").update(token.trim()).digest("hex").slice(0, 32)}`
    if (stamp?.kind !== "token" || stamp.identity !== createHash("sha256").update(principal).digest("hex")) return undefined
    const payload = String(JSON.parse(signatureText)?.jws ?? "").split(".")[1]
    if (!payload) return unread(configHome, "its policy record isn't one this version reads")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof stamp.sha !== "string" || claims?.sha !== stamp.sha) return undefined
    const account = typeof claims.sub === "string" ? claims.sub.trim().toLowerCase() : ""
    const organization = typeof claims.aud === "string" ? claims.aud.trim().toLowerCase() : ""
    return account && organization ? `anthropic:${account}|${organization}` : undefined
  } catch {
    // (Read as Claude Code writes it, say: read again in a minute.)
    return undefined
  }
}

/** Said once a folder, in the bridge's log: why its account can't be told (none). */
function unread(configHome: string, why: string): undefined {
  if (!told.has(configHome)) console.error(`Claude's account in ${configHome} can't be told: ${why}.`)
  told.add(configHome)
  return undefined
}

const told = new Set<string>()

/** "Max 20x", "Pro": the plan, from what Claude Code kept of the sign-in. */
export function planName(subscription?: string, tier?: string): string | undefined {
  const base = subscription?.trim()
  if (!base) return undefined
  const name = base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()
  const size = tier?.match(/\d+x/)?.[0]
  return size ? `${name} ${size}` : name
}

/** The windows Claude's answer has: the plan's five hours and week, and each model's own week. */
export function claudeWindows(body: any): Omit<LimitWindow, "read" | "source">[] {
  const windows: Omit<LimitWindow, "read" | "source">[] = []
  const add = (id: string, value: any, minutes: number, model?: string) => {
    const used = Number(value?.utilization)
    if (value == null || value.utilization == null || !Number.isFinite(used)) return
    const resets = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN
    windows.push({ id, used: used / 100, minutes, ...(Number.isFinite(resets) ? { resetsAt: resets } : {}), ...(model ? { model } : {}) })
  }
  add("five_hour", body?.five_hour, 300)
  add("seven_day", body?.seven_day, 10_080)
  add("seven_day_sonnet", body?.seven_day_sonnet, 10_080, "Sonnet")
  add("seven_day_opus", body?.seven_day_opus, 10_080, "Opus")
  // Each model's own week, where Anthropic lists them now (`limits`, "weekly_scoped").
  for (const limit of Array.isArray(body?.limits) ? body.limits : []) {
    const model = limit?.scope?.model?.display_name
    if (limit?.kind !== "weekly_scoped" || typeof model !== "string" || !model) continue
    const id = `seven_day_${model.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
    if (windows.some((window) => window.id === id)) continue
    add(id, { utilization: limit.percent, resets_at: limit.resets_at }, 10_080, model)
  }
  return windows
}

/**
 * Reads the account's limits now. `version`: Claude Code's here, for the user agent Anthropic
 * expects of its reads.
 */
export async function readClaudeLimits(signIn: ClaudeSignIn | undefined, version: string | undefined, now = Date.now()): Promise<LimitReading> {
  if (!signIn) throw new LimitsProblem("none", "Not signed in to a Claude plan here.", undefined, false)
  const plan = planName(signIn.subscription, signIn.tier)
  if (signIn.expiresAt !== undefined && signIn.expiresAt <= now) throw new LimitsProblem("expired", "Its sign-in has lapsed: Claude Code renews it the next time it runs here.", undefined, false)
  if (signIn.scopes?.length && !signIn.scopes.includes("user:profile")) throw new LimitsProblem("unreadable", "This sign-in runs Claude but can't read its plan's limits: sign in to Claude Code again here.", undefined, false)
  let response: Response
  try {
    response = await fetch(claudeUsage.url, {
      headers: {
        Authorization: `Bearer ${signIn.token.trim()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        ...(version ? { "User-Agent": `claude-cli/${version} (external, cli)` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (caught) {
    throw new LimitsProblem("failed", `Couldn't reach Anthropic: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
  if (response.status === 429) throw new LimitsProblem("rate-limited", "Anthropic is turning away reads of the plan's limits for now.", retryAt(response.headers.get("retry-after"), now))
  const text = await response.text().catch(() => "")
  if (response.status === 401) throw new LimitsProblem("expired", "Anthropic turned its sign-in away: Claude Code renews it the next time it runs here.")
  if (response.status === 403) {
    if (/scope/i.test(text)) throw new LimitsProblem("unreadable", "This sign-in runs Claude but can't read its plan's limits: sign in to Claude Code again here.")
    throw new LimitsProblem("failed", "Anthropic didn't let this sign-in read its plan's limits.")
  }
  if (!response.ok) throw new LimitsProblem("failed", `Anthropic answered ${response.status}.`)
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new LimitsProblem("failed", "Anthropic's answer wasn't what Kuvo Code reads.")
  }
  const extra = claudeExtraUsage(body?.extra_usage)
  return { windows: claudeWindows(body), ...(plan ? { plan } : {}), ...(extra ? { extras: [extra] } : {}) }
}

/**
 * Claude's extra usage, where it's on (`extra_usage`, in cents): what's used of its monthly cap, or,
 * without one, what's spent.
 */
export function claudeExtraUsage(value: any): LimitExtra | undefined {
  if (!value || typeof value !== "object" || value.is_enabled !== true) return undefined
  const used = Number(value.used_credits)
  if (!Number.isFinite(used)) return undefined
  const limit = Number(value.monthly_limit)
  const resets = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN
  const resetsAt = Number.isFinite(resets) ? { resetsAt: resets } : {}
  if (Number.isFinite(limit) && limit > 0) return { id: "extra_usage", name: "Extra Usage", kind: "capped", amount: Math.max(0, used) / 100, limit: limit / 100, unit: "usd", ...resetsAt }
  return { id: "extra_usage", name: "Extra Usage", kind: "spent", amount: Math.max(0, used) / 100, unit: "usd", ...resetsAt }
}

/** Anthropic's one-off resets of an account's limits (its `cedar_ember` program), as last read. */
export interface ClaudeGrants {
  eligible: boolean
  grants: { id: string; left: number; endsAt?: number; clears: string[] }[]
  /** The grant a reset spends now, as Anthropic names it. */
  next?: string
}

/** The grants Anthropic states (`cedar_ember`); none for a plan outside the program, or one not read whole (never half trusted). */
export function claudeGrants(value: any): ClaudeGrants | undefined {
  if (!value || typeof value !== "object") return undefined
  const grants: ClaudeGrants["grants"] = []
  for (const grant of Array.isArray(value.grants) ? value.grants : []) {
    const left = Number(grant?.resets_left)
    if (typeof grant?.id !== "string" || !grant.id || !Number.isFinite(left)) return undefined
    const ends = typeof grant.ends_at === "string" ? Date.parse(grant.ends_at) : typeof grant.ends_at === "number" ? grant.ends_at * (grant.ends_at < 1e12 ? 1000 : 1) : NaN
    grants.push({ id: grant.id, left: Math.max(0, Math.floor(left)), ...(Number.isFinite(ends) ? { endsAt: ends } : {}), clears: Array.isArray(grant.clears) ? grant.clears.filter((each: unknown) => typeof each === "string") : [] })
  }
  return { eligible: value.eligible === true, grants, ...(typeof value.next_grant_id === "string" && value.next_grant_id ? { next: value.next_grant_id } : {}) }
}

/** The grant a reset would spend now: the one Anthropic names next, with a reset left, for an eligible account. */
export function claimableGrant(grants: ClaudeGrants | undefined, now: number): ClaudeGrants["grants"][number] | undefined {
  if (!grants?.eligible || !grants.next) return undefined
  return grants.grants.find((grant) => grant.id === grants.next && grant.left > 0 && (grant.endsAt === undefined || grant.endsAt > now))
}

/** The grants as a `resets` extra: each reset left of an unexpired grant, for an eligible account. */
export function grantsExtra(grants: ClaudeGrants, now: number): LimitExtra {
  let count = 0
  const expiries: number[] = []
  if (grants.eligible) {
    for (const grant of grants.grants) {
      if (grant.left < 1 || (grant.endsAt !== undefined && grant.endsAt <= now)) continue
      count += grant.left
      if (grant.endsAt !== undefined) expiries.push(...Array(Math.min(grant.left, 50)).fill(grant.endsAt))
    }
  }
  const next = claimableGrant(grants, now)
  return { id: "resets", name: "Rate Limit Resets", kind: "resets", count, ...(expiries.length ? { expiries: expiries.sort((a, b) => a - b).slice(0, 50) } : {}), ...(next?.clears.length ? { refills: next.clears } : {}), usable: !!next }
}

/** Claude Code's own headers, as it reads its plan with its sign-in. */
const claudeHeaders = (token: string, version: string | undefined) => ({
  Authorization: `Bearer ${token.trim()}`,
  Accept: "application/json",
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
  ...(version ? { "User-Agent": `claude-cli/${version} (external, cli)` } : {}),
})

/**
 * The account's grants, read now as Claude Code reads them when it checks for a reset to offer
 * (`cedar_ember=1&skip_spend=1`; Anthropic turns away a client it doesn't take for Claude Code's).
 * Anthropic limits this read hard: the box asks it at most hourly an account. Throws when it can't.
 */
export async function readClaudeGrants(signIn: ClaudeSignIn, version: string | undefined): Promise<ClaudeGrants | undefined> {
  const url = new URL(claudeUsage.url)
  url.searchParams.set("cedar_ember", "1")
  url.searchParams.set("skip_spend", "1")
  const response = await fetch(url, { headers: claudeHeaders(signIn.token, version), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Anthropic answered ${response.status}.`)
  return claudeGrants(((await response.json()) as any)?.cedar_ember)
}

/** The organization a sign-in claims against: as Claude Code keeps it beside the sign-in, else as Anthropic's profile says. */
export async function claudeOrganization(configHome: string | undefined, signIn: ClaudeSignIn, version: string | undefined): Promise<string | undefined> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const kept = configHome ? claudeIdentity(configHome)?.split("|")[1] : undefined
  if (kept && uuid.test(kept)) return kept
  try {
    const response = await fetch(new URL("profile", claudeUsage.url), { headers: claudeHeaders(signIn.token, version), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return undefined
    const organization = ((await response.json()) as any)?.organization?.uuid
    return typeof organization === "string" && uuid.test(organization) ? organization : undefined
  } catch {
    return undefined
  }
}

/**
 * Spends one reset grant, as Claude Code does (`POST /api/organizations/<org>/reset_rate_limits`,
 * with the request id the box's journal keeps: asked again, Anthropic answers `already_used`).
 * `grant`: the one to spend, as last read (`claimableGrant`).
 */
export async function claimClaudeGrant(signIn: ClaudeSignIn | undefined, version: string | undefined, organization: string | undefined, grant: string | undefined, attempt: ResetAttempt): Promise<{ outcome: ResetOutcome; until?: number }> {
  const target = attempt.target ?? grant
  if (!signIn || !target) return { outcome: "no-reset" }
  if (!organization || !/^[a-z0-9_-]{1,40}$/.test(target) || !/^[A-Za-z0-9_-]{1,64}$/.test(attempt.request)) return { outcome: "failed" }
  if (!attempt.target) attempt.keep(target)
  try {
    const response = await fetch(new URL(`../organizations/${organization}/reset_rate_limits`, claudeUsage.url.replace(/\/oauth\/usage$/, "/oauth/")), {
      method: "POST",
      headers: claudeHeaders(signIn.token, version),
      body: JSON.stringify({ program: "cedar_ember", grant_id: target, request_id: attempt.request }),
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) return { outcome: "failed" }
    const body: any = await response.json().catch(() => undefined)
    const cooldown = typeof body?.cooldown_until === "string" ? Date.parse(body.cooldown_until) : NaN
    const until = Number.isFinite(cooldown) ? { until: cooldown } : {}
    const code = body?.result === "unavailable" ? body?.reason : body?.result
    switch (code) {
      case "reset":
      case "already_used":
        return { outcome: "reset" }
      case "not_limited":
        return { outcome: "nothing-to-reset" }
      case "ineligible":
      case "no_grant":
      case "unknown_grant":
      case "not_next_grant":
        return { outcome: "no-reset" }
      case "reset_unconfirmed":
      case "stamp_indeterminate":
        return { outcome: "unconfirmed" }
      case "cooldown":
      case "paused":
      case "low_priority_active":
        return { outcome: "not-now", ...until }
      default:
        return { outcome: "failed" }
    }
  } catch {
    return { outcome: "failed" }
  }
}

/**
 * The windows a turn heard of (Claude Code's `rate_limit_event`): every window it tracks
 * (`unifiedWindows`, read from each response's headers, from Claude Code 2.1.3xx), else the one that
 * limits it now, when it says enough to keep.
 */
export function heardWindows(info: any): Omit<LimitWindow, "read" | "source">[] {
  const windows: Omit<LimitWindow, "read" | "source">[] = []
  const unified = info?.unifiedWindows
  if (unified && typeof unified === "object") {
    for (const [id, window] of Object.entries<any>(unified)) {
      const shape = HEARD[id]
      const used = Number(window?.utilization)
      if (!shape || !Number.isFinite(used)) continue
      const resetsAt = Number(window.resetsAt)
      windows.push({ id: shape.id, used, minutes: shape.minutes, ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt: resetsAt * 1000 } : {}), ...(shape.model ? { model: shape.model } : {}) })
    }
    if (windows.length) return windows
  }
  const shape = HEARD[info?.rateLimitType]
  if (!shape) return []
  const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined
  // How much is used, as it says; turned away with no word, all of it.
  const used = typeof info.utilization === "number" ? info.utilization : info.status === "rejected" ? 1 : undefined
  if (used === undefined) return []
  return [{ id: shape.id, used, minutes: shape.minutes, ...(resetsAt ? { resetsAt } : {}), ...(shape.model ? { model: shape.model } : {}) }]
}

/** How much of a limit is gone before a warning calls it close: 90%, where the Mac's usage panel turns a bar red. */
export const CLOSE_TO_LIMIT = 0.9

/**
 * What a turn says when Claude Code warns of a limit (`allowed_warning`): how much of which one is
 * used, and whether that's close. Claude Code warns early in a window too (a quarter of the week
 * gone in its first day), so it's "close" only once nearly all of it is.
 */
export function limitWarning(info: any): { text: string; close: boolean } {
  const limit = warnedLimit(info?.rateLimitType)
  const stated = [info?.utilization, info?.unifiedWindows?.[info?.rateLimitType]?.utilization].find((value) => typeof value === "number" && Number.isFinite(value))
  if (stated !== undefined) {
    // (Never all of it till it is: 99.6% is 99%.)
    const percent = stated < 1 ? Math.min(Math.round(Math.max(stated, 0) * 100), 99) : 100
    if (percent === 100) return { text: `You've used all of ${limit}.`, close: true }
    const close = percent >= CLOSE_TO_LIMIT * 100
    return { text: close ? `You're close to ${limit}: ${percent}% used.` : `You've used ${percent}% of ${limit}.`, close }
  }
  // No figure: the threshold it passed, at least.
  const passed = typeof info?.surpassedThreshold === "number" ? info.surpassedThreshold : NaN
  if (!(passed > 0)) return { text: `Claude Code warned about ${limit}.`, close: false }
  const close = passed >= CLOSE_TO_LIMIT
  return { text: close ? `You're close to ${limit}.` : `You've used over ${Math.round(passed * 100)}% of ${limit}.`, close }
}

/** The limit Claude Code warns of, by its name for it. */
function warnedLimit(type: unknown): string {
  if (type === "five_hour") return "your 5-hour Claude limit"
  if (type === "overage") return "your Claude extra usage limit"
  const shape = typeof type === "string" ? HEARD[type] : undefined
  if (shape?.minutes === 10_080) return shape.model ? `your weekly ${shape.model} limit` : "your weekly Claude limit"
  return "your Claude usage limit"
}

/** Claude Code's windows, as the usage endpoint names them (its overage-included week is Fable's, as Claude Code calls it). */
const HEARD: Record<string, { id: string; minutes: number; model?: string }> = {
  five_hour: { id: "five_hour", minutes: 300 },
  seven_day: { id: "seven_day", minutes: 10_080 },
  seven_day_sonnet: { id: "seven_day_sonnet", minutes: 10_080, model: "Sonnet" },
  seven_day_opus: { id: "seven_day_opus", minutes: 10_080, model: "Opus" },
  seven_day_overage_included: { id: "seven_day_fable", minutes: 10_080, model: "Fable" },
}
