// How this bridge's mail reaches your other computers (its group chats', `peer.ts`, and its plan
// limits, `../limits-peers.ts`): through the box's
// link (`kuvo-link.js` on a machine, the app on the Mac), which carries it over the relay, in parts
// when it's big, and resends what mustn't be lost until it's there. The link follows what goes
// (`/api/kuvo/peers/mail`, a line each), says which of what mustn't be lost it has taken
// (`/api/kuvo/peers/sent`), hands over what came (`POST /api/kuvo/peers/mail`), and says who your
// other computers and their bots are (`PUT /api/kuvo/peers`).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { SEAT_MAIL_KINDS, type SeatLine, type SeatMailKind } from "../../shared/seats"
import type { LimitsDirectory, LimitsMail, LimitsPeers } from "../limits-peers"
import { RemoteHome, type Clock, type PeerBot, type PeerDirectory, type PeerTransport, type SeatMail, type SeatServer, realClock } from "./peer"
import type { GroupRunner } from "./runner"

// The kinds of mail, as the link names them too: `SeatMail`'s, no more and no fewer.
type Agree<Same extends true> = Same
export type SeatKindsAgree = Agree<[SeatMail["kind"]] extends [SeatMailKind] ? ([SeatMailKind] extends [SeatMail["kind"]] ? true : false) : false>
const kinds = new Set<string>(SEAT_MAIL_KINDS)
export const isSeatMail = (value: any): value is SeatMail => value !== null && typeof value === "object" && kinds.has(value.kind)

/** Two of what a bot remembers of a chat, for the same bot and chat. */
const sameMemory = (one: SeatMail, other: SeatMail) => one.kind === "memory" && other.kind === "memory" && one.memory.bot === other.memory.bot && one.memory.chat === other.memory.chat

type Line = SeatLine<SeatMail | LimitsMail>

/** How often what goes says it's still there while nothing goes: an empty line, so the link, which
 * follows it, can tell a bridge that's alive from one that's stuck (it follows anew after a minute
 * without a word, `watchSeats`). */
export const MAIL_HEARTBEAT = 20_000

/** What goes, as the link takes it. What mustn't be lost is kept (in `file`) until the link says it has it. */
export class PeerPost implements PeerTransport {
  private followers = new Set<(line: Line) => void>()
  private kept: Line[]

  constructor(
    private readonly file?: string,
    private readonly clock: Clock = realClock,
  ) {
    let kept: Line[] = []
    try {
      if (file && existsSync(file)) kept = JSON.parse(readFileSync(file, "utf8"))
    } catch {}
    this.kept = Array.isArray(kept) ? kept.filter((line) => line && typeof line.id === "string" && typeof line.to === "string" && isSeatMail(line.mail)) : []
  }

  send(to: string, mail: SeatMail | LimitsMail, durable: boolean) {
    const line: Line = { id: "sm_" + crypto.randomUUID().replaceAll("-", ""), to, mail, durable }
    if (durable) {
      // What a bot remembers of a chat, the newest only: one the link hasn't taken yet goes for it.
      if (mail.kind === "memory") this.kept = this.kept.filter((each) => !(each.to === to && each.mail.kind === "memory" && sameMemory(each.mail, mail)))
      this.kept.push(line)
      this.save()
    }
    for (const follower of this.followers) follower(line)
  }

  /** The link has these of what mustn't be lost: they're its to deliver now. */
  sent(ids: string[]) {
    const before = this.kept.length
    this.kept = this.kept.filter((line) => !ids.includes(line.id))
    if (this.kept.length !== before) this.save()
  }

  private save() {
    if (!this.file) return
    try {
      writeFileSync(this.file + ".new", JSON.stringify(this.kept), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch {}
  }

  /** What goes, a line each, as it goes: first what mustn't be lost that the link hasn't taken yet. */
  follow(signal?: AbortSignal): Response {
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (line: Line) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"))
          } catch {
            stop()
          }
        }
        let beat: unknown
        let following = true
        const beating = () => {
          beat = this.clock.setTimeout(() => {
            if (!following) return
            try {
              controller.enqueue(encoder.encode("\n"))
            } catch {
              return stop()
            }
            beating()
          }, MAIL_HEARTBEAT)
          // (It never keeps the bridge up on its own.)
          ;(beat as { unref?: () => void } | undefined)?.unref?.()
        }
        stop = () => {
          following = false
          this.clock.clearTimeout(beat)
          this.followers.delete(write)
          signal?.removeEventListener("abort", stop)
        }
        signal?.addEventListener("abort", stop, { once: true })
        for (const line of this.kept) write(line)
        this.followers.add(write)
        beating()
      },
      cancel: () => stop(),
    })
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } })
  }

  /** Whether the link follows what goes now. */
  get followed(): boolean {
    return this.followers.size > 0
  }
}

