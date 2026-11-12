// A newer bridge put in this one's place while it works (a Mac that connected brought its own, on a
// box whose sessions work day and night): this one makes way for it without cutting a turn
// (PROTOCOL.md, "A new version while it works"). Once nothing has run for half a minute (no turn,
// no discussion in a group chat, nothing an agent left running, no request under way) it goes, and
// what keeps it running (a machine's launch) starts the new one. Waiting an hour without such a
// moment, it holds new turns from the night's window (02:00 to 05:00 where you are), or after a day
// whatever the hour: what's sent waits in line, kept, and once the turns under way have ended it
// goes, and the new bridge starts what waited. A turn that doesn't end within half an hour of
// holding (one waiting on you overnight) has it let go of what it held, and an hour later (that
// night still, or the next) it holds again. Nothing it ran is cut, and nothing sent is lost or
// started twice.
//
// It makes way only for a bundle that runs on the engine it runs on and that its keeper starts
// (`ready`), that has answered a check on it (`check`), and only while what keeps it running will
// start it: a launch from before October 2026 starts it five times at most, and one since gives up
// after five runs in a row under ten minutes, so it goes only after eleven minutes, and on an older
// launch only while it has started fewer than four times (`lets`).

import { statSync } from "node:fs"
import { dirname } from "node:path"
import { bundleBuild } from "../shared/bundle"
import { nightOf } from "../shared/night"
import type { RenewalRecord, RenewalWait } from "../shared/records"
import { watchFolder } from "../shared/watch"

/** What's under way here: `turns`, which it never cuts (a session's turn, a subagent's, your `!`
 * command, a message being handed to an agent, a session being deleted, a group chat's discussion,
 * a request being answered), and `other`, what it ends as it goes, each saying so as after any
 * restart (what an agent left running in the background, a side question, a review, a handoff, a
 * sign-in), waited for only until it holds. */
export type Work = { turns: boolean; other: boolean }

/** How often it looks (besides when the file changes and when a turn ends); how long nothing must
 * have run before it goes, and the moment it holds before it goes; how long it looks for such a
 * time before holding at night; the longest before it holds whatever the hour; the longest it
 * holds; and how long it runs before it may go (a launch counts a shorter run as a failed one). */
export const renewalTiming = { look: 10_000, settle: 30_000, grace: 1_000, patience: 60 * 60_000, longest: 24 * 60 * 60_000, holding: 30 * 60_000, uptime: 11 * 60_000 }

/** Whether what keeps it running (the machine's launch, `loop` its parent's command line, `log`
 * reading its `run/agents.log`) starts it again once it goes, after a run of eleven minutes
 * (`renewalTiming.uptime`). A launch since October 2026 starts its count again after a run of ten
 * minutes (`-ge 600` in its loop). One from before never does, and starts it five times in all, one
 * `"url"` line in its log each but for a start that ended before it said where it listens: it goes
 * only while there have been fewer than three, two spare. A parent that isn't such a loop: no. One
 * whose command line can't be read (a Mac that won't say): counted from its log, as one from
 * before. A log that can't be read: no. */
export function launchLets(loop: string | undefined, log: () => string | undefined): boolean {
  if (loop !== undefined && !(loop.includes("kuvo-agents") && loop.includes("-lt 5"))) return false
  if (loop?.includes("-ge 600")) return true
  const text = log()
  return text !== undefined && (text.match(/"url"/g) ?? []).length < 3
}

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
  /** Whether the bundle in place runs on the engine it runs on, the one its keeper starts. */
  ready?: () => boolean
  /** Whether what keeps it running starts it again once it goes. */
  lets?: () => boolean
  /** How long it has run (ms), and how long it must have before it goes. */
  uptime?: () => number
  longEnough?: number
  /** Whether a build in place loads and runs here (asked once for each; undefined: it couldn't
   * tell, asked again later). */
  check?: (build: string) => Promise<boolean | undefined>
  now?: () => number
  zone?: string
  /** A test's: it holds this long after it saw the newer one, whatever the hour; and how long
   * nothing must run before it goes. */
  holdAfter?: number
  settle?: number
}

export class Renewal {
  private since?: number
  private waits: RenewalWait = "quiet"
  /** When it began looking for a moment: as it saw the newer one, or as it let go of a hold. */
  private from = 0
  private holding = false
  private heldAt = 0
  private quietSince?: number
  private going = false
  private seen?: string
  private newer?: string
  private checked = new Map<string, boolean | "checking">()
  private looking?: ReturnType<typeof setInterval>
  private watching?: { close(): void }

  constructor(private readonly options: RenewalOptions) {}

