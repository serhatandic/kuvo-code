// `kuvo-link.js rehome`: this Mac's box moved out of its app's folder into a home of its own,
// `~/.kuvo-code`, laid out as a machine's (#333 §3, PROTOCOL.md, "Moving this Mac's box"); and back.
// The box's own command: the keeper only stops what runs before and starts it after.
//
// Each step journaled in the home it moves to (`updates/rehome`, state.ts), one move at a time (its
// lock). Until it clears the old place, a failure or a crash goes back: what it did undone in
// reverse, so the old box is as it was. From then on it only goes forward. Folders are cloned (APFS
// clones: moments, almost no room), never copied, and the originals are kept 30 days.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { processRuns } from "../../shared/platform";
import type { RehomeStatus, RehomeStep } from "../../shared/routes/box";
import { readAsks } from "../areas/asks";
import { listOf, writePrivate } from "../files";
import { IN_TEST_FOLDER, accountHome, homeFolder, located } from "../home";
import { foundAt, runsAt } from "../setup/judge";
import { agentsWorking } from "../updates/update";
import { BRIDGE_VERSION } from "../version";
import { setKeepsAwake } from "../work/settings";
import { NO_REWRITE, pathMap, type Rewriter } from "./rewrite";
import {
  AFTER_A_FAILURE, KEPT_FOR, MOST_TRIES, forgetJournal, forwardOnly, giveLock, holdsLock, journalAct, noteRecord, readActs, readJournal,
  moveUnderWay, readRecord, rehomeFolder, rehomeStatus, stepIndex, takeLock, writeJournal, type Act, type Journal, type Placement,
} from "./state";

/** What's beside the box in its app's folder that moves into its home, by the name it has there
 * (`<home>/<name>`) and where it is in the app's folder: the engine's own folders (its data,
 * settings, state, cache and workspace), its versions, integrations' data, bots, wake-ups, group
 * chats, chats, the coding agents' bridge's folder, and the app's record of its machines' bridges. */
export const BESIDE: readonly (readonly [string, string])[] = [
  ["data", "opencode/data"], ["config", "opencode/config"], ["state", "opencode/state"], ["cache", "opencode/cache"], ["workspace", "opencode/workspace"],
  ["engine", "engine"], ["integrations", "integrations"], ["bots", "bots"], ["wakes", "wakes"], ["groups", "groups"], ["chats", "Chats"],
  ["agents", "agents"], ["phone-link.json", "phone-link.json"],
];
/** The files the app's sessions sent (`Attachments`), merged with the box's own (`attachments`). */
const APP_ATTACHMENTS = "Attachments";
/** Its processes' records in `run`, made anew where it runs next (and the record of the last start
 * in the app's folder, `served.json`): never moved. */
export const PROCESS_RECORD = /^(keeper\..*|serve\.json|served\.json|host\.json|engine\.json|bridge\.json|link\.(pid|version|needed)|box\.(pid|lock)|.*\.pid|.*\.lock|\.updating|socket\.key|\.system-asking|engine-(output|stopped)|engine\.retry|agents-stopped|update-(trial|restore))$/;
/** What says the app's box started (`serve`, `run/served.json`): the app's version and the link's,
 * so a move waits for the upgrades a newer app runs as its box starts. */
export const SERVED_FILE = "served.json";

/** What a move back says with nothing moved. */
const NOT_MOVED = "This Mac's box hasn't moved: there's nothing to move back.";
/** What a box that's in its own home says to a move: a machine's, on Linux. */
export const NOTHING_TO_MOVE = "This machine's box is in its own home already: there's nothing to move.";

const exists = (file: string): boolean => {
  try { fs.lstatSync(file); return true; } catch { return false; }
};
const inside = (file: string, folder: string) => file !== folder && file.startsWith(folder + "/");

// A crash at a named point, for a test's folder alone (`KUVO_TEST_REHOME_STOP`): killed at once, as
// a power cut or a kill would, with nothing after it run.
// And, for a test, something written there meanwhile (`KUVO_TEST_REHOME_WRITE_AT`, `…_FILE`, `…_TEXT`),
// as the app or a process that started would.
function stopPoint(point: string): void {
  if (!IN_TEST_FOLDER) return;
  if (process.env.KUVO_TEST_REHOME_WRITE_AT === point && process.env.KUVO_TEST_REHOME_WRITE_FILE) {
    fs.mkdirSync(path.dirname(process.env.KUVO_TEST_REHOME_WRITE_FILE), { recursive: true });
    fs.writeFileSync(process.env.KUVO_TEST_REHOME_WRITE_FILE, process.env.KUVO_TEST_REHOME_WRITE_TEXT ?? "");
  }
  if (process.env.KUVO_TEST_REHOME_STOP === point) process.kill(process.pid, "SIGKILL");
}

// Running

const pidIn = (file: string): number | null => {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").trim(); } catch { return null; }
  let pid: unknown = Number(text);
  if (!Number.isInteger(pid)) try { const record = JSON.parse(text); pid = isObject(record) ? record.pid : null; } catch { return null; }
  return Number.isInteger(pid) && (pid as number) > 1 ? pid as number : null;
};

/** What runs from a box's `run` folder: its engine, coding agents' bridge, `serve`, link and keeper
 * (`box.pid`, `kuvo-start`), by their records; `keeper` too where it's asked of. */
