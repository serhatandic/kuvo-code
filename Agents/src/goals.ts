// Goals: you give a conversation's agent a goal ("/goal all tests in test/auth pass"), and it
// works toward it on its own, turn after turn, until a separate check finds it met. The box runs
// them, here beside the engine, so they go on with no client there, on this Mac and on each of
// your machines alike, for the engine's sessions and the coding agents' (PROTOCOL.md, "Goals").
//
// After each of the agent's turns, the session's own model reads the conversation (it runs
// nothing, it only reads) and says whether the goal is met, not met yet (and what's left), or
// can't be met as asked. Not met yet: the agent is told what's left, and takes another turn.
// A turn you stop, one that fails, or three in a row where the agent does nothing pause it,
// and so does a long run of turns, until you resume it.
//
// What's decided comes from the conversation itself (its last turn's end, `idle`), never from
// remembering events: a box started again, or a feed that dropped, picks up where it was, and a
// turn is never checked twice.

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { emit } from "./events"
import type { Requester } from "./groups/api"

export type GoalState = "working" | "paused" | "met" | "unmet"
export type Verdict = "met" | "not_met" | "impossible"

/** A goal as a client shows it. */
export interface Goal {
  session: string
  condition: string
  state: GoalState
  /** Why it's paused, or why it can't be met, in plain words. */
  note?: string
  /** Who paused it: you, or the box (a turn failed, the agent stopped making progress, the turn limit). */
  pausedBy?: "you" | "error" | "stalled" | "limit"
  /** When it was set, and when it was met or found impossible, in ms since 1970. */
  started: number
  ended?: number
  /** Turns the agent has taken toward it, each one checked. */
  turns: number
  /** A check is under way now. */
  checking: boolean
  /** The last check: its verdict and why (what's left, or the proof it's met). */
  last?: { verdict: Verdict; reason: string; at: number }
}

/** What the box keeps besides, never sent. */
interface Kept extends Goal {
  /** The last turn checked (its `idle` message), so none is checked twice. */
  checkedIdle?: string
  /** Turns in a row with nothing done (no tool used). */
  quiet: number
  /** The turn count at which it pauses next. */
  limit: number
  /** A turn that ended before it was resumed, checked however it ended (it paused on it). */
  recheck?: string
}

/** Where a session runs: the engine's API, or this bridge's own, and its events. */
export interface GoalPlace {
  api: Requester
  /** Tells `told` each event of `session`'s; returns a stop. `reconnected` when the feed came back (events may have been missed). */
  listen(session: string, told: { event(type: string, data: any): void; reconnected(): void }): () => void
}

export interface GoalPlaces {
  engine: GoalPlace
  bridge: GoalPlace
  /** Whether a session is one of this bridge's (a coding agent's), not the engine's. */
  isBridge(session: string): boolean
}

/** A goal's condition is at most this long, as Claude Code's are. */
export const conditionLimit = 4_000
/** Turns in a row without doing anything that pause a goal. */
export const quietLimit = 3
/** Turns toward a goal before it pauses to ask you, and again after each resume. */
export const turnLimit = 100
/** The goal check reads this much of the conversation (the newest part). */
const readLimit = 30_000

export class GoalError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class Goals {
  private goals = new Map<string, Kept>()
  private stops = new Map<string, () => void>()
  /** Sessions being looked at now, so one look at a time. */
  private looking = new Set<string>()
  /** Sessions to look at again once the look under way ends (something changed meanwhile). */
  private again = new Set<string>()
  /** Told once a look has finished (a test waits on it). */
  onSettled?: () => void

