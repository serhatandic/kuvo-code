// The bridge's HTTP API: the engine's, the parts the app uses for a session, its models and its
// sign-in, answered for outside agents. Anything else is "not here", which the app takes as it
// takes an engine without that feature.

import { kinds, type AgentKind } from "./accounts"
import type { Account, Agent, SignInAttempt } from "./agent"
import type { Auto, AutoList } from "./auto"
import type { EngineLink } from "./engine"
import type { Roster } from "./roster"
import { emit, feed } from "./events"
import { goalRoutes, type GoalPlaces, type Goals } from "./goals"
import { sideQuestionRoutes, type SideQuestions } from "./btw"
import { branchRoutes } from "./branch"
import { handoffRoutes, type Handoffs } from "./handoff"
import { reviewRoutes, type Reviews } from "./reviews"
import { voiceRoutes, type VoiceWords } from "./voice"
import { limitsRoutes, type Limits } from "./limits"
import { isOutdated, type Maintenance } from "./maintenance"
import { refreshLoginPath } from "./proc"
import { setToolServer } from "./kuvotools"
import { noteToolServer } from "./fence"
import { newID } from "./ids"
import { BadRequest, NotFound, Sessions } from "./sessions"
import { artifactRoutes, notedRoute } from "./artifacts/routes"
import { carryRoutes, type Carrying } from "./carry"
import type { ArtifactStore } from "./artifacts/store"
import { linkRoutes } from "./groups/link"
import { peerRoutes, type PeerParts } from "./groups/post"
import { groupRoutes } from "./groups/routes"
import type { GroupRunner } from "./groups/runner"
import type { GroupStore } from "./groups/store"
import { shell, shellOutput, shells, stopShell } from "./shells"
import type { Integration, Model } from "./wire"

export interface Context {
  roster: Roster
  sessions: Sessions
  auto: Auto
  link: EngineLink
  password: string
  version: string
  /** The build it runs, as its bundle names it (none run from its sources). */
  build?: string | null
  /** The group chats that live on this computer (groups/runner.ts), and its part in those on your others; none where they don't run here. */
  groups?: { runner: GroupRunner; store: GroupStore; peers?: PeerParts }
  /** Restarts the agents' processes started before the box's sandbox was on, as you said to (main.ts). */
  restartOutside?: () => void
  /** Goals that conversations here and on the engine work toward (goals.ts). */
  goals?: Goals
  /** The record of what this computer's agents made (artifacts/store.ts); none where it couldn't start. */
  artifacts?: ArtifactStore
  /** A file a conversation got without a tool call naming it (artifacts/recorder.ts, `noted`). */
  noted?: (session: string, path: string, via: string) => Promise<boolean>
  /** The box's other keywords: side questions, handoffs and reviews (btw.ts, handoff.ts, reviews.ts). */
  sideQuestions?: SideQuestions
  handoffs?: Handoffs
  /** Where conversations are, for branching one (branch.ts). */
  places?: GoalPlaces
  reviews?: Reviews
  /** The project's words for voice input to listen for (voice.ts). */
  voice?: VoiceWords
  /** Conversations on their way to and from your other computers (carry.ts). */
  carrying?: Carrying
  /** Your plans' limits for each account here (limits.ts). */
  limits?: Limits
}

const attempts = new Map<string, { agent: Agent; attempt: SignInAttempt; created: number; expires: number }>()

/** Sign-ins still waiting, given up on (the bridge is stopping). */
export function cancelSignIns() {
  for (const pending of attempts.values()) pending.attempt.cancel()
  attempts.clear()
}

/** Whether a sign-in waits for you to finish it (a newer bridge waits for it: renewal.ts). */
export function signInsWaiting(): boolean {
  const now = Date.now()
  return [...attempts.values()].some((pending) => now < pending.expires && pending.attempt.status().status === "pending")
}