export function runningIn(run: string, { keeper = true } = {}): string[] {
  const records: [string, string, string][] = [["engine.json", "opencode", "its engine"], ["bridge.json", "kuvo-agents", "its coding agents' bridge"],
    ["serve.json", "kuvo-link", "its server"], ["link.pid", "kuvo-link", "its link"], ...(keeper ? [["box.pid", "kuvo-start", "its keeper"] as [string, string, string]] : [])];
  return records.filter(([file, name]) => {
    const pid = pidIn(path.join(run, file));
    return pid !== null && processRuns(pid, name);
  }).map(([, , what]) => what);
}

// Disks

const ran = (command: string, args: string[], timeout = 120_000) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}`, errors: `${result.stderr ?? ""}` };
};
/** The nearest folder of `file` that's there. */
const nearest = (file: string): string => {
  let folder = file;
  while (!exists(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
  return folder;
};
/** The kind of disk `folder` is on (`apfs`, `hfs`, …), by its mount, or null. */
function diskKind(folder: string): string | null {
  const df = ran("/bin/df", ["-P", folder]).output.trim().split("\n").pop()?.trim().split(/\s+/);
  const mount = df && df.length >= 6 ? df.slice(5).join(" ") : null;
  if (!mount) return null;
  for (const line of ran("/sbin/mount", []).output.split("\n")) {
    const found = / on (.+) \(([^,)]+)/.exec(line);
    if (found && found[1] === mount) return found[2];
  }
  return null;
}
/** Free bytes on `folder`'s disk (a test's folder may say, `KUVO_TEST_REHOME_FREE`). */
function freeBytes(folder: string): number | null {
  if (IN_TEST_FOLDER && process.env.KUVO_TEST_REHOME_FREE) return Number(process.env.KUVO_TEST_REHOME_FREE);
  const free = Number(ran("/bin/df", ["-Pk", folder]).output.trim().split("\n").pop()?.trim().split(/\s+/)[3]);
  return Number.isFinite(free) ? free * 1024 : null;
}
const sizeOf = (file: string) => { try { return fs.statSync(file).size; } catch { return 0; } };

// The plan

/** A box's folders, as a move goes: the app's (`appFolder`, where its box is `box`) and its home of its own. */
export interface Folders {
  appFolder: string;
  home: string;
}

const staging = (home: string) => path.join(rehomeFolder(home), "staging");
const stamp = (at: number) => new Date(at).toISOString().replace(/[:.]/g, "-");

/** What moves from the app's folder (#333 §2.1): the box's own folder's entries to the same names
 * in its home (`run` without its processes' records; never `bin`, which comes from its release),
 * what's beside it to its place there, and the app's sent files merged into `attachments`; then its
 * release's `bin`. Cleared after: the app's box folder and the engine's whole, and each other. */
export function planMove({ appFolder, home }: Folders, release: string): Pick<Journal, "placements" | "clearing"> {
  const box = path.join(appFolder, "box");
  const placements: Placement[] = [];
  const stage = (name: string) => path.join(staging(home), `${placements.length}-${name}`);
  for (const name of listOf(box).sort()) {
    if (name === "bin") continue;
    placements.push({ from: path.join(box, name), to: path.join(home, name), staged: stage(name), ...(name === "run" ? { run: true } : {}) });
  }
  for (const [name, there] of BESIDE) {
    const from = path.join(appFolder, there);
    if (exists(from)) placements.push({ from, to: path.join(home, name), staged: stage(name) });
  }
  if (exists(path.join(appFolder, APP_ATTACHMENTS))) placements.push({ from: path.join(appFolder, APP_ATTACHMENTS), to: path.join(home, "attachments"), staged: stage("attachments") });
  placements.push({ from: path.join(release, "bin"), to: path.join(home, "bin"), staged: stage("bin"), installed: true });
  const clearing = [box, path.join(appFolder, "opencode"), ...BESIDE.filter(([, there]) => !there.startsWith("opencode/")).map(([, there]) => path.join(appFolder, there)),
    path.join(appFolder, APP_ATTACHMENTS)].filter(exists);
  return { placements, clearing };
}

/** A move back (`--back`), from the box's home as it is now to its app's folder: what the move merged
 * back where it came from first, then each entry of its home to its place there (`updates` an
 * entry at a time, never the move's own folder; never `bin`, which is cleared with the rest). */
export function planBack({ appFolder, home }: Folders, merged: { source: string; placed: string }[] = []): Pick<Journal, "placements" | "clearing"> {
  const box = path.join(appFolder, "box");
  const placements: Placement[] = [];
  const stage = (name: string) => path.join(staging(home), `${placements.length}-${name}`);
  for (const { source, placed } of merged) {
    if (inside(placed, home) && inside(source, appFolder) && exists(placed)) placements.push({ from: placed, to: source, staged: stage(path.basename(placed)) });
  }
  const beside = new Map(BESIDE);
  // (Each once: what went back where it came from already isn't sent again.)
  const add = (from: string, to: string, run = false) => {
    if (!placements.some(each => each.from === from)) placements.push({ from, to, staged: stage(path.basename(from)), ...(run ? { run: true } : {}) });
  };
  for (const name of listOf(home).sort()) {
    if (name === "bin") continue;
    // (`updates` an entry at a time, never the move's own; `trash` so too, never an earlier box the
    // move set aside there, which stays where it was.)
    if (name === "updates" || name === "trash") {
      for (const each of listOf(path.join(home, name)).sort()) {
        if (each !== "rehome" && !each.startsWith("earlier-box-")) add(path.join(home, name, each), path.join(box, name, each));
      }
      continue;
    }
    const there = beside.get(name);
    add(path.join(home, name), there ? path.join(appFolder, there) : path.join(box, name), name === "run");
  }
  const sources = placements.map(each => each.from);
  const clearing = [...sources.filter(each => !sources.some(other => inside(each, other))), path.join(home, "bin")].filter(exists);
  return { placements, clearing };
}

/** Why the move can't go ahead now, or null: checked as it's planned, before anything changes. */
export function moveRefusal({ appFolder, home }: Folders, { appVersion, release, bridgeVersion = BRIDGE_VERSION, rewriter = NO_REWRITE, running: checkRunning = true }: { appVersion: string | null; release: string | null | undefined; bridgeVersion?: string; rewriter?: Rewriter; running?: boolean }): string | null {
  if (process.platform !== "darwin") return NOTHING_TO_MOVE;
  const box = path.join(appFolder, "box");
  const state = readRecord(home);
  if (state.state === "done" && state.way !== "back") return "This Mac's box has moved already.";
  // The old box started once since the app updated: the upgrades a newer app runs as its box starts
  // have run (its bots' jobs taken, say).
  let served: unknown = null;
  try { served = JSON.parse(fs.readFileSync(path.join(box, "run", SERVED_FILE), "utf8")); } catch {}
  if (!isObject(served) || served.bridge !== bridgeVersion || (appVersion !== null && served.app !== appVersion)) {
    return "This Mac's box hasn't started since Kuvo Code updated: it moves once it has.";
  }
  // (Asked whether it's ready, the box runs: the keeper stops it before it moves.)
  const running = checkRunning ? runningIn(path.join(box, "run"), { keeper: false }) : [];
  if (running.length) return `Something is running in this Mac's box (${running.join(", ")}): it moves once that's stopped.`;
  // (Asked whether it's ready, the files may not be said yet.)
  // (A copy of the app, a demo's or a test's, never moves into the real one's home.)
  if (located(home) === located(path.join(accountHome(), ".kuvo-code")) && path.basename(appFolder) !== "run.kuvo.code") return "Only Kuvo Code itself moves its box into ~/.kuvo-code: a copy moves into a home of its own.";
  const fileAt = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (release !== undefined && (!release || !fileAt(path.join(release, "bin", "kuvo-start")) || !fileAt(path.join(release, "bin", "kuvo-link.js")))) {
    return "The box's own files to put in its new home weren't given.";
  }
  // A box already in its home (#333 §3.7): no move, both keep running as they are. One its Mac
  // removed is set aside first.
  const there = runsAt(home);
  if (there !== "gone" && (there === "running" || foundAt(home, false) !== null)) return "There's a box in this Mac's ~/.kuvo-code already: both keep running as they are.";
  if (runningIn(path.join(home, "run")).length) return "Something is running in this Mac's ~/.kuvo-code: it moves once that's stopped.";
  // One disk, cloned: never copied.
  const target = nearest(home);
  if (fs.statSync(appFolder).dev !== fs.statSync(target).dev || diskKind(appFolder) !== "apfs") return "Kuvo Code can't move its box on this disk.";
  // Room for what's rewritten: the engine's database and its journal, and some to spare.
  const database = path.join(appFolder, "opencode", "data", "opencode");
  const needed = (sizeOf(path.join(database, "opencode.db")) + sizeOf(path.join(database, "opencode.db-wal"))) * 1.1 + 200_000_000;
  const free = freeBytes(target);
  if (free !== null && free < needed) return `There isn't room to move this Mac's box: it needs ${Math.ceil(needed / 1_000_000)} MB free.`;
  const plan = planMove({ appFolder, home }, release ?? path.join(home, "bin"));
  return rewriter.refuses(plan.placements, pathMap(plan.placements));
}

/** Why a move back can't go ahead now, or null. */
export function backRefusal({ appFolder, home }: Folders, { running: checkRunning = true } = {}): string | null {
  if (process.platform !== "darwin") return NOTHING_TO_MOVE;
  const state = readRecord(home);
  if (state.state !== "done" || state.way !== "move") return NOT_MOVED;
  // (Its keeper, which runs the move back, aside.)
  const running = checkRunning ? runningIn(path.join(home, "run"), { keeper: false }) : [];
  if (running.length) return `Something is running in this Mac's box (${running.join(", ")}): it moves back once that's stopped.`;
  const old = path.join(appFolder, "box", "run");
  if (["setup-card.json", "link.json"].some(file => exists(path.join(old, file))) || runningIn(old).length) return "Kuvo Code has a box of its own in its folder again: this one can't move back beside it.";
  if (!exists(appFolder) || fs.statSync(appFolder).dev !== fs.statSync(home).dev) return "Kuvo Code can't move its box back on this disk.";
  return null;
}

// Doing it

/** `act` journaled, then done. */
function rename(home: string, from: string, to: string, extra: Partial<Extract<Act, { act: "rename" }>> = {}): void {
  journalAct(home, { act: "rename", from, to, ...extra });
  fs.renameSync(from, to);
}

/** `folder` and those above it that aren't there, made, each journaled (taken away again going back
 * where they're empty). */
function madeFolder(home: string, folder: string, like: (folder: string) => string | null = () => null): void {
  if (exists(folder)) return;
  madeFolder(home, path.dirname(folder), like);
  journalAct(home, { act: "made", path: folder, folder: true });
  fs.mkdirSync(folder, { mode: 0o700 });
  // (As the one it stands for was, where there was one: a move back's, as the app made it.)
  const was = like(folder);
  if (was) try { fs.chmodSync(folder, fs.statSync(was).mode & 0o7777); } catch {}
}

/** Where a folder a move back makes in the app's folder was before the move: in the move's kept
 * copy, if it's there. */
const keptLike = (journal: Journal) => (folder: string): string | null => {
  if (journal.way !== "back" || !journal.keptBefore || !inside(folder, journal.to)) return null;
  const was = path.join(journal.keptBefore, path.relative(journal.to, folder));
  return exists(was) ? was : null;
};

/** The first file in `files` (or in their folders) changed since `since` (ms), or null: by a file's
 * status time, which a write, a rename into its folder or a change of its mode moves. In `run`, the
 * box's processes' records (never moved) and the folder itself, which they're written into, aside. */
function changedSince(files: string[], since: number, run: string): string | null {
  const walk = (file: string): string | null => {
    if (path.dirname(file) === run && PROCESS_RECORD.test(path.basename(file))) return null;
    let kind: fs.Stats;
    try { kind = fs.lstatSync(file); } catch { return null; }
    if (kind.ctimeMs >= since && file !== run) return file;
    if (!kind.isDirectory()) return null;
    for (const name of listOf(file)) {
      const found = walk(path.join(file, name));
      if (found) return found;
    }
    return null;
  };
  for (const file of files) {
    const found = walk(file);
    if (found) return found;
  }
  return null;
}

/** A free name beside `file` for one that's there already ("name 2.ext", …). */
function freeName(file: string): string {
  const extension = path.extname(file), base = file.slice(0, file.length - extension.length);
  for (let n = 2; ; n++) if (!exists(`${base} ${n}${extension}`)) return `${base} ${n}${extension}`;
}

/** What's staged at `from`, put at `to`: renamed whole where nothing's there, else merged entry by
 * entry, a name in both keeping both: the one that was there keeps its name, or, where what's put
 * there `wins` (a move back: the box's live file over one the app made meanwhile), the one put
 * there. Each rename journaled with where it came from (`source`). */
function place(home: string, from: string, to: string, source: string, wins: boolean, merged = false): void {
  if (exists(to) && fs.lstatSync(from).isDirectory() && fs.lstatSync(to).isDirectory()) {
    for (const name of listOf(from).sort()) place(home, path.join(from, name), path.join(to, name), path.join(source, name), wins, true);
    return;
  }
  const clash = exists(to);
  if (!clash) rename(home, from, to, { source, merged });
  else if (!wins) rename(home, from, freeName(to), { source, merged: true });
  else {
    rename(home, to, freeName(to));
    rename(home, from, to, { source, merged: true });
  }
  // (Part way through merging one folder into another.)
  if (merged || clash) stopPoint("in-merge");
}

/** As long as a clone may take: hours, for a box of millions of files, never a clone that hangs for
 * good (with the box stopped). */
const CLONE_LIMIT = 6 * 3600_000;

/** `from` cloned to `to` (`cp -c`: APFS clones, links as links; a socket isn't a file and stays);
 * `installed` files copied, from wherever they are. */
function clone(from: string, to: string, installed = false): void {
  // (The box's files whole, links followed: from the app, wherever it is.)
  const result = ran("/bin/cp", [installed ? "-RLp" : "-cRPp", from, to], CLONE_LIMIT);
  if (result.status !== 0) throw new Error(`${from} couldn't be cloned: ${result.errors.trim().slice(0, 300)}`);
}

