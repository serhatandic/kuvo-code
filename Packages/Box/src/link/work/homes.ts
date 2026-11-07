// Where conversations that aren't here live now (`run/work/homes.json`, PROTOCOL.md, "Work"), so a
// session left behind can always tell whoever started it, however long ago that moved. Learned from
// this box's record of its moves and its peers' word on theirs, from a box saying where one went
// (`lives`), and from the sessions a box's notes speak of. A conversation found here always wins
// over a home: whoever reads one has looked here first.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { peerPlaces } from "../engine/client";
import type { PeerPlaces } from "../engine/client";
import { locked, writePrivate } from "../files";
import { NOTE_MEMORY } from "../letters/letter";
import { movedAway } from "../moves/records";
import { movesTold, ownKey, ownListed, removedBoxes } from "../peers/known";
import { WORK_FOLDER } from "./changes";
import { startedByOf, workSessions } from "./tree";
import type { LinkState } from "../state";

export const WORK_HOMES = path.join(WORK_FOLDER, "homes.json");
const LOCK = path.join(WORK_FOLDER, ".homes.lock");

/** Where a conversation lives (a box's key), and when that was so. */
interface Home {
  key: string;
  at: number;
}

const readHomes = (): Record<string, Home> => {
  try {
    const kept: unknown = JSON.parse(fs.readFileSync(WORK_HOMES, "utf8"));
    if (!isObject(kept)) return {};
    return Object.fromEntries(Object.entries(kept).filter(([, each]) => isObject(each) && typeof each.key === "string" && typeof each.at === "number")) as Record<string, Home>;
  } catch {
    return {};
  }
};

const changeHomes = (change: (homes: Record<string, Home>) => boolean): void => {
  try {
    fs.mkdirSync(WORK_FOLDER, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const homes = readHomes();
      if (change(homes)) writePrivate(WORK_HOMES, JSON.stringify(homes));
    });
  } catch {}
};

// All this box's record of its moves says, however old (`movedAway` looks back from the time it's
// given, so from none it's all of it).
const everyMove = () => movedAway(0);

/** Where each conversation known to have left lives now, by the newest word on it; a computer you
 * removed is no one's home. */
export function homesOf(link: LinkState | null | undefined): Map<string, string> {
  const newest = new Map(Object.entries(readHomes()));
  // (The record too, should the box have been off since, too long for what follows to have learned it.)
  for (const { session, key, at } of everyMove()) if (at > (newest.get(session)?.at ?? -Infinity)) newest.set(session, { key, at });
  const removed = removedBoxes(link);
  return new Map([...newest].filter(([, home]) => !removed.has(home.key)).map(([session, home]) => [session, home.key]));
}

/** Word that `sessions` live on box `key`, as of `at`: an older word than what's kept changes nothing. */
export function noteHomes(sessions: readonly string[], key: string, at = Date.now()): void {
  if (!sessions.length) return;
  changeHomes(homes => {
    const newer = sessions.filter(session => (homes[session]?.at ?? -Infinity) <= at);
    for (const session of newer) homes[session] = { key, at };
    return newer.length > 0;
  });
}

/** What this box's record of its moves and its peers' word say now, kept for as long as it's needed
 * (the record itself forgets, and is rewritten without what's older than two days). One listed here
 * again has no home; one older than a home lasts wasn't learned in time, and `homesOf` still reads it. */
export function learnHomes(link: LinkState | null | undefined, now = Date.now()): void {
  const newest = new Map<string, Home>();
  for (const { session, key, at } of [...everyMove().filter(each => now - each.at < NOTE_MEMORY), ...movesTold(link, now)]) {
    if (at > (newest.get(session)?.at ?? -Infinity)) newest.set(session, { key, at });
  }
  const here = new Set(ownListed().map(agent => agent.session));
  const own = ownKey(link ?? {});
  const kept = readHomes();
  // (A word that it's here is news only of one with a home.)
  const news = [...newest].some(([session, { key, at }]) => !here.has(session) && at > (kept[session]?.at ?? -Infinity) && (key !== own || session in kept));
  if (!news && !Object.keys(kept).some(session => here.has(session))) return;
  changeHomes(homes => {
    for (const [session, home] of newest) if (!here.has(session) && home.at > (homes[session]?.at ?? -Infinity)) homes[session] = home;
    for (const session of Object.keys(homes)) if (here.has(session) || homes[session]!.key === own) delete homes[session];
    return true;
  });
}

// When old homes were last looked at (a whole list of sessions, so not each round).
let lookedAt = -Infinity;
const LOOK_EVERY = 3_600_000;

/** Homes 30 days old that no session here names any more, gone. Only once it's sure of that: every
 * place conversations run here answered, in full. */
export async function forgetOldHomes(now = Date.now(), places: () => PeerPlaces = peerPlaces): Promise<void> {
  const old = Object.entries(readHomes()).filter(([, home]) => now - home.at > NOTE_MEMORY).map(([session]) => session);
  if (!old.length || Math.abs(now - lookedAt) < LOOK_EVERY) return;
  const { targets, bridge } = places();
  if (!bridge) return;
  lookedAt = now;
  const named = new Set((await workSessions(targets, undefined, { archived: true, whole: true })).map(each => startedByOf(each.data)));
  changeHomes(homes => {
    for (const session of old) if (!named.has(session) && now - (homes[session]?.at ?? now) > NOTE_MEMORY) delete homes[session];
    return true;
  });
}