/**
 * What this computer does with mail from another (`from`, one of its peers: the link opens only
 * theirs): its group chats' (none where they don't run here), and its plan limits'.
 */
export interface PeerParts {
  post: PeerPost
  directory: LinkDirectory
  server?: SeatServer
  runner?: GroupRunner
  limits?: LimitsPeers
}

const isLimitsMail = (value: any): value is LimitsMail => value !== null && typeof value === "object" && value.kind === "limits"

export function receive(parts: PeerParts, from: string, mail: SeatMail) {
  if (!parts.server || !parts.runner) return
  // Anything from it says its computer is there again: its bots here are asked again.
  parts.directory.existing(from)?.heardFrom(from)
  if (mail.kind === "state" || mail.kind === "result") parts.directory.existing(from)?.take(from, mail)
  else if (mail.kind === "report") parts.runner.reported(from, mail)
  else if (mail.kind === "held") parts.runner.held(from, mail)
  else parts.server.take(from, mail)
}

/**
 * A letter to `to` that the link gave up (two days online without that computer saying it has it,
 * too big, or turned down), as it went at `at`. Nothing given up is final: what still matters goes
 * again as a new letter while `to` is one of your computers (a part, its report, a seat gone, what a
 * bot remembers as it is now), and what doesn't is let go; a part given to a computer that isn't
 * one of yours any more fails, and still takes its report should it come after all.
 */
