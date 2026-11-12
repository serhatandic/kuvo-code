// What you do to an item another of your computers keeps, done there (PROTOCOL.md, "The Work
// Queue", "Across your computers", Done where it's kept): a client sends it to any box, and that box,
// which knows which computer keeps the item (as that one told it), hands it to that computer's box
// by mail and answers with what it said. So no client works out where an item is.
//
// The asking box leaves it in `run/work-queue/forward/<id>.json` and waits for `<id>.answer.json`
// beside it: a machine's routes from a Mac over SSH are answered by a process of their own (`box
// route`) with no relay connection, so its link sends what's left there, and leaves the answer, as
// this Mac's box does in one process. The computer that keeps it does it as its own client's, once
// for each id.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { listOf, writePrivate } from "../files";
import { watchFolders } from "../follow";
import { ownName } from "../letters/start";
import { readPeerAgents } from "../peers/directory";
import { peersOf } from "../peers/known";
import { awaySince } from "../peers/reach";
import { offRelay } from "../letters/leave";
import { sharedMachine } from "../setup/settle";
import { readLink } from "../state";
import { computerName } from "./across";
import { mailsFor } from "./parts";
import { WORK_QUEUE } from "./store";
import { readTold } from "./told";
import type { MailSender } from "../peers/known";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { Computer } from "./view";

/** What a box's agents' mail says when it takes what you do to an item from your other computers'
 * boxes (`kuvo/info`'s `features` too). */
export const FORWARD_FEATURE = "work-queue.forward";

/** Whether the computer `key` takes what you do to its items from another box. */
export const takesForwarded = (key: string): boolean => (readPeerAgents()[key]?.features ?? []).includes(FORWARD_FEATURE);

export const FORWARDS = path.join(WORK_QUEUE, "forward");
// What a keeper did for the asks it took, by asker and id (changes only: a read is done again).
const DONE_FILE = path.join(WORK_QUEUE, "acted.json");
const ID = /^wqa_[A-Za-z0-9_-]{16,40}$/;
const LEFT = /^(wqa_[A-Za-z0-9_-]{16,40})\.json$/;

/** How long a box waits for the computer that keeps an item to answer (a test's shorter). */
export const forwardTiming = { wait: 20_000 };
/** How often what's waiting goes again while it's waited for (the keeper takes each id once). */
const AGAIN_AFTER = 5_000;
/** How soon a keeper sends an answer again, to an ask sent again: a file's later (it can be big). */
const answerAgainAfter = (act: Act) => (act.action === "file" ? 15_000 : 4_000);
/** How long a keeper remembers what it did for each id, and how far off an ask's `at` may be. */
export const ACT_MEMORY = 600_000;

/** What a client did, as it goes to the box that keeps the item: a whole read (`GET`) or one of its
 * files (`action` `file`, `name`), a delete, or a move or a bringing back (`action`), with what it
 * said (`body`, a move's place). */
export interface Act {
  id: string;
  method: "GET" | "DELETE" | "POST";
  item: string;
  action?: "move" | "restore" | "file";
  name?: string;
  body?: Record<string, unknown>;
  at: number;
}

/** What the box that keeps it answered: as its own route would have (a file: `{type, data}`, its
 * bytes in base64). */
export interface Acted { status: number; value: unknown }

/** How it went, for the box that asked: that box's answer, or why there's none. */
export type Forwarded = Acted | { status: 409 | 503; refused: string };

/** How what's left goes at once, where this process sends it (this Mac's box, a machine's link). */
export const forwardsSoon: { send: () => void } = { send: () => {} };

const left = (id: string) => path.join(FORWARDS, `${id}.json`);
const answerOf = (id: string) => path.join(FORWARDS, `${id}.answer.json`);
const read = (file: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
};

/** `act` done on the computer `computer` (one of your other computers, by what it told of its
 * items), and what it answered: or, when it can't be asked, why, in words a client shows (`named`,
 * the item as they name it). */
