// The bridge's writers of a conversation's notes on the engine or on this bridge, through their API
// (`../shared/session-notes.ts`): each in its turn on the conversation in this process, read just
// before it writes, changing only what it owns. (Its writers of its own conversations' notes in
// place, `sessions.ts`, change them at once, with nothing in between.)

import { rewriteSession, type NotesPlace, type Rewritten, type SessionChange } from "../shared/session-notes"
import type { Requester } from "./groups/api"

/** A conversation as its place answers it, as far as its notes go. */
export interface NotedSession {
  id: string
  metadata?: Record<string, any>
  [more: string]: unknown
}

const at = (id: string) => "/api/session/" + encodeURIComponent(id)

/** The conversations `api` answers for, as a writer of their notes reads and writes them. (Their
 * IDs are the engine's and this bridge's alike, never the same: one turn per conversation.) */
export function notesPlace(api: Requester): NotesPlace<NotedSession> {
  return {
    name: "bridge",
    read: async (id) => {
      const data = (await api.request<{ data?: NotedSession }>("GET", at(id)))?.data
      return typeof data?.id === "string" ? data : null
    },
    write: (id, change) => api.request("PATCH", at(id), change),
  }
}

/** Conversation `id` changed in its turn (`rewriteSession`), through `api`. */
export const rewriteVia = (api: Requester, id: string, change: (session: NotedSession) => SessionChange | null | undefined): Promise<Rewritten<NotedSession> | null> =>
  rewriteSession(notesPlace(api), id, change)
