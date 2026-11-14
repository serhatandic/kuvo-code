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

/** Where `bun` really runs from, as a box it runs sees itself (`process.execPath`): a script that
 * starts it (as scripts/lokum-bridge-check.sh puts on the PATH) runs the engine it names. */
export function bunRunsAs(bun) {
  const said = spawnSync(bun, ["-e", "console.log(process.execPath)"], { env: { ...process.env, BUN_BE_BUN: "1" }, encoding: "utf8" });
  if (said.status !== 0 || !said.stdout.trim()) throw new Error(`${bun} didn't say where it runs from: ${said.stderr}`);
  return said.stdout.trim();
}
