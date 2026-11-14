// Your plans' limits, shared between your computers (PROTOCOL.md, "Plan limits", "Across your
// computers"). Each box tells its peers what it read of its accounts (the readings only: who each
// account is, as a hash, its windows and when they were read; never a sign-in), as that changes
// and every ten minutes, and keeps the last each peer told, through a restart. With that, a box
// doesn't ask a maker for an account a peer read within its time between reads (`fresh`): each
// account is read once, not by every computer signed in to it; and every box lists every account
// across your computers (`limits-rows.ts`). A peer that stops telling keeps what it last said, as of
// when it was read, and is marked away. The mail goes through the box's link, as group chats' does
// (`groups/post.ts`).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kinds, type AgentKind } from "./accounts"
import type { AccountLimits, LimitedAccount, LimitExtra, LimitWindow, Limits, LimitsService } from "./limits"
import { takeNotices, takeStates, type UsageNotice, type NoticeState } from "./usage/notices"
import { limitRows, type LimitRow, type LimitsBox } from "./limits-rows"

/** What one box tells another of its limits (`{"limits": …}` between links). */
export interface LimitsMail {
  kind: "limits"
  /** When it was told, by the sender's clock (ms): what's said is moved onto the receiver's by how far it is off. */
  at: number
  /** Its own accounts, as its `api/kuvo/limits` lists them. */
  accounts: AccountLimits[]
  /** It just started: tell it yours. */
  ask?: true
  /** Read these of yours now, if they may be (rows' ids: a refresh asked where they aren't). */
  refresh?: string[]
}

/** What carries mail to a peer (the bridge's mail to its link, `PeerPost`). */
export interface LimitsTransport {
  send(to: string, mail: LimitsMail, durable: boolean): void
  /** Whether the link takes what's sent now. */
  readonly followed: boolean
  /** Told each time the link starts taking what's sent (again). */
  onFollowed?(listener: () => void): void
}

/** Who your other computers are, as the link says (`LinkDirectory`). */
export interface LimitsDirectory {
  /** Whether the link has said since this started. */
  readonly told: boolean
  peerBoxes(): { key: string; name: string }[]
  /** This box, as the link names it. */
  own(): { key: string; name: string } | undefined
  /** Told each time the link says who they are. */
  listen(listener: () => void): void
  /** Whether a box is one of your computers (a peer), not one a peer vouches for. */
  isPeer?(key: string): boolean
}

interface Kept {
  name: string
  /** When its last mail came, by this box's clock. */
  heard: number
  accounts: AccountLimits[]
}

const MINUTE = 60_000
/** Told again this often though nothing changed (the relay keeps nothing). */
export const TELL_AGAIN = 10 * MINUTE
/** A peer not heard from this long is away: what it said stays, as of when it was read. */
export const PEER_AWAY = 25 * MINUTE
/** What a turn hears changes the numbers often: told at most this often, a read at once. */
const HEARD_EVERY = MINUTE
/** A clock this far off or more is moved onto this box's (a mail's way takes less). */
const SKEW = MINUTE
/** A mail at most this big, its JSON in UTF-8, so it fits in one sealed mail (65,600 bytes) with room to spare. */
const MOST_BYTES = 40_000

/** A service as a newer box may name one this box doesn't know yet: kept as its name. */
const SERVICE = /^[a-z0-9][a-z0-9-]{0,39}$/
const PROBLEMS = new Set(["rate-limited", "expired", "unreadable", "failed"])

export class LimitsPeers {
  private peers = new Map<string, Kept>()
  /** What was last told each peer, and when. */
  private told = new Map<string, { json: string; at: number }>()
  /** When each peer's ask (or its coming back) was last answered. */
  private answered = new Map<string, number>()

  constructor(
    private readonly limits: Limits,
    private readonly transport: LimitsTransport,
    private readonly directory: LimitsDirectory,
    /** Where what peers told is kept between runs (`limits-peers.json`); none in a test that doesn't. */
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load()
    limits.peers = this
    directory.listen(() => this.directorySaid())
    // The link carries what goes again (it started, or followed anew): what went meanwhile was
    // lost, so each peer is told again, and asked for its own, once the link says who they are.
    transport.onFollowed?.(() => this.told.clear())
  }

