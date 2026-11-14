// COMPAT(0.7 settings): the launch's lock as the scripts take it, for `box adopt` (adopt-settings.ts). Goes 3 months after 0.8.0.
// The engine's launch's lock as the box's own scripts take it (OpenCodeKit's `RemoteServer.launchLock`,
// which says more): `run/.launching`, an empty folder, made by whoever takes it; beside it its holder
// says who it is (`run/.launching.pid`, believed only if the folder isn't newer). One whose holder is
// gone (a number that runs as none of the scripts that take it now, this process's own included) is
// taken away at once, one at a time (`run/.launching.breaking`, with who's doing it in it; one whose
// taker is gone taken over by one alone, `.launching.breaking.gone-<taker>`); one whose holder runs,
// or that says nothing (an older script's), is waited for until it's `stale`. Never gone ahead without.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { textOf } from "../files";
import { RUN } from "../home";

const LOCK = path.join(RUN, ".launching");
const SAID = `${LOCK}.pid`;
const BREAKING = `${LOCK}.breaking`;
const TAKER = path.join(BREAKING, "pid");
const GONE = `${BREAKING}.gone-`;
// The scripts that take it, as `holding` there knows them.
const SCRIPTS = /kuvo-start|kuvo-launch|kuvo_script|kuvo-link/;

/** The launch's lock wasn't had in time: one holding it runs. */
export class LaunchLockBusy extends Error {}

const said = (file: string) => textOf(file)?.trim() ?? "";
const changed = (file: string) => {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
};
const olderThan = (file: string, ms: number) => {
  const at = changed(file);
  return at !== null && Date.now() - Number(at / 1_000_000n) > ms;
};

// Whether `pid` runs as one of the scripts that take it (its command line says so), and isn't this one.
function holding(pid: string): boolean {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
  try {
    if (fs.existsSync("/proc/self")) return SCRIPTS.test(fs.readFileSync(`/proc/${pid}/cmdline`, "latin1"));
    return SCRIPTS.test(spawnSync("ps", ["-ww", "-o", "command=", "-p", pid], { encoding: "utf8" }).stdout ?? "");
  } catch {
    return false;
  }
}

// The holder the lock says it has, believed, when it's gone; else "".
function goneHolder(): string {
  const holder = said(SAID);
  const lock = changed(LOCK);
  const saying = changed(SAID);
  return holder && lock !== null && saying !== null && lock <= saying && !holding(holder) ? holder : "";
}

// Takes away a lock whose holder is gone, or that's `stale`, as the scripts do: only from the holder
// judged gone (what it said moved aside, one step, and put back if it isn't that one's).
function unheld(stale: number) {
  if (!goneHolder() && !olderThan(LOCK, stale)) return;
  try {
    const taker = said(TAKER);
    if ((taker && !holding(taker)) || (!taker && olderThan(BREAKING, 60_000))) {
      // One alone takes over from a given taker that's gone (one that never said, by its folder).
      let gone = taker;
      if (!gone) try { gone = `n${fs.statSync(BREAKING).ino}`; } catch { gone = "n"; }
      for (const name of fs.readdirSync(RUN)) {
        const marker = path.join(RUN, name);
        if (marker.startsWith(GONE) && olderThan(marker, 60_000)) try { fs.rmdirSync(marker); } catch {}
      }
      try {
        fs.mkdirSync(`${GONE}${gone}`);
      } catch {
        return;
      }
      const aside = `${BREAKING}.${process.pid}`;
      try {
        fs.renameSync(BREAKING, aside);
        if (said(path.join(aside, "pid")) !== taker) {
          // Another's: back where it was.
          if (!fs.existsSync(BREAKING)) fs.renameSync(aside, BREAKING);
          return;
        }
        fs.rmSync(aside, { recursive: true, force: true });
      } catch {}
    }
    try {
      fs.mkdirSync(BREAKING);
    } catch {
      return;
    }
    try {
      fs.writeFileSync(TAKER, `${process.pid}\n`);
      const holder = goneHolder();
      if (holder) {
        const aside = `${SAID}.${process.pid}`;
        fs.renameSync(SAID, aside);
        if (said(aside) === holder) {
          // Only that holder's: one newer than what it said was taken since.
          const lock = changed(LOCK);
          const saying = changed(aside);
          if (lock !== null && saying !== null && lock <= saying) try { fs.rmdirSync(LOCK); } catch {}
        } else {
          try { fs.linkSync(aside, SAID); } catch {}
        }
        fs.rmSync(aside, { force: true });
      } else if (olderThan(LOCK, stale)) {
        fs.rmSync(SAID, { force: true });
        try { fs.rmdirSync(LOCK); } catch {}
      }
    } finally {
      if (said(TAKER) === String(process.pid)) fs.rmSync(BREAKING, { recursive: true, force: true });
    }
  } catch {}
}

// `work` done holding the launch's lock, saying so. Not had in `wait / 100` tries, 100 ms apart (each
// longer by the look at whether its holder runs: past `stale`, so it's one taken again and again):
// LaunchLockBusy, never without it. One held over `stale` is taken away as left behind.
export function launchLocked<T>(work: () => T, { stale = 300_000, wait = 330_000 } = {}): T {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let i = 0; !held && i < wait / 100; i++) {
    try {
      fs.mkdirSync(LOCK);
      held = true;
    } catch {
      unheld(stale);
      Atomics.wait(nap, 0, 0, 100);
    }
  }
  if (!held) throw new LaunchLockBusy("Another start of the engine there is still under way, after five minutes: try again once it's done.");
  let saying = false;
  if (held) try { fs.writeFileSync(SAID, `${process.pid}\n`); saying = true; } catch {}
  try {
    return work();
  } finally {
    // Only its own: one taken from it (held over `stale`) and taken again since is the other's.
    if (held && (!saying || said(SAID) === String(process.pid))) {
      try { fs.rmSync(SAID, { force: true }); } catch {}
      try { fs.rmdirSync(LOCK); } catch {}
    }
  }
}
