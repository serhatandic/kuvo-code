// A bot's seat in a group chat, on the computer the bot lives on: made, kept on the bot's model and
// told who's there, given its turn, waited for (asks turned down on the way, as nobody's there to
// answer them), and read back. The chat's own computer (its host) composes what the bot is told
// and keeps the chat; this is the bot's own computer's part, the same whether the chat lives here
// or on another of your computers (`peer.ts` carries it there).

import { autoProvider } from "../auto"
import { parseProvider } from "../accounts"
import { newID } from "../ids"
import type { ModelRef, ToolCall } from "../wire"
import { SeatAPI, type Requester } from "./api"
import { activity as activityOf, isWaiting, plainError, said, seatBudget, seatInstructions, seatRules, thought, type Activity, type Group, type SeatBot } from "./rules"
import type { GroupStore, MachineBot } from "./store"

/** The key of a seat's instructions. */
export const seatKey = "kuvo.seat"

/** How long a seat's run may take before it's stopped. */
export const turnLimit = 600_000

/** The chat a seat is in, as the bot's computer needs it: who's there, the lead first. */
export interface ChatContext {
  id: string
  name: string
  purpose?: string
  members: { id: string; name: string; job: string }[]
}

/** One turn, as the chat's computer asks it of the bot's. */
export interface SeatTurn {
  /** This turn, so it's taken once. */
  id: string
  chat: ChatContext
  bot: string
  /** Its seat in the chat, when it has one, and whether that runs with the coding agents. */
  seat?: string
  agentsSeat?: boolean
  /** A turn in its seat, the lead's wrap-up there, a guest's one turn, or the lead's list of who does what (both in a conversation of their own for it). */
  kind: "turn" | "wrapUp" | "guest" | "split"
  /** What it's told. */
  text: string
  /** The whole chat, for a seat that has to be made anew (its model now runs elsewhere). */
  fresh?: string
  /** The chat as a new seat reads it, in bytes: a seat grown far past it starts over. */
  chatSize?: number
}

/** How a turn goes, as the bot's computer says it. */
export type SeatState =
  /** Its computer has the turn (from another computer, said at once, so it isn't asked again). */
  | { phase: "taken" }
  /** A seat made for it now (in place of one on another model, `replaced`). */
  | { phase: "seated"; seat: string; agents: boolean; replaced?: string }
  /** Its words are with its seat: what it hasn't heard, it has now. */
  | { phase: "started" }
  /** What it's doing, its last step. */
  | { phase: "activity"; activity: Activity[] }
  /** A message of yours reached it as it talked. */
  | { phase: "steered"; message: string }
  /** Still at it (from another computer, said every few seconds, so a long quiet step isn't asked again). */
  | { phase: "working" }

/** How a turn ended. */
export type SeatResult =
  /** What it said (nothing: it passed), with its steps; `outgrown`: its seat went, too big, and its next turn starts anew. */
  | { ok: true; text: string; steps: ToolCall[]; outgrown?: boolean }
  /** It couldn't answer, and why, as the chat says it; `away`: its computer couldn't be reached. */
  | { ok: false; why: string; away?: true }

/** How far a turn got: its seat, then its message there and when it went. */
export interface SeatProgress {
  seat: string
  agents: boolean
  prompt?: string
  sent?: number
}

/** For a turn from another computer (`Seats.turn`). */
export interface SeatTurnOptions {
  /** The seat it names is used only when it's this bot's seat in that chat (`owns`); otherwise the bot gets a seat of its own. */
  checkSeat?: boolean
  /** How far it got before (the bridge restarted): it goes on from there, its message never sent twice. */
  resume?: SeatProgress
  /** Told how far it gets, before each step is taken, to keep. */
  progress?: (progress: SeatProgress) => void
}

