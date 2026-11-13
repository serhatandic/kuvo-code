// Wake-ups and watches (PROTOCOL.md, `kuvo/wakes`): a conversation's or a bot's, kept beside it as
// `kuvo-wake` keeps them, listed, added, held, cancelled and sent now from any client.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import type { Wake, WakeList, Wakes, Watch } from "../../shared/routes/wakes";
import { wakeMark } from "../../shared/queues";
import { oneLine } from "../../shared/text";
import { sleep } from "../../shared/wait";
import { isMoving, MOVING } from "../bots/here";
import { engineGet } from "../engine/client";
import type { EngineAnswer } from "../engine/client";
import { keepWaiting } from "../engine/queue";
import { messageID } from "../engine/sessions";
import type { EngineSession } from "../engine/sessions";
import { listOf, textOf } from "../files";
import { followed, watchFolders } from "../follow";
import { stopIfWaiting } from "../work/answers";
import { BOTS, OWN_RUNTIME, RUN, SCRIPT, SESSION_WAKES, WAKE_COMMAND } from "../home";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";

// What a wake-up's message starts with, as the Mac words it.
export const WAKE_MARKER = "[Wake-up] ";

// How often a wake-up comes back, as its name says (the app's Wakes.Repeat): 30m, 2h, 1d, 1w or
// weekdays, within a year; null for anything else.
export function repeatText(text: string | null | undefined): string | null {
  if (text === "weekdays") return text;
  const match = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text ?? "");
  if (!match) return null;
  const count = Number(match[1]);
  const fits = { m: count >= 5 && count <= 525_600, h: count <= 8_760, d: count <= 366, w: count <= 52 }[match[2] as "m" | "h" | "d" | "w"];
  return fits ? text! : null;
}

/** A wake-up as its file names it: its file's name (`id`), when it's due, its note, how often it
 * comes back (null for once), and the letters that name it for good. */
export interface PendingWake {
  id: string;
  due: number;
  note: string;
  every: string | null;
  letters: string;
}

// A wake-up from its file's name (the app's Wakes.Pending): when it's due, in seconds since 1970,
// the letters that name it for good, and how often it comes back; null for another file.
export function wakeOf(name: string, note = ""): PendingWake | null {
  const [due, letters = "", ...more] = name.split("-");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(due ?? "")) return null;
  const repeating = more.join("-");
  return { id: name, due: Number(due), note, every: repeating ? repeatText(repeating.split("@")[0]) : null, letters };
}

/**
 * A conversation archived (or brought back) from a phone: its wake-ups wait while it's archived,
 * as WakeUps.setPaused has a Mac hold them, and come back with it. A hold of your own (`paused`)
 * stays; a move's (`moving`) becomes archiving's.
 */
export function holdArchived(session: string, archived: boolean): void {
  if (!/^ses_[A-Za-z0-9]+$/.test(session)) return;
  const folder = path.join(SESSION_WAKES, session);
  const file = path.join(folder, "paused");
  const held = textOf(file);
  if (archived) {
    if (!fs.existsSync(folder) || (held !== null && held !== "moving")) return;
    fs.writeFileSync(file, "archived");
  } else if (held === "archived" || held === "") {
    fs.rmSync(file, { force: true });
  }
}

// The folder keeping a session's wake-ups: its bot's, or its own in `wakes`; null for none.
export function wakeFolder(session: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session)) return null;
  for (const id of listOf(BOTS)) {
    if ((textOf(path.join(BOTS, id, "session")) ?? "").trim() === session) return path.join(BOTS, id);
  }
  const own = path.join(SESSION_WAKES, session);
  return textOf(path.join(own, "session")) === null ? null : own;
}

// Each session here with a wake-up or a watch, as the Mac lists them in `kuvo/wakes`: its soonest
// wake-up, whether it watches, and its wake-ups, watches and pause whole. Bots' come with `kuvo/bots`.
export function listWakes(): WakeList["sessions"] {
  const sessions: WakeList["sessions"][number][] = [];
  for (const name of listOf(SESSION_WAKES)) {
    const folder = path.join(SESSION_WAKES, name);
    const session = (textOf(path.join(folder, "session")) ?? "").trim();
    if (!session) continue;
    const { wakes, watches, paused } = readWakes(folder);
    if (!wakes.length && !watches.length) continue;
    sessions.push({ session, ...(wakes.length ? { next: wakes[0].due } : {}), watching: watches.length > 0, wakes: wakes.map(listedWake), watches, paused });
  }
  return sessions;
}

