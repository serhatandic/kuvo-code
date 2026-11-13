// The limits and credits of the engine's sign-ins (limits.ts): each account you signed in to in
// Kuvo Code on this computer (Settings › Accounts), read with that sign-in as the engine keeps it
// (`GET /api/credential`), never renewed here (the engine renews its own as it uses it), and never a
// tool's own login elsewhere on the computer. One row per service, its active sign-in's:
// - ChatGPT (`openai`, signed in): Codex's 5-hour and weekly windows, as chatgpt.com states them;
// - SuperGrok (`xai`, signed in): Grok's weekly pool;
// - GitHub Copilot: the month's premium requests (and a free plan's chat and completions);
// - OpenRouter: the key's own cap if it has one, and the credits left;
// - Z.ai's coding plan: its 5-hour and weekly windows, and web searches;
// - OpenCode Go: its rolling, weekly and monthly windows.
// Ollama's isn't read: ollama.com tells its usage only to the Ollama app's own signing key, not to the
// API key you sign in to Kuvo Code with.

import { codexCredits, codexResets, readCodexResets, spendCodexReset, type ChatGPTSignIn } from "./codex-resets"
import { chatGPTIdentity, fingerprint, LimitsProblem, retryAt, xaiIdentity, type LimitedAccount, type LimitExtra, type LimitReading, type LimitsService, type LimitWindow } from "./limits"

type Window = Omit<LimitWindow, "read" | "source">

/** A sign-in as the engine keeps it, with its secret (only ever in memory). */
interface Credential {
  integrationID: string
  active: boolean
  value: { type?: string; access?: string; refresh?: string; key?: string; expires?: number; metadata?: Record<string, unknown> }
}

/** Where each is read: its maker's, or a test's stand-in. */
export const engineEndpoints = {
  chatgpt: "https://chatgpt.com/backend-api/wham/usage",
  grok: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
  copilot: "https://api.github.com/copilot_internal/user",
  /** Your organizations, and one's billing this month: for a seat its organization pays for. */
  githubOrgs: "https://api.github.com/user/orgs?per_page=100",
  githubBilling: "https://api.github.com/orgs",
  openrouterKey: "https://openrouter.ai/api/v1/key",
  openrouterCredits: "https://openrouter.ai/api/v1/credits",
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
  opencodeGo: "https://opencode.ai/zen/go/v1/usage",
}

const EVERY = 10 * 60_000
const MONTH = 43_200

interface Reader {
  service: LimitsService
  /** Only a sign-in (OAuth) of it, not an API key, has a plan to read. */
  signIn?: boolean
  /** Read with the sign-in's lasting token (GitHub's, which the engine keeps as `refresh`; its
   * `access` is Copilot's own, short-lived), so its expiry isn't the sign-in's. */
  lasting?: boolean
  read(secret: string, credential: Credential, now: number): Promise<LimitReading>
  /** Who the sign-in is, as it says itself (`LimitsSource.identity`); else as its maker's answer says. */
  identity?(value: Credential["value"]): string | undefined
}

/** An API key is its own account here: the same key on two computers is one row. */
const byKey = (value: Credential["value"]) => (value.key?.trim() ? `key:${value.key.trim()}` : undefined)

const READERS: Record<string, Reader> = {
  openai: { service: "codex", signIn: true, read: readChatGPT, identity: (value) => chatGPTIdentity(value.access, value.metadata?.accountID) },
  xai: { service: "grok", signIn: true, read: readGrok, identity: (value) => xaiIdentity(value.access) },
  "github-copilot": { service: "copilot", lasting: true, read: readCopilot },
  openrouter: { service: "openrouter", read: readOpenRouter, identity: byKey },
  zai: { service: "zai", read: readZai, identity: byKey },
  "zai-coding-plan": { service: "zai", read: readZai, identity: byKey },
  "opencode-go": { service: "opencode", read: readOpenCodeGo, identity: byKey },
}

/** The services whose limits the engine's sign-ins are read for. */
export const ENGINE_SERVICES: LimitsService[] = [...new Set(Object.values(READERS).map((reader) => reader.service))]

