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
import type { Move, MoveKind, MovePlace } from "../../shared/routes/moves";
import { plainName } from "../../shared/text";
import { answerBotKeys } from "../areas/bot-keys";
import { askGroups } from "../areas/groups";
import { botHere, MOVING } from "../bots/here";
import { settleBot } from "../bots/tell";
import { call, readBridgeFile, readEngineFile } from "../engine/client";
import { writePrivate } from "../files";
import { HERE, IS_MAC, K } from "../home";
import { mailFor, ownKey, peersOf } from "../peers/known";
import type { MailSender, Peer } from "../peers/known";
import type { LinkHost } from "../relay/host";
import { readLink } from "../state";
import { CHATS, MOST_BUNDLE, deleteSession, directoryOf, exportAll, folderOf, groupAction, hashOf, idsOf, importAll, keysOf, pack, same, toTrash, unpack } from "./bundle";
import type { Contents } from "./bundle";
import { MOVES, bundleOf, changeMove, endedAs, forgetMove, forgetMovedAway, moveOf, movesChanged, noteEnded, noteMovedAway, readMove, readMoves, saveMove, shownMove } from "./records";
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
/** How long the box it leaves waits for its conversations to settle, at most. */
const SETTLE_FOR = 60;
/** A copy held here with no word from the box it came from this long goes. */
const HELD_AT_MOST = 7 * 24 * 3600_000;

/** What a move says, in words to show. */
export const say = {
  notConnected: (place: string) => `${place} isn’t connected. Connect to it, then try again.`,
  working: (name: string) => `${name} is working. Move it once it’s done.`,
  inProject: (name: string) => `${name} works in one of your projects, which stays where it is. Only a bot with a folder of its own can move.`,
  withAgents: (name: string) => `${name} talks with a coding agent, which keeps its conversation on this computer, so it can’t move yet.`,
  waiting: (name: string) => `${name} still has messages on their way. Try again in a moment.`,
  busy: (name: string) => `${name} kept getting messages while it moved, so it stayed where it is. Try again in a moment.`,
  botsElsewhere: (chat: string) => `${chat}’s bots live on different computers, so it can’t go there.`,
  inBoxGroup: (name: string, chat: string) => `${name} is in “${chat}”, which lives on ${HERE} with its bots. Move the chat to a Mac first, or take ${name} out of it.`,
  tooBig: (name: string) => `${name} is too big to move over the internet (more than 1 GB).`,
  noGroups: (place: string) => `Group chats on ${place} aren’t running right now. Try again once they are.`,
  noEngine: (place: string) => `The engine on ${place} isn’t running. Try again once it is.`,
  moving: MOVING,
};

/** A move's outcome, for whoever asked for it. */
export type MoveOutcome = { ok: true; move: Move } | { ok: false; status: number; message: string };

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
  inTurn(id, () => carryOn(id).catch(error => takeBack(id, String((error as Error | null)?.message ?? error), (error as Refused | null)?.status ?? 409))).finally(() => driving.delete(id));
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
  try {
    hostOf()?.send(bytes);
    return Boolean(hostOf());
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
}