  /** This box's key, as the link names it ("" until it says). */
  ownKey(): string {
    return this.directory.own()?.key ?? ""
  }

  /** The newest time a peer read this account from its maker (on this box's clock), if any did. */
  fresh(service: LimitsService, identity: string): number | undefined {
    return this.freshest(service, identity)?.checked
  }

  /** The newest reading a peer had of this account from its maker, without a problem, if any did. */
  freshest(service: LimitsService, identity: string): AccountLimits | undefined {
    let newest: AccountLimits | undefined
    for (const kept of this.peers.values()) {
      for (const account of kept.accounts) {
        if (account.service !== service || account.identity !== identity || account.problem || !account.checked) continue
        if (!newest || account.checked > newest.checked!) newest = account
      }
    }
    return newest
  }

  /** One current account holder forwards decided notices to phones, even if a peer read it. */
  forwarder(service: string, identity: string): string | undefined {
    const own = this.directory.own()?.key
    if (!own || !this.directory.told || !this.directory.isPeer) return own
    const candidates = [own]
    for (const [key, kept] of this.peers) {
      if (!this.directory.isPeer(key) || this.now() - kept.heard > PEER_AWAY) continue
      if (kept.accounts.some(a => a.service === service && a.identity === identity)) candidates.push(key)
    }
    return candidates.sort()[0]
  }

  ownsPush(key: string): boolean { return this.directory.own()?.key === key }

  /** Per-window decisions, including turn-only accounts whose maker was never checked here. */
  noticeStates(service: LimitsService, identity: string): Record<string, NoticeState>[] {
    if (!this.directory.told || !this.directory.isPeer) return []
    return [...this.peers].flatMap(([key, kept]) => this.directory.isPeer!(key) ? kept.accounts.filter(a => a.service === service && a.identity === identity).map(a => a.noticeState ?? {}) : [])
  }

  /** Only direct peers' decided notices: vouched-for computers never send or receive these. */
  notices(): UsageNotice[] {
    if (!this.directory.told || !this.directory.isPeer) return []
    return [...this.peers].flatMap(([key, kept]) => this.directory.isPeer!(key) ? kept.accounts.flatMap(a => a.notices ?? []) : [])
  }

