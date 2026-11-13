// Antigravity quotas: Kuvo Code's own agent sign-in, never the editor's login or Keychain.
import { readFileSync, readdirSync, readlinkSync } from "node:fs"
import { join } from "node:path"
import { fingerprint, LimitsProblem, retryAt, tokenClaims, type LimitReading, type LimitsSource } from "../limits"
import { run } from "../proc"
import { isoTime } from "./cursor-plan"

const specs = [
  ["gemini-5h", "Session", 300], ["gemini-weekly", "Weekly", 10080],
  ["3p-5h", "Claude", 300], ["3p-weekly", "Claude Weekly", 10080],
] as const
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v.trim() : undefined
const groupsOf = (body: any): any[] | undefined => Array.isArray(body?.response?.groups) ? body.response.groups : Array.isArray(body?.groups) ? body.groups : undefined
const windowOf = (id: string, name: string, minutes: number, fraction: number, reset: unknown) => ({ id, name, minutes, used: Math.round((1 - Math.min(1, Math.max(0, fraction))) * 100) / 100, ...(isoTime(reset) !== undefined ? { resetsAt: isoTime(reset) } : {}) })

/** Faithful AntigravityUsageMapper summary merge: exact IDs, first usable wins, separate Argon. */
export function antigravitySummary(bodies: any[]): LimitReading["windows"] | undefined {
  const lists = bodies.map(groupsOf).filter((g): g is any[] => g !== undefined)
  if (!lists.length) return undefined
  const found = new Map<string, any>()
  for (const groups of lists) for (const group of groups) {
    if (group?.displayName === "Gemini 4 Argon") continue
    for (const b of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (specs.some(([id]) => id === b?.bucketId) && finite(b?.remainingFraction) && !found.has(b.bucketId)) found.set(b.bucketId, b)
    }
  }
  const windows = specs.flatMap(([id, name, minutes]) => { const b = found.get(id); return b ? [windowOf(id, name, minutes, b.remainingFraction, b.resetTime)] : [] })
  for (const groups of lists) {
    const weekly = groups.filter(g => g?.displayName === "Gemini 4 Argon").flatMap(g => Array.isArray(g?.buckets) ? g.buckets : []).filter(b => b?.window === "weekly")
    const b = weekly[0]
    if (weekly.length !== 1 || !text(b?.bucketId) || specs.some(([id]) => id === b.bucketId) || (b.disabled != null && typeof b.disabled !== "boolean") || b.disabled === true || !finite(b.remainingFraction)) continue
    const index = windows.findIndex(w => w.id === "3p-5h" || w.id === "3p-weekly")
    windows.splice(index < 0 ? windows.length : index, 0, windowOf("argon-weekly", "Argon Weekly", 10080, b.remainingFraction, b.resetTime))
    break
  }
  return windows
}
export function antigravityPlanName(raw: unknown): string | undefined {
  const name = text(raw)
  if (!name) return undefined
  if (name.startsWith("Google AI ")) return name.slice(10).split(/\s+/).map(w => w[0]!.toUpperCase() + w.slice(1)).join(" ")
  for (const word of ["Ultra", "Pro", "Free"]) if (name.toLowerCase().includes(word.toLowerCase())) return word
  return name.split(/\s+/).map(w => w[0]!.toUpperCase() + w.slice(1)).join(" ")
}
const blacklist = new Set(["MODEL_CHAT_20706", "MODEL_CHAT_23310", "MODEL_GOOGLE_GEMINI_2_5_FLASH", "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING", "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE", "MODEL_GOOGLE_GEMINI_2_5_PRO", "MODEL_PLACEHOLDER_M19", "MODEL_PLACEHOLDER_M9", "MODEL_PLACEHOLDER_M12"])
/** Legacy per-model pooling (missing quota means depleted, as in the Swift mapper). */
export function antigravityLegacy(configs: any[]): LimitReading["windows"] {
  const pools = new Map<string, any>()
  for (const c of configs) {
    const label = text(c?.label ?? c?.displayName)
    const id = text(c?.modelOrAlias?.model ?? c?.model ?? c?.modelID)
    if (!label || c.isInternal === true || blacklist.has(id ?? "") || id === "MODEL_PLACEHOLDER_M421" || [label, id ?? ""].some(s => /^gemini-4-argon(?:-|$)/.test(s.toLowerCase().replaceAll(" ", "-")))) continue
    const pool = label.toLowerCase().includes("gemini") ? "gemini-5h" : "3p-5h"
    const b = { remainingFraction: finite(c.quotaInfo?.remainingFraction) ? c.quotaInfo.remainingFraction : 0, resetTime: c.quotaInfo?.resetTime }
    if (!pools.has(pool) || b.remainingFraction < pools.get(pool).remainingFraction) pools.set(pool, b)
  }
  return specs.filter(([, , minutes]) => minutes === 300).flatMap(([id, name, minutes]) => { const b = pools.get(id); return b ? [windowOf(id, name, minutes, b.remainingFraction, b.resetTime)] : [] })
}

