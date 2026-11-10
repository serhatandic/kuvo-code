// Your plans' limits as the box states them (`api/kuvo/limits`): read from Kuvo Code's own sign-in
// for each account, one row each, kept through a 429 for as long as Anthropic says, and through a
// restart; what a turn hears keeps them current. Anthropic and Codex are stand-ins here.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
  private waiting: (() => void)[] = []
  /** Once the next read has come. */
  nextRead() {
    return new Promise<void>((resolve) => this.waiting.push(resolve))
  }
  private server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      this.reads.push({ token, agent: request.headers.get("user-agent"), beta: request.headers.get("anthropic-beta") })
      for (const resolve of this.waiting.splice(0)) resolve()
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

/**
 * Refreshed, as a client's pull does, once the reads are over: the route answers after two seconds
 * with what's read by then, and a Codex started to read takes longer than that on a busy Mac.
 */
const refreshed = async (limits: Limits) => {
  await limits.refresh()
  return route(limits)
}

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

  /** Claude Code's rate-limit event, as 2.1.3xx sends it with every window from a response's headers. */
  const event = (fiveHour: number, week: number, fable?: number) => ({
    status: "allowed",
    rateLimitType: "five_hour",
    utilization: fiveHour,
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: 1_794_200_000, status: "allowed" },
      seven_day: { utilization: week, resetsAt: 1_794_600_000, status: "allowed" },
      ...(fable === undefined ? {} : { seven_day_overage_included: { utilization: fable, resetsAt: 1_794_600_000 } }),
    },
  })

  test("each Claude login is its own row, from what its turns hear, and Anthropic's usage endpoint is never asked", async () => {
    const { heardWindows } = await import("../../src/agents/agents/claude-limits")
    const own = new TestClaude(home)
    const work = new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: join(home, "claude", "accounts", "1f2e3d4c") })
    // Kuvo Code's own sign-ins: setup-tokens, which can only run Claude.
    signIn(home, "default", "token-own")
    signIn(home, "1f2e3d4c", "token-work")
    anthropic.answers.set("token-own", usage(1, 1))
    const limits = new Limits(() => agentAccounts([own, work]), undefined, clock.now)
    const told: any[] = []
    const stop = subscribe((each) => each.type === "kuvo.limits.updated" && told.push(each.data))
    await limits.refresh()
    expect((await route(limits)).accounts).toEqual([])

    clock.pass(60_000)
    for (const window of heardWindows(event(0.42, 0.18, 0.07))) own.limits.heard!(window)
    for (const window of heardWindows(event(0.9, 0.61))) work.limits.heard!(window)
    stop()
    await limits.refresh()
    clock.pass(60 * 60_000)
    await limits.tick()

    const { accounts, services } = await route(limits)
    expect(services).toEqual(["claude"])
    expect(accounts.map((each) => [each.provider, each.label])).toEqual([["claude-code", undefined], ["claude-code@1f2e3d4c", "Work"]])
    expect(accounts[0]!.windows.map((window) => [window.id, window.used, window.minutes, window.model, window.resetsAt, window.source])).toEqual([
      ["five_hour", 0.42, 300, undefined, 1_794_200_000_000, "turn"],
      ["seven_day", 0.18, 10_080, undefined, 1_794_600_000_000, "turn"],
      ["seven_day_fable", 0.07, 10_080, "Fable", 1_794_600_000_000, "turn"],
    ])
    expect(accounts[1]!.windows.map((window) => window.used)).toEqual([0.9, 0.61])
    expect(told.at(-1).accounts).toHaveLength(2)
    expect(anthropic.reads).toHaveLength(0)
  })

  test("an older Claude Code's event, with only the window that limits it, keeps that one", async () => {
    const { heardWindows } = await import("../../src/agents/agents/claude-limits")
    expect(heardWindows({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1_794_600_000 })).toEqual([{ id: "seven_day", used: 0.81, minutes: 10_080, resetsAt: 1_794_600_000_000 }])
    // Turned away, with no amount: all of it.
    expect(heardWindows({ status: "rejected", rateLimitType: "five_hour" })[0]!.used).toBe(1)
    expect(heardWindows({ status: "allowed" })).toEqual([])
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
  const signedIn = (folder: string, token: string) => credentials(folder, { accessToken: token, expiresAt: clock.at + 30 * 86_400_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })

  /** Two accounts, signed in in Kuvo Code's folders. */
  function two() {
    const ownHome = join(home, "claude", "home")
    const workHome = join(home, "claude", "accounts", "1f2e3d4c")
    signedIn(ownHome, "token-own")
    signedIn(workHome, "token-work")
    return [new TestClaude(home, { id: "default", home: ownHome }), new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: workHome })]
  }

  test("each login is its own row, read with its own sign-in in Kuvo Code's folder, one a minute", async () => {
    const [own, work] = two()
    anthropic.answers.set("token-own", usage(42, 18, { limits: [{ kind: "weekly_scoped", percent: 7, resets_at: "2026-11-12T09:00:00.000Z", scope: { model: { display_name: "Fable" } } }] }))
    anthropic.answers.set("token-work", usage(90, 61))
    const limits = new Limits(() => agentAccounts([own!, work!]), undefined, clock.now)
    await limits.tick()
    // Anthropic's limit on reads is the computer's: never two at once.
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-own"])
    clock.pass(60_000)
    await limits.tick()
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-own", "token-work"])

    const { accounts } = await route(limits)
    expect(accounts.map((each) => [each.provider, each.label, each.plan])).toEqual([["claude-code", undefined, "Max 20x"], ["claude-code@1f2e3d4c", "Work", "Max 20x"]])
    expect(accounts[0]!.windows.map((window) => [window.id, window.used, window.minutes, window.model, window.source])).toEqual([
      ["five_hour", 0.42, 300, undefined, "usage"],
      ["seven_day", 0.18, 10_080, undefined, "usage"],
      ["seven_day_fable", 0.07, 10_080, "Fable", "usage"],
    ])
    expect(accounts[1]!.windows.map((window) => window.used)).toEqual([0.9, 0.61])
    // As Claude Code asks it.
    expect(anthropic.reads.every((read) => read.beta === "oauth-2025-04-20" && read.agent === "claude-cli/2.1.300 (external, cli)")).toBe(true)
  })

  test("a 429 keeps the last numbers and holds every Claude login until Anthropic's time, through a restart", async () => {
    const [own, work] = two()
    anthropic.answers.set("token-own", usage(42, 18))
    anthropic.answers.set("token-work", usage(90, 61))
    const file = join(home, "limits.json")
    const limits = new Limits(() => agentAccounts([own!, work!]), file, clock.now)
    await limits.tick()
    clock.pass(60_000)
    await limits.tick()
    expect(anthropic.reads).toHaveLength(2)

    // Fifteen minutes on, Anthropic turns the first away, for 46 minutes.
    clock.pass(15 * 60_000)
    anthropic.answers.set("token-own", () => new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "2766" } }))
    await limits.tick()
    clock.pass(60_000)
    await limits.tick()
    // The other isn't asked meanwhile: the hold is the computer's.
    expect(anthropic.reads).toHaveLength(3)
    const held = await route(limits)
    expect(held.accounts[0]!.problem).toEqual({ kind: "rate-limited", message: expect.any(String), until: clock.at - 60_000 + 2_766_000 })
    expect(held.accounts.map((each) => each.windows.map((window) => window.used))).toEqual([[0.42, 0.18], [0.9, 0.61]])

    // Refreshing, and the minutes passing, ask nothing until then: not after a restart either.
    await limits.refresh()
    clock.pass(30 * 60_000)
    await limits.tick()
    const restarted = new Limits(() => agentAccounts([own!, work!]), file, clock.now)
    await restarted.refresh()
    await restarted.tick()
    expect(anthropic.reads).toHaveLength(3)
    expect((await route(restarted)).accounts.map((each) => each.windows.map((window) => window.used))).toEqual([[0.42, 0.18], [0.9, 0.61]])

    // Once it's time, they're read again, one a minute.
    anthropic.answers.set("token-own", usage(50, 20))
    clock.pass(16 * 60_000)
    await restarted.tick()
    clock.pass(60_000)
    await restarted.tick()
    expect(anthropic.reads).toHaveLength(5)
    const after = await route(restarted)
    expect(after.accounts[0]!.problem).toBeUndefined()
    expect(after.accounts[0]!.windows.map((window) => window.used)).toEqual([0.5, 0.2])
  })

  test("a read under way is kept before it's answered: a restart meanwhile doesn't ask again", async () => {
    const folder = join(home, "claude", "home")
    signedIn(folder, "token-own")
    let answer!: () => void
    anthropic.answers.set("token-own", () => new Promise<Response>((resolve) => (answer = () => resolve(usage(42, 18)()))) as any)
    const file = join(home, "limits.json")
    const own = new TestClaude(home, { id: "default", home: folder })
    const first = new Limits(() => agentAccounts([own]), file, clock.now)
    const asked = anthropic.nextRead()
    const reading = first.tick()
    await asked
    // The box starts again while Anthropic hasn't answered.
    const restarted = new Limits(() => agentAccounts([new TestClaude(home, { id: "default", home: folder })]), file, clock.now)
    await restarted.tick()
    expect(anthropic.reads).toHaveLength(1)
    answer()
    await reading
  })

  test("a refresh right after a read doesn't read another Claude account within the minute", async () => {
    const [own, work] = two()
    anthropic.answers.set("token-own", usage(42, 18))
    anthropic.answers.set("token-work", usage(90, 61))
    const limits = new Limits(() => agentAccounts([own!, work!]), undefined, clock.now)
    await limits.tick()
    clock.pass(5_000)
    await limits.refresh()
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-own"])
    clock.pass(55_000)
    await limits.refresh()
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-own", "token-work"])
  })

  test("a restart while one Claude account is being read doesn't read another in the same minute", async () => {
    const [own, work] = two()
    let answer!: () => void
    anthropic.answers.set("token-own", () => new Promise<Response>((resolve) => (answer = () => resolve(usage(42, 18)()))) as any)
    anthropic.answers.set("token-work", usage(90, 61))
    const file = join(home, "limits.json")
    const first = new Limits(() => agentAccounts([own!, work!]), file, clock.now)
    const asked = anthropic.nextRead()
    const reading = first.tick()
    await asked
    // The box starts again, seconds later.
    clock.pass(5_000)
    const restarted = new Limits(() => agentAccounts([own!, work!]), file, clock.now)
    await restarted.tick()
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-own"])
    answer()
    await reading
  })

  test("a 429 with no time waits an hour, then longer each time", async () => {
    const folder = join(home, "claude", "home")
    signedIn(folder, "token-own")
    anthropic.answers.set("token-own", () => new Response("{}", { status: 429 }))
    const limits = new Limits(() => agentAccounts([new TestClaude(home, { id: "default", home: folder })]), undefined, clock.now)
    await limits.tick()
    expect((await route(limits)).accounts[0]!.problem?.until).toBe(clock.at + 60 * 60_000)
    clock.pass(60 * 60_000)
    await limits.tick()
    expect(anthropic.reads).toHaveLength(2)
    expect((await route(limits)).accounts[0]!.problem?.until).toBe(clock.at + 2 * 60 * 60_000)
  })

  test("a sign-in Anthropic won't let read its limits isn't asked again until it's signed in again", async () => {
    const folder = join(home, "claude", "home")
    signedIn(folder, "token-old")
    anthropic.answers.set("token-old", () => Response.json({ error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" } }, { status: 403 }))
    anthropic.answers.set("token-new", usage(5, 5))
    const limits = new Limits(() => agentAccounts([new TestClaude(home, { id: "default", home: folder })]), undefined, clock.now)
    await limits.tick()
    expect((await route(limits)).accounts[0]!.problem?.kind).toBe("unreadable")
    clock.pass(3 * 60 * 60_000)
    await limits.tick()
    await limits.refresh()
    expect(anthropic.reads).toHaveLength(1)
    // Signed in again: read at its next turn.
    signedIn(folder, "token-new")
    clock.pass(15 * 60_000)
    await limits.tick()
    expect(anthropic.reads.map((read) => read.token)).toEqual(["token-old", "token-new"])
    expect((await route(limits)).accounts[0]!.problem).toBeUndefined()
  })

  test("what a turn hears keeps a window current between reads, even while a read is under way", async () => {
    const folder = join(home, "claude", "home")
    signedIn(folder, "token-own")
    const own = new TestClaude(home, { id: "default", home: folder })
    anthropic.answers.set("token-own", usage(42, 18))
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    await limits.tick()
    clock.pass(60_000)
    own.limits.heard!({ id: "five_hour", used: 0.97, resetsAt: Date.parse("2026-11-09T02:00:00.000Z") })
    let window = (await route(limits)).accounts[0]!.windows.find((each) => each.id === "five_hour")!
    expect([window.used, window.minutes, window.source, window.read]).toEqual([0.97, 300, "turn", clock.at])
    // A read asked before a turn heard more doesn't take its place with older numbers.
    let answer!: () => void
    anthropic.answers.set("token-own", () => new Promise<Response>((resolve) => (answer = () => resolve(usage(50, 20)()))) as any)
    clock.pass(15 * 60_000)
    const asked = anthropic.nextRead()
    const reading = limits.tick()
    await asked
    own.limits.heard!({ id: "five_hour", used: 0.99 })
    answer()
    await reading
    const windows = (await route(limits)).accounts[0]!.windows
    expect(windows.map((each) => [each.id, each.used, each.source])).toEqual([["seven_day", 0.2, "usage"], ["five_hour", 0.99, "turn"]])
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
    const { accounts, services } = await refreshed(limits)
    expect(accounts).toEqual([])
    expect(services).toEqual(["claude"])
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
    if (message.method) require("node:fs").appendFileSync(${JSON.stringify(join(folder, "asked.txt"))}, message.method + "\\n")
    if (message.method === "account/read") send({ id: message.id, result: { account: ${JSON.stringify(account)} } })
    else if (message.method === "account/rateLimits/read") send({ id: message.id, result: ${JSON.stringify(rateLimits)} })
    else if (message.id !== undefined) send({ id: message.id, result: {} })
  }
})
`,
  )
  const launcher = join(folder, "codex")
  writeFileSync(launcher, `#!/bin/sh\necho started >> "${join(folder, "starts.txt")}"\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
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
    const { accounts } = await refreshed(limits)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.plan).toBe("Pro")
    expect(accounts[0]!.windows.map((each) => [each.id, each.used, each.minutes, each.model, each.resetsAt])).toEqual([
      ["primary", 0.12, 300, undefined, 1_794_200_000_000],
      ["secondary", 0.4, 10_080, undefined, 1_794_200_000_000],
      ["codex_spark.primary", 0.03, 300, "GPT-5.3-Codex-Spark", 1_794_200_000_000],
    ])
  })

  test("once read, it's read again only while Codex runs here anyway: a read never starts one", async () => {
    const window = { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_794_200_000 }
    codex = new TestCodex(fakeCodex(home, { type: "chatgpt", planType: "plus" }, { rateLimits: { limitId: "codex", primary: window } }), home)
    const limits = new Limits(() => agentAccounts([codex!]), undefined, clock.now)
    await limits.tick()
    const reads = () => readFileSync(join(home, "asked.txt"), "utf8").split("\n").filter((method) => method === "account/rateLimits/read").length
    expect(reads()).toBe(1)
    // Its app-server stops (nothing used it): ten minutes on, nothing starts it again for this.
    codex.shutdown?.()
    clock.pass(10 * 60_000)
    await limits.tick()
    expect(reads()).toBe(1)
    expect((await route(limits)).accounts[0]!.windows.map((each) => each.used)).toEqual([0.12])
  })

  test("an API key's Codex is started once to ask, not again every time it's looked at", async () => {
    codex = new TestCodex(fakeCodex(home, { type: "apiKey" }, {}), home)
    const limits = new Limits(() => agentAccounts([codex!]), undefined, clock.now)
    await limits.tick()
    codex.shutdown?.()
    clock.pass(31 * 60_000)
    await limits.tick()
    expect(readFileSync(join(home, "starts.txt"), "utf8").trim().split("\n")).toHaveLength(1)
    expect((await route(limits)).accounts).toEqual([])
  })

  test("an API key has no plan limits: not listed", async () => {
    codex = new TestCodex(fakeCodex(home, { type: "apiKey" }, {}), home)
    const limits = new Limits(() => agentAccounts([codex!]), undefined, clock.now)
    expect((await refreshed(limits)).accounts).toEqual([])
  })
})

