// The limits and credits of the engine's sign-ins, as the box states them (`api/kuvo/limits`): each
// one you signed in to in Kuvo Code, read with that sign-in only, one row each. The makers are
// stand-ins here, answering as their real endpoints do.

import "../safety"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ENGINE_SERVICES, EngineAccounts, engineEndpoints } from "../../src/agents/engine-limits"
import { BOX_ONLY_SERVICES, Limits, limitsRoutes, type AccountLimits } from "../../src/agents/limits"

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
  limits.alsoServices = [...ENGINE_SERVICES, ...BOX_ONLY_SERVICES]
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
    // As the engine keeps it: GitHub's token as `refresh`, Copilot's own short-lived one as `access`, lapsed.
    credential("github-copilot", { type: "oauth", access: "copilot-short", refresh: "gho_token", expires: NOW - 1 }),
    credential("openrouter", { type: "api", key: "or-key" }),
    credential("zai-coding-plan", { type: "api", key: "zai-key" }),
    credential("opencode-go", { type: "api", key: "go-key" }),
    // Not the active one: never read.
    credential("anthropic", { type: "api", key: "sk-old" }, false),
  ])
  // (Antigravity's too, with none signed in: only boxes read it, so a client's card of it takes only theirs.)
  expect(services.sort()).toEqual(["antigravity", "codex", "copilot", "grok", "opencode", "openrouter", "zai"])
  const by = Object.fromEntries(accounts.map((each) => [each.provider, each]))
  expect(Object.keys(by)).toEqual(["openai", "github-copilot", "openrouter", "zai-coding-plan", "opencode-go"])

  expect(by.openai!.service).toBe("codex")
  expect(by.openai!.plan).toBe("Plus")
  expect(by.openai!.windows.map((w) => [w.id, w.used, w.minutes, w.resetsAt])).toEqual([["primary", 0.3, 300, 1_794_200_000_000], ["secondary", 0.55, 10_080, 1_794_600_000_000]])
  const chatgpt = reads.find((read) => read.path === "/chatgpt")!.headers
  expect([chatgpt.get("authorization"), chatgpt.get("chatgpt-account-id")]).toEqual(["Bearer chatgpt-token", "acct_1"])

  // Premium requests, as a count; unlimited chat isn't a limit.
  expect(by["github-copilot"]!.windows.map((w) => [w.id, w.name, w.used, w.amount])).toEqual([["premium_interactions", "Premium requests", 0.6, { used: 180, limit: 300, unit: "requests" }]])
  expect(by["github-copilot"]!.plan).toBe("Individual Pro")
  expect(reads.find((read) => read.path === "/copilot")!.headers.get("authorization")).toBe("token gho_token")

  // No cap on the key: its credits left.
  expect(by.openrouter!.windows).toEqual([])
  expect(by.openrouter!.balance).toEqual({ left: 12.5, limit: 20, unit: "usd" })

  expect(by["zai-coding-plan"]!.windows.map((w) => [w.id, w.used, w.minutes, w.name ?? null])).toEqual([["session", 0.12, 300, null], ["web_search", 0.4, undefined, "Web searches"]])
  expect(by["opencode-go"]!.windows.map((w) => [w.id, w.used, w.resetsAt ?? null])).toEqual([["rolling", 0.09, Date.parse("2026-11-08T22:00:00.000Z")], ["weekly", 0.21, Date.parse("2026-11-12T00:00:00.000Z")]])
})

test("an OpenRouter key's spend today, this week and this month (UTC's), each starting over when OpenRouter's does; what was bought, for what's left of it", async () => {
  answers["/openrouterKey"] = () => Response.json({ data: { limit: null, usage: 31.75, usage_daily: 1.84, usage_weekly: 9.2, usage_monthly: 31.75, is_free_tier: false } })
  answers["/openrouterCredits"] = () => Response.json({ data: { total_credits: 50, total_usage: 42.3 } })
  const [account] = (await stated([credential("openrouter", { type: "api", key: "or-key" })])).accounts
  const at = new Date(NOW)
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  expect(account!.balance).toEqual({ left: 50 - 42.3, limit: 50, unit: "usd" })
  expect(account!.extras).toEqual([
    { id: "today", name: "Today", kind: "spent", amount: 1.84, unit: "usd", resetsAt: day + 86_400_000 },
    { id: "week", name: "This Week", kind: "spent", amount: 9.2, unit: "usd", resetsAt: day + (7 - ((at.getUTCDay() + 6) % 7)) * 86_400_000 },
    { id: "month", name: "This Month", kind: "spent", amount: 31.75, unit: "usd", resetsAt: Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) },
  ])
  // A key that doesn't say its spend: none, never a zero.
  answers["/openrouterKey"] = () => Response.json({ data: { limit: 10, usage: 2 } })
  expect((await stated([credential("openrouter", { type: "api", key: "or-key" })])).accounts[0]!.extras).toBeUndefined()
})