  constructor(
    private readonly file: string,
    private readonly places: GoalPlaces,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      for (const goal of Array.isArray(saved) ? saved : []) if (typeof goal?.session === "string" && typeof goal?.condition === "string") this.goals.set(goal.session, { ...goal, checking: false })
    } catch {}
  }

  /** Follows the goals kept from before, and looks at those still working: their last turn may have ended meanwhile. */
  start() {
    for (const goal of this.goals.values()) {
      if (goal.state === "working" || goal.state === "paused") this.follow(goal.session)
      if (goal.state === "working") this.look(goal.session)
    }
  }

  list(): Goal[] {
    return [...this.goals.values()].map(shown)
  }

  get(session: string): Goal | undefined {
    const goal = this.goals.get(session)
    return goal && shown(goal)
  }

  /** Sets a session's goal (in place of one it had), and starts the agent on it. */
  async set(session: string, condition: string): Promise<Goal> {
    const text = condition.trim()
    if (!text) throw new GoalError(400, "Say what the goal is.")
    if (text.length > conditionLimit) throw new GoalError(400, `A goal can be at most ${conditionLimit.toLocaleString("en-US")} characters.`)
    const place = this.place(session)
    const messages = await this.messages(session, place).catch((error) => {
      throw new GoalError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
    })
    const goal: Kept = { session, condition: text, state: "working", started: this.now(), turns: 0, checking: false, quiet: 0, limit: turnLimit, checkedIdle: lastIdle(messages)?.id }
    this.goals.set(session, goal)
    this.follow(session)
    this.changed(goal)
    try {
      await place.api.request("POST", at(session) + "/synthetic", { text: brief(text), description: `Goal: ${line(text)}` })
    } catch (error: any) {
      this.pause(goal, "error", `The goal couldn't be given to the agent: ${error?.message ?? error}`)
    }
    return shown(goal)
  }

  /** Holds a goal: the turn under way ends as it would, and no other starts. */
  pauseByYou(session: string): Goal {
    const goal = this.found(session)
    if (goal.state === "met" || goal.state === "unmet") throw new GoalError(409, "That goal is over.")
    if (goal.state === "working") this.pause(goal, "you", "You paused it.")
    return shown(goal)
  }

  /**
   * Lets it go again. Idle now, its last turn is checked (however it ended): met meanwhile, it's
   * met; not, it carries on. At work, the turn under way is checked when it ends.
   */
  async resume(session: string): Promise<Goal> {
    const goal = this.found(session)
    if (goal.state === "met" || goal.state === "unmet") throw new GoalError(409, "That goal is over: set it again to carry on.")
    if (goal.state === "paused") {
      const messages = await this.messages(session, this.place(session)).catch(() => undefined)
      if (!messages) throw new GoalError(503, "The conversation can't be reached now.")
      if (this.goals.get(session) !== goal || goal.state !== "paused") return shown(goal)
      goal.state = "working"
      delete goal.note
      delete goal.pausedBy
      goal.quiet = 0
      goal.limit = goal.turns + turnLimit
      const idle = lastIdle(messages)
      if (idle && !atWork(messages, idle)) {
        goal.recheck = idle.id
        delete goal.checkedIdle
      }
      this.follow(session)
      this.changed(goal)
      this.look(session)
    }
    return shown(goal)
  }

  /** Takes the goal away (or the one it met): the agent carries on only with what you ask. */
  clear(session: string) {
    this.found(session)
    this.goals.delete(session)
    this.stops.get(session)?.()
    this.stops.delete(session)
    this.save()
    emit("kuvo.goal.updated", { sessionID: session, goal: null })
  }

  /** A session deleted: its goal goes with it. */
  forget(session: string) {
    if (this.goals.has(session)) this.clear(session)
  }

  /** The bridge is stopping: nothing more is followed, checked or kept. */
  stopAll() {
    this.stopped = true
    for (const stop of this.stops.values()) stop()
    this.stops.clear()
  }

  private stopped = false

  // MARK: Following a session

  private follow(session: string) {
    if (this.stops.has(session)) return
    this.stops.set(
      session,
      this.place(session).listen(session, {
        event: (type, data) => {
          // A subagent's events come to its parent's listener too: only the session's own turns count.
          if (data?.sessionID !== session) return
          if (type === "session.deleted") return this.forget(session)
          if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") this.look(session)
        },
        reconnected: () => this.look(session),
      }),
    )
  }

  /** Looks at a working goal's session: a turn that ended and wasn't checked yet is checked now. */
  private look(session: string) {
    if (this.stopped) return
    if (this.looking.has(session)) {
      this.again.add(session)
      return
    }
    this.looking.add(session)
    void this.lookNow(session)
      .catch((error) => console.error("goal:", error))
      .finally(() => {
        this.looking.delete(session)
        if (this.again.delete(session)) this.look(session)
        else this.onSettled?.()
      })
  }

  private async lookNow(session: string) {
    const goal = this.goals.get(session)
    if (!goal || goal.state !== "working") return
    const place = this.place(session)
    let messages: any[]
    try {
      messages = await this.messages(session, place)
    } catch (error: any) {
      if (error?.status === 404) this.forget(session)
      return
    }
    const idle = lastIdle(messages)
    // At work now (a turn started after the last one's end), or this turn was checked already.
    if (!idle || atWork(messages, idle) || idle.id === goal.checkedIdle) return
    const before = goal.checkedIdle
    goal.checkedIdle = idle.id
    const resumed = goal.recheck === idle.id
    delete goal.recheck
    if (!resumed && idle.outcome === "interrupted") return this.pause(goal, "you", "You stopped it.")
    if (!resumed && idle.outcome === "failed") return this.pause(goal, "error", idle.error?.message ? `The turn failed: ${idle.error.message}` : "The turn failed.")
    // Its turn since the last check: whether it did anything at all.
    const from = before ? messages.findIndex((message) => message.id === before) + 1 : 0
    const turn = messages.slice(from).filter((message) => (message.time?.created ?? 0) >= goal.started)
    const worked = turn.some((message) => message.type === "assistant" && (message.content ?? []).some((part: any) => part?.type === "tool"))
    goal.checking = true
    this.changed(goal)
    let verdict: { verdict: Verdict; reason: string }
    try {
      const answer = await place.api.request<{ data?: { text?: string } }>("POST", at(session) + "/generate", { prompt: checkPrompt(goal.condition, transcript(messages, goal.started)) }, 180_000)
      verdict = parseVerdict(answer?.data?.text ?? "")
    } catch (error: any) {
      goal.checking = false
      return this.pause(goal, "error", `The goal couldn't be checked: ${error?.message ?? error}`)
    }
    goal.checking = false
    // Taken away, or paused, while it was checked: as it is now.
    if (this.goals.get(session) !== goal || goal.state !== "working") return void this.changed(goal)
    goal.turns += 1
    goal.last = { ...verdict, at: this.now() }
    if (verdict.verdict === "met") {
      goal.state = "met"
      goal.ended = this.now()
      this.stops.get(session)?.()
      this.stops.delete(session)
      return void this.changed(goal)
    }
    if (verdict.verdict === "impossible") {
      goal.state = "unmet"
      goal.ended = this.now()
      goal.note = verdict.reason
      this.stops.get(session)?.()
      this.stops.delete(session)
      return void this.changed(goal)
    }
    goal.quiet = worked ? 0 : goal.quiet + 1
    if (goal.quiet >= quietLimit) return this.pause(goal, "stalled", `It stopped making progress: ${quietLimit} turns in a row without doing anything.`)
    if (goal.turns >= goal.limit) return this.pause(goal, "limit", `It's taken ${goal.turns} turns. Resume to keep going.`)
    // Someone wrote to it meanwhile: that turn is checked when it ends, rather than sending another.
    const now = await this.messages(session, place).catch(() => undefined)
    if (now && atWork(now, idle)) return void this.changed(goal)
    if (this.stopped) return
    this.changed(goal)
    try {
      await place.api.request("POST", at(session) + "/synthetic", { text: nudge(goal.condition, verdict.reason), description: `Not met yet: ${line(verdict.reason)}` })
    } catch (error: any) {
      this.pause(goal, "error", `The agent couldn't be told to carry on: ${error?.message ?? error}`)
    }
  }

  // MARK: Helpers

  private pause(goal: Kept, by: NonNullable<Goal["pausedBy"]>, note: string) {
    goal.state = "paused"
    goal.pausedBy = by
    goal.note = note
    this.changed(goal)
  }

  private found(session: string): Kept {
    const goal = this.goals.get(session)
    if (!goal) throw new GoalError(404, "That conversation has no goal.")
    return goal
  }

  private place(session: string): GoalPlace {
    return this.places.isBridge(session) ? this.places.bridge : this.places.engine
  }

  /** The conversation, oldest first: its newest part (a goal's turns are recent). */
  private async messages(session: string, place: GoalPlace): Promise<any[]> {
    const answer = await place.api.request<{ data?: any[] }>("GET", at(session) + "/message?limit=200")
    return [...(answer?.data ?? [])].reverse()
  }

  private changed(goal: Kept) {
    if (this.stopped || this.goals.get(goal.session) !== goal) return
    this.save()
    emit("kuvo.goal.updated", { sessionID: goal.session, goal: shown(goal) })
  }

  private save() {
    try {
      writeFileSync(this.file + ".new", JSON.stringify([...this.goals.values()]), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch (error) {
      console.error("goals not kept:", error)
    }
  }
}

const at = (session: string) => "/api/session/" + encodeURIComponent(session)

function shown(goal: Kept): Goal {
  const { checkedIdle: _idle, quiet: _quiet, limit: _limit, recheck: _recheck, ...rest } = goal
  return { ...rest }
}

/** The last turn's end in a conversation, oldest first. */
function lastIdle(messages: any[]): any | undefined {
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index]?.type === "idle") return messages[index]
  return undefined
}

