// This Mac's app, as a Mac's box in a home of its own knows it (#333 piece 3; PROTOCOL.md, "This
// Mac's app"): where the app's tools answer while it's open, and where it's installed, as it says
// when it registers (`kuvo/box/app`), so the box's `kuvo-browser.js` sends the browser's tools to
// the panel. And, when an agent needs the browser while the app is closed, the box decides to open
// it (#211, carried over from the keeper's `AppOpener`): one opening at a time, which every call
// meanwhile waits on, from whichever of the box's processes it comes; 30 seconds for the app to
// register; after one that failed, no other for five minutes; never while an update of the app
// installs. Only the opening itself is done by what runs as the app (the keeper, the helper after
// it), at the box's ask (`app/open` on the host interface).
//
// What it keeps, in `run` (each only you can read):
// - `app.json`: `{bundle, tools: {url, token} | null, at}`, the app as it last registered;
// - `app-opening.json`: `{at, by}`, an opening under way, and which process asked for it;
// - `app-open-failed.json`: `{at, message}`, the last opening that failed;
// - `app-updating`: noted as the app quits to install an update (by its time).

import fs from "node:fs";
import path from "node:path";
import { alive } from "../../shared/platform";
import { isObject, parsed } from "../../shared/json";
import { writePrivate } from "../../shared/files";
import { OWN_HOME_MAC, RUN } from "../home";
import { appHost, proveHost } from "../host-interface";
import type { AnswerPiece, RouteContext } from "../server/context";

export const APP_FILE = () => path.join(RUN, "app.json");
const OPENING_FILE = () => path.join(RUN, "app-opening.json");
const FAILED_FILE = () => path.join(RUN, "app-open-failed.json");
/** The same name the keeper's `AppOpener` reads in the app's own box. */
export const UPDATING_FILE = () => path.join(RUN, "app-updating");

/** How long a call waits for the app it had opened to register. */
export const WAIT = 30_000;
/** How long after an opening that failed it isn't tried again. */
export const REST = 5 * 60_000;
/** How long a note that an update installs counts (one that never opened again, quit for real,
 * leaves it behind). */
export const UPDATING_FOR = 2 * 60_000;
/** How long the host has to open it (`open` itself, as the keeper gives it 20 s). */
const OPEN_WITHIN = 25_000;

// What the agent is told: the keeper's words (`AppOpener`), now the box's.
export const GONE = "Kuvo Code isn't where it was installed on this Mac any more (it was moved or deleted), so its browser can't be opened. Ask the user to open Kuvo Code, then try again.";
export const couldntOpen = (why: string) => `Kuvo Code couldn't be opened in the background on this Mac for its browser (${why.trim()}). Ask the user to open Kuvo Code, then try again.`;
export const NOT_READY = `Kuvo Code was opened in the background on this Mac, but its browser wasn't ready within ${WAIT / 1000} seconds. Try again in a few minutes; if it still isn't ready, ask the user to open Kuvo Code.`;
/** What a browser call says where the app never registered with this box: there's nothing to open. */
export const NEEDS_APP = "This tool needs Kuvo Code open on this Mac, and it isn't open now. Ask the user to open Kuvo Code, then try again.";
/** Where nothing that opens it runs (no host interface): the keeper, or the helper after it. */
const NO_OPENER = "nothing that opens it is running on this Mac";

/** The app as it last registered: where it's installed, and while it's open, where its tools answer. */
export interface AppRecord {
  bundle: string | null;
  tools: { url: string; token: string } | null;
  at: number;
}

