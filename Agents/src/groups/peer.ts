// Group chats across your computers (PROTOCOL.md, "Peers": `seat`): a chat lives on one computer
// (its host) and runs there, and a bot that lives on another (its home) takes its turn there, in a
// seat of that computer's own (`seat.ts`). Only the words go between them, box to box over the
// relay, with no Mac in the middle: the box's link carries this mail (in parts when it's big, and
// what mustn't be lost until it's there), and hands what comes to this bridge.

import { prefixBytes } from "./runner"
import { Cancelled, turnLimit, type SeatHome, type SeatProgress, type SeatResult, type SeatState, type SeatTurn, type Seats } from "./seat"
import type { GroupStore, PeerTurn, PeerWork } from "./store"

/**
 * A mail between two computers' bridges at most this big, its JSON in UTF-8 bytes: as much as the
 * links put together from parts (a document's most), so one never goes without a word.
 */
export const seatMailBytes = 512 * 1024
export const mailSize = (mail: SeatMail) => new TextEncoder().encode(JSON.stringify(mail)).length
/** A part's report, its words cut to this many bytes: what's past it stays in the bot's own conversation. */
export const reportBytes = 64_000
const cutNote = "\n\n[Cut here: the rest is in its own conversation on its computer.]"

/** Words cut to `most` bytes, said to be cut. */
const cut = (text: string, most: number) => (new TextEncoder().encode(text).length <= most ? text : prefixBytes(text, most - cutNote.length) + cutNote)

/** How a turn ended, to fit in a mail: its steps left out if they don't, then its words cut. */
export function fitResult(id: string, result: SeatAnswer): SeatAnswer {
  if (!result.ok || mailSize({ kind: "result", id, result }) <= seatMailBytes) return result.ok ? result : { ...result, why: cut(result.why, 2000) }
  const words = { ...result, steps: [] }
  if (mailSize({ kind: "result", id, result: words }) <= seatMailBytes) return words
  return { ...words, text: cut(result.text, reportBytes) }
}

/** How a part went, its report cut to `reportBytes`. */
export const fitReport = (result: SeatResult): SeatResult => (result.ok ? { ...result, text: cut(result.text, reportBytes), steps: [] } : { ...result, why: cut(result.why, 2000) })

/** A turn's result as its computer says it: with the seat it ended in, so a chat that missed `seated` still keeps it. */
export type SeatAnswer = SeatResult & { seat?: string; agents?: boolean; replaced?: string }

/** What goes between two computers for their group chats. */
export type SeatMail =
  /** Host → home: a bot's turn. */
  | { kind: "turn"; turn: SeatTurn }
  /** Home → host: how it goes. */
  | { kind: "state"; id: string; state: SeatState }
  /** Home → host: how it ended. */
  | { kind: "result"; id: string; result: SeatAnswer }
  /** Host → home: a message of yours, to the bot talking now. */
  | { kind: "steer"; id: string; text: string; message: string }
  /** Host → home: stopped (Stop, Undo, a move). */
  | { kind: "stop"; id: string }
  /** Host → home: `bot`'s seat in `chat` gone (it left the chat, the chat was deleted). Not to be lost. */
  | { kind: "drop"; seat: string; agents: boolean; bot?: string; chat?: string }
  /** Host → home: a part of the work, for the bot's own conversation, followed there until it reports. Not to be lost. */
  | { kind: "work"; work: WorkGiven }
  /** Home → host: how a part went, its report or why it couldn't be done. Not to be lost. */
  | { kind: "report"; task: string; wrapUp: string; chat: string; result: SeatResult }
  /** Host → home: what a bot remembers of a chat (its recap and latest messages), or that it forgets it. Not to be lost. */
  | { kind: "memory"; memory: MemoryGiven }

/** A part of a chat's work, as its computer gives it to a bot on another. */
export interface WorkGiven {
  task: string
  wrapUp: string
  chat: string
  bot: string
  /** What it's told: the part, what was decided, and how to report back. */
  text: string
  started: string
}

