// Spending a plan's resets (Claude's reset grants, Codex's reset credits), from any client or an
// agent's tool, through the box (PROTOCOL.md, "Plan limits", "Resets"). Two steps: asked first, the
// box answers what it would spend and a one-time `confirm` id; asked again with that id, it spends
// one, once. A reset spends what's the user's, so each spend is written to a journal before its
// request goes, with the request id its maker takes as the same request (Anthropic's `request_id`,
// Codex's `redeem_request_id`) and what it spends (the grant, the credit): asked again after a
// crash, a lost answer or a failure, it goes as the same request, and its maker answers that it's
// done rather than spending another. It runs on the computer that holds the account's sign-in: a box
// without one (a Mac's Claude token can only run Claude) passes it to the peer of yours that has
// one (`{"seat": {"kind": "reset"}}`, only between your own computers), and answers when that one
// does. Whether agents may use an account's resets without asking (Always Allow) is kept here too,
// with the account, on the box whose sign-in spends them.

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
  ask?: { id: string; row: string; by?: string }
  /** How the ask `id` went. */
  answer?: { id: string; outcome: ResetOutcome; until?: number; already?: true }
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
type Result = { outcome: ResetOutcome; until?: number; already?: true; message?: string }

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
    if (before && this.allowed.get(before)?.on) this.allowed.set(before, { on: false, at: this.now() })
    this.save()
  }

  /** A decision for an account, kept unless a later one is (of two at once, the last told); whether it was taken. */
  private decide(rowID: string, on: boolean, at: number): boolean {
    const kept = this.allowed.get(rowID)
    if (kept && kept.at > at) return false
    this.allowed.set(rowID, { on, at })
    this.save()
    this.limits.ownChanged()
    return true
  }

  /**
   * Agents may (or may not) use a row's resets without asking: kept with its account on the box
   * whose sign-in spends them (here, or told to that peer). `provider`: an account here, as
   * Settings › Accounts names it.
   */
  setAlways(given: { row?: string; provider?: string }, on: boolean, tell = true): ResetRefusal | null {
    const ownProvider = given.provider ?? (given.row ? this.limits.accountOf(given.row)?.provider : undefined)
    // The account, by who it is: never a slot another account may be signed in to later.
    const rowID = given.row ?? (given.provider ? this.limits.accountRow(given.provider) : undefined)
    if (!rowID) return { status: 404, message: "No account of yours by that name has resets." }
    if (!rowID.includes("#")) return { status: 409, message: "This account doesn't say who it is yet, so Always Allow can't be kept for it." }
    const row = this.limits.rows().find((each) => each.id === rowID)
    const ownCan = ownProvider !== undefined && !!this.limits.account(ownProvider)?.limits.reset && this.limits.liveRow(ownProvider) === rowID
    // Every other computer of yours with the account's sign-in keeps it too (told as mail that's
    // kept until it's there): it's the account's.
    const others = tell ? (row?.boxes ?? []).filter((box) => !box.here && box.key && this.directory?.isPeer?.(box.key) === true) : []
    if (!ownCan && !others.length) return { status: 404, message: "No computer of yours has this account's sign-in." }
    // Kept here as decided now (an older decision told later doesn't undo it), and told.
    const at = this.now()
    if (ownCan) this.saw(ownProvider!, rowID)
    this.decide(rowID, on, at)
    for (const box of others) this.transport?.send(box.key, { kind: "reset", at, always: { row: rowID, on, at } }, true)
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
        always: resets.agents === true,
        expires: at + CONFIRM_FOR,
      },
    }
  }

  /**
   * Second step: spends one reset with the id the first gave (once; asked again with it, how it went
   * the first time, or, where that was never settled, the same request again).
   */
  async spend(rowID: string, confirm: string, by?: string): Promise<{ done: ResetDone } | { refused: ResetRefusal }> {
    const kept = this.spends.find((spend) => (spend.id === confirm || spend.also?.includes(confirm)) && spend.row === rowID)
    let result: Result
    if (kept?.state === "done") {
      result = { outcome: kept.outcome!, ...(kept.until ? { until: kept.until } : {}) }
    } else if (kept) {
      // Never settled (the box stopped, no answer came): the same request again.
      result = kept.via ? await this.passed(kept) : await this.here(kept.id, kept.row, kept.provider, kept.by)
    } else {
      const asked = this.confirms.get(confirm)
      if (!asked || asked.row !== rowID || this.now() - asked.at > CONFIRM_FOR) return { refused: { status: 404, message: "That confirmation has expired: ask again." } }
      // (Spent once: the id goes now, whatever comes of it; its journal entry answers it after.)
      this.confirms.delete(confirm)
      // One of this account's still open (no answer came, its maker couldn't say, or it runs now:
      // Retry, a second confirmation from another app): this is that same spend, its request, its
      // id there, so a reset it used isn't used again.
      const open = this.open(rowID, asked.via)
      const rerun = (spend: Spend) => (spend.via ? this.passed(spend) : this.here(spend.id, rowID, spend.provider ?? asked.provider, spend.by ?? by))
      const join = (spend: Spend) => {
        spend.also = [...new Set([...(spend.also ?? []), confirm])].slice(-20)
        this.save()
      }
      let settledFirst: Result | undefined
      if (open && this.now() - open.at < JOIN_FOR) {
        join(open)
        result = await rerun(open)
      } else if (open && ((settledFirst = await rerun(open)), OPEN.has(settledFirst.outcome) || (settledFirst.outcome === "reset" && !settledFirst.already))) {
        // An older one, settled first from what its maker says: still not known, or used only now
        // (as it was asked then): that's this one. Done before, or refused: this one goes as its own.
        join(open)
        result = settledFirst
      } else if (asked.via) {
        const spend: Spend = { id: confirm, row: rowID, via: asked.via, request: confirm, at: this.now(), state: "sending", ...(by ? { by } : {}) }
        this.keep(spend)
        result = await this.passed(spend)
      } else {
        result = await this.here(confirm, rowID, asked.provider, by)
      }
    }
    const { already: _, message, ...told } = result
    return { done: { ...told, ...((message ?? words(result.outcome)) ? { message: message ?? words(result.outcome) } : {}), row: this.limits.rows().find((each) => each.id === rowID) } }
  }

  /** This row's spend still open (passed to `via`, or here), from the last day. */
  private open(rowID: string, via?: string): Spend | undefined {
    return this.spends.findLast((each) => each.row === rowID && each.state === "sending" && (via ? each.via === via : !each.via) && this.now() - each.at < UNSETTLED_FOR)
  }

  /** A peer's reset mail: only from one of your own computers. */
  take(from: string, mail: unknown) {
    if (!isResetMail(mail)) return
    if (this.directory && this.directory.isPeer?.(from) !== true) return
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
    // (One of this row's still open here, asked by another of your computers: that same spend.)
    const id = `${from}:${ask.id}`
    const known = this.spends.find((each) => each.id === id || each.also?.includes(id))
    const open = known ? undefined : this.open(ask.row)
    if (open) {
      open.also = [...new Set([...(open.also ?? []), id])].slice(-20)
      this.save()
    }
    void this.here(known?.id ?? open?.id ?? id, ask.row, open?.provider, by).then((result) => {
      this.transport?.send(from, { kind: "reset", at: this.now(), answer: { id: ask.id, outcome: result.outcome, ...(result.until ? { until: result.until } : {}), ...(result.already ? { already: true as const } : {}) } }, false)
    })
  }

  /** Whether a peer of yours can be asked now (one a peer vouches for never spends your resets). */
  private reaches(key: string) {
    return !!this.transport?.followed && this.directory?.isPeer?.(key) === true
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
    // (Not sent: nothing spent this time; asked again, it's asked there under the same id.)
    if (!this.reaches(spend.via!)) return { outcome: "failed" }
    const answer = await new Promise<NonNullable<ResetMail["answer"]> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), this.peerWait)
      timer.unref?.()
      this.waiting.set(spend.id, (given) => {
        clearTimeout(timer)
        resolve(given)
      })
      this.transport!.send(spend.via!, { kind: "reset", at: this.now(), ask: { id: spend.id, row: spend.row, ...(spend.by ? { by: spend.by } : {}) } }, false)
    })
    this.waiting.delete(spend.id)
    // No answer in time: it may have been used there.
    if (!answer) return { outcome: "unknown" }
    const outcome = OUTCOMES.has(answer.outcome) ? answer.outcome : "unknown"
    // (Not settled there either: asked again, it's asked again there, under the same id.)
    if (!OPEN.has(outcome)) {
      spend.state = "done"
      spend.outcome = outcome
      if (typeof answer.until === "number") spend.until = answer.until
      this.save()
    }
    return { outcome, ...(typeof answer.until === "number" ? { until: answer.until } : {}), ...(answer.already === true ? { already: true as const } : {}) }
  }

  /** One spent with a sign-in here: once (asked again while it runs, the same run). */
  private here(id: string, rowID: string, provider: string | undefined, by: string | undefined): Promise<Result> {
    const running = this.running.get(id)
    if (running) return running
    const run = this.spendHere(id, rowID, provider, by).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async spendHere(id: string, rowID: string, provider: string | undefined, by: string | undefined): Promise<Result> {
    let spend = this.spends.find((each) => each.id === id)
    // (Done before: as it went, and said to be the same request's, not a reset used now.)
    if (spend?.state === "done") return { outcome: spend.outcome!, ...(spend.until ? { until: spend.until } : {}), ...(spend.outcome === "reset" ? { already: true as const } : {}) }
    // Refused here before anything goes: one already open stays open (an earlier try may have
    // gone), and says so; a new one is only refused.
    const refused = (outcome: ResetOutcome): Result => (spend ? { outcome, message: STILL_OPEN } : { outcome })
    const account = provider ? this.limits.account(provider) : this.limits.accountOf(rowID)
    if (!account?.limits.reset) return refused("no-reset")
    if (this.limits.held(account.provider)) return refused("not-now")
    // The account signed in there now, right before it's spent from (not as last read): another
    // account signed in since never pays for this one's reset, and Always Allow for it goes.
    if (rowID.includes("#")) {
      const live = this.limits.liveRow(account.provider)
      if (live === undefined) return refused("not-now")
      if (live !== rowID) {
        this.saw(account.provider, live)
        if (this.allowed.get(rowID)?.on) this.decide(rowID, false, this.now())
        return refused("no-reset")
      }
    }
    if (!spend) {
      spend = { id, row: rowID, provider: account.provider, request: requestID(), at: this.now(), state: "sending", ...(by ? { by } : {}) }
      // Kept before anything goes to its maker.
      this.keep(spend)
    }
    const kept = spend
    let result: Result
    try {
      result = await account.limits.reset({ request: kept.request, ...(kept.target ? { target: kept.target } : {}), keep: (target) => {
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
    const spent = await resets.spend(given.row, given.confirm, typeof given.by === "string" ? given.by.slice(0, 200) : undefined)
    return "refused" in spent ? json({ message: spent.refused.message }, spent.refused.status) : json({ data: spent.done })
  }
  if (rest.length === 1 && rest[0] === "always" && method === "PUT") {
    if (typeof given?.always !== "boolean" || (typeof given.row !== "string" && typeof given.provider !== "string")) return json({ message: "Say which account (row or provider), and always." }, 400)
    const refused = resets.setAlways({ ...(typeof given.row === "string" ? { row: given.row } : {}), ...(typeof given.provider === "string" ? { provider: given.provider } : {}) }, given.always)
    return refused ? json({ message: refused.message }, refused.status) : json({ data: {} })
  }
  return json({ message: "Not found" }, 404)
}
