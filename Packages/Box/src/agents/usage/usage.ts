// What your accounts used and cost, by the day: each account this box runs that's signed in to Kuvo
// Code (Claude Code's, so far), read from its agent's own logs on this computer, priced
// (pricing.ts), and kept by the quarter hour (history.ts). This box's own, with your other computers' boxes'
// (usage-peers.ts), one row per account: an account used on two computers is the sum of both. A
// client asks for its own days (`zone`): the box answers them. Read every five minutes, or when a
// client asks, one round at a time. PROTOCOL.md, "Usage history".
//
// Nothing here reads a sign-in: an account is named as its plan limits name it (`Limits.identity`).

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import type { AgentKind } from "../accounts"
import { parseProvider } from "../accounts"
import type { Agent } from "../agent"
import { emit } from "../events"
import type { LimitsService } from "../limits"
import { claudeLine, dedupClaude, fromKeptClaude, keptClaude, type KeptClaudeEntry } from "./claude-log"
import { claudeSlots, daysIn, slotsFrom, keptSlots, knownZone, noSlots, ownZone, summed, trimmed, type Day, type Slots, KEPT_DAYS } from "./history"
import { JSONLFiles, jsonlFiles } from "./jsonl"
import type { Pricing, PricingStore } from "./pricing"
import type { UsagePeers } from "./usage-peers"

/** The services whose usage history a box states, so far. */
export const USAGE_SERVICES: LimitsService[] = ["claude"]

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** A round of reading every account's logs, this often. */
export const SCAN_EVERY = 5 * MINUTE

/** An account whose usage this box reads from its agent's logs here. */
export interface UsageSource {
  provider: string
  service: LimitsService
  agent?: { kind: AgentKind; account: string }
  label?: string
  /** Its slots from `since` (ms) on, priced (throws when its logs can't be read now). */
  slots(pricing: Pricing, since: number): Promise<Slots>
  /** The folders its logs are in, hashed (`placeOf`). */
  places?(): string[]
  /** What it keeps of the logs it read, shared by the accounts of its kind: told once a round is over. */
  files?: { endRound(complete: boolean): void }
}

/** One of this box's accounts, as it's kept and told. */
export interface OwnUsage {
  provider: string
  service: LimitsService
  agent?: AgentKind
  account?: string
  label?: string
  /** As plan limits name it (`AccountLimits.identity`): the same account on every box. */
  identity?: string
  /** When its logs were last read here, in ms. */
  scanned?: number
  slots: Slots
  /** A peer's whose oldest use was left out of its mail (too much to tell): this box has less of it. */
  cut?: true
  /** A peer's: its slots are all there from this one (quarter hours since 1970) on, none before. */
  whole?: number
  /**
   * The folders its logs are in, each as a hash of its computer and the folder's real path
   * (`placeOf`): two boxes on one computer reading one folder are counted once.
   */
  places?: string[]
}

/** A computer an account's usage comes from, as a row names it. */
export interface UsageRowBox {
  key: string
  name: string
  provider: string
  agent?: AgentKind
  account?: string
  label?: string
  scanned?: number
  here?: true
  away?: true
  /** A box a peer vouches for (another Mac beside a machine you share): not one of your computers. */
  vouched?: true
  /** It reads a folder another of these boxes already does (two boxes on one computer): not added again. */
  same?: true
}

/** One account across your computers: every box's slots of it, added up. */
export interface UsageRow {
  /** As plan limits' `rows` have it: `<service>#<identity>`, or `<box key>/<provider>`. */
  id: string
  service: LimitsService
  provider: string
  agent?: AgentKind
  account?: string
  label?: string
  identity?: string
  /** The newest of its boxes' reads. */
  scanned?: number
  boxes: UsageRowBox[]
  /** Every computer it's on is away: its numbers are as of then. */
  away?: true
  /** One of its computers told less than all of its use (`OwnUsage.cut`): its oldest days are short. */
  cut?: true
  /** It's only on boxes a peer vouches for: not yours, and in no total. */
  vouched?: true
  slots: Slots
  /** Its slots from your own computers only (not a vouched box's): what the totals add up. */
  yours: Slots
  /** Your own computers' share of it: one is away, or told less than all. */
  yoursAway?: true
  yoursCut?: true
}

