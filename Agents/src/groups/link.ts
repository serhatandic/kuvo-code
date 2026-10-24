// This computer's group chats as a client reads and changes them (`kuvo/groups` in PROTOCOL.md):
// the phone, and the Mac's window, in the shapes they show, with every rule of what can be made or
// changed decided here, so a client holds none of its own. The box's link (`kuvo-link.js` on a
// machine) passes them on as they are, at `/api/kuvo/link/groups…`.

import { subscribe } from "../events"
import { trim, type GroupMessage } from "./rules"
import { groupRoutes } from "./routes"
import type { GroupRunner } from "./runner"
import type { PeerBot } from "./peer"
import type { GroupStore, MachineBot } from "./store"
import { planMeeting } from "./time"

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const message = (status: number, text: string) => json({ message: text }, status)

/** Times as a client takes them: seconds since 1970. */
const seconds = (text?: string) => {
  const time = Date.parse(text ?? "")
  return Number.isFinite(time) ? time / 1000 : undefined
}
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
/** A name as one line of plain text, as a name field shows it. */
const plainName = (text: unknown) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
const newGroupID = () => "grp_" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("")

/** What a client hears of an action the runner didn't take: moving (409), not answering now (503), or no such chat or message (404). */
const failed = (status: number) => (status === 409 ? 409 : status >= 500 ? 503 : 404)

/** A message as a client shows it: its times in seconds, without the block naming agents (the box's own record of who you named) nor, in a list, what each bot did on its turn. */
export function clientMessage(message: GroupMessage | undefined, withSteps = true) {
  if (!message) return undefined
  const { named: _named, steps, time, tasks, ...rest } = message as GroupMessage & { named?: string }
  return {
    ...rest,
    time: seconds(time),
    ...(withSteps && steps ? { steps } : {}),
    ...(tasks
      ? {
          tasks: tasks.map(({ started, finished, ...task }) => ({ ...task, ...(started ? { started: seconds(started) } : {}), ...(finished ? { finished: seconds(finished) } : {}) })),
        }
      : {}),
  }
}

/** A bot as a chat lists it: who it is, how it looks, its own conversation and folder. */
function member(bot: MachineBot) {
  return { id: bot.id, name: bot.name, look: bot.look, session: bot.sessionID, directory: bot.directory, agents: bot.agents }
}

/** A bot on another of your computers, as a chat here lists it: who it is, its own conversation, and the computer it's on (`computer`, as its notes name it). */
function memberThere(bot: PeerBot, runner: GroupRunner) {
  return { id: bot.id, name: bot.name, ...(bot.session ? { session: bot.session } : {}), agents: false, computer: runner.peers?.name(bot.box) ?? "another computer" }
}

/** Who can be in a chat here: this computer's bots, and those of your others that take a chat's turns (`groups.seats`). */
function bots(runner: GroupRunner, store: GroupStore) {
  const here = store.allBots().sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.name.localeCompare(b.name))
  const ids = new Set(here.map((bot) => bot.id))
  const there = (runner.peers?.bots() ?? []).filter((bot) => !ids.has(bot.id) && runner.peers?.takesSeats(bot.box))
  return { here, there }
}

/** A chat's bot as a client lists it, wherever it lives; undefined for one nobody knows now. */
function anyMember(id: string, runner: GroupRunner, store: GroupStore) {
  const bot = store.bot(id)
  if (bot) return member(bot)
  const there = runner.peers?.bots().find((each) => each.id === id)
  return there ? memberThere(there, runner) : undefined
}

/** The chats here, as a client lists them: only those that live here now (one moving here isn't, yet). */
function list(runner: GroupRunner, store: GroupStore) {
  const groups = runner
    .list()
    .filter((chat) => chat.status === "active")
    .map(({ group, state, said, fromBot }) => ({
      id: group.id,
      name: group.name,
      purpose: group.purpose,
      members: group.members.flatMap((id) => anyMember(id, runner, store) ?? []),
      speaking: state.speaking,
      discussing: Boolean(state.discussing),
      paused: Boolean(state.paused),
      unread: Boolean(fromBot && (!group.viewed || Date.parse(fromBot.time) > Date.parse(group.viewed))),
      last: clientMessage(said, false),
      meeting: group.meeting ? { ...group.meeting, next: seconds(group.meeting.next) } : undefined,
    }))
  return { groups }
}

