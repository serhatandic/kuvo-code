// Spending a plan's resets (Claude's reset grants, Codex's reset credits), from any client or an
// agent's tool, through the box (PROTOCOL.md, "Plan limits", "Resets"). Two steps: asked first, the
// box answers what it would spend and a one-time `confirm` id; asked again with that id, it spends
// one, once. A reset spends what's the user's, so each spend is written to a journal before its
// request goes, with the request id its maker takes as the same request (Anthropic's `request_id`,
// Codex's `redeem_request_id`) and what it spends (the grant, the credit): asked again after a
// crash, a lost answer or a failure, it goes as the same request, and its maker answers that it's
// done rather than spending another. It runs on the computer that holds the account's sign-in: a box
// without one (a Mac's Claude token can only run Claude) passes it to the peer of yours that has
// one (`{"seat": {"kind": "reset"}}`, only between your own computers: never a box a peer vouches
// for, nor through a machine two people's Macs share, nor a box of another setup), and answers when
// that one does. Whether agents may use an account's resets without asking (Always Allow) is kept
// here too, with the account, on the box whose sign-in spends them, and told only to your own
// computers.

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Limits, ResetOutcome } from "./limits"
import type { LimitsDirectory } from "./limits-peers"
import type { LimitRow } from "./limits-rows"

/** What one box tells another of a reset (`{"seat": {"kind": "reset", …}}` between links). */
export interface ResetMail {
  kind: "reset"
  at: number
  /** Spend one of this row's resets (`id`: the asking box's own for it; asked again, the same). */
  ask?: { id: string; row: string; by?: string; unasked?: true }
  /** How the ask `id` went. */
  answer?: { id: string; outcome: ResetOutcome; until?: number; already?: true; open?: true; message?: string }
  /** Agents may (or may not) use this row's resets without asking, as decided at `at` (the sender's clock): kept with its account there unless a later decision is. */
  always?: { row: string; on: boolean; at?: number }
}

export const isResetMail = (value: any): value is ResetMail => value !== null && typeof value === "object" && value.kind === "reset"

/** What carries a reset's mail to a peer (the bridge's mail to its link). */
export interface ResetTransport {
  send(to: string, mail: ResetMail, durable: boolean): void
  readonly followed: boolean
}

/** What the first ask answers: what one more ask, with `confirm`, spends. */
export interface ResetOffer {
  /** Asked again with this (within `expires`), one reset is spent. Once. */
  confirm: string
  row: string
  service: string
  /** How many there are now: one of them is spent. */
  count: number
  /** The windows one refills, where its maker says. */
  refills?: string[]
  /** The computer whose sign-in spends it. */
  on: { key: string; name: string; here?: true }
  /** Whether agents may use this account's resets without asking (Always Allow). */
  always: boolean
  /** Until when `confirm` holds (ms). */
  expires: number
}

/** One spend, as the journal keeps it. */
interface Spend {
  /** The confirm id it was asked with (`<peer>:<id>` for one a peer passed here). */
  id: string
  /** Confirm ids asked since, while it was still unsettled: each is this same spend. */
  also?: string[]
  row: string
  provider?: string
  /** The peer it was passed to (this box has no sign-in to spend it). */
  via?: string
  /** Its maker's request id: the same however often it's tried. */
  request: string
  /** What it spends (a grant, a credit), once chosen: the same however often it's tried. */
  target?: string
  /** Who asked: a client, or an agent (its name). */
  by?: string
  /** An agent's, under Always Allow (no one confirmed it): spent only while it's allowed on the box that spends it. */
  unasked?: true
  at: number
  /**
   * `sending`: written before its request went, and not settled since (no answer came, or its
   * maker couldn't say it went through: asked again, it goes as the same request); `done`: its maker
   * said how it went, or it went no further than this box.
   */
  state: "sending" | "done"
  outcome?: ResetOutcome
  until?: number
}

interface Saved {
  spends: Spend[]
  /**
   * Whether agents may use an account's resets without asking, by account (its row,
   * `<service>#<identity>`): the latest decision, and when (ms), here or on another of your
   * computers. A decision older than the one kept never takes its place.
   */
  allowed?: Record<string, { on: boolean; at: number }>
  /** The account each slot here (by provider) was last seen signed in to. */
  seen?: Record<string, string>
}

