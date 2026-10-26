// Reading and writing the box's files: what's there or nothing, written so only you can read them
// and never seen half-written, one process at a time where two would clash.

import fs from "node:fs";
import path from "node:path";

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

// `work` done holding `lock` (a folder, made while it's held): one process at a time. A lock left by
// one that was cut off goes after `stale` ms (ten seconds); one not had in `wait` ms (three) goes
// ahead all the same.
export function locked<T>(lock: string, work: () => T, { stale = 10_000, wait = 3_000 } = {}): T {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let i = 0; i < wait / 10 && !held; i++) {
    try {
      fs.mkdirSync(lock);
      held = true;
    } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > stale) fs.rmdirSync(lock); } catch {}
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    if (held) try { fs.rmdirSync(lock); } catch {}
  }
}
