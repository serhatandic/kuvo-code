// What your accounts used, as the box states it (`api/kuvo/usage`, PROTOCOL.md "Usage history"):
// read from each Claude account's own logs here, priced as UsageKit prices them (the same fixtures
// as UsageKit's `UsageBoxParityTests`), by the hour, answered as days in the time zone a client
// asks for, kept through a restart, and added up across your computers. Logs, prices and the
// feeds are synthetic stand-ins; no sign-in is read and no maker is asked.

import "../safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { CodexAgent } from "../../src/agents/agents/codex"
import type { Agent } from "../../src/agents/agent"
import { subscribe } from "../../src/agents/events"
import { LinkDirectory, PeerPost, peerRoutes, type PeerParts } from "../../src/agents/groups/post"
import type { Clock } from "../../src/agents/groups/peer"
import { claudeLine, dedupClaude } from "../../src/agents/usage/claude-log"
import { claudeSlots, daysIn } from "../../src/agents/usage/history"
import { bundledPricing, catalogFromCompact, Pricing, PricingStore, supplementFrom, type PricingFetch } from "../../src/agents/usage/pricing"
import { claudeSources, codexSources, engineHostedSources, thisComputer, Usage, usageRoutes, UsageSettings, uuidOf, type UsageSource } from "../../src/agents/usage/usage"
import { Database } from "bun:sqlite"
import { isRealBridgeFolder } from "../../src/shared/account"
import { digestOf, UsagePeers, type UsageMail } from "../../src/agents/usage/usage-peers"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-usage-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const fixtures = join(import.meta.dir, "..", "fixtures", "usage")
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"))

const HOUR = 3_600_000
const MINUTE = 60_000

describe("as UsageKit reads and prices them", () => {
  test("Claude's logs: the lines that count, deduplicated, priced, by the day (UsageKit's ClaudeLogUsageScanner)", () => {
    const expected = fixture("claude-expected.json")
    const pricing = new Pricing(supplementFrom(fixture("pricing-supplement.json")), catalogFromCompact(fixture("pricing-litellm.json")), catalogFromCompact(fixture("pricing-models-dev.json")))
    const entries = (expected.files as string[]).flatMap((file) =>
      readFileSync(join(fixtures, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => claudeLine(Buffer.from(line))),
    )
    const days = daysIn(claudeSlots(dedupClaude(entries), pricing, Date.parse(expected.since)), "UTC", Date.parse(expected.now))
    const priced = days.filter((day) => day.models.length)
    expect(priced.map((day) => day.date)).toEqual(expected.days.map((day: any) => day.date))
    priced.forEach((day, index) => {
      const want = expected.days[index]
      expect(day.tokens).toBe(want.tokens)
      expect(day.cost).toBeCloseTo(want.cost, 9)
      expect(day.models.map((model) => [model.model, model.tokens])).toEqual(want.models.map((model: any) => [model.model, model.tokens]))
      day.models.forEach((model, at) => expect(model.cost).toBeCloseTo(want.models[at].cost, 9))
    })
    expect(Object.fromEntries(days.filter((day) => day.unknown).map((day) => [day.date, day.unknown]))).toEqual(expected.unknown)
  })

  test("the bundled prices name each model's rates as UsageKit's do: aliases, fast variants, fuzzy keys, models.dev, none", () => {
    const pricing = bundledPricing()
    for (const [model, want] of Object.entries(fixture("pricing-expected.json") as Record<string, any>)) {
      const found = pricing.resolve(model)
      if (want === null) {
        expect(found, model).toBeUndefined()
        continue
      }
      expect(found, model).toBeDefined()
      const got = { input: found!.input, output: found!.output, cacheWrite: found!.cacheWrite, cacheRead: found!.cacheRead, inputAbove: found!.inputAbove ?? null, outputAbove: found!.outputAbove ?? null, cacheWriteAbove: found!.cacheWriteAbove ?? null, cacheReadAbove: found!.cacheReadAbove ?? null, fast: found!.fast }
      expect(got, model).toEqual(want)
    }
  })
})

class TestClaude extends ClaudeAgent {
  constructor(home: string, instance?: { id: string; label?: string; home?: string }) {
    super({ home, temporary: home, deps: {} as any }, instance)
  }
}

/** A line Claude Code writes for a reply: its usage, at `at`. */
function reply(at: string, id: string, model: string, input: number, output: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "assistant", timestamp: at, sessionId: "s", version: "2.1.300", requestId: `req_${id}`, message: { id: `msg_${id}`, model, role: "assistant", usage: { input_tokens: input, output_tokens: output } }, ...extra }) + "\n"
}

