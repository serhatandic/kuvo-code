// Using a plan's resets through the box (PROTOCOL.md, "Plan limits", "Resets"): asked first, the box
// says what it would spend and gives a one-time confirmation; asked again with it, one reset is
// spent, once, whatever happens between (a crash before the request goes, a lost answer), because
// each spend is written to a journal first and goes to its maker as the same request every time.
// A box whose sign-in can't spend it (a Mac's Claude token) passes it to the computer of yours that
// can, and answers when that one does. Real bridge parts (limits, peers, resets, a Mac's and a
// Linux Claude agent, the engine's ChatGPT sign-in); Anthropic and ChatGPT are stand-ins that count
// what they spend by request id, as they do.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { claudeUsage, MAC_TOKEN_CANT } from "../../src/agents/agents/claude-limits"
import { codexResetEndpoints } from "../../src/agents/codex-resets"
import { EngineAccounts, engineEndpoints } from "../../src/agents/engine-limits"
import { LinkDirectory, PeerPost, peerRoutes, type PeerParts } from "../../src/agents/groups/post"
import type { Clock } from "../../src/agents/groups/peer"
import { agentAccounts, Limits, limitsRoutes, type LimitedAccount } from "../../src/agents/limits"
import { LimitsPeers } from "../../src/agents/limits-peers"
import { LimitResets } from "../../src/agents/limits-resets"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-limits-resets-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const keychain = ClaudeAgent.keychain
afterEach(() => {
  ClaudeAgent.keychain = keychain
})

let time = Date.parse("2026-11-13T09:00:00.000Z")
const now = () => time
const DAY = 86_400_000

/** A gate a stand-in holds a request at until the test opens it. */
class Gate {
  private open?: () => void
  readonly reached: Promise<void>
  private arrived!: () => void
  readonly opened = new Promise<void>((resolve) => (this.open = resolve))
  constructor() {
    this.reached = new Promise<void>((resolve) => (this.arrived = resolve))
  }
  async pass() {
    this.arrived()
    await this.opened
  }
  release() {
    this.open!()
  }
}

/**
 * Anthropic and ChatGPT: their usage, an account's reset grants (Anthropic) and reset credits
 * (ChatGPT), and what each spend did, by its request id: asked again with one it has, it answers
 * that it's done, and spends nothing more.
 */
class Makers {
  grants = { eligible: true, grants: [{ id: "promo_one", resets_left: 2, ends_at: new Date(time + 5 * DAY).toISOString(), clears: ["five_hour", "seven_day"] }], next_grant_id: "promo_one" }
  claims: { org: string; grant: string; request: string }[] = []
  credits = [
    { id: "credit_late", status: "available", expires_at: new Date(time + 9 * DAY).toISOString() },
    { id: "credit_soon", status: "available", expires_at: new Date(time + 2 * DAY).toISOString() },
  ]
  consumes: { credit: string; request: string; account: string | null }[] = []
  /** What each request id spent. */
  private spent = new Map<string, string>()
  /** Held at: the credits' list, or a consume after it's spent (its answer lost). */
  holdList?: Gate
  holdAnswer?: Gate
  /** The next consume: spent, then answered with a failure (its answer lost). */
  failAfterSpending = false
  /** Credits it refuses outright (expired since they were listed): a 400. */
  refuses = new Set<string>()
  fiveHour = 92