function readJSON(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** The app's place: a whole path to an `.app` bundle, as it says it. */
function bundleOf(given: unknown): string | null {
  if (typeof given !== "string" || given.length > 1024 || given.includes("\0") || !path.isAbsolute(given)) return null;
  const bundle = given.replace(/\/+$/, "");
  return bundle.endsWith(".app") && path.normalize(bundle) === bundle ? bundle : null;
}

/** Where the app's tools answer: on this Mac only (the token goes there with every call). */
function toolsOf(given: unknown): AppRecord["tools"] {
  if (!isObject(given) || typeof given.url !== "string" || typeof given.token !== "string") return null;
  if (given.token.length < 16 || given.token.length > 512) return null;
  let url: URL;
  try { url = new URL(given.url); } catch { return null; }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password) return null;
  return { url: url.toString(), token: given.token };
}

export function readApp(): AppRecord | null {
  const said = readJSON(APP_FILE());
  if (!isObject(said)) return null;
  return { bundle: bundleOf(said.bundle), tools: toolsOf(said.tools), at: typeof said.at === "number" ? said.at : 0 };
}

/** Whether the app has said where its tools answer (and hasn't said it quit). */
const isOpen = () => readApp()?.tools != null;

interface Failed { at: number; message: string }
function readFailed(): Failed | null {
  const said = readJSON(FAILED_FILE());
  return isObject(said) && typeof said.at === "number" && typeof said.message === "string" ? { at: said.at, message: said.message } : null;
}

interface OpeningNote { at: number; by: number }
function readOpening(): OpeningNote | null {
  const said = readJSON(OPENING_FILE());
  return isObject(said) && typeof said.at === "number" && typeof said.by === "number" ? { at: said.at, by: said.by } : null;
}

/** Whether an update of the app installs now: noted in the last two minutes. */
export function updating(now = Date.now()): boolean {
  try { return Math.abs(now - fs.statSync(UPDATING_FILE()).mtimeMs) < UPDATING_FOR; } catch { return false; }
}

/** The app registered: open (`tools`), or quit (`tools` null), and where it's installed (kept from
 * before when it doesn't say). Open, what an opening that failed said is forgotten, as is an update
 * that installed. */
export function registerApp(given: { tools: AppRecord["tools"]; bundle?: string | null }, now = Date.now()): AppRecord {
  const before = readApp();
  const record: AppRecord = { bundle: given.bundle ?? before?.bundle ?? null, tools: given.tools, at: now };
  writePrivate(APP_FILE(), JSON.stringify(record));
  if (record.tools) {
    fs.rmSync(FAILED_FILE(), { force: true });
    fs.rmSync(UPDATING_FILE(), { force: true });
  }
  return record;
}

/** The app registered with `token` didn't answer (it quit without saying): taken for closed, but
 * only while that's still its registration (read again just before: one it made since stays). */
export function forgetTools(token: string, now = Date.now()) {
  const app = readApp();
  if (!app?.tools || app.tools.token !== token) return;
  const record: AppRecord = { ...app, tools: null, at: now };
  if (readApp()?.tools?.token === token) writePrivate(APP_FILE(), JSON.stringify(record));
}

/** The app said it quits to install an update: it isn't opened over it, and Sparkle opens it. */
export function noteUpdating(now = Date.now()) {
  registerApp({ tools: null }, now);
  writePrivate(UPDATING_FILE(), String(now));
  const at = new Date(now);
  try { fs.utimesSync(UPDATING_FILE(), at, at); } catch {}
}

/** How the app stands, as clients read it. */
export function appStatus(now = Date.now()) {
  const app = readApp();
  const failed = readFailed();
  const opening = readOpening();
  return {
    bundle: app?.bundle ?? null,
    open: app?.tools != null,
    updating: updating(now),
    opening: opening !== null && !stale(opening, now),
    failed: failed && now - failed.at < REST ? failed : null,
  };
}

/** An opening whose process is gone, or that has run past its time (and a little more). */
function stale(opening: OpeningNote, now: number): boolean {
  return (opening.by !== process.pid && !alive(opening.by)) || now - opening.at > WAIT + OPEN_WITHIN;
}