describe("one box", () => {
  let home: string
  let account: string
  let agent: TestClaude
  let at: number
  let identity: string | undefined
  const now = () => at
  const make = (folder = join(home, "usage")) => {
    const sources = claudeSources(folder)
    return new Usage(() => sources([agent as unknown as Agent]), new PricingStore(undefined, null), () => identity, join(folder, "usage.json"), now)
  }
  const route = async (usage: Usage, zone?: string, method = "GET", rest: string[] = []) => ((await (await usageRoutes(usage, method, rest, new URLSearchParams(zone ? { zone } : {}))).json()) as any).data

  beforeEach(() => {
    home = mkdtempSync(join(base, "box-"))
    account = join(home, "claude", "accounts", "work")
    mkdirSync(join(account, "projects", "-work-site"), { recursive: true })
    agent = new TestClaude(home, { id: "work", label: "Work", home: account })
    at = Date.parse("2026-11-12T21:00:00Z")
    identity = "0123456789abcdef"
  })

  test("an account's logs as days in the zone a client asks for: late evening in UTC is the next day in Istanbul", async () => {
    const log = join(account, "projects", "-work-site", "one.jsonl")
    writeFileSync(log, reply("2026-11-11T22:30:00Z", "1", "claude-opus-4-5", 1000, 1000) + reply("2026-11-12T09:00:00Z", "2", "claude-opus-4-5", 2000, 0))
    const usage = make()
    const updated: unknown[] = []
    const stop = subscribe((event) => event.type === "kuvo.usage.updated" && updated.push(event.data))
    await usage.refresh()
    stop()
    expect(updated.length).toBe(1)

    const istanbul = await route(usage, "Europe/Istanbul")
    expect(istanbul.zone).toBe("Europe/Istanbul")
    expect(istanbul.services).toEqual(["claude", "codex", "grok", "opencode", "cursor", "antigravity"])
    expect(istanbul.rows).toHaveLength(1)
    const row = istanbul.rows[0]
    expect(row).toMatchObject({ id: "claude#0123456789abcdef", service: "claude", provider: "claude-code@work", agent: "claude", account: "work", label: "Work", identity: "0123456789abcdef", scanned: at })
    expect(row.boxes).toEqual([{ key: "", name: "", provider: "claude-code@work", agent: "claude", account: "work", label: "Work", scanned: at, here: true }])
    // Both replies on the 12th in Istanbul (the first at half past one at night)…
    expect(row.days.map((day: any) => [day.date, day.tokens])).toEqual([["2026-11-12", 4000]])
    expect(row.days[0].cost).toBeCloseTo((1000 * 5 + 1000 * 25 + 2000 * 5) / 1e6, 9)
    expect(istanbul.totals.claude).toEqual(row.days)
    // …and on two days in UTC.
    const utc = await route(usage, "UTC")
    expect(utc.rows[0].days.map((day: any) => [day.date, day.tokens])).toEqual([
      ["2026-11-12", 2000],
      ["2026-11-11", 2000],
    ])
    // India's half hour: a quarter past midnight there is the 12th.
    writeFileSync(join(account, "projects", "-work-site", "two.jsonl"), reply("2026-11-11T18:45:00Z", "3", "claude-opus-4-5", 5, 0))
    await usage.refresh()
    expect((await route(usage, "Asia/Kolkata")).rows[0].days.map((day: any) => [day.date, day.tokens])).toEqual([["2026-11-12", 4005]])
    // A zone this computer doesn't know: its own.
    expect((await route(usage, "Mars/Olympus")).zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  test("a log as it grows is read on from where it was; one rewritten shorter is read again whole; the numbers stay through a restart", async () => {
    const log = join(account, "projects", "-work-site", "one.jsonl")
    writeFileSync(log, reply("2026-11-12T10:00:00Z", "1", "claude-opus-4-5", 1000, 0))
    let usage = make()
    await usage.refresh()
    expect((await route(usage, "UTC")).rows[0].days[0].tokens).toBe(1000)

    // Claude Code writes the next reply, the last line not whole yet: only what's whole counts.
    appendFileSync(log, reply("2026-11-12T10:05:00Z", "2", "claude-opus-4-5", 500, 0) + reply("2026-11-12T10:06:00Z", "3", "claude-opus-4-5", 7, 0).slice(0, 40))
    at += 5 * MINUTE
    await usage.refresh()
    expect((await route(usage, "UTC")).rows[0].days[0].tokens).toBe(1500)
    appendFileSync(log, reply("2026-11-12T10:06:00Z", "3", "claude-opus-4-5", 7, 0).slice(40))
    await usage.refresh()
    expect((await route(usage, "UTC")).rows[0].days[0].tokens).toBe(1507)

    // A restart: what was read is there before the logs are read again.
    usage = make()
    expect((await route(usage, "UTC")).rows[0].days[0].tokens).toBe(1507)
    expect(readdirSync(join(home, "usage")).sort()).toEqual(["claude-files", "usage.json"])
    expect(readdirSync(join(home, "usage", "claude-files"))).toHaveLength(1)

    // The log rewritten, shorter: only what it says now.
    writeFileSync(log, reply("2026-11-12T11:00:00Z", "9", "claude-opus-4-5", 42, 0))
    await usage.refresh()
    expect((await route(usage, "UTC")).rows[0].days[0].tokens).toBe(42)
  })

  test("a subagent's log replaying its parent's reply counts once; an account removed goes; one with no identity yet is its box's own row", async () => {
    mkdirSync(join(account, "projects", "-work-site", "s", "subagents"), { recursive: true })
    writeFileSync(join(account, "projects", "-work-site", "s.jsonl"), reply("2026-11-12T10:00:00Z", "p", "claude-opus-4-5", 100, 0))
    writeFileSync(join(account, "projects", "-work-site", "s", "subagents", "a.jsonl"), JSON.stringify({ ...JSON.parse(reply("2026-11-12T10:00:01Z", "p", "claude-opus-4-5", 100, 900)), requestId: "req_other", isSidechain: true }) + "\n")
    identity = undefined
    let agents: Agent[] = [agent as unknown as Agent]
    const sources = claudeSources(join(home, "usage"))
    const usage = new Usage(() => sources(agents), new PricingStore(undefined, null), () => identity, join(home, "usage", "usage.json"), now)
    await usage.refresh()
    const row = (await route(usage, "UTC")).rows[0]
    expect(row.id).toBe("/claude-code@work")
    expect(row.identity).toBeUndefined()
    expect(row.days[0].tokens).toBe(100)

    agents = []
    await usage.refresh()
    expect((await route(usage, "UTC")).rows).toEqual([])
  })

  test("a client's days are today and the 30 before it, in its zone", async () => {
    const log = join(account, "projects", "-work-site", "one.jsonl")
    writeFileSync(log, reply("2026-10-12T10:00:00Z", "out", "claude-opus-4-5", 10, 0) + reply("2026-10-13T10:00:00Z", "in", "claude-opus-4-5", 1, 0) + reply("2026-11-12T10:00:00Z", "new", "claude-opus-4-5", 100, 0))
    const usage = make()
    await usage.refresh()
    expect((await route(usage, "UTC")).rows[0].days.map((day: any) => day.date)).toEqual(["2026-11-12", "2026-10-13"])
  })
})

describe("prices kept current", () => {
  const liteLLM = (model: string, input: number) => JSON.stringify({ [model]: { input_cost_per_token: input / 1e6, output_cost_per_token: (input * 5) / 1e6 } })

  test("fetched hourly with what it was last sent, used from the next scan on, kept for the next start; a feed that fails or says nonsense changes nothing", async () => {
    const folder = mkdtempSync(join(base, "pricing-"))
    let at = Date.parse("2026-11-12T09:00:00Z")
    const asked: { url: string; etag?: string }[] = []
    let answer: (url: string) => Response = (url) => (url.includes("litellm") ? new Response(liteLLM("brand-new-model", 2), { headers: { etag: '"v1"' } }) : new Response("", { status: 500 }))
    const fetcher: PricingFetch = async (url, init) => {
      asked.push({ url, ...(init.headers["If-None-Match"] ? { etag: init.headers["If-None-Match"] } : {}) })
      return answer(url)
    }
    let store = new PricingStore(folder, fetcher, () => at)
    expect(store.current().resolve("brand-new-model")).toBeUndefined()
    await store.refreshNow()
    expect(asked.map((each) => each.url.split("/")[2])).toEqual(["raw.githubusercontent.com", "models.dev", "robinebers.github.io"])
    expect(store.current().resolve("brand-new-model")?.input).toBe(2)
    // (The bundled catalog's models stay beside it.)
    expect(store.current().resolve("claude-opus-4-5")?.input).toBe(5)

    // Within the hour: nothing asked. The two that failed: not again for half an hour.
    asked.length = 0
    at += 20 * MINUTE
    await store.refreshNow()
    expect(asked).toEqual([])
    at += 41 * MINUTE
    answer = (url) => (url.includes("litellm") ? new Response(null, { status: 304 }) : new Response("not json"))
    await store.refreshNow()
    expect(asked.find((each) => each.url.includes("litellm"))?.etag).toBe('"v1"')
    expect(store.current().resolve("brand-new-model")?.input).toBe(2)

    // The next start: what was fetched, without asking.
    store = new PricingStore(folder, null, () => at)
    expect(store.current().resolve("brand-new-model")?.input).toBe(2)
    rmSync(folder, { recursive: true, force: true })
  })

  test("only a real box's bridge fetches them, a Mac app's or a machine's: never one a test started in a folder of its own", () => {
    const account = mkdtempSync(join(base, "account-"))
    expect(isRealBridgeFolder(join(account, "Library", "Application Support", "run.kuvo.code", "agents"), account)).toBe(true)
    expect(isRealBridgeFolder(join(account, "Library", "Application Support", "run.kuvo.code.debug", "agents"), account)).toBe(true)
    expect(isRealBridgeFolder(join(account, ".kuvo-code", "agents"), account)).toBe(true)
    // The Mac app's tests (`<their folder>/Support/agents`), a bridge test's, and a machine's own folder in another home.
    expect(isRealBridgeFolder(join(account, "tests", "Support", "agents"), account)).toBe(false)
    expect(isRealBridgeFolder(join(base, "bridge-test", "agents"), account)).toBe(false)
    expect(isRealBridgeFolder(join(base, "elsewhere", ".kuvo-code", "agents"), account)).toBe(false)
  })

  test("new prices price the next round: a model that was unknown gets its dollars", async () => {
    const home = mkdtempSync(join(base, "priced-"))
    const account = join(home, "acct")
    mkdirSync(join(account, "projects", "p"), { recursive: true })
    writeFileSync(join(account, "projects", "p", "x.jsonl"), reply("2026-11-12T10:00:00Z", "1", "brand-new-model", 1_000_000, 0))
    const agent = new TestClaude(home, { id: "acct", home: account })
    let answers = 0
    const store = new PricingStore(join(home, "pricing"), async (url) => (url.includes("litellm") && ++answers ? new Response(liteLLM("brand-new-model", 3)) : new Response("", { status: 500 })), () => Date.parse("2026-11-12T12:00:00Z"))
    const sources = claudeSources(join(home, "usage"))
    const usage = new Usage(() => sources([agent as unknown as Agent]), store, () => undefined, undefined, () => Date.parse("2026-11-12T12:00:00Z"))
    // (Its first round prices with what's bundled, and starts the fetch.)
    await usage.refresh()
    await store.refreshNow()
    await usage.refresh()
    const day = (usage.view("UTC").rows[0]!.days[0])!
    expect(day.unknown).toBeUndefined()
    expect(day.cost).toBeCloseTo(3, 9)
    rmSync(home, { recursive: true, force: true })
  })
})

// --- Across your computers ---

const still: Clock = { setTimeout: () => undefined, clearTimeout: () => {} }

/** Carries each box's post to the box it's for, through its peer routes, as the link does. */
class Relay {
  boxes = new Map<string, PeerBox>()
  off = new Set<string>()
  sent: { from: string; to: string; mail: UsageMail }[] = []
  /** What the boxes' bridges sent, and what of it is where it went (or lost to one that's off). */
  posted = 0
  done = 0
  carry(from: string, to: string, mail: any) {
    this.sent.push({ from, to, mail })
    if (this.off.has(from) || this.off.has(to)) {
      this.done++
      return
    }
    queueMicrotask(async () => {
      const target = this.boxes.get(to)
      if (target) await peerRoutes(target.parts, "POST", ["mail"], async () => ({ from, mail: structuredClone(mail) }))
      this.done++
    })
  }
  /** Once every mail sent is where it went (and what that set off, sent and there too). */
  async settled() {
    while (this.done < this.posted) await new Promise((resolve) => setImmediate(resolve))
  }
}

/** A box's real post, counting what its bridge sends. */
class Post extends PeerPost {
  constructor(private readonly counted: () => void) {
    super(undefined, still)
  }
  override send(...given: Parameters<PeerPost["send"]>) {
    this.counted()
    super.send(...given)
  }
}

class PeerBox {
  post: PeerPost
  directory: LinkDirectory
  usage: Usage
  peers: UsagePeers
  parts: PeerParts
  private following = new AbortController()
  agents: Agent[]
  /** Codex's fallback model here, as the box keeps it (`UsageSettings`). */
  readonly settings = new UsageSettings()
  get fallback() {
    return this.settings.codexFallback
  }
  set fallback(model: string | undefined) {
    this.settings.setCodexFallback(model ?? null)
  }

  constructor(
    readonly key: string,
    readonly name: string,
    relay: Relay,
    readonly home: string,
    agents: (TestClaude | CodexAgent)[],
    identity: (provider: string) => string | undefined,
    now: () => number,
    most?: number,
    /** The computer it's on (`thisComputer`): this one's, unless a test stands in another. */
    computer?: string,
    /** Its other sources (the engine's hosted models'). */
    extra: () => UsageSource[] = () => [],
  ) {
    this.agents = agents as unknown as Agent[]
    this.post = new Post(() => relay.posted++)
    this.directory = new LinkDirectory(this.post, still)
    const sources = claudeSources(join(home, "usage"), computer === undefined ? undefined : () => computer)
    const codex = codexSources(join(home, "usage"), () => this.fallback, computer === undefined ? undefined : () => computer)
    this.usage = new Usage(() => [...sources(this.agents), ...codex(this.agents), ...extra()], new PricingStore(undefined, null), identity, join(home, "usage", "usage.json"), now)
    this.usage.settings = this.settings
    this.peers = new UsagePeers(this.usage, this.post, this.directory, join(home, "usage", "peers.json"), now, most)
    this.parts = { post: this.post, directory: this.directory, usage: this.peers }
    relay.boxes.set(key, this)
    void this.link(relay)
  }

  private async link(relay: Relay) {
    const reader = this.post.follow(this.following.signal).body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const read = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (read.done) return
      buffer += decoder.decode(read.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line) continue
        const given = JSON.parse(line)
        relay.carry(this.key, given.to, given.mail)
      }
    }
  }

  /** Its link says who your computers are; `apart`, those of `others` that aren't your own (this box or it a machine two people's Macs share, or in another setup). */
  async meet(others: PeerBox[], also: PeerBox[] = [], apart: PeerBox[] = []) {
    await peerRoutes(this.parts, "PUT", [], async () => ({ self: { key: this.key, name: this.name }, boxes: others.map((box) => ({ key: box.key, name: box.name, seats: true, ...(apart.includes(box) ? { apart: true } : {}) })), also: also.map((box) => ({ key: box.key, name: box.name })), bots: [] }))
  }

  stop() {
    this.following.abort()
  }
}

describe("across your computers", () => {
  let at: number
  const now = () => at
  let relay: Relay

  const account = (home: string, id: string, lines: string) => {
    const folder = join(home, "accounts", id)
    mkdirSync(join(folder, "projects", "p"), { recursive: true })
    writeFileSync(join(folder, "projects", "p", "log.jsonl"), lines)
    return new TestClaude(home, { id, home: folder })
  }

  beforeEach(() => {
    at = Date.parse("2026-11-12T12:00:00Z")
    relay = new Relay()
  })

  test("one account used on two computers is one row, its usage added up from both; another account is a row of its own; each box lists them all", async () => {
    const macHome = mkdtempSync(join(base, "mac-"))
    const devHome = mkdtempSync(join(base, "devbox-"))
    const mac = new PeerBox("mac-key", "MacBook", relay, macHome, [account(macHome, "work", reply("2026-11-05T09:00:00Z", "m0", "claude-opus-4-5", 400, 0) + reply("2026-11-12T09:00:00Z", "m1", "claude-opus-4-5", 1000, 0))], () => "aaaaaaaaaaaaaaaa", now)
    const dev = new PeerBox(
      "dev-key",
      "devbox",
      relay,
      devHome,
      [account(devHome, "work", reply("2026-11-12T10:00:00Z", "d1", "claude-opus-4-5", 300, 0)), account(devHome, "home", reply("2026-11-12T10:00:00Z", "d2", "claude-opus-4-5", 7, 0))],
      (provider) => (provider === "claude-code@work" ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb"),
      now,
    )
    await mac.meet([dev])
    await dev.meet([mac])
    await mac.usage.refresh()
    await dev.usage.refresh()
    await relay.settled()

    for (const box of [mac, dev]) {
      const view = box.usage.view("UTC")
      expect(view.rows.map((row) => [row.id, row.days[0]!.tokens])).toEqual(box === mac ? [["claude#aaaaaaaaaaaaaaaa", 1300], ["claude#bbbbbbbbbbbbbbbb", 7]] : [["claude#aaaaaaaaaaaaaaaa", 1300], ["claude#bbbbbbbbbbbbbbbb", 7]])
      expect(view.totals.claude![0]!.tokens).toBe(1307)
    }
    const shared = mac.usage.view("UTC").rows[0]!
    expect(shared.boxes.map((each) => [each.name, each.here ?? false])).toEqual([["MacBook", true], ["devbox", false]])

    // A round that read nothing new tells no one, and the clients nothing.
    const sent = relay.sent.length
    const events: unknown[] = []
    const listening = subscribe((event) => event.type === "kuvo.usage.updated" && events.push(event))
    at += 5 * MINUTE
    await mac.usage.refresh()
    await dev.usage.refresh()
    await relay.settled()
    expect(relay.sent.length).toBe(sent)
    expect(events).toEqual([])
    // Ten minutes on: only that it's as it was, and the other keeps what it had, not away.
    at += 6 * MINUTE
    await mac.usage.refresh()
    await relay.settled()
    const word = relay.sent.slice(sent)
    expect(word.map((each) => [each.from, each.to, each.mail.accounts === undefined, typeof each.mail.digest])).toEqual([["mac-key", "dev-key", true, "string"]])
    at += 20 * MINUTE
    const onDev = dev.usage.view("UTC").rows[0]!
    expect([onDev.days[0]!.tokens, onDev.boxes.map((each) => [each.name, each.away ?? false])]).toEqual([1300, [["devbox", false], ["MacBook", false]]])
    listening()

    // The Mac's Claude writes more: only its last two days go, and the devbox, putting them with what
    // it had, has all of it (nothing asked again).
    appendFileSync(join(macHome, "accounts", "work", "projects", "p", "log.jsonl"), reply("2026-11-12T11:30:00Z", "m2", "claude-opus-4-5", 9, 0))
    at += MINUTE
    const partly = relay.sent.length
    await mac.usage.refresh()
    await relay.settled()
    const update = relay.sent.slice(partly)
    expect(update.map((each) => [each.from, each.to, typeof each.mail.from, each.mail.ask ?? false])).toEqual([["mac-key", "dev-key", "number", false]])
    expect(JSON.stringify(update[0]!.mail.accounts)).not.toContain(String(Date.parse("2026-11-05T09:00:00Z") / (15 * MINUTE)))
    expect(dev.usage.view("UTC").rows[0]!.days.map((day) => [day.date, day.tokens])).toEqual([["2026-11-12", 1309], ["2026-11-05", 400]])

    // What went: slots, models and numbers, hashed identities; no path, log or sign-in.
    const told = JSON.stringify(relay.sent.map((each) => each.mail))
    expect(told).not.toContain(macHome)
    expect(told).not.toContain("msg_")

    // The devbox goes quiet: what it said stays, and its own row says it's away after a while.
    relay.off.add("dev-key")
    at += 26 * MINUTE
    const away = mac.usage.view("UTC").rows
    expect(away[1]).toMatchObject({ id: "claude#bbbbbbbbbbbbbbbb", away: true })
    expect(away[0]!.away).toBeUndefined()

    // Removed from your computers: what it said goes.
    await mac.meet([])
    expect(mac.usage.view("UTC").rows.map((row) => [row.id, row.days[0]!.tokens])).toEqual([["claude#aaaaaaaaaaaaaaaa", 1009]])
    mac.stop()
    dev.stop()
  })

  test("Codex's use estimated with a fallback model goes to the others saying so; a box from before, which keeps none of that, finds the same digest and asks nothing again", async () => {
    const macHome = mkdtempSync(join(base, "mac-"))
    const devHome = mkdtempSync(join(base, "devbox-"))
    const codexHome = join(devHome, "codex", "accounts", "work")
    mkdirSync(join(codexHome, "sessions"), { recursive: true })
    writeFileSync(join(codexHome, "sessions", "rollout-a.jsonl"), JSON.stringify({ timestamp: "2026-11-12T10:00:00Z", type: "turn_context", payload: { model: "gpt-mystery-9" } }) + "\n" + JSON.stringify({ timestamp: "2026-11-12T10:01:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } } } }) + "\n")
    const mac = new PeerBox("mac-key", "MacBook", relay, macHome, [], () => undefined, now)
    const dev = new PeerBox("dev-key", "devbox", relay, devHome, [new CodexAgent({ home: devHome, temporary: devHome, deps: {} as any }, { id: "work", home: codexHome })], () => "cccccccccccccccc", now)
    const choice = new PricingStore(undefined, null).current().fallbackOptions("codex")[0]!
    dev.fallback = choice
    await mac.meet([dev])
    await dev.meet([mac])
    await dev.usage.refresh()
    await mac.usage.refresh()
    await relay.settled()
    const day = mac.usage.view("UTC").totals.codex![0]!
    expect(day).toMatchObject({ date: "2026-11-12", tokens: 1100, unknown: ["gpt-mystery-9"], fallback: [choice] })
    expect(day.cost).toBeGreaterThan(0)

    // What a box from before keeps of it (no `fallback`) hashes the same as what was told.
    const told = relay.sent.filter((each) => each.from === "dev-key" && each.mail.accounts).at(-1)!.mail.accounts!
    expect(JSON.stringify(told)).toContain('"fallback"')
    const before = told.map((account) => ({ ...account, slots: { ...account.slots, fallback: undefined } }))
    expect(digestOf(before)).toBe(digestOf(told))
    // Ten minutes on, its digest alone: the Mac asks nothing again.
    const sent = relay.sent.length
    at += 11 * MINUTE
    await dev.usage.refresh()
    await relay.settled()
    expect(relay.sent.slice(sent).map((each) => [each.from, each.mail.accounts === undefined, each.mail.ask ?? false])).toEqual([["dev-key", true, false]])

    // Another fallback model priced the same (the digest is the same): its older days say the new one too.
    appendFileSync(join(codexHome, "sessions", "rollout-a.jsonl"), JSON.stringify({ timestamp: "2026-11-06T10:01:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } } }) + "\n")
    at += MINUTE
    await dev.usage.refresh()
    await relay.settled()
    const pricing = new PricingStore(undefined, null).current()
    const rates = (model: string) => JSON.stringify(pricing.fallbackRates(model, "codex"))
    const choices = pricing.fallbackOptions("codex")
    // (Two priced the same, so their dollars and digest are the same: only telling all of it again shows the change.)
    const pair = choices.flatMap((one) => choices.filter((other) => other > one && rates(other) === rates(one)).map((other) => [one, other] as const))[0]
    expect(pair).toBeDefined()
    const [first, second] = pair!
    const switched = relay.sent.length
    dev.fallback = first
    await dev.usage.refresh()
    await relay.settled()
    expect(mac.usage.view("UTC").totals.codex!.map((each) => [each.date, each.fallback])).toEqual([["2026-11-12", [first]], ["2026-11-06", [first]]])
    dev.fallback = second
    at += MINUTE
    await dev.usage.refresh()
    await relay.settled()
    expect(mac.usage.view("UTC").totals.codex!.map((each) => [each.date, each.fallback])).toEqual([["2026-11-12", [second]], ["2026-11-06", [second]]])
    // Told once each way it changed, all of it, not asking the Mac for its own; the Mac sent nothing back.
    expect(relay.sent.slice(switched).filter((each) => each.mail.accounts && each.mail.from === undefined).map((each) => [each.from, each.mail.ask ?? false])).toEqual(first === choice ? [["dev-key", false]] : [["dev-key", false], ["dev-key", false]])
    expect(relay.sent.slice(switched).filter((each) => each.from === "mac-key")).toEqual([])
    // A round with more estimated use, the same model: two days' slots, as ever.
    appendFileSync(join(codexHome, "sessions", "rollout-a.jsonl"), JSON.stringify({ timestamp: "2026-11-12T11:31:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } } }) + "\n")
    const later = relay.sent.length
    at += MINUTE
    await dev.usage.refresh()
    await relay.settled()
    expect(relay.sent.slice(later).map((each) => [each.from, typeof each.mail.from])).toEqual([["dev-key", "number"]])
    mac.stop()
    dev.stop()
  })

  test("an account too big for a mail is cut from its oldest uses and says so; a long name; what changes after costs no more than its last two days", async () => {
    const lines = Array.from({ length: 200 }, (_, i) => reply(new Date(Date.parse("2026-11-02T00:00:00Z") + i * 75 * MINUTE).toISOString(), `c${i}`, i % 2 ? "claude-opus-4-5" : "claude-sonnet-4-5", 100 + i, 0)).join("")
    const oneHome = mkdtempSync(join(base, "one-"))
    const twoHome = mkdtempSync(join(base, "two-"))
    const busy = account(oneHome, "busy", lines)
    busy.instance.label = "B".repeat(150)
    const one = new PeerBox("one-key", "one", relay, oneHome, [busy], () => "cccccccccccccccc", now, 3_000)
    const two = new PeerBox("two-key", "two", relay, twoHome, [], () => undefined, now, 3_000)
    await one.meet([two])
    await two.meet([one])
    await one.usage.refresh()
    await two.usage.refresh()
    await relay.settled()
    const told = two.usage.view("UTC").rows[0]!
    expect(told.cut).toBe(true)
    expect(told.label).toBe("B".repeat(100))
    // (The newest days whole, as the box itself has them.)
    expect(told.days[0]).toEqual(one.usage.view("UTC").rows[0]!.days[0]!)

    appendFileSync(join(oneHome, "accounts", "busy", "projects", "p", "log.jsonl"), reply("2026-11-12T11:00:00Z", "new", "claude-opus-4-5", 5, 0))
    at += 2 * MINUTE
    const before = relay.sent.length
    await one.usage.refresh()
    await relay.settled()
    expect(relay.sent.slice(before).map((each) => [each.from, typeof each.mail.from, each.mail.ask ?? false])).toEqual([["one-key", "number", false]])
    expect(two.usage.view("UTC").rows[0]!.days[0]).toEqual(one.usage.view("UTC").rows[0]!.days[0]!)
    one.stop()
    two.stop()
  })

  test("what the engine's hosted models cost on a machine shows on your Mac as billed, not estimated, in OpenCode's total", async () => {
    const macHome = mkdtempSync(join(base, "mac-"))
    const devHome = mkdtempSync(join(base, "devbox-"))
    const engine = join(devHome, "data", "opencode")
    mkdirSync(engine, { recursive: true })
    const db = new Database(join(engine, "opencode.db"))
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
    db.exec(`INSERT INTO message VALUES ('m1','s',${Date.parse("2026-11-12T10:00:00Z")},0,'{"role":"assistant","providerID":"opencode-go","modelID":"glm-5.2","cost":0.5,"tokens":{"total":900}}')`)
    db.close()
    const mac = new PeerBox("mac-key", "MacBook", relay, macHome, [], () => undefined, now)
    const dev = new PeerBox("dev-key", "devbox", relay, devHome, [], (provider) => (provider === "opencode-go" ? "eeeeeeeeeeeeeeee" : undefined), now, undefined, undefined, engineHostedSources(engine))
    await mac.meet([dev])
    await dev.meet([mac])
    await mac.usage.refresh()
    await dev.usage.refresh()
    await relay.settled()
    const view = mac.usage.view("UTC")
    expect(view.rows.map((row) => [row.id, row.estimated, row.days[0]!.cost, row.boxes.map((box) => box.name)])).toEqual([["opencode#eeeeeeeeeeeeeeee", false, 0.5, ["devbox"]]])
    expect(view.totals.opencode!.map((day) => [day.date, day.tokens, day.cost])).toEqual([["2026-11-12", 900, 0.5]])
    // (Whether it's billed isn't in the digest: a box from before, which doesn't keep it, gets the same one.)
    const told = relay.sent.find((each) => each.from === "dev-key" && each.mail.accounts?.length)!.mail
    expect(told.accounts![0]!.estimated).toBe(false)
    expect(digestOf(told.accounts!.map(({ estimated: _, ...account }) => account))).toBe(told.digest)
    const sent = relay.sent.length
    at += 11 * MINUTE
    await dev.usage.refresh()
    await mac.usage.refresh()
    await relay.settled()
    expect(relay.sent.slice(sent).every((each) => each.mail.accounts === undefined && each.mail.ask === undefined)).toBe(true)
    mac.stop()
    dev.stop()
  })

  test("two boxes on one computer reading one folder count it once; a reply written again for each of its parts is kept once", async () => {
    const shared = mkdtempSync(join(base, "shared-"))
    const folder = join(shared, "claude")
    mkdirSync(join(folder, "projects", "p"), { recursive: true })
    const line = reply("2026-11-12T09:00:00Z", "s1", "claude-opus-4-5", 100, 0)
    writeFileSync(join(folder, "projects", "p", "log.jsonl"), line + line + line)
    const firstHome = mkdtempSync(join(base, "first-"))
    const secondHome = mkdtempSync(join(base, "second-"))
    const first = new PeerBox("first-key", "app's box", relay, firstHome, [new TestClaude(firstHome, { id: "default", home: folder })], () => "dddddddddddddddd", now)
    const second = new PeerBox("second-key", "keeper's box", relay, secondHome, [new TestClaude(secondHome, { id: "default", home: folder })], () => "dddddddddddddddd", now)
    await first.meet([second])
    await second.meet([first])
    await first.usage.refresh()
    await second.usage.refresh()
    await relay.settled()
    for (const box of [first, second]) {
      const view = box.usage.view("UTC")
      expect(view.rows.map((row) => [row.id, row.days[0]!.tokens, row.boxes.map((each) => each.same ?? false)])).toEqual([["claude#dddddddddddddddd", 100, [false, true]]])
      expect(view.totals.claude!.map((day) => day.tokens)).toEqual([100])
    }
    // (Its three lines, one reply: one item kept for the log.)
    const kept = readdirSync(join(firstHome, "usage", "claude-files"))
    expect(JSON.parse(readFileSync(join(firstHome, "usage", "claude-files", kept[0]!), "utf8")).record.items).toHaveLength(1)
    first.stop()
    second.stop()
  })

  test("two computers with one name reading the same path (two Raspberry Pis' /home/pi) are two computers: both count", async () => {
    // (One folder stands for both computers' `/home/pi/.claude`: the same path on each.)
    const shared = mkdtempSync(join(base, "pi-"))
    const folder = join(shared, "claude")
    mkdirSync(join(folder, "projects", "p"), { recursive: true })
    writeFileSync(join(folder, "projects", "p", "log.jsonl"), reply("2026-11-12T09:00:00Z", "p1", "claude-opus-4-5", 100, 0))
    const named = (id: string) => thisComputer("linux", (path) => (path === "/etc/machine-id" ? id + "\n" : ""), () => undefined, () => "raspberrypi")
    expect(named("0123456789abcdef0123456789abcdef")).not.toBe(named("fedcba9876543210fedcba9876543210"))
    // Two cloned from one image keep its machine ID, but not its name: still two.
    const cloned = (name: string) => thisComputer("linux", () => "0123456789abcdef0123456789abcdef\n", () => undefined, () => name)
    expect(cloned("ip-10-0-0-5")).not.toBe(cloned("ip-10-0-0-9"))
    // A first boot's `uninitialized` isn't an ID: D-Bus's is taken; with neither, the name alone.
    const dbus = (path: string) => (path === "/etc/machine-id" ? "uninitialized\n" : path === "/var/lib/dbus/machine-id" ? "ABCDEF0123456789ABCDEF0123456789\n" : "")
    expect(thisComputer("linux", dbus, () => undefined, () => "pi")).toBe("machine-id:abcdef0123456789abcdef0123456789\npi")
    expect(thisComputer("linux", () => "", () => undefined, () => "raspberrypi")).toBe("host:raspberrypi")
    // A Mac's, from what `ioreg` says; one that said nothing, its name.
    expect(uuidOf('    "IOPlatformSerialNumber" = "C02XXXXXXXXX"\n    "IOPlatformUUID" = "1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D"\n')).toBe("1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D")
    expect(thisComputer("darwin", () => "", () => uuidOf(undefined), () => "MacBook")).toBe("host:MacBook")
    const oneHome = mkdtempSync(join(base, "pi-one-"))
    const twoHome = mkdtempSync(join(base, "pi-two-"))
    const one = new PeerBox("one-key", "raspberrypi", relay, oneHome, [new TestClaude(oneHome, { id: "default", home: folder })], () => "eeeeeeeeeeeeeeee", now, undefined, named("0123456789abcdef0123456789abcdef"))
    const two = new PeerBox("two-key", "raspberrypi", relay, twoHome, [new TestClaude(twoHome, { id: "default", home: folder })], () => "eeeeeeeeeeeeeeee", now, undefined, named("fedcba9876543210fedcba9876543210"))
    await one.meet([two])
    await two.meet([one])
    await one.usage.refresh()
    await two.usage.refresh()
    await relay.settled()
    for (const box of [one, two]) {
      const view = box.usage.view("UTC")
      expect(view.rows.map((row) => [row.id, row.days[0]!.tokens, row.boxes.map((each) => each.same ?? false)])).toEqual([["claude#eeeeeeeeeeeeeeee", 200, [false, false]]])
      expect(view.totals.claude!.map((day) => day.tokens)).toEqual([200])
    }
    one.stop()
    two.stop()
  })

  test("a box a peer vouches for (another Mac beside a shared machine) shares usage too; a refresh asks the others to read now; a restart keeps what peers said", async () => {
    const aHome = mkdtempSync(join(base, "a-"))
    const bHome = mkdtempSync(join(base, "b-"))
    const bAgent = account(bHome, "default", reply("2026-11-12T09:00:00Z", "b1", "claude-opus-4-5", 50, 0))
    const a = new PeerBox("a-key", "Air", relay, aHome, [account(aHome, "default", reply("2026-11-12T09:00:00Z", "a1", "claude-opus-4-5", 20, 0))], () => undefined, now)
    let b = new PeerBox("b-key", "Pro", relay, bHome, [bAgent], () => undefined, now)
    await a.meet([], [b])
    await b.meet([], [a])
    await a.usage.refresh()
    await b.usage.refresh()
    await relay.settled()
    expect(a.usage.view("UTC").rows.map((row) => [row.id, row.days[0]!.tokens])).toEqual([["a-key/claude-code", 20], ["b-key/claude-code", 50]])
    // The Pro may be another person's: its account is a row of its own, in none of the Air's totals.
    expect(a.usage.view("UTC").rows[1]!.vouched).toBe(true)
    expect(a.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([20])

    // The Pro's Claude writes more; a refresh on the Air asks it to read now.
    appendFileSync(join(bHome, "accounts", "default", "projects", "p", "log.jsonl"), reply("2026-11-12T11:00:00Z", "b2", "claude-opus-4-5", 5, 0))
    at += MINUTE
    await usageRoutes(a.usage, "POST", ["refresh"], new URLSearchParams())
    await relay.settled()
    await b.peers.idle()
    await relay.settled()
    expect(a.usage.view("UTC").rows[1]!.days[0]!.tokens).toBe(55)

    // A word that what the Pro told is as it was, when it isn't what the Air has: the Air asks again.
    at += MINUTE
    const before = relay.sent.length
    a.peers.take("b-key", { kind: "usage", at, digest: "not what the air has" })
    await relay.settled()
    expect(relay.sent.slice(before).map((each) => [each.from, !!each.mail.ask, !!each.mail.accounts])).toEqual([
      ["a-key", true, true],
      ["b-key", false, true],
    ])

    // The Air restarts: the Pro's usage is there before it tells again, and out of the Air's totals
    // before the link has said who its computers are.
    a.stop()
    const again = new PeerBox("a-key", "Air", new Relay(), aHome, [account(aHome, "default", reply("2026-11-12T09:00:00Z", "a1", "claude-opus-4-5", 20, 0))], () => undefined, now)
    await again.usage.refresh()
    // (Its own row has no key of its own yet: the link names it too.)
    expect(again.usage.view("UTC").rows.map((row) => [row.id, row.vouched ?? false])).toEqual([["/claude-code", false], ["b-key/claude-code", true]])
    expect(again.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([20])
    await again.meet([], [b])
    expect(again.usage.view("UTC").rows.map((row) => row.id)).toEqual(["a-key/claude-code", "b-key/claude-code"])
    expect(again.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([20])
    again.stop()
    b.stop()
  })

  test("just after a restart, before the link says who your computers are, another computer's spend stays in your totals; a box that becomes one a peer vouches for leaves them", async () => {
    const macHome = mkdtempSync(join(base, "mac-"))
    const devHome = mkdtempSync(join(base, "devbox-"))
    const macAgent = () => account(macHome, "default", reply("2026-11-12T09:00:00Z", "m1", "claude-opus-4-5", 100, 0))
    const mac = new PeerBox("mac-key", "MacBook", relay, macHome, [macAgent()], () => undefined, now)
    const dev = new PeerBox("dev-key", "devbox", relay, devHome, [account(devHome, "default", reply("2026-11-12T10:00:00Z", "d1", "claude-opus-4-5", 300, 0))], () => undefined, now)
    await mac.meet([dev])
    await dev.meet([mac])
    await mac.usage.refresh()
    await dev.usage.refresh()
    await relay.settled()
    expect(mac.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([400])
    mac.stop()

    const again = new PeerBox("mac-key", "MacBook", new Relay(), macHome, [macAgent()], () => undefined, now)
    await again.usage.refresh()
    expect(again.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([400])
    await again.meet([dev])
    expect(again.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([400])

    // The link says the devbox is now only a box a peer vouches for: its spend leaves your totals, and clients hear.
    const events: unknown[] = []
    const listening = subscribe((event) => event.type === "kuvo.usage.updated" && events.push(event))
    await peerRoutes(again.parts, "PUT", [], async () => ({ self: { key: "mac-key", name: "MacBook" }, boxes: [], also: [{ key: "dev-key", name: "devbox" }], bots: [] }))
    listening()
    expect(again.usage.view("UTC").rows.map((row) => [row.id, row.vouched ?? false])).toEqual([["mac-key/claude-code", false], ["dev-key/claude-code", true]])
    expect(again.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([100])
    expect(events).toHaveLength(1)
    again.stop()
    dev.stop()
  })

  test("a machine two people's Macs set up (#701) never counts one Mac's spend in its totals, nor either Mac the machine's: each row shows, in no total", async () => {
    const adaHome = mkdtempSync(join(base, "ada-"))
    const boHome = mkdtempSync(join(base, "bo-"))
    const sharedHome = mkdtempSync(join(base, "shared-"))
    const ada = new PeerBox("ada-key", "Ada's MacBook", relay, adaHome, [account(adaHome, "default", reply("2026-11-12T09:00:00Z", "a1", "claude-opus-4-5", 20, 0))], () => "aaaaaaaaaaaaaaaa", now)
    const bo = new PeerBox("bo-key", "Bo's MacBook", relay, boHome, [account(boHome, "default", reply("2026-11-12T09:00:00Z", "b1", "claude-opus-4-5", 50, 0))], () => "bbbbbbbbbbbbbbbb", now)
    const machine = new PeerBox("shared-key", "shared", relay, sharedHome, [account(sharedHome, "default", reply("2026-11-12T10:00:00Z", "s1", "claude-opus-4-5", 7, 0))], () => "cccccccccccccccc", now)
    // Each link as it says: the machine's peers aren't anyone's own computers there; each Mac's machine isn't one of its own.
    await ada.meet([machine], [bo], [machine])
    await bo.meet([machine], [ada], [machine])
    await machine.meet([ada, bo], [], [ada, bo])
    for (const box of [ada, bo, machine]) await box.usage.refresh()
    await relay.settled()
    const view = machine.usage.view("UTC")
    expect(view.rows.map((row) => [row.id, row.vouched ?? false]).sort()).toEqual([["claude#aaaaaaaaaaaaaaaa", true], ["claude#bbbbbbbbbbbbbbbb", true], ["claude#cccccccccccccccc", false]])
    // Only its own.
    expect(view.totals.claude!.map((day) => day.tokens)).toEqual([7])
    // Ada's Mac: its own only, not Bo's, nor what's spent on the machine both share.
    expect(ada.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([20])
    expect(bo.usage.view("UTC").totals.claude!.map((day) => day.tokens)).toEqual([50])
    for (const box of [ada, bo, machine]) box.stop()
  })
})