  private server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      if (url.pathname === "/api/oauth/usage") {
        if (!token.startsWith("claude-")) return new Response("{}", { status: 401 })
        if (url.searchParams.get("cedar_ember") === "1") return Response.json({ cedar_ember: this.grants })
        return Response.json({ five_hour: { utilization: this.fiveHour, resets_at: new Date(time + 3_600_000).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(time + 3 * DAY).toISOString() }, extra_usage: { is_enabled: true, used_credits: 1240, monthly_limit: 5000 } })
      }
      const claim = url.pathname.match(/^\/api\/organizations\/([^/]+)\/reset_rate_limits$/)
      if (claim && request.method === "POST") {
        const body: any = await request.json()
        this.claims.push({ org: claim[1]!, grant: body.grant_id, request: body.request_id })
        if (this.spent.has(body.request_id)) return Response.json({ result: "already_used" })
        const grant = this.grants.grants.find((each) => each.id === body.grant_id)
        if (!grant || grant.resets_left < 1) return Response.json({ result: "unavailable", reason: "no_grant" })
        grant.resets_left--
        this.spent.set(body.request_id, grant.id)
        this.fiveHour = 0
        return Response.json({ result: "reset" })
      }
      if (url.pathname === "/wham/usage") {
        return Response.json({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: this.fiveHour, limit_window_seconds: 18_000, reset_after_seconds: 3600 } },
          credits: { has_credits: true, balance: "1240.5" },
          rate_limit_reset_credits: { available_count: this.credits.filter((each) => each.status === "available").length },
        })
      }
      if (url.pathname === "/wham/rate-limit-reset-credits") {
        await this.holdList?.pass()
        return Response.json({ available_count: this.credits.filter((each) => each.status === "available").length, credits: this.credits })
      }
      if (url.pathname === "/wham/rate-limit-reset-credits/consume" && request.method === "POST") {
        const body: any = await request.json()
        this.consumes.push({ credit: body.credit_id, request: body.redeem_request_id, account: request.headers.get("chatgpt-account-id") })
        if (this.refuses.has(body.credit_id)) return Response.json({ error: "credit_expired" }, { status: 400 })
        let code = "already_redeemed"
        if (!this.spent.has(body.redeem_request_id)) {
          const credit = this.credits.find((each) => each.id === body.credit_id && each.status === "available")
          if (!credit) return Response.json({ code: "no_credit" })
          credit.status = "redeemed"
          this.spent.set(body.redeem_request_id, credit.id)
          this.fiveHour = 0
          code = "reset"
        }
        await this.holdAnswer?.pass()
        if (this.failAfterSpending) {
          this.failAfterSpending = false
          return new Response("{}", { status: 502 })
        }
        return Response.json({ code })
      }
      return new Response("{}", { status: 404 })
    },
  })
  readonly origin = `http://127.0.0.1:${this.server.port}`

  /** How many resets were spent, whatever was asked. */
  get spends() {
    return this.spent.size
  }

  stop() {
    this.server.stop(true)
  }
}

let makers: Makers
const endpoints = { claude: claudeUsage.url, chatgpt: engineEndpoints.chatgpt, list: codexResetEndpoints.list, consume: codexResetEndpoints.consume }
beforeEach(() => {
  makers = new Makers()
  claudeUsage.url = `${makers.origin}/api/oauth/usage`
  engineEndpoints.chatgpt = `${makers.origin}/wham/usage`
  codexResetEndpoints.list = `${makers.origin}/wham/rate-limit-reset-credits`
  codexResetEndpoints.consume = `${makers.origin}/wham/rate-limit-reset-credits/consume`
})
afterEach(() => {
  makers.stop()
  claudeUsage.url = endpoints.claude
  engineEndpoints.chatgpt = endpoints.chatgpt
  codexResetEndpoints.list = endpoints.list
  codexResetEndpoints.consume = endpoints.consume
})

