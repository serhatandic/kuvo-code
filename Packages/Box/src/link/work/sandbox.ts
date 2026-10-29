// Whether this box may work unattended (PROTOCOL.md, "Work › A night"): a night runs only where the
// commands its sessions run are kept to their folders (the sandbox), so nothing a session runs
// while you sleep reaches your keys, your other projects or Kuvo Code itself. Until the sandbox is
// built into this box, no night starts here; everything else about nights works.

import { IN_TEST_FOLDER } from "../home";

/** Whether a night can start on this box now. A test box (its own folder, never yours) can say yes
 * with KUVO_TEST_SANDBOX_ON=1, for the tests of what a night does. */
export function sandboxOn(): boolean {
  if (IN_TEST_FOLDER && process.env.KUVO_TEST_SANDBOX_ON === "1") return true;
  return false;
}
