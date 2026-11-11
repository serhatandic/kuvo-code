// Handoffs ("/handoff" or "/handoff now write the tests"): a long conversation carried on in a
// fresh one, with room to work. The conversation's model writes a handoff note from inside it
// (what it's for, what's done, what's left, the files and decisions that matter); a new
// conversation in the same folder, on the same model, effort, mode and permissions, starts with
// that note, and with what to do next when you said; the two are linked both ways. Writing the
// note takes a while, so a handoff answers at once and says when it's done (`kuvo.handoff`). The
// box does it, here beside the engine, for the engine's sessions and the coding agents' alike
// (PROTOCOL.md, "Handoffs").

import { emit } from "./events"
import type { GoalPlace, GoalPlaces } from "./goals"
import { transcript } from "./goals"
import { answerWithContext, at, line, messages, opening, sessionInfo, type SessionInfo } from "./oneoff"

/** What marks a handoff's note to the new conversation's agent, so clients show it as the handoff's. */
export const handoffMarker = "[Handoff] "

export class HandoffError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A conversation's handoff, as it goes: the note being written, the new conversation started, or why it couldn't be. */
export interface Handoff {
  from: string
  state: "writing" | "done" | "failed"
  /** The new conversation, once it's started. */
  to?: string
  title?: string
  error?: string
}

const notePrompt = `Write a handoff note for a new agent who takes over this conversation's work in a fresh conversation, without its history. Cover, in this order and briefly:
- what the work is for, and what the person asked for;
- what's done, and how you know (tests run, what they printed);
- what's left, as next steps;
- the files, commands and decisions that matter, and anything to watch out for.
Write it as Markdown, under 400 words, addressed to the new agent. Don't run or change anything.`

/** "Fix the parser (continued)" from "Fix the parser" or from "Fix the parser (continued)". */
export function continuedTitle(title?: string): string {
  return `${(title ?? "Conversation").replace(/\s*\(continued\)$/, "")} (continued)`
}

export class Handoffs {
  /** Each conversation's latest, while the box runs. */
  private kept = new Map<string, Handoff>()
  /** Those being checked before one starts: a second ask meanwhile (a double click, the phone and the Mac at once) is turned away. */
  private starting = new Set<string>()

  constructor(private readonly places: GoalPlaces) {}

  get(session: string): Handoff | undefined {
    return this.kept.get(session)
  }

  /** Whether one is being written or checked to start (a newer bridge waits for it: renewal.ts). */
  busy(): boolean {
    return this.starting.size > 0 || [...this.kept.values()].some((handoff) => handoff.state === "writing")
  }

  /** Starts one: answers with it writing, and says when it's done or why not (`kuvo.handoff`). */
  async start(session: string, next?: string): Promise<Handoff> {
    if (this.starting.has(session) || this.kept.get(session)?.state === "writing") throw new HandoffError(409, "It's being handed off already.")
    this.starting.add(session)
    try {
      return await this.begin(session, next)
    } finally {
      this.starting.delete(session)
    }
  }

  private async begin(session: string, next?: string): Promise<Handoff> {
    const place = this.place(session)
    const info = await sessionInfo(place.api, session).catch((error: any) => {
      throw new HandoffError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
    })
    if (info.parentID) throw new HandoffError(409, "A subagent's conversation can't be handed off. Hand off the conversation it works for.")
    if (!info.directory || !info.model) throw new HandoffError(409, "That conversation has no model yet: there's nothing to hand off.")
    // Two agents at work in the same folder at once would get in each other's way.
    if (await this.isActive(session, place)) throw new HandoffError(409, "The agent is working now. Stop it or wait for its turn to end, then hand it off.")
    const handoff: Handoff = { from: session, state: "writing" }
    this.kept.set(session, handoff)
    this.told(handoff)
    void this.carryOn(handoff, info, place, next?.trim() || undefined)
    return { ...handoff }
  }

