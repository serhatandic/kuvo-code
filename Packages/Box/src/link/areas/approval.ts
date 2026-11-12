// `kuvo/approval` and `kuvo/sessions/<id>/approval`: how much a conversation's agent does on its own,
// kept on the box (PROTOCOL.md, "Approval"; the rules in `../work/approval.ts`). A client reads a
// conversation's (what it is, what it comes to here now, and which it can pick) and sets it; and
// this computer's Full Access switch. The box keeps each conversation's rules to what it comes to
// as the sandbox starts or stops and the switch changes (`keepApprovals`), and a bot's conversation
// from before there were approvals starts with this computer's default, as a new one (`adoptBots`).

import fs from "node:fs";
import path from "node:path";
import { isObject, parsed } from "../../shared/json";
import { BOX, BRIDGE_FILE } from "../home";
import { bridgeTarget, engineGet, readEngineFile } from "../engine/client";
import { rewriteOn } from "../engine/notes";
import { allowFullAccess, allowOtherComputers, APPROVALS, approvalOf, approvalRules, approvalsSince, defaultApproval, effectiveApproval, fullAccessAllowed, heldOf, isApproval, madeBefore, otherComputersAllowed, rememberApproval, unavailable } from "../work/approval";
import { resumeReviewedSession } from "../work/goals";
import { heldMark, nothingCountsOnIt } from "../fence/state";
import { sandboxOn } from "../work/sandbox";
import { approveHeld, clearFetched, clearPlaces, resumeReviews, reviewLog, revokePlace, seeHeld, shownReviews } from "../work/reviewer";
import { noteFolderFound, tellApproved } from "../work/reviewing";
import { markConversation } from "../work/full";
import { botOfConversation, worksFor } from "../work/tree";
import { listBots } from "../bots/list";
import { permissionsHere } from "../bots/tell";
import type { Approval } from "../work/approval";
import type { KitRule } from "../bots/kit";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { Rewritten } from "../../shared/session-notes";
import type { Target } from "../../shared/records";
import type { ApprovalHere, SessionApproval } from "../../shared/routes/approval";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_APPROVAL_ROUTE = /^kuvo\/sessions\/([^/]+)\/approval$/;
/** A conversation's decisions by Auto's reviewer. */
export const SESSION_DECISIONS_ROUTE = /^kuvo\/sessions\/([^/]+)\/decisions$/;

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
 * already so. */
function changeFor(at: Found, wanted: Approval): { permissions: KitRule[]; metadata: Record<string, unknown> } | null {
  const current = (at.data.permissions ?? []) as KitRule[];
  const { approval } = effectiveApproval(wanted, { agents: at.agents });
  const permissions = approvalRules(approval, current, heldOf(at.data));
  const metadata = at.data.metadata ?? {};
  const kuvo = isObject(metadata.kuvo) ? metadata.kuvo : {};
  if (JSON.stringify(permissions) === JSON.stringify(current) && kuvo.approval === wanted && kuvo.applied === approval) return null;
  return { permissions, metadata: { ...metadata, kuvo: { ...kuvo, approval: wanted, applied: approval } } };
}

/** The conversation changed in its turn (`../engine/notes.ts`): read as it is then, and given the
 * rules and notes of the approval `wanted` says for it as it is (null: none to change), changing
 * only those and the approval's own notes. `at` takes it as it is then. True once it's so; false
 * where the engine didn't answer or take it, or it's gone. */
async function write(at: Found, wanted: (now: Found) => Approval | null, signal?: AbortSignal): Promise<boolean> {
  let done: Rewritten<EngineSession> | null;
  try {
    done = await rewriteOn(at.target, at.data.id, data => {
      const now = found(at.target, data, at.agents);
      const approval = wanted(now);
      return approval ? changeFor(now, approval) : null;
    }, signal);
  } catch {
    return false;
  }
  if (!done) return false;
  Object.assign(at, found(at.target, done.session, at.agents));
  return true;
}

/** The approval a conversation is to be kept with now, where its rules are made for something else
 * than it comes to (the sandbox started or stopped, the switch changed, and the box hasn't come
 * round to it), or it's a bot's from before there were approvals (kept with the one its rules
 * say: Ask First, or this computer's default), or a new one waiting for its own; null where
 * nothing's left to do. */
function toSettle(at: Found): Approval | null {
  const now = approvalOf(at.data, { agents: at.agents, bot: at.bot });
  if (now.stored ? now.applied === now.effective && !madeBefore(at.data.permissions ?? [], now.effective) : !(at.bot || now.pending)) return null;
  return now.approval;
}

