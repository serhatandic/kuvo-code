// `kuvo/sessions/<id>/typed` (PROTOCOL.md, "What a typed message means"): what a conversation's
// composer offers after "/" (`GET`: its keywords, and the engine's commands as "/" lists them), and
// what a typed text means once it's sent (`POST`): the box decides (typed/decide.ts), does what's
// its own to do (a goal set, paused, resumed or taken away; a bot asked for one; Autopilot on; a
// /loop wake-up; a side question, handoff or review started), and answers with what it did and what
// the client does with the rest: send a message, run a command or a "!" command, switch Plan or
// Autopilot, compact, ask the side thread, or put what was written back in the composer, saying why.
// The client sends the files and quotes it has with what it's told to send, and keeps the rest.

import { isObject, parsed } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { SessionAutopilot } from "../../shared/routes/autopilot";
import { call } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import { isRefused, placeOfSessionPatiently } from "../letters/letter";
import { targetsOf } from "../letters/tools";
import { BUSY, collected } from "../server/sent-once";
import { askGoal } from "../work/goals";
import { isAutopilot } from "../work/autopilot";
import { listsHere, offeredHere } from "../work/model-rule";
import { botOfConversation } from "../work/tree";
import { zone } from "../work/clock";
import { decide, writtenBack, GOALS_NOT_RUNNING, KEYWORD_UNAVAILABLE, type BoxStep, type Decision, type Restore } from "../typed/decide";
import { KEYWORD_WORDS, KEYWORDS, commandsOffered, splitCommand, parseGoal, parseKeyword, type Command, type Keyword, type ModelRef, type Reader } from "../typed/words";
import { autopilotRoute } from "./autopilot";
import { answerWakes } from "./wakes";
import type { AnswerPiece, RouteContext } from "../server/context";

export const TYPED_ROUTE = /^kuvo\/sessions\/([^/]+)\/typed$/;

/** The keywords a conversation offers, as this box runs them: none in a subagent's (its work is the
 * conversation it works for's); goals, side questions, handoffs and reviews while the agents bridge
 * runs; the rest always. */
export function keywordsOffered(session: Pick<EngineSession, "parentID">, bridge: boolean): Keyword[] {
  if (session.parentID) return [];
  return KEYWORDS.filter(keyword => (keyword === "goal" || keyword === "review" || keyword === "btw" || keyword === "handoff" ? bridge : true));
}

/** The engine's commands in `folder`, as it lists them; null when it can't be asked. */
async function engineCommands(engine: Target | null, folder: string | undefined, signal?: AbortSignal): Promise<Command[] | null> {
  if (!engine) return [];
  try {
    const listed = await call(engine, "GET", "/api/command", undefined, within(signal, 10_000), folder);
    return Array.isArray(listed) ? listed.flatMap(each => (isObject(each) && typeof each.name === "string" ? [{ name: each.name, ...(typeof each.description === "string" ? { description: each.description } : {}) }] : [])) : [];
  } catch {
    return null;
  }
}

/** The models "/review with …" can name: the engine's you can use now (a review runs beside it). */
async function reviewReaders(engine: Target | null, folder: string | undefined): Promise<Reader[]> {
  if (!engine) return [];
  const lists = await listsHere(engine, null, folder).catch(() => null);
  if (!lists?.engine) return [];
  const accounts = lists.engine.accounts;
  return offeredHere(lists).filter(model => !model.agents && !model.retiring).map(model => ({
    name: model.name,
    ref: { providerID: model.providerID, id: model.id },
    provider: model.providerID === "opencode" ? "OpenCode Zen" : accounts.get(model.providerID)?.name ?? model.providerID,
  }));
}

const refOf = (value: unknown): ModelRef | null =>
  isObject(value) && typeof value.providerID === "string" && typeof value.id === "string" ? { providerID: value.providerID, id: value.id } : null;

/** The request's own signal, and at most `ms` more: a stalled engine or bridge never holds the
 * composer's next message (each client sends it after this answer). */
const within = (signal: AbortSignal | undefined, ms: number): AbortSignal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
/** How long the box waits on its engine or bridge for one step. */
const STEP_PATIENCE = 30_000;

