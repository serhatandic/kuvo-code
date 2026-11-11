// Your plans' limits (a 5-hour window, a week, a model's own week, a month's requests) and credits,
// for each account this box runs that's signed in to Kuvo Code (each coding agent's accounts, and the
// engine's sign-ins), read from those sign-ins only, never a tool's own login elsewhere on the
// computer: what the clients' usage menus show, one row per account, and what an agent paces its
// work by (`plan_limits`). Each account reads its own (`LimitsSource`; an agent's is `Agent.limits`),
// and an agent tells what a turn heard on the way (`LimitsSource.heard`). This keeps the
// last reading of each, on disk too, reads again as often as each maker allows, holds off after a
// 429 for as long as it says (every account that shares the maker's limit on reads), and tells the
// clients when anything changes (`kuvo.limits.updated`). PROTOCOL.md, "Plan limits".

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { AgentKind } from "./accounts"
import { parseProvider } from "./accounts"
import type { Agent } from "./agent"
import { emit } from "./events"

/** The services whose limits a box states, by the name clients know them by (their marks and colors). */
export type LimitsService = "claude" | "codex" | "grok" | "cursor" | "antigravity" | "copilot" | "openrouter" | "zai" | "ollama" | "opencode"

/** One window of a plan's limit, as its maker says it. */
export interface LimitWindow {
  /** Its maker's own name for it: `five_hour`, `seven_day`, `seven_day_sonnet`, Codex's `primary`… */
  id: string
  /** How much of it is used, from 0 to 1. */
  used: number
  /** When it starts over, in ms since 1970, when its maker says. */
  resetsAt?: number
  /** How long it is, in minutes, when its maker says (300: five hours; 10080: a week). */
  minutes?: number
  /** The model it's for, as its maker names it ("Sonnet", "Fable"); none for the whole plan's. */
  model?: string
  /** Its maker's name for what it counts, where that isn't a model or the plan's time ("Premium requests", "Web searches"). */
  name?: string
  /** A count's or an amount's own numbers, where the limit is one (300 premium requests, $50): `used` is their share. */
  amount?: { used: number; limit: number; unit: "requests" | "usd" | "credits" }
  /** When this was read, in ms since 1970. */
  read: number
  /** Read from the maker's own account of the plan (`usage`), or heard in a turn (`turn`). */
  source: "usage" | "turn"
}

/** What an agent read of its plan just now. */
export interface LimitReading {
  windows: Omit<LimitWindow, "read" | "source">[]
  /** The plan, in its maker's words ("Max 20x", "Pro"), when it says. */
  plan?: string
  /** Credits left to spend, where the account has them (OpenRouter's), and the most it can, when there's a cap. */
  balance?: { left: number; limit?: number; unit: "usd" | "credits" }
  /** Who the account is, where only its maker's answer says (GitHub's login): as `LimitsSource.identity`. */
  identity?: string
}

/**
 * Why an account's limits couldn't be read just now:
 * - `rate-limited`: its maker turned the read away for now (`until`, when it says);
 * - `expired`: its sign-in lapsed or was turned away, and its agent renews it the next time it runs;
 * - `unreadable`: its sign-in can run the agent but not read the plan's limits;
 * - `failed`: anything else (the network, its maker answering something else);
 * - `none`: the account has no plan limits to read (signed out, or an API key): it isn't listed.
 */
export type LimitsProblemKind = "rate-limited" | "expired" | "unreadable" | "failed" | "none"

export class LimitsProblem extends Error {
  constructor(
    readonly kind: LimitsProblemKind,
    message: string,
    /** When it may be read again, in ms since 1970, when its maker says. */
    readonly until?: number,
    /** Whether a request went to its maker (false: what's kept here said so first). */
    readonly sent = true,
  ) {
    super(message)
  }
}

