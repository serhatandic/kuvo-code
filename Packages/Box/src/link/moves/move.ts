// Move to Computer, box to box (PROTOCOL.md, `kuvo/moves` and "Peers"): the box a bot, a chat or a
// group chat lives on moves it to another of your computers, over peer mail. That box alone decides
// the switch, so the two copies are never both live: the one it goes to takes what's sent, keeps it
// held, and starts it only when told to.
//
// The box it leaves: holds it (its wake-ups paused with `moving`, its conversations frozen: prompts,
// letters and seats wait), settles it, packs it (`bundle.ts`) and offers it; sends its parts; once
// it's there, settles and reads it again (anything new: it all goes again, three tries, then it's
// taken back); then notes the switch, tells the other box to switch, and lets its own copy go.
// Before the switch, anything that goes wrong takes it back as it was; after it, only forward.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { Move, MoveKind, MovePlace, MoveStays } from "../../shared/routes/moves";
import { plainName } from "../../shared/text";
import { answerBotKeys, forgetBotKeys } from "../areas/bot-keys";
import { askGroups } from "../areas/groups";
import { botHere, MOVING } from "../bots/here";
import { signInRefusal } from "../bots/make";
import { settleBot } from "../bots/tell";
import { bridgeTarget, call, readBridgeFile, readEngineFile } from "../engine/client";
import { CantCarry, forgetQueue, packQueues, queueOf, resumeQueue, unpackQueues } from "../engine/queue";
import { writePrivate } from "../files";
import { HERE, IS_MAC, K } from "../home";
import { readPeerAgents } from "../peers/directory";
import { mailFor, ownKey, peersOf } from "../peers/known";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import { readLink } from "../state";
import { goalRuns, proposedGoals } from "../work/goals";
import { workAsks } from "../work/asks";
import { ofBot, under, workSessions } from "../work/tree";
import { readBackground } from "../work/background";
import { decidedOf, forgetDecided, isAutopilot, keepDecided, tellAutopilot } from "../work/autopilot";
import { isChatsFolder } from "../engine/chats";
import type { EngineSession } from "../engine/sessions";
import { CHATS, engineWait, MOST_BUNDLE, NotTaken, TooBig, deleteSession, directoryOf, exportAll, folderOf, groupAction, conversationHash, hashOf, idsOf, importAll, keysOf, notPlainIn, ownTree, pack, toTrash, unpack } from "./bundle";
import type { Contents } from "./bundle";
import { forgetWorkQueues, packWorkQueues, placeWorkQueues } from "../work-queue/moves";
import { AGENT_NAMES, CARRIED_AGENTS } from "../../shared/carry";
import { forgetQuiet, tellMoving } from "./elsewhere";
import { ASK_LEFT, KEEP_LEFT, forgetLeft, keysGone, noteLeft, noteRan, readLeft, removeTrashed } from "./left";
import type { LeftEntry } from "./left";
import { MOVES, bundleOf, changeMove, endedAs, endedAt, endedLast, forgetMove, forgetMovedAway, moveOf, movesChanged, noteEnded, noteMovedAway, readMove, readMoves, saveMove, shownMove, waitingFor } from "./records";
import type { MoveRecord } from "./records";

/** Raw bytes in each part (40,000 characters as base64url, as documents' parts are). */
export const PART_BYTES = 30_000;
/** Parts on their way at once, and how long one goes unanswered before it's sent again. */
const IN_FLIGHT = 16;
const PART_AGAIN = 20_000;
/** A step unanswered is sent again each minute; a first offer unanswered this long: the other
 * computer isn't there. */
const STEP_AGAIN = 60_000;
const NO_ANSWER = 30_000;
/** Before the switch, the other computer quiet this long about a move: it's taken back. */
const QUIET_AT_MOST = 10 * 60_000;
/** A copy there to let go of that it never says it let go of: given up on (it goes there by itself). */
const DROP_AT_MOST = 24 * 3600_000;
// When the other computer last said something of each move here (its parts and their answers come
// often).
const heard = new Map<string, number>();
/** The other computer quiet this long about a move's step: the move shows as waiting for it (longer
 * than a step goes before it's sent again, so one going well never does). */
const WAITING_AFTER = 90_000;
// Since when this box has been looking at its moves (started again, it's heard nothing yet).
let lookingSince = Date.now();
/** How long the box it leaves waits for its conversations to settle, at most. */
const SETTLE_FOR = 60;
/** A copy held here with no word from the box it came from this long goes; one being let go of
 * that still can't all go after this long is said so in the log, and tried again each hour. */
const HELD_AT_MOST = 7 * 24 * 3600_000;
const DROP_AGAIN_LATE = 3600_000;
// The copies being let go of here whose lasting failure has been logged.
const loggedStuck = new Set<string>();
/** The other computer gone from your computers this long (not just left out as a list's read again):
 * a move with it ends. */
const GONE_FOR = 5 * 60_000;
// Since when each move's other computer has been missing from your computers.
const missing = new Map<string, number>();
/** Being got ready to go this long (its engine or group chats stuck): taken back. */
const HOLDING_AT_MOST = 30 * 60_000;
/** A copy being set up here this long (its engine stuck): given up on, and taken back. */
const SET_UP_AT_MOST = 30 * 60_000;
// What gives up on each copy being set up here; and the copies set up here now or next, in their turn.
const settingUp = new Map<string, AbortController>();
const toSetUp = new Set<string>();
/** Letting an original go, refused this many times by its engine while it's up: it goes on here. */
const FINISH_TRIES = 10;

/** What a move says, in words to show. */
export const say = {
  notConnected: (place: string) => `${place} isn’t connected. Connect to it, then try again.`,
  working: (name: string) => `${name} is working. Move it once it’s done.`,
  leftBoth: (name: string, place: string) => `${name} is on ${place} now, but couldn’t be let go of here, so it’s on both computers. Delete the one you don’t want.`,
  inProject: (name: string) => `${name} works in one of your projects, which stays where it is. Only a bot with a folder of its own can move.`,
  noAgents: (place: string) => `The coding agents on ${place} aren’t running. Try again once they are.`,
  cantCarry: (name: string, why: string) => `${name} can’t move: ${why}.`,
  agentNotThere: (name: string, agent: string, place: string) => `${name} talks with ${agent}, which isn’t installed on ${place}. Install it in Settings › Accounts there, then move ${name}.`,
  agentSignedOut: (name: string, agent: string, place: string) => `${name} talks with ${agent}, which isn’t signed in on ${place}. Sign in to it in Settings › Accounts there, then move ${name}.`,
  otherAccount: (name: string, agent: string, who: string, place: string) => `On ${place}, ${name} uses the ${agent} account signed in there${who}.`,
  modelNotThere: (name: string, model: string, place: string) => `${name} uses ${model}, which needs a sign-in on ${place}. Sign in to it in Settings › Accounts there, or choose another model, then move ${name}.`,
  notSame: (name: string) => `${name}’s conversation didn’t come out the same on the other computer, so it stayed here. Try again.`,
  background: (name: string, what: string) => `${name} has ${what} running. Wait for it to finish, or stop it, then move ${name}.`,
  onGoal: (name: string) => `${name} is working on a goal, which stays on this computer. Move it once the goal is done, or stop the goal first.`,
  waiting: (name: string) => `${name} still has messages on their way. Try again in a moment.`,
  notPlain: (name: string, what: { path: string; link: boolean }) => `${name}’s folder has ${what.link ? "a link that wouldn’t work on another computer" : "something that isn’t a file"} (${what.path}), which can’t move to another computer. Remove it, then move ${name}.`,
  busy: (name: string) => `${name} kept getting messages while it moved, so it stayed where it is. Try again in a moment.`,
  botsElsewhere: (chat: string) => `${chat}’s bots live on different computers, so it can’t go there.`,
  inBoxGroup: (name: string, chat: string) => `${name} is in “${chat}”, which lives on ${HERE} with its bots. Move the chat to a Mac first, or take ${name} out of it.`,
  tooBig: (name: string) => `${name} is more than 1 GB, too big to move to another computer, so it stays where it is.`,
  noGroups: (place: string) => `Group chats on ${place} aren’t running right now. Try again once they are.`,
  noEngine: (place: string) => `The engine on ${place} isn’t running. Try again once it is.`,
  needsUpdate: (place: string) => `${place} needs a newer Kuvo Code before things can move to or from it.`,
  botsNotThere: (chat: string, place: string) => `${chat}’s bots don’t all live on ${place}. Move them there first, then the chat can follow.`,
  slow: (name: string) => `${name} took too long to get ready to move on ${HERE}, so it stayed here. Try again in a moment.`,
  oldCopy: (name: string, place: string) => `An earlier copy of ${name} on ${place} couldn’t be let go of yet. Try again in a moment.`,
  moving: MOVING,
};

/** The same, short, for a menu that shows it beside a computer's name. */
const note = {
  inProject: "Works in a project",
  noAgents: "Its coding agents aren’t running",
  onGoal: "Working on a goal",
  background: "Running something",
  notPlain: { link: "Has a link that can’t move", other: "Has something that isn’t a file" },
  inBoxGroup: "In a group chat that lives here",
  needsUpdate: "Needs a newer Kuvo Code",
  botsNotThere: "Its bots don’t all live there",
  moving: "Moving already",
};

/** A move's outcome, for whoever asked for it. */
export type MoveOutcome = { ok: true; move: Move; note?: string } | { ok: false; status: number; message: string };

// Those waiting on a move here, by its ID. How it ended is also noted beside its record for a while
// (`<id>.outcome.json`), for a client that asked through another process (a Mac's `box route`),
// which the running bridge moves it for.
const waiting = new Map<string, ((outcome: MoveOutcome) => void)[]>();
const outcomeFile = (id: string) => path.join(MOVES, `${id}.outcome.json`);
const OUTCOME_KEPT = 10 * 60_000;
function ended(id: string, outcome: MoveOutcome): void {
  try { writePrivate(outcomeFile(id), JSON.stringify(outcome)); } catch {}
  for (const resolve of waiting.get(id) ?? []) resolve(outcome);
  waiting.delete(id);
}
/** Until move `id` ends, here or in the running bridge. */
export function outcomeOf(id: string): Promise<MoveOutcome> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const done = (outcome: MoveOutcome) => {
      if (timer) clearInterval(timer);
      timer = null;
      resolve(outcome);
    };
    waiting.set(id, [...(waiting.get(id) ?? []), done]);
    if (watching) return;
    // Another process moves it: how it ended, once it's noted.
    timer = setInterval(() => {
      try { done(JSON.parse(fs.readFileSync(outcomeFile(id), "utf8"))); } catch {}
    }, 500);
  });
}

// Each move's steps one at a time, in the order they come (its mail, and what `keepMoving` does for
// it): one never runs while another of the same move is half done.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(id: string, step: () => Promise<T>): Promise<T> {
  const before = queues.get(id) ?? Promise.resolve();
  const next = before.catch(() => {}).then(step);
  const kept = next.catch(() => {});
  queues.set(id, kept);
  kept.then(() => { if (queues.get(id) === kept) queues.delete(id); });
  return next;
}

// The relay connection that's up, for mail to the other box, in the process that moves things (the
// running bridge: `watchMoves`); the moves it's carrying on now.
let hostOf: () => Pick<LinkHost, "send"> | null | undefined = () => null;
let watching = false;
const driving = new Set<string>();
function drive(id: string): void {
  if (driving.has(id)) return;
  driving.add(id);
  inTurn(id, () => carryOn(id).catch(async error => {
    await takeBack(id, String((error as Error | null)?.message ?? error), (error as Refused | null)?.status ?? 409);
    // Taken back already as a step went on (too long held): what that step left in its folder goes.
    if (!readMove(id)) try { fs.rmSync(bundleOf(id), { recursive: true, force: true }); } catch {}
  })).finally(() => driving.delete(id));
}

