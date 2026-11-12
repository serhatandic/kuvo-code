// A bot's conversation told what it is, as the Mac tells it: the kit's words, with its job as its
// memory has it now.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { ownsSettings, readSettings } from "../areas/config";
import { call } from "../engine/client";
import { rewriteOn } from "../engine/notes";
import { listOf, textOf } from "../files";
import { BOTS, HERE, IS_MAC, WAKE_COMMAND } from "../home";
import { botPersonalities } from "../personalities/library";
import { withoutFormerAsks } from "../work/former-asks";
import { approvalOf, approvalRules } from "../work/approval";
import { botHere, isMoving, noteBotsChanged } from "./here";
import { jobOf } from "./jobs";
import { botInstructions, NO_KIT, readKit, readMacKit, zoneOf } from "./kit";
import { listBots } from "./list";
import type { Target } from "../../shared/records";
import type { ChangedBot } from "../../shared/routes/bots";
import type { JSONAnswer, OtherStatus } from "../server/context";
import type { BotDescription, BotHere } from "./here";
import type { BotKit, KitRule } from "./kit";

/** What a bot's conversation was last told (`told.json`): its conversation, a digest of what it was
 * told, and the folder its own rules were last put right for. */
export interface Told {
  session?: string;
  instructions?: string;
  rules?: string;
}

/** What `POST kuvo/bots/<id>/arrived` answers (`settleBot`): the bot as it's listed now, or why not. */
export type SettledAnswer = JSONAnswer<ChangedBot | { message: string }>;

// What a bot's conversation was last told, kept in its folder (`told.json`, so a restart doesn't
// tell every bot again): its conversation, what it was told (a digest), and the folder its own
// rules were last put right for. It's told again only when what it would be told changes.
const TOLD_FILE = "told.json";
export const toldDigest = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
function toldOf(folder: string): Told {
  try {
    const told: unknown = JSON.parse(textOf(path.join(folder, TOLD_FILE)) ?? "");
    return isObject(told) ? told as Told : {};
  } catch {
    return {};
  }
}
export function noteTold(folder: string, changes: Told): void {
  try {
    const file = path.join(folder, TOLD_FILE);
    fs.writeFileSync(`${file}.new`, JSON.stringify({ ...toldOf(folder), ...changes }));
    fs.renameSync(`${file}.new`, file);
  } catch {}
}

// What a bot here is told now: the kit's words, with its name, folder, personality and project,
// and its job as its memory has it.
export function toldNow(kit: BotKit, here: BotHere, described: BotDescription = here.described): string {
  const personality = botPersonalities(kit).find(each => each.id === described.personality)?.instruction;
  const job = jobOf(here);
  return botInstructions(kit, described.name, here.folder, personality, described.project, { line: job.line, section: job.details });
}

