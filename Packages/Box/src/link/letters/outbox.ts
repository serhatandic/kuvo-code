// The outbox: letters this box's agents leave for agents elsewhere
// Each goes by mail to the box its agent is on, again each minute until that box says it has it
// (or why not), for two days; a note, the box's own word, for 30; without the relay, it waits for it.
// A waiting tool reads its answer from `run/replies/<id>.json`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName, prefixBytes } from "../../shared/text";
import { asked, peerPlaces, peerTargets, readEngineFile } from "../engine/client";
import { sendInto } from "../engine/queue";
import { messageID } from "../engine/sessions";
import { listOf, writePrivate } from "../files";
import { HERE, IS_MAC, RUN } from "../home";
import { frozen } from "../moves/records";
import { announce, toldPeers } from "../peers/agents";
import { isPutAway, peerOf, readPeerAgents } from "../peers/directory";
import { KEY, mailFor, movedOf, ownKey, ownListed, peersOf, removedBoxes } from "../peers/known";
import { bridgeAsk, giveUpSeat, ONLINE_STEP, SEAT_LETTER_LIFE, seatAge, seatRounds, sendSeatLetter } from "../peers/seats";
import { readLink } from "../state";
import { excerpt, READ_BY_MAIL, readConversation } from "./conversation";
import { composeLetter, cutText, LETTER_ID, LETTER_LIFE, LETTER_MEMORY, letterTries, NOTE_MEMORY, OUTBOX, pausedNote, placeOfSession, SENDING } from "./letter";
import { deliverNote, noteOf } from "./note";
import { answerTo } from "./take";
import { forgetOldHomes, homesOf, learnHomes, noteHomes } from "../work/homes";
import { resumeStarts } from "./start-call";
import type { Target } from "../../shared/records";
import type { PutAwayable } from "../peers/directory";
import type { Peer } from "../peers/known";
import type { LetterNote } from "./note";
import type { BridgeAsk, SeatLetter } from "../peers/seats";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { OutboxCall } from "./calls";
import { answerResumed, boxName, callLife, callRefused, sendCall } from "./calls";

/** A letter as it goes by mail (`{"letter": …}`): its id, from and for which conversations, its
 * words, whether its sender waits for the answer, when it was left (ms), and the letter it answers. */
export interface MailedLetter {
  id: string;
  from?: string | null;
  to: string;
  text: string;
  wait: boolean;
  at: number;
  answers?: string;
  read?: LetterRead;
  /** The box's own word, not an agent's: delivered as that box would have (`LetterNote`). */
  note?: LetterNote;
  /** A note: when it was first left (`at` is when this mail of it was sealed). */
  made?: number;
  /** A call's answer that says it couldn't do what was asked (its tool's `isError`). */
  refused?: boolean;
}

/** A letter that asks for a conversation instead of saying something (read_conversation from another
 * computer): its answer is the conversation, or the parts that mention `query`. Only to a box whose
 * agents' mail says it takes them (`letters-read`). */
export interface LetterRead {
  query?: string;
}

/** An answer as it comes (a letter with `answers`): the letter it answers, its words, and the
 * conversation it's from (the one that was asked). */
export type AnswerLetter = Pick<MailedLetter, "text" | "note" | "refused"> & { answers: string; from: string };

/** How a letter went, as the box it went to says (`{"delivered": …}`): there (`ok`), or why not;
 * with `retry`, not now, so it's sent again; with `answer: false`, there, but no answer will come;
 * with `lives`, a note's conversation lives on that box now, so that's where it goes. */
export interface Delivered {
  id: string;
  ok: boolean;
  why?: string;
  retry?: boolean;
  answer?: boolean;
  lives?: string;
}

/** A letter in the outbox (`run/outbox/sending/<id>.json`, as a tool's call or this box left it):
 * from and for which conversations, its sender's name, its words (or what it asks to read), whether
 * a tool waits for its answer, when it was left (ms), and the letter it answers; the box it's for
 * (`peer`), and the one it was last sent to (`sentTo`). */
export interface OutboxLetter {
  from?: string | null;
  name?: string;
  to: string;
  text: string;
  wait?: boolean;
  at?: number;
  answers?: string;
  peer?: string;
  sentTo?: string;
  read?: LetterRead;
  note?: LetterNote;
  refused?: boolean;
}

/** What waits in `outbox/sending/<id>.json`, as the outbox reads it: a letter; with `seat`, a
 * group chat's mail that mustn't be lost (a `SeatLetter`, which has no words of its own); or with
 * `call`, a lead's tool for another box (`OutboxCall`). */
