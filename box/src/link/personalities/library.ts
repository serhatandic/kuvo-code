// Personalities you make (PROTOCOL.md, "Personalities")
// One library on every computer: each keeps its copy, and copies meet box to box (each box's view
// is a document of its own, PROTOCOL.md "Documents") and as a Mac connects: per personality a
// removal wins, and stays noted so no copy brings it back; otherwise the newest change, by a count
// each change moves on from the one before it (`updated`), whatever any clock says. Kuvo Code's own
// presets aren't in it; they come with the kit.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { plainName } from "../../shared/text";
import { MOST_DOC } from "../documents/format";
import { textOf, locked, writePrivate } from "../files";
import { BOTS, RUN } from "../home";
import type { Personality as PersonalityShape } from "../../shared/routes/personalities";

/** A personality you made, as the library keeps it: its name and what it is, the SF Symbol it
 * shows, and its change's count. */
export type Personality = PersonalityShape & {
  // (It isn’t a removal.)
  removed?: never;
};

/** A personality removed, noted with its count so no copy brings it back. */
export interface PersonalityRemoval {
  id: string;
  removed: number;
  // (A removal has no words.)
  name?: never;
  description?: never;
}

/** One personality's take as kept: the personality, or its removal. */
export type PersonalityEntry = Personality | PersonalityRemoval;

/** This computer's copy of the library: its personalities, and the removals noted, newest first. */
export interface PersonalityLibrary {
  personalities: Personality[];
  removed: PersonalityRemoval[];
}

/** A library as a copy or a change gives it: its lists, of anything; only what's a personality or
 * a removal is kept of them. */
export interface GivenLibrary {
  personalities?: unknown;
  removed?: unknown;
}

/** A personality a bot made here can have: one of the kit's presets, or one you made (`custom`),
 * with what the bot is told. */
export interface BotPersonality {
  id: string;
  name: string;
  description: string;
  custom?: boolean;
  instruction: string;
}

/** What `botPersonalities` needs of a box's kit (bots/kit.ts): its personalities, and the words a
 * bot is told one in, with ⟦name⟧ and ⟦description⟧. */
export interface PersonalityKit {
  personalityWords: string;
  personalities: BotPersonality[];
}

// Beside the bots: where a Mac's app keeps them (KUVO_BOTS), a machine in its own folder.
export const PERSONALITIES_FILE = path.join(BOTS, "personalities.json");
export const PERSONALITIES_LOCK = path.join(RUN, ".personalities.lock");
// Those following the library (`kuvo/personalities/events`), told of each change written here.
export const personalityFollowers = new Set<() => void>();
export const PERSONALITY_ID = /^custom\.[A-Za-z0-9._-]{1,80}$/;
// Removals noted, the newest kept.
const MOST_REMOVALS = 500;
// A change's count no higher than this, so the next one is always higher.
export const MOST_COUNT = 2 ** 52;

const changedAt = (entry: { removed?: unknown; updated?: unknown } | null | undefined): number => Number(entry?.removed ?? entry?.updated ?? 0) || 0;
const isRemoval = (entry: { removed?: unknown } | null | undefined): entry is PersonalityRemoval => entry?.removed !== undefined;

// One personality as kept: what's needed, plain and of a sane length; null for what isn't one.
export function keptPersonality(entry: unknown): PersonalityEntry | null {
  if (!isObject(entry) || typeof entry.id !== "string" || !PERSONALITY_ID.test(entry.id) || changedAt(entry) > MOST_COUNT) return null;
  if (isRemoval(entry)) return Number.isFinite(Number(entry.removed)) ? { id: entry.id, removed: Number(entry.removed) } : null;
  const name = plainName(entry.name).slice(0, 80);
  const description = String(entry.description ?? "").trim().slice(0, 2000);
  if (!name || !description) return null;
  return { id: entry.id as string, name, description, symbol: typeof entry.symbol === "string" && entry.symbol ? entry.symbol.slice(0, 80) : "person.crop.circle", updated: Number(entry.updated) || 0 };
}

