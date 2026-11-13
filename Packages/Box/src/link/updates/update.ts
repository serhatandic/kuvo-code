// Updates (PROTOCOL.md, "Updates")
// A box updates itself to a newer Kuvo Code's release: at night (02:00 to 05:00 where you are) when
// nothing runs on it, or now (Update Now, from a Mac or a phone). Never to an older one, only what
// a key pinned here signed, only in a machine's own ~/.kuvo-code (not a test's or a demo's), and
// only while every Mac that started its engine lately leaves a newer box as it is. It checks what
// it got, tries the new engine and bridge, keeps what it had, swaps its files one by one and
// starts again; if that doesn't come up well, or the new bridge never says it's well (the keeper
// waits twenty minutes), it goes back to what it had. A release can come from a folder on this
// computer too (`kuvo/box/update {from}`: the one an app carries, for it to offer as it updates),
// checked the same way and taken at the next quiet moment; and it can carry a signed Mac bundle
// (the box's helper), swapped whole.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { nightOf } from "../../shared/night";
import { updateUnderWay } from "../../shared/updating";
import type { Body } from "../../shared/json";
import { alive, processRuns as runs } from "../../shared/platform";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { LastUpdate, UpdateStatus, UpdateStep } from "../../shared/routes/box";
import { quote } from "../../shared/text";
import { sleep } from "../../shared/wait";
import { readAsks } from "../areas/asks";
import { asked, fetched, readBridgeFile, readEngineFile } from "../engine/client";
import type { UncheckedAnswer } from "../engine/client";
import { listOf, textOf, writePrivate } from "../files";
import { K, OWN_RUNTIME, RUN, SCRIPT, UPDATES, homeFolder } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import { readLink, type LinkState } from "../state";

// The releases' public keys (scripts/set-box-key.sh, scripts/sign-box.mjs), base64: with none, no
// box updates itself.
export const UPDATE_KEYS = ["iLSFoygG8wg+r2yj+/qnoMHpZIhPKRNLlf9vpEKmx0A="];
const UPDATE_URL = "https://github.com/serhatandic/kuvo-code/releases/latest/download/boxes.json";
const UPDATE_STATE = path.join(RUN, "update.json");
const UPDATE_TRIAL = path.join(RUN, "update-trial");
/** An update is here on trial: until it's confirmed, the keeper may yet put the version before back. */
export const updateOnTrial = (): boolean => fs.existsSync(UPDATE_TRIAL);
const UPDATE_LOCK = path.join(RUN, ".updating");
const ROLLBACK = path.join(UPDATES, "rollback");
const LAUNCHERS = path.join(RUN, "launchers.json");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
// A release this old before a box takes it by itself (most Macs have updated by then, and a bad
// one doesn't reach every box the night it's out).
const RELEASE_AGE = 3 * 86_400_000;
const MAC_MEMORY = 30 * 86_400_000;
const BOX_FILE = /^(bin\/[A-Za-z0-9._-]+|bin\/runtime\/[A-Za-z0-9._-]+|config\/opencode\/plugins\/[A-Za-z0-9._-]+)$/;
// A Mac bundle a release carries (the box's helper, `bin/Kuvo Code Box.app`), named in `box.json`'s
// `bundles` (which a box from before them passes over), each of its files by its path in it:
// none a link, no part starting with a dot (never `..`), and the bundle swapped whole.
const BUNDLE = /^bin\/[A-Za-z0-9][A-Za-z0-9._ -]*\.app$/;
const BUNDLE_PART = /^(?:[A-Za-z0-9_][A-Za-z0-9._+ -]*\/)*[A-Za-z0-9_][A-Za-z0-9._+ -]*$/;
// How long a release that was offered rests before it's taken again: one that was put in place and
// didn't come up (taken back), a day; one that failed before anything changed (the engine's
// download offline, say), an hour the first time, then a day (one whose own checks fail every
// time isn't downloaded again every hour).
const OFFER_REST = 86_400_000;
const OFFER_RETRY = 3_600_000;
// A release offered from a folder on this computer (`kuvo/box/update`), kept until it's taken.
const OFFERED = path.join(UPDATES, "offered");
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;

// A version as versions are ordered (a beta before its release), or null for one that isn't.
export function versionOrder(version: string | null | undefined): [number, number, number, number] | null {
  const found = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version ?? "");
  return found ? [+found[1], +found[2], +found[3], found[4] == null ? Infinity : +found[4]] : null;
}

// Whether `version` is newer than `than` (none: any is).
export function newerVersion(version: string | null | undefined, than: string | null | undefined): boolean {
  const a = versionOrder(version), b = versionOrder(than);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** A release's manifest (in `boxes.json`, signed): its version, its engine's, when it came out,
 * its files' pack, and its engine for each kind of machine: Linux's and Macs', each by `uname -m`'s
 * kinds. */
export interface BoxRelease {
  kuvo: "box/1";
  version: string;
  engine: string;
  released?: string;
  pack: { url: string; sha256: string };
  linux?: Record<string, { url?: string; integrity?: string } | undefined>;
  darwin?: Record<string, { url?: string; integrity?: string } | undefined>;
}

// A release's manifest, from boxes.json as the release workflow signs it: only with a key that's
// pinned, its signature over "kuvo-box v1\n" and its bytes. It throws for anything else.
export function verifyBoxes(text: string, keys: string[] = UPDATE_KEYS): BoxRelease {
  // (Each checked below.)
  let given: { manifest: string; signature: string; key: string } | null;
  try { given = JSON.parse(text); } catch { throw new Error("That isn't a release."); }
  if (typeof given?.manifest !== "string" || typeof given.signature !== "string" || typeof given.key !== "string") throw new Error("That isn't a release.");
  const key = keys.map(each => Buffer.from(each, "base64")).find(each => each.length === 32 && each.equals(Buffer.from(given!.key, "base64")));
  if (!key) throw new Error("It isn't signed with a key this machine trusts.");
  const bytes = Buffer.from(given.manifest, "base64");
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: "der", type: "spki" });
  if (!crypto.verify(null, Buffer.concat([Buffer.from("kuvo-box v1\n"), bytes]), publicKey, Buffer.from(given.signature, "base64"))) throw new Error("Its signature doesn't match.");
  const manifest: BoxRelease = JSON.parse(bytes.toString("utf8"));
  if (manifest?.kuvo !== "box/1" || !RELEASE_VERSION.test(manifest.version ?? "") || typeof manifest.engine !== "string" || !/^[0-9][0-9A-Za-z.-]*$/.test(manifest.engine)
    || !isObject(manifest.pack) || typeof manifest.pack.url !== "string" || !/^[0-9a-f]{64}$/.test(manifest.pack.sha256 ?? "")) throw new Error("That isn't a release.");
  return manifest;
}