/** A chat, as a bot on another computer remembers it; `forget`, it leaves its memory. */
export interface MemoryGiven {
  chat: string
  bot: string
  /** When the chat's computer said it (milliseconds, later each time): an older one that comes late is refused. */
  at?: number
  forget?: boolean
  name?: string
  with?: string[]
  recap?: string
  transcript?: string
  time?: string
}

/** How this bridge's mail reaches another computer: `durable`, it's resent until it's there; otherwise now, or not at all. */
export interface PeerTransport {
  send(to: string, mail: SeatMail, durable: boolean): void
}

/** A bot that lives on another of your computers, as it says. */
export interface PeerBot {
  id: string
  name: string
  job: string
  /** Its computer, by key. */
  box: string
  /** Its own conversation there. */
  session?: string
  /** How it looks (BotLook: color, shape, face), as its computer says. */
  look?: unknown
}

/** Your other computers, as this one knows them. */
export interface PeerDirectory {
  bots(): PeerBot[]
  /** A computer's name, as its bots' notes say it. */
  name(box: string): string
  /** Whether it takes group chats' seats (its `features` say `groups.seats`). */
  takesSeats(box: string): boolean
  /** Its seats, as a chat here asks them. */
  home(box: string): RemoteHome
}

/** A turn there is asked again after this long without a word from its computer, and taken as away after `awayAfter`. */
export const askAgainAfter = 15_000
export const awayAfter = 45_000
/** Past its computer's own limit on a turn, with no result, it's taken as away. */
export const longestTurn = turnLimit + 60_000

export interface Clock {
  setTimeout(work: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
  /** Milliseconds since 1970 (`Date.now()` when it doesn't say). */
  now?(): number
}
export const realClock: Clock = { setTimeout: (work, ms) => setTimeout(work, ms), clearTimeout: (timer) => clearTimeout(timer as any), now: () => Date.now() }

interface Pending {
  turn: SeatTurn
  report: (state: SeatState) => void
  done: (result: SeatResult) => void
  /** Heard from it since it was last asked: the seat it's in now, whether its words are with it, what it said already. */
  seat?: string
  started: boolean
  told: Set<string>
  /** Asking again, taking it as away after a silence, and after its longest. */
  asking?: unknown
  silent?: unknown
  limit?: unknown
}

/** A bot's seats on another computer, as a chat here asks them. */
export class RemoteHome implements SeatHome {
  private pending = new Map<string, Pending>()

  constructor(
    readonly box: string,
    private readonly transport: PeerTransport,
    private readonly place: () => string,
    private readonly clock: Clock = realClock,
  ) {}

  /**
   * A turn there. Each time it says nothing for a while it's asked again, by the same id (its
   * computer takes a turn once, and says again how one it has goes, or how it ended); after a
   * longer silence, or past its longest, it's taken as away.
   */
  turn(turn: SeatTurn, report: (state: SeatState) => void, signal: AbortSignal): Promise<SeatResult> {
    return new Promise<SeatResult>((resolve, reject) => {
      if (signal.aborted) return reject(new Cancelled())
      // Too big for its computer to put together: said, rather than sent and never answered.
      if (mailSize({ kind: "turn", turn }) > seatMailBytes) return resolve({ ok: false, why: `the chat is too big to send to ${this.place()}.` })
      const pending: Pending = { turn, report, done: resolve, seat: turn.seat, started: false, told: new Set() }
      const end = () => {
        for (const timer of [pending.asking, pending.silent, pending.limit]) if (timer !== undefined) this.clock.clearTimeout(timer)
        this.pending.delete(turn.id)
        signal.removeEventListener("abort", stop)
      }
      pending.done = (result) => {
        end()
        resolve(result)
      }
      const stop = () => {
        this.transport.send(this.box, { kind: "stop", id: turn.id }, false)
        end()
        reject(new Cancelled())
      }
      signal.addEventListener("abort", stop, { once: true })
      this.pending.set(turn.id, pending)
      this.transport.send(this.box, { kind: "turn", turn }, false)
      this.listen(pending)
      pending.limit = this.clock.setTimeout(() => this.away(pending), longestTurn)
    })
  }