type InSending = OutboxLetter & Partial<SeatLetter> & Partial<Omit<OutboxCall, "to" | "from" | "at">>;

/** An answer for a tool waiting for it: its words, and for one delivered later as a message, the
 * conversation it's for, and whom it's from (their conversation, or "unknown", and name). */
export interface AnswerReply {
  text: string;
  /** A call's answer that says it couldn't. */
  isError?: boolean;
  to?: string | null;
  from?: string;
  name?: string;
  /** A conversation read: only for the tool waiting, never a message. */
  read?: boolean;
}

/** What a tool waiting for a letter's answer reads (`run/replies/<id>.json`, or on this Mac, its
 * conversation's `macWaiting`): the answer, or why none will come (`failed`, `note`). */
export type LetterReply = AnswerReply | { failed: string } | { note: string };

/** One of this Mac's conversations waiting for a letter's answer (`macWaiting`): the box it went to
 * (null until it's there), whether it still waits, and how it's given its answer. */
export interface MacWaiter {
  sentTo: string | null;
  gone: () => boolean;
  done: (value: LetterReply) => void;
  /** How much of its answer it takes (a conversation read is longer than an answer). */
  most?: number;
}

// Senders being told of to their letters' boxes first (one made a moment ago, which those boxes
// don't know yet): its letter goes once that's done (or couldn't be), or a minute on, whatever
// rounds come meanwhile.
const introducing = new Map<string, { at: number; done: boolean }>();
const INTRODUCING_FOR = 60_000;

// Notes sent for each conversation on each box that aren't there yet, since when and the last: past
// QUIET_AFTER that box may be away, or the conversation put away, for days, with days of them kept
// for it, so only the oldest goes each minute until one's there.
const notesWaiting = new Map<string, { since: number; last: number }>();
const QUIET_AFTER = 120_000;

export const REPLIES = path.join(RUN, "replies");

export const LETTER_BYTES = 24_000;
// How much of an answer comes back to the agent waiting for it.
export const ANSWER_TEXT = 8000;

// This Mac's conversations waiting for a letter's answer, by the letter (an agent's tool's call):
// answered here, in memory, as the box takes the answer itself; once it's there, which box it went
// to (only that one's answer counts).
export const macWaiting = new Map<string, MacWaiter>();

function reply(id: string, value: LetterReply): void {
  // On this Mac: to the conversation waiting, if it still is.
  if (IS_MAC) return void macWaiting.get(id)?.done(value);
  try {
    fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
    writePrivate(path.join(REPLIES, `${id}.json`), JSON.stringify(value));
  } catch {}
}

/** A letter whose tool stopped waiting: it goes on without waiting (its answer comes as a message),
 * or, one that only asked to read a conversation, not at all. */
export function givenUp(id: string): void {
  const file = path.join(SENDING, `${id}.json`);
  try {
    const letter = JSON.parse(fs.readFileSync(file, "utf8"));
    // (A list another computer was asked for is only for the tool that asked.)
    if (isObject(letter?.read) || letter?.call?.tool === "list_sessions") fs.rmSync(file, { force: true });
    else writePrivate(file, JSON.stringify({ ...letter, wait: false }));
  } catch {}
}

// A letter for the outbox, from this box (an answer, say); false if it couldn't be left.
function leaveLetter(letter: OutboxLetter, now = Date.now(), id = "ltr_" + crypto.randomBytes(16).toString("base64url")): boolean {
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ ...letter, wait: false, at: now }));
    outboxSoon.send();
    return true;
  } catch {
    return false;
  }
}
export const leaveAnswer = (letter: OutboxLetter): void => void leaveLetter(letter);
/** A letter from this box with the id it's given (a call's answer, whose id comes from the call's:
 * left again, it's the same letter). */
export const leaveLetterAs = (id: string, letter: OutboxLetter, now = Date.now()): boolean => leaveLetter(letter, now, id);

/** How the outbox is sent at once, where this process sends it (this Mac's box, a machine's link):
 * an answer goes now, not at the next round. */
export const outboxSoon: { send: () => void } = { send: () => {} };

/** What this box has to tell one of its conversations that lives on another computer now, however
 * long ago it left (`homesOf`): a letter to it there, which the outbox sends as a note, with `note`
 * saying how it would have been delivered here, so the box it goes to delivers it the same way.
 * False when it has no home elsewhere, or the letter couldn't be left. */
