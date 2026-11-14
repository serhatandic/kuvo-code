// Side questions ("/btw what does this regex match?"): asked about a conversation, answered from
// what it knows, and kept out of it, so the agent's work and context stay as they are. One can be
// followed up, as a short side thread: each follow-up is answered with the thread so far. Each
// conversation keeps its own, in a list of its own that a client shows apart from it (the
// sidebar's side questions under the conversation). The box answers them and keeps them, here
// beside the engine, for the engine's sessions and the coding agents' alike (PROTOCOL.md, "Side
// questions").

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { emit } from "./events"
import type { GoalPlaces } from "./goals"
import { transcript } from "./goals"
import { newID } from "./ids"
import { answerWithContext, at, messages, opening, sessionInfo } from "./oneoff"

export interface SideQuestion {
  id: string
  /** The conversation it's about. */
  session: string
  /** The side thread it's in: the id of the question that started it (its own, for one). */
  thread?: string
  question: string
  state: "answering" | "answered" | "failed"
  answer?: string
  /** Why it couldn't be answered, in plain words. */
  error?: string
  /** In ms since 1970. */
  asked: number
  answered?: number
}

/** A question is at most this long. */
export const questionLimit = 4_000
/** A conversation keeps this many, the oldest going first. */
export const keptLimit = 100
/** A follow-up is answered with this many of its thread's answers before it, the latest. */
const threadContext = 12

/** The side thread `question` is in (one from before threads is a thread of its own). */
export function threadOf(question: SideQuestion): string {
  return question.thread ?? question.id
}

export class SideQuestionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class SideQuestions {
  /** Each conversation's, oldest first. */
  private kept = new Map<string, SideQuestion[]>()
  private stopped = false
  /** Told once an answer's in (a test waits on it). */
  onAnswered?: () => void
  /** Each conversation followed for its deletion, which takes its side questions with it. */
  private stops = new Map<string, () => void>()

