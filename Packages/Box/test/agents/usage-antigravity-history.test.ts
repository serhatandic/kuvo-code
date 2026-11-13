import "../safety"
import { afterAll, describe, expect, test } from "bun:test"
import type { Agent } from "../../src/agents/agent"
import { antigravitySources, claudeSources, placeOf, Usage } from "../../src/agents/usage/usage"
import { ClaudeAgent } from "../../src/agents/agents/claude"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AntigravityHistory, antigravityDatabases, antigravitySlots, generationEvent, MAXIMUM_BLOB_BYTES, modelCandidates, readAntigravityDatabase } from "../../src/agents/usage/antigravity-history"
import { daysIn } from "../../src/agents/usage/history"
import { Catalog, Pricing, PricingStore, supplementFrom } from "../../src/agents/usage/pricing"

const base = realpathSync(mkdtempSync(join(tmpdir(), "antigravity-history-test-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/usage/antigravity-blobs.json"), "utf8"))
const data = (hex: string) => Buffer.from(hex, "hex")
const pricing = new Pricing(supplementFrom({ pricing: {}, alias_rules: [] }), new Catalog(new Map([["gemini-3.6-flash", { input: 1, output: 4, cacheWrite: 1, cacheRead: 0.25, cacheReadIsExplicit: true, longContextThreshold: 200_000, fast: 1 }]])), new Catalog())
function store(options: { steps?: boolean; wal?: boolean } = {}) {
  const home = mkdtempSync(join(base, "profile-"))
  const folder = join(home, "antigravity", "conversations")
  mkdirSync(folder, { recursive: true })
  const path = join(folder, "conversation.db")
  const db = new Database(path)
  if (options.wal) db.exec("PRAGMA journal_mode=WAL")
  db.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)")
  if (options.steps !== false) db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)")
  return { home, folder, path, db }
}
function insert(db: Database, index: number, each = fixture.cases[0]) {
  db.query("INSERT INTO gen_metadata VALUES (?,?)").run(index, data(each.hex))
  if (each.stepHex) db.query("INSERT INTO steps VALUES (?,?)").run(index, data(each.stepHex))
}