/** A message the bridge (or a route) answered with, as words to show. */
const said = (error: unknown, otherwise: string) => (error instanceof Error && error.message ? error.message : otherwise);

/** What the box did for it, as the answer says it. */
type Done = { goal?: unknown; goalCleared?: true; askedBot?: true; autopilot?: SessionAutopilot; wakeUp?: { due: number; every: string; note: string }; sideQuestion?: unknown; handoff?: unknown; review?: unknown };

/** One of the box's routes asked from here, as a client would: its status and JSON. */
async function routeAnswer(pieces: AsyncIterable<AnswerPiece>): Promise<{ status: number; value: Record<string, unknown> }> {
  const answer = await collected(pieces);
  const value = parsed(answer.body);
  return { status: answer.status, value: isObject(value) ? value : {} };
}

async function doStep(step: BoxStep, session: string, place: { target: Target; data: Partial<EngineSession> }, context: RouteContext): Promise<Done> {
  const { request, readEngine, bridge } = context;
  const signal = within(context.signal, STEP_PATIENCE);
  const agents = bridge();
  const at = (path: string) => `/api/kuvo/${path}/${encodeURIComponent(session)}`;
  switch (step.do) {
    case "goal": {
      if (!agents) throw new Error(GOALS_NOT_RUNNING);
      const { command } = step;
      if (command.kind === "set") return { goal: await call(agents, "PUT", at("goals"), { condition: command.words }, signal) };
      if (command.kind === "pause") return { goal: await call(agents, "POST", `${at("goals")}/pause`, undefined, signal) };
      if (command.kind === "resume") return { goal: await call(agents, "POST", `${at("goals")}/resume`, undefined, signal) };
      await call(agents, "DELETE", at("goals"), undefined, signal);
      return { goalCleared: true };
    }
    case "askBot": {
      const outcome = await askGoal(session, step.words, () => targetsOf({ readEngine, bridge }));
      if ("refused" in outcome) throw new Error(outcome.refused.message);
      return { askedBot: true };
    }
    case "autopilot": {
      // On already: nothing to change.
      if (isAutopilot(place.data)) return {};
      const route = `kuvo/sessions/${encodeURIComponent(session)}/autopilot`;
      const answer = await routeAnswer(autopilotRoute({ ...context, route, request: { ...request, method: "PUT", path: route, body: Buffer.from(JSON.stringify({ autopilot: true })) } }));
      if (answer.status !== 200) throw new Error(typeof answer.value.message === "string" ? answer.value.message : "Autopilot couldn’t be turned on. Try again.");
      return { autopilot: answer.value as unknown as SessionAutopilot };
    }
    case "wake": {
      const route = `kuvo/wakes/${encodeURIComponent(session)}`;
      const body = { due: step.due, every: step.every, note: step.note };
      const answer = await routeAnswer(answerWakes(session, undefined, { ...request, method: "POST", path: route, body: Buffer.from(JSON.stringify(body)) }, readEngine, bridge, signal));
      if (answer.status !== 200) throw new Error(typeof answer.value.message === "string" ? answer.value.message : "The wake-up couldn’t be saved. Try again.");
      return { wakeUp: body };
    }
    case "btw":
    case "handoff":
    case "review": {
      if (!agents) throw Object.assign(new Error("unavailable"), { unavailable: true });
      if (step.do === "btw") return { sideQuestion: await call(agents, "POST", at("btw"), { question: step.question }, signal) };
      if (step.do === "handoff") return { handoff: await call(agents, "POST", at("handoff"), { next: step.next ?? undefined }, signal) };
      return { review: await call(agents, "POST", at("reviews"), { ...(step.model ? { model: step.model } : {}), ...(step.focus ? { focus: step.focus } : {}), ...(step.scope ? { scope: step.scope } : {}) }, signal) };
    }
  }
}

/** The answer, as clients read it: what the box did, then what the client does (PROTOCOL.md). */
function answerOf(decision: Decision, done: Done, failure: { restore: Restore; error: string } | null) {
  const { box: _box, failed: _failed, restore, error, send, command, ...steps } = decision;
  // Its step failed: nothing of the rest is done, and what was written goes back.
  if (failure) return { ...(decision.keyword ? { keyword: decision.keyword } : {}), restore: failure.restore, error: failure.error };
  return { ...steps, ...done, ...(command ? { command } : {}), ...(send ? { send } : {}), ...(restore ? { restore } : {}), ...(error ? { error } : {}) };
}