/** A box's accounts, as `rows` takes them: this one's, or what a peer last told. */
export interface UsageBox {
  key: string
  name: string
  here: boolean
  away: boolean
  /** A box a peer vouches for, not one of yours. */
  vouched?: boolean
  accounts: OwnUsage[]
}

/** One row per account across the boxes, this box's first: one `service` with one `identity` is one account. */
export function usageRows(boxes: UsageBox[]): UsageRow[] {
  const groups: { id: string; members: { box: UsageBox; account: OwnUsage; same: boolean }[] }[] = []
  const found = new Map<string, number>()
  // Folders already counted, this box's first: one read again by another box on that computer isn't.
  const counted = new Set<string>()
  for (const box of boxes) {
    for (const account of box.accounts) {
      const same = (account.places ?? []).some((place) => counted.has(place))
      if (!same) for (const place of account.places ?? []) counted.add(place)
      const id = account.identity ? `${account.service}#${account.identity}` : `${box.key}/${account.provider}`
      const index = found.get(id)
      if (index !== undefined) groups[index]!.members.push({ box, account, same })
      else {
        found.set(id, groups.length)
        groups.push({ id, members: [{ box, account, same }] })
      }
    }
  }
  return groups.map(({ id, members }) => {
    // Named as a coding agent's where one is among them, with the first name you gave it.
    const base = members.find((member) => member.account.agent)?.account ?? members[0]!.account
    const label = members.map((member) => member.account.label?.trim()).find(Boolean)
    const scanned = Math.max(0, ...members.map((member) => member.account.scanned ?? 0))
    const row: UsageRow = {
      id,
      service: base.service,
      provider: base.provider,
      ...(base.agent ? { agent: base.agent } : {}),
      ...(base.account ? { account: base.account } : {}),
      ...(label ? { label } : {}),
      ...(base.identity ? { identity: base.identity } : {}),
      ...(scanned ? { scanned } : {}),
      boxes: members.map(({ box, account, same }) => ({
        key: box.key,
        name: box.name,
        provider: account.provider,
        ...(account.agent ? { agent: account.agent } : {}),
        ...(account.account ? { account: account.account } : {}),
        ...(account.label ? { label: account.label } : {}),
        ...(account.scanned ? { scanned: account.scanned } : {}),
        ...(box.here ? { here: true as const } : {}),
        ...(box.away ? { away: true as const } : {}),
        ...(box.vouched ? { vouched: true as const } : {}),
        ...(same ? { same: true as const } : {}),
      })),
      slots: summed(members.filter((member) => !member.same).map((member) => member.account.slots)),
      yours: summed(members.filter((member) => !member.same && !member.box.vouched).map((member) => member.account.slots)),
    }
    const yours = members.filter((member) => !member.same && !member.box.vouched)
    if (members.every((member) => member.box.away)) row.away = true
    if (members.some((member) => member.account.cut)) row.cut = true
    if (members.every((member) => member.box.vouched)) row.vouched = true
    if (yours.some((member) => member.box.away)) row.yoursAway = true
    if (yours.some((member) => member.account.cut)) row.yoursCut = true
    return row
  })
}

interface Entry {
  identity?: string
  scanned?: number
  slots: Slots
}

export class Usage {
  private entries = new Map<string, Entry>()
  private scanning?: Promise<void>
  private again = false
  private timer?: ReturnType<typeof setInterval>
  private said = ""
  /** Your other computers' usage, once the bridge's link is there to carry it. */
  peers?: UsagePeers

  constructor(
    private readonly sources: () => UsageSource[],
    private readonly pricing: PricingStore,
    /** Who each account is, as its plan limits name it (`Limits.identity`). */
    private readonly identity: (provider: string) => string | undefined,
    /** Where it's kept between runs (`usage/usage.json` in the bridge's folder); none in a test that doesn't. */
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load()
    // New prices: read again, to price with them.
    pricing.onChange = () => void this.refresh()
  }

