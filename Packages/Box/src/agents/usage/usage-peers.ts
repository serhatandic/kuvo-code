// What your accounts used, shared between your computers (PROTOCOL.md, "Usage history"): each box
// tells the boxes it shares plan limits with (its peers and those they vouch for, `LimitsDirectory`)
// its own accounts' slots (who each account is, as a hash, its name, and each quarter hour's tokens
// and dollars by model; never a sign-in, a log or a message) when they changed, and keeps the last
// each one told, through a restart. Every box then lists every account across them, each account's
// slots added up from every box it's used on (`usageRows`). In between, every ten minutes, a box
// says only that it's there and what it told is as it was (`digest`); a box that missed it asks
// again. One that stops telling keeps what it last said, and is marked away. The mail goes through
// the box's link, in parts when it's big, as a group chat's does.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kinds, type AgentKind } from "../accounts"
import type { LimitsDirectory, LimitsTransport } from "../limits-peers"
import type { LimitsService } from "../limits"
import { keptSlots, slotsFrom, trimmed, type KeptSlots } from "./history"
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
  /** What its accounts used, hashed: the same as last told, nothing new. */
  digest: string
  /** Tell me yours (it just started, or missed what you told). */
  ask?: true
  /** Read yours now and tell it (a client pulled to refresh there). */
  refresh?: true
}

export const isUsageMail = (value: any): value is UsageMail => value !== null && typeof value === "object" && value.kind === "usage"

interface Kept {
  name: string
  /** When its last mail came, by this box's clock. */
  heard: number
  /** What it told, hashed (`UsageMail.digest`). */
  digest?: string
  accounts: OwnUsage[]
}

const MINUTE = 60_000
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

const SERVICE = /^[a-z0-9][a-z0-9-]{0,39}$/
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
  ) {
    this.load()
    usage.peers = this
    directory.listen(() => this.directorySaid())
    transport.onFollowed?.(() => this.told.clear())
  }

  /** Every computer's accounts, this box's first, then each peer's by name. */
  rows(own: OwnUsage[]): UsageRow[] {
    const now = this.now()
    const self = this.directory.own()
    const boxes: UsageBox[] = [{ key: self?.key ?? "", name: self?.name ?? "", here: true, away: false, accounts: own }]
    const peers = [...this.peers.entries()].sort(([, a], [, b]) => a.name.localeCompare(b.name))
    for (const [key, kept] of peers) boxes.push({ key, name: this.directory.peerBoxes().find((box) => box.key === key)?.name ?? kept.name, here: false, away: now - kept.heard > PEER_AWAY, accounts: kept.accounts.map((account) => ({ ...account, slots: trimmed(account.slots, now) })) })
    return usageRows(boxes)
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
    for (const { key } of this.directory.peerBoxes()) {
      const last = this.told.get(key)
      if (!last || (changed && last.digest !== digest)) this.transport.send(key, { kind: "usage", at: now, accounts, digest, ...(!last ? { ask: true as const } : {}) }, false)
      else if (now - last.at >= TELL_AGAIN) this.transport.send(key, { kind: "usage", at: now, digest, ...(last.digest === digest ? {} : { accounts }) }, false)
      else continue
      this.told.set(key, { digest, at: now })
    }
  }

  /** A client pulled to refresh here: each peer reads its own now, and tells (at most once a minute). */
  refreshElsewhere() {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    if (now - this.refreshedElsewhere < MINUTE) return
    this.refreshedElsewhere = now
    const { digest } = this.shared()
    for (const { key } of this.directory.peerBoxes()) this.transport.send(key, { kind: "usage", at: now, digest, refresh: true }, false)
  }

  /** What a peer told (`from`, its key: the link opens only your computers' mail). */
  take(from: string, mail: unknown) {
    if (!isUsageMail(mail)) return
    if (this.directory.told && !this.directory.peerBoxes().some((box) => box.key === from)) return
    const now = this.now()
    const before = this.peers.get(from)
    const name = this.directory.peerBoxes().find((box) => box.key === from)?.name ?? before?.name ?? "another computer"
    const digest = text(mail.digest, 64)
    if (Array.isArray(mail.accounts)) {
      const off = typeof mail.at === "number" && Number.isFinite(mail.at) && Math.abs(now - mail.at) >= SKEW ? now - mail.at : 0
      const accounts = mail.accounts.slice(0, MOST_ACCOUNTS).flatMap((account) => {
        const taken = takenAccount(account, off, now)
        return taken ? [taken] : []
      })
      this.peers.set(from, { name, heard: now, ...(digest ? { digest } : {}), accounts })
      this.save()
      this.usage.peersChanged()
    } else if (before && digest && before.digest === digest) {
      // As it told before: there still.
      const away = now - before.heard > PEER_AWAY
      before.heard = now
      before.name = name
      if (away) this.usage.peersChanged()
    } else if (now - (this.askedBack.get(from) ?? -Infinity) >= MINUTE) {
      // What it says is as it was isn't what this box has: asked for it.
      this.askedBack.set(from, now)
      const mine = this.shared()
      this.transport.send(from, { kind: "usage", at: now, ...mine, ask: true }, false)
      this.told.set(from, { digest: mine.digest, at: now })
    }
    if (mail.ask === true || (before && now - before.heard > PEER_AWAY)) this.answer(from)
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
    this.transport.send(key, { kind: "usage", at: now, ...mine }, false)
    this.told.set(key, { digest: mine.digest, at: now })
  }

  /**
   * This box's own accounts as told, as many uses as fit in a mail (the oldest left out first), and
   * their digest: what they used, not when each was read.
   */
  private shared(): { accounts: ToldUsage[]; digest: string } {
    const accounts = this.usage
      .own()
      .slice(0, MOST_ACCOUNTS)
      .map(({ slots, ...account }) => ({ ...account, slots: keptSlots(slots) }))
    while (Buffer.byteLength(JSON.stringify(accounts)) > MOST_BYTES) {
      // (The account with the oldest use gives it up.)
      const oldest = accounts.filter((account) => account.slots.used.length).sort((a, b) => a.slots.used[0]![0] - b.slots.used[0]![0])[0]
      if (!oldest) break
      oldest.slots = { ...oldest.slots, used: oldest.slots.used.slice(Math.max(1, Math.floor(oldest.slots.used.length / 10))) }
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(accounts.map(({ scanned: _, ...account }) => account)))
      .digest("hex")
      .slice(0, 32)
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
    if (gone) {
      this.save()
      this.usage.peersChanged()
    }
    this.tell()
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { peers?: Record<string, { name?: unknown; heard?: unknown; digest?: unknown; accounts?: unknown }> }
      for (const [key, kept] of Object.entries(saved.peers ?? {})) {
        if (!kept || typeof kept.heard !== "number" || !Array.isArray(kept.accounts)) continue
        const digest = text(kept.digest, 64)
        this.peers.set(key, { name: typeof kept.name === "string" ? kept.name : "another computer", heard: kept.heard, ...(digest ? { digest } : {}), accounts: kept.accounts.flatMap((account) => takenAccount(account, 0, Infinity) ?? []) })
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
  }
}
