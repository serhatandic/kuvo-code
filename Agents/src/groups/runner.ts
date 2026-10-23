// The group chats that live on this machine, run here as the Mac's `BotGroups` runs its own: the
// lead first, then whoever's named or next in line, one bot at a time, until they've nothing to add;
// the lead's wrap-up and who does what; each part in its bot's own conversation, its report back
// in the chat; meetings at their times; and each bot remembering its chats. They go on while the
// Mac is off. The Mac (and the phone) follow them through the bridge's API and its event feed.

import { parseProvider } from "../accounts"
import { autoProvider } from "../auto"
import { emit } from "../events"
import { newID } from "../ids"
import type { ModelRef } from "../wire"
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
  seatInstructions,
  seatRules,
  splitText,
  chatText,
  seatStartText,
  guestText,
  guests,
  outgrew,
  seatBudget,
  ampersands,
  stamp,
  tasks as splitTasks,
  activity as activityOf,
  thought,
  trim,
  trimmed,
  turnText,
  type Activity,
  type Group,
  type GroupMessage,
  type GroupTask,
  type Meeting,
  plainError,
} from "./rules"
import type { GroupStore, Kept, MachineBot, Status } from "./store"
import { keepsTimeOfDay, keepsWeekday, minutesOf, next as nextTime, parseRepeat } from "./time"

/** The key of a seat's instructions, and of the chats here a bot's own conversation remembers. */
export const seatKey = "kuvo.seat"
export const memoryKey = "kuvo.groups.machine"

export interface RunnerContext {
  store: GroupStore
  /** The machine's engine. */
  engine: Requester
  /** This bridge, once it listens: where seats on the coding agents' models run. */
  bridge: () => Requester | undefined
  /** Kuvo Code's trash folder on the machine. */
  trash: string
  /** How often it looks in on a run, as a share of the usual (tests look in more often). */
  pace?: number
  /** The engine's live events for a session, while it's listened to: a seat's thinking reaches its messages only as each step ends. */
  listen?: (session: string, listener: { event(event: any): void; reconnected(): void }) => () => void
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
}

type Outcome = "said" | "passed" | "absent"

class Cancelled extends Error {}

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
const reason = (error: any) => String(error?.message ?? error ?? "it failed").trim()
const runsWithAgents = (model?: ModelRef) => Boolean(model && (model.providerID === autoProvider || parseProvider(model.providerID)))

export class GroupRunner {
  private chats: Map<string, Kept>
  private live = new Map<string, Live>()
  /** Each seat's context at its first turn since the bridge started: its growth past that makes it start over (`outgrew`). */
  private seatBase = new Map<string, number>()
  private runs = 0
  /** Parts being handed to their bots or followed, so none is followed twice. */
  private following = new Set<string>()
  /** Requests from seats already turned down. */
  private declined = new Set<string>()
  /** Seats whose rules were brought up to date since this runner started, and what each was last told. */
  private seatsChecked = new Set<string>()

  /** What's asked first or denied changed: each seat is told again at its next turn. */
  rulesChanged() {
    this.seatsChecked.clear()
  }
  private seatTexts = new Map<string, string>()
  private syncs = new Map<string, ReturnType<typeof setTimeout>>()
  private meetings?: ReturnType<typeof setTimeout>

