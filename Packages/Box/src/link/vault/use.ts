// Whether an agent may use an item now: Pause first, then its grant (on its own, or asking you
// each time), and an item named without a grant asks you too. Every outcome is noted.

import os from "node:os";
import { LEFT_UNDONE_WORDS } from "../work/autopilot";
import type { VaultItem } from "../../shared/routes/vault";
import { homeFolder, IS_MAC } from "../home";
import type { Notice } from "../notices/notice";
import { note } from "./activity";
import { ask } from "./asks";
import { pausedFor, setGrant, setPaused } from "./store";
import { type Caller, grantFor, untilOnAutopilot } from "./who";

/** Where the use goes, and why the agent says it needs it. */
export interface Use {
  site?: string;
  program?: string;
  why?: string;
  /** Whether it asks you when it may not use it at all (an item it named), rather than just saying no. */
  askWithout?: boolean;
  signal?: AbortSignal;
  /** The conversation to watch while you're asked, where the caller goes unnamed (a shared SSH agent). */
  watch?: string;
  /** Left undone, it's been noted in the activity already. */
  leftUndoneNoted?: boolean;
}

export type Allowed = { ok: true; how: "own" | "once" | "always" } | { ok: false; message: string; leftUndone?: boolean };

/** How a use Autopilot left undone is noted: nobody was asked, and nothing's wrong. */
export const AUTOPILOT_HOW = "autopilot";

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

// What you allowed once (an item given for this once, through vault_ask), by the conversation it's
// for and the item: its next use goes ahead without asking again, within a while.
const ONCE_FOR = 30 * 60_000;
const once = new Map<string, number>();
const onceKey = (caller: Caller, item: string) => `${caller.root ?? caller.session ?? ""}\0${item}`;

/** Lets `caller` use `item` once more without asking. */
export function allowOnce(caller: Caller, item: string) {
  once.set(onceKey(caller, item), Date.now() + ONCE_FOR);
}

/** Whether `caller` has a use of `item` you allowed once, still unused (`take`: using it up). */
export function hasOnce(caller: Caller, item: string, take = false): boolean {
  const key = onceKey(caller, item);
  const until = once.get(key);
  if (!until || until < Date.now()) {
    once.delete(key);
    return false;
  }
  if (take) once.delete(key);
  return true;
}

/** Whom "always" grants for `caller`: its bot, or its project's folder (never a home folder or the
 * whole disk, which would be every project); null for neither, or a seat in a group chat, when it's a once. */
export function alwaysFor(caller: Caller): { bot: string } | { project: string } | null {
  if (caller.seat) return null;
  if (caller.bot) return { bot: caller.bot };
  if (caller.folder && caller.folder !== "/" && caller.folder !== homeFolder()) return { project: caller.folder };
  return null;
}

export async function mayUse(item: VaultItem, caller: Caller, use: Use): Promise<Allowed> {
  const where = { ...(use.site ? { site: use.site } : {}), ...(use.program ? { program: use.program } : {}), ...(use.why ? { why: use.why } : {}) };
  const paused = pausedFor(caller.bot, caller.root ?? caller.session);
  if (paused) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "paused" });
    return { ok: false, message: paused };
  }
  const how = grantFor(item, caller);
  if (how === "own") return { ok: true, how: "own" };
  if (hasOnce(caller, item.id, true)) return { ok: true, how: "once" };
  if (how === null && !use.askWithout) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "no grant" });
    return { ok: false, message: `You may not use “${item.name}”. Ask the user for it with vault_ask.` };
  }
  const leftUndone = (): Allowed => {
    if (!use.leftUndoneNoted) note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: AUTOPILOT_HOW });
    return { ok: false, message: LEFT_UNDONE_WORDS, leftUndone: true };
  };
  if (caller.autopilot) return leftUndone();
  note({ what: "asked", ...itemOf(item), ...whoOf(caller), ...where });
  const { value: answered, onAutopilot } = await untilOnAutopilot(caller.yours ? undefined : use.watch ?? caller.session, use.signal, signal =>
    ask({ kind: "use", ...whoOf(caller), ...(caller.group ? { group: caller.group } : {}), item: item.id, itemName: item.name, ...(use.site ? { site: use.site } : {}), ...(use.why ? { why: use.why } : {}), ...(machineName() ? { machine: machineName() } : {}) }, signal));
  if (onAutopilot) return leftUndone();
  if (answered.answer === "no") {
    note({ what: "declined", ...itemOf(item), ...whoOf(caller), ...where, ...(answered.client ? { client: answered.client, by: answered.by } : {}) });
    return { ok: false, message: `The user didn't let you use “${item.name}”.` };
  }
  const always = answered.answer === "always" ? alwaysFor(caller) : null;
  if (always) {
    setGrant(item.id, always, "own");
    note({ what: "granted", ...itemOf(item), ...whoOf(caller), how: "own", ...(answered.client ? { client: answered.client, by: answered.by } : {}) });
  }
  // ("Always" for a conversation with neither a bot nor a project of its own is this once.)
  const allowed = always ? "always" : "once";
  note({ what: "allowed", ...itemOf(item), ...whoOf(caller), ...where, how: allowed, ...(answered.client ? { client: answered.client, by: answered.by } : {}) });
  return { ok: true, how: allowed };
}

/** A fill refused because the page isn't one of the item's sites: the strongest sign a page is
 * steering the agent. That bot's use of the vault (or that conversation's, when it isn't a bot's)
 * pauses until you look. */
export function tripwire(item: VaultItem, caller: Caller, site: string): string {
  const why = `It tried to use “${item.name}” on ${site}, which isn't one of its sites.`;
  const who = caller.bot ?? caller.root ?? caller.session;
  if (who) setPaused(true, who, why);
  note({ what: "refused", ...itemOf(item), ...whoOf(caller), site, how: "wrong site" });
  try {
    // (A seat's opens its group chat: no one opens the seat.)
    tell({ title: caller.botName ? `${caller.botName} paused` : "A fill was refused", subtitle: machineName(), body: why, category: "message", thread: caller.group ?? caller.root ?? "vault", data: caller.group ? { group: caller.group } : caller.root ? { session: caller.root } : {} });
  } catch {}
  return `${why} Kuvo Code only fills it on ${item.sites.join(", ")}.${who ? ` The user has been told, and this ${caller.bot ? "bot" : "conversation"}'s use of the vault is paused until they look.` : ""}`;
}

/** Notes a use that went ahead. */
export const noteUse = (item: VaultItem, caller: Caller, use: Omit<Use, "signal" | "askWithout">, how: string) =>
  note({ what: "used", ...itemOf(item), ...whoOf(caller), ...(use.site ? { site: use.site } : {}), ...(use.program ? { program: use.program } : {}), ...(use.why ? { why: use.why } : {}), how });