/** A sign-in's token as its maker signs it: only what it says of itself matters here. */
const token = (claims: Record<string, unknown>) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`

describe("who each account is, the same from every computer", () => {
  /** Claude Code's own record of who it's signed in as, beside its sign-in (Linux). */
  function signedInAs(folder: string, token: string, account: string, organization: string) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: clock.at + 86_400_000, scopes: ["user:inference", "user:profile"] } }))
    writeFileSync(join(folder, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: "ada@example.com", organizationUuid: organization } }))
  }

  test("one Claude login on two computers is one identity, another login another, and neither says who", async () => {
    ClaudeAgent.keychain = false
    // Two computers' boxes, each with Kuvo Code's own sign-ins in its folders.
    const first = join(home, "first")
    const second = join(home, "second")
    signedInAs(join(first, "claude", "home"), "token-1", "6F1E0C4A-0000-4000-8000-000000000001", "org-1")
    signedInAs(join(second, "claude", "home"), "token-2", "6f1e0c4a-0000-4000-8000-000000000001", "ORG-1")
    signedInAs(join(second, "claude", "accounts", "a1"), "token-3", "6f1e0c4a-0000-4000-8000-000000000002", "org-2")
    for (const each of ["token-1", "token-2", "token-3"]) anthropic.answers.set(each, usage(10, 20))
    const one = new Limits(() => agentAccounts([new TestClaude(first, { id: "default", home: join(first, "claude", "home") })]), undefined, clock.now)
    const two = new Limits(() => agentAccounts([new TestClaude(second, { id: "default", home: join(second, "claude", "home") }), new TestClaude(second, { id: "a1", label: "Athas", home: join(second, "claude", "accounts", "a1") })]), undefined, clock.now)
    await one.tick()
    clock.pass(60_000)
    await two.tick()
    clock.pass(60_000)
    await two.tick()
    const [mine] = (await route(one)).accounts
    const [same, other] = (await route(two)).accounts
    expect(mine!.identity).toMatch(/^[0-9a-f]{16}$/)
    expect(same!.identity).toBe(mine!.identity!)
    expect(other!.identity).toMatch(/^[0-9a-f]{16}$/)
    expect(other!.identity).not.toBe(mine!.identity!)
    // Nothing of the account itself leaves the box.
    const said = JSON.stringify([await route(one), await route(two)])
    for (const secret of ["6f1e0c4a", "6F1E0C4A", "org-1", "org-2", "ada@example.com", "token-1"]) expect(said).not.toContain(secret)
  })

  test("a Mac's Claude token says nothing of who it's for: no identity, and the row is as before", async () => {
    ClaudeAgent.keychain = true
    const { heardWindows } = await import("../../src/agents/agents/claude-limits")
    signIn(home, "default", "token-own")
    const own = new TestClaude(home)
    const limits = new Limits(() => agentAccounts([own]), undefined, clock.now)
    await limits.tick()
    for (const window of heardWindows({ rateLimitType: "five_hour", utilization: 0.3, status: "allowed" })) own.limits.heard!(window)
    const [account] = (await route(limits)).accounts
    expect(account!.windows.map((each) => each.used)).toEqual([0.3])
    expect(account!.identity).toBeUndefined()
  })

  test("signed in to another account since, what was kept of the one before isn't shown as this one's", async () => {
    ClaudeAgent.keychain = false
    const folder = join(home, "claude", "home")
    signedInAs(folder, "token-old", "00000000-0000-4000-8000-00000000000a", "org-a")
    anthropic.answers.set("token-old", usage(80, 70))
    const file = join(home, "limits.json")
    const own = new TestClaude(home, { id: "default", home: folder })
    const limits = new Limits(() => agentAccounts([own]), file, clock.now)
    await limits.tick()
    const before = (await route(limits)).accounts[0]!
    expect(before.windows.map((each) => each.used)).toEqual([0.8, 0.7])

    // Signed in as someone else, and Anthropic holding reads off for now: nothing of the old one stays.
    signedInAs(folder, "token-new", "00000000-0000-4000-8000-00000000000b", "org-b")
    anthropic.answers.set("token-new", () => new Response("{}", { status: 429, headers: { "retry-after": "600" } }))
    clock.pass(60_000)
    await limits.tick()
    const after = (await route(limits)).accounts[0]!
    expect(after.identity).not.toBe(before.identity!)
    expect(after.windows).toEqual([])
    expect(after.problem?.kind).toBe("rate-limited")
    // Through a restart too.
    const restarted = new Limits(() => agentAccounts([own]), file, clock.now)
    expect((await route(restarted)).accounts[0]!.windows).toEqual([])
  })

  test("Codex's ChatGPT sign-in is its account and workspace member, the same as the engine's sign-in to it", async () => {
    const { EngineAccounts } = await import("../../src/agents/engine-limits")
    const access = (user: string) => token({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-77", chatgpt_user_id: user }, "https://api.openai.com/profile": { email: "ada@example.com" } })
    const codexHome = join(home, "codex-accounts", "a1")
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x", access_token: access("user-ada"), refresh_token: "r", account_id: "acct-77" } }))
    const window = { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_794_200_000 }
    const launcher = fakeCodex(home, { type: "chatgpt", email: "ada@example.com", planType: "team" }, { rateLimits: { limitId: "codex", primary: window } })
    const codex = new (class extends CodexAgent {
      override executable() {
        return launcher
      }
    })({ home, temporary: home, deps: {} as any }, { id: "a1", label: "Work", home: codexHome })
    try {
      const agent = (await refreshed(new Limits(() => agentAccounts([codex]), undefined, clock.now))).accounts[0]!
      const engine = (signedIn: string) => {
        const accounts = new EngineAccounts(async () => [{ integrationID: "openai", active: true, value: { type: "oauth", access: access(signedIn), expires: clock.at + 3_600_000, metadata: { accountID: "acct-77" } } }])
        return accounts.refresh().then(() => accounts.accounts()[0]!.limits.identity!())
      }
      const { identityOf } = await import("../../src/agents/limits")
      expect(agent.identity).toBe(identityOf((await engine("user-ada"))!))
      // Another member of the same workspace has limits of their own.
      expect(identityOf((await engine("user-bob"))!)).not.toBe(agent.identity!)
      expect(JSON.stringify(agent)).not.toContain("acct-77")
    } finally {
      codex.shutdown?.()
    }
  })

  test("Codex signed in to another account while one still runs: not read through it, said so, then read once it starts again", async () => {
    const access = (user: string) => token({ "https://api.openai.com/auth": { chatgpt_account_id: `acct-${user}`, chatgpt_user_id: user } })
    const codexHome = join(home, "codex-accounts", "a1")
    mkdirSync(codexHome, { recursive: true })
    const signIn = (user: string) => writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: access(user), account_id: `acct-${user}` } }))
    signIn("ada")
    // (The stand-in answers the same numbers whoever it is: what matters is whose they're said to be.)
    const launcher = fakeCodex(home, { type: "chatgpt", planType: "plus" }, { rateLimits: { limitId: "codex", primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 1_794_200_000 } } })
    const codex = new (class extends CodexAgent {
      override executable() {
        return launcher
      }
    })({ home, temporary: home, deps: {} as any }, { id: "a1", home: codexHome })
    try {
      const limits = new Limits(() => agentAccounts([codex]), undefined, clock.now)
      const first = (await refreshed(limits)).accounts[0]!
      expect(first.windows.map((each) => each.used)).toEqual([0.7])
      // Signed in as Bob in Terminal; the Codex running reads Ada's sign-in still.
      signIn("bob")
      clock.pass(60_000)
      await limits.tick()
      const switched = (await route(limits)).accounts[0]!
      expect(switched.identity).not.toBe(first.identity!)
      expect(switched.windows).toEqual([])
      expect(switched.problem?.message).toBe("Signed in to another account here: its limits show once they're read.")
      // It stops (nothing used it); the next read starts one with Bob's sign-in.
      codex.shutdown?.()
      clock.pass(10 * 60_000)
      await limits.tick()
      const read = (await route(limits)).accounts[0]!
      expect([read.identity, read.windows.map((each) => each.used), read.problem]).toEqual([switched.identity, [0.7], undefined])
    } finally {
      codex.shutdown?.()
    }
  })
})

describe("plan_limits, an agent's read of them", () => {
  test("says each account's windows, how much is used, when each resets and as of when", async () => {
    ClaudeAgent.keychain = false
    const sign = (folder: string, token: string) => {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, scopes: ["user:profile"] } }))
    }
    sign(join(home, "claude", "home"), "token-own")
    sign(join(home, "claude", "accounts", "1f2e3d4c"), "token-work")
    const own = new TestClaude(home, { id: "default", home: join(home, "claude", "home") })
    const work = new TestClaude(home, { id: "1f2e3d4c", label: "Work", home: join(home, "claude", "accounts", "1f2e3d4c") })
    const real = Date.now()
    const at = (minutes: number) => new Date(real + minutes * 60_000).toISOString()
    anthropic.answers.set("token-own", () => Response.json({ five_hour: { utilization: 42, resets_at: at(130) }, seven_day: { utilization: 18, resets_at: at(4 * 1440) } }))
    anthropic.answers.set("token-work", () => Response.json({}, { status: 429, headers: { "retry-after": "1800" } }))
    let clockAt = real
    const limits = new Limits(() => agentAccounts([own, work]), undefined, () => clockAt)
    // (One Claude account a minute.)
    await limits.tick()
    clockAt += 60_000
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
      expect(text).toContain("Not read just now: Anthropic is turning away reads of the plan's limits for now. Read again in 31m.")
    } finally {
      bridge.stop(true)
    }
  })

  test("with the coding agents not running, says so as an error", async () => {
    const { planLimitsTool } = await import("../../src/link/work/plan-limits")
    expect((await planLimitsTool(null)).isError).toBe(true)
  })
})