/** Each placement cloned into staging: `run` without its processes' records; what moves apart from
 * a folder it's in, taken out of that folder's copy. */
function cloneAll(journal: Journal): void {
  const folder = staging(homeOf(journal));
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const placement of journal.placements) {
    if (!exists(placement.from)) continue;
    if (placement.run) {
      fs.mkdirSync(placement.staged, { mode: 0o700 });
      fs.chmodSync(placement.staged, fs.statSync(placement.from).mode & 0o7777);
      for (const name of listOf(placement.from)) {
        const file = path.join(placement.from, name);
        const kind = fs.lstatSync(file);
        if (PROCESS_RECORD.test(name) || !(kind.isFile() || kind.isDirectory() || kind.isSymbolicLink())) continue;
        clone(file, path.join(placement.staged, name));
      }
    } else {
      clone(placement.from, placement.staged, placement.installed);
    }
    // The box's files: with those the app put in its box's `bin` that its release doesn't bring
    // (its catalog of servers, its bots' words), as the box reads them there.
    if (placement.installed && journal.way === "move") {
      const old = path.join(journal.from, "box", "bin");
      for (const name of listOf(old)) {
        const kind = fs.lstatSync(path.join(old, name));
        if (!exists(path.join(placement.staged, name)) && (kind.isFile() || kind.isDirectory())) clone(path.join(old, name), path.join(placement.staged, name));
      }
    }
    for (const other of journal.placements) {
      if (inside(other.from, placement.from)) fs.rmSync(path.join(placement.staged, path.relative(placement.from, other.from)), { recursive: true, force: true });
    }
  }
}