  constructor(
    private readonly file: string,
    private readonly places: GoalPlaces,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8"))
      for (const question of Array.isArray(saved) ? saved : []) {
        if (typeof question?.session !== "string" || typeof question?.question !== "string") continue
        this.kept.set(question.session, [...(this.kept.get(question.session) ?? []), question])
      }
    } catch {}
    for (const session of this.kept.keys()) {
      this.follow(session)
      void this.forgetIfGone(session)
    }
  }

  private follow(session: string) {
    if (this.stops.has(session)) return
    this.stops.set(session, this.place(session).listen(session, {
      event: (type, data) => {
        if (type === "session.deleted" && data?.sessionID === session) this.forget(session)
      },
      // Its deletion may have gone by while the feed was away.
      reconnected: () => void this.forgetIfGone(session),
    }))
  }

  /** A conversation deleted while the box was stopped, or its feed away: its side questions go. */
  private async forgetIfGone(session: string) {
    await this.place(session).api.request("GET", at(session)).catch((error: any) => {
      if (error?.status === 404) this.forget(session)
    })
  }

  /** Answers those still waiting from before the box stopped. */
  start() {
    for (const list of this.kept.values()) for (const question of list) if (question.state === "answering") void this.answer(question)
  }

  /** Whether one is being answered (a newer bridge waits for it: renewal.ts). */
  busy(): boolean {
    return [...this.kept.values()].some((list) => list.some((question) => question.state === "answering"))
  }

  stopAll() {
    this.stopped = true
    for (const stop of this.stops.values()) stop()
    this.stops.clear()
  }

  /** A conversation's, oldest first. */
  list(session: string): SideQuestion[] {
    return this.kept.get(session) ?? []
  }

  /** Every conversation that has some: how many, in how many threads, and the latest, for a list beside them. */
  summary(): { session: string; count: number; threads: number; latest: SideQuestion }[] {
    return [...this.kept]
      .filter(([, list]) => list.length)
      .map(([session, list]) => ({ session, count: list.length, threads: new Set(list.map(threadOf)).size, latest: list.at(-1)! }))
  }

  /** Asks one about `session`, a new side thread, or a follow-up in `thread`: answered in a
   * moment (`kuvo.btw.updated`). */
  async ask(session: string, question: string, thread?: string): Promise<SideQuestion> {
    const text = question.trim()
    if (!text) throw new SideQuestionError(400, "Say what you'd like to know.")
    if (text.length > questionLimit) throw new SideQuestionError(400, `A side question can be at most ${questionLimit.toLocaleString("en-US")} characters.`)
    if (thread !== undefined && !this.list(session).some((each) => threadOf(each) === thread)) throw new SideQuestionError(404, "There's no such side thread.")
    const place = this.place(session)
    await sessionInfo(place.api, session).catch((error: any) => {
      throw new SideQuestionError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
    })
    // Taken away meanwhile: no follow-up left in a thread that's gone.
    if (thread !== undefined && !this.list(session).some((each) => threadOf(each) === thread)) throw new SideQuestionError(404, "There's no such side thread.")
    const id = newID("btw")
    const asked: SideQuestion = { id, session, thread: thread ?? id, question: text, state: "answering", asked: this.now() }
    const list = [...(this.kept.get(session) ?? []), asked].slice(-keptLimit)
    this.kept.set(session, list)
    this.follow(session)
    this.changed(asked)
    void this.answer(asked)
    return asked
  }

  /** Takes one away, a side thread's all (`thread`), or all of a conversation's (both left out). */
  remove(session: string, id?: string, { thread }: { thread?: string } = {}) {
    const list = this.kept.get(session) ?? []
    const left = thread ? list.filter((question) => threadOf(question) !== thread) : id ? list.filter((question) => question.id !== id) : []
    if (left.length === list.length) throw new SideQuestionError(404, thread ? "There's no such side thread." : id ? "There's no such side question." : "That conversation has no side questions.")
    if (left.length) this.kept.set(session, left)
    else {
      this.kept.delete(session)
      this.stops.get(session)?.()
      this.stops.delete(session)
    }
    this.save()
    // A thread's, one by one: a client from before threads reads each as it always has.
    if (thread) for (const gone of list.filter((question) => threadOf(question) === thread)) emit("kuvo.btw.removed", { sessionID: session, id: gone.id })
    else emit("kuvo.btw.removed", { sessionID: session, ...(id ? { id } : {}) })
  }

  /** A conversation deleted: its side questions go with it. */
  forget(session: string) {
    if (this.kept.has(session)) this.remove(session)
  }

  private async answer(question: SideQuestion) {
    const place = this.place(question.session)
    // Its thread so far, so a follow-up follows on from it; a new thread starts afresh.
    const list = this.list(question.session)
    const before = list.slice(0, Math.max(0, list.indexOf(question)))
    // (One still being answered, asked from another client meanwhile, is there unanswered.)
    const earlier = before.filter((each) => threadOf(each) === threadOf(question) && each.state !== "failed").slice(-threadContext)
    const said = (each: SideQuestion) => `Q: ${each.question}\nA: ${each.state === "answered" ? each.answer : "(not answered yet)"}`
    const prompt = `Someone working with you in this conversation asks a side question. Answer it briefly and plainly, from what this conversation shows and what you know. Don't run anything or change anything: this answer isn't added to the conversation, and the work in it carries on as it was.
${earlier.length ? `\nIt follows on from their side thread so far, with your answers:\n${earlier.map(said).join("\n\n")}\n` : ""}
<question>
${question.question}
</question>`
    try {
      const answer = await answerWithContext(place.api, place === this.places.engine, question.session, prompt, async () => transcript(await messages(place.api, question.session), 0, await opening(place.api, question.session)))
      if (!answer.trim()) throw new Error("The model gave no answer.")
      question.state = "answered"
      question.answer = answer.trim()
    } catch (error: any) {
      question.state = "failed"
      question.error = String(error?.message ?? error)
    }
    question.answered = this.now()
    this.changed(question)
    this.onAnswered?.()
  }

  private place(session: string) {
    return this.places.isBridge(session) ? this.places.bridge : this.places.engine
  }

  private changed(question: SideQuestion) {
    if (this.stopped || !this.list(question.session).includes(question)) return
    this.save()
    emit("kuvo.btw.updated", { sessionID: question.session, question: { ...question } })
  }

  private save() {
    try {
      writeFileSync(this.file + ".new", JSON.stringify([...this.kept.values()].flat()), { mode: 0o600 })
      renameSync(this.file + ".new", this.file)
    } catch (error) {
      console.error("side questions not kept:", error)
    }
  }
}

// MARK: Routes (`/api/kuvo/btw`, which a client reaches as `kuvo/agents/api/kuvo/btw`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function sideQuestionRoutes(questions: SideQuestions | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!questions) return json({ message: "Side questions aren't running on this computer." }, 503)
  const [session, id] = parts
  try {
    if (!session) return method === "GET" ? json({ data: questions.summary() }) : json({ message: "Not allowed" }, 405)
    if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
    if (method === "GET" && !id) return json({ data: questions.list(session) })
    if (method === "POST" && !id) {
      const { question, thread } = (await body()) ?? {}
      if (typeof question !== "string") return json({ message: "Say what you'd like to know." }, 400)
      if (thread !== undefined && thread !== null && typeof thread !== "string") return json({ message: "There's no such side thread." }, 404)
      return json({ data: await questions.ask(session, question, thread ?? undefined) })
    }
    if (method === "DELETE" && id === "threads") {
      // A side thread, all of it.
      const thread = parts[2]
      if (!thread) return json({ message: "There's no such side thread." }, 404)
      questions.remove(session, undefined, { thread })
      return json({})
    }
    if (method === "DELETE") {
      questions.remove(session, id)
      return json({})
    }
    return json({ message: "Not allowed" }, 405)
  } catch (error) {
    if (error instanceof SideQuestionError) return json({ message: error.message }, error.status)
    throw error
  }
}