/** How a spend went here or there: `already`, its maker said this same request was done before; `message`, said in place of the outcome's own words. */
type Result = { outcome: ResetOutcome; until?: number; already?: true; message?: string; open?: true }

/** Said of an agent's reset under Always Allow that's off for its account now. */
const NOT_ALLOWED = "Always Allow is off for this account now: nothing was used. Ask the user first."

/** A new confirmation joins a row's open spend this long after it was asked; later, that one is settled first and the new one goes as its own. */
const JOIN_FOR = 10 * 60_000

/** Said of a spend still open that couldn't be asked again from here just now. */
const STILL_OPEN = "It can't be asked of its maker from here right now. An earlier try may have gone through: asking again later won't use another."

/** Outcomes that leave a spend open: it may have gone, so asked again, it's the same request. */
const OPEN: ReadonlySet<ResetOutcome> = new Set(["unknown", "unconfirmed"])

const MINUTE = 60_000
/** A confirm id holds this long: a confirmation left open longer asks again. */
export const CONFIRM_FOR = 10 * MINUTE
/** How long a box waits for the peer it passed a reset to. */
const PEER_WAIT = 45_000
/** Spends kept in the journal: the last ones, for a month. */
const KEEP = 200
const KEEP_FOR = 30 * 24 * 60 * MINUTE
/** How long an answer waits for the account to be read again after a reset. */
const READ_AFTER = 8_000

/** A refusal, in words, with the status a route answers it with. */
export interface ResetRefusal {
  status: 404 | 409 | 503
  message: string
}

/** How a spend went, and the account's row as it is now. */
export interface ResetDone {
  outcome: ResetOutcome
  until?: number
  /** Why, in words, where it didn't go through. */
  message?: string
  row?: LimitRow
}

export class LimitResets {
  private confirms = new Map<string, { row: string; at: number; via?: string; provider?: string }>()
  private spends: Spend[] = []
  private allowed = new Map<string, { on: boolean; at: number }>()
  private seen = new Map<string, string>()
  private waiting = new Map<string, (answer: NonNullable<ResetMail["answer"]>) => void>()
  /** Spends under way here, by id: asked again meanwhile, the same one is waited for. */
  private running = new Map<string, Promise<Result>>()

  constructor(
    private readonly limits: Limits,
    /** The journal (`limits-resets.json` in the bridge's folder); none in a test that doesn't keep one. */
    private readonly file?: string,
    private readonly now: () => number = Date.now,
    private readonly transport?: ResetTransport,
    private readonly directory?: LimitsDirectory,
    private readonly peerWait = PEER_WAIT,
  ) {
    this.load()
    limits.resets = this
  }

  /**
   * Whether agents may use the resets of this account here (by provider) without asking: only for
   * the account it was allowed for. Signed in to another since, it's forgotten.
   */
  agentsMay(provider: string): boolean {
    const live = this.limits.liveRow(provider)
    if (live === undefined) return false
    this.saw(provider, live)
    return this.allowed.get(live)?.on === true
  }

  /**
   * The account this slot's sign-in is now: signed in to another since it was last seen, what was
   * allowed for the one before isn't any more (coming back, agents ask again).
   */
  private saw(provider: string, live: string) {
    const before = this.seen.get(provider)
    if (before === live) return
    this.seen.set(provider, live)
    this.save()
    // (Decided here, as any decision is: stamped and told your other computers.)
    if (before && this.allowed.get(before)?.on) this.decideHere(before, false)
  }

  /**
   * A decision made here: stamped after any this box knows of (another computer's clock may be
   * ahead of this one's), so it's always kept here; and told to every computer of yours, as mail
   * that's kept until it's there.
   */
  private decideHere(rowID: string, on: boolean) {
    const at = Math.max(this.now(), (this.allowed.get(rowID)?.at ?? 0) + 1)
    this.decide(rowID, on, at)
    for (const box of this.yours()) this.transport?.send(box.key, { kind: "reset", at, always: { row: rowID, on, at } }, true)
  }

  /** Your other computers (never a box a peer only vouches for, a machine two people's Macs share, or a box of another setup). */
  private yours() {
    const own = this.directory?.own()?.key
    return (this.directory?.peerBoxes() ?? []).filter((box) => box.key && box.key !== own && this.isYours(box.key))
  }

  /** Whether a box is one of your own computers (`LimitsDirectory.isYours`). */
  private isYours(key: string) {
    return this.directory?.isYours?.(key) === true
  }