// The take of one personality that wins: a removal over any change; else the newer change, and at
// the same count the one whose words sort last, so every copy picks the same.
function newerTake(a: PersonalityEntry, b: PersonalityEntry): PersonalityEntry {
  if (isRemoval(a) !== isRemoval(b)) return isRemoval(a) ? a : b;
  const at = changedAt(a), bt = changedAt(b);
  if (at !== bt) return at > bt ? a : b;
  return `${a.name ?? ""}\n${a.description ?? ""}` >= `${b.name ?? ""}\n${b.description ?? ""}` ? a : b;
}

// Libraries as one: `{personalities, removed}`, in the order they were first seen.
export function mergePersonalities(...libraries: (GivenLibrary | null | undefined)[]): PersonalityLibrary {
  const byID = new Map<string, PersonalityEntry>();
  for (const library of libraries) {
    for (const entry of [...(Array.isArray(library?.personalities) ? library.personalities : []), ...(Array.isArray(library?.removed) ? library.removed : [])]) {
      const kept = keptPersonality(entry);
      if (!kept) continue;
      const had = byID.get(kept.id);
      byID.set(kept.id, had ? newerTake(had, kept) : kept);
    }
  }
  const all = [...byID.values()];
  return {
    personalities: all.filter((entry): entry is Personality => !isRemoval(entry)),
    removed: all.filter(isRemoval).sort((a, b) => b.removed - a.removed).slice(0, MOST_REMOVALS),
  };
}

export function readPersonalities(file = PERSONALITIES_FILE): PersonalityLibrary {
  try {
    return mergePersonalities(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { personalities: [], removed: [] };
  }
}

// Changes this computer's copy under its lock: `change` gets it and gives it back changed.
export function changePersonalities(change: (library: PersonalityLibrary) => GivenLibrary, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK): PersonalityLibrary {
  return locked(lock, () => {
    const library = mergePersonalities(change(readPersonalities(file)));
    // Written only when it changed (a Mac meets this copy every minute).
    const text = JSON.stringify({ kuvo: 1, ...library }, null, 2) + "\n";
    if (textOf(file) !== text) {
      writePrivate(file, text);
      for (const tell of personalityFollowers) tell();
    }
    return library;
  });
}

// Another copy met with this one's, under its lock: the ids whose personality or removal changed
// here. Met whole, past what a document holds too, so every copy comes to the same (one past it
// just isn't given to the others until it's smaller, `ownDocs`).
export function meetPersonalities(given: GivenLibrary | null | undefined, file?: string, lock?: string): string[] {
  let changed: string[] = [];
  changePersonalities(library => {
    const was = new Map([...library.personalities, ...library.removed].map(entry => [entry.id, JSON.stringify(entry)]));
    const met = mergePersonalities(library, given);
    changed = [...met.personalities, ...met.removed].filter(entry => was.get(entry.id) !== JSON.stringify(entry)).map(entry => entry.id);
    return met;
  }, file, lock);
  return changed;
}

// The library whole, as this box keeps it and signs it (`kuvo/personalities/document`).
export function personalitiesDocument(file = PERSONALITIES_FILE) {
  return { kuvo: 1, ...readPersonalities(file) };
}

// The library fits in one document, with room to spare; a change that would take it past that is
// refused, as on the Mac.
export const FULL_LIBRARY = "There’s no room for more in your personalities. Shorten or remove one, then try again.";
export const fitsLibrary = (library: GivenLibrary): boolean => Buffer.byteLength(JSON.stringify(mergePersonalities(library))) <= MOST_DOC - 4096;

// The personalities a bot made here can have: the kit's presets, then the library's, each with
// what the bot is told (`personalityWords`, as the Mac words it).
export function botPersonalities(kit: PersonalityKit, library = readPersonalities()): BotPersonality[] {
  const told = (each: Personality) => kit.personalityWords.replaceAll("⟦name⟧", each.name).replaceAll("⟦description⟧", each.description);
  const presets = kit.personalities.filter(each => !each.custom);
  // Ones you made that a Mac's kit lists and this copy of the library hasn't had yet: the kit's,
  // until the library has them.
  const fromKit = kit.personalities.filter(each => each.custom && !library.personalities.some(mine => mine.id === each.id) && !library.removed.some(gone => gone.id === each.id));
  return [...presets, ...fromKit, ...library.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: true, instruction: told(each) }))];
}
