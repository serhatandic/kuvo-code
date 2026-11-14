// When each field of a bot was last changed (`edited.json` in its folder, `{<field>: ms}`, by the
// clock of the box it lives on): by a client, the bot itself (set_job), or an edit another computer
// held for it. An edit held elsewhere that comes later changes only the fields it changed after
// that (PROTOCOL.md, `kuvo/bots`, "Held for another computer"), so one you made meanwhile is never
// undone by an older one. In its folder, so it goes with the bot when it moves.

import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, textOf, writePrivate } from "../files";
import { botHere } from "./here";

/** How long a field's time is kept: past it, a held edit always lands (one held that long is rare). */
const KEPT = 30 * 86_400_000;
export const EDITED_FILE = "edited.json";

function readTimes(folder: string, now: number): Record<string, number> {
  try {
    const kept: unknown = JSON.parse(textOf(path.join(folder, EDITED_FILE)) ?? "");
    if (!isObject(kept)) return {};
    // (Never ahead of this clock: a bot from a computer whose clock was ahead brings its times.)
    return Object.fromEntries(Object.entries(kept).filter(([, at]) => typeof at === "number" && now - at < KEPT).map(([field, at]) => [field, Math.min(at as number, now)]));
  } catch {
    return {};
  }
}

/** When each field of `bot`, a bot here, was last changed, by field. */
export function editedTimes(bot: string, now = Date.now()): Record<string, number> {
  const here = botHere(bot);
  return here ? readTimes(here.folder, now) : {};
}

/** `fields` of `bot` changed as of `at` (one time for all, or each its own), each unless it was
 * changed later already. */
export function noteEdited(bot: string, fields: string[], at: number | Record<string, number> = Date.now(), now = Date.now()): void {
  const here = botHere(bot);
  if (!fields.length || !here) return;
  try {
    locked(path.join(here.folder, ".edited.lock"), () => {
      const times = readTimes(here.folder, now);
      for (const field of fields) times[field] = Math.max(times[field] ?? 0, Math.min(now, typeof at === "number" ? at : at[field] ?? now));
      writePrivate(path.join(here.folder, EDITED_FILE), JSON.stringify(times));
    });
  } catch {}
}
