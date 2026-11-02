// This box's bots: listed and followed, made, changed and deleted as the Mac's New Bot and Edit
// Bot do, brought here from another computer, and told what they are now.

import { parsed } from "../../shared/json";
import { changeBot, deleteBot } from "../bots/edit";
import { botFollowers } from "../bots/here";
import { botTemplates, NO_KIT, readKit } from "../bots/kit";
import { listBots } from "../bots/list";
import { makeBot, startingModelHere } from "../bots/make";
import { freshenBots, settleBot } from "../bots/tell";
import { followed } from "../follow";
import { BOTS } from "../home";
import type { Target } from "../../shared/records";
import type { BotChange } from "../bots/edit";
import type { GivenBot } from "../bots/make";
import type { AnswerPiece, RouteContext } from "../server/context";

export async function* botTemplatesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, info, json } = context;
  // Read with GET or HEAD, as every box's lists are.
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* json(405, {});
  const kit = readKit();
  if (!kit) return yield* json(409, { message: NO_KIT });
  const startingModel = await startingModelHere(kit.startingModel ?? null, readEngine, signal);
  return yield* json(200, botTemplates({ ...kit, startingModel }, info.name));
}

// New bots, made here as New Bot makes them on the Mac, which takes them in when it next connects.
export async function* newBotRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, info, json } = context;
  const { status, value } = await makeBot(parsed(request.body) as GivenBot | null | undefined, readEngine, bridge, info.name);
  return yield* json(status, value);
}

// A bot here changed as Edit Bot changes it, or deleted as Delete Bot… deletes it.
export async function* botRoute(context: RouteContext, oneBot: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, bridge, info, json } = context;
  let id: string;
  try {
    id = decodeURIComponent(oneBot[1]);
  } catch {
    return yield* json(404, { message: "That bot isn’t there any more." });
  }
  const { status, value } = request.method.toUpperCase() === "PATCH"
    ? await changeBot(id, parsed(request.body) as BotChange | null | undefined, readEngine, bridge, info.name, signal)
    : await deleteBot(id, readEngine, bridge);
  return yield* json(status, value);
}

// A bot brought here from another computer, made this box's (Move to Computer).
export async function* arrivedRoute(context: RouteContext, arrived: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, info, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  let id: string;
  try { id = decodeURIComponent(arrived[1]); } catch { return yield* json(404, { message: "That bot isn’t there any more." }); }
  const { status, value } = await settleBot(id, readEngine, bridge, info.name);
  return yield* json(status, value);
}

// Its bots told what they are now where that changed, as its app asks after a change to its kit
// (your personalities, on a Mac).
export async function* retellRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, readBridge, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  for (const read of [readEngine, readBridge]) {
    let target: Target | null = null;
    try { target = read(); } catch {}
    if (target?.port) await freshenBots(target);
  }
  return yield* json(200, {});
}

// Its bots followed: a line now, and again as they change (made, changed, deleted, a wake-up
// added or sent), as a client shows them.
export async function* botEventsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, info, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ bots: listBots(info.name) }), botFollowers, signal, { folders: [BOTS] });
}

// This machine's bots and wake-ups, from their folders.
export async function* botsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, info, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ bots: listBots(info.name) })) };
  return;
}