/** How the opening is done and waited for: the host asked (`open`, null once it's opened, else
 * why not), the clock, and a wait for the app (comes back once `ready()` holds, by `deadline`, or
 * `signal` stops it). A test's own. */
export interface OpenWays {
  open: (bundle: string) => Promise<string | null>;
  now: () => number;
  until: (ready: () => boolean, deadline: number, signal?: AbortSignal) => Promise<void>;
}

/** The app opened for a browser call, if it isn't open: null once it's registered, or what the
 * agent is told instead. One opening at a time across the box's processes: a call while one is
 * under way waits for it, and is told what it ended with; one whose process went is taken over.
 * `signal` stops a call's wait; the one that asked for an opening sees it through, so every call
 * waiting on it hears how it went (its caller sends it one SIGTERM, which `box route` takes as that). */
export async function openApp(signal?: AbortSignal, ways: OpenWays = OPEN_WAYS): Promise<string | null> {
  if (isOpen()) return null;
  for (let tries = 0; tries < 3; tries++) {
    const now = ways.now();
    let opening = readOpening();
    if (opening && stale(opening, now)) {
      // (Only the one that was there: one another process has just taken stays.)
      if (JSON.stringify(readOpening()) === JSON.stringify(opening)) fs.rmSync(OPENING_FILE(), { force: true });
      opening = null;
    }
    if (!opening) {
      const failed = readFailed();
      if (failed && now - failed.at < REST && now >= failed.at) return failed.message;
      const mine: OpeningNote = { at: now, by: process.pid };
      try {
        fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
        fs.writeFileSync(OPENING_FILE(), JSON.stringify(mine), { flag: "wx", mode: 0o600 });
      } catch (error) {
        // Another took it at the same moment: waited on. Anything else is said.
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
        return couldntOpen(`its box couldn't note the opening: ${(error as Error)?.message ?? error}`);
      }
      return await openAndWait(mine, ways);
    }
    // One under way: waited for, until the app registers, that opening ends, or its process goes
    // (cut off, it never says how it went: the next try takes it on). Long enough for the opener's
    // own ask of the host to come back after its wait, with why it failed.
    const theirs = opening;
    const still = () => JSON.stringify(readOpening()) === JSON.stringify(theirs);
    const cutOff = () => theirs.by !== process.pid && !alive(theirs.by);
    await ways.until(() => isOpen() || !still() || cutOff(), theirs.at + WAIT + OPEN_WITHIN, signal);
    if (isOpen()) return null;
    if (signal?.aborted) return "The call was stopped.";
    if (still() && !cutOff()) return NOT_READY;
    const failed = readFailed();
    if (!cutOff() && failed && failed.at >= theirs.at) return failed.message;
  }
  return NOT_READY;
}

async function openAndWait(mine: OpeningNote, ways: OpenWays): Promise<string | null> {
  let said: string | null = null;
  try {
    if (!updating(ways.now())) {
      const bundle = readApp()?.bundle;
      said = bundle ? await ways.open(bundle) : NEEDS_APP;
    }
    // (While an update installs, Sparkle opens it: waited for, never opened over it.)
    if (said === null && !isOpen()) await ways.until(isOpen, mine.at + WAIT);
    if (said === null && !isOpen()) said = NOT_READY;
    if (said !== null) writePrivate(FAILED_FILE(), JSON.stringify({ at: ways.now(), message: said }));
    return said;
  } finally {
    if (JSON.stringify(readOpening()) === JSON.stringify(mine)) fs.rmSync(OPENING_FILE(), { force: true });
  }
}

