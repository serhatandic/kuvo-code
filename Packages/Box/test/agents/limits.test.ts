// Your plans' limits as the box states them (`api/kuvo/limits`): read from Kuvo Code's own sign-in
// for each account, one row each, kept through a 429 for as long as Anthropic says, and through a
// restart; what a turn hears keeps them current. Anthropic and Codex are stand-ins here.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { claudeUsage } from "../../src/agents/agents/claude-limits"
import { CodexAgent } from "../../src/agents/agents/codex"
import type { Agent } from "../../src/agents/agent"
import { subscribe } from "../../src/agents/events"
import { agentAccounts, Limits, limitsRoutes, type AccountLimits } from "../../src/agents/limits"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-limits-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const keychain = ClaudeAgent.keychain
afterEach(() => {
  ClaudeAgent.keychain = keychain
})

/** Anthropic's usage endpoint: what it answers each sign-in (by its token), and every read it got. */
class Anthropic {
  answers = new Map<string, () => Response>()
  reads: { token: string; agent: string | null; beta: string | null }[] = []
  private server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      this.reads.push({ token, agent: request.headers.get("user-agent"), beta: request.headers.get("anthropic-beta") })
      return this.answers.get(token)?.() ?? new Response("{}", { status: 401 })
    },
  })
  readonly url = `http://127.0.0.1:${this.server.port}/api/oauth/usage`
  stop() {
    this.server.stop(true)
  }
}

const usage = (fiveHour: number, week: number, extra: Record<string, unknown> = {}) => () =>
  Response.json({
    five_hour: { utilization: fiveHour, resets_at: "2026-11-09T02:00:00.000Z" },
    seven_day: { utilization: week, resets_at: "2026-11-12T09:00:00.000Z" },
    seven_day_sonnet: null,
    ...extra,
  })

class TestClaude extends ClaudeAgent {
  constructor(home: string, instance?: { id: string; label?: string; home?: string }) {
    super({ home, temporary: home, deps: {} as any }, instance)
  }
  protected override async programVersion() {
    return "2.1.300"
  }
}

/** Kuvo Code's own token for an account on a Mac, as signing in keeps it (`claude setup-token`). */
function signIn(home: string, account: string, token: string) {
  mkdirSync(join(home, "claude", "tokens"), { recursive: true })
  writeFileSync(join(home, "claude", "tokens", `${account}.json`), JSON.stringify({ token, made: 1 }))
}

/** A clock the test moves. */
class Clock {
  at = Date.parse("2026-11-08T20:00:00.000Z")
  now = () => this.at
  pass(ms: number) {
    this.at += ms
  }
}

const route = async (limits: Limits, method = "GET", rest: string[] = []) => ((await (await limitsRoutes(limits, method, rest)).json()) as any).data as { accounts: AccountLimits[]; services: string[] }

let anthropic: Anthropic
let home: string
let clock: Clock

beforeEach(() => {
  anthropic = new Anthropic()
  claudeUsage.url = anthropic.url
  home = mkdtempSync(join(base, "case-"))
  clock = new Clock()
})

afterEach(() => anthropic.stop())

