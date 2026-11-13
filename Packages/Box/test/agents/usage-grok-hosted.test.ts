// What your Grok accounts used, and what the engine's own hosted models (OpenCode Go and Zen) cost,
// as the box states them (`api/kuvo/usage`, PROTOCOL.md "Usage history"): Grok's from each Grok
// account's own session transcripts here, its own costs where it said them, else priced; OpenCode's
// from the engine's databases here, as OpenCode billed it. The same fixtures as UsageKit's
// `UsageBoxParityTests`. Transcripts, databases and prices are synthetic stand-ins: no sign-in is
// read, no maker or price feed is asked, and no real `~/.grok` or engine database is near.

import "../safety"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GrokAgent } from "../../src/agents/agents/grok"
import type { Agent } from "../../src/agents/agent"
import { dedupGrok, grokLine, grokSlots } from "../../src/agents/usage/grok-log"
import { hostedRows, hostedSlots } from "../../src/agents/usage/engine-hosted"
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
    expect(view.services).toEqual(["claude", "grok", "opencode"])
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

describe("the engine's hosted models", () => {
  let at: number
  beforeEach(() => {
    at = Date.parse("2026-11-12T14:00:00Z")
  })
  const make = (folder: string | undefined, identity: (provider: string) => string | undefined = (provider) => (provider === "opencode-go" ? "fedcba9876543210" : undefined)) => {
    const sources = engineHostedSources(folder)
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

  test("one database that can't be read while another can: the other counts; none readable: what it had stays; unchanged databases aren't read again", async () => {
    const folder = engineFolder()
    writeFileSync(join(folder, "opencode-broken.db"), "not a database at all, but long enough to look like one".repeat(100))
    const usage = make(folder)
    await usage.refresh()
    const first = await route(usage)
    expect(first.rows.map((row: any) => row.provider)).toEqual(["opencode-go", "opencode"])
    expectDays(first.totals.opencode, fixture("opencode-hosted-expected.json").days)

    // Unchanged: what it read stands, without opening them again (one it couldn't open now is no matter).
    if (process.getuid?.() !== 0) {
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

  test("no engine folder known: no source, and a box that says so leaves OpenCode out of what it states", async () => {
    const usage = make(undefined)
    usage.services = ["claude", "grok"]
    await usage.refresh()
    const view = await route(usage)
    expect(view.services).toEqual(["claude", "grok"])
    expect(view.totals.opencode).toBeUndefined()
  })
})
