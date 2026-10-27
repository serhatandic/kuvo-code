// Your accounts with each coding agent. The first is the agent's own sign-in, where it always
// keeps it (`~/.claude`, `~/.codex`, `~/.grok`; Cursor's and Antigravity's in the bridge's
// folder); each one you add gets a folder of its own in the bridge's (`<agent>/accounts/<id>`),
// which the agent is pointed at (CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME…), as T3 Code runs a
// second instance. An added account's models and sessions are its own: its provider is
// `<agent's provider>@<id>`. On a machine, the agent's own sign-in is in the bridge's folder too
// (`<agent>/home`): nothing goes in the machine's home.

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { onMachine } from "./machine"

export type AgentKind = "claude" | "codex" | "cursor" | "grok" | "antigravity"

export const kinds: AgentKind[] = ["claude", "codex", "cursor", "grok", "antigravity"]

export const baseProvider: Record<AgentKind, string> = {
  claude: "claude-code",
  codex: "codex-cli",
  cursor: "cursor",
  grok: "grok-cli",
  antigravity: "antigravity",
}

export interface AccountRecord {
  kind: AgentKind
  /** `default` for the agent's own sign-in; otherwise a short random ID. */
  id: string
  /** What you called it ("Work"); an added account without one goes by its sign-in. */
  label?: string
}

/** One account as an agent runs it. */
export interface AgentAccount {
  id: string
  label?: string
  /** The folder the agent keeps this account in; none for the default (the agent's own). */
  home?: string
}

export function providerID(kind: AgentKind, id: string): string {
  return id === "default" ? baseProvider[kind] : `${baseProvider[kind]}@${id}`
}

/** The agent and account a provider ID names, if it's one of theirs. */
export function parseProvider(provider: string): { kind: AgentKind; id: string } | undefined {
  const [base, id] = provider.split("@", 2)
  const kind = kinds.find((kind) => baseProvider[kind] === base)
  if (!kind) return undefined
  return { kind, id: id ?? "default" }
}

export class Accounts {
  private records: AccountRecord[] = []

  constructor(private readonly root: string) {
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as AccountRecord[]
      this.records = saved.filter((record) => kinds.includes(record.kind) && record.id && record.id !== "default")
    } catch {}
  }

  private get file() {
    return join(this.root, "accounts.json")
  }

  /** Each agent's default account, then the ones you added, in the order you added them. */
  all(): AccountRecord[] {
    return [...kinds.map((kind) => ({ kind, id: "default" })), ...this.records]
  }

  home(record: AccountRecord): string | undefined {
    if (record.id !== "default") return join(this.root, record.kind, "accounts", record.id)
    // (Cursor's and Antigravity's own are in the bridge's folder anyway.)
    if (!onMachine || !["claude", "codex", "grok"].includes(record.kind)) return undefined
    const home = join(this.root, record.kind, "home")
    mkdirSync(home, { recursive: true, mode: 0o700 })
    return home
  }

  add(kind: AgentKind, label?: string): AccountRecord {
    const record: AccountRecord = { kind, id: randomBytes(4).toString("hex"), label: label?.trim() || undefined }
    mkdirSync(this.home(record)!, { recursive: true, mode: 0o700 })
    this.records.push(record)
    this.save()
    return record
  }

  rename(provider: string, label: string | undefined) {
    const parsed = parseProvider(provider)
    const record = this.records.find((record) => record.kind === parsed?.kind && record.id === parsed?.id)
    if (!record) return
    record.label = label?.trim() || undefined
    this.save()
  }

  /** Forgets an added account, and everything kept in its folder. */
  remove(provider: string): AccountRecord | undefined {
    const parsed = parseProvider(provider)
    const index = this.records.findIndex((record) => record.kind === parsed?.kind && record.id === parsed?.id)
    if (index < 0) return undefined
    const [record] = this.records.splice(index, 1)
    this.save()
    rmSync(this.home(record)!, { recursive: true, force: true })
    return record
  }

  private save() {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.file + ".new", JSON.stringify(this.records, null, 2))
    renameSync(this.file + ".new", this.file)
  }
}