  /** Reads every five minutes, and once soon. */
  start() {
    this.timer ??= setInterval(() => void this.tick(), SCAN_EVERY)
    this.timer.unref?.()
    void this.tick()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** A round now (one under way: another after it, once). */
  tick(): Promise<void> {
    if (this.scanning) {
      this.again = true
      return this.scanning
    }
    this.scanning = this.round().finally(() => {
      this.scanning = undefined
      if (this.again) {
        this.again = false
        void this.tick()
      }
    })
    return this.scanning
  }

  /** A client or a peer asked: read now, and wait for it. */
  async refresh() {
    await this.tick()
    // (One under way when asked read before it was: the round after it is the one asked for.)
    if (this.scanning) await this.scanning
  }

  private async round() {
    const pricing = this.pricing.current()
    const at = this.now()
    // (From a UTC midnight: what ages out goes once a day, not a little each round.)
    const since = Math.floor((at - KEPT_DAYS * DAY) / DAY) * DAY
    const sources = this.sources()
    let complete = true
    for (const source of sources) {
      let slots: Slots | undefined
      try {
        slots = await source.slots(pricing, since)
      } catch (error) {
        console.error(`usage of ${source.provider}:`, error)
      }
      const entry = this.entries.get(source.provider) ?? { slots: noSlots() }
      if (slots) {
        entry.slots = slots
        entry.scanned = this.now()
      } else {
        complete = false
        entry.slots = trimmed(entry.slots, at)
      }
      this.entries.set(source.provider, entry)
    }
    // Accounts gone since: their records go.
    const here = new Set(sources.map((source) => source.provider))
    for (const provider of [...this.entries.keys()]) if (!here.has(provider)) this.entries.delete(provider)
    // (A round cut short forgets none of the logs it didn't get to.)
    for (const files of new Set(sources.flatMap((source) => (source.files ? [source.files] : [])))) files.endRound(complete)
    this.save()
    this.changed(true)
  }

  /** This box's own accounts, as it keeps them and tells its peers. */
  own(): OwnUsage[] {
    return this.sources().flatMap((source) => {
      const entry = this.entries.get(source.provider)
      if (!entry) return []
      const identity = this.identity(source.provider) ?? entry.identity
      if (identity !== entry.identity) entry.identity = identity
      return [
        {
          provider: source.provider,
          service: source.service,
          ...(source.agent ? { agent: source.agent.kind, account: source.agent.account } : {}),
          ...(source.label ? { label: source.label } : {}),
          ...(identity ? { identity } : {}),
          ...(entry.scanned ? { scanned: entry.scanned } : {}),
          slots: entry.slots,
          ...(source.places ? { places: source.places() } : {}),
        },
      ]
    })
  }

  /** Every account across your computers, this box's first. */
  rows(): UsageRow[] {
    const own = this.own()
    return this.peers ? this.peers.rows(own) : usageRows([{ key: "", name: "", here: true, away: false, accounts: own }])
  }

  /** What a peer told changed the rows: the clients are told. */
  peersChanged() {
    this.changed(false)
  }

  /**
   * The rows as a client draws them, in its time zone (`zone`, an IANA name; this box's own when
   * it isn't one): each account's days, and each service's, every account added up.
   */
  view(zone?: string | null) {
    const asked = knownZone(zone) ?? ownZone()
    const now = this.now()
    const rows = this.rows()
    // Each service's days: your own computers' accounts only (a box a peer vouches for may be
    // another person's), each folder once. And whether one of them is away or told less than all.
    const totals: Record<string, Day[]> = {}
    const partial: Record<string, { away?: true; cut?: true }> = {}
    for (const service of USAGE_SERVICES) {
      const of = rows.filter((row) => row.service === service && !row.vouched)
      if (!of.length) continue
      totals[service] = daysIn(summed(of.map((row) => row.yours)), asked, now)
      if (of.some((row) => row.yoursAway || row.yoursCut)) partial[service] = { ...(of.some((row) => row.yoursAway) ? { away: true as const } : {}), ...(of.some((row) => row.yoursCut) ? { cut: true as const } : {}) }
    }
    const scanned = Math.max(0, ...this.own().map((account) => account.scanned ?? 0))
    return {
      zone: asked,
      services: USAGE_SERVICES,
      ...(scanned ? { scanned } : {}),
      rows: rows.map(({ slots, yours: _, yoursAway: _away, yoursCut: _cut, ...row }) => ({ ...row, days: daysIn(slots, asked, now) })),
      totals,
      ...(Object.keys(partial).length ? { partial } : {}),
    }
  }

  /** What this box's own accounts used, as last told: a round that read nothing new tells no one. */
  private ownSaid = ""

  /**
   * After a round (`own`) or a peer's word: your other computers are told what this box's accounts
   * used, and the clients that the rows changed, only when what they used did (when each was read
   * isn't news).
   */
  private changed(own: boolean) {
    if (own) {
      const mine = JSON.stringify(this.own().map(({ scanned: _, slots, ...account }) => ({ ...account, slots: keptSlots(slots) })))
      // (A round is minutes from the last: what changed goes at once; else, now and then, that nothing did.)
      this.peers?.tell(mine !== this.ownSaid)
      this.ownSaid = mine
    }
    const now = JSON.stringify(this.rows().map(({ scanned: _, slots, yours, boxes, ...row }) => ({ ...row, boxes: boxes.map(({ scanned: _, ...box }) => box), slots: keptSlots(slots), yours: keptSlots(yours) })))
    if (now === this.said) return
    this.said = now
    emit("kuvo.usage.updated", { services: USAGE_SERVICES })
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"))
      for (const [provider, kept] of Object.entries(saved?.accounts ?? {}) as [string, any][]) {
        if (!kept || typeof kept !== "object") continue
        this.entries.set(provider, {
          ...(typeof kept.identity === "string" && /^[0-9a-f]{16}$/.test(kept.identity) ? { identity: kept.identity } : {}),
          ...(typeof kept.scanned === "number" ? { scanned: kept.scanned } : {}),
          slots: trimmed(slotsFrom(kept.slots, 200_000), this.now()),
        })
      }
    } catch {}
    this.said = ""
  }