// This box's version, as the Kuvo Code that put its files there marked it (`bin/box-version`).
export const boxVersion = (): string | null => {
  const version = textOf(path.join(K, "bin", "box-version"))?.trim();
  return versionOrder(version) ? version! : null;
};

/** What an update came to (`update`'s `result`), as `kuvo/update`'s `last` says it. */
export type UpdateResult = LastUpdate["result"];

/** What `update` says happened: its result, the version it's at or found, and why, in words. */
export interface UpdateOutcome {
  result: UpdateResult;
  version?: string;
  message?: string;
}

/** An update being tried (`trial`): from and to which version, since when, and whether it came up well. */
export interface UpdateTrial {
  from: string;
  to: string;
  at: number;
  healthy?: boolean;
}

/** `run/update.json`: the newest release heard of (and when it was looked for), an update being
 * tried, the step under way, how the last went, and the night it last tried. */
export interface UpdateState {
  latest?: string;
  checked?: number;
  trial?: UpdateTrial;
  /** The step under way (shared/routes/box.ts, `STEP`). */
  running?: UpdateStep;
  /** How the last update went, when (shared/routes/box.ts, `LAST_UPDATE`). */
  last?: LastUpdate;
  night?: string;
  /** A release offered from a folder here that failed as it was taken: its version, when, whether
   * it was put in place and taken back, and how many times in a row it failed. */
  offerFailed?: { version: string; at: number; takenBack: boolean; tries?: number; message?: string };
}

/** A change to `run/update.json`: each field given, null to take it away. */
export type UpdateChange = { [Key in keyof UpdateState]?: UpdateState[Key] | null };

export const updateState = (): UpdateState => { try { return JSON.parse(fs.readFileSync(UPDATE_STATE, "utf8")) ?? {}; } catch { return {}; } };
export function noteUpdate(change: UpdateChange): UpdateState {
  const state = { ...updateState(), ...change };
  for (const [key, value] of Object.entries(change)) if (value == null) delete state[key as keyof UpdateState];
  try { writePrivate(UPDATE_STATE, JSON.stringify(state)); } catch {}
  return state as UpdateState;
}