/** How an account reads its plan's limits. */
export interface LimitsSource {
  /**
   * Reads them now (`now`, the box's clock); throws a `LimitsProblem` when it can't, and answers
   * null when there's nothing to read now (what it has stays). None for an account whose limits only
   * its turns tell (`heard`).
   */
  read?(now: number): Promise<LimitReading | null>
  /**
   * Its sign-in as it is now, as a fingerprint (never the secret): one that lapsed, or can't read its
   * limits, isn't asked again until this changes; for one only its turns tell of (no `read`), what
   * they told goes when it changes.
   */
  signIn?(): string | undefined
  /** The least time between two reads, in ms: as often as its maker's endpoint allows. */
  every: number
  /** Accounts whose reads share one limit at their maker (Anthropic's applies to the computer, not a sign-in): one turned away holds them all. */
  bucket?: string
  /** Set by the box: a window a turn heard of (a rate-limit event), told as it comes. */
  heard?: (window: Omit<LimitWindow, "read" | "source">) => void
  /**
   * Who the account is at its maker, as its sign-in says, the same on every computer signed in to
   * it: its maker's own account ID (`anthropic:<account>|<organization>`, `chatgpt:<account>/<user>`,
   * `xai:<user>`), or `key:<the key>` for an API key. Never an email. Only ever hashed before it
   * leaves (`identityOf`); undefined where the sign-in doesn't say (a Mac's Claude token before
   * Claude Code has run with it).
   */
  identity?(): string | undefined
}

/** An account whose limits are read: a coding agent's, or a sign-in of the engine's. */
export interface LimitedAccount {
  /** Its provider: `claude-code`, `claude-code@<id>` for one you added, the engine's `github-copilot`… */
  provider: string
  service: LimitsService
  /** For a coding agent's: which agent, and `default` for its own sign-in or the ID of one you added. */
  agent?: { kind: AgentKind; account: string }
  /** What you called it ("Work"), for one you added. */
  label?: string
  limits: LimitsSource
}

/** One account's limits, as the box states them (`GET api/kuvo/limits`). */
export interface AccountLimits {
  provider: string
  service: LimitsService
  /** For a coding agent's account (absent for the engine's sign-ins). */
  agent?: AgentKind
  account?: string
  label?: string
  /**
   * The account at its maker, the same from every computer signed in to it, so a client lists it
   * once: 16 hex characters of a hash, never the ID itself (`identityOf`). Absent where it isn't known.
   */
  identity?: string
  plan?: string
  windows: LimitWindow[]
  balance?: LimitReading["balance"]
  /** When it was last read from its maker, whatever came of it, in ms. */
  checked?: number
  /** When it will be read again, in ms. */
  next?: number
  /** Why the last read didn't work (the windows are as last read, with when). */
  problem?: { kind: Exclude<LimitsProblemKind, "none">; message: string; until?: number }
}

interface Entry {
  plan?: string
  windows: LimitWindow[]
  balance?: LimitReading["balance"]
  checked?: number
  next: number
  problem?: { kind: LimitsProblemKind; message: string; until?: number }
  /** The sign-in a lapsed or unreadable one was, as `LimitsSource.signIn` gave it. */
  signIn?: string
  /** Reads turned away in a row (each holds off longer). */
  refusals?: number
  /** Reads that failed in a row. */
  failures?: number
  /** Who it is (`identityOf`), as last known. */
  identity?: string
  /** For an account only its turns tell of (no `read`): the sign-in (`LimitsSource.signIn`) what's kept was heard with. */
  heardAs?: string
}

interface Saved {
  accounts: Record<string, Entry>
  /** Makers' holds on reads, by bucket: until when, in ms. */
  holds: Record<string, number>
  /** When each bucket was last asked, in ms. */
  asked?: Record<string, number>
  /** Reads each bucket turned away in a row. */
  refusals?: Record<string, number>
}

const MINUTE = 60_000
/** A 429 without a time: an hour, then longer each time, up to six hours. */
const FIRST_HOLD = 60 * MINUTE
const LONGEST_HOLD = 6 * 60 * MINUTE
/** A read that failed: five minutes, then longer, up to half an hour. */
const FIRST_RETRY = 5 * MINUTE
const LONGEST_RETRY = 30 * MINUTE
/** An account with nothing to read (signed out, an API key), looked at again. */
const NOTHING_AGAIN = 30 * MINUTE
/** A refresh asked for (a client, an agent's tool) reads an account read longer ago than this. */
const FRESH_ENOUGH = MINUTE

export class Limits {
  private entries = new Map<string, Entry>()
  private holds = new Map<string, number>()
  /** When each maker's bucket was last asked, in ms. */
  private asked = new Map<string, number>()
  /** Reads each maker's bucket turned away in a row. */
  private refusals = new Map<string, number>()
  private reading?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private said = ""

