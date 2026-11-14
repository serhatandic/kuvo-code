// A session's queue, as every client reads and changes it (PROTOCOL.md, "The queue"): whether it
// waits for Resume, what Stop held and what waits on the box, followed as it changes; Stop, Resume,
// Send Now, and a client's own message to wait with it.

import { isObject, parsed } from "../../shared/json";
import { wakeMarkOf } from "../../shared/queues";
import { MOVING } from "../bots/here";
import { frozen, liveMoves } from "../moves/records";
import { followed, followedLive } from "../follow";
import { isRefused, placeOfSession, placeOfSessionPatiently } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { asked } from "../engine/client";
import { dropWaiting, holdQueue, inboxFollowers, inboxFor, inboxNow, keepWaitingBefore, queueFollowers, queueItems, queueOf, readQueues, resumeQueue, sendNow, showsQueue, shownQueue, takeBackFromInbox } from "../engine/queue";
import type { QueueShown } from "../../shared/routes/sessions";
import { forgetStopped } from "../work/background";
import { stopConversation } from "../work/stopping";
import { messageID } from "../engine/sessions";
import { attachedIn } from "../server/attached";
import { fieldsOf, keptParts, withParts, withPartsOf } from "../messages/parts";
import { composed, isEmpty, NotListed, sentAgain } from "./messages";
import type { Composed } from "./messages";
import { fromPhone, modelInput } from "../server/forward";
import { namedIn, namingHere } from "../server/naming";
import { answering, BUSY, collected, forgetSent, SENDING_PATIENCE, sentKey, sentOnce } from "../server/sent-once";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { Target } from "../../shared/records";

export const QUEUE_ROUTE = /^kuvo\/sessions\/(?:queues\/events|([^/]+)\/(stop|queue(?:\/(hold|resume|add|events))?|queue\/([^/]+)(?:\/(now))?))$/;

// How long the queue's read waits for the engine, each time (where the session is, then its inbox):
// a client draws it at once, and a busy engine's `items` are null rather than late.
const ITEMS_WAIT = 2_000;

/** `session`'s queue as a client shows it, with every message waiting (`items`, in their order;
 * null while the engine or the coding agents' bridge, where it may be, can't be read). */
