// What your accounts used, shared between your computers (PROTOCOL.md, "Usage history"): each box
// tells the boxes it shares plan limits with (its peers and those they vouch for, `LimitsDirectory`)
// its own accounts' slots (who each account is, as a hash, its name, and each quarter hour's tokens
// and dollars by model; never a sign-in, a log or a message), and keeps the last each one told,
// through a restart. Every box then lists every account across them, each account's slots added up
// from every box it's used on (`usageRows`). In full when a box asks (it started, or what it has
// isn't what was told); when they changed, only the last two days (`from`), the receiver keeping
// the rest; and every ten minutes, only that what was told is as it was. Each mail says what the
// whole is (`digest`): a box whose own isn't that asks for it in full. One that stops telling keeps
// what it last said, and is marked away. The mail goes through the box's link, in parts when it's
// big, as a group chat's does.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kinds, type AgentKind } from "../accounts"
import type { LimitsDirectory, LimitsTransport } from "../limits-peers"
import type { LimitsService } from "../limits"
import { KEPT_DAYS, keptSlots, noSlots, slotsFrom, SLOT, trimmed, type KeptSlots } from "./history"
import { usageRows, type OwnUsage, type Usage, type UsageBox, type UsageRow } from "./usage"

/** One account as a box tells it. */
export interface ToldUsage extends Omit<OwnUsage, "slots"> {
  slots: KeptSlots
}

/** What one box tells another of its usage (`{"seat": {"kind": "usage", …}}` between links). */
export interface UsageMail {
  kind: "usage"
  /** When it was told, by the sender's clock (ms). */
  at: number
  /** What its accounts used: none in a mail that only says what it told is as it was (`digest`). */
  accounts?: ToldUsage[]
  /** The accounts' slots are those from this one on (quarter hours since 1970), the older as told before. */
  from?: number
  /** What its accounts used, all of it, hashed (`digestOf`): the receiver's, put together, is the same. */
  digest: string
  /** Tell me yours (it just started, or missed what you told). */
  ask?: true
  /** Read yours now and tell it (a client pulled to refresh there). */
  refresh?: true
  /**
   * When the sender last read each of its accounts its maker states whole (`accountWide`:
   * Cursor's), by provider, by its clock: in every mail, so one of your computers reads each at a
   * time (`readsWhole`) though what it read didn't change.
   */
  fresh?: Record<string, number>
}

export const isUsageMail = (value: any): value is UsageMail => value !== null && typeof value === "object" && value.kind === "usage"

interface Kept {
  name: string
  /** When its last mail came, by this box's clock. */
  heard: number
  /** What it told, hashed (`UsageMail.digest`). */
  digest?: string
  /** A box a peer vouches for, not one of yours, as the link last said (kept, for a start before it says again). */
  vouched?: boolean
  accounts: OwnUsage[]
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Said again this often though nothing changed (the relay keeps nothing). */
const TELL_AGAIN = 10 * MINUTE
/** A peer not heard from this long is away: what it said stays. */
const PEER_AWAY = 25 * MINUTE
/** A clock this far off or more is moved onto this box's. */
const SKEW = MINUTE
/** At most this many accounts from a box, and uses of each. */
const MOST_ACCOUNTS = 50
const MOST_USES = 50_000
/** A mail at most this big, its JSON in UTF-8 (the link sends it in parts; it takes 512 KB at most). */
const MOST_BYTES = 400_000
/** What changed is told from this far back: a round is minutes apart, so the last two days hold it. */
const RECENT = 2 * 24 * 60 * MINUTE

const SERVICE = /^[a-z0-9][a-z0-9-]{0,39}$/
/** An account its maker states whole that a peer read this lately is read there, not here. */
const WHOLE_FRESH = 25 * MINUTE
const text = (value: unknown, most = 200) => (typeof value === "string" && value ? value.slice(0, most) : undefined)

export class UsagePeers {
  private peers = new Map<string, Kept>()
  /** What was last told each peer (its digest), and when. */
  private told = new Map<string, { digest: string; at: number }>()
  /** When each peer was last answered, asked, or read for. */
  private answered = new Map<string, number>()
  private askedBack = new Map<string, number>()
  private readFor = new Map<string, number>()
  private refreshedElsewhere = -Infinity
  /** Reads for peers under way (tests wait for them). */
  private reading = new Set<Promise<void>>()

