// Reading and writing the box's files: what's there or nothing, written so only you can read them
// and never seen half-written, one process at a time where two would clash.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sleep } from "./wait";

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
  placeWhole(file, text);
}

/**
 * A key, token or sign-in in `file`: as `writePrivate`, and in a folder only you can open however
 * it was made (one others could read is closed to them first).
 */
export function writeSecret(file: string, text: string | Uint8Array, mode = 0o600) {
  privateFolder(path.dirname(file));
  placeWhole(file, text, mode);
}

/** `folder`, made if it isn't there, and closed to everyone but you, where it really is (a link to
 * one elsewhere, as when you've moved it to another disk, is followed); one that's someone else's is
 * refused, as what's written in it could be read or swapped (root may write in anyone's). */
export function privateFolder(folder: string): string {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(folder);
  const made = fs.statSync(real);
  if (!made.isDirectory()) throw new Error(`${folder} isn't a folder: nothing secret is written there.`);
  const me = process.getuid?.();
  if (me !== undefined && me !== 0 && made.uid !== me) throw new Error(`${folder} isn't yours: nothing secret is written in it.`);
  if (made.mode & 0o077) fs.chmodSync(real, 0o700);
  return folder;
}

// Through a new file only you can read (one of that name already there, or a link, isn't written
// through), renamed into place: never seen half-written, and nothing left beside it if it fails.
// (`mode` 0o700 for a script that runs as it lands.)
export function placeWhole(file: string, text: string | Uint8Array, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode, flag: "wx" });
    // (Only a mode your umask took bits from, as a script's.)
    if ((fs.statSync(temporary).mode & 0o777) !== mode) fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
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

// Each lock's work in this process, in turn: the last one's end.
const turns = new Map<string, Promise<void>>();

// The same for work that awaits: held until it's done. In this process, each waits its turn however
// long the one before takes; the lock's folder keeps other processes out.
export async function lockedWhile<T>(lock: string, work: () => Promise<T>, { stale = 10_000, wait = 3_000 } = {}): Promise<T> {
  const before = turns.get(lock) ?? Promise.resolve();
  let done = () => {};
  const mine = before.then(() => new Promise<void>(resolve => { done = resolve; }));
  turns.set(lock, mine);
  await before;
  try {
    const held = await holdAwaiting(lock, stale, wait);
    try {
      return await work();
    } finally {
      if (held) try { fs.rmdirSync(lock); } catch {}
    }
  } finally {
    done();
    if (turns.get(lock) === mine) turns.delete(lock);
  }
}