// Who started this box's engine lately: each Mac by its ID (in its launches' notes), with when.
export function noteLauncher(readEngine: () => EngineRecord = readEngineFile, now = Date.now()): void {
  let mac: unknown = null;
  try { mac = readEngine()?.notes?.mac; } catch {}
  if (typeof mac !== "string" || !mac || mac.length > 100) return;
  let all: Record<string, number> = {};
  try { all = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  if (now - (all[mac] ?? 0) < 3600_000) return;
  all[mac] = now;
  for (const [key, at] of Object.entries(all)) if (now - at > MAC_MEMORY) delete all[key];
  try { writePrivate(LAUNCHERS, JSON.stringify(all)); } catch {}
}

// COMPAT(0.7 visits): `launchers.json`, Macs that started the engine without saying they tolerate newer boxes, hold updates back. Goes 3 months after 0.8.0.
// Why this box doesn't update itself now, or null: it isn't a machine's own folder, or a Mac that
// started its engine lately would put back older versions (one that didn't say it leaves a newer
// box as it is).
export function updatesBlocked(link: LinkState | null = readLink(), now = Date.now(), root = K): string | null {
  if (path.resolve(root) !== path.join(homeFolder(), ".kuvo-code")) return "Only a machine's own Kuvo Code folder updates itself.";
  let launchers: Record<string, number> = {};
  try { launchers = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  const behind = Object.entries(launchers).filter(([mac, at]) => now - at < MAC_MEMORY && link?.tolerantIDs?.[mac] !== true);
  if (behind.length) return "A Mac that connects to this machine has an older Kuvo Code, which would put back older versions: update Kuvo Code there first.";
  return null;
}

// Whether something runs on the box: a conversation working (the engine's, the coding agents'),
// or an agent's browser waiting on you.
async function boxBusy(readEngine: () => EngineRecord = readEngineFile, readBridge: () => BridgeRecord = readBridgeFile): Promise<boolean> {
  return await agentsWorking(readEngine, readBridge) === true || readAsks().length > 0;
}

/** Whether a conversation is working on the box now: the engine's, or the coding agents'; null when
 * that can't be told (one that's recorded as running didn't answer, a moment's restart). */
export async function agentsWorking(readEngine: () => EngineRecord = readEngineFile, readBridge: () => BridgeRecord = readBridgeFile): Promise<boolean | null> {
  let unknown = false;
  for (const [read, program] of [[readEngine, "opencode"], [readBridge, "kuvo-agents"]] as const) {
    let target: Target | null = null;
    try { target = read(); } catch {}
    if (!target?.port || !target?.password) continue;
    // (A record its process left as it went, killed: nothing works there.)
    const pid = (target as { pid?: unknown }).pid;
    if (pid !== undefined && !runs(pid, program)) continue;
    const answer = await asked(target, "GET", "api/session/active").catch(() => null) as UncheckedAnswer | null;
    const active = answer?.data;
    if (Array.isArray(active) ? active.length : isObject(active) && Object.keys(active).length) return true;
    if (!Array.isArray(active) && !isObject(active)) unknown = true;
  }
  return unknown ? null : false;
}


const hexSHA256 = (data: Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

// `command` with `args`, in the box's folder, its environment the bridge's: its exit status and
// output, within `timeout` ms.
function ran(command: string, args: string[], env: Record<string, string> = {}, timeout = 120_000): { status: number | null; output: string } {
  const result = spawnSync(command, args, { cwd: K, env: { ...process.env, ...env }, encoding: "utf8", timeout });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}


// An update under way, by its process (`run/.updating/pid`): one at a time, and one whose process
// went isn't one.
export function isUpdating(): boolean {
  return updateUnderWay(RUN);
}

function takeUpdateLock(): boolean {
  try {
    fs.mkdirSync(UPDATE_LOCK);
  } catch {
    if (isUpdating()) return false;
    fs.rmSync(UPDATE_LOCK, { recursive: true, force: true });
    try { fs.mkdirSync(UPDATE_LOCK); } catch { return false; }
  }
  fs.writeFileSync(path.join(UPDATE_LOCK, "pid"), String(process.pid), { mode: 0o600 });
  return true;
}

// Keeps what's there now of each of a release's files, and with another engine version the
// engine's data (stopped), with `restore.sh`, which puts them back: run by the update when the new
// version doesn't come up, or by the keeper once the update's trial runs out (not while an update
// runs). Each step checked: one that fails leaves what was kept, for the next try.
function keepForRollback(files: string[], withData: boolean, bundles: ReadonlySet<string> = new Set()): void {
  fs.rmSync(ROLLBACK, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROLLBACK, "files"), { recursive: true, mode: 0o700 });
  const lines = [
    "#!/bin/sh",
    `K=${quote(K)}; B=${quote(ROLLBACK)}`,
    `p=$(cat "$K/run/.updating/pid" 2>/dev/null)`,
    `if [ -n "$p" ] && [ "$p" != "\${KUVO_UPDATER:-}" ] && kill -0 "$p" 2>/dev/null && { if [ -d /proc ]; then grep -q kuvo-link "/proc/$p/cmdline" 2>/dev/null; else ps -ww -o command= -p "$p" 2>/dev/null | grep -q kuvo-link; fi; }; then exit 0; fi`,
    `sh "$K/bin/kuvo-start" stop >/dev/null 2>&1 || exit 1`,
  ];
  for (const file of files) {
    const from = path.join(K, file);
    if (bundles.has(file)) {
      // A bundle, whole: the one there put back aside the new, which goes (none there: it goes).
      const [here, fresh, old] = [`"$K/"${quote(file)}`, `"$K/"${quote(`${file}.new`)}`, `"$K/"${quote(`${file}.old`)}`];
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(path.join(ROLLBACK, "files", file)), { recursive: true, mode: 0o700 });
        fs.cpSync(from, path.join(ROLLBACK, "files", file), { recursive: true, verbatimSymlinks: true });
        lines.push(`rm -rf ${fresh} ${old} && cp -Rp "$B/files/"${quote(file)} ${fresh} && { [ ! -e ${here} ] || mv ${here} ${old}; } && mv ${fresh} ${here} && rm -rf ${old} || exit 1`);
      } else {
        lines.push(`rm -rf ${here} ${fresh} || exit 1`);
      }
    } else if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(path.join(ROLLBACK, "files", file)), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, path.join(ROLLBACK, "files", file));
      fs.chmodSync(path.join(ROLLBACK, "files", file), fs.statSync(from).mode & 0o777);
      lines.push(`cp -p "$B/files/"${quote(file)} "$K/"${quote(file)}.new && mv -f "$K/"${quote(file)}.new "$K/"${quote(file)} || exit 1`);
    } else {
      lines.push(`rm -f "$K/"${quote(file)} || exit 1`);
    }
  }
  if (withData) {
    // The database as it was kept, moved back (on the same disk: no room needed), with its own
    // journal and index (none, when it was closed cleanly), never the new engine's beside it. Only
    // once it was kept (the update may have stopped before).
    lines.push(
      `D="$K/data/opencode"`,
      `if [ -f "$B/data/opencode.db" ]; then`,
      `  rm -f "$D/opencode.db-wal" "$D/opencode.db-shm" || exit 1`,
      `  for n in opencode.db opencode.db-wal opencode.db-shm; do if [ -f "$B/data/$n" ]; then mv -f "$B/data/$n" "$D/$n" || exit 1; fi; done`,
      `fi`,
    );
  }
  lines.push(`sh "$K/bin/kuvo-start" start >/dev/null 2>&1`, `rm -f "$K/run/update-trial" "$K/run/update-restore"`, `rm -rf "$B"`);
  writePrivate(path.join(ROLLBACK, "restore.sh"), lines.join("\n") + "\n");
}

// The engine's data as it is, the engine stopped, beside what's put back: whole or not at all (a
// copy cut short is never put back).
function keepData(): void {
  const folder = path.join(K, "data", "opencode"), partial = path.join(ROLLBACK, "data.partial");
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    if (fs.existsSync(path.join(folder, name))) fs.copyFileSync(path.join(folder, name), path.join(partial, name));
  }
  fs.renameSync(partial, path.join(ROLLBACK, "data"));
}

// Whether there's room to keep the engine's data beside it, with some to spare.
function roomForData(): boolean {
  let size = 0;
  for (const name of ["opencode.db", "opencode.db-wal"]) try { size += fs.statSync(path.join(K, "data", "opencode", name)).size; } catch {}
  const free = ran("df", ["-Pk", K]).output.split("\n").pop()?.trim().split(/\s+/)[3];
  return !free || Number(free) * 1024 > size * 1.1 + 200_000_000;
}

// Whether the engine came up as `version` and answers, and the coding agents' bridge with it when
// it ran before, within `timeout` ms.
async function cameUp(version: string, withAgents: boolean, timeout = 120_000, readEngine: () => EngineRecord = readEngineFile, readBridge: () => BridgeRecord = readBridgeFile): Promise<boolean> {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    await sleep(Math.min(2000, timeout / 10));
    let engine: EngineRecord | null = null;
    try { engine = readEngine(); } catch {}
    if (engine?.version !== version) continue;
    if (!(await asked(engine, "GET", "api/session?limit=1").then(() => true, () => false))) continue;
    if (!withAgents) return true;
    let bridge: BridgeRecord | null = null;
    try { bridge = readBridge(); } catch {}
    if (bridge?.port && (await asked(bridge, "GET", "api/session/active").then(() => true, () => false))) return true;
  }
  return false;
}

