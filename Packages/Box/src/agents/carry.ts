// A session with the coding agents on its way to another of your computers (PROTOCOL.md, `kuvo/moves`):
// the box's link drives the move, and asks here for what only the bridge knows: its sessions' records,
// and where each agent keeps its own conversation.
//
// Leaving, `pack` copies into a folder of the move's: the session and those under it (`sessions/<id>`,
// the store's three files as they are), and for each agent that ran it, its own conversation and its
// memory (`lanes/<n>/conversation`, `lanes/<n>/memory`), with a manifest (`carry.json`) of each file's
// size and hash. Arriving, `place` checks every file against the manifest, puts them where this
// computer's agents keep them, hashes them again there, and only then adds the sessions; what it
// replaced it keeps until the switch, so `undo` leaves everything as it found it.
//
// Copying an agent's own conversation is a step of its own (`conversation: false` leaves it out): a
// lane that can't be carried, or one left out, gets the session's record alone, and its agent is handed
// what came before (16 KB, handover.ts) as it first runs there, as it is whenever a conversation's gone.

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path"
import { baseProvider, parseProvider, type AgentKind } from "./accounts"
import type { Agent, ConversationFiles } from "./agent"
import { NotFound, type Sessions } from "./sessions"
import type { Record_, Store } from "./store"
import type { Session } from "./wire"

/** A pack refused because its conversation is in a turn now (another try may well go). */
export const WORKING = 423

/** Why a session can't go, or come, in words that may be shown. */
export class CantCarry extends Error {
  constructor(message: string, readonly status = 409) {
    super(message)
  }
}

/** A file in the manifest: where it is under the folder, its size and hash. */
interface CarriedFile {
  path: string
  size: number
  sha256: string
}

/** What came of one agent's own conversation in a session. */
export interface CarriedLane {
  /** Its account, as `claude-code` or `claude-code@<id>`. */
  provider: string
  session: string
  /** `files`: its own conversation goes; `handover`: its next run starts over, with what came before. */
  how: "files" | "handover"
  /** Why not its files, when it isn't. */
  why?: "not-carried" | "left-out" | "missing" | "unknown-agent"
  /** Each item's name, as the agent keeps it on any computer. */
  items: string[]
  memory: boolean
  files: number
  bytes: number
}

/** The manifest (`carry.json`). */
export interface Manifest {
  root: string
  /** Each session, and (`model`) the model its own is an alias for where it was packed: it runs
   * on that one where it goes, as it did, whatever the alias stands for there. */
  sessions: { id: string; parentID?: string; metadata?: Record<string, unknown>; model?: { providerID: string; id: string } }[]
  lanes: (CarriedLane & { list: CarriedFile[] })[]
  /** The sessions' own files, by hash. */
  records: CarriedFile[]
  digest: string
}

/** What this computer keeps of a lane it sent, to clear later (`remove`): never sent anywhere. */
export interface LeftOf {
  provider: string
  paths: string[]
  memory?: string
  /** The folder its session worked in: another session here still in it shares that memory. */
  directory: string
}