const nameOf = (key: string): string => plainName(peersOf(readLink()).find(peer => peer.key === key)?.name ?? "") || "the other computer";

// Where a move's mail goes instead of the relay: a test's scripted other computer.
let sendInstead: ((peer: string, move: Record<string, unknown>) => boolean) | null = null;
export function sendMovesWith(send: typeof sendInstead): void {
  sendInstead = send;
}

function tell(peer: string, move: Record<string, unknown>): boolean {
  if (sendInstead) return sendInstead(peer, move);
  const link = readLink();
  const to: Peer | undefined = peersOf(link).find(each => each.key === peer);
  const bytes = link && to && mailFor(to, { move, at: Date.now() }, link);
  if (!bytes) return false;
  // Sent only when the connection took it: one closing, or not welcomed yet, takes nothing.
  try {
    return hostOf()?.send(bytes) === true;
  } catch {
    return false;
  }
}

// ---- What it is, and where it can go ----

/** What's moving, as this box has it: its name and its conversations' root, or why it can't move. */
interface Movable {
  name: string;
  root?: string;
  why?: string;
  note?: string;
  /** A group chat's bots, by their IDs. */
  members?: string[];
  /** It talks with a coding agent. */
  lane?: boolean;
  /** The model it talks with, for the computer it goes to to check it can. */
  model?: { providerID: string; id: string };
}


/** The agents bridge's part of a move (`carry.ts`, its `kuvo/carry` routes): what it answers, or why
 * not, in its own words. */
async function carry<T>(bridge: Target, step: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return await call(bridge, "POST", `/api/kuvo/carry/${step}`, body, engineWait(signal, CARRY_WAIT)) as T;
}
/** How long the bridge has to pack, hash or place a conversation (its whole files, up to 1 GB). */
const CARRY_WAIT = 10 * 60_000;

/** What the bridge says as it packs a conversation. */
interface Packed {
  sessions: { id: string; metadata?: Record<string, unknown> }[];
  digest: string;
  left: unknown[];
}

/** Whether the chat `session` has its own goal (`/goal`) working or paused: the agents bridge keeps
 * it here, and it would end with the conversation as it leaves. Undefined when the bridge didn't
 * answer, so it can't say. */
async function chatGoalRuns(session: string, signal?: AbortSignal): Promise<boolean | undefined> {
  let bridge: Target;
  try { bridge = readBridgeFile(); } catch { return false; }
  const goal = await call(bridge, "GET", `/api/kuvo/goals/${encodeURIComponent(session)}`, undefined, engineWait(signal)).then(
    data => data,
    (error: { status?: number }) => (error?.status === 404 ? null : undefined),
  );
  if (goal === undefined) return undefined;
  return isObject(goal) && (goal.state === "working" || goal.state === "paused");
}

async function movable(kind: MoveKind, thing: string, signal?: AbortSignal): Promise<Movable | null> {
  if (kind === "bot") {
    const here = botHere(thing);
    if (!here) return null;
    const name = here.described.name;
    if (here.described.project) return { name, why: say.inProject(name), note: note.inProject };
    if (here.agents && !bridgeTarget()) return { name, why: say.noAgents(HERE), note: note.noAgents };
    if (goalRuns(thing)) return { name, why: say.onGoal(name), note: note.onGoal };
    const running = runningOf([here.session]);
    if (running) return { name, why: say.background(name, running), note: note.background };
    // Found now, not by the computer it goes to once it's all there. (A folder too big to look
    // through here is looked through as it's packed.)
    const odd = notPlainIn(here.folder, 50_000);
    if (odd) return { name, why: say.notPlain(name, odd), note: odd.link ? note.notPlain.link : note.notPlain.other };
    // One in a group chat that lives here with its bots, on a machine, stays with it.
    if (!IS_MAC) {
      let bridge: Target | null = null;
      try { bridge = readBridgeFile(); } catch {}
      const listed = bridge ? await askGroups<{ data?: { group?: { id?: string; name?: string; members?: unknown } }[] }>(bridge, "GET", "", undefined, engineWait(signal)).catch(() => null) : null;
      const chat = (listed?.status === 200 && Array.isArray(listed.value?.data) ? listed.value.data : []).find(each => Array.isArray(each?.group?.members) && (each.group.members as unknown[]).includes(thing));
      if (chat) return { name, root: here.session, why: say.inBoxGroup(name, plainName(chat.group?.name ?? "") || "a group chat"), note: note.inBoxGroup };
    }
    return { name, root: here.session, ...(here.agents ? { lane: true } : {}), ...(modelOf(here.described.model) ?? {}) };
  }
  if (kind === "chat") {
    // On the engine, or, talking with a coding agent, on the agents bridge.
    const look = (target: () => Target) => Promise.resolve().then(() => call(target(), "GET", `/api/session/${encodeURIComponent(thing)}`, undefined, engineWait(signal))).catch(() => null);
    let session = await look(readEngineFile);
    const lane = !isObject(session);
    if (lane) session = await look(readBridgeFile);
    if (!isObject(session)) return null;
    const title = typeof session.title === "string" && session.title.trim() ? `“${session.title.trim()}”` : "This chat";
    const directory = isObject(session.location) ? session.location.directory : session.directory;
    if (!isChatsFolder(directory)) return null;
    if (await chatGoalRuns(thing, signal)) return { name: title, why: say.onGoal(title), note: note.onGoal };
    const running = runningOf([thing]);
    if (running) return { name: title, why: say.background(title, running), note: note.background };
    return { name: title, root: thing, ...(lane ? { lane: true } : {}), ...(modelOf(session.model) ?? {}) };
  }
  let bridge: Target;
  try { bridge = readBridgeFile(); } catch { return null; }
  const listed = await askGroups<{ data?: { group?: { name?: string; members?: unknown } } }>(bridge, "GET", `/${encodeURIComponent(thing)}`, undefined, engineWait(signal)).catch(() => null);
  if (listed?.status !== 200) return null;
  const members = listed.value?.data?.group?.members;
  return {
    name: `“${plainName(listed.value?.data?.group?.name ?? "") || "Group chat"}”`,
    members: Array.isArray(members) ? members.filter((member): member is string => typeof member === "string") : [],
  };
}

/** What still runs for any of `sessions` besides a turn (a command left running, a subagent sent
 * off), in words; null when nothing does. It would end as it moves, so it's waited for. */
function runningOf(sessions: readonly string[]): string | null {
  const running = readBackground();
  const all = sessions.map(session => running[session]).filter(each => each !== undefined);
  const commands = all.reduce((sum, each) => sum + each.commands, 0), helpers = all.reduce((sum, each) => sum + each.subagents + each.tasks, 0);
  if (!commands && !helpers) return null;
  return [commands ? (commands === 1 ? "a command" : `${commands} commands`) : "", helpers ? (helpers === 1 ? "a subagent" : `${helpers} subagents`) : ""].filter(Boolean).join(" and ");
}

const modelOf = (model: unknown): { model: { providerID: string; id: string } } | null =>
  isObject(model) && typeof model.providerID === "string" && typeof model.id === "string" ? { model: { providerID: model.providerID, id: model.id } } : null;

/** Whether a group chat's bots all live on the machine `peer`, as the computers say: none here, and
 * each in that machine's list of its agents. One that hasn't said what it has isn't judged (it
 * checks itself as the chat comes). */
function botsLiveOn(members: string[], peer: Peer): boolean {
  if (members.some(member => botHere(member))) return false;
  const list = readPeerAgents()[peer.key]?.list;
  if (!Array.isArray(list)) return true;
  return members.every(member => list.some(agent => agent.kind === "bot" && agent.id === member));
}

/** Where `thing` can go: each of your other computers, and why not one where it can't. */
export async function placesFor(kind: MoveKind, thing: string, signal?: AbortSignal): Promise<{ places: MovePlace[]; stays?: MoveStays } | null> {
  const what = await movable(kind, thing, signal);
  if (!what) return null;
  const stays = kind === "group" ? undefined : await staysOf(kind, thing, what, signal);
  return { places: placesOf(kind, thing, what), ...(stays && Object.keys(stays).length ? { stays } : {}) };
}

/** What of a bot or chat stays here as it moves: none of it goes, and none of it's lost (it's here
 * again if it comes back). Sessions it can't list now aren't counted. */
async function staysOf(kind: MoveKind, thing: string, what: Movable, signal?: AbortSignal): Promise<MoveStays> {
  const stays: MoveStays = {};
  const targets = [readEngineFile, bridgeTarget].flatMap(each => {
    try { return [each()].filter((target): target is Target => Boolean(target)); } catch { return []; }
  });
  const all = await workSessions(targets, signal).catch(() => []);
  const started = new Set([...(what.root ? under(what.root, all) : []), ...(kind === "bot" ? ofBot(thing, all) : [])].map(each => each.data.id));
  if (started.size) stays.sessions = started.size;
  const own = (session: string | undefined, bot: string | undefined) => (kind === "bot" ? bot === thing : session === what.root);
  const asks = workAsks().filter(ask => own(ask.session, ask.bot)).length;
  if (asks) stays.asks = asks;
  const goals = proposedGoals().filter(goal => own(goal.session, goal.bot)).length;
  if (goals) stays.goals = goals;
  // Its coding agent's own conversation: kept here as the way back where it goes too; one that can't
  // go stays, and the agent starts a new one there, handed what was said so far.
  const agent = what.model?.providerID.split("@")[0] ?? "";
  if (what.lane && AGENT_NAMES[agent] && !CARRIED_AGENTS.has(agent)) stays.startsOver = AGENT_NAMES[agent];
  else if (what.lane) stays.agent = true;
  return stays;
}

function placesOf(kind: MoveKind, thing: string, what: Movable): MovePlace[] {
  const moving = moveOf(thing) !== null;
  const own = ownKey(readLink() ?? {});
  return peersOf(readLink()).filter(peer => peer.key !== own).map(peer => {
    const name = plainName(peer.name) || (peer.kind === "mac" ? "Mac" : "Machine");
    // Why not, and the same short: the thing's own reason first, then that computer's.
    const not: [string, string] | null = moving ? [say.moving, note.moving]
      : what.why ? [what.why, what.note ?? what.why]
      : olderThanMoves(peer.key) || (what.lane && olderThanCarrying(peer.key)) ? [say.needsUpdate(name), note.needsUpdate]
      // A group chat goes to a machine only where all its bots live (to a Mac, they stay put).
      : kind === "group" && peer.kind === "machine" && !botsLiveOn(what.members ?? [], peer) ? [say.botsNotThere(what.name, name), note.botsNotThere]
      : null;
    return { key: peer.key, name, kind: peer.kind, ok: !not, ...(not ? { why: not[0], note: not[1] } : {}) };
  });
}

/** Whether another computer says what it answers, and moves isn't among it (a box from before them). */
function olderThanMoves(key: string): boolean {
  const features = readPeerAgents()[key]?.features;
  return Array.isArray(features) && !features.includes("moves");
}

/** Whether another computer checks it can run what comes before it's held here (`check`). */
const checksFirst = (key: string): boolean => readPeerAgents()[key]?.features?.includes("moves.check") === true;

/** The same, for one that talks with a coding agent. */
function olderThanCarrying(key: string): boolean {
  const features = readPeerAgents()[key]?.features;
  return Array.isArray(features) && !features.includes("moves.agents");
}

// ---- The box it leaves ----