/** The box's own files, after what was cloned: never its kind (written last, on a move; taken out of
 * what goes back), nor on a move back the files its keys were written to from your Keychain, which
 * the app writes for itself in its folder (`KUVO_KEYS`). */
function settleBoxFiles(journal: Journal): void {
  const { appFolder, home } = foldersOf(journal);
  const box = journal.placements.find(each => each.to === (journal.way === "move" ? path.join(home, "box") : path.join(appFolder, "box", "box")));
  if (!box || !exists(box.staged)) return;
  fs.rmSync(path.join(box.staged, "kind"), { force: true });
  if (journal.way === "back") for (const name of ["keys", "bot-keys"]) fs.rmSync(path.join(box.staged, name), { recursive: true, force: true });
}

/** Undoes every act journaled, last first (each only where it was done), then the staging folder:
 * the old box as it was. Done again from the start if it's cut short (the journal goes after). */
function undo(journal: Journal): void {
  const home = homeOf(journal);
  let undone = 0;
  for (const act of readActs(home).reverse()) {
    if (act.act === "rename") {
      if (exists(act.to) && !exists(act.from)) {
        fs.mkdirSync(path.dirname(act.from), { recursive: true, mode: 0o700 });
        fs.renameSync(act.to, act.from);
        if (++undone === 1) stopPoint("in-undo");
      }
    } else if (act.folder) {
      try { fs.rmdirSync(act.path); } catch {}
    } else {
      fs.rmSync(act.path, { force: true });
    }
  }
  fs.rmSync(staging(home), { recursive: true, force: true });
}