  /**
   * A decision for an account, kept unless a later one is; of two at once, an off (Always Allow
   * turned off is never lost to an on stamped the same); whether it was taken.
   */
  private decide(rowID: string, on: boolean, at: number): boolean {
    const kept = this.allowed.get(rowID)
    if (kept && (kept.at > at || (kept.at === at && on && !kept.on))) return false
    this.allowed.set(rowID, { on, at })
    this.save()
    this.changedSoon()
    return true
  }

  private telling = false

  /**
   * The accounts' listing told it changed, once this turn is over: a decision can be made while
   * that listing is being made (a slot seen signed in to another account), which mustn't make it
   * again from inside itself.
   */
  private changedSoon() {
    if (this.telling) return
    this.telling = true
    queueMicrotask(() => {
      this.telling = false
      this.limits.ownChanged()
    })
  }

  /**
   * Agents may (or may not) use a row's resets without asking. Kept here as decided now, after any
   * decision this box knows of, and told to every computer of yours: a computer that has heard it
   * keeps it unless a later decision comes; one that decided otherwise before hearing this one
   * keeps whichever is stamped later (their clocks may differ by as much as they're apart).
   * `provider`: an account here, as Settings › Accounts names it.
   */
  setAlways(given: { row?: string; provider?: string }, on: boolean): ResetRefusal | null {
    const ownProvider = given.provider ?? (given.row ? this.limits.accountOf(given.row)?.provider : undefined)
    // The account, by who it is: never a slot another account may be signed in to later.
    const rowID = given.row ?? (given.provider ? this.limits.accountRow(given.provider) : undefined)
    if (!rowID) return { status: 404, message: "No account of yours by that name has resets." }
    if (!rowID.includes("#")) return { status: 409, message: "This account doesn't say who it is yet, so Always Allow can't be kept for it." }
    const ownCan = ownProvider !== undefined && !!this.limits.account(ownProvider)?.limits.reset && this.limits.liveRow(ownProvider) === rowID
    if (!ownCan && !this.yours().length) return { status: 404, message: "No computer of yours has this account's sign-in." }
    if (ownCan) this.saw(ownProvider!, rowID)
    this.decideHere(rowID, on)
    return null
  }

  /** First step: what a spend would be, and the id that spends it. */
  ask(rowID: string): { offer: ResetOffer } | { refused: ResetRefusal } {
    const row = this.limits.rows().find((each) => each.id === rowID)
    if (!row) return { refused: { status: 404, message: "No account of yours by that name." } }
    const resets = row.extras?.find((extra) => extra.kind === "resets")
    if (!resets) {
      const unread = row.extras?.find((extra) => extra.kind === "unreadable")
      return { refused: { status: 409, message: unread?.message ?? "This account has no resets." } }
    }
    if (!(Number(resets.count) >= 1)) return { refused: { status: 409, message: "This account has no resets left." } }
    if (!resets.on) return { refused: { status: 409, message: "None of your computers can use this account's resets now." } }
    let provider: string | undefined
    if (resets.on.here) {
      const account = this.limits.accountOf(rowID)
      if (!account?.limits.reset) return { refused: { status: 409, message: "This computer's sign-in can't use this account's resets." } }
      if (this.limits.held(account.provider)) return { refused: { status: 409, message: "Its maker is turning requests away for now: try again later." } }
      provider = account.provider
    } else if (!this.reaches(resets.on.key)) {
      return { refused: { status: 503, message: `${resets.on.name || "The computer with its sign-in"} can't be reached now: its reset is used there.` } }
    }
    const at = this.now()
    for (const [id, kept] of this.confirms) if (at - kept.at > CONFIRM_FOR) this.confirms.delete(id)
    const confirm = `rsc_${randomBytes(12).toString("hex")}`
    this.confirms.set(confirm, { row: rowID, at, ...(resets.on.here ? { provider } : { via: resets.on.key }) })
    return {
      offer: {
        confirm,
        row: rowID,
        service: row.service,
        count: Number(resets.count),
        ...(resets.refills?.length ? { refills: resets.refills } : {}),
        on: resets.on,
        // (Not where this box's own decision for it is off, whatever the computer with the sign-in last said.)
        always: resets.agents === true && this.allowed.get(rowID)?.on !== false,
        expires: at + CONFIRM_FOR,
      },
    }
  }

