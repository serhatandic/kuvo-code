// What a Cursor account used, from Cursor's own record of it (its dashboard's usage events), asked
// with Kuvo Code's own Cursor sign-in (cursor-api.ts): every request on the account, wherever it ran,
// so it's the account's, not this computer's (a row takes the newest box's, never a sum: usage.ts).
// Asked a UTC day at a time, a page of a thousand events after another; today and yesterday asked
// again each round, an older day only until Cursor's answer for it was whole; what was asked kept
// per user (`cursor-history/`), and nothing kept of a day that didn't come whole. Priced here
// (pricing.ts), never with long-context rates (Cursor's events don't keep a request's whole prompt).
// UsageKit's `CursorSpendHistoryFetcher`, `CursorUsageEvents` and `CursorUsageHistoryStore`, ported
// (#631 piece D1), by the quarter hour rather than a calendar day.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LimitsProblem } from "../limits"
import { CursorClient, cursorSession } from "./cursor-api"
import { add, addUnknown, noSlots, SLOT, UNATTRIBUTED, type Slots } from "./history"
import { totalTokens, type Pricing, type Tokens } from "./pricing"

const DAY = 24 * 60 * 60_000
/** UTC days asked for: today and the 31 before, so any time zone's today and 30 days before are whole. */
export const CURSOR_DAYS = 32
/** A user's whole read stands for this long: rounds, refreshes and peers' refreshes don't ask Cursor again sooner. */
const MIN_BETWEEN = 60_000

/** One request, as Cursor's usage events state it. */
export interface CursorEvent {
  at: number
  model: string
  tokens: Tokens
}

/** `CursorUsageEvents.integer`: a JSON number that's a whole one (not a boolean). */
const integer = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined)

function tokenValue(usage: Record<string, unknown>, key: string): number | undefined {
  if (!(key in usage) || usage[key] === undefined) return 0
  const found = integer(usage[key])
  return found !== undefined && found >= 0 ? found : undefined
}

/** `CursorUsageEvents.parsePage`: a page's events, its total, and the events it couldn't read; undefined: not a page. */
export function cursorEventsPage(body: unknown): { events: CursorEvent[]; total: number; rejected: number } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const page = body as Record<string, unknown>
  const total = integer(page.totalUsageEventsCount)
  if (total === undefined || total < 0 || !Array.isArray(page.usageEventsDisplay)) return undefined
  const events: CursorEvent[] = []
  let rejected = 0
  for (const raw of page.usageEventsDisplay) {
    const event = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
    const at = event ? timestamp(event.timestamp) : undefined
    const model = typeof event?.model === "string" ? event.model : undefined
    const tokens = event ? breakdown(event, "tokenUsage") : undefined
    if (at === undefined || model === undefined || !tokens) {
      rejected++
      continue
    }
    events.push({ at, model: model.trim(), tokens })
  }
  return { events, total, rejected }
}

function breakdown(event: Record<string, unknown>, key: string): Tokens | undefined {
  // (None: none used. Anything but an object, `null` too, isn't one.)
  if (!(key in event) || event[key] === undefined) return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }
  const usage = event[key]
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined
  const fields = usage as Record<string, unknown>
  const input = tokenValue(fields, "inputTokens")
  const output = tokenValue(fields, "outputTokens")
  const cacheWrite = tokenValue(fields, "cacheWriteTokens")
  const cacheRead = tokenValue(fields, "cacheReadTokens")
  if (input === undefined || output === undefined || cacheWrite === undefined || cacheRead === undefined) return undefined
  return { input, cacheWrite5m: cacheWrite, cacheWrite1h: 0, cacheRead, output }
}

function timestamp(value: unknown): number | undefined {
  // (Text of a whole number, as Swift's `Int(_:)` reads it, or a whole number.)
  const ms = typeof value === "string" ? (/^[+-]?\d+$/.test(value) ? Number(value) : undefined) : integer(value)
  return ms !== undefined && Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined
}

/** One UTC day of an account's use, as kept: `[slot (quarter hours since 1970), model, input, output, cache writes, cache reads]`. */
export interface CursorDay {
  /** Cursor's answer was for the whole day (it had ended when it was asked). */
  complete: boolean
  uses: [number, string, number, number, number, number][]
}

type Failure = "http" | "request" | "invalid" | "incomplete"

/** UTC day `start` (ms) as `yyyy-MM-dd`. */
const dayKey = (start: number) => new Date(start).toISOString().slice(0, 10)

/**
 * Each Cursor user's days as asked (`cursor-history/<a hash of the user>.json` in the usage folder),
 * and asking for those due. One read at a time per user.
 */
