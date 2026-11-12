// What your accounts used, shared between your computers (PROTOCOL.md, "Usage history"): each box
// tells the boxes it shares plan limits with (its peers and those they vouch for, `LimitsDirectory`)
// its own accounts' hours (who each account is, as a hash, and each hour's tokens and dollars by
// model; never a sign-in, a log or a message), after a round that changed them and every ten minutes,
// and keeps the last each one told, through a restart. Every box then lists every account across
// them, each account's hours added up from every box it's used on (`usageRows`). A box that stops
// telling keeps what it last said, and is marked away. The mail goes through the box's link, in
// parts when it's big, as a group chat's does.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kinds, type AgentKind } from "../accounts"
import type { LimitsDirectory, LimitsTransport } from "../limits-peers"
import type { LimitsService } from "../limits"
import { hoursFrom, keptHours, trimmed, type KeptHours } from "./history"
import { usageRows, type OwnUsage, type Usage, type UsageBox, type UsageRow } from "./usage"

/** One account as a box tells it. */
export interface ToldUsage extends Omit<OwnUsage, "hours"> {
  hours: KeptHours
}

/** What one box tells another of its usage (`{"seat": {"kind": "usage", …}}` between links). */
export interface UsageMail {
  kind: "usage"
  /** When it was told, by the sender's clock (ms). */
  at: number
  accounts: ToldUsage[]
  /** It just started: tell it yours. */
  ask?: true
  /** Read yours now and tell it (a client pulled to refresh there). */
  refresh?: true
}

export const isUsageMail = (value: any): value is UsageMail => value !== null && typeof value === "object" && value.kind === "usage"

interface Kept {
  name: string
  /** When its last mail came, by this box's clock. */
  heard: number
  accounts: OwnUsage[]
}

const MINUTE = 60_000
/** Told again this often though nothing changed (the relay keeps nothing). */
const TELL_AGAIN = 10 * MINUTE
/** A peer not heard from this long is away: what it said stays. */
const PEER_AWAY = 25 * MINUTE
/** What changed is told at most this often (a round is every five minutes; a refresh's sooner). */
const CHANGED_EVERY = MINUTE
/** A clock this far off or more is moved onto this box's. */
const SKEW = MINUTE
/** At most this many accounts from a box, and uses of each. */
const MOST_ACCOUNTS = 50
const MOST_USES = 20_000

const SERVICE = /^[a-z0-9][a-z0-9-]{0,39}$/
const text = (value: unknown, most = 200) => (typeof value === "string" && value ? value.slice(0, most) : undefined)

export class UsagePeers {
  private peers = new Map<string, Kept>()
  private told = new Map<string, { json: string; at: number }>()
  private answered = new Map<string, number>()

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
    for (const [key, kept] of peers) boxes.push({ key, name: this.directory.peerBoxes().find((box) => box.key === key)?.name ?? kept.name, here: false, away: now - kept.heard > PEER_AWAY, accounts: kept.accounts.map((account) => ({ ...account, hours: trimmed(account.hours, now) })) })
    return usageRows(boxes)
  }

  /** This box's accounts told to each peer: once changed (at most a minute apart), and every ten minutes; to one not told since this started, asking for its own. */
  tell(urgent = false) {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    const accounts = this.shared()
    const json = JSON.stringify(accounts)
    for (const { key } of this.directory.peerBoxes()) {
      const last = this.told.get(key)
      const due = !last || now - last.at >= TELL_AGAIN || (last.json !== json && (urgent || now - last.at >= CHANGED_EVERY))
      if (!due) continue
      this.transport.send(key, { kind: "usage", at: now, accounts, ...(!last ? { ask: true as const } : {}) }, false)
      this.told.set(key, { json, at: now })
    }
  }

  /** A client pulled to refresh here: each peer reads its own now, and tells. */
  refreshElsewhere() {
    if (!this.transport.followed || !this.directory.told) return
    const now = this.now()
    const accounts = this.shared()
    for (const { key } of this.directory.peerBoxes()) this.transport.send(key, { kind: "usage", at: now, accounts, refresh: true }, false)
  }

  /** What a peer told (`from`, its key: the link opens only your computers' mail). */
  take(from: string, mail: unknown) {
    if (!isUsageMail(mail) || !Array.isArray(mail.accounts)) return
    if (this.directory.told && !this.directory.peerBoxes().some((box) => box.key === from)) return
    const now = this.now()
    const off = typeof mail.at === "number" && Number.isFinite(mail.at) && Math.abs(now - mail.at) >= SKEW ? now - mail.at : 0
    const accounts = mail.accounts.slice(0, MOST_ACCOUNTS).flatMap((account) => {
      const taken = takenAccount(account, off, now)
      return taken ? [taken] : []
    })
    const before = this.peers.get(from)
    const name = this.directory.peerBoxes().find((box) => box.key === from)?.name ?? before?.name ?? "another computer"
    this.peers.set(from, { name, heard: now, accounts })
    this.save()
    this.usage.peersChanged()
    if (mail.ask === true || (before && now - before.heard > PEER_AWAY)) this.answer(from)
    if (mail.refresh === true) void this.usage.refresh().then(() => this.answer(from, true))
  }

  /** This box's accounts told to one peer that asked, unless it was answered within the minute. An answer doesn't ask back. */
  private answer(key: string, urgent = false) {
    if (!this.transport.followed) return
    const now = this.now()
    if (!urgent && now - (this.answered.get(key) ?? -Infinity) < MINUTE) return
    this.answered.set(key, now)
    const accounts = this.shared()
    this.transport.send(key, { kind: "usage", at: now, accounts }, false)
    this.told.set(key, { json: JSON.stringify(accounts), at: now })
  }

  private shared(): ToldUsage[] {
    return this.usage
      .own()
      .slice(0, MOST_ACCOUNTS)
      .map(({ hours, ...account }) => ({ ...account, hours: keptHours(hours) }))
  }

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
      this.usage.peersChanged()
    }
    this.tell()
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { peers?: Record<string, { name?: unknown; heard?: unknown; accounts?: unknown }> }
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
      const peers = Object.fromEntries([...this.peers].map(([key, kept]) => [key, { ...kept, accounts: kept.accounts.map(({ hours, ...account }) => ({ ...account, hours: keptHours(hours) })) }]))
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
    hours: hoursFrom(account.hours, MOST_USES),
  }
}