/** Moves `thing` to the box whose key is `to`, as a client asks: until it's there, or why not. */
export async function startMove(kind: MoveKind, thing: string, to: string, signal?: AbortSignal): Promise<MoveOutcome> {
  const link = readLink();
  const own = link ? ownKey(link) : null;
  const peer = peersOf(link).find(each => each.key === to);
  if (!own || !peer || to === own) return { ok: false, status: 404, message: "That computer isn’t one of yours." };
  if (olderThanMoves(to)) return { ok: false, status: 409, message: say.needsUpdate(plainName(peer.name) || "That computer") };
  if (moveOf(thing)) return { ok: false, status: 409, message: say.moving };
  const what = await movable(kind, thing, signal);
  if (!what) return { ok: false, status: 404, message: "It isn’t on this computer any more." };
  if (what.why) return { ok: false, status: 409, message: what.why };
  if (what.lane && olderThanCarrying(to)) return { ok: false, status: 409, message: say.needsUpdate(plainName(peer.name) || "That computer") };
  const id = `mov_${crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "")}`;
  const folder = folderOf(kind, thing);
  const record: MoveRecord = {
    id, kind, thing, name: what.name, from: own, to, role: "from", stage: "holding", sessions: what.root ? [what.root] : [],
    peer: to, wasPaused: true, tries: 0, started: Date.now(), ...(folder && fs.existsSync(folder) ? { folder } : {}), ...(what.lane ? { lane: true } : {}),
    ...(what.model ? { model: what.model } : {}), ...(checksFirst(to) && kind !== "group" ? { step: "check" as const } : {}),
  };
  // One move of a thing at a time, whoever asks (a phone and a Mac at once, through this bridge or
  // `box route`): noted under a lock, after a look again.
  if (!noteFirst(record)) return { ok: false, status: 409, message: say.moving };
  const outcome = outcomeOf(id);
  // Moved by this process when it's the bridge; else by the bridge, as it next looks.
  if (watching) drive(id);
  return outcome;
}

/** `record` noted, unless a move of its thing is under way already: under a lock of its own (a file
 * made only if it isn't there; one left by a process cut off goes after a minute). */
