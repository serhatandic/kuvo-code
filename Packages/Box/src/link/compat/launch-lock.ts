// COMPAT(0.7 settings): the launch's lock as the scripts take it, for `box adopt` (adopt-settings.ts). Goes 3 months after 0.8.0.
// The engine's launch's lock as the box's own scripts take it (OpenCodeKit's `RemoteServer.launchLock`,
// which says more): `run/.launching`, an empty folder, made by whoever takes it; beside it its holder
// says who it is (`run/.launching.pid`, believed only if the folder isn't newer). One whose holder is
// gone (a number nothing of Kuvo Code's runs as now, this process's own included) is taken away at
// once, one at a time (`run/.launching.breaking`, with who's doing it in it); one whose holder runs,
// or that says nothing (an older script's), is waited for until it's `stale`.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { textOf } from "../files";
import { RUN } from "../home";

const LOCK = path.join(RUN, ".launching");
const SAID = `${LOCK}.pid`;
const BREAKING = `${LOCK}.breaking`;
const TAKER = path.join(BREAKING, "pid");

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

// Whether `pid` runs as one of Kuvo Code's (its command line says so), and isn't this one.
function holding(pid: string): boolean {
  if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false;
  try {
    if (fs.existsSync("/proc/self")) return fs.readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("kuvo");
    return spawnSync("ps", ["-ww", "-o", "command=", "-p", pid], { encoding: "utf8" }).stdout?.includes("kuvo") ?? false;
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
      const aside = `${BREAKING}.${process.pid}`;
      try {
        fs.renameSync(BREAKING, aside);
        const was = said(path.join(aside, "pid"));
        fs.rmSync(aside, { recursive: true, force: true });
        if (was !== taker) return;
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
          try { fs.rmdirSync(LOCK); } catch {}
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

// `work` done holding the launch's lock, saying so. One not had in `wait` ms goes ahead all the same:
// by then one that was held all along is `stale`, and taken away.
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
