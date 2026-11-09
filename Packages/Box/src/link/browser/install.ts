// The browser on a machine (PROTOCOL.md, "The browser on a machine"): Chrome for Testing, which the
// agents there browse with (`kuvo-browser.js`). The box puts it in `~/.kuvo-code/browser` itself,
// with or without a Mac: as its keeper starts, while it's missing, and when a browser tool or a
// client asks. It downloads only the build this version pins (browser/linux.json, browser/mac.json,
// which `scripts/browser-runtime.py` writes, and Kuvo Code's updates bring), only over HTTPS from
// Google's Chrome for Testing and Rocky Linux's packages (the libraries and fonts Chrome needs on
// Linux), checks each file's size and SHA-256 before anything of it is unpacked, and runs nothing
// it downloaded. Nothing is installed on the system.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserStatus } from "../../shared/routes/box";
import { parsed } from "../../shared/json";
import { processRuns } from "../../shared/platform";
import { writePrivate } from "../files";
import { IS_MAC, K, OWN_RUNTIME, REAL_BOX, RUN, SCRIPT } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import { boxVersion } from "../updates/update";
import linux from "./linux.json";
import mac from "./mac.json";
import { cpioEntries, payload, S_IFLNK, S_IFREG } from "./rpm";
import { unzip } from "./zip";

interface Download {
  url: string;
  sha256: string;
  size: number;
}

interface Package {
  name: string;
  version: string;
  repo: string;
  path: string;
  sha256: string;
  size: number;
}

/** A pinned build: Chrome for Testing for each kind of processor, and on Linux the packages that
 * hold what it needs, by kind. */
export interface Runtime {
  chromium: { version: string; x86_64: Download; aarch64: Download };
  packages?: Record<string, Package[]>;
}

export const PINNED: { linux: Runtime; darwin: Runtime } = { linux, darwin: mac };

const BROWSER = () => path.join(K, "browser");
const CURRENT = () => path.join(BROWSER(), "current");
const STATE = () => path.join(RUN, "browser-install.json");
const LOCK = () => path.join(RUN, ".browser-installing");
const STAGING = ".box-staging-";

/** Where the browser may come from: these, over HTTPS, and nowhere else. */
const SOURCES = [
  "https://storage.googleapis.com/chrome-for-testing-public/",
  "https://dl.rockylinux.org/pub/rocky/8/",
  "https://dl.rockylinux.org/vault/rocky/8.10/",
];

/** Whether `url` is one of the browser's sources. */
export function allowedSource(url: string): boolean {
  let parsedURL: URL;
  try { parsedURL = new URL(url); } catch { return false; }
  if (parsedURL.protocol !== "https:" || parsedURL.username || parsedURL.password || parsedURL.port || parsedURL.search || parsedURL.hash) return false;
  // (As it was written: nothing a URL's parsing would take out, like a `..`.)
  if (parsedURL.href !== url) return false;
  return SOURCES.some(source => url.startsWith(source));
}

/** Whether this box sets up a browser: a machine's own folder, or a test's with stand-ins. */
const downloads = (): boolean => !IS_MAC && (REAL_BOX || testSource() !== null);

/** A test's stand-in for those sources and pins (only in a test's folder, never a machine's own):
 * `KUVO_BROWSER_SOURCE` an address that serves `<host>/<path>`, `KUVO_BROWSER_PINS` a file with
 * `{linux?, darwin?}`, `KUVO_BROWSER_SYSTEM` the system to set up for. A test's folder without them downloads nothing. */
function testSource(): string | null {
  return !REAL_BOX && process.env.KUVO_BROWSER_SOURCE ? process.env.KUVO_BROWSER_SOURCE.replace(/\/+$/, "") : null;
}

/** A test's system to set up for (`KUVO_BROWSER_SYSTEM`, linux or darwin), in a test's folder only. */
function testSystem(): NodeJS.Platform | null {
  const given = process.env.KUVO_BROWSER_SYSTEM;
  return !REAL_BOX && (given === "linux" || given === "darwin") ? given : null;
}

function pinned(system: "linux" | "darwin"): Runtime {
  if (!REAL_BOX && process.env.KUVO_BROWSER_PINS) {
    try {
      const given = JSON.parse(fs.readFileSync(process.env.KUVO_BROWSER_PINS, "utf8"));
      if (given?.[system]) return given[system];
    } catch {}
  }
  return PINNED[system];
}

