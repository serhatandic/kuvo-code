// @ts-nocheck
// The box's keeper, and the bridge it keeps running

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { processRuns as runs } from "../shared/platform";
import { textOf } from "./files";
import { K, PID_FILE, RUN } from "./home";
import { SCRIPT } from "./home";

// (Whether a process is alive, and runs what it should: `alive` and `runs`, ../shared/platform.)

// Another bridge.
export const isBridge = pid => pid !== process.pid && runs(pid, "kuvo-link.js");

// The box's keeper (`bin/kuvo-start`), started again if it went: it keeps the engine and this
// bridge running.
export function keepKeeper() {
  let start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return;
  // COMPAT(0.7 keeper): the keeper started from its own copy (`bin/.kuvo-start-keeper`) when an older Mac's kuvo-start has no `keep)`. Goes 3 months after 0.8.0.
  // An older Kuvo Code on a Mac (0.7 and before) put its own kuvo-start here, which only starts
  // the engine after a restart: the box's keeper, from the copy it keeps of itself (which puts
  // itself back).
  const copy = path.join(K, "bin", ".kuvo-start-keeper");
  if (!/\nkeep\)/.test(textOf(start) ?? "") && fs.existsSync(copy)) start = copy;
  let keeper = null;
  try { keeper = Number(fs.readFileSync(path.join(RUN, "box.pid"), "utf8")); } catch {}
  if (keeper && runs(keeper, "kuvo-start")) return;
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  try {
    spawn("sh", [start], { cwd: K, env: environment, detached: true, stdio: "ignore" }).unref();
  } catch {}
}

export function runningBridge() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    return isBridge(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Starts the bridge on its own, outliving this command, from the machine's workspace.
export function startBridge() {
  const workspace = path.join(K, "workspace");
  const child = spawn(process.execPath, [SCRIPT, "run"], {
    detached: true,
    stdio: "ignore",
    cwd: fs.existsSync(workspace) ? workspace : K,
    env: process.env,
  });
  child.unref();
}