export async function forwardAct(computer: Computer, named: string, act: Omit<Act, "id" | "at">, signal?: AbortSignal | null, link: LinkState | null = readLink(), now = Date.now()): Promise<Forwarded> {
  const peer = peersOf(link).find(each => each.key === computer.key);
  // (One it doesn't know any more, or that doesn't take it yet: changed there, as before. Nor from
  // a machine Macs share outside one setup: another person's computers may tell it theirs.)
  if (!peer || !takesForwarded(peer.key) || sharedMachine(link)) return { status: 409, refused: `${named} is on ${computer.name}: change it there.` };
  const here = ownName();
  if (awaySince(peer.key) !== null) return { status: 503, refused: `${computer.name} isn't answering now (it may be asleep, off or offline), so nothing was changed there. Try again once it's back.` };
  if (offRelay()) return { status: 503, refused: `${here} isn't connected to your other computers now, so nothing was changed on ${computer.name}. Try again in a moment.` };
  const id = `wqa_${crypto.randomBytes(16).toString("base64url")}`;
  try {
    writePrivate(left(id), JSON.stringify({ to: peer.key, act: { ...act, id, at: now } }));
  } catch {
    return { status: 503, refused: `${here} couldn't send it to ${computer.name}. Try again in a moment.` };
  }
  forwardsSoon.send();
  try {
    const answer = await answered(id, peer.key, signal);
    // (It may have got there before that computer stopped answering, or its answer was lost.)
    if (answer === "away") return { status: 503, refused: `${computer.name} stopped answering, so ${here} can't tell whether it was done there. Look again once it's back.` };
    if (answer === "late") return { status: 503, refused: `${computer.name} didn't answer in time, so ${here} can't tell whether it was done there. Look again in a moment.` };
    return answer;
  } finally {
    fs.rmSync(left(id), { force: true });
    fs.rmSync(answerOf(id), { force: true });
  }
}

// The answer to `id` once it's left beside it; "away" once the relay finds that computer not there
// (after it was sent), "late" past the wait or once its asker went.
function answered(id: string, key: string, signal?: AbortSignal | null): Promise<Acted | "away" | "late"> {
  return new Promise(resolve => {
    const until = Date.now() + forwardTiming.wait;
    let done = false;
    const finish = (value: Acted | "away" | "late") => {
      if (done) return;
      done = true;
      watch.close();
      clearInterval(timer);
      signal?.removeEventListener("abort", gone);
      resolve(value);
    };
    const check = () => {
      const answer = read(answerOf(id));
      if (answer && typeof answer.status === "number") return finish({ status: answer.status, value: answer.value });
      if (awaySince(key) !== null) return finish("away");
      if (Date.now() >= until || signal?.aborted) finish("late");
    };
    const gone = () => finish("late");
    // (The system's watch, and a look every half second for what one missed.)
    const watch = watchFolders([FORWARDS], check, { recursive: false });
    const timer = setInterval(check, 500);
    signal?.addEventListener("abort", gone, { once: true });
    check();
  });
}

// When each one left was last sent, in this process.
const sent = new Map<string, number>();

/** What's left to forward, sent by this process's relay connection (each round, and as it's left):
 * each again every few seconds while it's waited for. What's past its wait is cleared. */
export function sendForwards(host: Pick<LinkHost, "send" | "welcomed"> | null | undefined, link: LinkState | null = readLink(), now = Date.now()): void {
  const names = listOf(FORWARDS);
  const here = new Set<string>();
  for (const name of names) {
    const id = LEFT.exec(name)?.[1];
    if (!id) continue;
    here.add(id);
    const kept = read(path.join(FORWARDS, name));
    const act = isObject(kept?.act) ? kept.act : null;
    // (Its asker is gone: a process that stopped mid-wait leaves it.)
    if (!act || typeof act.at !== "number" || now - act.at > forwardTiming.wait + AGAIN_AFTER) {
      fs.rmSync(path.join(FORWARDS, name), { force: true });
      fs.rmSync(answerOf(id), { force: true });
      here.delete(id);
      continue;
    }
    if (!host?.welcomed || !link || fs.existsSync(answerOf(id)) || now - (sent.get(id) ?? -Infinity) < AGAIN_AFTER) continue;
    const peer = peersOf(link).find(each => each.key === kept!.to);
    const mails = peer ? mailsFor(peer, { act }, link, now) : null;
    if (!mails) continue;
    try {
      for (const bytes of mails) host.send(bytes);
      sent.set(id, now);
    } catch {}
  }
  for (const id of sent.keys()) if (!here.has(id)) sent.delete(id);
  // (An answer whose ask is gone.)
  for (const name of names) {
    const id = /^(wqa_[A-Za-z0-9_-]{16,40})\.answer\.json$/.exec(name)?.[1];
    if (id && !here.has(id)) fs.rmSync(answerOf(id), { force: true });
  }
}

/** The answer from the box an ask went to, left for whoever waits for it; only from that box. */
export function takeActed(sender: MailSender, given: unknown): void {
  if (!isObject(given) || typeof given.id !== "string" || !ID.test(given.id)) return;
  const status = given.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) return;
  const kept = read(left(given.id));
  if (kept?.to !== sender.key) return;
  try { writePrivate(answerOf(given.id), JSON.stringify({ status, value: given.value ?? null })); } catch {}
}

