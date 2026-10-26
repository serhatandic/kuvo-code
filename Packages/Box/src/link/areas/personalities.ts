// @ts-nocheck
// Your personalities (PROTOCOL.md, "Personalities"): this box's copy of the library, followed and
// changed, and another computer's copy met with it.

import path from "node:path";
import { parsed } from "../../shared/json";
import { followed } from "../follow";
import { PERSONALITIES_FILE, personalitiesDocument, personalityFollowers, readPersonalities } from "../personalities/library";
import { answerPersonalities, retellBots, takePersonalitiesDocument } from "../personalities/take";

// The library followed: a line now, and again as it changes, from a route here, a peer's copy
// met, or another process (a Mac's `box personalities` over SSH, the bridge beside this box).
export async function* personalityEventsRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ personalities: readPersonalities().personalities }), personalityFollowers, signal, { folders: [path.dirname(PERSONALITIES_FILE)], recursive: false });
}

// The library whole, and another computer's copy met with it: for the app beside this box only
// (it signs the library for your other computers), never a phone.
export async function* personalitiesDocumentRoute(context) {
  const { request, route, readEngine, readBridge, json } = context;
  if (!request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  const method = request.method.toUpperCase();
  if (route === "kuvo/personalities/document") return yield* method === "GET" ? json(200, personalitiesDocument()) : json(405, {});
  if (method !== "POST") return yield* json(405, {});
  const [status, value] = takePersonalitiesDocument(parsed(request.body), readEngine, readBridge);
  return yield* json(status, value);
}

// The personalities you make, this machine's copy of the library.
export async function* personalityRoute(context, personality) {
  const { request, readEngine, readBridge, json } = context;
  let id;
  try { id = personality[1] === undefined ? undefined : decodeURIComponent(personality[1]); } catch { return yield* json(404, {}); }
  const [status, value] = answerPersonalities(request.method.toUpperCase(), id, parsed(request.body));
  // Its bots with it are told what it is now, or that it's gone.
  if (status === 200 && id !== undefined) retellBots([id], readEngine, readBridge).catch(() => {});
  return yield* json(status, value);
}