  constructor(
    private readonly usage: Usage,
    private readonly transport: Pick<LimitsTransport, "followed" | "onFollowed"> & { send(to: string, mail: UsageMail, durable: boolean): void },
    private readonly directory: LimitsDirectory,
    /** Where what peers told is kept between runs (`usage/peers.json`); none in a test that doesn't. */
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    /** The most a mail says, its JSON in UTF-8 (smaller in tests). */
    private readonly most = MOST_BYTES,
  ) {
    this.load()
    usage.peers = this
    directory.listen(() => this.directorySaid())
    transport.onFollowed?.(() => this.told.clear())
  }

  private freshAt?: { at: number; fresh: Record<string, number> }

  /** A mail to a peer, with when this box last read each account its maker states whole (`fresh`). */
  private send(to: string, mail: UsageMail, durable: boolean) {
    // (Worked out once for the mails of one moment: each peer's is the same.)
    if (this.freshAt?.at !== mail.at) this.freshAt = { at: mail.at, fresh: Object.fromEntries(this.usage.own().flatMap((account) => (account.accountWide && account.scanned ? [[account.provider, account.scanned]] : []))) }
    const fresh = this.freshAt.fresh
    this.transport.send(to, Object.keys(fresh).length ? { ...mail, fresh } : mail, durable)
  }

  /**
   * Whether another of your own computers reads this account its maker states whole (`service`,
   * `identity`: Cursor's) in this box's place: of those that read it lately (25 minutes, as they
   * said: one that stopped, or that's away, is taken over), the one whose key comes first does,
   * this box included. However its plan's limits went (a problem, a hold, a box a peer vouches for
   * reading them), one of your computers asks its maker for its history at a time.
   */
  readsWhole(service: LimitsService, identity: string): boolean {
    const self = this.directory.own()?.key
    if (!self || !this.directory.told) return false
    const now = this.now()
    for (const [key, kept] of this.peers) {
      if (key >= self || this.vouched(key) || now - kept.heard > PEER_AWAY) continue
      if (kept.accounts.some((account) => account.accountWide && account.service === service && account.identity === identity && account.scanned !== undefined && now - account.scanned < WHOLE_FRESH)) return true
    }
    return false
  }

  /** Every computer's accounts, this box's first, then each peer's by name. */
  rows(own: OwnUsage[]): UsageRow[] {
    const now = this.now()
    const self = this.directory.own()
    const boxes: UsageBox[] = [{ key: self?.key ?? "", name: self?.name ?? "", here: true, away: false, accounts: own }]
    const peers = [...this.peers.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name))
    for (const [key, kept] of peers) boxes.push({ key, name: this.directory.peerBoxes().find((box) => box.key === key)?.name ?? kept.name, here: false, away: now - kept.heard > PEER_AWAY, vouched: this.vouched(key), accounts: kept.accounts.map((account) => ({ ...account, slots: trimmed(account.slots, now) })) })
    return usageRows(boxes)
  }

  /**
   * Whether a box is one a peer vouches for (another Mac beside a machine you share), not one of
   * your computers: as the link says, or until it has since this started, as it last said.
   */
  private vouched(key: string): boolean {
    if (!this.directory.isPeer) return false
    return this.directory.told ? !this.directory.isPeer(key) : this.peers.get(key)?.vouched === true
  }

  /**
   * This box's accounts told to each peer: in full when they changed since (`changed`, after a round
   * here) or to one not told since this started (asking for its own); else every ten minutes, only
   * that what was told is as it was.
   */
  tell(changed = false) {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    const { accounts, digest } = this.shared()
    const from = Math.floor((now - RECENT) / SLOT)
    const recent = () => recentOf(accounts, from)
    for (const { key } of this.directory.peerBoxes()) {
      const last = this.told.get(key)
      if (!last) this.send(key, { kind: "usage", at: now, accounts, digest, ask: true }, false)
      else if (last.digest !== digest && (changed || now - last.at >= TELL_AGAIN)) this.send(key, { kind: "usage", at: now, accounts: recent(), from, digest }, false)
      else if (now - last.at >= TELL_AGAIN) this.send(key, { kind: "usage", at: now, digest }, false)
      else continue
      this.told.set(key, { digest, at: now })
    }
  }

  /**
   * What this box's accounts used, all of it, to each of them, now: another fallback model was
   * chosen, which the digest doesn't hold (`digestOf`) and their older slots keep as told.
   */
  tellAll() {
    if (!this.transport.followed || !this.directory.told) {
      // (Told all of it as soon as it can be.)
      this.told.clear()
      return
    }
    const now = this.now()
    const { accounts, digest } = this.shared()
    // (Not asking for theirs, which didn't change: but from one not told since the link started.)
    for (const { key } of this.directory.peerBoxes()) {
      this.send(key, { kind: "usage", at: now, accounts, digest, ...(this.told.has(key) ? {} : { ask: true }) }, false)
      this.told.set(key, { digest, at: now })
    }
  }

