// What this box's agents made

import { IS_MAC } from "../home";
import type { Target } from "../../shared/records";
import type { AnswerPiece, LinkRequest, RouteContext } from "../server/context";
import { agentsDown } from "./agents-down";
import { groupJSON } from "./groups";

// What a client asks of the record (PROTOCOL.md, `kuvo/artifacts`): a place's list, Timeline and
// one thing with its versions (read, or followed as they change), a version's bytes and what it
// changed, pinning and putting a version back, and what the copies take. The coding agents' bridge
// keeps the record and answers in the shapes a client takes: passed on as it answers.
export const ARTIFACT_ROUTE = /^kuvo\/artifacts(?:\/(?:events|timeline(?:\/events)?|storage(?:\/clear)?|art_[0-9a-f]{24}(?:\/(?:pin|restore|versions\/\d+(?:\/changes)?))?))?$/;

// A client's route to the bridge and back as it answers, with its query (a followed one streams,
// a version's bytes come as they are).
export async function* forwardArtifacts(target: Target, route: string, request: LinkRequest, signal: AbortSignal | undefined): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  const sends = method === "POST";
  const query = request.path.includes("?") ? request.path.slice(request.path.indexOf("?")) : "";
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/link/artifacts${route.slice("kuvo/artifacts".length)}${query}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(sends ? { "content-type": "application/json" } : {}) },
      body: sends ? Buffer.from(request.body ?? []) : undefined,
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    return yield* groupJSON(503, { message: notAnswering() });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return yield* groupJSON(503, { message: notAnswering() });
  }
  const headers: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const length = response.headers.get("content-length");
  if (length) headers["content-length"] = length;
  yield { head: { status: response.status, headers } };
  try {
    for await (const chunk of response.body ?? []) yield { body: Buffer.from(chunk) };
  } catch {}
}

const notAnswering = () => (IS_MAC ? "What your agents made on this Mac can’t be read right now. Try again in a moment." : "The coding agents’ bridge here isn’t answering. Try again in a moment.");

// What this box's agents made (`kuvo/artifacts`), from the coding agents' bridge, which keeps the
// record, in the shapes of shared/routes/artifacts.ts.
export async function* artifactsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, bridge } = context;
  const target = bridge();
  if (!target) return yield* groupJSON(503, { message: agentsDown() ?? (IS_MAC ? "What your agents made on this Mac is still loading. Try again in a moment." : "What agents made here is kept by the coding agents' bridge, which isn't running on this machine.") });
  return yield* forwardArtifacts(target, route, request, signal);
}
