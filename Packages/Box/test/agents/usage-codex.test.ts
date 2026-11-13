// What your Codex accounts used, as the box states it (`api/kuvo/usage`, PROTOCOL.md "Usage
// history"): read from each Codex account's own `sessions` and `archived_sessions` here, and your
// ChatGPT sign-in's use through the engine's own models from its databases, priced as UsageKit
// prices Codex's (the same fixtures as UsageKit's `UsageBoxParityTests`), and Codex's fallback
// model a setting of the box's. Logs, databases and prices are synthetic stand-ins: no sign-in is
// read, no maker or price feed is asked, and no real `~/.codex` is near.

import "../safety"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAgent } from "../../src/agents/agents/codex"
import type { Agent } from "../../src/agents/agent"
import { codexLine, codexSlots, codexState } from "../../src/agents/usage/codex-log"
import { datedBaseModel, pricingModelOf } from "../../src/agents/usage/codex-pricing"
import { engineCodexRows, engineCodexSlots, parseRows } from "../../src/agents/usage/engine-codex"
import { daysIn, type Day } from "../../src/agents/usage/history"
import { catalogFromCompact, Pricing, PricingStore, supplementFrom } from "../../src/agents/usage/pricing"
import { codexSources, engineCodexSource, Usage, usageRoutes, UsageSettings } from "../../src/agents/usage/usage"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-usage-codex-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const fixtures = join(import.meta.dir, "..", "fixtures", "usage")
const fixture = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"))
const codexPricing = () => new Pricing(supplementFrom(fixture("pricing-codex-supplement.json")), catalogFromCompact(fixture("pricing-codex-litellm.json")), catalogFromCompact(fixture("pricing-codex-models-dev.json")))

/** Days as the expected files keep them: priced days, unknown models and fallback estimates by the day. */
function shaped(days: Day[]) {
  return {
    days: days.filter((day) => day.models.length).map(({ date, tokens, cost, models }) => ({ date, tokens, cost, models })),
    unknown: Object.fromEntries(days.filter((day) => day.unknown).map((day) => [day.date, day.unknown])),
    fallback: Object.fromEntries(days.filter((day) => day.fallback).map((day) => [day.date, day.fallback])),
  }
}

function expectDays(got: ReturnType<typeof shaped>, want: any) {
  expect(got.days.map((day) => day.date)).toEqual(want.days.map((day: any) => day.date))
  got.days.forEach((day, index) => {
    const wanted = want.days[index]
    expect(day.tokens).toBe(wanted.tokens)
    expect(day.cost).toBeCloseTo(wanted.cost, 9)
    expect(day.models.map((model) => [model.model, model.tokens])).toEqual(wanted.models.map((model: any) => [model.model, model.tokens]))
    day.models.forEach((model, at) => expect(model.cost).toBeCloseTo(wanted.models[at].cost, 9))
  })
  expect(got.unknown).toEqual(want.unknown)
  expect(got.fallback).toEqual(want.fallback ?? {})
}

