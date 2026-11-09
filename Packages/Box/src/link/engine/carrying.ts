// Conversations being carried on with the coding agents now (`carryToAgents`), by any of this box's
// processes: the long-running one a phone reaches, or a client's `box route`, a process of its own
// for each request. One at a time each, and the queue's watcher leaves a queue to the carry under
// way (`carryQueue`, with what it renames). A mark in `run/carrying`, by the process doing it; one
// whose process is gone, or older than any carry takes, doesn't count.

import fs from "node:fs";
import path from "node:path";
import { RUN } from "../home";

const FOLDER = path.join(RUN, "carrying");
// Longer than a carry takes (its import waits two minutes at most).
const MOST = 30 * 60_000;

/** Whether `id` can name a conversation's mark: a session's id, never a path. */
export const isSessionID = (id: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(id);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether `id` is being carried on now, by this process or another. */
export function carryUnderWay(id: string): boolean {
  if (!isSessionID(id)) return false;
  const file = path.join(FOLDER, id);
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 1 && alive(pid) && Date.now() - fs.statSync(file).mtimeMs < MOST;
  } catch {
    return false;
  }
}

/** `id`'s carry, begun by this process: false while another is under way. */
export function beginCarry(id: string): boolean {
  if (!isSessionID(id)) return false;
  fs.mkdirSync(FOLDER, { recursive: true, mode: 0o700 });
  const file = path.join(FOLDER, id);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (carryUnderWay(id)) return false;
    // (Left by a process that's gone.)
    fs.rmSync(file, { force: true });
  }
  return false;
}

/** `id`'s carry, done. */
export function endCarry(id: string): void {
  if (isSessionID(id)) fs.rmSync(path.join(FOLDER, id), { force: true });
}
