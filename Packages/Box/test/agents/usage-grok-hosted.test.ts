// What your Grok accounts used, and what the engine's own hosted models (OpenCode Go and Zen) cost,
// as the box states them (`api/kuvo/usage`, PROTOCOL.md "Usage history"): Grok's from each Grok
// account's own session transcripts here, its own costs where it said them, else priced; OpenCode's
// from the engine's databases here, as OpenCode billed it. The same fixtures as UsageKit's
// `UsageBoxParityTests`. Transcripts, databases and prices are synthetic stand-ins: no sign-in is
// read, no maker or price feed is asked, and no real `~/.grok` or engine database is near.

import "../safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAgent } from "../../src/agents/agents/grok"
import type { Agent } from "../../src/agents/agent"
import { dedupGrok, grokLine, grokSlots } from "../../src/agents/usage/grok-log"
import { hostedAnswers, hostedRows, hostedSlots } from "../../src/agents/usage/engine-hosted"
import { daysIn, summed, type Day } from "../../src/agents/usage/history"
import { catalogFromCompact, Pricing, supplementFrom, type PricingStore } from "../../src/agents/usage/pricing"
import { engineHostedSources, grokSources, Usage, usageRoutes } from "../../src/agents/usage/usage"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-usage-grok-hosted-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const fixtures = join(import.meta.dir, "..", "fixtures", "usage")
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"))
const grokPricing = () => new Pricing(supplementFrom(fixture("pricing-supplement.json")), catalogFromCompact(fixture("pricing-grok-litellm.json")), catalogFromCompact(fixture("pricing-grok-models-dev.json")))
/** A store whose prices are these, and never fetched. */
const store = (pricing: Pricing) => ({ current: () => pricing }) as unknown as PricingStore

/** Days as the expected files keep them: priced days, and unknown models by the day. */
function shaped(days: Day[]) {
  return {
    days: days.filter((day) => day.models.length).map(({ date, tokens, cost, models }) => ({ date, tokens, cost, models })),
    unknown: Object.fromEntries(days.filter((day) => day.unknown).map((day) => [day.date, day.unknown])),
  }
}

function expectDays(got: Day[], want: any[]) {
  const priced = got.filter((day) => day.models.length)
  expect(priced.map((day) => day.date)).toEqual(want.map((day: any) => day.date))
  priced.forEach((day, index) => {
    const wanted = want[index]
    expect(day.tokens).toBe(wanted.tokens)
    expect(day.cost).toBeCloseTo(wanted.cost, 9)
    expect(day.models.map((model) => [model.model, model.tokens])).toEqual(wanted.models.map((model: any) => [model.model, model.tokens]))
    day.models.forEach((model, at) => expect(model.cost).toBeCloseTo(wanted.models[at].cost, 9))
  })
}

/** The engine's databases from the fixtures' SQL, in a data folder of their own. */
function engineFolder(): string {
  const folder = mkdtempSync(join(base, "engine-"))
  for (const [name, sql] of Object.entries(fixture("opencode-hosted-expected.json").databases as Record<string, string>)) {
    const db = new Database(join(folder, name))
    db.exec(readFileSync(join(fixtures, sql), "utf8"))
    db.close()
  }
  return folder
}

