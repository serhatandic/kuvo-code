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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { claudeUsage, MAC_TOKEN_CANT, sameClaudeAccount } from "../../src/agents/agents/claude-limits"
import { codexResetEndpoints } from "../../src/agents/codex-resets"
import { EngineAccounts, engineEndpoints } from "../../src/agents/engine-limits"
import { LinkDirectory, PeerPost, peerRoutes, type PeerParts } from "../../src/agents/groups/post"
import type { Clock } from "../../src/agents/groups/peer"
import { agentAccounts, identityOf, Limits, limitsRoutes, type LimitedAccount } from "../../src/agents/limits"
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
  claims: { org: string; grant: string; request: string; token?: string }[] = []
  /** Held at: a profile request (who a token is for). */
  holdProfile?: Gate
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
  /** The next claim: spent, and answered `reset_unconfirmed`. */
  unconfirmedOnce = false
  /** ChatGPT holding reads of the plan off (a 429 for an hour). */
  holdUsage = false
  /** Anthropic holding reads of the plan off (a 429 for an hour). */
  holdClaude = false
  /** The next claim: spent, then answered with a failure (its answer lost). */
  claimFailsAfterSpending = false
  /** Who each token is for, where it isn't the account the tests sign in to. */
  profiles = new Map<string, { account: string; organization: string }>()
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
        if (this.holdClaude) return new Response("{}", { status: 429, headers: { "retry-after": "3600" } })
        if (url.searchParams.get("cedar_ember") === "1") return Response.json({ cedar_ember: this.grants })
        return Response.json({ five_hour: { utilization: this.fiveHour, resets_at: new Date(time + 3_600_000).toISOString() }, seven_day: { utilization: 40, resets_at: new Date(time + 3 * DAY).toISOString() }, extra_usage: { is_enabled: true, used_credits: 1240, monthly_limit: 5000 } })
      }
      // Who a token is for, as Anthropic says (its profile).
      if (url.pathname === "/api/oauth/profile") {
        await this.holdProfile?.pass()
        const who = this.profiles.get(token) ?? (token.startsWith("claude-") ? { account: ACCOUNT, organization: ORG } : undefined)
        return who ? Response.json({ account: { uuid: who.account }, organization: { uuid: who.organization } }) : new Response("{}", { status: 401 })
      }
      const claim = url.pathname.match(/^\/api\/organizations\/([^/]+)\/reset_rate_limits$/)
      if (claim && request.method === "POST") {
        const body: any = await request.json()
        this.claims.push({ org: claim[1]!, grant: body.grant_id, request: body.request_id, token })
        if (this.spent.has(body.request_id)) return Response.json({ result: "already_used" })
        // Spent, but it can't say so (Anthropic's `reset_unconfirmed`).
        if (this.unconfirmedOnce) {
          this.unconfirmedOnce = false
          const grant = this.grants.grants.find((each) => each.id === body.grant_id)!
          grant.resets_left--
          this.spent.set(body.request_id, grant.id)
          return Response.json({ result: "reset_unconfirmed" })
        }
        const grant = this.grants.grants.find((each) => each.id === body.grant_id)
        if (!grant || grant.resets_left < 1) return Response.json({ result: "unavailable", reason: "no_grant" })
        grant.resets_left--
        this.spent.set(body.request_id, grant.id)
        this.fiveHour = 0
        if (this.claimFailsAfterSpending) {
          this.claimFailsAfterSpending = false
          return new Response("{}", { status: 502 })
        }
        return Response.json({ result: "reset" })
      }
      if (url.pathname === "/wham/usage") {
        if (this.holdUsage) return new Response("{}", { status: 429, headers: { "retry-after": "3600" } })
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
  /** Mail of its own the relay loses (it never reaches the box it's for). */
  loses?: (mail: any) => boolean
  constructor(readonly key: string, readonly name: string, accounts: () => LimitedAccount[], folder: string, relay: Map<string, Box>, peerWait = 5_000, readonly ahead = 0) {
    const clock = () => time + ahead
    this.limits = new Limits(accounts, join(folder, "limits.json"), clock)
    this.peers = new LimitsPeers(this.limits, this.post, this.directory, undefined, clock)
    this.resets = new LimitResets(this.limits, join(folder, "limits-resets.json"), clock, this.post, this.directory, peerWait)
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
        if (this.loses?.(line.mail)) continue
        if (to) queueMicrotask(() => void peerRoutes(to.parts, "POST", ["mail"], async () => ({ from: this.key, mail: structuredClone(line.mail) })).then(beat))
      }
    }
  }
  /**
   * Its link says who your computers are, and `also`, boxes a peer of yours only vouches for;
   * `apart`, those of `others` that aren't your own computers (this box or it a machine two people's
   * Macs share, or in another setup).
   */
  async meet(others: Box[], also: Box[] = [], apart: Box[] = [], shared = false) {
    await peerRoutes(this.parts, "PUT", [], async () => ({ self: { key: this.key, name: this.name }, boxes: others.map((box) => ({ key: box.key, name: box.name, seats: true, ...(apart.includes(box) ? { apart: true } : {}) })), also: also.map((box) => ({ key: box.key, name: box.name })), bots: [], ...(shared ? { setup: null, shared: true } : {}) }))
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
      expect(JSON.parse(readFileSync(join(linuxFolder, "limits-resets.json"), "utf8")).allowed[id]).toEqual({ on: true, at: time, from: "key-mac" })

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

describe("the second review's cases", () => {
  /** A Linux machine's Claude box, alone or among your computers. */
  async function linuxBox(key: string, name: string, relay: Map<string, Box>, peerWait?: number) {
    const folder = mkdtempSync(join(base, `${name}-`))
    const claude = linuxClaude(folder)
    return new Box(key, name, () => agentAccounts([claude]), folder, relay, peerWait)
  }

  test("its maker couldn't say a reset went through: Retry, with a new confirmation, goes as the same request, so a second isn't used", async () => {
    const relay = new Map<string, Box>()
    const box = await linuxBox("key-l", "hetzner", relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      makers.unconfirmedOnce = true
      const first = await post(box.limits, { row: id })
      expect((await post(box.limits, { row: id, confirm: first.body.data.confirm })).body.data.outcome).toBe("unconfirmed")
      expect(makers.spends).toBe(1)
      const again = await post(box.limits, { row: id })
      expect((await post(box.limits, { row: id, confirm: again.body.data.confirm })).body.data.outcome).toBe("reset")
      expect(makers.claims.map((each) => each.request)).toEqual([makers.claims[0]!.request, makers.claims[0]!.request])
      expect(makers.spends).toBe(1)
      expect(makers.grants.grants[0]!.resets_left).toBe(1)
    } finally {
      box.stop()
    }
  })

  test("two confirmations at once (two apps): one request goes, and both hear it went", async () => {
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "twice-")))
    const [row] = limits.rows()
    const one = await post(limits, { row: row!.id })
    const two = await post(limits, { row: row!.id })
    makers.holdAnswer = new Gate()
    const first = post(limits, { row: row!.id, confirm: one.body.data.confirm })
    await makers.holdAnswer.reached
    const second = post(limits, { row: row!.id, confirm: two.body.data.confirm })
    makers.holdAnswer.release()
    expect([(await first).body.data.outcome, (await second).body.data.outcome]).toEqual(["reset", "reset"])
    expect(makers.consumes).toHaveLength(1)
    expect(makers.spends).toBe(1)
  })

  test("Always Allow is the account's: signed in to another account in the same place, agents ask again, and coming back doesn't bring it back", async () => {
    let account = "acct-1"
    const engine = new EngineAccounts(async () => [{ integrationID: "openai", active: true, value: { type: "oauth", access: chatGPTToken(account), refresh: `refresh-${account}`, expires: time + DAY, metadata: { accountID: account } } }])
    const limits = new Limits(() => engine.accounts(), undefined, now, () => engine.refresh(), () => engine.answered)
    const resets = new LimitResets(limits, join(mkdtempSync(join(base, "slot-")), "limits-resets.json"), now)
    await limits.tick()
    const first = limits.rows()[0]!.id
    expect((await limitsRoutes(limits, "PUT", ["reset", "always"], async () => ({ provider: "openai", always: true }))).status).toBe(200)
    expect(resets.agentsMay("openai")).toBe(true)
    expect((await post(limits, { row: first })).body.data.always).toBe(true)

    account = "acct-2"
    time += 11 * 60_000
    await limits.tick()
    const second = limits.rows()[0]!.id
    expect(second).not.toBe(first)
    expect(resets.agentsMay("openai")).toBe(false)
    expect((await post(limits, { row: second })).body.data.always).toBe(false)
    account = "acct-1"
    time += 11 * 60_000
    await limits.tick()
    expect(resets.agentsMay("openai")).toBe(false)
  })

  test("Always Allow set on one of your computers with the sign-in is kept on the other, and turned off on either, it's off on both", async () => {
    const relay = new Map<string, Box>()
    const one = await linuxBox("key-one", "hetzner", relay)
    const two = await linuxBox("key-two", "lokum", relay)
    try {
      await one.meet([two])
      await two.meet([one])
      await one.limits.tick()
      await two.limits.tick()
      // (Each has heard the other is signed in to it.)
      await until(() => one.limits.rows()[0]?.boxes.length === 2 && two.limits.rows()[0]?.boxes.length === 2)
      const id = one.limits.rows()[0]!.id
      expect((await limitsRoutes(one.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))).status).toBe(200)
      await until(() => two.resets.agentsMay("claude-code"))
      expect(one.resets.agentsMay("claude-code")).toBe(true)
      // Off on lokum's page: off on hetzner too.
      await limitsRoutes(two.limits, "PUT", ["reset", "always"], async () => ({ provider: "claude-code", always: false }))
      await until(() => !one.resets.agentsMay("claude-code"))
      expect(two.resets.agentsMay("claude-code")).toBe(false)
    } finally {
      one.stop()
      two.stop()
    }
  })

  test("the answer from the computer with the sign-in is lost: Retry, with a new confirmation, is asked there under the same id, and nothing more is used", async () => {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-lost-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay, 20)
    const hetzner = await linuxBox("key-hetzner", "hetzner", relay)
    try {
      await mac.meet([hetzner])
      await hetzner.meet([mac])
      await mac.limits.tick()
      claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
      await hetzner.limits.tick()
      const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
      await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
      const id = merged()!.id
      // (A minute on: hetzner may read the account again once it's used.)
      time += 2 * 60_000
      // hetzner's first answer never reaches the Mac.
      let lost = 0
      hetzner.loses = (mail) => mail.kind === "reset" && !!mail.answer && lost++ === 0
      const first = await post(mac.limits, { row: id })
      const gone = await post(mac.limits, { row: id, confirm: first.body.data.confirm })
      expect(gone.body.data.outcome).toBe("unknown")
      // (Used there, and read again: hetzner tells the Mac one fewer.)
      await until(() => merged()?.extras?.find((extra) => extra.kind === "resets")?.count === 1)
      expect(makers.claims).toHaveLength(1)
      const again = await post(mac.limits, { row: id })
      expect((await post(mac.limits, { row: id, confirm: again.body.data.confirm })).body.data.outcome).toBe("reset")
      // Asked once of Anthropic: hetzner's journal answered the second ask.
      expect(makers.claims).toHaveLength(1)
      expect(makers.spends).toBe(1)
    } finally {
      mac.stop()
      hetzner.stop()
    }
  })

  test("a box a peer only vouches for hears an account's limits but not its spend or Always Allow, and can't ask for a reset", async () => {
    const relay = new Map<string, Box>()
    const hetznerFolder = mkdtempSync(join(base, "hetzner-v-"))
    const claudeLinux = linuxClaude(hetznerFolder)
    // (An account with credits left, as OpenRouter's is.)
    const credits: LimitedAccount = { provider: "openrouter", service: "openrouter", limits: { every: 600_000, identity: () => "key:sk-or-test", read: async () => ({ windows: [], balance: { left: 7.7, limit: 50, unit: "usd" as const } }) } }
    const hetzner = new Box("key-hetzner", "hetzner", () => [...agentAccounts([claudeLinux]), credits], hetznerFolder, relay)
    const macFolder = mkdtempSync(join(base, "mac-v-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay)
    const otherFolder = mkdtempSync(join(base, "vouched-"))
    const other = new Box("key-other", "another Mac", () => [], otherFolder, relay)
    try {
      await hetzner.meet([mac], [other])
      await mac.meet([hetzner])
      await other.meet([], [hetzner])
      await hetzner.limits.tick()
      const id = hetzner.limits.rows()[0]!.id
      await limitsRoutes(hetzner.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))
      const theirs = () => other.limits.rows().find((row) => row.id === id)
      const ours = () => mac.limits.rows().find((row) => row.id === id)
      await until(() => !!theirs() && !!ours()?.extras?.some((extra) => extra.agents))
      expect(theirs()!.windows.length).toBeGreaterThan(0)
      expect(theirs()!.extras?.map((extra) => extra.kind)).toEqual(["resets"])
      expect(theirs()!.extras?.[0]!.agents).toBeUndefined()
      expect(theirs()!.agentsReset).toBeUndefined()
      // Your own Mac hears all of it.
      expect(ours()!.extras?.map((extra) => extra.kind)).toEqual(["capped", "resets"])
      // Nor what an account has left to spend.
      await until(() => !!other.limits.rows().find((row) => row.service === "openrouter") && !!mac.limits.rows().find((row) => row.service === "openrouter"))
      expect(other.limits.rows().find((row) => row.service === "openrouter")!.balance).toBeUndefined()
      expect(mac.limits.rows().find((row) => row.service === "openrouter")!.balance).toEqual({ left: 7.7, limit: 50, unit: "usd" })
      // And its ask is never taken.
      await peerRoutes(hetzner.parts, "POST", ["mail"], async () => ({ from: "key-other", mail: { kind: "reset", at: time, ask: { id: "v1", row: id } } }))
      expect(makers.claims).toEqual([])
    } finally {
      hetzner.stop()
      mac.stop()
      other.stop()
    }
  })
})

