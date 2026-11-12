// What you do to an item from a client, on the box that keeps it (PROTOCOL.md, "The Work Queue"):
// read it whole, delete it, bring it back, or move it. The same whether your client asked this box
// (`kuvo/work-queue/items/…`) or another of your computers' boxes handed it on (`forward.ts`).

import fs from "node:fs";
import path from "node:path";
import { ownName } from "../letters/start";
import { callOffHanding, MOST_HANDED_FILES, refuseLiveElsewhere } from "./hand";
import { readSeen } from "./github";
import { numberWaiting, primaryOf } from "./numbers";
import { changeItem, refuseHanding, refuseMoving, removeItem, restoreItem } from "./ops";
import { allItems, changeQueues, FILE_NAME, filesOf, matching, Refusal, type Book, type Item, type ItemRef } from "./store";
import { tellQueuesAgain } from "./across";
import { factsOf, ownersOf, refOf, summaryOf, wholeOf } from "./view";
import type { Act, Acted } from "./forward";
import type { Target } from "../../shared/records";

/** How long a client's ask waits for GitHub to say what its issues and pull requests are now (a
 * read that takes longer goes on, for the next ask or the view's next line). */
export const GITHUB_WAIT = 3_000;

const YOU = { user: true } as const;
// An item a client named that isn't here.
class Missing extends Refusal {}

// What a client's own change says: the item as it is now, or why not.
function changed(work: () => Item): Acted {
  try {
    const item = work();
    // Your other computers hear of it at their next round, not after the usual wait.
    tellQueuesAgain();
    return { status: 200, value: { item: summaryOf(item, new Set(), new Map()) } };
  } catch (error) {
    if (error instanceof Refusal) return { status: error instanceof Missing ? 404 : 400, value: { message: error.message } };
    throw error;
  }
}

/** What a client does to an item this box keeps (`ref`), as the route answers it: read whole, delete,
 * bring back or move (`given`, where to). */
export async function actHere({ method, action, ref, given = {}, targets, signal }: { method: Act["method"]; action?: "move" | "restore"; ref: ItemRef; given?: Record<string, unknown>; targets: Target[]; signal?: AbortSignal | null }): Promise<Acted> {
  const find = (items: Item[]) => matching(items, ref)[0] ?? null;
  if (method === "GET") {
    const item = find(allItems());
    if (!item) return { status: 404, value: { message: "There's no such item." } };
    const facts = await factsOf(targets, signal ?? undefined);
    await readSeen([item], GITHUB_WAIT);
    const { titles } = await ownersOf(item.owner, [item], facts, targets);
    return { status: 200, value: { item: wholeOf(item, facts.working, titles) } };
  }
  const now = Date.now();
  const primary = primaryOf();
  const inBook = (work: (item: Item, book: Book) => void, { handing = false } = {}) => () => changeQueues(book => {
    const item = find(book.items());
    if (!item) throw new Missing("There's no item like that.");
    refuseMoving([item.owner]);
    if (!handing) refuseHanding(item);
    work(item, book);
    numberWaiting(book, primary, null);
    return item;
  });
  // (Deleting one on its way to another computer calls its hand-off off: one stuck going to a
  // computer that doesn't answer is yours to let go of.)
  if (method === "DELETE") {
    return changed(inBook(item => {
      if (item.removed) throw new Refusal("It's deleted already.");
      callOffHanding(item, YOU, now);
      removeItem(item, YOU, now);
    }, { handing: true }));
  }
  if (action === "restore") {
    return changed(inBook((item, book) => {
      if (!item.removed) throw new Refusal("It isn't deleted.");
      refuseLiveElsewhere(item);
      restoreItem(book, item, YOU, now);
    }));
  }
  return changed(inBook((item, book) => {
    if (item.removed) throw new Refusal("It's deleted: bring it back first.");
    // (Only where it goes: what it says is the agents' to change.)
    const { category, before, after, top } = given;
    if ([before, after].some(each => each !== undefined && refOf(each) === null)) throw new Refusal("There's no item like that to put it beside.");
    changeItem(book, item, { category, before, after, top }, { who: YOU, now, fileOps: [] });
  }));
}

/** The bytes of a file kept with an item here, by its name, or null when there's no such file. */
export function fileOf(ref: ItemRef, name: string): { type: string; bytes: Buffer } | null {
  const item = matching(allItems(), ref)[0];
  const kept = item?.files.find(each => each.name === name);
  if (!item || !kept || !FILE_NAME.test(name)) return null;
  try {
    return { type: kept.type, bytes: fs.readFileSync(path.join(filesOf(item.id), name)) };
  } catch {
    return null;
  }
}

/** What another of your computers' boxes asked this one to do for its client, to an item kept here
 * (`forward.ts`): done as this box's own client's, and answered as the route would; a file's bytes
 * in base64 (`{type, data}`), up to a few MB. One that isn't here (it moved on meanwhile) isn't
 * handed on again. */
export function actForPeer(act: Act, targets: Target[]): Promise<Acted> {
  const ref = refOf(act.item);
  if (!ref) return Promise.resolve({ status: 404, value: { message: "There's no such item." } });
  if (act.action === "file") {
    const file = fileOf(ref, act.name ?? "");
    if (!file) return Promise.resolve({ status: 404, value: { message: "There's no such file." } });
    if (file.bytes.length > MOST_FORWARDED_FILE) return Promise.resolve({ status: 413, value: { message: `${act.name} is ${Math.round(file.bytes.length / 1_000_000)} MB: too big to bring from ${ownName()} (${Math.round(MOST_FORWARDED_FILE / 1_000_000)} MB at most). Open it there.` } });
    return Promise.resolve({ status: 200, value: { type: file.type, data: file.bytes.toString("base64") } });
  }
  return actHere({ method: act.method, action: act.action, ref, given: act.body ?? {}, targets });
}

/** The most of a file's bytes another of your computers' boxes is given for its client (as an item
 * handed on takes). */
export const MOST_FORWARDED_FILE = MOST_HANDED_FILES;