// Sign-ins left waiting past their time: stopped, with what they started.
setInterval(() => {
  for (const [id, pending] of attempts) {
    if (Date.now() < pending.expires + 60_000) continue
    pending.attempt.cancel()
    attempts.delete(id)
  }
}, 60_000).unref?.()

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
const located = (value: unknown) => json({ location: { directory: process.cwd() }, data: value })
const error = (status: number, message: string) => json({ message }, status)

/** What each agent's account looked like when last asked: a change means other models. */
const lastSeen = new Map<string, { installed: boolean; signedIn: boolean; label?: string }>()
/** Each agent's program's version and the newest, as last known. */
const lastMaintained = new Map<string, Maintenance>()

/**
 * Its version and the newest, if they come soon (checking may ask Homebrew or npm): what was
 * known before otherwise, and the account is said again once they do.
 */
async function maintainedSoon(agent: Agent, fresh: boolean): Promise<Maintenance | undefined> {
  if (!agent.maintenance) return undefined
  let answered = false
  const asked = agent.maintenance(fresh).then(
    (value) => {
      const changed = JSON.stringify(lastMaintained.get(agent.providerID)) !== JSON.stringify(value)
      lastMaintained.set(agent.providerID, value)
      if (answered && changed) emit("integration.updated", { integrationID: agent.providerID })
      return value
    },
    () => lastMaintained.get(agent.providerID),
  )
  const value = await Promise.race([asked, Bun.sleep(2_000).then(() => lastMaintained.get(agent.providerID))])
  answered = true
  return value
}

export async function integration(agent: Agent, fresh = false, auto?: Auto): Promise<Integration> {
  const [account, maintained] = await Promise.all([
    // A check that fails is its program's (each agent says itself when it isn't installed): it's
    // there, and says why, rather than offering its installer again.
    agent.account(fresh).catch((error): Account => ({ installed: true, signedIn: false, message: String(error?.message ?? error) })),
    maintainedSoon(agent, fresh),
  ])
  const before = lastSeen.get(agent.providerID)
  // Who's signed in, as last said (one not said yet, or not now, is no other account).
  const label = account.signedIn ? (account.label ?? before?.label) : undefined
  lastSeen.set(agent.providerID, { installed: account.installed, signedIn: account.signedIn, label })
  const changed = before && (before.installed !== account.installed || before.signedIn !== account.signedIn || (before.label !== undefined && before.label !== label))
  if (changed) {
    agent.forgetModels?.()
    emit("integration.updated", { integrationID: agent.providerID })
    // Signed in anew (or as someone else): Custom Auto tries it again.
    if (account.signedIn && auto?.release(agent.providerID)) emit("kuvo.auto.updated", {})
  }
  return {
    id: agent.providerID,
    name: agent.name,
    metadata: {
      source: "agent",
      agent: agent.id,
      // Which of your accounts with it: `default` is the agent's own sign-in.
      accountID: agent.instance.id,
      accountLabel: agent.instance.label,
      installed: account.installed,
      message: account.message,
      signInEnded: account.ended ?? false,
      // Its sign-in couldn't be checked just now, and is as it last said.
      unchecked: account.unchecked ?? false,
      account: account.label,
      install: agent.install,
      signsOut: Boolean(agent.signOut),
      // Its program's version, and the newest (an old Claude Code lists old models).
      version: maintained?.installed,
      latestVersion: maintained?.latest,
      outdated: maintained ? isOutdated(maintained) : false,
      updateCommand: maintained?.shown,
      updates: Boolean(agent.update && maintained?.command),
      // Whether its sign-in can finish on another device (`remote: true`).
      remoteSignIn: Boolean(agent.signIn && agent.signsInRemotely),
    },
    methods: agent.methods(),
    connections: account.signedIn
      ? [{ type: "agent", label: account.label, method: "oauth", status: { status: "connected", message: account.label ? `Signed in as ${account.label}` : account.unchecked ? "Couldn't check the sign-in just now" : "Signed in" } }]
      : [],
  }
}