async function movable(kind: MoveKind, thing: string, signal?: AbortSignal): Promise<Movable | null> {
  if (kind === "bot") {
    const here = botHere(thing);
    if (!here) return null;
    const name = here.described.name;
    if (here.described.project) return { name, why: say.inProject(name) };
    if (here.agents) return { name, why: say.withAgents(name) };
    // One in a group chat that lives here with its bots, on a machine, stays with it.
    if (!IS_MAC) {
      let bridge: Target | null = null;
      try { bridge = readBridgeFile(); } catch {}
      const listed = bridge ? await askGroups<{ data?: { group?: { id?: string; name?: string; members?: unknown } }[] }>(bridge, "GET", "", undefined, signal).catch(() => null) : null;
      const chat = (listed?.status === 200 && Array.isArray(listed.value?.data) ? listed.value.data : []).find(each => Array.isArray(each?.group?.members) && (each.group.members as unknown[]).includes(thing));
      if (chat) return { name, root: here.session, why: say.inBoxGroup(name, plainName(chat.group?.name ?? "") || "a group chat") };
    }
    return { name, root: here.session };
  }
  if (kind === "chat") {
    let session: unknown;
    try { session = await call(readEngineFile(), "GET", `/api/session/${encodeURIComponent(thing)}`, undefined, signal); } catch { return null; }
    if (!isObject(session)) return null;
    const title = typeof session.title === "string" && session.title.trim() ? `“${session.title.trim()}”` : "This chat";
    const directory = isObject(session.location) ? session.location.directory : session.directory;
    if (directory !== CHATS) return null;
    const kuvo = isObject(session.metadata) && isObject(session.metadata.kuvo) ? session.metadata.kuvo : {};
    if (kuvo.agents || kuvo.agent) return { name: title, why: say.withAgents(title) };
    return { name: title, root: thing };
  }
  let bridge: Target;
  try { bridge = readBridgeFile(); } catch { return null; }
  const listed = await askGroups<{ data?: { group?: { name?: string } } }>(bridge, "GET", `/${encodeURIComponent(thing)}`, undefined, signal).catch(() => null);
  if (listed?.status !== 200) return null;
  return { name: `“${plainName(listed.value?.data?.group?.name ?? "") || "Group chat"}”` };
}

/** Where `thing` can go: each of your other computers, and why not one where it can't. */
export async function placesFor(kind: MoveKind, thing: string, signal?: AbortSignal): Promise<MovePlace[] | null> {
  const what = await movable(kind, thing, signal);
  if (!what) return null;
  const why = moveOf(thing) ? say.moving : what.why;
  const own = ownKey(readLink() ?? {});
  return peersOf(readLink()).filter(peer => peer.key !== own).map(peer => ({
    key: peer.key, name: plainName(peer.name) || (peer.kind === "mac" ? "Mac" : "Machine"), kind: peer.kind, ok: !why, ...(why ? { why } : {}),
  }));
}

// ---- The box it leaves ----