/** A folder's wake-ups as `readWakes` reads them: each as its file names it, the watches, and the pause. */
export interface FolderWakes {
  wakes: PendingWake[];
  watches: Watch[];
  paused: boolean;
}

// A folder's waiting wake-ups (soonest first), its watches, and whether you paused them: their
// notes and checks on a line each, or `whole`.
export function readWakes(folder: string, { whole = false }: { whole?: boolean } = {}): FolderWakes {
  const line = (text: string, limit: number) => whole ? text : oneLine(text, limit);
  const wakes = (listOf(path.join(folder, "wakes"))
    .map(name => wakeOf(name, line(textOf(path.join(folder, "wakes", name)) ?? "", 400)))
    .filter(Boolean) as PendingWake[])
    .sort((a, b) => a.due - b.due);
  const watches = listOf(path.join(folder, "watches")).sort().map((letters): Watch | null => {
    const at = path.join(folder, "watches", letters);
    const check = textOf(path.join(at, "check")) ?? "";
    if (!check) return null;
    return { letters, every: (textOf(path.join(at, "every")) ?? "").trim(), check: line(check, 300), note: line(textOf(path.join(at, "note")) ?? "", 400) };
  }).filter(Boolean) as Watch[];
  return { wakes, watches, paused: fs.existsSync(path.join(folder, "paused")) };
}

// A wake-up as a client takes it.
export const listedWake = ({ id, due, note, every }: PendingWake): Wake => ({ id, due, note, every: every ?? undefined });

/** A conversation's wake-ups, watches and pause, with its session, as `kuvo/wakes/events` tells them. */
export interface SessionWakes extends Wakes {
  session: string;
}

// Every conversation here with wake-ups, watches or a pause, a bot's or its own, whole: what a
// client keeps of them, followed (`kuvo/wakes/events`).
export function allWakes(): SessionWakes[] {
  const sessions: SessionWakes[] = [];
  const add = (folder: string) => {
    const session = (textOf(path.join(folder, "session")) ?? "").trim();
    if (!session) return;
    const { wakes, watches, paused } = readWakes(folder, { whole: true });
    if (wakes.length || watches.length || paused) sessions.push({ session, wakes: wakes.map(listedWake), watches, paused });
  };
  for (const id of listOf(BOTS)) add(path.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES)) add(path.join(SESSION_WAKES, name));
  return sessions;
}

// When `kuvo-wake fire` next has something to send, in seconds since 1970: the soonest wake-up of a
// conversation that isn't paused, or the time one that couldn't go is tried again; null for none.
export function nextWake(): number | null {
  let soonest: number | null = null;
  const look = (folder: string) => {
    if (fs.existsSync(path.join(folder, "paused")) || textOf(path.join(folder, "session")) === null) return;
    const [retry = 0] = (textOf(path.join(folder, ".retry")) ?? "").trim().split(/\s+/).map(Number);
    for (const name of listOf(path.join(folder, "wakes"))) {
      const due = wakeOf(name)?.due;
      if (due === undefined) continue;
      const at = Math.max(due, Number.isFinite(retry) ? retry : 0);
      if (soonest === null || at < soonest) soonest = at;
    }
  };
  for (const id of listOf(BOTS)) look(path.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES)) look(path.join(SESSION_WAKES, name));
  return soonest;
}

/** This computer's wake-ups and watches sent by its box, as a machine's keeper sends its own with
 * the same `kuvo-wake fire` (which keeps two runs apart itself): at the soonest one's time, at
 * least each minute (for watches), and again as they change, here or by an agent's kuvo-wake. One
 * still due after a run that was due before it (it couldn't go, or its conversation is archived)
 * waits for the next minute; one that came due during it goes right after. The returned function
 * stops it: nothing runs after, and its promise settles once a run already going is over. */