async function queueShown(session: string, targets: Target[]): Promise<QueueShown> {
  const state = queueOf(session);
  let inbox: Awaited<ReturnType<typeof inboxNow>> | null = [];
  try {
    const place = targets.length ? await placeOfSession(session, targets, ITEMS_WAIT) : undefined;
    if (place === undefined) inbox = null;
    else if (place) inbox = await inboxNow(place.target, session, ITEMS_WAIT);
  } catch {
    inbox = null;
  }
  return { ...shownQueue(state), items: inbox === null ? null : queueItems(inbox, state) };
}


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
    return yield* json(200, await queueShown(session, targetsOf({ readEngine, bridge })));
  }
  // One session's queue followed, its items too: again as the box changes it, or the engine's
  // inbox for it does (`session.inbox.*`), and a look each second at what another process changed.
  if (step === "events") {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followedLive(() => queueShown(session, targetsOf({ readEngine, bridge })), told => {
      const heard = (changed: string) => { if (changed === session) told(); };
      queueFollowers.add(told);
      inboxFollowers.add(heard);
      return () => { queueFollowers.delete(told); inboxFollowers.delete(heard); };
    }, signal ?? undefined, { look: () => JSON.stringify(shownQueue(queueOf(session))) });
  }
  // One moving to or from another computer: what waits for it goes as it was read for the move. A
  // Stop still stops it while the box it leaves waits for its turn to end, before it's read.
  const stopping = action === "stop" || step === "hold";
  const settling = () => liveMoves().some(move => move.role === "from" && move.stage === "holding" && (move.thing === session || move.sessions.includes(session)));
  if (frozen().has(session) && !(stopping && settling())) return yield* json(409, { message: MOVING });
  if (item && !now) {
    if (method !== "DELETE") return yield* json(405, {});
    // (The engine's inbox, for what came after it; none when it can't be read.)
    // (Undefined: where it is couldn't be read.)
    const place = await placeOfSession(session, targetsOf({ readEngine, bridge })).catch(() => undefined);
    const dropped = dropWaiting(session, decodeURIComponent(item), place ? await inboxFor(place.target, session) : []);
    if (!dropped) {
      if (place === undefined && targetsOf({ readEngine, bridge }).length) return yield* json(503, { message: "The engine isn't answering." });
      // One the engine (or the coding agents' bridge) holds, taken back from its inbox, answered as
      // one waiting on the box is, for Edit to put back in the composer.
      let taken: Awaited<ReturnType<typeof takeBackFromInbox>> = null;
      if (place) {
        try {
          taken = await takeBackFromInbox(place.target, session, decodeURIComponent(item));
        } catch (error) {
          return yield* json(502, { message: String((error as Error | null)?.message ?? error) });
        }
      }
      if (!taken) return yield* json(404, { message: "That message isn't waiting any more." });
      forgetSent(session, decodeURIComponent(item));
      return yield* json(200, { ...shownQueue(queueOf(session)), removed: taken });
    }
    // Put back with Undo under the same id, it's added again.
    forgetSent(session, decodeURIComponent(item));
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
  let place: Awaited<ReturnType<typeof placeOfSessionPatiently>>;
  try {
    place = await placeOfSessionPatiently(session, targets);
  } catch (error) {
    // Nothing listening where its record says: it isn't running. Else it's there, and too busy.
    if (isRefused(error)) return yield* json(503, { message: "The engine isn't running." });
    return yield* json(504, { message: BUSY, busy: true });
  }
  if (!place) return yield* json(404, { message: "There's no such conversation here." });
  try {
    if (action === "stop") return yield* json(200, shownQueue(await stopConversation(place.target, { ...place.data, id: session })));
    if (step === "hold") {
      // (`{items}`: messages a client held as they went, first.)
      const given = parsed(request.body);
      const items = isObject(given) && Array.isArray(given.items) ? given.items.filter((id): id is string => typeof id === "string") : [];
      return yield* json(200, shownQueue(await holdQueue(place.target, session, undefined, items)));
    }
    if (step === "add") {
      // Sent again under its id (the phone's link dropped before the answer came, #144): added once,
      // every send answered as the one that went (`sentOnce`).
      const once = sentKey("queue", session, request.body);
      const target = place.target;
      if (!once) return yield* add(context, target, session);
      return yield* answering(await sentOnce(once, () => collected(add(context, target, session))));
    }
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
// paused, else to the engine as it asked. Its forms (`id?`, `files?`, `delivery?`, `from?`,
// `before?` and `metadata?` with each):
// - `{words, keyword?, widget?, comments?, named?, notes?}`: a message's fields
//   (`kuvo/sessions/<id>/send`'s); the box writes what the agent reads.
// - `{text, again: true, words?}`: one sent before, sent again as the agent read it (`words`: how
//   it's shown); its parts read from it.
// - `{text, kept: true, words?, metadata?}`: one a DELETE gave back (Undo), as it was kept already,
//   with the parts it had.
// `before`: Undo's, what came after it, which it goes back ahead of; `metadata`: a wake-up's mark
// (`wakeMark`), kept with it. `waits` says whether it waits on the box.
async function* add({ request, bridge, readEngine, json, signal }: RouteContext, target: Target, session: string): AsyncGenerator<AnswerPiece> {
  const given = parsed(request.body);
  if (!isObject(given)) return yield* json(400, { message: "Send what was written (words)." });
  const id = typeof given.id === "string" && /^msg_[A-Za-z0-9]{1,80}$/.test(given.id) ? given.id : messageID();
  const files = Array.isArray(given.files) ? given.files : [];
  const toAgents = bridge()?.port === target.port;
  const mark = wakeMarkOf(given.metadata) ?? undefined;
  const shownAs = (fallback: string | undefined) => (typeof given.words === "string" ? given.words : fallback);
  // A message's fields.
  const fields = typeof given.text !== "string" && given.kept !== true ? fieldsOf(given) : null;
  if (fields) {
    if (isEmpty(fields, files)) return yield* json(400, { message: "There's nothing to send." });
    let message: Composed;
    try {
      message = await composed(fields, files, session, target, toAgents, request, readEngine, signal, mark);
    } catch (error) {
      if (error instanceof NotListed) return yield* json(409, { message: error.message });
      throw error;
    }
    return yield* added({ json }, target, session, given, { id, text: message.text, files: message.files, metadata: message.metadata }, fields.words);
  }
  if (typeof given.text !== "string" || (!given.text.trim() && !files.length)) return yield* json(400, { message: "Send what was written (words)." });
  // Sent again as the agent read it.
  if (given.again === true) {
    const message = await sentAgain(given.text, files, session, target, toAgents, signal, mark);
    return yield* added({ json }, target, session, given, { id, text: message.text, files: message.files, metadata: message.metadata }, shownAs(undefined));
  }
  // Put back as it was kept, with its parts.
  if (given.kept === true) {
    const parts = keptParts(given.metadata);
    const metadata = parts ? withParts(mark, parts) : withPartsOf(mark, given.text);
    return yield* added({ json }, target, session, given, { id, text: given.text, files, metadata }, shownAs(undefined));
  }
  // COMPAT(0.7 own-envelope): one a client wrote the blocks of itself (`text`, no `again`). Goes 3 months after 0.8.0.
  const delivery = given.delivery === "steer" ? "steer" : "queue";
  const base = new URL(`http://127.0.0.1:${target.port}/`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const asGiven = Buffer.from(JSON.stringify({ id, text: given.text, ...(files.length ? { files } : {}), delivery, ...(mark ? { metadata: mark } : {}) }));
  // (A phone's also says who it names with "&", and that it's from the phone, as its prompt would.)
  const fromPhoneToo = request.fromMac !== true && request.fromApp !== true;
  const attached = await attachedIn(asGiven, session, modelInput(base, headers, signal), request.fromMac === true, !toAgents);
  const body = fromPhoneToo ? fromPhone(await namedIn(attached, session, namingHere(readEngine))) : attached;
  const message = parsed(body) as { id: string; text: string; files?: unknown[]; delivery: "steer" | "queue"; metadata?: Record<string, unknown> };
  // Shown as written (`words`: without what the client added for the agent, like its files' notes).
  return yield* added({ json }, target, session, given, { id: message.id, text: message.text, files: message.files, metadata: withPartsOf(message.metadata, message.text) }, shownAs(given.text));
}

// What `add` adds, its text written: waiting on the box while the queue is paused, else to the
// engine, as `given` asked (its id, delivery, `from` and `before`); `words`, how it's shown.
async function* added({ json }: Pick<RouteContext, "json">, target: Target, session: string, given: Record<string, unknown>, written: { id: string; text: string; files?: unknown[]; metadata?: Record<string, unknown> }, words: string | undefined): AsyncGenerator<AnswerPiece> {
  const { id } = written;
  const delivery = given.delivery === "steer" ? "steer" : "queue";
  const from = typeof given.from === "string" && given.from.trim() ? given.from.trim().slice(0, 80) : undefined;
  const message = { id, text: written.text, ...(written.files?.length ? { files: written.files } : {}), delivery, ...(written.metadata ? { metadata: written.metadata } : {}) } as { id: string; text: string; files?: unknown[]; delivery: "steer" | "queue"; metadata?: Record<string, unknown> };
  const before = typeof given.before === "string" && /^[A-Za-z0-9_]{1,100}$/.test(given.before) ? given.before : undefined;
  if (await keepWaitingBefore(target, session, message, { from, words }, before)) return yield* json(200, { ...shownQueue(queueOf(session)), waits: true });
  // (A busy engine takes the message late, and has it then: waited for, not given up on at the
  // usual half minute and said to have failed, #443.)
  await asked(target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, message, SENDING_PATIENCE.ms);
  return yield* json(200, { ...shownQueue(queueOf(session)), waits: false });
}
