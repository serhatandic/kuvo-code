// A session's queue, as every client reads and changes it (PROTOCOL.md, "The queue"): whether it
// waits for Resume and what Stop held, followed as it changes; Stop, Resume and Send Now.

import { isObject, parsed } from "../../shared/json";
import { followed } from "../follow";
import { placeOfSession } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { holdQueue, queueFollowers, queueOf, readQueues, resumeQueue, sendNow, shownQueue, stopSession } from "../engine/queue";
import type { AnswerPiece, RouteContext } from "../server/context";

export const QUEUE_ROUTE = /^kuvo\/sessions\/(?:queues\/events|([^/]+)\/(stop|queue(?:\/(hold|resume))?|queue\/([^/]+)\/now))$/;

// `kuvo/sessions/queues/events`: every queue that's paused or holds something, a line now and one
// each time that changes. `GET kuvo/sessions/<id>/queue`: one session's. `POST …/stop`: what waits
// held and paused, then the run stopped. `POST …/queue/hold`: held and paused without stopping.
// `POST …/queue/resume`: the queue goes on. `POST …/queue/<item>/now`: that message right away.
export async function* queueRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  const [, rawSession, action, step, item] = match;
  if (!rawSession) {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ queues: Object.fromEntries(Object.entries(readQueues()).filter(([, state]) => state.paused || state.held.length).map(([session, state]) => [session, shownQueue(state)])) }), queueFollowers, signal);
  }
  const session = decodeURIComponent(rawSession);
  if (action === "queue" && !step && !item) {
    if (method !== "GET") return yield* json(405, {});
    return yield* json(200, shownQueue(queueOf(session)));
  }
  if (method !== "POST") return yield* json(405, {});
  const place = await placeOfSession(session, targetsOf({ readEngine, bridge })).catch(() => undefined);
  if (place === undefined) return yield* json(503, { message: "The engine isn't running." });
  if (!place) return yield* json(404, { message: "There's no such conversation here." });
  try {
    if (action === "stop") return yield* json(200, shownQueue(await stopSession(place.target, session)));
    if (step === "hold") {
      // (`{items}`: messages a client held as they went, first.)
      const given = parsed(request.body);
      const items = isObject(given) && Array.isArray(given.items) ? given.items.filter((id): id is string => typeof id === "string") : [];
      return yield* json(200, shownQueue(await holdQueue(place.target, session, undefined, items)));
    }
    if (step === "resume") return yield* json(200, shownQueue(await resumeQueue(place.target, session)));
    if (!(await sendNow(place.target, session, decodeURIComponent(item)))) return yield* json(404, { message: "That message isn't waiting any more." });
    return yield* json(200, shownQueue(queueOf(session)));
  } catch (error) {
    return yield* json(502, { message: String((error as Error | null)?.message ?? error) });
  }
}