/** Whether a turn began after `idle` (what you or an agent said since, or its reply). */
function atWork(messages: any[], idle: any): boolean {
  const index = messages.findIndex((message) => message?.id === idle.id)
  return messages.slice(index + 1).some((message) => message?.type === "user" || message?.type === "synthetic" || message?.type === "assistant")
}

/** The first line of `text`, short enough for a row. */
function line(text: string, limit = 140): string {
  const first = text.split("\n").map((part) => part.trim()).find(Boolean) ?? ""
  return first.length > limit ? first.slice(0, limit - 1).trimEnd() + "…" : first
}

// MARK: What the agent and the check are told

/** What marks a goal's messages to the agent, so clients show them as the goal's. */
export const goalMarker = "[Goal] "

export function brief(condition: string): string {
  return `${goalMarker}${condition}

Work on this until it's done, without waiting for me between turns. After each of your turns, a separate check reads this conversation (it can't run anything itself) and decides whether the goal is met, so show the proof as you go: run the tests or commands that prove it, and say what they printed. If it can't be done as asked, say exactly why.`
}

export function nudge(condition: string, reason: string): string {
  return `${goalMarker}Not met yet: ${reason}

Keep working toward the goal: ${condition}`
}

export function checkPrompt(condition: string, conversation: string): string {
  return `You check whether a coding agent has met a goal it was given. You can't run anything or look at files: judge only from the conversation below, which shows what the agent did and what its commands printed.

<goal>
${condition}
</goal>

<conversation>
${conversation}
</conversation>

Reply with JSON alone, no other words: {"verdict": "met" | "not_met" | "impossible", "reason": "<one short sentence>"}.
- "met" only when the conversation shows the goal holds (a test run that passes, the output the goal asks for), not just the agent saying it's done. The reason says what shows it.
- "not_met" otherwise. The reason says what's still left, as a next step for the agent.
- "impossible" only when it can never be met as asked: it needs something only the person can give, or it contradicts itself. The reason says why.`
}