export function tellMovedAway(session: string, text: string, note: LetterNote, now = Date.now()): boolean {
  const link = readLink();
  const key = homesOf(link).get(session);
  return Boolean(key) && key !== ownKey(link ?? {}) && leaveLetter({ from: null, to: session, text, peer: key, note }, now);
}

// How a letter went, from the box it went to (anyone else's word is dropped): there, so it's not
// sent again, and with `wait`, its answer awaited (`replies/<id>.wait`, whose box it's from), or
// none to wait for; not now, so it's sent again; or why not, for a waiting tool.
export function letterWent(sender: Pick<Peer, "key">, { id, ok, why, retry, answer, lives }: Delivered, now = Date.now()): void {
  if (!LETTER_ID.test(id)) return;
  const file = path.join(SENDING, `${id}.json`);
  let letter: InSending | null = null;
  try { letter = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (letter?.sentTo !== sender.key) return;
  const note = noteOf(letter.note);
  if (note && (ok || retry !== true || lives)) notesWaiting.delete(`${sender.key} ${letter.to}`);
  // A note's conversation lives elsewhere now, as the box it went to says: it goes there.
  if (!ok && retry === true && note && typeof lives === "string" && KEY.test(lives)) {
    noteHomes([letter.to], lives, now);
    try { writePrivate(file, JSON.stringify({ ...letter, peer: lives })); } catch {}
  }
  // Not now: sent again. A group chat's waits as long as it takes (the outbox counts its time online).
  const call = isObject(letter.call) ? letter as OutboxCall : null;
  if (!ok && retry === true && (isObject(letter.seat) || now - (letter.at ?? 0) < (call ? callLife(call.call) : note ? NOTE_MEMORY : LETTER_MEMORY))) return;
  // A group chat's that can't be delivered is given up, and the bridge told, never just dropped.
  if (!ok && isObject(letter.seat)) return void giveUpSeat(id, letter as SeatLetter);
  letterTries.delete(id);
  const words = typeof why === "string" ? why.slice(0, 500) : null;
  // A call kept for a box that was away, refused there for good: its lead hears why.
  if (!ok && call) callRefused(call, words ?? "It couldn't be done there.", sender);
  if (ok && letter.wait === true && answer !== false) {
    // On this Mac: the conversation waiting is told by whom its answer comes.
    const waiter = IS_MAC ? macWaiting.get(id) : null;
    if (waiter) {
      waiter.sentTo = sender.key;
      fs.rmSync(file, { force: true });
      return;
    }
    if (!IS_MAC) try {
      fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(REPLIES, `${id}.wait`));
      return;
    } catch {}
  }
  // Not there, for good: its sender hears why, in that box's words (one that ran out of time, in ours).
  if (!ok) return failLetter(id, file, letter, retry === true ? { why: EXPIRED, on: sender.key }
    : { why: words || "It wasn't accepted there.", on: sender.key, said: Boolean(words) }, now);
  fs.rmSync(file, { force: true });
  // Only a tool waiting for its answer reads how it went.
  if (letter.wait !== true) return;
  if (answer === false) reply(id, { note: words ?? "It got your message, but its answer can't come back to you here." });
}

/** Why a letter won't be delivered (`failLetter`): in words (none when that wasn't kept), the box its
 * agent is on (`on`, its key), whether those words are that box's own (`said`), and what its
 * conversation's called there. */
interface Failure {
  why?: string;
  on?: string;
  said?: boolean;
  title?: string;
}

// Why one tried for its two days won't be delivered (not the last word from where it went, which was
// "not now").
const EXPIRED = "It couldn't get there in two days of trying.";

// The notice for letter `id` that won't be delivered: an id of its own (so no word on the letter acts
// on it), the same each time it's made (a box it goes to takes it once).
const noticeID = (id: string): string => "ltr_" + crypto.createHash("sha256").update(`${id} not delivered`).digest("base64url").slice(0, 22);

// Notices left this round: the outbox goes again once it's over, not inside it.
let noticesLeft = false;
function sendNoticesSoon(): void {
  if (noticesLeft) return;
  noticesLeft = true;
  setImmediate(() => {
    noticesLeft = false;
    outboxSoon.send();
  });
}

