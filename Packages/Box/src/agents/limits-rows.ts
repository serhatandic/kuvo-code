// Your plans' limits across your computers, one row per account (PROTOCOL.md, "Plan limits",
// `rows`): what this box read, and what each of your other computers' boxes last told it they read
// (`limits-peers.ts`), as one list, the same on every box. Worked out here, so no client merges.

import type { AgentKind } from "./accounts"
import type { AccountLimits, LimitWindow } from "./limits"

/** One computer's accounts, as this box has them: its own, or what a peer last told. */
export interface LimitsBox {
  /** Its key (this box's own, or "" where it isn't known yet). */
  key: string
  name: string
  /** This box. */
  here: boolean
  /** A peer not heard from for a while: what it said is as of then. */
  away: boolean
  accounts: AccountLimits[]
}

/** A computer an account is signed in on, as a row names it. */
export interface LimitRowBox {
  key: string
  name: string
  /** What it's called there (`claude-code`, `openai`…), the coding agent's, and the name you gave it there. */
  provider: string
  agent?: AgentKind
  account?: string
  label?: string
  /** When its maker last answered it there. */
  checked?: number
  here?: true
  away?: true
}

/** One account across your computers: its newest reading, and every computer it's signed in on. */
export interface LimitRow extends AccountLimits {
  /** The same for the account on every box: `<service>#<identity>`, or `<box key>/<provider>` for one that can't say who it is. */
  id: string
  boxes: LimitRowBox[]
  /** Every computer it's on is away: its numbers are as of their `read`, not live. */
  away?: true
}

/**
 * One row per account across the boxes, in their order (this box first): rows of one `service` with
 * one `identity` are one account, from any box; one without an identity is its box's own.
 */
export function limitRows(boxes: LimitsBox[]): LimitRow[] {
  const groups: { id: string; members: { box: LimitsBox; account: AccountLimits }[] }[] = []
  const found = new Map<string, number>()
  for (const box of boxes) {
    for (const account of box.accounts) {
      const id = account.identity ? `${account.service}#${account.identity}` : `${box.key}/${account.provider}`
      const index = found.get(id)
      if (index !== undefined) groups[index]!.members.push({ box, account })
      else {
        found.set(id, groups.length)
        groups.push({ id, members: [{ box, account }] })
      }
    }
  }
  return groups.map(({ id, members }) => {
    const row: LimitRow = {
      ...merged(members.map((member) => member.account)),
      id,
      boxes: members.map(({ box, account }) => ({
        key: box.key,
        name: box.name,
        provider: account.provider,
        ...(account.agent ? { agent: account.agent } : {}),
        ...(account.account ? { account: account.account } : {}),
        ...(account.label ? { label: account.label } : {}),
        ...(account.checked ? { checked: account.checked } : {}),
        ...(box.here ? { here: true as const } : {}),
        ...(box.away ? { away: true as const } : {}),
      })),
    }
    if (members.every((member) => member.box.away)) row.away = true
    return row
  })
}

/** When an account was last heard of: its maker's last answer, else its newest window. */
const newestOf = (account: AccountLimits) => account.checked ?? Math.max(0, ...account.windows.map((window) => window.read))

/**
 * One account as its boxes state it, together: named as a coding agent's where one is among them
 * (else the engine's sign-in's), with the first name you gave it; each window as read last; the
 * plan, credits, what it has beyond its windows (`extras`) and when it was checked as the newest says; a problem only when none of them could
 * read it.
 */
function merged(members: AccountLimits[]): AccountLimits {
  const base = members.find((member) => member.agent) ?? members[0]!
  if (members.length === 1) return base
  const account: AccountLimits = { ...base }
  const label = members.map((member) => member.label?.trim()).find(Boolean)
  if (label) account.label = label
  else delete account.label
  const windows: LimitWindow[] = []
  for (const member of members) {
    for (const window of member.windows) {
      const index = windows.findIndex((each) => limitOf(each) === limitOf(window))
      if (index < 0) windows.push(window)
      else if (window.read > windows[index]!.read) windows[index] = window
    }
  }
  account.windows = windows
  const newest = [...members].sort((a, b) => newestOf(b) - newestOf(a))
  const plan = newest.find((member) => member.plan)?.plan
  const balance = newest.find((member) => member.balance)?.balance
  const extras = newest.find((member) => member.extras?.length)?.extras
  const checked = Math.max(0, ...members.map((member) => member.checked ?? 0))
  const next = Math.min(...members.map((member) => member.next ?? Infinity))
  for (const key of ["plan", "balance", "extras", "checked", "next", "problem"] as const) delete account[key]
  if (plan) account.plan = plan
  if (balance) account.balance = balance
  if (extras) account.extras = extras
  if (checked) account.checked = checked
  if (Number.isFinite(next)) account.next = next
  if (members.every((member) => member.problem)) account.problem = newest[0]!.problem
  return account
}

/**
 * Which limit a window is, the same from any box and either sign-in to an account (a coding agent's,
 * the engine's), which may name it differently: what it counts, and how long it is.
 */
function limitOf(window: LimitWindow): string {
  if (window.model === undefined && window.name === undefined && window.minutes === undefined) return "id:" + window.id
  return `${window.model?.toLowerCase() ?? ""}|${window.name ?? ""}|${window.minutes ?? ""}`
}