  private save() {
    if (!this.file) return
    const accounts = Object.fromEntries([...this.entries].map(([provider, entry]) => [provider, { ...(entry.identity ? { identity: entry.identity } : {}), ...(entry.scanned ? { scanned: entry.scanned } : {}), slots: keptSlots(entry.slots) }]))
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + ".new", JSON.stringify({ accounts }), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch {}
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/**
 * `GET api/kuvo/usage?zone=<IANA>` → `{data: {zone, services, scanned?, rows, totals}}`; `POST
 * api/kuvo/usage/refresh[?zone=]` reads now (here, and asks your other computers to), and answers
 * the same once it's read here (PROTOCOL.md, "Usage history").
 */
export async function usageRoutes(usage: Usage | undefined, method: string, rest: string[], params: URLSearchParams): Promise<Response> {
  if (!usage) return json({ message: "Usage isn't read on this computer." }, 503)
  const zone = params.get("zone")
  if (!rest.length && method === "GET") return json({ data: usage.view(zone) })
  if (rest.length === 1 && rest[0] === "refresh" && method === "POST") {
    usage.peers?.refreshElsewhere()
    // What's read within a few seconds is in the answer; the rest comes as kuvo.usage.updated.
    await Promise.race([usage.refresh(), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())])
    return json({ data: usage.view(zone) })
  }
  return json({ message: "Not available for this agent." }, 404)
}

/**
 * Where a folder of logs is, as boxes tell each other: a hash of this computer (`thisComputer`) and
 * the folder's real path, so two boxes on one computer reading the same folder count it once, and
 * two computers with the same name and the same path (two Raspberry Pis' `/home/pi/.claude`) don't.
 */
export function placeOf(computer: string, folder: string): string {
  let real = folder
  try {
    real = realpathSync(folder)
  } catch {}
  return createHash("sha256").update("kuvo-code usage place v2\n").update(computer).update("\n").update(real).digest("hex").slice(0, 16)
}

/**
 * This computer, the same for every box on it and different from any other's: on Linux its machine
 * ID (`/etc/machine-id`, or D-Bus's) with its name (a machine cloned from one image can keep the
 * image's ID); on a Mac its hardware UUID alone (its name can change with the network); else its
 * name. It's only hashed (`placeOf`), never told. Not the box's link key: two boxes on one Mac
 * have two.
 */
export function thisComputer(platform: string = process.platform, read = (path: string) => readFileSync(path, "utf8"), macUUID = () => uuidOf(ioreg()), name = hostname): string {
  if (platform === "darwin") {
    const uuid = macUUID()
    if (uuid) return "mac:" + uuid
  } else {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const id = read(path).trim()
        if (/^[0-9a-fA-F]{16,}$/.test(id)) return "machine-id:" + id.toLowerCase() + "\n" + name()
      } catch {}
    }
  }
  return "host:" + name()
}

