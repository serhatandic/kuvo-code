// The Work Queue's numbers (PROTOCOL.md, "The Work Queue", "Numbers"): one #n per item, unique
// across your computers, handed out by the primary: the box of the Mac that set this one up (a Mac's
// own box, and a box with no Mac, is its own), kept once it's first used, so a Mac switching later
// doesn't move the counter. The primary keeps the one counter; every other box numbers from blocks
// the primary leased it, so it numbers at once, offline too, and asks for another block by mail
// before it runs out. An ask has an id, and the primary keeps what it gave for each, so one sent
// again gets the same block. With no number left and the primary away, an item waits for one, and
// takes it, oldest first, when a block comes.
//
// An import keeps its items' numbers by claiming them: the primary grants a claimed number only at
// or above its counter (below it, it may have handed it out already), and moves its counter past.
// Kept in `run/work-queue/numbers.json`, each box's own.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { IS_MAC } from "../home";
import { locked, textOf, writePrivate } from "../files";
import { macsOf, mailFor, peersOf } from "../peers/known";
import { readLink } from "../state";
import { changeQueues, WORK_QUEUE } from "./store";
import type { Book } from "./store";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";
import type { MailSender, Peer } from "../peers/known";

export const NUMBERS_FILE = path.join(WORK_QUEUE, "numbers.json");

/** How many numbers a block holds, and how few left start an ask for the next. */
export const BLOCK = 50;
export const LOW = 15;
/** How long an ask waits for its answer before it's sent again. */
export const ASK_AGAIN = 30_000;
const MOST_GIVEN = 500;
const MOST_RANGES = 400;
const ASK_ID = /^wqn_[A-Za-z0-9_-]{8,40}$/;

/** Numbers as runs, `[from, to]` each, sorted and joined. */
export type Ranges = [number, number][];

/** What a box keeps of its numbers: its primary (once it's used: "self" or the Mac's key); on the
 * primary, its counter (`next`), the blocks and claims it gave by ask, and the numbers it granted
 * each box (`granted`, by box: "self" for its own); elsewhere, its leased blocks and the ask it
 * waits on, with the numbers it claims. */
export interface Numbers {
  primary?: string;
  next?: number;
  given?: Record<string, { from: number; to: number; granted: Ranges; at: number }>;
  granted?: Record<string, Ranges>;
  leases: Ranges;
  asking?: { id: string; count: number; claims?: Ranges; since: number; sent?: number };
}

/** Who hands out this box's numbers: itself, the Mac it names, or a Mac it can't write to yet. */
export type Primary = { self: true } | { peer: Peer } | { away: true };

const isRange = (each: unknown): each is [number, number] => Array.isArray(each) && each.length === 2 && each.every(n => Number.isInteger(n) && n > 0) && each[0] <= each[1];

/** Runs sorted, and those that touch or overlap joined. */
const joined = (...all: Ranges[]): Ranges => {
  const sorted = all.flat().filter(isRange).map(([from, to]): [number, number] => [from, to]).sort((a, b) => a[0] - b[0]);
  const ranges: Ranges = [];
  for (const [from, to] of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  return ranges;
};
/** `numbers` as runs. */
export const rangesOf = (numbers: Iterable<number>): Ranges => joined([...numbers].filter(n => Number.isInteger(n) && n > 0).map((n): [number, number] => [n, n]));
/** What of `ranges` is also in `within`. */
const overlap = (ranges: Ranges, within: Ranges): Ranges => joined(ranges.flatMap(([from, to]) => within.flatMap(([a, b]): Ranges => (Math.max(from, a) <= Math.min(to, b) ? [[Math.max(from, a), Math.min(to, b)]] : []))));
export const inRanges = (ranges: Ranges, n: number) => ranges.some(([from, to]) => n >= from && n <= to);
const cleanRanges = (value: unknown): Ranges => (Array.isArray(value) ? value.filter(isRange).slice(0, MOST_RANGES) : []);

export function readNumbers(file = NUMBERS_FILE): Numbers {
  try {
    const kept = JSON.parse(textOf(file) ?? "null");
    if (!isObject(kept)) return { leases: [] };
    const asking = isObject(kept.asking) && typeof kept.asking.id === "string" && typeof kept.asking.count === "number" && typeof kept.asking.since === "number"
      ? { id: kept.asking.id, count: kept.asking.count, since: kept.asking.since, ...(typeof kept.asking.sent === "number" ? { sent: kept.asking.sent } : {}), ...(Array.isArray(kept.asking.claims) ? { claims: cleanRanges(kept.asking.claims) } : {}) }
      : undefined;
    return {
      ...(typeof kept.primary === "string" ? { primary: kept.primary } : {}),
      ...(typeof kept.next === "number" && Number.isInteger(kept.next) && kept.next > 0 ? { next: kept.next } : {}),
      ...(isObject(kept.given) ? { given: kept.given as Numbers["given"] } : {}),
      ...(isObject(kept.granted) ? { granted: Object.fromEntries(Object.entries(kept.granted).map(([box, ranges]) => [box, cleanRanges(ranges)])) } : {}),
      leases: cleanRanges(kept.leases),
      ...(asking ? { asking } : {}),
    };
  } catch {
    return { leases: [] };
  }
}

/** This box's primary: the one it kept, else as its link says now. */
export function primaryOf(link: LinkState | null | undefined = readLink(), file = NUMBERS_FILE): Primary {
  if (IS_MAC) return { self: true };
  const kept = readNumbers(file).primary;
  const mac = kept ?? (link ? (typeof link.mac === "string" ? link.mac : macsOf(link)[0]) : undefined);
  if (!mac || mac === "self") return { self: true };
  const peer = peersOf(link).find(each => each.key === mac && each.address);
  return peer ? { peer } : { away: true };
}

const keyOf = (primary: Primary, link: LinkState | null | undefined) => ("self" in primary ? "self" : "peer" in primary ? primary.peer.key : (readNumbers().primary ?? (link?.mac || undefined)));
const askID = () => `wqn_${crypto.randomBytes(12).toString("base64url")}`;
const leftIn = (leases: Ranges) => leases.reduce((sum, [from, to]) => sum + to - from + 1, 0);

/** `work` on the numbers, one process at a time. */
export function changeNumbers<T>(work: (kept: Numbers) => T, file = NUMBERS_FILE): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return locked(`${path.join(path.dirname(file), "." + path.basename(file))}.lock`, () => {
    const kept = readNumbers(file);
    const before = JSON.stringify(kept);
    const value = work(kept);
    if (JSON.stringify(kept) !== before) writePrivate(file, JSON.stringify(kept));
    return value;
  });
}

