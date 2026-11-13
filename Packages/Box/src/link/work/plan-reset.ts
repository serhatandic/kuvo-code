// use_limit_reset: one of an account's rate-limit resets (Claude's reset grants, Codex's reset
// credits) used now, for an agent that's at a limit and has work to finish. It spends what's the
// user's, so each use asks them first, on the permission card in the conversation (Allow, Always
// Allow for this account, Don't), unless they chose Always Allow for that account (kept with the
// account on the box whose sign-in spends it: Settings › Accounts turns it off). It goes through
// the coding agents' bridge's resets (`api/kuvo/limits/reset`, PROTOCOL.md "Plan limits",
// "Resets"): on this computer, or on the one of yours with the account's sign-in. Every use is said
// in the conversation (the tool's own answer) and in the bridge's log; its answer is the account's
// limits as read just after.

import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import { call } from "../engine/client";
import { HERE } from "../home";
import { describePlanLimits, rowTitle } from "./plan-limits";

/** What a card asks about a reset: the account, by its row's id and name, what it has and where it's used. */
export interface ResetGiven {
  row: string;
  /** "Codex", "Claude Code (Work)". */
  account: string;
  service: string;
  /** How many there are now: one is used. */
  count: number;
  /** The windows one refills (`five_hour`, `seven_day`), where its maker says. */
  refills?: readonly string[];
  /** The computer of yours whose sign-in uses it, where that isn't this one. */
  on?: string;
}

const said = (text: string) => ({ text, isError: false });
const refused = (text: string) => ({ text, isError: true });
const why = (error: unknown) => String((error as Error | null)?.message ?? error);

/** The bridge's rows: every account across your computers. */
async function rowsOf(bridge: Target, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
  const data = await call(bridge, "GET", "/api/kuvo/limits", undefined, signal);
  return isObject(data) && Array.isArray(data.rows) ? data.rows.filter(isObject) : [];
}

const resetsOf = (row: Record<string, unknown>) => (Array.isArray(row.extras) ? row.extras.filter(isObject) : []).find(extra => extra.kind === "resets");

/** The account an agent named (its id as plan_limits gives it, or its name), or why there's none to use. */
export async function resetRow(bridge: Target, wanted: string, signal?: AbortSignal): Promise<{ row: Record<string, unknown> } | { refused: string }> {
  const rows = await rowsOf(bridge, signal);
  const name = wanted.trim().toLowerCase();
  const withResets = rows.filter(row => resetsOf(row));
  const found = rows.find(row => row.id === wanted.trim()) ?? withResets.filter(row => rowTitle(row).toLowerCase() === name || rowTitle(row).toLowerCase().startsWith(name + " ")).at(0);
  if (!found) {
    const listed = withResets.map(row => `- ${rowTitle(row)}: account "${String(row.id)}"`).join("\n");
    return { refused: listed ? `No account of the user's is called ${wanted}. Those with resets:\n${listed}` : "None of the user's accounts has rate-limit resets." };
  }
  return { row: found };
}

/** What the card says of the reset, from the bridge's first answer (`ResetOffer`). */
export function resetGiven(row: Record<string, unknown>, offer: Record<string, unknown>): ResetGiven {
  const on = isObject(offer.on) && offer.on.here !== true && typeof offer.on.name === "string" && offer.on.name ? offer.on.name : undefined;
  return {
    row: String(row.id),
    account: rowTitle(row),
    service: String(row.service ?? ""),
    count: Number(offer.count) || 0,
    ...(Array.isArray(offer.refills) && offer.refills.length ? { refills: offer.refills.filter(each => typeof each === "string").slice(0, 10) } : {}),
    ...(on ? { on } : {}),
  };
}

/**
 * One reset used now (asked of the bridge, then confirmed with the id it gave), and Always Allow
 * kept first where it's given: what the agent hears, with the account's limits as read just after.
 */
