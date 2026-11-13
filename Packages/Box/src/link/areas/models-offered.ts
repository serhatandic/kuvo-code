// The models a session can use here, and the one a new session starts on (PROTOCOL.md, "The models
// offered"): `GET kuvo/models/offered`, decided by the box's one rule (work/model-rule.ts), so every
// client's picker offers the same, and a new session starts by the same rule whoever starts it.

import type { Target } from "../../shared/records";
import { targetsOf } from "../letters/tools";
import { listsHere, offeredHere, startingModel, stillListing, type Ref } from "../work/model-rule";
import type { AnswerPiece, RouteContext } from "../server/context";

export const MODELS_OFFERED_ROUTE = "kuvo/models/offered";

/** The model a client would start a new session on (`provider`, `model`, `variant`: the one picked
 * last there); none named, none wanted. */
function wantedIn(requestPath: string): Ref | null {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const providerID = query.get("provider")?.trim(), id = query.get("model")?.trim(), variant = query.get("variant")?.trim();
  return providerID && id ? { providerID, id, ...(variant ? { variant } : {}) } : null;
}

export async function* modelsOfferedRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  if (!targetsOf({ readEngine, bridge }).length) return yield* json(503, { message: "The engine isn't running." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  const agents = bridge();
  const lists = await listsHere(engine, agents);
  const starting = startingModel([wantedIn(request.path)], lists);
  const listing = stillListing(lists);
  return yield* json(200, {
    models: offeredHere(lists).map(model => ({ providerID: model.providerID, id: model.id, name: model.name, ...(model.retiring ? { retiring: true } : {}), ...(model.hidden ? { hidden: true } : {}) })),
    // (The bridge not running is one that can't say yet: it's starting, or started again.)
    known: { engine: lists.engine !== null, agents: lists.bridge !== null },
    ...(listing.length ? { listing } : {}),
    ...(starting !== undefined ? { starting: starting?.model ?? null } : {}),
  });
}