/** Where a bot takes its turns: its seats on this computer (`Seats`), or on another (`RemoteHome`). */
export interface SeatHome {
  turn(turn: SeatTurn, report: (state: SeatState) => void, signal: AbortSignal): Promise<SeatResult>
  /** A message of yours to its seat at work. Whether it reached it now (from another computer, it's said later: `steered`). */
  steer(seat: string, agents: boolean, text: string, message: string): Promise<boolean>
  /** A seat gone: `bot`'s, in `chat` (on another computer, it's checked to be that before it goes). */
  drop(seat: string, agents: boolean, owner?: { bot: string; chat: string }): Promise<void>
}

export interface SeatContext {
  store: GroupStore
  engine: Requester
  bridge: () => Requester | undefined
  pace?: number
  listen?: (session: string, listener: { event(event: any): void; reconnected(): void }) => () => void
  /** The computer, as what a bot can't do here names it ("this machine"); none on the Mac. */
  place?: string
  agentAccount?: (provider: string) => Promise<{ name: string; signedOut: boolean } | undefined>
}

class Cancelled extends Error {}
export { Cancelled }

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

const reason = (error: any) => String(error?.message ?? error ?? "it failed").trim()
export const runsWithAgents = (model?: ModelRef) => Boolean(model && (model.providerID === autoProvider || parseProvider(model.providerID)))

/** A bot's seats, on the computer it lives on. */
export class Seats implements SeatHome {
  /** Each seat's context at its first turn since this started: its growth past that makes it start over. */
  private seatBase = new Map<string, number>()
  /** Requests from seats already turned down. */
  private declined = new Set<string>()
  /** Seats whose rules were brought up to date since this started, and what each was last told. */
  private seatsChecked = new Set<string>()
  private seatTexts = new Map<string, string>()

  constructor(private readonly context: SeatContext) {}

  /** What's asked first or denied changed: each seat is told again at its next turn. */
  rulesChanged() {
    this.seatsChecked.clear()
  }

  private get here(): string {
    return this.context.place ? ` on ${this.context.place}` : ""
  }

  bot(id: string): MachineBot | undefined {
    return this.context.store.bot(id)
  }

  /** The API where a bot's own conversation runs. */
  ownAPI(bot: MachineBot): SeatAPI | undefined {
    if (!bot.agents) return new SeatAPI(this.context.engine)
    const bridge = this.context.bridge()
    return bridge ? new SeatAPI(bridge) : undefined
  }

  /** Where a seat runs: this bridge for one on a coding agent's model (or Auto), else the engine. */
  private apiFor(onAgents: boolean): SeatAPI | undefined {
    if (!onAgents) return new SeatAPI(this.context.engine)
    const bridge = this.context.bridge()
    return bridge ? new SeatAPI(bridge) : undefined
  }

  /**
   * The model a bot talks on: the one picked for it (Edit Bot's) while it can run here; otherwise
   * (its account signed out of here, which takes its models away, so Edit Bot shows none) what its
   * own conversation is on now.
   */
  async model(bot: MachineBot): Promise<ModelRef | undefined> {
    const conversation = async () => (await this.ownAPI(bot)?.session(bot.sessionID).catch(() => undefined))?.model as ModelRef | undefined
    if (!bot.model) return conversation()
    if (runsWithAgents(bot.model)) return bot.model
    const account = await new SeatAPI(this.context.engine).account(bot.model).catch(() => undefined)
    return account?.signedOut ? ((await conversation()) ?? bot.model) : bot.model
  }

  private rules(bot: MachineBot) {
    const settings = this.context.store.settings()
    return seatRules(bot.folder, settings?.askFirst ?? false, settings?.denies ?? [])
  }

