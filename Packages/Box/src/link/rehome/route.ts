// `kuvo/box/rehome` (PROTOCOL.md, "Moving this Mac's box"): how moving this Mac's box into a home
// of its own stands, for a client to show (the box decides when, and keeps count); and Move Now or
// Move Back, asked by Kuvo Code itself, which the keeper acts on as it next asks `rehome --ready`.

import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import type { RehomeStatus } from "../../shared/routes/box";
import { APP_FOLDER, K, REAL_BOX, homeFolder } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import { askRehome } from "./move";
import { rehomeStatus } from "./state";

/** Where this box's move is kept: in its own home (a box in a home of its own, moved or never in an
 * app's folder), or for the app's box in its folder, the home it moves to: the account's
 * `~/.kuvo-code`, or the folder a copy names (`KUVO_MACHINE_ROOT`, a name in your home folder). A
 * copy that isn't the real app's names none: it never reads or asks the real one's. */
export function rehomeHome(): string | null {
  if (!APP_FOLDER) return K;
  const root = process.env.KUVO_MACHINE_ROOT;
  if (root && !root.includes("/") && root !== "." && root !== "..") return path.join(homeFolder(), root);
  return REAL_BOX ? path.join(homeFolder(), ".kuvo-code") : null;
}

const NOTHING_YET: RehomeStatus = {
  state: null, way: null, step: null, tries: 0, nextTry: null, waitingSince: null, overdue: false, failed: null,
  movedAt: null, keptUntil: null, owed: [], asked: null, from: null, to: null,
};

export async function* rehomeRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  const home = rehomeHome();
  if (method === "GET") return yield* json(200, home ? rehomeStatus(home) : NOTHING_YET);
  if (method !== "POST") return yield* json(405, {});
  // (Kuvo Code asks, having asked you: never a phone, which shows it.)
  if (!request.fromApp && !request.fromMac) return yield* json(403, { message: "Only Kuvo Code on this Mac moves its box." });
  const given = parsed(request.body);
  const ask = isObject(given) ? (given.now === true ? "now" : given.back === true ? "back" : null) : null;
  if (!ask) return yield* json(400, { message: "Say Move Now (now) or Move Back (back)." });
  if (!home) return yield* json(409, { message: "This copy of Kuvo Code has no home to move its box to." });
  const refused = askRehome(home, ask);
  return yield* (refused ? json(409, { message: refused }) : json(200, rehomeStatus(home)));
}