describe("Claude on a Mac", () => {
  beforeEach(() => {
    ClaudeAgent.keychain = true
  })

  test("each Claude login is its own row, read with Kuvo Code's own sign-in", async () => {
    const own = new TestClaude(home)
    const work = new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: join(home, "claude", "accounts", "1f2e3d4c") })
    signIn(home, "default", "token-own")
    signIn(home, "1f2e3d4c", "token-work")
    anthropic.answers.set("token-own", usage(42, 18, { limits: [{ kind: "weekly_scoped", percent: 7, resets_at: "2026-11-12T09:00:00.000Z", scope: { model: { display_name: "Fable" } } }] }))
    anthropic.answers.set("token-work", usage(90, 61))
    const limits = new Limits(() => agentAccounts([own, work]), undefined, clock.now)

    const { accounts, services } = await route(limits, "POST", ["refresh"])

    expect(services).toEqual(["claude"])
    expect(accounts.map((each) => [each.provider, each.label])).toEqual([["claude-code", undefined], ["claude-code@1f2e3d4c", "Work"]])
    expect(accounts[0]!.windows.map((window) => [window.id, window.used, window.minutes, window.model])).toEqual([
      ["five_hour", 0.42, 300, undefined],
      ["seven_day", 0.18, 10_080, undefined],
      ["seven_day_fable", 0.07, 10_080, "Fable"],
    ])
    expect(accounts[0]!.windows[0]!.resetsAt).toBe(Date.parse("2026-11-09T02:00:00.000Z"))
    expect(accounts[0]!.windows[0]!.read).toBe(clock.at)
    expect(accounts[1]!.windows.map((window) => window.used)).toEqual([0.9, 0.61])
    // As Claude Code asks it, with each account's own token.
    expect(anthropic.reads.map((read) => read.token).sort()).toEqual(["token-own", "token-work"])
    expect(anthropic.reads.every((read) => read.beta === "oauth-2025-04-20" && read.agent === "claude-cli/2.1.300 (external, cli)")).toBe(true)
  })

  test("a 429 keeps the last numbers and holds every Claude login until Anthropic's time, through a restart", async () => {
    const own = new TestClaude(home)
    const work = new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: join(home, "claude", "accounts", "1f2e3d4c") })
    signIn(home, "default", "token-own")
    signIn(home, "1f2e3d4c", "token-work")
    anthropic.answers.set("token-own", usage(42, 18))
    anthropic.answers.set("token-work", usage(90, 61))
    const file = join(home, "limits.json")
    const limits = new Limits(() => agentAccounts([own, work]), file, clock.now)
    await limits.tick()
    expect(anthropic.reads).toHaveLength(2)

    // Fifteen minutes on, Anthropic turns the first away, for 46 minutes.
    clock.pass(15 * 60_000 + 1)
    anthropic.answers.set("token-own", () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "2766" } }))
    await limits.tick()
    // The other isn't asked meanwhile: the limit is the computer's.
    expect(anthropic.reads).toHaveLength(3)
    const held = await route(limits)
    expect(held.accounts[0]!.problem).toEqual({ kind: "rate-limited", message: expect.any(String), until: clock.at + 2_766_000 })
    expect(held.accounts[0]!.windows.map((window) => window.used)).toEqual([0.42, 0.18])
    expect(held.accounts[1]!.windows.map((window) => window.used)).toEqual([0.9, 0.61])

    // Refreshing, and the minutes passing, ask nothing until then: not after a restart either.
    await limits.refresh()
    clock.pass(30 * 60_000)
    await limits.tick()
    const restarted = new Limits(() => agentAccounts([own, work]), file, clock.now)
    await restarted.refresh()
    await restarted.tick()
    expect(anthropic.reads).toHaveLength(3)
    expect((await route(restarted)).accounts.map((each) => each.windows.map((window) => window.used))).toEqual([[0.42, 0.18], [0.9, 0.61]])

    // Once it's time, both are read again.
    anthropic.answers.set("token-own", usage(50, 20))
    clock.pass(17 * 60_000)
    await restarted.tick()
    expect(anthropic.reads).toHaveLength(5)
    const after = await route(restarted)
    expect(after.accounts[0]!.problem).toBeUndefined()
    expect(after.accounts[0]!.windows.map((window) => window.used)).toEqual([0.5, 0.2])
  })

  test("a 429 with no time waits an hour, then longer each time", async () => {
    const own = new TestClaude(home)
    signIn(home, "default", "token-own")
    anthropic.answers.set("token-own", () => new Response("{}", { status: 429 }))
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    await limits.tick()
    expect((await route(limits)).accounts[0]!.problem?.until).toBe(clock.at + 60 * 60_000)
    clock.pass(60 * 60_000)
    await limits.tick()
    expect(anthropic.reads).toHaveLength(2)
    expect((await route(limits)).accounts[0]!.problem?.until).toBe(clock.at + 2 * 60 * 60_000)
  })

  test("a computer without Kuvo Code's own Claude sign-in states none, and asks Anthropic nothing", async () => {
    const own = new TestClaude(home)
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    const { accounts, services } = await route(limits, "POST", ["refresh"])
    expect(accounts).toEqual([])
    expect(services).toEqual(["claude"])
    expect(anthropic.reads).toHaveLength(0)
  })

  test("a sign-in Anthropic won't let read its limits says so, and isn't asked again until later", async () => {
    const own = new TestClaude(home)
    signIn(home, "default", "token-own")
    anthropic.answers.set("token-own", () => Response.json({ error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" } }, { status: 403 }))
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    await limits.tick()
    clock.pass(5 * 60_000)
    await limits.refresh()
    expect(anthropic.reads).toHaveLength(1)
    expect((await route(limits)).accounts[0]!.problem?.kind).toBe("unreadable")
  })

  test("what a turn hears keeps a window current between reads, and tells the clients", async () => {
    const own = new TestClaude(home)
    signIn(home, "default", "token-own")
    anthropic.answers.set("token-own", usage(42, 18))
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    await limits.tick()
    const told: any[] = []
    const stop = subscribe((event) => event.type === "kuvo.limits.updated" && told.push(event.data))
    clock.pass(60_000)
    own.limits.heard!({ id: "five_hour", used: 0.97, resetsAt: Date.parse("2026-11-09T02:00:00.000Z") })
    stop()
    const window = (await route(limits)).accounts[0]!.windows[0]!
    expect([window.id, window.used, window.minutes, window.source, window.read]).toEqual(["five_hour", 0.97, 300, "turn", clock.at])
    expect(told.at(-1).accounts[0].windows[0].used).toBe(0.97)
  })
})

describe("Claude on Linux", () => {
  beforeEach(() => {
    ClaudeAgent.keychain = false
  })

  /** Claude Code's own sign-in file, in Kuvo Code's folder for the account. */
  function credentials(folder: string, oauth: Record<string, unknown>) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }))
  }

  test("reads Claude Code's sign-in in Kuvo Code's folder, with its plan", async () => {
    const folder = join(home, "claude", "home")
    credentials(folder, { accessToken: "token-linux", expiresAt: clock.at + 3_600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })
    anthropic.answers.set("token-linux", usage(10, 5))
    const limits = new Limits(() => agentAccounts([new TestClaude(home, { id: "default", home: folder })]), undefined, clock.now)
    const { accounts } = await route(limits, "POST", ["refresh"])
    expect(accounts[0]!.plan).toBe("Max 20x")
    expect(accounts[0]!.windows.map((window) => window.used)).toEqual([0.1, 0.05])
  })

  test("a lapsed or inference-only sign-in says why, and never goes to Anthropic", async () => {
    const lapsed = join(home, "claude", "home")
    const inference = join(home, "claude", "accounts", "a1")
    credentials(lapsed, { accessToken: "token-lapsed", expiresAt: clock.at - 1, scopes: ["user:profile"] })
    credentials(inference, { accessToken: "token-inference", expiresAt: clock.at + 3_600_000, scopes: ["user:inference"] })
    const limits = new Limits(() => agentAccounts([new TestClaude(home, { id: "default", home: lapsed }), new TestClaude(home, { id: "a1", home: inference })]), undefined, clock.now)
    const { accounts } = await route(limits, "POST", ["refresh"])
    expect(accounts.map((each) => each.problem?.kind)).toEqual(["expired", "unreadable"])
    expect(anthropic.reads).toHaveLength(0)
  })

  test("never reads a sign-in outside Kuvo Code's folders (yours in ~/.claude)", async () => {
    credentials(join(process.env.HOME!, ".claude"), { accessToken: "token-yours", scopes: ["user:profile"] })
    anthropic.answers.set("token-yours", usage(1, 1))
    const limits = new Limits(() => agentAccounts([new TestClaude(home)]), undefined, clock.now)
    expect((await route(limits, "POST", ["refresh"])).accounts).toEqual([])
    expect(anthropic.reads).toHaveLength(0)
  })
})