// Tells a bot's conversation (on `target`) `text`, and notes it. Whether it got there.
export async function tellBot(target: Target, here: BotHere, session: string, text: string, signal?: AbortSignal): Promise<boolean> {
  const told = await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries/kuvo.bot`, { value: text }, signal).then(() => true, () => false);
  if (told) noteTold(here.folder, { session, instructions: toldDigest(text) });
  return told;
}

// A bot's run started (`target` runs its conversation): what it's told brought up to date (new
// words in an update, a personality changed), once, at its run rather than every bot at once as the
// box starts, since telling one opens its folder on the engine; its own rules put right for the
// folder it's in; and its memory file made, for one made before it was made with it.
// One bot at a time: asked again while it's being told (its run starting as the box finds its
// engine, or as its app asks), it's looked at again once that's done, so it's never told twice.
const freshening = new Map<string, Promise<unknown>>();
function oneAtATime<T>(sessionID: string, work: () => T | Promise<T>): Promise<T> {
  const now = (freshening.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(work);
  freshening.set(sessionID, now);
  const done = () => { if (freshening.get(sessionID) === now) freshening.delete(sessionID); };
  now.then(done, done);
  return now;
}

export function freshenBot(target: Target, sessionID: string): Promise<void> {
  return oneAtATime(sessionID, () => freshenOne(target, sessionID));
}

async function freshenOne(target: Target, sessionID: string): Promise<void> {
  const here = listOf(BOTS).map(botHere).find(bot => bot?.session === sessionID);
  if (!here || isMoving(here.folder)) return;
  const kit = readKit();
  settleFolder(here, kit);
  if (!kit) return;
  const told = toldOf(here.folder);
  const text = toldNow(kit, here);
  // What its conversation has now, where that can be read: one that told it something else (a Mac
  // of an earlier version) is put right; otherwise what was last told it here.
  const there = await toldThere(target, sessionID);
  const stale = there === undefined ? told.session !== sessionID || told.instructions !== toldDigest(text) : there !== text;
  if (stale) await tellBot(target, here, sessionID, text);
  if (told.rules !== here.folder && await repairRules(target, here, sessionID)) noteTold(here.folder, { rules: here.folder });
}

// What a bot's folder says of where it is, as this box has it: the folder it works in, the time zone
// its wake-ups go by and that zone's rules, for a machine without zone files of its own (a
// machine's: yours, as its kit has it; this Mac's go by its own clock), and its memory file (for
// one made before it was made with it), which needs this box's words (`kit`, null without them).
// For one that came from another computer (Move to Computer), those are this one's from now on.
function settleFolder(here: BotHere, kit: BotKit | null): void {
  const write = (name: string, data: string | Buffer) => {
    const file = path.join(here.folder, name);
    let now: Buffer | null = null;
    try { now = fs.readFileSync(file); } catch {}
    if (!now || !now.equals(Buffer.from(data))) fs.writeFileSync(file, data);
  };
  try {
    write("directory", typeof here.described.project === "string" ? here.described.project : path.join(here.folder, "workspace"));
    if (IS_MAC) {
      for (const name of ["timezone", "zoneinfo"]) fs.rmSync(path.join(here.folder, name), { force: true });
    } else {
      const mac = readMacKit(), zone = zoneOf(mac);
      if (zone) write("timezone", zone);
      if (typeof mac?.zoneinfo === "string" && mac.zoneinfo) write("zoneinfo", Buffer.from(mac.zoneinfo, "base64"));
    }
    if (kit && !fs.existsSync(path.join(here.folder, "MEMORY.md"))) write("MEMORY.md", kit.memory.replaceAll("⟦name⟧", () => here.described.name));
  } catch {}
}

// `POST kuvo/bots/<id>/arrived`: a bot whose folder and conversation were just brought here from
// another computer (Move to Computer), made this box's: what its folder says of where it is, its
// rules here (for its folder here, and from this box's Settings › Permissions), and what it's told
// here (where it runs, now). Done while its move still holds it, before its wake-ups go on, and
// one at a time with its other tellings. `{status, value}`: 200 `{bot}`.
export async function settleBot(id: string, readEngine: () => Target, readBridge: () => Target | null, machine?: string): Promise<SettledAnswer> {
  const no = (status: OtherStatus, message: string): SettledAnswer => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  return oneAtATime(here.session, async (): Promise<SettledAnswer> => {
    const kit = readKit();
    // Where it works and the clock it goes by, whatever else can't be done yet.
    settleFolder(here, kit);
    noteBotsChanged();
    if (!kit) return no(409, NO_KIT);
    let target: Target | null | undefined;
    try { target = here.agents ? readBridge() : readEngine(); } catch {}
    if (!target) return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
    const text = toldNow(kit, here);
    const there = await toldThere(target, here.session);
    // Told already (by its box before, or here): noted as told here, so what was noted where it came
    // from doesn't have it told again.
    if (there === text) noteTold(here.folder, { session: here.session, instructions: toldDigest(text) });
    const told = there === text || await tellBot(target, here, here.session, text);
    const ruled = await repairRules(target, here, here.session);
    if (ruled) noteTold(here.folder, { rules: here.folder });
    if (!told || !ruled) return no(503, "Its conversation here didn’t take what it is now. It’s tried again as its next run starts.");
    return { status: 200, value: { bot: listBots(machine).find(each => each.id === id) ?? null } };
  });
}

// What a conversation on `target` is told as a bot (its `kuvo.bot` entry): its words, null for
// none, undefined when that can't be read (it isn't there, or `target` doesn't say).
async function toldThere(target: Target, sessionID: string): Promise<string | null | undefined> {
  try {
    const entries: unknown = await call(target, "GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries`);
    if (!Array.isArray(entries)) return undefined;
    const entry = entries.find((each: { key?: unknown; value?: unknown } | null) => each?.key === "kuvo.bot");
    return typeof entry?.value === "string" ? entry.value : null;
  } catch {
    return undefined;
  }
}

// Every bot whose conversation is on `target`, told what it is now if that changed (after an update,
// or what a Mac of an earlier version told it), and its rules put right: as the box finds its engine
// or its coding agents' bridge (it started, or they did), so a bot's next turn starts on its own
// words. The ones on the other are left to it.
export async function freshenBots(target: Target): Promise<void> {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (!here || isMoving(here.folder)) continue;
    if (await toldThere(target, here.session) === undefined && !(await call(target, "GET", `/api/session/${encodeURIComponent(here.session)}`).then(() => true, () => false))) continue;
    await freshenBot(target, here.session).catch(() => {});
  }
}

