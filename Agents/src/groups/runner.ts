// The group chats that live on this computer, run here: the lead first, then whoever's named or
// next in line, one bot at a time, until they've nothing to add; the lead's wrap-up and who does
// what; each part in its bot's own conversation, its report back in the chat; meetings at their
// times; and each bot remembering its chats. Each bot takes its turns on the computer it lives on
// (`seat.ts`). They go on with no client connected; the Mac's window and the phone follow them
// through the bridge's API and its event feed.

import { emit } from "../events"
import { newID } from "../ids"
import { SeatAPI, type Requester } from "./api"
import {
  compose,
  isPass,
  label,
  limit,
  nextSpeaker,
  ownWords,
  ring,
  said,
  splitText,
  chatText,
  seatStartText,
  guestText,
  guests,
  ampersands,
  stamp,
  tasks as splitTasks,
  trim,
  trimmed,
  turnText,
  type Activity,
  type Group,
  type GroupMessage,
  type GroupTask,
  type Meeting,
} from "./rules"
import type { PeerDirectory } from "./peer"
import { Cancelled, Seats, type ChatContext, type SeatHome, type SeatResult, type SeatState } from "./seat"
import type { GroupStore, Kept, MachineBot, Status } from "./store"
import { keepsTimeOfDay, keepsWeekday, minutesOf, next as nextTime, parseRepeat } from "./time"

export { seatKey } from "./seat"
/** The key of the chats here a bot's own conversation remembers, on a machine; the Mac's own chats use the key its app always used (`kuvo.groups`). */
export const memoryKey = "kuvo.groups.machine"

export interface RunnerContext {
  store: GroupStore
  /** The computer's engine. */
  engine: Requester
  /** This bridge, once it listens: where seats on the coding agents' models run. */
  bridge: () => Requester | undefined
  /** Kuvo Code's trash folder on the computer. */
  trash: string
  /** How often it looks in on a run, as a share of the usual (tests look in more often). */
  pace?: number
  /** The engine's live events for a session, while it's listened to: a seat's thinking reaches its messages only as each step ends. */
  listen?: (session: string, listener: { event(event: any): void; reconnected(): void }) => () => void
  /** The computer, as what a bot can't do here names it ("this machine"); none on the Mac. */
  place?: string
  /** The key a bot's own conversation remembers these chats under (`memoryKey` unless given). */
  memoryKey?: string
  /** A coding agent's account, by its provider: its name, and whether it needs a sign-in it hasn't got. */
  agentAccount?: (provider: string) => Promise<{ name: string; signedOut: boolean } | undefined>
  /** Your other computers and their bots, which take their turns in chats here on their own computer. */
  peers?: PeerDirectory
}

/** A bot in a chat: one of this computer's, or another's (`box`). */
interface Member {
  id: string
  name: string
  job: string
  box?: string
}

/** What the Mac and phone see of a chat's talk. */
export interface TalkState {
  speaking?: string
  discussing: boolean
  paused: boolean
  /** What the bot talking is doing (see `activity`). */
  activity?: Activity[]
}

interface Live {
  run?: number
  abort?: AbortController
  speaking?: string
  splitting?: string
  /** What the bot talking is doing, as its seat shows it. */
  activity?: Activity[]
  paused: boolean
  /** Goes up with each message of yours, so a discussion under way starts its count again. */
  asked: number
  /** The meeting being talked over, by its message: how it went is told when it ends. */
  meeting?: string
  /** Stops the lead's list of who does what: a message of yours is newer than the go-ahead it reads. */
  splitStop?: () => void
}

type Outcome = "said" | "passed" | "absent"

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done, fail) => {
    if (signal?.aborted) return fail(new Cancelled())
    const stop = () => {
      clearTimeout(timer)
      fail(new Cancelled())
    }
    // Its listener goes with it, or a long turn's looks would pile them up on the run's signal.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      done()
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })

const groupMessageID = () => "gm_" + crypto.randomUUID().toLowerCase()
const turnID = () => "trn_" + crypto.randomUUID().toLowerCase()
const reason = (error: any) => String(error?.message ?? error ?? "it failed").trim()

/** One signal that goes when any of `signals` does. */
function either(...signals: AbortSignal[]): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const stop = () => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
  }
  return { signal: controller.signal, done: () => signals.forEach((signal) => signal.removeEventListener("abort", stop)) }
}

export class GroupRunner {
  private chats: Map<string, Kept>
  private live = new Map<string, Live>()
  private runs = 0
  /** Parts being handed to their bots or followed, so none is followed twice. */
  private following = new Set<string>()
  /** This computer's bots' seats. */
  readonly seats: Seats

  /** What's asked first or denied changed: each seat is told again at its next turn. */
  rulesChanged() {
    this.seats.rulesChanged()
  }
  private syncs = new Map<string, ReturnType<typeof setTimeout>>()
  private meetings?: ReturnType<typeof setTimeout>

  /** Your other computers and their bots, which chats here can have. */
  get peers(): PeerDirectory | undefined {
    return this.context.peers
  }

  private get memoryKey(): string {
    return this.context.memoryKey ?? memoryKey
  }

  constructor(private readonly context: RunnerContext) {
    this.seats = new Seats(context)
    this.chats = context.store.load()
    for (const [id, kept] of this.chats) {
      // Talking when it last stopped (the engine started over): it waits for Keep Going.
      if (kept.talking) {
        kept.talking = false
        this.state(id).paused = true
        context.store.saveGroup(kept)
      }
      try {
        this.keepAwake(id)
      } catch (error) {
        console.error(`${id}:`, reason(error))
      }
    }
  }

  /** Parts under way when it last stopped are followed again, and meetings are held. */
  start() {
    this.resumeWork()
    this.scheduleMeetings(10_000)
    void this.dropLeftScratch()
  }

  /**
   * A chat's conversations for one question (a guest's turn, a work list) still there half an
   * hour on, on the engine or this bridge: what was asking stopped before deleting them (the
   * bridge stopped or updated itself). They go.
   */
  private async dropLeftScratch() {
    const old = Date.now() - 30 * 60_000
    const bridge = this.context.bridge()
    for (const api of [new SeatAPI(this.context.engine), ...(bridge ? [new SeatAPI(bridge)] : [])]) {
      const sessions = await api.sessions().catch(() => [])
      for (const session of sessions) {
        if (session?.metadata?.kuvo?.seat?.scratch !== true || (session?.time?.updated ?? Date.now()) >= old) continue
        await api.delete(session.id).catch(() => {})
      }
    }
  }

  // MARK: What's here

  private state(id: string): Live {
    let live = this.live.get(id)
    if (!live) this.live.set(id, (live = { paused: false, asked: 0 }))
    return live
  }

  talk(id: string): TalkState {
    const live = this.state(id)
    return { speaking: live.speaking ?? live.splitting, discussing: live.abort !== undefined, paused: live.paused, ...(live.speaking && live.activity ? { activity: live.activity } : {}) }
  }

