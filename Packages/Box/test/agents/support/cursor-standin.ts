// A stand-in for Cursor (cursor-api.ts asks it in place of api2.cursor.sh and cursor.com): its API
// key exchange, its dashboard's Connect calls, its website's usage pages, and its usage events, a
// page at a time, as the real ones answer. Nothing real is asked: `cursorEndpoints` point here while
// it runs, and go back when it stops.

import { cursorEndpoints } from "../../../src/agents/usage/cursor-api"

const real = { ...cursorEndpoints }

/** An access token as Cursor's look: a JWT for `sub`, lapsing at `exp` (seconds). */
export function cursorToken(sub: string, exp = 4_000_000_000): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, exp })}.signature`
}

/** One usage event as Cursor's dashboard lists it. */
export const cursorEvent = (at: number, model: string, input = 0, output = 0, cacheWrite = 0, cacheRead = 0) => ({ timestamp: String(at), model, tokenUsage: { inputTokens: input, outputTokens: output, cacheWriteTokens: cacheWrite, cacheReadTokens: cacheRead } })

export class CursorStandIn {
  readonly server: ReturnType<typeof Bun.serve>
  /** Every request, in order: its path, its body and its headers. */
  readonly asked: { path: string; body: any; headers: Headers }[] = []
  /** Each API key's user (`auth0|<user>`), and the tokens handed out for it. */
  readonly keys = new Map<string, string>()
  readonly handedOut: string[] = []
  /** What each answers (a status alone, or a body); none: a 404. */
  exchange?: number
  /** Answers to the usage read, used in turn (a status, or a body); then `usage`. */
  usageAnswers: (number | Record<string, unknown>)[] = []
  usage: Record<string, unknown> = { enabled: true, billingCycleStart: "1793491200000", billingCycleEnd: "1796083200000", planUsage: { limit: 2000, totalSpend: 500, autoPercentUsed: 20, apiPercentUsed: 5, totalPercentUsed: 25 }, spendLimitUsage: { individualLimit: 5000, individualRemaining: 4000 } }
  plan: Record<string, unknown> | number = { planInfo: { planName: "Pro" } }
  credits: Record<string, unknown> | number = { hasCreditGrants: true, totalCents: 2000, usedCents: 500 }
  stripe: Record<string, unknown> | number = { customerBalance: -300 }
  grokBot: Record<string, unknown> | number = { usagePercent: 12, hasNonZeroIncludedLimit: true, currentPeriodStart: "2026-11-10T00:00:00Z", nextResetTimestampUtc: "2026-11-17T00:00:00Z" }
  summary: Record<string, unknown> | number = 404
  requests: Record<string, unknown> | number = 404
  retryAfter?: string
  /** The usage events Cursor has, each with its time. */
  events: { timestamp: string; model: string; tokenUsage?: unknown }[] = []
  /** A page of events answered otherwise (a status), by its day's start (ms) and page. */
  failing?: (start: number, page: number) => number | undefined
  /** Events left out of a day's later pages, as though more came in between (its total grows). */
  growing?: (start: number, page: number) => number

  constructor() {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.answer(request) })
    cursorEndpoints.api2 = `http://127.0.0.1:${this.server.port}/api2`
    cursorEndpoints.web = `http://127.0.0.1:${this.server.port}/web`
  }

  stop() {
    this.server.stop(true)
    Object.assign(cursorEndpoints, real)
  }

  /** The days whose events were asked for, as `yyyy-MM-dd`, in order (a page each). */
  eventDays(): string[] {
    return this.asked.filter((each) => each.path === "/web/api/dashboard/get-filtered-usage-events").map((each) => new Date(Number(each.body.startDate)).toISOString().slice(0, 10))
  }

  private user(request: Request): string | undefined {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    const cookie = /WorkosCursorSessionToken=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1]
    const token = bearer ?? cookie?.split("%3A%3A")[1]
    return token && this.handedOut.includes(token) ? token : undefined
  }

  private async answer(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const text = await request.text()
    let body: any
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {}
    this.asked.push({ path: url.pathname, body, headers: request.headers })
    const reply = (value: Record<string, unknown> | number) => (typeof value === "number" ? new Response("{}", { status: value, headers: this.retryAfter ? { "Retry-After": this.retryAfter } : {} }) : Response.json(value))
    if (url.pathname === "/api2/auth/exchange_user_api_key") {
      if (this.exchange) return reply(this.exchange)
      const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      const sub = this.keys.get(key)
      if (!sub) return new Response("{}", { status: 401 })
      const token = cursorToken(sub, Math.floor(Date.now() / 1000) + 3600) + "." + this.handedOut.length
      this.handedOut.push(token)
      return Response.json({ accessToken: token })
    }
    if (!this.user(request)) return new Response("{}", { status: 401 })
    switch (url.pathname) {
      case "/api2/aiserver.v1.DashboardService/GetCurrentPeriodUsage": {
        const next = this.usageAnswers.shift()
        return reply(next ?? this.usage)
      }
      case "/api2/aiserver.v1.DashboardService/GetPlanInfo":
        return reply(this.plan)
      case "/api2/aiserver.v1.DashboardService/GetCreditGrantsBalance":
        return reply(this.credits)
      case "/api2/aiserver.v1.DashboardService/GetSandUsageStatus":
        return reply(this.grokBot)
      case "/web/api/auth/stripe":
        return reply(this.stripe)
      case "/web/api/usage-summary":
        return reply(this.summary)
      case "/web/api/usage":
        return reply(this.requests)
      case "/web/api/dashboard/get-filtered-usage-events": {
        const start = Number(body.startDate)
        const end = Number(body.endDate)
        const status = this.failing?.(start, body.page)
        if (status) return new Response("{}", { status })
        const day = this.events.filter((event) => Number(event.timestamp) >= start && Number(event.timestamp) <= end)
        const extra = this.growing?.(start, body.page) ?? 0
        const from = (body.page - 1) * body.pageSize
        return Response.json({ totalUsageEventsCount: day.length + extra, usageEventsDisplay: day.slice(from, from + body.pageSize) })
      }
    }
    return new Response("{}", { status: 404 })
  }
}