  start() {
    this.looking = setInterval(() => this.look(), renewalTiming.look)
    this.looking.unref?.()
    try {
      this.watching = watchFolder(dirname(this.options.script), () => this.look())
    } catch {}
    this.look()
  }

  stop() {
    clearInterval(this.looking)
    this.watching?.close()
  }

  get state(): RenewalRecord | null {
    return this.since === undefined ? null : { since: this.since, holding: this.holding, waits: this.waits }
  }

  /** Whether it holds new turns now, having looked for a quiet moment `from` then. */
  holdsNow(from: number, now: number): boolean {
    const waited = now - from
    if (this.options.holdAfter !== undefined) return waited >= this.options.holdAfter
    return waited >= renewalTiming.longest || (waited >= renewalTiming.patience && nightOf(new Date(now), this.options.zone) !== null)
  }

  look() {
    if (this.going) return
    const now = this.options.now?.() ?? Date.now()
    const build = this.newerInPlace()
    if (!build) {
      // Its own back in place (or none there): nothing to make way for.
      if (this.since === undefined) return
      this.since = undefined
      this.quietSince = undefined
      this.letGo()
      this.waits = "quiet"
      return this.tell()
    }
    if (this.since === undefined) {
      this.since = this.from = now
      this.tell()
    }
    // Holding no longer than it may, whatever else holds it up (a turn waiting on you overnight, an
    // update of the box that never finished): what waited goes, and it looks again.
    if (this.holding && now - this.heldAt >= renewalTiming.holding) {
      this.from = now
      this.letGo()
      this.tell()
    }
    if (this.options.paused?.()) return
    const blocked = this.blocked(build)
    if (blocked) {
      this.quietSince = undefined
      this.letGo()
      return this.tell(blocked)
    }
    if (!this.holding && this.checked.get(build) !== "checking" && this.holdsNow(this.from, now)) {
      this.holding = true
      this.heldAt = now
      this.options.hold(true)
    }
    this.tell(this.holding ? "holding" : "quiet")
    if (!this.quiet()) {
      this.quietSince = undefined
      return
    }
    // Quiet a while (holding, the turns it waited for have ended): nothing new starts, and if it's
    // still quiet a moment later (what was being sent has come in, and waits for the new one), it
    // goes.
    this.quietSince ??= now
    if (!this.holding && now - this.quietSince < (this.options.settle ?? renewalTiming.settle)) return
    if ((this.options.uptime?.() ?? Infinity) < (this.options.longEnough ?? renewalTiming.uptime)) return
    this.going = true
    if (!this.holding) this.options.hold(true)
    const later = setTimeout(() => {
      if (this.quiet() && this.newerInPlace() === build && !this.options.paused?.()) return this.options.renew()
      this.going = false
      this.quietSince = undefined
      if (!this.holding) this.options.hold(false)
    }, renewalTiming.grace)
    later.unref?.()
  }

  /** Why it can't make way for `build` now, beyond what's under way: it waits for its engine, or
   * for a restart (the build doesn't run here, or nothing would start it again). */
  private blocked(build: string): RenewalWait | undefined {
    if (!(this.options.ready?.() ?? true)) return "engine"
    if (!(this.options.lets?.() ?? true)) return "restart"
    if (!this.options.check) return undefined
    const checked = this.checked.get(build)
    if (checked === undefined) {
      this.checked.set(build, "checking")
      void this.options
        .check(build)
        .then(
          (ok) => (ok === undefined ? this.checked.delete(build) : this.checked.set(build, ok)),
          () => this.checked.delete(build),
        )
        .then(() => this.look())
      return undefined
    }
    if (checked === false) return "restart"
    return undefined
  }

  /** Something just ran (a turn ended, a request came): a quiet moment counts from now. */
  busied() {
    this.quietSince = undefined
  }

  private tell(waits: RenewalWait = this.waits) {
    const changed = waits !== this.waits
    this.waits = waits
    if (changed || this.lastTold !== JSON.stringify(this.state)) {
      this.lastTold = JSON.stringify(this.state)
      this.options.told(this.state)
    }
  }
  private lastTold?: string

  private letGo() {
    if (!this.holding) return
    this.holding = false
    this.options.hold(false)
  }

  private quiet(): boolean {
    if (this.checked.get(this.newer ?? "") === "checking") return false
    const work = this.options.work()
    return !work.turns && (this.holding || !work.other)
  }

  /** The build in its place now, when it's another than its own: read again only when the file
   * changed (one being replaced, a moment missing, is as it was). */
  private newerInPlace(): string | undefined {
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
    this.newer = build !== null && build !== this.options.build ? build : undefined
    return this.newer
  }
}
