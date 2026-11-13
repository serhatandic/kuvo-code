// Moving this Mac's box out of its app's folder to a home of its own (#333, PROTOCOL.md, "Moving
// this Mac's box"): what the move keeps where it can't be moved itself, in the home it moves to
// (`<home>/updates/rehome`, made first and never moved). Its state (`state.json`: how it stands,
// its tries, the next one, why it last failed, when the kept copy goes), its journal (`journal.json`
// and its acts, `journal.acts`), and its lock (`lock`). What `here`, the route and `rehome` read.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { processRuns } from "../../shared/platform";
import { locked } from "../files";
import { sleep } from "../../shared/wait";
import type { RehomeStatus, RehomeStep } from "../../shared/routes/box";

/** The move's folder in the home it moves to (`<home>/updates/rehome`). */
export const rehomeFolder = (home: string): string => path.join(home, "updates", "rehome");

/** The steps, in order (PROTOCOL.md, "Moving this Mac's box"). Before `clear`, a move that stops
 * goes back; from it on, it only goes forward. */
export const STEPS = ["plan", "install", "clone", "rewrite", "check", "place", "fix", "clear", "done"] as const satisfies readonly RehomeStep[];
export const stepIndex = (step: RehomeStep): number => STEPS.indexOf(step);
/** Whether `step` is past the point a stopped move goes back from. */
export const forwardOnly = (step: RehomeStep): boolean => stepIndex(step) >= stepIndex("clear");

/** How many tries a move gets by itself before it waits for Move Now, and how long after one fails
 * before the next. */
export const MOST_TRIES = 3;
export const AFTER_A_FAILURE = 3600_000;
/** How long a move waits for a quiet moment before the box says it's overdue (Move Now). */
export const OVERDUE_AFTER = 3 * 86_400_000;
/** How long the originals are kept after a move. */
export const KEPT_FOR = 30 * 86_400_000;

/** What `state.json` keeps (`kuvo/box/rehome` answers it, `RehomeStatus`), and the folders and
 * merges a move back needs. */
export interface RehomeRecord extends Partial<RehomeStatus> {
  /** The kept copies' folders, each deleted once `keptUntil` passes. */
  kept?: string[];
  /** What a move merged into a folder that was there (a session's files from the app's
   * `Attachments` into `attachments`, say): each as it was and where it went, for a move back. */
  merged?: { source: string; placed: string }[];
  /** The move whose failure its tries count (its journal's `began`): counted once. */
  counted?: number;
  /** Moved back: it moves again only on Move Now, until a move's done. */
  movedBack?: boolean;
  /** Where the old place is still named in what moved, but not where the box rewrites (people's and
   * agents' words, what's made anew as the box starts): said for support. */
  leftovers?: string[];
}

const stateFile = (home: string) => path.join(rehomeFolder(home), "state.json");

export function readRecord(home: string): RehomeRecord {
  try {
    const kept = JSON.parse(fs.readFileSync(stateFile(home), "utf8"));
    return isObject(kept) ? kept as RehomeRecord : {};
  } catch {
    return {};
  }
}

/** `state.json` changed: each field given, null taking it away where it's optional. */
export function noteRecord(home: string, change: Partial<RehomeRecord>): RehomeRecord {
  fs.mkdirSync(rehomeFolder(home), { recursive: true, mode: 0o700 });
  // (One change at a time, from the move, `--ready` and the route alike: none lost.)
  return locked(`${stateFile(home)}.lock`, () => {
    const next: RehomeRecord = { ...readRecord(home), ...change };
    writeSynced(stateFile(home), JSON.stringify(next, null, 1));
    return next;
  });
}