  constructor(
    private readonly accounts: () => LimitedAccount[],
    /** Where they're kept between runs (`limits.json` in the bridge's folder); none in a test that doesn't. */
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    /** Before each round of reads: what lists the accounts asked again (the engine's sign-ins). */
    private readonly prepare?: () => Promise<void>,
    /** Whether what lists the accounts has said them all (the engine answered): until then, none is gone. */
    private readonly settled: () => boolean = () => true,
  ) {
    this.load()
    this.said = JSON.stringify(this.list())
  }

  /** Reads what's due every minute, and listens to what turns hear. */
  start() {
    this.timer ??= setInterval(() => void this.tick(), MINUTE)
    this.timer.unref?.()
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The accounts with plan limits: each agent's own sign-in first, then the ones you added, then the engine's. */
  list(): AccountLimits[] {
    const listed: AccountLimits[] = []
    for (const account of this.accounts()) {
      const entry = this.entries.get(account.provider)
      if (!entry || entry.problem?.kind === "none") continue
      // Nothing read yet, and nothing heard: not one to show until it's tried (one signed in to
      // another account since says so).
      if (!entry.checked && !entry.windows.length && !entry.problem) continue
      const problem = entry.problem ? { kind: entry.problem.kind, message: entry.problem.message, ...(entry.problem.until ? { until: entry.problem.until } : {}) } : undefined
      listed.push({
        provider: account.provider,
        service: account.service,
        ...(account.agent ? { agent: account.agent.kind, account: account.agent.account } : {}),
        ...(account.label ? { label: account.label } : {}),
        ...(entry.identity ? { identity: entry.identity } : {}),
        ...(entry.plan ? { plan: entry.plan } : {}),
        windows: entry.windows,
        ...(entry.balance ? { balance: entry.balance } : {}),
        ...(entry.checked ? { checked: entry.checked } : {}),
        // (One only its turns tell of is never read.)
        ...(account.limits.read ? { next: entry.next } : {}),
        ...(problem ? { problem } : {}),
      })
    }
    return listed
  }

  /** The services whose limits this box reads (`claude`, `codex`…), so a client knows what it covers. */
  services(): LimitsService[] {
    return [...new Set([...this.accounts().map((account) => account.service), ...this.alsoServices])]
  }

  /** Services read here though none may be signed in now (the engine's). */
  alsoServices: LimitsService[] = []

  /**
   * Reads now each account read longer ago than a minute, unless its maker said to wait or it was
   * read as recently as its maker allows: a client pulled to refresh, or an agent asked.
   */
  async refresh() {
    const at = this.now()
    for (const account of this.accounts()) {
      const source = account.limits
      const entry = this.entries.get(account.provider)
      if (!source.read || !entry || this.heldBack(source, entry, at)) continue
      if (entry.checked && at - entry.checked < Math.max(FRESH_ENOUGH, source.every)) continue
      entry.next = Math.min(entry.next, at)
    }
    await this.tick()
  }

  /** Reads what's due, one account at a time (a busy computer isn't given more). */
  tick(): Promise<void> {
    this.reading ??= this.readDue().finally(() => (this.reading = undefined))
    return this.reading
  }

  private heldBack(source: LimitsSource, entry: Entry, at: number) {
    const hold = source.bucket ? (this.holds.get(source.bucket) ?? 0) : 0
    return at < hold || (entry.problem?.kind === "rate-limited" && at < (entry.problem.until ?? entry.next))
  }

  private async readDue() {
    await this.prepare?.()
    for (const account of this.accounts()) {
      const source = account.limits
      this.listen(account.provider, source)
      let entry = this.entries.get(account.provider)
      if (!entry) {
        entry = { windows: [], next: 0 }
        this.entries.set(account.provider, entry)
      }
      this.switched(entry, source)
      this.identify(entry, source.identity?.())
      if (!source.read) continue
      const at = this.now()
      if (at < entry.next) continue
      // Another account of its maker was turned away meanwhile: this one waits as long.
      const hold = source.bucket ? (this.holds.get(source.bucket) ?? 0) : 0
      if (at < hold) {
        entry.next = hold
        continue
      }
      // One read of a maker's bucket a minute, whatever asked (the timer, a refresh): a hold that
      // just ended isn't met with every account at once.
      const last = source.bucket ? (this.asked.get(source.bucket) ?? 0) : 0
      if (source.bucket && at - last < MINUTE) {
        entry.next = last + MINUTE
        continue
      }
      // A sign-in that lapsed or can't read its limits, as it was: nothing to ask its maker yet.
      if ((entry.problem?.kind === "expired" || entry.problem?.kind === "unreadable") && entry.signIn !== undefined && entry.signIn === source.signIn?.()) {
        entry.next = at + Math.max(source.every, FIRST_RETRY)
        continue
      }
      // Counted as asked before it's sent, and kept so (a restart meanwhile doesn't ask another
      // account of its maker at once); taken back when nothing went.
      const before = source.bucket ? this.asked.get(source.bucket) : undefined
      if (source.bucket) this.asked.set(source.bucket, at)
      const sent = await this.readOne(source, entry)
      if (source.bucket && !sent) {
        if (before === undefined) this.asked.delete(source.bucket)
        else this.asked.set(source.bucket, before)
      }
      // Kept at once: a restart meanwhile never asks again what was just asked.
      this.changed()
    }
    this.forgetGone()
    this.changed()
  }

  /** Reads one account; whether a request went to its maker. */
  private async readOne(source: LimitsSource, entry: Entry): Promise<boolean> {
    const started = this.now()
    // Not asked again before its time, even if the box stops while it waits for the answer.
    entry.next = Math.max(entry.next, started + source.every)
    this.save()
    try {
      const reading = await source.read!(started)
      const at = this.now()
      // (Another account's since: what was kept goes, before this one's is kept.)
      if (reading) this.identify(entry, reading.identity)
      entry.next = at + source.every
      // Nothing to read now: as it was.
      if (!reading) return false
      entry.checked = at
      entry.plan = reading.plan ?? entry.plan
      entry.balance = reading.balance
      // What it says now, in place of all it said before; a window a turn told of since it was
      // asked, or that only turns tell, stays as heard.
      const heard = entry.windows.filter((window) => window.source === "turn" && (window.read >= started || !reading.windows.some((each) => each.id === window.id)))
      entry.windows = [...reading.windows.filter((window) => !heard.some((each) => each.id === window.id)).map((window) => ({ ...window, used: clamp(window.used), read: at, source: "usage" as const })), ...heard]
      entry.problem = undefined
      entry.signIn = undefined
      entry.refusals = 0
      entry.failures = 0
      if (source.bucket) this.refusals.delete(source.bucket)
      return true
    } catch (caught) {
      const at = this.now()
      entry.checked = at
      const problem = caught instanceof LimitsProblem ? caught : new LimitsProblem("failed", `Couldn't read its limits: ${caught instanceof Error ? caught.message : String(caught)}`)
      entry.problem = { kind: problem.kind, message: problem.message, ...(problem.until ? { until: problem.until } : {}) }
      switch (problem.kind) {
        case "rate-limited": {
          // Counted per maker's bucket where there is one (its hold is the computer's): turned away
          // on one account, then another, is twice.
          const refusals = (source.bucket ? (this.refusals.get(source.bucket) ?? 0) : (entry.refusals ?? 0)) + 1
          entry.refusals = refusals
          if (source.bucket) this.refusals.set(source.bucket, refusals)
          // As long as its maker says, never less than the account's own spacing; with no word, an
          // hour, doubling each time it's turned away again.
          const wait = problem.until ? Math.max(problem.until, at + source.every) : at + Math.min(FIRST_HOLD * 2 ** (refusals - 1), LONGEST_HOLD)
          entry.next = wait
          entry.problem.until = wait
          if (source.bucket) this.holds.set(source.bucket, Math.max(this.holds.get(source.bucket) ?? 0, wait))
          break
        }
        case "none":
          // Signed out, or no plan: nothing kept of it, and looked at again later.
          entry.windows = []
          entry.plan = undefined
          entry.balance = undefined
          entry.next = at + NOTHING_AGAIN
          break
        case "expired":
        case "unreadable":
          // Its maker isn't asked again until the sign-in changes (looked at each round, here only).
          entry.signIn = source.signIn?.()
          entry.next = at + Math.max(source.every, FIRST_RETRY)
          break
        default:
          entry.failures = (entry.failures ?? 0) + 1
          entry.next = at + Math.max(source.every, Math.min(FIRST_RETRY * 2 ** (entry.failures - 1), LONGEST_RETRY))
      }
      return problem.sent
    }
  }

  /**
   * Who the account is now, as its sign-in says (none: as last known). Signed in to another account
   * since, what was kept of the one before isn't this one's: it goes, and this one is read soon.
   */
  private identify(entry: Entry, raw: string | undefined) {
    if (!raw) return
    const identity = identityOf(raw)
    if (entry.identity === identity) return
    if (entry.identity) {
      entry.windows = []
      entry.plan = undefined
      entry.balance = undefined
      entry.checked = undefined
      // Listed meanwhile, saying why it has no numbers (a maker's hold can keep it unread for hours).
      entry.problem = { kind: "failed", message: "Signed in to another account here: its limits show once they're read." }
      entry.signIn = undefined
      entry.refusals = 0
      entry.failures = 0
      entry.next = 0
    }
    entry.identity = identity
  }

  /**
   * An account only its turns tell of, signed in to another since what's kept was heard (a Mac's
   * Claude, given a new token): nothing kept is this one's, nor who it was, which its sign-in says
   * again in time (`identity`). Its windows start over with what its turns hear next.
   */
  private switched(entry: Entry, source: LimitsSource) {
    if (source.read || !source.signIn) return
    const now = source.signIn()
    if (now === undefined) return
    if (entry.heardAs !== undefined && entry.heardAs !== now) {
      entry.windows = []
      entry.plan = undefined
      entry.balance = undefined
      entry.checked = undefined
      entry.problem = undefined
      entry.identity = undefined
    }
    entry.heardAs = now
  }

  /** What a turn of this account hears (its rate-limit events), kept as the window's latest. */
  private listen(provider: string, source: LimitsSource) {
    if (source.heard) return
    source.heard = (window) => {
      let entry = this.entries.get(provider)
      if (!entry) {
        entry = { windows: [], next: 0 }
        this.entries.set(provider, entry)
      }
      this.switched(entry, source)
      // (One that's never read has nothing a turn doesn't make current: whatever it said goes.)
      if (entry.problem?.kind === "none" || !source.read) entry.problem = undefined
      const before = entry.windows.find((each) => each.id === window.id)
      const heard: LimitWindow = {
        ...before,
        ...window,
        // What a turn doesn't say (how long it is, the model) is as last read.
        minutes: window.minutes ?? before?.minutes,
        model: window.model ?? before?.model,
        used: clamp(window.used),
        read: this.now(),
        source: "turn",
      }
      if (heard.minutes === undefined) delete heard.minutes
      if (heard.model === undefined) delete heard.model
      if (heard.name === undefined) delete heard.name
      if (heard.resetsAt === undefined) delete heard.resetsAt
      entry.windows = before ? entry.windows.map((each) => (each.id === window.id ? heard : each)) : [...entry.windows, heard]
      this.changed(true)
    }
  }

  /** Accounts removed since: their records go. */
  private forgetGone() {
    if (!this.settled()) return
    const here = new Set(this.accounts().map((account) => account.provider))
    for (const provider of this.entries.keys()) if (!here.has(provider)) this.entries.delete(provider)
  }

  /** Tells the clients, and keeps it, when what's listed changed. */
  private lastHeardSave = 0

  /** `heard`: from a turn's event, which comes with each response: kept on disk at most every half minute. */
  private changed(heard = false) {
    const list = this.list()
    const now = JSON.stringify(list)
    if (!heard || this.now() - this.lastHeardSave >= 30_000) {
      if (heard) this.lastHeardSave = this.now()
      this.save()
    }
    if (now === this.said) return
    this.said = now
    emit("kuvo.limits.updated", { accounts: list })
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved
      for (const [provider, entry] of Object.entries(saved.accounts ?? {})) {
        if (!entry || !Array.isArray(entry.windows) || typeof entry.next !== "number") continue
        this.entries.set(provider, entry)
      }
      for (const [bucket, until] of Object.entries(saved.holds ?? {})) if (typeof until === "number") this.holds.set(bucket, until)
      for (const [bucket, at] of Object.entries(saved.asked ?? {})) if (typeof at === "number") this.asked.set(bucket, at)
      for (const [bucket, count] of Object.entries(saved.refusals ?? {})) if (typeof count === "number") this.refusals.set(bucket, count)
    } catch {}
  }