describe("as UsageKit reads them", () => {
  test("Grok's transcripts: completed turns by model, its own costs where it said them, else priced; a copied event once per model (UsageKit's GrokLogUsageScanner)", () => {
    const expected = fixture("grok-expected.json")
    const entries = (expected.files as string[]).flatMap((file) =>
      readFileSync(join(fixtures, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => grokLine(Buffer.from(line))),
    )
    const days = daysIn(grokSlots(dedupGrok(entries), grokPricing(), Date.parse(expected.since)), "UTC", Date.parse(expected.now))
    expectDays(days, expected.days)
    expect(shaped(days).unknown).toEqual(expected.unknown)
  })

  test("the engine's hosted rows: Go's and Zen's billed costs, both tables, a copy in another table or database once; a key of your own, a cost as text, a running compaction never (UsageKit's OpenCodeUsageScanner)", async () => {
    const expected = fixture("opencode-hosted-expected.json")
    const since = Date.parse(expected.since)
    const rows = (await hostedRows(engineFolder(), since))!
    const go = hostedSlots(rows, "opencode-go", since)
    const zen = hostedSlots(rows, "opencode", since)
    const now = Date.parse(expected.now)
    expectDays(daysIn(summed([go, zen]), "UTC", now), expected.days)
    expectDays(daysIn(go, "UTC", now), expected.providers["opencode-go"])
    expectDays(daysIn(zen, "UTC", now), expected.providers.opencode)
  })
})

class TestGrok extends GrokAgent {
  constructor(home: string, instance: { id: string; label?: string; home: string }) {
    super({ home, temporary: home, deps: {} as any }, instance)
  }
}

const route = async (usage: Usage, zone = "UTC") => ((await (await usageRoutes(usage, "GET", [], new URLSearchParams({ zone }))).json()) as any).data

describe("Grok's accounts", () => {
  let home: string
  let account: string
  let at: number

  beforeEach(() => {
    home = mkdtempSync(join(base, "box-"))
    account = join(home, "grok", "accounts", "work")
    // (An added account's own Grok home: its transcripts, and the debug log beside them.)
    cpSync(join(fixtures, "grok"), account, { recursive: true })
    at = Date.parse("2026-11-12T14:00:00Z")
  })

  test("an account's sessions' transcripts, only their updates.jsonl: a row by the account, Grok's total; read on as one grows, through a restart", async () => {
    const agent = new TestGrok(home, { id: "work", label: "Work", home: account })
    expect(agent.conversationRoots()).toEqual([join(account, "sessions")])
    const make = () => {
      const sources = grokSources(join(home, "usage"))
      return new Usage(() => sources([agent as unknown as Agent]), store(grokPricing()), () => "0123456789abcdef", join(home, "usage", "usage.json"), () => at)
    }
    const usage = make()
    await usage.refresh()
    const view = await route(usage)
    expect(view.services).toEqual(["claude", "codex", "grok", "opencode"])
    expect(view.rows.map((row: any) => [row.id, row.service, row.provider, row.agent, row.account, row.label, row.estimated])).toEqual([["grok#0123456789abcdef", "grok", "grok-cli@work", "grok", "work", "Work", undefined]])
    const expected = fixture("grok-expected.json")
    expectDays(view.totals.grok, expected.days)
    expect(shaped(view.totals.grok).unknown).toEqual(expected.unknown)
    // (Grok's other files there, and its debug log, aren't read: none of their tokens count.)
    expect(view.totals.grok.reduce((sum: number, day: Day) => sum + day.tokens, 0)).toBe(expected.days.reduce((sum: number, day: any) => sum + day.tokens, 0))

    // Another turn, billed: read on from where it was.
    appendFileSync(join(account, "sessions", "2026-11-12-session-b", "updates.jsonl"), JSON.stringify({ params: { update: { sessionUpdate: "turn_completed", usage: { modelUsage: { "grok-5": { inputTokens: 40, outputTokens: 2, costUsdTicks: 10_000_000 } } } }, _meta: { eventId: "ev-new", agentTimestampMs: Date.parse("2026-11-12T13:30:00Z") } } }) + "\n")
    at += 5 * 60_000
    await usage.refresh()
    const grown = (await route(usage)).totals.grok[0]
    expect([grown.tokens - expected.days[0].tokens, grown.cost - expected.days[0].cost]).toEqual([42, expect.closeTo(0.001, 12)])
    // A restart answers at once with what it had.
    const again = make()
    expect((await route(again)).totals.grok[0].tokens).toBe(grown.tokens)
    expect(readdirSync(join(home, "usage", "grok-files")).length).toBe(2)
  })
})

describe("your own Grok on a Mac", () => {
  test("the default account reads your GROK_HOME (your Terminal's sessions too); an added account whose home is the same folder doesn't count it again", async () => {
    const home = mkdtempSync(join(base, "box-"))
    const own = join(home, "your-grok")
    cpSync(join(fixtures, "grok"), own, { recursive: true })
    const linked = join(home, "grok", "accounts", "linked")
    mkdirSync(join(home, "grok", "accounts"), { recursive: true })
    symlinkSync(own, linked)
    const was = process.env.GROK_HOME
    process.env.GROK_HOME = own
    try {
      const yours = new GrokAgent({ home, temporary: home, deps: {} as any })
      expect(yours.conversationRoots()).toEqual([join(own, "sessions")])
      const added = new TestGrok(home, { id: "linked", home: linked })
      const sources = grokSources(join(home, "usage"))
      const usage = new Usage(() => sources([yours, added] as unknown as Agent[]), store(grokPricing()), (provider) => (provider === "grok-cli" ? "1111111111111111" : "2222222222222222"), undefined, () => Date.parse("2026-11-12T14:00:00Z"))
      await usage.refresh()
      const view = await route(usage)
      expect(view.rows.map((row: any) => [row.id, row.days.reduce((sum: number, day: Day) => sum + day.tokens, 0) > 0])).toEqual([["grok#1111111111111111", true], ["grok#2222222222222222", false]])
      expectDays(view.totals.grok, fixture("grok-expected.json").days)
    } finally {
      if (was === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = was
    }
  })
})

describe("the engine's hosted models", () => {
  let at: number
  beforeEach(() => {
    at = Date.parse("2026-11-12T14:00:00Z")
  })
  const make = (folder: string | undefined, identity: (provider: string) => string | undefined = (provider) => (provider === "opencode-go" ? "fedcba9876543210" : undefined), log: (line: string) => void = () => {}, answers = hostedAnswers) => {
    const sources = engineHostedSources(folder, undefined, log, answers)
    return new Usage(sources, store(grokPricing()), identity, undefined, () => at)
  }

  test("Go's and Zen's each a row, as billed (not estimated): Go's the same row as its plan limits'; OpenCode's total both; the databases only read", async () => {
    const folder = engineFolder()
    const before = Object.fromEntries(readdirSync(folder).map((name) => [name, [statSync(join(folder, name)).mtimeMs, readFileSync(join(folder, name)).toString("base64")]]))
    const usage = make(folder)
    await usage.refresh()
    const view = await route(usage)
    expect(view.rows.map((row: any) => [row.id, row.service, row.provider, row.estimated, row.boxes[0].estimated])).toEqual([
      ["opencode#fedcba9876543210", "opencode", "opencode-go", false, undefined],
      ["/opencode", "opencode", "opencode", false, undefined],
    ])
    const expected = fixture("opencode-hosted-expected.json")
    expectDays(view.rows[0].days, expected.providers["opencode-go"])
    expectDays(view.rows[1].days, expected.providers.opencode)
    expectDays(view.totals.opencode, expected.days)
    // Never written: no file new, none changed.
    expect(Object.fromEntries(readdirSync(folder).map((name) => [name, [statSync(join(folder, name)).mtimeMs, readFileSync(join(folder, name)).toString("base64")]]))).toEqual(before)
  })

  test("an engine's databases in WAL mode, closed so their side files are gone (a channel not running), are read as they are, every one", async () => {
    const folder = mkdtempSync(join(base, "engine-"))
    for (const [name, sql] of Object.entries(fixture("opencode-hosted-expected.json").databases as Record<string, string>)) {
      const db = new Database(join(folder, name))
      db.exec("PRAGMA journal_mode = WAL")
      db.exec(readFileSync(join(fixtures, sql), "utf8"))
      db.close()
      // (Linux's SQLite removes them as the last connection closes; macOS's keeps them, emptied.)
      for (const side of ["-wal", "-shm"]) rmSync(join(folder, name + side), { force: true })
    }
    expect(readdirSync(folder).sort()).toEqual(["opencode-next.db", "opencode.db"])
    const bytes = () => ["opencode-next.db", "opencode.db"].map((name) => readFileSync(join(folder, name)).toString("base64"))
    const before = bytes()
    const expected = fixture("opencode-hosted-expected.json")
    const since = Date.parse(expected.since)
    const rows = (await hostedRows(folder, since))!
    expectDays(daysIn(summed([hostedSlots(rows, "opencode-go", since), hostedSlots(rows, "opencode", since)]), "UTC", Date.parse(expected.now)), expected.days)
    // (Only read: the databases as they were. Linux's SQLite may set up the empty side files a reader of one in WAL mode uses.)
    expect(bytes()).toEqual(before)
  })

  test("a provider with no use in the window has no row; no database, none; one that isn't the engine's (no message tables) says nothing", async () => {
    const folder = mkdtempSync(join(base, "engine-"))
    const usage = make(folder)
    await usage.refresh()
    expect((await route(usage)).rows).toEqual([])
    const other = new Database(join(folder, "opencode-other.db"))
    other.exec("CREATE TABLE something (id TEXT)")
    other.close()
    await usage.refresh()
    expect((await route(usage)).rows).toEqual([])
    const db = new Database(join(folder, "opencode.db"))
    db.exec(readFileSync(join(fixtures, "opencode-hosted.sql"), "utf8"))
    db.exec("DELETE FROM message WHERE json_valid(data) AND json_extract(data,'$.providerID') = 'opencode'; DELETE FROM session_message WHERE json_valid(data) AND json_extract(data,'$.model.providerID') = 'opencode'")
    db.close()
    await usage.refresh()
    expect((await route(usage)).rows.map((row: any) => row.provider)).toEqual(["opencode-go"])
  })

  test("one database that never could be read while another can: the other counts; none readable: what it had stays; unchanged databases aren't read again", async () => {
    const folder = engineFolder()
    writeFileSync(join(folder, "opencode-broken.db"), "not a database at all, but long enough to look like one".repeat(100))
    const usage = make(folder)
    await usage.refresh()
    const first = await route(usage)
    expect(first.rows.map((row: any) => row.provider)).toEqual(["opencode-go", "opencode"])
    expectDays(first.totals.opencode, fixture("opencode-hosted-expected.json").days)

    // Unchanged, every one read: what it read stands, without opening them again (one it couldn't
    // open now is no matter). (A read with one that failed is read again each round.)
    if (process.getuid?.() !== 0) {
      rmSync(join(folder, "opencode-broken.db"))
      at += 5 * 60_000
      await usage.refresh()
      for (const name of ["opencode.db", "opencode-next.db"]) chmodSync(join(folder, name), 0)
      at += 5 * 60_000
      await usage.refresh()
      const reused = await route(usage)
      expect(reused.scanned).toBe(at)
      expect(reused.totals).toEqual(first.totals)
      // Changed (a write the engine made), and now none can be read: the round fails, what it had stays.
      writeFileSync(join(folder, "opencode.db-wal"), "")
      at += 5 * 60_000
      await usage.refresh()
      const failed = await route(usage)
      expect(failed.scanned).toBe(at - 5 * 60_000)
      expect(failed.totals).toEqual(first.totals)
      for (const name of ["opencode.db", "opencode-next.db"]) chmodSync(join(folder, name), 0o644)
    }
  })

  // (Root reads what it may not: these need a user's permissions.)
  const asUser = process.getuid?.() !== 0

  test("a database that can't be read now, after it was, gives what it last did: never less, logged once, and read again whole next round", async () => {
    if (!asUser) return
    const folder = engineFolder()
    const logged: string[] = []
    const usage = make(folder, undefined, (line) => logged.push(line))
    await usage.refresh()
    const total = (view: any) => view.totals.opencode.reduce((sum: number, day: Day) => sum + day.cost, 0)
    const whole = total(await route(usage))
    expect(whole).toBeCloseTo(3.34375, 9)

    // The next channel's can't be read for a while; a new Go reply in the other.
    chmodSync(join(folder, "opencode-next.db"), 0)
    const db = new Database(join(folder, "opencode.db"))
    db.exec(`INSERT INTO session_message VALUES ('m-new','s2','assistant',99,${Date.parse("2026-11-12T13:00:00Z")},0,'{"model":{"id":"glm-5.2","providerID":"opencode-go"},"cost":1,"tokens":{"input":10}}')`)
    db.close()
    for (const _ of [1, 2]) {
      at += 5 * 60_000
      await usage.refresh()
      expect(total(await route(usage))).toBeCloseTo(whole + 1, 9)
    }
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain("opencode-next.db")

    // Back: read whole again, as before.
    chmodSync(join(folder, "opencode-next.db"), 0o644)
    at += 5 * 60_000
    await usage.refresh()
    expect(total(await route(usage))).toBeCloseTo(whole + 1, 9)
    expect(logged).toHaveLength(1)
  })

  test("both providers' rows come from one read a round, though the engine writes while it's read", async () => {
    const folder = engineFolder()
    let reads = 0
    const usage = make(folder, undefined, undefined, async (path, since) => {
      reads++
      const answers = await hostedAnswers(path, since)
      // (The engine writes meanwhile: its write-ahead log changes.)
      writeFileSync(join(folder, "opencode.db-wal"), "x".repeat(reads))
      return answers
    })
    await usage.refresh()
    expect(reads).toBe(1)
    expect((await route(usage)).rows.map((row: any) => row.provider)).toEqual(["opencode-go", "opencode"])
  })

  test("an engine folder that's there but can't be listed: not known now, what the box had stays", async () => {
    if (!asUser) return
    const folder = engineFolder()
    const usage = make(folder)
    await usage.refresh()
    const before = await route(usage)
    chmodSync(folder, 0)
    try {
      at += 5 * 60_000
      await usage.refresh()
      const after = await route(usage)
      expect(after.totals).toEqual(before.totals)
      expect(after.scanned).toBe(before.scanned)
    } finally {
      chmodSync(folder, 0o755)
    }
  })

  test("no engine folder known: no source, and a box that says so leaves OpenCode out of what it states", async () => {
    const usage = make(undefined)
    usage.services = ["claude", "grok"]
    await usage.refresh()
    const view = await route(usage)
    expect(view.services).toEqual(["claude", "grok"])
    expect(view.totals.opencode).toBeUndefined()
  })
})
