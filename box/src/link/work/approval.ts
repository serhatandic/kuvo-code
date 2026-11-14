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
//   confirmed it on this computer (`box/approval.json`: a client asks you the first time).
// A bot's conversation and its work are as any other's: only what you set in Edit Bot holds a bot
// back.
// Plan stays the conversation's agent, beside this. What the box writes is the engine's rules for
// it (the coding agents' bridge reads the same ones and sets each agent from them), made again
// with Settings › Permissions as they are, so a Don't Allow there still holds in every one.

import path from "node:path";
import { isObject } from "../../shared/json";
import { textOf, writePrivate } from "../files";
import { BOX, IS_MAC } from "../home";
import { holdsBack, isParticular, permissionsHere, refreshedRules } from "../bots/tell";
import { hasFormerAsks } from "./former-asks";
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

const keptHere = (file: string): Record<string, unknown> => {
  try {
    const read = JSON.parse(textOf(file) ?? "");
    if (isObject(read)) return read;
  } catch {}
  return {};
};

const keepHere = (change: Record<string, unknown>, file: string) =>
  writePrivate(file, JSON.stringify({ ...keptHere(file), ...change }, null, 2));

/** Full Access switched on or off here; off, a new conversation's default stops being it, and comes
 * back only when you pick it again. */
export function allowFullAccess(on: boolean, file = APPROVAL_FILE): void {
  keepHere({ fullAccess: on, ...(!on && keptHere(file).last === "fullAccess" ? { last: "auto" } : {}) }, file);
}

/** Whether your other computers may start work on this one (start_session, list_models and
 * list_projects from a lead on another of your computers: PROTOCOL.md, "Peers", `call`). Yours to
 * allow, at your own risk: a machine's key, taken, could then start sessions here. Until you say,
 * it follows the role: off on the Mac with the app, on for a machine (so machines from before have
 * it on). */
export function otherComputersAllowed(file = APPROVAL_FILE): boolean {
  const kept = keptHere(file).otherComputers;
  return typeof kept === "boolean" ? kept : !IS_MAC;
}

/** Your other computers allowed to start work here, or not. */
export function allowOtherComputers(on: boolean, file = APPROVAL_FILE): void {
  keepHere({ otherComputers: on }, file);
}

/** The approval a new conversation here gets where its client didn't say: Auto the first time on
 * this computer, then the last one you picked here; Auto while Full Access, picked
 * last, is switched off here since. */
export function defaultApproval(file = APPROVAL_FILE): Approval {
  const kept = keptHere(file);
  return isApproval(kept.last) && (kept.last !== "fullAccess" || kept.fullAccess === true) ? kept.last : "auto";
}

/** Keeps `approval` as the last one you picked on this computer. */
export function rememberApproval(approval: Approval, file = APPROVAL_FILE): void {
  if (keptHere(file).last !== approval) keepHere({ last: approval }, file);
}

/** When this box first kept approvals for new conversations (kept the first time it's asked): a
 * conversation from before then that no box kept an approval with ran as its rules say; one made
 * since, by a client that doesn't say, gets the default. */
export function approvalsSince(file = APPROVAL_FILE): number {
  const since = keptHere(file).since;
  if (typeof since === "number" && Number.isFinite(since)) return since;
  const now = Date.now();
  keepHere({ since: now }, file);
  return now;
}

/** Why one can't be had here now, as a word a client maps and in words; none where it can. */
export interface Unavailable {
  reason: "sandbox" | "fullAccessOff";
  why: string;
}

/** Where a conversation is, as its approval goes: on the coding agents (`agents`, whose own
 * programs run its commands), a bot's or its work (`bot`): one from before there were approvals
 * gets this computer's default, as a new one does. */
export interface Where {
  agents?: boolean;
  bot?: boolean;
}

const SANDBOX_WHY = {
  off: "Auto needs the sandbox, which isn't running on this computer.",
  partial: "Auto needs the whole sandbox, and on this computer it can't keep commands from the services your login runs.",
  agents: "Auto needs the coding agents' own programs in the sandbox, and some here started before it and still run outside it.",
} as const;

/** Whether `approval` can be had here now: Full Access refused without its switch (it can't be
 * picked), Auto held without the sandbox (it can, and asks first until then). */