/** One chat as a client follows it: its latest messages and its talk; undefined while it isn't here (gone, or moving). */
function chat(runner: GroupRunner, id: string) {
  const found = runner.get(id)
  if (!found || found.status !== "active") return undefined
  const { messages, state } = found
  return {
    messages: messages.slice(-300).map((each) => clientMessage(each)),
    speaking: state.speaking,
    discussing: Boolean(state.discussing),
    paused: Boolean(state.paused),
    ...(state.activity?.length ? { activity: state.activity } : {}),
  }
}

/**
 * A line of JSON now, and another each time it changes, as the runner says what changed (no
 * polling): for one chat, a line whose messages are as they were leaves them out.
 */
function following(read: () => Record<string, unknown> | undefined, oneChat: boolean, signal?: AbortSignal): Response {
  const encoder = new TextEncoder()
  let stop = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = ""
      let lastMessages: string | undefined
      const look = () => {
        const now = read()
        if (!now) {
          stop()
          try {
            controller.close()
          } catch {}
          return
        }
        const line = JSON.stringify(now)
        if (line === last) return
        const messages = oneChat ? JSON.stringify(now.messages) : undefined
        const { messages: _messages, ...state } = now
        last = line
        try {
          controller.enqueue(encoder.encode((oneChat && messages === lastMessages ? JSON.stringify(state) : line) + "\n"))
        } catch {
          stop()
        }
        lastMessages = messages
      }
      const unsubscribe = subscribe((event) => {
        if (event.type.startsWith("kuvo.group.")) look()
      })
      const onAbort = () => stop()
      stop = () => {
        unsubscribe()
        signal?.removeEventListener("abort", onAbort)
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      look()
    },
    cancel() {
      stop()
    },
  })
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } })
}

/** The runner's own answer to a step, read. */
async function ask(runner: GroupRunner, store: GroupStore, method: string, parts: string[], body: unknown = {}) {
  const response = await groupRoutes(runner, store, method, parts, async () => body)
  const value: any = await response.json().catch(() => ({}))
  return { status: response.status, value }
}

/** Who can be in a chat that lives here: every bot here, the first made first, then those of your other computers that take a chat's turns. */
export function joinable(runner: GroupRunner, store: GroupStore) {
  const { here, there } = bots(runner, store)
  return [...here.map(member), ...there.map((bot) => memberThere(bot, runner))]
}

/**
 * `/api/kuvo/link/groups[/<id>[/<action>]]`, as `kuvo/groups` answers a client (PROTOCOL.md). A
 * computer whose group chats don't run here answers 404.
 */
