// Codex's reset credits and credits (limits.ts, `extras`), read and spent with a ChatGPT sign-in
// Kuvo Code runs: the Codex agent's own (its home's `auth.json`), or the engine's `openai` one.
// ChatGPT's endpoints, as the Codex CLI uses them: the list of reset credits (`GET`, safe), and
// spending one (`POST …/consume`, by the credit's id, with the request id the box's journal keeps,
// so a retry is the same request and ChatGPT answers `already_redeemed` rather than spending
// another). Never renewed here: Codex and the engine renew their own sign-ins as they run.

import type { LimitExtra, ResetAttempt, ResetOutcome } from "./limits"

/** Where they're read: ChatGPT's, or a test's stand-in. */
export const codexResetEndpoints = {
  list: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
  consume: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
}

/** A ChatGPT sign-in to read and spend with. */
export interface ChatGPTSignIn {
  token: string
  account?: string
}

const headers = (signIn: ChatGPTSignIn): Record<string, string> => ({
  Authorization: `Bearer ${signIn.token.trim()}`,
  Accept: "application/json",
  "Content-Type": "application/json",
  "OpenAI-Beta": "codex-1",
  originator: "Codex Desktop",
  ...(signIn.account ? { "ChatGPT-Account-Id": signIn.account } : {}),
})

const time = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value !== "string" || !value.trim()) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

/** A credit still to spend: `available`, or one whose status isn't said. */
const available = (credit: any) => credit && typeof credit === "object" && (credit.status === undefined || credit.status === null || credit.status === "available")

/** The reset credits as a `resets` extra, from the list or the usage answer's own count; none where neither says. */
export function codexResets(list: any, embedded?: any, now = Date.now()): LimitExtra | undefined {
  const source = typeof list?.available_count === "number" && Number.isFinite(list.available_count) ? list : embedded
  const count = source?.available_count
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return undefined
  const expiries = (Array.isArray(source.credits) ? source.credits : [])
    .filter(available)
    .map((credit: any) => time(credit.expires_at))
    .filter((at: number | undefined): at is number => at !== undefined && at > now)
    .sort((a: number, b: number) => a - b)
    .slice(0, 50)
  const left = Math.floor(count)
  return { id: "resets", name: "Rate Limit Resets", kind: "resets", count: left, ...(expiries.length ? { expiries } : {}), usable: left > 0 }
}

/** Codex's credits left to spend, as ChatGPT's usage answer or Codex's snapshot says them (`balance`). */
export function codexCredits(credits: any): LimitExtra | undefined {
  if (!credits || typeof credits !== "object" || credits.unlimited === true) return undefined
  const raw = credits.balance
  const balance = typeof raw === "string" && raw.trim() ? Number(raw) : raw
  if (typeof balance === "number" && Number.isFinite(balance)) return { id: "credits", name: "Extra Usage", kind: "left", amount: Math.max(0, Math.floor(balance)), unit: "credits" }
  // (No credits at all is a real zero, said so; nothing said is nothing.)
  if (credits.has_credits === false || credits.hasCredits === false) return { id: "credits", name: "Extra Usage", kind: "left", amount: 0, unit: "credits" }
  return undefined
}

/** The reset credits, read now: undefined where they couldn't be (what was read before stands). */
export async function readCodexResets(signIn: ChatGPTSignIn, now = Date.now()): Promise<LimitExtra | undefined> {
  try {
    const response = await fetch(codexResetEndpoints.list, { headers: headers(signIn), signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return undefined
    return codexResets((await response.json()) as any, undefined, now)
  } catch {
    return undefined
  }
}

/**
 * Spends one reset credit: the one `attempt` already chose (asked again), else the soonest to
 * expire, chosen from the list read now and kept in the journal before it's spent.
 */
export async function spendCodexReset(signIn: ChatGPTSignIn | undefined, attempt: ResetAttempt, now = Date.now()): Promise<{ outcome: ResetOutcome; already?: true }> {
  if (!signIn) return { outcome: "no-reset" }
  let credit = attempt.target
  // (Nothing is spent before the credit is chosen and kept: a failure until then is only that.)
  if (!credit) {
    try {
      const response = await fetch(codexResetEndpoints.list, { headers: headers(signIn), signal: AbortSignal.timeout(15_000) })
      if (!response.ok) return { outcome: "failed" }
      const body: any = await response.json().catch(() => undefined)
      const credits = (Array.isArray(body?.credits) ? body.credits : []).filter((each: any) => available(each) && typeof each.id === "string" && each.id && (time(each.expires_at) ?? Infinity) > now)
      credits.sort((a: any, b: any) => (time(a.expires_at) ?? Infinity) - (time(b.expires_at) ?? Infinity))
      if (!credits.length) return { outcome: "no-reset" }
      credit = String(credits[0].id)
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(credit)) return { outcome: "failed" }
      attempt.keep(credit)
    } catch {
      return { outcome: "failed" }
    }
  }
  try {
    const response = await fetch(codexResetEndpoints.consume, {
      method: "POST",
      headers: headers(signIn),
      body: JSON.stringify({ redeem_request_id: attempt.request, credit_id: credit }),
      signal: AbortSignal.timeout(25_000),
    })
    // Turned away as asked (its credit gone, a request it won't take): nothing spent. Turned away
    // for its sign-in or for now, or failing: whether an earlier try went through isn't said.
    if (!response.ok) return { outcome: response.status >= 500 || [401, 403, 429].includes(response.status) ? "unknown" : "failed" }
    const code = ((await response.json().catch(() => undefined)) as any)?.code
    if (code === "reset") return { outcome: "reset" }
    if (code === "already_redeemed") return { outcome: "reset", already: true }
    if (code === "nothing_to_reset") return { outcome: "nothing-to-reset" }
    if (code === "no_credit") return { outcome: "no-reset" }
    return { outcome: "unknown" }
  } catch {
    return { outcome: "unknown" }
  }
}