/** The check's answer; one it can't make sense of counts as not met yet. */
export function parseVerdict(text: string): { verdict: Verdict; reason: string } {
  const match = text.match(/\{[\s\S]*\}/)
  try {
    const value = JSON.parse(match?.[0] ?? "")
    const verdict = value?.verdict === "met" || value?.verdict === "impossible" ? value.verdict : "not_met"
    const reason = typeof value?.reason === "string" && value.reason.trim() ? line(value.reason, 400) : verdict === "met" ? "The goal holds." : "Keep going."
    return { verdict, reason }
  } catch {
    return { verdict: "not_met", reason: "Keep going, and show what proves the goal holds." }
  }
}

/** The conversation since the goal was set, as the check reads it: who said and did what, the newest part if it's long. */
export function transcript(messages: any[], since: number): string {
  const lines: string[] = []
  const cut = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) + " […]" : text)
  for (const message of messages) {
    if ((message?.time?.created ?? 0) < since) continue
    switch (message?.type) {
      case "user":
        lines.push(`Person: ${cut(String(message.text ?? ""), 4_000)}`)
        break
      case "synthetic":
        // The goal's own messages say what the agent was told; others are notes from the app.
        lines.push(String(message.text ?? "").startsWith(goalMarker) ? `Goal check: ${cut(String(message.description ?? message.text), 600)}` : `Note: ${cut(String(message.description ?? message.text ?? ""), 600)}`)
        break
      case "assistant":
        for (const part of message.content ?? []) {
          if (part?.type === "text" && part.text?.trim()) lines.push(`Agent: ${cut(part.text.trim(), 4_000)}`)
          if (part?.type === "tool") {
            const input = cut(JSON.stringify(part.state?.input ?? {}), 300)
            const output = (part.state?.content ?? []).map((item: any) => (item?.type === "text" ? item.text : "")).join("\n").trim()
            const error = part.state?.error?.message ?? (typeof part.state?.error === "string" ? part.state.error : "")
            lines.push(`Agent ran ${part.name} ${input} (${part.state?.status ?? "?"})${output ? `:\n${cut(output, 1_500)}` : ""}${error ? `\nError: ${cut(String(error), 500)}` : ""}`)
          }
        }
        if (message.error?.message) lines.push(`(The agent's reply failed: ${cut(String(message.error.message), 500)})`)
        break
      case "shell":
        lines.push(`Command: ${cut(String(message.command ?? ""), 300)}${message.output ? `\n${cut(String(message.output), 1_500)}` : ""}`)
        break
    }
  }
  let text = lines.join("\n\n")
  if (text.length > readLimit) text = "[…earlier turns left out]\n\n" + text.slice(text.length - readLimit)
  return text || "(Nothing yet.)"
}

