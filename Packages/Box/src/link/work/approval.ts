// How much a conversation's agent does on its own (PROTOCOL.md, "Approval"), kept on the box with
// the conversation (its `kuvo.approval`), so every client shows the same one and no client has to
// guess it from the engine's rules:
// - Ask First: edits, commands and the rest wait for your OK.
// - Accept Edits: edits in its folders go ahead; commands still wait for your OK.
// - Auto: everything inside the sandbox's walls goes ahead; what's beyond them asks. Only where the
//   sandbox runs: elsewhere a conversation set to Auto asks first until it's back (it fails
//   closed, and says why).
// - Full Access: nothing asks, and nothing stands in the way: its commands (and a coding agent's
//   own program) run outside the sandbox, no reviewer, its file tools go anywhere. Picked once you
//   confirmed it on this computer (`box/approval.json`: a client asks you the first time), and
//   never for a bot's work, whatever started it.
// Plan stays the conversation's agent, beside this. What the box writes is the engine's rules for
// it (the coding agents' bridge reads the same ones and sets each agent from them), made again
// with Settings › Permissions as they are, so a Don't Allow there still holds in every one.

import path from "node:path";
import { isObject } from "../../shared/json";
import { textOf, writePrivate } from "../files";
import { BOX } from "../home";
import { holdsBack, isParticular, permissionsHere, refreshedRules } from "../bots/tell";
import { asksPublishing, withAlwaysAsk } from "./always";
import { sandboxGap } from "./sandbox";
import type { KitRule } from "../bots/kit";

export const APPROVALS = ["askFirst", "acceptEdits", "auto", "fullAccess"] as const;
export type Approval = typeof APPROVALS[number];
export const isApproval = (value: unknown): value is Approval => APPROVALS.includes(value as Approval);
const RANK: Record<Approval, number> = { askFirst: 0, acceptEdits: 1, auto: 2, fullAccess: 3 };
/** The lower of two: a session never does more on its own than the one that started it. */
export const lowerOf = (a: Approval, b: Approval): Approval => (RANK[a] <= RANK[b] ? a : b);

export const APPROVAL_FILE = path.join(BOX, "approval.json");

/** Whether you confirmed Full Access on this computer (a client asks you the first time you pick
 * it): until then it can't be picked here. */
export function fullAccessAllowed(file = APPROVAL_FILE): boolean {
  try {
    const kept = JSON.parse(textOf(file) ?? "");
    return isObject(kept) && kept.fullAccess === true;
  } catch {
    return false;
  }
}

export function allowFullAccess(on: boolean, file = APPROVAL_FILE): void {
  let kept: Record<string, unknown> = {};
  try {
    const read = JSON.parse(textOf(file) ?? "");
    if (isObject(read)) kept = read;
  } catch {}
  writePrivate(file, JSON.stringify({ ...kept, fullAccess: on }, null, 2));
}

/** Why one can't be had here now, as a word a client maps and in words; none where it can. */
export interface Unavailable {
  reason: "sandbox" | "fullAccessOff" | "bot";
  why: string;
}

/** Where a conversation is, as its approval goes: on the coding agents (`agents`, whose own
 * programs run its commands), a bot's or its work (`bot`). */
export interface Where {
  agents?: boolean;
  bot?: boolean;
}

const SANDBOX_WHY = {
  off: "Auto needs the sandbox, which isn't running on this computer.",
  partial: "Auto needs the whole sandbox, and on this computer it can't keep commands from the services your login runs.",
  agents: "Auto needs the coding agents' own programs in the sandbox, and some here started before it and still run outside it.",
} as const;

/** Whether `approval` can be had here now: Full Access refused without its switch or for a bot's
 * (it can't be picked), Auto held without the sandbox (it can, and asks first until then). */
export function unavailable(approval: Approval, { agents = false, bot = false }: Where = {}): Unavailable | null {
  if (approval === "fullAccess") {
    if (bot) return { reason: "bot", why: "Bots can't use Full Access: Auto is the most they get." };
    if (!fullAccessAllowed()) return { reason: "fullAccessOff", why: "Full Access isn't confirmed on this computer yet: confirm it first." };
  }
  if (approval === "auto") {
    const gap = sandboxGap(agents);
    if (gap) return { reason: "sandbox", why: SANDBOX_WHY[gap] };
  }
  return null;
}

/** What `wanted` comes to here now: itself where it can be had, else the most it can be (Full
 * Access without its switch or for a bot, Auto; Auto without the sandbox, Ask First), and why: the
 * last step down, what holds it where it is. */
export function effectiveApproval(wanted: Approval, where: Where = {}): { approval: Approval; held?: Unavailable } {
  let approval = wanted;
  let held: Unavailable | undefined;
  if (approval === "fullAccess") {
    const not = unavailable("fullAccess", { bot: where.bot });
    if (not) { held = not; approval = "auto"; }
  }
  if (approval === "auto") {
    const not = unavailable("auto", where);
    if (not) { held = not; approval = "askFirst"; }
  }
  return { approval, ...(held ? { held } : {}) };
}