  /** From now on: asked again at each silence, and taken as away after a long one. */
  private listen(pending: Pending) {
    if (pending.asking !== undefined) this.clock.clearTimeout(pending.asking)
    if (pending.silent !== undefined) this.clock.clearTimeout(pending.silent)
    const askAgain = () => {
      pending.asking = this.clock.setTimeout(() => {
        // Once its words are with its seat, no seat is made for it anew: the whole chat isn't sent again.
        const { fresh: _fresh, ...slim } = pending.turn
        this.transport.send(this.box, { kind: "turn", turn: pending.started ? slim : pending.turn }, false)
        askAgain()
      }, askAgainAfter)
    }
    askAgain()
    pending.silent = this.clock.setTimeout(() => this.away(pending), awayAfter)
  }

  /** Its computer can't be reached now: the chat goes on without it, and a turn it still has stops there. */
  private away(pending: Pending) {
    this.transport.send(this.box, { kind: "stop", id: pending.turn.id }, false)
    pending.done({ ok: false, away: true, why: `${this.place()} can’t be reached now.` })
  }

  /** What its computer says of a turn: only from the computer it was asked of (`from`), never another's. */
  take(from: string, mail: SeatMail) {
    if (from !== this.box || (mail.kind !== "state" && mail.kind !== "result")) return
    const pending = this.pending.get(mail.id)
    if (!pending) return
    this.listen(pending)
    if (mail.kind === "state") return this.heard(pending, mail.state)
    // What it missed of how it went (its seat, that its words were with it) is in how it ended.
    const { seat, agents, replaced, ...result } = mail.result
    if (typeof seat === "string" && seat && seat !== pending.seat) {
      this.heard(pending, { phase: "seated", seat, agents: agents === true, ...(typeof replaced === "string" && replaced ? { replaced } : {}) })
    }
    if (result.ok && !pending.started) this.heard(pending, { phase: "started" })
    pending.done(result as SeatResult)
  }

  /** How it goes, each thing once, though it's said again when it's asked again. */
  private heard(pending: Pending, state: SeatState) {
    // Only that it's still at it: heard, nothing to say.
    if (state.phase === "working") return
    const said = JSON.stringify(state)
    if (state.phase !== "activity") {
      if (pending.told.has(said)) return
      pending.told.add(said)
    }
    if (state.phase === "seated") pending.seat = state.seat
    if (state.phase === "started") pending.started = true
    pending.report(state)
  }

  /** A message of yours, to its bot talking now in `seat`: heard once its computer says so. */
  async steer(seat: string, _agents: boolean, text: string, message: string): Promise<boolean> {
    const running = [...this.pending.values()].find((each) => each.seat === seat && each.told.size > 0)
    if (running) this.transport.send(this.box, { kind: "steer", id: running.turn.id, text, message }, false)
    return false
  }

  async drop(seat: string, agents: boolean, owner?: { bot: string; chat: string }) {
    this.transport.send(this.box, { kind: "drop", seat, agents, ...(owner ? { bot: owner.bot, chat: owner.chat } : {}) }, true)
  }

  /** A part of the work, to its bot's own conversation there: false for one too big to send. */
  work(work: WorkGiven): boolean {
    const mail: SeatMail = { kind: "work", work }
    if (mailSize(mail) > seatMailBytes) return false
    this.transport.send(this.box, mail, true)
    return true
  }