/** A ChatGPT token, as its claims say who it's for. */
const chatGPTToken = (account: string) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: "user-1" } })).toString("base64url")}.signature`

/** The engine's ChatGPT sign-in, as `GET /api/credential` lists it. */
function chatGPT() {
  const engine = new EngineAccounts(async () => [{ integrationID: "openai", active: true, value: { type: "oauth", access: chatGPTToken("acct-1"), refresh: "refresh-1", expires: time + DAY, metadata: { accountID: "acct-1" } } }])
  return engine
}

/** A box's bridge with the engine's ChatGPT sign-in: its limits and resets, journal in `folder`. */
async function chatGPTBox(folder: string) {
  const engine = chatGPT()
  const limits = new Limits(() => engine.accounts(), join(folder, "limits.json"), now, () => engine.refresh(), () => engine.answered)
  const resets = new LimitResets(limits, join(folder, "limits-resets.json"), now)
  await limits.tick()
  return { limits, resets, engine }
}

const post = async (limits: Limits, body: unknown) => {
  const response = await limitsRoutes(limits, "POST", ["reset"], async () => body)
  return { status: response.status, body: (await response.json()) as any }
}

describe("a reset, asked and then confirmed", () => {
  test("the account's row says what it has; asked, the box offers one with a confirmation; confirmed, one is spent, and asked again with it, nothing more is", async () => {
    const folder = mkdtempSync(join(base, "chatgpt-"))
    const { limits } = await chatGPTBox(folder)
    const [row] = limits.rows()
    expect(row!.id).toMatch(/^codex#[0-9a-f]{16}$/)
    // What it has beyond its windows: its credits, and its resets, with when each expires.
    expect(row!.extras).toEqual([
      { id: "credits", name: "Extra Usage", kind: "left", amount: 1240, unit: "credits" },
      { id: "resets", name: "Rate Limit Resets", kind: "resets", count: 2, expiries: [time + 2 * DAY, time + 9 * DAY], usable: true, on: { key: "", name: "", here: true } },
    ])

    const offered = await post(limits, { row: row!.id })
    expect(offered.status).toBe(200)
    expect(offered.body.data).toMatchObject({ row: row!.id, service: "codex", count: 2, on: { here: true }, always: false })
    expect(offered.body.data.confirm).toMatch(/^rsc_[0-9a-f]{24}$/)
    // Asking spends nothing.
    expect(makers.consumes).toEqual([])

    const done = await post(limits, { row: row!.id, confirm: offered.body.data.confirm })
    expect(done.body.data.outcome).toBe("reset")
    // The soonest to expire, once, as the account's own ChatGPT account.
    expect(makers.consumes.map((each) => [each.credit, each.account])).toEqual([["credit_soon", "acct-1"]])
    // Read again at once: its window refilled, one reset fewer.
    expect(done.body.data.row.windows[0].used).toBe(0)
    expect(done.body.data.row.extras.find((extra: any) => extra.kind === "resets").count).toBe(1)

    // The same confirmation again (a client that didn't hear back, a second tap): how it went, nothing spent.
    const again = await post(limits, { row: row!.id, confirm: offered.body.data.confirm })
    expect(again.body.data.outcome).toBe("reset")
    expect(makers.consumes).toHaveLength(1)
    expect(makers.spends).toBe(1)

    // One it never gave, or for another account: refused, nothing spent.
    expect((await post(limits, { row: row!.id, confirm: "rsc_000000000000000000000000" })).status).toBe(404)
    const other = await post(limits, { row: row!.id })
    expect((await post(limits, { row: "codex#0000000000000000", confirm: other.body.data.confirm })).status).toBe(404)
    // (And one given an hour ago has lapsed.)
    time += 60 * 60_000
    expect((await post(limits, { row: row!.id, confirm: other.body.data.confirm })).status).toBe(404)
    expect(makers.spends).toBe(1)
  })

  test("the box stops after the spend is written down and before its request goes: started again, the same confirmation goes as the same request, and one reset is spent", async () => {
    const folder = mkdtempSync(join(base, "crash-before-"))
    const first = await chatGPTBox(folder)
    const [row] = first.limits.rows()
    const offered = await post(first.limits, { row: row!.id })
    // It goes as far as choosing the credit, and stops there (the box is gone).
    makers.holdList = new Gate()
    const lost = post(first.limits, { row: row!.id, confirm: offered.body.data.confirm })
    await makers.holdList.reached
    const journal = JSON.parse(readFileSync(join(folder, "limits-resets.json"), "utf8"))
    expect(journal.spends).toHaveLength(1)
    expect(journal.spends[0]).toMatchObject({ id: offered.body.data.confirm, state: "sending" })
    expect(makers.consumes).toEqual([])

    // Started again from what it kept: the client asks again with the confirmation it had.
    makers.holdList.release()
    makers.holdList = undefined
    const second = await chatGPTBox(folder)
    const done = await post(second.limits, { row: row!.id, confirm: offered.body.data.confirm })
    expect(done.body.data.outcome).toBe("reset")
    // The box that stopped, had it gone on after all, sends the very same request: nothing more spent.
    await lost
    expect(new Set(makers.consumes.map((each) => each.request)).size).toBe(1)
    expect(makers.consumes[0]!.request).toBe(journal.spends[0].request)
    expect(makers.spends).toBe(1)
    expect(makers.credits.filter((each) => each.status === "available")).toHaveLength(1)
  })

  test("the box stops after its maker spent it and before the answer came: started again, its maker says it's done, and nothing more is spent", async () => {
    const folder = mkdtempSync(join(base, "crash-after-"))
    const first = await chatGPTBox(folder)
    const [row] = first.limits.rows()
    const offered = await post(first.limits, { row: row!.id })
    makers.holdAnswer = new Gate()
    void post(first.limits, { row: row!.id, confirm: offered.body.data.confirm })
    await makers.holdAnswer.reached
    expect(makers.spends).toBe(1)

    // A new box from the journal; the first one's answer never comes.
    const held = makers.holdAnswer
    makers.holdAnswer = undefined
    const second = await chatGPTBox(folder)
    const done = await post(second.limits, { row: row!.id, confirm: offered.body.data.confirm })
    expect(done.body.data.outcome).toBe("reset")
    expect(makers.consumes).toHaveLength(2)
    expect(makers.consumes[1]).toEqual(makers.consumes[0]!)
    expect(makers.spends).toBe(1)
    // A new ask of the same account after: one more, its own request.
    const next = await post(second.limits, { row: row!.id })
    expect((await post(second.limits, { row: row!.id, confirm: next.body.data.confirm })).body.data.outcome).toBe("reset")
    expect(makers.spends).toBe(2)
    held.release()
  })

  test("no answer came (its maker failed after spending it): the box says it may have been used, and Retry, with a new confirmation, goes as the same request and uses nothing more", async () => {
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "unknown-")))
    const [row] = limits.rows()
    makers.failAfterSpending = true
    const first = await post(limits, { row: row!.id })
    const lost = await post(limits, { row: row!.id, confirm: first.body.data.confirm })
    expect(lost.body.data.outcome).toBe("unknown")
    expect(lost.body.data.message).toBe("No answer came, so it may have been used. Asking again won't use another.")
    expect(makers.spends).toBe(1)
    // Retry, as the apps do it: asked again, confirmed again.
    const again = await post(limits, { row: row!.id })
    const done = await post(limits, { row: row!.id, confirm: again.body.data.confirm })
    expect(done.body.data.outcome).toBe("reset")
    expect(makers.consumes.map((each) => each.request)).toEqual([makers.consumes[0]!.request, makers.consumes[0]!.request])
    expect(makers.spends).toBe(1)
    // Settled: the next is a reset of its own.
    const next = await post(limits, { row: row!.id })
    await post(limits, { row: row!.id, confirm: next.body.data.confirm })
    expect(makers.spends).toBe(2)
    expect(new Set(makers.consumes.map((each) => each.request)).size).toBe(2)
  })

  test("its maker turns the chosen credit away (expired since): nothing was used, it says so, and the next ask isn't held to that credit", async () => {
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "refused-")))
    const [row] = limits.rows()
    makers.refuses.add("credit_soon")
    const first = await post(limits, { row: row!.id })
    const refused = await post(limits, { row: row!.id, confirm: first.body.data.confirm })
    expect(refused.body.data.outcome).toBe("failed")
    expect(refused.body.data.message).toBe("Didn't go through. Nothing was used.")
    expect(makers.spends).toBe(0)
    // ChatGPT says it's gone: the list no longer has it, and the next ask uses another.
    makers.credits = makers.credits.filter((each) => each.id !== "credit_soon")
    const again = await post(limits, { row: row!.id })
    expect((await post(limits, { row: row!.id, confirm: again.body.data.confirm })).body.data.outcome).toBe("reset")
    expect(makers.consumes.map((each) => each.credit)).toEqual(["credit_soon", "credit_late"])
    expect(makers.consumes[0]!.request).not.toBe(makers.consumes[1]!.request)
  })

  test("an account with no resets left, or none at all, is refused before anything is offered", async () => {
    makers.credits = []
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "none-")))
    const [row] = limits.rows()
    expect(row!.extras?.find((extra) => extra.kind === "resets")).toMatchObject({ count: 0, usable: false })
    const refused = await post(limits, { row: row!.id })
    expect(refused.status).toBe(409)
    expect(refused.body.message).toBe("This account has no resets left.")
  })
})

/** A box on the in-memory relay, with its real post, directory, limits, peers and resets. */
class Box {
  post = new PeerPost(undefined, still)
  directory = new LinkDirectory(this.post, still)
  limits: Limits
  peers: LimitsPeers
  resets: LimitResets
  parts: PeerParts
  private following = new AbortController()
  constructor(readonly key: string, readonly name: string, accounts: () => LimitedAccount[], folder: string, relay: Map<string, Box>) {
    this.limits = new Limits(accounts, join(folder, "limits.json"), now)
    this.peers = new LimitsPeers(this.limits, this.post, this.directory, undefined, now)
    this.resets = new LimitResets(this.limits, join(folder, "limits-resets.json"), now, this.post, this.directory, 5_000)
    this.parts = { post: this.post, directory: this.directory, limits: this.peers, resets: this.resets }
    relay.set(key, this)
    void this.carry(relay)
  }
  /** Its link: what its bridge sends goes to the box it's for. */
  private async carry(relay: Map<string, Box>) {
    const reader = this.post.follow(this.following.signal).body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const to = relay.get(line.to)
        if (to) queueMicrotask(() => void peerRoutes(to.parts, "POST", ["mail"], async () => ({ from: this.key, mail: structuredClone(line.mail) })).then(beat))
      }
    }
  }
  async meet(others: Box[]) {
    await peerRoutes(this.parts, "PUT", [], async () => ({ self: { key: this.key, name: this.name }, boxes: others.map((box) => ({ key: box.key, name: box.name, seats: true })), bots: [] }))
  }
  stop() {
    this.following.abort()
  }
}
const still: Clock = { setTimeout: () => undefined, clearTimeout: () => {} }

/** Waits that look again each time a mail was given to its box. */
const wakes = new Set<() => void>()
const beat = () => {
  for (const wake of [...wakes]) wake()
}
async function until(condition: () => boolean) {
  while (!condition()) await new Promise<void>((resolve) => wakes.add(function wake() { wakes.delete(wake); resolve() }))
}

/** Claude Code's record of who a Mac's token is for, as it keeps it while it runs (limits.test.ts' `policyRecord`). */
function policyRecord(folder: string, token: string, account: string, organization: string) {
  mkdirSync(folder, { recursive: true })
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
  const body = `sha256:${sha256(`policies of ${account}`)}`
  writeFileSync(join(folder, "policy-limits.json.stamp.json"), JSON.stringify({ v: 1, identity: sha256(`token:${sha256(token).slice(0, 32)}`), kind: "token", sha: body }))
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  writeFileSync(join(folder, "policy-limits.json.signature.json"), JSON.stringify({ jws: `${part({ alg: "ES256" })}.${part({ aud: organization, sub: account, sha: body })}.c2ln` }))
}

class TestClaude extends ClaudeAgent {
  protected override async programVersion() {
    return "2.1.319"
  }
}

const ACCOUNT = "6f1e0c4a-0000-4000-8000-000000000001"
const ORG = "0a1b2c3d-0000-4000-8000-0000000000aa"

/** This Mac's Claude, on Kuvo Code's token: what its turns hear is all it has. */
function macClaude(folder: string) {
  ClaudeAgent.keychain = true
  mkdirSync(join(folder, "claude", "tokens"), { recursive: true })
  writeFileSync(join(folder, "claude", "tokens", "default.json"), JSON.stringify({ token: "mac-token", made: 1 }))
  policyRecord(join(folder, "claude", "home"), "mac-token", ACCOUNT, ORG)
  const agent = new TestClaude({ home: folder, temporary: folder, deps: {} as any }, { id: "default", home: join(folder, "claude", "home") })
  ClaudeAgent.keychain = keychain
  return agent
}

/** A Linux machine's Claude, signed in to Claude Code itself with the same account. */
function linuxClaude(folder: string) {
  ClaudeAgent.keychain = false
  const home = join(folder, "claude", "home")
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "claude-linux", expiresAt: time + 30 * DAY, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x" } }))
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT, organizationUuid: ORG } }))
  const agent = new TestClaude({ home: folder, temporary: folder, deps: {} as any }, { id: "default", home })
  ClaudeAgent.keychain = keychain
  return agent
}

describe("a Mac's Claude token and your other computers", () => {
  test("alone, a Mac's Claude row says its token can't read extra usage or resets, and asking for one says why", async () => {
    const folder = mkdtempSync(join(base, "mac-alone-"))
    const claude = macClaude(folder)
    const limits = new Limits(() => agentAccounts([claude]), undefined, now)
    new LimitResets(limits, join(folder, "limits-resets.json"), now)
    await limits.tick()
    claude.limits.heard!({ id: "five_hour", used: 0.4, minutes: 300 })
    const [row] = limits.rows()
    expect(row!.extras).toEqual([{ id: "resets", name: "Rate Limit Resets", kind: "unreadable", message: MAC_TOKEN_CANT }])
    const refused = await post(limits, { row: row!.id })
    expect(refused.status).toBe(409)
    expect(refused.body.message).toBe(MAC_TOKEN_CANT)
    expect(makers.claims).toEqual([])
  })

  test("with a machine signed in to the same account, the Mac's row has its extra usage and resets, and a reset asked on the Mac is used there, once, and the Mac answers when it is", async () => {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-"))
    const linuxFolder = mkdtempSync(join(base, "hetzner-"))
    const claudeMac = macClaude(macFolder)
    const claudeLinux = linuxClaude(linuxFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay)
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([claudeLinux]), linuxFolder, relay)
    try {
      await mac.meet([hetzner])
      await hetzner.meet([mac])
      await mac.limits.tick()
      claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
      // hetzner reads the account (and its grants), and tells the Mac.
      await hetzner.limits.tick()
      const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
      await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
      const row = merged()!
      expect(row.boxes.map((box) => box.name)).toEqual(["MacBook Pro", "hetzner"])
      expect(row.extras).toEqual([
        { id: "extra_usage", name: "Extra Usage", kind: "capped", amount: 12.4, limit: 50, unit: "usd" },
        { id: "resets", name: "Rate Limit Resets", kind: "resets", count: 2, expiries: [time + 5 * DAY, time + 5 * DAY], refills: ["five_hour", "seven_day"], usable: true, on: { key: "key-hetzner", name: "hetzner" } },
      ])

      const offered = await post(mac.limits, { row: row.id })
      expect(offered.body.data).toMatchObject({ count: 2, refills: ["five_hour", "seven_day"], on: { key: "key-hetzner", name: "hetzner" } })
      const done = await post(mac.limits, { row: row.id, confirm: offered.body.data.confirm, by: "Mira" })
      expect(done.body.data.outcome).toBe("reset")
      // Spent with hetzner's sign-in, against the account's organization, as the grant Anthropic named.
      expect(makers.claims.map((each) => [each.org, each.grant])).toEqual([[ORG, "promo_one"]])
      // The same confirmation again on the Mac: as it went, nothing more asked of hetzner or Anthropic.
      expect((await post(mac.limits, { row: row.id, confirm: offered.body.data.confirm })).body.data.outcome).toBe("reset")
      expect(makers.claims).toHaveLength(1)
      expect(makers.spends).toBe(1)

      // A box that isn't one of yours can't ask hetzner for one.
      await peerRoutes(hetzner.parts, "POST", ["mail"], async () => ({ from: "key-stranger", mail: { kind: "reset", at: time, ask: { id: "x1", row: row.id } } }))
      expect(makers.claims).toHaveLength(1)
    } finally {
      mac.stop()
      hetzner.stop()
    }
  })

  test("Always Allow, set from the Mac, is kept with the account on the machine that spends its resets, and every box says so", async () => {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-always-"))
    const linuxFolder = mkdtempSync(join(base, "hetzner-always-"))
    const claudeMac = macClaude(macFolder)
    const claudeLinux = linuxClaude(linuxFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay)
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([claudeLinux]), linuxFolder, relay)
    try {
      await mac.meet([hetzner])
      await hetzner.meet([mac])
      await mac.limits.tick()
      claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
      await hetzner.limits.tick()
      const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
      await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
      const id = merged()!.id
      expect((await post(mac.limits, { row: id })).body.data.always).toBe(false)

      const response = await limitsRoutes(mac.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))
      expect(response.status).toBe(200)
      const resets = () => merged()?.extras?.find((extra) => extra.kind === "resets")
      await until(() => resets()?.agents === true)
      expect(hetzner.resets.agentsMay("claude-code")).toBe(true)
      expect(resets()!.agents).toBe(true)
      expect((await post(mac.limits, { row: id })).body.data.always).toBe(true)
      // Kept through hetzner's restart, in its journal.
      expect(JSON.parse(readFileSync(join(linuxFolder, "limits-resets.json"), "utf8")).always).toEqual(["claude-code"])

      // Turned off where the account is (Settings › Accounts on hetzner's page).
      await limitsRoutes(hetzner.limits, "PUT", ["reset", "always"], async () => ({ provider: "claude-code", always: false }))
      await until(() => resets()?.agents !== true)
      expect(resets()!.agents).toBeUndefined()
    } finally {
      mac.stop()
      hetzner.stop()
    }
  })
})