// COMPAT(0.7 files): `bin/.own`, the box's own copies of the tools an older Mac puts its own over. Goes 3 months after 0.8.0.
// The box's tools that an older Kuvo Code on a Mac (0.7 and before) puts its own over as it
// connects: the box keeps copies of its own (`bin/.own`), which its keeper puts back.
const OWN_TOOLS = ["kuvo-agents.js", "kuvo-browser.js", "kuvo-wake", "kuvo-npx"];

// The order files go in: its version first (a Mac connecting meanwhile leaves the box as it is),
// the keeper's mark last (the keeper starts its new script only once the script is there).
const installOrder = (files: string[]): string[] => [...files].sort((a, b) => (a === "bin/box-version" ? -1 : b === "bin/box-version" ? 1 : a === "bin/.kuvo-boot" ? 1 : b === "bin/.kuvo-boot" ? -1 : a < b ? -1 : 1));

/** How `update` runs: now (Update Now) or by night, from a folder on this computer (`from`, with
 * `boxes.json` and the pack it names) rather than GitHub, and for a test, its keys, address,
 * block, clock, steps and how long the new version has to come up. */
export interface UpdateOptions {
  now?: boolean;
  from?: string;
  keys?: string[];
  url?: string;
  blocked?: string | null;
  clock?: () => number;
  step?: (running: UpdateStep) => void;
  upWithin?: number;
  /** Told as it starts putting the new version in place (from there, a failure is taken back). */
  swapping?: () => void;
  /** Told the version of the release it takes, once it's checked its signature. */
  taking?: (version: string) => void;
}

/** A release's `box.json`, in its pack: its version, its engine's, each file's SHA-256, and its
 * Mac bundles' (`bin/<name>.app`), each file by its path in the bundle. */
interface BoxFiles {
  version: string;
  engine: string;
  files: Record<string, string>;
  bundles?: Record<string, Record<string, string>>;
}