/** Where a move back's folders are, by the journal: the app's (`from` on a move) and the box's home. */
const foldersOf = (journal: Journal): Folders => (journal.way === "move" ? { appFolder: journal.from, home: journal.to } : { appFolder: journal.to, home: journal.from });

/** The journal's own folder (always the box's home, whichever way it goes). */
const homeOf = (journal: Journal) => foldersOf(journal).home;

function stepTo(journal: Journal, step: RehomeStep): void {
  if (!holdsLock(homeOf(journal))) throw new LockLost("Another move took its lock.");
  // (The step it's at once the journal says so, never before.)
  writeJournal(homeOf(journal), { ...journal, step });
  journal.step = step;
}

/** Its steps from where the journal is, to the end (a failure before `clear` throws, for the move to
 * go back). */
function carryOn(journal: Journal, rewriter: Rewriter): void {
  // (The journal's acts are always in the box's home, `home`; renames go between both folders.)
  const home = homeOf(journal);
  const map = pathMap(journal.placements);
  const from = stepIndex(journal.step);
  const at = (step: RehomeStep) => stepIndex(step) >= from;
  if (at("install")) {
    stepTo(journal, "install");
    if (journal.way === "move") {
      // What's in its home that isn't a box (#333 §3.7: a box its Mac removed, or what was left),
      // set aside in its trash first, nothing deleted.
      const aside = path.join(home, "trash", `earlier-box-${stamp(journal.began)}`);
      const there = listOf(home).filter(name => name !== "updates").map(name => path.join(home, name))
        .concat(listOf(path.join(home, "updates")).filter(name => name !== "rehome").map(name => path.join(home, "updates", name)));
      for (const file of there.sort()) {
        if (file === path.join(home, "trash") || !exists(file)) continue;
        madeFolder(home, path.dirname(path.join(aside, path.relative(home, file))));
        rename(home, file, path.join(aside, path.relative(home, file)));
      }
      // (The trash it was in, set aside as well, once it's empty of all but that.)
      const trash = path.join(home, "trash");
      for (const name of listOf(trash).filter(name => path.join(trash, name) !== aside)) {
        madeFolder(home, path.join(aside, "trash"));
        rename(home, path.join(trash, name), path.join(aside, "trash", name));
      }
    }
    stopPoint("after-install");
  }
  if (at("clone")) {
    journal.clonedAt = Date.now();
    stepTo(journal, "clone");
    cloneAll(journal);
    settleBoxFiles(journal);
    stopPoint("after-clone");
  }
  if (at("rewrite")) {
    stepTo(journal, "rewrite");
    rewriter.rewrite(journal.placements, map);
    stopPoint("after-rewrite");
  }
  if (at("check")) {
    stepTo(journal, "check");
    for (const placement of journal.placements) {
      if (exists(placement.from) && !exists(placement.staged)) throw new Error(`${placement.from} wasn't staged.`);
    }
    if (journal.way === "move" && !exists(path.join(journal.placements.find(each => each.installed)!.staged, "kuvo-start"))) throw new Error("The box's own files weren't staged.");
    rewriter.check(journal.placements, map);
    stopPoint("after-check");
  }
  if (at("place")) {
    stepTo(journal, "place");
    let placed = 0;
    for (const placement of journal.placements) {
      if (!exists(placement.staged)) continue;
      madeFolder(home, path.dirname(placement.to), keptLike(journal));
      place(home, placement.staged, placement.to, placement.from, journal.way === "back");
      if (++placed === 1) stopPoint("in-place");
    }
    if (journal.way === "move") {
      // Its kind, last of the box's own files: a Mac's, in a home of its own.
      const box = path.join(home, "box");
      madeFolder(home, box);
      // (Keep This Mac Awake off, as the app had it: in the clone, or a file of its own.)
      if (journal.keepsAwakeOff) {
        if (!exists(path.join(box, "work.json"))) journalAct(home, { act: "made", path: path.join(box, "work.json") });
        setKeepsAwake(false, path.join(box, "work.json"));
      }
      journalAct(home, { act: "made", path: path.join(box, "kind") });
      writePrivate(path.join(box, "kind"), "mac\n");
    }
    stopPoint("after-place");
  }
  if (at("fix")) {
    stepTo(journal, "fix");
    rewriter.outside(map, undo => journalAct(home, undo));
    stopPoint("after-fix");
  }
  // From here it only goes forward: nothing may have started meanwhile in what it clears (it would
  // have written there, into what's only kept).
  if (at("clear")) {
    if (stepIndex(journal.step) < stepIndex("clear")) {
      const run = journal.way === "move" ? path.join(journal.from, "box", "run") : path.join(home, "run");
      const running = runningIn(run, { keeper: false });
      if (running.length) throw new Error(`Something started in the box as it moved (${running.join(", ")}), so it went back.`);
      // Nor anything written meanwhile where it moves from (a file the app kept as you sent it):
      // only its copy would move.
      // (All it clears but the engine's own folders, which its engine alone writes; new entries too.)
      const written = journal.way === "move" && journal.clonedAt
        ? changedSince(journal.clearing.filter(each => each !== path.join(journal.from, "opencode")), journal.clonedAt, path.join(journal.from, "box", "run"))
        : null;
      if (written) throw new Error(`${written} changed as it moved, so it went back.`);
    }
    stepTo(journal, "clear");
    // A move back: the files its keys were written to from your Keychain go, never kept.
    if (journal.way === "back") for (const name of ["keys", "bot-keys"]) fs.rmSync(path.join(home, "box", name), { recursive: true, force: true });
    const root = journal.way === "move" ? journal.from : home;
    let cleared = 0;
    for (const file of journal.clearing) {
      if (!exists(file)) continue;
      const kept = path.join(journal.kept, path.relative(root, file));
      madeFolder(home, path.dirname(kept));
      rename(home, file, exists(kept) ? freeName(kept) : kept);
      if (++cleared === 1) stopPoint("in-clear");
    }
    // (Its trash, emptied going back, goes too: one that still holds an earlier box stays.)
    if (journal.way === "back") try { fs.rmdirSync(path.join(home, "trash")); } catch {}
    stopPoint("after-clear");
  }
  finish(journal);
}

