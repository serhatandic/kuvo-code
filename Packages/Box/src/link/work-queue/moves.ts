// A move's part of the Work Queue (PROTOCOL.md, "kuvo/moves", "The Work Queue"): the queues of the
// conversations a move carries go with them, items and files, under the same owner keys and
// numbers, and are gone from the box they left once the move is over. A conversation carried on as
// another here (a chat changed to Codex) takes its queue along.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { categories, keepCategory } from "./categories";
import { categoryNamed } from "./categories";
import { changeQueues, FILE_NAME, filesOf, itemOf, KEPT_OWNER, OWNER, readQueueSettingAside, type Item } from "./store";

/** What a move carries: each owner's items, the custom categories they're in, and which items
 * have files (packed beside `move.json`, in `work-queue/<item>/`). */
export interface CarriedQueues {
  items: Item[];
  categories: { id: string; name: string }[];
  withFiles: string[];
}

/** The queues of `owners`, as a move carries them; null for none. */
export function packWorkQueues(owners: readonly string[]): CarriedQueues | null {
  const items = owners.filter(owner => KEPT_OWNER.test(owner)).flatMap(owner => readQueueSettingAside(owner).items);
  if (!items.length) return null;
  const used = new Set(items.map(item => item.category));
  return {
    items,
    categories: categories().filter(each => !each.builtIn && used.has(each.id)).map(({ id, name }) => ({ id, name })),
    withFiles: items.filter(item => item.files.length && fs.existsSync(filesOf(item.id))).map(item => item.id),
  };
}

/** The files of what's carried, copied into `staging/work-queue`, for the bundle. */
export function stageFiles(carried: CarriedQueues | undefined, staging: string): boolean {
  if (!carried?.withFiles.length) return false;
  for (const id of carried.withFiles) fs.cpSync(filesOf(id), path.join(staging, "work-queue", id), { recursive: true });
  return true;
}

/** The bytes the carried files come to. */
export const filesSize = (carried: CarriedQueues | undefined): number => (carried?.withFiles ?? []).reduce((sum, id) => {
  try {
    return sum + fs.readdirSync(filesOf(id)).reduce((each, name) => each + fs.statSync(path.join(filesOf(id), name)).size, 0);
  } catch {
    return sum;
  }
}, 0);

/** What came with a move put in place: the items of `owners` it brought (any other owner's left
 * out, and each checked as one read from this box's own files), their files from
 * `opened/work-queue`, and the custom categories they're in (Next for one this box can't keep). */
export function placeWorkQueues(carried: unknown, owners: readonly string[], opened: string | null): void {
  if (!isObject(carried) || !Array.isArray(carried.items)) return;
  const allowed = new Set(owners);
  const items = carried.items.flatMap(each => (isObject(each) && typeof each.owner === "string" && allowed.has(each.owner) ? [itemOf(each, each.owner)] : [])).filter((each): each is Item => each !== null);
  if (!items.length) return;
  for (const each of Array.isArray(carried.categories) ? carried.categories : []) if (isObject(each) && typeof each.id === "string" && typeof each.name === "string") keepCategory(each.id, each.name);
  for (const item of items) if (!categoryNamed(item.category)) item.category = "next";
  changeQueues(book => {
    for (const item of items) {
      const before = book.find({ id: item.id });
      if (before) book.queue(before.owner).items = book.queue(before.owner).items.filter(each => each.id !== item.id);
      book.queue(item.owner).items.push(item);
      const from = opened ? path.join(opened, "work-queue", item.id) : null;
      fs.rmSync(filesOf(item.id), { recursive: true, force: true });
      for (const file of item.files) {
        if (!from || !FILE_NAME.test(file.name)) continue;
        try {
          fs.mkdirSync(filesOf(item.id), { recursive: true, mode: 0o700 });
          // (Never through a link: `unpack` took only plain files, and this is opened as one.)
          const handle = fs.openSync(path.join(from, file.name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
          try {
            if (fs.fstatSync(handle).isFile()) fs.writeFileSync(path.join(filesOf(item.id), file.name), fs.readFileSync(handle), { mode: 0o600 });
          } finally {
            fs.closeSync(handle);
          }
        } catch {}
      }
    }
  }, undefined, { onItsOwn: true });
}

/** The queues of `owners` gone from here (their files too): the move took them (nothing changes
 * them while it's under way, `refuseMoving`), or a copy that came is taken back. */
export function forgetWorkQueues(owners: readonly string[]): void {
  const gone = new Set(owners);
  changeQueues(book => {
    for (const owner of gone) {
      if (!KEPT_OWNER.test(owner)) continue;
      const queue = book.queue(owner);
      for (const item of queue.items) fs.rmSync(filesOf(item.id), { recursive: true, force: true });
      queue.items = [];
    }
  }, undefined, { onItsOwn: true });
}

/** A conversation carried on as another here: its queue, and its links, under the new one. */
export function carryWorkQueue(from: string, to: string): void {
  if (!OWNER.test(from) || !OWNER.test(to) || from === to) return;
  changeQueues(book => {
    for (const item of [...book.queue(from).items]) book.give(item, to);
    for (const item of book.items()) {
      for (const link of item.sessions) if (link.session === from) link.session = to;
      if (item.handedBy === from) item.handedBy = to;
    }
  }, undefined, { onItsOwn: true });
}