describe("the third review's cases", () => {
  async function linuxBox(key: string, name: string, relay: Map<string, Box>) {
    const folder = mkdtempSync(join(base, `${name}-`))
    const claude = linuxClaude(folder)
    return new Box(key, name, () => agentAccounts([claude]), folder, relay)
  }

  test("Always Allow, and another account signed in between the offer and the spend: nothing is spent from it, and the allowance goes", async () => {
    let account = "acct-1"
    const engine = new EngineAccounts(async () => [{ integrationID: "openai", active: true, value: { type: "oauth", access: chatGPTToken(account), refresh: `refresh-${account}`, expires: time + DAY, metadata: { accountID: account } } }])
    const limits = new Limits(() => engine.accounts(), undefined, now, () => engine.refresh(), () => engine.answered)
    const resets = new LimitResets(limits, join(mkdtempSync(join(base, "between-")), "limits-resets.json"), now)
    await limits.tick()
    const id = limits.rows()[0]!.id
    await limitsRoutes(limits, "PUT", ["reset", "always"], async () => ({ provider: "openai", always: true }))
    const offer = await post(limits, { row: id })
    expect(offer.body.data.always).toBe(true)
    // Signed in to another account in Settings › Accounts, before the box reads it again.
    account = "acct-2"
    await engine.refresh()
    const done = await post(limits, { row: id, confirm: offer.body.data.confirm })
    expect(done.body.data.outcome).toBe("no-reset")
    expect(makers.consumes).toEqual([])
    expect(resets.agentsMay("openai")).toBe(false)
  })

  test("Always Allow on, then off, while the computer with the sign-in is away: the older on, told last, doesn't undo the off", async () => {
    const relay = new Map<string, Box>()
    const box = await linuxBox("key-l", "hetzner", relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      // (As the Mac's link would deliver them: a peer it knows.)
      const tell = (on: boolean, at: number) => box.resets.take("key-mac", { kind: "reset", at, always: { row: id, on, at } })
      ;(box.directory as any).isPeer = (key: string) => key === "key-mac"
      tell(true, time - 2_000)
      tell(false, time - 1_000)
      // The "on" sent again, last.
      tell(true, time - 2_000)
      expect(box.resets.agentsMay("claude-code")).toBe(false)
      // And one turned off here after a queued "on" was decided elsewhere.
      tell(true, time + 1_000)
      expect(box.resets.agentsMay("claude-code")).toBe(true)
      time += 5_000
      await limitsRoutes(box.limits, "PUT", ["reset", "always"], async () => ({ provider: "claude-code", always: false }))
      tell(true, time - 3_000)
      expect(box.resets.agentsMay("claude-code")).toBe(false)
    } finally {
      box.stop()
    }
  })

  test("an off for an account this box doesn't know yet is kept: once it does, the account isn't allowed, and an older on doesn't change that", async () => {
    const folder = mkdtempSync(join(base, "later-"))
    const later = linuxClaude(folder)
    let signedIn = false
    const limits = new Limits(() => (signedIn ? agentAccounts([later]) : []), join(folder, "limits.json"), now)
    const resets = new LimitResets(limits, join(folder, "limits-resets.json"), now)
    const id = `claude#${identityOf(`anthropic:${ACCOUNT}|${ORG}`)}`
    resets.take("key-mac", { kind: "reset", at: time, always: { row: id, on: false, at: time } })
    expect(JSON.parse(readFileSync(join(folder, "limits-resets.json"), "utf8")).allowed[id]).toEqual({ on: false, at: time, from: "key-mac" })
    resets.take("key-mac", { kind: "reset", at: time - 1, always: { row: id, on: true, at: time - 1 } })
    signedIn = true
    await limits.tick()
    expect(limits.rows()[0]!.id).toBe(id)
    expect(resets.agentsMay("claude-code")).toBe(false)
  })

  test("a reset still open, asked again while its maker holds requests off: refused for now, and still open, never 'nothing was used'", async () => {
    const folder = mkdtempSync(join(base, "held-"))
    const { limits } = await chatGPTBox(folder)
    const [row] = limits.rows()
    makers.failAfterSpending = true
    const offer = await post(limits, { row: row!.id })
    expect((await post(limits, { row: row!.id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("unknown")
    // ChatGPT holds reads off now.
    makers.holdUsage = true
    time += 11 * 60_000
    await limits.tick()
    const again = await post(limits, { row: row!.id, confirm: offer.body.data.confirm })
    expect(again.body.data.outcome).toBe("not-now")
    expect(again.body.data.message).toContain("An earlier try may have gone through")
    expect(JSON.parse(readFileSync(join(folder, "limits-resets.json"), "utf8")).spends[0].state).toBe("sending")
    expect(makers.consumes).toHaveLength(1)
  })

  test("a new reset asked well after one that never heard back: that one is settled first from what its maker says, and this one is its own", async () => {
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "later-new-")))
    const [row] = limits.rows()
    makers.failAfterSpending = true
    const first = await post(limits, { row: row!.id })
    expect((await post(limits, { row: row!.id, confirm: first.body.data.confirm })).body.data.outcome).toBe("unknown")
    // A quarter of an hour on, the user wants another.
    time += 15 * 60_000
    const second = await post(limits, { row: row!.id })
    expect((await post(limits, { row: row!.id, confirm: second.body.data.confirm })).body.data.outcome).toBe("reset")
    // The first asked again as itself (ChatGPT: done before), then the new one, its own request.
    expect(makers.consumes.map((each) => each.request)).toEqual([makers.consumes[0]!.request, makers.consumes[0]!.request, makers.consumes[2]!.request])
    expect(makers.consumes[2]!.request).not.toBe(makers.consumes[0]!.request)
    expect(makers.spends).toBe(2)
  })
})

describe("the fourth review's cases", () => {
  /** This Mac (Kuvo Code's Claude token) and hetzner (Claude Code's own sign-in, the same account), on the relay. */
  async function macAndHetzner(peerWait = 20, ahead = 0) {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-4-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay, peerWait)
    const hetznerFolder = mkdtempSync(join(base, "hetzner-4-"))
    const claudeLinux = linuxClaude(hetznerFolder)
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([claudeLinux]), hetznerFolder, relay, 5_000, ahead)
    await mac.meet([hetzner])
    await hetzner.meet([mac])
    await mac.limits.tick()
    claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
    await hetzner.limits.tick()
    const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
    await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
    return { mac, hetzner, macFolder, hetznerFolder, id: merged()!.id, merged, stop: () => (mac.stop(), hetzner.stop()) }
  }
  const journal = (folder: string) => JSON.parse(readFileSync(join(folder, "limits-resets.json"), "utf8"))

  test("no answer came from the computer with the sign-in, then it's held off: the Mac's spend stays open, never 'nothing was used', and Retry goes again", async () => {
    const two = await macAndHetzner()
    try {
      makers.claimFailsAfterSpending = true
      const offer = await post(two.mac.limits, { row: two.id })
      expect((await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("unknown")
      await until(() => makers.claims.length === 1 && !!journal(two.hetznerFolder).spends.length)
      // Anthropic holds hetzner off now.
      makers.holdClaude = true
      time += 16 * 60_000
      await two.hetzner.limits.tick()
      const again = await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm })
      expect(again.body.data.outcome).toBe("not-now")
      expect(again.body.data.message).toContain("An earlier try may have gone through")
      expect(journal(two.macFolder).spends[0].state).toBe("sending")
    } finally {
      two.stop()
    }
  })

  test("a peer's ask more than 10 minutes after an open spend that went through: that one is settled first, and this one is a reset of its own", async () => {
    const two = await macAndHetzner()
    try {
      makers.claimFailsAfterSpending = true
      const offer = await post(two.mac.limits, { row: two.id })
      expect((await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("unknown")
      await until(() => makers.claims.length === 1)
      // A quarter of an hour on, another of your computers asks hetzner for one, as a new ask.
      time += 15 * 60_000
      two.hetzner.resets.take("key-mac", { kind: "reset", at: time, ask: { id: "rsc_new", row: two.id } })
      await until(() => makers.claims.length === 3)
      // The first again as itself (Anthropic: done before), then the new one, its own request.
      expect(makers.claims[1]!.request).toBe(makers.claims[0]!.request)
      expect(makers.claims[2]!.request).not.toBe(makers.claims[0]!.request)
      expect(makers.spends).toBe(2)
    } finally {
      two.stop()
    }
  })

  test("hetzner's clock a minute ahead: Always Allow on there, then off from the Mac within that minute, is off on both", async () => {
    const two = await macAndHetzner(5_000, 60_000)
    try {
      expect((await limitsRoutes(two.hetzner.limits, "PUT", ["reset", "always"], async () => ({ row: two.id, always: true }))).status).toBe(200)
      const resets = () => two.merged()?.extras?.find((extra) => extra.kind === "resets")
      await until(() => resets()?.agents === true)
      time += 10_000
      const off = await limitsRoutes(two.mac.limits, "PUT", ["reset", "always"], async () => ({ row: two.id, always: false }))
      expect(off.status).toBe(200)
      await until(() => resets()?.agents !== true)
      expect(two.hetzner.resets.agentsMay("claude-code")).toBe(false)
      expect((await post(two.mac.limits, { row: two.id })).body.data.always).toBe(false)
    } finally {
      two.stop()
    }
  })

  test("an agent's reset under Always Allow, with it turned off on the computer with the sign-in: refused there, nothing used", async () => {
    const two = await macAndHetzner()
    try {
      // The Mac still thinks it's allowed (it hasn't heard of the off yet).
      two.mac.resets.take("key-hetzner", { kind: "reset", at: time, always: { row: two.id, on: true, at: time } })
      ;(two.hetzner.resets as any).allowed.set(two.id, { on: false, at: time + 1 })
      const offer = await post(two.mac.limits, { row: two.id })
      const done = await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm, unasked: true })
      expect(done.body.data.outcome).toBe("failed")
      expect(done.body.data.message).toBe("Always Allow is off for this account now: nothing was used. Ask the user first.")
      expect(makers.claims).toEqual([])
    } finally {
      two.stop()
    }
  })

  test("two confirmations at once, well after one that never heard back: that one settled first, then one fresh request for both", async () => {
    const { limits } = await chatGPTBox(mkdtempSync(join(base, "two-late-")))
    const [row] = limits.rows()
    makers.failAfterSpending = true
    const first = await post(limits, { row: row!.id })
    expect((await post(limits, { row: row!.id, confirm: first.body.data.confirm })).body.data.outcome).toBe("unknown")
    time += 15 * 60_000
    const a = await post(limits, { row: row!.id })
    const b = await post(limits, { row: row!.id })
    const [one, two] = await Promise.all([post(limits, { row: row!.id, confirm: a.body.data.confirm }), post(limits, { row: row!.id, confirm: b.body.data.confirm })])
    expect([one.body.data.outcome, two.body.data.outcome]).toEqual(["reset", "reset"])
    expect(makers.consumes).toHaveLength(3)
    expect(makers.spends).toBe(2)
  })

  test("the computer with the sign-in can't be reached while a spend is open: it stays open and says an earlier try may have gone, never 'nothing was used'", async () => {
    const two = await macAndHetzner()
    try {
      makers.claimFailsAfterSpending = true
      const offer = await post(two.mac.limits, { row: two.id })
      expect((await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("unknown")
      // hetzner isn't one the Mac reaches now.
      await two.mac.meet([])
      const again = await post(two.mac.limits, { row: two.id, confirm: offer.body.data.confirm })
      expect(again.body.data.outcome).toBe("not-now")
      expect(again.body.data.message).toContain("An earlier try may have gone through")
      expect(journal(two.macFolder).spends).toHaveLength(1)
      expect(journal(two.macFolder).spends[0].state).toBe("sending")
    } finally {
      two.stop()
    }
  })

  test("Claude on Linux: the token is another account's than Claude Code's record says: nothing is spent from it", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "token-"))
    const claude = linuxClaude(folder)
    const box = new Box("key-l", "hetzner", () => agentAccounts([claude]), folder, relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      // Signed in to another account; Claude Code hasn't written its record of it yet.
      makers.profiles.set("claude-linux", { account: "6f1e0c4a-0000-4000-8000-0000000000ff", organization: ORG })
      const offer = await post(box.limits, { row: id })
      expect((await post(box.limits, { row: id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("no-reset")
      expect(makers.claims).toEqual([])
    } finally {
      box.stop()
    }
  })
})

describe("the fifth review's cases", () => {
  /** This Mac and hetzner (the same Claude account), on the relay. */
  async function macAndHetzner(peerWait = 20) {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-5-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay, peerWait)
    const hetznerFolder = mkdtempSync(join(base, "hetzner-5-"))
    const claudeLinux = linuxClaude(hetznerFolder)
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([claudeLinux]), hetznerFolder, relay)
    await mac.meet([hetzner])
    await hetzner.meet([mac])
    await mac.limits.tick()
    claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
    await hetzner.limits.tick()
    const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
    await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
    return { mac, hetzner, hetznerFolder, id: merged()!.id, stop: () => (mac.stop(), hetzner.stop()) }
  }

  test("an agent's reset under Always Allow got no answer, then Always Allow is turned off: the user confirming it is theirs, and it goes through as the same request", async () => {
    const two = await macAndHetzner()
    try {
      await limitsRoutes(two.mac.limits, "PUT", ["reset", "always"], async () => ({ row: two.id, always: true }))
      await until(() => two.hetzner.resets.agentsMay("claude-code"))
      makers.claimFailsAfterSpending = true
      const agent = await post(two.mac.limits, { row: two.id })
      expect((await post(two.mac.limits, { row: two.id, confirm: agent.body.data.confirm, unasked: true })).body.data.outcome).toBe("unknown")
      await until(() => makers.claims.length === 1)
      await limitsRoutes(two.mac.limits, "PUT", ["reset", "always"], async () => ({ row: two.id, always: false }))
      await until(() => !two.hetzner.resets.agentsMay("claude-code"))
      // The user, on the Mac's card: Use.
      const user = await post(two.mac.limits, { row: two.id })
      const done = await post(two.mac.limits, { row: two.id, confirm: user.body.data.confirm })
      expect(done.body.data.outcome).toBe("reset")
      expect(makers.claims.map((each) => each.request)).toEqual([makers.claims[0]!.request, makers.claims[0]!.request])
      expect(makers.spends).toBe(1)
    } finally {
      two.stop()
    }
  })

  test("Claude on Linux whose record of the sign-in leaves out its organization: its token's account matches by the account itself, and a reset goes", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "no-org-"))
    const claude = linuxClaude(folder)
    writeFileSync(join(folder, "claude", "home", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT } }))
    const box = new Box("key-l", "hetzner", () => agentAccounts([claude]), folder, relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      expect(id).toBe(`claude#${identityOf(`anthropic:${ACCOUNT}|`)}`)
      const offer = await post(box.limits, { row: id })
      expect((await post(box.limits, { row: id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("reset")
      expect(makers.spends).toBe(1)
    } finally {
      box.stop()
    }
  })

  test("signed in to another account in a slot: Always Allow for the one before goes off here, and on your other computers too", async () => {
    const relay = new Map<string, Box>()
    const oneFolder = mkdtempSync(join(base, "one-5-"))
    const twoFolder = mkdtempSync(join(base, "two-5-"))
    const claudeOne = linuxClaude(oneFolder)
    const claudeTwo = linuxClaude(twoFolder)
    const one = new Box("key-one", "hetzner", () => agentAccounts([claudeOne]), oneFolder, relay)
    const two = new Box("key-two", "lokum", () => agentAccounts([claudeTwo]), twoFolder, relay)
    try {
      await one.meet([two])
      await two.meet([one])
      await one.limits.tick()
      const id = one.limits.rows()[0]!.id
      await limitsRoutes(one.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))
      await until(() => (two.resets as any).allowed.get(id)?.on === true)
      // hetzner's Claude Code signs in to another account.
      const record = join(oneFolder, "claude", "home", ".claude.json")
      writeFileSync(record, JSON.stringify({ oauthAccount: { accountUuid: "6f1e0c4a-0000-4000-8000-0000000000ee", organizationUuid: ORG, note: "another" } }))
      utimesSync(record, new Date(time + 60_000), new Date(time + 60_000))
      expect(one.resets.agentsMay("claude-code")).toBe(false)
      await until(() => (two.resets as any).allowed.get(id)?.on === false)
    } finally {
      one.stop()
      two.stop()
    }
  })

  test("Claude's token is a newly signed-in account while its record still says the one before: nothing is spent, and the new account's Always Allow stays", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "lag-"))
    const claude = linuxClaude(folder)
    const box = new Box("key-l", "hetzner", () => agentAccounts([claude]), folder, relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      const next = "6f1e0c4a-0000-4000-8000-0000000000dd"
      const nextRow = `claude#${identityOf(`anthropic:${next}|${ORG}`)}`
      ;(box.directory as any).isPeer = () => true
      box.resets.take("key-mac", { kind: "reset", at: time, always: { row: nextRow, on: true, at: time } })
      makers.profiles.set("claude-linux", { account: next, organization: ORG })
      const offer = await post(box.limits, { row: id })
      expect((await post(box.limits, { row: id, confirm: offer.body.data.confirm })).body.data.outcome).toBe("no-reset")
      expect(makers.claims).toEqual([])
      box.resets.agentsMay("claude-code")
      expect((box.resets as any).allowed.get(nextRow)?.on).toBe(true)
    } finally {
      box.stop()
    }
  })
})