function noteFirst(record: MoveRecord): boolean {
  fs.mkdirSync(MOVES, { recursive: true, mode: 0o700 });
  const lock = path.join(MOVES, `.${record.thing}.lock`);
  try { if (Date.now() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { force: true }); } catch {}
  let handle: number;
  try { handle = fs.openSync(lock, "wx", 0o600); } catch { return false; }
  try {
    if (moveOf(record.thing)) return false;
    saveMove(record);
    return true;
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

const PAUSED = (folder: string) => path.join(folder, "paused");
const pausedText = (folder: string): string | null => { try { return fs.readFileSync(PAUSED(folder), "utf8").trim(); } catch { return null; } };

/** Its wake-ups held while it moves, as Pause does (only a move takes `moving` away). */
// It says `moving` while it moves, whatever it said before (your own pause, kept to put back), so
// nothing changes it on the way and its copy there is known for one a move brought.
function hold(record: MoveRecord): void {
  if (!record.folder || !fs.existsSync(record.folder)) return;
  const was = pausedText(record.folder);
  if (was !== "moving") {
    record.wasPaused = was !== null;
    if (was !== null) record.pausedAs = was;
    writePrivate(PAUSED(record.folder), "moving");
  }
}

/** Its wake-ups as they were before it moved: going again, or paused as you paused them. */
function unhold(folder: string | undefined, wasPaused: boolean, pausedAs?: string): void {
  if (!folder || pausedText(folder) !== "moving") return;
  try {
    if (wasPaused) writePrivate(PAUSED(folder), pausedAs ?? "");
    else fs.rmSync(PAUSED(folder), { force: true });
  } catch {}
}

/** Until none of its conversations is at work and nothing waits to go to them: a minute at most.
 * What the engine holds for one you stopped waits for Resume, and goes with it (`packQueues`). */
async function settle(target: Target, sessions: readonly string[], name: string): Promise<void> {
  // (Still in a turn at the end, it's working; else only messages wait to go to it.)
  let busy = false;
  for (let tries = 0; tries < SETTLE_FOR; tries++) {
    const active = await call(target, "GET", "/api/session/active", undefined, engineWait()).catch(() => ({}));
    busy = isObject(active) && sessions.some(session => session in active);
    const inbox = sessions[0] && !queueOf(sessions[0]).paused ? await call(target, "GET", `/api/session/${encodeURIComponent(sessions[0])}/inbox`, undefined, engineWait()).catch(() => []) : [];
    if (!busy && !(Array.isArray(inbox) && inbox.length)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Refused(busy ? say.working(name) : say.waiting(name));
}

class Refused extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

/** What a move carries of its conversations, to see whether anything changed as it went: their
 * messages, word for word (`conversationHash`), or, with a coding agent, those and each agent's own
 * files (the bridge's `digest`), and their queues (what waits for them), but when each was read as
 * waiting. */
const fingerprint = (conversation: string, queues: Record<string, unknown>): string =>
  `${conversation}.${crypto.createHash("sha256").update(JSON.stringify(queues, (key, value) => key === "at" ? undefined : value)).digest("base64url")}`;

/** What waits for its conversations, as a move carries it (`packQueues`); one the engine held that
 * can't go with it, and it doesn't go yet. */
const queuesOf = (engine: Target, sessions: readonly string[], name: string) => packQueues(engine, sessions).catch(error => {
  throw error instanceof CantCarry ? new Refused(say.waiting(name)) : error;
});

// What the box it leaves has of each move in memory: the parts the other box has, and those on
// their way (by when they went).
// (`window`: how many may be on their way now: halved as one's lost, one more as each comes, up to
// `IN_FLIGHT`; a slow connection isn't sent everything again and again.)
const outgoing = new Map<string, { got: Set<number>; flying: Map<number, number>; exports: string; digest?: string; window?: number }>();

/** The box it leaves, carrying on from where it is (as it starts, or step by step). */
async function carryOn(id: string): Promise<void> {
  let record = readMove(id);
  if (!record || record.role !== "from" || record.stage !== "holding" || record.failed) return;
  // The computer it goes to says first whether it can run it there: nothing's held here till then.
  if (record.step === "check") {
    const there = await checkThere(record);
    const now = changeMove(id, each => { if (!each.failed && each.stage === "holding") { each.step = undefined; if (there.note) each.note = there.note; } });
    if (!now || now.failed || now.stage !== "holding") return;
    record = now;
  }
  hold(record);
  record.holdSince = Date.now();
  saveMove(record);
  // Taken back meanwhile (as the box started again, or as getting it ready took too long): it stays
  // taken back, nothing more done or kept of it (a group chat held as it was is looked at again, and
  // goes on).
  const takenBack = (): boolean => {
    const now = readMove(id);
    if (now && !now.failed && now.stage === "holding") return false;
    if (record.kind === "group") groupsToWake = true;
    try { fs.rmSync(bundleOf(id), { recursive: true, force: true }); } catch {}
    return true;
  };
  let exports: unknown[] = [];
  let digest = "";
  let queues: Record<string, unknown> = {};
  const contents: Contents = { kind: record.kind, thing: record.thing, name: record.name, exports, wasPaused: record.wasPaused };
  if (record.kind === "group") {
    contents.group = await groupAction(readBridgeFile(), record.thing, "hold") as Contents["group"];
    // Its Work Queue, which its seats keep.
    const workQueue = packWorkQueues([record.thing]);
    if (workQueue) contents.workQueue = workQueue;
    const members = isObject(contents.group?.group) && Array.isArray(contents.group.group.members) ? contents.group.group.members : [];
    record.members = members.filter((member): member is string => typeof member === "string");
  } else {
    // A goal set as it was asked to move (goals stay where they started): it stays. Asked before
    // waiting for it to settle, which a goal at work never lets it do; one the bridge can't say
    // of now isn't taken for none.
    if (record.kind === "chat") {
      const goal = await chatGoalRuns(record.thing);
      if (goal) throw new Refused(say.onGoal(record.name));
      if (goal === undefined) throw new Refused(`${record.name}’s goal couldn’t be checked on ${HERE}. Try again in a moment.`);
    }
    const target = record.lane ? readBridgeFile() : readEngineFile();
    await settle(target, record.sessions, record.name);
    const running = runningOf(record.sessions);
    if (running) throw new Refused(say.background(record.name, running));
    // Its folder goes as it is, and the computer it goes to takes plain files only: found here first.
    const odd = record.folder && fs.existsSync(record.folder) ? notPlainIn(record.folder) : null;
    if (odd) throw new Refused(say.notPlain(record.name, odd));
    if (record.lane) {
      const packed = await carry<Packed>(target, "pack", { root: record.sessions[0], into: path.join(bundleOf(id), "carry"), most: MOST_BUNDLE }).catch(error => {
        const why = String((error as Error | null)?.message ?? error);
        const status = (error as { status?: number } | null)?.status;
        // (Its turn started again as it was packed: the bridge's 423.)
        if (status === 423) throw new Refused(say.working(record.name));
        throw status === 413 ? new Refused(say.tooBig(record.name)) : new Refused(say.cantCarry(record.name, why));
      });
      digest = packed.digest;
      record.sessions = packed.sessions.map(each => each.id);
      record.leftOf = packed.left;
      contents.lane = { sessions: [...record.sessions], root: record.sessions[0] };
    } else {
      exports = await exportAll(target, record.sessions[0]);
      contents.exports = exports;
      record.sessions = idsOf(exports);
      digest = conversationHash(exports);
    }
    // (What its conversation says of where it worked: a bot's folder; a chat's, this box's chats.)
    const worked = record.kind === "bot" ? record.folder : CHATS;
    contents.was = { place: plainName(readLink()?.name ?? "") || (IS_MAC ? "a Mac" : "a machine"), ...(worked ? { folder: worked } : {}) };
    // A conversation you stopped goes stopped, with what waits for it, here and in the engine.
    queues = await queuesOf(target, record.sessions, record.name);
    if (Object.keys(queues).length) contents.queues = queues;
    const decided = decidedOf(record.sessions);
    if (Object.keys(decided).length) contents.decided = decided;
    // Its conversations' Work Queues.
    const workQueue = packWorkQueues(record.sessions);
    if (workQueue) contents.workQueue = workQueue;
    if (record.folder) contents.folder = path.basename(record.folder);
    if (record.kind === "bot") {
      // A goal started as it was asked to move (goals stay where they started): it stays.
      if (goalRuns(record.thing)) throw new Refused(say.onGoal(record.name));
      const keys = await keysOf(record.thing);
      if (!keys) throw new Refused(`${record.name}’s own keys couldn’t be read on ${HERE}. Try again in a moment.`);
      if (Object.keys(keys).length) contents.keys = keys;
    }
  }
  if (takenBack()) return;
  const bundle = await pack(id, contents).catch(error => {
    throw error instanceof TooBig ? new Refused(say.tooBig(record.name)) : error;
  });
  if (bundle.size > MOST_BUNDLE) throw new Refused(say.tooBig(record.name));
  if (takenBack()) return;
  outgoing.set(id, { got: new Set(), flying: new Map(), exports: fingerprint(digest, queues), digest });
  const now = changeMove(id, each => {
    Object.assign(each, { leftOf: record.leftOf, sessions: record.sessions, wasPaused: record.wasPaused, pausedAs: record.pausedAs, members: record.members, hash: bundle.hash, size: bundle.size, sent: 0, stage: "copying", step: "offer", offered: true, sentAt: Date.now(), holdSince: undefined });
  });
  if (now) offer(now);
}

// ---- Whether it can run there ----

/** How long the computer it goes to has to say whether it can run it. */
const CHECK_WAIT = 45_000;
const checking = new Map<string, (answer: Record<string, unknown>) => void>();

/** Asked of the computer it goes to before anything's held: whether it can run it there (its agents
 * or engine running, its coding agent there and signed in, its model usable). Refused there: why,
 * as that computer says it; no answer: it isn't connected. */
async function checkThere(record: MoveRecord): Promise<{ note?: string }> {
  const answer = await new Promise<Record<string, unknown> | null>(resolve => {
    const timer = setTimeout(() => { checking.delete(record.id); resolve(null); }, CHECK_WAIT);
    checking.set(record.id, given => { clearTimeout(timer); checking.delete(record.id); resolve(given); });
    tell(record.peer, { op: "check", id: record.id, kind: record.kind, name: record.name, ...(record.lane ? { lane: true } : {}), ...(record.model ? { model: record.model } : {}) });
  });
  if (!answer) throw new Refused(say.notConnected(nameOf(record.peer)), 503);
  if (answer.ok !== true) throw new Refused(typeof answer.message === "string" && answer.message ? answer.message : `${record.name} can’t run on ${nameOf(record.peer)}.`);
  return typeof answer.note === "string" && answer.note ? { note: answer.note } : {};
}

/** A coding agent's account here, as its bridge lists it (`api/integration`). */
interface AgentAccount {
  id?: string;
  name?: string;
  metadata?: { agent?: string; installed?: boolean; account?: string; accountLabel?: string };
  connections?: unknown[];
}

/** The box it goes to: whether it can run what's coming (`check`), said back at once. */
async function checkHere(sender: MailSender, given: Record<string, unknown>, id: string): Promise<void> {
  const answer = (move: Record<string, unknown>) => void tell(sender.key, { op: "checked", id, ...move });
  const name = typeof given.name === "string" ? given.name : "It";
  const lane = given.lane === true;
  const place = IS_MAC ? "this Mac" : (plainName(readLink()?.name ?? "") || "this machine");
  const wait = AbortSignal.timeout(20_000);
  let target: Target;
  try {
    target = lane ? readBridgeFile() : readEngineFile();
    await call(target, "GET", "/api/session/active", undefined, wait);
  } catch {
    return answer({ ok: false, message: lane ? say.noAgents(place) : say.noEngine(place) });
  }
  const model = isObject(given.model) && typeof given.model.providerID === "string" && typeof given.model.id === "string" ? { providerID: given.model.providerID, id: given.model.id } : null;
  if (!model || given.kind === "group") return answer({ ok: true });
  if (!lane) {
    const refused = await signInRefusal(model, target, wait).catch(() => null);
    return answer(refused ? { ok: false, message: say.modelNotThere(name, model.id, place) } : { ok: true });
  }
  // (Its agent's accounts there, by the provider they're all of: `claude-code`, `claude-code@<account>`.)
  const kind = model.providerID.split("@")[0]!;
  // Custom Auto picks among what's signed in there.
  if (kind === "auto") return answer({ ok: true });
  const listed = await call(target, "GET", "/api/integration", undefined, wait).catch(() => null);
  if (!Array.isArray(listed)) return answer({ ok: false, message: say.noAgents(place) });
  const ofKind = (listed as (AgentAccount | null)[]).filter((each): each is AgentAccount => typeof each?.id === "string" && each.id.split("@")[0] === kind);
  // Not a coding agent's: a model the engine's sign-ins give it, as for a bot of the engine's.
  if (!ofKind.length) {
    const refused = await signInRefusal(model, readEngineFile(), wait).catch(() => null);
    return answer(refused ? { ok: false, message: say.modelNotThere(name, model.id, place) } : { ok: true });
  }
  const agentName = ofKind[0]!.name ?? "its coding agent";
  if (!ofKind.some(each => each.metadata?.installed)) return answer({ ok: false, message: say.agentNotThere(name, agentName, place) });
  const signedIn = ofKind.filter(each => each.metadata?.installed && Array.isArray(each.connections) && each.connections.length);
  if (!signedIn.length) return answer({ ok: false, message: say.agentSignedOut(name, agentName, place) });
  // Its own account, or another of the same agent there: which it is from then on, said.
  if (signedIn.some(each => each.id === model.providerID)) return answer({ ok: true });
  const uses = signedIn[0]!;
  const who = uses.metadata?.account ? ` (${uses.metadata.account})` : "";
  return answer({ ok: true, note: say.otherAccount(name, agentName, who, place) });
}

function offer(record: MoveRecord): void {
  tell(record.peer, { op: "offer", id: record.id, kind: record.kind, thing: record.thing, name: record.name, size: record.size, hash: record.hash, wasPaused: record.wasPaused, ...(record.pausedAs !== undefined ? { pausedAs: record.pausedAs } : {}), from: record.from, ...(record.members ? { members: record.members } : {}), ...(record.lane ? { lane: true } : {}) });
}

// The next parts to the other box, up to `IN_FLIGHT` on their way.
function sendParts(record: MoveRecord, now = Date.now()): void {
  const state = outgoing.get(record.id);
  if (!state || !record.size) return;
  const of = Math.ceil(record.size / PART_BYTES);
  const file = path.join(bundleOf(record.id), "bundle.tgz");
  let handle: number | null = null;
  // One unanswered this long is lost (the relay dropped, say): no longer on its way, so it goes again.
  let lost = false;
  for (const [i, when] of state.flying) if (now - when >= PART_AGAIN) { state.flying.delete(i); lost = true; }
  if (lost) state.window = Math.max(1, Math.floor((state.window ?? IN_FLIGHT) / 2));
  try {
    for (let i = 0; i < of && state.flying.size < (state.window ?? IN_FLIGHT); i++) {
      if (state.got.has(i) || state.flying.has(i)) continue;
      handle ??= fs.openSync(file, "r");
      const bytes = Buffer.alloc(Math.min(PART_BYTES, record.size - i * PART_BYTES));
      fs.readSync(handle, bytes, 0, bytes.length, i * PART_BYTES);
      if (!tell(record.peer, { op: "part", id: record.id, hash: record.hash, i, of, d: bytes.toString("base64url") })) break;
      state.flying.set(i, now);
    }
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
}

/** It's there, held: settled and read again; the same, it switches; not, it all goes again. */
async function arrived(record: MoveRecord, placed?: unknown): Promise<void> {
  const still = () => {
    const now = readMove(record.id);
    return now?.role === "from" && now.stage === "copying" && !now.failed ? now : null;
  };
  if (record.kind !== "group") {
    const target = record.lane ? readBridgeFile() : readEngineFile();
    await settle(target, record.sessions, record.name);
    // What's in place there, file by file, is what was sent: or it's not the one to go on from.
    if (record.lane && placed !== outgoing.get(record.id)?.digest) throw new Refused(say.notSame(record.name));
    const again = record.lane
      // (A turn that started just now, the bridge's 423: changed, so it's got ready again.)
      ? (await carry<{ digest: string }>(target, "digest", { root: record.sessions[0] }).catch(error => {
        if ((error as { status?: number } | null)?.status === 423) return { digest: "" };
        throw error;
      })).digest
      : conversationHash(await exportAll(target, record.sessions[0]));
    const before = outgoing.get(record.id)?.exports;
    // Taken back meanwhile (its copy there couldn't be set up, or it took too long): nothing more.
    if (!still()) return;
    if (!before || fingerprint(again, await queuesOf(target, record.sessions, record.name)) !== before) {
      if (record.tries >= 2) throw new Refused(say.busy(record.name));
      // (Getting it ready again from now: what `keepMoving` counts its half hour from.)
      changeMove(record.id, each => { each.tries += 1; each.stage = "holding"; each.step = undefined; each.holdSince = Date.now(); });
      return drive(record.id);
    }
  }
  // From here on the copy is the one: only while it's still under way (read and noted at once).
  if (!still()) return;
  const now = changeMove(record.id, each => { each.stage = "switching"; each.step = "switch"; each.sentAt = each.switchSince = Date.now(); });
  if (now) tell(now.peer, { op: "switch", id: now.id });
}

/** Switched: the original goes here, its conversation kept in its folder as it goes to the trash.
 * One cut short (its engine down) is tried again each minute (`keepMoving`), from where it was. */
async function finish(id: string): Promise<void> {
  const record = changeMove(id, each => { each.stage = "finishing"; each.step = "done"; each.sentAt = Date.now(); });
  if (!record) return;
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "release");
    forgetWorkQueues([record.thing]);
  } else {
    const engine = record.lane ? readBridgeFile() : readEngineFile();
    const place = record.folder ?? path.join(K, `moved-${record.thing}`);
    // Kept by a try before this one, whole: not again (some of it may be gone since).
    if (!record.kept) {
      try {
        fs.mkdirSync(place, { recursive: true });
        if (record.lane) {
          await carry(engine, "keep", { root: record.sessions[0], into: path.join(place, "conversation") });
        } else {
          const exports = await exportAll(engine, record.sessions[0]);
          writePrivate(path.join(place, "conversation.json"), JSON.stringify(exports, null, 2));
        }
        changeMove(id, each => { each.kept = true; });
      } catch (error) {
        // Gone already: on. Still here: not yet; refused that way, again and again, with its engine
        // up, it never will be: it goes on here too, as it's on the other computer.
        const there = await call(engine, "GET", `/api/session/${encodeURIComponent(record.sessions[0])}`, undefined, engineWait()).then(() => true, () => false);
        if (there) {
          const tries = (record.finishTries ?? 0) + 1;
          if (tries >= FINISH_TRIES) {
            console.error(`kuvo-link: a moved conversation couldn't be kept as it went, so it stays here: ${String((error as Error | null)?.message ?? error)}`);
            return restore(record, say.leftBoth(record.name, nameOf(record.peer)));
          }
          changeMove(id, each => { each.finishTries = tries; });
          throw error;
        }
      }
    }
    for (const session of [...record.sessions].reverse()) {
      await deleteSession(engine, session);
      forgetDecided(session);
    }
    // What waited for them here went with them, and so did their Work Queues.
    for (const session of record.sessions) forgetQueue(session);
    forgetWorkQueues(record.sessions);
    // (Kept here they're no one's, but never left for good: tried again till they're gone.)
    const keysLeft = record.kind === "bot" && !(await answerBotKeys("DELETE", `kuvo/bots/${record.thing}/keys`, null, null).then(answer => answer.status === 200, () => false));
    const trash = await toTrash(place);
    // Kept as the way back, until it has run there a while.
    noteLeft({ id, thing: record.thing, kind: record.kind, to: record.to, at: Date.now(), sessions: [...record.sessions], ...(record.lane ? { lane: true } : {}), ...(trash ? { trash } : {}), ...(record.leftOf?.length ? { left: record.leftOf } : {}), ...(keysLeft ? { keys: true } : {}) });
  }
  noteMovedAway(record.sessions, record.to);
  forgetMove(id);
  outgoing.delete(id);
  ended(id, { ok: true, move: shownMove({ ...record, stage: "finishing" }), ...(record.note ? { note: record.note } : {}) });
}

/** Taken back before it switched: the other box lets its copy go, and it goes on here as it was. */
async function takeBack(id: string, message: string, status = 409): Promise<void> {
  const record = readMove(id);
  if (!record || record.role !== "from" || record.failed || record.stage === "switching" || record.stage === "finishing") return;
  outgoing.delete(id);
  // As it was, before whoever asked hears: noted at once (a step still under way, given up on by
  // `keepMoving`, finds it taken back and goes no further).
  unhold(record.folder, record.wasPaused, record.pausedAs);
  // Offered already: its copy there goes too, once that box says so (`dropped`).
  if (record.offered) {
    changeMove(id, each => { each.step = "drop"; each.sentAt = Date.now(); each.dropSince = Date.now(); each.failed = message; each.failedStatus = status; });
    tell(record.peer, { op: "drop", id });
    // What it would have sent isn't needed any more.
    try { fs.rmSync(bundleOf(id), { recursive: true, force: true }); } catch {}
  } else {
    forgetMove(id);
  }
  heard.delete(id);
  if (waitingFor.delete(id)) movesChanged();
  if (record.kind === "group") await wakeGroup(record.thing);
  ended(id, { ok: false, status, message });
}

/** A move whose copy the other box let go of before it was switched to: the original goes on here. */
async function restore(record: MoveRecord, message: string): Promise<void> {
  outgoing.delete(record.id);
  unhold(record.folder, record.wasPaused, record.pausedAs);
  forgetMove(record.id);
  try { fs.rmSync(bundleOf(record.id), { recursive: true, force: true }); } catch {}
  // (Once no move holds it.)
  if (record.kind === "group") await wakeGroup(record.thing);
  ended(record.id, { ok: false, status: 409, message });
}

// ---- The box it goes to ----

// What the box it goes to has of each bundle on its way: the parts written so far (as its `got`
// file says, after a restart).
const incoming = new Map<string, Set<number>>();
function partsOf(id: string): Set<number> {
  let parts = incoming.get(id);
  if (!parts) {
    parts = new Set();
    try { for (const line of fs.readFileSync(path.join(bundleOf(id), "got"), "utf8").split("\n")) if (/^\d+$/.test(line)) parts.add(Number(line)); } catch {}
    incoming.set(id, parts);
  }
  return parts;
}

/** What this box keeps in memory of moves under way, gone, as it is when the bridge starts again
 * (a test's restart). */
export function forgetMovesInMemory(): void {
  incoming.clear();
  outgoing.clear();
  heard.clear();
  waitingFor.clear();
  loggedStuck.clear();
}

async function takeOffer(sender: MailSender, given: Record<string, unknown>): Promise<void> {
  const id = String(given.id);
  const answer = (move: Record<string, unknown>) => tell(sender.key, { id, ...move });
  const kind = given.kind as MoveKind;
  const thing = typeof given.thing === "string" ? given.thing : "";
  const name = typeof given.name === "string" ? given.name : "It";
  const size = typeof given.size === "number" ? given.size : 0;
  const lane = given.lane === true;
  if (!["bot", "chat", "group"].includes(kind) || !/^[A-Za-z0-9_]{1,80}$/.test(thing) || typeof given.hash !== "string" || size <= 0) return void answer({ op: "refused", message: "That isn’t a move." });
  if (size > MOST_BUNDLE) return void answer({ op: "refused", message: say.tooBig(name) });
  const place = IS_MAC ? "this Mac" : (plainName(readLink()?.name ?? "") || "this machine");
  if (kind === "group") {
    let bridge: Target | null = null;
    try { bridge = readBridgeFile(); } catch {}
    const running = bridge ? await askGroups(bridge, "GET", "", undefined, engineWait()).then(answer => answer.status === 200).catch(() => false) : false;
    if (!running) return void answer({ op: "refused", message: say.noGroups(place) });
    // To a machine, only with its bots: they all live there, and stay there while it does.
    const members = Array.isArray(given.members) ? given.members : [];
    if (!IS_MAC && members.some(member => !botHere(member))) return void answer({ op: "refused", message: say.botsElsewhere(name) });
  } else {
    try {
      await call(lane ? readBridgeFile() : readEngineFile(), "GET", "/api/session/active", undefined, engineWait());
    } catch {
      return void answer({ op: "refused", message: lane ? say.noAgents(place) : say.noEngine(place) });
    }
  }
  const was = readMove(id);
  if (was && (was.role !== "to" || was.peer !== sender.key || was.thing !== thing)) return void answer({ op: "refused", message: say.moving });
  if (was && was.hash === given.hash && !was.dropping) return void answer({ op: "ready" });
  // Offered again, changed (it got more while it moved): what came of it before goes first; and a
  // move of it this way from the same computer, cut short: this one takes its place (in its own
  // turn: one still being set up is let go of once it's all there). Any other under way (from
  // another computer, or away from here) stays. What can't go yet (its engine or group chats
  // refusing) is said, rather than left unanswered.
  const before = moveOf(thing);
  try {
    if (was) await clearCopy(was);
    if (before && before.id !== id && before.role === "to" && before.peer === sender.key) await inTurn(before.id, () => drop(before.id));
  } catch {
    return void answer({ op: "refused", message: say.oldCopy(name, place) });
  }
  if (before && before.id !== id && !(before.role === "to" && before.peer === sender.key)) return void answer({ op: "refused", message: say.moving });
  // Never over one that lives here: a copy only comes where there's none.
  if (!was && await livesHere(kind, thing)) return void answer({ op: "refused", message: `${name} is on ${place} already.` });
  fs.rmSync(bundleOf(id), { recursive: true, force: true });
  fs.mkdirSync(bundleOf(id), { recursive: true, mode: 0o700 });
  incoming.set(id, new Set());
  saveMove({
    id, kind, thing, name, from: sender.key, to: ownKey(readLink() ?? {}) ?? "", role: "to", stage: "copying", sessions: was?.sessions ?? [],
    peer: sender.key, wasPaused: given.wasPaused === true, ...(typeof given.pausedAs === "string" ? { pausedAs: given.pausedAs.slice(0, 2000) } : {}), hash: given.hash, size, sent: 0, tries: 0, started: was?.started ?? Date.now(), ...(lane ? { lane: true } : {}),
  });
  answer({ op: "ready" });
}

/** Whether a bot, chat or group chat by that ID is on this box now. */
async function livesHere(kind: MoveKind, thing: string): Promise<boolean> {
  if (kind === "group") {
    let bridge: Target | null = null;
    try { bridge = readBridgeFile(); } catch {}
    return bridge ? (await askGroups(bridge, "GET", `/${encodeURIComponent(thing)}`, undefined, engineWait()).catch(() => null))?.status === 200 : false;
  }
  if (fs.existsSync(folderOf(kind, thing)!)) return true;
  const root = kind === "bot" ? null : thing;
  if (!root) return false;
  // On either: a chat's on the agents bridge once it talks with a coding agent.
  for (const target of [readEngineFile, readBridgeFile]) {
    try {
      await call(target(), "GET", `/api/session/${encodeURIComponent(root)}`, undefined, engineWait());
      return true;
    } catch {}
  }
  return false;
}

async function takePart(sender: MailSender, given: Record<string, unknown>): Promise<void> {
  const id = String(given.id);
  const record = readMove(id);
  const i = given.i, of = given.of;
  const expected = Math.ceil((record?.size ?? 0) / PART_BYTES);
  if (!record || record.role !== "to" || record.dropping || record.peer !== sender.key || record.hash !== given.hash || !Number.isInteger(i) || of !== expected
    || (i as number) < 0 || (i as number) >= expected || typeof given.d !== "string" || given.d.length > Math.ceil(PART_BYTES * 4 / 3)) return;
  // All here already, and this one's answer lost: said again, so the box it comes from goes on.
  if (record.complete) return void tell(sender.key, { op: "got", id, i });
  const parts = partsOf(id);
  const bytes = Buffer.from(given.d, "base64url");
  const file = path.join(bundleOf(id), "bundle.tgz");
  const handle = fs.openSync(file, fs.existsSync(file) ? "r+" : "w", 0o600);
  try { fs.writeSync(handle, bytes, 0, bytes.length, (i as number) * PART_BYTES); } finally { fs.closeSync(handle); }
  if (!parts.has(i as number)) {
    parts.add(i as number);
    // Noted beside it too, so a restart here counts what came before.
    fs.appendFileSync(path.join(bundleOf(id), "got"), `${i}\n`, { mode: 0o600 });
  }
  tell(sender.key, { op: "got", id, i });
  if (parts.size % 32 === 0 || parts.size === of) changeMove(id, each => { each.sent = Math.min(each.size ?? 0, parts.size * PART_BYTES); });
  if (parts.size !== of) return;
  incoming.delete(id);
  // All here: put in place once, whatever comes again after; in the move's turn, so a step about it
  // that comes meanwhile (a drop) waits until it's in place, then finds all of it.
  // (Since now: one cut short by a restart is known for one, `resumeMoves`.)
  changeMove(id, each => { each.complete = true; each.setUpSince = Date.now(); });
  toSetUp.add(id);
  return inTurn(id, () => setUp(sender, id, file)).finally(() => toSetUp.delete(id));
}

async function setUp(sender: MailSender, id: string, file: string): Promise<void> {
  const record = readMove(id);
  // Let go of before its turn came: nothing to set up.
  if (!record || record.role !== "to" || record.peer !== sender.key) return;
  // Still at it, said now and each minute (a big one on a small machine takes a while), so the box
  // it came from doesn't take it back for want of an answer.
  tell(sender.key, { op: "working", id });
  const beat = setInterval(() => tell(sender.key, { op: "working", id }), STEP_AGAIN);
  // Given up on if it takes too long (`keepMoving`), its engine stuck.
  const stop = new AbortController();
  settingUp.set(id, stop);
  changeMove(id, each => { each.setUpSince = Date.now(); });
  try {
    if (await hashOf(file) !== record.hash) throw new NotTaken("What came wasn’t what was sent.");
    const sessions = await bringIn(record, stop.signal);
    stop.signal.throwIfAborted();
    const now = changeMove(id, each => { each.sessions = sessions; each.setUpSince = undefined; each.setUpAt = Date.now(); });
    tell(sender.key, { op: "arrived", id, hash: record.hash, ...(now?.digest ? { digest: now.digest } : {}) });
  } catch (thrown) {
    const error = stop.signal.aborted ? stop.signal.reason : thrown;
    // What was set up of it goes: the box it came from takes it back, and a switch for it is
    // answered `dropped`. Only what it brought is said back, never what this box found.
    if (!(error instanceof NotTaken)) console.error(`kuvo-link: a move that came couldn't be set up: ${String((error as Error | null)?.message ?? error)}`);
    // No longer at it: no more word that it is while what came goes.
    clearInterval(beat);
    await drop(id).catch(() => {});
    tell(sender.key, { op: "failed", id, message: error instanceof NotTaken ? `It couldn’t be set up on ${HERE}: ${error.message}` : `It couldn’t be set up on ${HERE}.` });
  } finally {
    clearInterval(beat);
    settingUp.delete(id);
  }
}

/** The bundle put in place here, held: its folder, its conversations, a bot's keys, a group chat. */
async function bringIn(record: MoveRecord, signal: AbortSignal): Promise<string[]> {
  const { contents, folder, carry: carried, opened } = await unpack(record.id);
  if (record.kind === "group") {
    const held = contents.group;
    if (!held || !isObject(held.group)) throw new NotTaken("The group chat didn’t come with it.");
    const answer = await askGroups<{ message?: unknown }>(readBridgeFile(), "PUT", `/${encodeURIComponent(record.thing)}`, { group: held.group, messages: held.messages, status: "held" }, engineWait(signal));
    if (answer.status !== 200) throw new Error(typeof answer.value?.message === "string" ? answer.value.message : `Its group chats answered ${answer.status}.`);
    placeWorkQueues(contents.workQueue, [record.thing], opened);
    return [];
  }
  const place = folderOf(record.kind, record.thing)!;
  // Only its own conversations, one of them its root (a chat's is the chat; a bot's, the one its
  // folder names), and none that's here already: it never brings in, or takes away, another one.
  const root = record.kind === "chat" ? record.thing : (() => { try { return folder ? fs.readFileSync(path.join(folder, "session"), "utf8").trim() : ""; } catch { return ""; } })();
  // (It says the same as what was offered, or it's put where it can't run.)
  if (Boolean(contents.lane) !== Boolean(record.lane)) throw new NotTaken("What came isn’t a move.");
  if (contents.lane ? contents.lane.root !== root : !ownTree(contents.exports, root)) throw new NotTaken("Its conversations aren’t its own.");
  const engine = record.lane ? readBridgeFile() : readEngineFile();
  // (Those it says it brings, none of them here: noted before they're brought in, so each is held from
  // the moment it's here. The bridge looks again as it places them.)
  const bringing = contents.lane ? contents.lane.sessions.filter(each => typeof each === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each)) : idsOf(contents.exports);
  if (contents.lane && (!bringing.length || bringing.length !== contents.lane.sessions.length)) throw new NotTaken("Its conversations aren’t its own.");
  for (const session of bringing) {
    if (await call(engine, "GET", `/api/session/${encodeURIComponent(session)}`, undefined, engineWait(signal)).then(() => true, () => false)) throw new NotTaken(`Its conversations are on ${HERE} already.`);
  }
  signal.throwIfAborted();
  if (folder) {
    // One left by a move cut short, or by the copy before this one, goes first.
    if (fs.existsSync(place)) await toTrash(place);
    fs.mkdirSync(path.dirname(place), { recursive: true });
    fs.renameSync(folder, place);
    // Placed by this move: it goes if the move's taken back.
    changeMove(record.id, each => { each.placed = true; });
    // Held here until the switch, whatever it was where it came from.
    writePrivate(PAUSED(place), "moving");
    // Where a chat's watches' checks run here.
    if (record.kind === "chat") writePrivate(path.join(place, "directory"), CHATS);
  }
  const directory = directoryOf(record.kind, record.thing);
  fs.mkdirSync(directory, { recursive: true });
  const was = contents.was && typeof contents.was.place === "string" ? { place: plainName(contents.was.place), ...(typeof contents.was.folder === "string" ? { folder: contents.was.folder } : {}) } : undefined;
  // Its conversations, noted before they're brought in: any that came go if it's taken back (with a
  // coding agent, what its bridge placed it undoes itself).
  let sessions = bringing;
  changeMove(record.id, each => { each.sessions = sessions; each.was = was; });
  let infos: (Partial<EngineSession> & { id: string })[];
  if (contents.lane) {
    const placed = await carry<{ digest: string; sessions: string[]; model?: { providerID?: string; id?: string }; came?: { providerID?: string; id?: string }; infos: { id: string; metadata?: Record<string, unknown> }[] }>(engine, "place", { from: carried, keep: placedOf(record.id), directory, root }, signal).catch(error => {
      if ((error as { status?: number } | null)?.status === 409) throw new NotTaken(String((error as Error).message));
      throw error;
    });
    sessions = [...new Set([...sessions, ...placed.sessions])];
    changeMove(record.id, each => { each.digest = placed.digest; each.sessions = sessions; });
    infos = placed.infos as typeof infos;
    // Its account isn't on this computer: the bot goes on with the one its conversation went to. And
    // on the model it ran on, where it named it by an alias that stands for another one here.
    if (record.kind === "bot" && placed.model?.providerID) rewriteModel(place, placed.model, placed.came);
  } else {
    await importAll(engine, contents.exports, directory, signal);
    infos = contents.exports.flatMap(exported => isObject(exported) && isObject(exported.info) ? [exported.info as Partial<EngineSession> & { id: string }] : []);
  }
  // What waited for them, kept here paused until the switch.
  const goOn = unpackQueues(contents.queues, sessions);
  if (goOn.length) changeMove(record.id, each => { each.queuesGoOn = goOn; });
  // The calls it made on Autopilot; on it (its flag came with it), its agent is told so here.
  keepDecided(contents.decided, sessions);
  // Its conversations' Work Queues, with their files.
  placeWorkQueues(contents.workQueue, sessions, opened);
  for (const info of infos) {
    if (isAutopilot(info)) await tellAutopilot(engine, info.id, true, signal).catch(error => console.error(`kuvo-link: ${record.name} couldn't be told it's on Autopilot here: ${error}`));
  }
  for (const [integration, keys] of Object.entries(contents.keys ?? {})) {
    const given = await answerBotKeys("PUT", `kuvo/bots/${record.thing}/keys/${encodeURIComponent(integration)}`, { keys }, null);
    // Never lost on the way: one that can't be kept here takes the move back, and it stays there.
    if (given.status !== 200) {
      console.error(`kuvo-link: a moved bot's own key for ${integration} couldn't be kept here (${given.status}).`);
      throw new NotTaken(`Its own key for ${integration} couldn’t be kept there.`);
    }
  }
  fs.rmSync(path.join(bundleOf(record.id), "opened"), { recursive: true, force: true });
  return sessions;
}

/** What the bridge keeps of what it placed for a move, until it's over (never in what's opened). */
const placedOf = (id: string) => path.join(bundleOf(id), "carried");

/** The account a moved bot's model is on, as its conversation's now is here (`now`), and the model:
 * the one its conversation went on with, when the bot named the same as its conversation did as it
 * came (`came`; an alias such as Claude Code's `default`, which stands for another model here). */
function rewriteModel(folder: string, now: { providerID?: string; id?: string }, came?: { providerID?: string; id?: string }): void {
  try {
    const file = path.join(folder, "bot.json");
    const described: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(described) || !isObject(described.model) || typeof now.providerID !== "string") return;
    const model = described.model;
    const same = typeof came?.id === "string" && model.id === came.id && model.providerID === came.providerID;
    const id = same && typeof now.id === "string" && now.id ? now.id : model.id;
    if (model.providerID === now.providerID && model.id === id) return;
    described.model = { ...model, providerID: now.providerID, id };
    writePrivate(file, JSON.stringify(described, null, 2));
  } catch {}
}

/** What it's told as it's switched to: where it is now, for what its conversation still says. */
async function tellMoved(record: MoveRecord): Promise<void> {
  const root = record.sessions[0];
  if (!root || !record.was) return;
  const folder = record.kind === "bot" ? folderOf(record.kind, record.thing) : CHATS;
  const lines = [
    `You moved to this computer from ${record.was.place}. What you did before that happened there.`,
    ...(record.was.folder && folder && record.was.folder !== folder ? [`Paths in your conversation under ${record.was.folder} are under ${folder} now.`] : []),
    `Other paths on ${record.was.place} aren't here, and the sessions you started there stay there: reach them with list_agents, send_message and read_conversation.`,
  ];
  const target = record.lane ? readBridgeFile() : readEngineFile();
  await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(root)}/instructions/entries/kuvo.moved`, { value: lines.join(" ") }, engineWait());
}

/** Switched to: the copy here goes on from now, as it was where it came from. */
async function switchHere(record: MoveRecord): Promise<void> {
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "activate");
  } else {
    unhold(folderOf(record.kind, record.thing) ?? undefined, record.wasPaused, record.pausedAs);
    forgetMovedAway(record.sessions);
    await backHere(record.thing).catch(error => console.error(`kuvo-link: what an earlier move of ${record.name} left couldn't all be cleared: ${String((error as Error | null)?.message ?? error)}`));
    // Told where it is now, before anything could run it here.
    await tellMoved(record).catch(error => console.error(`kuvo-link: ${record.name} couldn't be told it moved: ${String((error as Error | null)?.message ?? error)}`));
    // A queue that went on where it came from goes on here (one you stopped stays stopped).
    for (const session of record.queuesGoOn ?? []) await resumeQueue(record.lane ? readBridgeFile() : readEngineFile(), session).catch(() => {});
    if (record.kind === "bot") await settleBot(record.thing, readEngineFile, () => { try { return readBridgeFile(); } catch { return null; } }).catch(() => {});
  }
}