export function sendWakes(): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null, settling: NodeJS.Timeout | null = null, running = false, again = false, stopped = false, started = 0, said = false, over: (() => void) | null = null, ending: Promise<void> | null = null;
  const schedule = (afterFire = false) => {
    if (stopped) return;
    clearTimeout(timer!);
    const due = nextWake(), now = Date.now() / 1000;
    const missed = afterFire && due !== null && due <= now && due < started;
    const wait = due === null || missed ? 60_000 : Math.min(60_000, Math.max(500, (due + 1 - now) * 1000));
    timer = setTimeout(fire, wait);
  };
  const fire = () => {
    if (stopped) return;
    if (running) return void (again = true);
    running = true;
    started = Date.now() / 1000;
    // (With this box's own command, which a wake-up due in a conversation you stopped is handed to,
    // to wait there: `box route`.)
    const env = { ...process.env, KUVO_LINK_RUNTIME: process.execPath, KUVO_LINK_FLAGS: OWN_RUNTIME.join(" "), KUVO_LINK_SCRIPT: SCRIPT };
    execFile(WAKE_COMMAND, ["fire", BOTS, path.join(RUN, "engine.json")], { env }, error => {
      running = false;
      if (error?.code === "ENOENT" && !said) {
        said = true;
        console.error(`Wake-ups can't be sent: there's no kuvo-wake at ${WAKE_COMMAND}.`);
      }
      if (stopped) {
        over?.();
      } else if (again) {
        again = false;
        fire();
      } else {
        schedule(true);
      }
    });
  };
  // A change, here or beside it, once the folders settle (a wake-up is a file or two).
  const changed = () => {
    clearTimeout(settling!);
    settling = setTimeout(() => schedule(), 200);
  };
  wakeFollowers.add(changed);
  const watching = watchFolders([BOTS, SESSION_WAKES], changed);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer!);
    clearTimeout(settling!);
    wakeFollowers.delete(changed);
    watching.close();
    if (!running) return Promise.resolve();
    return ending ??= new Promise<void>(resolve => { over = resolve; });
  };
}

// Those following them (`kuvo/wakes/events`), told of each change made here; `kuvo-wake fire`'s
// as the system sees their folders change.
export const wakeFollowers = new Set<() => void>();
export const wakesChanged = () => {
  for (const tell of wakeFollowers) tell();
};

const LETTERS = /^[A-Za-z0-9]+$/;
// The most wake-ups a conversation keeps waiting, as the Mac's (Wakes.limit).
const WAKE_LIMIT = 50;

// A folder for a session's wake-ups here, made as kuvo-wake makes one with a session's first wake-up: its
// session, its folder, whether the coding agents run it, and held while it's archived. Null when
// it isn't a conversation here.
async function wakeFolderFor(session: string, readEngine: () => EngineRecord, bridge: () => BridgeRecord | null): Promise<string | null> {
  const where = await whereIs(session, readEngine, bridge);
  if (!where) return null;
  const { found, agents } = where;
  const folder = path.join(SESSION_WAKES, session);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, "session"), session);
  fs.writeFileSync(path.join(folder, "directory"), found.location?.directory ?? found.directory ?? "");
  if (agents) fs.writeFileSync(path.join(folder, "via"), "bridge");
  if (found.metadata?.["kuvo.archived"] === true) fs.writeFileSync(path.join(folder, "paused"), "archived");
  return folder;
}