// Updates the box to the newest release, when it's newer: `now` (Update Now) takes it whatever its
// age. What happened: `{result: "updated" | "current" | "waiting" | "busy" | "off" | "blocked" |
// "failed", version?, message?}`; once "updated", the bridge goes for the keeper to start the new
// one. `from`: a release in a folder here, taken whatever its age (the Kuvo Code it came with is
// here already). `keys` and `url`: a test's (a test's folder only).
export async function update({ now = false, from, keys = UPDATE_KEYS, url = UPDATE_URL, blocked = updatesBlocked(), clock = Date.now, step = () => {}, upWithin = 120_000, swapping = () => {}, taking = () => {} }: UpdateOptions = {}): Promise<UpdateOutcome> {
  if (!keys.length) return { result: "off", message: "Updates aren't set up for this machine yet." };
  if (blocked) return { result: "blocked", message: blocked };
  // COMPAT(0.7 engine-stop): no update while an older Mac's Stop holds the engine down. Goes 3 months after 0.8.0.
  if (fs.existsSync(path.join(RUN, "stopped"))) return { result: "blocked", message: "Its engine is stopped: start it to update it." };
  const before = boxVersion();
  if (!before) return { result: "blocked", message: "This machine's version isn't known: connect to it from Kuvo Code on your Mac once." };
  if (!takeUpdateLock()) return { result: "busy", message: "It's updating already." };
  let trial = false, stopped = false, swapped = false, stage: string | null = null;
  try {
    step("checking");
    let released: Buffer;
    if (from) released = readRelease(path.join(from, "boxes.json"), 1_000_000);
    else try {
      released = await fetched(url, 1_000_000, 30_000);
    } catch (error) {
      // COMPAT(0.7 no-boxes-json): a newest release without `boxes.json` (0.7.2) is "current". Goes once a release with one is the newest.
      // The newest release has none for machines (one from before them): nothing newer for it.
      if (/answered 404/.test(String((error as Error | undefined)?.message))) return { result: "current", version: before };
      throw error;
    }
    const manifest = verifyBoxes(released.toString("utf8"), keys);
    taking(manifest.version);
    // (Only GitHub's says what the newest release is.)
    if (!from) noteUpdate({ latest: manifest.version, checked: clock() });
    if (!newerVersion(manifest.version, before)) return { result: "current", version: before };
    if (!now && !from && clock() - (Date.parse(manifest.released!) || clock()) < RELEASE_AGE) return { result: "waiting", version: manifest.version, message: "It takes a release a few days after it's out." };
    if (await boxBusy()) return { result: "busy", message: "Something is running there now." };

    step("downloading");
    stage = path.join(UPDATES, manifest.version);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, "files"), { recursive: true, mode: 0o700 });
    const pack = from ? readRelease(path.join(from, packName(manifest)), 100_000_000) : await fetched(manifest.pack.url, 100_000_000, 300_000);
    if (hexSHA256(pack) !== manifest.pack.sha256) throw new Error("The release's files aren't what it says.");
    fs.writeFileSync(path.join(stage, "pack.tgz"), pack, { mode: 0o600 });
    if (ran("tar", ["xzf", path.join(stage, "pack.tgz"), "-C", path.join(stage, "files")]).status !== 0) throw new Error("The release's files couldn't be unpacked.");
    const box: BoxFiles = JSON.parse(fs.readFileSync(path.join(stage, "files", "box.json"), "utf8"));
    if (box?.version !== manifest.version || box.engine !== manifest.engine || !isObject(box.files)) throw new Error("The release's files aren't what it says.");
    const files = installOrder(Object.keys(box.files));
    // (Each a file, never a link to one elsewhere.)
    const matches = (file: string, sha: unknown): boolean => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true && hexSHA256(fs.readFileSync(file)) === sha;
    for (const file of files) {
      if (!BOX_FILE.test(file) || file.split("/").includes("..")) throw new Error("The release names a file outside the box.");
      if (!matches(path.join(stage, "files", file), box.files[file])) throw new Error("The release's files aren't what it says.");
    }
    // Its bundles, each swapped whole, so nothing in one that `box.json` doesn't name. A Mac's
    // alone: on Linux they're left out.
    if (box.bundles !== undefined && !isObject(box.bundles)) throw new Error("The release's files aren't what it says.");
    const bundles = Object.keys(box.bundles ?? {}).sort();
    for (const bundle of bundles) {
      const listed = box.bundles![bundle];
      if (!BUNDLE.test(bundle) || files.includes(bundle) || !isObject(listed)) throw new Error("The release names a file outside the box.");
      for (const [inner, sha] of Object.entries(listed)) {
        if (!BUNDLE_PART.test(inner)) throw new Error("The release names a file outside the box.");
        if (!matches(path.join(stage, "files", bundle, inner), sha)) throw new Error("The release's files aren't what it says.");
      }
      for (const entry of fs.readdirSync(path.join(stage, "files", bundle), { recursive: true, encoding: "utf8" })) {
        const stat = fs.lstatSync(path.join(stage, "files", bundle, entry));
        if (!stat.isDirectory() && !(stat.isFile() && Object.hasOwn(listed, entry))) throw new Error("The release's files aren't what it says.");
      }
    }
    if (process.platform !== "darwin") bundles.length = 0;
    if (!files.includes("bin/box-version") || fs.readFileSync(path.join(stage, "files", "bin", "box-version"), "utf8").trim() !== manifest.version) throw new Error("The release's files aren't what it says.");
    // COMPAT(0.7 files): the release's tools kept in `bin/.own`. Goes 3 months after 0.8.0.
    // Its tools kept as the box's own too (and put back with the rest, if it goes back).
    for (const tool of OWN_TOOLS) {
      if (!files.includes(`bin/${tool}`)) continue;
      const from = path.join(stage, "files", "bin", tool), own = path.join(stage, "files", "bin", ".own", tool);
      fs.mkdirSync(path.dirname(own), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, own);
      fs.chmodSync(own, fs.statSync(from).mode & 0o777);
      files.push(`bin/.own/${tool}`);
    }
    // Each bundle in among the files, as one (before the keeper's mark, last).
    files.splice(0, files.length, ...installOrder([...files, ...bundles]));

    // Its engine, unless it's here already.
    const engineFolder = path.join(K, "engine", manifest.engine);
    let staged = null;
    if (!fs.existsSync(path.join(engineFolder, "opencode"))) {
      // (Another kind of machine has none: no kind, and no build.)
      const kind = { x64: "x86_64", arm64: "aarch64" }[os.arch() as "x64" | "arm64"];
      const build = (process.platform === "darwin" ? manifest.darwin : manifest.linux)?.[kind];
      if (!build?.url || !/^sha512-/.test(build.integrity ?? "")) throw new Error("The release has no engine for this machine.");
      step("downloading the engine");
      const tarball = await fetched(build.url, 400_000_000, 900_000);
      if (crypto.createHash("sha512").update(tarball).digest("base64") !== build.integrity!.slice(7)) throw new Error("The engine isn't what the release says.");
      fs.writeFileSync(path.join(stage, "engine.tgz"), tarball, { mode: 0o600 });
      fs.mkdirSync(path.join(stage, "engine"), { mode: 0o700 });
      if (ran("tar", ["xzf", path.join(stage, "engine.tgz"), "-C", path.join(stage, "engine"), "package/bin/opencode"]).status !== 0) throw new Error("The engine couldn't be unpacked.");
      staged = path.join(stage, "engine", "package", "bin", "opencode");
      fs.chmodSync(staged, 0o755);
    }

    // Tried before anything's swapped: the engine runs, the new bridge works with it, the keeper reads.
    step("checking it");
    const engine = staged ?? path.join(engineFolder, "opencode");
    if (ran(engine, ["--version"]).status !== 0) throw new Error("The new engine doesn't run here.");
    const tried = ran(engine, ["--config=/dev/null", "--no-env-file", path.join(stage, "files", "bin", "kuvo-link.js"), "selftest"], { BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: K });
    if (tried.status !== 0 || !tried.output.includes("ok")) throw new Error("The new link doesn't work with it here.");
    if (ran("sh", ["-n", path.join(stage, "files", "bin", "kuvo-start")]).status !== 0) throw new Error("The new keeper doesn't read.");
    if (!now && await boxBusy()) return { result: "busy", message: "Something is running there now." };

    // Stopped, for sure, before anything's copied; what's there kept; then the new in its place,
    // one file at a time, and started again.
    step("installing");
    let previous: Partial<EngineRecord> = {};
    try { previous = readEngineFile(); } catch {}
    const withAgents = Boolean(previous?.agentsPort) && fs.existsSync(path.join(stage, "files", "bin", "kuvo-agents.js"));
    const otherEngine = previous?.version !== manifest.engine;
    if (otherEngine && !roomForData()) throw new Error("There isn't room on it to keep its data while it updates.");
    // What's there kept, and how to put it back, before the engine stops: a stop the update
    // doesn't get past (the machine going down) is put back too, its engine started again.
    keepForRollback(files, otherEngine, new Set(bundles));
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock() }, running: null });
    fs.writeFileSync(UPDATE_TRIAL, manifest.version, { mode: 0o600 });
    trial = true;
    stopped = true;
    const stop = ran("sh", [path.join(K, "bin", "kuvo-start"), "stop"], {}, 300_000);
    if (stop.status !== 0 || (previous?.pid && alive(previous.pid))) throw new Error("Its engine couldn't be stopped to update it.");
    if (otherEngine) keepData();
    swapped = true;
    swapping();
    if (staged) {
      fs.mkdirSync(engineFolder, { recursive: true, mode: 0o700 });
      fs.renameSync(staged, path.join(engineFolder, "opencode"));
    }
    for (const file of files) {
      const from = path.join(stage, "files", file), to = path.join(K, file);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      if (bundles.includes(file)) {
        swapBundle(from, to);
        continue;
      }
      fs.copyFileSync(from, `${to}.new`);
      fs.chmodSync(`${to}.new`, fs.statSync(from).mode & 0o777);
      fs.renameSync(`${to}.new`, to);
    }
    ran("sh", [path.join(K, "bin", "kuvo-start"), "start"]);
    step("starting");
    if (!(await cameUp(manifest.engine, withAgents, upWithin))) throw new Error("The new version didn't come up.");
    // What it put there, for telling later whether an older Mac put its own back (`checkDrift`).
    // (Not its bundles: the helper's own keeper may put its own back, which is never drift.)
    writePrivate(path.join(UPDATES, "installed.json"), JSON.stringify({ version: box.version, files: box.files }));
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock(), healthy: true } });
    return { result: "updated", version: manifest.version };
  } catch (error) {
    const message = String((error as Error | undefined)?.message ?? error).slice(0, 300);
    // Room first: what was downloaded goes before anything's put back.
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (swapped) {
      ran("sh", [path.join(ROLLBACK, "restore.sh")], { KUVO_UPDATER: String(process.pid) }, 600_000);
    } else {
      // Nothing changed: what was kept goes, and the engine starts again if it was stopped.
      if (trial) {
        fs.rmSync(UPDATE_TRIAL, { force: true });
        fs.rmSync(ROLLBACK, { recursive: true, force: true });
      }
      if (stopped) ran("sh", [path.join(K, "bin", "kuvo-start"), "start"]);
    }
    if (trial) noteUpdate({ trial: null });
    noteUpdate({ last: { at: clock(), result: "failed", message, from: before } });
    return { result: "failed", message };
  } finally {
    clearUpdateStaging();
    fs.rmSync(UPDATE_LOCK, { recursive: true, force: true });
  }
}