const SHELL_ASK: KitRule = { action: "shell", resource: "*", effect: "ask" };
const EDITS = new Set(["edit", "write", "patch"]);
const asksFor = (rules: readonly KitRule[], action: string) => rules.some(rule => rule.action === action && rule.resource === "*" && rule.effect === "ask");

/** Whether rules made for `approval` ask before commands (Ask First and Accept Edits do). */
export const asksBeforeCommands = (approval: Approval) => approval === "askFirst" || approval === "acceptEdits";

/** The rules a conversation runs with for `approval`: made with this box's Settings › Permissions
 * as they are (or, where they aren't its own, the Don't Allows it has), its own folders kept; for
 * a bot's, what always comes to you asked whatever it is (`always`). Accept Edits allows edits in
 * place of Ask First's asks for them, so an Ask in Settings doesn't hold them back, and a Don't
 * Allow there, after, still does. */
export function approvalRules(approval: Approval, current: readonly KitRule[], always: { publishing: boolean } | null = null): KitRule[] {
  const settings = permissionsHere() ?? current.filter(holdsBack);
  let made = refreshedRules([...(asksBeforeCommands(approval) ? [SHELL_ASK] : []), ...current.filter(isParticular)], settings);
  if (approval === "acceptEdits") made = made.map(rule => (EDITS.has(rule.action) && rule.resource === "*" && rule.effect === "ask" ? { ...rule, effect: "allow" } : rule));
  // The engine's own file tools aren't in the sandbox: in Auto, what they do outside its folders
  // asks as Settings says it does (the engine asks by itself where Settings says nothing). Full
  // Access lets them, first, so a Don't Allow in Settings, after, still holds.
  if (approval === "auto" && settings.findLast(isOutside)?.effect === "ask") made = made.map(rule => (isOutside(rule) && rule.effect === "allow" ? { ...rule, effect: "ask" } : rule));
  if (approval === "fullAccess") made = [{ action: "external_directory", resource: "*", effect: "allow" }, ...made];
  return always ? withAlwaysAsk(made, always) : made;
}

const isOutside = (rule: KitRule) => rule.action === "external_directory" && rule.resource === "*";

/** What always comes to you, asked in a bot's conversation and its work whatever its approval: and
 * publishing, where its rules asked before it already or its bot's goal does (`publishes`). Null
 * for any other conversation. */
export function alwaysFor(rules: unknown, bot: boolean, publishes = false): { publishing: boolean } | null {
  return bot ? { publishing: publishes || asksPublishing(rules) } : null;
}

/** A conversation as far as its approval reads it: its rules and Kuvo Code's notes on it. */
export interface WithApproval {
  permissions?: readonly KitRule[] | null;
  metadata?: { kuvo?: { approval?: unknown; applied?: unknown; [more: string]: unknown } | null; [more: string]: unknown } | null;
}

/** Whether a conversation's rules are still the ones the box made for `applied`: asking before
 * commands as those do, and edits not asking where it's Accept Edits. */
const madeFor = (rules: readonly KitRule[], applied: Approval) =>
  asksBeforeCommands(applied) === asksFor(rules, "shell") && !(applied === "acceptEdits" && asksFor(rules, "edit"));

/** A conversation's approval: the one kept with it (`kuvo.approval`), while its rules are still the
 * ones the box made for it (`kuvo.applied`, what that came to then); a client from before that
 * changed them on its own leaves what they say. Else as its rules say: asking before commands is
 * Ask First, and nothing asking (Approve All, from before) is Full Access, as it ran: never the
 * reviewer it didn't have (but a bot's, which never has more than Auto). `stored`: whether it's the one kept; `applied`: what its rules are made
 * for now (null for one from before); `effective`: what it comes to here now, and `held`, why
 * that's less. */
export function approvalOf(session: WithApproval, where: Where = {}): { approval: Approval; stored: boolean; applied: Approval | null; effective: Approval; held?: Unavailable } {
  const rules = Array.isArray(session.permissions) ? session.permissions : [];
  const kept = session.metadata?.kuvo?.approval;
  const applied = session.metadata?.kuvo?.applied;
  if (isApproval(kept) && isApproval(applied) && madeFor(rules, applied)) {
    const { approval, held } = effectiveApproval(kept, where);
    return { approval: kept, stored: true, applied, effective: approval, ...(held ? { held } : {}) };
  }
  // (Asking before commands was Ask First, before there was more: its rules are made again as that.
  // One from before runs as it did: what its rules say is what it does, whether or not you
  // confirmed Full Access here. But a bot's, which never has more than Auto, and comes to what Auto
  // does here: the box makes its rules so (`adoptBots`).)
  const guessed: Approval = asksFor(rules, "shell") ? "askFirst" : where.bot ? "auto" : "fullAccess";
  if (!where.bot) return { approval: guessed, stored: false, applied: null, effective: guessed };
  const { approval, held } = effectiveApproval(guessed, where);
  return { approval: guessed, stored: false, applied: null, effective: approval, ...(held ? { held } : {}) };
}
