// Whether agents may use the vault on this box: its tools listed and answered, its items, keys and
// files filled. Only where every agent's commands run in the sandbox (fence/state.ts): the engine's
// (`on`), and the coding agents' own programs' (`agents`), since any command outside it could read
// another's environment, where vault_run puts what it hands a command; and where it keeps them from
// all it hides (`fenceWhole`: not a Linux machine whose commands can't have a namespace of their own,
// where one could have your login's systemd start anything outside it). Until then its tools are
// yours alone. What Kuvo Code did before the vault still works: a sign-in you let agents make on
// their own on a site is filled there, into the page (`kuvo/vault/fill`).
//
// `KUVO_VAULT_AGENTS=1` opens it for the tests of what agents do with it, in a test's own folder
// only: never the real box's (your account's own `~/.kuvo-code`, or this Mac's `run.kuvo.code…/box`),
// where a line an agent's command added to your shell's profile could set it.

import { fenceState, fenceWhole } from "../fence/state";
import { REAL_BOX } from "../home";

export const agentsUseVault = (): boolean => {
  if (process.env.KUVO_VAULT_AGENTS === "1" && !REAL_BOX) return true;
  const sandbox = fenceState();
  return sandbox.on && sandbox.agents && fenceWhole();
};

/** Whether the sandbox is on here and agents wait only for those started before it to finish. */
export const agentsWaitForOlder = (): boolean => {
  if (process.env.KUVO_VAULT_AGENTS === "1" && !REAL_BOX) return false;
  const sandbox = fenceState();
  return sandbox.on && !sandbox.agents && fenceWhole();
};

export const AGENTS_LATER = "The user's vault isn't open to agents on this computer yet: its items, keys, files and notes can't be used here. To sign in, call browser_sign_in without an item: a sign-in the user lets you use on this site fills on its own, or else they sign in. For anything else, ask the user in the chat.";
