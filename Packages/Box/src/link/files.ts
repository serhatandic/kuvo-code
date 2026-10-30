// Reading and writing the box's files: what's there or nothing, written so only you can read them
// and never seen half-written, one process at a time where two would clash.

import fs from "node:fs";
import path from "node:path";
import { sleep } from "../shared/wait";

/** A file's text, or null when it isn't there or can't be read. */
export const textOf = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
/** What's in a folder, or nothing when it isn't there. */
export const listOf = (folder: string): string[] => {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};

/** `text` in `file`, readable by you only (its folder made so too), moved into place whole. */
export function writePrivate(file: string, text: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Takes `lock` (a folder, made while it's held) when it's free: whether it was. A lock left by one
// that was cut off goes after `stale` ms.
function take(lock: string, stale: number): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > stale) fs.rmdirSync(lock); } catch {}
    return false;
  }
}

// Holds `lock` for one process at a time: whether it was had. One not had in `wait` ms goes ahead
// all the same.
function hold(lock: string, stale: number, wait: number): boolean {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < wait / 10; i++) {
    if (take(lock, stale)) return true;
    Atomics.wait(nap, 0, 0, 10);
  }
  return false;
}

// The same, waiting without holding up the process: the one holding it may be this process too,
// awaiting what it holds the lock for.
async function holdAwaiting(lock: string, stale: number, wait: number): Promise<boolean> {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let i = 0; i < wait / 10; i++) {
    if (take(lock, stale)) return true;
    await sleep(10);
  }
  return false;
}

// `work` done holding `lock`: one process at a time. A lock left by one that was cut off goes
// after `stale` ms (ten seconds); one not had in `wait` ms (three) goes ahead all the same.
export function locked<T>(lock: string, work: () => T, { stale = 10_000, wait = 3_000 } = {}): T {
  const held = hold(lock, stale, wait);
  try {
    return work();
  } finally {
    if (held) try { fs.rmdirSync(lock); } catch {}
  }
}

// The same for work that awaits: held until it's done.
export async function lockedWhile<T>(lock: string, work: () => Promise<T>, { stale = 10_000, wait = 3_000 } = {}): Promise<T> {
  const held = await holdAwaiting(lock, stale, wait);
  try {
    return await work();
  } finally {
    if (held) try { fs.rmdirSync(lock); } catch {}
  }
}