let computer: { found: string; sure: boolean; at: number } | undefined
/**
 * `thisComputer()`, worked out once it's found. A Mac's `ioreg` that didn't answer is asked again,
 * at most once a minute (each try holds the bridge up to 5 s), so two boxes on one Mac don't stay
 * named differently; meanwhile its name stands in.
 */
export function ownComputer(now = Date.now()): string {
  if (computer && (computer.sure || now - computer.at < 60_000)) return computer.found
  const found = thisComputer()
  computer = { found, sure: process.platform !== "darwin" || found.startsWith("mac:"), at: now }
  return found
}

/** A Mac's hardware UUID, from what `ioreg -rd1 -c IOPlatformExpertDevice` says. */
export function uuidOf(said: string | undefined): string | undefined {
  return said ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{16,})"/.exec(said)?.[1] : undefined
}

function ioreg(): string | undefined {
  try {
    return execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

/**
 * The `projects` folders an account's Claude Code conversations are in: those it runs with
 * (`conversationRoots`: an added account's own folder, Kuvo Code's on a machine), and for one that
 * runs in your own settings folder (a Mac's own sign-in), every folder Claude Code uses as UsageKit
 * read them: each of a comma-separated `CLAUDE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/claude` (or
 * `~/.config/claude`) and `~/.claude`.
 */
export function claudeRoots(agent: Agent, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const roots = [...(agent.conversationRoots?.() ?? [])]
  if (!agent.instance.home) {
    const configured = env.CLAUDE_CONFIG_DIR?.trim()
    const folders = configured
      ? configured.split(",").map((part) => part.trim()).filter(Boolean).map((part) => (part.startsWith("~/") ? join(home, part.slice(2)) : part))
      : [join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "claude"), join(home, ".claude")]
    for (const folder of folders) roots.push(basename(folder) === "projects" ? folder : join(folder, "projects"))
  }
  return [...new Set(roots)]
}

/**
 * The Claude Code accounts whose usage is read here, from the folders each runs Claude Code with
 * (`claudeRoots`). `folder`: where what was read of the logs is kept (`claude-files`, a file a log).
 * A round that read nothing new, with the same prices, works nothing out again. `computer`: this
 * computer, for where its folders are (`placeOf`).
 */
export function claudeSources(folder?: string, computer = ownComputer): (agents: Agent[]) => UsageSource[] {
  const files = new JSONLFiles<KeptClaudeEntry>(
    (line) => claudeLine(line).map(keptClaude),
    (entry) => entry[0],
    folder ? join(folder, "claude-files") : undefined,
    1,
    // (The same reply's usage written again for each of its parts: kept once. One without a message ID is always kept.)
    (entry) => (entry[1] === null ? undefined : JSON.stringify(entry.slice(1))),
  )
  const last = new Map<string, { version: number; pricing: Pricing; since: number; listed: string; slots: Slots }>()
  return (agents) =>
    agents.flatMap((agent) => {
      const parsed = parseProvider(agent.providerID)
      if (parsed?.kind !== "claude" || !agent.conversationRoots) return []
      const roots = () => claudeRoots(agent)
      const source: UsageSource = {
        provider: agent.providerID,
        service: "claude",
        agent: { kind: "claude", account: parsed.id },
        ...(agent.instance.label ? { label: agent.instance.label } : {}),
        places: () => {
          const here = computer()
          return roots().map((root) => placeOf(here, root))
        },
        slots: async (pricing, since) => {
          const found = new Map<string, Awaited<ReturnType<typeof jsonlFiles>>[number]>()
          for (const root of roots()) for (const file of await jsonlFiles(root)) found.set(file.path, file)
          const ordered = [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          await files.refresh(ordered, since)
          const listed = createHash("sha256").update(ordered.map((file) => file.path).join("\n")).digest("hex")
          const before = last.get(agent.providerID)
          if (before && before.version === files.version && before.pricing === pricing && before.since === since && before.listed === listed) return before.slots
          const slots = claudeSlots(dedupClaude(files.itemsOf(ordered, since).map(fromKeptClaude)), pricing, since)
          last.set(agent.providerID, { version: files.version, pricing, since, listed, slots })
          return slots
        },
        files,
      }
      return [source]
    })
}
