// What agents ask you for from the vault: to use an item they may only use by asking (`use`), or an
// item they need and haven't got (`item`). Each waits for your answer, from any client (a card on
// the Mac, the phone's sheet), up to 15 minutes; your phones hear of one still open after a moment.

import { newID, oneLine } from "../../shared/text";
import type { VaultAsk } from "../../shared/routes/vault";
import type { Notice } from "../notices/notice";

/** How long an agent waits for you. */
export const PATIENCE = 15 * 60_000;

/** Your answer: once, always (a grant for that bot, or that project), or no; for an `item` ask, the item you gave. */
export interface AskAnswer {
  answer: "once" | "always" | "no";
  item?: string;
  /** Who answered: "Mac", or a phone's name. */
  client?: string;
}

interface Open {
  ask: VaultAsk;
  done: (answer: AskAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, Open>();
const listeners = new Set<() => void>();

const changed = () => {
  for (const listener of listeners) try { listener(); } catch {}
};

/** Hears each change to what's asked; gives back how to stop hearing. */
export function onAsksChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What's asked now, oldest first. */
export const listAsks = (): VaultAsk[] => [...open.values()].map(each => each.ask).sort((a, b) => a.at - b.at);

/** Asks you; the answer comes when a client gives it, or "no" after `PATIENCE` (or when `signal`
 * says the agent stopped waiting). */
export function ask(what: Omit<VaultAsk, "id" | "at">, signal?: AbortSignal, patience = PATIENCE): Promise<AskAnswer> {
  const asked: VaultAsk = { id: newID("q_"), at: Date.now(), ...what };
  if (asked.why) asked.why = oneLine(asked.why, 300);
  if (asked.need) asked.need = oneLine(asked.need, 300);
  return new Promise(resolve => {
    const finish = (answer: AskAnswer) => {
      const was = open.get(asked.id);
      if (!was) return;
      clearTimeout(was.timer);
      open.delete(asked.id);
      signal?.removeEventListener("abort", stopped);
      changed();
      resolve(answer);
    };
    const stopped = () => finish({ answer: "no" });
    if (signal?.aborted) return resolve({ answer: "no" });
    signal?.addEventListener("abort", stopped, { once: true });
    open.set(asked.id, { ask: asked, done: finish, timer: setTimeout(() => finish({ answer: "no" }), patience) });
    changed();
  });
}

/** A client's answer to `id`: false for one that isn't asked (any more). */
export function answer(id: string, given: AskAnswer): boolean {
  const found = open.get(id);
  if (!found) return false;
  found.done(given);
  return true;
}

/** The notification for an ask, as the Mac words it. */
export function vaultAskNotice(asked: VaultAsk): Notice {
  const who = asked.botName ?? asked.sessionName ?? "An agent";
  const title = asked.kind === "use" ? `${who} wants to use ${asked.itemName ?? "an item"}` : `${who} needs ${asked.need ?? "something from your vault"}`;
  return {
    title,
    subtitle: asked.machine,
    body: asked.why || (asked.kind === "use" ? "Allow it once, always, or say no." : "Give it an item from your vault, or say no."),
    category: "ask",
    thread: asked.session ?? asked.id,
    data: { ...(asked.session ? { session: asked.session } : {}), vaultAsk: asked.id },
  };
}

/** Your phones hear of each ask still open a moment after it's made (one answered at once on a Mac
 * never buzzes them); `answered` hears of one told that's no longer asked. */
export function watchVaultAsks(tell: (notice: Notice) => boolean, answered: (id: string) => void = () => {}, after = 2000): () => void {
  const told = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const look = () => {
    const now = new Set(listAsks().map(each => each.id));
    for (const id of [...told]) if (!now.has(id)) { told.delete(id); answered(id); }
    for (const [id, timer] of timers) if (!now.has(id)) { clearTimeout(timer); timers.delete(id); }
    for (const asked of listAsks()) {
      if (told.has(asked.id) || timers.has(asked.id)) continue;
      timers.set(asked.id, setTimeout(() => {
        timers.delete(asked.id);
        if (!open.has(asked.id)) return;
        if (tell(vaultAskNotice(asked))) told.add(asked.id);
      }, after));
    }
  };
  return onAsksChanged(look);
}
