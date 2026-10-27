// Sessions and their conversations, kept in the bridge's own folder: one folder per session with
// `session.json` (the session as the app reads it), `messages.json` (its conversation, in the
// engine's form) and `agent.json` (what the agent needs to go on: its own conversation's ID).

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message, Session } from "./wire"

export interface Record_ {
  session: Session
  messages: Message[]
  /** The agent's own state for this session (its conversation's ID, to resume it). */
  agent: Record<string, unknown>
}

export class Store {
  private records = new Map<string, Record_>()
  private pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true })
    for (const id of readdirSync(root)) {
      try {
        const folder = join(root, id)
        const session = JSON.parse(readFileSync(join(folder, "session.json"), "utf8")) as Session
        let messages: Message[] = []
        try {
          messages = JSON.parse(readFileSync(join(folder, "messages.json"), "utf8"))
        } catch {}
        let agent: Record<string, unknown> = {}
        try {
          agent = JSON.parse(readFileSync(join(folder, "agent.json"), "utf8"))
        } catch {}
        this.records.set(session.id, { session, messages, agent })
      } catch {
        // A folder left half-written: not a session.
      }
    }
  }

  all(): Session[] {
    return [...this.records.values()].map((record) => record.session)
  }

  get(id: string): Record_ | undefined {
    return this.records.get(id)
  }

  /** When its conversation was last written (ms), if it has been. */
  writtenAt(id: string): number | undefined {
    try {
      return statSync(join(this.root, id, "messages.json")).mtimeMs
    } catch {
      return undefined
    }
  }

  add(session: Session) {
    this.records.set(session.id, { session, messages: [], agent: {} })
    this.save(session.id, true)
  }

  remove(id: string) {
    this.records.delete(id)
    clearTimeout(this.pending.get(id))
    this.pending.delete(id)
    rmSync(join(this.root, id), { recursive: true, force: true })
  }

  /** Writes a session's files: at once, or a moment after its last change (a reply streams in). */
  save(id: string, now = false) {
    clearTimeout(this.pending.get(id))
    if (now) {
      this.pending.delete(id)
      this.write(id)
      return
    }
    this.pending.set(
      id,
      setTimeout(() => {
        this.pending.delete(id)
        this.write(id)
      }, 500),
    )
  }

  /** Everything still waiting to be written, written. */
  flush() {
    for (const id of [...this.pending.keys()]) this.save(id, true)
  }

  private write(id: string) {
    const record = this.records.get(id)
    if (!record) return
    const folder = join(this.root, id)
    mkdirSync(folder, { recursive: true })
    for (const [name, value] of [
      ["session.json", record.session],
      ["messages.json", record.messages],
      ["agent.json", record.agent],
    ] as const) {
      const file = join(folder, name)
      writeFileSync(file + ".new", JSON.stringify(value))
      renameSync(file + ".new", file)
    }
  }
}