test("a Copilot seat its organization pays for by the credit: the organization's credits and spend this month, where the sign-in may read its billing; nothing, never a zero, where it may not", async () => {
  answers["/copilot"] = () => Response.json({ copilot_plan: "business", token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0 } } })
  answers["/githubOrgs"] = () => Response.json([{ login: "member-only" }, { login: "acme" }])
  answers["/githubBilling/member-only/settings/billing/usage/summary"] = () => Response.json({ message: "Must have admin rights" }, { status: 403 })
  answers["/githubBilling/acme/settings/billing/usage/summary"] = () => Response.json({ usageItems: [
    { product: "Copilot", unitType: "ai-credits", grossQuantity: 1200, netAmount: 14.5 },
    { product: "copilot", unitType: "AI-Units", grossQuantity: 300, netAmount: 0.5 },
    // A seat's fee isn't credits.
    { product: "Copilot", unitType: "user-months", grossQuantity: 3, netAmount: 57 },
    { product: "Actions", unitType: "minutes", grossQuantity: 900, netAmount: 2 },
  ] })
  const [account] = (await stated([credential("github-copilot", { type: "oauth", access: "short", refresh: "gho_admin", expires: NOW - 1 })])).accounts
  expect(account!.windows).toEqual([])
  expect(account!.extras).toEqual([
    { id: "org_credits", name: "Org Credits", kind: "spent", amount: 1500, unit: "credits" },
    { id: "org_spend", name: "Org Spend", kind: "spent", amount: 15, unit: "usd" },
  ])
  expect(reads.find((read) => read.path === "/githubOrgs")!.headers.get("authorization")).toBe("token gho_admin")

  // GitHub failing the organization's billing for now: what was read stays, never none.
  answers["/githubBilling/acme/settings/billing/usage/summary"] = () => new Response("{}", { status: 503 })
  const [kept] = (await stated([credential("github-copilot", { type: "oauth", access: "short", refresh: "gho_admin", expires: NOW - 1 })])).accounts
  expect(kept!.extras?.map((extra) => [extra.id, extra.amount])).toEqual([["org_credits", 1500], ["org_spend", 15]])

  // A member who can't read any organization's billing: the plan alone.
  answers["/githubBilling/acme/settings/billing/usage/summary"] = () => Response.json({ message: "Must have admin rights" }, { status: 403 })
  const [member] = (await stated([credential("github-copilot", { type: "oauth", access: "short", refresh: "gho_member", expires: NOW - 1 })])).accounts
  expect(member!.plan).toBe("Business")
  expect(member!.extras).toBeUndefined()
})

test("GitHub holding requests off (a 403 with retry-after) stops the look through your organizations, and the next read looks again", async () => {
  answers["/copilot"] = () => Response.json({ copilot_plan: "business", token_based_billing: true, quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0 } } })
  answers["/githubOrgs"] = () => Response.json([{ login: "first" }, { login: "second" }, { login: "acme" }])
  answers["/githubBilling/first/settings/billing/usage/summary"] = () => new Response("{}", { status: 403, headers: { "retry-after": "60" } })
  answers["/githubBilling/acme/settings/billing/usage/summary"] = () => Response.json({ usageItems: [{ product: "Copilot", unitType: "ai-credits", grossQuantity: 10, netAmount: 1 }] })
  const read = async () => (await stated([credential("github-copilot", { type: "oauth", access: "short", refresh: "gho_held", expires: NOW - 1 })])).accounts[0]!
  expect((await read()).extras).toBeUndefined()
  expect(reads.filter((each) => each.path.startsWith("/githubBilling/")).map((each) => each.path.split("/")[2])).toEqual(["first"])
  // Not taken for "none here": asked again at the next read.
  answers["/githubBilling/first/settings/billing/usage/summary"] = () => new Response("{}", { status: 403 })
  expect((await read()).extras?.map((extra) => extra.id)).toEqual(["org_credits", "org_spend"])
})