/** Done: said in `state.json`, then the journal (written last). */
function finish(journal: Journal, now = Date.now()): void {
  const home = homeOf(journal);
  const record = readRecord(home);
  const merged = journal.way === "move"
    ? readActs(home).flatMap(act => (act.act === "rename" && act.merged && act.source && inside(act.to, home) ? [{ source: act.source, placed: act.to }] : []))
    : [];
  noteRecord(home, {
    state: journal.way === "move" ? "done" : "back",
    way: journal.way,
    // (Moved back, it moves again only on Move Now, however that goes: until a move's done.)
    movedBack: journal.way === "back",
    movedAt: now,
    keptUntil: now + KEPT_FOR,
    kept: [...(record.kept ?? []).filter(each => each !== journal.kept), journal.kept],
    merged,
    owed: ["keychain", "agent"],
    tries: 0,
    nextTry: null,
    failed: null,
    asked: null,
    waitingSince: null,
    from: foldersOf(journal).appFolder,
    to: home,
  });
  fs.rmSync(staging(home), { recursive: true, force: true });
  stepTo(journal, "done");
}

/** A failure before the old place was cleared: gone back, and noted with its try. */
function failed(journal: Journal, error: unknown, now = Date.now()): string {
  const home = homeOf(journal);
  const step = journal.step;
  undo(journal);
  const message = error instanceof Error ? error.message : String(error);
  const record = readRecord(home);
  // A move back that didn't: the box stays moved, as it was (Move Back tried again by asking again).
  // (Its try counted once, should it stop before the journal goes and be undone again.)
  const counted = record.counted === journal.began;
  if (journal.way === "back") noteRecord(home, { state: "done", way: "move", failed: { at: now, step, message }, asked: null });
  else noteRecord(home, { state: "failed", way: "move", tries: (record.tries ?? 0) + (counted ? 0 : 1), nextTry: now + AFTER_A_FAILURE, failed: { at: now, step, message }, asked: null, counted: journal.began });
  // (Then the journal: stopped before, it's undone again, which changes nothing.)
  forgetJournal(home);
  return message;
}

// The command

/** What `rehome` says it did, as one JSON line, and what the keeper does then: `done` (moved), `back`
 * (moved back) and `nothing` (nothing to finish): start what's there; `refused` and `failed` (it went
 * back, or never began): start the box where it was; `stuck` (it stopped past the point it goes
 * back from: `--resume` carries it on) and `waits` (another move holds the lock): start nothing. */
export interface RehomeOutcome {
  result: "done" | "back" | "refused" | "failed" | "stuck" | "nothing" | "waits";
  message?: string;
  status: RehomeStatus;
}

/** What a move or a move back is given: the app's version and the box's files to put in its new
 * home, whether Keep This Mac Awake was off in the app, its rewriter, and what it says while it
 * waits for the lock. */
export interface MoveOptions {
  appVersion?: string | null;
  release?: string | null;
  keepsAwakeOff?: boolean;
  rewriter?: Rewriter;
  waiting?: () => void;
}

/** Another took the move's lock from this one (it took this one for gone): this one stops where it
 * is, undoing nothing, for that one to finish. */