describe("Antigravity's bounded local history", () => {
  test("shared blob fixtures decode exactly as Swift, including fallback time and malformed messages", () => {
    for (const each of fixture.cases) expect(generationEvent(data(each.hex), each.stepHex ? data(each.stepHex) : undefined) ?? null).toEqual(each.expected)
    expect(modelCandidates("gemini-pro-default", "Gemini 3.6 Flash")).toEqual(["Gemini 3.6 Flash", "gemini-pro-default"])
    expect(modelCandidates("gemini-3.6-flash-tiered")).toEqual(["gemini-3.6-flash"])
  })
  test("read-only SQLite batches and pricing match Swift's shared expected days", async () => {
    const { home, db, path } = store()
    fixture.cases.forEach((each: any, index: number) => insert(db, index, each))
    db.close()
    const before = statSync(path)
    const history = new AntigravityHistory()
    const events = await history.scan(home, 0)
    const days = daysIn(antigravitySlots(events, pricing, 0), "UTC", Date.parse(fixture.now))
    for (const [index, expected] of fixture.days.entries()) {
      expect(days[index]!.date).toBe(expected.date)
      expect(days[index]!.tokens).toBe(expected.tokens)
      expect(days[index]!.cost).toBeCloseTo(expected.cost, 10)
      expect(days[index]!.models.map((m) => m.model)).toEqual([expected.model])
      expect(days[index]!.unknown).toEqual(expected.unknown)
    }
    expect(await history.scan(home, 0)).toBe(events)
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
    expect(statSync(path).size).toBe(before.size)
  })
  test("WAL-only changes invalidate a cached scan, and a later cutoff prunes it", async () => {
    const { home, db } = store({ wal: true })
    try {
      insert(db, 0)
      const history = new AntigravityHistory()
      expect(await history.scan(home, 0)).toHaveLength(1)
      insert(db, 1)
      expect(await history.scan(home, 0)).toHaveLength(2)
      expect(await history.scan(home, Date.parse(fixture.now) + 1)).toHaveLength(0)
    } finally { db.close() }
  })
  test("legacy databases without steps, then gaining metadata, are re-read", async () => {
    const { home, db } = store({ steps: false })
    const history = new AntigravityHistory()
    try {
      const modern = fixture.cases[1]
      db.query("INSERT INTO gen_metadata VALUES (?,?)").run(0, data(modern.hex))
      expect(await history.scan(home, 0)).toEqual([])
      db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB)")
      db.query("INSERT INTO steps VALUES (?,?)").run(0, data(modern.stepHex))
      expect(await history.scan(home, 0)).toEqual([modern.expected])
    } finally { db.close() }
  })
  test("oversized blobs are skipped, and an unreadable new database is logged once and left out while the others count", async () => {
    const { home, db, path } = store()
    insert(db, 0)
    db.close()
    const logged: string[] = []
    const history = new AntigravityHistory(undefined, undefined, (message) => logged.push(message))
    expect(await history.scan(home, 0)).toHaveLength(1)
    const writable = new Database(path)
    writable.query("INSERT INTO gen_metadata VALUES (?,?)").run(1, new Uint8Array(MAXIMUM_BLOB_BYTES + 1))
    writable.close()
    expect(await history.scan(home, 0)).toHaveLength(1)
    const repair = new Database(path)
    repair.exec("DELETE FROM gen_metadata WHERE idx=1")
    repair.close()
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(logged).toEqual([])
    const broken = join(home, "antigravity", "conversations", "broken.db")
    writeFileSync(broken, "not SQLite")
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(realpathSync(broken))
    // A database without gen_metadata, and a link to one that's gone, are left out the same way.
    new Database(join(home, "antigravity", "conversations", "other.db")).close()
    symlinkSync(join(home, "absent.db"), join(home, "antigravity", "conversations", "dangling.db"))
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(logged).toHaveLength(3)
    expect(logged.slice(1).join("\n")).toContain("other.db")
    expect(logged.slice(1).join("\n")).toContain("dangling.db")
    // Repaired, it counts.
    rmSync(broken)
    const copy = new Database(broken); copy.exec("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)"); insert(copy, 0); copy.close()
    expect(await history.scan(home, 0)).toHaveLength(2)
  })
  test("a conversations folder that can't be listed is logged once and left out while the others count", async () => {
    const { home, db } = store()
    insert(db, 0)
    db.close()
    // (A file where a folder should be: listing it fails on macOS and Linux alike, whoever runs it.)
    writeFileSync(join(home, "antigravity-broken"), "")
    mkdirSync(join(home, "antigravity-file"))
    writeFileSync(join(home, "antigravity-file", "conversations"), "")
    const logged: string[] = []
    const history = new AntigravityHistory(undefined, undefined, (message) => logged.push(message))
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(await history.scan(home, 0)).toHaveLength(1)
    expect(logged).toHaveLength(2)
    expect(logged.join("\n")).toContain(join(home, "antigravity-file", "conversations"))
  })
  test("missing stores are empty and symlinked stores count only once", async () => {
    const { home, db } = store()
    insert(db, 0)
    db.close()
    symlinkSync(join(home, "antigravity"), join(home, "antigravity-2"))
    expect(antigravityDatabases(home)).toHaveLength(1)
    expect(await new AntigravityHistory().scan(home, 0)).toHaveLength(1)
    expect(await new AntigravityHistory().scan(join(base, "absent"), 0)).toEqual([])
  })
})


test("own profiles alone, machine-hashed places, and an unreadable new database leaves the rest of the account counted", async () => {
  const own = store()
  insert(own.db, 0)
  own.db.close()
  const other = store()
  insert(other.db, 0)
  other.db.close()
  const agent = { providerID: "antigravity@work", profile: own.home, instance: { id: "work", label: "Work" } } as unknown as Agent
  const sources = antigravitySources(undefined, () => "machine-one")
  expect(sources([{ providerID: "grok-cli", profile: other.home } as unknown as Agent])).toEqual([])
  const source = sources([agent])[0]!
  expect(source.places!()).toEqual([placeOf("machine-one", own.home)])
  expect(source.places!()).not.toEqual([placeOf("machine-two", own.home)])
  expect(source.places!()[0]).toMatch(/^[a-f0-9]{16}$/)
  const first = await source.slots(pricing, 0)
  expect(await source.slots(pricing, 0)).toBe(first)
  let now = Date.parse(fixture.now)
  const usage = new Usage(() => sources([agent]), { current: () => pricing } as unknown as PricingStore, () => "0123456789abcdef", undefined, () => now)
  await usage.refresh()
  const before = usage.view("UTC")
  expect(before.rows.map((row) => row.id)).toEqual(["antigravity#0123456789abcdef"])
  expect(before.totals.antigravity?.[0]?.tokens).toBe(1350)
  writeFileSync(join(own.folder, "partial.db"), "broken SQLite")
  now += 5 * 60_000
  await usage.refresh()
  expect(usage.view("UTC").totals).toEqual(before.totals)
  expect(usage.own()[0]!.scanned).toBe(now)
  rmSync(join(own.folder, "partial.db"))
  rmSync(own.path)
  expect(await source.slots(pricing, 0)).toEqual({ used: new Map(), unknown: new Map(), fallback: new Map() })
})

 test("deleted databases leave the total after restart and do not block the remaining stores", async () => {
  const own = store()
  insert(own.db, 0); own.db.close()
  const second = join(own.folder, "second.db")
  writeFileSync(second, readFileSync(own.path))
  const folder = mkdtempSync(join(base, "restart-"))
  const file = join(folder, "usage.json")
  const agent = { providerID: "antigravity", profile: own.home, instance: { id: "default" } } as unknown as Agent
  const make = () => {
    const sources = antigravitySources(folder, () => "machine-one")
    return new Usage(() => sources([agent]), { current: () => pricing } as unknown as PricingStore, () => "0123456789abcdef", file, () => Date.parse(fixture.now))
  }
  const first = make(); await first.refresh()
  const totals = first.view("UTC").totals
  rmSync(second)
  const restarted = make(); await restarted.refresh()
  expect(restarted.view("UTC").totals.antigravity![0]!.tokens).toEqual(totals.antigravity![0]!.tokens / 2)
  expect(restarted.view("UTC").totals.antigravity![0]!.cost).toBeCloseTo(totals.antigravity![0]!.cost / 2, 12)
  rmSync(own.path)
  const absent = make(); await absent.refresh()
  expect(absent.view("UTC").totals.antigravity).toEqual([])
})