  /**
   * Second step: spends one reset with the id the first gave (once; asked again with it, how it went
   * the first time, or, where that was never settled, the same request again).
   */
  async spend(rowID: string, confirm: string, by?: string, unasked = false): Promise<{ done: ResetDone } | { refused: ResetRefusal }> {
    const kept = this.spends.find((spend) => (spend.id === confirm || spend.also?.includes(confirm)) && spend.row === rowID)
    let result: Result
    if (kept?.state === "done") {
      result = { outcome: kept.outcome!, ...(kept.until ? { until: kept.until } : {}) }
    } else if (kept) {
      // Never settled (the box stopped, no answer came): the same request again.
      result = await this.rerun(kept, rowID)
    } else {
      const asked = this.confirms.get(confirm)
      if (!asked || asked.row !== rowID || this.now() - asked.at > CONFIRM_FOR) return { refused: { status: 404, message: "That confirmation has expired: ask again." } }
      // An agent's under Always Allow: not where this box's own decision for the account is off.
      if (unasked && this.allowed.get(rowID)?.on === false) return { done: { outcome: "failed", message: NOT_ALLOWED, row: this.limits.rows().find((each) => each.id === rowID) } }
      // (Spent once: the id goes now, whatever comes of it; its journal entry answers it after.)
      this.confirms.delete(confirm)
      result = await this.attach(confirm, rowID, { via: asked.via, provider: asked.provider, by, unasked })
    }
    const { already: _, open: __, message, ...told } = result
    return { done: { ...told, ...((message ?? words(result.outcome)) ? { message: message ?? words(result.outcome) } : {}), row: this.limits.rows().find((each) => each.id === rowID) } }
  }

  /** A spend kept, asked again as itself: here, or on the peer it was passed to. */
  private rerun(spend: Spend, rowID: string, given: { provider?: string; by?: string } = {}): Promise<Result> {
    return spend.via ? this.passed(spend) : this.here(spend.id, rowID, spend.provider ?? given.provider, spend.by ?? given.by, spend.unasked === true)
  }

  /**
   * A new ask for a row (`id`: a confirmation here, or `<peer>:<id>` for one a peer passed here),
   * the same way whoever asks. Within 10 minutes of the row's open spend, it's that spend (two at
   * once share one request). Later, the open one is asked again first, as itself: still not known,
   * or used only now, this ask is that one; done before or refused, this one goes as its own (once,
   * however many ask at once). Else its own.
   */
  private async attach(id: string, rowID: string, given: { via?: string; provider?: string; by?: string; unasked?: boolean }): Promise<Result> {
    const join = (spend: Spend) => {
      spend.also = [...new Set([...(spend.also ?? []), id])].slice(-20)
      // Confirmed by the user now: theirs, not only an agent's (the same request, nothing more spent).
      if (!given.unasked) delete spend.unasked
      this.save()
    }
    const open = this.open(rowID, given.via)
    if (open && this.now() - open.at < JOIN_FOR) {
      join(open)
      return this.rerun(open, rowID, given)
    }
    if (open) {
      // (Asked by the user now: theirs before it's asked again, here or on the peer it was passed to.)
      if (!given.unasked && open.unasked) {
        delete open.unasked
        this.save()
      }
      const settled = await this.rerun(open, rowID, given)
      if (OPEN.has(settled.outcome) || settled.open || (settled.outcome === "reset" && !settled.already)) {
        join(open)
        return settled
      }
      // (Another ask, at once, may have gone as its own meanwhile: this one is that one.)
      const since = this.open(rowID, given.via)
      if (since && since !== open) {
        join(since)
        return this.rerun(since, rowID, given)
      }
    }
    if (given.via) {
      // Never kept as open when it can't go: nothing was sent.
      if (!this.reaches(given.via)) return { outcome: "failed" }
      const spend: Spend = { id, row: rowID, via: given.via, request: id, at: this.now(), state: "sending", ...(given.by ? { by: given.by } : {}), ...(given.unasked ? { unasked: true as const } : {}) }
      this.keep(spend)
      return this.passed(spend)
    }
    return this.here(id, rowID, given.provider, given.by, given.unasked === true)
  }

  /** This row's spend still open (passed to `via`, or here), from the last day. */
  private open(rowID: string, via?: string): Spend | undefined {
    return this.spends.findLast((each) => each.row === rowID && each.state === "sending" && (via ? each.via === via : !each.via) && this.now() - each.at < UNSETTLED_FOR)
  }

