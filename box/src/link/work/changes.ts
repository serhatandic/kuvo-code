// When each bot's work last changed (`run/work/changes.json`): a session of its started, stopped,
// finished, asked or answered. Every process that changes it notes it here (a tool's `box route`
// too), so `kuvo/work/events` tells every client, who reads that bot's work again.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";

export const WORK_FOLDER = path.join(RUN, "work");
export const WORK_CHANGES = path.join(WORK_FOLDER, "changes.json");
const LOCK = path.join(WORK_FOLDER, ".changes.lock");

/** Those following the work here, in this process: told at once of a change made here. */
export const workFollowers = new Set<() => void>();

/** When each bot's work last changed (ms), by its id. */
export function readWorkChanges(file = WORK_CHANGES): Record<string, number> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return isObject(kept) ? Object.fromEntries(Object.entries(kept).filter(([, at]) => typeof at === "number")) as Record<string, number> : {};
  } catch {
    return {};
  }
}

/** A change to `bot`'s work, noted now. */
export function noteWorkChanged(bot: string, file = WORK_CHANGES): void {
  try {
    fs.mkdirSync(WORK_FOLDER, { recursive: true });
    locked(LOCK, () => {
      const changes = readWorkChanges(file);
      // Never the same time twice, so a client sees each.
      changes[bot] = Math.max(Date.now(), (changes[bot] ?? 0) + 1);
      writePrivate(file, JSON.stringify(changes));
    });
  } catch {}
  for (const tell of workFollowers) tell();
}