  /** What its bot remembers of a chat here. */
  remember(memory: MemoryGiven) {
    this.transport.send(this.box, { kind: "memory", memory }, true)
  }
}

/** How long a turn's id is remembered, so one asked again isn't taken twice. */
const rememberTurns = 86_400_000
/**
 * How long a part done here is remembered, with how it went: far longer than a letter lives (two
 * days), so a part given again however late (its chat's computer off meanwhile, its report's
 * letter given up) is told again how it went, never done twice.
 */
export const rememberWork = 30 * 86_400_000
/** What a bot's doing goes at most this often, the latest of it. */
export const activityEvery = 1_500

/** A turn here says it's still at it this often, while it runs. */
export const aliveEvery = 10_000

interface Running {
  host: string
  controller: AbortController
  /** How it goes so far (what it's doing, only the latest), said again when it's asked again; none once it's over. */
  states: SeatState[]
  result?: SeatAnswer
  at: number
  /** Its seat once it's settled (checked as this bot's in that chat, or made for it), and whether its words are with it. */
  seat?: { seat: string; agents: boolean }
  started: boolean
  /** Messages of yours that came before its words were with its seat, for it once they are. */
  steers: { text: string; message: string }[]
}

/** What a computer's bots' part in chats elsewhere needs of it besides their seats. */
export interface SeatServerContext {
  store: GroupStore
  /** What a chat elsewhere said one of its bots here remembers of it: kept, and the bot told. */
  remembered(from: string, memory: MemoryGiven): Promise<void>
}

/** This computer's bots' seats, as chats on your other computers ask them. */
export class SeatServer {
  private turns = new Map<string, Running>()
  /** Parts being followed now, so none is followed twice. */
  private following = new Set<string>()

  constructor(
    private readonly seats: Seats,
    private readonly transport: PeerTransport,
    private readonly context?: SeatServerContext,
    private readonly clock: Clock = realClock,
  ) {}

  private now(): number {
    return this.clock.now?.() ?? Date.now()
  }

  /** Parts given here before this started (the bridge restarted): followed again; those done long ago forgotten. */
  start() {
    this.forgetOldWork()
    for (const [task, work] of Object.entries(this.context?.store.peerWork() ?? {})) {
      if (work.done) continue
      if (work.prompt) this.follow(task, work)
      else this.report(task, work, { ok: false, why: "Kuvo Code stopped before it reached the bot" })
    }
  }

  private forgetOldWork() {
    const store = this.context?.store
    for (const [task, work] of Object.entries(store?.peerWork() ?? {})) {
      if (work.done && this.now() - Date.parse(work.finished ?? work.started) > rememberWork) store?.keepPeerWork(task, undefined)
    }
  }

  /**
   * A part, to its bot's own conversation here; then followed until the bot reports. Given twice,
   * taken once: given again once it's done (its chat's computer started again, its report not
   * there), it's told again how it went.
   */
  private async work(host: string, given: WorkGiven) {
    const store = this.context?.store
    if (!store) return
    this.forgetOldWork()
    const known = store.peerWork()[given.task]
    if (known) {
      if (known.done && known.result && known.host === host) this.tell(given.task, known, known.result)
      return
    }
    const work = { host, chat: given.chat, wrapUp: given.wrapUp, bot: given.bot, started: given.started }
    store.keepPeerWork(given.task, work)
    const bot = this.seats.bot(given.bot)
    if (!bot) return this.report(given.task, work, { ok: false, why: "the bot doesn’t live on this computer any more" })
    try {
      const prompt = await this.seats.give(bot, given.text)
      store.keepPeerWork(given.task, { ...work, prompt })
      this.follow(given.task, { ...work, prompt })
    } catch (error: any) {
      this.report(given.task, work, { ok: false, why: String(error?.message ?? error) })
    }
  }

  private follow(task: string, work: PeerWork) {
    if (this.following.has(task) || !work.prompt) return
    this.following.add(task)
    void this.seats
      .follow(work.bot, work.prompt, work.started, () => {
        const now = this.context?.store.peerWork()[task]
        return Boolean(now && !now.done)
      })
      .then((result) => {
        if (result) this.report(task, work, result)
      })
      .finally(() => this.following.delete(task))
  }

  /** How a part went, noted here as done with it (to tell it again), and to the chat's computer (never lost on the way). */
  private report(task: string, work: PeerWork, result: SeatResult) {
    const fitted = fitReport(result)
    this.context?.store.keepPeerWork(task, { ...work, done: true, result: fitted, finished: new Date(this.now()).toISOString() })
    this.tell(task, work, fitted)
  }