test("ChatGPT's credits and reset credits, read with the engine's sign-in", async () => {
  answers["/chatgpt"] = () => Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_794_200_000 } }, credits: { has_credits: true, balance: "821.9" }, rate_limit_reset_credits: { available_count: 0 } })
  const [account] = (await stated([credential("openai", { type: "oauth", access: "chatgpt-token", expires: NOW + 3_600_000, metadata: { accountID: "acct_1" } })])).accounts
  expect(account!.extras).toEqual([
    { id: "credits", name: "Extra Usage", kind: "left", amount: 821, unit: "credits" },
    { id: "resets", name: "Rate Limit Resets", kind: "resets", count: 0, usable: false },
  ])
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
    writeFileSync(join(folder, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "grok-token", expires_at: "2026-11-09T20:00:00Z" } }))
    answers["/grok"] = () => Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-05T00:00:00Z", end: "2026-11-12T00:00:00Z" }, creditUsagePercent: 12.5 } })
    const grok = new (class extends GrokAgent { override executable() { return "/bin/true" } })({ home: folder, temporary: folder, deps: {} as any }, { id: "a1", label: "Side", home: folder })
    const limits = new Limits(() => agentAccounts([grok]), undefined, () => NOW)
    const accounts = (((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data.accounts) as AccountLimits[]
    expect(accounts.map((each) => [each.provider, each.service, each.agent, each.label, each.windows[0]?.used])).toEqual([["grok-cli@a1", "grok", "grok", "Side", 0.125]])
    expect(reads[0]!.headers.get("authorization")).toBe("Bearer grok-token")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("OpenCode Go turning a key away for having no plan lists nothing, rather than asking to sign in again", async () => {
  answers["/opencodeGo"] = () => Response.json({ type: "error", error: { type: "EntitlementError", message: "No active subscription" } }, { status: 403 })
  const { accounts } = await stated([credential("opencode-go", { type: "api", key: "go-key" })])
  expect(accounts).toEqual([])
})

test("a Grok sign-in that lapsed waits for Grok to renew it, without asking xAI", async () => {
  const { GrokAgent } = await import("../../src/agents/agents/grok")
  const { agentAccounts } = await import("../../src/agents/limits")
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-grok-limits-"))
  try {
    writeFileSync(join(folder, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: "grok-token", expires_at: "2026-11-08T19:00:00Z" } }))
    const grok = new (class extends GrokAgent { override executable() { return "/bin/true" } })({ home: folder, temporary: folder, deps: {} as any }, { id: "a1", home: folder })
    const limits = new Limits(() => agentAccounts([grok]), undefined, () => NOW)
    const accounts = (((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data.accounts) as AccountLimits[]
    expect(accounts.map((each) => each.problem?.kind)).toEqual(["expired"])
    expect(reads).toHaveLength(0)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("a box starting before its engine answers keeps the engine's sign-ins' holds, and asks nothing early", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-engine-limits-"))
  try {
    const file = join(folder, "limits.json")
    answers["/openrouterKey"] = () => new Response("{}", { status: 429, headers: { "retry-after": "3600" } })
    const signedIn = [credential("openrouter", { type: "api", key: "or-key" })]
    let at = NOW
    const first = new EngineAccounts(async () => ({ data: signedIn }))
    await new Limits(() => first.accounts(), file, () => at, () => first.refresh(), () => first.answered).tick()
    expect(reads).toHaveLength(1)
    // The box starts again; its engine isn't up yet, then it is.
    at += 5 * 60_000
    let up = false
    const again = new EngineAccounts(async () => {
      if (!up) throw new Error("The engine isn't running.")
      return { data: signedIn }
    })
    const restarted = new Limits(() => again.accounts(), file, () => at, () => again.refresh(), () => again.answered)
    await restarted.tick()
    up = true
    at += 60_000
    await restarted.tick()
    expect(reads).toHaveLength(1)
    expect(((await (await limitsRoutes(restarted, "GET", [])).json()) as any).data.accounts[0].problem.kind).toBe("rate-limited")
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("an API key turned away is tried again later, not held to that key as a lapsed sign-in", async () => {
  let at = NOW
  answers["/openrouterKey"] = () => new Response("{}", { status: 401 })
  const engine = new EngineAccounts(async () => ({ data: [credential("openrouter", { type: "api", key: "or-key" })] }))
  const limits = new Limits(() => engine.accounts(), undefined, () => at, () => engine.refresh(), () => engine.answered)
  await limits.tick()
  const listed = ((await (await limitsRoutes(limits, "GET", [])).json()) as any).data.accounts
  expect(listed[0].problem.kind).toBe("failed")
  at += 11 * 60_000
  await limits.tick()
  expect(reads.filter((read) => read.path === "/openrouterKey")).toHaveLength(2)
})

test("each sign-in says who it is, the same on every computer: a key by the key, Copilot by GitHub's login, SuperGrok by its user", async () => {
  const { GrokAgent } = await import("../../src/agents/agents/grok")
  const { agentAccounts } = await import("../../src/agents/limits")
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
  answers["/openrouterKey"] = () => Response.json({ data: { limit: null, usage: 3, is_free_tier: false } })
  answers["/openrouterCredits"] = () => Response.json({ data: { total_credits: 20, total_usage: 7.5 } })
  answers["/copilot"] = () => Response.json({ login: "Ada-L", copilot_plan: "individual_pro", quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40 } } })
  answers["/grok"] = () => Response.json({ config: { currentPeriod: { start: "2026-11-05T00:00:00Z", end: "2026-11-12T00:00:00Z" }, creditUsagePercent: 10 } })
  const engine = (key: string, github: string) => stated([
    credential("openrouter", { type: "api", key }),
    credential("github-copilot", { type: "oauth", access: "copilot-short", refresh: github, expires: NOW - 1 }),
    credential("xai", { type: "oauth", access: jwt({ sub: "xai-user-1" }), expires: NOW + 3_600_000 }),
  ])
  // Two computers: the same key and GitHub account, signed in on each with sign-ins of their own.
  const here = await engine("or-key", "gho_here")
  const there = await engine("or-key", "gho_there")
  const other = await engine("or-other-key", "gho_there")
  const identities = (accounts: AccountLimits[]) => accounts.map((each) => [each.provider, each.identity])
  expect(identities(here.accounts)).toEqual(identities(there.accounts))
  expect(here.accounts.every((each) => /^[0-9a-f]{16}$/.test(each.identity ?? ""))).toBe(true)
  expect(other.accounts[0]!.identity).not.toBe(here.accounts[0]!.identity!)
  const said = JSON.stringify([here, there])
  for (const secret of ["or-key", "Ada-L", "ada-l", "xai-user-1", "gho_here"]) expect(said).not.toContain(secret)

  // The Grok agent signed in to the same xAI account: the same identity as the engine's SuperGrok.
  const folder = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-grok-identity-"))
  try {
    writeFileSync(join(folder, "auth.json"), JSON.stringify({ "https://auth.x.ai": { key: jwt({ sub: "xai-user-1" }), expires_at: "2026-11-09T20:00:00Z" } }))
    const grok = new (class extends GrokAgent { override executable() { return "/bin/true" } })({ home: folder, temporary: folder, deps: {} as any }, { id: "a1", home: folder })
    const limits = new Limits(() => agentAccounts([grok]), undefined, () => NOW)
    const accounts = (((await (await limitsRoutes(limits, "POST", ["refresh"])).json()) as any).data.accounts) as AccountLimits[]
    expect(accounts[0]!.identity).toBe(here.accounts.find((each) => each.provider === "xai")!.identity!)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

test("signed in to Copilot as another GitHub account, what was kept of the one before isn't shown as this one's", async () => {
  let login = "ada"
  let remaining = 120
  answers["/copilot"] = () => Response.json({ login, copilot_plan: "individual", quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining, percent_remaining: (remaining / 300) * 100 } } })
  let now = NOW
  let value = { type: "oauth", access: "copilot-short", refresh: "gho_ada", expires: NOW - 1 }
  const engine = new EngineAccounts(async () => ({ data: [credential("github-copilot", value)] }))
  const limits = new Limits(() => engine.accounts(), undefined, () => now, () => engine.refresh())
  const listed = async () => (((await (await limitsRoutes(limits, "GET", [])).json()) as any).data.accounts as AccountLimits[])[0]!
  await limits.tick()
  const ada = await listed()
  expect(ada.windows[0]!.amount?.used).toBe(180)
  // Signed in again as Bob, who has used less.
  login = "bob"
  remaining = 290
  value = { ...value, refresh: "gho_bob" }
  now += 11 * 60_000
  await limits.tick()
  const bob = await listed()
  expect(bob.identity).not.toBe(ada.identity!)
  expect(bob.windows.map((each) => each.amount?.used)).toEqual([10])
  expect(bob.problem).toBeUndefined()
})