export interface AntigravityEndpoint { scheme: "http" | "https"; port: number; csrf: string }
export const flagValue = (argv: string[], flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith(flag + "="))?.slice(flag.length + 1) }
const port = (s: string | undefined) => s && /^\d+$/.test(s) && +s > 0 && +s < 65536 ? +s : undefined
/** Linux /proc/net/tcp[6]: use only this process's listening socket inodes. */
export function antigravityProcPorts(tables: string[], inodes: Set<string>): number[] {
  const ports = new Set<number>()
  for (const table of tables) for (const line of table.split("\n")) {
    const cols = line.trim().split(/\s+/)
    if (cols[3] !== "0A" || !inodes.has(cols[9] ?? "")) continue
    const found = parseInt(cols[1]?.split(":")[1] ?? "", 16)
    if (found > 0 && found < 65536) ports.add(found)
  }
  return [...ports].sort((a, b) => a - b)
}
export function antigravityEndpoints(argv: string[], ports: number[]): AntigravityEndpoint[] {
  const csrf = flagValue(argv, "--csrf_token")
  if (!csrf) return []
  const endpoints = ports.flatMap(p => [{ scheme: "https" as const, port: p, csrf }, { scheme: "http" as const, port: p, csrf }])
  const extension = port(flagValue(argv, "--extension_server_port"))
  if (extension) endpoints.push({ scheme: "http", port: extension, csrf })
  return endpoints
}
/** Never adopt an editor's server: require this account's GEMINI_HOME or its explicit profile flag. */
export async function discoverAntigravity(profile: string, platform = process.platform, procRoot = "/proc", runner = run): Promise<AntigravityEndpoint[]> {
  if (platform === "linux") {
    let names: string[]
    try { names = readdirSync(procRoot) } catch { return [] }
    for (const pid of names.filter(n => /^\d+$/.test(n))) {
      try {
        const argv = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean)
        if (!argv[0]?.includes("language_server") && !argv[0]?.endsWith("/agy")) continue
        const env = readFileSync(join(procRoot, pid, "environ"), "utf8").split("\0")
        if (!env.includes(`GEMINI_HOME=${profile}`) && flagValue(argv, "--app_data_dir") !== profile) continue
        const inodes = new Set(readdirSync(join(procRoot, pid, "fd")).flatMap(fd => { try { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(procRoot, pid, "fd", fd))); return m ? [m[1]!] : [] } catch { return [] } }))
        const tables = ["tcp", "tcp6"].flatMap(name => { try { return [readFileSync(join(procRoot, pid, "net", name), "utf8")] } catch { return [] } })
        const endpoints = antigravityEndpoints(argv, antigravityProcPorts(tables, inodes))
        if (endpoints.length) return endpoints
      } catch {}
    }
    return []
  }
  if (platform !== "darwin") return []
  const ps = await runner("/bin/ps", ["axeww", "-o", "pid=,command="], { timeout: 5000 })
  if (ps.code) return []
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || !/language_server|\/agy\b/.test(match[2]!)) continue
    const argv = match[2]!.split(/\s+/)
    if (!argv.includes(`GEMINI_HOME=${profile}`) && flagValue(argv, "--app_data_dir") !== profile) continue
    const result = await runner("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", match[1]!], { timeout: 5000 })
    const ports = [...new Set(result.stdout.split("\n").filter(l => l.includes("LISTEN")).flatMap(l => { const p = port(/:(\d+)\s+\(LISTEN\)/.exec(l)?.[1]); return p ? [p] : [] }))].sort((a,b) => a-b)
    const endpoints = antigravityEndpoints(argv, ports)
    if (endpoints.length) return endpoints
  }
  return []
}

