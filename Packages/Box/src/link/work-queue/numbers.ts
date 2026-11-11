// The Work Queue's numbers (PROTOCOL.md, "The Work Queue", "Numbers"): one #n per item, unique
// across your computers, handed out by the primary: your setup's main computer (PROTOCOL.md, "Your
// setup"). A box in no setup (a machine Macs share that aren't joined in one setup yet, the Macs and
// machines numbering with it, or one beside an older box; kept until every box knows setups, #183)
// works out the first computer you set up from what it and its peers know, so Macs that set up the same machine
// already number from one of them, the one set up first. The primary keeps the one counter; every
// other box numbers from blocks the primary leased it, so it numbers at once, offline too, and asks
// for another block by mail before it runs out. An ask has an id, and the primary keeps what it gave
// for each, so one sent again gets the same block. With no number left and the primary away, an item
// waits for one, and takes it, oldest first, when a block comes.
//
// An import keeps its items' numbers by claiming them: the primary grants a claimed number only at
// or above its counter (below it, it may have handed it out already), and moves its counter past.
// Kept in `run/work-queue/numbers.json`, each box's own.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { IS_MAC, RUN } from "../home";
import { locked, textOf, writePrivate } from "../files";
import { KEY, macsOf, mailFor, ownKey, peersOf, removedBoxes } from "../peers/known";
import { readTold, toldKeys } from "./told";
import { awaySince, lastFoundAway, PEER_CHECKED, readReach } from "../peers/reach";
import { followedSetup } from "../setup/record";
import { readLink } from "../state";
import { allItems, changeQueues, OWNER, WORK_QUEUE } from "./store";
import type { Book, Item } from "./store";
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
  /** When this box was set up, as it ranks for numbering (`ownSince`). */
  since?: number;
  /** Since when the primary it keeps hasn't been heard of (`notePrimaryNow`). */
  lost?: number;
  /** The peer it reaches its primary through, when that isn't one of its own. */
  through?: string;
  next?: number;
  /** By ask: the block given, the claims granted with it, and the box it went to (`by`; missing in
   * what an older primary kept). */
  given?: Record<string, { from: number; to: number; granted: Ranges; at: number; by?: string }>;
  granted?: Record<string, Ranges>;
  leases: Ranges;
  /** Elsewhere, the numbers of its leases it gave items here: an import here never claims one that
   * no item here has now (it left with a move, or was deleted). */
  used?: Ranges;
  /** The ask under way: how many, the numbers claimed, and of those, the ones asked back for items
   * an import renumbered (`restores`). */
  asking?: { id: string; count: number; claims?: Ranges; restores?: Ranges; since: number; sent?: number };
}

/** Who hands out this box's numbers: itself, another computer (reached through a peer, `via`, when
 * it isn't one of this box's own), or one it can't write to yet. */
export type Primary = { self: true } | { peer: Peer; via?: Peer } | { away: true };

// (A number has six digits at most: what a chip reads (`#243`), and far past what's ever handed out.)
export const MOST_NUMBER = 1_000_000;
/** How far past the counter a claim is granted: an import's numbers, not one stray far number that
 * would move the counter past every number there is. Beyond it, an item is numbered afresh. */
export const CLAIM_REACH = 10_000;
const isRange = (each: unknown): each is [number, number] => Array.isArray(each) && each.length === 2 && each.every(n => Number.isInteger(n) && n > 0 && n < MOST_NUMBER) && each[0] <= each[1];

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
const cleanRanges = (value: unknown): Ranges => (Array.isArray(value) ? value.filter(isRange).slice(-MOST_RANGES) : []);

