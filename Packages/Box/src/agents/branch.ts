// Branches ("Branch from here"): a new conversation with another one's words up to a message of
// yours, to try another way. Its place (the engine, or this bridge for the coding agents) makes
// the copy; the box marks where it came from (`kuvo.branchedFrom`), as a handoff's conversation
// is marked (`kuvo.handoffFrom`), so every client shows it under that one (PROTOCOL.md,
// "Branches").

import type { GoalPlaces } from "./goals"
import { sameJSON } from "../shared/json"
import { rewriteVia } from "./notes"
import { at, sessionInfo } from "./oneoff"

/** What says where a conversation came from (an agent's start_session marks `startedBy`; older
 * ones also `beside`; one carried on with the coding agents, `carriedFrom`), and where its handoff
 * went: a branch's own, not its source's. */
const origins = ["branchedFrom", "handoffFrom", "handoffTo", "startedBy", "beside", "carriedFrom"]
/** Its source's place in the lists, which a branch starts without: pinned or archived. */
const listed = ["kuvo.pinned", "kuvo.archived"]

export class BranchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A new conversation with `session`'s words before `before`, marked as branched from it: as its place answers it, with the mark. */
export async function branch(places: GoalPlaces, session: string, before: string): Promise<any> {
  const place = places.isBridge(session) ? places.bridge : places.engine
  const info = await sessionInfo(place.api, session).catch((error: any) => {
    throw new BranchError(error?.status === 404 ? 404 : 503, error?.status === 404 ? "There's no such conversation here." : "The conversation can't be reached now.")
  })
  if (info.parentID) throw new BranchError(409, "A subagent's conversation can't be branched. Branch the conversation it works for.")
  const made = await place.api.request<{ data?: any }>("POST", at(session) + "/fork", { before }).catch((error: any) => {
    if (error?.status === 404) throw new BranchError(404, "That message isn't in this conversation.")
    // What it refused, as it said; anything else, that it couldn't be reached.
    if (error?.status >= 400 && error?.status < 500) throw new BranchError(error.status, String(error?.message ?? error))
    throw new BranchError(503, "The new conversation couldn't be started.")
  })
  const copy = made?.data
  if (typeof copy?.id !== "string") throw new BranchError(503, "The new conversation couldn't be started.")
  // A copy carries its source's metadata on some places: where that one came from isn't this one's.
  // Marked in its turn (`notes.ts`), on its notes as they are then: what was written to it since it
  // was made stays, and only what it carried of those goes (as its place answered the copy, or as
  // its source has them, for a place whose answer leaves its metadata out).
  const carried = [copy.metadata ?? {}, info.metadata ?? {}] as Record<string, any>[]
  const from = (key: string, value: unknown, inKuvo: boolean) => carried.some((notes) => {
    const where = inKuvo ? notes.kuvo ?? {} : notes
    return key in where && sameJSON(value, where[key])
  })
  const marked = await rewriteVia(place.api, copy.id, (now) => {
    const metadata: Record<string, any> = { ...(now.metadata ?? {}) }
    for (const key of listed) if (key in metadata && from(key, metadata[key], false)) delete metadata[key]
    const kuvo: Record<string, any> = { ...(metadata.kuvo ?? {}) }
    for (const key of origins) if (key in kuvo && from(key, kuvo[key], true)) delete kuvo[key]
    return { metadata: { ...metadata, kuvo: { ...kuvo, branchedFrom: session } } }
  }).catch(() => null)
  // Unmarked, it's answered as it is: shown loose, as its list will show it.
  return marked ? { ...copy, metadata: marked.session.metadata } : copy
}

// MARK: Routes (`/api/kuvo/branch`, which a client reaches as `kuvo/agents/api/kuvo/branch`)

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

export async function branchRoutes(places: GoalPlaces | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!places) return json({ message: "Branches aren't running on this computer." }, 503)
  const [session] = parts
  if (!session || method !== "POST") return json({ message: "Not allowed" }, 405)
  if (!/^ses_[A-Za-z0-9_]+$/.test(session)) return json({ message: "There's no such conversation here." }, 404)
  const { before } = (await body()) ?? {}
  if (typeof before !== "string" || !before) return json({ message: "Say which message to branch before." }, 400)
  try {
    return json({ data: await branch(places, session, before) })
  } catch (error) {
    if (error instanceof BranchError) return json({ message: error.message }, error.status)
    throw error
  }
}
