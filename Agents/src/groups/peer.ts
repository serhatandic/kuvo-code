// Group chats across your computers (PROTOCOL.md, "Peers": `seat`): a chat lives on one computer
// (its host) and runs there, and a bot that lives on another (its home) takes its turn there, in a
// seat of that computer's own (`seat.ts`). Only the words go between them, box to box over the
// relay, with no Mac in the middle: the box's link carries this mail (in parts when it's big, and
// what mustn't be lost until it's there), and hands what comes to this bridge.

import { Cancelled, turnLimit, type SeatHome, type SeatResult, type SeatState, type SeatTurn, type Seats } from "./seat"
import type { GroupStore, PeerWork } from "./store"

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
        this.transport.send(this.box, { kind: "turn", turn: pending.turn }, false)
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

  /** A part of the work, to its bot's own conversation there. */
  work(work: WorkGiven) {
    this.transport.send(this.box, { kind: "work", work }, true)
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

interface Running {
  host: string
  controller: AbortController
  /** How it goes so far (what it's doing, only the latest), said again when it's asked again; none once it's over. */
  states: SeatState[]
  result?: SeatAnswer
  at: number
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
    this.context?.store.keepPeerWork(task, { ...work, done: true, result, finished: new Date(this.now()).toISOString() })
    this.tell(task, work, result)
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
        if (running?.host === from) running.controller.abort()
        return
      }
      case "steer": {
        const running = this.turns.get(mail.id)
        const seat = running && [...running.states].reverse().find((state) => state.phase === "seated")
        const turn = running && this.asked.get(mail.id)
        if (!running || running.host !== from || running.result || !turn) return
        const at = seat?.phase === "seated" ? seat : turn.seat ? { seat: turn.seat, agents: turn.agentsSeat ?? false } : undefined
        if (!at) return
        void this.seats.steer(at.seat, at.agents, mail.text).then((steered) => {
          if (steered) this.send(from, mail.id, { phase: "steered", message: mail.message })
        })
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

  private asked = new Map<string, SeatTurn>()

  /** How it goes, to the chat's computer, and kept to say again: of what it's doing, only the latest. */
  private send(to: string, id: string, state: SeatState) {
    const running = this.turns.get(id)
    if (running && !running.result) {
      if (state.phase === "activity") running.states = running.states.filter((each) => each.phase !== "activity")
      running.states.push(state)
    }
    this.transport.send(to, { kind: "state", id, state }, false)
  }

  private turn(host: string, turn: SeatTurn) {
    const now = Date.now()
    for (const [id, running] of this.turns) if (running.result && now - running.at > rememberTurns) this.turns.delete(id)
    const known = this.turns.get(turn.id)
    if (known) {
      // Asked again (an answer lost on the way): told where it is, not taken twice.
      if (known.host !== host) return
      if (known.result) this.transport.send(host, { kind: "result", id: turn.id, result: known.result }, false)
      else for (const state of known.states) this.transport.send(host, { kind: "state", id: turn.id, state }, false)
      return
    }
    const running: Running = { host, controller: new AbortController(), states: [], at: now }
    this.turns.set(turn.id, running)
    this.asked.set(turn.id, turn)
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
      if (state.phase !== "activity") return this.send(host, turn.id, state)
      latest = state
      if (timer !== undefined) return
      const wait = Math.max(0, activityEvery - (Date.now() - last))
      if (wait === 0) flush()
      else timer = this.clock.setTimeout(flush, wait)
    }
    // Said at once that it has it, so the host doesn't ask again while its seat is made.
    this.send(host, turn.id, { phase: "taken" })
    void this.seats
      .turn(turn, report, running.controller.signal, true)
      .catch((error): SeatResult => (error instanceof Cancelled ? { ok: false, why: "it was stopped." } : { ok: false, why: String(error?.message ?? error) }))
      .then((result) => {
        if (timer !== undefined) this.clock.clearTimeout(timer)
        // With the seat it ended in, so a chat that missed `seated` keeps it all the same.
        const seated = [...running.states].reverse().find((state) => state.phase === "seated")
        running.result = seated?.phase === "seated" ? { ...result, seat: seated.seat, agents: seated.agents, ...(seated.replaced ? { replaced: seated.replaced } : {}) } : result
        running.states = []
        running.at = Date.now()
        this.asked.delete(turn.id)
        if (!running.controller.signal.aborted) this.transport.send(host, { kind: "result", id: turn.id, result: running.result }, false)
      })
  }
}
