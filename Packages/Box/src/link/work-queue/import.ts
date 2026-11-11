// Importing an old backlog into the Work Queue (PROTOCOL.md, "The Work Queue", "Import"), keeping
// its numbers: an agent's items, as it read them from its files (`queue_import`), or Markdown files
// on the box read with plain rules (`POST kuvo/work-queue/import`). Either way each number is
// claimed from the primary; an item waits without one until it's granted.

import fs from "node:fs";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { categoryNamed } from "./categories";
import { claimNumbers, inRanges, MOST_NUMBER, numberWaiting, rangesOf, readNumbers, type Primary } from "./numbers";
import { readTold, toldKeys } from "./told";
import { MOST_BODY, MOST_TITLE, newItemID, placeIn, type Book, type Item, type Who } from "./store";

/** An item to import: its number, title, body and category id. */
export interface Imported { number: number; title: string; body: string; category: string }

/** What an import did: how many came into each category, and what it left out, in words. */
export interface ImportOutcome {
  added: number;
  byCategory: Record<string, number>;
  skipped: string[];
  /** Numbers skipped as in the queue already (or imported before). */
  already: number[];
  waiting: number;
  /** Those whose number was another item's or was refused, with the one they have now. */
  renumbered: string[];
  /** Those imported before and renumbered, given their own number back now, and those that wait
   * for the primary to give it. */
  restored: string[];
  restoring: string[];
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
    const number = isObject(each) && typeof each.number === "number" && Number.isInteger(each.number) && each.number > 0 && each.number < MOST_NUMBER ? each.number : null;
    const title = isObject(each) ? plainName(each.title).slice(0, MOST_TITLE) : "";
    if (number === null || !title) {
      skipped.push(isObject(each) && each.number !== undefined ? `#${String(each.number)} (it needs a whole number of six digits at most, and a title)` : "an item with no number");
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

/** `items` put in `owner`'s queue, each keeping its own number wherever no other item has it: the
 * numbers are claimed from the primary (granted at once on the primary itself). One here already
 * under its number and title (or waiting for that number) was imported before, and is skipped. One
 * an import before renumbered (`importedAs`) under the same title asks for its own number back,
 * where no other item has it (an item that's itself on its way back to its own doesn't count): this
 * is how a backlog imported again repairs what went wrong. One whose number is another item's, here
 * or on another of your computers, gets a new one (with a note), as does one the primary refuses. */
export function importItems(book: Book, owner: string, items: Imported[], who: Who, primary: Primary, now = Date.now()): ImportOutcome {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Who holds each number here: the item numbered so, or one waiting for it (an import's, or one
  // asking for its own back).
  const holders = new Map<number, Item[]>();
  const hold = (n: number, item: Item) => holders.set(n, [...(holders.get(n) ?? []), item]);
  for (const item of book.items()) {
    if (item.number !== undefined) hold(item.number, item);
    if (item.wanted !== undefined) hold(item.wanted, item);
  }
  const elsewhere = numbersElsewhere();
  // (Numbers this box gave items that are gone from it: moved to another computer, or deleted.)
  const used = readNumbers().used ?? [];
  const gone = (n: number, here: Item[]) => !here.length && inRanges(used, n);
  const outcome: ImportOutcome = { added: 0, byCategory: {}, skipped: [], already: [], waiting: 0, renumbered: [], restored: [], restoring: [] };
  const made: Item[] = [];
  const fresh: { from: number; item: Item }[] = [];
  const back: { from: number; item: Item }[] = [];
  for (const each of items) {
    const here = holders.get(each.number) ?? [];
    // Imported before and renumbered: the same again isn't made twice.
    const earlier = book.items().find(item => item.importedAs === each.number && same(item.title, each.title));
    if (here.some(item => same(item.title, each.title)) || (earlier && (earlier.removed || earlier.number === undefined || earlier.wanted !== undefined))) {
      outcome.already.push(each.number);
      continue;
    }
    if (earlier?.stays) {
      outcome.skipped.push(`#${each.number} (imported before as #${earlier.number}; its own number couldn't be given back)`);
      continue;
    }
    const far = elsewhere.get(each.number);
    if (far !== undefined && same(far, each.title)) {
      outcome.skipped.push(`#${each.number} (already in the Work Queue on another of your computers)`);
      continue;
    }
    // Its own number asked for again.
    if (earlier) {
      // (An item holding it that's on its way back to its own lets it go.)
      const kept = here.filter(item => !(item.number === each.number && item.wanted !== undefined && item.wanted !== each.number));
      if (kept.length || far !== undefined || gone(each.number, here)) {
        outcome.skipped.push(`#${each.number} (imported before as #${earlier.number}; #${each.number} is another item's${kept.length ? " here" : far !== undefined ? " on another of your computers" : ", one no longer here"})`);
        continue;
      }
      earlier.wanted = each.number;
      hold(each.number, earlier);
      back.push({ from: earlier.number!, item: earlier });
      continue;
    }
    const taken = here.length > 0 || far !== undefined || gone(each.number, here);
    const item: Item = {
      id: newItemID(),
      owner,
      ...(taken ? { importedAs: each.number } : { wanted: each.number }),
      title: each.title,
      body: each.body,
      category: each.category,
      order: placeIn(book.items(), each.category),
      notes: taken ? [{ at: now, by: { user: true }, text: `Imported as #${each.number}, a number already given to another item${here.length ? " here" : far !== undefined ? " on another of your computers" : ", one no longer here"}, so it has a new one.` }] : [],
      files: [],
      links: [],
      sessions: [],
      created: { at: now, by: who },
      updated: { at: now, by: who },
      ...(each.category === "done" ? { doneAt: now } : {}),
    };
    book.queue(owner).items.push(item);
    if (taken) fresh.push({ from: each.number, item });
    else {
      hold(each.number, item);
      made.push(item);
    }
    outcome.added++;
    outcome.byCategory[each.category] = (outcome.byCategory[each.category] ?? 0) + 1;
  }
  const restores = back.map(({ item }) => item.wanted!);
  const claimed = [...made.map(item => item.wanted!), ...restores];
  const { granted } = claimNumbers(primary, claimed, { restores });
  numberWaiting(book, primary, granted ? { granted, claimed: rangesOf(claimed) } : null, { now });
  outcome.waiting = made.filter(item => item.number === undefined).length;
  // Those the primary refused at once (on the primary itself), and those whose number another had.
  const refused = made.filter(item => item.importedAs !== undefined).map(item => ({ from: item.importedAs!, item }));
  outcome.renumbered = [...fresh, ...refused].sort((a, b) => a.from - b.from).map(({ from, item }) => (item.number !== undefined ? `#${from} is #${item.number}` : `#${from} waits for a new number`));
  for (const { from, item } of back) {
    if (item.wanted !== undefined) outcome.restoring.push(`#${from} (for #${item.wanted}${item.backGranted ? ", given: once the item that has it moves to its own" : ""})`);
    else if (item.importedAs === undefined) outcome.restored.push(`#${from} is #${item.number} again`);
    else outcome.renumbered.push(`#${item.importedAs} stays #${item.number}`);
  }
  outcome.skipped = outcome.skipped.slice(0, MOST_SKIPPED_SAID);
  return outcome;
}

// The numbers your other computers told this one their items have, with their titles.
function numbersElsewhere(): Map<number, string> {
  const found = new Map<number, string>();
  for (const key of toldKeys()) for (const item of readTold(key)?.items ?? []) if (item.number !== undefined && !item.source) found.set(item.number, item.title);
  return found;
}

/** Numbers as runs, in words: `#1–150, #201–300`. */
const runsWords = (numbers: number[]) => rangesOf(numbers).map(([from, to]) => (from === to ? `#${from}` : `#${from}–${to}`)).join(", ");

/** An import's outcome, in words. */
export function importWords(outcome: ImportOutcome, skipped: string[], names: (id: string) => string): string {
  const parts = Object.entries(outcome.byCategory).map(([category, count]) => `${count} in ${names(category)}`);
  const all = [...skipped, ...outcome.skipped];
  const left = all.length + outcome.already.length;
  const said = [...(outcome.already.length ? [`${runsWords(outcome.already)} (already in the Work Queue here)`] : []), ...all.slice(0, MOST_SKIPPED_SAID)];
  return [
    outcome.added ? `Imported ${outcome.added} item${outcome.added === 1 ? "" : "s"} with their numbers: ${parts.join(", ")}.` : outcome.restored.length || outcome.restoring.length ? "" : "Nothing was imported.",
    outcome.waiting ? `${outcome.waiting} wait${outcome.waiting === 1 ? "s" : ""} for the primary computer to grant ${outcome.waiting === 1 ? "its number" : "their numbers"}; until then ${outcome.waiting === 1 ? "it shows" : "they show"} as new.` : "",
    outcome.renumbered.length ? `Renumbered, as their own number is another item's or couldn't be kept (each has a note saying why): ${outcome.renumbered.join(", ")}.` : "",
    outcome.restored.length ? `Given their own numbers back, as imported before: ${outcome.restored.join(", ")}.` : "",
    outcome.restoring.length ? `${outcome.restoring.length} item${outcome.restoring.length === 1 ? "" : "s"} imported before ask${outcome.restoring.length === 1 ? "s" : ""} for ${outcome.restoring.length === 1 ? "its" : "their"} own number back, keeping the one ${outcome.restoring.length === 1 ? "it has" : "they have"} until then: ${outcome.restoring.join(", ")}.` : "",
    left ? `Left out (${left}): ${said.join("; ")}${all.length > MOST_SKIPPED_SAID ? "; …" : ""}.` : "",
  ].filter(Boolean).join(" ");
}
