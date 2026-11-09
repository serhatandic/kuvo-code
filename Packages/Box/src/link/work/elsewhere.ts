// Rows from elsewhere (PROTOCOL.md, "Work", `rows`): the sessions on this box whose lead lives on
// another computer now (a bot that moved away, say) are told to that computer as they change, kept
// there in `run/work/elsewhere/<key>.json`, so its list_sessions has them, as of when they were
// told, while this one is asleep. A box pushes rather than waiting to be asked, so they're there
// before it sleeps; each goes again each minute until that box says it has it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { cut, plainName } from "../../shared/text";
import { listOf, locked, writePrivate } from "../files";
import { RUN } from "../home";
import { MOVES } from "../moves/records";
import { KEY, mailFor, ownKey, peersOf, removedBoxes } from "../peers/known";
import { awaySince } from "../peers/reach";
import { readPeerAgents } from "../peers/directory";
import { WORK_CHANGES, WORK_FOLDER } from "./changes";
import { homesOf, noteHomes } from "./homes";
import { describeWork, lineOf, startedByOf, workingNow, workSessions } from "./tree";
import type { Target } from "../../shared/records";
import type { WorkSession } from "../../shared/routes/work";
import type { LinkHost } from "../relay/host";
import type { LinkState } from "../state";

export const ELSEWHERE = path.join(WORK_FOLDER, "elsewhere");
const PUSHED = path.join(WORK_FOLDER, "pushed.json");
const LOCK = path.join(WORK_FOLDER, ".elsewhere.lock");

/** A session of a lead's, as it's told to the lead's computer: where it stands, and what it asks. */
export type Row = WorkSession & { askID?: string };

/** What a computer told of the sessions of leads that live here: as of when (`at`, its clock), when
 * it was heard (`heard`, this one's), and the rows of each lead, by the lead's address. */
export interface RowsKept {
  at: number;
  heard: number;
  leads: Record<string, Row[]>;
}

// How many rows of each lead go: as list_sessions shows them.
const ROWS_EACH = 40;
// The least time between two mails of rows to one computer: four a minute at most, however busy.
export const PUSH_SPACING = 15_000;
const STATES: readonly Row["state"][] = ["working", "asking", "finished", "failed", "stopped", "idle"];
const SESSION = /^ses_[A-Za-z0-9]{1,60}$/;

// A row as it came, cleaned: null for one that isn't.
function rowOf(given: unknown): Row | null {
  if (!isObject(given) || typeof given.session !== "string" || !SESSION.test(given.session) || !STATES.includes(given.state as Row["state"])) return null;
  const text = (value: unknown, most: number) => (typeof value === "string" ? cut(plainName(value), most) : "");
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const model = isObject(given.model) && typeof given.model.id === "string" && typeof given.model.providerID === "string"
    ? { id: text(given.model.id, 120), providerID: text(given.model.providerID, 120), ...(typeof given.model.variant === "string" ? { variant: text(given.model.variant, 60) } : {}) } : undefined;
  return {
    session: given.session,
    title: text(given.title, 200) || "New Session",
    folder: typeof given.folder === "string" ? given.folder.slice(0, 1000) : "",
    ...(text(given.project, 200) ? { project: text(given.project, 200) } : {}),
    startedBy: typeof given.startedBy === "string" && SESSION.test(given.startedBy) ? given.startedBy : "",
    depth: Math.max(1, Math.min(20, Math.floor(number(given.depth)) || 1)),
    ...(model ? { model } : {}),
    state: given.state as Row["state"],
    ...(given.state === "asking" && text(given.asks, 500) ? { asks: text(given.asks, 500) } : {}),
    ...(given.state === "asking" && typeof given.askID === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(given.askID) ? { askID: given.askID } : {}),
    started: number(given.started),
    tokens: number(given.tokens),
    ...(number(given.cost) ? { cost: number(given.cost) } : {}),
  };
}

