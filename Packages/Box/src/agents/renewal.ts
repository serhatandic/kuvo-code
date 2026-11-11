// A newer bridge put in this one's place while it works (a Mac that connected brought its own, on a
// box whose sessions work day and night): this one makes way for it without cutting a turn
// (PROTOCOL.md, "A new version while it works"). At the first quiet moment (no turn, nothing an
// agent left running) it goes, and what keeps it running (a machine's launch) starts the new one.
// Waiting an hour without one, it holds new turns from the next night's window (02:00 to 05:00
// where you are), or after a day whatever the hour: what's sent waits in line, kept, and once the
// turns under way have ended it goes, and the new bridge starts what waited. Nothing it ran is
// cut, and nothing sent is lost or started twice.

import { statSync, watch } from "node:fs"
import { dirname } from "node:path"
import { bundleBuild } from "../shared/bundle"
import { nightOf } from "../shared/night"
import type { RenewalRecord } from "../shared/records"

/** What's under way here: `turns`, which it never cuts (a session's turn, your `!` command, a side
 * question being answered, a sign-in…), and `other`, what it ends as it goes, said to its session
 * once it's back (what an agent left running in the background), waited for only until it holds. */
export type Work = { turns: boolean; other: boolean }

/** How often it looks (besides when the file changes and when a turn ends); how long it waits once
 * quiet, for what was being sent to come in; how long it looks for a quiet moment before holding
 * at night; and the longest before it holds whatever the hour. */
export const renewalTiming = { look: 10_000, grace: 1_000, patience: 60 * 60_000, longest: 24 * 60 * 60_000 }

export interface RenewalOptions {
  /** The bundle this bridge runs, and its build as it started. */
  script: string
  build: string
  work: () => Work
  /** New turns held, or let go (those held start). */
  hold: (on: boolean) => void
  /** Goes, for the newer one to start. */
  renew: () => void
  /** How it stands, as it changes (null: no newer one in place). */
  told: (state: RenewalRecord | null) => void
  /** Not now (the box is updating itself, which starts everything again anyway). */
  paused?: () => boolean
  now?: () => number
  zone?: string
  /** A test's: it holds this long after it saw the newer one, whatever the hour. */
  holdAfter?: number
}

export class Renewal {
  private since?: number
  private holding = false
  private going = false
  private seen?: string
  private newer = false
  private looking?: ReturnType<typeof setInterval>
  private watching?: { close(): void }

  constructor(private readonly options: RenewalOptions) {}

  start() {
    this.looking = setInterval(() => this.look(), renewalTiming.look)
    this.looking.unref?.()
    try {
      this.watching = watch(dirname(this.options.script), () => this.look())
    } catch {}
    this.look()
  }

  stop() {
    clearInterval(this.looking)
    this.watching?.close()
  }

  get state(): RenewalRecord | null {
    return this.since === undefined ? null : { since: this.since, holding: this.holding }
  }

  /** Whether it holds new turns now, `since` the newer one came. */
  holdsNow(since: number, now: number): boolean {
    const waited = now - since
    if (this.options.holdAfter !== undefined) return waited >= this.options.holdAfter
    return waited >= renewalTiming.longest || (waited >= renewalTiming.patience && nightOf(new Date(now), this.options.zone) !== null)
  }

  look() {
    if (this.going || this.options.paused?.()) return
    const now = this.options.now?.() ?? Date.now()
    if (!this.newerInPlace()) {
      // Its own back in place (or none there): nothing to make way for.
      if (this.since === undefined) return
      this.since = undefined
      if (this.holding) {
        this.holding = false
        this.options.hold(false)
      }
      this.options.told(null)
      return
    }
    if (this.since === undefined) {
      this.since = now
      this.options.told(this.state)
    }
    if (!this.holding && this.holdsNow(this.since, now)) {
      this.holding = true
      this.options.hold(true)
      this.options.told(this.state)
    }
    if (!this.quiet()) return
    // Quiet: nothing new starts, and if it's still quiet a moment later (what was being sent has
    // come in, and waits for the new one), it goes.
    this.going = true
    if (!this.holding) this.options.hold(true)
    const later = setTimeout(() => {
      if (this.quiet() && this.newerInPlace()) return this.options.renew()
      this.going = false
      if (!this.holding) this.options.hold(false)
    }, renewalTiming.grace)
    later.unref?.()
  }

  private quiet(): boolean {
    const work = this.options.work()
    return !work.turns && (this.holding || !work.other)
  }

  /** Whether the bundle in its place now is another build than its own: read again only when the
   * file changed (one being replaced, a moment missing, is as it was). */
  private newerInPlace(): boolean {
    let stat
    try {
      stat = statSync(this.options.script)
    } catch {
      return this.newer
    }
    const seen = `${stat.ino}:${stat.size}:${stat.mtimeMs}`
    if (seen === this.seen) return this.newer
    this.seen = seen
    const build = bundleBuild(this.options.script)
    this.newer = build !== null && build !== this.options.build
    return this.newer
  }
}
