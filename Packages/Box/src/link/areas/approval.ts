// `kuvo/approval` and `kuvo/sessions/<id>/approval`: how much a conversation's agent does on its own,
// kept on the box (PROTOCOL.md, "Approval"; the rules in `../work/approval.ts`). A client reads a
// conversation's (what it is, what it comes to here now, and which it can pick) and sets it; and
// this computer's Full Access switch. The box keeps each conversation's rules to what it comes to
// as the sandbox starts or stops and the switch changes (`keepApprovals`), and a bot's conversation
// from before there were approvals to Auto's (`adoptBots`).

import { isObject, parsed } from "../../shared/json";
import { bridgeTarget, call, engineGet, readEngineFile } from "../engine/client";
import { allowFullAccess, alwaysFor, APPROVALS, approvalOf, approvalRules, effectiveApproval, fullAccessAllowed, isApproval, unavailable } from "../work/approval";
import { resumeReviewedSession, runningGoal } from "../work/goals";
import { sandboxOn } from "../work/sandbox";
import { resumeReviews, reviewLog, setTellAuto, tellAuto } from "../work/reviewer";
import { botOfConversation, worksFor } from "../work/tree";
import { listBots } from "../bots/list";
import type { Approval } from "../work/approval";
import type { KitRule } from "../bots/kit";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { Target } from "../../shared/records";
import type { ApprovalHere, SessionApproval } from "../../shared/routes/approval";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_APPROVAL_ROUTE = /^kuvo\/sessions\/([^/]+)\/approval$/;
/** A conversation's decisions by Auto's reviewer. */
export const SESSION_DECISIONS_ROUTE = /^kuvo\/sessions\/([^/]+)\/decisions$/;

/** How long the box waits on the engine for one conversation. */
const WAIT = 30_000;

/** A conversation where it is: on the engine, or the coding agents' (`agents`); a bot's own or its
 * work's (`bot`). */
interface Found {
  target: Target;
  data: EngineSession;
  agents: boolean;
  bot: boolean;
}

const found = (target: Target, data: EngineSession, agents: boolean): Found =>
  ({ target, data, agents, bot: Boolean(botOfConversation(data.id) || worksFor(data)) });