const keptFile = (key: string) => path.join(ELSEWHERE, `${key}.json`);

/** What the computer `key` last told of leads here, or null. */
export function readRows(key: string): RowsKept | null {
  if (!KEY.test(key)) return null;
  try {
    const kept = JSON.parse(fs.readFileSync(keptFile(key), "utf8"));
    if (!isObject(kept) || typeof kept.at !== "number" || !isObject(kept.leads)) return null;
    return { at: kept.at, heard: typeof kept.heard === "number" ? kept.heard : kept.at, leads: kept.leads as Record<string, Row[]> };
  } catch {
    return null;
  }
}

/** Each computer's rows of `lead`'s sessions, by its key, with when they're as of. */
export function rowsOf(lead: string): { key: string; at: number; rows: Row[] }[] {
  const found: { key: string; at: number; rows: Row[] }[] = [];
  for (const name of listOf(ELSEWHERE)) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -5);
    const kept = readRows(key);
    const rows = kept?.leads[lead];
    if (kept && Array.isArray(rows) && rows.length) found.push({ key, at: kept.at, rows });
  }
  return found;
}

/** The rows every computer last told of any of `leads`' sessions, each session once. */
export function rowsOfLeads(leads: ReadonlySet<string>): Row[] {
  const found = new Map<string, Row>();
  for (const name of listOf(ELSEWHERE)) {
    if (!name.endsWith(".json")) continue;
    for (const [lead, rows] of Object.entries(readRows(name.slice(0, -5))?.leads ?? {})) {
      if (!leads.has(lead) || !Array.isArray(rows)) continue;
      for (const row of rows) if (row?.session && !found.has(row.session)) found.set(row.session, row);
    }
  }
  return [...found.values()];
}

// Where each lead here started sessions on other computers (`run/work/started-elsewhere.json`,
// `{lead: {key: at}}`): its list_sessions asks there at once, before that computer's first rows come.
const STARTED = path.join(WORK_FOLDER, "started-elsewhere.json");
const STARTED_FOR = 30 * 86_400_000;

/** That `lead` started a session on the computer `key` just now. */
export function noteStartedOn(lead: string, key: string, now = Date.now()): void {
  try {
    fs.mkdirSync(WORK_FOLDER, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const kept = readStarted();
      for (const [each, keys] of Object.entries(kept)) {
        for (const [at, when] of Object.entries(keys)) if (now - when > STARTED_FOR) delete keys[at];
        if (!Object.keys(keys).length) delete kept[each];
      }
      kept[lead] = { ...(kept[lead] ?? {}), [key]: now };
      writePrivate(STARTED, JSON.stringify(kept));
    });
  } catch {}
}

/** The computers `lead` started sessions on, in the last 30 days. */
export function startedOn(lead: string, now = Date.now()): string[] {
  return Object.entries(readStarted()[lead] ?? {}).filter(([, at]) => now - at <= STARTED_FOR).map(([key]) => key);
}

const readStarted = (): Record<string, Record<string, number>> => {
  try {
    const kept = JSON.parse(fs.readFileSync(STARTED, "utf8"));
    return isObject(kept) ? kept as Record<string, Record<string, number>> : {};
  } catch {
    return {};
  }
};

/** The computer whose rows name `session` (under any lead), or null. */
export function rowsBox(session: string): { key: string; row: Row } | null {
  for (const name of listOf(ELSEWHERE)) {
    if (!name.endsWith(".json")) continue;
    const key = name.slice(0, -5);
    for (const rows of Object.values(readRows(key)?.leads ?? {})) {
      const row = Array.isArray(rows) ? rows.find(each => each?.session === session) : undefined;
      if (row) return { key, row };
    }
  }
  return null;
}

/** What a computer, `sender`, says of the sessions of leads that live here (`{rows: {id, at, leads}}`):
 * kept, if it's newer than what it said before; and the sessions it names live there. True for any
 * that's whole (an older one is had, too, so it isn't sent again), false for one that isn't. */