/** The host interface asked to open the app at `bundle`: null once it has, else why not. */
async function hostOpens(bundle: string): Promise<string | null> {
  const host = appHost();
  if (!host) return couldntOpen(NO_OPENER);
  try {
    await proveHost(host, AbortSignal.timeout(10_000));
  } catch {
    return couldntOpen(NO_OPENER);
  }
  try {
    const response = await fetch(`${host.url}/app/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
      body: JSON.stringify({ bundle }),
      signal: AbortSignal.timeout(OPEN_WITHIN),
    });
    let answer: unknown = null;
    try { answer = await response.json(); } catch {}
    if (response.ok) return null;
    // Not there any more (410); or a host that doesn't know the call (404, an older keeper's).
    if (response.status === 410) return GONE;
    if (response.status === 404) return couldntOpen("what runs this box can't open it yet");
    const why = isObject(answer) && typeof answer.message === "string" && answer.message.trim() ? answer.message.slice(0, 300) : `it said ${response.status}`;
    return couldntOpen(why);
  } catch (error) {
    return couldntOpen(error instanceof Error && error.name === "TimeoutError" ? "macOS didn't open it in time" : NO_OPENER);
  }
}

/** Waits until `ready()`, `deadline` (ms since 1970) or `signal`: as `run` changes, and each second
 * besides (a change a watch misses). */
function waitUntil(ready: () => boolean, deadline: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    let watcher: fs.FSWatcher | null = null;
    const done = () => {
      clearInterval(every);
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const look = () => { if (ready()) done(); };
    const every = setInterval(look, 1_000);
    const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
    try { watcher = fs.watch(RUN, look); watcher.on("error", () => {}); } catch {}
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
    else look();
  });
}

const OPEN_WAYS: OpenWays = { open: hostOpens, now: () => Date.now(), until: waitUntil };

const ONLY_MAC = "Only a Mac's box in a home of its own has its app register with it.";

/** `kuvo/box/app`: how this Mac's app stands (`GET`, for any client), and its registration (`POST`, from Kuvo Code
 * itself): `{tools: {url, token}, bundle}` as it opens, `{tools: null}` as it quits, `{updating:
 * true}` as it quits to install an update. */
export async function* appRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return yield* json(405, {});
  if (!OWN_HOME_MAC) return yield* json(409, { message: ONLY_MAC });
  if (method === "GET") return yield* json(200, appStatus());
  if (!request.fromApp && !request.fromMac) return yield* json(403, { message: "Only Kuvo Code on this Mac registers its app." });
  const given = parsed(request.body);
  if (!isObject(given)) return yield* json(400, { message: "Say where its tools answer (tools), or that it quits (tools: null)." });
  if (given.updating === true) {
    noteUpdating();
    return yield* json(200, appStatus());
  }
  if (!("tools" in given)) return yield* json(400, { message: "Say where its tools answer (tools), or that it quits (tools: null)." });
  const tools = given.tools === null ? null : toolsOf(given.tools);
  if (given.tools !== null && !tools) return yield* json(400, { message: "Its tools answer on this Mac, at an http address, with a token." });
  const bundle = given.bundle === undefined ? undefined : bundleOf(given.bundle);
  if (given.bundle !== undefined && !bundle) return yield* json(400, { message: "Its bundle is a whole path to the app (…/Kuvo Code.app)." });
  registerApp({ tools, bundle });
  return yield* json(200, appStatus());
}

/** `kuvo/box/app/open` (`POST`, from Kuvo Code's own processes: `kuvo-browser.js`): the app opened
 * for a browser call, as `openApp` decides; `{gone: <token>}` says the app registered with that
 * token didn't answer (it quit without saying). 200 once it's registered, 503 with what to tell
 * the agent otherwise. */
export async function* appOpenRoute({ request, json, signal }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  if (!request.fromApp && !request.fromMac) return yield* json(403, { message: "Only Kuvo Code on this Mac opens its app." });
  if (!OWN_HOME_MAC) return yield* json(409, { message: ONLY_MAC });
  const given = parsed(request.body);
  if (isObject(given) && typeof given.gone === "string") forgetTools(given.gone);
  const said = await openApp(signal);
  return yield* (said === null ? json(200, appStatus()) : json(503, { message: said }));
}