  /** What a seat is told, from its bot as its folder has it now and the others as the chat says. */
  private seatText(bot: MachineBot, chat: ChatContext): string {
    const settings = this.context.store.settings()
    const asBot = (member: ChatContext["members"][number]): SeatBot => ({ id: member.id, name: member.name, job: member.job, instructions: "", memoryFile: "", folder: "" })
    const others = chat.members.filter((member) => member.id !== bot.id).map(asBot)
    const lead = chat.members[0] ? asBot(chat.members[0]) : undefined
    const personality = bot.personality ? settings?.personalities[bot.personality] : undefined
    const group = { id: chat.id, name: chat.name, purpose: chat.purpose, members: chat.members.map((member) => member.id), seats: {}, heard: {}, created: "" } satisfies Group
    return seatInstructions(bot, group, others, lead, personality, settings?.identityNote ?? "")
  }

  /** A seat made for `bot` in `chat`: on its model, with its rules and instructions. */
  private async make(bot: MachineBot, chat: ChatContext, title: string, scratch: boolean): Promise<{ seat: string; agents: boolean; api: SeatAPI }> {
    const model = await this.model(bot)
    const onAgents = runsWithAgents(model)
    const api = this.apiFor(onAgents)
    if (!api) throw new Error("the coding agents aren’t running")
    const agent = onAgents && model?.providerID.split("@")[0] === "cursor" ? "plan" : undefined
    const text = this.seatText(bot, chat)
    const session = await api.create(bot.directory, title, agent, model, this.rules(bot))
    try {
      // Whose seat it is, in which chat: what a chat on another computer asks of a seat is checked against it (`owns`).
      await api.setMetadata(session.id, { kuvo: { seat: { group: chat.id, bot: bot.id, ...(scratch ? { scratch: true } : {}) } } })
      await api.setInstruction(session.id, seatKey, text)
    } catch (error) {
      await api.delete(session.id).catch(() => {})
      throw error
    }
    this.seatTexts.set(session.id, text)
    this.seatsChecked.add(session.id)
    return { seat: session.id, agents: onAgents, api }
  }

  /**
   * The bot's seat as it is, told who's there now, on its bot's model: switched where it runs, or,
   * when the model runs elsewhere now (the engine, the coding agents), gone, for a new one that
   * hears the whole chat. Undefined when it went.
   */
  private async keep(turn: SeatTurn, bot: MachineBot): Promise<{ seat: string; agents: boolean; api: SeatAPI } | undefined> {
    const seat = turn.seat!
    const agents = turn.agentsSeat ?? false
    const api = this.apiFor(agents)
    if (!api) return undefined
    if (!this.seatsChecked.has(seat)) {
      this.seatsChecked.add(seat)
      await api.setPermissions(seat, this.rules(bot)).catch(() => {})
    }
    const text = this.seatText(bot, turn.chat)
    if (this.seatTexts.get(seat) !== text) {
      await api.setInstruction(seat, seatKey, text).catch(() => {})
      this.seatTexts.set(seat, text)
    }
    const model = await this.model(bot)
    if (!model) return { seat, agents, api }
    const session = await api.session(seat).catch(() => undefined)
    if (!session) return { seat, agents, api }
    if (session.model?.id === model.id && session.model?.providerID === model.providerID) return { seat, agents, api }
    if (agents || !runsWithAgents(model)) {
      await api.selectModel(seat, model).catch(() => {})
      if (agents) await api.selectAgent(seat, model.providerID.split("@")[0] === "cursor" ? "plan" : "build").catch(() => {})
      return { seat, agents, api }
    }
    await this.drop(seat, agents)
    return undefined
  }

  /**
   * Whether `seat` is `bot`'s seat in `chat`, as `make` marked it: what a chat on another computer
   * asks of a seat here is checked against this, so it can't use or delete any other conversation.
   * `gone` when there's no such conversation, `unknown` when it can't be read now.
   */
  async owns(seat: string, agents: boolean, bot: string, chat: string): Promise<"yes" | "no" | "gone" | "unknown"> {
    const api = this.apiFor(agents)
    if (!api) return "unknown"
    try {
      const marked = (await api.session(seat))?.metadata?.kuvo?.seat
      return marked?.bot === bot && marked?.group === chat ? "yes" : "no"
    } catch (error: any) {
      return error?.status === 404 ? "gone" : "unknown"
    }
  }

