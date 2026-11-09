// Importing an old backlog into the Work Queue (PROTOCOL.md, "The Work Queue", "Import"), keeping
// its numbers: an agent's items, as it read them from its files (`queue_import`), or Markdown files
// on the box read with plain rules (`POST kuvo/work-queue/import`). Either way each number is
// claimed from the primary; an item waits without one until it's granted.

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { categoryNamed } from "./categories";
import { claimNumbers, numberWaiting, type Primary } from "./numbers";
import { MOST_BODY, MOST_TITLE, newItemID, placeIn, type Book, type Item, type Who } from "./store";

/** An item to import: its number, title, body and category id. */
export interface Imported { number: number; title: string; body: string; category: string }

/** What an import did: how many came into each category, and what it left out, in words. */
export interface ImportOutcome {
  added: number;
  byCategory: Record<string, number>;
  skipped: string[];
  waiting: number;
  /** Those whose number was another item's here already, with the one they have now. */
  renumbered: string[];
}

const MOST_SKIPPED_SAID = 40;

/** The first sentence of `text`, a title's length at most. */
export function titleOf(text: string): string {
  const plain = plainName(text.replace(/\*\*/g, "").replace(/`/g, ""));
  const sentence = plain.match(/^(.{8,}?[.!?])(\s|$)/)?.[1] ?? plain;
  return sentence.length <= 120 ? sentence : sentence.slice(0, 119).replace(/\s+\S*$/, "") + "…";
}

// The category a heading's words give, if any.
function categoryOfHeading(heading: string): string | null {
  const words = heading.toLowerCase();
  if (/\b(done|finished|completed)\b/.test(words)) return "done";
  if (/\b(shelved|parked)\b/.test(words)) return "parked";
  if (/\b(later|ideas?|someday)\b/.test(words)) return "later";
  const custom = categoryNamed(heading.trim());
  return custom ? custom.id : null;
}

/** Markdown files' items, by the import's plain rules: a list line starting with `#N` is one (its
 * mark `[x]` makes it Done), in the category of the nearest heading above it that names one, else
 * Next; a line like `LATER: #3 #4` sets those items' category; the first line naming a number
 * gives its title, and every line naming it, in any file, its body. */
export function parseBacklog(texts: string[]): { items: Imported[]; skipped: string[] } {
  const found = new Map<number, { title: string; lines: string[]; category: string }>();
  const set = new Map<number, string>();
  const skipped: string[] = [];
  for (const text of texts) {
    const headings: { level: number; text: string }[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
        headings.push({ level, text: heading[2] });
        continue;
      }
      const sorted = line.match(/^\s*(?:[-*]\s+)?(NOW|NEXT|LATER|PARKED|DONE)\b[^:]{0,80}:\s*(.*)$/);
      if (sorted && /#\d/.test(sorted[2])) {
        const category = sorted[1] === "NOW" ? "next" : sorted[1].toLowerCase();
        for (const ref of sorted[2].matchAll(/(?:^|[\s,(])#(\d{1,6})(?![\w])/g)) set.set(Number(ref[1]), category);
        continue;
      }
      const listed = line.match(/^\s*[-*]\s+(.*)$/);
      if (!listed) continue;
      const item = listed[1].match(/^#(\d{1,6})(?![\w])((?:\s*[/–,-]+\s*#\d{1,6}(?![\w]))*)\s*(\[[ x~]\])?\s*(.*)$/i);
      if (!item) continue;
      const number = Number(item[1]);
      for (const other of item[2].matchAll(/#(\d{1,6})/g)) skipped.push(`#${other[1]} (named with #${number} on one line)`);
      const rest = item[4].trim();
      const done = item[3]?.toLowerCase() === "[x]";
      const kept = found.get(number);
      if (kept) {
        kept.lines.push(listed[1]);
        continue;
      }
      let category = "next";
      for (const each of [...headings].reverse()) {
        const named = categoryOfHeading(each.text);
        if (named) {
          category = named;
          break;
        }
      }
      if (done) category = "done";
      found.set(number, { title: titleOf(rest) || `Item ${number}`, lines: [listed[1]], category });
    }
  }
  for (const [number, category] of set) {
    const kept = found.get(number);
    if (kept && kept.category !== "done") kept.category = category;
  }
  // Numbers named in a list line that no line starts with: said, never lost silently.
  for (const text of texts) {
    for (const raw of text.split("\n")) {
      if (!/^\s*[-*]\s+/.test(raw)) continue;
      for (const ref of raw.matchAll(/(?:^|[\s,(/–-])#(\d{1,6})(?![\w])/g)) {
        const number = Number(ref[1]);
        if (!found.has(number) && !skipped.some(each => each.startsWith(`#${number} `))) skipped.push(`#${number} (named, but no line starts with it)`);
      }
    }
  }
  const items = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([number, kept]) => ({ number, title: kept.title, body: kept.lines.join("\n\n").slice(0, MOST_BODY), category: kept.category }));
  return { items, skipped: [...new Set(skipped)] };
}

/** Markdown files on this box, read for an import. */
export function readBacklogFiles(files: unknown): { texts: string[] } | { refused: string } {
  const named = (Array.isArray(files) ? files : [files]).filter((each): each is string => typeof each === "string" && each.trim() !== "");
  if (!named.length) return { refused: "Name the files to import (files), as full paths." };
  const texts: string[] = [];
  for (const file of named.slice(0, 10)) {
    try {
      const kind = fs.statSync(file);
      if (!kind.isFile() || kind.size > 20_000_000) return { refused: `${file} isn't a Markdown file to import.` };
      texts.push(fs.readFileSync(file, "utf8"));
    } catch {
      return { refused: `${file} can't be read.` };
    }
  }
  return { texts };
}

/** Items an agent gave `queue_import`, checked: those that are, and why the rest aren't. */
export function givenItems(given: unknown): { items: Imported[]; skipped: string[] } | { refused: string } {
  if (!Array.isArray(given) || !given.length) return { refused: "Give the items (items), each with its number and title." };
  if (given.length > 200) return { refused: "At most 200 items a call: import the rest in another." };
  const items: Imported[] = [];
  const skipped: string[] = [];
  for (const each of given) {
    const number = isObject(each) && typeof each.number === "number" && Number.isInteger(each.number) && each.number > 0 && each.number < 10_000_000 ? each.number : null;
    const title = isObject(each) ? plainName(each.title).slice(0, MOST_TITLE) : "";
    if (number === null || !title) {
      skipped.push(isObject(each) && each.number !== undefined ? `#${String(each.number)} (it needs a whole number and a title)` : "an item with no number");
      continue;
    }
    const category = isObject(each) && each.done === true ? "done" : isObject(each) && each.category !== undefined ? categoryNamed(each.category)?.id : "next";
    if (!category) {
      skipped.push(`#${number} (there's no category ${String((each as Record<string, unknown>).category)})`);
      continue;
    }
    const body = isObject(each) && typeof each.body === "string" ? each.body.slice(0, MOST_BODY) : "";
    items.push({ number, title, body, category });
  }
  return { items, skipped };
}

/** `items` put in `owner`'s queue with their numbers claimed. One here already under its number
 * and title was imported before, and is skipped; a number this box gave something else gets a new
 * one (with a note); on the primary, so does one it can't grant. */
export function importItems(book: Book, owner: string, items: Imported[], who: Who, primary: Primary, now = Date.now()): ImportOutcome {
  const have = new Map(book.items().flatMap(item => [item.number, item.wanted].filter((n): n is number => n !== undefined).map(n => [n, item.title] as const)));
  const outcome: ImportOutcome = { added: 0, byCategory: {}, skipped: [], waiting: 0, renumbered: [] };
  const made: Item[] = [];
  const fresh: { from: number; item: Item }[] = [];
  for (const each of items) {
    const taken = have.get(each.number);
    if (taken !== undefined && taken.toLowerCase() === each.title.toLowerCase()) {
      outcome.skipped.push(`#${each.number} (already in the Work Queue here)`);
      continue;
    }
    if (taken === undefined) have.set(each.number, each.title);
    const item: Item = {
      id: newItemID(),
      owner,
      ...(taken === undefined ? { wanted: each.number } : {}),
      title: each.title,
      body: each.body,
      category: each.category,
      order: placeIn(book.items(), each.category),
      notes: taken === undefined ? [] : [{ at: now, by: { user: true }, text: `Imported as #${each.number}, a number already given to another item here, so it has a new one.` }],
      files: [],
      links: [],
      sessions: [],
      created: { at: now, by: who },
      updated: { at: now, by: who },
      ...(each.category === "done" ? { doneAt: now } : {}),
    };
    book.queue(owner).items.push(item);
    if (taken === undefined) made.push(item);
    else fresh.push({ from: each.number, item });
    outcome.added++;
    outcome.byCategory[each.category] = (outcome.byCategory[each.category] ?? 0) + 1;
  }
  const { granted } = claimNumbers(primary, made.map(item => item.wanted!));
  numberWaiting(book, primary, granted, { now });
  outcome.waiting = made.filter(item => item.number === undefined).length;
  outcome.renumbered = fresh.map(({ from, item }) => (item.number !== undefined ? `#${from} is #${item.number}` : `#${from} waits for a new number`));
  outcome.skipped = outcome.skipped.slice(0, MOST_SKIPPED_SAID);
  return outcome;
}

/** An import's outcome, in words. */
export function importWords(outcome: ImportOutcome, skipped: string[], names: (id: string) => string): string {
  const parts = Object.entries(outcome.byCategory).map(([category, count]) => `${count} in ${names(category)}`);
  const all = [...skipped, ...outcome.skipped];
  return [
    outcome.added ? `Imported ${outcome.added} item${outcome.added === 1 ? "" : "s"} with their numbers: ${parts.join(", ")}.` : "Nothing was imported.",
    outcome.waiting ? `${outcome.waiting} wait${outcome.waiting === 1 ? "s" : ""} for the primary computer to grant ${outcome.waiting === 1 ? "its number" : "their numbers"}; until then ${outcome.waiting === 1 ? "it shows" : "they show"} as new.` : "",
    outcome.renumbered.length ? `Imported with a new number, theirs being another item's here already: ${outcome.renumbered.join(", ")}.` : "",
    all.length ? `Left out (${all.length}): ${all.slice(0, MOST_SKIPPED_SAID).join("; ")}${all.length > MOST_SKIPPED_SAID ? "; …" : ""}.` : "",
  ].filter(Boolean).join(" ");
}