interface Credential { access?: string; refresh?: string; expires?: number; identity?: string; clientID?: string; clientSecret?: string }
export function antigravityCredential(raw: any): Credential | undefined {
  const source = raw?.token && typeof raw.token === "object" ? raw.token : raw
  const access = text(source?.access_token ?? source?.accessToken)
  const refresh = text(source?.refresh_token ?? source?.refreshToken)
  if (!access && !refresh) return undefined
  const claims = tokenClaims(source?.id_token ?? source?.idToken) ?? tokenClaims(access)
  return { access, refresh, identity: text(claims?.sub) ? `google:${claims!.sub}` : undefined, expires: finite(source?.expires_at) ? source.expires_at * 1000 : isoTime(source?.expiry ?? source?.expiresAt), clientID: text(source?.client_id), clientSecret: text(source?.client_secret) }
}
export type AntigravityFetch = (url: string, init: RequestInit & { tls?: { rejectUnauthorized: boolean } }) => Promise<Response>
/** Enabled only by main.ts in a real box folder; test constructors supply stand-in bases. */
export const antigravityTransport = { live: false }
const productionBases = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"]
export class AntigravityPlan {
  private denied = new Set<string>()
  private deniedAccess = new Set<string>()
  private deniedCSRF = new Set<string>()
  private access?: { credential: string; token: string; expires: number }
  readonly limits: LimitsSource
  constructor(readonly profile: () => string, private readonly fetcher: AntigravityFetch = (url, init) => fetch(url, init), private readonly discover = discoverAntigravity, private readonly bases = productionBases, private readonly oauth = "https://oauth2.googleapis.com/token") {
    this.limits = { every: 10 * 60_000, bucket: "antigravity", read: now => this.read(now), signIn: () => this.signIn(), account: () => this.account(), identity: () => this.credential()?.identity }
  }
  private raw(): string | undefined { if (!antigravityTransport.live && this.bases === productionBases) return undefined; try { return readFileSync(join(this.profile(), "antigravity-acp", "acp_token.json"), "utf8") } catch (e: any) { if (e?.code === "ENOENT") return undefined; throw new LimitsProblem("failed", "Antigravity's own sign-in cannot be read here.", undefined, false) } }
  private credential() { try { return antigravityCredential(JSON.parse(this.raw() ?? "null")) } catch { return undefined } }
  signIn() { try { return fingerprint(this.raw()) } catch { return "unreadable" } }
  account() { const c = this.credential(); return fingerprint(c?.refresh ?? c?.access) }
  private async request(url: string, init: RequestInit & { tls?: { rejectUnauthorized: boolean } }, now: number, allowMissing = false): Promise<any> {
    let response: Response
    try { response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) }) } catch { throw new LimitsProblem("failed", "Antigravity's quota service is unavailable.") }
    if (allowMissing && response.status === 404) return undefined
    if (url === this.oauth && response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new LimitsProblem("expired", "Antigravity refused this refresh token. Sign in again.")
    if (response.status === 429) throw new LimitsProblem("rate-limited", "Antigravity asked this computer to wait.", retryAt(response.headers.get("retry-after"), now))
    if (response.status === 401 || response.status === 403) throw new LimitsProblem("expired", "Antigravity refused this sign-in. Sign in again.")
    if (!response.ok) throw new LimitsProblem("failed", `Antigravity quota service returned HTTP ${response.status}.`)
    try { return await response.json() } catch { throw new LimitsProblem("failed", "Antigravity returned an unreadable quota response.") }
  }
  private async read(now: number): Promise<LimitReading> {
    if (!antigravityTransport.live && this.bases === productionBases) return Promise.reject(new LimitsProblem("failed", "Antigravity quotas are disabled outside a real box folder.", undefined, false))
    const raw = this.raw()
    if (!raw) throw new LimitsProblem("none", "Sign in to Antigravity in Kuvo Code.", undefined, false)
    let c: Credential | undefined
    try { c = antigravityCredential(JSON.parse(raw)) } catch {}
    if (!c) throw new LimitsProblem("failed", "Antigravity's own sign-in is unreadable.", undefined, false)
    const signIn = fingerprint(c.refresh ?? c.access)!
    if (this.denied.has(signIn)) throw new LimitsProblem("expired", "Antigravity refused this sign-in. Sign in again.", undefined, false)
    try {
      // Own-account local LS is useful while the agent is running. Its certificate exception is
      // scoped to the literal loopback URL; remote calls always retain TLS verification.
      const endpoints = await this.discover(this.profile())
      for (const e of endpoints) {
        if (this.deniedCSRF.has(fingerprint(e.csrf)!)) continue
        const call = (method: string) => this.request(`${e.scheme}://127.0.0.1:${e.port}/exa.language_server_pb.LanguageServerService/${method}`, { method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", "x-codeium-csrf-token": e.csrf }, body: JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" } }), ...(e.scheme === "https" ? { tls: { rejectUnauthorized: false } } : {}) }, now, true)
        let summary: any
        try { summary = await call("RetrieveUserQuotaSummary") } catch (error) { if (error instanceof LimitsProblem && error.kind === "rate-limited") throw error; if (error instanceof LimitsProblem && error.kind === "expired") this.deniedCSRF.add(fingerprint(e.csrf)!); continue }
        const windows = antigravitySummary([summary])
        if (windows !== undefined) {
          if (!windows.length) throw new LimitsProblem("failed", "Antigravity's quota summary has no readable buckets.")
          let plan: string | undefined
          try { const status = await call("GetUserStatus"); plan = antigravityPlanName(status?.userStatus?.userTier?.name ?? status?.userStatus?.planStatus?.planInfo?.planName) } catch (error) { if (error instanceof LimitsProblem && error.kind === "rate-limited") throw error; if (error instanceof LimitsProblem && error.kind === "expired") this.deniedCSRF.add(fingerprint(e.csrf)!) }
          return { windows, plan, partial: windows.filter(w => w.id !== "argon-weekly").length < 4, identity: c.identity }
        }
        try {
          const status = await call("GetUserStatus")
          let legacy = antigravityLegacy(status?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [])
          if (!legacy.length) { const configs = await call("GetCommandModelConfigs"); legacy = antigravityLegacy(configs?.clientModelConfigs ?? []) }
          if (legacy.length) return { windows: legacy, partial: true, plan: antigravityPlanName(status?.userStatus?.userTier?.name ?? status?.userStatus?.planStatus?.planInfo?.planName), identity: c.identity }
        } catch (error) { if (error instanceof LimitsProblem && error.kind === "rate-limited") throw error; if (error instanceof LimitsProblem && error.kind === "expired") this.deniedCSRF.add(fingerprint(e.csrf)!) }
      }
      const cached = this.access && this.access.credential === this.account() && this.access.expires > now + 60_000 ? this.access : undefined
      let access = cached?.token ?? c.access
      if (access && this.deniedAccess.has(fingerprint(access)!)) access = undefined
      if ((!access || (!cached && c.expires !== undefined && c.expires <= now + 60_000)) && c.refresh) {
        const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientID ?? "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: c.clientSecret ?? "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" })
        const refreshed = await this.request(this.oauth, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, now)
        access = text(refreshed.access_token)
        if (!access) throw new LimitsProblem("failed", "Antigravity token refresh returned no access token.")
        this.access = { credential: this.account()!, token: access, expires: now + (finite(refreshed.expires_in) ? refreshed.expires_in : 3600) * 1000 }
      }
      if (!access) throw new LimitsProblem("failed", "Antigravity's language server isn't available on this computer and its sign-in has no usable access token.", undefined, false)
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${access}`, "User-Agent": `antigravity/2.24.0 (aidev_client; os_type=${process.platform}; arch=${process.arch === "arm64" ? "arm64" : "amd64"})` }
      const cloudRequest = async (url: string, body: any) => {
        try { return await this.request(url, { method: "POST", headers, body: JSON.stringify(body) }, now) }
        catch (error) {
          if (!(error instanceof LimitsProblem) || error.kind !== "expired") throw error
          this.deniedAccess.add(fingerprint(access)!)
          if (!c.refresh || this.denied.has(fingerprint(c.refresh)!)) throw error
          const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientID ?? "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: c.clientSecret ?? "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" })
          const refreshed = await this.request(this.oauth, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() }, now)
          const token = text(refreshed.access_token)
          if (!token || this.deniedAccess.has(fingerprint(token)!)) throw new LimitsProblem("expired", "Antigravity did not renew its refused access token.", undefined, false)
          access = token
          this.access = { credential: this.account()!, token, expires: now + (finite(refreshed.expires_in) ? refreshed.expires_in : 3600) * 1000 }
          headers.Authorization = `Bearer ${token}`
          try { return await this.request(url, { method: "POST", headers, body: JSON.stringify(body) }, now) }
          catch (second) { if (second instanceof LimitsProblem && second.kind === "expired") this.deniedAccess.add(fingerprint(token)!); throw second }
        }
      }
      const call = async (path: string, body: any) => {
        let last: unknown
        for (const base of this.bases) { try { return await cloudRequest(base + path, body) } catch (e) { if (e instanceof LimitsProblem && ["expired", "rate-limited"].includes(e.kind)) throw e; last = e } }
        throw last
      }
      const summaries: any[] = []
      for (const base of this.bases) {
        try { summaries.push(await cloudRequest(base + "/v1internal:retrieveUserQuotaSummary", {})) } catch (e) { if (e instanceof LimitsProblem && ["expired", "rate-limited"].includes(e.kind)) throw e }
        if (antigravitySummary(summaries)?.filter(w => w.id !== "argon-weekly").length === 4) break
      }
      let windows = antigravitySummary(summaries)
      if (windows === undefined) {
        try {
          const models = await call("/v1internal:fetchAvailableModels", {})
          windows = antigravityLegacy(Object.entries(models?.models ?? {}).map(([id, value]: [string, any]) => ({ ...value, modelID: value?.model ?? id })))
        } catch (error) { if (error instanceof LimitsProblem && ["expired", "rate-limited"].includes(error.kind)) throw error }
        if (!windows?.length) {
          const status = await call("/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } })
          let quota = await call("/v1internal:retrieveUserQuota", text(status?.cloudaicompanionProject) ? { project: status.cloudaicompanionProject } : {})
          if (!(quota?.buckets?.length) && status?.cloudaicompanionProject) quota = await call("/v1internal:retrieveUserQuota", {})
          windows = antigravityLegacy((Array.isArray(quota?.buckets) ? quota.buckets : []).filter((b: any) => text(b?.modelId)).map((b: any) => ({ label: b.modelId, modelID: b.modelId, quotaInfo: b })))
        }
      }
      if (!windows?.length) throw new LimitsProblem("failed", "Antigravity's quota response has no readable buckets; the last reading is kept.")
      let plan: string | undefined
      try { const status = await call("/v1internal:loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }); plan = ({ "g1-pro-tier": "Pro", "g1-ultra-tier": "Ultra", "g1-ultra-lite-tier": "Ultra Lite" } as Record<string, string>)[status?.paidTier?.id] ?? antigravityPlanName(status?.paidTier?.name ?? status?.currentTier?.name) } catch (e) { if (e instanceof LimitsProblem && ["expired", "rate-limited"].includes(e.kind)) throw e }
      return { windows, plan, partial: windows.filter(w => w.id !== "argon-weekly").length < 4, identity: c.identity }
    } catch (e) { if (e instanceof LimitsProblem && e.kind === "expired") this.denied.add(signIn); throw e }
  }
}