/** How the move stands, as `kuvo/box/rehome` says it (the journal's step while one's under way). */
export function rehomeStatus(home: string, now = Date.now()): RehomeStatus {
  const kept = readRecord(home);
  let journal: Journal | null = null;
  let unreadable = false;
  try { journal = readJournal(home); } catch { unreadable = true; }
  const underWay = journal !== null && journal.step !== "done" ? journal : null;
  const waitingSince = typeof kept.waitingSince === "number" ? kept.waitingSince : null;
  // (A record left saying it moves, with no journal: it stopped as it went back.)
  const recorded = kept.state === "moving" ? "failed" : kept.state ?? null;
  const state = unreadable ? "moving" : underWay ? (forwardOnly(underWay.step) ? "clearing" : "moving") : recorded;
  return {
    state,
    way: underWay ? underWay.way : kept.way ?? null,
    step: underWay ? underWay.step : null,
    tries: typeof kept.tries === "number" ? kept.tries : 0,
    nextTry: typeof kept.nextTry === "number" ? kept.nextTry : null,
    waitingSince,
    overdue: (state === "waiting" || state === "failed") && waitingSince !== null && now - waitingSince >= OVERDUE_AFTER,
    failed: unreadable ? { at: now, step: null, message: new UnreadableJournal().message } : kept.failed ?? null,
    movedAt: typeof kept.movedAt === "number" ? kept.movedAt : null,
    keptUntil: typeof kept.keptUntil === "number" ? kept.keptUntil : null,
    owed: Array.isArray(kept.owed) ? kept.owed : [],
    asked: kept.asked ?? null,
    from: kept.from ?? underWay?.from ?? null,
    to: kept.to ?? underWay?.to ?? null,
  };
}

// The journal

/** One thing a move did, journaled before it's done, so going back undoes exactly what was:
 * renamed (`from` → `to`; `source`, where it came from before it was staged), made (a folder or
 * file that wasn't there), written over (a file outside the box, `was` what it held: a git link),
 * or a Keychain item written (`was`, what it held, where there was one). */
export type Act =
  | { act: "rename"; from: string; to: string; source?: string; merged?: boolean }
  | { act: "made"; path: string; folder?: boolean }
  | { act: "wrote"; path: string; was: string }
  | { act: "keychain"; service: string; account: string; was?: string };

/** What moves where: each staged (`staged`, in the move's staging folder) from where it is
 * (`from`), then put in place (`to`). `run` takes its files but its processes' records. */
export interface Placement {
  from: string;
  to: string;
  staged: string;
  run?: boolean;
  /** Its files, installed rather than moved: never cleared. */
  installed?: boolean;
}

/** A move's journal (`journal.json`): which way (`move`: from the app's folder to a home of its
 * own; `back`), the step under way, both folders, its plan, and its kept copy's folder. */
export interface Journal {
  v: 1;
  way: "move" | "back";
  began: number;
  step: RehomeStep;
  from: string;
  to: string;
  placements: Placement[];
  /** What's cleared once it's in place: renamed into `kept`. */
  clearing: string[];
  kept: string;
  /** A move back's: the kept copy of the move it undoes, whose folders' modes it makes them with again. */
  keptBefore?: string;
  /** When it began to clone: what's changed since where it moves from (written there meanwhile)
   * only its copy would have, so it goes back. */
  clonedAt?: number;
  /** Keep This Mac Awake was off in the app: the box's own setting says so too. */
  keepsAwakeOff?: boolean;
}

const journalFile = (home: string) => path.join(rehomeFolder(home), "journal.json");
const actsFile = (home: string) => path.join(rehomeFolder(home), "journal.acts");

/** The journal, or null for none: one that's there but can't be read (cut short by a power cut, say)
 * throws, never read as none, since a move may be under way. */
