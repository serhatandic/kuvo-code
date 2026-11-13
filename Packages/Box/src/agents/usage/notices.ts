// Quota notification decisions belong to the box that read the account. Clients only deliver IDs.
import { randomUUID } from "node:crypto"
import type { LimitWindow } from "../limits"
import type { NotificationSettings } from "./settings"

export type Milestone = "underTenPercent" | "healthyToClose" | "closeToRunningOut"
export type Bucket = "untracked" | "healthy" | "close" | "runningOut"
export type Meter = Bucket | "noData" | "level" | "spent"
export interface NoticeState {
  resetsAt?: number
  fired: Milestone[]
  previous: Bucket
  under: boolean
  primed: boolean
  /** Reading that established this state, for ownership handoff. */
  read?: number
}
export interface UsageNotice {
  id: string
  row: string
  service: string
  window: string
  milestone: Milestone
  at: number
  remaining: number
  resetsAt?: number
}
export const milestones: Milestone[] = ["underTenPercent", "healthyToClose", "closeToRunningOut"]
export const initialState = (): NoticeState => ({ fired: [], previous: "untracked", under: false, primed: false })
const severity = (bucket: Bucket) => ["untracked", "healthy", "close", "runningOut"].indexOf(bucket)

/** Swift PaceNotificationLogic parity. Candidates aren't committed until their facts are kept. */
export function transitions(meter: Meter, fraction: number, resetsAt: number | undefined, previous: NoticeState, toggles: NotificationSettings): { fire: Milestone[]; state: NoticeState } {
  const state = structuredClone(previous)
  if (resetsAt !== undefined && (previous.resetsAt === undefined || resetsAt - previous.resetsAt > 1000)) {
    state.fired = []
    state.under = false
    state.previous = "untracked"
  }
  state.resetsAt = resetsAt ?? previous.resetsAt
  const bucket: Bucket = meter === "spent" ? "runningOut" : meter === "noData" || meter === "level" ? "untracked" : meter
  if (meter === "noData") return { fire: [], state }
  if (!state.primed) {
    state.primed = true
    state.previous = bucket
    state.under = fraction < 0.1
    state.fired = []
    return { fire: [], state }
  }
  const fire: Milestone[] = []
  const maybe = (milestone: Milestone) => {
    if (!toggles[milestone] || state.fired.includes(milestone)) return false
    fire.push(milestone)
    return true
  }
  if (bucket !== "untracked") {
    const before = severity(state.previous), current = severity(bucket)
    let fired = false
    if (bucket === "close" && before < 2) fired = maybe("healthyToClose")
    if (current >= 3 && before < 3) fired = maybe("closeToRunningOut") || fired
    if (current < before) {
      state.fired = state.fired.filter(m => !(m === "healthyToClose" && current <= 1) && !(m === "closeToRunningOut" && current <= 2))
    }
    if (current <= before || fired) state.previous = bucket
  }
  const under = fraction < 0.1
  const crossed = under && !state.under
  const fired = crossed && maybe("underTenPercent")
  if (!under) state.fired = state.fired.filter(m => m !== "underTenPercent")
  if (!crossed || fired) state.under = under
  return { fire, state }
}

/** Same projection gates as WidgetData.meterState/Pace; unknown cadence stays level-only. */
export function meter(window: LimitWindow, now: number): Meter {
  if (!Number.isFinite(window.used)) return "noData"
  const amount = window.amount
  const remaining = amount && amount.limit > 0 ? amount.limit - amount.used : (1 - window.used) * 100
  const precision = amount ? amount.unit === "usd" ? 100 : 10 : 1
  if (Math.round(remaining * precision) <= 0) return "spent"
  if (!window.minutes || !window.resetsAt || window.used <= 0 || now >= window.resetsAt) return "level"
  const period = window.minutes * 60_000
  const elapsed = now - (window.resetsAt - period)
  if (elapsed < Math.max(60_000, period * 0.01)) return "level"
  const projected = window.used / elapsed * period
  if (projected <= 0.9) return "healthy"
  if (window.used < 0.05) return "level"
  return projected <= 1 && Math.round((1 - projected) * 100) >= 1 ? "close" : "runningOut"
}

export function newNotice(row: string, service: string, window: LimitWindow, milestone: Milestone, at: number): UsageNotice {
  return { id: `usage_${randomUUID()}`, row, service, window: window.id, milestone, at, remaining: 1 - window.used, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) }
}

/** Peer facts validated without deciding them again; IDs and decision timestamps survive every hop. */
export function takeNotices(given: unknown): UsageNotice[] {
  if (!Array.isArray(given)) return []
  return given.slice(-100).filter((n): n is UsageNotice => n && typeof n === "object" && typeof n.id === "string" && /^usage_[a-zA-Z0-9-]{1,80}$/.test(n.id) && typeof n.row === "string" && n.row.length <= 300 && typeof n.service === "string" && n.service.length <= 40 && typeof n.window === "string" && n.window.length <= 200 && milestones.includes(n.milestone) && Number.isFinite(n.at) && Number.isFinite(n.remaining) && n.remaining >= 0 && n.remaining <= 1 && (n.resetsAt === undefined || Number.isFinite(n.resetsAt)))
}

export function takeStates(given: unknown): Record<string, NoticeState> {
  if (!given || typeof given !== "object" || Array.isArray(given)) return {}
  return Object.fromEntries(Object.entries(given).slice(0, 30).flatMap(([id, value]) => {
    const s = value as NoticeState
    return s && Array.isArray(s.fired) && s.fired.every(m => milestones.includes(m)) && ["untracked", "healthy", "close", "runningOut"].includes(s.previous) && typeof s.under === "boolean" && typeof s.primed === "boolean" && (s.resetsAt === undefined || Number.isFinite(s.resetsAt)) && (s.read === undefined || Number.isFinite(s.read)) ? [[id, s]] : []
  }))
}

/** The settings meter named by each maker's window (the same mapping the native panel draws). */
export function metricID(service: string, window: LimitWindow): string {
  const id = window.id
  if (service === "codex" && /spark/i.test(window.model ?? id)) return `codex.${id.endsWith("secondary") ? "sparkWeekly" : "spark"}`
  const aliases: Record<string, Record<string, string>> = {
    claude: { five_hour: "session", seven_day: "weekly", seven_day_sonnet: "sonnet", seven_day_fable: "fable", seven_day_opus: "opus" },
    antigravity: { "gemini-5h": "geminiPro", "gemini-weekly": "geminiWeekly", "argon-weekly": "argonWeekly", "3p-5h": "claude", "3p-weekly": "claudeWeekly" },
    codex: { primary: "session", secondary: "weekly" },
    opencode: { rolling: "session" },
    copilot: { premium_interactions: "premium" },
    openrouter: { key: "keyLimit" },
    zai: { web_search: "webSearches", window_10080: "weekly" },
    cursor: { total: "usage", included: "usage", on_demand: "onDemand", grok_bot: "grokBot" },
  }
  return `${service}.${aliases[service]?.[id] ?? id}`
}
