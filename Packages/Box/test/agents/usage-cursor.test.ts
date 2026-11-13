// Cursor's plan limits and usage history as the box states them (`api/kuvo/limits`,
// `api/kuvo/usage`, PROTOCOL.md "Plan limits" and "Usage history"), asked of Cursor with Kuvo Code's
// own Cursor sign-in: the plan's meters, its credits, and what the account used, a UTC day at a time,
// page after page. The same fixtures as UsageKit's `UsageBoxParityCursorTests`. Cursor is a stand-in
// (support/cursor-standin.ts): no real sign-in is read, and Cursor itself is never asked.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CursorAgent } from "../../src/agents/agents/cursor"
import type { Agent } from "../../src/agents/agent"
import { agentAccounts, identityOf, Limits, limitsRoutes, type LimitsSource } from "../../src/agents/limits"
import { cursorReachable } from "../../src/agents/usage/cursor-api"
import { CURSOR_DAYS, CursorHistory, cursorEventsPage, cursorSlots } from "../../src/agents/usage/cursor-history"
import * as plan from "../../src/agents/usage/cursor-plan"
import { daysIn, SLOT, type Slots } from "../../src/agents/usage/history"
import { catalogFromCompact, Pricing, supplementFrom, type PricingStore } from "../../src/agents/usage/pricing"
import { cursorSources, Usage, usageRoutes, usageRows, type OwnUsage } from "../../src/agents/usage/usage"
import { UsagePeers } from "../../src/agents/usage/usage-peers"
import { cursorEvent, CursorStandIn } from "./support/cursor-standin"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-usage-cursor-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const fixtures = join(import.meta.dir, "..", "fixtures", "usage")
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"))
const cursorPricing = () => new Pricing(supplementFrom(fixture("pricing-cursor-supplement.json")), catalogFromCompact(fixture("pricing-cursor-litellm.json")), catalogFromCompact(fixture("pricing-cursor-models-dev.json")))
const store = (pricing: Pricing) => ({ current: () => pricing }) as unknown as PricingStore
const DAY = 24 * 60 * 60_000

// --- Parity with UsageKit ---