/** Moved back to where an earlier move left it: this is the one now. What's in the trash is older, and
 * goes; each agent's files were replaced by what came, but for the memory a bot now keeps in its folder. */
async function backHere(thing: string): Promise<void> {
  for (const entry of readLeft().filter(each => each.thing === thing)) {
    // Forgotten first: whatever below fails, nothing here is ever removed later as "left" (it runs here now).
    forgetLeft(entry.id);
    removeTrashed(entry.trash);
    const memory = (entry.left ?? []).flatMap(each => isObject(each) && typeof each.memory === "string" ? [{ ...each, paths: [] }] : []);
    const bridge = memory.length ? bridgeTarget() : null;
    if (bridge) await carry(bridge, "remove", { left: memory, sessions: entry.sessions, back: true });
  }
}

// ---- What a move left ----

let leftAskedAt = 0;

/** The newest message of a session here. */
async function newestMessage(lane: boolean, session: string): Promise<string | undefined> {
  const target = lane ? readBridgeFile() : readEngineFile();
  const listed = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=1&order=desc`, undefined, engineWait());
  const newest = Array.isArray(listed) ? listed[0] : null;
  return isObject(newest) && typeof newest.id === "string" ? newest.id : undefined;
}

/** When it first ran here since it came at `since`: the first of its replies after `last` (its newest
 * message as it came; replies that came with it keep the other computer's times), on what it's kept on. */
async function ranHereSince(lane: boolean, session: string, since: number, last?: string): Promise<number | null | "gone"> {
  const target = lane ? readBridgeFile() : readEngineFile();
  let listed: unknown;
  try {
    listed = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`, undefined, engineWait());
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 404) return "gone";
    throw error;
  }
  let messages = Array.isArray(listed) ? listed : [];
  // Not among the last 20 when there are more: all of those came after it. Fewer, and it isn't one
  // (gone since, reverted say): by the time, then.
  let came = last ? messages.findIndex(each => isObject(each) && each.id === last) : -1;
  if (came < 0 && messages.length < 20) came = -2;
  if (came >= 0) messages = messages.slice(0, came);
  const byOrder = !!last && came !== -2;
  const replies = messages.flatMap(each => {
    if (!isObject(each) || each.type !== "assistant" || !isObject(each.time) || typeof each.time.created !== "number") return [];
    return byOrder || each.time.created > since ? [Math.max(each.time.created, since)] : [];
  });
  return replies.length ? Math.min(...replies) : null;
}