// A bundle in place whole, from where it's staged (on the same disk): the new beside the one
// there, that one put aside, the new renamed in, the old gone. A program running from the old one
// runs on (its keeper restarts it).
function swapBundle(from: string, to: string): void {
  const fresh = `${to}.new`, old = `${to}.old`;
  fs.rmSync(fresh, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(from, fresh);
  if (fs.existsSync(to)) fs.renameSync(to, old);
  fs.renameSync(fresh, to);
  fs.rmSync(old, { recursive: true, force: true });
}

// A release's file in a folder here: a file, not too big, read whole; or why it can't be.
function readRelease(file: string, limit: number): Buffer {
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.size <= limit) return fs.readFileSync(file);
  } catch {}
  throw new Error("That release can't be read.");
}

// The name of a release's pack, as its address ends: in a folder here, it's beside `boxes.json`.
function packName(manifest: BoxRelease): string {
  let name = "";
  try { name = decodeURIComponent(path.posix.basename(new URL(manifest.pack.url).pathname)); } catch {}
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("That isn't a release.");
  return name;
}

/** What an update staged in `updates` taken away as it ends, whatever came of it: never what's kept
 * there for good (its rollback, what it installed, a release offered from a folder here, and a
 * move of this Mac's box, `rehome`: its state and kept originals, which `rehome/state.ts` keeps
 * there). */
export function clearUpdateStaging(folder = UPDATES): void {
  const kept = new Set(["rollback", "installed.json", "rehome", "offered"]);
  for (const name of listOf(folder)) if (!kept.has(name)) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
}

// The new bridge, once an update put it there: well, the update's done. What was kept goes, and
// engines but this one.
export function confirmUpdate(clock = Date.now): boolean {
  const state = updateState();
  if (!state.trial?.healthy || boxVersion() !== state.trial.to || isUpdating()) return false;
  let engine: string | null | undefined = null;
  try { engine = readEngineFile()?.version; } catch {}
  fs.rmSync(UPDATE_TRIAL, { force: true });
  fs.rmSync(ROLLBACK, { recursive: true, force: true });
  if (engine) for (const name of listOf(path.join(K, "engine"))) if (name !== engine && !name.startsWith(".")) fs.rmSync(path.join(K, "engine", name), { recursive: true, force: true });
  noteUpdate({ trial: null, last: { at: clock(), result: "updated", from: state.trial.from, to: state.trial.to } });
  return true;
}