async function models(agents: Agent[], hidden = false): Promise<Model[]> {
  const lists = await Promise.all(
    agents.map(async (agent) => {
      try {
        const account = await agent.account()
        return account.signedIn ? await agent.models(hidden ? { hidden } : undefined) : []
      } catch {
        return []
      }
    }),
  )
  return lists.flat()
}

function page<T extends { id: string }>(items: T[], url: URL): { data: T[]; cursor: { next?: string; previous?: string } } {
  // Items come newest first unless `order=asc`; the cursor is the last one sent.
  const limit = Number(url.searchParams.get("limit") ?? 100) || 100
  const cursor = url.searchParams.get("cursor")
  let start = 0
  if (cursor) {
    const after = cursor.split(":")[1]
    const index = items.findIndex((item) => item.id === after)
    start = index >= 0 ? index + 1 : items.length
  }
  const data = items.slice(start, start + limit)
  const order = cursor?.split(":", 1)[0] ?? url.searchParams.get("order") ?? "desc"
  const filter = url.searchParams.get("parentID") ?? cursor?.split(":")[2]
  const next = start + limit < items.length && data.length ? `${order}:${data[data.length - 1].id}${filter ? `:${filter}` : ""}` : undefined
  return { data, cursor: { next } }
}

export function handler(context: Context) {
  const expected = "Basic " + Buffer.from(`opencode:${context.password}`).toString("base64")
  const { sessions, roster, auto, link } = context
  const agentFor = (id: string) => roster.find(id)

  return async (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== expected) return error(401, "Unauthorized")
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    const method = request.method
    const body = async (): Promise<any> => (request.headers.get("content-type")?.includes("json") ? await request.json().catch(() => ({})) : {})
    try {
      if (parts[0] !== "api") return error(404, "Not found")
      const [, area, a, b, c, d, e] = parts

      if (area === "info") return json({ version: context.version, pid: process.pid, build: context.build ?? null })
      if (area === "event") return feed()

      // Sign-in
      if (area === "integration") {
        if (!a) {
          // `fresh`: asked anew (you refreshed, or came back to the app), with your shell's PATH read again.
          const fresh = url.searchParams.get("fresh") === "1"
          if (fresh) await refreshLoginPath()
          return located(await Promise.all(roster.all().map((agent) => integration(agent, fresh, auto))))
        }
        const agent = agentFor(a)
        if (!agent) return error(404, `No agent ${a}.`)
        if (!b) return located(await integration(agent, true, auto))
        if (b === "connect" && c === "oauth") {
          if (!d && method === "POST") {
            const { methodID, remote } = await body()
            if (!agent.signIn) return error(400, `${agent.name} signs in another way.`)
            // Its page opened on another device (a phone): only where that can finish.
            if (remote === true && !agent.signsInRemotely) return error(400, `Sign in to ${agent.name} on the computer it runs on: its page comes back there.`)
            const attempt = await agent.signIn(methodID, { remote: remote === true })
            const id = newID("att")
            const created = Date.now()
            // Long enough for a download first (Antigravity's agent) on a slow connection.
            const expires = created + 30 * 60_000
            attempts.set(id, { agent, attempt, created, expires })
            return located({ attemptID: id, url: attempt.url, instructions: attempt.instructions, mode: attempt.mode, acceptsCode: attempt.acceptsCode || undefined, userCode: attempt.userCode, time: { created, expires } })
          }
          const pending = d ? attempts.get(d) : undefined
          if (!pending) return error(404, "That sign-in is over. Start it again.")
          if (method === "GET" && !e) {
            const expired = Date.now() > pending.expires
            const status = expired ? { status: "expired" } : pending.attempt.status()
            if (expired) pending.attempt.cancel()
            if (status.status !== "pending") attempts.delete(d!)
            return located(status)
          }
          if (method === "POST" && e === "complete") {
            const { code } = await body()
            if (!pending.attempt.complete) return error(400, "This sign-in finishes in the browser.")
            await pending.attempt.complete(String(code ?? ""))
            return json({})
          }
          if (method === "DELETE") {
            pending.attempt.cancel()
            attempts.delete(d!)
            return json({})
          }
        }
        if (b === "connect" && c === "key" && method === "POST") {
          const { key } = await body()
          if (!agent.signInWithKey) return error(400, `${agent.name} doesn't take a key here.`)
          await agent.signInWithKey(String(key ?? "").trim())
          return json({})
        }
        // Its program updated through the installer that owns it; then what it lists anew.
        if (b === "update" && method === "POST") {
          if (!agent.update) return error(400, `Update ${agent.name} the way you installed it.`)
          const result = await agent.update()
          if (result.updated) {
            // Every account with it runs that program.
            for (const each of roster.all()) if (each.id === agent.id) each.programUpdated?.()
            emit("integration.updated", { integrationID: agent.providerID })
            emit("model.updated", {})
          }
          return json({ data: result })
        }
        // Its program installed with its maker's installer (the command `metadata.install` shows),
        // as you'd run it in Terminal; then what it lists.
        if (b === "install" && method === "POST") {
          if (!agent.installProgram) return error(400, `Install ${agent.name} the way its maker says.`)
          const result = await agent.installProgram()
          if (result.installed) {
            for (const each of roster.all()) if (each.id === agent.id) each.programUpdated?.()
            emit("integration.updated", { integrationID: agent.providerID })
            emit("model.updated", {})
          }
          return json({ data: result })
        }
        if (b === "disconnect" && method === "POST") {
          if (!agent.signOut) return error(400, `Sign out of ${agent.name} where you signed in.`)
          await agent.signOut()
          return json({})
        }
      }

      // Catalog
      if (area === "model") {
        if (a === "default") return located(null)
        // `hidden=1`: also those an agent still runs but keeps out of its picker (the box's
        // `kuvo/sessions/models` reads them; pickers don't).
        return located(await models(roster.all(), url.searchParams.get("hidden") === "1"))
      }
      if (area === "agent" || area === "command" || area === "skill" || area === "mcp") return located([])
      if (area === "provider") return located([])

      // Commands agents left running in the background (the bar over the composer)
      if (area === "shell") {
        const header = request.headers.get("x-opencode-directory")
        const directory = url.searchParams.get("directory") ?? (header ? decodeURIComponent(header) : undefined)
        if (!a && method === "GET") return located(shells(directory))
        if (a && !b && method === "GET") {
          const job = shell(a)
          return job ? located(job) : error(404, "No such command.")
        }
        if (a && b === "output" && method === "GET") {
          const limit = url.searchParams.get("limit")
          const read = await shellOutput(a, Number(url.searchParams.get("cursor") ?? 0) || 0, limit ? Number(limit) : undefined)
          return read ? located(read) : error(404, "No such command.")
        }
        if (a && !b && method === "DELETE") return (await stopShell(a)) ? json({}) : error(404, "No such command.")
      }

      // Sessions
      if (area === "session") {
        if (!a) {
          if (method === "POST") return json({ data: sessions.create(await body()) })
          const directory = url.searchParams.get("directory") ?? undefined
          // Later pages carry the first's filter in their cursor ("<order>:<id>:<parentID>").
          const under = url.searchParams.get("parentID") ?? url.searchParams.get("cursor")?.split(":")[2] ?? null
          const roots = sessions.list(directory, under === null || under === "" ? undefined : under === "null" ? null : under)
          const ordered = (url.searchParams.get("cursor")?.startsWith("asc") || url.searchParams.get("order") === "asc") ? [...roots].reverse() : roots
          return json(page(ordered, url))
        }
        if (a === "active") return json({ data: Object.fromEntries(sessions.active().map((id) => [id, { type: "busy" }])) })
        if (a === "background") return json({ data: sessions.background() })
        // A conversation from the engine, carried on here.
        if (a === "import" && method === "POST") return json({ data: sessions.importSession(await body()) })
        const id = a
        if (!b) {
          if (method === "GET") return json({ data: sessions.get(id) })
          if (method === "PATCH") {
            sessions.update(id, await body())
            return json({ data: sessions.get(id) })
          }
          if (method === "DELETE") {
            await sessions.remove(id)
            return json({})
          }
        }
        switch (b) {
          case "compact":
            if (method === "POST") return json({ data: sessions.compact(id) })
            break
          case "background":
            if (method === "DELETE") {
              await sessions.stopBackground(id)
              return json({})
            }
            break
          case "message": {
            const messages = sessions.messages(id)
            const asc = url.searchParams.get("order") === "asc" || url.searchParams.get("cursor")?.startsWith("asc")
            const ordered = asc ? messages : [...messages].reverse()
            if (c) {
              const found = messages.find((message) => message.id === c)
              return found ? json({ data: found }) : error(404, "No such message.")
            }
            return json(page(ordered, url))
          }
          case "inbox":
            if (method === "DELETE" && c) {
              sessions.cancelInput(id, c)
              return json({})
            }
            if (method === "PATCH" && c) {
              sessions.setDelivery(id, c, (await body()).delivery)
              return json({})
            }
            return json({ data: sessions.inbox(id) })
          case "prompt": {
            const input = await body()
            sessions.prompt(id, { id: input.id ?? newID("msg"), text: String(input.text ?? ""), files: input.files ?? [], delivery: input.delivery ?? "steer", metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : undefined })
            return json({})
          }
          case "fork":
            return json({ data: sessions.fork(id, String((await body()).before ?? "")) })
          case "revert":
            if (c === "stage" && method === "POST") return json({ data: await sessions.stageRevert(id, String((await body()).messageID ?? "")) })
            if (!c && method === "DELETE") {
              await sessions.clearRevert(id)
              return json({})
            }
            break
          case "shell":
            if (method !== "POST") break
            sessions.runShell(id, String((await body()).command ?? ""))
            return json({})
          case "synthetic": {
            const input = await body()
            sessions.synthetic(id, String(input.text ?? ""), typeof input.description === "string" ? input.description : undefined)
            return json({})
          }
          case "generate": {
            const input = await body()
            const prompt = String(input.prompt ?? "")
            if (!prompt.trim()) throw new BadRequest("Say what to write.")
            // `orAnother`: another agent you're signed in to may answer, where this one can't.
            // `model`: on that model of the session's own maker (Auto's reviewer, on its small one).
            const model = input.model && typeof input.model.providerID === "string" && typeof input.model.id === "string" ? { providerID: input.model.providerID, id: input.model.id } : undefined
            return json({ data: { text: await sessions.generate(id, prompt, { orAnother: input.orAnother === true, model }) } })
          }
          case "command": {
            // One of yours (Settings › Commands): what it says, with what you wrote after it. Any
            // other: the agent's own, as it takes them, typed.
            const input = await body()
            const name = String(input.name ?? "")
            const written = String(input.text ?? "")
            const template = name ? await link.commandTemplate(name, sessions.get(id).location.directory) : undefined
            const text = template ? expandCommand(template, written) : `/${name} ${written}`.trim()
            sessions.prompt(id, { id: newID("msg"), text, files: input.files ?? [], delivery: input.delivery ?? "steer" })
            return json({})
          }
          case "interrupt":
            return json({ interrupted: await sessions.interrupt(id, url.searchParams.get("resume") === "true") })
          case "model":
            sessions.selectModel(id, (await body()).model)
            return json({})
          case "agent":
            sessions.selectAgent(id, (await body()).agent)
            return json({})
          case "permission":
            // What the engine asks for everyone ("global": its MCP servers') isn't asked here.
            if (!c) return json({ data: id === "global" ? [] : sessions.permissions(id) })
            if (d === "reply") {
              const { decision, message } = await body()
              sessions.replyPermission(id, c, decision, typeof message === "string" ? message : undefined)
              return json({})
            }
            break
          case "form":
            if (!c) return json({ data: id === "global" ? [] : sessions.forms(id) })
            if (d === "reply") {
              sessions.replyForm(id, c, (await body()).answer ?? {})
              return json({})
            }
            if (method === "DELETE") {
              sessions.replyForm(id, c, null, url.searchParams.get("message") ?? undefined)
              return json({})
            }
            break
          case "view": {
            const { idle } = await body()
            sessions.view(id, Number(idle) || Date.now())
            return json({})
          }
          case "diff":
            return json({ data: [] })
        }
      }

      // Your accounts with the agents: adding one (it then signs in as any does), naming one, removing one.
      if (area === "kuvo" && a === "accounts") {
        if (method === "POST" && !b) {
          const { agent, label } = await body()
          if (!kinds.includes(agent)) return error(400, "That isn't one of the coding agents.")
          const record = roster.accounts.add(agent as AgentKind, label)
          roster.sync()
          const added = roster.all().find((each) => each.instance.id === record.id && each.id === agent)!
          emit("integration.updated", { integrationID: added.providerID })
          return json({ data: { providerID: added.providerID } })
        }
        const target = b ? roster.find(b) : undefined
        if (!target) return error(404, "No such account.")
        if (target.instance.id === "default") return error(400, "That's the agent's own sign-in: sign out of it where you signed in.")
        if (method === "PATCH") {
          roster.accounts.rename(target.providerID, (await body()).label)
          roster.sync()
          emit("integration.updated", { integrationID: target.providerID })
          return json({})
        }
        if (method === "DELETE") {
          sessions.forgetProvider(target.providerID)
          await target.removeAccount?.().catch(() => {})
          target.shutdown?.()
          roster.accounts.remove(target.providerID)
          roster.sync()
          emit("integration.updated", { integrationID: target.providerID })
          emit("model.updated", {})
          return json({})
        }
      }

      // Where Kuvo Code's own tools are (the app says each time they start), for every agent here.
      // The group chats that live on this machine.
      // You said to restart the agents started before the box's sandbox was on (`kuvo/sandbox/restart`, from the box's link).
      if (area === "kuvo" && a === "sandbox" && b === "restart" && !c && method === "POST") {
        context.restartOutside?.()
        return json({})
      }
      if (area === "kuvo" && a === "carry") return await carryRoutes(context.carrying, method, parts.slice(3), body)
      if (area === "kuvo" && a === "goals") return await goalRoutes(context.goals, method, parts.slice(3), body)
      if (area === "kuvo" && a === "btw") return await sideQuestionRoutes(context.sideQuestions, method, parts.slice(3), body)
      if (area === "kuvo" && a === "handoff") return await handoffRoutes(context.handoffs, method, parts.slice(3), body)
      if (area === "kuvo" && a === "branch") return await branchRoutes(context.places, method, parts.slice(3), body)
      if (area === "kuvo" && a === "reviews") return await reviewRoutes(context.reviews, method, parts.slice(3), body)
      if (area === "kuvo" && a === "voice") return await voiceRoutes(context.voice, method, parts.slice(3))
      if (area === "kuvo" && a === "limits") return await limitsRoutes(context.limits, method, parts.slice(3))
      if (area === "kuvo" && a === "groups") return await groupRoutes(context.groups?.runner, context.groups?.store, method, parts.slice(3), body)
      // The same, as a client reads and changes them (`kuvo/groups`, which the box's link passes on).
      if (area === "kuvo" && a === "link" && b === "groups") return await linkRoutes(context.groups?.runner, context.groups?.store, method, parts.slice(4), body, request.signal)
      // What this computer's agents made (`kuvo/artifacts`, which the box's link passes on).
      if (area === "kuvo" && a === "artifacts" && b === "noted" && !c) return await notedRoute(context.noted, method, body)
      if (area === "kuvo" && a === "link" && b === "artifacts") return await artifactRoutes(context.artifacts, method, parts.slice(4), url.searchParams, body, request.signal)
      // Group chats across your computers, as the box's link carries their mail (groups/post.ts).
      if (area === "kuvo" && a === "peers") return await peerRoutes(context.groups?.peers, method, parts.slice(3), body, request.signal)

      if (area === "kuvo" && a === "tools" && method === "PUT") {
        const { url: address, token, timeout } = await body()
        setToolServer(typeof address === "string" && address && typeof token === "string" ? { url: address, token, timeout: Number(timeout) || 960_000 } : undefined)
        noteToolServer(typeof address === "string" && typeof token === "string" ? address : undefined)
        return json({})
      }

      // Where the engine is (the app says each time it starts), for its models in sessions here.
      if (area === "kuvo" && a === "engine" && method === "PUT") {
        const { url: address, password } = await body()
        link.configure(typeof address === "string" && address ? address : undefined, typeof password === "string" ? password : undefined)
        return json({})
      }

      // Auto: your list of models, and the ones held back at a limit until it resets.
      if (area === "kuvo" && a === "auto") {
        if (b === "limits" && method === "DELETE") {
          // One account's (you signed in to it again, or switched to another of it), or all.
          const provider = url.searchParams.get("provider")
          if (provider) auto.release(provider)
          else auto.clearLimits()
          emit("kuvo.auto.updated", {})
          return json({})
        }
        if (!b && method === "PUT") {
          const { entries, lists } = await body()
          // Your lists; or, as before there were lists, the first one's models.
          // (As they were given: each entry under the id it was kept by.)
          if (Array.isArray(lists)) {
            try {
              auto.setLists(await sessions.asKept(lists))
            } catch (problem) {
              return error(400, (problem as Error).message)
            }
          } else if (Array.isArray(entries)) auto.set(((await sessions.asKept([{ ...auto.all()[0], entries }]))[0] as AutoList).entries)
          else return error(400, "Send the lists, or the first one's entries.")
          emit("kuvo.auto.updated", {})
        }
        // (Each as the models it names: one named by another id it's known by, as that model, once.)
        if (!b && (method === "GET" || method === "PUT")) return json({ data: { entries: await sessions.autoEntries(), lists: await sessions.autoLists(), limits: auto.limits() } })
      }

      if (area === "experimental" && a === "session" && b) {
        const id = b
        // Its instruction entries, as the engine lists them; one changed or taken away.
        if (c === "instructions" && d === "entries" && !e && method === "GET") return json({ data: sessions.instructionEntries(id) })
        if (c === "instructions" && d === "entries" && e && (method === "PUT" || method === "DELETE")) {
          sessions.setInstruction(id, e, method === "DELETE" ? undefined : String((await body()).value ?? ""))
          return json({})
        }
        if (c === "wait") {
          while (sessions.active().includes(id)) await Bun.sleep(200)
          return json({})
        }
      }

      return error(404, "Not available for this agent.")
    } catch (caught) {
      if (caught instanceof NotFound) return error(404, caught.message)
      if (caught instanceof BadRequest) return error(400, caught.message)
      return error(500, caught instanceof Error ? caught.message : String(caught))
    }
  }
}

/**
 * A command's text with what you wrote after its name: in place of $ARGUMENTS (and $1, $2… for
 * its words), as the engine fills it in; after it, when it names none.
 */
export function expandCommand(template: string, written: string): string {
  const all = written.trim()
  const words = all ? all.split(/\s+/) : []
  const named = /\$ARGUMENTS|\$[1-9]/.test(template)
  // In one pass, so what you wrote is never filled in again: $1, $2… a word each, the highest
  // taking the rest; $ARGUMENTS all of it, as written.
  const highest = Math.max(0, ...[...template.matchAll(/\$([1-9]\d*)/g)].map((match) => Number(match[1])))
  const filled = template.replace(/\$ARGUMENTS|\$([1-9]\d*)/g, (_, index?: string) => {
    if (index === undefined) return all
    return Number(index) === highest ? words.slice(highest - 1).join(" ") : (words[Number(index) - 1] ?? "")
  })
  return named || !all ? filled.trim() : `${filled.trim()}\n\n${all}`
}