  /** A peer's reset mail: only from one of your own computers (another owner's, through a machine you share, never spends yours). */
  take(from: string, mail: unknown) {
    if (!isResetMail(mail)) return
    if (this.directory && !this.isYours(from)) return
    if (mail.answer && typeof mail.answer.id === "string") {
      this.waiting.get(mail.answer.id)?.(mail.answer)
      return
    }
    if (mail.always && typeof mail.always.row === "string" && mail.always.row.includes("#") && typeof mail.always.on === "boolean") {
      // Kept as decided then, whether or not this box knows the account yet (an "off" for one it
      // learns of later holds then), unless a later decision is.
      const at = typeof mail.always.at === "number" ? mail.always.at : typeof mail.at === "number" ? mail.at : 0
      this.decide(mail.always.row, mail.always.on, at)
      return
    }
    const ask = mail.ask
    if (!ask || typeof ask.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(ask.id) || typeof ask.row !== "string") return
    const by = typeof ask.by === "string" ? ask.by.slice(0, 200) : undefined
    // Asked before: as itself. New: as any new ask here (`attach`).
    const id = `${from}:${ask.id}`
    const known = this.spends.find((each) => each.id === id || each.also?.includes(id))
    const unasked = ask.unasked === true
    // (Asked again as confirmed by the user, where an agent asked it first: the user's now.)
    if (known && !unasked && known.unasked) {
      delete known.unasked
      this.save()
    }
    const run = known ? (known.state === "done" ? this.here(known.id, ask.row, known.provider, by) : this.rerun(known, ask.row, { by })) : this.attach(id, ask.row, { by, unasked })
    void run.then((result) => {
      this.transport?.send(from, { kind: "reset", at: this.now(), answer: { id: ask.id, outcome: result.outcome, ...(result.until ? { until: result.until } : {}), ...(result.already ? { already: true as const } : {}), ...(result.open || OPEN.has(result.outcome) ? { open: true as const } : {}), ...(result.message ? { message: result.message.slice(0, 300) } : {}) } }, false)
    })
  }

  /** Whether one of your own computers can be asked now (any other box never spends your resets). */
  private reaches(key: string) {
    return !!this.transport?.followed && this.isYours(key)
  }

  /** Asks passed to a peer and waiting for its answer, by id: asked again meanwhile, the same wait. */
  private passing = new Map<string, Promise<Result>>()

  /** One passed to the peer with the sign-in: asked (again) there, under the same id. */
  private passed(spend: Spend): Promise<Result> {
    const waiting = this.passing.get(spend.id)
    if (waiting) return waiting
    const run = this.pass(spend).finally(() => this.passing.delete(spend.id))
    this.passing.set(spend.id, run)
    return run
  }