describe("the sixth review's cases", () => {
  test("an agent's reset that never heard back, Always Allow turned off since, and the user's Use a quarter of an hour on: it goes the first time, the agent's settled first", async () => {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "mac-6-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-mac", "MacBook Pro", () => agentAccounts([claudeMac]), macFolder, relay, 20)
    const hetznerFolder = mkdtempSync(join(base, "hetzner-6-"))
    const claudeLinux = linuxClaude(hetznerFolder)
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([claudeLinux]), hetznerFolder, relay)
    try {
      await mac.meet([hetzner])
      await hetzner.meet([mac])
      await mac.limits.tick()
      claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
      await hetzner.limits.tick()
      const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
      await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
      const id = merged()!.id
      await limitsRoutes(mac.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))
      await until(() => hetzner.resets.agentsMay("claude-code"))
      makers.claimFailsAfterSpending = true
      const agent = await post(mac.limits, { row: id })
      expect((await post(mac.limits, { row: id, confirm: agent.body.data.confirm, unasked: true })).body.data.outcome).toBe("unknown")
      await until(() => makers.claims.length === 1)
      await limitsRoutes(mac.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: false }))
      await until(() => !hetzner.resets.agentsMay("claude-code"))
      time += 15 * 60_000
      const user = await post(mac.limits, { row: id })
      const done = await post(mac.limits, { row: id, confirm: user.body.data.confirm })
      expect(done.body.data.outcome).toBe("reset")
      // The agent's asked again as itself (done before), then the user's, its own request.
      expect(makers.claims.map((each) => each.request)).toEqual([makers.claims[0]!.request, makers.claims[0]!.request, makers.claims[2]!.request])
      expect(makers.claims[2]!.request).not.toBe(makers.claims[0]!.request)
      expect(makers.spends).toBe(2)
    } finally {
      mac.stop()
      hetzner.stop()
    }
  })

  test("signed in to another account while Anthropic is asked who the sign-in is: the reset is spent with the sign-in that was checked, never the new one", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "switch-"))
    const claude = linuxClaude(folder)
    const box = new Box("key-l", "hetzner", () => agentAccounts([claude]), folder, relay)
    try {
      await box.meet([])
      await box.limits.tick()
      const id = box.limits.rows()[0]!.id
      makers.profiles.set("claude-other", { account: "6f1e0c4a-0000-4000-8000-0000000000cc", organization: ORG })
      makers.holdProfile = new Gate()
      const offer = await post(box.limits, { row: id })
      const spending = post(box.limits, { row: id, confirm: offer.body.data.confirm })
      await makers.holdProfile.reached
      // Claude Code signs in to another account meanwhile.
      writeFileSync(join(folder, "claude", "home", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "claude-other", expiresAt: time + 30 * DAY, scopes: ["user:inference", "user:profile"] } }))
      makers.holdProfile.release()
      expect((await spending).body.data.outcome).toBe("reset")
      expect(makers.claims.map((each) => each.token)).toEqual(["claude-linux"])
    } finally {
      box.stop()
    }
  })

  test("Claude's record and its token's account: one account only where the accounts match, and the organizations where both say one", () => {
    const a = "6f1e0c4a-0000-4000-8000-000000000001", b = "6f1e0c4a-0000-4000-8000-000000000002"
    expect(sameClaudeAccount(`anthropic:${a}|org-1`, `anthropic:${a}|org-1`)).toBe(true)
    expect(sameClaudeAccount(`anthropic:${a}|`, `anthropic:${a}|org-1`)).toBe(true)
    expect(sameClaudeAccount(`anthropic:${a}|org-1`, `anthropic:${a}|org-2`)).toBe(false)
    expect(sameClaudeAccount(`anthropic:${a}|`, `anthropic:${b}|org-1`)).toBe(false)
    expect(sameClaudeAccount(`anthropic:${a}|org-1`, `anthropic:${b}|`)).toBe(false)
    expect(sameClaudeAccount(`anthropic:|`, `anthropic:|`)).toBe(false)
  })
})