// What this box did for each ask, by asker and id, and when it last answered it: so one sent again
// is answered the same (not again at once) and done once. A change's is kept on
// disk too, so it holds across a restart; one that was under way as the box stopped is answered as
// one that may have been done.
interface Done { at: number; answer: Acted | null; answered?: number }
const did = new Map<string, Done>();

function readDone(now: number): Record<string, { at: number; answer: Acted | null }> {
  const kept = read(DONE_FILE) ?? {};
  const fresh: Record<string, { at: number; answer: Acted | null }> = {};
  for (const [key, each] of Object.entries(kept)) {
    if (isObject(each) && typeof each.at === "number" && now - each.at <= ACT_MEMORY) fresh[key] = { at: each.at, answer: isObject(each.answer) ? each.answer as unknown as Acted : null };
  }
  return fresh;
}

function keepDone(key: string, done: Done, now: number): void {
  try {
    const kept = readDone(now);
    kept[key] = { at: done.at, answer: done.answer };
    writePrivate(DONE_FILE, JSON.stringify(kept));
  } catch {}
}

/** An ask from another of your computers' boxes: done here as this box's own client's (`run`), and
 * answered; one asked again is answered as it was, never done twice. */
export async function takeAct(sender: MailSender, given: unknown, reply: (payload: Record<string, unknown>) => void, run: (act: Act) => Promise<Acted>, now = Date.now()): Promise<void> {
  const act = actOf(given);
  if (!act) return;
  const link = readLink();
  // (Only from one of your computers that's still a peer.)
  const peer = peersOf(link).find(each => each.key === sender.key);
  if (!peer) return;
  const here = ownName();
  const answer = (value: Acted) => reply({ acted: { id: act.id, ...value } });
  for (const [id, each] of did) if (now - each.at > ACT_MEMORY) did.delete(id);
  const key = `${sender.key} ${act.id}`;
  const changes = act.method !== "GET";
  const mine = did.get(key);
  if (mine) {
    // (Under way now, or answered a moment ago.)
    if (!mine.answer || (mine.answered !== undefined && now - mine.answered < answerAgainAfter(act))) return;
    mine.answered = now;
    return answer(mine.answer);
  }
  // A change this box took before it last started: as it went, or, cut short then, that it may
  // have been done.
  const kept = changes ? readDone(now)[key] : undefined;
  if (kept) {
    const value = kept.answer ?? { status: 409, value: { message: `${here} stopped while it was doing this, so it can't tell whether it was done. Look again in a moment.` } };
    did.set(key, { at: kept.at, answer: value, answered: now });
    return answer(value);
  }
  // (From a machine Macs share outside one setup: another person may use it.)
  if (readTold(sender.key)?.shared) return answer({ status: 409, value: { message: `${here} doesn't take changes from ${computerName(peer)}, a machine shared with other Macs: change it from ${here}.` } });
  // (One from long ago, sent again, or from a computer whose clock is far off: not done.)
  if (Math.abs(now - act.at) > ACT_MEMORY) return answer({ status: 409, value: { message: `${here}'s clock and ${computerName(peer)}'s are too far apart to take it: check both computers' time.` } });
  const entry: Done = { at: now, answer: null };
  did.set(key, entry);
  if (changes) keepDone(key, entry, now);
  try {
    entry.answer = await run(act);
  } catch {
    entry.answer = { status: 500, value: { message: `Something went wrong on ${here}. Try again in a moment.` } };
  }
  if (changes) keepDone(key, entry, now);
  entry.answered = Date.now();
  answer(entry.answer);
}

/** All this box did for others forgotten, in this process (a test's: what's on disk stays, as for a
 * box that started again). */
export function forgetActs(): void {
  did.clear();
  sent.clear();
}

const actOf = (given: unknown): Act | null => {
  if (!isObject(given) || typeof given.id !== "string" || !ID.test(given.id) || typeof given.item !== "string" || !given.item || given.item.length > 300) return null;
  if (typeof given.at !== "number" || !Number.isFinite(given.at)) return null;
  const { method, action, name } = given;
  const fits = (method === "GET" && action === undefined) || (method === "DELETE" && action === undefined) || (method === "POST" && (action === "move" || action === "restore"))
    || (method === "GET" && action === "file" && typeof name === "string" && name.length > 0 && name.length <= 300);
  if (!fits) return null;
  return { id: given.id, method, item: given.item, ...(action ? { action } : {}), ...(action === "file" ? { name } : {}), ...(isObject(given.body) ? { body: given.body } : {}), at: given.at } as Act;
};