export async function spendReset(bridge: Target, row: string, by: string, { always = false, unasked = false, signal }: { always?: boolean; unasked?: boolean; signal?: AbortSignal } = {}): Promise<{ text: string; isError: boolean }> {
  try {
    if (always) await call(bridge, "PUT", "/api/kuvo/limits/reset/always", { row, always: true }, signal);
    let offer: unknown;
    try {
      offer = await call(bridge, "POST", "/api/kuvo/limits/reset", { row }, signal);
    } catch (error) {
      // The computer with its sign-in is away: Always Allow is kept all the same (it gets it once it's
      // back), and the reset waits for it.
      if (always && (error as { status?: number } | null)?.status === 503) return refused(`Always Allow is kept for this account. ${why(error)} So no reset was used now: ask again once it's back.`);
      throw error;
    }
    if (!isObject(offer) || typeof offer.confirm !== "string") return refused("The reset couldn't be asked for.");
    // (`unasked`: no one confirmed it, under Always Allow: the box with the sign-in checks it's still allowed.)
    const done = await call(bridge, "POST", "/api/kuvo/limits/reset", { row, confirm: offer.confirm, by, ...(unasked ? { unasked: true } : {}) }, signal);
    if (!isObject(done)) return refused("The reset's answer didn't come.");
    const limits = isObject(done.row) ? `\n\n${describePlanLimits({ rows: [done.row] })}` : "";
    const name = isObject(done.row) ? rowTitle(done.row) : "the account";
    switch (done.outcome) {
      case "reset":
        console.error(`kuvo-link: ${by} used a reset of ${name}.`);
        return said(`Used one of ${name}'s rate-limit resets: its limits started over.${limits}`);
      case "unconfirmed":
        return said(`The reset of ${name} may still be going through: read plan_limits again in a minute.${limits}`);
      default:
        return refused(`${typeof done.message === "string" ? done.message : "The reset didn't go through. Nothing was used."}${limits}`);
    }
  } catch (error) {
    return refused(`The reset didn't go through: ${why(error)}`);
  }
}

/** What the card asks, in words for a phone's notification. */
export function resetAskWords(name: string, given: ResetGiven): { title: string; body: string } {
  return { title: `${name} asks to use a reset`, body: `${given.account}: 1 of ${given.count}${given.on ? `, on ${given.on}` : ""}` };
}

/**
 * use_limit_reset, from the coding agents' bridge here: the account's reset offered, then, once the
 * user allows it (`ask`, the card; or Always Allow, kept with the account), used.
 */
export async function useResetTool(
  bridge: Target | null,
  args: Record<string, unknown>,
  asker: { session: string; name: string } | null,
  ask: (given: ResetGiven) => Promise<{ text: string; isError: boolean }>,
  signal?: AbortSignal,
): Promise<{ text: string; isError: boolean }> {
  if (!bridge) return refused(`The coding agents aren't running on ${HERE} now, so no reset can be used. Try again in a moment.`);
  if (!asker) return refused("Only a conversation on this computer can use a reset from here.");
  const wanted = typeof args.account === "string" ? args.account.trim() : "";
  if (!wanted) return refused("Say which account (account), as plan_limits lists it.");
  try {
    const found = await resetRow(bridge, wanted, signal);
    if ("refused" in found) return refused(found.refused);
    const id = String(found.row.id);
    // Asked first: what it would use, and whether the user lets agents use them without asking.
    let offer: unknown;
    try {
      offer = await call(bridge, "POST", "/api/kuvo/limits/reset", { row: id }, signal);
    } catch (error) {
      return refused(`${rowTitle(found.row)}'s resets can't be used now: ${why(error)}`);
    }
    if (!isObject(offer)) return refused("The reset couldn't be asked for.");
    if (offer.always === true) return spendReset(bridge, id, asker.name, { unasked: true, signal });
    return ask(resetGiven(found.row, offer));
  } catch (error) {
    return refused(`Couldn't read the plan limits on ${HERE}: ${why(error)}`);
  }
}
