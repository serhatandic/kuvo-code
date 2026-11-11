// Whether a box is updating itself now (`run/.updating`, PROTOCOL.md "Updates"): by the process
// that holds the lock, the link's; one whose process went (killed mid-way, the machine restarted)
// isn't one. The link reads it before it updates or restarts its bridge; the coding agents' bridge
// before it makes way for a newer one.

import fs from "node:fs";
import path from "node:path";
import { processRuns } from "./platform";

export function updateUnderWay(run: string): boolean {
  const lock = path.join(run, ".updating");
  if (!fs.existsSync(lock)) return false;
  let pid: number | null = null;
  try { pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8")); } catch {}
  if (pid) return processRuns(pid, "kuvo-link");
  // Just made, its process not written yet.
  try { return Date.now() - fs.statSync(lock).mtimeMs < 60_000; } catch { return false; }
}
