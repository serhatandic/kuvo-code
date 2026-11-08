// The limits and credits of the engine's sign-ins, as the box states them (`api/kuvo/limits`): each
// one you signed in to in Kuvo Code, read with that sign-in only, one row each. The makers are
// stand-ins here, answering as their real endpoints do.

import "../safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ENGINE_SERVICES, EngineAccounts, engineEndpoints } from "../../src/agents/engine-limits"
import { Limits, limitsRoutes, type AccountLimits } from "../../src/agents/limits"

const real = { ...engineEndpoints }
const NOW = Date.parse("2026-11-08T20:00:00.000Z")

/** Every maker at once: what each path answers, and every read with its headers. */
let answers: Record<string, () => Response>
let reads: { path: string; headers: Headers }[]
let server: ReturnType<typeof Bun.serve>

beforeEach(() => {
  answers = {}
  reads = []
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      reads.push({ path: url.pathname, headers: request.headers })
      return answers[url.pathname]?.() ?? new Response("{}", { status: 404 })
    },
  })
  for (const key of Object.keys(engineEndpoints) as (keyof typeof engineEndpoints)[]) engineEndpoints[key] = `http://127.0.0.1:${server.port}/${key}`
})

afterEach(() => {
  server.stop(true)
  Object.assign(engineEndpoints, real)
})

const credential = (integrationID: string, value: Record<string, unknown>, active = true) => ({ id: `cred_${integrationID}`, integrationID, active, value })

async function stated(credentials: unknown[]) {
  const engine = new EngineAccounts(async () => ({ data: credentials }))
  const limits = new Limits(() => engine.accounts(), undefined, () => NOW, () => engine.refresh())
  limits.alsoServices = ENGINE_SERVICES
  return ((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data as { accounts: AccountLimits[]; services: string[] }
}

test("each sign-in in Settings › Accounts is a row of its own, read with that sign-in", async () => {
  answers["/chatgpt"] = () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_794_200_000 }, secondary_window: { used_percent: 55, limit_window_seconds: 604_800, reset_at: 1_794_600_000 } } })
  answers["/copilot"] = () => Response.json({ copilot_plan: "individual_pro", quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40 }, chat: { entitlement: -1, remaining: -1, unlimited: true } } })
  answers["/openrouterKey"] = () => Response.json({ data: { limit: null, usage: 3, is_free_tier: false } })
  answers["/openrouterCredits"] = () => Response.json({ data: { total_credits: 20, total_usage: 7.5 } })
  answers["/zai"] = () => Response.json({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12, nextResetTime: 1_794_190_000_000 }, { type: "TIME_LIMIT", currentValue: 40, usage: 100 }] } })
  answers["/opencodeGo"] = () => Response.json({ usage: { rolling: { percent: 9, resetsAt: "2026-11-08T22:00:00.000Z" }, weekly: { percent: 21, resetsAt: "2026-11-12T00:00:00.000Z" } } })
  const { accounts, services } = await stated([
    credential("openai", { type: "oauth", access: "chatgpt-token", expires: NOW + 3_600_000, metadata: { accountID: "acct_1" } }),
    credential("github-copilot", { type: "oauth", access: "gho_token" }),
    credential("openrouter", { type: "api", key: "or-key" }),
    credential("zai-coding-plan", { type: "api", key: "zai-key" }),
    credential("opencode-go", { type: "api", key: "go-key" }),
    // Not the active one: never read.
    credential("anthropic", { type: "api", key: "sk-old" }, false),
  ])
  expect(services.sort()).toEqual(["codex", "copilot", "grok", "opencode", "openrouter", "zai"])
  const by = Object.fromEntries(accounts.map((each) => [each.provider, each]))
  expect(Object.keys(by)).toEqual(["openai", "github-copilot", "openrouter", "zai-coding-plan", "opencode-go"])

  expect(by.openai!.service).toBe("codex")
  expect(by.openai!.plan).toBe("Plus")
  expect(by.openai!.windows.map((w) => [w.id, w.used, w.minutes, w.resetsAt])).toEqual([["primary", 0.3, 300, 1_794_200_000_000], ["secondary", 0.55, 10_080, 1_794_600_000_000]])
  const chatgpt = reads.find((read) => read.path === "/chatgpt")!.headers
  expect([chatgpt.get("authorization"), chatgpt.get("chatgpt-account-id")]).toEqual(["Bearer chatgpt-token", "acct_1"])

  // Premium requests, as a count; unlimited chat isn't a limit.
  expect(by["github-copilot"]!.windows.map((w) => [w.id, w.used, w.amount])).toEqual([["premium_interactions", 0.6, { used: 180, limit: 300, unit: "requests" }]])
  expect(by["github-copilot"]!.plan).toBe("Individual Pro")
  expect(reads.find((read) => read.path === "/copilot")!.headers.get("authorization")).toBe("token gho_token")

  // No cap on the key: its credits left.
  expect(by.openrouter!.windows).toEqual([])
  expect(by.openrouter!.balance).toEqual({ left: 12.5, unit: "usd" })

  expect(by["zai-coding-plan"]!.windows.map((w) => [w.id, w.used, w.minutes, w.model ?? null])).toEqual([["session", 0.12, 300, null], ["web_search", 0.4, undefined, "Web searches"]])
  expect(by["opencode-go"]!.windows.map((w) => [w.id, w.used, w.resetsAt ?? null])).toEqual([["rolling", 0.09, Date.parse("2026-11-08T22:00:00.000Z")], ["weekly", 0.21, Date.parse("2026-11-12T00:00:00.000Z")]])
})