  /** Each chat, with its last message, the last said (not a note) and the last from a bot, as a list shows them. */
  list() {
    return [...this.chats.values()].map((kept) => {
      const said = kept.messages.filter((message) => message.kind !== "note")
      return {
        group: kept.group,
        status: kept.status,
        state: this.talk(kept.group.id),
        last: kept.messages.at(-1),
        said: said.at(-1),
        fromBot: said.filter((message) => message.author !== undefined).at(-1),
      }
    })
  }

  get(id: string) {
    const kept = this.chats.get(id)
    return kept && { group: kept.group, status: kept.status, state: this.talk(id), messages: kept.messages }
  }

  private chat(id: string): Kept | undefined {
    const kept = this.chats.get(id)
    return kept?.status === "active" ? kept : undefined
  }

  private bot(id: string | undefined): MachineBot | undefined {
    return id ? this.context.store.bot(id) : undefined
  }

  /** A bot of a chat here, wherever it lives: this computer's own, else one a peer says is its. */
  private member(id: string | undefined): Member | undefined {
    if (!id) return undefined
    const here = this.bot(id)
    if (here) return { id: here.id, name: here.name, job: here.job }
    const there = this.context.peers?.bots().find((bot) => bot.id === id)
    return there && { id: there.id, name: there.name, job: there.job, box: there.box }
  }

  /** Every bot there is to name: this computer's, and its peers'. */
  private everyone(): Member[] {
    const here = this.context.store.allBots().map((bot): Member => ({ id: bot.id, name: bot.name, job: bot.job }))
    const ids = new Set(here.map((bot) => bot.id))
    return [...here, ...(this.context.peers?.bots() ?? []).filter((bot) => !ids.has(bot.id))]
  }

  /** Where a bot takes its turns: here, or on its own computer. */
  private home(box: string | undefined): SeatHome {
    return box && this.context.peers ? this.context.peers.home(box) : this.seats
  }

  name(author?: string): string {
    return author === undefined ? "User" : (this.member(author)?.name ?? "A bot that left")
  }

  private changed(id: string) {
    const kept = this.chats.get(id)
    if (!kept) return
    this.context.store.saveGroup(kept)
    this.keepAwake(id)
    emit("kuvo.group.updated", { id, group: kept.group, status: kept.status, state: this.talk(id) })
  }

  private told(id: string) {
    const kept = this.chats.get(id)
    if (kept) emit("kuvo.group.updated", { id, group: kept.group, status: kept.status, state: this.talk(id) })
  }

  /** Whether the chat keeps the engine up: a meeting coming, or talk or work under way. */
  private keepAwake(id: string) {
    const kept = this.chats.get(id)
    if (!kept) return
    const working = kept.messages.some((message) => message.tasks?.some((task) => task.state === "working" || task.state === "waiting"))
    this.context.store.setAwake(id, kept.status === "active" && (kept.group.meeting !== undefined || this.state(id).abort !== undefined || working))
  }

  // MARK: Making, changing, deleting

  /**
   * A chat brought here (a move from another computer), with its messages: held until it's
   * started (`activate`), so nothing happens here before the Mac has let go of its copy. One here
   * already is replaced only when `replace` says so.
   */
  put(group: Group, messages: GroupMessage[], status: Status, replace: boolean): boolean {
    const existing = this.chats.get(group.id)
    if (existing && !replace) return false
    if (existing) this.stop(group.id)
    const kept: Kept = { group, status, messages }
    this.chats.set(group.id, kept)
    this.context.store.saveMessages(kept)
    this.changed(group.id)
    if (status === "active") this.began(group.id)
    return true
  }

  activate(id: string): boolean {
    const kept = this.chats.get(id)
    if (!kept) return false
    if (kept.status !== "active") {
      kept.status = "active"
      this.changed(id)
      this.began(id)
    }
    return true
  }

  /** Started here: its parts under way are followed, its bots remember it, its meetings are held. */
  private began(id: string) {
    this.resumeWork(id)
    this.rememberSoon(id)
    this.scheduleMeetings(0)
  }

  /** Held, for a move away: its talk stops and nothing more happens here. Its record and messages, as they are now. */
  hold(id: string) {
    const kept = this.chats.get(id)
    if (!kept) return undefined
    this.stop(id)
    kept.status = "held"
    this.changed(id)
    return { group: kept.group, messages: kept.messages }
  }

  /** Gone from here, its seats left where they are (a move away: the bots stay here). */
  release(id: string): boolean {
    const kept = this.chats.get(id)
    if (!kept) return false
    this.stop(id)
    this.chats.delete(id)
    this.live.delete(id)
    this.context.store.trash(id, this.context.trash)
    emit("kuvo.group.deleted", { id })
    // Its bots no longer remember it from here (the computer it went to does, in the same file,
    // which stays).
    for (const bot of kept.group.members) void this.remember(bot)
    return true
  }

  /** Deleted: its seats go, its bots forget it, its folder goes to the trash. */
  async delete(id: string): Promise<boolean> {
    const kept = this.chats.get(id)
    if (!kept) return false
    this.stop(id)
    this.chats.delete(id)
    this.live.delete(id)
    this.context.store.trash(id, this.context.trash)
    emit("kuvo.group.deleted", { id })
    for (const [bot, seat] of Object.entries(kept.group.seats)) await this.deleteSeat(seat, kept.group, bot)
    for (const bot of kept.group.members) await this.remember(bot, { forgetting: id })
    return true
  }

  /** A new name, purpose, members, lead or meeting; and when you last looked. Bots that left lose their seat and forget the chat. */
  async update(id: string, edits: { name?: string; purpose?: string | null; members?: string[]; meeting?: Meeting | null; viewed?: string }): Promise<boolean> {
    const kept = this.chats.get(id)
    if (!kept) return false
    const old = structuredClone(kept.group)
    const group = kept.group
    if (typeof edits.name === "string" && edits.name.trim()) group.name = edits.name
    if (edits.purpose !== undefined) group.purpose = edits.purpose ?? undefined
    if (edits.meeting !== undefined) group.meeting = edits.meeting ?? undefined
    if (typeof edits.viewed === "string") group.viewed = edits.viewed
    const leaving: { bot: string; seat: string }[] = []
    if (Array.isArray(edits.members) && edits.members.every((member) => typeof member === "string")) {
      group.members = [...edits.members]
      for (const bot of old.members) {
        if (group.members.includes(bot)) continue
        const seat = group.seats[bot]
        if (seat) leaving.push({ bot, seat })
        delete group.seats[bot]
        delete group.heard[bot]
        if (group.retracted) delete group.retracted[bot]
      }
    }
    // The same as it was (a look already noted): nothing to tell.
    if (JSON.stringify(group) === JSON.stringify(old)) return true
    this.changed(id)
    if (edits.meeting !== undefined) this.scheduleMeetings(0)
    for (const { bot, seat } of leaving) await this.deleteSeat(seat, old, bot)
    if (Array.isArray(edits.members) || edits.name !== undefined || edits.purpose !== undefined) {
      // Everyone's seat learns who's there now, at its next turn; those that left forget the chat.
      for (const bot of new Set([...old.members, ...group.members])) {
        if (group.members.includes(bot)) await this.remember(bot)
        else await this.remember(bot, { changed: id, forgetting: id })
      }
    }
    return true
  }