  /** A client pulled to refresh here: each peer reads its own now, and tells (at most once a minute). */
  refreshElsewhere() {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    if (now - this.refreshedElsewhere < MINUTE) return
    this.refreshedElsewhere = now
    // (A refresh only asks: what it says of this box is as last told.)
    const digest = this.lastDigest ?? this.shared().digest
    for (const { key } of this.directory.peerBoxes()) this.send(key, { kind: "usage", at: now, digest, refresh: true }, false)
  }

  /** What a peer told (`from`, its key: the link opens only your computers' mail). */
  take(from: string, mail: unknown) {
    if (!isUsageMail(mail)) return
    if (this.directory.told && !this.directory.peerBoxes().some((box) => box.key === from)) return
    const now = this.now()
    const before = this.peers.get(from)
    const name = this.directory.peerBoxes().find((box) => box.key === from)?.name ?? before?.name ?? "another computer"
    const digest = text(mail.digest, 64)
    const wasAway = !!before && now - before.heard > PEER_AWAY
    const skew = typeof mail.at === "number" && Number.isFinite(mail.at) && Math.abs(now - mail.at) >= SKEW ? now - mail.at : 0
    let whole = !!before && !!digest && before.digest === digest
    if (Array.isArray(mail.accounts)) {
      const off = typeof mail.at === "number" && Number.isFinite(mail.at) && Math.abs(now - mail.at) >= SKEW ? now - mail.at : 0
      let accounts = mail.accounts.slice(0, MOST_ACCOUNTS).flatMap((account) => {
        const taken = takenAccount(account, off, now)
        return taken ? [taken] : []
      })
      // Only its recent slots: the older ones as it told them before.
      const since = typeof mail.from === "number" && Number.isInteger(mail.from) && mail.from > 0 ? mail.from * SLOT : undefined
      if (since !== undefined) accounts = accounts.map((account) => withOlder(account, before?.accounts.find((kept) => kept.provider === account.provider), since))
      whole = !!digest && digestOf(accounts.map(toldOf)) === digest
      const vouched = this.vouched(from)
      this.peers.set(from, { name, heard: now, ...(digest ? { digest } : {}), ...(vouched ? { vouched } : {}), accounts })
      this.save()
      this.usage.peersChanged()
    } else if (before) {
      // Only its word that what it told is as it was: there still (whether this box has all of it
      // is below).
      before.heard = now
      before.name = name
      if (wasAway) this.usage.peersChanged()
    }
    // When it last read each account its maker states whole, though what it read is as it was.
    const fresh = mail.fresh && typeof mail.fresh === "object" ? (mail.fresh as Record<string, unknown>) : undefined
    const kept = this.peers.get(from)
    if (fresh && kept) {
      for (const account of kept.accounts) {
        const at = fresh[account.provider]
        if (!account.accountWide || typeof at !== "number" || !Number.isFinite(at)) continue
        const moved = Math.min(at + skew, now)
        if (moved > (account.scanned ?? 0)) account.scanned = moved
      }
    }
    // What this box has of it isn't what it says it told (it missed some): asked for all of it.
    if (!whole && digest && mail.ask !== true && now - (this.askedBack.get(from) ?? -Infinity) >= MINUTE) {
      this.askedBack.set(from, now)
      const mine = this.shared()
      this.send(from, { kind: "usage", at: now, ...mine, ask: true }, false)
      this.told.set(from, { digest: mine.digest, at: now })
    }
    // (Asked: answered whatever was told lately, as the asker asks at most once a minute.)
    if (mail.ask === true || wasAway) this.answer(from, mail.ask === true)
    if (mail.refresh === true && now - (this.readFor.get(from) ?? -Infinity) >= MINUTE) {
      this.readFor.set(from, now)
      const reading = this.usage.refresh().then(() => this.answer(from, true))
      this.reading.add(reading)
      void reading.finally(() => this.reading.delete(reading))
    }
  }

  /** Once the reads peers asked for are done and told (tests). */
  async idle() {
    while (this.reading.size) await Promise.all([...this.reading])
  }