/** The build for this machine: its system's, its processor's, with its name in `browser`. */
export function runtimeHere(platform: NodeJS.Platform = testSystem() ?? process.platform, arch: string = os.arch()): { runtime: Runtime; id: string; kind: "x86_64" | "aarch64"; mac: boolean } | { unsupported: string } {
  const system = platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : null;
  if (!system) return { unsupported: `The browser runs on Linux and macOS; this machine is ${platform}.` };
  const kind = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!kind) return { unsupported: `The browser runs on machines with x86-64 or ARM64 processors; this one is ${arch}.` };
  const runtime = pinned(system);
  const hash = crypto.createHash("sha256").update(JSON.stringify(runtime)).digest("hex").slice(0, 8);
  return { runtime, id: `${runtime.chromium.version}-${system === "darwin" ? "mac-" : ""}${hash}`, kind, mac: system === "darwin" };
}

/** Chromium's versions in order (155.0.8059.79). */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The browser a build holds: Chrome itself, or the headless shell an earlier build had. */
function hasBrowser(build: string): boolean {
  for (const name of ["chrome", "chrome-headless-shell"]) {
    try {
      fs.accessSync(path.join(build, name), fs.constants.X_OK);
      if (fs.statSync(path.join(build, name)).isFile()) return true;
    } catch {}
  }
  return false;
}

/** The build in use (`browser/current`), whole: its folder, name and Chromium's version. */
export function inUse(): { build: string; id: string; chromium: string } | null {
  let build: string;
  try { build = fs.realpathSync(CURRENT()); } catch { return null; }
  if (!hasBrowser(build)) return null;
  let chromium = "0";
  try { chromium = fs.readFileSync(path.join(build, "chromium-version"), "utf8").trim() || "0"; } catch {}
  return { build, id: path.basename(build), chromium };
}

/** Whether a browser runs from build `id`, by its path (`browser/<id>/`, or its real one: a folder
 * on the way may be a link). */
function running(id: string): boolean {
  const folder = BROWSER();
  let real = folder;
  try { real = fs.realpathSync(folder); } catch {}
  const marks = [`${folder}/${id}/`, `${real}/${id}/`];
  if (fs.existsSync("/proc/self")) {
    for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
      try {
        const line = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (marks.some(mark => line.includes(mark))) return true;
      } catch {}
    }
    return false;
  }
  try {
    const listed = execFileSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
    return marks.some(mark => listed.includes(mark));
  } catch {
    // (Unknown: taken as running, so nothing is removed from under it.)
    return true;
  }
}

// MARK: - What it says

type Step = "checking" | "downloading" | "installing";
interface Record_ {
  state?: "ready" | "failed" | Step;
  progress?: number;
  message?: string;
  at?: number;
  failures?: number;
  retryAt?: number | null;
  /** The build it was setting up: a failure of another (before an update) doesn't hold this one back. */
  id?: string;
  /** The last time a build was set up again because it didn't start (`repair`), and which. */
  repairedAt?: number;
  repairedId?: string;
}

const readRecord = (): Record_ => {
  try { return JSON.parse(fs.readFileSync(STATE(), "utf8")) ?? {}; } catch { return {}; }
};
function note(change: Record_): void {
  const record = { ...readRecord(), ...change, at: Date.now() };
  for (const [key, value] of Object.entries(change)) if (value === undefined) delete record[key as keyof Record_];
  try { writePrivate(STATE(), JSON.stringify(record)); } catch {}
}

/** Whether a setup is under way (its process holds `run/.browser-installing`). */
export function installing(): boolean {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(LOCK(), "pid"), "utf8")); } catch {
    // Just made, its process not written yet.
    try { return Date.now() - fs.statSync(LOCK()).mtimeMs < 60_000; } catch { return false; }
  }
  return pid === process.pid || processRuns(pid, "kuvo-link");
}

