// Whether this box may work on its own (PROTOCOL.md, "Work › Goals"): a bot's goal goes on alone,
// its bot answering its sessions' asks within the rules, only where the commands its sessions run are
// kept to their folders (the sandbox), so nothing they run while you're away reaches your keys, your
// other projects or Kuvo Code itself. Until the sandbox is built into this box, a goal runs with you
// there: what its sessions ask waits for you. Once it is, this reads `fenceState()`
// (`../fence/state.ts`): `on`, every command the engine runs here goes through the sandbox, and
// for a bot on a coding agent (whose CLI runs its own commands) `agents` too.

import path from "node:path";
import { IN_TEST_FOLDER, K } from "../home";

/** Whether a goal may go on alone on this box now. A test box (its own folder, never yours, nor the real
 * app's: `run.kuvo.code/box`) can say yes with KUVO_TEST_SANDBOX_ON=1, for the tests of what a
 * goal does alone. */
export function sandboxOn(): boolean {
  const realApp = path.basename(path.dirname(path.resolve(K))) === "run.kuvo.code";
  if (IN_TEST_FOLDER && !realApp && process.env.KUVO_TEST_SANDBOX_ON === "1") return true;
  return false;
}
