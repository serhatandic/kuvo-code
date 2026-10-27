// Personalities, as their bots and your other computers hear of them

import crypto from "node:crypto";
import { isObject } from "../../shared/json";
import type { Body } from "../../shared/json";
import { botHere, isMoving } from "../bots/here";
import { readKit } from "../bots/kit";
import { tellBot, toldNow } from "../bots/tell";
import { noteDocsChanged } from "../documents/changed";
import { readBridgeFile, readEngineFile } from "../engine/client";
import { listOf } from "../files";
import { BOTS } from "../home";
import { changePersonalities, fitsLibrary, FULL_LIBRARY, keptPersonality, meetPersonalities, PERSONALITIES_FILE, PERSONALITIES_LOCK, PERSONALITY_ID, readPersonalities } from "./library";
import type { Target } from "../../shared/records";
import type { Personalities, PersonalitiesTaken } from "../../shared/routes/personalities";
import type { GivenLibrary, Personality } from "./library";

/** What a personalities route answers, `[status, value]`: the value it sends as JSON with that
 * status (the library's personalities, one of them, the ids that changed, why not, or nothing). */
export type PersonalitiesAnswer = [status: number, value: Personalities | Personality | PersonalitiesTaken | { message: string } | Record<string, never>];

// Another copy met with this one's (a peer's view, a Mac's over SSH): the personalities that changed
// here, whose bots here are told what they are now.
export async function takePersonalities(given: GivenLibrary | null | undefined, readEngine: () => Target = readEngineFile, readBridge: () => Target | null = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK): Promise<string[]> {
  const changed = meetPersonalities(given, file, lock);
  if (changed.length) await retellBots(changed, readEngine, readBridge).catch(() => {});
  return changed;
}

// Another computer's copy, given by the app beside this box (`kuvo/personalities/take`), met with
// this one's by the same rules as a peer's: `[status, value]`, with the ids that changed here. Their
// bots here are told (not waited for), and the other boxes, as after a change through the routes.
export function takePersonalitiesDocument(body: Body<"document">, readEngine: () => Target = readEngineFile, readBridge: () => Target | null = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK): PersonalitiesAnswer {
  const given = body?.document;
  if (!isObject(given) || !Array.isArray(given.personalities) || (given.removed !== undefined && !Array.isArray(given.removed))) {
    return [400, { message: "Send a library of personalities: {document: {personalities, removed}}." }];
  }
  const changed = meetPersonalities(given, file, lock);
  if (changed.length) {
    noteDocsChanged();
    retellBots(changed, readEngine, readBridge).catch(() => {});
  }
  return [200, { changed }];
}

// Bots here whose personality is among `ids` (changed, or gone), told what they are now, as a
// Mac asks after a change to your personalities (`kuvo/bots/retell`).
export async function retellBots(ids: string[], readEngine: () => Target = readEngineFile, readBridge: () => Target | null = readBridgeFile): Promise<void> {
  const kit = readKit();
  if (!kit) return;
  for (const here of listOf(BOTS).map(botHere)) {
    if (!here || !(ids as (string | undefined)[]).includes(here.described.personality) || isMoving(here.folder)) continue;
    let target: Target | null = null;
    try { target = here.agents ? readBridge() : readEngine(); } catch {}
    if (!target?.port) continue;
    await tellBot(target, here, here.session, toldNow(kit, here));
  }
}

// What a phone asks of the library (`kuvo/personalities`): `[status, value]`.
export function answerPersonalities(method: string, id: string | undefined, body: Body<"name" | "description">, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK): PersonalitiesAnswer {
  const now = Date.now();
  const incomplete: PersonalitiesAnswer = [400, { message: "A personality needs a name and a description." }];
  const full: PersonalitiesAnswer = [400, { message: FULL_LIBRARY }];
  if (id === undefined) {
    if (method === "GET") return [200, { personalities: readPersonalities(file).personalities }];
    if (method !== "POST") return [405, {}];
    // (A personality, not a removal: it has no `removed`.)
    const made = keptPersonality({ id: `custom.${crypto.randomUUID().toLowerCase()}`, name: body?.name, description: body?.description, updated: now }) as Personality | null;
    if (!made) return incomplete;
    let refused = false;
    changePersonalities(library => {
      const after = { ...library, personalities: [...library.personalities, made] };
      if (fitsLibrary(after)) return after;
      refused = true;
      return library;
    }, file, lock);
    if (refused) return full;
    noteDocsChanged();
    return [200, made];
  }
  if (!PERSONALITY_ID.test(id)) return [404, {}];
  let found: Personality | null = null;
  if (method === "PATCH") {
    let refused: PersonalitiesAnswer | null = null;
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      const changed = keptPersonality({ ...kept, name: body?.name ?? kept.name, description: body?.description ?? kept.description, updated: kept.updated + 1 }) as Personality | null;
      if (!changed) { refused = incomplete; return library; }
      const after = { ...library, personalities: library.personalities.map(each => each.id === id ? changed : each) };
      if (!fitsLibrary(after)) { refused = full; return library; }
      found = changed;
      return after;
    }, file, lock);
    if (refused) return refused;
    if (found) noteDocsChanged();
    return found ? [200, found] : [404, {}];
  }
  if (method === "DELETE") {
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      found = kept;
      // Counted past its last change; among removals, the newest are the ones kept.
      return { personalities: library.personalities.filter(each => each.id !== id), removed: [...library.removed, { id, removed: Math.max(now, kept.updated + 1) }] };
    }, file, lock);
    if (found) noteDocsChanged();
    return found ? [200, {}] : [404, {}];
  }
  return [405, {}];
}