export async function* typedRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return yield* json(405, { message: "Read what it offers with GET, or send what was typed with POST." });
  let session = "";
  try { session = decodeURIComponent(match[1]); } catch {}
  if (!session) return yield* json(404, { message: "There's no such conversation here." });
  const given = parsed(request.body);
  const body = isObject(given) ? given : {};
  if (method === "POST" && typeof body.text !== "string") return yield* json(400, { message: "Send what was typed (text)." });
  // A send it can't answer for: what was written goes back as a keyword's does, saying why.
  const back = method === "POST" ? { restore: writtenBack(body.text as string) } : {};
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running.", ...back });
  // (Patiently, as a message's send is: a busy computer's engine can take a while to answer.)
  let place: Awaited<ReturnType<typeof placeOfSessionPatiently>>;
  try {
    place = await placeOfSessionPatiently(session, targets);
  } catch (error) {
    return yield* json(503, { message: isRefused(error) ? "The engine isn't running." : BUSY, ...back });
  }
  if (!place) return yield* json(404, { message: "There's no such conversation here.", ...back });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine?.port) engine = null;
  const agents = bridge();
  const data = place.data;
  const folder = data.location?.directory ?? data.directory;
  const keywords = keywordsOffered(data, agents !== null);

  if (method === "GET") {
    const commands = await engineCommands(engine, folder, signal);
    return yield* json(200, {
      keywords: keywords.map(name => ({ name, ...KEYWORD_WORDS[name] })),
      commands: commandsOffered(commands ?? [], keywords),
    });
  }

  const text = body.text as string;
  // What a "/" message needs: the engine's commands (a message that may name one), the models a
  // review can be read by, whether a goal is there to show.
  const slash = splitCommand(text) !== null;
  const commands = slash ? await engineCommands(engine, folder, signal) : [];
  const typed = parseKeyword(text);
  const onAgents = agents !== null && place.target.port === agents.port;
  const readers = typed?.keyword === "review" && !onAgents ? await reviewReaders(engine, folder) : [];
  const hasGoal = parseGoal(text)?.kind === "show" && agents ? await call(agents, "GET", `/api/kuvo/goals/${encodeURIComponent(session)}`, undefined, within(signal, 10_000)).then(() => true, () => false) : false;
  const decision = decide(text, {
    keywords,
    commands: commands ?? [],
    files: body.files === true,
    side: body.side === true,
    refusal: typeof body.refusal === "string" && body.refusal.trim() ? body.refusal : null,
    readers,
    reviewer: refOf(body.reviewer),
    subagent: Boolean(data.parentID),
    hasGoal,
    botChat: botOfConversation(session) !== null,
    bridge: agents !== null,
    now: Date.now(),
    timeZone: zone(),
  });
  // The engine's commands unread: a keyword or goal goes on without them; what might have been one
  // of them can't be told from a message, and waits.
  if (commands === null && (decision.send || decision.sideThread)) return yield* json(503, { message: "The engine didn't answer. Try again in a moment.", restore: { text } });
  let done: Done = {};
  let failure: { restore: Restore; error: string } | null = null;
  if (decision.box) {
    try {
      done = await doStep(decision.box, session, place, context);
    } catch (error) {
      // The bridge not reached (its record there, and nothing answering, or no answer in time),
      // rather than one that said no: as it isn't running, not in the runtime's words.
      const step = decision.box.do;
      const unreached = !(isObject(error) && typeof error.status === "number");
      const unavailable = (isObject(error) && error.unavailable === true) || ((step === "btw" || step === "handoff" || step === "review") && unreached);
      if (step === "goal" && unreached) error = new Error(GOALS_NOT_RUNNING);
      failure = unavailable
        ? { restore: { text }, error: KEYWORD_UNAVAILABLE }
        : { restore: decision.failed ?? { text }, error: said(error, "It couldn’t be done. Try again.") };
    }
  }
  return yield* json(200, answerOf(decision, done, failure));
}
