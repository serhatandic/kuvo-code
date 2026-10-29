// `kuvo/moves`: Move to Computer, as a client asks this box for it (PROTOCOL.md, `kuvo/moves`):
// where a bot, a chat or a group chat can go, a move (answered once it's there, or why not), and the
// moves under way here with the conversations that don't live here.

import { isObject } from "../../shared/json";
import type { MoveKind, MovePlaces, Moves } from "../../shared/routes/moves";
import { followed } from "../follow";
import { placesFor, startMove } from "../moves/move";
import { awaySessions, liveMoves, moveFollowers, shownMove } from "../moves/records";
import type { AnswerPiece, RouteContext } from "../server/context";

const KINDS: MoveKind[] = ["bot", "chat", "group"];

const movesNow = (): Moves => ({ moves: liveMoves().map(shownMove), away: awaySessions() });

export async function* movesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  const method = request.method.toUpperCase();
  if (method === "GET") return yield* json(200, movesNow());
  if (method !== "POST") return yield* json(405, {});
  let given: unknown;
  try { given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}"); } catch { given = null; }
  if (!isObject(given) || !KINDS.includes(given.kind as MoveKind) || typeof given.id !== "string" || typeof given.to !== "string") {
    return yield* json(400, { message: `Say what moves where: {"kind": "bot" | "chat" | "group", "id": …, "to": <its box's key>}.` });
  }
  // It goes on if the client goes: the box it leaves sees it through.
  const outcome = await startMove(given.kind as MoveKind, given.id, given.to);
  if (signal?.aborted) return;
  return yield* (outcome.ok ? json(200, { move: outcome.move }) : json(outcome.status, { message: outcome.message }));
}

export async function* moveEventsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(movesNow, moveFollowers, signal);
}

export async function* movePlacesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const query = new URLSearchParams(request.path.split("?")[1] ?? "");
  const kind = query.get("kind") as MoveKind, id = query.get("id");
  if (!KINDS.includes(kind) || !id) return yield* json(400, { message: "Say what: ?kind=bot|chat|group&id=…" });
  const places = await placesFor(kind, id, signal);
  if (!places) return yield* json(404, { message: "It isn’t on this computer any more." });
  return yield* json(200, { places } satisfies MovePlaces);
}