/** A Codex app-server that answers who's signed in and the plan's windows, as Codex 0.167 does. */
function fakeCodex(folder: string, account: unknown, rateLimits: unknown): string {
  const script = join(folder, "app-server.js")
  writeFileSync(
    script,
    `let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === "account/read") send({ id: message.id, result: { account: ${JSON.stringify(account)} } })
    else if (message.method === "account/rateLimits/read") send({ id: message.id, result: ${JSON.stringify(rateLimits)} })
    else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

class TestCodex extends CodexAgent {
  constructor(
    readonly launcher: string,
    home: string,
  ) {
    super({ home, temporary: home, deps: {} as any })
  }
  override executable() {
    return this.launcher
  }
}

describe("Codex", () => {
  let codex: Agent | undefined
  afterEach(() => codex?.shutdown?.())

  test("its plan's windows and a model's own, as Codex reads them with its sign-in", async () => {
    const window = (usedPercent: number, windowDurationMins: number) => ({ usedPercent, windowDurationMins, resetsAt: 1_794_200_000 })
    const launcher = fakeCodex(home, { type: "chatgpt", email: "you@example.com", planType: "pro" }, {
      rateLimits: { limitId: "codex", primary: window(12, 300), secondary: window(40, 10_080) },
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: window(12, 300), secondary: window(40, 10_080), planType: "pro" },
        codex_spark: { limitId: "codex_spark", limitName: "GPT-5.3-Codex-Spark", primary: window(3, 300), secondary: null },
      },
    })
    codex = new TestCodex(launcher, home)
    const limits = new Limits(() => agentAccounts([codex!]), undefined, clock.now)
    const { accounts } = await route(limits, "POST", ["refresh"])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.plan).toBe("Pro")
    expect(accounts[0]!.windows.map((each) => [each.id, each.used, each.minutes, each.model, each.resetsAt])).toEqual([
      ["primary", 0.12, 300, undefined, 1_794_200_000_000],
      ["secondary", 0.4, 10_080, undefined, 1_794_200_000_000],
      ["codex_spark.primary", 0.03, 300, "GPT-5.3-Codex-Spark", 1_794_200_000_000],
    ])
  })

  test("an API key has no plan limits: not listed", async () => {
    codex = new TestCodex(fakeCodex(home, { type: "apiKey" }, {}), home)
    const limits = new Limits(() => agentAccounts([codex!]), undefined, clock.now)
    expect((await route(limits, "POST", ["refresh"])).accounts).toEqual([])
  })
})

describe("plan_limits, an agent's read of them", () => {
  test("says each account's windows, how much is used, when each resets and as of when", async () => {
    ClaudeAgent.keychain = true
    const own = new TestClaude(home)
    const work = new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: join(home, "claude", "accounts", "1f2e3d4c") })
    signIn(home, "default", "token-own")
    signIn(home, "1f2e3d4c", "token-work")
    const real = Date.now()
    const at = (minutes: number) => new Date(real + minutes * 60_000).toISOString()
    anthropic.answers.set("token-own", () => Response.json({ five_hour: { utilization: 42, resets_at: at(130) }, seven_day: { utilization: 18, resets_at: at(4 * 1440) } }))
    anthropic.answers.set("token-work", () => Response.json({}, { status: 429, headers: { "retry-after": "1800" } }))
    const limits = new Limits(() => agentAccounts([own, work]))
    await limits.tick()
    // The bridge as the link reaches it.
    const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => limitsRoutes(limits, request.method, new URL(request.url).pathname.split("/").slice(4)) })
    try {
      const { planLimitsTool } = await import("../../src/link/work/plan-limits")
      const { text, isError } = await planLimitsTool({ port: bridge.port, password: "x" } as never)
      expect(isError).toBe(false)
      expect(text).toContain("- Claude Code, provider claude-code:")
      expect(text).toContain("5-hour window: 42% used, resets in 2h 10m")
      expect(text).toContain("weekly limit: 18% used, resets in 4 days")
      expect(text).toContain("as of just now")
      // One Anthropic turned away: said so, with when it's read again.
      expect(text).toContain("- Claude Code (Work), provider claude-code@1f2e3d4c:")
      expect(text).toContain("Not read just now: Anthropic is turning away reads of the plan's limits for now. Read again in 30m.")
    } finally {
      bridge.stop(true)
    }
  })

  test("with the coding agents not running, says so as an error", async () => {
    const { planLimitsTool } = await import("../../src/link/work/plan-limits")
    expect((await planLimitsTool(null)).isError).toBe(true)
  })
})