  /** This box's accounts told in full to one peer that asked, unless it was answered within the minute. An answer doesn't ask back. */
  private answer(key: string, urgent = false) {
    if (!this.transport.followed) return
    const now = this.now()
    if (!urgent && now - (this.answered.get(key) ?? -Infinity) < MINUTE) return
    this.answered.set(key, now)
    const mine = this.shared()
    this.send(key, { kind: "usage", at: now, ...mine }, false)
    this.told.set(key, { digest: mine.digest, at: now })
  }

  /**
   * This box's own accounts as told, as many uses as fit in a mail (the oldest left out first), and
   * their digest: what they used, not when each was read.
   */
  private lastDigest?: string

  private shared(): { accounts: ToldUsage[]; digest: string } {
    // From the first slot of what's kept (a UTC midnight), each account as a receiver will take it
    // (its names cut to length, its slots checked: `takenAccount`), so the two digests agree.
    const start = Math.floor(Math.floor((this.now() - KEPT_DAYS * DAY) / DAY) * DAY) / SLOT
    const accounts: ToldUsage[] = this.usage
      .own()
      .slice(0, MOST_ACCOUNTS)
      .flatMap((own) => {
        const taken = takenAccount(toldOf(own), 0, Infinity)
        return taken ? [{ ...toldOf(taken), slots: fromSlot(keptSlots(taken.slots), start), whole: start }] : []
      })
    for (let bytes = Buffer.byteLength(JSON.stringify(accounts)); bytes > this.most; bytes = Buffer.byteLength(JSON.stringify(accounts))) {
      // The oldest uses across the accounts left out, about as many as are too many (and a few more),
      // each account so cut whole from the slot after.
      const uses = accounts.reduce((sum, account) => sum + account.slots.used.length, 0)
      if (!uses) break
      const over = Math.ceil(((bytes - this.most) / bytes) * uses) + 16
      const cutoff = accounts.flatMap((account) => account.slots.used.map((use) => use[0])).sort((a, b) => a - b)[Math.min(over, uses) - 1]!
      for (const account of accounts) {
        if (!account.slots.used.some((use) => use[0] <= cutoff)) continue
        account.slots = fromSlot(account.slots, cutoff + 1)
        account.whole = Math.max(account.whole ?? 0, cutoff + 1)
        account.cut = true
      }
    }
    const digest = digestOf(accounts)
    this.lastDigest = digest
    return { accounts, digest }
  }

  private directorySaid() {
    const here = new Set(this.directory.peerBoxes().map((box) => box.key))
    let gone = false
    for (const key of [...this.peers.keys()]) {
      if (here.has(key)) continue
      this.peers.delete(key)
      gone = true
    }
    for (const map of [this.told, this.answered, this.askedBack, this.readFor]) for (const key of [...map.keys()]) if (!here.has(key)) map.delete(key)
    // (Which are your computers and which a peer vouches for may have changed: the totals with it.)
    let moved = false
    for (const [key, kept] of this.peers) {
      const vouched = this.vouched(key)
      if ((kept.vouched === true) === vouched) continue
      if (vouched) kept.vouched = true
      else delete kept.vouched
      moved = true
    }
    if (gone || moved) {
      this.save()
      this.usage.peersChanged()
    }
    this.tell()
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { peers?: Record<string, { name?: unknown; heard?: unknown; digest?: unknown; vouched?: unknown; accounts?: unknown }> }
      for (const [key, kept] of Object.entries(saved.peers ?? {})) {
        if (!kept || typeof kept.heard !== "number" || !Array.isArray(kept.accounts)) continue
        const digest = text(kept.digest, 64)
        this.peers.set(key, { name: typeof kept.name === "string" ? kept.name : "another computer", heard: kept.heard, ...(digest ? { digest } : {}), ...(kept.vouched === true ? { vouched: true } : {}), accounts: kept.accounts.flatMap((account) => takenAccount(account, 0, Infinity) ?? []) })
      }
    } catch {}
  }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const peers = Object.fromEntries([...this.peers].map(([key, kept]) => [key, { ...kept, accounts: kept.accounts.map(({ slots, ...account }) => ({ ...account, slots: keptSlots(slots) })) }]))
      writeFileSync(this.file + ".new", JSON.stringify({ peers }), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch {}
  }
}

/**
 * What a box's accounts used, hashed, as told: the same on both sides once the receiver has put
 * together what it was told (each account's fields in one order, its slots as kept: `keptSlots`).
 * Not which fallback model estimated what (`slots.fallback`): a box from before keeps none of it,
 * and would never find its own the same. Its peers are told all of it when that changes (`tellAll`).
 * Nor whether it's billed (`estimated`) or stated whole by its maker (`accountWide`), which never
 * change for an account, and which a box from before doesn't keep either.
 */