  /** A seat (or a conversation for one question) gone, with what it gathered. */
  async drop(seat: string, agents: boolean) {
    this.seatBase.delete(seat)
    await this.apiFor(agents)?.delete(seat).catch(() => {})
  }

  /**
   * One turn: its seat made or kept, what it's told sent, its run waited for, and what it said.
   * `report` hears how it goes. Stopped (`signal`), it stops where it is, mid-sentence.
   * `options`, for a turn from another computer: its seat checked, and how far it got kept, so
   * one asked again after the bridge restarted goes on where it was.
   */
  async turn(turn: SeatTurn, report: (state: SeatState) => void, signal: AbortSignal, options: SeatTurnOptions = {}): Promise<SeatResult> {
    const { checkSeat = false, resume, progress } = options
    const bot = this.bot(turn.bot)
    if (!bot) return { ok: false, why: "it doesn’t live on this computer any more." }
    const going = () => {
      if (signal.aborted) throw new Cancelled()
    }
    const ownConversation = turn.kind === "guest" || turn.kind === "split"
    let provider: string | undefined
    let scratch: { seat: string; agents: boolean } | undefined
    try {
      // Its model can't run here (its account signed out of): said, rather than sent to an engine
      // that drops it without a word. A coding agent's model, by the agent's own account (Auto
      // picks one that can run itself).
      const model = await this.model(bot)
      going()
      // Its seat, or the one it'd have, with the coding agents, and they aren't running.
      const onAgents = !ownConversation && turn.seat ? (turn.agentsSeat ?? false) : runsWithAgents(model)
      if (onAgents && !this.context.bridge()) return { ok: false, why: "the coding agents aren’t running." }
      if (model && model.providerID !== autoProvider) {
        const account = runsWithAgents(model)
          ? await this.context.agentAccount?.(model.providerID).catch(() => undefined)
          : await new SeatAPI(this.context.engine).account(model).catch(() => undefined)
        going()
        provider = account?.name
        if (account?.signedOut) return { ok: false, why: `${model.id} needs a sign-in${this.here}: sign in to ${account.name} in Settings › Accounts, or choose another model.` }
      }
      let seat: string
      let agents: boolean
      let api: SeatAPI
      let text = turn.text
      if (resume) {
        // Its seat (or its conversation for this one turn) as it was settled before the bridge
        // restarted: checked or made then.
        ;({ seat, agents } = resume)
        const resumed = this.apiFor(agents)
        if (!resumed) throw new Error("the coding agents aren’t running")
        api = resumed
        if (ownConversation) scratch = { seat, agents }
        else if (seat !== turn.seat) {
          report({ phase: "seated", seat, agents, ...(turn.seat ? { replaced: turn.seat } : {}) })
          if (turn.seat) text = turn.fresh ?? turn.text
        }
      } else if (ownConversation) {
        const title = turn.kind === "guest" ? `${bot.name} asked into ${turn.chat.name}` : `${bot.name} handing out the work in ${turn.chat.name}`
        ;({ seat, agents, api } = await this.make(bot, turn.chat, title, true))
        scratch = { seat, agents }
        progress?.({ seat, agents })
      } else {
        let ours = Boolean(turn.seat)
        if (turn.seat && checkSeat) {
          const owned = await this.owns(turn.seat, turn.agentsSeat ?? false, bot.id, turn.chat.id)
          if (owned === "unknown") throw new Error("its seat couldn’t be read")
          ours = owned === "yes"
          going()
        }
        const kept = ours ? await this.keep(turn, bot) : undefined
        going()
        if (kept) {
          ;({ seat, agents, api } = kept)
          progress?.({ seat, agents })
        } else {
          ;({ seat, agents, api } = await this.make(bot, turn.chat, `${bot.name} in ${turn.chat.name}`, false))
          progress?.({ seat, agents })
          report({ phase: "seated", seat, agents, ...(turn.seat ? { replaced: turn.seat } : {}) })
          if (turn.seat) text = turn.fresh ?? turn.text
        }
      }
      going()
      // Its message, by an id kept before it goes: after a restart, one already there is followed, not sent again.
      let promptID = resume?.prompt
      let sent = resume?.sent ?? Date.now()
      const there = promptID ? await this.sentAlready(seat, promptID, sent, api) : false
      going()
      if (!promptID || !there) {
        promptID ??= newID("msg")
        sent = Date.now()
        progress?.({ seat, agents, prompt: promptID, sent })
        await api.prompt(seat, promptID, text, "queue")
      }
      report({ phase: "started" })
      // Its latest thought, from the engine's stream, in a line under its name, a few times a
      // second at most; a look at its messages, which can be a step behind, doesn't take it back
      // for a moment.
      let thinking = ""
      let streamedAt = 0
      let shown: Activity[] = []
      const show = (now: Activity[], quiet = 300) => {
        if (JSON.stringify(now) === JSON.stringify(shown)) return
        const sameKind = shown[0]?.kind === now[0]?.kind
        if (sameKind && Date.now() - streamedAt < quiet) return
        shown = now
        streamedAt = Date.now()
        report({ phase: "activity", activity: now })
      }
      const unlisten = ownConversation
        ? undefined
        : this.context.listen?.(seat, {
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
        await this.waitForRun(seat, promptID, sent, api, signal, bot.directory, ownConversation ? undefined : (messages) => {
          const now = activityOf(messages, promptID, sent)
          if (now.length === 0 || JSON.stringify(now) === JSON.stringify(shown) || Date.now() - streamedAt < 3000) return
          shown = now
          report({ phase: "activity", activity: now })
        })
      } finally {
        unlisten?.()
      }
      const reply = await this.reply(seat, promptID, sent, api)
      going()
      // Grown well past the chat it's in (pages it read, drafts, long answers): it starts over at
      // its next turn, in a new seat given the whole chat, and this one goes. Grown from its first
      // turn here, so what every turn carries (its instructions and tools) doesn't count.
      let outgrown = false
      if (!ownConversation && reply.size !== undefined) {
        const base = this.seatBase.get(seat) ?? reply.size
        this.seatBase.set(seat, base)
        const grown = reply.size - base
        if (grown > seatBudget && grown > 2 * Math.floor((turn.chatSize ?? 0) / 4)) {
          outgrown = true
          await this.drop(seat, agents)
        }
      }
      if (!reply.text && reply.error) return { ok: false, why: plainError(reply.error, provider, this.context.place) }
      return { ok: true, text: reply.text, steps: reply.steps, ...(outgrown ? { outgrown } : {}) }
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled) throw new Cancelled()
      return { ok: false, why: plainError(reason(error), provider, this.context.place) }
    } finally {
      if (scratch) void this.drop(scratch.seat, scratch.agents)
    }
  }

