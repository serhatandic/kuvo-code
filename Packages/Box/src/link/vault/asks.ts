// What agents ask you for from the vault: to use an item they may only use by asking (`use`), or an
// item they need and haven't got (`item`). Each waits for your answer, from any client (a card on
// the Mac, the phone's sheet), up to 15 minutes; your phones hear of one still open after a moment.

import { oneLine } from "../../shared/text";
import type { VaultAsk } from "../../shared/routes/vault";
import { askBook, PATIENCE } from "../notices/asking";
import type { Notice } from "../notices/notice";

export { PATIENCE };

/** Your answer: once, always (a grant for that bot, or that project), or no; for an `item` ask, the item you gave. */
export interface AskAnswer {
  answer: "once" | "always" | "no";
  item?: string;
  /** Who answered: "Mac", or a phone's name; and who that is, for activity (areas/vault.ts). */
  client?: string;
  by?: string;
}

const book = askBook<VaultAsk, AskAnswer>("q_", { answer: "no" });

/** Hears each change to what's asked; gives back how to stop hearing. */
export const onAsksChanged = book.onChanged;

/** What's asked now, oldest first. */
export const listAsks = book.list;

/** Asks you; the answer comes when a client gives it, or "no" after `PATIENCE` (or when `signal`
 * says the agent stopped waiting). */
export function ask(what: Omit<VaultAsk, "id" | "at">, signal?: AbortSignal, patience = PATIENCE): Promise<AskAnswer> {
  const asked = { ...what };
  if (asked.why) asked.why = oneLine(asked.why, 300);
  if (asked.need) asked.need = oneLine(asked.need, 300);
  return book.ask(asked, signal, patience);
}

/** A client's answer to `id`: false for one that isn't asked (any more). */
export const answer = book.answer;

/** The notification for an ask, as the Mac words it. */
export function vaultAskNotice(asked: VaultAsk): Notice {
  const who = asked.botName ?? asked.sessionName ?? "An agent";
  const title = asked.kind === "use" ? `${who} wants to use ${asked.itemName ?? "an item"}` : `${who} needs ${asked.need ?? "something from your vault"}`;
  return {
    title,
    subtitle: asked.machine,
    body: asked.why || (asked.kind === "use" ? (asked.group ? "Allow it once, or say no." : "Allow it once, always, or say no.") : "Give it an item from your vault, or say no."),
    category: "ask",
    thread: asked.group ?? asked.session ?? asked.id,
    // (A seat's opens its group chat: no one opens the seat.)
    data: { ...(asked.group ? { group: asked.group } : asked.session ? { session: asked.session } : {}), vaultAsk: asked.id },
  };
}

/** Your phones hear of each ask still open a moment after it's made (one answered at once on a
 * Mac never buzzes them); `answered` hears of one told that's no longer asked. */
export function watchVaultAsks(tell: (notice: Notice) => boolean, answered: (id: string) => void = () => {}, after = 2000): () => void {
  return book.watch(vaultAskNotice, tell, answered, after);
}