/** Moves `thing` to the box whose key is `to`, as a client asks: until it's there, or why not. */
export async function startMove(kind: MoveKind, thing: string, to: string, signal?: AbortSignal): Promise<MoveOutcome> {
  const link = readLink();
  const own = link ? ownKey(link) : null;
  const peer = peersOf(link).find(each => each.key === to);
  if (!own || !peer || to === own) return { ok: false, status: 404, message: "That computer isn’t one of yours." };
  if (moveOf(thing)) return { ok: false, status: 409, message: say.moving };
  const what = await movable(kind, thing, signal);
  if (!what) return { ok: false, status: 404, message: "It isn’t on this computer any more." };
  if (what.why) return { ok: false, status: 409, message: what.why };
  const id = `mov_${crypto.randomBytes(12).toString("base64url").replace(/[-_]/g, "")}`;
  const folder = folderOf(kind, thing);
  const record: MoveRecord = {
    id, kind, thing, name: what.name, from: own, to, role: "from", stage: "holding", sessions: what.root ? [what.root] : [],
    peer: to, wasPaused: true, tries: 0, started: Date.now(), ...(folder && fs.existsSync(folder) ? { folder } : {}),
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

/** Until none of its conversations is at work and nothing waits to go to them: a minute at most. */
async function settle(engine: Target, sessions: readonly string[], name: string): Promise<void> {
  for (let tries = 0; tries < SETTLE_FOR; tries++) {
    const active = await call(engine, "GET", "/api/session/active").catch(() => ({}));
    const busy = isObject(active) && sessions.some(session => session in active);
    const inbox = sessions[0] ? await call(engine, "GET", `/api/session/${encodeURIComponent(sessions[0])}/inbox`).catch(() => []) : [];
    if (!busy && !(Array.isArray(inbox) && inbox.length)) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Refused(say.waiting(name));
}

class Refused extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

// What the box it leaves has of each move in memory: the parts the other box has, and those on
// their way (by when they went).
const outgoing = new Map<string, { got: Set<number>; flying: Map<number, number>; exports: unknown[] }>();

/** The box it leaves, carrying on from where it is (as it starts, or step by step). */
async function carryOn(id: string): Promise<void> {
  const record = readMove(id);
  if (!record || record.role !== "from" || record.stage !== "holding") return;
  hold(record);
  saveMove(record);
  let exports: unknown[] = [];
  const contents: Contents = { kind: record.kind, thing: record.thing, name: record.name, exports, wasPaused: record.wasPaused };
  if (record.kind === "group") {
    contents.group = await groupAction(readBridgeFile(), record.thing, "hold") as Contents["group"];
    const members = isObject(contents.group?.group) && Array.isArray(contents.group.group.members) ? contents.group.group.members : [];
    record.members = members.filter((member): member is string => typeof member === "string");
  } else {
    const engine = readEngineFile();
    await settle(engine, record.sessions, record.name);
    exports = await exportAll(engine, record.sessions[0]);
    contents.exports = exports;
    record.sessions = idsOf(exports);
    if (record.folder) contents.folder = path.basename(record.folder);
    if (record.kind === "bot") {
      const keys = await keysOf(record.thing);
      if (!keys) throw new Refused(`${record.name}’s own keys couldn’t be read on ${HERE}. Try again in a moment.`);
      if (Object.keys(keys).length) contents.keys = keys;
    }
  }
  const bundle = await pack(id, contents);
  if (bundle.size > MOST_BUNDLE) throw new Refused(say.tooBig(record.name));
  outgoing.set(id, { got: new Set(), flying: new Map(), exports });
  const now = changeMove(id, each => {
    Object.assign(each, { sessions: record.sessions, wasPaused: record.wasPaused, pausedAs: record.pausedAs, members: record.members, hash: bundle.hash, size: bundle.size, sent: 0, stage: "copying", step: "offer", offered: true, sentAt: Date.now() });
  });
  if (now) offer(now);
}

function offer(record: MoveRecord): void {
  tell(record.peer, { op: "offer", id: record.id, kind: record.kind, thing: record.thing, name: record.name, size: record.size, hash: record.hash, wasPaused: record.wasPaused, ...(record.pausedAs !== undefined ? { pausedAs: record.pausedAs } : {}), from: record.from, ...(record.members ? { members: record.members } : {}) });
}

// The next parts to the other box, up to `IN_FLIGHT` on their way.
function sendParts(record: MoveRecord, now = Date.now()): void {
  const state = outgoing.get(record.id);
  if (!state || !record.size) return;
  const of = Math.ceil(record.size / PART_BYTES);
  const file = path.join(bundleOf(record.id), "bundle.tgz");
  let handle: number | null = null;
  try {
    for (let i = 0; i < of && state.flying.size < IN_FLIGHT; i++) {
      if (state.got.has(i) || (state.flying.has(i) && now - state.flying.get(i)! < PART_AGAIN)) continue;
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
async function arrived(record: MoveRecord): Promise<void> {
  const still = () => {
    const now = readMove(record.id);
    return now?.role === "from" && now.stage === "copying" && !now.failed ? now : null;
  };
  if (record.kind !== "group") {
    const engine = readEngineFile();
    await settle(engine, record.sessions, record.name);
    const again = await exportAll(engine, record.sessions[0]);
    const before = outgoing.get(record.id)?.exports;
    // Taken back meanwhile (its copy there couldn't be set up, or it took too long): nothing more.
    if (!still()) return;
    if (!before || !same(again, before)) {
      if (record.tries >= 2) throw new Refused(say.busy(record.name));
      changeMove(record.id, each => { each.tries += 1; each.stage = "holding"; each.step = undefined; });
      return drive(record.id);
    }
  }
  // From here on the copy is the one: only while it's still under way (read and noted at once).
  if (!still()) return;
  const now = changeMove(record.id, each => { each.stage = "switching"; each.step = "switch"; each.sentAt = Date.now(); });
  if (now) tell(now.peer, { op: "switch", id: now.id });
}

/** Switched: the original goes here, its conversation kept in its folder as it goes to the trash. */
async function finish(id: string): Promise<void> {
  const record = changeMove(id, each => { each.stage = "finishing"; each.step = "done"; });
  if (!record) return;
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "release");
  } else {
    const engine = readEngineFile();
    const place = record.folder ?? path.join(K, `moved-${record.thing}`);
    try {
      const exports = await exportAll(engine, record.sessions[0]);
      fs.mkdirSync(place, { recursive: true });
      writePrivate(path.join(place, "conversation.json"), JSON.stringify(exports, null, 2));
    } catch {}
    for (const session of [...record.sessions].reverse()) await deleteSession(engine, session);
    if (record.kind === "bot") await answerBotKeys("DELETE", `kuvo/bots/${record.thing}/keys`, null, null).catch(() => {});
    await toTrash(place);
  }
  noteMovedAway(record.sessions, record.to);
  forgetMove(id);
  outgoing.delete(id);
  ended(id, { ok: true, move: shownMove({ ...record, stage: "finishing" }) });
}

/** Taken back before it switched: the other box lets its copy go, and it goes on here as it was. */
async function takeBack(id: string, message: string, status = 409): Promise<void> {
  const record = readMove(id);
  if (!record || record.role !== "from" || record.failed || record.stage === "switching" || record.stage === "finishing") return;
  outgoing.delete(id);
  // As it was, before whoever asked hears.
  unhold(record.folder, record.wasPaused, record.pausedAs);
  if (record.kind === "group") await groupAction(readBridgeFile(), record.thing, "activate").catch(() => {});
  // Offered already: its copy there goes too, once that box says so (`dropped`).
  if (record.offered) {
    changeMove(id, each => { each.step = "drop"; each.sentAt = Date.now(); each.failed = message; each.failedStatus = status; });
    tell(record.peer, { op: "drop", id });
  } else {
    forgetMove(id);
  }
  ended(id, { ok: false, status, message });
}

/** A move whose copy the other box let go of before it was switched to: the original goes on here. */
async function restore(record: MoveRecord, message: string): Promise<void> {
  outgoing.delete(record.id);
  unhold(record.folder, record.wasPaused, record.pausedAs);
  if (record.kind === "group") await groupAction(readBridgeFile(), record.thing, "activate").catch(() => {});
  forgetMove(record.id);
  try { fs.rmSync(bundleOf(record.id), { recursive: true, force: true }); } catch {}
  ended(record.id, { ok: false, status: 409, message });
}

// ---- The box it goes to ----

// What the box it goes to has of each bundle on its way: the parts written so far.
const incoming = new Map<string, Set<number>>();

async function takeOffer(sender: MailSender, given: Record<string, unknown>): Promise<void> {
  const id = String(given.id);
  const answer = (move: Record<string, unknown>) => tell(sender.key, { id, ...move });
  const kind = given.kind as MoveKind;
  const thing = typeof given.thing === "string" ? given.thing : "";
  const name = typeof given.name === "string" ? given.name : "It";
  const size = typeof given.size === "number" ? given.size : 0;
  if (!["bot", "chat", "group"].includes(kind) || !/^[A-Za-z0-9_]{1,80}$/.test(thing) || typeof given.hash !== "string" || size <= 0) return void answer({ op: "refused", message: "That isn’t a move." });
  if (size > MOST_BUNDLE) return void answer({ op: "refused", message: say.tooBig(name) });
  const place = IS_MAC ? "this Mac" : (plainName(readLink()?.name ?? "") || "this machine");
  if (kind === "group") {
    let bridge: Target | null = null;
    try { bridge = readBridgeFile(); } catch {}
    const running = bridge ? await askGroups(bridge, "GET", "", undefined, undefined).then(answer => answer.status === 200).catch(() => false) : false;
    if (!running) return void answer({ op: "refused", message: say.noGroups(place) });
    // To a machine, only with its bots: they all live there, and stay there while it does.
    const members = Array.isArray(given.members) ? given.members : [];
    if (!IS_MAC && members.some(member => !botHere(member))) return void answer({ op: "refused", message: say.botsElsewhere(name) });
  } else {
    try {
      await call(readEngineFile(), "GET", "/api/session/active");
    } catch {
      return void answer({ op: "refused", message: say.noEngine(place) });
    }
  }
  const was = readMove(id);
  if (was && was.role === "to" && was.hash === given.hash) return void answer({ op: "ready" });
  // A move of it this way already, cut short: this one takes its place.
  const before = moveOf(thing);
  if (before && before.id !== id && before.role === "to") await drop(before.id);
  else if (before && before.id !== id) return void answer({ op: "refused", message: say.moving });
  fs.rmSync(bundleOf(id), { recursive: true, force: true });
  fs.mkdirSync(bundleOf(id), { recursive: true, mode: 0o700 });
  incoming.set(id, new Set());
  saveMove({
    id, kind, thing, name, from: sender.key, to: ownKey(readLink() ?? {}) ?? "", role: "to", stage: "copying", sessions: was?.sessions ?? [],
    peer: sender.key, wasPaused: given.wasPaused === true, ...(typeof given.pausedAs === "string" ? { pausedAs: given.pausedAs.slice(0, 2000) } : {}), hash: given.hash, size, sent: 0, tries: 0, started: was?.started ?? Date.now(),
  });
  answer({ op: "ready" });
}

async function takePart(sender: MailSender, given: Record<string, unknown>): Promise<void> {
  const id = String(given.id);
  const record = readMove(id);
  const i = given.i, of = given.of;
  const expected = Math.ceil((record?.size ?? 0) / PART_BYTES);
  if (!record || record.role !== "to" || record.complete || record.peer !== sender.key || record.hash !== given.hash || !Number.isInteger(i) || of !== expected
    || (i as number) < 0 || (i as number) >= expected || typeof given.d !== "string" || given.d.length > Math.ceil(PART_BYTES * 4 / 3)) return;
  const parts = incoming.get(id) ?? new Set<number>();
  incoming.set(id, parts);
  const bytes = Buffer.from(given.d, "base64url");
  const file = path.join(bundleOf(id), "bundle.tgz");
  const handle = fs.openSync(file, fs.existsSync(file) ? "r+" : "w", 0o600);
  try { fs.writeSync(handle, bytes, 0, bytes.length, (i as number) * PART_BYTES); } finally { fs.closeSync(handle); }
  parts.add(i as number);
  tell(sender.key, { op: "got", id, i });
  if (parts.size % 32 === 0 || parts.size === of) changeMove(id, each => { each.sent = Math.min(each.size ?? 0, parts.size * PART_BYTES); });
  if (parts.size !== of) return;
  incoming.delete(id);
  // All here: put in place once, whatever comes again after.
  changeMove(id, each => { each.complete = true; });
  try {
    if (await hashOf(file) !== record.hash) throw new Error("What came wasn’t what was sent.");
    const sessions = await bringIn(record);
    changeMove(id, each => { each.sessions = sessions; });
    tell(sender.key, { op: "arrived", id });
  } catch (error) {
    // What was set up of it goes: the box it came from takes it back, and a switch for it is
    // answered `dropped`.
    await drop(id).catch(() => {});
    tell(sender.key, { op: "failed", id, message: `It couldn’t be set up on ${HERE}: ${String((error as Error | null)?.message ?? error)}` });
  }
}

/** The bundle put in place here, held: its folder, its conversations, a bot's keys, a group chat. */
async function bringIn(record: MoveRecord): Promise<string[]> {
  const { contents, folder } = await unpack(record.id);
  if (record.kind === "group") {
    const held = contents.group;
    if (!held || !isObject(held.group)) throw new Error("The group chat didn’t come with it.");
    const answer = await askGroups<{ message?: unknown }>(readBridgeFile(), "PUT", `/${encodeURIComponent(record.thing)}`, { group: held.group, messages: held.messages, status: "held" }, undefined);
    if (answer.status !== 200) throw new Error(typeof answer.value?.message === "string" ? answer.value.message : `Its group chats answered ${answer.status}.`);
    return [];
  }
  const place = folderOf(record.kind, record.thing)!;
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
  // Its conversations, noted before they're brought in: any that came go if it's taken back.
  changeMove(record.id, each => { each.sessions = idsOf(contents.exports); });
  await importAll(readEngineFile(), contents.exports, directory);
  for (const [integration, keys] of Object.entries(contents.keys ?? {})) {
    const given = await answerBotKeys("PUT", `kuvo/bots/${record.thing}/keys/${encodeURIComponent(integration)}`, { keys }, null);
    if (given.status !== 200) console.error(`kuvo-link: a moved bot's own key for ${integration} didn't come with it (${given.status}).`);
  }
  fs.rmSync(path.join(bundleOf(record.id), "opened"), { recursive: true, force: true });
  return idsOf(contents.exports);
}

/** Switched to: the copy here goes on from now, as it was where it came from. */
async function switchHere(record: MoveRecord): Promise<void> {
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "activate");
  } else {
    unhold(folderOf(record.kind, record.thing) ?? undefined, record.wasPaused, record.pausedAs);
    forgetMovedAway(record.sessions);
    if (record.kind === "bot") await settleBot(record.thing, readEngineFile, () => { try { return readBridgeFile(); } catch { return null; } }).catch(() => {});
  }
}

/** A copy here that won't be switched to: gone, as if it never came. */
async function drop(id: string): Promise<void> {
  const record = readMove(id);
  if (!record || record.role !== "to") return;
  noteEnded(id, "dropped");
  incoming.delete(id);
  if (record.kind === "group") {
    await groupAction(readBridgeFile(), record.thing, "release").catch(() => {});
  } else {
    let engine: Target | null = null;
    try { engine = readEngineFile(); } catch {}
    for (const session of [...record.sessions].reverse()) if (engine) await deleteSession(engine, session).catch(() => {});
    const place = folderOf(record.kind, record.thing);
    // Only a copy this move placed, never one that lives here.
    if (place && record.placed) {
      if (record.kind === "bot") await answerBotKeys("DELETE", `kuvo/bots/${record.thing}/keys`, null, null).catch(() => {});
      await toTrash(place).catch(() => {});
    }
  }
  forgetMove(id);
}

// ---- Mail between them ----

/** A move's mail from another box (`{"move": {op, id, …}}`). */
export async function takeMoveMail(sender: MailSender, given: unknown): Promise<void> {
  if (!isObject(given) || typeof given.op !== "string" || typeof given.id !== "string" || !/^mov_[A-Za-z0-9]{1,40}$/.test(given.id)) return;
  // Parts and their answers come many at once, and need no turn of their own.
  if (given.op === "part" || given.op === "got") return moveMail(sender, given, given.id);
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
      if (mine?.role === "to" && mine.complete && mine.sessions.length + (mine.kind === "group" ? 1 : 0) > 0) {
        await switchHere(mine);
        noteEnded(id, "switched");
        forgetMove(id);
        return void tell(sender.key, { op: "switched", id });
      }
      if (mine?.role === "to") await drop(id);
      return void tell(sender.key, { op: endedAs(id) === "switched" ? "switched" : "dropped", id });
    }
    case "drop":
      if (record && !mine) return;
      // A copy switched to already can't be let go: the box it came from goes on to finish.
      if (endedAs(id) === "switched") return void tell(sender.key, { op: "switched", id });
      if (mine?.role === "to") await drop(id);
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
      state.got.add(given.i as number);
      state.flying.delete(given.i as number);
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
      if (mine?.role !== "from" || mine.stage !== "copying" || mine.failed) return;
      return arrived(mine).catch(error => takeBack(id, String((error as Error | null)?.message ?? error), 409));
    case "refused":
    case "failed":
      if (mine?.role !== "from" || mine.stage !== "copying" || mine.failed) return;
      return takeBack(id, typeof given.message === "string" ? given.message : "It couldn’t go there.", 409);
    case "switched":
      if (mine?.role !== "from" || (mine.stage !== "switching" && mine.stage !== "finishing")) return;
      return finish(id).catch(() => {});
    case "dropped":
      if (mine?.role === "from" && mine.step === "drop") return void forgetMove(id);
      // Its copy there is gone before it was switched to: the original here goes on, as it was.
      if (mine?.role === "from" && mine.stage === "switching") return restore(mine, `${mine.name} couldn’t be set up there, so it stayed here. Try again.`);
      return;
  }
}

