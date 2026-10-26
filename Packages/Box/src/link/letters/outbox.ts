// The outbox: letters this box's agents leave for agents elsewhere
// Each goes by mail to the box its agent is on, again each minute until that box says it has it
// (or why not), for two days. A waiting tool reads its answer from `run/replies/<id>.json`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName, prefixBytes } from "../../shared/text";
import { asked, peerTargets, readEngineFile } from "../engine/client";
import { messageID } from "../engine/sessions";
import { listOf, writePrivate } from "../files";
import { IS_MAC, RUN } from "../home";
import { announce, toldPeers } from "../peers/agents";
import { isPutAway, peerOf, readPeerAgents } from "../peers/directory";
import { mailFor, movedOf, peersOf } from "../peers/known";
import { bridgeAsk, giveUpSeat, ONLINE_STEP, SEAT_LETTER_LIFE, seatAge, seatRounds, sendSeatLetter } from "../peers/seats";
import { readLink } from "../state";
import { composeLetter, cutText, LETTER_ID, LETTER_LIFE, LETTER_MEMORY, letterTries, OUTBOX, placeOfSession, SENDING } from "./letter";
import type { Target } from "../../shared/records";
import type { PutAwayable } from "../peers/directory";
import type { Peer } from "../peers/known";
import type { BridgeAsk, SeatLetter } from "../peers/seats";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";

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
}

/** An answer as it comes (a letter with `answers`): the letter it answers, its words, and the
 * conversation it's from (the one that was asked). */
export type AnswerLetter = Pick<MailedLetter, "text"> & { answers: string; from: string };

/** How a letter went, as the box it went to says (`{"delivered": …}`): there (`ok`), or why not;
 * with `retry`, not now, so it's sent again; with `answer: false`, there, but no answer will come. */
export interface Delivered {
  id: string;
  ok: boolean;
  why?: string;
  retry?: boolean;
  answer?: boolean;
}

/** A letter in the outbox (`run/outbox/sending/<id>.json`, as a tool, this Mac's app or this box
 * left it): from and for which conversations, its sender's name, its words, whether a tool waits for
 * its answer, when it was left (ms), and the letter it answers; the box it's for (`peer`, an
 * answer's), the one it was last sent to (`sentTo`), and that a tool left it for the link (`via`).
 * One handed to the Mac (in `run/outbox`) is marked when (`handed`). */
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
  via?: "link";
  handed?: number;
}

/** What waits in `outbox/sending/<id>.json`, as the outbox reads it: a letter, or with `seat`, a
 * group chat's mail that mustn't be lost (a `SeatLetter`, which has no words of its own). */
type InSending = OutboxLetter & Partial<SeatLetter>;

/** An answer for a tool waiting for it: its words, and for one delivered later as a message, the
 * conversation it's for, and whom it's from (their conversation, or "unknown", and name). */
export interface AnswerReply {
  text: string;
  to?: string | null;
  from?: string;
  name?: string;
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
}

// Senders being told of to their letters' boxes first (one made a moment ago, which those boxes
// don't know yet): its letter goes the round after.
const introducing = new Map<string, number>();

export const REPLIES = path.join(RUN, "replies");

export const LETTER_BYTES = 24_000;

// Without the relay this long, this box's letters go to the Mac instead, which collects them
// over SSH.
export const RELAY_GONE_AFTER = 5 * 60_000;

// This Mac's conversations waiting for a letter's answer, by the letter (`kuvo/link/letters`):
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

// A letter for the outbox, from this box (an answer, say).
function leaveLetter(letter: OutboxLetter, now = Date.now()): void {
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    const id = "ltr_" + crypto.randomBytes(16).toString("base64url");
    writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ ...letter, wait: false, at: now }));
  } catch {}
}
export const leaveAnswer = (letter: OutboxLetter): void => leaveLetter(letter);