export async function linkRoutes(runner: GroupRunner | undefined, store: GroupStore | undefined, method: string, parts: string[], body: () => Promise<any>, signal?: AbortSignal): Promise<Response> {
  if (!runner || !store) return json({}, 404)
  const [id, action] = parts
  // Who can be in a chat here: its own bots, and your other computers' that take a chat's turns.
  const here = () => {
    const { here, there } = bots(runner, store)
    return new Set([...here, ...there].map((bot) => bot.id))
  }

  if (!id || id === "events") {
    if (method === "GET") return id ? following(() => list(runner, store), false, signal) : json(list(runner, store))
    if (method === "POST" && !id) return await make(runner, store, await body().catch(() => undefined), here())
    return json({}, 405)
  }
  if (id === "joinable") return method === "GET" ? json({ bots: joinable(runner, store) }) : json({}, 405)
  if (!/^grp_[a-z0-9]+$/.test(id)) return json({}, 404)

  if (method === "GET" && (!action || action === "events")) {
    if (!chat(runner, id)) return json({}, 404)
    return action ? following(() => chat(runner, id), true, signal) : json(chat(runner, id))
  }
  // Its name, purpose, bots or meeting, as Edit Group Chat changes them: a meeting as you set it up,
  // worked out here, on your clock.
  if (method === "PATCH" && !action) {
    const given = await body().catch(() => undefined)
    if (!given || typeof given !== "object" || Array.isArray(given)) return message(400, "That isn’t a change to a group chat.")
    const edits: Record<string, unknown> = {}
    if ("name" in given) {
      const name = plainName(given.name)
      if (!name) return message(400, "A group chat needs a name.")
      edits.name = name
    }
    if ("purpose" in given) edits.purpose = typeof given.purpose === "string" && given.purpose.trim() ? given.purpose.trim() : null
    if ("members" in given) {
      if (!Array.isArray(given.members) || !given.members.every((each: unknown) => typeof each === "string")) return message(400, "Those aren’t bots.")
      const members = [...new Set<string>(given.members)]
      if (members.length < 2) return message(400, "A group chat needs at least two bots.")
      const bots = here()
      const missing = members.find((each) => !bots.has(each))
      if (missing) return message(404, `There’s no bot “${missing}”.`)
      edits.members = members
    }
    if ("meeting" in given) edits.meetingPlan = given.meeting
    const asked = await ask(runner, store, "PATCH", [id], edits)
    if (asked.status !== 200) return message([400, 404, 409].includes(asked.status) ? asked.status : 503, asked.value?.message ?? "The group chat couldn’t be changed.")
    return json({ group: list(runner, store).groups.find((each) => each.id === id) ?? null })
  }
  // Deleted, as Delete Group Chat deletes it: its messages and seats go, and its bots forget it.
  // Not one moving; one gone already is as good as deleted.
  if (method === "DELETE" && !action) {
    const asked = await ask(runner, store, "DELETE", [id])
    if (asked.status === 200 || (asked.status === 404 && asked.value?.message === "No such chat.")) return json({})
    if (asked.status === 409) return message(409, "That chat is moving. Try again once it’s there.")
    return message(503, asked.value?.message ?? "The group chat couldn’t be deleted. Try again in a moment.")
  }
  if (method !== "POST" || action === "events") return json({}, 405)
  const given: any = (await body().catch(() => undefined)) ?? {}
  let asked: { status: number; value: any }
  switch (action) {
    case undefined:
      if (typeof given.text !== "string" || !trim(given.text)) return json({}, 400)
      asked = await ask(runner, store, "POST", [id, "send"], { text: given.text, ...(typeof given.named === "string" ? { named: given.named } : {}) })
      break
    case "stop":
    case "keep-going":
      asked = await ask(runner, store, "POST", [id, action])
      break
    case "viewed":
      asked = await ask(runner, store, "PATCH", [id], { viewed: stamp() })
      break
    case "undo": {
      if (typeof given.message !== "string") return json({}, 404)
      asked = await ask(runner, store, "POST", [id, "undo"], { message: given.message })
      if (asked.status !== 200) return json({}, failed(asked.status))
      return json({ text: asked.value?.data?.text ?? "" })
    }
    case "start":
      if (typeof given.message !== "string") return json({}, 404)
      asked = await ask(runner, store, "POST", [id, "start-work"], { wrapUp: given.message })
      break
    default:
      return json({}, 404)
  }
  return json({}, asked.status === 200 ? 200 : failed(asked.status))
}

/** A group chat made here, as New Group Chat makes one: of this computer's bots, with its meeting worked out here. */
async function make(runner: GroupRunner, store: GroupStore, given: any, here: Set<string>): Promise<Response> {
  if (!given || typeof given !== "object" || Array.isArray(given)) return message(400, "That isn’t a group chat to make.")
  const name = plainName(given.name)
  if (!name) return message(400, "A group chat needs a name.")
  const members = [...new Set<string>(Array.isArray(given.members) ? given.members.filter((each: unknown) => typeof each === "string") : [])]
  if (members.length < 2) return message(400, "A group chat needs at least two bots.")
  const missing = members.find((each) => !here.has(each))
  if (missing) return message(404, `There’s no bot “${missing}”.`)
  const purpose = typeof given.purpose === "string" && given.purpose.trim() ? given.purpose.trim() : undefined
  let meeting
  if (given.meeting !== undefined && given.meeting !== null) {
    const planned = planMeeting(given.meeting, undefined, store.settings()?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
    if (typeof planned === "string") return message(400, planned)
    meeting = planned
  }
  const id = newGroupID()
  const now = stamp()
  if (!runner.put({ id, name, ...(purpose ? { purpose } : {}), members, seats: {}, heard: {}, created: now, viewed: now, ...(meeting ? { meeting } : {}) }, [], "active", false)) {
    return message(409, "That chat is here already.")
  }
  return json({ group: list(runner, store).groups.find((each) => each.id === id) ?? null }, 201)
}