// MARK: Routes (`/api/kuvo/goals`, which a client reaches as `kuvo/agents/api/kuvo/goals`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function goalRoutes(goals: Goals | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!goals) return json({ message: "Goals aren't running on this computer." }, 503)
  const [session, action] = parts
  try {
    if (!session) {
      if (method === "GET") return json({ data: goals.list() })
      return json({ message: "Not allowed" }, 405)
    }
    if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
    if (!action) {
      if (method === "GET") {
        const goal = goals.get(session)
        return goal ? json({ data: goal }) : json({ message: "That conversation has no goal." }, 404)
      }
      if (method === "PUT") {
        const { condition } = (await body()) ?? {}
        if (typeof condition !== "string") return json({ message: "Say what the goal is." }, 400)
        return json({ data: await goals.set(session, condition) })
      }
      if (method === "DELETE") {
        goals.clear(session)
        return json({})
      }
      return json({ message: "Not allowed" }, 405)
    }
    if (method !== "POST") return json({ message: "Not allowed" }, 405)
    if (action === "pause") return json({ data: goals.pauseByYou(session) })
    if (action === "resume") return json({ data: await goals.resume(session) })
    return json({ message: "Not found" }, 404)
  } catch (error) {
    if (error instanceof GoalError) return json({ message: error.message }, error.status)
    throw error
  }
}
