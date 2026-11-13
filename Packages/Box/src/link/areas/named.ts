// Who `&` can name in a message here (`kuvo/named`), as a Mac's composer offers them.

import { ownAgentsNow, ownAsLast } from "../peers/agents";
import { readPeerAgents } from "../peers/directory";
import { movedOf, peersOf } from "../peers/known";
import { namedAgents } from "../peers/naming";
import { readLink } from "../state";
import type { Named } from "../../shared/routes/box";
import type { AnswerPiece, RouteContext } from "../server/context";

// Who `&` can name in a message here, as a Mac's composer offers them: this machine's bots and
// latest sessions (`machine` null), then those its other computers told it of.
export async function* namedRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const link = readLink();
  // Its own as last worked out while its engine can't say (starting), rather than none.
  const fresh = await ownAgentsNow(readEngine, link?.id ?? null).catch(() => null);
  const own = fresh ?? ownAsLast(link?.id ?? null);
  return yield* json(200, { agents: namedAgents(own, peersOf(link), readPeerAgents(), movedOf(link)) } satisfies Named);
}
