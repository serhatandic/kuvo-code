// What fills the record: the tool calls of every conversation on this box, as its engine and this
// bridge tell them (the same events, `session.tool.*`), turned into versions of the files they
// wrote, edited, made or showed.
//
// - A call's name comes with `session.tool.input.started`, its input with `session.tool.called`,
//   and what it did with `session.tool.success`: its `metadata.files` (edits and patches, from the
//   engine and the coding agents alike), a write's path, the pictures a tool that makes them
//   made, and Kuvo Code's own tools (show_file, show_in_panel, mark_final).
// - A turn runs from `session.execution.started` to its end; the message that started it is the
//   first `session.inbox.delivered`, a wake-up's when `session.inbox.enqueued` says so.
// - Who: the conversation's bot (its folder, its `kuvo.bot` metadata, or the bots' folders), a
//   group chat seat's bot and chat (`kuvo.seat`), and a subagent's work counts as its parent's.
// - Each conversation's events are handled in order, one after another; its state stays while
//   anything of it is queued, so a turn that starts as the last one ends keeps what it's told.

import { readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { unapplyExactly } from "./changes"
import type { ArtifactStore, Made, Trigger } from "./store"

export interface Event {
  type: string
  data?: Record<string, any>
  location?: { directory?: string }
}

/** A conversation as the record needs it. */
interface Info {
  directory?: string
  parent?: string
  bot?: string
  seat?: { group: string; bot: string }
  /** A conversation the engine runs for one of this bridge's (its events come again from here). */
  hidden?: boolean
}

interface Call {
  name?: string
  input?: Record<string, any>
}

interface Live {
  /** The turn running: when it began, the message that started it, and the group chat it's a part of. */
  turn?: { started: number; message?: string; group?: string; trigger?: Trigger }
  calls: Map<string, Call>
  /** Its events in order, each after the last is done. */
  queue: Promise<void>
}

/** Where events come from: the engine, or this bridge's own conversations. */
export interface Source {
  name: "engine" | "bridge"
  /** A conversation's details as its source has them; throws when it can't be read now. */
  session(id: string): Promise<{ parentID?: string; location?: { directory?: string }; metadata?: Record<string, any> } | undefined>
  /** The coding agent a conversation of this source runs with ("engine" for the engine's own). */
  agent(id: string): string | undefined
}

/** Tools that write a whole file by its path. */
const writes = new Set(["write", "Write", "create", "write_file"])
/** Tools whose output files are what they made (a picture), not what they read. */
const makers = new Set(["generate_image", "browser_screenshot"])
/** How a wake-up's note starts, as it arrives in its conversation. */
const wakeMarker = "[Wake-up] "
/** Most of each kept by the message it's for: conversations' details, chats' parts, wake-ups. */
const remembered = 500

const relevant = new Set([
  "session.execution.started", "session.inbox.enqueued", "session.inbox.delivered",
  "session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed",
  "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
])

export class Recorder {
  private live = new Map<string, Live>()
  /** Each conversation's details, read once a turn (a parent's too). */
  private infos = new Map<string, Promise<Info>>()
  /** Chats' parts given to bots' own conversations, by the message that starts each. */
  private parts = new Map<string, string>()
  /** Wake-ups' messages, by their ID, until their turn starts. */
  private wakes = new Map<string, true>()
  /** Each bot's turn running now, by its conversation (or seat). */
  private running = new Map<string, { key: string; made: (via: string) => Made }>()

  constructor(
    private readonly store: ArtifactStore,
    private readonly options: {
      bots?: string
      now?: () => Date
      /**
       * A turn ending (not a subagent's): what changed meanwhile that no tool call named (a
       * command's files), recorded as that turn's with `made`, in its bot's folder or its project.
       */
      turnEnded?: (turn: { bot?: string; folder?: string; since: number; made: (via: string) => Made }) => void
    } = {},
  ) {}

  /** One event from `source`, handled after that conversation's earlier ones. */
  heard(source: Source, event: Event): Promise<void> {
    const id = event.data?.sessionID
    if (typeof id !== "string" || !relevant.has(event.type)) return Promise.resolve()
    const key = source.name + "\0" + id
    let live = this.live.get(key)
    if (!live) this.live.set(key, (live = { calls: new Map(), queue: Promise.resolve() }))
    const it = live
    const done = it.queue.then(() => this.handle(source, id, it, event)).catch((error) => console.error("artifacts:", error?.message ?? error))
    it.queue = done
    // Forgotten once nothing more of it is queued, and no turn or tool call of it runs.
    void done.then(() => {
      if (this.live.get(key) === it && it.queue === done && !it.turn && !it.calls.size) this.live.delete(key)
    })
    return done
  }

  /**
   * A file conversation `id` got without a tool call naming it (a download in the agent's
   * browser), recorded as that conversation's, in the turn it's in, after what it's told so far.
   * Whether one of `sources` has that conversation.
   */
  async noted(sources: Source[], id: string, path: string, via: string): Promise<boolean> {
    for (const source of sources) {
      let found
      try {
        found = await source.session(id)
      } catch {}
      if (!found) continue
      const live = this.live.get(source.name + "\0" + id) ?? { calls: new Map(), queue: Promise.resolve() }
      await live.queue.catch(() => {})
      const context = await this.context(source, id, live)
      if (context) await this.store.change(path, { ...context.made(via), ...(via === "download" ? { download: true } : {}) })
      return true
    }
    return false
  }

  /** A chat's part given to a bot's conversation: the turn `prompt` starts is the chat's. */
  given(prompt: string, chat: string) {
    remember(this.parts, prompt, chat)
  }

  /** How a change in `bot`'s folder is recorded now: its running turn's (a command it ran), or none. */
  madeInFolder(bot: string): ((via: string) => Made) | undefined {
    return this.running.get(bot)?.made
  }

  private async handle(source: Source, id: string, live: Live, event: Event) {
    const data = event.data ?? {}
    const key = source.name + "\0" + id
    switch (event.type) {
      case "session.execution.started": {
        live.turn = { started: Date.now() }
        live.calls.clear()
        // Read again for this turn (a session moved, a seat made).
        this.infos.delete(key)
        // A bot at work: what changes in its folder meanwhile (a command's files) is this turn's.
        const context = await this.context(source, id, live, event.location?.directory)
        if (context?.bot) this.running.set(context.bot, { key, made: context.made })
        return
      }
      case "session.inbox.enqueued": {
        // A wake-up's note: the turn it starts is a wake-up's.
        const text = data.item?.payload?.text
        if (typeof data.inboxID === "string" && typeof text === "string" && text.startsWith(wakeMarker)) remember(this.wakes, data.inboxID, true)
        return
      }
      case "session.inbox.delivered":
        if (live.turn && !live.turn.message && typeof data.inboxID === "string") {
          live.turn.message = data.inboxID
          // A chat's part, given to the bot's own conversation: what it makes is the chat's too.
          const group = this.parts.get(data.inboxID)
          if (group) {
            this.parts.delete(data.inboxID)
            live.turn.group = group
          }
          if (this.wakes.delete(data.inboxID)) live.turn.trigger = "wake"
        }
        return
      case "session.tool.input.started":
        live.calls.set(data.id, { ...live.calls.get(data.id), name: String(data.name ?? "") })
        return
      case "session.tool.called":
        live.calls.set(data.id, { ...live.calls.get(data.id), input: data.input ?? {} })
        return
      case "session.tool.success": {
        const call = live.calls.get(data.id) ?? {}
        live.calls.delete(data.id)
        await this.succeeded(source, id, live, call, data.metadata, data.content, event.location?.directory)
        return
      }
      case "session.tool.failed":
        live.calls.delete(data.id)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        // What it made with commands. A subagent's turn is its parent's, looked at as that ends.
        const turn = live.turn
        if (turn && this.options.turnEnded) {
          const info = await this.info(source, id)
          const context = info.parent ? undefined : await this.context(source, id, live, event.location?.directory)
          if (context) this.options.turnEnded({ bot: context.bot, folder: context.folder, since: turn.started, made: context.made })
        }
        live.turn = undefined
        live.calls.clear()
        for (const [bot, running] of this.running) if (running.key === key) this.running.delete(bot)
        return
      }
    }
  }

  /**
   * How what conversation `id` does now is recorded: by whom, in which turn (a subagent's is its
   * parent's), for which bot, project, conversation or group chat. None for one the record skips.
   */
  private async context(source: Source, id: string, live: Live, directory?: string) {
    const info = await this.info(source, id)
    if (info.hidden) return undefined
    const root = await this.root(source, id, info)
    if (root.info.hidden) return undefined
    const turn = this.live.get(source.name + "\0" + root.id)?.turn ?? live.turn
    // A seat's turn, or a part a chat gave the bot's own conversation (known once its message is).
    const groupOf = () => root.info.seat?.group ?? turn?.group
    const folder = info.directory ?? directory ?? root.info.directory
    const bot = root.info.seat?.bot ?? root.info.bot
    const project = folder && !this.inBots(folder) ? folder : undefined
    const agent = source.agent(id)
    const made = (via: string): Made => {
      const group = groupOf()
      return {
        by: { kind: "agent", session: id, ...(bot ? { bot } : {}), ...(agent ? { agent } : {}) },
        ...(turn ? { turn: { session: root.id, ...(turn.message ? { message: turn.message } : {}) } } : {}),
        ...(group ? { group: { id: group }, trigger: "group" as Trigger } : turn?.trigger ? { trigger: turn.trigger } : {}),
        via,
        where: {
          ...(bot ? { bot } : {}),
          ...(project ? { project } : {}),
          ...(group ? { group } : {}),
          // A seat is the chat's, not a conversation of its own that you see.
          ...(root.info.seat ? {} : { session: root.id }),
        },
        at: this.options.now?.(),
      }
    }
    return { made, bot, folder }
  }

  private async succeeded(source: Source, id: string, live: Live, call: Call, metadata: any, content: any, directory?: string) {
    const context = await this.context(source, id, live, directory)
    if (!context) return
    const { made, folder } = context
    const absolute = (path: string) => (isAbsolute(path) ? path : resolve(folder ?? "/", path))
    const name = toolName(call.name ?? "")
    const input = call.input ?? {}

    // Edits and patches, as the engine and the coding agents report them.
    const files = Array.isArray(metadata?.files) ? metadata.files : []
    for (const file of files) {
      if (typeof file?.file !== "string") continue
      const path = absolute(file.file)
      if (!this.store.at(path) && file.status !== "added" && typeof file.patch === "string") await this.seedBefore(path, file.patch, file.status === "deleted")
      await this.store.change(path, { ...made(name), ...(typeof file.patch === "string" ? { patch: file.patch } : {}) })
    }
    // A write's file, when it didn't say so in its metadata.
    const written = input.path ?? input.filePath ?? input.file_path
    if (!files.length && writes.has(name) && typeof written === "string") await this.store.change(absolute(written), made(name))
    // What a tool that makes pictures made, in its output (not what a read looked at).
    if (makers.has(name) && (name !== "browser_screenshot" || input.show)) {
      for (const part of Array.isArray(content) ? content : []) {
        if (part?.type !== "file" || typeof part.uri !== "string" || !part.uri.startsWith("file:")) continue
        let path: string
        try {
          path = fileURLToPath(part.uri)
        } catch {
          continue
        }
        await this.store.change(path, made(name))
      }
    }
    // Kuvo Code's own tools.
    if ((name === "show_file" || name === "show_in_panel") && typeof input.path === "string") await this.store.shown(absolute(input.path), made(name))
    if (name === "mark_final" && typeof input.path === "string") {
      const artifact = (await this.store.change(absolute(input.path), made(name))) ?? this.store.at(absolute(input.path))
      if (artifact) await this.store.pin(artifact.id, { by: "bot", ...(typeof input.note === "string" && input.note ? { note: input.note } : {}) })
    }
  }

  /**
   * What a file was before a change the record first sees (a deletion too), from the change's patch, as version 0:
   * only when the patch fits the file as it is now exactly (it hasn't changed again since), never
   * a state made up from a later one.
   */
  private async seedBefore(path: string, patch: string, deleted = false) {
    let now: string
    try {
      // A deleted one is nothing now: its patch takes it back to all it was.
      now = deleted ? "" : readFileSync(path, "utf8")
    } catch {
      return
    }
    const before = unapplyExactly(patch, now)
    if (before !== undefined && before !== now) await this.store.before(path, Buffer.from(before))
  }

  /** The conversation at the top of `id`'s subagents, and its details. */
  private async root(source: Source, id: string, info: Info): Promise<{ id: string; info: Info }> {
    let current = { id, info }
    for (let depth = 0; depth < 8 && current.info.parent; depth++) {
      const parent = current.info.parent
      current = { id: parent, info: await this.info(source, parent) }
    }
    return current
  }

  private info(source: Source, id: string): Promise<Info> {
    const key = source.name + "\0" + id
    const known = this.infos.get(key)
    if (known) return known
    const reading = (async (): Promise<Info> => {
      let session
      try {
        session = await source.session(id)
      } catch {
        // Not readable now: asked again next time.
        this.infos.delete(key)
        return {}
      }
      const kuvo = session?.metadata?.kuvo ?? {}
      const seat = kuvo.seat && typeof kuvo.seat.group === "string" && typeof kuvo.seat.bot === "string" ? { group: kuvo.seat.group, bot: kuvo.seat.bot } : undefined
      const directory = session?.location?.directory
      const bot = typeof kuvo.bot === "string" ? kuvo.bot : this.botOf(id, directory)
      return {
        ...(directory ? { directory } : {}),
        ...(session?.parentID ? { parent: session.parentID } : {}),
        ...(bot ? { bot } : {}),
        ...(seat ? { seat } : {}),
        ...(source.name === "engine" && kuvo.engineFor ? { hidden: true } : {}),
      }
    })()
    remember(this.infos, key, reading)
    return reading
  }

  private inBots(folder: string) {
    return Boolean(this.options.bots && (folder + sep).startsWith(this.options.bots + sep))
  }

  /** The bot whose conversation `id` is: by its folder (`bots/<id>/…`), else its folder's `session` file. */
  private botOf(id: string, directory?: string): string | undefined {
    const bots = this.options.bots
    if (!bots) return undefined
    if (directory && this.inBots(directory)) {
      const first = relative(bots, directory).split(sep)[0]
      if (first.startsWith("bot_")) return first
    }
    // (A bot that works in a project: its folder's `session` file names its conversation.)
    try {
      for (const bot of readdirSync(bots)) {
        if (!bot.startsWith("bot_")) continue
        try {
          if (readFileSync(join(bots, bot, "session"), "utf8").trim() === id) return bot
        } catch {}
      }
    } catch {}
    return undefined
  }
}

/** `value` kept by `key`, the oldest going past a few hundred. */
function remember<Value>(map: Map<string, Value>, key: string, value: Value) {
  map.delete(key)
  map.set(key, value)
  for (const old of map.keys()) {
    if (map.size <= remembered) break
    map.delete(old)
  }
}

/** A tool's own name, without its server's (`kuvo-browser_show_file` is `show_file`). */
export function toolName(name: string): string {
  const own = ["show_file", "show_in_panel", "mark_final", "generate_image", "browser_screenshot"]
  for (const each of own) if (name === each || name.endsWith("_" + each) || name.endsWith("__" + each)) return each
  return name
}