export function gaveUp(parts: PeerParts, to: string, mail: SeatMail, at?: number) {
  if (!parts.server || !parts.runner) return
  switch (mail.kind) {
    case "work":
      return parts.runner.workGaveUp(to, mail.work, at)
    case "report":
      return parts.server.gaveUp(to, mail, parts.directory.isPeer(to))
    case "memory":
      return parts.runner.memoryGaveUp(to, mail.memory)
    case "drop":
      if (typeof mail.bot === "string" && typeof mail.chat === "string" && parts.directory.takesSeats(to)) {
        void parts.directory.home(to).drop(mail.seat, mail.agents, { bot: mail.bot, chat: mail.chat })
      }
      return
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/**
 * `/api/kuvo/peers[/mail|/sent|/gaveup]`, for the box's link: what goes (`GET mail`, followed), what it has
 * taken of what mustn't be lost (`POST sent {ids}`), what of that it gave up (`POST gaveup {to,
 * mail, at}`), what came (`POST mail {from, mail}`), and who
 * your other computers and their bots are (`PUT {self, boxes, bots}`).
 */
export async function peerRoutes(parts: PeerParts | undefined, method: string, path: string[], body: () => Promise<any>, signal?: AbortSignal): Promise<Response> {
  if (!parts) return json({ message: "Group chats don't run here." }, 404)
  const [what] = path
  if (what === "mail" && method === "GET") return parts.post.follow(signal)
  if (what === "mail" && method === "POST") {
    const given = await body().catch(() => undefined)
    if (typeof given?.from === "string" && given.from && isLimitsMail(given.mail)) {
      parts.limits?.take(given.from, given.mail)
      return json({})
    }
    // Group chats that didn't start here: the link says not now, so what mustn't be lost comes again.
    if (!parts.server || !parts.runner) return json({ message: "Group chats don't run here." }, 404)
    if (typeof given?.from !== "string" || !given.from || !isSeatMail(given.mail)) return json({ message: "That isn't group chat mail." }, 400)
    receive(parts, given.from, given.mail)
    return json({})
  }
  if (what === "gaveup" && method === "POST") {
    if (!parts.server || !parts.runner) return json({ message: "Group chats don't run here." }, 404)
    const given = await body().catch(() => undefined)
    if (typeof given?.to !== "string" || !given.to || !isSeatMail(given.mail)) return json({ message: "That isn't group chat mail." }, 400)
    // Not before the link has said who your computers are: what comes of it depends on that.
    if (!parts.directory.told) return json({ message: "Not yet." }, 503)
    gaveUp(parts, given.to, given.mail, typeof given.at === "number" ? given.at : undefined)
    return json({})
  }
  if (what === "sent" && method === "POST") {
    const given = await body().catch(() => undefined)
    if (!Array.isArray(given?.ids) || !given.ids.every((id: unknown) => typeof id === "string")) return json({ message: "Those aren't mail." }, 400)
    parts.post.sent(given.ids)
    return json({})
  }
  if (!what && method === "PUT") return parts.directory.set(await body().catch(() => undefined)) ? json({}) : json({ message: "That isn't who your computers are." }, 400)
  return json({ message: "Not found" }, 404)
}

/** Your other computers and their bots, as the link last said. */
export class LinkDirectory implements PeerDirectory, LimitsDirectory {
  private boxes = new Map<string, { name: string; seats: boolean }>()
  private listed: PeerBot[] = []
  private homes = new Map<string, RemoteHome>()
  private self?: { key: string; name: string }
  /** Boxes only a peer knows (another Mac's, beside a machine two Macs share): for plan limits alone. */
  private also = new Map<string, string>()
  private listeners: (() => void)[] = []
  /** Whether the link has said who your computers are since this started. */
  told = false

  constructor(
    private readonly transport: PeerTransport,
    private readonly clock: Clock = realClock,
  ) {}

  /** What the link says (`SeatPeers`, src/shared/seats.ts: `{boxes: [{key, name, seats}], bots: [{id, name, job, box, session, look?}]}`), checked as it's taken. False for what isn't that. */
  set(given: any): boolean {
    if (!given || typeof given !== "object" || !Array.isArray(given.boxes) || !Array.isArray(given.bots)) return false
    const boxes = new Map<string, { name: string; seats: boolean }>()
    for (const box of given.boxes) {
      if (box && typeof box.key === "string" && box.key) boxes.set(box.key, { name: typeof box.name === "string" && box.name ? box.name : "another computer", seats: box.seats === true })
    }
    this.boxes = boxes
    const self = given.self
    this.self = self && typeof self === "object" && typeof self.key === "string" ? { key: self.key, name: typeof self.name === "string" ? self.name : "" } : undefined
    this.also = new Map()
    for (const box of Array.isArray(given.also) ? given.also : []) {
      if (box && typeof box.key === "string" && box.key && !boxes.has(box.key)) this.also.set(box.key, typeof box.name === "string" && box.name ? box.name : "another computer")
    }
    this.told = true
    this.listed = given.bots
      .filter((bot: any) => bot && typeof bot.id === "string" && /^bot_[A-Za-z0-9]+$/.test(bot.id) && typeof bot.name === "string" && typeof bot.box === "string" && boxes.has(bot.box))
      .map((bot: any) => ({
        id: bot.id,
        name: bot.name,
        job: typeof bot.job === "string" ? bot.job : "",
        box: bot.box,
        ...(typeof bot.session === "string" ? { session: bot.session } : {}),
        ...(bot.look && typeof bot.look === "object" && !Array.isArray(bot.look) ? { look: bot.look } : {}),
      }))
    for (const listener of this.listeners) listener()
    return true
  }

  /** Your other computers whose plan limits this box shares, by key and name: its peers, and the boxes they know. */
  peerBoxes(): { key: string; name: string }[] {
    return [...[...this.boxes].map(([key, box]) => ({ key, name: box.name })), ...[...this.also].map(([key, name]) => ({ key, name }))]
  }

  /** This computer, as the link names it (a link from before it didn't). */
  own(): { key: string; name: string } | undefined {
    return this.self
  }

  /** Told each time the link says who your computers are. */
  listen(listener: () => void) {
    this.listeners.push(listener)
  }

  bots(): PeerBot[] {
    return this.listed
  }

  name(box: string): string {
    return this.boxes.get(box)?.name ?? "another computer"
  }

  takesSeats(box: string): boolean {
    return this.boxes.get(box)?.seats === true
  }

  /** Whether it's one of your computers now. */
  isPeer(box: string): boolean {
    return this.boxes.has(box)
  }

  home(box: string): RemoteHome {
    let home = this.homes.get(box)
    if (!home) this.homes.set(box, (home = new RemoteHome(box, this.transport, () => this.name(box), this.clock)))
    return home
  }

  /** Its seats' homes there are, to hand what comes from each. */
  existing(box: string): RemoteHome | undefined {
    return this.homes.get(box)
  }
}