  private kept = ""

  private save() {
    if (!this.file) return
    const saved = JSON.stringify({ accounts: Object.fromEntries(this.entries), holds: Object.fromEntries(this.holds), asked: Object.fromEntries(this.asked), refusals: Object.fromEntries(this.refusals) } satisfies Saved)
    if (saved === this.kept) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + ".new", saved)
      this.kept = saved
      renameSync(this.file + ".new", this.file)
    } catch {}
  }
}

function clamp(used: number) {
  return Number.isFinite(used) ? Math.min(Math.max(used, 0), 1) : 0
}

/** The seconds or date a `Retry-After` header gives, as when it may be asked again (ms since 1970). */
export function retryAt(header: string | null | undefined, now = Date.now()): number | undefined {
  const raw = header?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return now + Number(raw) * 1000
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(date, now) : undefined
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/**
 * `GET api/kuvo/limits` → `{data: {accounts, services}}`; `POST api/kuvo/limits/refresh` reads what
 * may be read now, and answers the same once it's read (PROTOCOL.md, "Plan limits").
 */
export async function limitsRoutes(limits: Limits | undefined, method: string, rest: string[]): Promise<Response> {
  if (!limits) return json({ message: "Plan limits aren't read on this computer." }, 503)
  const answer = () => json({ data: { accounts: limits.list(), services: limits.services() } })
  if (!rest.length && method === "GET") return answer()
  if (rest.length === 1 && rest[0] === "refresh" && method === "POST") {
    // What's read within a couple of seconds is in the answer; the rest comes as kuvo.limits.updated.
    await Promise.race([limits.refresh(), new Promise((resolve) => setTimeout(resolve, 2_000).unref?.())])
    return answer()
  }
  return json({ message: "Not available for this agent." }, 404)
}

const AGENT_SERVICES: Record<AgentKind, LimitsService> = { claude: "claude", codex: "codex", grok: "grok", cursor: "cursor", antigravity: "antigravity" }

/** The coding agents' accounts whose limits are read (an agent with `limits`). */
export function agentAccounts(agents: Agent[]): LimitedAccount[] {
  return agents.flatMap((agent) => {
    const parsed = parseProvider(agent.providerID)
    if (!agent.limits || !parsed) return []
    return [{ provider: agent.providerID, service: AGENT_SERVICES[parsed.kind], agent: { kind: parsed.kind, account: parsed.id }, ...(agent.instance.label ? { label: agent.instance.label } : {}), limits: agent.limits }]
  })
}

/** A sign-in's fingerprint, to tell when it changed: never the secret itself. */
export function fingerprint(secret: string | undefined): string | undefined {
  return secret ? createHash("sha256").update(secret).digest("hex").slice(0, 16) : undefined
}

/**
 * An account's identity as the clients get it (`AccountLimits.identity`): the same on every box, so
 * a client lists the account once, and nothing of what it's made of. Its makers' IDs are random
 * (UUIDs, keys) or public (a GitHub login); a hash of its own kind, not the bare SHA-256 of an ID,
 * so it matches nothing outside Kuvo Code.
 */
export function identityOf(raw: string): string {
  return createHash("sha256").update("kuvo-code plan limits account v1\n").update(raw).digest("hex").slice(0, 16)
}

/** What a JSON Web Token says of itself (its middle part), never checked: only to tell who it's for. */
export function tokenClaims(token: string | undefined): Record<string, any> | undefined {
  const part = token?.trim().split(".")[1]
  if (!part) return undefined
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return claims && typeof claims === "object" ? claims : undefined
  } catch {
    return undefined
  }
}

/** A ChatGPT sign-in's account, as its token says (Codex's, and the engine's `openai`, alike). */
export function chatGPTIdentity(access: string | undefined, accountID?: unknown): string | undefined {
  const auth = tokenClaims(access)?.["https://api.openai.com/auth"]
  const account = text(auth?.chatgpt_account_id) ?? text(accountID)
  if (!account) return undefined
  // (A workspace's members share its account: each one's own limits.)
  const user = text(auth?.chatgpt_user_id) ?? text(auth?.user_id)
  return `chatgpt:${account}${user ? `/${user}` : ""}`
}

/** An xAI sign-in's user, as its token says (the Grok agent's, and the engine's `xai`, alike). */
export function xaiIdentity(...tokens: (string | undefined)[]): string | undefined {
  for (const token of tokens) {
    const user = text(tokenClaims(token)?.sub)
    if (user) return `xai:${user}`
  }
  return undefined
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined)