class LockLost extends Error {}

const WAITS = "Another move is under way.";

async function locked(home: string, waiting: () => void, work: () => RehomeOutcome): Promise<RehomeOutcome> {
  if (!(await takeLock(home, { waiting }))) return { result: "waits", message: WAITS, status: rehomeStatus(home) };
  try {
    return work();
  } finally {
    giveLock(home);
  }
}

/** Its steps carried on from where the journal is: what a failure comes to. Before the old place is
 * cleared, it goes back; from then on, it says it's stuck (and why, in `state.json`), for `--resume`. */
function carried(journal: Journal, rewriter: Rewriter): RehomeOutcome {
  const home = homeOf(journal);
  try {
    carryOn(journal, rewriter);
  } catch (error) {
    if (error instanceof LockLost) return { result: "waits", message: WAITS, status: rehomeStatus(home) };
    if (!forwardOnly(journal.step)) return { result: "failed", message: failed(journal, error), status: rehomeStatus(home) };
    const message = error instanceof Error ? error.message : String(error);
    noteRecord(home, { failed: { at: Date.now(), step: journal.step, message } });
    return { result: "stuck", message, status: rehomeStatus(home) };
  }
  return { result: journal.way === "move" ? "done" : "back", status: rehomeStatus(home) };
}

/** One that stopped part way, finished: back before it cleared the old place, forward after. */
function resumed(home: string, rewriter: Rewriter): RehomeOutcome | null {
  let journal: Journal | null;
  try { journal = readJournal(home); } catch (error) {
    return { result: "stuck", message: (error as Error).message, status: rehomeStatus(home) };
  }
  if (!journal || journal.step === "done") return null;
  if (!forwardOnly(journal.step)) {
    const message = failed(journal, new Error(`It stopped part way (${journal.step}), so it went back.`));
    return { result: "failed", message, status: rehomeStatus(home) };
  }
  return carried(journal, rewriter);
}

/** `rehome`: this Mac's box moved into `home`, from the app's folder around `appBox`. */
export async function rehome(folders: Folders, options: MoveOptions = {}): Promise<RehomeOutcome> {
  const { home } = folders;
  const rewriter = options.rewriter ?? NO_REWRITE;
  if (process.platform !== "darwin") return { result: "refused", message: NOTHING_TO_MOVE, status: rehomeStatus(home) };
  return locked(home, options.waiting ?? (() => {}), () => {
    const earlier = resumed(home, rewriter);
    if (earlier) return earlier;
    const release = options.release ? path.resolve(options.release) : null;
    const refusal = moveRefusal(folders, { appVersion: options.appVersion ?? null, release, rewriter });
    const now = Date.now();
    if (refusal) {
      const record = readRecord(home);
      if (record.state !== "done") noteRecord(home, { state: "failed", way: "move", tries: (record.tries ?? 0) + 1, nextTry: now + AFTER_A_FAILURE, failed: { at: now, step: "plan", message: refusal }, asked: null });
      return { result: "refused", message: refusal, status: rehomeStatus(home) };
    }
    return run({
      v: 1, way: "move", began: now, step: "plan", from: folders.appFolder, to: home,
      ...planMove(folders, release!), kept: path.join(rehomeFolder(home), "kept", stamp(now)),
      ...(options.keepsAwakeOff ? { keepsAwakeOff: true } : {}),
    }, rewriter);
  });
}

/** `rehome --back`: the box in `home` moved back into the app's folder it came from. */
export async function rehomeBack(home: string, options: MoveOptions = {}): Promise<RehomeOutcome> {
  const rewriter = options.rewriter ?? NO_REWRITE;
  return locked(home, options.waiting ?? (() => {}), () => {
    const earlier = resumed(home, rewriter);
    if (earlier) return earlier;
    const record = readRecord(home);
    const appFolder = typeof record.from === "string" ? record.from : null;
    const refusal = backRefusal({ appFolder: appFolder ?? home, home });
    const now = Date.now();
    if (refusal || !appFolder) {
      // (Move Back asked: answered, for the keeper not to ask again until it's asked again.)
      if (record.state === "done" && record.way === "move") noteRecord(home, { failed: { at: now, step: "plan", message: refusal ?? NOT_MOVED }, asked: null });
      return { result: "refused", message: refusal ?? NOT_MOVED, status: rehomeStatus(home) };
    }
    return run({
      v: 1, way: "back", began: now, step: "plan", from: home, to: appFolder,
      ...planBack({ appFolder, home }, record.merged), kept: path.join(rehomeFolder(home), "kept", `${stamp(now)}-back`),
      ...(record.kept?.length ? { keptBefore: record.kept[record.kept.length - 1] } : {}),
    }, rewriter);
  });
}

function run(journal: Journal, rewriter: Rewriter): RehomeOutcome {
  const home = homeOf(journal);
  // (Anything left from a move that ended before it began.)
  forgetJournal(home);
  writeJournal(home, journal);
  noteRecord(home, { state: "moving", way: journal.way, from: foldersOf(journal).appFolder, to: home });
  stopPoint("after-plan");
  return carried(journal, rewriter);
}

/** `rehome --resume`: a move that stopped part way finished, back or forward (nothing without one,
 * and nothing made for it). */