  /** Every computer's accounts, this box's first, then each peer's by name. */
  rows(own: AccountLimits[]): LimitRow[] {
    const now = this.now()
    const self = this.directory.own()
    const boxes: LimitsBox[] = [{ key: self?.key ?? "", name: self?.name ?? "", here: true, away: false, accounts: own }]
    const peers = [...this.peers.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name))
    for (const [key, kept] of peers) boxes.push({ key, name: this.directory.peerBoxes().find((box) => box.key === key)?.name ?? kept.name, here: false, away: now - kept.heard > PEER_AWAY, ...(this.directory.isPeer?.(key) === false ? { vouched: true } : {}), accounts: kept.accounts })
    return limitRows(boxes)
  }

  /**
   * This box's accounts told to its peers: at once after a read, at most once a minute for what
   * turns hear, and again each ten minutes; to a peer not told since this started (or since the
   * link carries what goes again) at once, asking for its own (it may have told while this was
   * away).
   */
  tell(urgent = false) {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    const mine = this.shared()
    const theirs = forVouched(mine)
    for (const { key } of this.directory.peerBoxes()) {
      const accounts = this.ours(key) ? mine : theirs
      const json = JSON.stringify(accounts)
      const last = this.told.get(key)
      const due = !last || now - last.at >= TELL_AGAIN || (last.json !== json && (urgent || now - last.at >= HEARD_EVERY))
      if (!due) continue
      this.transport.send(key, { kind: "limits", at: now, accounts: this.forPeer(key, accounts), ...(!last ? { ask: true as const } : {}) }, false)
      this.told.set(key, { json, at: now })
    }
  }

  /** What a peer told (`from`, its key: the link opens only your computers' mail). */
  take(from: string, mail: unknown) {
    if (!mail || typeof mail !== "object") return
    const given = mail as Partial<LimitsMail>
    if (!Array.isArray(given.accounts)) return
    if (this.directory.told && !this.directory.peerBoxes().some((box) => box.key === from)) return
    const now = this.now()
    // Its clock, onto this box's: a mail takes a moment, so only one that's well off is moved.
    const off = typeof given.at === "number" && Number.isFinite(given.at) && Math.abs(now - given.at) >= SKEW ? now - given.at : 0
    const accounts = given.accounts.slice(0, 100).flatMap((account) => {
      const taken = takenAccount(account, off, now)
      if (taken && !this.directory.isPeer?.(from)) { delete taken.notices; delete taken.noticeState }
      return taken ? [taken] : []
    })
    const before = this.peers.get(from)
    const name = this.directory.peerBoxes().find((box) => box.key === from)?.name ?? before?.name ?? "another computer"
    const seen = new Set(before?.accounts.flatMap(a => a.notices?.map(n => n.id) ?? []) ?? [])
    const notices = accounts.flatMap(a => a.notices ?? []).filter(n => !seen.has(n.id))
    this.peers.set(from, { name, heard: now, accounts })
    if (notices.length) this.limits.deliverNotices(notices)
    this.save()
    this.limits.peersChanged()
    // Asked, or back after being away (it may have missed what was told meanwhile): told this box's,
    // whatever was told it lately (that may be what it missed), once a minute at most.
    if (given.ask === true || (before && now - before.heard > PEER_AWAY)) this.answer(from)
    if (Array.isArray(given.refresh)) {
      const ids = new Set(given.refresh.filter((id): id is string => typeof id === "string").slice(0, 200))
      if (ids.size) void this.limits.refresh((account, identity) => ids.has(this.idOf(account, identity)))
    }
  }

  /**
   * A refresh asked here: each account this box doesn't read itself (one only on your other
   * computers, or one only its turns tell of here: a Mac's Claude) is asked of a computer it's on
   * (the first that isn't away), which reads it if its maker allows. `reads`: the providers this
   * box reads itself.
   */
  refreshElsewhere(rows: LimitRow[], reads: Set<string>) {
    if (!this.transport.followed) return
    const asks = new Map<string, string[]>()
    for (const row of rows) {
      if (row.boxes.some((box) => box.here && reads.has(box.provider))) continue
      const box = row.boxes.find((each) => !each.here && !each.away) ?? row.boxes.find((each) => !each.here)
      if (!box?.key) continue
      if ((asks.get(box.key)?.length ?? 0) >= 200) continue
      asks.set(box.key, [...(asks.get(box.key) ?? []), row.id])
    }
    const now = this.now()
    const mine = this.shared()
    for (const [key, refresh] of asks) this.transport.send(key, { kind: "limits", at: now, accounts: this.forPeer(key, this.ours(key) ? mine : forVouched(mine)), refresh }, false)
  }

  /** An account of this box's, as rows name it. */
  private idOf(account: LimitedAccount, identity: string | undefined) {
    return identity ? `${account.service}#${identity}` : `${this.directory.own()?.key ?? ""}/${account.provider}`
  }

  /** This box's accounts told to one peer that asked, unless it was answered within the minute. An answer doesn't ask back. */
  private answer(key: string) {
    if (!this.transport.followed) return
    const now = this.now()
    if (now - (this.answered.get(key) ?? -Infinity) < HEARD_EVERY) return
    this.answered.set(key, now)
    const accounts = this.forPeer(key, this.ours(key) ? this.shared() : forVouched(this.shared()))
    this.transport.send(key, { kind: "limits", at: now, accounts }, false)
    this.told.set(key, { json: JSON.stringify(accounts), at: now })
  }

  private forPeer(key: string, accounts: AccountLimits[]): AccountLimits[] {
    return this.directory.isPeer?.(key) ? accounts : accounts.map(({ notices, noticeState, ...account }) => account)
  }

  /** Whether a box is one of your own computers (not one a peer of yours only vouches for). */
  private ours(key: string) {
    return this.directory.isPeer?.(key) === true
  }

  /** This box's own accounts, as many as fit in one mail (with up to 200 rows' ids asked of it besides). */
  private shared(): AccountLimits[] {
    const accounts = structuredClone(this.limits.list(false))
    // History must never push an otherwise small account's current limits out of the mail.
    while (Buffer.byteLength(JSON.stringify(accounts)) > MOST_BYTES - 200 * 60) {
      const largest = accounts.filter(a => a.notices?.length).sort((a, b) => b.notices!.length - a.notices!.length)[0]
      if (!largest) break
      largest.notices!.shift()
    }
    while (accounts.length && Buffer.byteLength(JSON.stringify(accounts)) > MOST_BYTES - 200 * 60) accounts.pop()
    return accounts
  }

  /** The link said who your computers are: those no longer among them go, and one new to this box is told now. */
  private directorySaid() {
    const here = new Set(this.directory.peerBoxes().map((box) => box.key))
    let gone = false
    for (const key of [...this.peers.keys()]) {
      if (here.has(key)) continue
      this.peers.delete(key)
      gone = true
    }
    for (const key of [...this.told.keys()]) if (!here.has(key)) this.told.delete(key)
    for (const key of [...this.answered.keys()]) if (!here.has(key)) this.answered.delete(key)
    if (gone) {
      this.save()
      this.limits.peersChanged()
    }
    this.tell()
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { peers?: Record<string, Kept> }
      for (const [key, kept] of Object.entries(saved.peers ?? {})) {
        if (!kept || typeof kept.heard !== "number" || !Array.isArray(kept.accounts)) continue
        this.peers.set(key, { name: typeof kept.name === "string" ? kept.name : "another computer", heard: kept.heard, accounts: kept.accounts.flatMap((account) => takenAccount(account, 0, Infinity) ?? []) })
      }
    } catch {}
  }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + ".new", JSON.stringify({ peers: Object.fromEntries(this.peers) }), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch {}
  }
}