/** A conversation kept with an approval whose rules are made for something else than it comes to
 * now, its rules made for what it comes to (`toSettle`), as it is in its turn. True where
 * nothing's left to do. */
async function settle(at: Found, signal?: AbortSignal): Promise<boolean> {
  return !toSettle(at) || await write(at, toSettle, signal);
}

/** A conversation kept with an approval, its rules made again for it with Settings › Permissions
 * as they are now, as it is in its turn. True where nothing's left to do. */
async function remake(at: Found, signal?: AbortSignal): Promise<boolean> {
  const kept = (now: Found) => {
    const is = approvalOf(now.data, { agents: now.agents, bot: now.bot });
    return is.stored ? is.approval : null;
  };
  return !kept(at) || await write(at, kept, signal);
}

/** A conversation a client just made, without a kept approval: the one it was made with
 * (`kuvo.approval` alone), else this computer's default (`defaultApproval`), kept with it and its
 * rules made for that. A bot's, a subagent's and one the box made itself are left as they are. */
export async function adoptConversation(target: Target, id: unknown, agents: boolean, signal?: AbortSignal): Promise<void> {
  if (typeof id !== "string" || !id) return;
  const data = (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
  if (!data?.id) return;
  // (Where its folder is now is where its own is: `reviewing.ts`.)
  await noteFolderFound(data.location?.directory).catch(() => {});
  const at = found(target, data, agents);
  const now = approvalOf(at.data, { agents, bot: at.bot });
  if (!now.pending) return;
  const asked = at.data.metadata?.kuvo?.approval;
  // (Read again just before it's written: one a client set meanwhile wins.)
  const again = (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
  if (!again?.id || again.metadata?.kuvo?.approval !== asked || again.metadata?.kuvo?.applied !== undefined) return;
  if (isApproval(asked)) rememberApproval(asked);
  await settle(at, signal);
  markConversation(at.data.id, approvalOf(at.data, { agents, bot: at.bot }).effective === "fullAccess");
}

/** The newest conversations a client made that are still waiting for their approval (one whose
 * event the box missed, or couldn't settle then), each adopted (`adoptConversation`). */
export async function adoptPending(engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<void> {
  const since = approvalsSince();
  const byDefault = defaultApproval();
  for (const [target, agents] of [[engine, false], [bridge, true]] as const) {
    if (!target) continue;
    const page = await engineGet(target, "api/session?limit=20&order=desc&parentID=null").catch(() => null) as { data?: unknown } | null;
    for (const data of Array.isArray(page?.data) ? page.data as EngineSession[] : []) {
      if (data?.id && approvalOf(data, { agents, bot: found(target, data, agents).bot }, since, byDefault).pending) await adoptConversation(target, data.id, agents, signal).catch(() => {});
    }
  }
}

/** The same for a conversation the box just made or changed, read again: what it comes to may have
 * changed while it was written (the sandbox stopped), and the box's round, which looks only when
 * that changes, may have passed it by. */
export async function settleAgain(target: Target, id: string, agents: boolean, signal?: AbortSignal): Promise<void> {
  const data = (await engineGet(target, `api/session/${encodeURIComponent(id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
  if (!data?.id) return;
  const at = found(target, data, agents);
  await settle(at, signal);
  markConversation(at.data.id, approvalOf(at.data, { agents, bot: at.bot }).effective === "fullAccess");
}

type Refusal = { status: 404 | 409 | 502 | 503; value: { message: string; reason?: string } };

/** Sets a conversation's approval, here: 200 with it as clients read it, 404 for none here, 409
 * for one it can't be set to (Full Access without its switch: and why), 502 where
 * the engine didn't take it. Auto without the sandbox is kept, and asks first until it runs. */
export async function setApproval(id: string, wanted: Approval, engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<{ status: 200; value: SessionApproval } | Refusal> {
  if (!engine && !bridge) return { status: 503, value: { message: "The engine isn't running." } };
  const at = await find(id, engine, bridge);
  if (!at) return { status: 404, value: { message: "That conversation isn't here." } };
  const not = unavailable(wanted, { agents: at.agents });
  if (not && not.reason !== "sandbox") return { status: 409, value: { message: not.why, reason: not.reason } };
  if (!await write(at, () => wanted, signal)) return { status: 502, value: { message: "It couldn't be changed: the engine didn't take it. Try again." } };
  // (The next new conversation here starts with it, a bot's pick too: never a subagent's.)
  if (!at.data.parentID) rememberApproval(wanted);
  // (What it comes to may have changed while it was written.)
  await settle(at, signal);
  // Its commands from now on in the sandbox or outside it, at once (and its next run's subagents).
  const effective = approvalOf(at.data, { agents: at.agents, bot: at.bot }).effective;
  markConversation(at.data.id, effective === "fullAccess");
  // Out of Auto, the folders it allowed edits in go with it.
  if (effective !== "auto") try { clearPlaces(at.data.id); } catch {}
  return { status: 200, value: shown(at) };
}

/** This computer's: whether Full Access may be picked, and whether Auto can run, for the engine's
 * conversations and the coding agents'. */
export function approvalHere(): ApprovalHere {
  const auto = (agents: boolean) => {
    const not = unavailable("auto", { agents });
    return not ? { held: not } : {};
  };
  return { fullAccess: fullAccessAllowed(), default: defaultApproval(), auto: { engine: auto(false), agents: auto(true) }, otherComputers: otherComputersAllowed() };
}

/** Each conversation kept with an approval that comes to something else now (the sandbox started
 * or stopped, the switch changed), its rules made for what it comes to: only those whose rules are
 * still the box's, never one a client changed on its own since, each read again just before it's
 * written. With `settings` (Settings › Permissions changed), every one kept with an approval whose
 * rules aren't made from them as they are now, too. True once every one is so; false where the
 * engine didn't answer or take one (tried again on the next round). */
export async function reapplyApprovals(engine: Target | null, bridge: Target | null, settings = false): Promise<boolean> {
  let done = true;
  // (This computer's, read once for the round: thousands of conversations may be looked at.)
  const since = approvalsSince();
  const byDefault = defaultApproval();
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
        const now = approvalOf(data, { agents, bot }, since, byDefault);
        // (Full Access's list for the sandbox's launcher, as each is now: one from before too.)
        markConversation(data.id, now.effective === "fullAccess");
        // Out of Auto (the sandbox stopped, its rules changed by a client): the folders it allowed go.
        if (now.effective !== "auto") try { clearPlaces(data.id); } catch {}
        // (Settings › Permissions changed: any kept with an approval, whose rules don't follow them yet.)
        const remade = settings && now.stored && changeFor(found(target, data, agents), now.approval) !== null;
        // (Ask First and Accept Edits come to themselves anywhere; a bot's from before, to its own.)
        if (!remade && kept !== "auto" && kept !== "fullAccess" && !(bot && kept === undefined) && !now.pending) continue;
        if (!remade && (now.stored ? now.applied === now.effective && !madeBefore(data.permissions ?? [], now.effective) : !(bot || now.pending))) continue;
        // (As it is now: what a client set since the list was read stays.)
        const fresh = (await engineGet(target, `api/session/${encodeURIComponent(data.id)}`).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
        if (!fresh?.id) { done = false; continue; }
        if (!await (remade ? remake(found(target, fresh, agents)) : settle(found(target, fresh, agents)))) done = false;
      }
      const next = page.cursor?.next;
      query = listed.length === 200 && next ? `limit=200&parentID=null&cursor=${encodeURIComponent(next)}` : null;
    }
  }
  return done;
}

// Settings › Permissions as the conversations' rules were last made with, by the box's round or a
// client's change (`followSettings`); null until made once as the box runs, so a change made while
// it was down reaches them too.
let settingsMade: string | null = null;
let following: Promise<void> | null = null;

/** Each conversation kept with an approval made again with Settings › Permissions as they are now,
 * one pass at a time: a second asked for meanwhile waits on the one going, and the box's round
 * catches what changed after it started. */
export function followSettings(engine: Target | null, bridge: Target | null): Promise<void> {
  following ??= (async () => {
    try {
      const settings = JSON.stringify(permissionsHere());
      if (await reapplyApprovals(engine, bridge, true)) settingsMade = settings;
    } catch {} finally {
      following = null;
    }
  })();
  return following;
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
  // (Tell Auto's rules, from a box before 0.9.184: Auto's reviewer is the box's alone now.)
  try { fs.rmSync(path.join(BOX, "tell-auto.json"), { force: true }); } catch {}
  // (From now on, a new conversation a client doesn't say gets the default.)
  try { approvalsSince(); } catch {}
  // (Scripts from the web the reviewer fetched for a box before this one: nothing runs them now.)
  clearFetched();
  let last: string | null = null;
  let going = false;
  const adopted = new Set<string>();
  every(async () => {
    const [here, agents] = [engine(), bridge()];
    // (And which hold of the sandbox is on, if any: one let go of and taken again meanwhile is a new
    // one, whose rules are made again.)
    const mark = heldMark();
    const off = !sandboxOn(false);
    const now = `${!off} ${sandboxOn(true)} ${fullAccessAllowed()} ${here?.port ?? 0} ${agents?.port ?? 0} ${mark ?? ""}`;
    if (going || following) return;
    going = true;
    try {
      // (Settings › Permissions changed, from any client or by hand in the file, or not made with
      // yet as the box runs: they reach every conversation within a round.)
      const settings = JSON.stringify(permissionsHere());
      if ((now !== last || settings !== settingsMade) && await reapplyApprovals(here, agents, settings !== settingsMade)) [last, settingsMade] = [now, settings];
      // Every conversation's rules made for the sandbox being off (Auto asks first), the engine's and
      // the coding agents' bridge's (where there's one here) both answering: what the sandbox held
      // for that, taking itself away after a failed check, goes ahead (fence/state.ts). Until then
      // it stays held, which is safe: commands still go through it.
      if (off && last === now && here && (agents || !fs.existsSync(BRIDGE_FILE))) nothingCountsOnIt(mark);
      await adoptPending(here, agents);
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
    // Whether your other computers may start work here: only that, when it's all that's said.
    if (typeof given.otherComputers === "boolean" && given.fullAccess === undefined) {
      allowOtherComputers(given.otherComputers);
      return yield* json(200, approvalHere());
    }
    if (typeof given.fullAccess !== "boolean") return yield* json(400, { message: "Say whether you confirmed Full Access on this computer (fullAccess, true or false), or whether your other computers may start work here (otherComputers, true or false)." });
    if (typeof given.otherComputers === "boolean") allowOtherComputers(given.otherComputers);
    allowFullAccess(given.fullAccess);
    // What had it, or was held from it, comes to what it can be now at once, rather than at the
    // box's next look.
    await reapplyApprovals(engine, bridge()).catch(() => false);
    return yield* json(200, approvalHere());
  }
  const decisions = idOf(route.match(SESSION_DECISIONS_ROUTE)?.[1]);
  if (decisions) {
    if (method === "GET") return yield* json(200, shownReviews(reviewLog(decisions)));
    if (method !== "POST") return yield* json(405, { message: "Read them with GET, or approve one held back (or let a paused conversation go on) with POST." });
    if (given.seen === true) {
      // Looked at on a client: what's held back by now isn't news on any of them.
      try { return yield* json(200, shownReviews(seeHeld(decisions))); }
      catch (error) { return yield* json(500, { message: `It couldn't be kept: ${String((error as Error)?.message ?? error).slice(0, 120)}` }); }
    }
    if (typeof given.approve === "string" && given.approve) {
      // Allowed once, the next time the agent does it the same way: it's told so, and goes on.
      let approved: ReturnType<typeof approveHeld>;
      try { approved = approveHeld(decisions, given.approve); }
      catch (error) { return yield* json(500, { message: `It couldn't be kept: ${String((error as Error)?.message ?? error).slice(0, 120)}` }); }
      if (!approved) return yield* json(404, { message: "That isn't held back here: it was approved already, or it's gone." });
      resumeReviewedSession(decisions);
      await tellApproved(decisions, approved).catch(() => false);
      return yield* json(200, shownReviews(reviewLog(decisions)));
    }
    if (typeof given.revoke === "string" && given.revoke) {
      // A folder Auto allowed edits in for the session, taken back: each change there is judged again.
      let revoked: ReturnType<typeof revokePlace>;
      try { revoked = revokePlace(decisions, given.revoke); }
      catch (error) { return yield* json(500, { message: `It couldn't be kept: ${String((error as Error)?.message ?? error).slice(0, 120)}` }); }
      if (!revoked) return yield* json(404, { message: "That isn't a folder Auto allows edits in here: it was taken back already, or it's gone." });
      return yield* json(200, shownReviews(reviewLog(decisions)));
    }
    if (given.resume !== true) return yield* json(400, { message: "Say approve: <id> to approve one held back, revoke: <id> to take back a folder Auto allowed edits in, resume: true to let Auto go on here, or seen: true once you've looked." });
    try { resumeReviews(decisions); }
    catch (error) { return yield* json(500, { message: `It couldn't be kept: ${String((error as Error)?.message ?? error).slice(0, 120)}` }); }
    resumeReviewedSession(decisions);
    return yield* json(200, shownReviews(reviewLog(decisions)));
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
