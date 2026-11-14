// When each field of a bot here was last changed (`run/bots-edited.json`, `{<bot>: {<field>: ms}}`):
// by a client, the bot itself (set_job), or an edit another computer held for this one. An edit held
// elsewhere that comes later changes only the fields it changed after that (PROTOCOL.md, `kuvo/bots`,
// "Held for another computer"), so one you made here meanwhile is never undone by an older one.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, textOf, writePrivate } from "../files";
import { RUN } from "../home";

const FILE = path.join(RUN, "bots-edited.json");
const LOCK = path.join(RUN, ".bots-edited.lock");
/** How long a field's time is kept: past it, a held edit always lands (one held that long is rare). */
const KEPT = 30 * 86_400_000;

type Times = Record<string, Record<string, number>>;

function readTimes(now: number): Times {
  try {
    const kept: unknown = JSON.parse(textOf(FILE) ?? "");
    if (!isObject(kept)) return {};
    const times: Times = {};
    for (const [bot, fields] of Object.entries(kept)) {
      if (!isObject(fields)) continue;
      const fresh = Object.entries(fields).filter(([, at]) => typeof at === "number" && now - at < KEPT);
      if (fresh.length) times[bot] = Object.fromEntries(fresh) as Record<string, number>;
    }
    return times;
  } catch {
    return {};
  }
}

/** When each field of `bot` was last changed here, by field. */
export const editedTimes = (bot: string, now = Date.now()): Record<string, number> => readTimes(now)[bot] ?? {};

/** `fields` of `bot` changed here as of `at` (each, unless it was changed later already). */
export function noteEdited(bot: string, fields: string[], at = Date.now(), now = Date.now()): void {
  if (!fields.length) return;
  try {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    locked(LOCK, () => {
      const times = readTimes(now);
      const mine = { ...(times[bot] ?? {}) };
      for (const field of fields) mine[field] = Math.max(mine[field] ?? 0, at);
      times[bot] = mine;
      writePrivate(FILE, JSON.stringify(times));
    });
  } catch {}
}