/** The next number for a new item here, or null when it has to wait for one (`primary`: who hands
 * them out, as `primaryOf` says). The first number taken keeps that primary for good. */
export function takeNumber(primary: Primary, { file = NUMBERS_FILE, now = Date.now(), link = readLink() }: { file?: string; now?: number; link?: LinkState | null } = {}): number | null {
  return changeNumbers(kept => {
    kept.primary ??= keyOf(primary, link);
    if ("self" in primary) {
      const number = kept.next ?? 1;
      kept.next = number + 1;
      return number;
    }
    const lease = kept.leases[0];
    let number: number | null = null;
    if (lease) {
      number = lease[0];
      if (lease[0] === lease[1]) kept.leases.shift();
      else lease[0]++;
    }
    if (leftIn(kept.leases) <= LOW) kept.asking ??= { id: askID(), count: BLOCK, since: now };
    return number;
  }, file);
}

// On the primary: which of `claims` the box `by` may have (at or above the counter, or granted it
// before), the counter moved past them.
function grantOn(kept: Numbers, by: string, claims: Ranges): Ranges {
  const before = kept.granted?.[by] ?? [];
  const next = kept.next ?? 1;
  const ranges = joined(overlap(claims, [[next, Number.MAX_SAFE_INTEGER]]), overlap(claims, before));
  if (ranges.length) {
    kept.next = Math.max(next, ranges[ranges.length - 1][1] + 1);
    kept.granted = { ...(kept.granted ?? {}), [by]: joined(before, ranges).slice(-MOST_RANGES) };
  }
  return ranges;
}

/** Numbers an import here wants to keep. On the primary, granted at once: what it may have
 * (`granted`). Elsewhere, claimed from the primary with the next ask (leases at or below them
 * dropped): `granted` is null, and the answer comes by mail (`takeBlock`). */
export function claimNumbers(primary: Primary, numbers: number[], { file = NUMBERS_FILE, now = Date.now(), link = readLink() }: { file?: string; now?: number; link?: LinkState | null } = {}): { granted: Ranges | null } {
  const claims = rangesOf(numbers);
  if (!claims.length) return { granted: [] };
  return changeNumbers(kept => {
    kept.primary ??= keyOf(primary, link);
    if ("self" in primary) return { granted: grantOn(kept, "self", claims) };
    const highest = claims[claims.length - 1][1];
    kept.leases = kept.leases.map(([from, to]): [number, number] => [Math.max(from, highest + 1), to]).filter(([from, to]) => from <= to);
    // (A new ask, so the claims go with it even if one without them was sent already.)
    kept.asking = { id: askID(), count: BLOCK, claims: joined(kept.asking?.claims ?? [], claims).slice(-MOST_RANGES), since: now };
    return { granted: null };
  }, file);
}

/** What goes to the primary now: the ask under way, if it wasn't sent in the last half minute
 * (kept as sent before it goes). */
export function askToSend({ file = NUMBERS_FILE, now = Date.now() }: { file?: string; now?: number } = {}): { id: string; count: number; claims?: Ranges } | null {
  return changeNumbers(kept => {
    const asking = kept.asking;
    if (!asking || (asking.sent !== undefined && now - asking.sent < ASK_AGAIN)) return null;
    asking.sent = now;
    return { id: asking.id, count: asking.count, ...(asking.claims?.length ? { claims: asking.claims } : {}) };
  }, file);
}