export function takeRows(sender: { key: string }, given: unknown, now = Date.now()): boolean {
  if (!isObject(given) || typeof given.at !== "number" || !isObject(given.leads)) return false;
  const at = Math.min(given.at, now);
  const leads: Record<string, Row[]> = {};
  for (const [lead, rows] of Object.entries(given.leads).slice(0, 50)) {
    if (!SESSION.test(lead) || !Array.isArray(rows)) continue;
    const cleaned = rows.slice(0, ROWS_EACH).map(rowOf).filter((row): row is Row => row !== null);
    if (cleaned.length) leads[lead] = cleaned;
  }
  let taken = false;
  try {
    fs.mkdirSync(ELSEWHERE, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const kept = readRows(sender.key);
      if (kept && kept.at > at) return;
      taken = true;
      if (!Object.keys(leads).length) fs.rmSync(keptFile(sender.key), { force: true });
      else writePrivate(keptFile(sender.key), JSON.stringify({ at, heard: now, leads } satisfies RowsKept));
    });
  } catch {}
  if (taken) noteHomes(Object.values(leads).flat().map(row => row.session), sender.key, at);
  return true;
}

/** What this box last told each computer (`run/work/pushed.json`): the rows' id, whether that
 * computer said it has them, and when they last went. */
interface Pushed {
  id: string;
  done: boolean;
  sent: number;
}
const readPushed = (): Record<string, Pushed> => {
  try {
    const kept = JSON.parse(fs.readFileSync(PUSHED, "utf8"));
    return isObject(kept) ? kept as Record<string, Pushed> : {};
  } catch {
    return {};
  }
};
const changePushed = (change: (pushed: Record<string, Pushed>) => void): void => {
  try {
    fs.mkdirSync(WORK_FOLDER, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const pushed = readPushed();
      change(pushed);
      writePrivate(PUSHED, JSON.stringify(pushed));
    });
  } catch {}
};

/** The computer `sender` says it has the rows `id`: they don't go again until they change. */
export function rowsWent(sender: { key: string }, id: string): void {
  if (!/^rws_[A-Za-z0-9_-]{6,60}$/.test(id) || readPushed()[sender.key]?.id !== id) return;
  changePushed(pushed => {
    if (pushed[sender.key]?.id === id) pushed[sender.key] = { ...pushed[sender.key]!, done: true };
  });
}

/** The rows of this box's sessions whose lead lives on another computer, by that computer and lead:
 * each session's leads are the first conversation above it, up its starters, that isn't here, and
 * those in its line that aren't, each that lives elsewhere, as this box knows it (`homesOf`). */
export async function rowsElsewhere(targets: Target[], link: LinkState | null, signal?: AbortSignal): Promise<Map<string, Record<string, Row[]>>> {
  const out = new Map<string, Record<string, Row[]>>();
  const own = ownKey(link ?? {});
  const homes = homesOf(link);
  if (![...homes.values()].some(key => key !== own)) return out;
  const all = await workSessions(targets, signal, { whole: true });
  const byID = new Map(all.map(each => [each.data.id, each]));
  const working = await workingNow(targets, signal);
  for (const each of all) {
    // Its leads elsewhere: the first conversation up its starters that isn't here, and any in its
    // line (or its starters' lines) that lives elsewhere, so a lead whose line crosses computers
    // (A to B to C) hears of it from C too.
    const above = new Set<string>();
    let at: (typeof all)[number] | undefined = each;
    for (let step = 0; at && step < 20; step++) {
      for (const session of lineOf(at.data)) if (!byID.has(session)) above.add(session);
      const starter = startedByOf(at.data);
      if (!starter) break;
      if (!byID.has(starter)) above.add(starter);
      at = byID.get(starter);
    }
    let row: Row | null = null;
    for (const lead of above) {
      const key = homes.get(lead);
      if (!key || key === own) continue;
      const leads = out.get(key) ?? {};
      const rows = (leads[lead] ??= []);
      if (rows.length >= ROWS_EACH) continue;
      row ??= rowOf(await describeWork(each, working, { signal }))!;
      rows.push(row);
      out.set(key, leads);
    }
  }
  return out;
}

