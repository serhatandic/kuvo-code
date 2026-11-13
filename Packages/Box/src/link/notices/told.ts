// What this box told you lately (PROTOCOL.md, "kuvo/notices"): each notice it made (a run's news, a
// question, a permission, an agent's notify_user), kept a little while in `run/notices/told.json`
// for its clients to show as their own notifications (`kuvo/notices/events`), so the box alone
// decides what's news and how it's said. Every process of the box writes there (its server, its
// bridge, a `box route` that answers an agent's tool), and the one that tells your phones tells what
// an agent sent on purpose from there.

import path from "node:path";
import { isObject } from "../../shared/json";
import { newID } from "../../shared/text";
import { locked, textOf, writePrivate } from "../files";
import { watchFolders } from "../follow";
import { IS_MAC, RUN } from "../home";
import { runningBridge } from "../keeper";
import type { Notice } from "./notice";

/** Where what's told is kept. */
export const TOLD_FOLDER = path.join(RUN, "notices");
const TOLD_FILE = path.join(TOLD_FOLDER, "told.json");
const TOLD_LOCK = path.join(TOLD_FOLDER, "told.lock");
// The process that tells your phones (a machine's bridge) and keeps its news here, by its pid.
const TELLER_FILE = path.join(TOLD_FOLDER, "teller");

/** Marks this process as the one that tells your phones and keeps its news here (a machine's
 * bridge, as it starts): a bridge from before it doesn't. */
export function markTeller(): void {
  try { writePrivate(TELLER_FILE, String(process.pid)); } catch {}
}

/** Whether this box tells its news now, and sends what agents send you: this Mac's box always; a
 * machine's while a bridge that does runs. */
export function tellingNow(): boolean {
  if (IS_MAC) return true;
  const teller = Number(textOf(TELLER_FILE));
  return Number.isInteger(teller) && teller > 0 && teller === runningBridge();
}

/** A notice told: its id, when (ms since 1970), the notice, and `by: "agent"` for one an agent sent
 * on purpose (notify_user). */
export interface ToldNotice {
  id: string;
  at: number;
  notice: Notice;
  by?: "agent";
}

// How long each is kept: news for clients that follow now; what agents sent, a day, for their limit.
const NEWS_KEPT = 10 * 60_000;
const SENT_KEPT = 24 * 60 * 60_000;
const MOST = 300;

const isTold = (entry: unknown): entry is ToldNotice =>
  isObject(entry) && typeof entry.id === "string" && typeof entry.at === "number" && isObject(entry.notice) && typeof entry.notice.category === "string";

/** What's kept, oldest first. */
export function readTold(): ToldNotice[] {
  try {
    const kept = JSON.parse(textOf(TOLD_FILE) ?? "[]");
    return Array.isArray(kept) ? kept.filter(isTold) : [];
  } catch {
    return [];
  }
}

const keptStill = (entry: ToldNotice, now: number) => now - entry.at < (entry.by === "agent" || entry.notice.category === "usage" ? SENT_KEPT : NEWS_KEPT);

/** Clients following what's told in this process: told at once of each kept. */
export const toldFollowers = new Set<() => void>();

/** `notice` kept as told now, with what's past its time let go: the entry kept, or null where it
 * couldn't be written. `unless`, given what's kept, says why it isn't (then nothing's kept), checked
 * while no other process changes it. */
export function keepTold(notice: Notice, { by, now = Date.now(), unless }: { by?: "agent"; now?: number; unless?: (kept: ToldNotice[]) => string | null } = {}): ToldNotice | { refused: string } | null {
  const entry: ToldNotice = { id: newID("ntc_"), at: now, notice, ...(by ? { by } : {}) };
  let refused: string | null = null;
  try {
    locked(TOLD_LOCK, () => {
      const kept = readTold().filter(each => keptStill(each, now));
      if (notice.category === "usage" && notice.data?.notice && kept.some(each => each.notice.category === "usage" && each.notice.data?.notice === notice.data?.notice)) { refused = "Already kept this usage notice."; return; }
      refused = unless?.(kept) ?? null;
      if (refused) return;
      kept.push(entry);
      writePrivate(TOLD_FILE, JSON.stringify(kept.slice(-MOST)));
    });
  } catch {
    return null;
  }
  if (refused) return { refused };
  for (const told of toldFollowers) told();
  return entry;
}

/** What clients follow (`kuvo/notices`): the news of the last minutes, oldest first. */
export const toldLately = (now = Date.now()): { notices: ToldNotice[] } => ({ notices: readTold().filter(each => now - each.at < (each.notice.category === "usage" ? SENT_KEPT : NEWS_KEPT)) });

/** Tells `tell` (your phones) each notice an agent sends on purpose from now on, whichever process
 * kept it, once each: as the folder changes, and looked at every few seconds too. `look`: looked at
 * now; `stop`: no more. */
export function watchSentByAgents(tell: (notice: Notice) => boolean, { every = 3000, now = Date.now } = {}): { look: () => void; stop: () => void } {
  const since = now();
  const told = new Set<string>();
  const look = () => {
    const kept = readTold();
    for (const entry of kept) {
      if (entry.by !== "agent" || entry.at < since || told.has(entry.id)) continue;
      told.add(entry.id);
      tell(entry.notice);
    }
    // (Those no longer kept needn't be remembered.)
    const ids = new Set(kept.map(each => each.id));
    for (const id of told) if (!ids.has(id)) told.delete(id);
  };
  const watch = watchFolders([TOLD_FOLDER], look, { recursive: false });
  const timer = setInterval(look, every);
  timer.unref?.();
  return {
    look,
    stop: () => {
      watch.close();
      clearInterval(timer);
    },
  };
}