// The session as the engine or the agents' bridge has it (whole), and which: null for neither.
async function whereIs(session: string, readEngine: () => EngineRecord, bridge: () => BridgeRecord | null): Promise<{ target: Target; found: EngineSession; agents: boolean } | null> {
  if (!/^ses_[A-Za-z0-9]+$/.test(session)) return null;
  const ask = async (target: Target | null): Promise<EngineSession | null> => target ? (await engineGet(target, `api/session/${encodeURIComponent(session)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data ?? null : null;
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  const here = await ask(engine);
  if (engine && here) return { target: engine, found: here, agents: false };
  const agents = bridge();
  const there = await ask(agents);
  return agents && there ? { target: agents, found: there, agents: true } : null;
}

// Takes a wake-up off the schedule by its letters, which a repeating one keeps as its time moves on,
// with its summary.
function cancelWake(folder: string, letters: string): void {
  if (!LETTERS.test(letters)) return;
  for (const name of listOf(path.join(folder, "wakes"))) {
    if (wakeOf(name)?.letters === letters) fs.rmSync(path.join(folder, "wakes", name), { force: true });
  }
  fs.rmSync(path.join(folder, "summaries", letters), { force: true });
}

// Until the MCP servers of the folder a conversation works in are connected, twenty seconds at
// most, as the app and the engine's watchdog wait before a wake-up: one sent sooner reaches a
// model without their tools.
async function waitForTools(port: number, authorization: string, directory: string, signal: AbortSignal | undefined): Promise<void> {
  const started = Date.now();
  let waited = false;
  while (Date.now() - started < 20_000) {
    let listed: string;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: { authorization, "x-opencode-directory": encodeURIComponent(directory) }, signal });
      if (!response.ok) return;
      listed = await response.text();
    } catch {
      return;
    }
    // A folder it has only just opened lists none for a moment before they're pending.
    const none = !listed.includes('"status"');
    if (!listed.includes('"pending"') && !(none && Date.now() - started < 3_000)) {
      if (waited && !none) await sleep(1_500);
      return;
    }
    waited = true;
    await sleep(none ? 100 : 250);
  }
}

// Wake-ups being sent with Wake Up Now, so a second tap doesn't send one twice.
const wakingNow = new Set<string>();

/** What can be done to a conversation's wake-ups past reading them (`kuvo/wakes/<session>/…`). */
export type WakeAction = "cancel" | "now" | "pause" | "watch";

/** Why its kuvo-wake said no: it isn't there, it refused (with what it said), or it failed. */
interface KuvoWakeRefusal {
  missing: boolean;
  refused: boolean;
  said: string;
}

// `kuvo/wakes/<session>`: its wake-ups, watches and pause; `…/cancel` with {"wake"} or {"watch"};
// `…/now` with {"wake"}, sent at once (one that repeats still comes back at its time); `…/watch`
// with {"every", "check", "note"}, a watch made as its agent makes one.
export async function* answerWakes(session: string, action: WakeAction | undefined, request: LinkRequest, readEngine: () => EngineRecord, bridge: () => BridgeRecord | null, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const changed = function* (status: number, value: Wakes | Record<string, never>) {
    wakesChanged();
    yield* json(status, value);
  };
  const json = (status: number, value: unknown): AnswerPiece[] => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  let folder = wakeFolder(session);
  const listed = (): Wakes => {
    if (!folder) return { wakes: [], watches: [], paused: false };
    const { wakes, watches, paused } = readWakes(folder);
    return { wakes: wakes.map(listedWake), watches, paused };
  };
  if (!action && (method === "GET" || method === "HEAD")) return yield* json(200, listed());
  if (method !== "POST") return yield* json(405, {});
  // (What a client sent, each field checked as it's read.)
  let given: Record<string, unknown> = {};
  try {
    given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}") ?? {};
  } catch {}
  // Its own kuvo-wake (this computer's clock, its weekends), as its agent runs it: its message when it
  // says no, else null.
  const kuvoWake = (args: string[]) => new Promise<KuvoWakeRefusal | null>(resolve => execFile(WAKE_COMMAND, [folder!, ...args], { encoding: "utf8", timeout: 30_000 },
    (error, _out, said) => resolve(error ? { missing: error.code === "ENOENT", refused: error.code === 2, said: String(said ?? "").trim() } : null)));
  const unavailable = (failed: KuvoWakeRefusal, what: string) => failed.missing
    ? json(503, { message: "Wake-ups aren’t set up on this computer." })
    : json(failed.refused && failed.said ? 400 : 503, { message: failed.refused && failed.said ? failed.said : `${what} couldn’t be saved. Try again.` });
  if (action === "watch") {
    const every = typeof given.every === "string" ? given.every.trim() : "";
    const check = typeof given.check === "string" ? given.check.trim() : "";
    const note = typeof given.note === "string" ? given.note.trim() : "";
    if (!every || !check || !note) return yield* json(400, { message: "Send how often (`every`, like 5m, 2h or 1d), the check to run (`check`) and what to do when it changes (`note`)." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made) return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder)) return yield* json(409, { message: MOVING });
    const failed = await kuvoWake(["watch", every, check, note]);
    if (failed) return yield* unavailable(failed, "The watch");
    return yield* changed(200, listed());
  }
  if (!action) {
    // One added as the bar over the composer adds one.
    const due = Number(given.due), note = typeof given.note === "string" ? given.note.trim() : "";
    const every = given.every == null ? null : String(given.every);
    if (!Number.isFinite(due) || !note) return yield* json(400, { message: "Send when it comes (`due`, seconds since 1970) and what it says (`note`)." });
    if (every !== null && !/^(weekdays|[1-9][0-9]{0,5}[mhdw])$/.test(every)) return yield* json(400, { message: "That isn’t a repeat: 30m, 2h, 1d, 1w or weekdays." });
    if (due < Date.now() / 1000 + 60) return yield* json(400, { message: "Pick a time at least a minute from now." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made) return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder)) return yield* json(409, { message: MOVING });
    if (readWakes(folder).wakes.length >= WAKE_LIMIT) return yield* json(409, { message: `There are ${WAKE_LIMIT} wake-ups waiting already. Cancel some first.` });
    const failed = await kuvoWake(["add", String(Math.floor(due)), ...(every ? ["--every", every] : []), note]);
    if (failed) return yield* unavailable(failed, "The wake-up");
    return yield* changed(200, listed());
  }
  // Held while it's archived, and let go when it's back, as its archiving (the Mac's, or a phone's
  // through this box) says: a hold of your own stays through both.
  if (action === "pause" && typeof given.archived === "boolean") {
    if (folder && isMoving(folder)) return yield* json(409, { message: MOVING });
    holdArchived(session, given.archived);
    // Archived while it waits on you: it stops, as a phone's Archive has it. (Not for a hold that
    // only follows an archive from before, `stop: false`: a first wake-up made for it.) Only while
    // its engine still has it archived: a Mac that hasn't heard it was brought back since stops nothing.
    const where = given.archived && given.stop !== false ? await whereIs(session, readEngine, bridge) : null;
    if (where?.found.metadata?.["kuvo.archived"] === true) await stopIfWaiting(where.target, session);
    return yield* changed(200, listed());
  }
  if (action === "pause" && typeof given.paused !== "boolean") return yield* json(400, { message: "Send {\"paused\": true} or false." });
  if (!folder) return yield* json(action === "pause" ? 200 : 404, action === "pause" ? listed() : {});
  if (isMoving(folder)) return yield* json(409, { message: MOVING });
  if (action === "pause") {
    // A hold of your own, until you take it away (archiving's and a move's are theirs: one
    // resumed while it's archived waits until it's back).
    if (given.paused) fs.writeFileSync(path.join(folder, "paused"), "paused");
    else if (textOf(path.join(folder, "paused")) !== "archived") fs.rmSync(path.join(folder, "paused"), { force: true });
    return yield* changed(200, listed());
  }
  const { wakes, watches } = readWakes(folder);
  const chosen = typeof given.wake === "string" ? wakes.find(each => each.id === given.wake || each.letters === given.wake) : undefined;
  if (action === "cancel") {
    if (chosen && LETTERS.test(chosen.letters)) {
      cancelWake(folder, chosen.letters);
      return yield* changed(200, {});
    }
    const watch = typeof given.watch === "string" ? watches.find(each => each.letters === given.watch) : undefined;
    if (watch && LETTERS.test(watch.letters)) {
      fs.rmSync(path.join(folder, "watches", watch.letters), { recursive: true, force: true });
      return yield* changed(200, {});
    }
    return yield* json(404, {});
  }
  if (!chosen) return yield* json(404, {});
  const key = `${folder}/${chosen.id}`;
  if (wakingNow.has(key)) return yield* json(200, {});
  wakingNow.add(key);
  try {
    // The whole note, as its time would send it, not the line it's listed by.
    const note = textOf(path.join(folder, "wakes", chosen.id));
    if (note === null) return yield* json(404, {});
    const agents = (textOf(path.join(folder, "via")) ?? "").trim() === "bridge";
    let target: Target | null = null;
    try {
      target = agents ? bridge() : readEngine();
    } catch {}
    if (!target) return yield* json(503, { message: agents ? "The coding agents aren’t running on this computer." : "The engine isn’t running." });
    const authorization = `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`;
    const directory = textOf(path.join(folder, "directory"));
    if (!agents && directory) await waitForTools(target.port, authorization, directory, signal);
    // With the summary its agent gave it, as kuvo-wake sends it at its time.
    const summary = LETTERS.test(chosen.letters) ? (textOf(path.join(folder, "summaries", chosen.letters)) ?? "").trim() : "";
    const message = { id: messageID(), text: WAKE_MARKER + note, delivery: "queue" as const, ...(summary ? { metadata: wakeMark(summary) } : {}) };
    // Its conversation stopped by you: it waits there with the queue, and goes once it goes on.
    if (!keepWaiting(session, message, { from: "Wake-up", words: note })) {
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}/prompt`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(message),
          signal,
        });
      } catch {
        return yield* json(503, { message: "The wake-up couldn’t be sent." });
      }
      if (!response.ok) return yield* json(503, { message: `The wake-up couldn’t be sent (${response.status}).` });
    }
    if (!chosen.every) cancelWake(folder, chosen.letters);
    return yield* changed(200, {});
  } finally {
    wakingNow.delete(key);
  }
}

export async function* wakesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ sessions: listWakes() } satisfies WakeList)) };
  return;
}

// Every conversation's wake-ups and watches followed: a line now, and again as they change
// (added, fired, canceled, paused), as a Mac shows them (PROTOCOL.md, "Wake-ups").
export async function* wakeEventsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ sessions: allWakes() }), wakeFollowers, signal, { folders: [BOTS, SESSION_WAKES] });
}

export async function* sessionWakesRoute(context: RouteContext, wakes: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, bridge, text } = context;
  let session: string;
  try {
    session = decodeURIComponent(wakes[1]);
  } catch {
    return yield* text(404, "No such session.");
  }
  return yield* answerWakes(session, wakes[2] as WakeAction | undefined, request, readEngine, bridge, signal);
}