/** A line as the expected file keeps it. */
const lineOf = (line: plan.CursorLine) => (line.kind === "dollars" ? { label: line.label, dollars: line.amount } : { label: line.label, used: line.used, limit: line.limit, format: line.format === "count" ? `count:${line.suffix}` : line.format, resetsAt: line.resetsAt ?? null, periodMs: line.periodMs ?? null })
const mappedOf = (run: () => plan.CursorMapped) => {
  try {
    const mapped = run()
    return { plan: mapped.plan ?? null, lines: mapped.lines.map(lineOf) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}
const or = <T>(value: T | null) => value ?? undefined

describe("as UsageKit reads Cursor", () => {
  for (const each of fixture("cursor-plan-cases.json").cases as { name: string; fn: string; args: any; expected: any }[]) {
    test(`${each.fn}: ${each.name}`, () => {
      const a = each.args
      let got: unknown
      switch (each.fn) {
        case "mapUsage":
          got = mappedOf(() => plan.mapUsage(a.usage, or(a.planName), or(a.creditGrants), a.stripeBalanceCents))
          break
        case "mapRequestBasedUsage":
          got = mappedOf(() => plan.mapRequestBasedUsage(or(a.usage), or(a.planName), a.unavailable))
          break
        case "mapSummary":
          got = mappedOf(() => plan.mapSummary(or(a.summary), or(a.requestUsage), or(a.planName), a.unavailable))
          break
        case "grokBot": {
          const line = plan.grokBotLine(a.usage)
          got = { line: line ? lineOf(line) : null }
          break
        }
        case "fallback":
          got = { message: plan.requestBasedFallback(a.usage, or(a.planName), a.planInfoUnavailable) ?? null }
          break
        case "appendMissingOnDemand": {
          const lines: plan.CursorLine[] = []
          plan.appendMissingOnDemand(a.summary, lines)
          got = { lines: lines.map(lineOf) }
          break
        }
        case "reading": {
          const reading = plan.readingOf(plan.mapUsage(a.usage, or(a.planName), or(a.creditGrants), a.stripeBalanceCents), undefined)
          got = { plan: reading.plan ?? null, windows: reading.windows.map((window) => ({ id: window.id, name: window.name, used: window.used, amount: window.amount ?? null })), balance: reading.balance ?? null, extras: reading.extras ?? [] }
          break
        }
        case "planNames":
          got = { names: a.pairs.map(([name, membership]: [string | null, string | null]) => ({ routing: plan.routingPlanName(or(name), or(membership)) ?? null, resolved: plan.resolvedPlanName(or(name), or(membership)) ?? null, label: plan.resolvedPlanLabel(or(name), or(membership)) ?? null, preferred: plan.preferredMembership(or(membership), or(name)) ?? null })) }
          break
      }
      expect(got).toEqual(each.expected)
    })
  }

  test("usage events: each page's events, its total and those it couldn't read; by the day, priced without long-context rates, by family (UsageKit's CursorUsageEvents and appendSpendLines)", () => {
    const expected = fixture("cursor-events-expected.json")
    const pages = (fixture("cursor-events.json").pages as unknown[]).map((page) => cursorEventsPage(page)!)
    expect(pages.map((page) => ({ events: page.events.length, rejected: page.rejected, total: page.total }))).toEqual(expected.pages)
    const uses = pages.flatMap((page) => page.events.map((event) => [Math.floor(event.at / SLOT), event.model, event.tokens.input, event.tokens.output, event.tokens.cacheWrite5m, event.tokens.cacheRead] as [number, string, number, number, number, number]))
    const pricing = cursorPricing()
    const days = daysIn(cursorSlots([{ complete: true, uses }], pricing, Date.parse(expected.since)), "UTC", Date.parse(expected.now))
    expect(days.map((day) => day.date)).toEqual(expected.days.map((day: any) => day.date))
    days.forEach((day, at) => {
      const want = expected.days[at]
      expect(day.tokens).toBe(want.tokens)
      expect(day.cost).toBeCloseTo(want.cost, 9)
      expect(day.unknown).toEqual(want.unknown)
      expect(day.models.map((model) => [model.model, model.tokens, pricing.familyName(model.model, ["-fast"])])).toEqual(want.models.map((model: any) => [model.model, model.tokens, model.family]))
      day.models.forEach((model, index) => expect(model.cost).toBeCloseTo(want.models[index].cost, 9))
    })
  })

  test("a page that isn't one, or an event that isn't, as UsageKit takes them", () => {
    expect(cursorEventsPage({ usageEventsDisplay: [] })).toBeUndefined()
    expect(cursorEventsPage([])).toBeUndefined()
    expect(cursorEventsPage({ totalUsageEventsCount: "1", usageEventsDisplay: [] })).toBeUndefined()
    const page = cursorEventsPage({ totalUsageEventsCount: 3, usageEventsDisplay: [{ timestamp: 1_800_000_001_234, model: " \n" }, { timestamp: true, model: "a" }, { timestamp: "12", model: 3 }] })!
    expect(page.events).toEqual([{ at: 1_800_000_001_234, model: "", tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 } }])
    expect(page.rejected).toBe(2)
  })
})

// --- Against a stand-in Cursor ---

let cursor: CursorStandIn
let now: number
beforeEach(() => {
  delete process.env.CURSOR_API_KEY
  cursor = new CursorStandIn()
  now = Date.parse("2026-11-12T15:00:00Z")
})
afterEach(() => cursor.stop())

/** A Cursor account you added here, signed in with `key` (its folder's `auth.json`, as the agent's SDK writes it). */
function account(key: string | undefined, id = "work", extra: Record<string, unknown> = {}): CursorAgent {
  const home = mkdtempSync(join(base, "box-"))
  const folder = join(home, "cursor", "accounts", id)
  mkdirSync(folder, { recursive: true })
  if (key !== undefined) writeFileSync(join(folder, "auth.json"), JSON.stringify({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: key, createdAtMs: 1, ...extra }))
  return new CursorAgent({ home, temporary: home, deps: { ensure: async () => home, load: async () => ({}) } } as any, { id, home: folder, label: "Work" })
}

const limitsOf = (agents: Agent[]) => new Limits(() => agentAccounts(agents), undefined, () => now)

describe("Cursor's plan limits", () => {
  test("its meters, its credits and its plan, read with its own sign-in; who it is from Cursor's answer, only as a hash", async () => {
    cursor.keys.set("key_work", "auth0|user_Abc")
    const agent = account("key_work")
    const limits = limitsOf([agent as unknown as Agent])
    const data = ((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data
    expect(data.services).toEqual(["cursor"])
    const [row] = data.accounts
    expect(row).toMatchObject({ provider: "cursor@work", service: "cursor", agent: "cursor", account: "work", label: "Work", plan: "Pro", identity: identityOf("cursor:user_abc"), balance: { left: 18, unit: "usd" } })
    expect(row.windows.map((window: any) => [window.id, window.name, window.used, window.minutes, window.amount ?? null])).toEqual([
      ["total", "Total usage", 0.25, 43_200, null],
      ["auto", "Cursor Models", 0.2, 43_200, null],
      ["api", "Other Models", 0.05, 43_200, null],
      ["on_demand", "On-demand", 0.2, undefined, { used: 10, limit: 50, unit: "usd" }],
      ["grok_bot", "Grok Bot usage", 0.12, 10_080, null],
    ])
    expect(row.windows[0].resetsAt).toBe(1_796_083_200_000)
    expect(JSON.stringify(data)).not.toContain("user_abc")
    expect(JSON.stringify(data)).not.toContain("key_work")
    // The key, only to the exchange; the token, to the rest.
    expect(cursor.asked[0]).toMatchObject({ path: "/api2/auth/exchange_user_api_key" })
    expect(cursor.asked[0]!.headers.get("authorization")).toBe("Bearer key_work")
    expect(cursor.asked.slice(1).every((each) => !(each.headers.get("authorization") ?? "").includes("key_work"))).toBe(true)
  })

  test("its token is kept while it lasts, and exchanged again once when Cursor turns it away", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    const agent = account("key_work")
    await agent.limits.read!(now)
    await agent.limits.read!(now)
    expect(cursor.asked.filter((each) => each.path.endsWith("exchange_user_api_key"))).toHaveLength(1)
    cursor.usageAnswers = [401]
    const reading = await agent.limits.read!(now)
    expect(reading?.windows.length).toBeGreaterThan(0)
    expect(cursor.asked.filter((each) => each.path.endsWith("exchange_user_api_key"))).toHaveLength(2)
  })

  test("a key Cursor turns away is a sign-in to renew; a 429 holds off as long as it says; no sign-in, no row", async () => {
    const turnedAway = account("key_gone")
    await expect(turnedAway.limits.read!(now)).rejects.toMatchObject({ kind: "expired" })
    cursor.keys.set("key_work", "auth0|user_abc")
    const busy = account("key_work")
    cursor.usageAnswers = [429]
    cursor.retryAfter = "120"
    const held = busy.limits.read!(now)
    await expect(held).rejects.toMatchObject({ kind: "rate-limited" })
    expect(((await held.catch((error) => error)) as any).until).toBeGreaterThan(Date.now())
    await expect(account(undefined).limits.read!(now)).rejects.toMatchObject({ kind: "none", sent: false })
    // (A sign-in that lapsed is no sign-in.)
    await expect(account("key_work", "old", { apiKeyExpiresAtMs: 1 }).limits.read!(now)).rejects.toMatchObject({ kind: "none" })
  })

  test("an on-demand spend with no cap: no window, but what the plan has beyond them (`extras`), on its row across your computers", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.usage = { enabled: true, planUsage: { limit: 2000, totalSpend: 2000 }, spendLimitUsage: { totalSpend: 4321 } }
    const limits = limitsOf([account("key_work") as unknown as Agent])
    const data = ((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data
    const extras = [{ id: "on_demand", name: "On-demand", kind: "spent", amount: 43.21, unit: "usd" }]
    expect(data.accounts[0].windows.map((window: any) => window.id)).toEqual(["total", "grok_bot"])
    expect(data.accounts[0].extras).toEqual(extras)
    expect(data.rows[0].extras).toEqual(extras)
    // Read again with the cap back: what it had beyond its windows goes.
    cursor.usage = { enabled: true, planUsage: { limit: 2000, totalSpend: 2000 }, spendLimitUsage: { individualLimit: 5000, individualRemaining: 4000 } }
    now += 11 * 60_000
    const again = ((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data
    expect(again.accounts[0].extras).toBeUndefined()
  })

  test("a sign-in file that can't be read just now keeps the plan's numbers (tried again soon), not a sign-out", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    const agent = account("key_work")
    const limits = limitsOf([agent as unknown as Agent])
    await limits.refresh()
    writeFileSync(join(agent.folder, "auth.json"), '{"apiKey": "key_wo')
    now += 11 * 60_000
    await limits.refresh()
    const [row] = limits.list()
    expect(row!.windows.map((window) => window.id)).toContain("total")
    expect(row!.problem).toMatchObject({ kind: "failed" })
  })

  test("a request-based plan: its requests as its total, said once; the summary's on-demand", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.usage = { enabled: true, planUsage: {} }
    cursor.plan = { planInfo: { planName: "Enterprise" } }
    cursor.summary = { billingCycleStart: "2026-11-01T00:00:00Z", billingCycleEnd: "2026-12-01T00:00:00Z", individualUsage: { onDemand: { limit: 10000, used: 2500 } } }
    cursor.requests = { "gpt-4": { numRequests: 120, maxRequestUsage: 500 }, startOfMonth: "2026-11-01T00:00:00Z" }
    const reading = (await account("key_work").limits.read!(now))!
    expect(reading.plan).toBe("Enterprise")
    expect(reading.windows.map((window) => [window.id, window.amount])).toEqual([
      ["total", { used: 120, limit: 500, unit: "requests" }],
      ["on_demand", { used: 25, limit: 100, unit: "usd" }],
      ["grok_bot", undefined],
    ])
    expect(cursor.asked.find((each) => each.path === "/web/api/usage")!.headers.get("cookie")).toContain("WorkosCursorSessionToken=user_abc%3A%3A")
  })

  test("a test's box never asks Cursor itself, whatever sign-in its folder holds", async () => {
    cursor.stop()
    expect(cursorReachable()).toBe(false)
    await expect(account("key_work").limits.read!(now)).rejects.toMatchObject({ kind: "none", sent: false })
    expect(cursorSources(undefined, () => false)([account("key_work") as unknown as Agent])).toEqual([])
    cursor = new CursorStandIn()
  })
})

// --- Its usage history ---

/** Events on each of the 32 UTC days to now, `perDay` a day, the newest last. */
function eventsEachDay(perDay = 3) {
  const today = Math.floor(now / DAY) * DAY
  const events = []
  for (let back = 0; back < CURSOR_DAYS; back++) {
    for (let at = 0; at < perDay; at++) {
      const time = today - back * DAY + (at + 1) * 60 * 60_000
      if (time < now) events.push(cursorEvent(time, at === 0 ? "composer-2" : "gpt-6-high-fast", 1000, 100))
    }
  }
  return events
}

const instant = () => ({ done: new Promise<void>(() => {}), cancel() {} })

describe("Cursor's usage history", () => {
  test("filled in a UTC day at a time, page after page; then only today and yesterday asked again, and a day Cursor didn't answer whole", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay()
    const agent = account("key_work")
    const folder = mkdtempSync(join(base, "history-"))
    const history = new CursorHistory(folder, { deadline: instant, pageSize: 2, log: () => {} })
    const days = await history.read(agent.cursor, now)
    expect(days.size).toBe(CURSOR_DAYS)
    expect([...days.keys()][0]).toBe("2026-11-12")
    expect(days.get("2026-11-12")!.complete).toBe(false)
    expect(days.get("2026-11-11")!.complete).toBe(true)
    // Three events a day, two to a page: two pages a day.
    expect(cursor.eventDays().length).toBe(CURSOR_DAYS * 2)
    const slots = cursorSlots(days.values(), cursorPricing(), 0)
    expect([...slots.used.values()].reduce((sum, models) => sum + models.size, 0)).toBe(cursor.events.length)
    // Kept on disk, by a hash of the user: not their ID.
    const kept = readdirSync(folder)
    expect(kept).toHaveLength(1)
    expect(kept[0]).not.toContain("user_abc")
    expect(readFileSync(join(folder, kept[0]!), "utf8")).not.toContain("user_abc")

    // A new history (a restart): what's whole comes from disk.
    cursor.asked.length = 0
    now += 60 * 60_000
    const again = await new CursorHistory(folder, { deadline: instant, pageSize: 2, log: () => {} }).read(agent.cursor, now)
    expect(again.size).toBe(CURSOR_DAYS)
    expect(new Set(cursor.eventDays())).toEqual(new Set(["2026-11-12", "2026-11-11"]))
  })

  test("a day whose later page fails, or whose total moved, keeps what was known of it; one never known can't be had, so the read fails rather than say nothing was used", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay()
    const agent = account("key_work")
    const folder = mkdtempSync(join(base, "history-"))
    const history = new CursorHistory(folder, { deadline: instant, pageSize: 2, log: () => {} })
    const before = await history.read(agent.cursor, now)
    // Asked again within the minute (a refresh, a peer's): what was just read stands, nothing asked.
    const asked = cursor.asked.length
    expect(await history.read(agent.cursor, now + 30_000)).toBe(before)
    expect(cursor.asked).toHaveLength(asked)
    now += 2 * 60_000
    const yesterday = Date.parse("2026-11-11T00:00:00Z")
    // More came in yesterday while it was asked (its total moved): not whole, so as known.
    cursor.events.push(cursorEvent(yesterday + 20 * 60 * 60_000, "composer-2", 5_000_000, 0))
    cursor.growing = (start, page) => (start === yesterday && page === 2 ? 1 : 0)
    const kept = await history.read(agent.cursor, now)
    expect(kept.get("2026-11-11")).toEqual(before.get("2026-11-11"))
    // Fine again: its new event counted.
    cursor.growing = undefined
    now += 2 * 60_000
    const whole = await history.read(agent.cursor, now)
    expect(whole.get("2026-11-11")!.uses.some((use) => use[2] === 5_000_000)).toBe(true)

    // A user never read before whose third day fails: no history at all, not one with a day of nothing.
    cursor.keys.set("key_other", "auth0|user_other")
    const third = Date.parse("2026-11-10T00:00:00Z")
    cursor.failing = (start, page) => (start === third && page === 1 ? 500 : undefined)
    await expect(new CursorHistory(mkdtempSync(join(base, "history-")), { deadline: instant, pageSize: 2, log: () => {} }).read(account("key_other", "other").cursor, now)).rejects.toThrow("aren't known yet")
  })

  test("when the time runs out, the days that came are kept, and the next read asks only for the rest", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work")
    const folder = mkdtempSync(join(base, "history-"))
    let release!: () => void
    // Out of time once the fifth day is asked (the stand-in answers the first four).
    const days = new Set<number>()
    cursor.failing = (start) => {
      days.add(start)
      if (days.size === 5) release()
      return undefined
    }
    const deadline = () => ({ done: new Promise<void>((resolve) => (release = resolve)), cancel() {} })
    await expect(new CursorHistory(folder, { deadline, concurrency: 1, log: () => {} }).read(agent.cursor, now)).rejects.toThrow("aren't known yet")
    cursor.failing = undefined
    cursor.asked.length = 0
    const whole = await new CursorHistory(folder, { deadline: instant, log: () => {} }).read(agent.cursor, now)
    expect(whole.size).toBe(CURSOR_DAYS)
    // Today and yesterday again, and the days it didn't get to.
    const asked = cursor.eventDays()
    expect(asked).toContain("2026-11-12")
    expect(asked.length).toBeGreaterThanOrEqual(CURSOR_DAYS - 4 + 2 - 2)
    expect(asked.length).toBeLessThan(CURSOR_DAYS)
  })

  test("out of time in the middle of a day of many pages: no page after it is asked", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(3)
    const agent = account("key_work")
    let release!: () => void
    const today = Math.floor(now / DAY) * DAY
    // Out of time as today's second page is asked.
    cursor.failing = (start, page) => {
      if (start === today && page === 2) release()
      return undefined
    }
    const deadline = () => ({ done: new Promise<void>((resolve) => (release = resolve)), cancel() {} })
    await expect(new CursorHistory(undefined, { deadline, concurrency: 1, pageSize: 1, log: () => {} }).read(agent.cursor, now)).rejects.toThrow("aren't known yet")
    const pages = cursor.asked.filter((each) => each.path.endsWith("get-filtered-usage-events")).map((each) => each.body.page)
    expect(pages).toEqual([1, 2])
  })

  test("on the box: Cursor's row by the day in the client's zone, by family; a read that fails keeps the last known; a round with nothing new works nothing out again", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    // (One late on the 11th, UTC: the 12th already in Tokyo.)
    cursor.events = [...eventsEachDay(), cursorEvent(Date.parse("2026-11-11T16:00:00Z"), "kimi-k3", 7000, 0)]
    const agent = account("key_work") as unknown as Agent
    const folder = mkdtempSync(join(base, "usage-"))
    const limits = limitsOf([agent])
    await limits.refresh()
    const sources = cursorSources(folder, (provider) => limits.held(provider), new CursorHistory(join(folder, "cursor-history"), { deadline: instant, log: () => {} }), () => now)
    const usage = new Usage(() => sources([agent]), store(cursorPricing()), (provider) => limits.identity(provider), join(folder, "usage.json"), () => now)
    await usage.refresh()
    const view = ((await (await usageRoutes(usage, "GET", [], new URLSearchParams({ zone: "Asia/Tokyo" }))).json()) as any).data
    expect(view.services).toContain("cursor")
    const [row] = view.rows
    expect(row).toMatchObject({ id: `cursor#${identityOf("cursor:user_abc")}`, service: "cursor", provider: "cursor@work", accountWide: true })
    const day = (days: any[], date: string) => days.find((each) => each.date === date)
    expect(day(row.days, "2026-11-12").models.find((model: any) => model.model === "kimi-k3").tokens).toBe(7000)
    const utc = ((await (await usageRoutes(usage, "GET", [], new URLSearchParams({ zone: "UTC" }))).json()) as any).data
    expect(day(utc.rows[0].days, "2026-11-11").models.find((model: any) => model.model === "kimi-k3").tokens).toBe(7000)
    const fast = row.days[0].models.find((model: any) => model.model === "gpt-6-high-fast")
    expect(fast.family).toBe("gpt-6")
    expect(row.days[0].models.find((model: any) => model.model === "composer-2").family).toBeUndefined()
    expect(view.totals.cursor[0].models.find((model: any) => model.model === "gpt-6-high-fast").family).toBe("gpt-6")
    const before = JSON.stringify(view.totals.cursor)

    // Cursor fails now: what the box had stays, never $0.
    cursor.failing = () => 500
    now += 6 * 60_000
    await usage.refresh()
    const after = ((await (await usageRoutes(usage, "GET", [], new URLSearchParams({ zone: "Asia/Tokyo" }))).json()) as any).data
    expect(JSON.stringify(after.totals.cursor)).toBe(before)
  })

  test("a plan Cursor can't state (no subscription): the account is still known as itself, so two computers' rows of it are one, never added up", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.usage = { enabled: false }
    cursor.events = eventsEachDay(1)
    const agent = account("key_work") as unknown as Agent
    const limits = limitsOf([agent])
    await limits.refresh()
    expect(limits.list()[0]!.problem?.message).toBe("No active Cursor subscription.")
    expect(limits.identity("cursor@work")).toBe(identityOf("cursor:user_abc"))
    const sources = cursorSources(undefined, (provider) => limits.held(provider), new CursorHistory(undefined, { deadline: instant, log: () => {} }), () => now)
    const usage = new Usage(() => sources([agent]), store(cursorPricing()), (provider) => limits.identity(provider), undefined, () => now)
    await usage.refresh()
    const [mine] = usage.own()
    expect(mine!.identity).toBe(identityOf("cursor:user_abc"))
    const rows = usageRows([
      { key: "mac", name: "Mac", here: true, away: false, accounts: [mine!] },
      { key: "dev", name: "devbox", here: false, away: false, accounts: [{ ...mine!, scanned: mine!.scanned! - 60_000 }] },
    ])
    expect(rows.map((row) => row.id)).toEqual([`cursor#${identityOf("cursor:user_abc")}`])
    const tokens = (slots: Slots) => [...slots.used.values()].flatMap((models) => [...models.values()]).reduce((sum, [each]) => sum + each, 0)
    expect(tokens(rows[0]!.yours)).toBe(tokens(mine!.slots))
  })

  test("a sign-in file that can't be read just now (being rewritten) isn't a sign-out: what the box had stays", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work") as unknown as Agent
    const sources = cursorSources(undefined, () => false, new CursorHistory(undefined, { deadline: instant, log: () => {} }), () => now)
    const usage = new Usage(() => sources([agent]), store(cursorPricing()), () => "aaaaaaaaaaaaaaaa", undefined, () => now)
    await usage.refresh()
    const before = usage.own()[0]!
    writeFileSync(join((agent as unknown as CursorAgent).folder, "auth.json"), '{"apiKey": "key_wo')
    now += 6 * 60_000
    await usage.refresh()
    expect(usage.own()[0]!.slots).toEqual(before.slots)
    // Signed out (the file gone): its row from this box goes.
    rmSync(join((agent as unknown as CursorAgent).folder, "auth.json"))
    now += 6 * 60_000
    await usage.refresh()
    expect(usage.own()).toEqual([])
  })

  test("signed out of Cursor here: no Cursor row from this box", async () => {
    const agent = account(undefined) as unknown as Agent
    expect(cursorSources(undefined, () => false)([agent])).toEqual([])
  })
})