export class CursorHistory {
  private kept = new Map<string, Map<string, CursorDay>>()
  private reading = new Map<string, Promise<Map<string, CursorDay>>>()
  /** Each user's last whole read, and when: asked again within a minute (a refresh, a peer's), it stands. */
  private last = new Map<string, { at: number; days: Map<string, CursorDay> }>()

  constructor(
    /** Where each user's days are kept (`usage/cursor-history`); none in a test that doesn't. */
    private readonly folder?: string,
    private readonly options: {
      /** Resolves when a read has gone on long enough (UsageKit's 20 s): the days that came are kept, the rest asked next round. */
      deadline?: () => { done: Promise<void>; cancel(): void }
      concurrency?: number
      pageSize?: number
      log?: (line: string) => void
    } = {},
  ) {}

  /**
   * The account's days, today's and the 31 before (UTC), all of them: what's due asked now, the rest
   * as kept. Throws when one of them can't be had (nothing kept of it, and Cursor didn't answer it
   * whole), so what the box had stays: never a day of nothing in place of one not known.
   */
  async read(client: CursorClient, now: number): Promise<Map<string, CursorDay>> {
    const access = await client.accessToken()
    const user = cursorSession(access)?.user
    if (!user) throw new LimitsProblem("failed", "Cursor's sign-in doesn't say whose it is.")
    const key = createHash("sha256").update("kuvo-code cursor history v1\n").update(user).digest("hex").slice(0, 16)
    const under = this.reading.get(key)
    if (under) return under
    const last = this.last.get(key)
    if (last && now >= last.at && now - last.at < MIN_BETWEEN && Math.floor(now / DAY) === Math.floor(last.at / DAY)) return last.days
    const read = this.readFor(client, access, key, now)
      .then((days) => {
        this.last.set(key, { at: now, days })
        return days
      })
      .finally(() => this.reading.delete(key))
    this.reading.set(key, read)
    return read
  }