// What "Ask First" asks about (the Mac's ToolApproval.askFirst): a conversation that asks before
// running commands asks first.
const ASK_FIRST: string[] = ["edit", "write", "patch", "shell", "webfetch", "external_directory", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"];
const isRule = (rule: unknown): rule is KitRule => isObject(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && typeof rule.effect === "string" && rule.effect !== "";
// What a rule holds back: Don't Allow, or one a newer engine set that this box doesn't know (the
// Mac's `holdsBack`), which goes on as it is.
export const holdsBack = (rule: KitRule): boolean => rule.effect !== "allow" && rule.effect !== "ask";
// A folder a conversation may work in, of its own (the Mac's ToolApproval.isParticular).
export const isParticular = (rule: KitRule): boolean => rule.action === "external_directory" && rule.effect === "allow" && rule.resource !== "*";

// This box's Settings › Permissions (its settings' `permissions`), or null where they can't be read,
// or aren't its own yet (a machine whose Mac hasn't made them so, which runs with what its Mac gave it).
export function permissionsHere(): KitRule[] | null {
  if (!ownsSettings()) return null;
  const { settings } = readSettings();
  if (!settings) return null;
  const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
  return rules.every(isRule) ? rules : [];
}

// A conversation's rules made again from its approval (it asks first when it asks before commands)
// and Settings › Permissions (`settings`) as they are now, with its own folders after, as the Mac
// makes them (ToolApproval.refreshed): Approve All runs what Settings asks first about, Ask First
// still lets through what Settings allows, and both keep what Settings doesn't allow.
export function refreshedRules(current: KitRule[], settings: KitRule[]): KitRule[] {
  // (Its own approval's rule: Ask First's ask before every command.)
  const asks = current.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask");
  const denied = settings.filter(holdsBack);
  let made: KitRule[];
  if (asks) {
    const everywhere = settings.findLast(rule => rule.action === "external_directory" && rule.resource === "*")?.effect === "allow";
    made = [
      ...ASK_FIRST.filter(action => everywhere || action !== "external_directory").map(action => ({ action, resource: "*", effect: "ask" as const })),
      ...settings.filter(rule => !holdsBack(rule) && rule.resource !== "*" && rule.action !== "external_directory"),
      ...denied,
    ];
  } else {
    made = [...settings.filter(rule => rule.effect === "ask").map(rule => ({ action: rule.action, resource: rule.resource, effect: "allow" as const })), ...denied];
  }
  // (Its own folders are those Settings says nothing of: one it does is Settings' to say, and an
  // allow made from Settings' ask, kept from before, isn't its own.)
  const own = current.filter(rule => isParticular(rule) && !settings.some(set => set.action === "external_directory" && set.resource === rule.resource));
  return [...made, ...own];
}

// A bot's own rules as they're made now: its approval with this box's Settings › Permissions, then
// `external_directory` for its folder here. An earlier version allowed its kuvo-wake commands
// (which let one that also wrote a file through), a move left the folder it had, and the computer
// it came from had Settings of its own. Whether they're right now.
async function repairRules(target: Target, here: BotHere, sessionID: string): Promise<boolean> {
  const id = here.described.id;
  const own = { action: "external_directory", resource: path.join(here.folder, "*"), effect: "allow" };
  const commands = [`kuvo-wake ${id} `, `"${WAKE_COMMAND}" ${id} `, `"$HOME/.kuvo-code/bin/kuvo-wake" ${id} `];
  const old = (rule: { action?: unknown; resource?: unknown } | null | undefined) => (rule?.action === "shell" && commands.some(command => String(rule.resource ?? "").startsWith(command)))
    || (rule?.action === "external_directory" && String(rule.resource ?? "").endsWith(`/bots/${id}/*`));
  let readable = true;
  // (In its turn, as its rules and notes are then: `../engine/notes.ts`.)
  const done = await rewriteOn(target, sessionID, data => {
    const rules: unknown = data.permissions;
    const metadata: unknown = data.metadata;
    if (!Array.isArray(rules)) {
      readable = false;
      return null;
    }
    const kept: unknown[] = rules.filter(rule => !old(rule));
    const settings = kept.every(isRule) ? permissionsHere() : null;
    // Where `settings` is there, every one kept is a rule (checked just above). Made for the approval
    // kept with it, where there is one (Accept Edits isn't in its rules alone).
    const approval = settings ? approvalOf({ permissions: kept as KitRule[], metadata: isObject(metadata) ? metadata : null }, { bot: true }) : null;
    const made = settings ? (approval?.stored ? approvalRules(approval.effective, kept as KitRule[]) : refreshedRules(kept as KitRule[], settings)) : kept as KitRule[];
    // (Without the asks a box before put in a bot's: only what you set in Edit Bot holds it back.)
    const repaired = [...withoutFormerAsks(made, settings ?? []), own];
    return JSON.stringify(repaired) === JSON.stringify(rules) ? null : { permissions: repaired };
  }).catch(() => null);
  return Boolean(done) && readable;
}