// Whether a tool still waits for letter `id`'s answer, whatever the letter says: on this Mac, its
// conversation (`macWaiting`, empty once the box started again); on a machine, one that hasn't given
// up and noted it waits in the last ten seconds (`<id>.alive`), as `answered` reads it.
function toolWaits(id: string, now = Date.now()): boolean {
  if (IS_MAC) {
    const waiter = macWaiting.get(id);
    return Boolean(waiter && !waiter.gone());
  }
  if (fs.existsSync(path.join(REPLIES, `${id}.gaveup`))) return false;
  let alive = 0;
  try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
  return now - alive <= 10_000;
}

// A letter that won't be delivered: a tool still waiting hears why; one sent without waiting (its tool
// said "On its way", or is gone) is the box's own word to its sender instead, as a call's
// lead hears of its call (`tellLead`), once: queued, marked, by its agent's name and computer. The
// letter's taken out of sending first (`.failed`, which the next round finishes should this be cut
// short), so it never goes again. The box's own words (notes, answers), reads and calls just go.
function failLetter(id: string, file: string, letter: InSending, { why, on, said = false, title }: Failure, now = Date.now()): void {
  letterTries.delete(id);
  if (letter.wait === true && toolWaits(id, now)) {
    reply(id, { failed: why || "It wasn't delivered." });
    fs.rmSync(file, { force: true });
    return;
  }
  if (!letter.from || noteOf(letter.note) || letter.answers || letter.read || isObject(letter.call)) {
    fs.rmSync(file, { force: true });
    return;
  }
  const failed = path.join(SENDING, `${id}.failed`);
  try {
    if (file !== failed) fs.renameSync(file, failed);
    const link = readLink();
    const mine = ownKey(link ?? {});
    const peer = peersOf(link).find(each => each.key === on);
    const told = readPeerAgents();
    const nameIn = (key: string) => { const list = told[key]?.list; return Array.isArray(list) ? list.find(each => each?.session === letter.to)?.name : undefined; };
    const listed = [...(on ? [on] : []), ...Object.keys(told)].map(nameIn).find(name => typeof name === "string");
    const name = plainName(title ?? listed ?? ownListed().find(each => each.session === letter.to)?.name ?? "") || "that chat";
    const computer = on && on === mine ? HERE : peer ? boxName(peer) : "another computer";
    const line = `Your message to ${name} on ${computer} wasn't delivered`;
    const text = `[Not delivered] ${line}${!why ? "." : said ? `: ${computer} said "${why}"` : `. ${why}`}`;
    writePrivate(path.join(SENDING, `${noticeID(id)}.json`), JSON.stringify({ to: letter.from, text, ...(mine ? { peer: mine } : {}), wait: false, at: now,
      note: { from: "Your other computers", words: text, line, delivery: "queue" } } satisfies OutboxLetter));
    fs.rmSync(failed, { force: true });
    sendNoticesSoon();
  } catch {}
}

// Letters being delivered here (`deliverHere`), so the next round doesn't too.
const deliveringHere = new Set<string>();