  // MARK: Talking

  /** Your message to the chat. It starts a discussion, or joins the one under way. `named`: the block naming the agents it names with &. */
  send(id: string, text: string, named?: string): GroupMessage | undefined {
    text = trim(text)
    const kept = this.chat(id)
    if (!text || !kept) return undefined
    const message: GroupMessage = { id: groupMessageID(), text, time: stamp(), kind: "message", ...(named ? { named } : {}) }
    this.append(message, id)
    const live = this.state(id)
    live.asked++
    live.splitStop?.()
    live.paused = false
    if (live.speaking) void this.steer(live.speaking, id, message)
    if (!live.abort) this.begin(id)
    this.told(id)
    return message
  }

  /** A meeting come due: its topic to the chat, and the bots talk it through. */
  private meet(id: string, topic: string) {
    if (!this.chat(id)) return
    const message = this.append({ id: groupMessageID(), text: topic, time: stamp(), kind: "meeting" }, id)
    const live = this.state(id)
    live.asked++
    live.splitStop?.()
    live.paused = false
    live.meeting = message.id
    if (live.speaking) void this.steer(live.speaking, id, message)
    if (!live.abort) this.begin(id)
    this.told(id)
  }

  /** A meeting's talk ended: how it went, for the Mac and phone to tell you. */
  private meetingEnded(id: string) {
    const live = this.state(id)
    const start = live.meeting
    live.meeting = undefined
    const kept = this.chats.get(id)
    if (!start || !kept) return
    const index = kept.messages.findIndex((message) => message.id === start)
    const since = index >= 0 ? kept.messages.slice(index + 1) : []
    const last = [...since].reverse().find((message) => message.author !== undefined && message.kind !== "note")
    emit("kuvo.group.met", { id, name: kept.group.name, ...(last ? { last, who: this.name(last.author) } : {}) })
  }

  /** Takes the chat back to before one of your messages; the bots that heard any of it set it aside at their next turn. Its words, for the composer. */
  undo(id: string, messageID: string): string | undefined {
    const kept = this.chat(id)
    if (!kept) return undefined
    const cut = kept.messages.findIndex((message) => message.id === messageID)
    if (cut < 0) return undefined
    this.stop(id)
    const taken = kept.messages.slice(cut)
    const text = kept.messages[cut].text
    kept.messages = kept.messages.slice(0, cut)
    this.context.store.saveMessages(kept)
    const retracted = { ...(kept.group.retracted ?? {}) }
    for (const bot of kept.group.members) {
      const heard = kept.group.heard[bot]
      if (!heard || !taken.some((message) => message.id === heard)) continue
      const last = kept.messages.at(-1)?.id
      if (last) kept.group.heard[bot] = last
      else delete kept.group.heard[bot]
      if (retracted[bot] === undefined) retracted[bot] = [...new Intl.Segmenter().segment(text)].slice(0, 120).map((part) => part.segment).join("")
    }
    kept.group.retracted = Object.keys(retracted).length > 0 ? retracted : undefined
    this.changed(id)
    emit("kuvo.group.reset", { id })
    this.rememberSoon(id)
    return text
  }

  /** Stops the discussion; the bot talking stops mid-sentence (a meeting with it). */
  stop(id: string) {
    const live = this.state(id)
    live.meeting = undefined
    // The bot talking (or the lead handing out the work) stops mid-sentence, where its seat is.
    live.abort?.abort()
    live.abort = undefined
    live.run = undefined
    live.paused = false
    live.speaking = undefined
    live.activity = undefined
    live.splitting = undefined
    this.setTalking(id, false)
    this.told(id)
  }

  /** After the limit of turns: more of the same. */
  keepGoing(id: string) {
    const live = this.state(id)
    if (live.abort || !this.chat(id)) return
    live.paused = false
    live.asked++
    this.begin(id)
    this.told(id)
  }

  private setTalking(id: string, talking: boolean) {
    const kept = this.chats.get(id)
    if (!kept || (kept.talking ?? false) === talking) return this.keepAwake(id)
    kept.talking = talking
    this.context.store.saveGroup(kept)
    this.keepAwake(id)
  }

  private begin(id: string) {
    const live = this.state(id)
    const run = ++this.runs
    const abort = new AbortController()
    live.run = run
    live.abort = abort
    this.setTalking(id, true)
    void (async () => {
      // A message of yours that came as it was ending (during the wrap-up) starts another.
      let epoch: number
      do {
        epoch = await this.discuss(id, abort.signal)
      } while (!abort.signal.aborted && this.state(id).asked !== epoch)
      if (this.state(id).run !== run) return
      live.run = undefined
      live.abort = undefined
      live.speaking = undefined
      live.activity = undefined
      this.setTalking(id, false)
      this.meetingEnded(id)
      this.told(id)
    })().catch((error) => console.error("group chat:", error))
  }