  private async pass(spend: Spend): Promise<Result> {
    // (Can't go now: it stays open, as it may have gone before; asked again, it's asked there under
    // the same id.)
    if (!this.reaches(spend.via!)) return { outcome: "not-now", message: STILL_OPEN, open: true }
    const answer = await new Promise<NonNullable<ResetMail["answer"]> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.peerWait)
      timer.unref?.()
      this.waiting.set(spend.id, (given) => {
        clearTimeout(timer)
        resolve(given)
      })
      this.transport!.send(spend.via!, { kind: "reset", at: this.now(), ask: { id: spend.id, row: spend.row, ...(spend.by ? { by: spend.by } : {}), ...(spend.unasked ? { unasked: true as const } : {}) } }, false)
    })
    this.waiting.delete(spend.id)
    // No answer in time: it may have been used there.
    if (!answer) return { outcome: "unknown" }
    const outcome = OUTCOMES.has(answer.outcome) ? answer.outcome : "unknown"
    // (Not settled there either, or refused there while it's open: asked again, it's asked again
    // there, under the same id.)
    const open = OPEN.has(outcome) || answer.open === true
    if (!open) {
      spend.state = "done"
      spend.outcome = outcome
      if (typeof answer.until === "number") spend.until = answer.until
      this.save()
    }
    return { outcome, ...(typeof answer.until === "number" ? { until: answer.until } : {}), ...(answer.already === true ? { already: true as const } : {}), ...(answer.open === true && !OPEN.has(outcome) ? { message: STILL_OPEN, open: true as const } : typeof answer.message === "string" && answer.message ? { message: answer.message.slice(0, 300) } : {}) }
  }

  /** One spent with a sign-in here: once (asked again while it runs, the same run). */
  private here(id: string, rowID: string, provider: string | undefined, by: string | undefined, unasked = false): Promise<Result> {
    const running = this.running.get(id)
    if (running) return running
    const run = this.spendHere(id, rowID, provider, by, unasked).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async spendHere(id: string, rowID: string, provider: string | undefined, by: string | undefined, unasked: boolean): Promise<Result> {
    let spend = this.spends.find((each) => each.id === id)
    // (Done before: as it went, and said to be the same request's, not a reset used now.)
    if (spend?.state === "done") return { outcome: spend.outcome!, ...(spend.until ? { until: spend.until } : {}), ...(spend.outcome === "reset" ? { already: true as const } : {}) }
    const fresh = !spend
    // Refused here before anything goes: one already open stays open (an earlier try may have
    // gone), and says so; a new one is only refused.
    const refused = (outcome: ResetOutcome, message?: string): Result => (!fresh ? { outcome, message: STILL_OPEN, open: true } : { outcome, ...(message ? { message } : {}) })
    const account = provider ? this.limits.account(provider) : this.limits.accountOf(rowID)
    if (!account?.limits.reset) return refused("no-reset")
    if (this.limits.held(account.provider)) return refused("not-now")
    // An agent's under Always Allow, no one having confirmed it: only while this box, which spends
    // it, has it allowed (turned off anywhere, it's off here once told).
    if ((unasked || spend?.unasked) && this.allowed.get(rowID)?.on !== true) return refused("failed", NOT_ALLOWED)
    if (!spend) {
      spend = { id, row: rowID, provider: account.provider, request: requestID(), at: this.now(), state: "sending", ...(by ? { by } : {}), ...(unasked ? { unasked: true as const } : {}) }
      // Kept before anything goes to its maker (and before anything is waited for, so another ask
      // at once finds it).
      this.keep(spend)
    }
    /** The sign-in its maker checked, where it was (`spender`). */
    let signIn: unknown
    // A new one stopped before anything went: settled as that.
    const stopped = (outcome: ResetOutcome): Result => {
      if (!fresh) return { outcome, message: STILL_OPEN, open: true }
      spend!.state = "done"
      spend!.outcome = outcome
      this.save()
      return { outcome }
    }
    // The account signed in there now, right before it's spent from (not as last read; by its
    // token's own answer where its maker gives one): another account signed in since never pays for
    // this one's reset, and Always Allow for it goes.
    if (rowID.includes("#")) {
      const live = this.limits.liveRow(account.provider)
      if (live === undefined) return stopped("not-now")
      if (live !== rowID) {
        // (Signed in to another since: what was allowed for this one isn't any more.)
        this.saw(account.provider, live)
        return stopped("no-reset")
      }
      // Where the sign-in's own files can lag (Claude's), its maker is asked too. Nothing of what's
      // allowed changes on that: whichever of the two lags, the newly signed-in account's stays.
      if (account.limits.spender) {
        const checked = await account.limits.spender().catch(() => undefined)
        if (checked === undefined) return stopped("not-now")
        if (!checked.same) return stopped("no-reset")
        // (Spent with the very sign-in that was checked, whatever's signed in by then.)
        signIn = checked.signIn
      }
    }
    const kept = spend
    let result: Result
    try {
      result = await account.limits.reset({ request: kept.request, ...(kept.target ? { target: kept.target } : {}), ...(signIn !== undefined ? { signIn } : {}), keep: (target) => {
        kept.target = target
        this.save()
      } }, this.now())
    } catch {
      result = { outcome: "unknown" }
    }
    console.error(`limits: a reset of ${account.provider} ${result.outcome === "reset" ? "was used" : `didn't go through (${result.outcome})`}${kept.by ? `, asked by ${kept.by}` : ""}.`)
    // An answer that says how it went settles it (a refusal too: nothing was spent); one that
    // doesn't (no answer, or its maker couldn't say) leaves it open: asked again, the same request.
    if (!OPEN.has(result.outcome)) {
      kept.state = "done"
      kept.outcome = result.outcome
      if (result.until) kept.until = result.until
      this.save()
    }
    if (result.outcome === "reset" || result.outcome === "unconfirmed" || result.outcome === "no-reset" || result.outcome === "unknown") {
      account.limits.afterReset?.()
      await Promise.race([this.limits.readAgain(account.provider), new Promise((resolve) => setTimeout(resolve, READ_AFTER).unref?.())])
    }
    return result
  }


  private keep(spend: Spend) {
    this.spends.push(spend)
    this.save()
  }

  private load() {
    if (!this.file) return
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved
      this.spends = (Array.isArray(saved.spends) ? saved.spends : []).filter((spend) => spend && typeof spend.id === "string" && typeof spend.request === "string" && typeof spend.row === "string")
      for (const [row, decided] of Object.entries(saved.allowed ?? {})) if (row.includes("#") && typeof decided?.on === "boolean" && typeof decided.at === "number") this.allowed.set(row, { on: decided.on, at: decided.at })
      for (const [provider, row] of Object.entries(saved.seen ?? {})) if (typeof row === "string") this.seen.set(provider, row)
    } catch {}
  }

  /** The journal, written whole and renamed into place: a spend is kept before its request goes. */
  private save() {
    if (!this.file) return
    const at = this.now()
    this.spends = this.spends.filter((spend) => spend.state === "sending" || at - spend.at < KEEP_FOR).slice(-KEEP)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + ".new", JSON.stringify({ spends: this.spends, allowed: Object.fromEntries(this.allowed), seen: Object.fromEntries(this.seen) } satisfies Saved), { mode: 0o600 })
    renameSync(this.file + ".new", this.file)
  }
}