export function readNumbers(file = NUMBERS_FILE): Numbers {
  try {
    const kept = JSON.parse(textOf(file) ?? "null");
    if (!isObject(kept)) return { leases: [] };
    const asking = isObject(kept.asking) && typeof kept.asking.id === "string" && typeof kept.asking.count === "number" && typeof kept.asking.since === "number"
      ? { id: kept.asking.id, count: kept.asking.count, since: kept.asking.since, ...(typeof kept.asking.sent === "number" ? { sent: kept.asking.sent } : {}), ...(Array.isArray(kept.asking.claims) ? { claims: cleanRanges(kept.asking.claims) } : {}), ...(Array.isArray(kept.asking.restores) ? { restores: cleanRanges(kept.asking.restores) } : {}) }
      : undefined;
    return {
      ...(typeof kept.primary === "string" ? { primary: kept.primary } : {}),
      ...(typeof kept.since === "number" && Number.isFinite(kept.since) && kept.since > 0 ? { since: kept.since } : {}),
      ...(typeof kept.lost === "number" && Number.isFinite(kept.lost) ? { lost: kept.lost } : {}),
      ...(typeof kept.through === "string" ? { through: kept.through } : {}),
      ...(typeof kept.next === "number" && Number.isInteger(kept.next) && kept.next > 0 ? { next: kept.next } : {}),
      ...(isObject(kept.given) ? { given: kept.given as Numbers["given"] } : {}),
      ...(isObject(kept.granted) ? { granted: Object.fromEntries(Object.entries(kept.granted).map(([box, ranges]) => [box, cleanRanges(ranges)])) } : {}),
      leases: cleanRanges(kept.leases),
      ...(Array.isArray(kept.used) ? { used: cleanRanges(kept.used) } : {}),
      ...(asking ? { asking } : {}),
    };
  } catch {
    return { leases: [] };
  }
}

/** This box's primary: its setup's main computer, itself when it's that (PROTOCOL.md, "Your setup");
 * one it can't write to yet (its document isn't here, or names no address) is waited for, never
 * passed over. In no setup, the first computer you set up (`rankedPrimary`). */
export function primaryOf(link: LinkState | null | undefined = readLink(), file = NUMBERS_FILE, now = Date.now()): Primary {
  const setup = followedSetup(link);
  if (!setup) return rankedPrimary(link, file, now);
  if (setup.role === "primary") return { self: true };
  const peer = peersOf(link).find(each => each.key === setup.primary);
  return peer?.address ? { peer } : { away: true };
}

/** For a box in no setup, kept until every box knows setups and shared groups are joined (#183).
 * The first computer you set up, as far as this box can tell (PROTOCOL.md,
 * "The Work Queue", "Numbers"): of this box, its peers and the primaries they say they number from,
 * a Mac before a machine (a machine is always set up from a Mac), then the one set up first, then by
 * key. The one it numbers from now is kept while it's still one of your computers and none set up
 * earlier is known; a box that hears of an earlier one moves to it (never back), and one whose
 * primary was removed or forgotten finds the next. A machine with a Mac is never its own. */
export function rankedPrimary(link: LinkState | null | undefined = readLink(), file = NUMBERS_FILE, now = Date.now()): Primary {
  const kept = readNumbers(file);
  const own = link ? ownKey(link) : null;
  const gone = goneOf(link, now);
  const all = candidatesOf(link, kept, own, file, gone);
  const macs = IS_MAC ? [] : macsOf(link);
  // (A machine set up from a Mac never numbers on its own.)
  const choices = macs.length ? all.filter(each => !each.self) : all;
  const best = choices.sort(rank)[0];
  const keptKey = kept.primary === "self" || (own && kept.primary === own) ? "self" : kept.primary;
  let current: Candidate | null | "away" = null;
  if (keptKey === "self") current = all.find(each => each.self) ?? null;
  else if (keptKey && !gone.has(keptKey)) {
    current = all.find(each => each.key === keptKey) ?? null;
    // Not heard of now (one of its Macs whose peers document isn't here yet, one a peer stopped
    // naming for a while, no link yet): it waits, so a box never goes back and forth between two;
    // only one you removed, or one not heard of for days (gone), makes way for the next; and one
    // the peer it was reached through now says it numbers from another instead of (it found it
    // gone, or one set up earlier).
    const removed = removedBoxes(link);
    const through = kept.through ? readTold(kept.through)?.primary : undefined;
    const movedOn = Boolean(kept.through && through && through.key !== keptKey && peersOf(link).some(peer => peer.key === kept.through) && !gone.has(kept.through));
    if (!current && !movedOn && !removed.has(keptKey) && !(kept.through && removed.has(kept.through)) && !(kept.lost !== undefined && now - kept.lost > LOST_FOR)) current = "away";
  }
  if (current === "away") return { away: true };
  // A machine kept itself (before it was set up from a Mac): its Mac now.
  if (current?.self && macs.length) current = null;
  const chosen = current && (!best || !earlier(best, current)) ? current : best;
  if (!chosen) return (keptKey && keptKey !== "self") || macs.length ? { away: true } : { self: true };
  if (chosen.self) return { self: true };
  if (chosen.peer?.address) return { peer: chosen.peer };
  if (chosen.via?.address) return { peer: { key: chosen.key, address: "", kind: chosen.kind, name: chosen.name ?? "" }, via: chosen.via };
  return { away: true };
}

