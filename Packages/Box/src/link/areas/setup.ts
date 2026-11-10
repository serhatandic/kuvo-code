// `kuvo/setup` (PROTOCOL.md, "Your setup"): who's in your setup and who its main computer is, as
// this box says it, on every box, for every client; and its events, a line now and one as it changes.

import { followed } from "../follow";
import { setupView } from "../setup/view";
import { onLinkWritten, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";

// Those following it here: told as this process writes link.json (what another wrote, within a second).
const followers = new Set<() => void>();
onLinkWritten(() => {
  for (const tell of followers) tell();
});

export async function* setupRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, signal, json } = context;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return yield* json(405, {});
  if (route === "kuvo/setup/events") {
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => setupView(readLink()), followers, signal);
  }
  return yield* json(200, setupView(readLink()));
}