// A letter for a conversation that moved to this box since it was left: delivered here as a tool's
// here is, by its sender's name, and with `wait`, its answer to the tool (or why none comes), or once
// that stopped waiting, to its conversation as a message. One moving on again, or that can't be
// reached now (the coding agents' bridge starting), is tried again the next minute.
async function deliverHere(id: string, file: string, letter: OutboxLetter, step: number): Promise<void> {
  if (deliveringHere.has(id) || frozen().has(letter.to)) return;
  deliveringHere.add(id);
  try {
    const place = await placeOfSession(letter.to, peerTargets()).catch(() => undefined);
    if (place === undefined || (place === null && !peerPlaces().bridge)) return;
    const own = ownListed();
    const nameOf = (session: string | null | undefined) => own.find(agent => agent.session === session)?.name ?? undefined;
    const done = (value?: LetterReply) => {
      fs.rmSync(file, { force: true });
      letterTries.delete(id);
      if (value && letter.wait === true) reply(id, value);
    };
    // (Here, in this box's words.)
    const fail = (why: string, title?: string) => failLetter(id, file, letter, { why, on: ownKey(readLink() ?? {}) ?? undefined, title });
    if (!place) return fail("There's no such conversation here.");
    const kuvo = place.data?.metadata?.kuvo ?? {};
    // The box's word for one put away here waits until it's brought back, as it does anywhere.
    if (noteOf(letter.note) && isPutAway(place.data as PutAwayable) && !place.data?.parentID && !kuvo.seat) return;
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data as PutAwayable)) return fail("That conversation doesn't take messages.", place.data?.title);
    const name = nameOf(letter.to) ?? (place.data?.title || "New session");
    if (isObject(letter.read)) {
      const query = typeof letter.read.query === "string" && letter.read.query.trim() ? letter.read.query.trim() : null;
      return done({ text: excerpt(await readConversation(place.target, letter.to, place.data ?? {}, name), query, READ_BY_MAIL), read: true });
    }
    // The box's own word (`tellMovedAway`): as it would have gone here, never awaited.
    const note = noteOf(letter.note);
    if (note) {
      await deliverNote(place.target, letter.to, messageID(), cutText(letter.text), note);
      return done();
    }
    const sender = nameOf(letter.from) ?? (IS_MAC ? "another agent" : `an agent on ${HERE}`);
    const by = letter.from ?? "unknown";
    const words = cutText(letter.text);
    const prompt = messageID();
    const went = await sendInto(place.target, letter.to, { id: prompt, text: composeLetter(sender, by, words, letter.wait === true), delivery: "steer" },
      { from: sender, words, kept: composeLetter(sender, by, words, false) });
    // Stopped by the user here: it waits for them, and its answer comes as a message.
    if (went === "waits") return done({ note: pausedNote(name) });
    done();
    if (letter.wait !== true) return;
    const text = await answerTo(place.target, letter.to, prompt, { wait: step, by: letter.from ?? null });
    if (!text) return;
    const said = cutText(text, ANSWER_TEXT);
    const waiter = IS_MAC ? macWaiting.get(id) : null;
    let alive = 0;
    try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
    if (IS_MAC ? waiter && !waiter.gone() : Date.now() - alive <= 10_000) return reply(id, { text: said, to: letter.from, from: letter.to, name });
    // Its tool stopped waiting: to the conversation that asked, as a message, left as answers its
    // tool never took are (`deliverLeftAnswers`): tried again until it goes, not while that
    // conversation moves, and to it on the computer it moved to.
    if (!letter.from) return;
    fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
    writePrivate(path.join(REPLIES, `${id}.json`), JSON.stringify({ text: said, to: letter.from, from: letter.to, name } satisfies AnswerReply));
  } catch {
    // Tried again the next minute.
  } finally {
    deliveringHere.delete(id);
  }
}