export function unavailable(approval: Approval, { agents = false }: Where = {}): Unavailable | null {
  if (approval === "fullAccess" && !fullAccessAllowed()) return { reason: "fullAccessOff", why: "Full Access isn't confirmed on this computer yet: confirm it first." };
  if (approval === "auto") {
    const gap = sandboxGap(agents);
    if (gap) return { reason: "sandbox", why: SANDBOX_WHY[gap] };
  }
  return null;
}

/** What `wanted` comes to here now: itself where it can be had, else the most it can be (Full
 * Access without its switch, Auto; Auto without the sandbox, Ask First), and why: the last step
 * down, what holds it where it is. */
export function effectiveApproval(wanted: Approval, where: Where = {}): { approval: Approval; held?: Unavailable } {
  let approval = wanted;
  let held: Unavailable | undefined;
  if (approval === "fullAccess") {
    const not = unavailable("fullAccess");
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
 * as they are (or, where they aren't its own, the Don't Allows it has), its own folders kept
 * (only those of its own rules: never the asks a box before put in a bot's). Accept Edits allows edits in
 * place of Ask First's asks for them, so an Ask in Settings doesn't hold them back, and a Don't
 * Allow there, after, still does. */
export function approvalRules(approval: Approval, current: readonly KitRule[], held: readonly KitRule[] = []): KitRule[] {
  const made = rulesMade(approval, current);
  // (Don't Allows it brought from the computer its lead lives on, `kuvo.held`: last, so nothing here
  // lets it past them, as they're made again whenever Settings › Permissions here change.)
  const more = held.filter(rule => holdsBack(rule) && !made.some(each => each.action === rule.action && each.resource === rule.resource && each.effect === rule.effect));
  return [...made, ...more];
}

/** The Don't Allows a conversation brought from its lead's computer (`kuvo.held`), kept with it so
 * they hold here however often its rules are made again. */
export function heldOf(session: WithApproval | null | undefined): KitRule[] {
  const held = session?.metadata?.kuvo?.held;
  return Array.isArray(held) ? held.filter((rule): rule is KitRule => isObject(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && typeof rule.effect === "string" && holdsBack(rule as unknown as KitRule)) : [];
}

function rulesMade(approval: Approval, current: readonly KitRule[]): KitRule[] {
  const settings = permissionsHere() ?? current.filter(holdsBack);
  let made = refreshedRules([...(asksBeforeCommands(approval) ? [SHELL_ASK] : []), ...current.filter(isParticular)], settings);
  if (approval === "acceptEdits") made = made.map(rule => (EDITS.has(rule.action) && rule.resource === "*" && rule.effect === "ask" ? { ...rule, effect: "allow" } : rule));
  // The engine's own file tools aren't in the sandbox: in Auto, what they do outside its folders
  // asks as Settings says it does (the engine asks by itself where Settings says nothing). Full
  // Access lets them, first, so a Don't Allow in Settings, after, still holds.
  if (approval === "auto" && settings.findLast(isOutside)?.effect === "ask") made = made.map(rule => (isOutside(rule) && rule.effect === "allow" ? { ...rule, effect: "ask" } : rule));
  if (approval === "fullAccess") made = [{ action: "external_directory", resource: "*", effect: "allow" }, ...made];
  // The engine's own defaults ask before reading a `.env`, and before carrying on once the agent
  // makes the same call again and again: in Auto and Full Access, which never hold the agent for
  // you, it reads them as any file in its folder and carries on, as Claude Code's and Codex's do
  // (first, so a Don't Allow in Settings, after, still holds).
  if (approval === "auto" || approval === "fullAccess") made = [...NEVER_HELD, ...made];
  return made;
}

const NEVER_HELD: KitRule[] = [
  { action: "read", resource: "*.env", effect: "allow" },
  { action: "read", resource: "*.env.*", effect: "allow" },
  { action: "doom_loop", resource: "*", effect: "allow" },
];

/** Whether rules made for `applied` lack what a box before 0.9.192 didn't give it (`.env` reads
 * and carrying on after repeated calls, in Auto and Full Access), or keep the asks one before
 * 0.9.189 put in a bot's: then they're made again. */
export const madeBefore = (rules: readonly KitRule[], applied: Approval) => hasFormerAsks(rules, permissionsHere() ?? []) ||
  (applied === "auto" || applied === "fullAccess") && !NEVER_HELD.every(env => rules.some(rule => rule.action === env.action && rule.resource === env.resource && rule.effect === env.effect));

const isOutside = (rule: KitRule) => rule.action === "external_directory" && rule.resource === "*";

/** A conversation as far as its approval reads it: its rules, Kuvo Code's notes on it, and when it
 * was made. */
export interface WithApproval {
  permissions?: readonly KitRule[] | null;
  metadata?: { kuvo?: { approval?: unknown; applied?: unknown; [more: string]: unknown } | null; [more: string]: unknown } | null;
  time?: { created?: number } | null;
  parentID?: string | null;
}

/** Kuvo Code's marks on a conversation the box made, which keeps its approval itself or has none
 * of its own: a bot's, one an agent started, an engine's copy of a coding agent's conversation, a
 * reviewer's part, a seat. */
const BOX_MADE = ["bot", "by", "startedBy", "engineFor", "reviewPart", "seat"];

/** Whether a conversation's rules are still the ones the box made for `applied`: asking before
 * commands as those do, and edits not asking where it's Accept Edits. */
const madeFor = (rules: readonly KitRule[], applied: Approval) =>
  asksBeforeCommands(applied) === asksFor(rules, "shell") && !(applied === "acceptEdits" && asksFor(rules, "edit"));

/** A conversation's approval: the one kept with it (`kuvo.approval`), while its rules are still the
 * ones the box made for it (`kuvo.applied`, what that came to then); a client from before that
 * changed them on its own leaves what they say. One a client made with `kuvo.approval` alone is
 * that, and `pending` until the box makes its rules (`settle`). Else as its rules say: asking
 * before commands is Ask First; nothing asking is, for one from before this box kept approvals
 * (`approvalsSince`), Full Access, as it ran, and for one a client made since with no tool held
 * back as a whole (Approve All), this computer's default (`defaultApproval`, or `byDefault`), `pending`
 * too. A bot's, unkept, gets this computer's default as the box keeps it (`adoptBots`); one the
 * box made itself (`BOX_MADE`), a subagent's, or one
 * with other rules, never Full Access unkept: Auto (a subagent's Ask First, where its conversation
 * can't be found). `stored`: whether it's the one kept;
 * `applied`: what its rules are made for now (null for one from before); `effective`: what it comes
 * to here now, and `held`, why that's less. */
export function approvalOf(session: WithApproval, where: Where = {}, since = approvalsSince(), byDefault?: Approval): { approval: Approval; stored: boolean; applied: Approval | null; effective: Approval; held?: Unavailable; pending?: boolean } {
  const rules = Array.isArray(session.permissions) ? session.permissions : [];
  const kept = session.metadata?.kuvo?.approval;
  const applied = session.metadata?.kuvo?.applied;
  if (isApproval(kept) && isApproval(applied) && madeFor(rules, applied)) {
    const { approval, held } = effectiveApproval(kept, where);
    return { approval: kept, stored: true, applied, effective: approval, ...(held ? { held } : {}) };
  }
  const asked = isApproval(kept) && applied === undefined ? kept : null;
  const created = session.time?.created;
  const marks = session.metadata?.kuvo ?? {};
  const boxMade = BOX_MADE.some(mark => mark in marks);
  const before = typeof created === "number" && created < since;
  // (Approve All as a client makes it: commands and edits not held back as a whole, whatever your
  // Don't Allows hold back. A group chat's seat, say, which runs nothing, is never one; nor one
  // ever kept with an approval, whose rules a client changed since.)
  const whole = rules.some(rule => rule.resource === "*" && rule.effect !== "allow" && /^(shell|edit|\*)$/.test(rule.action));
  const fresh = kept === undefined && !boxMade && !session.parentID && !before && !whole;
  // (Asking before commands was Ask First, before there was more: its rules are made again as that.
  // One from before runs as it did: what its rules say is what it does, whether or not you
  // confirmed Full Access here.)
  const guessed: Approval = asked ?? (asksFor(rules, "shell") ? "askFirst" : where.bot ? byDefault ?? defaultApproval() : session.parentID ? "askFirst"
    : fresh ? byDefault ?? defaultApproval() : before && !boxMade ? "fullAccess" : "auto");
  const pending = Boolean((asked || fresh) && !session.parentID && !where.bot);
  // (One from before runs as it ran, whatever's switched on here now.)
  if (!where.bot && !pending && before && !boxMade && guessed !== "auto") return { approval: guessed, stored: false, applied: null, effective: guessed };
  const { approval, held } = effectiveApproval(guessed, where);
  return { approval: guessed, stored: false, applied: null, effective: approval, ...(held ? { held } : {}), ...(pending ? { pending } : {}) };
}