export async function rehomeResume(home: string, options: MoveOptions = {}): Promise<RehomeOutcome> {
  if (!moveUnderWay(home)) return { result: "nothing", status: rehomeStatus(home) };
  return locked(home, options.waiting ?? (() => {}), () => resumed(home, options.rewriter ?? NO_REWRITE) ?? { result: "nothing", status: rehomeStatus(home) });
}

/** What `rehome --ready` says: whether to move (or move back, or finish one) now, and why not. */
export interface Readiness {
  ready: boolean;
  how: "move" | "back" | "resume" | null;
  why?: string;
  status: RehomeStatus;
}

/** Whether the keeper should run the move now, with the box running as it is (#333 §3.1, §3.5): one
 * under way first; then Move Back asked; then whatever keeps it from moving at all (each refusal but
 * the box running, which the keeper stops first); then Move Now asked; else at a quiet moment
 * (nothing working, nothing waiting on you), its tries and their next time as `state.json` says.
 * Only then does it wait (`waiting`), and three days of that is overdue, for a client to offer
 * Move Now. Moved back, it moves again only on Move Now. */
export async function rehomeReady(home: string, appFolder: string | null, { appVersion = null, release, now = Date.now(), busy }: { appVersion?: string | null; release?: string; now?: number; busy?: () => Promise<boolean> } = {}): Promise<Readiness> {
  clearKept(home, now);
  const say = (ready: boolean, how: Readiness["how"], why?: string): Readiness => ({ ready, how, ...(why ? { why } : {}), status: rehomeStatus(home, now) });
  let journal: Journal | null;
  try { journal = readJournal(home); } catch (error) { return say(false, null, (error as Error).message); }
  if (journal && journal.step !== "done") return say(true, "resume");
  if (process.platform !== "darwin") return say(false, null, NOTHING_TO_MOVE);
  const record = readRecord(home);
  const moved = record.state === "done" && record.way === "move";
  if (record.asked === "back") {
    const refusal = moved && typeof record.from === "string" ? backRefusal({ appFolder: record.from, home }, { running: false }) : NOT_MOVED;
    if (!refusal) return say(true, "back");
    noteRecord(home, { failed: { at: now, step: "plan", message: refusal }, asked: null });
    return say(false, null, refusal);
  }
  if (moved) return say(false, null, "This Mac's box has moved.");
  if (record.movedBack && record.asked !== "now") return say(false, null, "It was moved back: it moves again only on Move Now.");
  if (!appFolder) return say(false, null, "Only the app's own box, in its folder, moves.");
  const refusal = moveRefusal({ appFolder, home }, { appVersion, release, running: false });
  if (refusal) return say(false, null, refusal);
  if (record.asked === "now") return say(true, "move");
  if ((record.tries ?? 0) >= MOST_TRIES) return say(false, null, "It didn't move after three tries: it waits for Move Now.");
  if (record.nextTry && record.nextTry > now) return say(false, null, "It tries again later.");
  // (The first time it's only waiting for a quiet moment: waiting from now.)
  if (record.state == null || record.state === "back") noteRecord(home, { state: "waiting", waitingSince: now });
  else if (record.waitingSince == null) noteRecord(home, { waitingSince: now });
  const working = busy ? await busy() : (await agentsWorking().catch(() => null)) !== false || readAsks().length > 0;
  if (working) return say(false, null, "It moves when nothing's running.");
  return say(true, "move");
}

/** The kept copies deleted once their 30 days are up. */
export function clearKept(home: string, now = Date.now()): void {
  const record = readRecord(home);
  if (!record.keptUntil || record.keptUntil > now || !record.kept?.length) return;
  for (const folder of record.kept) if (inside(folder, rehomeFolder(home))) fs.rmSync(folder, { recursive: true, force: true });
  noteRecord(home, { kept: [], keptUntil: null });
}

/** A client's ask (`kuvo/box/rehome`): Move Now (`now`), or Move Back (`back`, once it's moved). */
export function askRehome(home: string, ask: "now" | "back"): string | null {
  if (process.platform !== "darwin") return NOTHING_TO_MOVE;
  const record = readRecord(home);
  const moved = record.state === "done" && record.way === "move";
  if (ask === "back" && !moved) return NOT_MOVED;
  if (ask === "now" && moved) return "This Mac's box has moved already.";
  noteRecord(home, { asked: ask });
  return null;
}

/** What the app's executable owes once a move's done (deleting the Keychain's originals,
 * unregistering its agent; or, once it's moved back, the opposite), settled. */
export function settled(home: string, what: string): boolean {
  const record = readRecord(home);
  if (!record.owed?.includes(what as never)) return false;
  noteRecord(home, { owed: record.owed.filter(each => each !== what) });
  return true;
}

/** The home of its own `root` names (`.kuvo-code`, or a test's or demo copy's own), in your home folder. */
export function homeOfRoot(root: string | undefined, home = homeFolder()): string {
  if (!root || root.includes("/") || root === "." || root === "..") throw new Error("kuvo-link.js rehome needs the machines' folder's name: rehome <root>.");
  return path.join(home, root);
}

/** The app's folder around its box (`KUVO_HOME`, `<app folder>/box`), checked against `home`. */
export function appFolderOf(appBox: string | undefined, home: string): string {
  if (!appBox || path.basename(appBox) !== "box" || located(appBox) === located(home)) throw new Error("kuvo-link.js rehome needs KUVO_HOME, the app's own box's folder (<app folder>/box).");
  return path.dirname(path.resolve(appBox));
}