test("per-database cache reads only changed stores, ages out idle ones, and keeps changing/unreadable stores' last events", async () => {
  const own = store()
  insert(own.db, 0); own.db.close()
  const second = join(own.folder, "second.db")
  writeFileSync(second, readFileSync(own.path))
  const reads: string[] = []
  let changing = false
  const history = new AntigravityHistory(undefined, async (path) => {
    reads.push(path)
    const events = await readAntigravityDatabase(path)
    if (changing && path === own.path) utimesSync(path, new Date(), new Date(Date.now() + 5000))
    return events
  })
  expect(await history.scan(own.home, 0)).toHaveLength(2)
  expect(reads).toEqual([own.path, second])
  const append = (path: string, index: number) => {
    const db = new Database(path); insert(db, index); db.close()
  }
  append(second, 1)
  expect(await history.scan(own.home, 0)).toHaveLength(3)
  expect(reads).toEqual([own.path, second, second])
  changing = true
  append(own.path, 1)
  append(second, 2)
  // The changing store keeps one, the other advances from two to three.
  expect(await history.scan(own.home, 0)).toHaveLength(4)
  changing = false
  expect(await history.scan(own.home, 0)).toHaveLength(5)
  writeFileSync(own.path, "unreadable SQLite")
  append(second, 3)
  expect(await history.scan(own.home, 0)).toHaveLength(6)
  rmSync(own.path)
  append(second, 4)
  expect(await history.scan(own.home, 0)).toHaveLength(5)
  utimesSync(second, new Date(1000), new Date(1000))
  const count = reads.length
  expect(await history.scan(own.home, 2000)).toEqual([])
  expect(reads).toHaveLength(count)
})

test("blob bounds match Swift: skip oversized generations and absent step timing, retain embedded timing and the inclusive cap", async () => {
  const { home, db } = store()
  for (const [index, row] of fixture.bounded.rows.entries()) {
    const each = fixture.cases[row.case]
    let blob = data(each.hex)
    if (row.dataBytes) { const padded = Buffer.alloc(row.dataBytes); blob.copy(padded); blob = padded }
    db.query("INSERT INTO gen_metadata VALUES (?,?)").run(index, blob)
    if (row.stepBytes) db.query("INSERT INTO steps VALUES (?,?)").run(index, Buffer.alloc(row.stepBytes))
    else if (each.stepHex) db.query("INSERT INTO steps VALUES (?,?)").run(index, data(each.stepHex))
  }
  db.close()
  const events = await new AntigravityHistory().scan(home, 0)
  expect(events).toHaveLength(fixture.bounded.events)
  const day = daysIn(antigravitySlots(events, pricing, 0), "UTC", Date.parse(fixture.now))[0]!
  expect(day.tokens).toBe(fixture.bounded.tokens)
  expect(day.cost).toBeCloseTo(fixture.bounded.cost, 10)
})

test("shared missing/empty profile fixtures contain no history, as Swift", async () => {
  const cases = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/usage/antigravity-empty-cases.json"), "utf8")) as { name: string; database: boolean; tokens: number }[]
  for (const each of cases) {
    let home: string
    if (each.database) { const empty = store(); empty.db.close(); home = empty.home }
    else home = join(base, "missing-empty-parity")
    const events = await new AntigravityHistory().scan(home, 0)
    expect(events.reduce((tokens, e) => tokens + e.inputTokens + e.outputTokens + e.cacheReadTokens, 0), each.name).toBe(each.tokens)
  }
})

