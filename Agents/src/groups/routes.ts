// The group chats on this machine, for the Mac and the phone (`/api/kuvo/groups`, behind the
// bridge's password): read them, bring one here or let it go (a move), and take part.

import type { GroupRunner } from "./runner"
import { isGroup, isMeeting, isMessages, version, type GroupStore } from "./store"
import { planMeeting } from "./time"

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const error = (status: number, message: string) => json({ message }, status)


export async function groupRoutes(runner: GroupRunner | undefined, store: GroupStore | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  if (!runner || !store) return error(404, "Group chats run on the Mac here.")
  const [id, action] = parts
  if (!id) {
    if (method === "GET") return json({ version, data: runner.list() })
    return error(405, "Not allowed")
  }
  // What the Mac says for every chat here: personalities, Ask First, what's denied, the time zone.
  if (id === "settings" && method === "PUT") {
    const value = await body()
    const before = store.settings()
    store.writeSettings({
      personalities: value?.personalities && typeof value.personalities === "object" ? value.personalities : {},
      identityNote: typeof value?.identityNote === "string" ? value.identityNote : "",
      askFirst: value?.askFirst === true,
      denies: Array.isArray(value?.denies) ? value.denies : [],
      timeZone: typeof value?.timeZone === "string" ? value.timeZone : undefined,
      locale: typeof value?.locale === "string" ? value.locale : undefined,
    })
    const after = store.settings()
    if (JSON.stringify([before?.askFirst, before?.denies]) !== JSON.stringify([after?.askFirst, after?.denies])) runner.rulesChanged()
    return json({})
  }
  if (!/^grp_[a-z0-9]+$/.test(id)) return error(404, "No such chat.")
  if (!action) {
    if (method === "GET") {
      const chat = runner.get(id)
      return chat ? json({ version, data: chat }) : error(404, "No such chat.")
    }
    if (method === "PUT") {
      const { group, messages, status, replace } = await body()
      if (!isGroup(group, id) || !isMessages(messages ?? [])) return error(400, "That isn't a group chat.")
      if (!runner.put(group, messages ?? [], status === "active" ? "active" : "held", replace === true)) return error(409, "That chat is here already.")
      return json({ data: runner.get(id) })
    }
    if (method === "PATCH") {
      const edits = await body()
      // A meeting as a phone sets it up (`meetingPlan`): worked out here, on your clock.
      if (edits && "meetingPlan" in edits) {
        if (edits.meetingPlan === null) {
          edits.meeting = null
        } else {
          const planned = planMeeting(edits.meetingPlan, runner.get(id)?.group.meeting, store.settings()?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
          if (typeof planned === "string") return error(400, planned)
          edits.meeting = planned
        }
        delete edits.meetingPlan
      }
      // One moving: nothing changes but that you've looked at it (what changed would be left behind).
      if (runner.get(id)?.status === "held" && Object.keys(edits ?? {}).some((key) => key !== "viewed")) return error(409, "That chat is moving.")
      if (edits?.meeting !== undefined && edits.meeting !== null && !isMeeting(edits.meeting)) return error(400, "That isn't a meeting.")
      if (edits?.members !== undefined && !(Array.isArray(edits.members) && edits.members.every((member: unknown) => typeof member === "string"))) return error(400, "Those aren't bots.")
      return (await runner.update(id, edits ?? {})) ? json({ data: runner.get(id) }) : error(404, "No such chat.")
    }
    if (method === "DELETE") {
      // One moving is let go of where it was once it's there (`release`), never deleted.
      if (runner.get(id)?.status === "held") return error(409, "That chat is moving.")
      return (await runner.delete(id)) ? json({}) : error(404, "No such chat.")
    }
    return error(405, "Not allowed")
  }
  if (method !== "POST") return error(405, "Not allowed")
  const found = runner.get(id)
  if (!found) return error(404, "No such chat.")
  switch (action) {
    case "activate":
      runner.activate(id)
      return json({ data: runner.get(id) })
    case "hold":
      return json({ data: runner.hold(id) })
    case "release":
      runner.release(id)
      return json({})
  }
  if (found.status !== "active") return error(409, "That chat is moving.")
  switch (action) {
    case "send": {
      const { text, named } = await body()
      const message = typeof text === "string" ? runner.send(id, text, typeof named === "string" ? named : undefined) : undefined
      return message ? json({ data: message }) : error(400, "Nothing to send.")
    }
    case "stop":
      runner.stop(id)
      return json({})
    case "keep-going":
      runner.keepGoing(id)
      return json({})
    case "undo": {
      const { message } = await body()
      const text = typeof message === "string" ? runner.undo(id, message) : undefined
      return text === undefined ? error(404, "No such message.") : json({ data: { text } })
    }
    case "start-work": {
      const { wrapUp } = await body()
      if (typeof wrapUp === "string") runner.startWork(wrapUp, id)
      return json({})
    }
  }
  return error(404, "Not found")
}