  constructor(private readonly context: RunnerContext) {
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

  name(author?: string): string {
    return author === undefined ? "User" : (this.bot(author)?.name ?? "A bot that left")
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
    live.abort?.abort()
    live.abort = undefined
    live.run = undefined
    live.paused = false
    for (const speaker of [live.speaking, live.splitting]) {
      const kept = this.chats.get(id)
      const seat = speaker ? kept?.group.seats[speaker] : undefined
      const bot = this.bot(speaker)
      if (seat && bot && kept) void this.seatAPI(bot, kept.group, seat).then((api) => api?.interrupt(seat).catch(() => {}))
    }
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
        const bot = this.bot(member)
        if (bot) names.set(member, bot.name)
      }
      const members = kept.group.members.filter((member) => names.has(member) && !absent.has(member))
      // A bot outside the chat that a message since the discussion began names with & answers it first, as a guest, once.
      const bots = this.context.store.allBots().map((bot) => ({ id: bot.id, name: bot.name }))
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
    // The lead sums up a discussion that went back and forth, or a meeting where more than one spoke, unless you've written since.
    const kept = this.chat(id)
    const lead = kept?.group.members[0]
    if (signal.aborted || saidCount === 0 || live.asked !== epoch || !kept || !lead || !this.bot(lead)) return epoch
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
   * it), and its answer to the chat. A `guest` (a bot outside the chat that a message there named)
   * answers in a conversation of its own for the turn, given the whole chat, which goes once it has.
   */
  private async turn(botID: string, id: string, signal: AbortSignal, wrapUp = false, namedIn?: GroupMessage): Promise<Outcome> {
    const guest = namedIn !== undefined
    const bot = this.bot(botID)
    if (!bot) return "absent"
    const live = this.state(id)
    live.speaking = botID
    // Its run: once stopped, what it leaves behind is no longer its to clear (the next run's
    // turn may be the same bot's).
    const run = live.run
    this.told(id)
    // Its discussion stopped meanwhile (Stop, Undo, a move): it stops where it is.
    const going = () => {
      if (signal.aborted) throw new Cancelled()
    }
    // Taken out of the chat as it spoke: it leaves quietly (a guest was never in it).
    const left = () => !guest && !this.chat(id)?.group.members.includes(botID)
    // A guest's conversation for the turn, deleted once it's over.
    let scratch: { seat: string; api: SeatAPI } | undefined
    // Its model's provider, named in what it says when that turns it down.
    let provider: string | undefined
    try {
      const kept = this.chat(id)
      if (!kept) return "absent"
      const first = await this.seatAPI(bot, kept.group, kept.group.seats[botID])
      going()
      if (!first) {
        this.note(`${bot.name} couldn’t answer: the coding agents aren’t running.`, id)
        return "absent"
      }
      // Its model can't run here (its account signed out of): said, rather than sent to an
      // engine that drops it without a word.
      const model = await this.model(bot)
      if (model && !runsWithAgents(model)) {
        const account = await new SeatAPI(this.context.engine).account(model).catch(() => undefined)
        going()
        provider = account?.name
        if (account?.signedOut) {
          this.note(`${bot.name} couldn’t answer: ${model.id} needs a sign-in on this machine: sign in to ${account.name} in Settings › Accounts, or choose another model.`, id)
          return "absent"
        }
      }
      let seat: string
      let isNew: boolean
      if (guest) {
        seat = await this.scratch(bot, kept.group, first, `${bot.name} asked into ${kept.group.name}`)
        scratch = { seat, api: first }
        isNew = true
      } else {
        ;({ seat, isNew } = await this.seat(bot, id, first))
      }
      going()
      const current = this.chat(id)
      if (!current) return "absent"
      // Where the seat is now (a new one, on another model, can run elsewhere).
      const api = guest ? first : await this.seatAPI(bot, current.group, seat)
      going()
      if (!api) {
        this.note(`${bot.name} couldn’t answer: the coding agents aren’t running.`, id)
        return "absent"
      }
      // What it's told is what's there now: a message that comes while it's sent wasn't in it.
      const all = [...current.messages]
      const heard = current.group.heard[botID]
      const start = heard ? all.findIndex((message) => message.id === heard) + 1 : 0
      const unheard = all.slice(start).filter((message) => message.author !== botID && message.kind !== "note")
      const promptID = newID("msg")
      const retracted = guest ? undefined : current.group.retracted?.[botID]
      const name = (author?: string) => this.name(author)
      const prompt = guest
        ? guestText(botID, current.group, all, namedIn?.author, name)
        : isNew
          ? seatStartText(botID, current.group, all, wrapUp, name, named(all))
          : turnText(botID, current.group, unheard, wrapUp, name, named(unheard))
      await api.prompt(seat, promptID, prompt, "queue")
      going()
      const last = all.at(-1)
      if (last && !guest) this.setHeard(last.id, botID, id)
      // What it was told to set aside, it has been (unless it was taken back again meanwhile).
      const now = this.chat(id)?.group
      if (now && retracted !== undefined && now.retracted?.[botID] === retracted) {
        delete now.retracted[botID]
        if (Object.keys(now.retracted).length === 0) now.retracted = undefined
        this.changed(id)
      }
      const sent = Date.now()
      // Its latest thought, from the engine's stream, in a line under its name, a few times a
      // second at most; a look at its messages, which can be a step behind, doesn't take it back
      // for a moment.
      let thinking = ""
      let streamedAt = 0
      const show = (now: Activity[]) => {
        if (live.run !== run || live.speaking !== botID || JSON.stringify(now) === JSON.stringify(live.activity ?? [])) return
        const sameKind = live.activity?.[0]?.kind === now[0]?.kind
        if (sameKind && Date.now() - streamedAt < 300) return
        live.activity = now
        streamedAt = Date.now()
        this.told(id)
      }
      const unlisten = this.context.listen?.(seat, {
        event: (event) => {
          const data = event?.data ?? {}
          if (event?.type === "session.reasoning.started") thinking = ""
          else if (event?.type === "session.reasoning.delta") {
            thinking = (thinking + String(data.delta ?? "")).slice(-2000)
            const line = thought(thinking)
            if (line) show([{ kind: "thinking", text: line }])
          } else if (event?.type === "session.text.started" || event?.type === "session.text.delta") show([{ kind: "writing" }])
        },
        reconnected() {},
      })
      try {
        await this.waitForRun(seat, promptID, sent, api, signal, (messages) => {
          const now = activityOf(messages, promptID, sent)
          if (live.run !== run || live.speaking !== botID || now.length === 0 || JSON.stringify(now) === JSON.stringify(live.activity ?? [])) return
          if (Date.now() - streamedAt < 3000) return
          live.activity = now
          this.told(id)
        })
      } finally {
        unlisten?.()
      }
      if (left()) return "absent"
      const reply = await this.reply(seat, promptID, sent, api)
      going()
      // Grown well past the chat it's in (pages it read, drafts, long answers): it starts over at
      // its next turn, in a new seat given the whole chat, and this one goes. Grown from its first
      // turn here, so what every turn carries (its instructions and tools) doesn't count.
      if (!guest && reply.size !== undefined) {
        const base = this.seatBase.get(seat) ?? reply.size
        this.seatBase.set(seat, base)
        const grown = reply.size - base
        if (grown > seatBudget && outgrew(grown, chatText(botID, current.group, this.chat(id)?.messages ?? all, name))) {
          this.seatBase.delete(seat)
          await this.startOver(botID, id)
        }
      }
      if (!reply.text) {
        if (reply.error) {
          this.note(`${bot.name} couldn’t answer: ${plainError(reply.error, provider)}`, id)
          return "absent"
        }
        return "passed"
      }
      if (!wrapUp && isPass(reply.text)) return "passed"
      this.append(
        {
          id: groupMessageID(),
          author: botID,
          text: ampersands(reply.text, this.context.store.allBots().map((each) => each.name)),
          time: stamp(),
          kind: wrapUp ? "wrapUp" : "message",
          ...(reply.steps.length ? { steps: reply.steps.map(trimmed) } : {}),
        },
        id,
      )
      return "said"
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled || left()) return "absent"
      console.error(`${botID}'s turn in ${id} failed:`, reason(error))
      this.note(`${bot.name} couldn’t answer: ${plainError(reason(error), provider)}`, id)
      return "absent"
    } finally {
      if (scratch) void scratch.api.delete(scratch.seat).catch(() => {})
      if (live.speaking === botID && live.run === run) {
        live.speaking = undefined
        live.activity = undefined
      }
      this.told(id)
    }
  }

  /** Your message, to the bot talking now: it hears it at its next step. */
  private async steer(botID: string, id: string, message: GroupMessage) {
    const kept = this.chat(id)
    const bot = this.bot(botID)
    const seat = kept?.group.seats[botID]
    if (!kept || !bot || !seat) return
    const api = await this.seatAPI(bot, kept.group, seat)
    // Only into a run: one that hasn't started yet gets it with the rest at its turn.
    if (!api || !(await api.active().catch(() => new Set<string>())).has(seat)) return
    const text = "The user, just now: " + message.text + (message.named ? "\n\n" + message.named : "")
    try {
      await api.prompt(seat, newID("msg"), text, "steer")
      this.setHeard(message.id, botID, id)
    } catch {}
  }

  /** Until the seat's run ends. Questions and requests for permission are turned down on the way, since nobody's there to answer them. */
  /** Until the seat's run ends; `seen` hears its latest messages now and then, for what it's doing. */
  private async waitForRun(seat: string, promptID: string, sent: number, api: SeatAPI, signal: AbortSignal, seen?: (messages: any[]) => void, stops?: () => boolean) {
    const pace = this.context.pace ?? 1
    let looked = Date.now()
    let gone = 0
    // Reads of its inbox that found no seat (deleted, as the bot left the chat), in a row.
    let missing = 0
    let idleSince: number | undefined
    let woken = false
    for (;;) {
      await sleep(600 * pace, signal)
      // Not worth waiting for any more (you wrote, while the work list was asked): stopped.
      if (stops?.()) {
        await api.interrupt(seat).catch(() => {})
        throw new Cancelled()
      }
      await this.decline(seat, api)
      if (seen && Date.now() - looked > 1500 * pace) {
        looked = Date.now()
        const page = await api.messages(seat, 12).catch(() => undefined)
        if (page) seen(page.data)
      }
      const active = await api.active().catch(() => undefined)
      if (active && !active.has(seat)) {
        // No seat (404) is told from a moment's trouble, which is asked again.
        const inbox = await api.inbox(seat).catch((error) => (error?.status === 404 ? null : undefined))
        if (inbox === null) {
          // Its seat is gone (the bot left the chat as it spoke): nothing more comes.
          if (++missing >= 3) return
          continue
        }
        missing = 0
        if (inbox && !inbox.some((item) => item.id === promptID)) {
          const read = await api.messages(seat, 60).catch(() => undefined)
          const at = read ? read.data.findIndex((message) => message?.id === promptID) : -1
          // Its run ended (its end marker after the message); or the message is nowhere, a few reads running.
          if (at >= 0 ? read!.data.slice(at + 1).some((message) => message?.type === "idle") : read ? ++gone >= 3 : false) return
          if (at >= 0) gone = 0
          idleSince = undefined
        } else if (inbox) {
          // Still waiting on a seat that isn't at work (held there after a stop): woken, then let go.
          idleSince ??= Date.now()
          if (Date.now() - idleSince > 8_000 * pace) {
            if (!woken) {
              woken = true
              idleSince = Date.now()
              await api.setDelivery(seat, promptID, "steer").catch(() => {})
            } else {
              await api.cancelInbox(seat, promptID).catch(() => {})
              return
            }
          }
        }
      } else {
        idleSince = undefined
      }
      if (Date.now() - sent > 600_000) {
        await api.interrupt(seat).catch(() => {})
        throw new Error("It took too long, so it was stopped.")
      }
    }
  }

  private async decline(seat: string, api: SeatAPI) {
    for (const request of await api.permissions(seat).catch(() => [])) {
      if (this.declined.has(request.id)) continue
      this.declined.add(request.id)
      await api.reject(seat, request.id, "Nobody can approve this in a group chat. Carry on without it, or say who should do it.").catch(() => {})
    }
    for (const form of await api.forms(seat).catch(() => [])) {
      if (this.declined.has(form.id)) continue
      this.declined.add(form.id)
      await api.dismiss(seat, form.id, "Ask the group in your reply instead.").catch(() => {})
    }
  }

  /** What the seat said since `promptID`, for the chat, and how much it sent the model at its last step (its whole context, in tokens). */
  private async reply(seat: string, promptID: string, sent: number, api: SeatAPI) {
    const { data } = await api.messages(seat, 60)
    const start = data.findIndex((message) => message?.id === promptID)
    const since = sent - 2000
    const tokens = [...data].reverse().find((message) => message?.type === "assistant" && message.tokens)?.tokens
    const size = tokens ? (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) : undefined
    return { ...said(start >= 0 ? data.slice(start + 1) : data.filter((message) => (message?.time?.created ?? 0) >= since)), size: size as number | undefined }
  }

  // MARK: Splitting the work

  /** After a wrap-up: the lead lists who does what; if you'd already said to go ahead, each bot starts on its part at once. */
  private async splitWork(wrapUpID: string, id: string, lead: string, signal: AbortSignal) {
    const kept = this.chat(id)
    const bot = this.bot(lead)
    if (!kept || !bot) return
    const api = await this.seatAPI(bot, kept.group, kept.group.seats[lead])
    if (!api) return
    const members = kept.group.members.flatMap((member) => {
      const found = this.bot(member)
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
    const promptID = newID("msg")
    const live = this.state(id)
    const epoch = live.asked
    live.splitting = lead
    this.told(id)
    const sent = Date.now()
    // Asked apart from the lead's seat, so its list doesn't stay in what the lead carries to every
    // turn after: in a conversation of its own, given the chat up to the wrap-up, which goes once
    // it's answered.
    let seat: string | undefined
    try {
      seat = await this.scratch(bot, kept.group, api, `${bot.name} handing out the work in ${kept.group.name}`)
      const chat = chatText(lead, kept.group, all.slice(0, Math.min(end + 1, all.length)), (author) => this.name(author))
      await api.prompt(seat, promptID, chat + "\n" + splitText(members.map((member) => member.name), yours), "queue")
      // You writing meanwhile comes first: the list stops, and your message has the next turn.
      await this.waitForRun(seat, promptID, sent, api, signal, undefined, () => this.state(id).asked !== epoch)
      const reply = await this.reply(seat, promptID, sent, api)
      const { tasks, go } = splitTasks(reply.text, members, () => "gt_" + crypto.randomUUID().toLowerCase())
      if (signal.aborted) return
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
      if (seat) void api.delete(seat).catch(() => {})
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
          this.fail(task.id, wrapUpID, id, `${this.bot(failed.bot)?.name ?? "the bot before it"} couldn’t finish its part first`, false)
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
    if (!bot.agents) return new SeatAPI(this.context.engine)
    const bridge = this.context.bridge()
    return bridge ? new SeatAPI(bridge) : undefined
  }

  /** One part, to its bot's conversation; then it's followed until the bot reports. */
  private async hand(taskID: string, wrapUpID: string, id: string) {
    const kept = this.chat(id)
    const wrapUp = kept?.messages.find((message) => message.id === wrapUpID)
    const task = wrapUp?.tasks?.find((part) => part.id === taskID)
    if (!kept || !wrapUp || !task) return
    const bot = this.bot(task.bot)
    if (!bot) return this.fail(taskID, wrapUpID, id, "the bot is gone")
    const api = this.ownAPI(bot)
    if (!api) return this.fail(taskID, wrapUpID, id, "the coding agents aren’t running")
    const before = (wrapUp.tasks ?? [])
      .filter((part) => (task.after ?? []).includes(part.bot))
      .flatMap((part) => {
        const report = [...kept.messages].reverse().find((message) => message.report === part.id)
        return report ? [{ name: this.name(part.bot), report: report.text }] : []
      })
    const promptID = newID("msg")
    try {
      const from = this.name(wrapUp.author) + (wrapUp.kind === "wrapUp" ? "'s wrap-up" : "'s last message")
      await api.prompt(bot.sessionID, promptID, compose(task, kept.group, wrapUp, from, before), "queue")
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
    let misses = 0
    let stoppedChecks = 0
    for (;;) {
      await sleep(3000 * (this.context.pace ?? 1))
      const task = this.taskState(taskID, wrapUpID, id)
      if (!task || task.state !== "working") return
      const bot = this.bot(task.bot)
      if (!bot || !task.prompt) return this.fail(taskID, wrapUpID, id, "the bot is gone")
      const api = this.ownAPI(bot)
      if (!api) continue
      const active = await api.active().catch(() => undefined)
      if (!active || active.has(bot.sessionID)) continue
      // The queue first, then the conversation: a message delivered between the two reads is in the second.
      const queued = await api.inbox(bot.sessionID).catch(() => undefined)
      if (!queued) continue
      const read = await this.messagesFrom(task.prompt, bot.sessionID, task.started, api)
      if (read.kind !== "found") {
        // Its message taken back before it was read: the part ends, rather than working forever; twice in a row, both read.
        if (read.kind === "missing" && !queued.some((item) => item.id === task.prompt)) {
          if (++misses >= 2) return this.fail(taskID, wrapUpID, id, `its message was taken back before ${bot.name} read it`)
        } else {
          misses = 0
        }
        continue
      }
      misses = 0
      const run = read.messages.slice(1)
      // Its run, up to its end: not a stop it carried on from, only one you followed with a message of yours, or the end at last.
      let end = run.findIndex((message, index) => {
        if (message?.type !== "idle") return false
        if (message.outcome !== "interrupted") return true
        return run[index + 1]?.type === "user"
      })
      const lastIndex = run.length - 1
      if (end < 0 && lastIndex >= 0 && run[lastIndex]?.type === "idle" && run[lastIndex].outcome === "interrupted") {
        if (++stoppedChecks >= 2) end = lastIndex
      } else {
        stoppedChecks = 0
      }
      const answered = end >= 0 || run.some((message) => message?.type === "assistant" && message.time?.completed !== undefined)
      if (!answered) continue
      const stillActive = await api.active().catch(() => undefined)
      if (!stillActive || stillActive.has(bot.sessionID)) continue
      const found = said(end >= 0 ? run.slice(0, end) : run)
      let error = found.error
      if (error === undefined && end >= 0 && run[end]?.outcome === "failed") error = run[end].error?.message
      // Reported meanwhile (or stopped), from elsewhere: not again.
      if (this.taskState(taskID, wrapUpID, id)?.state !== "working") return
      if (!found.text) return this.fail(taskID, wrapUpID, id, error ?? "it stopped without saying what it did")
      this.changeTask(taskID, wrapUpID, id, (part) => {
        part.state = "done"
        part.finished = stamp()
      })
      this.append({ id: groupMessageID(), author: bot.id, text: found.text, time: stamp(), kind: "message", report: taskID }, id)
      this.startReady(wrapUpID, id)
      const kept = this.chats.get(id)
      if (kept) emit("kuvo.group.done", { id, name: kept.group.name, bot: bot.id, who: bot.name, text: found.text })
      return
    }
  }

  /** The bot's conversation from `promptID` on, read further back while it's longer than a page, but not past the part's start. */
  private async messagesFrom(promptID: string, session: string, started: string | undefined, api: SeatAPI): Promise<{ kind: "found"; messages: any[] } | { kind: "missing" } | { kind: "unreadable" }> {
    let page: { data: any[]; cursor?: string }
    try {
      page = await api.messages(session, 80)
    } catch {
      return { kind: "unreadable" }
    }
    let messages = page.data
    const start = ((started ? Date.parse(started) : 0) / 1000 - 5) * 1000
    while (!messages.some((message) => message?.id === promptID) && messages.length > 0 && (messages[0]?.time?.created ?? 0) > start && messages.length < 2000 && page.cursor) {
      let older: { data: any[]; cursor?: string }
      try {
        older = await api.messages(session, 200, page.cursor)
      } catch {
        break
      }
      if (older.data.length === 0 || messages.some((message) => message?.id === older.data.at(-1)?.id)) break
      messages = [...older.data, ...messages]
      page = older
    }
    const index = messages.findIndex((message) => message?.id === promptID)
    return index >= 0 ? { kind: "found", messages: messages.slice(index) } : { kind: "missing" }
  }

  /** `thenOthers`: parts that waited on it fail too. */
  private fail(taskID: string, wrapUpID: string, id: string, why: string, thenOthers = true) {
    this.changeTask(taskID, wrapUpID, id, (part) => {
      part.state = "failed"
      part.finished = stamp()
    })
    const who = this.bot(this.taskState(taskID, wrapUpID, id)?.bot)?.name ?? "A bot"
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
          if (task.state !== "working" || this.following.has(task.id)) continue
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

  /** Where a bot's seat runs: this bridge for one on a coding agent's model (or Auto), else the engine. */
  private async seatAPI(bot: MachineBot, group: Group, seat?: string): Promise<SeatAPI | undefined> {
    let onAgents: boolean
    if (seat) onAgents = group.agentSeats?.includes(seat) ?? false
    else onAgents = runsWithAgents(await this.model(bot))
    if (!onAgents) return new SeatAPI(this.context.engine)
    const bridge = this.context.bridge()
    return bridge ? new SeatAPI(bridge) : undefined
  }

  /**
   * The model a bot talks on: the one picked for it (Edit Bot's) while it can run here; otherwise
   * (its account signed out of here, which takes its models away, so Edit Bot shows none) what its
   * own conversation is on now.
   */
  private async model(bot: MachineBot): Promise<ModelRef | undefined> {
    const conversation = async () => (await this.ownAPI(bot)?.session(bot.sessionID).catch(() => undefined))?.model as ModelRef | undefined
    if (!bot.model) return conversation()
    if (runsWithAgents(bot.model)) return bot.model
    const account = await new SeatAPI(this.context.engine).account(bot.model).catch(() => undefined)
    return account?.signedOut ? ((await conversation()) ?? bot.model) : bot.model
  }

  /** The bot's seat in the chat, made the first time it's needed, told who's there now, on its bot's model. */
  private async seat(bot: MachineBot, id: string, api: SeatAPI): Promise<{ seat: string; isNew: boolean }> {
    const kept = this.chat(id)
    if (!kept) throw new Cancelled()
    // The chat as it is now: one brought here in its place meanwhile isn't this one.
    const same = () => this.chat(id) === kept
    const settings = this.context.store.settings()
    const rules = seatRules(bot.folder, settings?.askFirst ?? false, settings?.denies ?? [])
    const text = this.seatText(bot, kept.group)
    const existing = kept.group.seats[bot.id]
    if (existing) {
      if (!this.seatsChecked.has(existing)) {
        this.seatsChecked.add(existing)
        await api.setPermissions(existing, rules).catch(() => {})
      }
      if (this.seatTexts.get(existing) !== text) {
        await api.setInstruction(existing, seatKey, text).catch(() => {})
        this.seatTexts.set(existing, text)
      }
      if (await this.keepModel(existing, bot, id, api)) return { seat: existing, isNew: false }
    }
    if (!same()) throw new Cancelled()
    const current = kept
    const model = await this.model(bot)
    const onAgents = runsWithAgents(model)
    const seatAPI = onAgents ? (this.context.bridge() ? new SeatAPI(this.context.bridge()!) : undefined) : new SeatAPI(this.context.engine)
    if (!seatAPI) throw new Error("the coding agents aren’t running")
    const agent = onAgents && model?.providerID.split("@")[0] === "cursor" ? "plan" : undefined
    const session = await seatAPI.create(bot.directory, `${bot.name} in ${current.group.name}`, agent, model, rules)
    await seatAPI.setMetadata(session.id, { kuvo: { seat: { group: id, bot: bot.id } } }).catch(() => {})
    await seatAPI.setInstruction(session.id, seatKey, text)
    this.seatTexts.set(session.id, text)
    this.seatsChecked.add(session.id)
    // The chat deleted or replaced meanwhile, or the bot taken out of it: the new seat goes with it.
    const after = kept
    if (!same() || !after.group.members.includes(bot.id)) {
      await seatAPI.delete(session.id).catch(() => {})
      throw new Cancelled()
    }
    after.group.seats[bot.id] = session.id
    if (onAgents) after.group.agentSeats = [...new Set([...(after.group.agentSeats ?? []), session.id])]
    this.changed(id)
    return { seat: session.id, isNew: true }
  }

  /** A seat that outgrew the chat: it goes, with what it gathered, and the bot's next turn makes a new one, given the whole chat. */
  private async startOver(botID: string, id: string) {
    const kept = this.chat(id)
    const seat = kept?.group.seats[botID]
    if (!kept || !seat) return
    await this.deleteSeat(seat, kept.group, botID)
    if (kept.group.seats[botID] !== seat) return
    delete kept.group.seats[botID]
    delete kept.group.heard[botID]
    this.changed(id)
  }

  /**
   * A conversation of a bot's own for one question in a chat, beside its seat (a guest's turn, the
   * work list): made as a seat is, marked as one so it stays out of the lists, and deleted once
   * answered, so nothing of it piles up.
   */
  private async scratch(bot: MachineBot, group: Group, api: SeatAPI, title: string): Promise<string> {
    const settings = this.context.store.settings()
    const rules = seatRules(bot.folder, settings?.askFirst ?? false, settings?.denies ?? [])
    const model = await this.model(bot)
    const agent = runsWithAgents(model) && model?.providerID.split("@")[0] === "cursor" ? "plan" : undefined
    const session = await api.create(bot.directory, title, agent, model, rules)
    await api.setMetadata(session.id, { kuvo: { seat: { group: group.id, bot: bot.id, scratch: true } } }).catch(() => {})
    try {
      await api.setInstruction(session.id, seatKey, this.seatText(bot, group))
    } catch (error) {
      await api.delete(session.id).catch(() => {})
      throw error
    }
    return session.id
  }

  /** What a seat is told, from its bot and the others as their folders have them now. */
  private seatText(bot: MachineBot, group: Group): string {
    const settings = this.context.store.settings()
    const others = group.members.filter((member) => member !== bot.id).flatMap((member) => this.bot(member) ?? [])
    const lead = this.bot(group.members[0])
    const personality = bot.personality ? settings?.personalities[bot.personality] : undefined
    return seatInstructions(bot, group, others, lead, personality, settings?.identityNote ?? "")
  }

  /**
   * A seat on its bot's model, as the Mac's `modelChanged` keeps it: switched where it runs, or,
   * when the model runs elsewhere (the engine, the coding agents), gone, for a new one at this turn
   * that hears the whole chat. Whether the seat is still the one.
   */
  private async keepModel(seat: string, bot: MachineBot, id: string, api: SeatAPI): Promise<boolean> {
    const model = await this.model(bot)
    if (!model) return true
    const session = await api.session(seat).catch(() => undefined)
    if (!session) return true
    if (session.model?.id === model.id && session.model?.providerID === model.providerID) return true
    const kept = this.chat(id)
    if (!kept) return true
    const onSeatAgents = kept.group.agentSeats?.includes(seat) ?? false
    if (onSeatAgents || !runsWithAgents(model)) {
      await api.selectModel(seat, model).catch(() => {})
      if (onSeatAgents) await api.selectAgent(seat, model.providerID.split("@")[0] === "cursor" ? "plan" : "build").catch(() => {})
      return true
    }
    await this.deleteSeat(seat, kept.group, bot.id)
    delete kept.group.seats[bot.id]
    delete kept.group.heard[bot.id]
    this.changed(id)
    return false
  }

  private async deleteSeat(seat: string, group: Group, botID: string) {
    const bot = this.bot(botID)
    const api = bot ? await this.seatAPI(bot, group, seat) : new SeatAPI(this.context.engine)
    await api?.delete(seat).catch(() => {})
    const kept = this.chats.get(group.id)
    if (kept?.group.agentSeats?.includes(seat)) {
      kept.group.agentSeats = kept.group.agentSeats.filter((each) => each !== seat)
      this.changed(group.id)
    }
  }

  // MARK: Remembering

  /** A bot's own conversation remembers its chats here, as you'd remember a meeting: a recap of each in its instructions, and the whole of each in a file in its folder. */
  private async remember(botID: string, options: { changed?: string; forgetting?: string } = {}) {
    const bot = this.bot(botID)
    if (!bot) return
    const api = this.ownAPI(bot)
    if (!api) return
    const folder = bot.folder + "/groups"
    if (options.forgetting) this.context.store.removeFile(`${folder}/${options.forgetting}.md`)
    const chats = [...this.chats.values()]
      .filter((kept) => kept.status === "active" && kept.group.members.includes(botID) && kept.messages.length > 0)
      .sort((a, b) => Date.parse(b.messages.at(-1)?.time ?? b.group.created) - Date.parse(a.messages.at(-1)?.time ?? a.group.created))
    if (chats.length === 0) {
      await api.removeInstruction(bot.sessionID, memoryKey).catch(() => {})
      return
    }
    let text =
      `You also take part in group chats in Kuvo Code, with the user and other bots. You remember them as you would a meeting: ` +
      `a recap of each is below, newest first, and the whole of each is in a file in "${folder}". When the user mentions one of ` +
      `these chats, or something talked about there, go by this, and read the file when you need more. What's marked ` +
      `"${bot.name}" is what you said.`
    for (const [index, kept] of chats.entries()) {
      const file = `${folder}/${kept.group.id}.md`
      if (!options.changed || options.changed === kept.group.id) {
        try {
          this.context.store.writeFile(file, this.transcript(kept))
        } catch {}
      }
      if (index >= 4) continue
      const others = kept.group.members.filter((member) => member !== botID).flatMap((member) => this.bot(member)?.name ?? [])
      text += `\n\n## "${kept.group.name}"${others.length ? " with " + others.join(", ") : ""}, in ${file}\n`
      text += this.recap(kept)
    }
    await api.setInstruction(bot.sessionID, memoryKey, text).catch(() => {})
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
    const names = kept.group.members.flatMap((member) => this.bot(member)?.name ?? [])
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