describe("as UsageKit reads and prices them", () => {
  const expected = fixture("codex-expected.json")
  const events = () =>
    (expected.files as string[]).flatMap((file) => {
      const state = codexState()
      return readFileSync(join(fixtures, file), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => codexLine(Buffer.from(line), state))
    })

  test("Codex's logs: turns from running totals, replays and repeats left out, tiers and model switches, priced by Codex's rules (UsageKit's CodexLogUsageScanner)", () => {
    const days = daysIn(codexSlots(events(), codexPricing(), Date.parse(expected.since)), "UTC", Date.parse(expected.now), 60)
    expectDays(shaped(days), expected.plain)
  })

  test("with a fallback model chosen, a model with no price is estimated at its rates, and the day says so; still an unknown model", () => {
    const pricing = codexPricing()
    expect(pricing.fallbackOptions("codex")).toEqual(expected.fallbackChoices)
    const days = daysIn(codexSlots(events(), pricing, Date.parse(expected.since), expected.fallback.model), "UTC", Date.parse(expected.now), 60)
    expectDays(shaped(days), expected.fallback)
    // One that isn't a choice prices nothing more.
    const none = daysIn(codexSlots(events(), pricing, Date.parse(expected.since), "gpt-nope"), "UTC", Date.parse(expected.now), 60)
    expectDays(shaped(none), expected.plain)
  })

  test("the engine's rows: only those priced at nothing, a message copied between databases once, priced as Codex's (UsageKit's OpenCodeCodexUsageScanner)", () => {
    const want = fixture("codex-engine-expected.json")
    const rows = parseRows(readFileSync(join(fixtures, want.rows), "utf8"))
    expectDays(shaped(daysIn(engineCodexSlots(rows, codexPricing(), Date.parse(want.since)), "UTC", Date.parse(want.now), 60)), want)
  })

  test("auto-review is priced by its date: the model it ran on then, free from 2026-10-06 (UTC); a snapshot date comes off a model's name", () => {
    expect(pricingModelOf("codex-auto-review", Date.parse("2026-10-05T23:59:59Z"))).toBe("gpt-5.6-luna")
    expect(pricingModelOf("codex-auto-review", Date.parse("2026-10-06T00:00:00Z"))).toBe("codex-auto-review")
    expect(pricingModelOf("codex-auto-review", Date.parse("2026-04-23T00:00:00Z"))).toBe("gpt-5.5")
    expect(pricingModelOf("codex-auto-review", Date.parse("2026-04-22T23:59:59Z"))).toBe("gpt-5.4")
    expect(pricingModelOf("codex-auto-review", Date.parse("2025-09-15T00:00:00Z"))).toBe("gpt-5-codex")
    expect(pricingModelOf("codex-auto-review", Date.parse("2025-01-01T00:00:00Z"))).toBe("gpt-5")
    expect(pricingModelOf("gpt-5.5", Date.parse("2025-01-01T00:00:00Z"))).toBe("gpt-5.5")
    expect(datedBaseModel("gpt-5.4-pro-2026-03-05")).toBe("gpt-5.4-pro")
    expect(datedBaseModel("gpt-5.5-20260423")).toBe("gpt-5.5")
    expect(datedBaseModel("-20260423")).toBe("-20260423")
    expect(datedBaseModel("gpt-5.5")).toBe("gpt-5.5")
    // A day's spend changes with the date alone: the same turn before and after.
    const turn = (at: string) => `{"timestamp":"${at}","type":"event_msg","payload":{"type":"token_count","info":{"model":"codex-auto-review","last_token_usage":{"input_tokens":1000,"output_tokens":100}}}}`
    const state = codexState()
    const both = [...codexLine(Buffer.from(turn("2026-10-05T12:00:00Z")), state), ...codexLine(Buffer.from(turn("2026-10-06T12:00:00Z")), state)]
    const days = daysIn(codexSlots(both, codexPricing(), Date.parse("2026-10-01T00:00:00Z")), "UTC", Date.parse("2026-10-07T00:00:00Z"))
    expect(days.map((day) => [day.date, day.tokens, Math.round(day.cost * 1e6)])).toEqual([
      ["2026-10-06", 1100, 0],
      ["2026-10-05", 1100, 290],
    ])
  })
})

class TestCodex extends CodexAgent {
  constructor(home: string, instance?: { id: string; label?: string; home?: string }) {
    super({ home, temporary: home, deps: {} as any }, instance)
  }
}

const HOUR = 3_600_000
const MINUTE = 60_000
const line = (value: unknown) => JSON.stringify(value) + "\n"
const context = (at: string, model: string) => line({ timestamp: at, type: "turn_context", payload: { model } })
const totals = (at: string, input: number, output: number) => line({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } } })
const turn = (at: string, input: number, output: number, model?: string) => line({ timestamp: at, type: "event_msg", payload: { type: "token_count", ...(model ? { model } : {}), info: { last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } } })

describe("one box", () => {
  let root: string
  let own: string
  let added: string
  let at: number
  let identities: Record<string, string>
  let agents: Agent[]
  const now = () => at
  let savedCodexHome: string | undefined
  const make = (folder = join(root, "usage"), settings = new UsageSettings(join(folder, "settings.json"))) => {
    const sources = codexSources(folder, () => settings.codexFallback)
    const usage = new Usage(() => sources(agents), new PricingStore(undefined, null), (provider) => identities[provider], join(folder, "usage.json"), now)
    usage.settings = settings
    return usage
  }
  const route = async (usage: Usage, method = "GET", rest: string[] = [], given?: unknown) => {
    const response = await usageRoutes(usage, method, rest, new URLSearchParams({ zone: "UTC" }), async () => given ?? {})
    return { status: response.status, body: (await response.json()) as any }
  }
  const view = async (usage: Usage) => (await route(usage)).body.data

  beforeEach(() => {
    root = mkdtempSync(join(base, "box-"))
    savedCodexHome = process.env.CODEX_HOME
    // Your own Codex's home, a folder of the test's (never a real ~/.codex).
    own = join(root, "own-codex")
    process.env.CODEX_HOME = own
    added = join(root, "codex", "accounts", "work")
    mkdirSync(join(own, "sessions", "2026", "11", "12"), { recursive: true })
    mkdirSync(join(added, "sessions", "2026", "11", "12"), { recursive: true })
    at = Date.parse("2026-11-12T21:00:00Z")
    identities = { "codex-cli@work": "0123456789abcdef" }
    agents = [new TestCodex(root, { id: "work", label: "Work", home: added }) as unknown as Agent]
  })
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
  })

  test("an account's sessions and archived sessions: a log in both counted once, as its sessions copy; a row by the account, Codex's total", async () => {
    const log = join(added, "sessions", "2026", "11", "12", "rollout-a.jsonl")
    writeFileSync(log, context("2026-11-12T10:00:00Z", "gpt-5") + turn("2026-11-12T10:01:00Z", 1000, 100))
    mkdirSync(join(added, "archived_sessions", "2026", "11", "12"), { recursive: true })
    // Archived, at the same place as one in sessions (its older copy): not counted again.
    writeFileSync(join(added, "archived_sessions", "2026", "11", "12", "rollout-a.jsonl"), context("2026-11-12T10:00:00Z", "gpt-5") + turn("2026-11-12T10:00:30Z", 5, 5))
    writeFileSync(join(added, "archived_sessions", "rollout-old.jsonl"), turn("2026-11-11T10:00:00Z", 2000, 0))
    const usage = make()
    await usage.refresh()
    const data = await view(usage)
    expect(data.services).toEqual(["claude", "codex", "grok", "opencode", "cursor"])
    expect(data.rows).toHaveLength(1)
    const row = data.rows[0]
    expect(row).toMatchObject({ id: "codex#0123456789abcdef", service: "codex", provider: "codex-cli@work", agent: "codex", account: "work", label: "Work" })
    expect(row.days.map((day: any) => [day.date, day.tokens])).toEqual([
      ["2026-11-12", 1100],
      ["2026-11-11", 2000],
    ])
    // gpt-5's priced at the bundled rates.
    expect(row.days[0].cost).toBeGreaterThan(0)
    expect(data.totals.codex).toEqual(row.days)
    expect(data.pricing.codex).toMatchObject({ fallback: null, chosen: false })
  })

  test("a log as it grows is read on with its running total, through a restart; one rewritten is read again whole", async () => {
    const log = join(added, "sessions", "2026", "11", "12", "rollout-a.jsonl")
    writeFileSync(log, context("2026-11-12T10:00:00Z", "gpt-5") + totals("2026-11-12T10:01:00Z", 1000, 100))
    let usage = make()
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(1100)

    // A restart: the log's running total is kept with what was read, so what it grows by is a turn's, not all of it again.
    usage = make()
    appendFileSync(log, totals("2026-11-12T10:05:00Z", 1500, 150) + totals("2026-11-12T10:06:00Z", 1500, 150))
    at += 5 * MINUTE
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(1650)
    expect(readdirSync(join(root, "usage")).sort()).toEqual(["codex-files", "usage.json"])

    // Its last line not whole yet: only what's whole counts, and the rest once it is.
    const next = totals("2026-11-12T10:07:00Z", 1600, 160)
    appendFileSync(log, next.slice(0, 30))
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(1650)
    appendFileSync(log, next.slice(30))
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(1760)

    // Rewritten, shorter: only what it says now, from no running total.
    writeFileSync(log, totals("2026-11-12T11:00:00Z", 40, 2))
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(42)
  })

  test("on a Mac an added account's history is your own Codex's (its sessions link there): counted once, with yours", async () => {
    rmSync(join(added, "sessions"), { recursive: true })
    symlinkSync(join(own, "sessions"), join(added, "sessions"))
    writeFileSync(join(own, "sessions", "2026", "11", "12", "rollout-a.jsonl"), context("2026-11-12T10:00:00Z", "gpt-5") + turn("2026-11-12T10:01:00Z", 300, 0))
    // An archived session only the added account has: its own.
    mkdirSync(join(added, "archived_sessions"), { recursive: true })
    writeFileSync(join(added, "archived_sessions", "rollout-b.jsonl"), turn("2026-11-12T09:00:00Z", 20, 0, "gpt-5"))
    agents = [new TestCodex(root, { id: "work", label: "Work", home: added }) as unknown as Agent, new TestCodex(root) as unknown as Agent]
    identities["codex-cli"] = "fedcba9876543210"
    const usage = make()
    await usage.refresh()
    const data = await view(usage)
    const tokens = Object.fromEntries(data.rows.map((row: any) => [row.provider, row.days[0]?.tokens ?? 0]))
    expect(tokens).toEqual({ "codex-cli@work": 20, "codex-cli": 300 })
    expect(data.totals.codex[0].tokens).toBe(320)
  })

  test("two accounts that link to a folder neither is in (your ~/.codex while CODEX_HOME names another): it's the first's, and each keeps its own", async () => {
    const shared = join(root, "dot-codex", "sessions")
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(shared, "rollout-shared.jsonl"), turn("2026-11-12T10:00:00Z", 300, 0, "gpt-5"))
    const other = join(root, "codex", "accounts", "home")
    for (const home of [added, other]) {
      rmSync(join(home, "sessions"), { recursive: true, force: true })
      mkdirSync(home, { recursive: true })
      symlinkSync(shared, join(home, "sessions"))
      mkdirSync(join(home, "archived_sessions"), { recursive: true })
    }
    writeFileSync(join(added, "archived_sessions", "rollout-a.jsonl"), turn("2026-11-12T09:00:00Z", 20, 0, "gpt-5"))
    writeFileSync(join(other, "archived_sessions", "rollout-b.jsonl"), turn("2026-11-12T09:00:00Z", 4, 0, "gpt-5"))
    agents = [new TestCodex(root, { id: "work", home: added }) as unknown as Agent, new TestCodex(root, { id: "home", home: other }) as unknown as Agent]
    identities["codex-cli@home"] = "1111111111111111"
    const usage = make()
    await usage.refresh()
    const data = await view(usage)
    expect(Object.fromEntries(data.rows.map((row: any) => [row.provider, row.days[0]?.tokens ?? 0]))).toEqual({ "codex-cli@work": 320, "codex-cli@home": 4 })
    expect(data.totals.codex[0].tokens).toBe(324)
  })

  test("your own Codex reads each home a comma-separated CODEX_HOME names, as UsageKit did; a home with neither sessions nor archived sessions is read itself", async () => {
    const second = join(root, "second-codex")
    mkdirSync(second, { recursive: true })
    writeFileSync(join(own, "sessions", "2026", "11", "12", "rollout-a.jsonl"), turn("2026-11-12T10:00:00Z", 300, 0, "gpt-5"))
    // No sessions folder: its logs where they are.
    writeFileSync(join(second, "rollout-b.jsonl"), turn("2026-11-12T11:00:00Z", 40, 0, "gpt-5"))
    process.env.CODEX_HOME = ` ${own} ,${second},`
    agents = [new TestCodex(root) as unknown as Agent]
    identities["codex-cli"] = "fedcba9876543210"
    const usage = make()
    await usage.refresh()
    expect((await view(usage)).rows.map((row: any) => [row.provider, row.days[0]?.tokens])).toEqual([["codex-cli", 340]])

    // A log at the same place in two homes' sessions: one in each (only one home's sessions and
    // archived sessions are one history). A home named again by a link to it: read once.
    mkdirSync(join(second, "sessions", "2026", "11", "12"), { recursive: true })
    rmSync(join(second, "rollout-b.jsonl"))
    writeFileSync(join(second, "sessions", "2026", "11", "12", "rollout-a.jsonl"), turn("2026-11-12T11:00:00Z", 7, 0, "gpt-5"))
    symlinkSync(own, join(root, "own-alias"))
    process.env.CODEX_HOME = [own, second, join(root, "own-alias")].join(",")
    at += MINUTE
    await usage.refresh()
    expect((await view(usage)).rows[0].days[0].tokens).toBe(307)
  })

  test("the fallback model is the box's: chosen through the route, kept through a restart, a model with no price estimated at its rates; one that isn't a choice is refused", async () => {
    writeFileSync(join(added, "sessions", "2026", "11", "12", "rollout-a.jsonl"), context("2026-11-12T10:00:00Z", "gpt-mystery-9") + turn("2026-11-12T10:01:00Z", 1000, 100))
    let usage = make()
    await usage.refresh()
    let data = await view(usage)
    expect(data.totals.codex).toEqual([{ date: "2026-11-12", tokens: 0, cost: 0, models: [], unknown: ["gpt-mystery-9"] }])
    const choices: string[] = data.pricing.codex.choices
    expect(choices.length).toBeGreaterThan(0)
    expect((await route(usage, "PUT", ["pricing"], { codex: { fallback: "not-a-model" } })).status).toBe(400)
    expect((await route(usage, "PUT", ["pricing"], { codex: { fallback: 7 } })).status).toBe(400)
    const chosen = await route(usage, "PUT", ["pricing"], { codex: { fallback: choices[0] } })
    expect(chosen.status).toBe(200)
    expect(chosen.body.data.pricing.codex).toMatchObject({ fallback: choices[0], chosen: true })
    const day = chosen.body.data.totals.codex[0]
    expect(day).toMatchObject({ date: "2026-11-12", tokens: 1100, unknown: ["gpt-mystery-9"], fallback: [choices[0]] })
    expect(day.cost).toBeGreaterThan(0)

    // A restart: still chosen, still priced so.
    usage = make()
    await usage.refresh()
    data = await view(usage)
    expect(data.pricing.codex).toMatchObject({ fallback: choices[0], chosen: true })
    expect(data.totals.codex[0].fallback).toEqual([choices[0]])
    // None again: chosen, as none.
    const none = await route(usage, "PUT", ["pricing"], { codex: { fallback: null } })
    expect(none.body.data.pricing.codex).toMatchObject({ fallback: null, chosen: true })
    expect(none.body.data.totals.codex[0].cost).toBe(0)
    expect(JSON.parse(readFileSync(join(root, "usage", "settings.json"), "utf8"))).toEqual({ codex: { fallback: null } })
  })
})