async function hashOf(file: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

/** Each plain file under `from` (itself, if it's one), by its path from there; `link` says what it found that isn't. */
async function plainFiles(from: string, link: (path: string) => Error, at = ""): Promise<{ path: string; size: number }[]> {
  const whole = at ? join(from, at) : from
  const kind = await lstat(whole)
  if (kind.isFile()) return [{ path: at, size: kind.size }]
  if (!kind.isDirectory()) throw link(whole)
  const files: { path: string; size: number }[] = []
  for (const name of (await readdir(whole)).sort()) files.push(...(await plainFiles(from, link, at ? join(at, name) : name)))
  return files
}

const digestOf = (records: CarriedFile[], lanes: { provider: string; session: string; how: string; list: CarriedFile[] }[], said: string[] = []): string => {
  const hash = createHash("sha256")
  for (const record of records) hash.update(`r ${record.path} ${record.size} ${record.sha256}\n`)
  for (const each of said) hash.update(`s ${each}\n`)
  for (const lane of lanes) {
    hash.update(`l ${lane.provider} ${lane.session} ${lane.how}\n`)
    for (const file of lane.list) hash.update(`f ${file.path} ${file.size} ${file.sha256}\n`)
  }
  return hash.digest("base64url")
}

/** A path from the bundle: under its folder, with nothing that climbs out of it. */
const safeWithin = (name: string): boolean => Boolean(name) && !isAbsolute(name) && normalize(name) === name && !name.split(sep).includes("..")

const ID = /^ses_[A-Za-z0-9]{1,60}$/
/** Waits for what closing an agent's process writes last, this long at most. */
const QUIET = { still: 400, most: 5_000 }

export class Carrying {
  constructor(
    private readonly sessions: Sessions,
    private readonly store: Store,
    /** The agent that runs a provider's models here, its accounts' and the engine's. */
    private readonly agentOf: (provider: string) => Agent | undefined,
    /** Its accounts with an agent here, its own sign-in first. */
    private readonly accountsOf: (kind: AgentKind) => Agent[],
  ) {}

  /** A session and those under it, root first. */
  private family(root: string): Record_[] {
    const out: Record_[] = []
    const next = [root]
    while (next.length) {
      const id = next.shift()!
      const record = this.store.get(id)
      if (!record) {
        if (id === root) throw new NotFound(`No session ${id}.`)
        continue
      }
      out.push(record)
      next.push(...this.sessions.list(undefined, id).map((child) => child.id))
    }
    return out
  }

  /** What a lane has to carry in `session` as it is now, and why not its files. */
  private laneFiles(record: Record_, provider: string, state: Record<string, unknown>, conversation: boolean): { files: ConversationFiles | null; why?: CarriedLane["why"] } {
    if (!conversation) return { files: null, why: "left-out" }
    const agent = this.agentOf(provider)
    if (!agent) return { files: null, why: "unknown-agent" }
    if (!agent.conversationFiles) return { files: null, why: "not-carried" }
    const files = agent.conversationFiles(state, record.session)
    if (files?.missing) return { files: null, why: "missing" }
    return { files }
  }

  /** Each file of one lane, read where it is now, by its path in the folder. */
  private async laneList(at: number, files: ConversationFiles): Promise<{ from: string; file: CarriedFile }[]> {
    const link = (path: string) => new CantCarry(`its conversation has something that isn't a plain file (${basename(path)})`)
    const out: { from: string; file: CarriedFile }[] = []
    const take = async (from: string, into: string) => {
      for (const { path, size } of await plainFiles(from, link)) {
        const whole = path ? join(from, path) : from
        out.push({ from: whole, file: { path: path ? join(into, path) : into, size, sha256: await hashOf(whole) } })
      }
    }
    for (const item of files.items) await take(item.path, join("lanes", String(at), "conversation", item.name))
    if (files.memory) await take(files.memory, join("lanes", String(at), "memory"))
    return out
  }

  /** A session as it is now, read and hashed; what's copied, if `into` says where. */
  private async read(root: string, conversation: boolean, into?: string): Promise<{ manifest: Manifest; left: LeftOf[] }> {
    const family = this.family(root)
    const records: CarriedFile[] = []
    // What you'd change of it as it goes: its name, its model, whether it's archived.
    const said: string[] = []
    const lanes: Manifest["lanes"] = []
    const left: LeftOf[] = []
    let at = 0
    for (const record of family) {
      const id = record.session.id
      this.store.save(id, true)
      const marks = (record.session.metadata ?? {}) as Record<string, any>
      const archived = record.session.time.archived ?? marks["kuvo.archived"] ?? marks.kuvo?.archived ?? null
      said.push(JSON.stringify([id, record.session.title ?? null, record.session.model ?? null, archived]))
      for (const name of ["session.json", "messages.json", "agent.json"]) {
        const file = this.store.fileOf(id, name)
        const path = join("sessions", id, name)
        // (What it says of itself changes as it's looked at and told things: its conversation is what counts.)
        if (name === "messages.json") records.push({ path, size: (await stat(file)).size, sha256: await hashOf(file) })
        if (into) {
          await mkdir(dirname(join(into, path)), { recursive: true })
          await copyFile(file, join(into, path))
        }
      }
      const slots = this.sessions.slotsOf(id)
      for (const [provider, slot] of Object.entries(slots)) {
        // Its agent hasn't started on it: nothing of its own to carry, nor to hand over yet.
        if (!Object.keys(slot.state ?? {}).length) continue
        const { files, why } = this.laneFiles(record, provider, slot.state, conversation)
        if (!files && !why) continue
        const list = files ? await this.laneList(at, files) : []
        const lane = {
          provider,
          session: id,
          how: files ? ("files" as const) : ("handover" as const),
          ...(why ? { why } : {}),
          items: (files?.items ?? []).map((item) => item.name),
          memory: Boolean(files?.memory),
          files: list.length,
          bytes: list.reduce((sum, each) => sum + each.file.size, 0),
          list: list.map((each) => each.file),
        }
        lanes.push(lane)
        // (What a folder's conversations share stays with the folder.)
        if (files) left.push({ provider, paths: files.items.map((item) => item.path), ...(files.memory && !files.memoryShared ? { memory: files.memory } : {}), directory: record.session.location.directory })
        if (into) {
          for (const { from, file } of list) {
            await mkdir(dirname(join(into, file.path)), { recursive: true })
            await copyFile(from, join(into, file.path))
          }
        }
        at++
      }
    }
    const digest = digestOf(records, lanes, said)
    return {
      manifest: {
        root,
        sessions: family.map(({ session }) => ({ id: session.id, ...(session.parentID ? { parentID: session.parentID } : {}), ...(session.metadata ? { metadata: session.metadata } : {}) })),
        lanes,
        records,
        digest,
      },
      left,
    }
  }

  /** Its agents stopped (a turn's process writes as it goes), until their files stay as they are. */
  private async settle(root: string): Promise<void> {
    const family = this.family(root)
    const working = family.filter(({ session }) => this.sessions.atWorkNow(session.id))
    if (working.length) throw new CantCarry("it's working", WORKING)
    const closed = family.map(({ session }) => this.sessions.closeAgents(session.id)).some(Boolean)
    if (!closed) return
    const files = family.flatMap((record) =>
      Object.entries(this.sessions.slotsOf(record.session.id)).flatMap(([provider, slot]) => this.laneFiles(record, provider, slot.state, true).files?.items.map((item) => item.path) ?? []),
    )
    const when = async () => (await Promise.all(files.map((file) => stat(file).then((found) => found.mtimeMs, () => 0)))).join()
    const began = Date.now()
    let last = await when()
    while (Date.now() - began < QUIET.most) {
      await Bun.sleep(QUIET.still)
      const now = await when()
      if (now === last) return
      last = now
    }
  }

  /** Copied into `into` (emptied first), with its manifest; `most` bytes at most, counted before any's copied. */
  async pack(root: string, into: string, options: { conversation?: boolean; most?: number } = {}) {
    const conversation = options.conversation !== false
    await this.settle(root)
    const counted = await this.read(root, conversation)
    const bytes = counted.manifest.lanes.reduce((sum, lane) => sum + lane.bytes, 0) + counted.manifest.records.reduce((sum, record) => sum + record.size, 0)
    if (options.most !== undefined && bytes > options.most) throw new CantCarry("it's too big", 413)
    await rm(into, { recursive: true, force: true })
    await mkdir(into, { recursive: true, mode: 0o700 })
    const { manifest, left } = await this.read(root, conversation, into)
    // (Each model asked once: an agent that can't say now isn't asked again for each session.)
    const asked = new Map<string, Promise<{ providerID: string; id: string } | undefined>>()
    for (const each of manifest.sessions) {
      const model = this.store.get(each.id)?.session.model
      if (!model?.providerID || !model.id) continue
      const key = `${model.providerID}/${model.id}`
      if (!asked.has(key)) asked.set(key, this.concreteOf(model))
      const concrete = await asked.get(key)
      if (concrete) each.model = concrete
    }
    await writeFile(join(into, "carry.json"), JSON.stringify(manifest), { mode: 0o600 })
    return { sessions: manifest.sessions, lanes: manifest.lanes.map(({ list: _, ...lane }) => lane), digest: manifest.digest, left }
  }

  /** The model `model` is an alias for here (Claude Code's `default`, Opus on one account and Sonnet
   * on another), as its agent listed it: none for one that isn't an alias, or an agent that hasn't said. */
  private async concreteOf(model: Session["model"] | undefined): Promise<{ providerID: string; id: string } | undefined> {
    if (!model?.providerID || !model.id) return undefined
    const id = await this.agentOf(model.providerID)?.concreteModel?.(model.id).catch(() => undefined)
    return id && id !== model.id ? { providerID: model.providerID, id } : undefined
  }

  /** What it would carry now, to see whether anything changed since it was packed. */
  async digest(root: string, conversation = true): Promise<string> {
    await this.settle(root)
    return (await this.read(root, conversation)).manifest.digest
  }

  /** What's kept of its conversation here as it goes, in the folder it goes to the trash with. */
  async keep(root: string, into: string) {
    for (const { session } of this.family(root)) {
      this.store.save(session.id, true)
      const folder = join(into, session.id)
      await mkdir(folder, { recursive: true })
      for (const name of ["session.json", "messages.json"]) await copyFile(this.store.fileOf(session.id, name), join(folder, name))
    }
  }

  /** The agent here that takes a lane's conversation: its own account, or, without it here, the
   * agent's first account that's signed in (its sign-in first), else that agent's own. */
  // The same account here, signed in; else the first of that agent's signed in here (as the move's
  // check said before it went: `check` in the link's moves); else the same, or the first, as it is.
  private async hostOf(provider: string): Promise<Agent | undefined> {
    const own = this.agentOf(provider)
    const signedIn = (agent: Agent) => agent.account(false).then((said) => said.signedIn, () => false)
    if (own && (await signedIn(own))) return own
    const named = parseProvider(provider)
    if (!named) return own
    const accounts = this.accountsOf(named.kind)
    for (const account of accounts) if (await signedIn(account)) return account
    return own ?? accounts[0] ?? this.agentOf(baseProvider[named.kind])
  }

  /**
   * What came (`from`, `carry.json` and all), checked, put in place and hashed again there, its
   * sessions added here working in `directory`. `keep`: a folder of the move's, for what it replaced
   * and the list of what it put where (`undo`), which stays until the move's over.
   * It throws `CantCarry` for what's wrong with what came; anything of it placed goes back then.
   */
  async place(from: string, keep: string, directory: string, root: string, chat?: string | null) {
    return await this.inTurn(keep, () => this.placeNow(from, keep, directory, root, chat))
  }

  /** What's placed or undone with a folder of a move's, one after the other: an undo that comes while
   * it's placed stops it at its next step, and undoes all of it once it's stopped. */
  private turns = new Map<string, Promise<unknown>>()
  private takenBack = new Set<string>()

  private async inTurn<T>(keep: string, work: () => Promise<T>): Promise<T> {
    const before = this.turns.get(keep) ?? Promise.resolve()
    const now = before.catch(() => {}).then(work)
    this.turns.set(keep, now)
    try {
      return await now
    } finally {
      if (this.turns.get(keep) === now) this.turns.delete(keep)
    }
  }

  /** Each file a session here works on now, by its agent's own say. */
  private inUse(): string[] {
    return this.store.all().flatMap((session) => {
      const record = this.store.get(session.id)
      if (!record) return []
      return Object.entries(this.sessions.slotsOf(session.id)).flatMap(([provider, slot]) => this.laneFiles(record, provider, slot.state ?? {}, true).files?.items.map((item) => item.path) ?? [])
    })
  }

  private async placeNow(from: string, keep: string, directory: string, root: string, chat?: string | null) {
    const manifest = await this.readManifest(from)
    if (manifest.root !== root) throw new CantCarry("its conversations aren't its own")
    for (const { id } of manifest.sessions) if (this.store.get(id)) throw new CantCarry("its conversations are here already")
    for (const file of [...manifest.records, ...manifest.lanes.flatMap((lane) => lane.list)]) await this.checked(from, file)
    await mkdir(keep, { recursive: true, mode: 0o700 })
    const undo = new Undo(keep)
    const sessions = manifest.sessions.map(({ id }) => id)
    const stillOn = () => {
      if (this.takenBack.has(keep)) throw new CantCarry("it was taken back")
    }
    const inUse = this.inUse()
    try {
      const hosts = new Map<string, Agent | undefined>()
      for (const lane of manifest.lanes) if (!hosts.has(lane.provider)) hosts.set(lane.provider, await this.hostOf(lane.provider))
      const placed: Manifest["lanes"] = []
      // The root's model as it came (`model`, as it's here now, may say another).
      let rootCame: Session["model"] | undefined
      // Sessions first, into a folder of their own: so whatever goes wrong below, `undo` has them too.
      for (const { id } of manifest.sessions) {
        stillOn()
        const read = async (name: string, or?: unknown) => {
          try {
            return JSON.parse(await readFile(join(from, "sessions", id, name), "utf8"))
          } catch (error) {
            if (or !== undefined) return or
            throw new CantCarry("its conversation didn't come whole")
          }
        }
        const session = (await read("session.json")) as Session
        const messages = await read("messages.json")
        const agent = (await read("agent.json", {})) as Record<string, any>
        if (session?.id !== id || !Array.isArray(messages)) throw new CantCarry("its conversation didn't come whole")
        session.location = { ...session.location, directory }
        // Its chat mark as the box it comes to says (PROTOCOL.md, "Chats"): the chats folder it's in
        // here, or none; as it came from a box that doesn't say. Put on as it's placed, so it's no
        // newer for it.
        if (chat !== undefined) {
          const { chat: _, ...kuvo } = (session.metadata?.kuvo ?? {}) as Record<string, unknown>
          session.metadata = { ...(session.metadata ?? {}), kuvo: chat ? { ...kuvo, chat } : kuvo }
        }
        session.projectID = "prj_" + createHash("sha1").update(directory).digest("hex").slice(0, 16)
        // Its undo's copies stay where they were made.
        delete agent.snapshots
        const lanesHere = manifest.lanes.filter((lane) => lane.session === id)
        const threads = (agent.threads ?? {}) as Record<string, { state: Record<string, unknown>; seen?: string }>
        const kept: typeof threads = {}
        // (The one its model is on last: two accounts that come to the same one here, it's the one that goes on.)
        const inTurn = Object.entries(threads).sort(([one], [other]) => Number(one === session.model?.providerID) - Number(other === session.model?.providerID))
        for (const [provider, slot] of inTurn) {
          const lane = lanesHere.find((each) => each.provider === provider)
          const host = hosts.get(provider) ?? this.agentOf(provider)
          const here = host?.providerID ?? provider
          // Carried: as it was. Otherwise it starts over, handed what came before.
          // (A conversation that was carried is placed whole, or not at all: it's never said to have come when it didn't.)
          if (lane?.how === "files" && !host?.conversationPlace) throw new CantCarry("its coding agent isn't here to take its conversation")
          if (lane?.how === "files" && host?.conversationPlace) {
            kept[here] = slot
            const where = host.conversationPlace(slot.state, session)
            for (const file of lane.list) {
              const conversation = join("lanes", String(manifest.lanes.indexOf(lane)), "conversation") + sep
              const memory = join("lanes", String(manifest.lanes.indexOf(lane)), "memory")
              const dest = file.path.startsWith(conversation) ? where.item(file.path.slice(conversation.length)) : file.path === memory ? where.memory ?? null : file.path.startsWith(memory + sep) && where.memory ? join(where.memory, file.path.slice(memory.length + 1)) : null
              if (!dest) throw new CantCarry("its conversation didn't come whole")
              // Never over a conversation a session here is on.
              if (inUse.some((path) => dest === path || dest.startsWith(path + sep))) throw new CantCarry("its conversation is one here already")
              stillOn()
              await undo.put(join(from, file.path), dest, file, Boolean(where.memoryMerges && !file.path.startsWith(conversation)))
            }
            placed.push(lane)
          } else {
            kept[here] = { state: {} }
          }
        }
        agent.threads = kept
        if (id === manifest.root && session.model) rootCame = { ...session.model }
        // On the model its alias stood for where it came from (it ran on that one there), if the
        // agent that takes it here has that one too (another account's may not).
        const concrete = manifest.sessions.find((each) => each.id === id)?.model
        if (concrete && session.model && concrete.providerID === session.model.providerID && typeof concrete.id === "string" && concrete.id && concrete.id.length <= 200) {
          const host = hosts.get(session.model.providerID) ?? this.agentOf(session.model.providerID)
          const there = (await host?.models({ hidden: true }).catch(() => [])) ?? []
          if (there.some((model) => model.id === concrete.id || model.aliases?.includes(concrete.id))) session.model = { ...session.model, id: concrete.id }
        }
        if (session.model?.providerID && hosts.get(session.model.providerID)) session.model = { ...session.model, providerID: hosts.get(session.model.providerID)!.providerID }
        stillOn()
        await undo.noteSession(id)
        this.sessions.addCarried({ session, messages, agent })
      }
      return { sessions, infos: manifest.sessions.map(({ id, metadata }) => ({ id, metadata })), digest: manifest.digest, ...(rootCame ? { came: rootCame } : {}), lanes: manifest.lanes.map(({ list: _, ...lane }) => ({ ...lane, how: placed.includes(manifest.lanes.find((each) => each.session === lane.session && each.provider === lane.provider)!) ? ("files" as const) : ("handover" as const) })), model: this.store.get(manifest.root)?.session.model }
    } catch (error) {
      await this.undoNow(keep).catch(() => {})
      throw error
    }
  }

  private async readManifest(from: string): Promise<Manifest> {
    let manifest: Manifest
    try {
      manifest = JSON.parse(await readFile(join(from, "carry.json"), "utf8"))
    } catch {
      throw new CantCarry("its conversation didn't come whole")
    }
    const ids = Array.isArray(manifest?.sessions) ? manifest.sessions.map((each) => each?.id) : []
    const parentsKnown = ids.length > 0 && manifest.sessions.every((each) => (each.id === manifest.root ? !each.parentID : typeof each.parentID === "string" && ids.includes(each.parentID)))
    if (!ids.includes(manifest?.root) || ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length || !parentsKnown) throw new CantCarry("its conversations aren't its own")
    if (!Array.isArray(manifest.lanes) || !Array.isArray(manifest.records)) throw new CantCarry("its conversation didn't come whole")
    for (const file of [...manifest.records, ...manifest.lanes.flatMap((lane) => lane.list ?? [])]) if (!safeWithin(file?.path) || typeof file.sha256 !== "string") throw new CantCarry("its conversation didn't come whole")
    return manifest
  }

  /** A file that came, the size and hash the other computer said. */
  private async checked(from: string, file: CarriedFile) {
    let found: Awaited<ReturnType<typeof lstat>>
    try {
      found = await lstat(join(from, file.path))
    } catch {
      throw new CantCarry("a file of its conversation didn't come with it")
    }
    if (!found.isFile() || found.size !== file.size || (await hashOf(join(from, file.path))) !== file.sha256) throw new CantCarry("a file of its conversation didn't come whole")
  }

  /** What `place` did, undone: its sessions gone (their files here with them), what it placed gone, what it replaced back. */
  async undo(keep: string) {
    this.takenBack.add(keep)
    try {
      await this.inTurn(keep, () => this.undoNow(keep))
    } finally {
      this.takenBack.delete(keep)
    }
  }

  private async undoNow(keep: string) {
    const undo = new Undo(keep)
    for (const id of (await undo.read()).sessions.reverse()) await this.sessions.remove(id).catch((error) => {
      if (!(error instanceof NotFound)) throw error
    })
    await undo.undo()
  }

  /**
   * What a moved session left here, gone, now that it's run on the other computer a while. Only what
   * its agent keeps as its own conversations (`conversationRoots`); memory only where no session here
   * still works in the folder it's the memory of (`back`: its own sessions, back here, keep their
   * memory in the bot's folder now, so they don't count).
   */
  async remove(left: LeftOf[], ownSessions: string[] = [], back = false): Promise<{ removed: string[]; kept: string[] }> {
    const removed: string[] = []
    const kept: string[] = []
    // Never what a session here works on now: one that moved back has its files where they were.
    const live = new Set(this.inUse())
    for (const lane of left) {
      const named = parseProvider(lane.provider)
      const agents = named ? this.accountsOf(named.kind) : []
      const roots = (this.agentOf(lane.provider)?.conversationRoots?.() ?? agents.flatMap((agent) => agent.conversationRoots?.() ?? [])).map((root) => root + sep)
      const ours = (path: string) => roots.some((root) => path.startsWith(root) && normalize(path) === path)
      for (const path of lane.paths) {
        if (!ours(path) || live.has(path)) {
          kept.push(path)
          continue
        }
        await rm(path, { recursive: true, force: true })
        removed.push(path)
      }
      if (!lane.memory) continue
      const shared = this.store.all().some((session) => session.location.directory === lane.directory && !(back && ownSessions.includes(session.id)))
      if (shared || !ours(lane.memory)) {
        kept.push(lane.memory)
        continue
      }
      await rm(lane.memory, { recursive: true, force: true })
      removed.push(lane.memory)
    }
    return { removed, kept }
  }
}

interface Placed {
  dest: string
  /** What was there, moved aside. */
  replaced?: string
  /** What was put there. */
  sha256?: string
}

/** What a placing did, written down as it goes (a box that stops midway still undoes it), in `keep`. */
class Undo {
  private list: { sessions: string[]; placed: Placed[] } = { sessions: [], placed: [] }
  private count = 0

  constructor(private readonly keep: string) {}

  private get file() {
    return join(this.keep, "placed.json")
  }

  async read() {
    try {
      const said = JSON.parse(await readFile(this.file, "utf8"))
      this.list = { sessions: Array.isArray(said?.sessions) ? said.sessions : [], placed: Array.isArray(said?.placed) ? said.placed : [] }
    } catch {}
    return this.list
  }

  private async write() {
    await writeFile(this.file, JSON.stringify(this.list), { mode: 0o600 })
  }

  async noteSession(id: string) {
    this.list.sessions.push(id)
    await this.write()
  }

  /** `from` to `dest`, checked there; what was at `dest` kept (`merges`: left, and this one beside it). */
  async put(from: string, dest: string, file: CarriedFile, merges: boolean) {
    await mkdir(dirname(dest), { recursive: true })
    let there = await lstat(dest).then(() => true, () => false)
    if (there && merges) {
      if ((await hashOf(dest).catch(() => "")) === file.sha256) return
      // Something else by that name: both kept, the one that came named for where it came from.
      dest = join(dirname(dest), `moved-${file.sha256.slice(0, 8)}-${basename(dest)}`)
      there = await lstat(dest).then(() => true, () => false)
      if (there) return
    }
    // (Its hash only where others may write to it too: one of its own, cut short or not, always goes.)
    const placed: Placed = merges ? { dest, sha256: file.sha256 } : { dest }
    if (there) placed.replaced = join(this.keep, "replaced", String(this.count++))
    this.list.placed.push(placed)
    await this.write()
    if (placed.replaced) {
      await mkdir(dirname(placed.replaced), { recursive: true })
      await rename(dest, placed.replaced)
    }
    await copyFile(from, dest)
    if ((await hashOf(dest)) !== file.sha256) throw new CantCarry("a file of its conversation didn't copy whole")
  }

  /** Each one undone from the last, and crossed off as it is (undone again after a stop, nothing's undone twice). */
  async undo() {
    await this.read()
    this.list.sessions = []
    while (this.list.placed.length) {
      const { dest, replaced, sha256 } = this.list.placed[this.list.placed.length - 1]
      const exists = (path: string) => lstat(path).then(() => true, () => false)
      if (replaced) {
        // What was there, back; still there if it was never moved aside.
        if (await exists(replaced)) {
          await rm(dest, { force: true })
          await rename(replaced, dest)
        }
      } else if (!sha256 || !(await exists(dest)) || (await hashOf(dest).catch(() => "")) === sha256) {
        await rm(dest, { force: true })
      }
      // (Written to since by something here, a memory the others share: kept as it is now.)
      this.list.placed.pop()
      await this.write()
    }
    await this.write().catch(() => {})
  }
}

/** The routes under `api/kuvo/carry`. */
export async function carryRoutes(carrying: Carrying | undefined, method: string, parts: string[], body: () => Promise<any>): Promise<Response> {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })
  if (!carrying) return json({ message: "Moves aren't running on this computer." }, 503)
  if (method !== "POST") return json({ message: "Not allowed" }, 405)
  const given = await body()
  const text = (name: string): string => {
    const value = given?.[name]
    if (typeof value !== "string" || !value) throw new CantCarry(`say ${name}`, 400)
    return value
  }
  try {
    switch (parts[0]) {
      case "pack":
        return json({ data: await carrying.pack(text("root"), text("into"), { conversation: given?.conversation !== false, ...(typeof given?.most === "number" ? { most: given.most } : {}) }) })
      case "digest":
        return json({ data: { digest: await carrying.digest(text("root"), given?.conversation !== false) } })
      case "keep":
        await carrying.keep(text("root"), text("into"))
        return json({ data: true })
      case "place":
        return json({ data: await carrying.place(text("from"), text("keep"), text("directory"), text("root"), typeof given?.chat === "string" || given?.chat === null ? given.chat : undefined) })
      case "undo":
        await carrying.undo(text("keep"))
        return json({ data: true })
      case "remove":
        return json({ data: await carrying.remove(Array.isArray(given?.left) ? given.left : [], Array.isArray(given?.sessions) ? given.sessions : [], given?.back === true) })
    }
    return json({ message: "Not found" }, 404)
  } catch (error) {
    if (error instanceof CantCarry) return json({ message: error.message, carry: true }, error.status)
    throw error
  }
}