/** The engine's sign-ins whose limits are read, from what it last listed. */
export class EngineAccounts {
  private credentials: Credential[] = []
  private made = new Map<string, LimitedAccount>()

  /** `credentials`: the engine's sign-ins with their secrets, as `GET /api/credential` answers. */
  constructor(private readonly credentialsNow: () => Promise<unknown>) {}

  /** The engine has listed its sign-ins once: until then, none is known gone. */
  answered = false
  /** Told the first time it has (what waited on knowing them goes on). */
  onAnswered?: () => void

  /** Asks the engine again (before each round of reads); what it said last stays when it can't say. */
  async refresh() {
    try {
      const answer: any = await this.credentialsNow()
      const list = Array.isArray(answer) ? answer : Array.isArray(answer?.data) ? answer.data : undefined
      if (list) this.credentials = list.filter((each: any) => each && typeof each.integrationID === "string" && each.active === true && each.value && typeof each.value === "object")
      if (list && !this.answered) {
        this.answered = true
        this.onAnswered?.()
      }
    } catch {}
  }

  accounts(): LimitedAccount[] {
    const accounts: LimitedAccount[] = []
    for (const credential of this.credentials) {
      const reader = READERS[credential.integrationID]
      if (!reader) continue
      if (reader.signIn && credential.value.type !== "oauth" && !credential.value.access) continue
      let account = this.made.get(credential.integrationID)
      if (!account) {
        const integration = credential.integrationID
        account = {
          provider: integration,
          service: reader.service,
          limits: {
            every: EVERY,
            read: (now) => this.read(integration, now),
            signIn: () => {
              const value = this.credentials.find((each) => each.integrationID === integration)?.value
              return fingerprint(`${value?.access ?? value?.key ?? ""}:${value?.refresh ?? ""}:${value?.expires ?? ""}`)
            },
            identity: () => {
              const value = this.credentials.find((each) => each.integrationID === integration)?.value
              return value ? READERS[integration]?.identity?.(value) : undefined
            },
            // (What lasts through a renewal: the refresh token, else the key.)
            account: () => {
              const value = this.credentials.find((each) => each.integrationID === integration)?.value
              return fingerprint(value?.refresh || value?.key || value?.access)
            },
            // ChatGPT's reset credits, spent with its sign-in here (codex-resets.ts).
            ...(integration === "openai"
              ? {
                  reset: (attempt, now) => {
                    const credential = this.credentials.find((each) => each.integrationID === integration)
                    const lapsed = credential?.value.expires !== undefined && credential.value.expires <= now
                    return spendCodexReset(lapsed ? undefined : chatGPTSignInOf(credential), attempt, now)
                  },
                }
              : {}),
          },
        }
        this.made.set(integration, account)
      }
      accounts.push(account)
    }
    return accounts
  }

  private async read(integration: string, now: number): Promise<LimitReading> {
    const credential = this.credentials.find((each) => each.integrationID === integration)
    const reader = READERS[integration]
    const secret = reader?.lasting ? credential?.value.refresh || credential?.value.key : credential?.value.access || credential?.value.key
    if (!credential || !reader || !secret) throw new LimitsProblem("none", "Not signed in here.", undefined, false)
    if (!reader.lasting && credential.value.type === "oauth" && credential.value.expires && credential.value.expires <= now) {
      throw new LimitsProblem("expired", "Its sign-in has lapsed: the engine renews it the next time a model of it runs here.")
    }
    try {
      return await reader.read(secret.trim(), credential, now)
    } catch (caught) {
      // An API key turned away isn't a sign-in its engine renews: tried again later, not held to it.
      if (caught instanceof LimitsProblem && caught.kind === "expired" && credential.value.type !== "oauth") {
        throw new LimitsProblem("failed", caught.message.replace(/the sign-in away: sign in again/, "the key away: check it"))
      }
      throw caught
    }
  }
}