/**
 * What a box a peer only vouches for is told of your accounts: their limits, but not what you spend
 * or have to spend beyond them (`spent`, `capped`, `left`, credits left), nor whether agents may
 * use their resets.
 */
function forVouched(accounts: AccountLimits[]): AccountLimits[] {
  return accounts.map((account) => {
    const { agentsReset: _, balance: ___, ...told } = account
    const extras = (account.extras ?? []).filter((extra) => extra.kind === "resets" || extra.kind === "unreadable").map(({ agents: __, ...extra }) => extra)
    delete told.extras
    return extras.length ? { ...told, extras } : told
  })
}

const text = (value: unknown, most = 200) => (typeof value === "string" && value ? value.slice(0, most) : undefined)
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

/** The most of an extra of a kind this box doesn't know (a newer box's), as JSON. */
const MOST_EXTRA = 1_000

/**
 * What a peer's account has beyond its windows, as kept: one of a kind this box knows checked
 * (`LimitExtra`); one of a kind this box doesn't know yet (a newer box's) passed on as told, but only its plain fields
 * (text, numbers, true or false) and only while it's small, so a newer box's facts survive a hop
 * through this one.
 */
function takenExtra(extra: any): LimitExtra[] {
  if (!extra || typeof extra !== "object" || Array.isArray(extra) || !text(extra.id) || !text(extra.name, 100) || !text(extra.kind, 40)) return []
  const named = { id: text(extra.id)!, name: text(extra.name, 100)! }
  const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  const unit = ["usd", "credits", "requests"].includes(extra.unit)
  const resets = time(extra.resetsAt) ? { resetsAt: extra.resetsAt } : {}
  switch (extra.kind) {
    case "spent":
    case "left":
      return amount(extra.amount) && unit ? [{ ...named, kind: extra.kind, amount: extra.amount, unit: extra.unit, ...resets }] : []
    case "capped":
      return amount(extra.amount) && amount(extra.limit) && extra.limit > 0 && unit ? [{ ...named, kind: "capped", amount: extra.amount, limit: extra.limit, unit: extra.unit, ...resets }] : []
    case "resets": {
      if (!amount(extra.count) || extra.count < 0) return []
      const expiries = (Array.isArray(extra.expiries) ? extra.expiries : []).filter((at: unknown) => time(at) !== undefined).slice(0, 50)
      const refills = (Array.isArray(extra.refills) ? extra.refills : []).map((each: unknown) => text(each, 40)).filter(Boolean).slice(0, 10)
      // (Where it's used is worked out by each box from its own rows: never taken as told.)
      return [{ ...named, kind: "resets", count: Math.floor(extra.count), ...(expiries.length ? { expiries } : {}), ...(refills.length ? { refills } : {}), usable: extra.usable === true, ...(extra.agents === true ? { agents: true as const } : {}) }]
    }
    case "unreadable":
      return text(extra.message, 500) ? [{ ...named, kind: "unreadable", message: text(extra.message, 500)! }] : []
  }
  const plain = Object.fromEntries(
    Object.entries(extra)
      .slice(0, 20)
      .filter(([, value]) => (typeof value === "string" && value.length <= 200) || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean"),
  )
  const taken = { ...plain, id: text(extra.id)!, name: text(extra.name, 100)!, kind: text(extra.kind, 40)! }
  // (Its names counted too: what's passed on is at most this, as it's told again.)
  return Buffer.byteLength(JSON.stringify(taken)) > MOST_EXTRA ? [] : [taken]
}

/**
 * A peer's account as it's kept: only what an account says, checked, its times moved by `off` onto
 * this box's clock (never past `now`); null for what isn't one.
 */
function takenAccount(given: unknown, off: number, now: number): AccountLimits | null {
  if (!given || typeof given !== "object") return null
  const account = given as Record<string, any>
  const provider = text(account.provider)
  if (!provider || typeof account.service !== "string" || !SERVICE.test(account.service)) return null
  const moved = (value: unknown) => {
    const at = time(value)
    return at === undefined ? undefined : Math.min(at + off, now)
  }
  const windows = (Array.isArray(account.windows) ? account.windows : []).slice(0, 30).flatMap((window: any): LimitWindow[] => {
    const read = moved(window?.read)
    if (!window || typeof window !== "object" || !text(window.id) || typeof window.used !== "number" || !Number.isFinite(window.used) || read === undefined) return []
    const amount = window.amount
    return [
      {
        id: text(window.id)!,
        used: Math.min(Math.max(window.used, 0), 1),
        ...(time(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
        ...(time(window.minutes) ? { minutes: window.minutes } : {}),
        ...(text(window.model) ? { model: text(window.model) } : {}),
        ...(text(window.name) ? { name: text(window.name) } : {}),
        ...(amount && typeof amount === "object" && typeof amount.used === "number" && typeof amount.limit === "number" && ["requests", "usd", "credits"].includes(amount.unit) ? { amount: { used: amount.used, limit: amount.limit, unit: amount.unit } } : {}),
        read,
        source: window.source === "turn" ? "turn" : "usage",
      },
    ]
  })
  const balance = account.balance
  const extras = (Array.isArray(account.extras) ? account.extras : []).slice(0, 10).flatMap((extra: any): LimitExtra[] => takenExtra(extra))
  const problem = account.problem
  const checked = moved(account.checked)
  const next = time(account.next) === undefined ? undefined : account.next + off
  return {
    provider,
    service: account.service as LimitsService,
    ...(kinds.includes(account.agent) ? { agent: account.agent as AgentKind, ...(text(account.account) ? { account: text(account.account) } : {}) } : {}),
    ...(text(account.label, 100) ? { label: text(account.label, 100) } : {}),
    ...(typeof account.identity === "string" && /^[0-9a-f]{16}$/.test(account.identity) ? { identity: account.identity } : {}),
    ...(text(account.plan, 100) ? { plan: text(account.plan, 100) } : {}),
    windows,
    notices: takeNotices(account.notices),
    noticeState: Object.fromEntries(Object.entries(takeStates(account.noticeState)).map(([id, state]) => [id, { ...state, ...(state.read !== undefined ? { read: moved(state.read) } : {}) }])),
    ...(balance && typeof balance === "object" && typeof balance.left === "number" && (balance.unit === "usd" || balance.unit === "credits") ? { balance: { left: balance.left, ...(typeof balance.limit === "number" ? { limit: balance.limit } : {}), unit: balance.unit } } : {}),
    ...(extras.length ? { extras } : {}),
    ...(account.agentsReset === true ? { agentsReset: true as const } : {}),
    ...(checked ? { checked } : {}),
    ...(next ? { next } : {}),
    ...(problem && typeof problem === "object" && PROBLEMS.has(problem.kind) && text(problem.message, 500) ? { problem: { kind: problem.kind, message: text(problem.message, 500)!, ...(time(problem.until) ? { until: problem.until + off } : {}) } } : {}),
  }
}