// COMPAT(0.7 visits): "an older Mac" in `launchers.json`. Goes 3 months after 0.8.0.
// An older Mac (Kuvo Code 0.7 and before) to hold updates back for, from now: it would put back
// its own files.
function noteOlderMac(at: number): void {
  let launchers: Record<string, number> = {};
  try { launchers = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  if ((launchers["an older Mac"] ?? 0) >= at) return;
  launchers["an older Mac"] = at;
  try { writePrivate(LAUNCHERS, JSON.stringify(launchers)); } catch {}
}

// COMPAT(0.7 visits): `run/attached` and `run/older-mac`, an older Mac's visits. Goes 3 months after 0.8.0.
// An older Kuvo Code on a Mac touches `run/attached` each time it connects, and this one never
// does: one that did lately holds this box's updates back (it would put back its own files). Not
// a touch from before a Kuvo Code that marks the box last put its files there: that was most
// likely the same Mac before it updated, and an older one still around touches it again.
export function noteOlderMacs(): boolean {
  let at = 0, marked = 0;
  try {
    at = fs.statSync(path.join(RUN, "attached")).mtimeMs;
    marked = fs.statSync(path.join(K, "bin", "box-version")).mtimeMs;
  } catch {}
  if (at <= marked) at = 0;
  // One a Mac's mark saw since the last check (`run/older-mac`), which marking hides.
  try { at = Math.max(at, fs.statSync(path.join(RUN, "older-mac")).mtimeMs); } catch {}
  if (!at || Date.now() - at > MAC_MEMORY) return false;
  noteOlderMac(at);
  return true;
}

/** What an update put there (`updates/installed.json`): its version, and each file's SHA-256. */
interface Installed {
  version: string;
  files: Record<string, string>;
}

// COMPAT(0.7 files): how long a Mac's `run/mac-installing` counts. Goes 3 months after 0.8.0.
const MAC_INSTALLING = 3600_000;

// COMPAT(0.7 visits): drift, an older Mac's files put back over an update's. Goes 3 months after 0.8.0.
// Whether a Mac that doesn't leave a newer box as it is (an older Kuvo Code) put its own files back
// since the box updated itself (seen twice, ten minutes apart, and not while a Mac says it puts its
// files in place): then the box doesn't update itself for a while, as that Mac would undo it, and
// says why. Its version mark stays, so no other older Mac takes it further back.
export function checkDrift(now = Date.now()): boolean {
  const record = path.join(UPDATES, "installed.json"), pending = path.join(RUN, "update-drift");
  // A Mac's note that it puts its files in place (`run/mac-installing`) counts for an hour. One
  // whose connect was cut off before it marked the box (Disconnect, Remove, the network) is left
  // behind: past the hour, it goes.
  const note = path.join(RUN, "mac-installing");
  let installing = 0;
  try { installing = fs.statSync(note).mtimeMs; } catch {}
  if (installing && now - installing >= MAC_INSTALLING) {
    fs.rmSync(note, { force: true });
    installing = 0;
  }
  // Not while the box updates itself, or tries what it updated to: its files and version change then.
  if (isUpdating() || fs.existsSync(UPDATE_TRIAL)) return false;
  let installed: Installed | null = null;
  try { installed = JSON.parse(fs.readFileSync(record, "utf8")); } catch { return false; }
  // A Mac marked it since (its own files, as they should be).
  if (installed?.version !== boxVersion() || !isObject(installed.files)) {
    fs.rmSync(record, { force: true });
    fs.rmSync(pending, { force: true });
    return false;
  }
  const changed = Object.entries(installed.files).some(([file, sha]) => {
    try { return hexSHA256(fs.readFileSync(path.join(K, file))) !== sha; } catch { return true; }
  });
  if (!changed || isUpdating() || now - installing < MAC_INSTALLING) {
    fs.rmSync(pending, { force: true });
    return false;
  }
  if (textOf(pending)?.trim() !== installed.version) {
    try { writePrivate(pending, installed.version); } catch {}
    return false;
  }
  noteOlderMac(now);
  noteUpdate({ last: { at: now, result: "failed", message: "An older Kuvo Code on a Mac put its own files back here: update Kuvo Code on your Macs." } });
  return true;
}

// Whether it's the night's window where you are (02:00 to 05:00, `KUVO_TZ`), and which night.
export function updateNight(date = new Date(), zone: string | undefined = process.env.KUVO_TZ): string | null {
  return nightOf(date, zone);
}

// What `kuvo/update` says: whether updates are set up, this version and the newest heard of, how
// the last went, whether one runs now, why not, when it can't, and a release offered from a folder
// here that waits for a quiet moment.
export function updateStatus(): UpdateStatus {
  const state = updateState();
  const offered = offeredVersion();
  let engine: string | null = null;
  try { engine = readEngineFile()?.version ?? null; } catch {}
  return {
    setUp: UPDATE_KEYS.length > 0,
    version: boxVersion(),
    engine,
    latest: state.latest ?? null,
    last: state.last ?? null,
    updating: isUpdating() ? state.running ?? "checking" : null,
    blocked: updatesBlocked(),
    ...(offered ? { offered } : {}),
    // How the release offered from a folder here last went, when taking it failed: its own outcome,
    // apart from the night's (`last`), which Kuvo Code here goes by (#679).
    ...(state.offerFailed ? { offerFailed: { version: state.offerFailed.version, at: state.offerFailed.at, takenBack: state.offerFailed.takenBack, ...(state.offerFailed.message ? { message: state.offerFailed.message } : {}) } } : {}),
  };
}

// An update run by the bridge (a phone's or a Mac's Update Now, or the night's): one at a time;
// once it's "updated", the bridge goes, for the keeper to start the new one.
let updating: Promise<UpdateOutcome | null> | null = null;
export function startUpdate(options: UpdateOptions = {}): Promise<UpdateOutcome | null> | null {
  if (updating || isUpdating()) return null;
  updating = update({ ...options, step: running => noteUpdate({ running }) })
    .then(outcome => {
      noteUpdate({ running: null, ...(outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } }) });
      if (outcome.result === "updated") setTimeout(() => process.exit(0), 1000);
      return outcome;
    }, () => null)
    .finally(() => { updating = null; });
  return updating;
}

// This box's updates (PROTOCOL.md, "Updates"): how it stands, Update Now. It always updates
// by itself: there's no switch.
export async function* updateRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (method === "GET") return yield* json(200, updateStatus());
  if (method === "POST") {
    if ((parsed(request.body) as Body<"now">)?.now !== true) return yield* json(400, { message: "Say to update now (now)." });
    if (!UPDATE_KEYS.length) return yield* json(409, { message: "Updates aren't set up for this machine yet." });
    const blocked = updatesBlocked();
    if (blocked) return yield* json(409, { message: blocked });
    return yield* (startUpdate({ now: true }) ? json(202, updateStatus()) : json(409, { message: "It's updating already." }));
  }
  return yield* json(405, {});
}

// The version of the release offered from a folder here (`updates/offered`), or null: checked as
// it was offered, and again as it's taken.
export function offeredVersion(): string | null {
  try {
    const given = JSON.parse(fs.readFileSync(path.join(OFFERED, "boxes.json"), "utf8"));
    const version = JSON.parse(Buffer.from(given.manifest, "base64").toString("utf8"))?.version;
    return versionOrder(version) ? version : null;
  } catch { return null; }
}

const dropOffer = (): void => fs.rmSync(OFFERED, { recursive: true, force: true });

/** What offering a release says: 202 and its version, or why not (400 not asked right, 409 not
 * now or not newer, 422 not a release this box takes). */
export interface Offered {
  status: 202 | 400 | 409 | 422;
  version?: string;
  message?: string;
}

// Whether a release offered from a folder here rests now, `version` at `now`: it failed as it was
// taken lately (a day once it was taken back, an hour when it failed before anything changed), or
// the update to it was taken back by the keeper (its new bridge never said it was well: the trial
// says it's on its way to it, and the box is back where it was).
function offerRests(version: string, now: number): boolean {
  const { offerFailed: failed, trial } = updateState();
  if (failed?.version === version && now - failed.at < (failed.takenBack || (failed.tries ?? 1) > 1 ? OFFER_REST : OFFER_RETRY)) return true;
  return trial?.to === version && boxVersion() !== version && !updateOnTrial() && now - trial.at < OFFER_REST;
}

/** A release offered from a folder on this computer (`kuvo/box/update {from}`: the one Kuvo Code
 * carries, as it updates): `boxes.json` and the pack it names, beside it. Checked as a downloaded
 * one is (the signature, a newer version, the pack's SHA-256), then kept in `updates/offered` (the
 * folder may go, the app updated again) for the next quiet moment (`takeOffer`), under the update
 * lock, so a take never reads it half replaced. Not one that was put in place lately and taken
 * back. `keys`, `blocked` and `clock`: a test's. */
