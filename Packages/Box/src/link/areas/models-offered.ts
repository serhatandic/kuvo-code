// The models a session can use here, and the one a new session starts on (PROTOCOL.md, "The models
// offered"): `GET kuvo/models/offered[?folder=<path>]`, decided by the box's one rule
// (work/model-rule.ts), so every client's picker offers the same, and a new session starts by the
// same rule whoever starts it, in a project's folder by what its own settings add too.

import fs from "node:fs";
import path from "node:path";
import type { Target } from "../../shared/records";
import { targetsOf } from "../letters/tools";
import { listsHere, offeredHere, startingModel, stillListing, type Lists, type Ref } from "../work/model-rule";
import type { AnswerPiece, RouteContext } from "../server/context";

export const MODELS_OFFERED_ROUTE = "kuvo/models/offered";

/** The model a client would start a new session on (`provider`, `model`, `variant`: the one picked
 * last there); none named, none wanted. */
function wantedIn(requestPath: string): Ref | null {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const providerID = query.get("provider")?.trim(), id = query.get("model")?.trim(), variant = query.get("variant")?.trim();
  return providerID && id ? { providerID, id, ...(variant ? { variant } : {}) } : null;
}

/** The folder asked about (`folder`: a project's, or a conversation's), where the engine's lists
 * are read, a project's own settings adding providers, models or its default; none named, or one
 * that isn't a folder here (a worktree removed since, a project named otherwise), the box's own. */
async function folderIn(requestPath: string): Promise<string | undefined> {
  const folder = new URLSearchParams(requestPath.split("?")[1] ?? "").get("folder")?.trim();
  if (!folder || !path.isAbsolute(folder)) return undefined;
  const resolved = path.resolve(folder);
  return (await fs.promises.stat(resolved).then(found => found.isDirectory(), () => false)) ? resolved : undefined;
}

export async function* modelsOfferedRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const folder = await folderIn(request.path);
  if (!targetsOf({ readEngine, bridge }).length) return yield* json(503, { message: "The engine isn't running." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  const agents = bridge();
  const lists = await listsHere(engine, agents, folder);
  return yield* json(200, offeredAnswer(lists, wantedIn(request.path)));
}

/** The route's answer from what the engine and the bridge list, for the model `wanted`. */
export function offeredAnswer(lists: Lists, wanted: Ref | null) {
  const starting = startingModel([wanted], lists);
  const listing = stillListing(lists);
  return {
    // `side`: where a conversation on it runs (the engine, or the coding agents' bridge, Custom
    // Auto's lists too), so a client offers in place only its own side's; `efforts`, its variants;
    // `aliases`, other ids a conversation may name it by (Claude Code's `default`).
    models: offeredHere(lists).map(model => ({ providerID: model.providerID, id: model.id, name: model.name, side: model.agents ? "agents" : "engine", efforts: model.efforts, aliases: model.aliases, ...(model.retiring ? { retiring: true } : {}), ...(model.hidden ? { hidden: true } : {}) })),
    // (The bridge not running is one that can't say yet: it's starting, or started again.)
    known: { engine: lists.engine !== null, agents: lists.bridge !== null },
    ...(listing.length ? { listing } : {}),
    ...(starting !== undefined ? { starting: starting?.model ?? null } : {}),
  };
}