  private async readFor(client: CursorClient, access: string, key: string, now: number): Promise<Map<string, CursorDay>> {
    const today = Math.floor(now / DAY) * DAY
    const window = Array.from({ length: CURSOR_DAYS }, (_, back) => {
      const start = today - back * DAY
      const end = Math.min(start + DAY, now)
      return { key: dayKey(start), start, end, complete: end === start + DAY }
    })
    const keys = new Set(window.map((day) => day.key))
    const cached = new Map([...this.load(key)].filter(([day]) => keys.has(day)))
    const due = window.filter((day, index) => index < 2 || !cached.get(day.key)?.complete)
    let failures = 0
    let first: Failure | undefined
    let succeeded = 0
    let stopped = false
    const deadline = (this.options.deadline ?? defaultDeadline)()
    const queue = [...due]
    const worker = async () => {
      for (let day = queue.shift(); day && !stopped; day = queue.shift()) {
        const result = await this.fetchDay(client, access, day, () => stopped)
        if (stopped) return
        if (typeof result === "string") {
          failures++
          first ??= result
        } else {
          succeeded++
          cached.set(day.key, result)
        }
      }
    }
    const workers = Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 4, due.length) }, worker))
    try {
      const hit = await Promise.race([workers.then(() => false), deadline.done.then(() => true)])
      if (hit) {
        stopped = true
        const missing = window.filter((day) => !cached.has(day.key)).length
        this.log(`usage: Cursor's usage events: the time ran out with ${missing} of ${window.length} days still missing`)
      }
    } finally {
      deadline.cancel()
    }
    if (failures) this.log(`usage: Cursor's usage events: ${failures} day${failures === 1 ? "" : "s"} failed (${first})`)
    if (succeeded) this.save(key, cached)
    if (!window.every((day) => cached.has(day.key))) throw new Error(`Cursor's usage events: ${window.filter((day) => !cached.has(day.key)).length} of ${window.length} days aren't known yet.`)
    return new Map(window.map((day) => [day.key, cached.get(day.key)!]))
  }

  /** One UTC day, page after page until Cursor has said all of it; what it didn't say whole is a failure. */
  private async fetchDay(client: CursorClient, access: string, day: { key: string; start: number; end: number; complete: boolean }, stopped: () => boolean): Promise<CursorDay | Failure> {
    const pageSize = this.options.pageSize ?? 1000
    let page = 1
    let expected: number | undefined
    let received = 0
    const uses = new Map<string, [number, string, number, number, number, number]>()
    for (;;) {
      // (Out of time: no page more, as UsageKit's task group was cancelled.)
      if (stopped()) return "request"
      let answer
      try {
        answer = await client.website("/api/dashboard/get-filtered-usage-events", access, { method: "POST", body: { startDate: String(day.start), endDate: String(day.end - 1), page, pageSize } }, 15_000)
      } catch {
        return "request"
      }
      if (!answer) return "request"
      if (answer.status < 200 || answer.status >= 300) return "http"
      const parsed = cursorEventsPage(answer.body)
      if (!parsed) return "invalid"
      if (expected !== undefined && parsed.total !== expected) return "incomplete"
      expected = parsed.total
      const count = parsed.events.length + parsed.rejected
      received += count
      if (parsed.rejected) this.log(`usage: Cursor's usage events: ${parsed.rejected} event${parsed.rejected === 1 ? "" : "s"} it couldn't read on one page`)
      if (parsed.total === 0) return count === 0 ? { complete: day.complete, uses: [...uses.values()] } : "incomplete"
      if (count === 0 && received < parsed.total) return "incomplete"
      for (const event of parsed.events) {
        if (event.at < day.start || event.at >= day.start + DAY) return "invalid"
        const slot = Math.floor(event.at / SLOT)
        const id = `${slot}\n${event.model}`
        const use = uses.get(id)
        if (use) {
          use[2] += event.tokens.input
          use[3] += event.tokens.output
          use[4] += event.tokens.cacheWrite5m
          use[5] += event.tokens.cacheRead
        } else uses.set(id, [slot, event.model, event.tokens.input, event.tokens.output, event.tokens.cacheWrite5m, event.tokens.cacheRead])
      }
      if (received === parsed.total) return { complete: day.complete, uses: [...uses.values()] }
      if (received > parsed.total) return "incomplete"
      page++
    }
  }

  private log(line: string) {
    ;(this.options.log ?? ((each: string) => console.error(each)))(line)
  }

  private load(key: string): Map<string, CursorDay> {
    const kept = this.kept.get(key)
    if (kept) return kept
    const days = new Map<string, CursorDay>()
    if (this.folder) {
      try {
        const saved = JSON.parse(readFileSync(join(this.folder, `${key}.json`), "utf8"))
        if (saved?.version === 1 && saved.user === key && saved.days && typeof saved.days === "object") {
          for (const [day, value] of Object.entries(saved.days as Record<string, any>)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== "object" || !Array.isArray(value.uses)) continue
            const uses = value.uses.filter((use: unknown): use is CursorDay["uses"][number] => Array.isArray(use) && use.length === 6 && Number.isSafeInteger(use[0]) && typeof use[1] === "string" && use.slice(2).every((each) => Number.isSafeInteger(each) && (each as number) >= 0))
            days.set(day, { complete: value.complete === true, uses })
          }
        }
      } catch {}
    }
    this.kept.set(key, days)
    return days
  }

  private save(key: string, days: Map<string, CursorDay>) {
    this.kept.set(key, days)
    if (!this.folder) return
    try {
      mkdirSync(this.folder, { recursive: true, mode: 0o700 })
      const file = join(this.folder, `${key}.json`)
      writeFileSync(file + ".new", JSON.stringify({ version: 1, user: key, days: Object.fromEntries(days) }), { mode: 0o600 })
      renameSync(file + ".new", file)
    } catch {
      this.log("usage: Cursor's usage history couldn't be kept")
    }
  }
}

function defaultDeadline() {
  let timer: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 20_000)
    timer.unref?.()
  })
  return { done, cancel: () => clearTimeout(timer) }
}

/**
 * The days' uses from `since` (ms) on, priced (UsageKit's `CursorUsageMapper.appendSpendLines`): a
 * model that can't be priced counts nowhere, and is named as unknown where it used any tokens; a use
 * with no model but a price is `Unattributed`.
 */
export function cursorSlots(days: Iterable<CursorDay>, pricing: Pricing, since: number): Slots {
  const slots = noSlots()
  for (const day of days) {
    for (const [index, model, input, output, cacheWrite, cacheRead] of day.uses) {
      const slot = index * SLOT
      if (slot < since) continue
      const tokens: Tokens = { input, cacheWrite5m: cacheWrite, cacheWrite1h: 0, cacheRead, output }
      const cost = pricing.cost(model, tokens, false)
      if (cost === undefined) {
        if (totalTokens(tokens) > 0 && model) addUnknown(slots, slot, model)
        continue
      }
      add(slots, slot, model || UNATTRIBUTED, totalTokens(tokens), cost)
    }
  }
  return slots
}