// How a letter went, from the box it went to (anyone else's word is dropped): there, so it's not
// sent again, and with `wait`, its answer awaited (`replies/<id>.wait`, whose box it's from), or
// none to wait for; not now, so it's sent again; or why not, for a waiting tool.
export function letterWent(sender: Pick<Peer, "key">, { id, ok, why, retry, answer }: Delivered): void {
  if (!LETTER_ID.test(id)) return;
  const file = path.join(SENDING, `${id}.json`);
  let letter: InSending | null = null;
  try { letter = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (letter?.sentTo !== sender.key) return;
  // Not now: sent again. A group chat's waits as long as it takes (the outbox counts its time online).
  if (!ok && retry === true && (isObject(letter.seat) || Date.now() - (letter.at ?? 0) < LETTER_MEMORY)) return;
  // A group chat's that can't be delivered is given up, and the bridge told, never just dropped.
  if (!ok && isObject(letter.seat)) return void giveUpSeat(id, letter as SeatLetter);
  letterTries.delete(id);
  const words = typeof why === "string" ? why.slice(0, 500) : null;
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
  fs.rmSync(file, { force: true });
  // Only a tool waiting for its answer reads how it went.
  if (letter.wait !== true) return;
  if (!ok) reply(id, { failed: words ?? "It wasn't delivered." });
  else if (answer === false) reply(id, { note: words ?? "It got your message, but its answer can't come back to you here." });
}

// The answer (`letter`) to letter `answers`, from the box it went to, for the tool waiting for it
// here: true when one still waits (it notes it does, `<id>.alive`, every two seconds as it looks);
// else it comes as a message. One the tool doesn't take after all (it stopped as it came) comes as
// a message too (`deliverLeftAnswers`): it's kept with who it's from and for.
export function answered(sender: { key: string; name?: string }, { answers: id, text, from }: AnswerLetter, now = Date.now()): boolean {
  // On this Mac: the request still waiting for it, if it's still there.
  if (IS_MAC) {
    const waiter = macWaiting.get(id);
    if (!waiter || waiter.sentTo !== sender.key || waiter.gone()) return false;
    waiter.done({ text: cutText(text, 8000) });
    return true;
  }
  const waiting = path.join(REPLIES, `${id}.wait`);
  let letter: OutboxLetter | null = null;
  try { letter = JSON.parse(fs.readFileSync(waiting, "utf8")); } catch { return false; }
  if (letter?.sentTo !== sender.key) return false;
  fs.rmSync(waiting, { force: true });
  let alive = 0;
  try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
  if (now - alive > 10_000) return false;
  // Its sender as that box named it, when that box alone lists it.
  const told = readPeerAgents();
  const agent = peerOf(from, peersOf(readLink()), told)?.key === sender.key ? (told[sender.key]?.list ?? []).find(each => each.session === from) : null;
  // For the conversation that asked (as this box's letter has it, not as the answer says).
  reply(id, { text: cutText(text, 8000), to: letter.from, from: agent ? from : "unknown", name: agent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}` });
  return true;
}

// Answers a tool here was given but never took (its turn stopped as one came): to the conversation
// that asked, as a message, once the tool's gone (it left `<id>.gaveup`, or stopped noting it
// waits), if it still takes letters (not a subagent's, a group chat's seat, nor one put away). Each
// once at most: taken out of the tool's way first, put back to try again if it can't go now; one
// cut off as it's delivered (this bridge stopped) stays `.delivering`, and is dropped.
export async function deliverLeftAnswers(now = Date.now(), targets: Target[] = peerTargets()): Promise<void> {
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const file = path.join(REPLIES, name);
    let answer: Partial<AnswerReply> | null;
    try { answer = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (typeof answer?.text !== "string" || typeof answer.to !== "string") continue;
    let alive = 0;
    try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
    if (!fs.existsSync(path.join(REPLIES, `${id}.gaveup`)) && now - alive <= 10_000) continue;
    const taken = `${file}.delivering`;
    try { fs.renameSync(file, taken); } catch { continue; }
    try {
      const place = await placeOfSession(answer.to, targets);
      const kuvo = place?.data?.metadata?.kuvo ?? {};
      if (place && !place.data?.parentID && !kuvo.seat && !isPutAway(place.data as PutAwayable)) {
        await asked(place.target, "POST", `api/session/${encodeURIComponent(answer.to)}/prompt`,
          { id: messageID(), text: composeLetter(String(answer.name ?? "another agent"), String(answer.from ?? "unknown"), answer.text, false), delivery: "steer" });
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
  for (const most of [LETTER_BYTES, LETTER_BYTES / 4, 2000]) {
    const bytes = mailFor(peer, { letter: { ...letter, text: prefixBytes(words, most) }, at: now }, link);
    if (bytes) return bytes;
  }
  return null;
}

// The outbox, sent: each letter the tool left for this link (in `outbox/sending`; the Mac collects
// the rest over SSH) goes to the box its agent is on (an answer, to the box it answers), again
// each minute until that box says it has it (or why not), for two days. A tool that gave up
// waiting (`replies/<id>.gaveup`) has its letter go on without waiting, and an answer that comes
// later reaches its conversation as a message. Without the relay for a while (`offline`), letters
// not yet sent go to the Mac instead. A group chat's letters given up are told to the coding
// agents' bridge (`ask`); the tellings are what it returns.
export function sendOutbox(host: Pick<LinkHost, "send">, link: LinkState | null = readLink(), now = Date.now(), offline = 0, ask: BridgeAsk = bridgeAsk): Promise<void[]> {
  const telling: Promise<void>[] = [];
  if (!link?.key) return Promise.all(telling);
  const peers = peersOf(link);
  const told = readPeerAgents(undefined, undefined, link);
  const moved = movedOf(link);
  // The relay back: letters given to the Mac it hasn't taken come back. (Not one a Mac took to
  // deliver, `.mac-…`: each goes one way, by whichever renames it first.)
  if (!offline) {
    for (const name of listOf(OUTBOX)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const letter: OutboxLetter | null = JSON.parse(fs.readFileSync(path.join(OUTBOX, name), "utf8"));
        if (typeof letter?.handed !== "number") continue;
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(OUTBOX, name), path.join(SENDING, name));
      } catch {}
    }
  }
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".gaveup")) continue;
    const id = name.slice(0, -7);
    fs.rmSync(path.join(REPLIES, name), { force: true });
    fs.rmSync(path.join(REPLIES, `${id}.wait`), { force: true });
    const file = path.join(SENDING, `${id}.json`);
    try { writePrivate(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wait: false })); } catch {}
  }
  const listed = new Set<string>();
  // Oldest first, as they were left.
  const waiting: { name: string; letter: InSending | null }[] = [];
  for (const name of listOf(SENDING)) {
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
    // Where its agent lives now: a conversation moved goes where it went, whoever it was left for.
    const lives = moved.get(letter.to);
    const peer = lives ? peers.find(each => each.key === lives) ?? null
      : typeof letter.peer === "string" ? peers.find(each => each.key === letter.peer) ?? null : peerOf(letter.to, peers, told, moved);
    if (now - made > LETTER_MEMORY) {
      fs.rmSync(file, { force: true });
      if (letter.wait === true) reply(id, { failed: "Its agent couldn't be reached." });
      continue;
    }
    // No box lists its agent now (lists change as boxes come and go): it waits.
    if (!peer) continue;
    // No relay for a while: one never sent goes to the Mac, which takes it on over SSH (on a
    // machine: this Mac's box waits for the relay).
    if (!IS_MAC && offline > RELAY_GONE_AFTER && !letter.sentTo && !letter.answers) {
      try {
        const { via, sentTo, peer: _, ...rest } = letter;
        writePrivate(path.join(OUTBOX, `${id}.json`), JSON.stringify({ ...rest, wait: false, handed: now }));
        fs.rmSync(file, { force: true });
        if (letter.wait === true) reply(id, { note: "Your other computers can't be reached through the relay now: it goes through your Mac instead, and its answer comes to you as a message." });
      } catch {}
      continue;
    }
    if (offline || now - (letterTries.get(id) ?? 0) < 60_000) continue;
    // Its sender, told of to that box first, so it's taken for one of this box's agents.
    if (letter.from && !toldPeers.get(peer.key)?.sessions?.has(letter.from) && !introducing.has(id)) {
      introducing.set(id, now);
      announce(host, readEngineFile, link).catch(() => {});
      continue;
    }
    letterTries.set(id, now);
    const bytes = letterMail(peer, { id, from: letter.from, to: letter.to, text: cutText(letter.text), wait: letter.wait === true, at: made,
      ...(letter.answers ? { answers: letter.answers } : {}) }, link, now);
    if (!bytes) {
      fs.rmSync(file, { force: true });
      if (letter.wait === true) reply(id, { failed: "It's too long to send." });
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