test("an Antigravity database that can't be read never holds up forgetting the other services' deleted logs", async () => {
  const own = store()
  insert(own.db, 0); own.db.close()
  writeFileSync(join(own.folder, "broken.db"), "not SQLite")
  const home = mkdtempSync(join(base, "claude-"))
  const account = join(home, "claude", "accounts", "work")
  const project = join(account, "projects", "-work-site")
  mkdirSync(project, { recursive: true })
  const at = Date.parse(fixture.now)
  const reply = (id: string) => JSON.stringify({ type: "assistant", timestamp: new Date(at - 60_000).toISOString(), sessionId: "s", version: "2.1.300", requestId: `req_${id}`, message: { id: `msg_${id}`, model: "claude-opus-4-5", role: "assistant", usage: { input_tokens: 100, output_tokens: 10 } } }) + "\n"
  writeFileSync(join(project, "one.jsonl"), reply("1"))
  writeFileSync(join(project, "two.jsonl"), reply("2"))
  const claude = new ClaudeAgent({ home, temporary: home, deps: {} as any }, { id: "work", home: account }) as unknown as Agent
  const antigravity = { providerID: "antigravity", profile: own.home, instance: { id: "default" } } as unknown as Agent
  const folder = join(home, "usage")
  const claudeOf = claudeSources(folder)
  const antigravityOf = antigravitySources(folder, () => "machine-one")
  const usage = new Usage(() => [...claudeOf([claude]), ...antigravityOf([antigravity])], new PricingStore(undefined, null), () => "0123456789abcdef", join(folder, "usage.json"), () => at)
  await usage.refresh()
  const totals = usage.view("UTC").totals
  expect(totals.claude?.[0]?.tokens).toBe(220)
  expect(totals.antigravity?.[0]?.tokens).toBe(1350)
  expect(readdirSync(join(folder, "claude-files"))).toHaveLength(2)
  rmSync(join(project, "two.jsonl"))
  await usage.refresh()
  // The round is whole: Claude's deleted log is forgotten, here and on disk.
  expect(usage.view("UTC").totals.claude?.[0]?.tokens).toBe(110)
  expect(readdirSync(join(folder, "claude-files"))).toHaveLength(1)
  expect(usage.view("UTC").totals.antigravity?.[0]?.tokens).toBe(1350)
})

test("a new database written to while it's read counts what was read, is read again next round, and never saves $0", async () => {
  const own = store({ wal: true })
  try {
    insert(own.db, 0)
    const reads: string[] = []
    let writing = true, index = 1
    // (Antigravity writing its next generation while the box reads: the WAL changes under the read.)
    const history = new AntigravityHistory(undefined, async (path) => {
      reads.push(path)
      const events = await readAntigravityDatabase(path)
      if (writing) insert(own.db, index++)
      return events
    }, () => { throw new Error("a database written to while read isn't a failure") })
    const folder = mkdtempSync(join(base, "changing-"))
    const agent = { providerID: "antigravity", profile: own.home, instance: { id: "default" } } as unknown as Agent
    const sources = antigravitySources(folder, () => "machine-one", history)
    const file = join(folder, "usage.json")
    const usage = new Usage(() => sources([agent]), { current: () => pricing } as unknown as PricingStore, () => "0123456789abcdef", file, () => Date.parse(fixture.now))
    await usage.refresh()
    // What the read saw counts, and is what's saved: not $0.
    const first = usage.view("UTC").totals.antigravity![0]!
    expect(first.tokens).toBe(1350)
    expect(first.cost).toBeGreaterThan(0)
    expect(readFileSync(file, "utf8")).toContain("antigravity")
    // (As a restart finds it, before reading anything.)
    const saved = new Usage(() => sources([agent]), { current: () => pricing } as unknown as PricingStore, () => "0123456789abcdef", file, () => Date.parse(fixture.now))
    expect(saved.view("UTC").totals.antigravity?.[0]?.tokens).toBe(1350)
    // Not kept under the stamp from before the read: the next round, written to again as it's
    // read, reads it again and counts what it sees, never the first round's answer.
    await usage.refresh()
    expect(reads).toEqual([realpathSync(own.path), realpathSync(own.path)])
    expect(usage.view("UTC").totals.antigravity![0]!.tokens).toBe(2700)
    // Quiet now: read once more and kept, then not read again while unchanged.
    writing = false
    await usage.refresh()
    expect(usage.view("UTC").totals.antigravity![0]!.tokens).toBe(4050)
    await usage.refresh()
    expect(reads).toHaveLength(3)
  } finally { own.db.close() }
})