  private tell(task: string, work: PeerWork, result: SeatResult) {
    this.transport.send(work.host, { kind: "report", task, wrapUp: work.wrapUp, chat: work.chat, result }, true)
  }

  /** A letter of this computer's given up by its link (days without its computer saying it has it): a part's report goes again, while the part is remembered. */
  gaveUp(to: string, mail: SeatMail) {
    if (mail.kind !== "report") return
    const known = this.context?.store.peerWork()[mail.task]
    if (known?.done && known.result && known.host === to) this.tell(mail.task, known, known.result)
  }

  /** What a chat's computer (`from`, one of this computer's peers: the link opens only theirs) asks. */
  take(from: string, mail: SeatMail) {
    switch (mail.kind) {
      case "turn":
        return this.turn(from, mail.turn)
      case "stop": {
        const running = this.turns.get(mail.id)
        if (running) {
          if (running.host === from) running.controller.abort()
          return
        }
        // One this bridge took before it restarted, not asked again since: its seat stops there.
        const before = this.keptTurns()[mail.id]
        if (before?.host === from && before.seat && before.prompt && !before.result) {
          void this.seats.interrupt(before.seat, before.agents ?? false)
          this.keepTurn(mail.id, (kept) => ({ ...kept, result: { ok: false, why: "it was stopped." } }), from)
        }
        return
      }
      case "steer": {
        const running = this.turns.get(mail.id)
        if (!running || running.host !== from || running.result) return
        // Only into a seat that's settled (checked as its, or made for it): until then, it waits.
        if (running.started) this.steerNow(from, mail.id, running, mail.text, mail.message)
        else running.steers.push({ text: mail.text, message: mail.message })
        return
      }
      case "drop":
        void this.drop(mail)
        return
      case "work":
        void this.work(from, mail.work)
        return
      case "memory":
        void this.context?.remembered(from, mail.memory)
        return
    }
  }

  /** A seat gone, only when it's the seat of the bot and chat it's said to be: no other conversation here can be deleted this way. */
  private async drop(mail: Extract<SeatMail, { kind: "drop" }>) {
    if (typeof mail.bot !== "string" || typeof mail.chat !== "string") return
    if ((await this.seats.owns(mail.seat, mail.agents, mail.bot, mail.chat)) === "yes") await this.seats.drop(mail.seat, mail.agents)
  }

  /** How it goes, to the chat's computer, and kept to say again: of what it's doing, only the latest. */
  private send(to: string, id: string, state: SeatState) {
    const running = this.turns.get(id)
    if (running && !running.result) {
      if (state.phase === "activity") running.states = running.states.filter((each) => each.phase !== "activity")
      running.states.push(state)
    }
    this.transport.send(to, { kind: "state", id, state }, false)
  }

  /** Turns kept on disk (so one asked again after the bridge restarted goes on where it was), those older than a day left out. */
  private keptTurns(): Record<string, PeerTurn> {
    const all = this.context?.store.peerTurns() ?? {}
    for (const [id, kept] of Object.entries(all)) if (!(this.now() - kept.at <= rememberTurns)) delete all[id]
    return all
  }

  private keepTurn(id: string, change: (kept: PeerTurn) => PeerTurn, host: string) {
    const store = this.context?.store
    if (!store) return
    try {
      const all = this.keptTurns()
      all[id] = change(all[id] ?? { host, at: this.now() })
      store.keepPeerTurns(all)
    } catch (error: any) {
      // Not kept (its folder unwritable): the turn goes on all the same, as it would have.
      console.error("group chat turn not kept:", String(error?.message ?? error))
    }
  }

