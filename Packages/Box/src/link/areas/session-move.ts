// `POST kuvo/sessions/<id>/move {directory}`: a conversation moved into a project here (PROTOCOL.md,
// "Projects"), as a chat that turns into work is: its conversation goes along, and from then on it
// works in that project's folders, given them as a session started there is (`giveFolders`).

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { call } from "../engine/client";
import { frozen } from "../moves/records";
import { giveFolders } from "./projects";
import type { Target } from "../../shared/records";
import type { SessionMoved } from "../../shared/routes/sessions";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_MOVE_ROUTE = /^kuvo\/sessions\/([^/]+)\/move$/;

// A session on `target` as it is now, or null for none there.
async function read(target: Target | null, id: string, signal: AbortSignal | undefined): Promise<Record<string, unknown> | null> {
  if (!target) return null;
  const data = await call(target, "GET", `/api/session/${encodeURIComponent(id)}`, undefined, signal).catch(() => null);
  return isObject(data) && data.id === id ? data : null;
}

export async function* sessionMoveRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, { message: "Move it with POST." });
  let id = "";
  try { id = decodeURIComponent(route.match(SESSION_MOVE_ROUTE)?.[1] ?? ""); } catch {}
  const body = parsed(request.body);
  const directory = isObject(body) && typeof body.directory === "string" ? body.directory : "";
  let isFolder = false;
  try { isFolder = path.isAbsolute(directory) && fs.statSync(directory).isDirectory(); } catch {}
  if (!isFolder) return yield* json(400, { message: directory ? `${directory} isn't a folder here.` : "Say where it goes (directory, a full path)." });
  // Moving to another computer: nothing changes it until it's there.
  if (frozen().has(id)) return yield* json(409, { message: "It’s moving to another computer. Try again once it’s there." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine?.port) engine = null;
  const before = await read(engine, id, signal);
  if (!before) {
    // (One of the coding agents' can't be moved: their sessions keep the folder they started in.)
    if (await read(bridge(), id, signal)) return yield* json(409, { message: "Moving a chat into a project isn't available in sessions with this agent." });
    return yield* json(engine ? 404 : 503, { message: engine ? "That conversation isn't here." : "The engine isn't running." });
  }
  try {
    await call(engine!, "POST", `/api/session/${encodeURIComponent(id)}/move`, { directory }, signal);
  } catch (error) {
    return yield* json(502, { message: `It couldn't be moved: ${String((error as Error | null)?.message ?? error)}` });
  }
  // Its project's folders there, as a session started there has them (the engine moves one at work
  // at its next step: by where it goes).
  await giveFolders(engine!, id, signal, directory);
  const info = await read(engine, id, signal);
  return yield* json(200, { session: id, directory, ...(info ? { info } : {}) } satisfies SessionMoved);
}