export function digestOf(accounts: ToldUsage[]): string {
  const canonical = accounts.map((account) => [account.provider, account.service, account.agent ?? null, account.account ?? null, account.label ?? null, account.identity ?? null, account.cut === true, account.places ?? [], account.slots.models, account.slots.used, account.slots.unknown ?? []])
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)
}

/** An account as this box keeps a peer's, as it was told. */
const toldOf = ({ slots, ...account }: OwnUsage): ToldUsage => ({ ...account, slots: keptSlots(slots) })

/** Kept slots from `first` (quarter hours since 1970) on, as a receiver keeps them (its models only those still used). */
function fromSlot(slots: KeptSlots, first: number): KeptSlots {
  return keptSlots(slotsFrom({ ...slots, used: slots.used.filter((use) => use[0] >= first), ...(slots.unknown ? { unknown: slots.unknown.filter((each) => each[0] >= first) } : {}), ...(slots.fallback ? { fallback: slots.fallback.filter((each) => each[0] >= first) } : {}) }, Infinity))
}

/** Each account with only its slots from `from` (quarter hours since 1970) on. */
function recentOf(accounts: ToldUsage[], from: number): ToldUsage[] {
  return accounts.map((account) => ({
    ...account,
    slots: { models: account.slots.models, used: account.slots.used.filter((use) => use[0] >= from), ...(account.slots.unknown ? { unknown: account.slots.unknown.filter((each) => each[0] >= from) } : {}), ...(account.slots.fallback ? { fallback: account.slots.fallback.filter((each) => each[0] >= from) } : {}) },
  }))
}

/** A peer's account told from `since` (ms) on, with what this box kept of it before then. */
function withOlder(account: OwnUsage, kept: OwnUsage | undefined, since: number): OwnUsage {
  const slots = noSlots()
  // (None from before what it still has: what it cut, or let age out.)
  const first = (account.whole ?? 0) * SLOT
  for (const [slot, models] of kept?.slots.used ?? []) if (slot < since && slot >= first) slots.used.set(slot, models)
  for (const [slot, models] of kept?.slots.unknown ?? []) if (slot < since && slot >= first) slots.unknown.set(slot, models)
  for (const [slot, models] of kept?.slots.fallback ?? []) if (slot < since && slot >= first) slots.fallback.set(slot, models)
  for (const [slot, models] of account.slots.used) if (slot >= since) slots.used.set(slot, models)
  for (const [slot, models] of account.slots.unknown) if (slot >= since) slots.unknown.set(slot, models)
  for (const [slot, models] of account.slots.fallback) if (slot >= since) slots.fallback.set(slot, models)
  return { ...account, slots }
}

/** A peer's account as it's kept: only what an account says, checked; its `scanned` moved by `off` onto this box's clock (never past `now`). */
function takenAccount(given: unknown, off: number, now: number): OwnUsage | null {
  if (!given || typeof given !== "object") return null
  const account = given as Record<string, any>
  const provider = text(account.provider)
  if (!provider || typeof account.service !== "string" || !SERVICE.test(account.service)) return null
  const scanned = typeof account.scanned === "number" && Number.isFinite(account.scanned) && account.scanned > 0 ? Math.min(account.scanned + off, now) : undefined
  return {
    provider,
    service: account.service as LimitsService,
    ...(kinds.includes(account.agent) ? { agent: account.agent as AgentKind, ...(text(account.account) ? { account: text(account.account) } : {}) } : {}),
    ...(text(account.label, 100) ? { label: text(account.label, 100) } : {}),
    ...(typeof account.identity === "string" && /^[0-9a-f]{16}$/.test(account.identity) ? { identity: account.identity } : {}),
    ...(scanned ? { scanned } : {}),
    slots: slotsFrom(account.slots, MOST_USES),
    ...(account.cut === true ? { cut: true as const } : {}),
    ...(Number.isSafeInteger(account.whole) && account.whole > 0 ? { whole: account.whole } : {}),
    ...(Array.isArray(account.places) && account.places.length ? { places: account.places.filter((place: unknown): place is string => typeof place === "string" && /^[0-9a-f]{16}$/.test(place)).slice(0, 20) } : {}),
    ...(account.estimated === false ? { estimated: false as const } : {}),
    ...(account.accountWide === true ? { accountWide: true as const } : {}),
  }
}
