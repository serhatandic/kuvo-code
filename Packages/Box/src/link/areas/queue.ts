// A session's queue, as every client reads and changes it (PROTOCOL.md, "The queue"): whether it
// waits for Resume, what Stop held and what waits on the box, followed as it changes; Stop, Resume,
// Send Now, and a client's own message to wait with it.

import { isObject, parsed } from "../../shared/json";
import { followed } from "../follow";
import { placeOfSession } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { asked } from "../engine/client";
import { dropWaiting, holdQueue, keepWaiting, queueFollowers, queueOf, readQueues, resumeQueue, sendNow, showsQueue, shownQueue, stopSession } from "../engine/queue";
import { messageID } from "../engine/sessions";
import { attachedIn } from "../server/attached";
import { fromPhone, modelInput } from "../server/forward";
import { namedIn, namingHere } from "../server/naming";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Target } from "../../shared/records";

export const QUEUE_ROUTE = /^kuvo\/sessions\/(?:queues\/events|([^/]+)\/(stop|queue(?:\/(hold|resume|add))?|queue\/([^/]+)(?:\/(now))?))$/;

// `kuvo/sessions/queues/events`: every queue that's paused or holds something, a line now and one
// each time that changes. `GET kuvo/sessions/<id>/queue`: one session's. `POST …/stop`: what waits
// held and paused, then the run stopped. `POST …/queue/hold`: held and paused without stopping.
// `POST …/queue/resume`: the queue goes on. `POST …/queue/<item>/now`: that message right away.
// `POST …/queue/add`: a client's message for the queue, waiting on the box while it's paused (else
// to the engine). `DELETE …/queue/<item>`: one waiting on the box taken away.
export async function* queueRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  const [, rawSession, action, step, item, now] = match;
  if (!rawSession) {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(() => ({ queues: Object.fromEntries(Object.entries(readQueues()).filter(([, state]) => showsQueue(state)).map(([session, state]) => [session, shownQueue(state)])) }), queueFollowers, signal);
  }
  const session = decodeURIComponent(rawSession);
  if (action === "queue" && !step && !item) {
    if (method !== "GET") return yield* json(405, {});
    return yield* json(200, shownQueue(queueOf(session)));
  }
  if (item && !now) {
    if (method !== "DELETE") return yield* json(405, {});
    const dropped = dropWaiting(session, decodeURIComponent(item));
    if (!dropped) return yield* json(404, { message: "That message isn't waiting any more." });
    // What it was, whole, for Undo to add back as it was (`queue/add` with `kept`).
    const { from, text: words } = dropped.shown;
    const removed = dropped.message ? { ...dropped.message, ...(from ? { from } : {}), words } : undefined;
    return yield* json(200, { ...shownQueue(queueOf(session)), ...(removed ? { removed } : {}) });
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
    if (step === "add") return yield* add(context, place.target, session);
    if (step === "resume") return yield* json(200, shownQueue(await resumeQueue(place.target, session)));
    if (!(await sendNow(place.target, session, decodeURIComponent(item)))) return yield* json(404, { message: "That message isn't waiting any more." });
    return yield* json(200, shownQueue(queueOf(session)));
  } catch (error) {
    return yield* json(502, { message: String((error as Error | null)?.message ?? error) });
  }
}

// A client's own message for the queue (Undo, or one sent after this run while it's paused): its
// files kept on the box as a message's are (`attachedIn`), then waiting there while the queue is
// paused, else to the engine as it asked. `{id?, text, files?, delivery?, from?}`; `waits` says which.
// `kept`: one a DELETE gave back (Undo), as it was kept already, shown with its `words`.
async function* add({ request, bridge, readEngine, json, signal }: RouteContext, target: Target, session: string): AsyncGenerator<AnswerPiece> {
  const given = parsed(request.body);
  if (!isObject(given) || typeof given.text !== "string" || (!given.text.trim() && !(Array.isArray(given.files) && given.files.length))) return yield* json(400, { message: "Send {\"text\": …}." });
  const id = typeof given.id === "string" && /^msg_[A-Za-z0-9]{1,80}$/.test(given.id) ? given.id : messageID();
  const delivery = given.delivery === "steer" ? "steer" : "queue";
  const from = typeof given.from === "string" && given.from.trim() ? given.from.trim().slice(0, 80) : undefined;
  const base = new URL(`http://127.0.0.1:${target.port}/`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const toAgents = bridge()?.port === target.port;
  const asGiven = Buffer.from(JSON.stringify({ id, text: given.text, ...(Array.isArray(given.files) ? { files: given.files } : {}), delivery }));
  // (A phone's also says who it names with "&", and that it's from the phone, as its prompt would.)
  const fromPhoneToo = request.fromMac !== true && request.fromApp !== true;
  const attached = given.kept === true ? asGiven : await attachedIn(asGiven, session, modelInput(base, headers, signal), request.fromMac === true, !toAgents);
  const body = given.kept !== true && fromPhoneToo ? fromPhone(await namedIn(attached, session, namingHere(readEngine))) : attached;
  const message = parsed(body) as { id: string; text: string; files?: unknown[]; delivery: "steer" | "queue" };
  // Shown as written (not with what was added for the agent), or, put back, as it was shown.
  const words = given.kept !== true ? given.text : typeof given.words === "string" ? given.words : undefined;
  if (keepWaiting(session, message, { from, words })) return yield* json(200, { ...shownQueue(queueOf(session)), waits: true });
  await asked(target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, message);
  return yield* json(200, { ...shownQueue(queueOf(session)), waits: false });
}
