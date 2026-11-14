// Group chats that live here

import { IS_MAC } from "../home";
import { agentsDown } from "./agents-down";
import { listedAgents, nameMissing, refreshOwnShared } from "../server/naming";
import type { Target } from "../../shared/records";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";

// What a client asks of them (PROTOCOL.md, `kuvo/groups`): the list and one chat (read, or followed
// as they change), who can be in one, and what it does (makes, changes or deletes one, writes to it,
// stops it, lets it keep going, looks at it, takes a message back, starts the work a wrap-up split
// up). The coding agents' bridge that runs them answers in the shapes a client takes, with every
// rule of what can be: passed on as it answers.
export const GROUP_ROUTE = /^kuvo\/groups(?:\/(events|joinable|grp_[a-z0-9]+(?:\/(?:events|stop|keep-going|viewed|undo|start))?))?$/;

// What the bridge's own group chat API (`/api/kuvo/groups…`, src/agents/groups/routes.ts) answers
// is the asker's to say (`Value`), with its status as it came; anything that isn't JSON comes as {}.
export async function askGroups<Value = unknown>(target: Target, method: string, route: string, body: unknown, signal: AbortSignal | undefined): Promise<{ status: number; value: Value }> {
  const response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/groups${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const value = await response.json().catch(() => ({})) as Value;
  return { status: response.status, value };
}

// A client's group chat route, to the bridge that runs them and back as it answers (a followed
// one as its lines come). Not answering now: 503, to ask again, never taken as having none.
export async function* forwardGroups(target: Target, route: string, request: LinkRequest, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  const sends = !["GET", "HEAD", "DELETE"].includes(method);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/link/groups${route.slice("kuvo/groups".length)}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(sends ? { "content-type": "application/json" } : {}) },
      body: sends ? Buffer.from(request.body ?? []) : undefined,
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  yield { head: { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } } };
  try {
    for await (const chunk of response.body ?? []) yield { body: Buffer.from(chunk) };
  } catch {}
}

const groupsNotAnswering = () => (IS_MAC ? "Group chats on this Mac aren’t answering. Try again in a moment." : "The coding agents’ bridge here isn’t answering. Try again in a moment.");

export function* groupJSON(status: number, value: { message: string }): Generator<AnswerPiece> {
  yield { head: { status, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify(value)) };
}

// The group chats that live here (`kuvo/groups`), from the coding agents' bridge, which runs them.
// What it answers is the bridge's, passed on as it comes, in the shapes of shared/routes/groups.ts.
export async function* groupsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, readEngine, bridge } = context;
  const target = bridge();
  if (!target) return yield* groupJSON(503, { message: agentsDown() ?? (IS_MAC ? "Group chats on this Mac are starting. Try again in a moment." : "Group chats run with the coding agents' bridge, which isn't running on this machine.") });
  // Who a message names with "&" is worked out there, from the list as it is now: worked out
  // again meanwhile, and waited for (two seconds at most) only when a name after "&" isn't
  // there yet, as a message from a phone (`namingHere`).
  if (request.method.toUpperCase() === "POST" && route.split("/").length === 3 && Buffer.from(request.body ?? []).includes("&")) {
    let text: unknown = "";
    try { text = JSON.parse(Buffer.from(request.body!).toString())?.text; } catch {}
    const working = refreshOwnShared(readEngine);
    if (typeof text === "string" && nameMissing(text, listedAgents().agents)) {
      await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
    }
  }
  return yield* forwardGroups(target, route, request, signal);
}