/** Once in a while: the computers a move went to asked whether it has run there; what's been kept
 * long enough since then, removed. Nothing while a move of it is under way here (it may be coming
 * back, and its way back taken back). */
function keepLeft(now: number): void {
  const entries = readLeft();
  if (!entries.length) return;
  // (A clock set back asks again, rather than not until it's caught up.)
  const asking = now - leftAskedAt >= ASK_LEFT || now < leftAskedAt;
  if (asking) {
    leftAskedAt = now;
    for (const entry of entries) {
      if (entry.ranAt === undefined && entry.sessions[0]) tell(entry.to, { op: "ran?", id: entry.id, session: entry.sessions[0], ...(entry.lane ? { lane: true } : {}) });
    }
  }
  for (const entry of entries) {
    // A bot's keys that couldn't go as it left: again each hour (never while it's moving back here).
    if (entry.keys && asking && !moveOf(entry.thing)) void inTurn(entry.id, () => forgetBotKeys(entry.thing).then(gone => { if (gone && !moveOf(entry.thing)) keysGone(entry.id); }));
    if (entry.ranAt === undefined || now - entry.ranAt < KEEP_LEFT || moveOf(entry.thing)) continue;
    inTurn(entry.id, () => clearLeft(entry)).catch(error => console.error(`kuvo-link: what a move of ${entry.thing} left couldn't be removed yet: ${String((error as Error | null)?.message ?? error)}`));
  }
}

async function clearLeft(entry: LeftEntry): Promise<void> {
  if (moveOf(entry.thing) || !readLeft().some(each => each.id === entry.id)) return;
  // (Its keys first: the entry stays, and all of it's tried again, while they can't go.)
  if (entry.keys && !(await forgetBotKeys(entry.thing))) throw new Error("its own keys couldn't be taken away yet");
  if (entry.left?.length) {
    const bridge = bridgeTarget();
    // (Its agents' folders aren't looked at without it: tried again later.)
    if (!bridge) throw new Error("its coding agents aren't running");
    await carry(bridge, "remove", { left: entry.left, sessions: entry.sessions });
  }
  removeTrashed(entry.trash);
  forgetLeft(entry.id);
}