describe("the engine's ChatGPT sign-in", () => {
  let data: string
  const day = Date.parse("2026-11-12T00:00:00Z")
  const since = day - 30 * 24 * HOUR
  beforeEach(() => {
    data = mkdtempSync(join(base, "engine-"))
  })

  /** A database as opencode keeps it: its sign-ins (unless `imported` is false) and its messages. */
  function database(name: string, options: { signIn?: { type: string; access?: string; key?: string; at: number | null }; imported?: boolean; v1?: unknown[][]; v2?: unknown[][] }) {
    const db = new Database(join(data, name))
    db.exec("CREATE TABLE migration (id TEXT)")
    if (options.imported !== false) db.exec("INSERT INTO migration VALUES ('20260805200742_import_legacy_credentials')")
    db.exec("CREATE TABLE credential (id INTEGER, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)")
    if (options.signIn) db.query("INSERT INTO credential VALUES (1, 'openai', ?, 1, ?, 0)").run(JSON.stringify({ type: options.signIn.type, ...(options.signIn.access ? { access: options.signIn.access } : {}), ...(options.signIn.key ? { key: options.signIn.key } : {}) }), options.signIn.at)
    if (options.v1) {
      db.exec("CREATE TABLE message (id TEXT, time_created INTEGER, data TEXT)")
      for (const [id, created, value] of options.v1) db.query("INSERT INTO message VALUES (?, ?, ?)").run(id as string, created as number, JSON.stringify(value))
    }
    if (options.v2) {
      db.exec("CREATE TABLE session_message (id TEXT, time_created INTEGER, type TEXT, data TEXT)")
      for (const [id, created, type, value] of options.v2) db.query("INSERT INTO session_message VALUES (?, ?, ?, ?)").run(id as string, created as number, type as string, JSON.stringify(value))
    }
    db.close()
  }
  const reply = (at: number, input: number, output: number, extra: Record<string, unknown> = {}) => ({ role: "assistant", providerID: "openai", modelID: "gpt-5", cost: 0, time: { completed: at }, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra })
  const v2reply = (at: number, input: number, extra: Record<string, unknown> = {}) => ({ model: { providerID: "openai", id: "gpt-5" }, cost: 0, finish: "text", time: { completed: at }, tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...extra })

  test("only a ChatGPT sign-in's rows, priced at nothing, from openai; opencode 2's only from when it signed in; a compaction counts", async () => {
    const signedIn = day + 10 * HOUR
    database("opencode.db", {
      signIn: { type: "oauth", access: "secret-access", at: signedIn },
      v1: [
        ["m1", day + HOUR, reply(day + HOUR, 100, 10)],
        // An API key's use (it cost something), another maker's, one not done: none.
        ["m2", day + HOUR, reply(day + HOUR, 9999, 0, { cost: 0.5 })],
        ["m3", day + HOUR, reply(day + HOUR, 9999, 0, { providerID: "anthropic" })],
        ["m4", day + HOUR, { ...reply(day + HOUR, 9999, 0), time: {} }],
      ],
      v2: [
        ["s1", day + 11 * HOUR, "assistant", v2reply(day + 11 * HOUR, 1000)],
        // Before the sign-in: an early opencode 2 priced a key's use at nothing too.
        ["s2", day + 9 * HOUR, "assistant", v2reply(day + 9 * HOUR, 9999)],
        ["s3", day + 12 * HOUR, "compaction", { ...v2reply(day + 12 * HOUR, 7), finish: undefined, time: { completed: day + 12 * HOUR }, status: "completed" }],
      ],
    })
    const rows = (await engineCodexRows(data, since))!
    expect(rows.map((row) => [row.id, row.total]).sort()).toEqual([
      ["m1", 110],
      ["s1", 1000],
      ["s3", 7],
    ])
    // A sign-in that doesn't say when it was made bounds nothing.
    rmSync(join(data, "opencode.db"))
    database("opencode.db", { signIn: { type: "oauth", access: "secret-access", at: null }, v2: [["s2", day + 9 * HOUR, "assistant", v2reply(day + 9 * HOUR, 9999)]] })
    expect((await engineCodexRows(data, since))!.map((row) => row.id)).toEqual(["s2"])
    // (Its token never leaves the database: the worker answers only whether it's ChatGPT's.)
    expect(JSON.stringify(await engineCodexRows(data, since))).not.toContain("secret-access")
  })

  test("a database that can't be read, and none that could: not known now (never none); one the engine left without its -wal and -shm is read as it is", async () => {
    writeFileSync(join(data, "opencode.db"), "not a database " + "x".repeat(200))
    await expect(engineCodexRows(data, since)).rejects.toThrow()
    rmSync(join(data, "opencode.db"))
    // An engine that stopped: its database in WAL mode, its -wal and -shm gone, which a read-only open can't take.
    database("opencode.db", { signIn: { type: "oauth", access: "a", at: null }, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    const db = new Database(join(data, "opencode.db"))
    db.exec("PRAGMA journal_mode=WAL")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.close()
    rmSync(join(data, "opencode.db-wal"), { force: true })
    rmSync(join(data, "opencode.db-shm"), { force: true })
    expect((await engineCodexRows(data, since))!.map((row) => row.total)).toEqual([110])
  })

  test("an API key's sign-in, or none: nothing of it; before opencode 2 took its sign-ins in, the auth.json beside it says", async () => {
    database("opencode.db", { signIn: { type: "api", key: "sk-test", at: 0 }, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    expect(await engineCodexRows(data, since)).toBeUndefined()
    rmSync(join(data, "opencode.db"))
    database("opencode.db", { imported: false, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    expect(await engineCodexRows(data, since)).toBeUndefined()
    writeFileSync(join(data, "auth.json"), JSON.stringify({ openai: { type: "oauth", refresh: "r" } }))
    expect((await engineCodexRows(data, since))!.map((row) => row.total)).toEqual([110])
    // A database a channel of its own (`opencode-next.db`) too, its copy of the same message once.
    database("opencode-next.db", { imported: false, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    expect((await engineCodexRows(data, since))!.length).toBe(2)
    expect(engineCodexSlots((await engineCodexRows(data, since))!, codexPricing(), since).used.size).toBe(1)
  })

  test("its row is Codex's: the same ChatGPT account as a Codex account here is one row, both added up; read again only when a database changed", async () => {
    const root = mkdtempSync(join(base, "box-"))
    const home = join(root, "codex", "accounts", "work")
    mkdirSync(join(home, "sessions"), { recursive: true })
    writeFileSync(join(home, "sessions", "rollout-a.jsonl"), context("2026-11-12T10:00:00Z", "gpt-5") + turn("2026-11-12T10:01:00Z", 1000, 0))
    database("opencode.db", { signIn: { type: "oauth", access: "a", at: null }, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    const codex = codexSources(join(root, "usage"))
    let signedIn: boolean | undefined = true
    let usage: Usage
    const engine = engineCodexSource(data, () => signedIn, () => usage.has("openai"))
    const agents = [new TestCodex(root, { id: "work", home }) as unknown as Agent]
    usage = new Usage(() => [...codex(agents), ...engine()], new PricingStore(undefined, null), () => "0123456789abcdef", undefined, () => Date.parse("2026-11-12T21:00:00Z"))
    await usage.refresh()
    const view = usage.view("UTC")
    expect(view.rows).toHaveLength(1)
    expect(view.rows[0]!.id).toBe("codex#0123456789abcdef")
    expect(view.rows[0]!.boxes.map((box) => box.provider)).toEqual(["codex-cli@work", "openai"])
    expect(view.totals.codex![0]!.tokens).toBe(1110)
    // Signed out of ChatGPT in the engine: its share goes.
    signedIn = false
    await usage.refresh()
    expect(usage.view("UTC").totals.codex![0]!.tokens).toBe(1000)
    // As the bridge starts, before the engine has said what it's signed in to: kept, not dropped.
    signedIn = true
    await usage.refresh()
    signedIn = undefined
    await usage.refresh()
    expect(usage.view("UTC").totals.codex![0]!.tokens).toBe(1110)
    // A box that never had it, before the engine has said: no empty row of it (to show, or tell your other computers).
    let fresh: Usage
    const unknown = engineCodexSource(join(base, "no-engine-here"), () => undefined, () => fresh.has("openai"))
    fresh = new Usage(() => unknown(), new PricingStore(undefined, null), () => undefined, undefined, () => Date.parse("2026-11-12T21:00:00Z"))
    await fresh.refresh()
    expect(fresh.view("UTC").rows).toEqual([])

    // A database that can't be read now: what was read before stays, never none.
    signedIn = true
    const good = readFileSync(join(data, "opencode.db"))
    writeFileSync(join(data, "opencode.db"), "not a database, as far as SQLite can tell, " + "x".repeat(200))
    await usage.refresh()
    expect(usage.view("UTC").totals.codex![0]!.tokens).toBe(1110)
    writeFileSync(join(data, "opencode.db"), good)

    // Nothing changed: what was worked out is the same; a message more: read again.
    const source = engineCodexSource(data, () => true, () => true)()[0]!
    const pricing = new PricingStore(undefined, null).current()
    const first = await source.slots(pricing, since)
    expect(await source.slots(pricing, since)).toBe(first)
    const db = new Database(join(data, "opencode.db"))
    db.query("INSERT INTO message VALUES (?, ?, ?)").run("m2", day + 2 * HOUR, JSON.stringify(reply(day + 2 * HOUR, 5, 0)))
    db.close()
    const again = (await source.slots(pricing, since))!
    expect(again).not.toBe(first)
    expect([...again.used.values()].flatMap((models) => [...models.values()]).reduce((sum, use) => sum + use[0], 0)).toBe(115)
  })

  test("one database that can't be read while another can: not known now (what was read stays), never kept as whole; one that keeps failing doesn't hold up the rest", async () => {
    database("opencode.db", { signIn: { type: "oauth", access: "a", at: null }, v1: [["m1", day + HOUR, reply(day + HOUR, 100, 10)]] })
    database("opencode-next.db", { signIn: { type: "oauth", access: "a", at: null }, v1: [["n1", day + HOUR, reply(day + HOUR, 1000, 0)]] })
    const source = engineCodexSource(data, () => true, () => true)()[0]!
    const pricing = new PricingStore(undefined, null).current()
    const tokens = (slots: Awaited<ReturnType<typeof source.slots>>) => [...slots!.used.values()].flatMap((models) => [...models.values()]).reduce((sum, use) => sum + use[0], 0)
    expect(tokens(await source.slots(pricing, since))).toBe(1110)
    // The next channel's breaks: twice not known (the box keeps 1110), then the other counts alone.
    writeFileSync(join(data, "opencode-next.db"), "not a database at all, but long enough to look like one".repeat(100))
    await expect(source.slots(pricing, since)).rejects.toThrow()
    await expect(source.slots(pricing, since)).rejects.toThrow()
    expect(tokens(await source.slots(pricing, since))).toBe(110)
  })
})
