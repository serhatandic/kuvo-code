// The box's server for clients, kept running by its keeper (#333 piece 3; PROTOCOL.md, "Kept for
// clients"): while a client wants one (`run/serve.needed`, `kuvo/box/serve`), `bin/kuvo-start`
// keeps `kuvo-link.js serve --kept` running on a box whose app doesn't run its own `serve` (a
// machine's; a Mac's own box has its app's keeper, or its helper, run that). It answers clients'
// routes as `serve` does, streams included, where `run/serve.json` says (`{pid, port, password,
// kept}`), and nothing else: what the box does in the background stays with what does it there
// (its link, `run`, and the keeper), so nothing is done twice. It goes once it isn't wanted, or
// another took its place.

import fs from "node:fs";
import path from "node:path";
import { runsAs } from "../shared/platform";
import { isObject, parsed } from "../shared/json";
import { writePrivate } from "../shared/files";
import { IS_MAC, RUN } from "./home";
import { keepKeeper } from "./keeper";
import type { AnswerPiece, RouteContext } from "./server/context";

export const SERVE_NEEDED = () => path.join(RUN, "serve.needed");
export const SERVE_FILE = () => path.join(RUN, "serve.json");

interface ServeRecord { pid: number; port: number; kept: boolean }
/** The command line of `serve`, and of one kept for clients. */
export const SERVE_ROLE = /kuvo-link\.js serve(\s|$)/;
export const KEPT_ROLE = /kuvo-link\.js serve --kept(\s|$)/;
/** Where `serve` answers now, as its record says, when that process runs as `serve` (its number
 * taken since by another process isn't believed). */
export function runningServe(): ServeRecord | null {
  try {
    const record = JSON.parse(fs.readFileSync(SERVE_FILE(), "utf8"));
    if (isObject(record) && Number.isInteger(record.pid) && runsAs(record.pid, record.kept === true ? KEPT_ROLE : SERVE_ROLE)) {
      return { pid: record.pid as number, port: Number(record.port), kept: record.kept === true };
    }
  } catch {}
  return null;
}

/** The kept server, stopped (after an update, for the keeper to start the new one): only one this
 * keeper keeps, never a Mac's own. */
export function stopKeptServe() {
  const running = runningServe();
  if (running?.kept && running.pid !== process.pid) try { process.kill(running.pid, "SIGTERM"); } catch {}
}

/** `kuvo/box/serve`: whether a client wants the box's server kept running here (`GET`, for any client), and asking
 * for it or letting it go (`POST {needed}`, from Kuvo Code itself). Asked for, the keeper's started
 * should it have gone; it starts the server within its next round (15 s at most). A Mac's own box
 * answers 409: its app's keeper, or its helper, runs its server. */
export async function* serveRoute({ request, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return yield* json(405, {});
  if (IS_MAC) return yield* json(409, { message: "This Mac's box has its server run by Kuvo Code itself." });
  if (method === "POST") {
    if (!request.fromApp && !request.fromMac) return yield* json(403, { message: "Only Kuvo Code asks for the box's server." });
    const given = parsed(request.body);
    if (!isObject(given) || typeof given.needed !== "boolean") return yield* json(400, { message: "Say whether it's needed (needed: true or false)." });
    if (given.needed) {
      writePrivate(SERVE_NEEDED(), "");
      keepKeeper();
    } else {
      fs.rmSync(SERVE_NEEDED(), { force: true });
    }
  }
  const running = runningServe();
  return yield* json(200, { needed: fs.existsSync(SERVE_NEEDED()), serving: running !== null });
}