export function offerUpdate(from: unknown, { keys = UPDATE_KEYS, blocked = updatesBlocked(), clock = Date.now }: Pick<UpdateOptions, "keys" | "blocked" | "clock"> = {}): Offered {
  if (typeof from !== "string" || !path.isAbsolute(from)) return { status: 400, message: "Say which folder the release is in (from), as a full path." };
  if (!keys.length) return { status: 409, message: "Updates aren't set up for this machine yet." };
  if (blocked) return { status: 409, message: blocked };
  const before = boxVersion();
  if (!before) return { status: 409, message: "This machine's version isn't known: connect to it from Kuvo Code on your Mac once." };
  if (updating || isUpdating()) return { status: 409, message: "It's updating already." };
  let boxes: Buffer, manifest: BoxRelease, name: string;
  try {
    boxes = readRelease(path.join(from, "boxes.json"), 1_000_000);
    manifest = verifyBoxes(boxes.toString("utf8"), keys);
    name = packName(manifest);
  } catch (error) {
    return { status: 422, message: String((error as Error | undefined)?.message ?? error).slice(0, 300) };
  }
  if (!newerVersion(manifest.version, before)) return { status: 409, message: `It has ${before} already, and takes only a newer version.` };
  const offered = offeredVersion();
  if (offered && newerVersion(offered, manifest.version)) return { status: 409, message: `A newer release (${offered}) waits to be taken already.` };
  const { offerFailed: failed } = updateState();
  if (offerRests(manifest.version, clock()) && (failed?.version !== manifest.version || failed.takenBack)) return { status: 409, message: `It tried ${manifest.version} lately and went back to what it had: it takes it again tomorrow.` };
  // The same, offered again (as Kuvo Code reconnects): it's there already.
  if (offered === manifest.version) return { status: 202, version: manifest.version };
  let pack: Buffer;
  try {
    pack = readRelease(path.join(from, name), 100_000_000);
  } catch (error) {
    return { status: 422, message: String((error as Error | undefined)?.message ?? error) };
  }
  if (hexSHA256(pack) !== manifest.pack.sha256) return { status: 422, message: "The release's files aren't what it says." };
  // Kept whole or not at all, and never while a take could be reading it.
  if (!takeUpdateLock()) return { status: 409, message: "It's updating already." };
  const partial = `${OFFERED}.partial`;
  try {
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(partial, "boxes.json"), boxes, { mode: 0o600 });
    fs.writeFileSync(path.join(partial, name), pack, { mode: 0o600 });
    dropOffer();
    fs.renameSync(partial, OFFERED);
  } catch (error) {
    fs.rmSync(partial, { recursive: true, force: true });
    return { status: 409, message: `It couldn't keep the release: ${String((error as Error | undefined)?.message ?? error).slice(0, 200)}` };
  } finally {
    fs.rmSync(UPDATE_LOCK, { recursive: true, force: true });
  }
  return { status: 202, version: manifest.version };
}

/** Whether the release offered from a folder here is to be taken now: newer than the box, not
 * resting after a failure, and nothing in the way (an update under way or on trial, a block, a
 * stopped engine, something running). One the box has caught up with goes. `blocked` and `clock`:
 * a test's. */
export async function offerDue({ blocked = updatesBlocked(), clock = Date.now }: Pick<UpdateOptions, "blocked" | "clock"> = {}): Promise<boolean> {
  const offered = offeredVersion(), before = boxVersion();
  // (None, or one being written: nothing to do yet.)
  if (!offered) return false;
  if (before && !newerVersion(offered, before)) {
    // (Not while an update could be writing a new one in its place.)
    if (!isUpdating()) dropOffer();
    return false;
  }
  return !blocked && !!before && !updating && !isUpdating() && !updateOnTrial() && !fs.existsSync(path.join(RUN, "stopped")) && !offerRests(offered, clock()) && !(await boxBusy());
}

/** The release offered from a folder here, taken when it's due (`offerDue`), as `update --offered`
 * does in a process of its own. Taken, or no longer newer, it goes. One that fails once it was put
 * in place is taken back, goes, and rests a day (offered again sooner, it's refused); one that
 * fails before anything changed stays, and is tried again in an hour, then a day after each next
 * failure. Busy, it waits. Nothing due: null. */
export async function takeOffer(options: UpdateOptions = {}): Promise<UpdateOutcome | null> {
  if (!(await offerDue(options))) return null;
  let version = offeredVersion()!, takenBack = false;
  const outcome = await update({ ...options, from: OFFERED, swapping: () => { takenBack = true; }, taking: taken => { version = taken; } });
  if (outcome.result === "failed") {
    const before = updateState().offerFailed;
    const tries = before?.version === version && !before.takenBack ? (before.tries ?? 1) + 1 : 1;
    noteUpdate({ offerFailed: { version, at: (options.clock ?? Date.now)(), takenBack, tries, ...(outcome.message ? { message: outcome.message } : {}) } });
  }
  if (outcome.result === "updated" || outcome.result === "current") noteUpdate({ offerFailed: null });
  if (outcome.result === "updated" || outcome.result === "current" || takenBack) dropOffer();
  return outcome;
}

/** The offered release taken in a process of its own (`kuvo-link.js update --offered`), as Update
 * Now's is, when it's due: never in the process that asks, whose answer it would outlive, and
 * which isn't the bridge that goes for the keeper to start the new one. */
export async function startOfferedUpdate(): Promise<boolean> {
  if (!(await offerDue())) return false;
  spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "update", "--offered"], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
  return true;
}

// A release from a folder on this computer (PROTOCOL.md, "Updates"): offered by Kuvo Code here
// (never a phone), checked now, taken at the next quiet moment.
export async function* boxUpdateRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  if (!request.fromApp && !request.fromMac) return yield* json(403, { message: "Only Kuvo Code offers this box a release." });
  const given = parsed(request.body);
  const offered = offerUpdate(isObject(given) ? given.from : undefined);
  if (offered.status !== 202) return yield* json(offered.status, { message: offered.message });
  startOfferedUpdate().catch(() => {});
  return yield* json(202, updateStatus());
}