/** The primary's answer to the box `by`'s ask: the numbers of its claims it may keep, and a block
 * past them (the same each time it's asked), kept before it's said. Null for an ask that isn't one. */
export function giveBlock(by: string, ask: unknown, { file = NUMBERS_FILE, now = Date.now() }: { file?: string; now?: number } = {}): { id: string; from: number; to: number; granted: Ranges } | null {
  if (!isObject(ask) || typeof ask.id !== "string" || !ASK_ID.test(ask.id)) return null;
  const count = typeof ask.count === "number" && Number.isInteger(ask.count) ? Math.min(Math.max(ask.count, 1), 200) : BLOCK;
  const claims = cleanRanges(ask.claims);
  const id = ask.id;
  return changeNumbers(kept => {
    kept.primary ??= "self";
    const given = kept.given?.[id];
    if (given) return { id, from: given.from, to: given.to, granted: given.granted ?? [] };
    const granted = grantOn(kept, by, claims);
    const from = kept.next ?? 1;
    const to = from + count - 1;
    kept.next = to + 1;
    const all = Object.entries({ ...(kept.given ?? {}), [id]: { from, to, granted, at: now } });
    kept.given = Object.fromEntries(all.sort((a, b) => a[1].at - b[1].at).slice(-MOST_GIVEN));
    return { id, from, to, granted };
  }, file);
}

/** A block the primary gave, kept, if it answers the ask under way: the claimed numbers it granted,
 * or null for an answer to no ask under way. */
export function takeBlock(give: unknown, { file = NUMBERS_FILE }: { file?: string } = {}): Ranges | null {
  if (!isObject(give) || typeof give.id !== "string" || !Number.isInteger(give.from) || !Number.isInteger(give.to)) return null;
  const from = give.from as number;
  const to = give.to as number;
  if (from < 1 || to < from || to - from > 1000) return null;
  const granted = cleanRanges(give.granted);
  return changeNumbers(kept => {
    if (kept.asking?.id !== give.id) return null;
    kept.asking = undefined;
    kept.leases = joined(kept.leases, [[from, to]]);
    return granted;
  }, file);
}

/** Items here that wait: those imported take the number they wanted where it was granted
 * (`granted`; one refused is noted and numbered afresh), then every one without a number takes the
 * next, oldest first. */
export function numberWaiting(book: Book, primary: Primary, granted: Ranges | null, options: { file?: string; now?: number } = {}): void {
  const now = options.now ?? Date.now();
  if (granted) {
    for (const item of book.items()) {
      if (item.wanted === undefined || item.number !== undefined) continue;
      if (inRanges(granted, item.wanted)) item.number = item.wanted;
      else item.notes.push({ at: now, by: { user: true }, text: `Imported as #${item.wanted}, a number another of your computers was given already, so it has a new one.` });
      delete item.wanted;
    }
  }
  const waiting = book.items().filter(item => item.number === undefined && item.wanted === undefined && !item.source).sort((a, b) => a.created.at - b.created.at);
  for (const item of waiting) {
    const number = takeNumber(primary, options);
    if (number === null) return;
    item.number = number;
  }
}

/** The ask under way sent to the primary, on this box's rounds (every few seconds), when it's due. */
export function pushNumbers(host: Pick<LinkHost, "send" | "welcomed"> | null | undefined, link: LinkState | null = readLink()): void {
  if (!host?.welcomed || !link || !readNumbers().asking) return;
  const primary = primaryOf(link);
  if (!("peer" in primary)) return;
  const ask = askToSend();
  if (!ask) return;
  const bytes = mailFor(primary.peer, { workQueue: { ask }, at: Date.now() }, link);
  if (bytes) try { host.send(bytes); } catch {}
}

/** Numbers' mail from another box (`{workQueue: …}`): an ask, answered by the primary with its
 * block; a block given (only from this box's own primary), kept, and what waits here numbered. */
export function takeNumbersMail(sender: MailSender, given: unknown, host: Pick<LinkHost, "send"> | null | undefined): void {
  if (!isObject(given)) return;
  const link = readLink();
  const primary = primaryOf(link);
  if (isObject(given.ask) && "self" in primary) {
    const block = giveBlock(sender.key, given.ask);
    const bytes = block && link && "address" in sender ? mailFor(sender, { workQueue: { give: block }, at: Date.now() }, link) : null;
    if (bytes) try { host?.send(bytes); } catch {}
    return;
  }
  if (isObject(given.give) && "peer" in primary && primary.peer.key === sender.key) blockArrived(given.give, primary);
}

/** A block from the primary, kept, and what waits here numbered with it (imports' wanted numbers
 * as granted): whether it answered the ask under way. */
export function blockArrived(give: unknown, primary: Primary, options: { file?: string } = {}): boolean {
  const granted = takeBlock(give, options);
  if (!granted) return false;
  changeQueues(book => numberWaiting(book, primary, granted, options));
  return true;
}