describe("a machine two people's Macs set up (#701)", () => {
  /**
   * Ada's Mac, signed in to an account with resets (and extra usage); Bo's Mac; and a machine both
   * set up. Each link says what it does: the machine's peers aren't anyone's own computers there,
   * and each Mac's machine isn't one of its own; each Mac is the other's box a peer vouches for.
   */
  async function shared() {
    const relay = new Map<string, Box>()
    const adaFolder = mkdtempSync(join(base, "ada-"))
    const ada = new Box("key-ada", "Ada's MacBook", () => agentAccounts([linuxClaude(adaFolder)]), adaFolder, relay)
    const bo = new Box("key-bo", "Bo's MacBook", () => [], mkdtempSync(join(base, "bo-")), relay)
    const machine = new Box("key-shared", "shared", () => [], mkdtempSync(join(base, "shared-")), relay)
    await ada.meet([machine], [bo], [machine])
    await bo.meet([machine], [ada], [machine])
    await machine.meet([ada, bo], [], [ada, bo], true)
    await ada.limits.tick()
    const id = ada.limits.rows()[0]!.id
    // (The machine has heard Ada's account.)
    await until(() => !!machine.limits.rows().find((row) => row.id === id))
    return { ada, bo, machine, id, stop: () => [ada, bo, machine].forEach((box) => box.stop()) }
  }

  test("an agent on the machine (Bo's, or anyone's there) can't spend Ada's reset: the machine offers none, and an ask that reaches Ada's box anyway is never taken", async () => {
    const { ada, machine, id, stop } = await shared()
    try {
      const there = machine.limits.rows().find((row) => row.id === id)!
      // Counted there, but no computer there can use them.
      expect(there.extras?.find((extra) => extra.kind === "resets")).toMatchObject({ count: 2, usable: false })
      expect(there.extras?.find((extra) => extra.kind === "resets")?.on).toBeUndefined()
      const asked = await post(machine.limits, { row: id })
      expect(asked.status).toBe(409)
      expect(asked.body.message).toBe("None of your computers can use this account's resets now.")
      // Mail from the machine asking Ada's box to spend one (as a box from before this would send it):
      // never taken, and answered so, so its asker isn't left waiting.
      const answers: any[] = []
      ada.loses = (mail) => {
        if (mail.kind === "reset" && mail.answer) answers.push(mail.answer)
        return false
      }
      await peerRoutes(ada.parts, "POST", ["mail"], async () => ({ from: "key-shared", mail: { kind: "reset", at: time, ask: { id: "s1", row: id, by: "Bo's agent", unasked: true } } }))
      await peerRoutes(ada.parts, "POST", ["mail"], async () => ({ from: "key-shared", mail: { kind: "reset", at: time, ask: { id: "s2", row: id } } }))
      await until(() => answers.length === 2)
      expect(answers).toEqual([
        { id: "s1", outcome: "failed", message: "The computer with its sign-in isn't one of yours now, so it doesn't use your resets: nothing was used." },
        { id: "s2", outcome: "failed", message: "The computer with its sign-in isn't one of yours now, so it doesn't use your resets: nothing was used." },
      ])
      expect(makers.claims).toEqual([])
      expect(makers.spends).toBe(0)
      // Ada's own box still spends its own.
      const own = await post(ada.limits, { row: id })
      expect((await post(ada.limits, { row: id, confirm: own.body.data.confirm })).body.data.outcome).toBe("reset")
      expect(makers.spends).toBe(1)
    } finally {
      stop()
    }
  })

  test("Always Allow never crosses: Ada's on stays off the machine, one set on the machine never reaches Ada's box, and the machine never hears Ada's extra usage", async () => {
    const { ada, machine, id, stop } = await shared()
    try {
      expect((await limitsRoutes(ada.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))).status).toBe(200)
      expect(ada.resets.agentsMay("claude-code")).toBe(true)
      // Ada's box tells the machine its limits again, with what may be told such a box only.
      ada.peers.tell(true)
      await until(() => machine.limits.rows().find((row) => row.id === id)?.extras?.some((extra) => extra.kind === "resets") === true)
      const there = machine.limits.rows().find((row) => row.id === id)!
      expect(there.extras?.map((extra) => extra.kind)).toEqual(["resets"])
      expect(there.extras?.[0]!.agents).toBeUndefined()
      expect(there.agentsReset).toBeUndefined()
      expect((machine.resets as any).allowed.get(id)).toBeUndefined()
      // Set on the machine (by Bo there): it has no computer of yours with the sign-in, and nothing goes to Ada's.
      const set = await limitsRoutes(machine.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: false }))
      expect(set.status).toBe(404)
      // An Always Allow off (or on) mailed from the machine anyway: Ada's box keeps its own.
      await peerRoutes(ada.parts, "POST", ["mail"], async () => ({ from: "key-shared", mail: { kind: "reset", at: time + 60_000, always: { row: id, on: false, at: time + 60_000 } } }))
      expect(ada.resets.agentsMay("claude-code")).toBe(true)
    } finally {
      stop()
    }
  })

  test("Ada's own machine signed in to the same account as the shared machine reads it itself: the shared machine's reading, told without its extra usage, never stands in for it", async () => {
    const relay = new Map<string, Box>()
    const sharedFolder = mkdtempSync(join(base, "shared-same-"))
    const machine = new Box("key-shared", "shared", () => agentAccounts([linuxClaude(sharedFolder)]), sharedFolder, relay)
    const ownFolder = mkdtempSync(join(base, "own-same-"))
    const own = new Box("key-own", "hetzner", () => agentAccounts([linuxClaude(ownFolder)]), ownFolder, relay)
    try {
      await machine.meet([own], [], [own])
      await own.meet([machine], [], [machine])
      // The shared machine reads it first, and tells Ada's machine (only what such a box is told).
      await machine.limits.tick()
      const id = machine.limits.rows()[0]!.id
      await until(() => own.limits.rows().some((row) => row.id === id))
      await own.limits.tick()
      const row = own.limits.rows().find((each) => each.id === id)!
      expect(row.boxes.map((box) => box.name).sort()).toEqual(["hetzner", "shared"])
      expect(row.extras?.map((extra) => extra.kind)).toEqual(["capped", "resets"])
      expect(row.extras?.find((extra) => extra.kind === "resets")?.on).toEqual({ key: "key-own", name: "hetzner", here: true })
    } finally {
      machine.stop()
      own.stop()
    }
  })

  test("Always Allow Ada set before Bo's Mac also set up her machine is forgotten there once it's shared: agents there ask again, and a later word from Ada's Mac isn't taken", async () => {
    const relay = new Map<string, Box>()
    const macFolder = mkdtempSync(join(base, "ada-mac-"))
    const claudeMac = macClaude(macFolder)
    const mac = new Box("key-ada", "Ada's MacBook", () => agentAccounts([claudeMac]), macFolder, relay)
    const machineFolder = mkdtempSync(join(base, "ada-machine-"))
    const machine = new Box("key-shared", "shared", () => agentAccounts([linuxClaude(machineFolder)]), machineFolder, relay)
    const bo = new Box("key-bo", "Bo's MacBook", () => [], mkdtempSync(join(base, "bo-later-")), relay)
    try {
      await mac.meet([machine])
      await machine.meet([mac])
      await mac.limits.tick()
      claudeMac.limits.heard!({ id: "five_hour", used: 0.9, minutes: 300 })
      await machine.limits.tick()
      const merged = () => mac.limits.rows().find((row) => row.boxes.length === 2)
      await until(() => !!merged()?.extras?.some((extra) => extra.kind === "resets"))
      const id = merged()!.id
      await limitsRoutes(mac.limits, "PUT", ["reset", "always"], async () => ({ row: id, always: true }))
      await until(() => machine.resets.agentsMay("claude-code"))
      // Bo's Mac sets the machine up too: its link says it's shared, and neither Mac is one of its own computers now.
      await machine.meet([mac, bo], [], [mac, bo], true)
      expect(machine.resets.agentsMay("claude-code")).toBe(false)
      expect(JSON.parse(readFileSync(join(machineFolder, "limits-resets.json"), "utf8")).allowed[id]).toMatchObject({ on: false, from: "" })
      // Ada's Mac saying it again (it doesn't know yet) changes nothing there.
      await peerRoutes(machine.parts, "POST", ["mail"], async () => ({ from: "key-ada", mail: { kind: "reset", at: time + 1_000, always: { row: id, on: true, at: time + 1_000 } } }))
      expect(machine.resets.agentsMay("claude-code")).toBe(false)
    } finally {
      for (const box of [mac, machine, bo]) box.stop()
    }
  })

  test("an Always Allow kept by a box from before this, which didn't say whose it was, goes once the machine is shared; on a box alone, it stays", async () => {
    const relay = new Map<string, Box>()
    const id = `claude#${identityOf(`anthropic:${ACCOUNT}|${ORG}`)}`
    const kept = (folder: string) => writeFileSync(join(folder, "limits-resets.json"), JSON.stringify({ spends: [], allowed: { [id]: { on: true, at: time } }, seen: { "claude-code": id } }))
    const sharedFolder = mkdtempSync(join(base, "legacy-shared-"))
    kept(sharedFolder)
    const machine = new Box("key-shared", "shared", () => agentAccounts([linuxClaude(sharedFolder)]), sharedFolder, relay)
    const aloneFolder = mkdtempSync(join(base, "legacy-alone-"))
    kept(aloneFolder)
    const alone = new Box("key-alone", "alone", () => agentAccounts([linuxClaude(aloneFolder)]), aloneFolder, relay)
    const ada = new Box("key-ada", "Ada's MacBook", () => [], mkdtempSync(join(base, "legacy-ada-")), relay)
    const bo = new Box("key-bo", "Bo's MacBook", () => [], mkdtempSync(join(base, "legacy-bo-")), relay)
    try {
      await machine.meet([ada, bo], [], [ada, bo], true)
      await alone.meet([])
      await machine.limits.tick()
      await alone.limits.tick()
      expect(machine.resets.agentsMay("claude-code")).toBe(false)
      expect(alone.resets.agentsMay("claude-code")).toBe(true)
    } finally {
      for (const box of [machine, alone, ada, bo]) box.stop()
    }
  })

  test("Always Allow Ada set on the machine's own page goes once Bo's Mac also sets it up; one set there after stays, through the link saying it again and a restart", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "own-page-"))
    const machine = new Box("key-shared", "shared", () => agentAccounts([linuxClaude(folder)]), folder, relay)
    const ada = new Box("key-ada", "Ada's MacBook", () => [], mkdtempSync(join(base, "own-page-ada-")), relay)
    const bo = new Box("key-bo", "Bo's MacBook", () => [], mkdtempSync(join(base, "own-page-bo-")), relay)
    try {
      await machine.meet([ada])
      await machine.limits.tick()
      const id = machine.limits.rows()[0]!.id
      // On the machine's own page (or from a card in a conversation there).
      await limitsRoutes(machine.limits, "PUT", ["reset", "always"], async () => ({ provider: "claude-code", always: true }))
      expect(machine.resets.agentsMay("claude-code")).toBe(true)
      await machine.meet([ada, bo], [], [ada, bo], true)
      expect(machine.resets.agentsMay("claude-code")).toBe(false)
      // Once only: set there again now, it stays through what the link says next, and a restart.
      time += 1_000
      await limitsRoutes(machine.limits, "PUT", ["reset", "always"], async () => ({ provider: "claude-code", always: true }))
      await machine.meet([ada, bo], [], [ada, bo], true)
      expect(machine.resets.agentsMay("claude-code")).toBe(true)
      const again = new LimitResets(machine.limits, join(folder, "limits-resets.json"), now, machine.post, machine.directory)
      expect(again.agentsMay("claude-code")).toBe(true)
      void id
    } finally {
      for (const box of [machine, ada, bo]) box.stop()
    }
  })

  test("a decision a peer told stays while the link only leaves that peer out for a moment; one of your own Mac's from before this stays though its only machine is shared", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "moment-"))
    const hetzner = new Box("key-hetzner", "hetzner", () => agentAccounts([linuxClaude(folder)]), folder, relay)
    const mac = new Box("key-mac", "MacBook Pro", () => [], mkdtempSync(join(base, "moment-mac-")), relay)
    try {
      await hetzner.meet([mac])
      await hetzner.limits.tick()
      const id = hetzner.limits.rows()[0]!.id
      await peerRoutes(hetzner.parts, "POST", ["mail"], async () => ({ from: "key-mac", mail: { kind: "reset", at: time, always: { row: id, on: true, at: time } } }))
      expect(hetzner.resets.agentsMay("claude-code")).toBe(true)
      // The link says your computers without the Mac for a moment (its keys not read yet), then with it.
      await hetzner.meet([])
      await hetzner.meet([mac])
      expect(hetzner.resets.agentsMay("claude-code")).toBe(true)
    } finally {
      hetzner.stop()
      mac.stop()
    }
    // A Mac whose one machine another setup's Mac shares (that machine apart, the Mac itself not shared): what it kept from before this stays.
    const own = mkdtempSync(join(base, "moment-own-"))
    const row = `claude#${identityOf(`anthropic:${ACCOUNT}|${ORG}`)}`
    writeFileSync(join(own, "limits-resets.json"), JSON.stringify({ spends: [], allowed: { [row]: { on: true, at: time } }, seen: { "claude-code": row } }))
    const box = new Box("key-own", "hetzner", () => agentAccounts([linuxClaude(own)]), own, relay)
    const shared = new Box("key-shared-2", "shared", () => [], mkdtempSync(join(base, "moment-shared-")), relay)
    try {
      await box.meet([shared], [], [shared])
      await box.limits.tick()
      expect(box.resets.agentsMay("claude-code")).toBe(true)
    } finally {
      box.stop()
      shared.stop()
    }
  })

  test("a spend a box began for a Mac that isn't one of its own any more is answered as it went, never 'nothing was used' for one that went", async () => {
    const relay = new Map<string, Box>()
    const folder = mkdtempSync(join(base, "begun-"))
    const machine = new Box("key-shared", "shared", () => agentAccounts([linuxClaude(folder)]), folder, relay)
    const ada = new Box("key-ada", "Ada's MacBook", () => [], mkdtempSync(join(base, "begun-ada-")), relay)
    try {
      await machine.meet([ada])
      await machine.limits.tick()
      const id = machine.limits.rows()[0]!.id
      const answers: any[] = []
      machine.loses = (mail) => {
        if (mail.kind === "reset" && mail.answer) answers.push(mail.answer)
        return false
      }
      await peerRoutes(machine.parts, "POST", ["mail"], async () => ({ from: "key-ada", mail: { kind: "reset", at: time, ask: { id: "b1", row: id } } }))
      await until(() => answers.length === 1)
      expect(answers[0]).toMatchObject({ id: "b1", outcome: "reset" })
      // Shared now: Ada's Mac asks again (its answer was lost), and a new one.
      await machine.meet([ada], [], [ada], true)
      await peerRoutes(machine.parts, "POST", ["mail"], async () => ({ from: "key-ada", mail: { kind: "reset", at: time, ask: { id: "b1", row: id } } }))
      await peerRoutes(machine.parts, "POST", ["mail"], async () => ({ from: "key-ada", mail: { kind: "reset", at: time, ask: { id: "b2", row: id } } }))
      await until(() => answers.length === 3)
      expect(answers[1]).toEqual({ id: "b1", outcome: "reset", already: true })
      expect(answers[2]).toEqual({ id: "b2", outcome: "failed", message: "The computer with its sign-in isn't one of yours now, so it doesn't use your resets: nothing was used." })
      expect(makers.spends).toBe(1)
    } finally {
      machine.stop()
      ada.stop()
    }
  })

  test("the machine's own box, told by a box from before this the whole of Ada's account, keeps only what such a box is told", async () => {
    const { machine, id, stop } = await shared()
    try {
      // As Ada's box sent it before it knew the machine is shared: its extra usage, and Always Allow on.
      const full = { provider: "claude-code", service: "claude", identity: id.split("#")[1], windows: [{ id: "five_hour", used: 0.5, minutes: 300, read: time }], balance: { left: 3, unit: "usd" }, extras: [{ id: "extra_usage", name: "Extra Usage", kind: "capped", amount: 12.4, limit: 50, unit: "usd" }, { id: "resets", name: "Rate Limit Resets", kind: "resets", count: 2, usable: true, agents: true }], agentsReset: true, checked: time }
      await peerRoutes(machine.parts, "POST", ["mail"], async () => ({ from: "key-ada", mail: { kind: "limits", at: time, accounts: [full] } }))
      const there = machine.limits.rows().find((row) => row.id === id)!
      expect(there.balance).toBeUndefined()
      expect(there.agentsReset).toBeUndefined()
      expect(there.extras).toEqual([{ id: "resets", name: "Rate Limit Resets", kind: "resets", count: 2, usable: false }])
    } finally {
      stop()
    }
  })
})