// When rows were last worked out, and what had changed by then (the work's and the moves' files),
// so they're worked out again as soon as either changes, and each minute otherwise.
let lastLook = -Infinity;
let lastMarks = "";
const marks = () => [WORK_CHANGES, path.join(MOVES, "moved.json"), path.join(RUN, "work", "homes.json")].map(file => {
  try { return String(fs.statSync(file).mtimeMs); } catch { return "-"; }
}).join(" ");
let pushing = false;

/** The rows of leads elsewhere, told to the computer each lives on (one that takes them, `work.elsewhere`)
 * when they change (once in 15 seconds at most), and again each minute until it says it has them;
 * a computer told of some before that has none now is told that once. Nothing goes while nothing
 * changed and it has them. Looked at each round (`sendOutbox`'s), worked out again only when
 * something changed or a minute went by. */
export async function pushRows(host: Pick<LinkHost, "send">, link: LinkState | null, targets: Target[], now = Date.now(), { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!link?.key || pushing) return;
  const changedMarks = marks();
  if (!force && changedMarks === lastMarks && now - lastLook < 60_000) return;
  pushing = true;
  try {
    let rows: Map<string, Record<string, Row[]>>;
    try {
      rows = await rowsElsewhere(targets, link);
    } catch {
      // (Its engine can't say now: as they were, until it can.)
      return;
    }
    lastLook = now;
    lastMarks = changedMarks;
    const pushed = readPushed();
    const told = readPeerAgents();
    // What's kept of computers you removed goes: theirs, and what was told them.
    const removed = removedBoxes(link);
    for (const key of removed) fs.rmSync(keptFile(key), { force: true });
    if (Object.keys(pushed).some(key => removed.has(key))) changePushed(all => { for (const key of removed) delete all[key]; });
    for (const peer of peersOf(link)) {
      // Not to one that isn't answering: what's changed goes once it's back (`rowsBack`).
      if (awaySince(peer.key) !== null) continue;
      const leads = rows.get(peer.key) ?? {};
      const before = pushed[peer.key];
      // Nothing for it, and nothing told it before: nothing to say.
      if (!Object.keys(leads).length && (!before || (before.done && before.id === idOf({})))) continue;
      if (!(told[peer.key]?.features ?? []).includes("work.elsewhere")) continue;
      const id = idOf(leads);
      if (before?.id === id && (before.done || now - before.sent < 60_000)) continue;
      // A busy box tells one computer once in PUSH_SPACING at most: worked out again next round
      // until it may.
      if (before && now - before.sent < PUSH_SPACING) {
        lastMarks = "";
        continue;
      }
      // As many of each lead's as fit in one mail, the latest first.
      let bytes: Buffer | null = null;
      for (const most of [ROWS_EACH, 20, 10, 4]) {
        const fitted = Object.fromEntries(Object.entries(leads).map(([lead, each]) => [lead, each.slice(0, most)]));
        bytes = mailFor(peer, { rows: { id, at: now, leads: fitted }, at: now }, link);
        if (bytes) break;
      }
      if (!bytes) continue;
      try { host.send(bytes); } catch {}
      changePushed(all => { all[peer.key] = { id, done: false, sent: now }; });
    }
  } finally {
    pushing = false;
  }
}

/** A computer answers again: rows are worked out and told at the next round. */
export function rowsBack(): void {
  lastMarks = "";
}

// The rows' id: the same while they're the same.
const idOf = (leads: Record<string, Row[]>): string => "rws_" + crypto.createHash("sha256").update(JSON.stringify(leads)).digest("base64url").slice(0, 22);