export function readJournal(home: string): Journal | null {
  let text: string;
  try { text = fs.readFileSync(journalFile(home), "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new UnreadableJournal();
  }
  let kept: unknown;
  try { kept = JSON.parse(text); } catch { throw new UnreadableJournal(); }
  if (!isObject(kept) || kept.v !== 1 || typeof kept.step !== "string") throw new UnreadableJournal();
  return kept as unknown as Journal;
}

/** A journal that's there but can't be read: a move may be under way, which no one can finish. */
export class UnreadableJournal extends Error {
  constructor() {
    super("The move's journal can't be read: nothing is done until someone looks at it (updates/rehome/journal.json).");
  }
}

/** Whether a move is under way in `home` (a journal not done, or one that can't be read): what
 * `here` says first. */
export const moveUnderWay = (home: string): boolean => {
  try {
    const journal = readJournal(home);
    return journal !== null && journal.step !== "done";
  } catch {
    return true;
  }
};

/** The journal written whole, synced (its file, then its folder) before anything it says is done. */
export function writeJournal(home: string, journal: Journal): void {
  writeSynced(journalFile(home), JSON.stringify(journal, null, 1));
}

/** `text` in `file`, whole: written beside it and synced, renamed into place, its folder synced. */
function writeSynced(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  syncFolder(path.dirname(file));
}

export function forgetJournal(home: string): void {
  fs.rmSync(actsFile(home), { force: true });
  fs.rmSync(journalFile(home), { force: true });
  syncFolder(rehomeFolder(home));
}

/** Each act, one JSON line, synced before it's done (one cut short by a crash wasn't done). */
export function journalAct(home: string, act: Act): void {
  const fd = fs.openSync(actsFile(home), "a+", 0o600);
  try {
    // (After a line a crash cut short, on a line of its own.)
    const size = fs.fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const torn = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
    fs.writeSync(fd, (torn ? "\n" : "") + JSON.stringify(act) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readActs(home: string): Act[] {
  let text = "";
  try { text = fs.readFileSync(actsFile(home), "utf8"); } catch { return []; }
  const acts: Act[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const act = JSON.parse(line);
      if (isObject(act) && ["rename", "made", "wrote", "keychain"].includes(act.act as string)) acts.push(act as unknown as Act);
    } catch {}
  }
  return acts;
}

function syncFolder(folder: string): void {
  try {
    const fd = fs.openSync(folder, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {}
}

// The lock

const lockFolder = (home: string) => path.join(rehomeFolder(home), "lock");
const holderOf = (lock: string): number | null => {
  try {
    const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
};
// (A holder by its command line: `kuvo-link.js rehome`, or its source's.)
const holds = (pid: number) => pid === process.pid || processRuns(pid, "rehome");

/** Takes the move's lock once it's free (a holder that's gone leaves it free), saying once that it
 * waits (`waiting`); false once `most` ms have gone by. One held by this process is taken again. */
export async function takeLock(home: string, { waiting = () => {}, most = 30 * 60_000, clock = Date.now } = {}): Promise<boolean> {
  const lock = lockFolder(home);
  fs.mkdirSync(rehomeFolder(home), { recursive: true, mode: 0o700 });
  const began = clock();
  let said = false;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
      return true;
    } catch {}
    const holder = holderOf(lock);
    if (holder === process.pid) return true;
    if (holder !== null && !holds(holder)) {
      // A holder that's gone: its lock set aside whole (one rename, so only one taker gets it),
      // then given back if it turns out another had just taken it.
      const aside = `${lock}.gone.${process.pid}`;
      try {
        fs.renameSync(lock, aside);
        if (holderOf(aside) === holder) fs.rmSync(aside, { recursive: true, force: true });
        else try { fs.renameSync(aside, lock); } catch { fs.rmSync(aside, { recursive: true, force: true }); }
      } catch {}
      continue;
    }
    // (One just made, its holder not written yet, is a moment from being said.)
    if (holder === null) {
      try { if (clock() - fs.statSync(lock).mtimeMs > 60_000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
    }
    if (!said) {
      said = true;
      waiting();
    }
    if (clock() - began > most) return false;
    await sleep(200);
  }
}

/** Whether this process still holds the lock (checked before each step). */
export const holdsLock = (home: string): boolean => holderOf(lockFolder(home)) === process.pid;

export function giveLock(home: string): void {
  if (holdsLock(home)) fs.rmSync(lockFolder(home), { recursive: true, force: true });
}
