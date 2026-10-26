// Handoffs ("/handoff" or "/handoff now write the tests"): a long conversation carried on in a
// fresh one, with room to work. The conversation's model writes a handoff note from inside it
// (what it's for, what's done, what's left, the files and decisions that matter); a new
// conversation in the same folder, on the same model and mode, starts with that note, and with
// what to do next when you said; the two are linked both ways. The box does it, here beside the
// engine, for the engine's sessions and the coding agents' alike (PROTOCOL.md, "Handoffs").

import { emit } from "./events"
import type { GoalPlaces } from "./goals"
import { transcript } from "./goals"
import { answerWithContext, at, line, messages, sessionInfo } from "./oneoff"

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

export interface Handoff {
  /** The conversation it was carried on from, and the new one. */
  from: string
  to: string
  title: string
}

const notePrompt = `Write a handoff note for a new agent who takes over this conversation's work in a fresh conversation, without its history. Cover, in this order and briefly:
- what the work is for, and what the person asked for;
- what's done, and how you know (tests run, what they printed);
- what's left, as next steps;
- the files, commands and decisions that matter, and anything to watch out for.
Write it as Markdown, under 400 words, addressed to the new agent. Don't run or change anything.`

export class Handoffs {
  /** Conversations being handed off now: one at a time each. */
  private underway = new Set<string>()

  constructor(private readonly places: GoalPlaces) {}

  async handoff(session: string, next?: string): Promise<Handoff> {
    if (this.underway.has(session)) throw new HandoffError(409, "It's being handed off already.")
    const place = this.places.isBridge(session) ? this.places.bridge : this.places.engine
    const onEngine = place === this.places.engine
    const info = await sessionInfo(place.api, session).catch((error: any) => {
      throw new HandoffError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
    })
    if (info.parentID) throw new HandoffError(409, "A subagent's conversation can't be handed off. Hand off the conversation it works for.")
    if (!info.directory || !info.model) throw new HandoffError(409, "That conversation has no model yet: there's nothing to hand off.")
    this.underway.add(session)
    try {
      let note: string
      try {
        note = (await answerWithContext(place.api, onEngine, session, notePrompt, async () => transcript(await messages(place.api, session), 0))).trim()
      } catch (error: any) {
        throw new HandoffError(503, `The handoff note couldn't be written: ${error?.message ?? error}`)
      }
      if (!note) throw new HandoffError(503, "The model wrote no handoff note.")
      const title = `${info.title ?? "Conversation"} (continued)`
      const made = await place.api.request<{ data?: { id?: string } }>("POST", "/api/session", {
        title,
        location: { directory: info.directory },
        model: info.model,
        ...(info.agent ? { agent: info.agent } : {}),
      })
      const to = made?.data?.id
      if (!to) throw new HandoffError(503, "The new conversation couldn't be started.")
      // Linked both ways, keeping what else their metadata says.
      await this.link(place.api, to, { handoffFrom: session })
      await this.link(place.api, session, { handoffTo: to }, info.metadata)
      const said = next?.trim()
      await place.api.request("POST", at(to) + "/synthetic", {
        text: `${handoffMarker}You're taking over from another conversation, "${info.title ?? "untitled"}". Its handoff note:\n\n${note}\n\n${said ? `What to do next: ${said}` : "Read it, say in a line what you'll do next, then wait for my next message."}`,
        description: `Carried on from “${line(info.title ?? "a conversation", 80)}”`,
      })
      const handoff = { from: session, to, title }
      emit("kuvo.handoff", { sessionID: session, ...handoff })
      return handoff
    } finally {
      this.underway.delete(session)
    }
  }

  /** `kuvo.<…>` in a conversation's metadata, the rest kept as it was. */
  private async link(api: GoalPlaces["engine"]["api"], session: string, kuvo: Record<string, string>, known?: Record<string, any>) {
    const metadata = known ?? (await sessionInfo(api, session).catch(() => undefined))?.metadata ?? {}
    await api.request("PATCH", at(session), { metadata: { ...metadata, kuvo: { ...(metadata.kuvo ?? {}), ...kuvo } } }).catch(() => {})
  }
}

// MARK: Routes (`/api/kuvo/handoff`, which a client reaches as `kuvo/agents/api/kuvo/handoff`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function handoffRoutes(handoffs: Handoffs | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!handoffs) return json({ message: "Handoffs aren't running on this computer." }, 503)
  const [session] = parts
  if (method !== "POST" || !session) return json({ message: "Not allowed" }, 405)
  if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
  try {
    const { next } = (await body()) ?? {}
    return json({ data: await handoffs.handoff(session, typeof next === "string" ? next : undefined) })
  } catch (error) {
    if (error instanceof HandoffError) return json({ message: error.message }, error.status)
    throw error
  }
}
