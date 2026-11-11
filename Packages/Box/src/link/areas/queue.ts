// A session's queue, as every client reads and changes it (PROTOCOL.md, "The queue"): whether it
// waits for Resume, what Stop held and what waits on the box, followed as it changes; Stop, Resume,
// Send Now, and a client's own message to wait with it.

import { isObject, parsed } from "../../shared/json";
import { wakeMarkOf } from "../../shared/queues";
import { MOVING } from "../bots/here";
import { frozen, liveMoves } from "../moves/records";
import { followed } from "../follow";
import { placeOfSession, placeOfSessionPatiently } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { asked } from "../engine/client";
import { dropWaiting, holdQueue, inboxFor, keepWaitingBefore, queueFollowers, queueOf, readQueues, resumeQueue, sendNow, showsQueue, shownQueue } from "../engine/queue";
import { forgetStopped } from "../work/background";
import { stopConversation } from "../work/background";
import { messageID } from "../engine/sessions";
import { attachedIn } from "../server/attached";
import { fromPhone, modelInput } from "../server/forward";
import { namedIn, namingHere } from "../server/naming";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Target } from "../../shared/records";

export const QUEUE_ROUTE = /^kuvo\/sessions\/(?:queues\/events|([^/]+)\/(stop|queue(?:\/(hold|resume|add))?|queue\/([^/]+)(?:\/(now))?))$/;

// What a queue change says when the engine here runs but is too busy to answer in time (504,
// `busy`): it isn't down, and the change can be asked again in a moment.
export const BUSY = "This computer is busy: its engine didn't answer in time. Try again in a moment.";

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
  // One moving to or from another computer: what waits for it goes as it was read for the move. A
  // Stop still stops it while the box it leaves waits for its turn to end, before it's read.
  const stopping = action === "stop" || step === "hold";
  const settling = () => liveMoves().some(move => move.role === "from" && move.stage === "holding" && (move.thing === session || move.sessions.includes(session)));
  if (frozen().has(session) && !(stopping && settling())) return yield* json(409, { message: MOVING });
  if (item && !now) {
    if (method !== "DELETE") return yield* json(405, {});
    // (The engine's inbox, for what came after it; none when it can't be read.)
    const place = await placeOfSession(session, targetsOf({ readEngine, bridge })).catch(() => null);
    const dropped = dropWaiting(session, decodeURIComponent(item), place ? await inboxFor(place.target, session) : []);
    if (!dropped) return yield* json(404, { message: "That message isn't waiting any more." });
    // What it was, whole, for Undo to add back as it was, where it was (`queue/add` with `kept`,
    // and `before`, what came after it).
    const { from, text: words } = dropped.shown;
    const removed = dropped.message ? { ...dropped.message, ...(from ? { from } : {}), words, ...(dropped.before ? { before: dropped.before } : {}) } : undefined;
    return yield* json(200, { ...shownQueue(queueOf(session)), ...(removed ? { removed } : {}) });
  }
  if (method !== "POST") return yield* json(405, {});
  // Only an engine that isn't here isn't running: one that's only slow to answer (a busy computer)
  // is asked again, and still slow, says so, for its client to try again (#443).
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  const place = await placeOfSessionPatiently(session, targets).catch(() => undefined);
  if (place === undefined) return yield* json(504, { message: BUSY, busy: true });
  if (!place) return yield* json(404, { message: "There's no such conversation here." });
  try {
    if (action === "stop") return yield* json(200, shownQueue(await stopConversation(place.target, { ...place.data, id: session })));
    if (step === "hold") {
      // (`{items}`: messages a client held as they went, first.)
      const given = parsed(request.body);
      const items = isObject(given) && Array.isArray(given.items) ? given.items.filter((id): id is string => typeof id === "string") : [];
      return yield* json(200, shownQueue(await holdQueue(place.target, session, undefined, items)));
    }
    if (step === "add") return yield* add(context, place.target, session);
    // (You set it going: if it was stopped, what comes of it is news again.)
    forgetStopped(session);
    if (step === "resume") return yield* json(200, shownQueue(await resumeQueue(place.target, session)));
    if (!(await sendNow(place.target, session, decodeURIComponent(item)))) return yield* json(404, { message: "That message isn't waiting any more." });
    return yield* json(200, shownQueue(queueOf(session)));
  } catch (error) {
    return yield* json(502, { message: String((error as Error | null)?.message ?? error) });
  }
}

// A client's own message for the queue (Undo, or one sent after this run while it's paused): its
// files kept on the box as a message's are (`attachedIn`), then waiting there while the queue is
// paused, else to the engine as it asked. `{id?, text, files?, delivery?, from?, words?, before?, metadata?}`
// (`words`: how it's shown, as you wrote it; `before`: Undo's, what came after it, which it goes
// back ahead of; `metadata`: only a wake-up's mark, `wakeMark`, kept with it); `waits` says which. `kept`: one a DELETE gave back (Undo), as it was kept already.
async function* add({ request, bridge, readEngine, json, signal }: RouteContext, target: Target, session: string): AsyncGenerator<AnswerPiece> {
  const given = parsed(request.body);
  if (!isObject(given) || typeof given.text !== "string" || (!given.text.trim() && !(Array.isArray(given.files) && given.files.length))) return yield* json(400, { message: "Send {\"text\": …}." });
  const id = typeof given.id === "string" && /^msg_[A-Za-z0-9]{1,80}$/.test(given.id) ? given.id : messageID();
  const delivery = given.delivery === "steer" ? "steer" : "queue";
  const from = typeof given.from === "string" && given.from.trim() ? given.from.trim().slice(0, 80) : undefined;
  const base = new URL(`http://127.0.0.1:${target.port}/`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const toAgents = bridge()?.port === target.port;
  const mark = wakeMarkOf(given.metadata);
  const asGiven = Buffer.from(JSON.stringify({ id, text: given.text, ...(Array.isArray(given.files) ? { files: given.files } : {}), delivery, ...(mark ? { metadata: mark } : {}) }));
  // (A phone's also says who it names with "&", and that it's from the phone, as its prompt would.)
  const fromPhoneToo = request.fromMac !== true && request.fromApp !== true;
  const attached = given.kept === true ? asGiven : await attachedIn(asGiven, session, modelInput(base, headers, signal), request.fromMac === true, !toAgents);
  const body = given.kept !== true && fromPhoneToo ? fromPhone(await namedIn(attached, session, namingHere(readEngine))) : attached;
  const message = parsed(body) as { id: string; text: string; files?: unknown[]; delivery: "steer" | "queue"; metadata?: Record<string, unknown> };
  // Shown as written (`words`: without what the client added for the agent, like its files' notes),
  // or, put back, as it was shown.
  const words = typeof given.words === "string" ? given.words : given.kept !== true ? given.text : undefined;
  const before = typeof given.before === "string" && /^[A-Za-z0-9_]{1,100}$/.test(given.before) ? given.before : undefined;
  if (await keepWaitingBefore(target, session, message, { from, words }, before)) return yield* json(200, { ...shownQueue(queueOf(session)), waits: true });
  // (A busy engine takes the message late, and has it then: waited for, not given up on at the
  // usual half minute and said to have failed, #443.)
  await asked(target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, message, 120_000);
  return yield* json(200, { ...shownQueue(queueOf(session)), waits: false });
}