/** A copy here that won't be switched to from now on (`dropping`, and noted as dropped): what's
 * here of it stays held until it's gone. */
function letGo(id: string): MoveRecord | null {
  const record = readMove(id);
  if (!record || record.role !== "to") return null;
  noteEnded(id, "dropped", Date.now(), record.sessions);
  if (!record.dropping) changeMove(id, each => { each.dropping = true; each.dropSince = Date.now(); });
  return record;
}

/** A copy here that won't be switched to: gone, as if it never came. One that can't all go now (its
 * engine or group chats down) is kept, held and never switched to, and let go of again each minute
 * (`keepMoving`) until it's all gone: its record goes only then, never leaving a second copy live. */
async function drop(id: string): Promise<void> {
  const record = letGo(id);
  if (!record) return;
  await clearCopy(record);
  forgetMove(id);
  loggedStuck.delete(id);
}

/** What a move brought here, gone: its conversations, the folder it placed, a bot's keys, a group
 * chat held for it. It throws while any of it can't go (tried again: what went already is as good
 * as gone). */
async function clearCopy(record: MoveRecord): Promise<void> {
  incoming.delete(record.id);
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "release");
    forgetWorkQueues([record.thing]);
  } else {
    // (None brought in yet: its engine needn't be running.)
    if (record.lane) {
      // Only what this move placed, each agent's files too, and what those replaced back.
      if (fs.existsSync(placedOf(record.id))) await carry(readBridgeFile(), "undo", { keep: placedOf(record.id) });
      for (const session of record.sessions) forgetDecided(session);
    } else if (record.sessions.length) {
      const engine = readEngineFile();
      for (const session of [...record.sessions].reverse()) {
      await deleteSession(engine, session);
      forgetDecided(session);
    }
    }
    for (const session of record.sessions) forgetQueue(session);
    forgetWorkQueues(record.sessions);
    const place = folderOf(record.kind, record.thing);
    // Only a copy this move placed, never one that lives here.
    if (place && record.placed) {
      if (record.kind === "bot") await answerBotKeys("DELETE", `kuvo/bots/${record.thing}/keys`, null, null).catch(() => {});
      await toTrash(place);
    }
  }
}

// ---- Group chats held ----

// A group chat a move held, to start again (taken back) as its group chats weren't answering: they're
// looked at again each minute until it is, and once as the box starts.
let groupsToWake = false;
let groupsLookedAt = 0;

/** A group chat a move held here going on again, as it was; tried again later when it can't now. */
async function wakeGroup(group: string): Promise<void> {
  // (Held again meanwhile, by another move of it: it stays held.)
  if (moveOf(group)) return;
  try {
    await groupAction(readBridgeFile(), group, "activate");
  } catch (error) {
    // Not there any more: nothing to start.
    if ((error as { status?: number } | null)?.status !== 404) groupsToWake = true;
  }
}

/** Each group chat held here that no move under way holds, going on again. */
async function wakeHeldGroups(): Promise<void> {
  groupsToWake = false;
  let bridge: Target;
  try {
    bridge = readBridgeFile();
  } catch {
    groupsToWake = true;
    return;
  }
  const listed = await askGroups<{ data?: { group?: { id?: unknown }; status?: unknown }[] }>(bridge, "GET", "", undefined, engineWait()).catch(() => null);
  // (No group chats run here: none held.)
  if (listed?.status === 404) return;
  if (listed?.status !== 200 || !Array.isArray(listed.value?.data)) {
    groupsToWake = true;
    return;
  }
  for (const chat of listed.value.data) {
    const id = chat?.group?.id;
    // (Looked at as it's started, so one a move holds meanwhile stays held.)
    if (chat?.status === "held" && typeof id === "string") await wakeGroup(id);
  }
}

// ---- Mail between them ----

/** A move's mail from another box (`{"move": {op, id, …}}`). */
export async function takeMoveMail(sender: MailSender, given: unknown): Promise<void> {
  if (!isObject(given) || typeof given.op !== "string" || typeof given.id !== "string" || !/^mov_[A-Za-z0-9]{1,40}$/.test(given.id)) return;
  // Heard as it comes, not in its turn: one held a while by what this box is doing (settling a
  // conversation to send) doesn't make the other computer look quiet.
  const record = readMove(given.id);
  if (record && record.peer === sender.key) {
    heard.set(given.id, Date.now());
    // Back: clients see it carry on at once.
    if (waitingFor.delete(given.id)) movesChanged();
  }
  // Parts and their answers come many at once, and need no turn of their own (nor does word that a
  // copy's still being set up).
  if (given.op === "part" || given.op === "got" || given.op === "working" || given.op === "arrive") return moveMail(sender, given, given.id);
  // Whether it can run there: asked and answered while the box it leaves waits, in its turn.
  if (given.op === "check") return checkHere(sender, given, given.id);
  if (given.op === "checked") {
    if (record?.role === "from" && record.peer === sender.key) checking.get(given.id)?.(given);
    return;
  }
  return inTurn(given.id, () => moveMail(sender, given, given.id as string));
}

async function moveMail(sender: MailSender, given: Record<string, unknown>, id: string): Promise<void> {
  const record = readMove(id);
  const mine = record && record.peer === sender.key ? record : null;
  switch (given.op) {
    // To the box it goes to.
    case "offer": return takeOffer(sender, given);
    case "part": return takePart(sender, given);
    case "switch": {
      if (record && !mine) return;
      // Only a copy that's here, whole, is switched to; one switched before (its answer lost) says
      // so again; any other (dropped, never set up, unknown) is `dropped`, and the box it came
      // from keeps its original.
      if (mine?.role === "to" && mine.complete && !mine.dropping && mine.sessions.length + (mine.kind === "group" ? 1 : 0) > 0) {
        // (Its newest message as it came, before anything could run it here.)
        const last = mine.kind === "group" ? undefined : await newestMessage(mine.lane === true, mine.sessions[0]!).catch(() => undefined);
        await switchHere(mine);
        noteEnded(id, "switched", Date.now(), [], last);
        forgetMove(id);
        return void tell(sender.key, { op: "switched", id });
      }
      if (mine?.role === "to") return letGoOf(sender, id);
      return void tell(sender.key, { op: endedAs(id) === "switched" ? "switched" : "dropped", id });
    }
    // Asked again whether its copy arrived (that word may have been lost): as it is here.
    case "arrive": {
      if (record && !mine) return;
      const failed = () => tell(sender.key, { op: "failed", id, message: `It couldn’t be set up on ${HERE}.`, ...(typeof given.hash === "string" ? { hash: given.hash } : {}) });
      if (mine?.role !== "to" || mine.dropping || !mine.complete) return void failed();
      if (mine.setUpSince === undefined) return void tell(sender.key, { op: "arrived", id, hash: mine.hash, ...(mine.digest ? { digest: mine.digest } : {}) });
      if (toSetUp.has(id)) return void tell(sender.key, { op: "working", id });
      // Cut short by a restart (nothing sets it up now): what came of it goes.
      return inTurn(id, () => drop(id)).then(() => void failed(), () => void failed());
    }
    case "drop":
      if (record && !mine) return;
      // A copy switched to already can't be let go: the box it came from goes on to finish.
      if (endedAs(id) === "switched") return void tell(sender.key, { op: "switched", id });
      if (mine?.role === "to") return letGoOf(sender, id);
      return void tell(sender.key, { op: "dropped", id });
    // To the box it leaves.
    case "ready":
      if (mine?.role !== "from" || mine.step !== "offer") return;
      changeMove(id, each => { each.step = "parts"; each.sentAt = Date.now(); });
      return sendParts(readMove(id)!);
    case "got": {
      if (mine?.role !== "from" || mine.step !== "parts" || !Number.isInteger(given.i)) return;
      const state = outgoing.get(id);
      if (!state) return;
      // (One lost and then come after all counts too, as it's no longer on its way.)
      const fresh = !state.got.has(given.i as number);
      state.got.add(given.i as number);
      state.flying.delete(given.i as number);
      if (fresh) state.window = Math.min(IN_FLIGHT, (state.window ?? IN_FLIGHT) + 1);
      const of = Math.ceil((mine.size ?? 0) / PART_BYTES);
      if (state.got.size === of) {
        changeMove(id, each => { each.sent = each.size; each.step = "arrive"; each.sentAt = Date.now(); });
      } else {
        if (state.got.size % 32 === 0) changeMove(id, each => { each.sent = Math.min(each.size ?? 0, state.got.size * PART_BYTES); });
        sendParts(mine);
      }
      return;
    }
    case "arrived":
      // (Of the bundle it sent last: one before it, sent again, is old news.)
      if (mine?.role !== "from" || mine.stage !== "copying" || mine.failed || (typeof given.hash === "string" && given.hash !== mine.hash)) return;
      return arrived(mine, given.digest).catch(error => takeBack(id, String((error as Error | null)?.message ?? error), 409));
    case "refused":
    case "failed":
      // (One about a bundle before the one sent last, asked again late, is old news.)
      if (mine?.role !== "from" || mine.stage !== "copying" || mine.failed || (typeof given.hash === "string" && given.hash !== mine.hash)) return;
      return takeBack(id, typeof given.message === "string" ? given.message : "It couldn’t go there.", 409);
    case "switched":
      if (mine?.role !== "from" || (mine.stage !== "switching" && mine.stage !== "finishing")) return;
      return finish(id).catch(() => {});
    case "dropped":
      // Its copy there is gone before it was switched to: the original here goes on, as it was.
      if (mine?.role === "from" && mine.stage === "switching") return restore(mine, `${mine.name} couldn’t be set up there, so it stayed here. Try again.`);
      if (mine?.role === "from" && mine.step === "drop") return void forgetMove(id);
      return;
    // Its copy there still being set up (`heard`, as it came, is all it's for).
    case "working":
      return;
    // Has what came from there run here yet?
    case "ran?": {
      if (typeof given.session !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(given.session)) return;
      const since = endedAt(id);
      // (Only one that came here, from that computer: a word of it is what removes what's there.)
      if (since === null || endedAs(id) !== "switched") return;
      const ran = await ranHereSince(given.lane === true, given.session, since, endedLast(id)).catch(() => null);
      // Gone from here (moved on, or deleted): it's not coming back through that way, so the time starts.
      if (ran !== null) tell(sender.key, { op: "ran", id, at: ran === "gone" ? Date.now() : ran });
      return;
    }
    case "ran":
      if (typeof given.at === "number") noteRan(id, sender.key, given.at);
      return;
  }
}

/** The copy here of a move the box it came from takes back: said `dropped` as soon as it's marked
 * so (it's never switched to after), so that box goes on with its original at once; what's here of
 * it goes now, or, held meanwhile, once its engine or group chats let it (`keepMoving`). */
async function letGoOf(sender: MailSender, id: string): Promise<void> {
  try {
    letGo(id);
  } catch {
    return;
  }
  tell(sender.key, { op: "dropped", id });
  await drop(id).catch(() => {});
}

// ---- Keeping them going ----

// Each move's next step, once in a while: a step unanswered sent again; a first offer with no answer
// taken back (the other computer isn't there); one whose other computer was removed, ended. And your
// other computers told what moves here, and what one quiet a while said forgotten (`elsewhere.ts`).
/** Move folders no move here has, by when they were first seen so. */
const orphans = new Map<string, number>();
/** How long one's left first: longer than the bridge's packing or placing is waited for. */
const ORPHAN_AFTER = 2 * CARRY_WAIT;