/** How the browser stands here (`kuvo/browser`): what's in use, what's under way, why it failed. */
export function browserStatus(): BrowserStatus {
  const here = runtimeHere();
  const chromium = "runtime" in here ? here.runtime.chromium.version : null;
  const now = inUse();
  const installed = now ? now.chromium : null;
  if (IS_MAC) return { state: "missing", chromium: null, installed: null, progress: null, message: "This Mac's agents browse in its app's panel.", retryAt: null };
  if ("unsupported" in here) return { state: "failed", chromium, installed, progress: null, message: here.unsupported, retryAt: null };
  const record = readRecord();
  const underWay = record.state === "checking" || record.state === "downloading" || record.state === "installing";
  // (Just asked for: its process may not have taken the lock yet.)
  if (underWay && (installing() || (record.state === "checking" && Date.now() - (record.at ?? 0) < 30_000))) {
    return { state: record.state as Step, chromium, installed, progress: record.state === "downloading" ? record.progress ?? 0 : null, message: null, retryAt: null };
  }
  if (underWay) return { state: "failed", chromium, installed, progress: null, message: "Setting up the browser stopped before it finished. It starts again in a minute.", retryAt: null };
  // The pinned build's in use (another setup put it there since one failed).
  if (now && chromium && compareVersions(now.chromium, chromium) >= 0) return { state: "ready", chromium, installed, progress: null, message: null, retryAt: null };
  if (record.state === "failed" && (!record.id || record.id === here.id)) return { state: "failed", chromium, installed, progress: null, message: record.message ?? "The browser couldn't be set up.", retryAt: record.retryAt ?? null };
  if (now) return { state: "ready", chromium, installed, progress: null, message: null, retryAt: null };
  if (!downloads()) return { state: "missing", chromium, installed, progress: null, message: "Only a machine's own Kuvo Code folder downloads the browser.", retryAt: null };
  return { state: "missing", chromium, installed, progress: null, message: null, retryAt: null };
}

// MARK: - Setting it up

class SetupError extends Error {
  constructor(message: string, readonly retry = true) {
    super(message);
  }
}

/** How long it waits after a failure before it tries again by itself: longer each time. */
const retryAfter = (failures: number): number => [60_000, 300_000, 900_000][failures - 1] ?? 3_600_000;
const inWords = (ms: number): string => (ms < 120_000 ? "in a minute" : ms < 3_600_000 ? `in ${Math.round(ms / 60_000)} minutes` : "in an hour");

/** A source's address as it's fetched: itself, or a test's stand-in. */
function fetchedFrom(url: string): string {
  if (!allowedSource(url)) throw new SetupError(`Kuvo Code doesn't download the browser from ${url}.`, false);
  const source = testSource();
  return source ? `${source}/${url.slice("https://".length)}` : url;
}

const hostOf = (url: string): string => new URL(url).host;

/** Downloads `url` into `to`, checking its size and SHA-256 as it comes: "missing" when the source
 * hasn't it (404), else it's there whole and checked, or it throws (and nothing's left). */
async function download(url: string, expected: { sha256: string; size: number }, to: string, received: (bytes: number) => void, signal: AbortSignal): Promise<"ok" | "missing"> {
  const address = fetchedFrom(url);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop);
  // Nothing for a minute: the connection's gone. And never longer than a slow connection takes
  // (50 KB a second), or ten minutes, whichever is longer.
  let idle = setTimeout(stop, 60_000);
  const deadline = setTimeout(stop, Math.max(600_000, (expected.size / 50_000) * 1000));
  const awake = () => {
    clearTimeout(idle);
    idle = setTimeout(stop, 60_000);
  };
  const settle = () => {
    clearTimeout(idle);
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
  };
  let response: Response;
  try {
    response = await fetch(address, { redirect: "error", signal: controller.signal });
  } catch (error) {
    settle();
    const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
    if (signal.aborted) throw new SetupError("Stopped.");
    throw new SetupError(`Couldn't reach ${hostOf(url)} to download the browser (${cause?.code ?? cause?.message ?? (error as Error)?.message ?? "no connection"}): the machine needs to reach storage.googleapis.com${testSystem() === "darwin" || (!testSystem() && process.platform === "darwin") ? "" : " and dl.rockylinux.org"} over HTTPS.`);
  }
  if (response.status === 404) {
    settle();
    await response.body?.cancel().catch(() => {});
    return "missing";
  }
  if (!response.ok || !response.body) {
    settle();
    await response.body?.cancel().catch(() => {});
    throw new SetupError(`${hostOf(url)} answered ${response.status} for the browser's download.`);
  }
  const fd = fs.openSync(to, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const hash = crypto.createHash("sha256");
  let bytes = 0, done = false;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      awake();
      bytes += chunk.length;
      if (bytes > expected.size) throw new SetupError(`The browser's download from ${hostOf(url)} is larger than it should be, so it wasn't used.`);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) written += fs.writeSync(fd, chunk, written);
      received(bytes);
    }
    if (bytes !== expected.size) throw new SetupError(`The browser's download from ${hostOf(url)} stopped partway.`);
    if (hash.digest("hex") !== expected.sha256) throw new SetupError(`The browser's download from ${hostOf(url)} isn't what Kuvo Code expects (its checksum doesn't match), so it wasn't used.`);
    done = true;
    return "ok";
  } catch (error) {
    if (error instanceof SetupError) throw error;
    if (signal.aborted) throw new SetupError("Stopped.");
    throw new SetupError(`The browser's download from ${hostOf(url)} stopped partway (${controller.signal.aborted ? "it came too slowly" : (error as Error)?.message ?? "the connection closed"}).`);
  } finally {
    settle();
    await response.body?.cancel().catch(() => {});
    fs.closeSync(fd);
    if (!done) fs.rmSync(to, { force: true });
  }
}