  private turn(host: string, turn: SeatTurn) {
    const now = this.now()
    for (const [id, running] of this.turns) if (running.result && now - running.at > rememberTurns) this.turns.delete(id)
    const known = this.turns.get(turn.id)
    if (known) {
      // Asked again (an answer lost on the way): told where it is, not taken twice.
      if (known.host !== host) return
      if (known.result) this.transport.send(host, { kind: "result", id: turn.id, result: known.result }, false)
      else for (const state of known.states) this.transport.send(host, { kind: "state", id: turn.id, state }, false)
      return
    }
    // Taken before this bridge started (it restarted): how it ended told again, or it goes on where it was.
    const before = this.keptTurns()[turn.id]
    if (before && before.host !== host) return
    if (before?.result) {
      this.turns.set(turn.id, { host, controller: new AbortController(), states: [], result: before.result, at: before.at, started: true, steers: [] })
      this.transport.send(host, { kind: "result", id: turn.id, result: before.result }, false)
      return
    }
    this.keepTurn(turn.id, (kept) => kept, host)
    const running: Running = { host, controller: new AbortController(), states: [], at: now, started: false, steers: [] }
    this.turns.set(turn.id, running)
    // Still at it, every few seconds, so a long quiet step isn't taken for silence and asked again.
    let alive: unknown
    const stillAt = () => {
      alive = this.clock.setTimeout(() => {
        if (running.result) return
        this.transport.send(host, { kind: "state", id: turn.id, state: { phase: "working" } }, false)
        stillAt()
      }, aliveEvery)
    }
    stillAt()
    // What it's doing, the latest, at most so often.
    let latest: SeatState | undefined
    let timer: unknown
    let last = 0
    const flush = () => {
      timer = undefined
      if (!latest || running.result) return
      last = Date.now()
      const state = latest
      latest = undefined
      this.send(host, turn.id, state)
    }
    const report = (state: SeatState) => {
      if (state.phase !== "activity") {
        this.send(host, turn.id, state)
        // Its words are with its seat, settled now: what you wrote meanwhile reaches it.
        if (state.phase === "started") {
          running.started = true
          for (const steer of running.steers.splice(0)) this.steerNow(host, turn.id, running, steer.text, steer.message)
        }
        return
      }
      latest = state
      if (timer !== undefined) return
      const wait = Math.max(0, activityEvery - (Date.now() - last))
      if (wait === 0) flush()
      else timer = this.clock.setTimeout(flush, wait)
    }
    // Said at once that it has it, so the host doesn't ask again while its seat is made.
    this.send(host, turn.id, { phase: "taken" })
    const resume = before?.seat ? { seat: before.seat, agents: before.agents ?? false, prompt: before.prompt, sent: before.sent } : undefined
    if (resume) running.seat = { seat: resume.seat, agents: resume.agents }
    const progress = (now: SeatProgress) => {
      running.seat = { seat: now.seat, agents: now.agents }
      this.keepTurn(turn.id, (kept) => ({ ...kept, ...now }), host)
    }
    void this.seats
      .turn(turn, report, running.controller.signal, { checkSeat: true, resume, progress })
      .catch((error): SeatResult => (error instanceof Cancelled ? { ok: false, why: "it was stopped." } : { ok: false, why: String(error?.message ?? error) }))
      .then((result) => {
        if (timer !== undefined) this.clock.clearTimeout(timer)
        if (alive !== undefined) this.clock.clearTimeout(alive)
        // With the seat it ended in, so a chat that missed `seated` keeps it all the same.
        const seated = [...running.states].reverse().find((state) => state.phase === "seated")
        const answer: SeatAnswer = seated?.phase === "seated" ? { ...result, seat: seated.seat, agents: seated.agents, ...(seated.replaced ? { replaced: seated.replaced } : {}) } : result
        running.result = fitResult(turn.id, answer)
        running.states = []
        running.steers = []
        running.at = this.now()
        this.keepTurn(turn.id, (kept) => ({ ...kept, result: running.result }), host)
        if (!running.controller.signal.aborted) this.transport.send(host, { kind: "result", id: turn.id, result: running.result }, false)
      })
  }

  /** A message of yours, to its seat as it talks (settled: checked as its, or made for it), said back once it reached it. */
  private steerNow(host: string, id: string, running: Running, text: string, message: string) {
    const at = running.seat
    if (!at || running.result) return
    void this.seats.steer(at.seat, at.agents, text).then((steered) => {
      if (steered) this.send(host, id, { phase: "steered", message })
    })
  }
}