/** The answer's JSON, or why it isn't one to read (a 429 held for as long as it says). */
async function fetched(url: string, headers: Record<string, string>, now: number, maker: string, refused?: (status: number, text: string) => LimitsProblem | undefined): Promise<any> {
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) })
  } catch (caught) {
    throw new LimitsProblem("failed", `Couldn't reach ${maker}: ${caught instanceof Error ? caught.message : String(caught)}`)
  }
  if (response.status === 429) throw new LimitsProblem("rate-limited", `${maker} is turning away reads of the limits for now.`, retryAt(response.headers.get("retry-after"), now))
  if (response.status === 401 || response.status === 403) {
    throw refused?.(response.status, await response.text().catch(() => "")) ?? new LimitsProblem("expired", `${maker} turned the sign-in away: sign in again in Settings › Accounts if it keeps saying so.`)
  }
  if (!response.ok) throw new LimitsProblem("failed", `${maker} answered ${response.status}.`)
  try {
    return await response.json()
  } catch {
    throw new LimitsProblem("failed", `${maker}'s answer wasn't what Kuvo Code reads.`)
  }
}

const number = (value: unknown): number | undefined => {
  const found = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof found === "number" && Number.isFinite(found) ? found : undefined
}
const date = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}
const title = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim().split(/[_\s]+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ") : undefined

/** ChatGPT's plan for Codex: its 5-hour and weekly windows, and each other limit's (Spark's). */
async function readChatGPT(secret: string, credential: Credential, now: number): Promise<LimitReading> {
  const account = credential.value.metadata?.accountID
  const body = await fetched(engineEndpoints.chatgpt, { Authorization: `Bearer ${secret}`, ...(typeof account === "string" && account ? { "ChatGPT-Account-Id": account } : {}) }, now, "ChatGPT")
  const windows = [...whamWindows(body?.rate_limit, "", undefined, now)]
  for (const extra of Array.isArray(body?.additional_rate_limits) ? body.additional_rate_limits : []) {
    const name = typeof extra?.limit_name === "string" ? extra.limit_name : typeof extra?.metered_feature === "string" ? extra.metered_feature : undefined
    if (name) windows.push(...whamWindows(extra.rate_limit, `${name}.`, name, now))
  }
  const plan = title(body?.plan_type)
  // Its credits, and its reset credits: their list (with when each expires) where there are any.
  const signIn = chatGPTSignInOf(credential)
  const embedded = body?.rate_limit_reset_credits
  const listed = signIn && Number(embedded?.available_count) > 0 ? await readCodexResets(signIn, now) : undefined
  const extras = [codexCredits(body?.credits), listed ?? codexResets(undefined, embedded, now)].filter((extra): extra is LimitExtra => !!extra)
  return { windows, ...(plan ? { plan } : {}), ...(extras.length ? { extras } : {}) }
}

/** The engine's ChatGPT sign-in, to read and spend its reset credits with. */
function chatGPTSignInOf(credential: Credential | undefined): ChatGPTSignIn | undefined {
  const token = credential?.value.access?.trim()
  if (!token) return undefined
  const account = credential!.value.metadata?.accountID
  return { token, ...(typeof account === "string" && account ? { account } : {}) }
}

function whamWindows(limit: any, prefix: string, model: string | undefined, now: number): Window[] {
  return (["primary", "secondary"] as const).flatMap((which) => {
    const window = limit?.[`${which}_window`]
    const used = number(window?.used_percent)
    if (!window || used === undefined) return []
    const seconds = number(window.limit_window_seconds)
    const resetsAt = number(window.reset_at) !== undefined ? number(window.reset_at)! * 1000 : number(window.reset_after_seconds) !== undefined ? now + number(window.reset_after_seconds)! * 1000 : undefined
    return [{ id: prefix + which, used: used / 100, ...(seconds ? { minutes: Math.round(seconds / 60) } : {}), ...(resetsAt ? { resetsAt } : {}), ...(model ? { model } : {}) }]
  })
}

/** SuperGrok's weekly pool, as the Grok CLI reads it (the engine's xAI sign-in, or the Grok agent's own). */
export async function readGrok(secret: string, _credential: unknown, now: number): Promise<LimitReading> {
  const body = await fetched(engineEndpoints.grok, { Authorization: `Bearer ${secret}`, "X-XAI-Token-Auth": "xai-grok-cli" }, now, "xAI")
  const period = body?.config?.currentPeriod
  const start = date(period?.start)
  const end = date(period?.end)
  if (!start || !end || end <= start) throw new LimitsProblem("failed", "xAI's answer wasn't what Kuvo Code reads.")
  // (Proto JSON leaves a 0 out.)
  const used = number(body.config.creditUsagePercent) ?? 0
  return { windows: [{ id: "weekly", used: used / 100, minutes: Math.round((end - start) / 60_000), resetsAt: end }] }
}

/** GitHub Copilot's month: premium requests, and a free plan's chat and completions. */
async function readCopilot(secret: string, _credential: Credential, now: number): Promise<LimitReading> {
  const body = await fetched(
    engineEndpoints.copilot,
    { Authorization: `token ${secret}`, "Editor-Version": "vscode/1.96.2", "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01" },
    now,
    "GitHub",
  )
  const resetsAt = date(body?.quota_reset_date) ?? date(body?.limited_user_reset_date)
  const windows: Window[] = []
  const snapshots = body?.quota_snapshots
  for (const [id, name] of [["premium_interactions", "Premium requests"], ["chat", "Chat"], ["completions", "Completions"]] as const) {
    const snapshot = snapshots?.[id]
    const entitlement = number(snapshot?.entitlement)
    const remaining = number(snapshot?.remaining)
    // Unlimited (GitHub's -1), or none to count.
    if (!snapshot || snapshot.unlimited === true || entitlement === -1 || remaining === -1 || !entitlement) continue
    const percentLeft = number(snapshot.percent_remaining)
    const used = percentLeft !== undefined ? 1 - percentLeft / 100 : remaining !== undefined ? 1 - remaining / entitlement : undefined
    if (used === undefined) continue
    windows.push({
      id,
      used,
      minutes: MONTH,
      ...(resetsAt ? { resetsAt } : {}),
      name,
      ...(remaining !== undefined ? { amount: { used: Math.max(0, entitlement - remaining), limit: entitlement, unit: "requests" as const } } : {}),
    })
  }
  // An older free plan's: what's left of the month's.
  if (!snapshots) {
    for (const [id, name] of [["chat", "Chat"], ["completions", "Completions"]] as const) {
      const limit = number(body?.monthly_quotas?.[id])
      const remaining = number(body?.limited_user_quotas?.[id])
      if (!limit || remaining === undefined) continue
      windows.push({ id, used: 1 - remaining / limit, minutes: MONTH, name, ...(resetsAt ? { resetsAt } : {}), amount: { used: Math.max(0, limit - remaining), limit, unit: "requests" } })
    }
  }
  const plan = title(body?.copilot_plan)
  const login = typeof body?.login === "string" && body.login.trim() ? body.login.trim().toLowerCase() : undefined
  // A seat its organization pays for by the credit (`token_based_billing`) has no meter of its own:
  // what the organization used this month, where this sign-in may read its billing.
  const extras = !windows.length && body?.token_based_billing === true ? await organizationCredits(secret, now) : undefined
  return { windows, ...(plan ? { plan } : {}), ...(extras?.length ? { extras } : {}), ...(login ? { identity: `github:${login}` } : {}) }
}

/** The organization whose billing carried Copilot's credits, by sign-in (a fingerprint): asked first. */
const billingOrgs = new Map<string, { org?: string; none?: number }>()
/** With none found, organizations are looked through again this often. */
const ORGS_AGAIN = 6 * 60 * 60_000

const githubHeaders = (secret: string) => ({ Authorization: `token ${secret}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Kuvo-Code" })

/**
 * A Copilot organization's credits and spend this month, as its billing summary says them: the
 * organization last found first, else each of yours in turn. Only an owner or a billing manager
 * may read it (anyone else is turned away, as expected), so none is usual: nothing then, never a 0.
 */
async function organizationCredits(secret: string, now: number): Promise<LimitExtra[] | undefined> {
  const key = fingerprint(secret)!
  const known = billingOrgs.get(key)
  const read = async (org: string): Promise<LimitExtra[] | null | undefined> => {
    try {
      const response = await fetch(`${engineEndpoints.githubBilling}/${encodeURIComponent(org)}/settings/billing/usage/summary`, { headers: githubHeaders(secret), signal: AbortSignal.timeout(15_000) })
      // (Turned away, or not found: not this organization's. A 429 or worse: not now.)
      if (response.status === 429 || response.status >= 500) return undefined
      if (!response.ok) return null
      return billingExtras(await response.json())
    } catch {
      return undefined
    }
  }
  if (known?.org) {
    const extras = await read(known.org)
    if (extras !== null) return extras ?? undefined
    billingOrgs.delete(key)
  } else if (known?.none && now - known.none < ORGS_AGAIN) {
    return undefined
  }
  let orgs: string[]
  try {
    const response = await fetch(engineEndpoints.githubOrgs, { headers: githubHeaders(secret), signal: AbortSignal.timeout(15_000) })
    // (A sign-in without `read:org` is turned away: nothing to look through.)
    if (!response.ok) {
      billingOrgs.set(key, { none: now })
      return undefined
    }
    const body = await response.json()
    orgs = (Array.isArray(body) ? body : []).map((each: any) => (typeof each?.login === "string" ? each.login.trim() : "")).filter(Boolean).slice(0, 30)
  } catch {
    return undefined
  }
  for (const org of orgs) {
    const extras = await read(org)
    if (!extras) continue
    billingOrgs.set(key, { org })
    return extras
  }
  billingOrgs.set(key, { none: now })
  return undefined
}

/** A billing summary's Copilot credits and what they cost beyond those included; null where it has none. */
export function billingExtras(body: any): LimitExtra[] | null {
  const items = Array.isArray(body?.usageItems) ? body.usageItems : null
  if (!items) return null
  const copilot = items.filter((item: any) => String(item?.product ?? "").trim().toLowerCase() === "copilot" && ["ai-units", "ai-credits"].includes(String(item?.unitType ?? "").trim().toLowerCase()))
  if (!copilot.length) return null
  const sum = (field: string) => copilot.reduce((total: number, item: any) => total + Math.max(0, number(item?.[field]) ?? 0), 0)
  return [
    { id: "org_credits", name: "Org Credits", kind: "spent", amount: sum("grossQuantity"), unit: "credits" },
    { id: "org_spend", name: "Org Spend", kind: "spent", amount: sum("netAmount"), unit: "usd" },
  ]
}

/** OpenRouter: the key's own cap, if it has one, and the account's credits left. */
async function readOpenRouter(secret: string, _credential: Credential, now: number): Promise<LimitReading> {
  const headers = { Authorization: `Bearer ${secret}` }
  const key = (await fetched(engineEndpoints.openrouterKey, headers, now, "OpenRouter"))?.data
  const windows: Window[] = []
  const limit = number(key?.limit)
  if (limit && limit > 0) {
    const left = Math.max(0, number(key.limit_remaining) ?? limit - (number(key.usage) ?? 0))
    windows.push({ id: "key", used: 1 - left / limit, name: "Key limit", amount: { used: limit - left, limit, unit: "usd" } })
  }
  let balance: LimitReading["balance"]
  try {
    const credits = (await fetched(engineEndpoints.openrouterCredits, headers, now, "OpenRouter"))?.data
    const total = number(credits?.total_credits)
    const spent = number(credits?.total_usage)
    // (With what was bought, so a client draws what's left of it.)
    if (total !== undefined && spent !== undefined) balance = { left: Math.max(0, total - spent), ...(total > 0 ? { limit: total } : {}), unit: "usd" }
  } catch (caught) {
    // A key that can't read the account's credits (a provisioned one) still has its own cap.
    if (!windows.length) throw caught
  }
  const plan = key?.is_free_tier === true ? "Free tier" : key?.is_free_tier === false ? "Pay as you go" : undefined
  // What the key spent today, this week and this month (OpenRouter's days, weeks and months are UTC's).
  const extras: LimitExtra[] = []
  for (const [field, id, name, ends] of [["usage_daily", "today", "Today", endOfDay], ["usage_weekly", "week", "This Week", endOfWeek], ["usage_monthly", "month", "This Month", endOfMonth]] as const) {
    const spent = number(key?.[field])
    if (spent !== undefined) extras.push({ id, name, kind: "spent", amount: Math.max(0, spent), unit: "usd", resetsAt: ends(now) })
  }
  return { windows, ...(balance ? { balance } : {}), ...(plan ? { plan } : {}), ...(extras.length ? { extras } : {}) }
}

const endOfDay = (now: number) => {
  const day = new Date(now)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1)
}
/** Its weeks start on Monday. */
const endOfWeek = (now: number) => {
  const day = new Date(now)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 7 - ((day.getUTCDay() + 6) % 7))
}
const endOfMonth = (now: number) => {
  const day = new Date(now)
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1)
}

/** Z.ai's coding plan: its windows by length, and the month's web searches. */
async function readZai(secret: string, _credential: Credential, now: number): Promise<LimitReading> {
  const root = await fetched(engineEndpoints.zai, { Authorization: `Bearer ${secret}` }, now, "Z.ai")
  if (root?.success === false && /coding plan/i.test(String(root?.msg ?? ""))) throw new LimitsProblem("none", "No coding plan on this key.")
  const limits = Array.isArray(root?.data?.limits) ? root.data.limits : Array.isArray(root?.limits) ? root.limits : undefined
  if (!limits) throw new LimitsProblem("failed", "Z.ai's answer wasn't what Kuvo Code reads.")
  const UNIT: Record<number, number> = { 3: 60, 4: 1_440, 5: 43_200, 6: 10_080 }
  const windows: Window[] = []
  for (const entry of limits) {
    const type = entry?.type ?? entry?.name
    const resetsAt = number(entry?.nextResetTime)
    if (type === "CREDIT_LIMIT" || type === "TOKENS_LIMIT") {
      const unit = UNIT[number(entry.unit) ?? 0]
      const count = number(entry.number)
      const percent = number(entry.percentage)
      if (!unit || !count || percent === undefined) continue
      const minutes = unit * count
      windows.push({ id: minutes < 1_440 ? "session" : `window_${minutes}`, used: percent / 100, minutes, ...(resetsAt ? { resetsAt } : {}) })
    } else if (type === "TIME_LIMIT") {
      const used = number(entry.currentValue)
      const limit = number(entry.usage)
      if (used === undefined || !limit) continue
      windows.push({ id: "web_search", used: used / limit, name: "Web searches", ...(resetsAt ? { resetsAt } : {}), amount: { used, limit, unit: "requests" } })
    }
  }
  return { windows }
}

/** OpenCode Go: its rolling, weekly and monthly windows. */
async function readOpenCodeGo(secret: string, _credential: Credential, now: number): Promise<LimitReading> {
  // (A key without a Go plan, or one whose plan lapsed, is turned away as an entitlement: no plan.)
  const body = await fetched(engineEndpoints.opencodeGo, { Authorization: `Bearer ${secret}` }, now, "OpenCode", (status, text) =>
    status === 403 && /EntitlementError/i.test(text) ? new LimitsProblem("none", "No OpenCode Go plan on this key.") : undefined)
  const usage = body?.usage
  if (!usage || typeof usage !== "object") throw new LimitsProblem("none", "No OpenCode Go plan on this key.")
  const windows: Window[] = []
  for (const [id, minutes] of [["rolling", 300], ["weekly", 10_080], ["monthly", MONTH]] as const) {
    const percent = number(usage[id]?.percent)
    if (percent === undefined) continue
    let resetsAt = date(usage[id].resetsAt)
    // A rolling window with nothing in it says it resets five hours from now: it hasn't started.
    if (id === "rolling" && resetsAt && resetsAt >= now + 299 * 60_000) resetsAt = undefined
    windows.push({ id, used: percent / 100, minutes, ...(resetsAt ? { resetsAt } : {}) })
  }
  return { windows, plan: "Go" }
}