/** How long a box's primary may go unheard of (no peer names it), or not answer the box that reaches
 * it, before it's taken to be gone. */
export const LOST_FOR = 3 * 86_400_000;

/** The computers taken to be gone, for numbering: a peer that hasn't answered this box for days,
 * and still didn't lately (a Mac put away, or set up again with new keys, that its machines still
 * list a while; not one that was away when this box itself went off the relay). A box that reaches
 * that one through this one hears of it no more once this box numbers from another. Heard from
 * again, it's back, and the earliest again: a box moves back to it, and it moves past what was
 * numbered meanwhile (`top`). */
export function goneOf(link: LinkState | null | undefined, now = Date.now()): Set<string> {
  const gone = new Set<string>();
  const reach = readReach();
  const checked = readReach(PEER_CHECKED);
  for (const peer of peersOf(link)) {
    const away = awaySince(peer.key, reach);
    const last = lastFoundAway(peer.key, checked);
    if (away !== null && now - away > LOST_FOR && last !== null && now - last < FOUND_AWAY_WITHIN) gone.add(peer.key);
  }
  return gone;
}

/** How lately a peer has to have been found away for it to count as gone. */
const FOUND_AWAY_WITHIN = 3_600_000;

/** Whether the primary this box keeps is one it hears of now: for `notePrimaryNow`, which notes
 * since when it hasn't been. */
function keptHeardOf(link: LinkState | null | undefined, kept: Numbers, file: string, now: number): boolean {
  if (!kept.primary || kept.primary === "self") return true;
  const own = link ? ownKey(link) : null;
  return kept.primary === own || candidatesOf(link, kept, own, file, goneOf(link, now)).some(each => each.key === kept.primary);
}

/** A computer that may be the primary: this box, a peer, or a primary a peer named (reached
 * through that peer, `via`). */
interface Candidate {
  key: string;
  kind: "mac" | "machine";
  since: number;
  self?: true;
  peer?: Peer;
  via?: Peer;
  name?: string;
}

// Whether `a` was set up before `b`, as far as either has said: a Mac before a machine, then the one
// that says it was set up first (one that hasn't said is never earlier).
// (Never over one that hasn't said yet, an older box in the middle of an update: it may well be
// the first.)
const earlier = (a: Candidate, b: Candidate): boolean => (a.kind !== b.kind ? a.kind === "mac" : b.since !== Number.MAX_SAFE_INTEGER && a.since < b.since);
// A Mac first, then the one set up first (one that hasn't said is last), then by key.
const rank = (a: Candidate, b: Candidate): number => (a.kind === b.kind ? 0 : a.kind === "mac" ? -1 : 1) || a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function candidatesOf(link: LinkState | null | undefined, kept: Numbers, own: string | null, file: string, gone: Set<string> = goneOf(link, Date.now())): Candidate[] {
  const all: Candidate[] = [{ key: own ?? "self", kind: IS_MAC ? "mac" : "machine", since: kept.since ?? ownSince(Date.now(), file), self: true }];
  const peers = peersOf(link).filter(peer => !gone.has(peer.key));
  for (const peer of peers) all.push({ key: peer.key, kind: peer.kind, since: readTold(peer.key)?.since ?? Number.MAX_SAFE_INTEGER, peer, name: peer.name });
  for (const peer of peers) {
    const named = readTold(peer.key)?.primary;
    if (!named || named.key === own || gone.has(named.key)) continue;
    const known = all.find(each => each.key === named.key);
    if (known) {
      if (known.since === Number.MAX_SAFE_INTEGER && named.since) known.since = named.since;
      continue;
    }
    all.push({ key: named.key, kind: named.kind, since: named.since ?? Number.MAX_SAFE_INTEGER, via: peer });
  }
  return all;
}

/** When this box was set up, as it ranks among your computers for numbering: kept once worked out
 * (the earliest of its folder's making, where the system keeps that, and its oldest item). */
export function ownSince(now = Date.now(), file = NUMBERS_FILE): number {
  const kept = readNumbers(file).since;
  if (kept) return kept;
  let since = now;
  try {
    const made = fs.statSync(RUN).birthtimeMs;
    if (made > 0 && made < since) since = made;
  } catch {}
  for (const item of allItems()) if (item.created.at > 0 && item.created.at < since) since = item.created.at;
  since = Math.floor(since);
  changeNumbers(numbers => { numbers.since ??= since; }, file);
  return readNumbers(file).since ?? since;
}

