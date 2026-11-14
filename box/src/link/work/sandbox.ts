// Whether this box may work on its own (PROTOCOL.md, "Work › Goals"): a bot's goal goes on alone,
// its bot answering its sessions' asks within the rules, and a conversation in Auto runs without
// asking (PROTOCOL.md, "Approval"), only where the commands its sessions run are kept in the
// sandbox, so nothing they run while you're away reaches your keys, your other projects or Kuvo Code
// itself: every command the engine runs here goes through it, and for a coding agent (whose program
// runs its own commands) every agent's process too; and kept from all it hides (`fenceWhole`), not on
// a Linux machine whose commands can't have a namespace of their own. Elsewhere a goal runs with you
// there: what its sessions ask waits for you. Read from what the box keeps in its folder, so any of
// its processes tells the same (a machine's `box route`, as the Mac asks it, too).

import path from "node:path";
import { agentsInSandbox, engineCommandsInSandbox, fenceWhole } from "../fence/state";
import { IN_TEST_FOLDER, K } from "../home";

/** What's missing for that: the sandbox (`off`), keeping commands from all it hides (`partial`), or
 * the coding agents' own programs in it (`agents`, some started before it still run outside it);
 * null where nothing is. */
export type SandboxGap = "off" | "partial" | "agents";

/** Whether a goal may go on alone on this box now, for a bot on the engine, or on a coding agent
 * (`agents`). A test box (its own folder, never yours, nor the real app's: `run.kuvo.code/box`) can
 * say yes with KUVO_TEST_SANDBOX_ON=1, for the tests of what a goal does alone. */
export function sandboxOn(agents = false): boolean {
  return sandboxGap(agents) === null;
}

export function sandboxGap(agents = false): SandboxGap | null {
  const realApp = path.basename(path.dirname(path.resolve(K))) === "run.kuvo.code";
  if (IN_TEST_FOLDER && !realApp && process.env.KUVO_TEST_SANDBOX_ON === "1") return null;
  if (!engineCommandsInSandbox()) return "off";
  if (!fenceWhole()) return "partial";
  return agents && !agentsInSandbox() ? "agents" : null;
}