export function keepMoving(now = Date.now()): void {
  const records = readMoves();
  noteWaiting(records, now);
  keepLeft(now);
  tellMoving(hostOf(), now);
  forgetQuiet(now);
  if (groupsToWake && now - groupsLookedAt > STEP_AGAIN) {
    groupsLookedAt = now;
    wakeHeldGroups().catch(() => {});
  }
  const peers = new Set(peersOf(readLink()).map(peer => peer.key));
  let names: string[] = [];
  try { names = fs.readdirSync(MOVES).filter(name => name.endsWith(".outcome.json")); } catch {}
  for (const name of names) try { if (now - fs.statSync(path.join(MOVES, name)).mtimeMs > OUTCOME_KEPT) fs.rmSync(path.join(MOVES, name), { force: true }); } catch {}
  // A move's folder no move here has any more (a step under way as it was taken back made it again):
  // gone once it's been seen so for longer than a step's given.
  let folders: string[] = [];
  try { folders = fs.readdirSync(MOVES, { withFileTypes: true }).filter(each => each.isDirectory() && each.name.startsWith("mov_")).map(each => each.name); } catch {}
  const known = new Set(records.map(record => record.id));
  for (const name of [...orphans.keys()]) if (!folders.includes(name) || known.has(name)) orphans.delete(name);
  for (const name of folders) {
    if (known.has(name)) continue;
    const since = orphans.get(name) ?? now;
    orphans.set(name, since);
    if (now - since > ORPHAN_AFTER) {
      try { fs.rmSync(bundleOf(name), { recursive: true, force: true }); } catch {}
      orphans.delete(name);
    }
  }
  for (const record of records) {
    if (!peers.has(record.peer)) {
      // Gone a while, not just left out as your computers are read again.
      const since = missing.get(record.id) ?? now;
      missing.set(record.id, since);
      if (now - since >= GONE_FOR) inTurn(record.id, () => endWithout(record.id)).catch(() => {});
      continue;
    }
    missing.delete(record.id);
    if (record.role === "to") {
      // A copy that couldn't all be let go of (its engine or group chats down): again, each minute.
      // Still not a week after it began: said in the log, once, and tried each hour (and as the box
      // starts).
      // It's never forgotten while any of it's here, so what's left never goes on as a second copy.
      if (record.dropping) {
        const late = now - (record.dropSince ?? record.started) > HELD_AT_MOST;
        if (now - (record.sentAt ?? 0) > (late ? DROP_AGAIN_LATE : STEP_AGAIN)) {
          changeMove(record.id, each => { each.sentAt = now; });
          inTurn(record.id, () => drop(record.id)).catch(error => {
            if (!late || loggedStuck.has(record.id)) return;
            loggedStuck.add(record.id);
            console.error(`kuvo-link: a copy of ${record.name} that came here couldn’t be let go of in a week, so it stays held: ${String((error as Error | null)?.message ?? error)}`);
          });
        }
        continue;
      }
      // Setting it up stuck (its engine not answering): given up on, which lets what came of it go
      // and says it failed, so the box it came from takes it back.
      // (One cut short by a restart was let go of as the box started, `resumeMoves`.)
      const stop = settingUp.get(record.id);
      if (stop && now - (record.setUpSince ?? now) > SET_UP_AT_MOST) stop.abort(new NotTaken("It took too long to set up."));
      else if (now - record.started > HELD_AT_MOST) inTurn(record.id, () => drop(record.id)).catch(() => {});
      continue;
    }
    // Taken back, whatever step it was left at (`takeBack` always says `drop`; a record from before
    // it did, or one written by hand, may not): its copy there is let go.
    if (record.failed && record.step !== "drop") {
      changeMove(record.id, each => { each.step = "drop"; each.sentAt = now; each.dropSince = now; });
      tell(record.peer, { op: "drop", id: record.id });
      continue;
    }
    // Getting it ready stuck (its engine or group chats not answering): taken back now, not in its
    // turn (which waits on what's stuck), so whoever asked hears.
    // (One noted by another process, `box route`, and not yet driven has no `holdSince`: counted
    // from when it began.)
    const holdingSince = record.holdSince ?? (!record.step || record.step === "check" ? record.started : undefined);
    if (record.stage === "holding" && holdingSince !== undefined && now - holdingSince > HOLDING_AT_MOST) {
      takeBack(record.id, say.slow(record.name), 409).catch(() => {});
      continue;
    }
    // One asked for through another process (`box route`): moved from here, from its check or its start.
    if (record.stage === "holding" && (!record.step || record.step === "check")) {
      drive(record.id);
      continue;
    }
    const due = now - Math.max(record.sentAt ?? 0, record.againAt ?? 0) > STEP_AGAIN;
    // Switched there, its original not yet gone here (its engine was down): tried again.
    if (record.stage === "finishing") {
      if (due) inTurn(record.id, () => finish(record.id)).catch(() => {});
      continue;
    }
    // Asked to switch, a while, with no answer either way: it asks the other box to let its copy go
    // instead. It answers `switched` if it did switch, else `dropped`, and the original goes on
    // here; nothing goes here without `switched`.
    if (record.step === "switch" && now - (record.switchSince ?? 0) > QUIET_AT_MOST) {
      changeMove(record.id, each => { each.step = "drop"; each.sentAt = now; });
      tell(record.peer, { op: "drop", id: record.id });
      continue;
    }
    // Before the switch, quiet too long: taken back (one first offered gets 30 seconds, below).
    const quiet = now - Math.max(record.sentAt ?? 0, heard.get(record.id) ?? 0) > QUIET_AT_MOST;
    if (quiet && (record.step === "parts" || record.step === "arrive" || (record.step === "offer" && record.tries > 0))) {
      inTurn(record.id, () => takeBack(record.id, `${nameOf(record.peer)} stopped answering, so ${record.name} stayed here. Try again once it’s back.`, 503)).catch(() => {});
      continue;
    }
    // (One asked to let go instead of switching is asked until it answers: it may have switched.)
    if (record.step === "drop" && record.stage !== "switching" && now - (record.dropSince ?? record.started) > DROP_AT_MOST) {
      forgetMove(record.id);
      continue;
    }
    switch (record.step) {
      case "offer":
        if (record.tries === 0 && now - (record.sentAt ?? 0) > NO_ANSWER && !outgoing.get(record.id)?.got.size) {
          inTurn(record.id, () => takeBack(record.id, say.notConnected(nameOf(record.peer)), 503)).catch(() => {});
        } else if (due) {
          changeMove(record.id, each => { each.againAt = now; });
          offer(record);
        }
        break;
      // Its copy all there, and no word of it set up (that word lost, say): asked again.
      case "arrive":
        if (due) {
          changeMove(record.id, each => { each.againAt = now; });
          tell(record.peer, { op: "arrive", id: record.id, hash: record.hash });
        }
        break;
      case "parts":
        if (outgoing.has(record.id)) sendParts(record, now);
        else inTurn(record.id, () => takeBack(record.id, `${record.name} didn’t get there. Try again.`, 409)).catch(() => {});
        break;
      case "switch":
        if (due) {
          changeMove(record.id, each => { each.sentAt = now; });
          tell(record.peer, { op: "switch", id: record.id });
        }
        break;
      case "drop":
        if (due) {
          changeMove(record.id, each => { each.sentAt = now; });
          tell(record.peer, { op: "drop", id: record.id });
        }
        break;
    }
  }
}

/** The moves here waiting on their other computer (`waitingFor`), whose other computer has said
 * nothing of them a while: from here, one that asked a step (its offer sent again, its parts, word
 * it's all there, or the switch, and then to let its copy go instead); coming here, a copy whose
 * parts or switch don't come. Clients told when that changes. */
function noteWaiting(records: MoveRecord[], now: number): void {
  const waiting = records.filter(record => {
    if (record.failed) return false;
    if (record.role === "to") {
      // (Being let go of, or set up here now: this box is at it.)
      if (record.dropping || record.setUpSince !== undefined) return false;
      // Its parts, since it was offered; set up, the switch, since it said so (the other box gets
      // the original ready to go first, a minute at most).
      return record.complete
        ? now - Math.max(record.setUpAt ?? record.started, heard.get(record.id) ?? 0, lookingSince) > WAITING_AFTER + SETTLE_FOR * 1000
        : now - Math.max(record.started, heard.get(record.id) ?? 0, lookingSince) > WAITING_AFTER;
    }
    const asked = record.step === "switch" || (record.step === "drop" && record.stage === "switching") ? record.switchSince
      : record.step === "parts" || record.step === "arrive" || (record.step === "offer" && record.tries > 0) ? record.sentAt
      : undefined;
    return asked !== undefined && now - Math.max(asked, heard.get(record.id) ?? 0, lookingSince) > WAITING_AFTER;
  }).map(record => record.id);
  if (waiting.length === waitingFor.size && waiting.every(id => waitingFor.has(id))) return;
  waitingFor.clear();
  for (const id of waiting) waitingFor.add(id);
  movesChanged();
}

/** A move whose other computer you removed: what's here goes back as it was (a copy that came, or
 * an original, switching or not: only `switched` lets it go), or, switched already, the original
 * goes. */
async function endWithout(id: string): Promise<void> {
  missing.delete(id);
  const record = readMove(id);
  if (!record) return;
  if (record.role === "to") return drop(id);
  if (record.stage === "finishing") return finish(id);
  if (record.failed) return void forgetMove(id);
  return restore(record, say.notConnected(nameOf(record.peer)));
}

/** As the box starts: moves cut short carry on (one switched, forward; one not yet, taken back), and
 * a `moving` hold nothing here moves (one a released Mac's move left as it updated) is lifted. */
export async function resumeMoves(now = Date.now()): Promise<void> {
  for (const record of readMoves()) {
    // A copy being set up here as the box stopped: nothing sets it up now, so what came of it goes,
    // and the box it came from hears it failed (and keeps its original). One being let go of goes on.
    if (record.role === "to" && (record.dropping || (record.complete && record.setUpSince !== undefined))) {
      await inTurn(record.id, () => drop(record.id)).catch(() => {});
      if (!record.dropping) tell(record.peer, { op: "failed", id: record.id, message: `It couldn’t be set up on ${HERE}.` });
      continue;
    }
    if (record.role !== "from") continue;
    // Each in its turn, as its mail and `keepMoving` are.
    if (record.stage === "finishing") await inTurn(record.id, () => finish(record.id)).catch(() => {});
    // (One asked for just now, through another process, is moved from here.)
    else if (record.stage === "holding" && (!record.step || record.step === "check") && now - record.started < 30_000) continue;
    else if (record.stage !== "switching") await inTurn(record.id, () => takeBack(record.id, `${record.name} didn’t get there. Try again.`, 409)).catch(() => {});
  }
  const moving = new Set(readMoves().map(record => record.thing));
  for (const kind of ["bot", "chat"] as const) {
    const parent = path.dirname(folderOf(kind, "x")!);
    let names: string[] = [];
    try { names = fs.readdirSync(parent); } catch {}
    for (const name of names) {
      const folder = path.join(parent, name);
      if (!moving.has(name) && pausedText(folder) === "moving") unhold(folder, false);
    }
  }
  // And a group chat held that no move here holds (one taken back as its group chats were down).
  groupsLookedAt = now;
  await wakeHeldGroups().catch(() => {});
  movesChanged();
}

/** Moves go by the relay connection `host` gives (the one that's up), and carry on from where they
 * were as the box starts; each step not answered is sent again. */
export function watchMoves(host: () => Pick<LinkHost, "send"> | null | undefined, signal?: AbortSignal): void {
  hostOf = host;
  watching = true;
  lookingSince = Date.now();
  resumeMoves().catch(() => {});
  const timer = setInterval(() => keepMoving(), 3_000);
  signal?.addEventListener("abort", () => {
    clearInterval(timer);
    watching = false;
  }, { once: true });
}
