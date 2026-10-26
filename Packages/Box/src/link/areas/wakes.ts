// @ts-nocheck
// Wake-ups and watches (PROTOCOL.md, `kuvo/wakes`): a conversation's or a bot's, kept beside it as
// `kuvo-wake` keeps them, listed, added, held, cancelled and sent now from any client.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BOTS, K, RUN } from "../home";
import { oneLine } from "../../shared/text";
import { textOf, listOf } from "../files";
import { watchFolders } from "../follow";

// What the Mac answers for them (PROTOCOL.md, `kuvo/bots` and `kuvo/wakes`), answered here from
// the folders the app keeps on the machine, so a phone has them with the Mac closed: a bot's
// description (`bot.json`, which the app writes from its list), its session, and the wake-ups,
// watches and pause that `kuvo-wake` keeps beside them.
export const SESSION_WAKES = process.env.KUVO_WAKES || path.join(K, "wakes");
export const WAKE_COMMAND = process.env.KUVO_WAKE_COMMAND || path.join(K, "bin", "kuvo-wake");
// The version of `bot.json` this reads (the app's `Bot.Descriptor`).
export const DESCRIPTION = 1;
export const WAKE_MARKER = "[Wake-up] ";


// How often a wake-up comes back, as its name says (the app's Wakes.Repeat): 30m, 2h, 1d, 1w or
// weekdays, within a year; null for anything else.
export function repeatText(text) {
  if (text === "weekdays") return text;
  const match = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text ?? "");
  if (!match) return null;
  const count = Number(match[1]);
  const fits = { m: count >= 5 && count <= 525_600, h: count <= 8_760, d: count <= 366, w: count <= 52 }[match[2]];
  return fits ? text : null;
}

// A wake-up from its file's name (the app's Wakes.Pending): when it's due, in seconds since 1970,
// the letters that name it for good, and how often it comes back; null for another file.
export function wakeOf(name, note = "") {
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
export function holdArchived(session, archived) {
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
export function wakeFolder(session) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session)) return null;
  for (const id of listOf(BOTS)) {
    if ((textOf(path.join(BOTS, id, "session")) ?? "").trim() === session) return path.join(BOTS, id);
  }
  const own = path.join(SESSION_WAKES, session);
  return textOf(path.join(own, "session")) === null ? null : own;
}

// Each session here with a wake-up or a watch, as the Mac lists them in `kuvo/wakes`: its soonest
// wake-up and whether it watches. Bots' come with `kuvo/bots`.
export function listWakes() {
  const sessions = [];
  for (const name of listOf(SESSION_WAKES)) {
    const folder = path.join(SESSION_WAKES, name);
    const session = (textOf(path.join(folder, "session")) ?? "").trim();
    if (!session) continue;
    const { wakes, watches } = readWakes(folder);
    if (!wakes.length && !watches.length) continue;
    sessions.push({ session, ...(wakes.length ? { next: wakes[0].due } : {}), watching: watches.length > 0 });
  }
  return sessions;
}

// A folder's waiting wake-ups (soonest first), its watches, and whether you paused them: their
// notes and checks on a line each, or `whole`.
export function readWakes(folder, { whole = false } = {}) {
  const line = (text, limit) => whole ? text : oneLine(text, limit);
  const wakes = listOf(path.join(folder, "wakes"))
    .map(name => wakeOf(name, line(textOf(path.join(folder, "wakes", name)) ?? "", 400)))
    .filter(Boolean)
    .sort((a, b) => a.due - b.due);
  const watches = listOf(path.join(folder, "watches")).sort().map(letters => {
    const at = path.join(folder, "watches", letters);
    const check = textOf(path.join(at, "check")) ?? "";
    if (!check) return null;
    return { letters, every: (textOf(path.join(at, "every")) ?? "").trim(), check: line(check, 300), note: line(textOf(path.join(at, "note")) ?? "", 400) };
  }).filter(Boolean);
  return { wakes, watches, paused: fs.existsSync(path.join(folder, "paused")) };
}

// A wake-up as a client takes it.
export const listedWake = ({ id, due, note, every }) => ({ id, due, note, every: every ?? undefined });

// Every conversation here with wake-ups, watches or a pause, a bot's or its own, whole: what a
// client keeps of them, followed (`kuvo/wakes/events`).
export function allWakes() {
  const sessions = [];
  const add = folder => {
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
export function nextWake() {
  let soonest = null;
  const look = folder => {
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
export function sendWakes() {
  let timer = null, settling = null, running = false, again = false, stopped = false, started = 0, said = false, over = null, ending = null;
  const schedule = (afterFire = false) => {
    if (stopped) return;
    clearTimeout(timer);
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
    execFile(WAKE_COMMAND, ["fire", BOTS, path.join(RUN, "engine.json")], error => {
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
    clearTimeout(settling);
    settling = setTimeout(() => schedule(), 200);
  };
  wakeFollowers.add(changed);
  const watching = watchFolders([BOTS, SESSION_WAKES], changed);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(settling);
    wakeFollowers.delete(changed);
    watching.close();
    if (!running) return Promise.resolve();
    return ending ??= new Promise(resolve => { over = resolve; });
  };
}

// Those following them (`kuvo/wakes/events`), told of each change made here; `kuvo-wake fire`'s
// as the system sees their folders change.
export const wakeFollowers = new Set();
export const wakesChanged = () => {
  for (const tell of wakeFollowers) tell();
};
