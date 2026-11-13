// The models a session can use here, and the one a new session starts on (PROTOCOL.md, "The models
// offered"): `GET kuvo/models/offered`, decided by the box's one rule (work/model-rule.ts), so every
// client's picker offers the same and a new conversation starts on the same model wherever it's
// begun.

import type { Target } from "../../shared/records";
import { targetsOf } from "../letters/tools";
import { listsHere, offeredHere, startingModel, type Ref } from "../work/model-rule";
import type { AnswerPiece, RouteContext } from "../server/context";

export const MODELS_OFFERED_ROUTE = "kuvo/models/offered";

/** The model a client would start a new session on (`provider`, `model`, `variant`: the one picked
 * last there), and the folder it's for; none named, none wanted. */
function asked(requestPath: string): { wanted: Ref | null; folder?: string } {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const providerID = query.get("provider")?.trim(), id = query.get("model")?.trim(), variant = query.get("variant")?.trim();
  const folder = query.get("folder")?.trim();
  return { wanted: providerID && id ? { providerID, id, ...(variant ? { variant } : {}) } : null, ...(folder ? { folder } : {}) };
}

export async function* modelsOfferedRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  if (!targetsOf({ readEngine, bridge }).length) return yield* json(503, { message: "The engine isn't running." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  const agents = bridge();
  const { wanted, folder } = asked(request.path);
  const lists = await listsHere(engine, agents, folder);
  const starting = startingModel([wanted], lists);
  return yield* json(200, {
    models: offeredHere(lists).map(model => ({ providerID: model.providerID, id: model.id, name: model.name, ...(model.retiring ? { retiring: true } : {}) })),
    // (A place that isn't there has nothing to say; one there that isn't answering can't say yet.)
    known: { engine: lists.engine !== null, agents: !agents || lists.bridge !== null },
    ...(starting !== undefined ? { starting: starting?.model ?? null } : {}),
  });
}
