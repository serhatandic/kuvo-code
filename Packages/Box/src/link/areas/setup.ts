// `kuvo/setup` (PROTOCOL.md, "Your setup"): who's in your setup and who its main computer is, as
// this box says it, on every box, for every client; and its events, a line now and one as it changes.
// `POST kuvo/setup/judge`: what a Mac adding a computer found there over SSH, judged by this box.
// `POST kuvo/setup/attached`: Kuvo Code on this computer attached to this box in place.

import fs from "node:fs";
import path from "node:path";
import { parsed, type Body } from "../../shared/json";
import { writePrivate } from "../files";
import { RUN } from "../home";
import { followed } from "../follow";
import { writeCard } from "../setup/card";
import { appsOf, ATTACHED_FILE, foundOf, judgeComputer, oursNow } from "../setup/judge";
import { setupView } from "../setup/view";
import { onLinkWritten, readLink } from "../state";
import type { AnswerPiece, RouteContext } from "../server/context";

// Those following it here: told as this process writes link.json; what another process wrote
// (`setup` and `leave`, over SSH), looked for each second (`followed`, with no folder to watch).
const followers = new Set<() => void>();
onLinkWritten(() => {
  for (const tell of followers) tell();
});

export async function* setupRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, signal, json } = context;
  const method = request.method.toUpperCase();
  if (route === "kuvo/setup/judge") {
    if (method !== "POST") return yield* json(405, {});
    // The probe's lines as it printed them (RemoteEngineInstaller's, in OpenCodeKit).
    const given = parsed(request.body) as Body<"probe">;
    if (typeof given?.probe !== "string" || given.probe.length > 200_000) return yield* json(400, { message: "Send what the probe printed, as probe." });
    const lines = given.probe.split("\n");
    return yield* json(200, judgeComputer(foundOf(lines), oursNow(readLink()), appsOf(lines)));
  }
  if (route === "kuvo/setup/attached") {
    if (method !== "POST") return yield* json(405, {});
    // Only Kuvo Code on this computer (`kuvo-link.js box route`), or its app beside its box.
    if (!request.fromMac && !request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer says it attached." });
    // Kept for good (an app that's gone again still asks before a join: the safe way to be wrong).
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(RUN, ATTACHED_FILE))) writePrivate(path.join(RUN, ATTACHED_FILE), JSON.stringify({ at: Date.now() }));
    writeCard();
    return yield* json(200, {});
  }
  if (method !== "GET" && method !== "HEAD") return yield* json(405, {});
  if (route === "kuvo/setup/events") {
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => setupView(readLink()), followers, signal);
  }
  return yield* json(200, setupView(readLink()));
}