/** The highest number this box used, holds or handed out: a primary moves its counter past it. */
export function topOf(kept: Numbers = readNumbers()): number {
  // (Not a number an import was refused, `importedAs`: that one was never used.)
  return Math.max(0, (kept.next ?? 1) - 1, ...kept.leases.map(([, to]) => to), ...allItems().map(item => item.number ?? 0));
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

/** The primary's counter: as kept, or, lost with its file, past every number here (never #1 again). */
function counterOf(kept: Numbers): number {
  return kept.next ?? Math.max(0, ...allItems().map(item => item.number ?? 0)) + 1;
}

/** The primary `primary` noted as the one this box numbers from now. One that leaves numbering on its
 * own asks its new primary at once, so that one moves past what it handed out (`top`); one that
 * becomes the primary starts past every number it knows of. */
function notePrimary(kept: Numbers, primary: Primary, link: LinkState | null | undefined, now: number): void {
  if ("away" in primary) {
    kept.primary ??= keyOf(primary, link);
    return;
  }
  const key = keyOf(primary, link)!;
  const through = "peer" in primary ? primary.via?.key : undefined;
  if (through) kept.through = through;
  else delete kept.through;
  if (kept.primary === key) return;
  const was = kept.primary;
  kept.primary = key;
  if (was === "self") kept.asking ??= { id: askID(), count: BLOCK, since: now };
  else if (key === "self" && was !== undefined) kept.next = Math.max(counterOf(kept), cappedTop(Math.max(topOf(kept), toldTop())) + 1);
}

/** The highest number your other computers told this one of. */
export function toldTop(): number {
  return Math.max(0, ...toldKeys().map(key => {
    const told = readTold(key);
    return Math.max(told?.top ?? 0, ...(told?.items ?? []).map(item => item.number ?? 0));
  }));
}

/** Where a `top` another box tells can move the counter at most: room left for blocks below six
 * digits, so one far number never takes every box past what a chip reads. */
const TOP_MOST = MOST_NUMBER - 1 - 4 * BLOCK;
const cappedTop = (top: number) => Math.min(top, TOP_MOST);

/** The primary moved past `top`, a number another of your computers used (on the primary only). */
export function movePast(top: number, { file = NUMBERS_FILE }: { file?: string } = {}): void {
  if (!Number.isInteger(top) || top <= 0 || top >= MOST_NUMBER) return;
  top = cappedTop(top);
  if ((readNumbers(file).next ?? 0) > top) return;
  changeNumbers(kept => {
    if (kept.primary !== "self" && kept.primary !== undefined) return;
    kept.next = Math.max(counterOf(kept), top + 1);
  }, file);
}

/** The next number for a new item here, or null when it has to wait for one (`primary`: who hands
 * them out, as `primaryOf` says). The first number taken keeps that primary for good. */
export function takeNumber(primary: Primary, { file = NUMBERS_FILE, now = Date.now(), link = readLink() }: { file?: string; now?: number; link?: LinkState | null } = {}): number | null {
  return changeNumbers(kept => {
    notePrimary(kept, primary, link, now);
    if ("self" in primary) {
      const number = counterOf(kept);
      kept.next = number + 1;
      return number;
    }
    const lease = kept.leases[0];
    let number: number | null = null;
    if (lease) {
      number = lease[0];
      if (lease[0] === lease[1]) kept.leases.shift();
      else lease[0]++;
      kept.used = joined(kept.used ?? [], [[number, number]]).slice(-MOST_RANGES);
    }
    if (leftIn(kept.leases) <= LOW) kept.asking ??= { id: askID(), count: BLOCK, since: now };
    return number;
  }, file);
}

/** The highest number the computer `key` told it used or holds: its `top`, or its items'. */
const toldTopOf = (key: string): number => {
  const told = readTold(key);
  return Math.max(told?.top ?? 0, ...(told?.items ?? []).map(item => item.number ?? 0));
};

/** What an ask says of its claims: that the asking box never claims a number it gave an item (`own`,
 * from a box that keeps `used`; an older one doesn't say it), and which are asked back for items an
 * import renumbered (`restores`). */
interface ClaimsSaid { own?: boolean; restores?: Ranges }

// On the primary: the blocks it gave the box `by`, whose numbers are that box's own (an import there
// that claims one it never used keeps it).
// Until the blocks an older primary kept without whom they went to (`by`) are gone from `given`
// (MOST_GIVEN asks on): one of those counts for numbers asked back (`restores`) when it can only be
// that box's: every other computer this one knows told it of no number as high as its first (as one
// holding it would, its `top`), and the asking box told of one as high as its last.
function blocksOf(kept: Numbers, by: string, restores: Ranges): Ranges {
  const given = Object.values(kept.given ?? {});
  const own: Ranges = given.filter(each => each.by === by).map(each => [each.from, each.to]);
  const unsaid = restores.length ? given.filter(each => each.by === undefined) : [];
  if (!unsaid.length) return joined(own);
  const told = new Set(toldKeys());
  const known = new Set([...peersOf(readLink()).map(peer => peer.key), ...Object.keys(kept.granted ?? {}), ...told]);
  known.delete(by);
  known.delete("self");
  // (One that never told this one anything could hold any of them.)
  if ([...known].some(key => !told.has(key))) return joined(own);
  const others = Math.max(0, ...[...known].map(toldTopOf));
  const theirs = toldTopOf(by);
  const old = unsaid.filter(each => each.from > others && each.to <= theirs).map((each): [number, number] => [each.from, each.to]);
  return joined(own, overlap(joined(old), restores));
}

// On the primary: which of `claims` the box `by` may have (at or above the counter and within reach
// of it, granted it before, or, from a box that never claims one it used, in a block it gave that
// box), the counter moved past them.
function grantOn(kept: Numbers, by: string, claims: Ranges, said: ClaimsSaid = {}): Ranges {
  const before = kept.granted?.[by] ?? [];
  const next = counterOf(kept);
  const blocks = by !== "self" && said.own ? blocksOf(kept, by, overlap(said.restores ?? [], claims)) : [];
  const ranges = joined(overlap(claims, [[next, Math.min(next + CLAIM_REACH, MOST_NUMBER - 1)]]), overlap(claims, before), overlap(claims, blocks));
  if (ranges.length) {
    kept.next = Math.max(next, ranges[ranges.length - 1][1] + 1);
    kept.granted = { ...(kept.granted ?? {}), [by]: joined(before, ranges).slice(-MOST_RANGES) };
  }
  return ranges;
}

/** Numbers an import here wants to keep. On the primary, granted at once: what it may have
 * (`granted`). Elsewhere, claimed from the primary with the next ask (leases at or below them
 * dropped): `granted` is null, and the answer comes by mail (`takeBlock`). */
export function claimNumbers(primary: Primary, numbers: number[], { file = NUMBERS_FILE, now = Date.now(), link = readLink(), restores = [] }: { file?: string; now?: number; link?: LinkState | null; restores?: number[] } = {}): { granted: Ranges | null } {
  const claims = rangesOf(numbers);
  if (!claims.length) return { granted: [] };
  return changeNumbers(kept => {
    notePrimary(kept, primary, link, now);
    if ("self" in primary) return { granted: grantOn(kept, "self", claims) };
    const highest = claims[claims.length - 1][1];
    kept.leases = kept.leases.map(([from, to]): [number, number] => [Math.max(from, highest + 1), to]).filter(([from, to]) => from <= to);
    // (A new ask, so the claims go with it even if one without them was sent already.)
    const back = joined(kept.asking?.restores ?? [], overlap(rangesOf(restores), claims)).slice(-MOST_RANGES);
    kept.asking = { id: askID(), count: BLOCK, claims: joined(kept.asking?.claims ?? [], claims).slice(-MOST_RANGES), ...(back.length ? { restores: back } : {}), since: now };
    return { granted: null };
  }, file);
}

/** What goes to the primary now: the ask under way, if it wasn't sent in the last half minute
 * (kept as sent before it goes), with the highest number this box used or holds (`top`). */
export function askToSend({ file = NUMBERS_FILE, now = Date.now() }: { file?: string; now?: number } = {}): { id: string; count: number; claims?: Ranges; restores?: Ranges; own?: true; top?: number } | null {
  const asked = changeNumbers(kept => {
    const asking = kept.asking;
    if (!asking || (asking.sent !== undefined && now - asking.sent < ASK_AGAIN)) return null;
    asking.sent = now;
    return { id: asking.id, count: asking.count, ...(asking.claims?.length ? { claims: asking.claims, own: true as const } : {}), ...(asking.restores?.length ? { restores: asking.restores } : {}) };
  }, file);
  if (!asked) return null;
  const top = topOf(readNumbers(file));
  return { ...asked, ...(top ? { top } : {}) };
}

/** Whether this box's primary changed (one set up earlier heard of, or the one it had gone): noted
 * now, so a box that numbered on its own asks its new primary at once. */
export function notePrimaryNow(link: LinkState | null | undefined = readLink(), { file = NUMBERS_FILE, now = Date.now() }: { file?: string; now?: number } = {}): void {
  // Since when the one it keeps hasn't been heard of.
  const before = readNumbers(file);
  const heard = keptHeardOf(link, before, file, now);
  if (heard === (before.lost !== undefined)) changeNumbers(numbers => {
    if (heard) delete numbers.lost;
    else numbers.lost ??= now;
  }, file);
  const primary = primaryOf(link, file, now);
  const kept = readNumbers(file);
  if (kept.primary === undefined || "away" in primary || (kept.primary === keyOf(primary, link) && kept.through === ("peer" in primary ? primary.via?.key : undefined))) return;
  changeNumbers(numbers => notePrimary(numbers, primary, link, now), file);
}

/** The primary's answer to the box `by`'s ask: the numbers of its claims it may keep, and a block
 * past them (the same each time it's asked), kept before it's said. Null for an ask that isn't one. */
export function giveBlock(by: string, ask: unknown, { file = NUMBERS_FILE, now = Date.now() }: { file?: string; now?: number } = {}): { id: string; from: number; to: number; granted: Ranges } | null {
  if (!isObject(ask) || typeof ask.id !== "string" || !ASK_ID.test(ask.id)) return null;
  const count = typeof ask.count === "number" && Number.isInteger(ask.count) ? Math.min(Math.max(ask.count, 1), 200) : BLOCK;
  const claims = cleanRanges(ask.claims);
  const top = typeof ask.top === "number" && Number.isInteger(ask.top) && ask.top > 0 && ask.top < MOST_NUMBER ? ask.top : 0;
  const id = ask.id;
  return changeNumbers(kept => {
    kept.primary ??= "self";
    // (Past what the asking box used or holds: one that numbered on its own before, or numbers this
    // box lost with its file.)
    if (top && !kept.given?.[id]) kept.next = Math.max(counterOf(kept), cappedTop(top) + 1);
    const given = kept.given?.[id];
    if (given) return { id, from: given.from, to: given.to, granted: given.granted ?? [] };
    const granted = grantOn(kept, by, claims, { own: ask.own === true, restores: cleanRanges(ask.restores) });
    const from = counterOf(kept);
    const to = from + count - 1;
    kept.next = to + 1;
    const all = Object.entries({ ...(kept.given ?? {}), [id]: { from, to, granted, at: now, by } });
    kept.given = Object.fromEntries(all.sort((a, b) => a[1].at - b[1].at).slice(-MOST_GIVEN));
    return { id, from, to, granted };
  }, file);
}

/** What the primary said to claims: those it granted, of those it was asked (`claimed`). */
export interface Granting { granted: Ranges; claimed: Ranges }

/** A block the primary gave, kept, if it answers the ask under way: the claims that ask carried and
 * those granted, or null for an answer to no ask under way. */
export function takeBlock(give: unknown, { file = NUMBERS_FILE }: { file?: string } = {}): Granting | null {
  if (!isObject(give) || typeof give.id !== "string" || !Number.isInteger(give.from) || !Number.isInteger(give.to)) return null;
  const from = give.from as number;
  const to = give.to as number;
  if (from < 1 || to < from || to - from > 1000) return null;
  const granted = cleanRanges(give.granted);
  return changeNumbers(kept => {
    if (kept.asking?.id !== give.id) return null;
    const claimed = kept.asking?.claims ?? [];
    kept.asking = undefined;
    kept.leases = joined(kept.leases, [[from, to]]);
    return { granted, claimed };
  }, file);
}

/** Items here that wait: those imported take the number they wanted where it was granted (one
 * refused is noted and numbered afresh), and those an import renumbered move to their own where it
 * was given back (`restoreNumbers`); only the items whose numbers that answer was asked (`claimed`)
 * are decided, the others wait for theirs. Then every one without a number takes the next, oldest
 * first. The numbers items took are noted as used here. */
export function numberWaiting(book: Book, primary: Primary, answer: Granting | null, options: { file?: string; now?: number } = {}): void {
  const now = options.now ?? Date.now();
  const used: number[] = [];
  if (answer) {
    for (const item of book.items()) {
      if (item.wanted === undefined || item.backGranted || item.source || !OWNER.test(item.owner) || !inRanges(answer.claimed, item.wanted)) continue;
      const kept = inRanges(answer.granted, item.wanted);
      if (item.number !== undefined) {
        if (kept) item.backGranted = true;
        else stays(item, `Its own number, #${item.wanted}, couldn't be given back (another of your computers was given it already, or it's far past the numbers in use), so it stays #${item.number}.`, now);
        continue;
      }
      if (kept) {
        item.number = item.wanted;
        used.push(item.number);
      } else {
        item.notes.push({ at: now, by: { user: true }, text: `Imported as #${item.wanted}, a number that couldn't be kept (another of your computers was given it already, or it's far past the numbers in use), so it has a new one.` });
        item.importedAs = item.wanted;
      }
      delete item.wanted;
    }
  }
  used.push(...restoreNumbers(book, now));
  if (used.length) changeNumbers(kept => { kept.used = joined(kept.used ?? [], rangesOf(used)).slice(-MOST_RANGES); }, options.file);
  // (Not an outside source's item, named by its ref; nor one in a queue of a kind a newer box keeps,
  // left as it is.)
  const waiting = book.items().filter(item => item.number === undefined && item.wanted === undefined && !item.source && OWNER.test(item.owner)).sort((a, b) => a.created.at - b.created.at);
  for (const item of waiting) {
    const number = takeNumber(primary, options);
    if (number === null) return;
    item.number = number;
  }
}

// An item asking for its own number back that keeps the one it has, for good (`why`, its note).
function stays(item: Item, why: string, now: number): void {
  item.notes.push({ at: now, by: { user: true }, text: why });
  delete item.wanted;
  delete item.backGranted;
  item.stays = true;
}

/** Items an import renumbered whose own numbers were given back (`backGranted`), moved to them all
 * at once, so two can trade. One whose number another item here has waits while that one is asking
 * for its own (not asked again: settled when that one is); else it stays as it is, with a note, as
 * does a second one asking for the same number. What it used: the numbers they moved to (those
 * they left are no item's now, and an import here may give one back to the item it names). */
function restoreNumbers(book: Book, now: number): number[] {
  const back = book.items().filter(item => item.backGranted && item.wanted !== undefined && item.number !== undefined);
  if (!back.length) return [];
  const first = new Map<number, Item>();
  for (const item of back) if (!first.has(item.wanted!)) first.set(item.wanted!, item);
  const going = new Set(first.values());
  const holders = new Map<number, Item[]>();
  for (const item of book.items()) {
    const held = item.number ?? item.wanted;
    if (held !== undefined) holders.set(held, [...(holders.get(held) ?? []), item]);
  }
  const blocker = (item: Item): Item | undefined => (first.get(item.wanted!) !== item ? first.get(item.wanted!) : undefined)
    ?? (holders.get(item.wanted!) ?? []).find(each => each !== item && !going.has(each));
  for (let changed = true; changed;) {
    changed = false;
    for (const item of going) {
      if (!blocker(item)) continue;
      going.delete(item);
      changed = true;
    }
  }
  for (const item of back) {
    if (going.has(item)) continue;
    const holder = blocker(item)!;
    // (One that has it and is asking for its own: this one moves once that one has.)
    if (!holder.removed && !holder.stays && holder.number === item.wanted && holder.wanted !== undefined) continue;
    stays(item, `Its own number, #${item.wanted}, is another item's here, so it stays #${item.number}.`, now);
  }
  const used: number[] = [];
  for (const item of going) {
    item.notes.push({ at: now, by: { user: true }, text: `Has its own number, #${item.wanted}, again (it was #${item.number}).` });
    used.push(item.wanted!);
    item.number = item.wanted;
    delete item.wanted;
    delete item.importedAs;
    delete item.backGranted;
  }
  return used;
}

/** Items here still waiting for a number with nothing under way to give them one (a crash between
 * a block's coming and its use, or items a move brought), or asking for their own number back:
 * their claims asked again (on the primary, granted at once), and a block asked for those with
 * none; those given theirs back and waiting for another item to move are settled. What it did:
 * whether anything waited. */
export function reclaimWaiting(primary: Primary = primaryOf(), options: { file?: string; now?: number } = {}): boolean {
  const mine = allItems().filter(item => !item.source && !item.removed && OWNER.test(item.owner));
  const waiting = mine.filter(item => item.number === undefined || (item.wanted !== undefined && !item.backGranted));
  const settling = mine.some(item => item.backGranted && item.wanted !== undefined);
  if (!waiting.length && !settling) return false;
  const kept = readNumbers(options.file);
  const asked = kept.asking?.claims ?? [];
  const wanted = waiting.flatMap(item => (item.wanted !== undefined && !inRanges(asked, item.wanted) ? [item.wanted] : []));
  const restores = waiting.flatMap(item => (item.number !== undefined && item.wanted !== undefined && !inRanges(asked, item.wanted) ? [item.wanted] : []));
  if ("self" in primary) {
    const granted = wanted.length ? claimNumbers(primary, wanted, { ...options, restores }).granted : [];
    changeQueues(book => numberWaiting(book, primary, { granted: granted ?? [], claimed: rangesOf(wanted) }, options), undefined, { onItsOwn: true });
    return true;
  }
  if (wanted.length) claimNumbers(primary, wanted, { ...options, restores });
  else if (!kept.asking && !leftIn(kept.leases) && waiting.some(item => item.number === undefined)) changeNumbers(numbers => { numbers.asking ??= { id: askID(), count: BLOCK, since: options.now ?? Date.now() }; }, options.file);
  // (A lease left: numbered now.)
  if (leftIn(readNumbers(options.file).leases) || settling) changeQueues(book => numberWaiting(book, primary, null, options), undefined, { onItsOwn: true });
  return true;
}

// When this box last looked for items waiting with nothing under way: once a minute.
let lookedForWaiting = 0;

/** The ask under way sent to the primary, on this box's rounds (every few seconds), when it's due:
 * to the primary itself, or, one this box can't write to, through the peer that named it. */
export function pushNumbers(host: Pick<LinkHost, "send" | "welcomed"> | null | undefined, link: LinkState | null = readLink()): void {
  if (Date.now() - lookedForWaiting > 60_000) {
    lookedForWaiting = Date.now();
    try { notePrimaryNow(link); } catch {}
    try { reclaimWaiting(primaryOf(link)); } catch {}
  }
  if (!host?.welcomed || !link || !readNumbers().asking) return;
  const primary = primaryOf(link);
  if (!("peer" in primary)) return;
  const ask = askToSend();
  if (!ask) return;
  const bytes = mailFor(primary.via ?? primary.peer, { workQueue: { ask, ...(primary.via ? { to: primary.peer.key } : {}) }, at: Date.now() }, link);
  if (bytes) try { host.send(bytes); } catch {}
}

/** Numbers' mail from another box (`{workQueue: …}`): an ask, answered by the primary with its
 * block; a block given (only from this box's own primary, or the peer it asks through), kept, and
 * what waits here numbered. A box asked on behalf of its primary (`to`, by a peer that can't write
 * to it) passes the ask on (`for`), and the block back; one hop only. */
export function takeNumbersMail(sender: MailSender, given: unknown, host: Pick<LinkHost, "send"> | null | undefined): void {
  if (!isObject(given)) return;
  const link = readLink();
  const primary = primaryOf(link);
  const send = (to: MailSender | Peer, payload: unknown) => {
    const bytes = link && "address" in to && to.address ? mailFor(to, { workQueue: payload, at: Date.now() }, link) : null;
    if (bytes) try { host?.send(bytes); } catch {}
  };
  const peers = peersOf(link);
  if (isObject(given.ask)) {
    // (`for`: the box a peer passed this on for, which it heard from itself.)
    const asker = typeof given.for === "string" && KEY.test(given.for) ? given.for : sender.key;
    if ("self" in primary && (given.to === undefined || given.to === ownKey(link ?? {}))) {
      const block = giveBlock(asker, given.ask);
      if (block) send(sender, { give: block, ...(asker !== sender.key ? { for: asker } : {}) });
      return;
    }
    // On behalf of this box's primary, for a peer that can't write to it.
    if (given.for === undefined && typeof given.to === "string" && "peer" in primary && !primary.via && primary.peer.key === given.to) send(primary.peer, { ask: given.ask, for: sender.key });
    return;
  }
  if (!isObject(given.give) || !("peer" in primary)) return;
  const route = primary.via ?? primary.peer;
  // A block for the peer this box passed an ask on for: to it, from this box's own primary only.
  if (typeof given.for === "string" && given.for !== ownKey(link ?? {})) {
    const to = peers.find(each => each.key === given.for);
    if (to && !primary.via && sender.key === primary.peer.key) send(to, { give: given.give });
    return;
  }
  if (route.key === sender.key) blockArrived(given.give, primary);
}

/** A block from the primary, kept, and what waits here numbered with it (imports' wanted numbers
 * as granted): whether it answered the ask under way. */
export function blockArrived(give: unknown, primary: Primary, options: { file?: string } = {}): boolean {
  const answer = takeBlock(give, options);
  if (!answer) return false;
  changeQueues(book => numberWaiting(book, primary, answer, options), undefined, { onItsOwn: true });
  return true;
}