// --- One account across your computers ---

const slotsOf = (at: number, tokens: number, cost: number): Slots => {
  const slots: Slots = { used: new Map([[Math.floor(at / SLOT) * SLOT, new Map([["composer-2", [tokens, cost] as [number, number]]])]]), unknown: new Map(), fallback: new Map() }
  return slots
}
const wide = (scanned: number, tokens: number): OwnUsage => ({ provider: "cursor", service: "cursor", agent: "cursor", account: "default", identity: "aaaaaaaaaaaaaaaa", scanned, slots: slotsOf(Date.parse("2026-11-12T09:00:00Z"), tokens, tokens / 1000), accountWide: true })

describe("Cursor's account across your computers", () => {
  test("a row's extras are its newest reading's: one with none says there are none now, though an older box still has some", async () => {
    const { limitRows } = await import("../../src/agents/limits-rows")
    const extra = { id: "on_demand", name: "On-demand", kind: "spent" as const, amount: 43, unit: "usd" as const }
    const account = (checked: number, extras?: (typeof extra)[], problem?: boolean) => ({ provider: "cursor", service: "cursor" as const, identity: "aaaaaaaaaaaaaaaa", windows: [], checked, ...(extras ? { extras } : {}), ...(problem ? { problem: { kind: "failed" as const, message: "x" } } : {}) })
    const rows = (mac: any, dev: any) => limitRows([{ key: "mac", name: "Mac", here: true, away: false, accounts: [mac] }, { key: "dev", name: "devbox", here: false, away: false, accounts: [dev] }])
    expect(rows(account(100, [extra]), account(200))[0]!.extras).toBeUndefined()
    expect(rows(account(100), account(200, [extra]))[0]!.extras).toEqual([extra])
    // (A newer read that failed says nothing of them: the one before stands.)
    expect(rows(account(100, [extra]), account(200, undefined, true))[0]!.extras).toEqual([extra])
  })

  test("a row takes its newest box's reading, never a sum; your totals, your own computers' newest", () => {
    const rows = usageRows([
      { key: "mac", name: "Mac", here: true, away: false, accounts: [wide(100, 10)] },
      { key: "dev", name: "devbox", here: false, away: false, accounts: [wide(300, 30)] },
      { key: "other", name: "Another Mac", here: false, away: false, vouched: true, accounts: [wide(500, 50)] },
    ])
    expect(rows).toHaveLength(1)
    const tokens = (slots: Slots) => [...slots.used.values()].flatMap((models) => [...models.values()]).reduce((sum, [each]) => sum + each, 0)
    expect(tokens(rows[0]!.slots)).toBe(50)
    expect(tokens(rows[0]!.yours)).toBe(30)
    expect(rows[0]!.accountWide).toBe(true)
    expect(rows[0]!.boxes.map((box) => box.key)).toEqual(["mac", "dev", "other"])
    // (Logs a box reads itself still add up.)
    const logs = usageRows([
      { key: "mac", name: "Mac", here: true, away: false, accounts: [{ ...wide(100, 10), accountWide: undefined }] },
      { key: "dev", name: "devbox", here: false, away: false, accounts: [{ ...wide(300, 30), accountWide: undefined }] },
    ])
    expect(tokens(logs[0]!.slots)).toBe(40)
  })

  test("read on another of your computers lately: this box doesn't ask Cursor, and keeps what it had", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work") as unknown as Agent
    let elsewhere = false
    const sources = cursorSources(undefined, () => elsewhere, new CursorHistory(undefined, { deadline: instant, log: () => {} }), () => now)
    // Never read here: no row of this box's own, only what the other told.
    elsewhere = true
    const usage = new Usage(() => sources([agent]), store(cursorPricing()), () => "aaaaaaaaaaaaaaaa", undefined, () => now)
    await usage.refresh()
    expect(usage.own()).toEqual([])
    expect(cursor.eventDays()).toEqual([])
    elsewhere = false
    await usage.refresh()
    const [mine] = usage.own()
    expect(mine!.accountWide).toBe(true)
    const asked = cursor.eventDays().length
    elsewhere = true
    now += 10 * 60_000
    await usage.refresh()
    expect(cursor.eventDays()).toHaveLength(asked)
    expect(usage.own()[0]!.slots).toEqual(mine!.slots)
    expect(usage.own()[0]!.scanned).toBe(mine!.scanned)
  })

  test("one of your computers asks Cursor for an account's history at a time, however its plan read went; one that stops, or is away, is taken over; one a peer vouches for isn't waited on", async () => {
    cursor.keys.set("key_mac", "auth0|user_abc")
    cursor.keys.set("key_dev", "auth0|user_abc")
    // Its plan can't be read (no subscription): neither computer's limits stand for the other's.
    cursor.usage = { enabled: false }
    cursor.events = eventsEachDay(1)
    const directory = (self: string, other: string) => ({ told: true, own: () => ({ key: self, name: self }), peerBoxes: () => [{ key: other, name: other }], listen: () => {}, isPeer: () => true })
    const boxes: { key: string; peers: UsagePeers }[] = []
    let down = new Set<string>()
    const box = (key: string, other: string, sign: string) => {
      const agent = account(sign) as unknown as Agent
      const limits = limitsOf([agent])
      const sources = cursorSources(undefined, (provider, identity) => limits.held(provider) || (identity !== undefined && !!usage.peers?.readsWhole("cursor", identity)), new CursorHistory(undefined, { deadline: instant, log: () => {} }), () => now)
      const usage = new Usage(() => sources([agent]), store(cursorPricing()), (provider) => limits.identity(provider), undefined, () => now)
      const transport = { followed: true, send: (to: string, mail: any) => void (down.has(key) || down.has(to) ? undefined : boxes.find((each) => each.key === to)?.peers.take(key, structuredClone(mail))) }
      const peers = new UsagePeers(usage, transport, directory(key, other) as any, undefined, () => now)
      boxes.push({ key, peers })
      return { key, usage, peers, limits }
    }
    const mac = box("a-mac", "b-dev", "key_mac")
    const dev = box("b-dev", "a-mac", "key_dev")
    const round = async () => {
      for (const each of [mac, dev]) {
        await each.limits.refresh()
        await each.usage.refresh()
      }
    }
    const events = () => cursor.eventDays().length
    // Both start, neither has heard of the other: both ask once.
    await round()
    // Then the one whose key comes first asks; the other waits, though no plan read worked.
    now += 6 * 60_000
    let before = events()
    await mac.usage.refresh()
    expect(events()).toBeGreaterThan(before)
    before = events()
    await dev.usage.refresh()
    expect(events()).toBe(before)
    // Still waits rounds later, though what the Mac read didn't change (its mail says when it read).
    for (let i = 0; i < 4; i++) {
      now += 6 * 60_000
      await mac.usage.refresh()
      mac.peers.tell()
      before = events()
      await dev.usage.refresh()
      expect(events()).toBe(before)
    }
    // The Mac stops telling (off): past 25 minutes, the devbox asks itself.
    down = new Set(["a-mac"])
    now += 26 * 60_000
    before = events()
    await dev.usage.refresh()
    expect(events()).toBeGreaterThan(before)
    expect(dev.usage.rows()[0]!.accountWide).toBe(true)
  })

  test("a box whose reads keep failing (today's events, while older days are known) doesn't say it read the account, so another of your computers takes over", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work") as unknown as Agent
    const sources = cursorSources(undefined, () => false, new CursorHistory(undefined, { deadline: instant, log: () => {} }), () => now)
    const usage = new Usage(() => sources([agent]), store(cursorPricing()), () => "aaaaaaaaaaaaaaaa", undefined, () => now)
    await usage.refresh()
    const read = usage.own()[0]!.scanned!
    expect(read).toBe(now)
    // cursor.com turns its days away now: the days are as known, but it isn't read.
    cursor.failing = () => 500
    now += 6 * 60_000
    await usage.refresh()
    expect(usage.own()[0]!.scanned).toBe(read)
  })

  test("a 429 that doesn't say for how long: the plan's own wait doubles, as for other makers", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    const agent = account("key_work") as unknown as Agent
    const limits = limitsOf([agent])
    cursor.usageAnswers = [429]
    await limits.refresh()
    const [row] = limits.list()
    expect(row!.problem).toMatchObject({ kind: "rate-limited", until: now + 60 * 60_000 })
  })

  test("a box a peer vouches for (another person's Mac beside a machine you share) is never waited on", async () => {
    const peers = new UsagePeers(new Usage(() => [], store(cursorPricing()), () => undefined, undefined, () => now), { followed: true, send: () => {} }, { told: true, own: () => ({ key: "b", name: "b" }), peerBoxes: () => [{ key: "a", name: "a" }], listen: () => {}, isPeer: () => false } as any, undefined, () => now)
    const identity = "aaaaaaaaaaaaaaaa"
    peers.take("a", { kind: "usage", at: now, digest: "x", accounts: [{ provider: "cursor", service: "cursor", identity, scanned: now, accountWide: true, slots: { models: [], used: [] } }] })
    expect(peers.readsWhole("cursor", identity)).toBe(false)
  })

  test("a key Cursor turned away isn't sent again, nor anything while Cursor holds reads off (the exchange's 429, the events' 429), whatever asks", async () => {
    const exchanges = () => cursor.asked.filter((each) => each.path.endsWith("exchange_user_api_key")).length
    const pages = () => cursor.eventDays().length
    // Revoked: its plan's read finds it so, and the history never sends it again.
    const revoked = account("key_gone") as unknown as Agent
    const limits = limitsOf([revoked])
    await limits.refresh()
    expect(limits.held("cursor@work")).toBe(true)
    const history = new CursorHistory(undefined, { deadline: instant, log: () => {} })
    const sources = cursorSources(undefined, (provider) => limits.held(provider), history, () => now)
    const usage = new Usage(() => sources([revoked]), store(cursorPricing()), (provider) => limits.identity(provider), undefined, () => now)
    for (let i = 0; i < 3; i++) {
      now += 6 * 60_000
      await usage.refresh()
      await limits.refresh()
    }
    expect(exchanges()).toBe(1)
    // Asked straight (a refresh as the plan's state is still unknown): the client itself won't send it again.
    await expect((revoked as unknown as CursorAgent).cursor.accessToken()).rejects.toMatchObject({ kind: "expired", sent: false })
    expect(exchanges()).toBe(1)

    // The exchange held off (429): nothing more is asked until it's over.
    cursor.keys.set("key_work", "auth0|user_abc")
    const busy = account("key_work", "busy")
    cursor.exchange = 429
    cursor.retryAfter = "600"
    await expect(busy.cursor.accessToken()).rejects.toMatchObject({ kind: "rate-limited" })
    cursor.exchange = undefined
    const asked = cursor.asked.length
    await expect(busy.cursor.accessToken()).rejects.toMatchObject({ kind: "rate-limited", sent: false })
    await expect(new CursorHistory(undefined, { deadline: instant, log: () => {} }).read(busy.cursor, Date.now())).rejects.toMatchObject({ kind: "rate-limited" })
    expect(cursor.asked.length).toBe(asked)

    // The events held off (429): the read stops there, and the next asks nothing until it's over.
    const other = account("key_work", "other")
    cursor.events = eventsEachDay(1)
    cursor.failing = () => 429
    await expect(new CursorHistory(undefined, { deadline: instant, concurrency: 1, log: () => {} }).read(other.cursor, now)).rejects.toThrow("aren't known yet")
    expect(pages()).toBe(1)
    await expect(new CursorHistory(undefined, { deadline: instant, log: () => {} }).read(other.cursor, now)).rejects.toMatchObject({ kind: "rate-limited" })
    expect(pages()).toBe(1)
  })

  test("a token turned away midway whose exchange is then held off (429): no page more is sent with it; nor any once the plan's read is held off meanwhile", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work")
    const pages = () => cursor.eventDays().length
    cursor.failing = () => {
      cursor.exchange = 429
      return 401
    }
    await expect(new CursorHistory(undefined, { deadline: instant, concurrency: 2, log: () => {} }).read(agent.cursor, now)).rejects.toThrow("aren't known yet")
    expect(pages()).toBe(2)
    expect(agent.cursor.heldUntil()).toBeDefined()

    // The plan's read held off (its 429) while the history's workers are under way: no page more.
    cursor.exchange = undefined
    const other = account("key_work", "other")
    cursor.failing = () => {
      other.cursor.holdFor("600")
      return undefined
    }
    const before = pages()
    await expect(new CursorHistory(undefined, { deadline: instant, concurrency: 1, log: () => {} }).read(other.cursor, now)).rejects.toThrow("aren't known yet")
    expect(pages() - before).toBe(1)
  })

  test("a 429 from one of the plan's optional reads holds the rest of them, and the history, off", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.plan = 429
    cursor.retryAfter = "600"
    const agent = account("key_work")
    const reading = await agent.limits.read!(now)
    expect(reading?.windows.length).toBeGreaterThan(0)
    expect(agent.cursor.heldUntil()).toBeDefined()
    const asked = cursor.asked.map((each) => each.path)
    for (const later of ["/api2/aiserver.v1.DashboardService/GetCreditGrantsBalance", "/web/api/auth/stripe", "/api2/aiserver.v1.DashboardService/GetSandUsageStatus"]) expect(asked).not.toContain(later)
    await expect(new CursorHistory(undefined, { deadline: instant, log: () => {} }).read(agent.cursor, now)).rejects.toMatchObject({ kind: "rate-limited" })
  })

  test("a token Cursor turns away midway through the history is exchanged again once, and its page asked again; two reads as the box starts share one exchange", async () => {
    cursor.keys.set("key_work", "auth0|user_abc")
    cursor.events = eventsEachDay(1)
    const agent = account("key_work")
    const exchanges = () => cursor.asked.filter((each) => each.path.endsWith("exchange_user_api_key")).length
    await Promise.all([agent.cursor.accessToken(), agent.cursor.accessToken()])
    expect(exchanges()).toBe(1)
    let once = true
    cursor.failing = () => {
      if (!once) return undefined
      once = false
      return 401
    }
    const days = await new CursorHistory(undefined, { deadline: instant, concurrency: 1, log: () => {} }).read(agent.cursor, now)
    expect(days.size).toBe(CURSOR_DAYS)
    expect(exchanges()).toBe(2)
  })
})
