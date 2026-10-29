// Agents' tools and starting sessions (PROTOCOL.md, "Agents' tools"): `POST kuvo/agent-tools`, which
// the tool servers on every box pass an agent's call to, and `POST kuvo/sessions`, a session started
// with a task by any client.

import { isObject, parsed } from "../../shared/json";
import { startSession } from "../letters/start";
import { agentTool, everyone, isAgentTool, rootOf, targetsOf } from "../letters/tools";
import type { AnswerPiece, RouteContext } from "../server/context";

const ADDRESS = /^ses_[A-Za-z0-9]{1,60}$/;

// An agent's call to one of its tools (`{name, arguments, session}`): what the tool says back,
// `{text, isError}`. One that waits for an answer holds the request (up to eleven minutes); the
// request going stops the wait, and an answer that comes later reaches its conversation as a message.
export async function* agentToolsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  if (!isObject(given) || !isAgentTool(given.name)) return yield* json(400, { message: "Send {name, arguments, session}: name one of list_agents, send_message, read_conversation, start_session." });
  const args = isObject(given.arguments) ? given.arguments : {};
  const session = typeof given.session === "string" && ADDRESS.test(given.session) ? given.session : null;
  return yield* json(200, await agentTool(given.name, args, session, { readEngine, bridge, signal: signal ?? undefined }));
}

// A session started with a task (`{task, title?, folder?, startedBy?, beside?, wait?}`): by the
// conversation `startedBy` (as its agent's start_session does), or by a client, the task as the
// user's own message. What it is, `{session, title, folder, project, beside}`, with `answer` when
// it's waited for.
export async function* startRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const given = parsed(request.body);
  if (!isObject(given)) return yield* json(400, { message: "Send {task}, and title, folder, startedBy, wait." });
  let by = null;
  if (given.startedBy !== undefined && given.startedBy !== null) {
    const root = typeof given.startedBy === "string" && ADDRESS.test(given.startedBy) ? await rootOf(given.startedBy, targetsOf({ readEngine, bridge })) : null;
    if (!root) return yield* json(404, { message: "There's no such conversation here." });
    const all = await everyone({ readEngine });
    by = { ...root, name: all.agents.find(agent => agent.session === root.session)?.name ?? "another agent" };
  }
  const outcome = await startSession(given, by, { readEngine, signal: signal ?? undefined });
  if ("refused" in outcome) {
    const { status, ...refusal } = outcome.refused;
    return yield* json(status, refusal);
  }
  return yield* json(200, outcome.started);
}