  /** Talks it through, until there's nothing left to add or it reaches its limit; then the wrap-up. The count of your messages it went by. */
  private async discuss(id: string, signal: AbortSignal): Promise<number> {
    const live = this.state(id)
    let epoch = live.asked
    let turns = 0
    let quiet = new Set<string>()
    let absent = new Set<string>()
    let saidCount = 0
    // Guests that answered (or tried), each by the message that named it and its id.
    const guested = new Set<string>()
    // Where the discussion began: from that message on, each one's guests are asked, even one that
    // came while a bot was talking and isn't the latest any more.
    const begun = Math.max(0, (this.chat(id)?.messages ?? []).findLastIndex((message) => message.kind !== "note"))
    while (!signal.aborted) {
      const kept = this.chat(id)
      if (!kept) return epoch
      if (live.asked !== epoch) {
        epoch = live.asked
        turns = 0
        quiet = new Set()
        absent = new Set()
        saidCount = 0
      }
      const names = new Map<string, string>()
      for (const member of kept.group.members) {
        const bot = this.member(member)
        if (bot) names.set(member, bot.name)
      }
      const members = kept.group.members.filter((member) => names.has(member) && !absent.has(member))
      // A bot outside the chat that a message since the discussion began names with & answers it first, as a guest, once.
      const bots = this.everyone().map((bot) => ({ id: bot.id, name: bot.name }))
      let named: { message: GroupMessage; guest: string } | undefined
      for (let index = begun; index < kept.messages.length && !named; index++) {
        const message = kept.messages[index]
        if (message.kind === "note") continue
        const guest = guests(kept.messages.slice(0, index + 1), kept.group.members, bots).find((bot) => !guested.has(message.id + "/" + bot))
        if (guest) named = { message, guest }
      }
      if (named) {
        const { message, guest } = named
        guested.add(message.id + "/" + guest)
        if (turns >= limit(kept.group.members.length)) {
          live.paused = true
          break
        }
        const outcome = await this.turn(guest, id, signal, false, message)
        if (signal.aborted) return epoch
        turns++
        if (outcome === "said") {
          quiet = new Set()
          saidCount++
        }
        continue
      }
      // Nobody with more to say: it's over, at the limit or not.
      const speaker = nextSpeaker(kept.group, kept.messages, members, quiet, names)
      if (!speaker) break
      if (turns >= limit(kept.group.members.length)) {
        live.paused = true
        break
      }
      const outcome = await this.turn(speaker, id, signal)
      if (signal.aborted) return epoch
      turns++
      if (outcome === "said") {
        quiet = new Set()
        saidCount++
      } else if (outcome === "passed") {
        quiet.add(speaker)
      } else {
        absent.add(speaker)
      }
    }
    // The lead sums up a discussion that went back and forth, or a meeting where more than one spoke, unless you've written since
    // or the lead couldn't take part (its note is in the chat already).
    const kept = this.chat(id)
    const lead = kept?.group.members[0]
    if (signal.aborted || saidCount === 0 || live.asked !== epoch || !kept || !lead || !this.member(lead) || absent.has(lead)) return epoch
    if (saidCount >= (live.meeting !== undefined ? 2 : 3) && kept.group.members.length >= 2) {
      const before = kept.messages.at(-1)?.id
      await this.turn(lead, id, signal, true)
      const wrapUp = this.chat(id)?.messages.at(-1)
      if (wrapUp && wrapUp.id !== before && wrapUp.kind === "wrapUp" && !signal.aborted && live.asked === epoch) await this.splitWork(wrapUp.id, id, lead, signal)
    } else {
      const last = kept.messages.at(-1)
      // A short exchange, with no wrap-up: the work, if there is any, under its last word.
      if (last && last.author !== undefined && last.kind === "message" && last.report === undefined) await this.splitWork(last.id, id, lead, signal)
    }
    return epoch
  }

  /**
   * One bot's turn: what it hasn't heard yet goes to its seat (the whole chat, to a seat new to
   * it), on the computer it lives on, and its answer to the chat. A `guest` (a bot outside the
   * chat that a message there named) answers in a conversation of its own for the turn, given the
   * whole chat, which goes once it has.
   */
  private async turn(botID: string, id: string, signal: AbortSignal, wrapUp = false, namedIn?: GroupMessage): Promise<Outcome> {
    const guest = namedIn !== undefined
    const bot = this.member(botID)
    if (!bot) return "absent"
    const live = this.state(id)
    live.speaking = botID
    // Its run: once stopped, what it leaves behind is no longer its to clear (the next run's
    // turn may be the same bot's).
    const run = live.run
    this.told(id)
    // Taken out of the chat as it spoke: it leaves quietly (a guest was never in it).
    const left = () => !guest && !this.chat(id)?.group.members.includes(botID)
    // Its turn alone, stopped when the discussion is, or when it's taken out as its seat is made.
    const own = new AbortController()
    const stopped = either(signal, own.signal)
    try {
      const kept = this.chat(id)
      if (!kept) return "absent"
      // What it's told is what's there now: a message that comes while it's sent wasn't in it.
      const all = [...kept.messages]
      const heard = kept.group.heard[botID]
      const start = heard ? all.findIndex((message) => message.id === heard) + 1 : 0
      const unheard = all.slice(start).filter((message) => message.author !== botID && message.kind !== "note")
      const retracted = guest ? undefined : kept.group.retracted?.[botID]
      const name = (author?: string) => this.name(author)
      // Its computer can't take a turn from here: said, rather than asked and never answered.
      const peers = this.context.peers
      if (bot.box && peers && !peers.takesSeats(bot.box)) {
        this.note(`${bot.name} is on ${peers.name(bot.box)}, which needs an update to take part.`, id)
        return "absent"
      }
      // Its seat, unless the bot lives on another computer than its seat now (it moved): that one
      // goes, and its next seat hears the whole chat.
      let seat = guest ? undefined : kept.group.seats[botID]
      if (seat && (kept.group.seatBoxes?.[botID] ?? undefined) !== bot.box) {
        void this.home(kept.group.seatBoxes?.[botID]).drop(seat, kept.group.agentSeats?.includes(seat) ?? false)
        delete kept.group.seats[botID]
        delete kept.group.heard[botID]
        if (kept.group.seatBoxes) delete kept.group.seatBoxes[botID]
        if (kept.group.agentSeats?.includes(seat)) kept.group.agentSeats = kept.group.agentSeats.filter((each) => each !== seat)
        this.changed(id)
        seat = undefined
      }
      const fresh = guest ? undefined : seatStartText(botID, kept.group, all, wrapUp, name, named(all))
      const text = guest ? guestText(botID, kept.group, all, namedIn?.author, name) : seat ? turnText(botID, kept.group, unheard, wrapUp, name, named(unheard)) : fresh!
      const last = all.at(-1)
      const home = this.home(bot.box)
      const result = await home.turn(
        {
          id: turnID(),
          chat: this.context_(kept.group),
          bot: botID,
          ...(seat ? { seat, agentsSeat: kept.group.agentSeats?.includes(seat) ?? false, fresh } : {}),
          kind: guest ? "guest" : wrapUp ? "wrapUp" : "turn",
          text,
          ...(guest ? {} : { chatSize: new TextEncoder().encode(chatText(botID, kept.group, all, name)).length }),
        },
        (state) => this.heardOf(state, { id, botID, box: bot.box, guest, run, last: last?.id, retracted, own }),
        stopped.signal,
      )
      if (left()) return "absent"
      if (!result.ok) {
        this.note(result.away && bot.box && peers ? `${bot.name} is on ${peers.name(bot.box)}, which can’t be reached now, so it sat this out.` : `${bot.name} couldn’t answer: ${result.why}`, id)
        return "absent"
      }
      // Grown well past the chat it's in: its seat went, and its next turn starts anew.
      if (result.outgrown) {
        const now = this.chat(id)
        const went = now?.group.seats[botID]
        if (now && went) {
          delete now.group.seats[botID]
          delete now.group.heard[botID]
          if (now.group.agentSeats?.includes(went)) now.group.agentSeats = now.group.agentSeats.filter((each) => each !== went)
          this.changed(id)
        }
      }
      if (!result.text) return "passed"
      if (!wrapUp && isPass(result.text)) return "passed"
      this.append(
        {
          id: groupMessageID(),
          author: botID,
          text: ampersands(result.text, this.everyone().map((each) => each.name)),
          time: stamp(),
          kind: wrapUp ? "wrapUp" : "message",
          ...(result.steps.length ? { steps: result.steps.map(trimmed) } : {}),
        },
        id,
      )
      return "said"
    } catch (error) {
      if (signal.aborted || own.signal.aborted || error instanceof Cancelled || left()) return "absent"
      console.error(`${botID}'s turn in ${id} failed:`, reason(error))
      this.note(`${bot.name} couldn’t answer: ${reason(error)}`, id)
      return "absent"
    } finally {
      stopped.done()
      if (live.speaking === botID && live.run === run) {
        live.speaking = undefined
        live.activity = undefined
      }
      this.told(id)
    }
  }

