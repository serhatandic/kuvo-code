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
  answer?: { id: string; outcome: ResetOutcome; until?: number }
  /** Agents may (or may not) use this row's resets without asking: kept with its account there. */
  always?: { row: string; on: boolean }
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
   * `sending`: written before its request went, and not settled since (asked again, it goes as the
   * same request); `done`: its maker answered, or it went no further than this box.
   */
  state: "sending" | "done"
  outcome?: ResetOutcome
  until?: number
}

interface Saved {
  spends: Spend[]
  /** Accounts here (by provider) whose resets agents may use without asking. */
  always?: string[]
}

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
  private always = new Set<string>()
  private waiting = new Map<string, (answer: NonNullable<ResetMail["answer"]>) => void>()
  /** Spends under way here, by id: asked again meanwhile, the same one is waited for. */
  private running = new Map<string, Promise<{ outcome: ResetOutcome; until?: number }>>()

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

  /** Whether agents may use the resets of this account here (by provider) without asking. */
  agentsMay(provider: string): boolean {
    return this.always.has(provider)
  }

  /**
   * Agents may (or may not) use a row's resets without asking: kept with its account on the box
   * whose sign-in spends them (here, or told to that peer). `provider`: an account here, as
   * Settings › Accounts names it.
   */
  setAlways(given: { row?: string; provider?: string }, on: boolean, tell = true): ResetRefusal | null {
    const ownProvider = given.provider ?? (given.row ? this.limits.accountOf(given.row)?.provider : undefined)
    const rowID = given.row ?? (given.provider ? this.limits.rows().find((each) => each.boxes.some((box) => box.here && box.provider === given.provider))?.id : undefined)
    const row = rowID ? this.limits.rows().find((each) => each.id === rowID) : undefined
    // Every other computer of yours with the account's sign-in keeps it too: it's the account's.
    const others = tell ? (row?.boxes ?? []).filter((box) => !box.here && box.key && this.reaches(box.key)) : []
    const ownCan = ownProvider !== undefined && !!this.limits.account(ownProvider)?.limits.reset
    if (!ownCan && !others.length) return { status: row ? 503 : 404, message: row ? "None of your computers with this account's sign-in can be reached now." : "No account of yours by that name has resets." }
    if (ownCan) {
      if (on) this.always.add(ownProvider!)
      else this.always.delete(ownProvider!)
      this.save()
      this.limits.ownChanged()
    }
    for (const box of others) this.transport!.send(box.key, { kind: "reset", at: this.now(), always: { row: row!.id, on } }, true)
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
    const kept = this.spends.find((spend) => spend.id === confirm && spend.row === rowID)
    let result: { outcome: ResetOutcome; until?: number }
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
      if (asked.via) {
        // One of this row's passed there lately that never heard back (Retry, with a new
        // confirmation): asked again under its id, so a reset it used isn't used again.
        const unsettled = this.spends.find((each) => each.via === asked.via && each.row === rowID && each.state === "sending" && this.now() - each.at < UNSETTLED_FOR)
        const spend: Spend = unsettled ?? { id: confirm, row: rowID, via: asked.via, request: confirm, at: this.now(), state: "sending", ...(by ? { by } : {}) }
        if (!unsettled) this.keep(spend)
        result = await this.passed(spend)
      } else {
        result = await this.here(confirm, rowID, asked.provider, by)
      }
    }
    return { done: { ...result, ...(words(result.outcome) ? { message: words(result.outcome) } : {}), row: this.limits.rows().find((each) => each.id === rowID) } }
  }

  /** A peer's reset mail: only from one of your own computers. */
  take(from: string, mail: unknown) {
    if (!isResetMail(mail)) return
    if (this.directory && this.directory.isPeer?.(from) !== true) return
    if (mail.answer && typeof mail.answer.id === "string") {
      this.waiting.get(mail.answer.id)?.(mail.answer)
      return
    }
    if (mail.always && typeof mail.always.row === "string" && typeof mail.always.on === "boolean") {
      const account = this.limits.accountOf(mail.always.row)
      if (account?.limits.reset) this.setAlways({ provider: account.provider }, mail.always.on, false)
      return
    }
    const ask = mail.ask
    if (!ask || typeof ask.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(ask.id) || typeof ask.row !== "string") return
    const by = typeof ask.by === "string" ? ask.by.slice(0, 200) : undefined
    void this.here(`${from}:${ask.id}`, ask.row, undefined, by).then((result) => {
      this.transport?.send(from, { kind: "reset", at: this.now(), answer: { id: ask.id, ...result } }, false)
    })
  }

  /** Whether a peer of yours can be asked now (one a peer vouches for never spends your resets). */
  private reaches(key: string) {
    return !!this.transport?.followed && this.directory?.isPeer?.(key) === true
  }

  /** Asks passed to a peer and waiting for its answer, by id: asked again meanwhile, the same wait. */
  private passing = new Map<string, Promise<{ outcome: ResetOutcome; until?: number }>>()

  /** One passed to the peer with the sign-in: asked (again) there, under the same id. */
  private passed(spend: Spend): Promise<{ outcome: ResetOutcome; until?: number }> {
    const waiting = this.passing.get(spend.id)
    if (waiting) return waiting
    const run = this.pass(spend).finally(() => this.passing.delete(spend.id))
    this.passing.set(spend.id, run)
    return run
  }

  private async pass(spend: Spend): Promise<{ outcome: ResetOutcome; until?: number }> {
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
    if (outcome !== "unknown") {
      spend.state = "done"
      spend.outcome = outcome
      if (typeof answer.until === "number") spend.until = answer.until
      this.save()
    }
    return { outcome, ...(typeof answer.until === "number" ? { until: answer.until } : {}) }
  }

  /** One spent with a sign-in here: once (asked again while it runs, the same run). */
  private here(id: string, rowID: string, provider: string | undefined, by: string | undefined): Promise<{ outcome: ResetOutcome; until?: number }> {
    const running = this.running.get(id)
    if (running) return running
    const run = this.spendHere(id, rowID, provider, by).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async spendHere(id: string, rowID: string, provider: string | undefined, by: string | undefined): Promise<{ outcome: ResetOutcome; until?: number }> {
    let spend = this.spends.find((each) => each.id === id)
    if (spend?.state === "done") return { outcome: spend.outcome!, ...(spend.until ? { until: spend.until } : {}) }
    const account = provider ? this.limits.account(provider) : this.limits.accountOf(rowID)
    if (!account?.limits.reset) return this.settle(spend, id, rowID, "no-reset")
    if (this.limits.held(account.provider)) return this.settle(spend, id, rowID, "not-now")
    if (!spend) {
      // One of this account's never settled (its box stopped as it went): the same request, so
      // what it may have spent isn't spent again.
      const unsettled = this.spends.find((each) => each.provider === account.provider && each.state === "sending" && !each.via && this.now() - each.at < UNSETTLED_FOR)
      spend = { id, row: rowID, provider: account.provider, request: unsettled?.request ?? requestID(), ...(unsettled?.target ? { target: unsettled.target } : {}), at: this.now(), state: "sending", ...(by ? { by } : {}) }
      if (unsettled) {
        unsettled.state = "done"
        unsettled.outcome = "failed"
      }
      // Kept before anything goes to its maker.
      this.keep(spend)
    }
    const kept = spend
    let result: { outcome: ResetOutcome; until?: number }
    try {
      result = await account.limits.reset({ request: kept.request, ...(kept.target ? { target: kept.target } : {}), keep: (target) => {
        kept.target = target
        this.save()
      } }, this.now())
    } catch {
      result = { outcome: "unknown" }
    }
    console.error(`limits: a reset of ${account.provider} ${result.outcome === "reset" ? "was used" : `didn't go through (${result.outcome})`}${kept.by ? `, asked by ${kept.by}` : ""}.`)
    // An answer that says how it went settles it (a refusal too: nothing was spent); with none, it's
    // tried again as the same request.
    if (result.outcome !== "unknown") {
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

  /** One that went no further than this box: settled, as `outcome`. */
  private settle(spend: Spend | undefined, id: string, row: string, outcome: ResetOutcome): { outcome: ResetOutcome } {
    if (spend) {
      spend.state = "done"
      spend.outcome = outcome
      this.save()
    }
    return { outcome }
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
      for (const provider of Array.isArray(saved.always) ? saved.always : []) if (typeof provider === "string") this.always.add(provider)
    } catch {}
  }

  /** The journal, written whole and renamed into place: a spend is kept before its request goes. */
  private save() {
    if (!this.file) return
    const at = this.now()
    this.spends = this.spends.filter((spend) => spend.state === "sending" || at - spend.at < KEEP_FOR).slice(-KEEP)
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + ".new", JSON.stringify({ spends: this.spends, always: [...this.always] } satisfies Saved), { mode: 0o600 })
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
