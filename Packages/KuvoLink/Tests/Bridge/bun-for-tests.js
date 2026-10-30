// The Bun a box runs on, for the tests that need one: this process when it's Bun (run on the engine,
// with BUN_BE_BUN=1), KUVO_TEST_BUN (Bun, or an engine, which is Bun with BUN_BE_BUN=1 as these
// run it), or `bun` on the PATH. On Linux the sandbox's script runs on it, and the coding agents'
// bridge does everywhere.
import { spawnSync } from "node:child_process";

export function testBun() {
  if (process.versions.bun) return process.execPath;
  return process.env.KUVO_TEST_BUN || spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim() || undefined;
}

export const NO_BUN = "this needs Bun, as a box runs on it: run it with the engine (BUN_BE_BUN=1), name a Bun or an engine in KUVO_TEST_BUN, or put bun on the PATH";