// The answer (`letter`) to letter `answers`, from the box it went to, for the tool waiting for it
// here: true when one still waits (it notes it does, `<id>.alive`, every two seconds as it looks);
// else it comes as a message. One the tool doesn't take after all (it stopped as it came) comes as
// a message too (`deliverLeftAnswers`): it's kept with who it's from and for.
export function answered(sender: { key: string; name?: string }, { answers: id, text, from, note, refused }: AnswerLetter, now = Date.now()): boolean {
  // Its answer says it was delivered, should that word have been lost on the way.
  if (LETTER_ID.test(id) && fs.existsSync(path.join(SENDING, `${id}.json`))) letterWent(sender, { id, ok: true });
  // A call's answer: in its own words (its letter's are for its lead, should no tool wait), and
  // whether it couldn't.
  const words = noteOf(note)?.words;
  const isError = refused === true ? { isError: true } : {};
  // On this Mac: the request still waiting for it, if it's still there.
  if (IS_MAC) {
    const waiter = macWaiting.get(id);
    if (!waiter || waiter.sentTo !== sender.key || waiter.gone()) return false;
    waiter.done({ text: cutText(words ?? text, waiter.most ?? ANSWER_TEXT), ...isError });
    return true;
  }
  const waiting = path.join(REPLIES, `${id}.wait`);
  let letter: InSending | null = null;
  try { letter = JSON.parse(fs.readFileSync(waiting, "utf8")); } catch { return false; }
  if (letter?.sentTo !== sender.key) return false;
  fs.rmSync(waiting, { force: true });
  let alive = 0;
  try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
  if (now - alive > 10_000) return false;
  // Its sender as that box named it, when that box alone lists it.
  const told = readPeerAgents();
  const agent = peerOf(from, peersOf(readLink()), told)?.key === sender.key ? (told[sender.key]?.list ?? []).find(each => each.session === from) : null;
  // A conversation read, or what another computer has of the caller's sessions: for the tool alone.
  if (letter.read || letter.call?.tool === "list_sessions") {
    reply(id, { text: cutText(words ?? text, READ_BY_MAIL), read: true, ...isError });
    return true;
  }
  // A call's answer: to the tool, or, should it not take it after all, to its lead as a message.
  if (isObject(letter.call)) {
    reply(id, { text: cutText(words ?? text, READ_BY_MAIL), to: letter.from, from: "unknown", name: plainName(sender.name) || "another computer", ...isError });
    return true;
  }
  // For the conversation that asked (as this box's letter has it, not as the answer says).
  reply(id, { text: cutText(text, ANSWER_TEXT), to: letter.from, from: agent ? from : "unknown", name: agent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}` });
  return true;
}

// Answers a tool here was given but never took (its turn stopped as one came): to the conversation
// that asked, as a message, once the tool's gone (it left `<id>.gaveup`, or stopped noting it
// waits), if it still takes letters (not a subagent's, a group chat's seat, nor one put away); not
// while it moves to or from another computer, and to it there once it's moved away. Each
// once at most: taken out of the tool's way first, put back to try again if it can't go now (or, a
// day at most, while the coding agents' bridge whose conversation it may be isn't running); one
// cut off as it's delivered (this bridge stopped) stays `.delivering`, and is dropped.
export async function deliverLeftAnswers(now = Date.now(), targets: Target[] = peerTargets(), bridgeRuns = peerPlaces().bridge): Promise<void> {
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const file = path.join(REPLIES, name);
    let answer: Partial<AnswerReply> | null;
    try { answer = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    let alive = 0;
    try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
    if (!fs.existsSync(path.join(REPLIES, `${id}.gaveup`)) && now - alive <= 10_000) continue;
    // A conversation read that came as its tool went: it just goes.
    if (answer?.read === true) {
      fs.rmSync(file, { force: true });
      fs.rmSync(path.join(REPLIES, `${id}.gaveup`), { force: true });
      continue;
    }
    if (typeof answer?.text !== "string" || typeof answer.to !== "string") continue;
    // Moving to or from another computer: it waits until it's there.
    if (frozen().has(answer.to)) continue;
    const taken = `${file}.delivering`;
    try { fs.renameSync(file, taken); } catch { continue; }
    try {
      const name = String(answer.name ?? "another agent");
      const text = composeLetter(name, String(answer.from ?? "unknown"), answer.text, false);
      const place = await placeOfSession(answer.to, targets);
      // Moved to another computer since: to it there, as a letter.
      const there = place === null && tellMovedAway(answer.to, text, { from: name, words: answer.text, delivery: "steer" });
      if (place === null && !there && !bridgeRuns && now - fs.statSync(taken).mtimeMs <= LETTER_LIFE) throw new Error("Its coding agents aren't running here now.");
      const kuvo = place?.data?.metadata?.kuvo ?? {};
      if (place && !place.data?.parentID && !kuvo.seat && !isPutAway(place.data as PutAwayable)) {
        await sendInto(place.target, answer.to, { id: messageID(), text, delivery: "steer" }, { from: name, words: answer.text });
      }
      fs.rmSync(taken, { force: true });
      fs.rmSync(path.join(REPLIES, `${id}.gaveup`), { force: true });
    } catch {
      try { fs.renameSync(taken, file); } catch {}
    }
  }
}

// A letter as mail for `peer`, its words cut to fit what the relay takes (UTF-8, and escaped as
// JSON, they can be several times as many bytes as characters); null if even a short one won't.
export function letterMail(peer: Pick<Peer, "key" | "address">, letter: MailedLetter, link: LinkState, now = Date.now()): Buffer | null {
  const words = String(letter.text ?? "");
  const { note } = letter;
  for (const most of [LETTER_BYTES, LETTER_BYTES / 4, 2000]) {
    // (A note's words and line too: each is at most what its text is, so it all fits.)
    const cut = note ? { note: { ...note, words: prefixBytes(note.words, most), ...(note.line !== undefined ? { line: prefixBytes(note.line, most) } : {}) } } : {};
    const bytes = mailFor(peer, { letter: { ...letter, text: prefixBytes(words, most), ...cut }, at: now }, link);
    if (bytes) return bytes;
  }
  return null;
}

// The outbox, sent: each letter left in `outbox/sending` goes to the box its agent is on (an
// answer, to the box it answers), again each minute until that box says it has it (or why not),
// for two days; without the relay (`offline`), they wait for it. A tool that gave up waiting
// (`replies/<id>.gaveup`) has its letter go on without waiting, and an answer that comes later
// reaches its conversation as a message. A group chat's letters given up are told to the coding
// agents' bridge (`ask`); the tellings are what it returns.
export function sendOutbox(host: Pick<LinkHost, "send">, link: LinkState | null = readLink(), now = Date.now(), offline = 0, ask: BridgeAsk = bridgeAsk, step = 2000): Promise<void[]> {
  const telling: Promise<void>[] = [];
  if (!link?.key) return Promise.all(telling);
  const peers = peersOf(link);
  const told = readPeerAgents();
  const moved = movedOf(link);
  learnHomes(link, now);
  telling.push(forgetOldHomes(now).catch(() => {}));
  // Starts from your other computers cut short as this box went down: finished, and their leads told.
  telling.push(resumeStarts(answerResumed, now).catch(() => {}));
  const homes = homesOf(link);
  const removed = removedBoxes(link);
  // COMPAT(beta.1 outbox): letters an older Kuvo Code left in `run/outbox` for a Mac to collect over SSH (its tools', and those its link handed over without the relay), taken on here. Goes 3 months after 0.8.0.
  // No Mac collects them any more: they go as this link's own. (Not one a Mac took to deliver,
  // `.mac-…`: each goes one way, by whichever renames it first.)
  for (const name of listOf(OUTBOX)) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    try {
      fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(OUTBOX, name), path.join(SENDING, name));
    } catch {}
  }
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".gaveup")) continue;
    const id = name.slice(0, -7);
    fs.rmSync(path.join(REPLIES, name), { force: true });
    fs.rmSync(path.join(REPLIES, `${id}.wait`), { force: true });
    givenUp(id);
  }
  // Letters that won't be delivered whose senders' notices were cut short (`failLetter`): finished
  // (without why, which wasn't kept), never sent. (Only a sender no tool waited for has one.)
  for (const name of listOf(SENDING)) {
    if (!name.endsWith(".failed")) continue;
    const file = path.join(SENDING, name), id = name.slice(0, -7);
    try {
      const letter: InSending = JSON.parse(fs.readFileSync(file, "utf8"));
      failLetter(id, file, { ...letter, wait: false }, { on: letter.sentTo ?? letter.peer }, now);
    } catch {}
  }
  const listed = new Set<string>();
  // The boxes not answering that a call went to this round: one each, the oldest.
  const awaySent = new Set<string>();
  const mine = ownKey(link);
  const ownHere = new Set(ownListed().map(agent => agent.session));
  // Oldest first, as they were left.
  const waiting: { name: string; letter: InSending | null }[] = [];
  for (const name of listOf(SENDING)) {
    // (A call's mark that the relay dropped it, left by a tool that's gone: `relay/dropped.ts`.)
    if (name.endsWith(".dropped") && !fs.existsSync(path.join(SENDING, `${name.slice(0, -8)}.json`))) fs.rmSync(path.join(SENDING, name), { force: true });
    if (!name.endsWith(".json")) continue;
    try { waiting.push({ name, letter: JSON.parse(fs.readFileSync(path.join(SENDING, name), "utf8")) }); } catch {}
  }
  waiting.sort((a, b) => (typeof a.letter?.at === "number" ? a.letter.at : now) - (typeof b.letter?.at === "number" ? b.letter.at : now));
  for (const { name, letter: kept } of waiting) {
    const id = name.slice(0, -5);
    const file = path.join(SENDING, name);
    let letter = kept;
    if (!isObject(letter)) continue;
    listed.add(id);
    const made = typeof letter.at === "number" ? letter.at : now;
    // A lead's tool for another box: to that box only, as long as its kind is kept (`sendCall`).
    if (isObject(letter.call)) {
      const told = sendCall(host, id, file, letter as unknown as OutboxCall, { link, now, offline: Boolean(offline), peers, away: awaySent });
      if (told) telling.push(told);
      continue;
    }
    // A group chat's mail that mustn't be lost: to its computer only (never through a Mac), each
    // minute until it says it has it, for two days of this link online (SEAT_LETTER_LIFE).
    if (isObject(letter.seat)) {
      const last = seatRounds.get(id);
      seatRounds.set(id, now);
      if (!offline && last !== undefined && now > last) {
        const before = seatAge(letter);
        letter = { ...letter, aged: before + Math.min(now - last, ONLINE_STEP) };
        // Kept a minute at a time: a restart loses no more.
        if (Math.floor(letter.aged! / 60_000) !== Math.floor(before / 60_000)) try { writePrivate(file, JSON.stringify(letter)); } catch {}
      }
      if (letter.gaveUp === true || seatAge(letter) > SEAT_LETTER_LIFE) {
        const told = giveUpSeat(id, letter as SeatLetter, ask);
        if (told) telling.push(told);
        continue;
      }
      const to = peers.find(each => each.key === letter!.peer);
      if (!to || offline || now - (letterTries.get(id) ?? 0) < 60_000) continue;
      letterTries.set(id, now);
      const told = sendSeatLetter(host, to, id, letter as SeatLetter, link, now, ask);
      if (told) telling.push(told);
      continue;
    }
    // Where its agent lives now: a conversation moved goes where it went, whoever it was left for. A
    // note goes by what's known of its home, however old (one listed here is found here first).
    const note = noteOf(letter.note);
    const lives = (note && !ownHere.has(letter.to) ? homes.get(letter.to) : undefined) ?? moved.get(letter.to) ?? (note && letter.peer === mine ? mine! : undefined);
    const peer = lives ? peers.find(each => each.key === lives) ?? null
      : typeof letter.peer === "string" ? peers.find(each => each.key === letter.peer) ?? null : peerOf(letter.to, peers, told, moved);
    // (Not one being delivered here now: that ends it.)
    if (!deliveringHere.has(id) && now - made > (note ? NOTE_MEMORY : LETTER_MEMORY)) {
      failLetter(id, file, letter, { why: EXPIRED, on: lives ?? (ownHere.has(letter.to) ? mine ?? undefined : peer?.key ?? letter.sentTo) }, now);
      continue;
    }
    // Moved here since it was left (as the box it went from says, or as this box lists it now): here,
    // relay or not.
    if (lives === mine || (!lives && ownHere.has(letter.to))) {
      if (now - (letterTries.get(id) ?? 0) < 60_000) continue;
      letterTries.set(id, now);
      telling.push(deliverHere(id, file, letter, step));
      continue;
    }
    // Its computer was removed, which is more than being left out of a list for now: no one to tell.
    if (note && !lives && !peer && removed.has(letter.peer as string)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    // No box lists its agent now (lists change as boxes come and go): it waits.
    if (!peer) continue;
    if (offline || now - (letterTries.get(id) ?? 0) < 60_000) continue;
    // Its sender, told of to that box first, so it's taken for one of this box's agents.
    if (letter.from && !toldPeers.get(peer.key)?.sessions?.has(letter.from)) {
      const introduced = introducing.get(id);
      if (!introduced) {
        const introduction = { at: now, done: false };
        introducing.set(id, introduction);
        telling.push(announce(host, readEngineFile, link).catch(() => {}).finally(() => { introduction.done = true; }));
        continue;
      }
      if (!introduced.done && now - introduced.at < INTRODUCING_FOR) continue;
    }
    const waiting = note ? notesWaiting.get(`${peer.key} ${letter.to}`) : undefined;
    if (waiting && now - waiting.since >= QUIET_AFTER && now - waiting.last < 60_000) continue;
    if (note) notesWaiting.set(`${peer.key} ${letter.to}`, { since: waiting?.since ?? now, last: now });
    letterTries.set(id, now);
    // A note is sealed now, however long it's been kept, with when it was made beside that. A replay
    // of an old one fails by its age or its id; an agent's message fails at a day, not arriving late.
    const bytes = letterMail(peer, { id, from: letter.from, to: letter.to, text: cutText(letter.text), wait: letter.wait === true, at: note ? now : made,
      ...(letter.answers ? { answers: letter.answers } : {}), ...(isObject(letter.read) ? { read: typeof letter.read.query === "string" ? { query: letter.read.query } : {} } : {}),
      ...(note ? { note, made } : {}), ...(letter.refused === true ? { refused: true } : {}) }, link, now);
    if (!bytes) {
      failLetter(id, file, letter, { why: "It's too long to send.", on: peer.key }, now);
      continue;
    }
    // Which box it went to: only that one's word on how it went counts.
    if (letter.sentTo !== peer.key) try { writePrivate(file, JSON.stringify({ ...letter, sentTo: peer.key })); } catch {}
    try { host.send(bytes); } catch {}
  }
  for (const id of letterTries.keys()) if (!listed.has(id)) letterTries.delete(id);
  for (const id of seatRounds.keys()) if (!listed.has(id)) seatRounds.delete(id);
  for (const id of introducing.keys()) if (!listed.has(id)) introducing.delete(id);
  // Answers no tool came for (it gave up waiting), and ones never answered, after a day.
  for (const name of listOf(REPLIES)) {
    try {
      if (now - fs.statSync(path.join(REPLIES, name)).mtimeMs > LETTER_LIFE) fs.rmSync(path.join(REPLIES, name), { force: true });
    } catch {}
  }
  return Promise.all(telling);
}