  private async carryOn(handoff: Handoff, info: SessionInfo, place: GoalPlace, next?: string) {
    const session = handoff.from
    // The new conversation, once made: taken away again if what follows fails, so a retry
    // doesn't leave an empty one behind each time.
    let to: string | undefined
    try {
      let note: string
      try {
        note = (await answerWithContext(place.api, place === this.places.engine, session, notePrompt, async () => transcript(await messages(place.api, session), 0, await opening(place.api, session)))).trim()
      } catch (error: any) {
        throw new Error(`The handoff note couldn't be written: ${error?.message ?? error}`)
      }
      if (!note) throw new Error("The model wrote no handoff note.")
      // Someone wrote to it meanwhile: two agents in one folder would get in each other's way.
      if (await this.isActive(session, place)) throw new Error("The agent started working while the note was written. Hand it off once its turn ends.")
      const title = continuedTitle(info.title)
      const made = await place.api.request<{ data?: { id?: string } }>("POST", "/api/session", {
        title,
        location: { directory: info.directory },
        model: info.model,
        ...(info.agent ? { agent: info.agent } : {}),
        ...(info.permissions ? { permissions: info.permissions } : {}),
        // (In the mode the one it carries on was in: its rules come along made for it.)
        ...(info.metadata?.kuvo?.approval ? { metadata: { kuvo: { approval: info.metadata.kuvo.approval, ...(info.metadata.kuvo.applied ? { applied: info.metadata.kuvo.applied } : {}) } } } : {}),
      })
      to = made?.data?.id
      if (!to) throw new Error("The new conversation couldn't be started.")
      await place.api.request("POST", at(to) + "/synthetic", {
        text: `${handoffMarker}You're taking over from another conversation, "${info.title ?? "untitled"}". Its handoff note:\n\n${note}\n\n${next ? `What to do next: ${next}` : "Read it, say in a line what you'll do next, then wait for my next message."}`,
        description: `Carried on from “${line(info.title ?? "a conversation", 80)}”`,
      })
      const started = to
      to = undefined
      // Linked both ways, keeping what else their metadata says now (read again, as a client
      // may have changed it while the note was written).
      await this.link(place, started, { handoffFrom: session })
      await this.link(place, session, { handoffTo: started })
      Object.assign(handoff, { state: "done", to: started, title })
    } catch (error: any) {
      if (to) await place.api.request("DELETE", at(to)).catch(() => {})
      Object.assign(handoff, { state: "failed", error: String(error?.message ?? error) })
    }
    this.told(handoff)
  }

  private told(handoff: Handoff) {
    if (this.kept.get(handoff.from) !== handoff) return
    emit("kuvo.handoff", { sessionID: handoff.from, handoff: { ...handoff } })
  }

  private place(session: string): GoalPlace {
    return this.places.isBridge(session) ? this.places.bridge : this.places.engine
  }

  private async isActive(session: string, place: GoalPlace): Promise<boolean> {
    const answer = await place.api.request<{ data?: Record<string, unknown> }>("GET", "/api/session/active").catch(() => undefined)
    return Boolean(answer?.data && session in answer.data)
  }

  /** `kuvo.<…>` in a conversation's metadata, the rest kept as it is now. */
  private async link(place: GoalPlace, session: string, kuvo: Record<string, string>) {
    const metadata = (await sessionInfo(place.api, session).catch(() => undefined))?.metadata ?? {}
    await place.api.request("PATCH", at(session), { metadata: { ...metadata, kuvo: { ...(metadata.kuvo ?? {}), ...kuvo } } }).catch(() => {})
  }
}

// MARK: Routes (`/api/kuvo/handoff`, which a client reaches as `kuvo/agents/api/kuvo/handoff`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function handoffRoutes(handoffs: Handoffs | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!handoffs) return json({ message: "Handoffs aren't running on this computer." }, 503)
  const [session] = parts
  if (!session) return json({ message: "Not allowed" }, 405)
  if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
  try {
    if (method === "GET") {
      const handoff = handoffs.get(session)
      return handoff ? json({ data: handoff }) : json({ message: "That conversation hasn't been handed off." }, 404)
    }
    if (method !== "POST") return json({ message: "Not allowed" }, 405)
    const { next } = (await body()) ?? {}
    return json({ data: await handoffs.start(session, typeof next === "string" ? next : undefined) })
  } catch (error) {
    if (error instanceof HandoffError) return json({ message: error.message }, error.status)
    throw error
  }
}