test("an API key with no plan isn't listed; a lapsed sign-in says so without asking its maker", async () => {
  answers["/zai"] = () => Response.json({ success: false, msg: "No coding plan found for this key" })
  const { accounts } = await stated([
    // An OpenAI API key: no ChatGPT plan.
    credential("openai", { type: "api", key: "sk-key" }),
    credential("zai", { type: "api", key: "zai-key" }),
    credential("xai", { type: "oauth", access: "xai-token", expires: NOW - 1 }),
  ])
  expect(accounts.map((each) => [each.provider, each.problem?.kind])).toEqual([["xai", "expired"]])
  expect(reads.map((read) => read.path)).toEqual(["/zai"])
})

test("SuperGrok's weekly pool, as the Grok CLI reads it", async () => {
  answers["/grok"] = () => Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-05T00:00:00Z", end: "2026-11-12T00:00:00Z" }, creditUsagePercent: 64 } })
  const { accounts } = await stated([credential("xai", { type: "oauth", access: "xai-token", expires: NOW + 3_600_000 })])
  expect(accounts[0]!.windows.map((w) => [w.id, w.used, w.minutes, w.resetsAt])).toEqual([["weekly", 0.64, 10_080, Date.parse("2026-11-12T00:00:00Z")]])
  expect(reads[0]!.headers.get("x-xai-token-auth")).toBe("xai-grok-cli")
})

test("the Grok agent's own sign-in, in its folder, reads the same pool", async () => {
  const { GrokAgent } = await import("../../src/agents/agents/grok")
  const { agentAccounts } = await import("../../src/agents/limits")
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-grok-limits-"))
  try {
    writeFileSync(join(folder, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "grok-token", expiresAt: "2026-11-09T20:00:00Z" } }))
    answers["/grok"] = () => Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-05T00:00:00Z", end: "2026-11-12T00:00:00Z" }, creditUsagePercent: 12.5 } })
    const grok = new GrokAgent({ home: folder, temporary: folder, deps: {} as any }, { id: "a1", label: "Side", home: folder })
    const limits = new Limits(() => agentAccounts([grok]), undefined, () => NOW)
    const accounts = (((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data.accounts) as AccountLimits[]
    expect(accounts.map((each) => [each.provider, each.service, each.agent, each.label, each.windows[0]?.used])).toEqual([["grok-cli@a1", "grok", "grok", "Side", 0.125]])
    expect(reads[0]!.headers.get("authorization")).toBe("Bearer grok-token")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