/** Where a package downloads from: Rocky Linux's current repositories, then its vault, which keeps
 * every release's packages once a newer one replaces them. */
const packageURLs = (each: Package, kind: string): string[] =>
  ["https://dl.rockylinux.org/pub/rocky/8", "https://dl.rockylinux.org/vault/rocky/8.10"].map(base => `${base}/${each.repo}/${kind}/os/${each.path}`);

const SAFE_NAME = /^[^/\0]+$/;
const safe = (name: string): boolean => SAFE_NAME.test(name) && name !== "." && name !== "..";

/** What the browser takes from a package's files: its libraries (with the links between their
 * names) in `lib`, its fonts in `fonts`, its licenses in `licenses`. Nothing else, and only by names
 * of the package's own, never a path it gives. */
function takeFrom(archive: Buffer, bundle: string): void {
  const write = (file: string, data: Buffer, mode: number) => {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode); } catch (error) {
      // (Another package had a file by that name: the first stays.)
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return;
    }
    try {
      let written = 0;
      while (written < data.length) written += fs.writeSync(fd, data, written);
    } finally {
      fs.closeSync(fd);
    }
  };
  for (const entry of cpioEntries(archive)) {
    const name = entry.name.replace(/^\.?\//, "");
    const type = entry.mode & 0o170000;
    let found: RegExpExecArray | null;
    if ((found = /^usr\/lib64\/([^/]+)$/.exec(name)) && found[1].includes(".so") && safe(found[1])) {
      const target = path.join(bundle, "lib", found[1]);
      if (type === S_IFREG) write(target, entry.data, 0o755);
      else if (type === S_IFLNK) {
        // Only to another of its names, beside it.
        const pointsTo = entry.data.toString("utf8");
        if (!/^[A-Za-z0-9._+-]+$/.test(pointsTo) || pointsTo === "." || pointsTo === "..") continue;
        try { fs.symlinkSync(pointsTo, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
    } else if ((found = /^usr\/share\/fonts\/(?:.+\/)?([^/]+\.(?:ttf|otf|ttc))$/i.exec(name)) && type === S_IFREG && safe(found[1])) {
      write(path.join(bundle, "fonts", found[1]), entry.data, 0o644);
    } else if ((found = /^usr\/share\/licenses\/(.+)$/.exec(name)) && type === S_IFREG) {
      const parts = found[1].split("/");
      if (parts.length < 2 || !parts.every(safe)) continue;
      let folder = path.join(bundle, "licenses");
      for (const part of parts.slice(0, -1)) {
        folder = path.join(folder, part);
        if (fs.existsSync(folder) && !fs.lstatSync(folder).isDirectory()) break;
        fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
      }
      if (fs.lstatSync(folder).isDirectory()) write(path.join(folder, parts[parts.length - 1]), entry.data, 0o644);
    }
  }
}

/** A Mac's Chrome for Testing, by the name its program has on Linux, as the keeper looks for it.
 * (Not a link: it finds what it needs beside the path it's started by.) */
export const MAC_LAUNCHER = `#!/bin/sh
exec "$(dirname "$0")/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" "$@"
`;

/** Free room where Kuvo Code keeps its files, in bytes (null if it can't be told). */
function freeRoom(folder: string): number | null {
  try {
    const stats = fs.statfsSync(folder);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {}
  try {
    const free = execFileSync(fs.existsSync("/bin/df") ? "/bin/df" : "/usr/bin/df", ["-Pk", folder], { encoding: "utf8", timeout: 5_000 }).trim().split("\n").pop()?.trim().split(/\s+/)[3];
    return free ? Number(free) * 1024 : null;
  } catch {
    return null;
  }
}

function takeLock(): boolean {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(LOCK(), { mode: 0o700 });
  } catch {
    if (installing()) return false;
    // One left by a setup that went: taken aside in one step, so of two that find it so, one does.
    const aside = `${LOCK()}.gone-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try { fs.renameSync(LOCK(), aside); } catch { return false; }
    fs.rmSync(aside, { recursive: true, force: true });
    try { fs.mkdirSync(LOCK(), { mode: 0o700 }); } catch { return false; }
  }
  fs.writeFileSync(path.join(LOCK(), "pid"), String(process.pid), { mode: 0o600 });
  return true;
}

/** Puts build `bundle` in place as `id` (unless a browser runs from that one already, whole) and in
 * use: `current` moves to it at once, never missing in between. */
function place(id: string, bundle: string): void {
  const folder = BROWSER(), target = path.join(folder, id);
  if (!(fs.existsSync(target) && hasBrowser(target) && running(id))) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(bundle, target);
  }
  const link = path.join(folder, `.current-${process.pid}`);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(id, link);
  try {
    fs.renameSync(link, CURRENT());
  } catch {
    // (A folder there, not a link: it goes.)
    fs.rmSync(CURRENT(), { recursive: true, force: true });
    fs.renameSync(link, CURRENT());
  }
}

/** The builds but `keep`, unless a browser still runs from one (it moves to the new one when it next
 * starts), and what a setup that stopped partway left. Never the browser's data. */
function clearOld(keep: string): void {
  const folder = BROWSER();
  for (const name of fs.readdirSync(folder)) {
    const entry = path.join(folder, name);
    if (name.startsWith(STAGING) || name.startsWith(".current-")) {
      // (Never another setup's at work: its process is in its name.)
      const pid = Number(name.slice(name.startsWith(STAGING) ? STAGING.length : ".current-".length).split("-")[0]);
      if (pid !== process.pid && processRuns(pid, "kuvo-link")) continue;
      fs.rmSync(entry, { recursive: true, force: true });
      continue;
    }
    if (name === keep || name === "profile" || name.startsWith(".")) continue;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(entry); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (!fs.existsSync(path.join(entry, "chrome")) && !fs.existsSync(path.join(entry, "chrome-headless-shell"))) continue;
    if (running(name)) continue;
    fs.rmSync(entry, { recursive: true, force: true });
  }
}

/** How a setup went. */
export type InstallOutcome = "ready" | "installed" | "busy" | "waiting" | "off" | "failed";

/** A build that doesn't start is set up again at most this often: a reason the box can't fix (a
 * library the machine itself lacks) never has it download the browser over and over. */
const REPAIR_EVERY = 6 * 3_600_000;

/** Whether a setup asked for now would do anything: what it comes to without one (null: it would
 * set up the pinned build), and whether a repair asked for still counts. */
function decide({ now, repair }: { now: boolean; repair: boolean }): { outcome: InstallOutcome | null; repair: boolean } {
  if (!downloads()) return { outcome: "off", repair: false };
  const here = runtimeHere();
  if ("unsupported" in here) return { outcome: "failed", repair: false };
  const before = readRecord();
  // (Once in a while for the same build.)
  if (repair && before.repairedId === here.id && Date.now() - (before.repairedAt ?? 0) < REPAIR_EVERY) repair = false;
  const current = inUse();
  if (repair && !current) repair = false;
  if (!repair && current && compareVersions(current.chromium, here.runtime.chromium.version) >= 0) return { outcome: "ready", repair };
  const failedBefore = before.state === "failed" && before.id === here.id;
  if (!now && !repair && failedBefore && (before.retryAt == null || Date.now() < before.retryAt)) return { outcome: "waiting", repair };
  if (installing()) return { outcome: "busy", repair };
  return { outcome: null, repair };
}

/** Checks the browser here, and puts the pinned build in place if it's missing, older, or (`repair`)
 * doesn't start: one setup at a time. After a failure it waits a while before trying again by
 * itself, unless asked `now`. */
export async function installBrowser(asked: { now?: boolean; repair?: boolean } = {}): Promise<InstallOutcome> {
  const here = runtimeHere();
  const { outcome, repair } = decide({ now: asked.now ?? false, repair: asked.repair ?? false });
  const before = readRecord();
  if (outcome === "failed" && "unsupported" in here) {
    note({ state: "failed", message: here.unsupported, retryAt: null, progress: undefined });
    return "failed";
  }
  if (outcome === "ready") {
    if (before.state !== "ready" && !installing()) note({ state: "ready", failures: 0, retryAt: null, message: undefined, progress: undefined });
    return "ready";
  }
  if (outcome) return outcome;
  if ("unsupported" in here) return "failed";
  if (!takeLock()) return "busy";
  // (Counted until one goes well, whoever asked in between.)
  const failedBefore = (before.failures ?? 0) > 0 && before.id === here.id;
  const current = inUse();
  const folder = BROWSER();
  let staging: string | null = null;
  // The first failure stops every download still going, before anything's said or cleared.
  const stop = new AbortController();
  try {
    note({ state: "checking", progress: undefined, message: undefined, ...(repair ? { repairedAt: Date.now(), repairedId: here.id } : {}) });
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    clearOld(current?.id ?? here.id);
    const { runtime, id, kind, mac } = here;
    const chromium = runtime.chromium[kind];
    const packages = mac ? [] : runtime.packages?.[kind] ?? [];
    if (!mac && !packages.length) throw new SetupError("This build of Kuvo Code has no browser for this machine.", false);
    const total = chromium.size + packages.reduce((sum, each) => sum + each.size, 0);
    // Its downloads, Chrome unpacked, and the libraries beside it, at once at most.
    const needed = total * 4 + 200_000_000;
    const room = freeRoom(folder);
    if (room !== null && room < needed) throw new SetupError(`There isn't room for the browser on this machine: it needs about ${Math.ceil(needed / 1e9 * 10) / 10} GB free where Kuvo Code keeps its files.`);

    staging = path.join(folder, `${STAGING}${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    const bundle = path.join(staging, "bundle");
    for (const each of [staging, bundle, path.join(bundle, "lib"), path.join(bundle, "fonts"), path.join(bundle, "licenses")]) fs.mkdirSync(each, { recursive: true, mode: 0o755 });
    fs.chmodSync(staging, 0o700);

    // Downloads, by size, for how far along it is.
    const got = new Map<string, number>();
    let said = -1, saidAt = 0;
    const received = (name: string, bytes: number) => {
      if (stop.signal.aborted) return;
      got.set(name, bytes);
      const progress = Math.min(1, [...got.values()].reduce((sum, each) => sum + each, 0) / total);
      if (progress - said >= 0.01 || Date.now() - saidAt > 2_000 || progress === 1) {
        said = progress;
        saidAt = Date.now();
        note({ state: "downloading", progress: Math.floor(progress * 1000) / 1000 });
      }
    };
    note({ state: "downloading", progress: 0 });
    const zip = path.join(staging, "chromium.zip");
    if ((await download(chromium.url, chromium, zip, bytes => received("chromium", bytes), stop.signal)) === "missing") {
      throw new SetupError(`${hostOf(chromium.url)} doesn't have the browser this Kuvo Code pins (Chrome for Testing ${runtime.chromium.version}): update Kuvo Code.`, false);
    }

    // The packages, a few at a time, each checked, then what the browser needs of it taken.
    const queue = [...packages];
    const worker = async () => {
      for (let each = queue.shift(); each && !stop.signal.aborted; each = queue.shift()) {
        const file = path.join(staging!, `${each.name.replace(/[^A-Za-z0-9._+-]/g, "_")}.rpm`);
        let outcome: "ok" | "missing" = "missing";
        for (const url of packageURLs(each, kind)) {
          outcome = await download(url, each, file, bytes => received(each.name, bytes), stop.signal);
          if (outcome === "ok") break;
        }
        if (outcome === "missing") throw new SetupError(`Rocky Linux no longer has ${each.name} ${each.version}, which the browser needs: update Kuvo Code.`, false);
        if (stop.signal.aborted) return;
        const archive = payload(fs.readFileSync(file));
        fs.rmSync(file, { force: true });
        takeFrom(archive, bundle);
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(4, packages.length) }, () => worker().catch(error => {
      stop.abort();
      throw error;
    })));
    const failed = settled.find((each): each is PromiseRejectedResult => each.status === "rejected");
    // (The first one's reason: the others only stopped for it.)
    if (failed) throw settled.map(each => (each.status === "rejected" ? each.reason : null)).find(reason => reason && !(reason instanceof SetupError && reason.message === "Stopped.")) ?? failed.reason;

    // Chrome: its folder's files at the top of the build.
    note({ state: "installing", progress: undefined });
    const unpacked = path.join(staging, "chromium");
    fs.mkdirSync(unpacked, { mode: 0o700 });
    await unzip(zip, unpacked);
    fs.rmSync(zip, { force: true });
    const top = fs.readdirSync(unpacked).find(name => name.startsWith("chrome-") && fs.lstatSync(path.join(unpacked, name)).isDirectory());
    if (!top) throw new SetupError("The browser's download has no browser in it.", false);
    for (const name of fs.readdirSync(path.join(unpacked, top))) {
      if (fs.existsSync(path.join(bundle, name))) throw new SetupError(`The browser's download has ${name} twice.`, false);
      fs.renameSync(path.join(unpacked, top, name), path.join(bundle, name));
    }
    if (mac) fs.writeFileSync(path.join(bundle, "chrome"), MAC_LAUNCHER, { mode: 0o755 });
    fs.writeFileSync(path.join(bundle, "chromium-version"), runtime.chromium.version + "\n", { mode: 0o644 });
    // Which Kuvo Code put it there, so an older one on a Mac leaves it in place.
    fs.writeFileSync(path.join(bundle, "kuvo-version"), (boxVersion() ?? "") + "\n", { mode: 0o644 });
    if (!hasBrowser(bundle) || (mac && !fs.existsSync(path.join(bundle, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")))) {
      throw new SetupError("The browser's download has no browser in it.", false);
    }
    // Every link in the build, now that it's all in its place, leads inside it.
    linksInside(bundle);
    fs.chmodSync(bundle, 0o755);
    place(id, bundle);
    clearOld(id);
    note({ state: "ready", failures: 0, retryAt: null, message: undefined, progress: undefined });
    return "installed";
  } catch (error) {
    stop.abort();
    const failures = (failedBefore ? before.failures ?? 0 : 0) + 1;
    const retry = !(error instanceof SetupError) || error.retry;
    const wait = retryAfter(failures);
    const message = String((error as Error)?.message ?? error).slice(0, 400);
    note({ state: "failed", id: here.id, failures, retryAt: retry ? Date.now() + wait : null, message: retry ? `${message} It tries again ${inWords(wait)}.` : message, progress: undefined });
    return "failed";
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(LOCK(), { recursive: true, force: true });
  }
}

/** Throws unless every link in `folder` leads somewhere inside it. */
function linksInside(folder: string): void {
  const real = fs.realpathSync(folder);
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const each = path.join(at, entry.name);
      if (entry.isSymbolicLink()) {
        let leads = "";
        try { leads = fs.realpathSync(each); } catch {}
        if (!leads.startsWith(real + path.sep)) throw new SetupError(`The browser's download has a link that leads outside it (${path.relative(folder, each)}).`, false);
      } else if (entry.isDirectory()) walk(each);
    }
  };
  walk(folder);
}

/** Sets it up in a process of its own (`kuvo-link.js browser install`), outliving whoever asked,
 * unless there's nothing to do (or it waits after a failure, unless asked `now`): how it stands then. */
export function startBrowserInstall({ now = false, repair = false }: { now?: boolean; repair?: boolean } = {}): BrowserStatus {
  const decided = decide({ now, repair });
  if (decided.outcome === null && SCRIPT) {
    // Said at once, so whoever asked sees it under way before its process takes the lock.
    note({ state: "checking", progress: undefined, message: undefined });
    const flags = [...(now ? ["--now"] : []), ...(decided.repair ? ["--repair"] : [])];
    spawn(process.execPath, [...OWN_RUNTIME, SCRIPT, "browser", "install", ...flags], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
  }
  return browserStatus();
}

/** `kuvo/browser` (PROTOCOL.md, "The browser on a machine"): how it stands, and setting it up (now,
 * after a failure, with `now`). */
export async function* browserRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (method === "GET") return yield* json(200, browserStatus());
  if (method === "POST") {
    const body = parsed(request.body) as { now?: unknown; repair?: unknown } | null;
    return yield* json(202, startBrowserInstall({ now: body?.now === true, repair: body?.repair === true }));
  }
  return yield* json(405, {});
}
