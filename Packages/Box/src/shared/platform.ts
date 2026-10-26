// Where macOS and Linux differ, for the box's code, which runs on both: this Mac's box and each
// machine's. Everything else is the same code on both; what differs is decided here, each side
// tested (test/platform.test.ts) on whichever system runs the tests.
//
// Also the same rule elsewhere, in shell: the update's restore script tells the link it started
// by its command line where there's /proc, and by its being alive where there isn't
// (`keepForRollback`'s `restore.sh`, link/updates/update.ts).

import fs from "node:fs";

/** Whether process `pid` is alive (and ours to signal). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` runs `name` (a program's file, `kuvo-agents`, `kuvo-link.js`), not whatever took
 * its number after a crash. Linux: its command line says so. macOS, which has no /proc: that it's
 * alive (this Mac's app removes the records that name its processes as they stop). `proc`: where
 * /proc is (a test's own).
 */
export function processRuns(pid: unknown, name: string, proc = "/proc"): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 1 || !alive(pid as number)) return false;
  try {
    return fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").includes(name);
  } catch {
    return !fs.existsSync(proc);
  }
}

/**
 * The folders in a home folder that the system asks you about before an app looks into them:
 * on a Mac, its privacy prompts (so a folder list from the home folder doesn't look inside
 * them); none on Linux.
 */
export function promptedFolders(platform: NodeJS.Platform = process.platform): ReadonlySet<string> {
  return platform === "darwin" ? new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"]) : new Set();
}
