// The Work Queue's categories (PROTOCOL.md, "The Work Queue", "Categories"): one set for every
// queue. Next, Later, Parked and Done are built in; custom ones sit between Later and Parked, in the
// order given. In progress isn't one: the box works it out from the sessions at work on an item.
// Kept in `run/work-queue/categories.json`.

import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { locked, textOf, writePrivate } from "../files";
import { WORK_QUEUE } from "./store";

export const CATEGORIES_FILE = path.join(WORK_QUEUE, "categories.json");
const LOCK = path.join(WORK_QUEUE, ".categories.lock");
const MOST_CUSTOM = 30;
const MOST_NAME = 40;

export interface Category { id: string; name: string; builtIn: boolean }

export const BUILT_IN: readonly Category[] = [
  { id: "next", name: "Next", builtIn: true },
  { id: "later", name: "Later", builtIn: true },
  { id: "parked", name: "Parked", builtIn: true },
  { id: "done", name: "Done", builtIn: true },
];
const CUSTOM_ID = /^cat_[a-z0-9-]{1,40}$/;

// The custom ones, as they're kept, in order.
function readCustom(): Category[] {
  try {
    const kept = JSON.parse(textOf(CATEGORIES_FILE) ?? "null");
    return (isObject(kept) && Array.isArray(kept.custom) ? kept.custom : [])
      .filter((each: unknown): each is { id: string; name: string } => isObject(each) && typeof each.id === "string" && CUSTOM_ID.test(each.id) && typeof each.name === "string")
      .map(({ id, name }: { id: string; name: string }) => ({ id, name, builtIn: false }));
  } catch {
    return [];
  }
}

/** Every category, in the order clients show them: Next, Later, the custom ones, Parked, Done. */
export function categories(): Category[] {
  return [BUILT_IN[0], BUILT_IN[1], ...readCustom(), BUILT_IN[2], BUILT_IN[3]];
}

/** The category `given` names (its id or its name, any case), or null for none. */
export function categoryNamed(given: unknown): Category | null {
  if (typeof given !== "string" || !given.trim()) return null;
  const wanted = given.trim().toLowerCase().replace(/^in[ -]?progress$/, "in progress");
  return categories().find(each => each.id === wanted || each.name.toLowerCase() === wanted) ?? null;
}

const slugOf = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** What a change says: done (with the categories now), or why not. */
export type CategoryOutcome = { done: Category } | { refused: string };

const change = (work: (custom: Category[]) => CategoryOutcome): CategoryOutcome => locked(LOCK, () => {
  const custom = readCustom();
  const outcome = work(custom);
  if ("done" in outcome) writePrivate(CATEGORIES_FILE, JSON.stringify({ custom: custom.map(({ id, name }) => ({ id, name })) }));
  return outcome;
});

/** A custom category added, after the one `after` names (else after the other custom ones). */
export function addCategory(name: unknown, after?: unknown): CategoryOutcome {
  const named = plainName(name).slice(0, MOST_NAME);
  if (!named) return { refused: "Say what it's called (add)." };
  if (/^in[ -]?progress$/i.test(named)) return { refused: "In progress isn't a category: an item is in progress while a session linked to it is at work." };
  if (categoryNamed(named)) return { refused: `There's a category called ${named} already.` };
  const slug = slugOf(named);
  if (!slug) return { refused: `${named} can't be a category's name: use letters or numbers.` };
  return change(custom => {
    if (custom.length >= MOST_CUSTOM) return { refused: `There are ${MOST_CUSTOM} custom categories already: remove one first.` };
    let id = `cat_${slug}`;
    for (let n = 2; custom.some(each => each.id === id); n++) id = `cat_${slug.slice(0, 36)}-${n}`;
    const made = { id, name: named, builtIn: false };
    let place = custom.length;
    if (typeof after === "string" && after.trim()) {
      const beside = categoryNamed(after);
      if (beside && (beside.id === "next" || beside.id === "later")) place = 0;
      else if (beside && !beside.builtIn) place = custom.findIndex(each => each.id === beside.id) + 1;
      else return { refused: `${after} isn't Later or a custom category: new ones go between Later and Parked.` };
    }
    custom.splice(place, 0, made);
    return { done: made };
  });
}

/** A custom category renamed. */
export function renameCategory(which: unknown, to: unknown): CategoryOutcome {
  const found = categoryNamed(which);
  if (!found) return { refused: `There's no category ${String(which ?? "")}.` };
  if (found.builtIn) return { refused: `${found.name} is built in: it keeps its name.` };
  const named = plainName(to).slice(0, MOST_NAME);
  if (!named) return { refused: "Say its new name (to)." };
  const taken = categoryNamed(named);
  if (taken && taken.id !== found.id) return { refused: `There's a category called ${named} already.` };
  return change(custom => {
    const kept = custom.find(each => each.id === found.id);
    if (!kept) return { refused: `There's no category ${found.name}.` };
    kept.name = named;
    return { done: kept };
  });
}

/** A custom category removed, once nothing is in it (`used`: how many items are). */
export function removeCategory(which: unknown, used: (id: string) => number): CategoryOutcome {
  const found = categoryNamed(which);
  if (!found) return { refused: `There's no category ${String(which ?? "")}.` };
  if (found.builtIn) return { refused: `${found.name} is built in: it can't be removed.` };
  const count = used(found.id);
  if (count) return { refused: `${found.name} still has ${count} item${count === 1 ? "" : "s"} in it: move ${count === 1 ? "it" : "them"} first.` };
  return change(custom => {
    const index = custom.findIndex(each => each.id === found.id);
    if (index < 0) return { refused: `There's no category ${found.name}.` };
    custom.splice(index, 1);
    return { done: found };
  });
}

/** One a hand-off or a move brought that this box doesn't have yet: added under its own id. */
export function keepCategory(id: string, name: string): void {
  if (!CUSTOM_ID.test(id) || readCustom().some(each => each.id === id)) return;
  change(custom => {
    if (custom.some(each => each.id === id) || custom.length >= MOST_CUSTOM) return { refused: "" };
    const made = { id, name: plainName(name).slice(0, MOST_NAME) || id.slice(4), builtIn: false };
    custom.push(made);
    return { done: made };
  });
}