const OUTCOMES = new Set<ResetOutcome>(["reset", "unconfirmed", "nothing-to-reset", "no-reset", "not-now", "failed", "unknown"])
/** A spend never settled is asked again as the same request for this long (its grant or credit may be gone after). */
const UNSETTLED_FOR = 24 * 60 * MINUTE

/** A request id as makers take them (letters, digits, `-`, `_`). */
const requestID = () => randomBytes(16).toString("hex")

/** Why one didn't go through, in words; none for one that did. */
export function words(outcome: ResetOutcome): string | undefined {
  switch (outcome) {
    case "reset":
      return undefined
    case "unconfirmed":
      return "It may still be going through: check again in a minute."
    case "nothing-to-reset":
      return "Nothing to reset: this account isn't at a limit. Nothing was used."
    case "no-reset":
      return "That reset isn't available any more. Nothing was used."
    case "not-now":
      return "Resets can't be used right now. Nothing was used."
    case "failed":
      return "Didn't go through. Nothing was used."
    case "unknown":
      return "No answer came, so it may have been used. Asking again won't use another."
  }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

/**
 * `POST api/kuvo/limits/reset {row}` → `{data: ResetOffer}`; `{row, confirm}` → `{data: ResetDone}`;
 * `PUT api/kuvo/limits/reset/always {row | provider, always}` (PROTOCOL.md, "Plan limits", "Resets").
 */
export async function resetRoutes(resets: LimitResets | undefined, method: string, rest: string[], body: () => Promise<any>): Promise<Response> {
  if (!resets) return json({ message: "Resets aren't used from this computer." }, 503)
  const given = await body().catch(() => undefined)
  if (!rest.length && method === "POST") {
    if (typeof given?.row !== "string" || !given.row) return json({ message: "Say which account (row)." }, 400)
    if (given.confirm === undefined) {
      const asked = resets.ask(given.row)
      return "refused" in asked ? json({ message: asked.refused.message }, asked.refused.status) : json({ data: asked.offer })
    }
    if (typeof given.confirm !== "string" || !given.confirm) return json({ message: "That isn't a confirmation." }, 400)
    const spent = await resets.spend(given.row, given.confirm, typeof given.by === "string" ? given.by.slice(0, 200) : undefined, given.unasked === true)
    return "refused" in spent ? json({ message: spent.refused.message }, spent.refused.status) : json({ data: spent.done })
  }
  if (rest.length === 1 && rest[0] === "always" && method === "PUT") {
    if (typeof given?.always !== "boolean" || (typeof given.row !== "string" && typeof given.provider !== "string")) return json({ message: "Say which account (row or provider), and always." }, 400)
    const refused = resets.setAlways({ ...(typeof given.row === "string" ? { row: given.row } : {}), ...(typeof given.provider === "string" ? { provider: given.provider } : {}) }, given.always)
    return refused ? json({ message: refused.message }, refused.status) : json({ data: {} })
  }
  return json({ message: "Not found" }, 404)
}
