// Claude's plan limits for one account (limits.ts), read as Claude Code reads them for its /usage:
// `GET /api/oauth/usage` with the account's own sign-in, Kuvo Code's (on a Mac its token from
// `claude setup-token`; on Linux Claude Code's own file in Kuvo Code's folder), never yours in
// Terminal, and never renewed here: Claude Code renews its own as it runs. Anthropic limits these
// reads hard, for the whole computer rather than a sign-in, and holds a reader off for longer each
// time it asks too soon, so the box reads each account at most every 15 minutes and waits out every
// 429 for as long as it says; meanwhile what a turn hears of the limits (Claude Code's rate-limit
// events) keeps them current.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LimitsProblem, retryAt, type LimitReading, type LimitWindow } from "../limits"

/** Where the reads go: Anthropic's, or a test's stand-in. */
export const claudeUsage = { url: "https://api.anthropic.com/api/oauth/usage" }

/** Fifteen minutes between two reads of an account. */
export const CLAUDE_LIMITS_EVERY = 15 * 60_000

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
  if (!signIn) throw new LimitsProblem("none", "Not signed in to a Claude plan here.")
  const plan = planName(signIn.subscription, signIn.tier)
  if (signIn.expiresAt !== undefined && signIn.expiresAt <= now) throw new LimitsProblem("expired", "Its sign-in has lapsed: Claude Code renews it the next time it runs here.")
  if (signIn.scopes?.length && !signIn.scopes.includes("user:profile")) throw new LimitsProblem("unreadable", "This sign-in runs Claude but can't read its plan's limits: sign in to Claude Code again here.")
  let response: Response
  try {
    response = await fetch(claudeUsage.url, {
      headers: {
        Authorization: `Bearer ${signIn.token.trim()}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-cli/${version ?? "2.1.319"} (external, cli)`,
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
  return { windows: claudeWindows(body), ...(plan ? { plan } : {}) }
}

/** A window a turn heard of (Claude Code's `rate_limit_event`), when it says enough to keep. */
export function heardWindow(info: any): Omit<LimitWindow, "read" | "source"> | undefined {
  const id = info?.rateLimitType
  if (typeof id !== "string" || !/^(five_hour|seven_day(_[a-z0-9_]+)?)$/.test(id) || id === "seven_day_overage_included") return undefined
  const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : undefined
  // How much is used, as it says; turned away with no word, all of it.
  const used = typeof info.utilization === "number" ? info.utilization : info.status === "rejected" ? 1 : undefined
  if (used === undefined) return undefined
  const minutes = id === "five_hour" ? 300 : 10_080
  const model = id === "seven_day_sonnet" ? "Sonnet" : id === "seven_day_opus" ? "Opus" : undefined
  return { id, used, minutes, ...(resetsAt ? { resetsAt } : {}), ...(model ? { model } : {}) }
}