async function find(id: string, engine: Target | null, bridge: Target | null): Promise<Found | null> {
  const route = `api/session/${encodeURIComponent(id)}`;
  for (const [target, agents] of [[engine, false], [bridge, true]] as const) {
    if (!target) continue;
    const data = (await engineGet(target, route).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
    if (data?.id) return found(target, data, agents);
  }
  return null;
}

/** A conversation's approval as clients read it: what it is, what it comes to here now and why
 * that's less, and each one it can be set to: why not where it can't (Full Access), and why it
 * would ask first for now where it's held (Auto without the sandbox). */
function shown(at: Found): SessionApproval {
  const where = { agents: at.agents, bot: at.bot };
  const { approval, stored, effective, held } = approvalOf(at.data, where);
  return {
    approval, effective, stored,
    ...(held ? { held } : {}),
    plan: at.data.agent === "plan",
    options: APPROVALS.map(each => {
      const not = unavailable(each, where);
      return { approval: each, ...(not ? (not.reason === "sandbox" ? { held: not } : { unavailable: not }) : {}) };
    }),
  };
}

/** The rules and notes a conversation gets for `wanted`: what it comes to here now, its rules made
 * for that, and both kept with it (with the rest of its notes as they are). Null where they're
 * already so. A bot's keep what always comes to you, and publishing where its goal or its rules
 * asked it. */
function changeFor(at: Found, wanted: Approval): { permissions: KitRule[]; metadata: Record<string, unknown> } | null {
  const current = (at.data.permissions ?? []) as KitRule[];
  const { approval } = effectiveApproval(wanted, { agents: at.agents, bot: at.bot });
  const goal = runningGoal(worksFor(at.data)?.bot);
  const permissions = approvalRules(approval, current, alwaysFor(current, at.bot, Boolean(goal && !goal.public.some(step => step.on))));
  const metadata = at.data.metadata ?? {};
  const kuvo = isObject(metadata.kuvo) ? metadata.kuvo : {};
  if (JSON.stringify(permissions) === JSON.stringify(current) && kuvo.approval === wanted && kuvo.applied === approval) return null;
  return { permissions, metadata: { ...metadata, kuvo: { ...kuvo, approval: wanted, applied: approval } } };
}

/** Writes `change` to the conversation, and takes what the engine kept: true once it's there. */
async function write(at: Found, change: NonNullable<ReturnType<typeof changeFor>>, signal?: AbortSignal): Promise<boolean> {
  const wait = AbortSignal.timeout(WAIT);
  try {
    await call(at.target, "PATCH", `/api/session/${encodeURIComponent(at.data.id)}`, change, signal ? AbortSignal.any([signal, wait]) : wait);
  } catch {
    return false;
  }
  at.data = { ...at.data, permissions: change.permissions as EngineSession["permissions"], metadata: change.metadata };
  return true;
}

/** A conversation kept with an approval whose rules are made for something else than it comes to
 * now (the sandbox started or stopped, the switch changed, and the box hasn't come round to it):
 * its rules made for what it comes to. A bot's from before there were approvals is kept with the
 * one its rules say (Auto, or Ask First), so it comes to what that does here, and stays so. True
 * where nothing's left to do. */
async function settle(at: Found, signal?: AbortSignal): Promise<boolean> {
  const now = approvalOf(at.data, { agents: at.agents, bot: at.bot });
  if (now.stored ? now.applied === now.effective : !at.bot) return true;
  const change = changeFor(at, now.approval);
  return !change || await write(at, change, signal);
}

/** The same for a conversation the box just made or changed, read again: what it comes to may have
 * changed while it was written (the sandbox stopped), and the box's round, which looks only when
 * that changes, may have passed it by. */
export async function settleAgain(target: Target, id: string, agents: boolean, signal?: AbortSignal): Promise<void> {
  const data = (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
  if (data?.id) await settle(found(target, data, agents), signal);
}

type Refusal = { status: 404 | 409 | 502 | 503; value: { message: string; reason?: string } };

/** Sets a conversation's approval, here: 200 with it as clients read it, 404 for none here, 409
 * for one it can't be set to (Full Access without its switch, or for a bot's: and why), 502 where
 * the engine didn't take it. Auto without the sandbox is kept, and asks first until it runs. */
export async function setApproval(id: string, wanted: Approval, engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<{ status: 200; value: SessionApproval } | Refusal> {
  if (!engine && !bridge) return { status: 503, value: { message: "The engine isn't running." } };
  const at = await find(id, engine, bridge);
  if (!at) return { status: 404, value: { message: "That conversation isn't here." } };
  const not = unavailable(wanted, { agents: at.agents, bot: at.bot });
  if (not && not.reason !== "sandbox") return { status: 409, value: { message: not.why, reason: not.reason } };
  const change = changeFor(at, wanted);
  if (change && !await write(at, change, signal)) return { status: 502, value: { message: "It couldn't be changed: the engine didn't take it. Try again." } };
  // (What it comes to may have changed while it was written.)
  await settle(at, signal);
  return { status: 200, value: shown(at) };
}

/** This computer's: whether Full Access may be picked, and whether Auto can run, for the engine's
 * conversations and the coding agents'. */
export function approvalHere(): ApprovalHere {
  const auto = (agents: boolean) => {
    const not = unavailable("auto", { agents });
    return not ? { held: not } : {};
  };
  return { fullAccess: fullAccessAllowed(), tellAuto: tellAuto(), auto: { engine: auto(false), agents: auto(true) } };
}

/** Each conversation kept with an approval that comes to something else now (the sandbox started
 * or stopped, the switch changed), its rules made for what it comes to: only those whose rules are
 * still the box's, never one a client changed on its own since, each read again just before it's
 * written. True once every one is so; false where the engine didn't answer or take one (tried again
 * on the next round). */
export async function reapplyApprovals(engine: Target | null, bridge: Target | null): Promise<boolean> {
  let done = true;
  for (const [target, agents] of [[engine, false], [bridge, true]] as const) {
    if (!target) continue;
    let query: string | null = "limit=200&order=desc&parentID=null";
    for (let pages = 0; pages < 15 && query; pages++) {
      const page = await engineGet(target, `api/session?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: string } | null } | null;
      if (!page) return false;
      const listed = Array.isArray(page.data) ? page.data as EngineSession[] : [];
      for (const data of listed) {
        if (!data?.id) continue;
        const kept = data.metadata?.kuvo?.approval;
        const bot = found(target, data, agents).bot;
        // (Ask First and Accept Edits come to themselves anywhere; a bot's from before, to its own.)
        if (kept !== "auto" && kept !== "fullAccess" && !(bot && kept === undefined)) continue;
        const now = approvalOf(data, { agents, bot });
        if (now.stored ? now.applied === now.effective : !bot) continue;
        // (As it is now: what a client set since the list was read stays.)
        const fresh = (await engineGet(target, `api/session/${encodeURIComponent(data.id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
        if (!fresh?.id) { done = false; continue; }
        if (!await settle(found(target, fresh, agents))) done = false;
      }
      const next = page.cursor?.next;
      query = listed.length === 200 && next ? `limit=200&parentID=null&cursor=${encodeURIComponent(next)}` : null;
    }
  }
  return done;
}

const ownEngine = (): Target | null => {
  try {
    const engine = readEngineFile();
    return engine?.port ? engine : null;
  } catch {
    return null;
  }
};

/** Each bot's own conversation from before there were approvals (one made by a box from before,
 * or moved here), kept with the one its rules say, once: `done`, those already looked at. */
async function adoptBots(engine: Target | null, bridge: Target | null, done: Set<string>): Promise<void> {
  for (const bot of listBots()) {
    const target = bot.agents ? bridge : engine;
    if (!target || done.has(bot.session)) continue;
    const data = (await engineGet(target, `api/session/${encodeURIComponent(bot.session)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
    if (data?.id && await settle(found(target, data, bot.agents))) done.add(bot.session);
  }
}

/** Kept so as the box runs: each round, what Auto and Full Access come to here, and which engine
 * and bridge run (one started again finds its conversations as they were); when that changed (and
 * once as it starts), the conversations kept with them made again, until every one is; and each
 * new bot's from before, once. `every`: what runs its round (a test's runs each by hand). */
export function keepApprovals(engine: () => Target | null = ownEngine, bridge: () => Target | null = bridgeTarget, every: (round: () => Promise<void>) => void = round => { setInterval(round, 2_000).unref?.(); }): void {
  let last: string | null = null;
  let going = false;
  const adopted = new Set<string>();
  every(async () => {
    const [here, agents] = [engine(), bridge()];
    const now = `${sandboxOn(false)} ${sandboxOn(true)} ${fullAccessAllowed()} ${here?.port ?? 0} ${agents?.port ?? 0}`;
    if (going) return;
    going = true;
    try {
      if (now !== last && await reapplyApprovals(here, agents)) last = now;
      await adoptBots(here, agents, adopted);
    } catch {} finally {
      going = false;
    }
  });
}

const idOf = (part: string | undefined) => {
  try { return decodeURIComponent(part ?? ""); } catch { return ""; }
};

export async function* approvalRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, json, route, signal, readEngine, bridge } = context;
  const method = request.method.toUpperCase();
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (!engine?.port) engine = null;
  if (route === "kuvo/approval") {
    if (method === "GET") return yield* json(200, approvalHere());
    if (method !== "PATCH") return yield* json(405, { message: "Read it with GET, or change it with PATCH." });
    if (given.fullAccess === undefined && given.tellAuto === undefined) return yield* json(400, { message: "Say whether Full Access may be picked here (fullAccess, true or false), or your rules for Auto (tellAuto, in words)." });
    if (given.fullAccess !== undefined && typeof given.fullAccess !== "boolean") return yield* json(400, { message: "fullAccess is true or false." });
    if (given.tellAuto !== undefined && typeof given.tellAuto !== "string") return yield* json(400, { message: "tellAuto is your rules for Auto, in words." });
    if (typeof given.tellAuto === "string") setTellAuto(given.tellAuto);
    if (typeof given.fullAccess !== "boolean") return yield* json(200, approvalHere());
    allowFullAccess(given.fullAccess);
    // What had it, or was held from it, comes to what it can be now at once, rather than at the
    // box's next look.
    await reapplyApprovals(engine, bridge()).catch(() => false);
    return yield* json(200, approvalHere());
  }
  const decisions = idOf(route.match(SESSION_DECISIONS_ROUTE)?.[1]);
  if (decisions) {
    const shownLog = (log: ReturnType<typeof reviewLog>) => ({ decisions: log.decisions, ...(log.paused ? { paused: log.paused } : {}) });
    if (method === "GET") return yield* json(200, shownLog(reviewLog(decisions)));
    if (method !== "POST") return yield* json(405, { message: "Read them with GET, or let a paused conversation go on with POST." });
    if (given.resume !== true) return yield* json(400, { message: "Say resume: true to let Auto go on here." });
    const resumed = resumeReviews(decisions);
    resumeReviewedSession(decisions);
    return yield* json(200, shownLog(resumed));
  }
  const id = idOf(route.match(SESSION_APPROVAL_ROUTE)?.[1]);
  if (!id) return yield* json(404, { message: "That conversation isn't here." });
  if (method !== "GET" && method !== "PUT") return yield* json(405, { message: "Read it with GET, or set it with PUT." });
  if (method === "PUT" && !isApproval(given.approval)) return yield* json(400, { message: `approval is one of ${APPROVALS.join(", ")}.` });
  if (!engine && !bridge()) return yield* json(503, { message: "The engine isn't running." });
  if (method === "PUT") {
    const set = await setApproval(id, given.approval as Approval, engine, bridge(), signal);
    return yield* json(set.status, set.value);
  }
  const at = await find(id, engine, bridge());
  if (!at) return yield* json(404, { message: "That conversation isn't here." });
  return yield* json(200, shown(at));
}
