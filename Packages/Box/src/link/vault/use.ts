// Whether an agent may use an item now: Pause first, then its grant (on its own, or asking you
// each time), and an item named without a grant asks you too. Every outcome is noted.

import os from "node:os";
import type { VaultItem } from "../../shared/routes/vault";
import { IS_MAC } from "../home";
import type { Notice } from "../notices/notice";
import { note } from "./activity";
import { ask } from "./asks";
import { pausedFor, setGrant, setPaused } from "./store";
import { type Caller, grantFor } from "./who";

/** Where the use goes, and why the agent says it needs it. */
export interface Use {
  site?: string;
  program?: string;
  why?: string;
  /** Whether it asks you when it may not use it at all (an item it named), rather than just saying no. */
  askWithout?: boolean;
  signal?: AbortSignal;
}

export type Allowed = { ok: true; how: "own" | "once" | "always" } | { ok: false; message: string };

// Your phones, told what needs you (a bot paused by the tripwire): set by the process that holds the vault.
let tell: (notice: Notice) => boolean = () => false;
export const setVaultTell = (to: (notice: Notice) => boolean) => {
  tell = to;
};

const machineName = () => (IS_MAC ? undefined : os.hostname());

const whoOf = (caller: Caller) => ({
  ...(caller.bot ? { bot: caller.bot } : {}),
  ...(caller.botName ? { botName: caller.botName } : {}),
  ...(caller.root ? { session: caller.root } : {}),
  ...(caller.sessionName ? { sessionName: caller.sessionName } : {}),
});

const itemOf = (item: VaultItem) => ({ item: item.id, itemName: item.name, kind: item.kind });

export async function mayUse(item: VaultItem, caller: Caller, use: Use): Promise<Allowed> {
  const where = { ...(use.site ? { site: use.site } : {}), ...(use.program ? { program: use.program } : {}), ...(use.why ? { why: use.why } : {}) };
  const paused = pausedFor(caller.bot);
  if (paused) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "paused" });
    return { ok: false, message: paused };
  }
  const how = grantFor(item, caller);
  if (how === "own") return { ok: true, how: "own" };
  if (how === null && !use.askWithout) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "no grant" });
    return { ok: false, message: `You may not use “${item.name}”. Ask the user for it with vault_ask.` };
  }
  note({ what: "asked", ...itemOf(item), ...whoOf(caller), ...where });
  const answered = await ask({ kind: "use", ...whoOf(caller), item: item.id, itemName: item.name, ...(use.site ? { site: use.site } : {}), ...(use.why ? { why: use.why } : {}), ...(machineName() ? { machine: machineName() } : {}) }, use.signal);
  if (answered.answer === "no") {
    note({ what: "declined", ...itemOf(item), ...whoOf(caller), ...where, ...(answered.client ? { client: answered.client } : {}) });
    return { ok: false, message: `The user didn't let you use “${item.name}”.` };
  }
  if (answered.answer === "always") {
    const who = caller.bot ? { bot: caller.bot } : caller.folder ? { project: caller.folder } : null;
    if (who) {
      setGrant(item.id, who, "own");
      note({ what: "granted", ...itemOf(item), ...whoOf(caller), how: "own", ...(answered.client ? { client: answered.client } : {}) });
    }
  }
  note({ what: "allowed", ...itemOf(item), ...whoOf(caller), ...where, how: answered.answer, ...(answered.client ? { client: answered.client } : {}) });
  return { ok: true, how: answered.answer };
}

/** A fill refused because the page isn't one of the item's sites: the strongest sign a page is
 * steering the agent. That bot's use of the vault pauses until you look. */
export function tripwire(item: VaultItem, caller: Caller, site: string): string {
  const why = `It tried to use “${item.name}” on ${site}, which isn't one of its sites.`;
  if (caller.bot) setPaused(true, caller.bot, why);
  note({ what: "refused", ...itemOf(item), ...whoOf(caller), site, how: "wrong site" });
  try {
    tell({ title: caller.botName ? `${caller.botName} paused` : "A fill was refused", subtitle: machineName(), body: why, category: "message", thread: caller.root ?? "vault", data: caller.root ? { session: caller.root } : {} });
  } catch {}
  return `${why} Kuvo Code only fills it on ${item.sites.join(", ")}.${caller.bot ? " The user has been told, and this bot's use of the vault is paused until they look." : ""}`;
}

/** Notes a use that went ahead. */
export const noteUse = (item: VaultItem, caller: Caller, use: Omit<Use, "signal" | "askWithout">, how: string) =>
  note({ what: "used", ...itemOf(item), ...whoOf(caller), ...(use.site ? { site: use.site } : {}), ...(use.program ? { program: use.program } : {}), ...(use.why ? { why: use.why } : {}), how });