  /** The chat as a bot's seat needs it: who's there, the lead first. */
  private context_(group: Group): ChatContext {
    return {
      id: group.id,
      name: group.name,
      ...(group.purpose ? { purpose: group.purpose } : {}),
      members: group.members.flatMap((member) => {
        const bot = this.member(member)
        return bot ? [{ id: bot.id, name: bot.name, job: bot.job }] : []
      }),
    }
  }

  /** What a bot's turn says of how it goes, kept in the chat: its seat, what it's heard, what it's doing. */
  private heardOf(state: SeatState, turn: { id: string; botID: string; box?: string; guest: boolean; run?: number; last?: string; retracted?: string; own: AbortController }) {
    if (state.phase === "taken") return
    const { id, botID } = turn
    const live = this.state(id)
    if (state.phase === "activity") {
      if (live.run !== turn.run || live.speaking !== botID || JSON.stringify(state.activity) === JSON.stringify(live.activity ?? [])) return
      live.activity = state.activity
      this.told(id)
      return
    }
    if (state.phase === "steered") {
      this.setHeard(state.message, botID, id)
      return
    }
    if (turn.guest) return
    if (state.phase === "seated") {
      // A seat made now: the chat deleted meanwhile, or the bot taken out of it, and it goes with it.
      const now = this.chat(id)
      if (!now || !now.group.members.includes(botID)) {
        void this.home(turn.box).drop(state.seat, state.agents)
        turn.own.abort()
        return
      }
      if (state.replaced) {
        if (now.group.agentSeats?.includes(state.replaced)) now.group.agentSeats = now.group.agentSeats.filter((each) => each !== state.replaced)
        delete now.group.heard[botID]
      }
      now.group.seats[botID] = state.seat
      if (turn.box) now.group.seatBoxes = { ...(now.group.seatBoxes ?? {}), [botID]: turn.box }
      else if (now.group.seatBoxes?.[botID]) {
        delete now.group.seatBoxes[botID]
        if (Object.keys(now.group.seatBoxes).length === 0) delete now.group.seatBoxes
      }
      if (state.agents) now.group.agentSeats = [...new Set([...(now.group.agentSeats ?? []), state.seat])]
      this.changed(id)
      return
    }
    if (turn.last) this.setHeard(turn.last, botID, id)
    // What it was told to set aside, it has been (unless it was taken back again meanwhile).
    const group = this.chat(id)?.group
    if (group && turn.retracted !== undefined && group.retracted?.[botID] === turn.retracted) {
      delete group.retracted[botID]
      if (Object.keys(group.retracted).length === 0) group.retracted = undefined
      this.changed(id)
    }
  }

  /** Your message, to the bot talking now: it hears it at its next step. */
  private async steer(botID: string, id: string, message: GroupMessage) {
    const kept = this.chat(id)
    const seat = kept?.group.seats[botID]
    const bot = this.member(botID)
    if (!kept || !bot || !seat) return
    const text = "The user, just now: " + message.text + (message.named ? "\n\n" + message.named : "")
    if (await this.home(bot.box).steer(seat, kept.group.agentSeats?.includes(seat) ?? false, text, message.id)) this.setHeard(message.id, botID, id)
  }

  // MARK: Splitting the work

