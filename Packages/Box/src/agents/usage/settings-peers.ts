// The usage panel's settings shared between your own computers' boxes (PROTOCOL.md, "Usage
// settings"): each tells the others its parts with their versions as they change, and each takes
// what's newer (`UsageSettings.merge`), so every box holds the same. Only to and from your own
// computers, never a box a peer vouches for (another person's Mac beside a machine you share), and
// nothing before the link has said which are which. Every ten minutes a box says only what it holds
// (`digest`); one that holds something else answers with all of its own and asks for the other's.
// The mail goes through the box's link (`{"seat": {"kind": "settings", …}}`), which carries this
// kind only between your own computers too.

import type { LimitsDirectory, LimitsTransport } from "../limits-peers"
import type { KeptUnit, SettingsUnit, UsageSettings } from "./settings"

/** What one box tells another of its usage settings. */
export interface SettingsMail {
  kind: "settings"
  /** When it was told, by the sender's clock (ms). */
  at: number
  /** What it holds, hashed (`UsageSettings.digest`). */
  digest: string
  /** Its parts, with their versions: none in a mail that only says what it holds. */
  usage?: Partial<Record<SettingsUnit, KeptUnit>>
  /** Tell me yours (it just started, or holds something else). */
  ask?: true
}

export const isSettingsMail = (value: any): value is SettingsMail => value !== null && typeof value === "object" && value.kind === "settings"

const MINUTE = 60_000
/** Said again this often though nothing changed (the relay keeps nothing). */
const TELL_AGAIN = 10 * MINUTE

export class SettingsPeers {
  /** What was last told each of your computers (its digest), and when. */
  private told = new Map<string, { digest: string; at: number }>()
  /** When each was last sent all of it without asking (at most once a minute: one that can't take a part doesn't go round and round). */
  private answered = new Map<string, number>()

  constructor(
    private readonly settings: UsageSettings,
    private readonly transport: Pick<LimitsTransport, "followed" | "onFollowed"> & { send(to: string, mail: SettingsMail, durable: boolean): void },
    private readonly directory: LimitsDirectory,
    private readonly now: () => number = Date.now,
  ) {
    settings.self = () => directory.own()?.key ?? ""
    settings.listen(() => this.tell(true))
    directory.listen(() => this.directorySaid())
    // (What went while the link didn't carry it was lost: all of it again, now.)
    transport.onFollowed?.(() => {
      this.told.clear()
      this.tell()
    })
  }

  /** Your own computers: the link's peers, never a box only a peer knows. None before the link says. */
  private ours(): string[] {
    if (!this.directory.told || !this.directory.isPeer) return []
    return this.directory.peerBoxes().flatMap(({ key }) => (this.directory.isPeer!(key) ? [key] : []))
  }

  /**
   * This box's settings told to each of your computers: all of them to one not told since this
   * started (asking for its own), or after they changed (`changed`); else every ten minutes, only
   * what they are.
   */
  tell(changed = false) {
    if (!this.transport.followed) return
    const now = this.now()
    const digest = this.settings.digest()
    for (const key of this.ours()) {
      const last = this.told.get(key)
      if (!last) this.send(key, { kind: "settings", at: now, digest, usage: this.settings.kept(), ask: true })
      else if (last.digest !== digest && (changed || now - last.at >= TELL_AGAIN)) this.send(key, { kind: "settings", at: now, digest, usage: this.settings.kept() })
      else if (now - last.at >= TELL_AGAIN) this.send(key, { kind: "settings", at: now, digest })
      else continue
      this.told.set(key, { digest, at: now })
    }
  }

  /** What another box told (`from`, its key): taken only from one of your own computers. */
  take(from: string, mail: unknown) {
    if (!isSettingsMail(mail) || !this.ours().includes(from)) return
    // (Newer parts taken tell the rest of your computers, `listen` above.)
    if (mail.usage) this.settings.merge(mail.usage)
    if (!this.transport.followed) return
    const digest = this.settings.digest()
    const now = this.now()
    if (mail.ask === true) {
      // Asked: all of it, whatever it was told lately.
      this.send(from, { kind: "settings", at: now, digest, usage: this.settings.kept() })
    } else if (typeof mail.digest === "string" && mail.digest !== digest && now - (this.answered.get(from) ?? -Infinity) >= MINUTE) {
      // It holds something else: all of this box's, and, when it said only what it holds, its own asked for.
      this.answered.set(from, now)
      this.send(from, { kind: "settings", at: now, digest, usage: this.settings.kept(), ...(mail.usage ? {} : { ask: true as const }) })
    } else return
    this.told.set(from, { digest, at: now })
  }

  private send(to: string, mail: SettingsMail) {
    this.transport.send(to, mail, false)
  }

  private directorySaid() {
    const ours = new Set(this.ours())
    // (A computer gone, or one that's now a box a peer vouches for: forgotten, told again should it come back as yours.)
    for (const map of [this.told, this.answered]) for (const key of [...map.keys()]) if (!ours.has(key)) map.delete(key)
    this.tell()
  }
}
