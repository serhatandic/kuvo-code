// COMPAT(0.7 leave-running): `run/link.seen`, which a 0.7 Mac reads before it stops a machine's engine as it quits. Goes 3 months after 0.8.0.
// When a phone last used this machine, in `run/link.seen`: a Mac with Kuvo Code 0.7.x leaves the
// engine running as it quits while one has in the last week (later ones always do), so
// the machine's sessions and bots are there whenever it asks; a phone lost or unpaired elsewhere
// stops keeping it after that.

import fs from "node:fs";
import path from "node:path";
import { RUN } from "../home";

export const SEEN_FILE = path.join(RUN, "link.seen");
export const KEEP_FOR = 7 * 24 * 60 * 60_000;
let seen = 0;
export function phoneHere(): void {
  if (Date.now() - seen < 5 * 60_000) return;
  seen = Date.now();
  try {
    const now = new Date();
    if (fs.existsSync(SEEN_FILE)) {
      fs.utimesSync(SEEN_FILE, now, now);
    } else {
      fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
      fs.writeFileSync(SEEN_FILE, "", { mode: 0o600 });
    }
  } catch {}
}

// No phone is paired any more: none keeps the engine up.
export function forgetPhones(): void {
  seen = 0;
  try {
    fs.rmSync(SEEN_FILE, { force: true });
  } catch {}
}

export function phoneSeenLately(file = SEEN_FILE, now = Date.now()): boolean {
  try {
    return now - fs.statSync(file).mtimeMs < KEEP_FOR;
  } catch {
    return false;
  }
}
