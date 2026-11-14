// What a session's model button shows and whether its model can run (PROTOCOL.md, "A session's
// model"): `GET kuvo/sessions/models?sessions=<id>,<id>…`. Decided here, from what the engine and
// the coding agents' bridge list, so every client shows the same: the model a session runs on, by
// the name its provider or agent lists it, whether it can run now, and what's missing if it can't
// (a model to choose, a sign-in, a key, its coding agent installed, or the model gone from its
// provider's list), and what that means for a composer, in words (work/model-words.ts). What
// can't be said yet (a place not answering, an agent's models still being listed, a provider only
// a project's own settings add) is left out, and a client lets it go.

import { isObject } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { SessionModel } from "../../shared/routes/sessions";
import { targetsOf } from "../letters/tools";
import type { EngineSession } from "../engine/sessions";
import { bridgeListsOf, engineListsIn, lastName, onAgents, stateOf, type Ref } from "../work/model-rule";
import { readiness } from "../work/model-words";
import { sessionHere, sessionsAsked, Unreached, GLANCE_MOST } from "./glance";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_MODELS_ROUTE = "kuvo/sessions/models";

/** What each of `ids` runs on, and whether it can, by session; one this box doesn't have, or can't
 * say about now, is left out. Throws `Unreached` while a place that might have one isn't answering. */
export async function sessionModels(ids: string[], engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<Record<string, SessionModel>> {
  const targets = [engine, bridge].filter((each): each is Target => each !== null);
  const found = (await Promise.all(ids.map(id => sessionHere(targets, id, signal)))).filter(each => each !== null);
  const reads = listReads(engine, bridge);
  const answer: Record<string, SessionModel> = {};
  await Promise.all(found.map(async place => {
    const said = await modelOf(place, engine, bridge, reads);
    if (said) answer[place.data.id] = said;
  }));
  return answer;
}

/** Each place's lists, read once (the engine's once a folder), and only where one's needed. */
function listReads(engine: Target | null, bridge: Target | null) {
  const engineRead = new Map<string, ReturnType<typeof engineListsIn>>();
  let bridgeRead: ReturnType<typeof bridgeListsOf> | undefined;
  return {
    engine: (folder: string | undefined) => {
      const key = folder ?? "";
      if (!engineRead.has(key)) engineRead.set(key, engineListsIn(engine, folder));
      return engineRead.get(key)!;
    },
    bridge: () => (bridgeRead ??= bridgeListsOf(bridge)),
  };
}

/** What the session at `place` runs on, whether it can, and what that means for a composer
 * (`readiness`); none where it can't be said now. */
export async function modelOf(place: { target: Target; data: Partial<EngineSession> }, engine: Target | null, bridge: Target | null, reads = listReads(engine, bridge)): Promise<SessionModel | undefined> {
  const { target, data } = place;
  const folder = data.location?.directory ?? data.directory;
  const own = isObject(data.model) && typeof data.model.providerID === "string" && typeof data.model.id === "string" ? data.model : null;
  const onBridge = bridge !== null && target.port === bridge.port;
  // None of its own: the engine's default (a coding agents' session always has one).
  const fallback = own || onBridge ? null : (await reads.engine(folder))?.fallback;
  // (An engine that can't say, or didn't say its default, has none to tell yet.)
  if (!own && !onBridge && fallback === undefined) return undefined;
  const ref: Ref | null = own ? { providerID: own.providerID, id: own.id, ...(typeof own.variant === "string" ? { variant: own.variant } : {}) } : fallback ?? null;
  if (!ref) {
    const state = { runs: false, missing: "model" as const };
    return { model: null, ...state, ...readiness(null, state) };
  }
  // (Only the place it runs in is read.)
  const state = stateOf(ref, onAgents(ref) ? { engine: null, bridge: await reads.bridge() } : { engine: await reads.engine(folder), bridge: null });
  return state ? { model: ref, ...state, ...readiness(ref, state, lastName(ref)) } : undefined;
}

export async function* sessionModelsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const ids = sessionsAsked(request.path);
  if (!ids) return yield* json(400, { message: `Name the sessions: sessions=<id>,<id>… (${GLANCE_MOST} at most).` });
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  try {
    return yield* json(200, { sessions: await sessionModels(ids, engine, bridge(), signal ?? undefined) });
  } catch (error) {
    if (error instanceof Unreached) return yield* json(503, { message: error.message });
    throw error;
  }
}