  /** A part of a chat's work, to its bot's own conversation: the message it went as. */
  async give(bot: MachineBot, text: string): Promise<string> {
    const api = this.ownAPI(bot)
    if (!api) throw new Error("the coding agents aren’t running")
    const promptID = newID("msg")
    await api.prompt(bot.sessionID, promptID, text, "queue")
    return promptID
  }

  /**
   * Until the bot's run on a part (its message `promptID`, given at `started`) ends, however long
   * it takes, waiting on you meanwhile if it asks something; then what it said, its report.
   * Undefined once it's no longer `wanted` (reported meanwhile, or stopped, from elsewhere).
   */
  async follow(botID: string, promptID: string, started: string | undefined, wanted: () => boolean): Promise<SeatResult | undefined> {
    let misses = 0
    let stoppedChecks = 0
    for (;;) {
      await sleep(3000 * (this.context.pace ?? 1))
      if (!wanted()) return undefined
      const bot = this.bot(botID)
      if (!bot) return { ok: false, why: "the bot is gone" }
      const api = this.ownAPI(bot)
      if (!api) continue
      const active = await api.active().catch(() => undefined)
      if (!active || active.has(bot.sessionID)) continue
      // The queue first, then the conversation: a message delivered between the two reads is in the second.
      const queued = await api.inbox(bot.sessionID).catch(() => undefined)
      if (!queued) continue
      const read = await this.messagesFrom(promptID, bot.sessionID, started, api)
      if (read.kind !== "found") {
        // Its message taken back before it was read: the part ends, rather than working forever; twice in a row, both read.
        if (read.kind === "missing" && !queued.some((item) => item.id === promptID)) {
          if (++misses >= 2) return { ok: false, why: `its message was taken back before ${bot.name} read it` }
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
      if (!wanted()) return undefined
      if (!found.text) return { ok: false, why: error ?? "it stopped without saying what it did" }
      return { ok: true, text: found.text, steps: [] }
    }
  }

  /** Whether a seat has message `promptID` (sent at `sent`), queued or read; thrown when it can't be read now. */
  private async sentAlready(seat: string, promptID: string, sent: number, api: SeatAPI): Promise<boolean> {
    const queued = await api.inbox(seat)
    if (queued.some((item) => item.id === promptID)) return true
    const read = await this.messagesFrom(promptID, seat, new Date(sent).toISOString(), api)
    if (read.kind === "unreadable") throw new Error("its seat couldn’t be read")
    return read.kind === "found"
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

  /** Stops a seat mid-sentence. */
  async interrupt(seat: string, agents: boolean) {
    await this.apiFor(agents)?.interrupt(seat).catch(() => {})
  }

  /** A message of yours, to a seat at work: it hears it at its next step. Whether it reached it (only into a run). */
  async steer(seat: string, agents: boolean, text: string, _message?: string): Promise<boolean> {
    const api = this.apiFor(agents)
    if (!api || !(await api.active().catch(() => new Set<string>())).has(seat)) return false
    try {
      await api.prompt(seat, newID("msg"), text, "steer")
      return true
    } catch {
      return false
    }
  }

  /**
   * Until the seat's run ends. Questions and requests for permission are turned down on the way,
   * since nobody's there to answer them, and so is what an MCP server asks in its folder
   * (`directory`) while a tool of it runs there. `seen` hears its latest messages now and then,
   * for what it's doing. Stopped (`signal`): the seat stops too.
   */
  private async waitForRun(seat: string, promptID: string, sent: number, api: SeatAPI, signal: AbortSignal, directory: string, seen?: (messages: any[]) => void) {
    const pace = this.context.pace ?? 1
    let looked = Date.now()
    let gone = 0
    // Reads of its inbox that found no seat (deleted, as the bot left the chat), in a row.
    let missing = 0
    let idleSince: number | undefined
    let woken = false
    for (;;) {
      try {
        await sleep(600 * pace, signal)
      } catch (error) {
        // Not worth waiting for any more (stopped, or you wrote while the work list was asked).
        await api.interrupt(seat).catch(() => {})
        throw error
      }
      await this.decline(seat, api, directory)
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
      if (Date.now() - sent > turnLimit) {
        await api.interrupt(seat).catch(() => {})
        throw new Error("It took too long, so it was stopped.")
      }
    }
  }

  private async decline(seat: string, api: SeatAPI, directory: string) {
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
    // What an MCP server asks in its folder, filed under no session: the seat's while a tool of
    // that server runs in it (its messages read only when something's asked).
    const asked = (await api.sharedForms(directory).catch(() => [])).filter((form) => form?.metadata?.kind === "mcp-elicitation" && !this.declined.has(form.id))
    if (asked.length === 0) return
    const messages = (await api.messages(seat, 8).catch(() => undefined))?.data ?? []
    for (const form of asked) {
      if (!isWaiting(String(form.metadata.server ?? ""), messages)) continue
      this.declined.add(form.id)
      await api.dismissShared(form.id, directory).catch(() => {})
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
}
