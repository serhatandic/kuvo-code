// Cursor's own account of your plan, asked with Kuvo Code's own Cursor sign-in (the API key the
// Cursor agent's sign-in made, kept in its folder's `auth.json`, or CURSOR_API_KEY for your own
// account), never the Cursor app's login on this computer. The key is exchanged for a short-lived
// access token as Cursor's own SDK does, kept in memory only while it lasts. UsageKit's
// `CursorUsageClient`, ported (#631 piece D1).

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fingerprint, LimitsProblem, retryAt, tokenClaims } from "../limits"

/**
 * Where Cursor is asked: its own hosts, or a test's stand-in. `live`: whether its own hosts may be
 * asked from this box (only a real box's bridge, `isRealBridgeFolder`): a test's bridge never does,
 * whatever sign-in its folder holds.
 */
export const cursorEndpoints = {
  api2: "https://api2.cursor.sh",
  web: "https://cursor.com",
  live: false,
}

/** Whether Cursor may be asked now: its own hosts only from a real box, a stand-in always. */
export function cursorReachable(): boolean {
  return cursorEndpoints.live || (cursorEndpoints.api2 !== "https://api2.cursor.sh" && cursorEndpoints.web !== "https://cursor.com")
}

/** A Connect call's headers, besides its token. */
const CONNECT = { "Content-Type": "application/json", "Connect-Protocol-Version": "1" }

/** An answer: its status, its body as JSON (undefined when it isn't any), and its headers. */
export interface CursorAnswer {
  status: number
  body: any
  headers: Headers
}

/** Who the access token is for, and the cookie Cursor's website takes for it (`CursorUsageClient.session`). */
export function cursorSession(accessToken: string): { user: string; cookie: string } | undefined {
  const subject = tokenClaims(accessToken)?.sub
  if (typeof subject !== "string" || !subject.trim()) return undefined
  const parts = subject.trim().split("|")
  const user = parts.length > 1 ? parts[1]! : parts[0]!
  if (!user) return undefined
  return { user, cookie: `WorkosCursorSessionToken=${user}%3A%3A${accessToken}` }
}

/**
 * A Cursor account's sign-in as the box keeps it: the API key in the account's folder (`auth.json`,
 * as the agent's SDK wrote it), while it lasts; for your own account, CURSOR_API_KEY first.
 */
export function cursorKey(folder: string, own: boolean, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | undefined {
  const fromEnvironment = own ? env.CURSOR_API_KEY?.trim() : undefined
  if (fromEnvironment) return fromEnvironment
  try {
    const saved = JSON.parse(readFileSync(join(folder, "auth.json"), "utf8"))
    const key = typeof saved?.apiKey === "string" ? saved.apiKey.trim() : ""
    if (!key) return undefined
    if (typeof saved.apiKeyExpiresAtMs === "number" && saved.apiKeyExpiresAtMs < now) return undefined
    return key
  } catch {
    return undefined
  }
}

/**
 * Whether the account's sign-in file is there but can't be read just now (the SDK rewriting it, say):
 * not signed out, so what the box has of the account stays.
 */
export function cursorKeyUnreadable(folder: string): boolean {
  const file = join(folder, "auth.json")
  if (!existsSync(file)) return false
  try {
    JSON.parse(readFileSync(file, "utf8"))
    return false
  } catch {
    return true
  }
}

/**
 * Asks Cursor for one account (`key`, its sign-in now): exchanges its key for an access token, kept
 * until five minutes before it lapses, and again when Cursor turns it away.
 */
export class CursorClient {
  private token?: { key: string; access: string; until: number }

  constructor(
    readonly key: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** The sign-in's fingerprint (never the key). */
  signIn(): string | undefined {
    return fingerprint(this.key())
  }

  /**
   * Who the account is (`cursor:<user>`), as the access token its key was last exchanged for says,
   * while the key is the one it was exchanged with: known once Cursor has answered the exchange,
   * whatever came of the reads after it. Never sent anywhere but hashed (`identityOf`).
   */
  identity(): string | undefined {
    const kept = this.token
    if (!kept || kept.key !== this.key()) return undefined
    const user = cursorSession(kept.access)?.user
    return user ? `cursor:${user.toLowerCase()}` : undefined
  }

  /** An access token for the sign-in now; `fresh`, exchanged again whatever's kept. */
  async accessToken(fresh = false): Promise<string> {
    if (!cursorReachable()) throw new LimitsProblem("none", "Cursor isn't asked from this box.", undefined, false)
    const key = this.key()
    if (!key) throw new LimitsProblem("none", "Not signed in to Cursor here.", undefined, false)
    const kept = this.token
    if (!fresh && kept && kept.key === key && this.now() < kept.until) return kept.access
    let answer: CursorAnswer
    try {
      answer = await send(`${cursorEndpoints.api2}/auth/exchange_user_api_key`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "{}" }, 10_000)
    } catch {
      throw new LimitsProblem("failed", "Couldn't reach Cursor. Check your connection.")
    }
    // (Cursor not answering, or answering otherwise, isn't the sign-in ending.)
    if (answer.status === 400 || answer.status === 401) throw new LimitsProblem("expired", "Cursor turned its sign-in away: sign in to Cursor again in Settings › Accounts.")
    if (answer.status === 429) throw new LimitsProblem("rate-limited", "Cursor is turning reads away for now.", retryAt(answer.headers.get("retry-after"), this.now()))
    if (answer.status < 200 || answer.status >= 300) throw new LimitsProblem("failed", `Cursor answered ${answer.status}.`)
    const access = typeof answer.body?.accessToken === "string" ? answer.body.accessToken.trim() : ""
    if (!access) throw new LimitsProblem("failed", "Cursor's answer wasn't one it gives.")
    // (Until five minutes before it lapses, `CursorAuthStore.refreshBufferSeconds`; one that doesn't say, this read only.)
    const exp = Number(tokenClaims(access)?.exp)
    this.token = { key, access, until: Number.isFinite(exp) ? exp * 1000 - 5 * 60_000 : 0 }
    return access
  }

  /** A Connect call to Cursor's dashboard service (`aiserver.v1.DashboardService/<method>`). */
  dashboard(method: string, access: string): Promise<CursorAnswer> {
    return send(`${cursorEndpoints.api2}/aiserver.v1.DashboardService/${method}`, { method: "POST", headers: { Authorization: `Bearer ${access}`, ...CONNECT }, body: "{}" }, 10_000)
  }

  /** A page of Cursor's website's API, with the access token's session cookie; undefined when the token names no one. */
  website(path: string, access: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}, timeout = 10_000): Promise<CursorAnswer> | undefined {
    const session = cursorSession(access)
    if (!session) return undefined
    const url = new URL(`${cursorEndpoints.web}${path}`)
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value)
    const headers: Record<string, string> = { Cookie: session.cookie }
    if (init.body !== undefined) Object.assign(headers, { "Content-Type": "application/json", Origin: "https://cursor.com" })
    return send(url.toString(), { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, timeout)
  }
}

async function send(url: string, init: RequestInit, timeout: number): Promise<CursorAnswer> {
  if (!cursorReachable()) throw new Error("Cursor isn't asked from this box.")
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeout) })
  const text = await response.text()
  let body: any
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {}
  return { status: response.status, body, headers: response.headers }
}