// ---- Keeping them going ----

// Each move's next step, once in a while: a step unanswered sent again; a first offer with no answer
// taken back (the other computer isn't there); one whose other computer was removed, ended.
export function keepMoving(now = Date.now()): void {
  const peers = new Set(peersOf(readLink()).map(peer => peer.key));
  let names: string[] = [];
  try { names = fs.readdirSync(MOVES).filter(name => name.endsWith(".outcome.json")); } catch {}
  for (const name of names) try { if (now - fs.statSync(path.join(MOVES, name)).mtimeMs > OUTCOME_KEPT) fs.rmSync(path.join(MOVES, name), { force: true }); } catch {}
  for (const record of readMoves()) {
    if (!peers.has(record.peer)) {
      inTurn(record.id, () => endWithout(record)).catch(() => {});
      continue;
    }
    if (record.role === "to") {
      if (now - record.started > HELD_AT_MOST) inTurn(record.id, () => drop(record.id)).catch(() => {});
      continue;
    }
    // One asked for through another process: moved from here.
    if (record.stage === "holding" && !record.step) {
      drive(record.id);
      continue;
    }
    const due = now - (record.sentAt ?? 0) > STEP_AGAIN;
    switch (record.step) {
      case "offer":
        if (record.tries === 0 && now - (record.sentAt ?? 0) > NO_ANSWER && !outgoing.get(record.id)?.got.size) {
          inTurn(record.id, () => takeBack(record.id, say.notConnected(nameOf(record.peer)), 503)).catch(() => {});
        } else if (due) {
          changeMove(record.id, each => { each.sentAt = now; });
          offer(record);
        }
        break;
      case "parts":
        if (outgoing.has(record.id)) sendParts(record, now);
        else inTurn(record.id, () => takeBack(record.id, `${record.name} didn’t get there. Try again.`, 409)).catch(() => {});
        break;
      case "arrive":
        // Its copy's set up there for a while at most; past that, it's taken back.
        if (now - (record.sentAt ?? 0) > 10 * STEP_AGAIN) inTurn(record.id, () => takeBack(record.id, `${record.name} couldn’t be set up there. Try again.`, 409)).catch(() => {});
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

/** A move whose other computer you removed: what's here goes back as it was (a copy that came, or
 * an original not switched from), or, switched already, the original goes. */
async function endWithout(record: MoveRecord): Promise<void> {
  if (record.role === "to") return drop(record.id);
  if (record.stage === "switching" || record.stage === "finishing") return finish(record.id);
  unhold(record.folder, record.wasPaused, record.pausedAs);
  if (record.kind === "group") await groupAction(readBridgeFile(), record.thing, "activate").catch(() => {});
  forgetMove(record.id);
  ended(record.id, { ok: false, status: 409, message: say.notConnected(nameOf(record.peer)) });
}

/** As the box starts: moves cut short carry on (one switched, forward; one not yet, taken back), and
 * a `moving` hold nothing here moves (one a released Mac's move left as it updated) is lifted. */
export async function resumeMoves(now = Date.now()): Promise<void> {
  for (const record of readMoves()) {
    if (record.role !== "from") continue;
    if (record.stage === "finishing") await finish(record.id).catch(() => {});
    // (One asked for just now, through another process, is moved from here.)
    else if (record.stage === "holding" && !record.step && now - record.started < 30_000) continue;
    else if (record.stage !== "switching") await takeBack(record.id, `${record.name} didn’t get there. Try again.`, 409).catch(() => {});
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
  movesChanged();
}

/** Moves go by the relay connection `host` gives (the one that's up), and carry on from where they
 * were as the box starts; each step not answered is sent again. */
export function watchMoves(host: () => Pick<LinkHost, "send"> | null | undefined, signal?: AbortSignal): void {
  hostOf = host;
  watching = true;
  resumeMoves().catch(() => {});
  const timer = setInterval(() => keepMoving(), 3_000);
  signal?.addEventListener("abort", () => {
    clearInterval(timer);
    watching = false;
  }, { once: true });
}
