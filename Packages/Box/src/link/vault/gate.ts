// Whether agents may use the vault on this box: its tools listed and answered, its items, keys and
// files filled. Only where agents' commands are fenced away from Kuvo Code's own folders, processes
// and secrets (vault/FENCING): until then a command an agent runs could reach what the vault keeps,
// so its tools are yours alone. What Kuvo Code did before the vault still works: a sign-in you let
// agents make on their own on a site is filled there, into the page (`kuvo/vault/fill`).
//
// `KUVO_VAULT_AGENTS=1` opens it for the tests of what agents do with it, in a test's own folder
// only: never the real box's (your account's own `~/.kuvo-code`, or this Mac's `run.kuvo.code…/box`),
// where a line an agent's command added to your shell's profile could set it.

import os from "node:os";
import path from "node:path";
import { K } from "../home";

const realBox = (): boolean => {
  const home = path.resolve(K);
  return home === path.join(os.userInfo().homedir, ".kuvo-code") || path.basename(path.dirname(home)).startsWith("run.kuvo.code");
};

export const agentsUseVault = (): boolean => process.env.KUVO_VAULT_AGENTS === "1" && !realBox();

export const AGENTS_LATER = "The user's vault isn't open to agents on this computer yet: its items, keys, files and notes can't be used here. To sign in, call browser_sign_in without an item: a sign-in the user lets you use on this site fills on its own, or else they sign in. For anything else, ask the user in the chat.";
