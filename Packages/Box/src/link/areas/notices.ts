// What this box told you lately (PROTOCOL.md, "kuvo/notices"): its notices, as it made them, for
// clients to show as their own notifications, so what's news and how it's said is the box's alone.
// `telling`: whether the box is telling its news now (this Mac's box always; a machine's while a
// bridge that does runs). A client shows its own only where it isn't.

import { followed } from "../follow";
import { TOLD_FOLDER, tellingNow, toldFollowers, toldLately } from "../notices/told";
import type { AnswerPiece, RouteContext } from "../server/context";

const lately = () => ({ telling: tellingNow(), ...toldLately() });

/** `GET kuvo/notices`: what's been told lately; `GET kuvo/notices/events`: that, a line now and one each time it changes. */
export async function* noticesRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  if (route === "kuvo/notices") return yield* json(200, lately());
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(lately, toldFollowers, signal, { folders: [TOLD_FOLDER], recursive: false });
}
