// `kuvo/sessions/<id>/autopilot`: whether a conversation runs Interactive or on Autopilot, and the
// calls it made there (PROTOCOL.md, "Autopilot"; the rest in `../work/autopilot.ts`). A client
// reads it, turns it on or off, confirms or changes a call, and asks whether a question waits on you.

import { isObject, parsed } from "../../shared/json";
import { engineGet, peerTargets } from "../engine/client";
import { CHOICE_MOST } from "../work/answers";
import { carryDecided, decidedByYou, decidedIn, goAheadOnWaiting, isAutopilot, setAutopilot, waitsOnYou } from "../work/autopilot";
import { carryWorkQueue } from "../work-queue/moves";
import { answerGoal, runningGoalOf } from "../work/goals";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";
import type { SessionAutopilot } from "../../shared/routes/autopilot";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_AUTOPILOT_ROUTE = /^kuvo\/sessions\/([^/]+)\/autopilot(\/asked)?$/;

/** A conversation where it is: on the engine, or the coding agents' bridge. */
async function find(id: string, targets: (Target | null)[]): Promise<{ target: Target; data: EngineSession } | null> {
  for (const target of targets) {
    if (!target) continue;
    const data = (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
    if (data?.id) return { target, data };
  }
  return null;
}

const shown = (data: EngineSession): SessionAutopilot => ({ autopilot: isAutopilot(data), decided: decidedIn(data.id) });

export async function* autopilotRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json, route, signal, readEngine, bridge } = context;
  const method = request.method.toUpperCase();
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  let id = "";
  try { id = decodeURIComponent(route.match(SESSION_AUTOPILOT_ROUTE)?.[1] ?? ""); } catch {}
  if (!id) return yield* json(404, { message: "That conversation isn't here." });
  const asked = Boolean(route.match(SESSION_AUTOPILOT_ROUTE)?.[2]);
  if (asked && method !== "POST") return yield* json(405, { message: "Ask with POST." });
  if (asked && typeof given.form !== "string") return yield* json(400, { message: "Say which question (form)." });
  if (method !== "GET" && method !== "PUT" && method !== "POST") return yield* json(405, { message: "Read it with GET, turn it on or off with PUT, or change a call with POST." });
  if (method === "PUT" && typeof given.autopilot !== "boolean") return yield* json(400, { message: "Say whether it runs on Autopilot (autopilot, true or false)." });
  if (method === "POST" && !asked && (typeof given.decided !== "string" || typeof given.choice !== "string" || !given.choice.trim())) return yield* json(400, { message: "Say which call (decided) and your choice (choice)." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine?.port) engine = null;
  const agents = bridge();
  if (!engine && !agents) return yield* json(503, { message: "The engine isn't running." });
  const at = await find(id, [engine, agents]);
  if (!at) return yield* json(404, { message: "That conversation isn't here." });
  // Carried on from another of this box's (a Mac carries it itself): its calls come along.
  const carried = at.data.metadata?.kuvo?.carriedFrom;
  if (typeof carried === "string") {
    carryDecided(carried, id);
    carryWorkQueue(carried, id);
  }
  if (asked) return yield* json(200, { waiting: await waitsOnYou(at.target, at.data, given.form as string, undefined, signal).catch(() => true) });
  if (method === "PUT") {
    const on = given.autopilot as boolean;
    if (!await setAutopilot(at.target, at.data, on, signal)) return yield* json(502, { message: "It couldn't be changed: the engine didn't take it. Try again." });
    const kuvo = isObject(at.data.metadata?.kuvo) ? at.data.metadata.kuvo : {};
    const now = { ...at.data, metadata: { ...at.data.metadata, kuvo: { ...kuvo, autopilot: on } } };
    // What it asks already that recommends a choice goes ahead now, as what it asks from here will.
    if (on) await goAheadOnWaiting(at.target, now, undefined, signal).catch(() => []);
    // A bot's conversation at a goal: the goal runs as it does now (its bot told so).
    const goal = runningGoalOf(id, null);
    if (goal && goal.session === id) await answerGoal(goal.id, { action: "change", mode: on ? "autopilot" : "interactive" }, peerTargets).catch(() => null);
    return yield* json(200, shown(now));
  }
  if (method === "POST") {
    const changed = await decidedByYou(at.target, id, given.decided as string, (given.choice as string).trim().slice(0, CHOICE_MOST));
    if ("status" in changed) return yield* json(changed.status, { message: changed.message });
    return yield* json(200, shown(at.data));
  }
  return yield* json(200, shown(at.data));
}