  /** After a wrap-up: the lead lists who does what; if you'd already said to go ahead, each bot starts on its part at once. */
  private async splitWork(wrapUpID: string, id: string, lead: string, signal: AbortSignal) {
    const kept = this.chat(id)
    const bot = this.member(lead)
    // A lead whose computer can't take a turn from here (the chat said so already) lists nothing.
    if (!kept || !bot || (bot.box && this.context.peers && !this.context.peers.takesSeats(bot.box))) return
    const members = kept.group.members.flatMap((member) => {
      const found = this.member(member)
      return found ? [{ id: member, name: found.name }] : []
    })
    // Yours since the wrap-up before this one: the discussion it sums up.
    const all = kept.messages
    const found = all.findIndex((message) => message.id === wrapUpID)
    const end = found >= 0 ? found : all.length
    const before = all.slice(0, end)
    let begin = 0
    for (let index = before.length - 1; index >= 0; index--) {
      if (before[index].kind === "wrapUp") {
        begin = index + 1
        break
      }
    }
    const yours = all
      .slice(begin, end)
      .filter((message) => message.author === undefined && message.kind === "message")
      .slice(-6)
      .map((message) => [...new Intl.Segmenter().segment(ownWords(message.text))].slice(0, 800).map((part) => part.segment).join(""))
    const live = this.state(id)
    const epoch = live.asked
    live.splitting = lead
    this.told(id)
    // You writing meanwhile comes first: the list stops, and your message has the next turn.
    const newer = new AbortController()
    const stopSplit = () => newer.abort()
    live.splitStop = stopSplit
    const stopped = either(signal, newer.signal)
    try {
      // Asked apart from the lead's seat, so its list doesn't stay in what the lead carries to
      // every turn after: in a conversation of its own, given the chat up to the wrap-up, which
      // goes once it's answered.
      const chat = chatText(lead, kept.group, all.slice(0, Math.min(end + 1, all.length)), (author) => this.name(author))
      const result = await this.home(bot.box).turn(
        { id: turnID(), chat: this.context_(kept.group), bot: lead, kind: "split", text: chat + "\n" + splitText(members.map((member) => member.name), yours) },
        () => {},
        stopped.signal,
      )
      if (signal.aborted || newer.signal.aborted) return
      if (!result.ok) {
        this.note(`${bot.name} couldn’t hand out the work: ${result.why}`, id)
        return
      }
      const { tasks, go } = splitTasks(result.text, members, () => "gt_" + crypto.randomUUID().toLowerCase())
      if (tasks.length === 0) {
        if (go) this.note(`${bot.name} didn’t say who does what, so no parts were handed out.`, id)
        return
      }
      this.change(wrapUpID, id, (message) => (message.tasks = tasks))
      // You wrote since (another thought, a stop): the parts wait for Start the Work.
      if (go && this.state(id).asked === epoch) this.startWork(wrapUpID, id)
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled) return
      this.note(`${bot.name} couldn’t hand out the work: ${reason(error)}`, id)
    } finally {
      stopped.done()
      if (live.splitStop === stopSplit) live.splitStop = undefined
      if (live.splitting === lead) live.splitting = undefined
      this.told(id)
    }
  }

  /** Hands each part of a wrap-up's work not yet started to its bot, in its own conversation. */
  startWork(wrapUpID: string, id: string) {
    const tasks = this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks
    if (!tasks) return
    const proposed = tasks.filter((task) => task.state === "proposed")
    for (const task of proposed) {
      this.changeTask(task.id, wrapUpID, id, (part) => {
        part.state = (part.after ?? []).length === 0 ? "working" : "waiting"
        part.started = stamp()
      })
    }
    for (const task of proposed) if ((task.after ?? []).length === 0) this.handSoon(task.id, wrapUpID, id)
    this.startReady(wrapUpID, id)
  }

  /** Parts waiting on others: once those are all done they start, with their reports. */
  private startReady(wrapUpID: string, id: string) {
    for (;;) {
      const tasks = this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks
      if (!tasks) return
      let changed = false
      for (const task of tasks) {
        if (task.state !== "waiting") continue
        const first = tasks.filter((other) => other.id !== task.id && (task.after ?? []).includes(other.bot))
        const failed = first.find((other) => other.state === "failed")
        if (failed) {
          this.fail(task.id, wrapUpID, id, `${this.member(failed.bot)?.name ?? "the bot before it"} couldn’t finish its part first`, false)
        } else if (first.every((other) => other.state === "done")) {
          this.changeTask(task.id, wrapUpID, id, (part) => (part.state = "working"))
          this.handSoon(task.id, wrapUpID, id)
        } else {
          const found = ring(task, tasks)
          if (!found) continue
          for (const part of found) {
            this.changeTask(part.id, wrapUpID, id, (each) => {
              each.state = "failed"
              each.finished = stamp()
            })
          }
          const names = new Intl.ListFormat("en", { type: "conjunction" }).format(found.map((part) => this.name(part.bot)))
          this.note(`${names} wait on each other’s parts, so ${found.length === 2 ? "neither" : "none of them"} could start.`, id)
        }
        changed = true
        break
      }
      if (!changed) return
    }
  }

  private handSoon(taskID: string, wrapUpID: string, id: string) {
    if (this.following.has(taskID)) return
    this.following.add(taskID)
    void this.hand(taskID, wrapUpID, id)
      .catch((error) => console.error("group chat part:", error))
      .finally(() => this.following.delete(taskID))
  }

  /** The API where a bot's own conversation runs. */
  private ownAPI(bot: MachineBot): SeatAPI | undefined {
    return this.seats.ownAPI(bot)
  }

  /**
   * One part, to its bot's own conversation, wherever it lives; then it's followed until the bot
   * reports (on another computer, that computer follows it and says how it went: `reported`).
   */
  private async hand(taskID: string, wrapUpID: string, id: string) {
    const kept = this.chat(id)
    const wrapUp = kept?.messages.find((message) => message.id === wrapUpID)
    const task = wrapUp?.tasks?.find((part) => part.id === taskID)
    if (!kept || !wrapUp || !task) return
    const bot = this.member(task.bot)
    if (!bot) return this.fail(taskID, wrapUpID, id, "the bot is gone")
    const before = (wrapUp.tasks ?? [])
      .filter((part) => (task.after ?? []).includes(part.bot))
      .flatMap((part) => {
        const report = [...kept.messages].reverse().find((message) => message.report === part.id)
        return report ? [{ name: this.name(part.bot), report: report.text }] : []
      })
    const from = this.name(wrapUp.author) + (wrapUp.kind === "wrapUp" ? "'s wrap-up" : "'s last message")
    const text = compose(task, kept.group, wrapUp, from, before)
    const peers = this.context.peers
    if (bot.box && peers) {
      if (!peers.takesSeats(bot.box)) return this.fail(taskID, wrapUpID, id, `${peers.name(bot.box)} needs an update to take part`)
      peers.home(bot.box).work({ task: taskID, wrapUp: wrapUpID, chat: id, bot: bot.id, text, started: task.started ?? stamp() })
      this.changeTask(taskID, wrapUpID, id, (part) => (part.prompt = `peer:${bot.box}`))
      return
    }
    const own = this.bot(task.bot)
    if (!own) return this.fail(taskID, wrapUpID, id, "the bot is gone")
    try {
      const promptID = await this.seats.give(own, text)
      this.changeTask(taskID, wrapUpID, id, (part) => (part.prompt = promptID))
      await this.awaitReport(taskID, wrapUpID, id)
    } catch (error) {
      this.fail(taskID, wrapUpID, id, reason(error))
    }
  }

  private taskState(taskID: string, wrapUpID: string, id: string): GroupTask | undefined {
    return this.chat(id)?.messages.find((message) => message.id === wrapUpID)?.tasks?.find((task) => task.id === taskID)
  }

  /** Until the bot's run on its part ends (however long, waiting on you meanwhile if it asks something); then its report, back in the chat. */
  private async awaitReport(taskID: string, wrapUpID: string, id: string) {
    const task = this.taskState(taskID, wrapUpID, id)
    if (!task || task.state !== "working") return
    if (!task.prompt || !this.bot(task.bot)) return this.fail(taskID, wrapUpID, id, "the bot is gone")
    const result = await this.seats.follow(task.bot, task.prompt, task.started, () => this.taskState(taskID, wrapUpID, id)?.state === "working")
    if (result) this.finish(taskID, wrapUpID, id, task.bot, result)
  }

  /** A part's report (or why it couldn't be done), back in the chat; reported meanwhile (or stopped), not again. */
  private finish(taskID: string, wrapUpID: string, id: string, botID: string, result: SeatResult) {
    if (this.taskState(taskID, wrapUpID, id)?.state !== "working") return
    if (!result.ok) return this.fail(taskID, wrapUpID, id, result.why)
    this.changeTask(taskID, wrapUpID, id, (part) => {
      part.state = "done"
      part.finished = stamp()
    })
    this.append({ id: groupMessageID(), author: botID, text: result.text, time: stamp(), kind: "message", report: taskID }, id)
    this.startReady(wrapUpID, id)
    const kept = this.chats.get(id)
    if (kept) emit("kuvo.group.done", { id, name: kept.group.name, bot: botID, who: this.name(botID), text: result.text })
  }

  /** What another computer says of a part its bot did (`from`: only the computer that bot lives on now). */
  reported(from: string, report: { task: string; wrapUp: string; chat: string; result: SeatResult }) {
    const task = this.taskState(report.task, report.wrapUp, report.chat)
    if (!task || this.member(task.bot)?.box !== from) return
    this.finish(report.task, report.wrapUp, report.chat, task.bot, report.result)
  }

  /** `thenOthers`: parts that waited on it fail too. */
  private fail(taskID: string, wrapUpID: string, id: string, why: string, thenOthers = true) {
    this.changeTask(taskID, wrapUpID, id, (part) => {
      part.state = "failed"
      part.finished = stamp()
    })
    const who = this.member(this.taskState(taskID, wrapUpID, id)?.bot)?.name ?? "A bot"
    const reasonText = trim(why).replace(/^\.+|\.+$/g, "")
    this.note(`${who} couldn’t do its part: ${reasonText}.`, id)
    if (thenOthers) this.startReady(wrapUpID, id)
  }

  /** Parts under way when it last stopped: followed again, until their bots report. */
  private resumeWork(only?: string) {
    for (const [id, kept] of this.chats) {
      if (kept.status !== "active" || (only && id !== only)) continue
      for (const message of kept.messages) {
        for (const task of message.tasks ?? []) {
          if (task.state !== "working" || this.following.has(task.id) || task.prompt?.startsWith("peer:")) continue
          if (!task.prompt) {
            this.fail(task.id, message.id, id, "Kuvo Code stopped before it reached the bot")
          } else {
            this.following.add(task.id)
            void this.awaitReport(task.id, message.id, id)
              .catch((error) => console.error("group chat part:", error))
              .finally(() => this.following.delete(task.id))
          }
        }
        if (message.tasks?.some((task) => task.state === "waiting")) this.startReady(message.id, id)
      }
    }
  }

  // MARK: Meetings

  private scheduleMeetings(delay: number) {
    if (this.meetings) clearTimeout(this.meetings)
    this.meetings = setTimeout(() => {
      this.meetings = undefined
      try {
        this.meetDue()
      } catch (error) {
        console.error("group meetings:", error)
      }
      const soonest = Math.min(...[...this.chats.values()].flatMap((kept) => (kept.status === "active" && kept.group.meeting ? [Date.parse(kept.group.meeting.next)] : [])))
      this.scheduleMeetings(Math.min(20_000, Math.max(500, Number.isFinite(soonest) ? soonest - Date.now() : 20_000)))
    }, delay)
    ;(this.meetings as any).unref?.()
  }

  /** Holds the meetings that have come due: once each, then the next time of one that repeats, or none for a one-off. */
  meetDue(now = Date.now()) {
    const zone = usableZone(this.context.store.settings()?.timeZone)
    for (const [id, kept] of this.chats) {
      const meeting = kept.group.meeting
      if (kept.status !== "active" || !meeting) continue
      const due = Date.parse(meeting.next)
      if (!(due <= now)) continue
      try {
        // Its next time first, so one that can't be worked out doesn't come again and again.
        const missed = due < now - 300_000
        const every = typeof meeting.every === "string" ? parseRepeat(meeting.every) : undefined
        if (every) {
          const updated: Meeting = { ...meeting }
          if (keepsTimeOfDay(every) && typeof updated.at !== "number") updated.at = minutesOf(due, zone)
          if (keepsWeekday(every) && typeof updated.weekday !== "number") updated.weekday = weekdayOf(due, zone)
          const at = keepsTimeOfDay(every) ? updated.at : undefined
          const weekday = keepsWeekday(every) ? updated.weekday : undefined
          let next = nextTime(every, due, now, zone, at, weekday)
          // A missed one held now isn't followed by the next a few hours later: that one's skipped.
          if (missed && keepsTimeOfDay(every) && next - now < 3 * 3_600_000) next = nextTime(every, next, next, zone, at, weekday)
          updated.next = stamp(new Date(next))
          kept.group.meeting = updated
        } else {
          kept.group.meeting = undefined
        }
      } catch (error) {
        console.error(`${id}'s meeting:`, reason(error))
        kept.group.meeting = undefined
      }
      this.changed(id)
      this.meet(id, meeting.topic)
    }
  }

  // MARK: Seats

  /** A bot's seat in a chat gone, on the computer it's on (never lost on the way there). */
  private async deleteSeat(seat: string, group: Group, botID: string) {
    await this.home(group.seatBoxes?.[botID]).drop(seat, group.agentSeats?.includes(seat) ?? false)
    const kept = this.chats.get(group.id)
    if (!kept) return
    let changed = false
    if (kept.group.agentSeats?.includes(seat)) {
      kept.group.agentSeats = kept.group.agentSeats.filter((each) => each !== seat)
      changed = true
    }
    if (kept.group.seatBoxes?.[botID] && kept.group.seats[botID] !== seat) {
      delete kept.group.seatBoxes[botID]
      changed = true
    }
    if (changed) this.changed(group.id)
  }

  // MARK: Remembering

  /**
   * A bot's own conversation remembers its chats, as you'd remember a meeting: a recap of each in
   * its instructions, and the whole of each in a file in its folder. One instruction, whichever
   * computers its chats live on: those here, and those on your other computers, which tell this
   * one (`remembered`). A bot that lives on another computer is told there.
   */
  private async remember(botID: string, options: { changed?: string; forgetting?: string } = {}) {
    const member = this.member(botID)
    if (member?.box && this.context.peers) return this.rememberThere(botID, member.box, options)
    const bot = this.bot(botID)
    if (!bot) return
    const api = this.ownAPI(bot)
    if (!api) return
    const folder = bot.folder + "/groups"
    if (options.forgetting) this.context.store.removeFile(`${folder}/${options.forgetting}.md`)
    const chats = [...this.chats.values()]
      .filter((kept) => kept.status === "active" && kept.group.members.includes(botID) && kept.messages.length > 0)
      .map((kept) => {
        const file = `${folder}/${kept.group.id}.md`
        if (!options.changed || options.changed === kept.group.id) {
          try {
            this.context.store.writeFile(file, this.transcript(kept))
          } catch {}
        }
        const others = kept.group.members.filter((member) => member !== botID).flatMap((member) => this.member(member)?.name ?? [])
        return { name: kept.group.name, others, file, recap: () => this.recap(kept), time: Date.parse(kept.messages.at(-1)?.time ?? kept.group.created) }
      })
    const elsewhere = Object.values(this.context.store.peerMemory(botID)).map((entry) => ({ name: entry.name, others: entry.with, file: entry.file, recap: () => entry.recap, time: Date.parse(entry.time) }))
    const all = [...chats, ...elsewhere].sort((a, b) => b.time - a.time)
    if (all.length === 0) {
      await api.removeInstruction(bot.sessionID, this.memoryKey).catch(() => {})
      return
    }
    let text =
      `You also take part in group chats in Kuvo Code, with the user and other bots. You remember them as you would a meeting: ` +
      `a recap of each is below, newest first, and the whole of each is in a file in "${folder}". When the user mentions one of ` +
      `these chats, or something talked about there, go by this, and read the file when you need more. What's marked ` +
      `"${bot.name}" is what you said.`
    for (const chat of all.slice(0, 4)) {
      text += `\n\n## "${chat.name}"${chat.others.length ? " with " + chat.others.join(", ") : ""}, in ${chat.file}\n`
      text += chat.recap()
    }
    await api.setInstruction(bot.sessionID, this.memoryKey, text).catch(() => {})
  }

  /** A chat here, as a bot on another computer remembers it: told to that computer (never lost on the way). */
  private rememberThere(botID: string, box: string, options: { changed?: string; forgetting?: string }) {
    const home = this.context.peers!.home(box)
    if (options.forgetting) home.remember({ chat: options.forgetting, bot: botID, forget: true })
    for (const kept of this.chats.values()) {
      if (kept.status !== "active" || !kept.group.members.includes(botID) || kept.messages.length === 0) continue
      if (options.changed && options.changed !== kept.group.id) continue
      home.remember({
        chat: kept.group.id,
        bot: botID,
        name: kept.group.name,
        with: kept.group.members.filter((member) => member !== botID).flatMap((member) => this.member(member)?.name ?? []),
        recap: this.recap(kept),
        transcript: this.transcript(kept),
        time: kept.messages.at(-1)?.time ?? kept.group.created,
      })
    }
  }

  /** What a chat on another computer (`from`) said its bot here remembers of it: kept, and the bot told. */
  async remembered(from: string, memory: { chat: string; bot: string; forget?: boolean; name?: string; with?: string[]; recap?: string; transcript?: string; time?: string }) {
    const bot = this.bot(memory.bot)
    if (!bot || !/^grp_[a-z0-9]+$/.test(memory.chat)) return
    const file = `${bot.folder}/groups/${peerPrefix(from)}-${memory.chat}.md`
    if (memory.forget) {
      this.context.store.removeFile(file)
      this.context.store.forgetPeerMemory(bot.id, `${from}/${memory.chat}`)
    } else {
      try {
        this.context.store.writeFile(file, memory.transcript ?? "")
      } catch {}
      this.context.store.keepPeerMemory(bot.id, `${from}/${memory.chat}`, { name: memory.name ?? "", with: memory.with ?? [], recap: memory.recap ?? "", file, time: memory.time ?? stamp() })
    }
    await this.remember(bot.id)
  }

  private when(time: string): string {
    const settings = this.context.store.settings()
    try {
      return new Intl.DateTimeFormat(settings?.locale ?? "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: settings?.timeZone }).format(new Date(time))
    } catch {
      return time
    }
  }

  /** The last few discussions: each one's start (what you asked), and its wrap-up or its last few messages, cut short. */
  private recap(kept: Kept): string {
    const discussions: GroupMessage[][] = []
    for (const message of kept.messages) {
      if (message.kind === "note") continue
      const current = discussions.at(-1)
      if (!current || (message.author === undefined && current.at(-1)?.author !== undefined)) discussions.push([message])
      else current.push(message)
    }
    return discussions
      .slice(-3)
      .flatMap((discussion) => {
        let asked = 0
        while (asked < discussion.length && discussion[asked].author === undefined) asked++
        const rest = discussion.slice(asked)
        const wrapUp = [...rest].reverse().find((message) => message.kind === "wrapUp")
        const shown = wrapUp ? [wrapUp] : rest.slice(-4)
        return [...discussion.slice(0, asked), ...shown].map((message) => {
          const segments = [...new Intl.Segmenter().segment(message.text)]
          const words = segments.length > 500 ? segments.slice(0, 500).map((part) => part.segment).join("") + "…" : message.text
          return `${label(message, (author) => this.name(author))} · ${this.when(message.time)}: ${words}`
        })
      })
      .join("\n")
  }

  /** The whole chat, as Markdown. */
  private transcript(kept: Kept): string {
    const names = kept.group.members.flatMap((member) => this.member(member)?.name ?? [])
    let text = `# ${kept.group.name}\n\nA group chat in Kuvo Code between the user and ${names.join(", ")}.\n`
    for (const message of kept.messages) {
      if (message.kind === "note") text += `\n_${message.text}_\n`
      else text += `\n**${label(message, (author) => this.name(author))}** · ${this.when(message.time)}\n\n${message.text}\n`
    }
    return text
  }

  /** After a chat moves on, its bots remember it, once it's been quiet for a moment. */
  private rememberSoon(id: string) {
    const pending = this.syncs.get(id)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.syncs.delete(id)
      const kept = this.chat(id)
      if (!kept) return
      void (async () => {
        for (const bot of kept.group.members) await this.remember(bot, { changed: id })
      })().catch(() => {})
    }, 3000)
    ;(timer as any).unref?.()
    this.syncs.set(id, timer)
  }

  // MARK: Messages

  private append(message: GroupMessage, id: string): GroupMessage {
    const kept = this.chat(id)
    if (!kept) return message
    kept.messages.push(message)
    this.context.store.saveMessages(kept)
    this.keepAwake(id)
    emit("kuvo.group.message", { id, message })
    this.rememberSoon(id)
    return message
  }

  private note(text: string, id: string) {
    this.append({ id: groupMessageID(), text, time: stamp(), kind: "note" }, id)
  }

  private change(messageID: string, id: string, edit: (message: GroupMessage) => void) {
    const kept = this.chat(id)
    const message = kept?.messages.find((each) => each.id === messageID)
    if (!kept || !message) return
    edit(message)
    this.context.store.saveMessages(kept)
    this.keepAwake(id)
    emit("kuvo.group.message", { id, message })
  }

  private changeTask(taskID: string, messageID: string, id: string, edit: (task: GroupTask) => void) {
    this.change(messageID, id, (message) => {
      const task = message.tasks?.find((each) => each.id === taskID)
      if (task) edit(task)
    })
  }

  private setHeard(messageID: string, botID: string, id: string) {
    const kept = this.chat(id)
    if (!kept) return
    // Only ever forward: a later message may have reached it already.
    const all = kept.messages
    const heard = kept.group.heard[botID]
    const current = heard ? all.findIndex((message) => message.id === heard) : -1
    const next = all.findIndex((message) => message.id === messageID)
    if (next < 0 || next <= current) return
    kept.group.heard[botID] = messageID
    this.context.store.saveGroup(kept)
  }
}

/** A computer's key, short, as the files of its chats in a bot's folder start. */
export const peerPrefix = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8)

/** The blocks naming the agents your messages named with &, as one. */
function named(unheard: GroupMessage[]): string | undefined {
  const blocks = unheard
    .slice(-40)
    .filter((message) => message.author === undefined)
    .map((message) => message.named)
    .filter((block): block is string => typeof block === "string" && block.length > 0)
  if (blocks.length <= 1) return blocks[0]
  const lines = blocks[0].split("\n")
  const items = [...new Set(blocks.flatMap((block) => block.split("\n").filter((line) => line.startsWith("- "))))]
  const head = lines.filter((line) => !line.startsWith("- "))
  return [...head.slice(0, -1), ...items, head.at(-1)!].join("\n")
}

/** The user's time zone, if it's one this machine knows; its own otherwise. */
function usableZone(zone: string | undefined): string {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!zone) return own
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone })
    return zone
  } catch {
    return own
  }
}

const weekdayOf = (time: number, zone: string) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(new Date(time))
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name) + 1
}

