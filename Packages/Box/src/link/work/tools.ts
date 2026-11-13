// The tools a conversation runs its sessions with (PROTOCOL.md, "Work"): list_sessions, where each
// it started stands; stop_session, one of them stopped; compact_session, one of them summarized to
// free up its context; answer_ask, what one asks, answered within
// what the asker may do itself; list_models, what a session can be started on; make_project, a new
// project made (asking you first, once for a bot if you say Always); list_projects, the projects
// here. Every box answers them alike, through `POST kuvo/agent-tools`.

import { call, readBridgeFile, readEngineFile } from "../engine/client";
import { callerOf, untilOnAutopilot } from "../vault/who";
import { agentsCommandsInSandbox, engineCommandsInSandbox, fenceWhole } from "../fence/state";
import { holdArchived } from "../areas/wakes";
import { noteWorkChanged } from "./changes";
import { noteOversightBy } from "./oversight";
import { callOf, keepAnswer, noteSession, pendingAsk, permissionWords, ruleFor, rulesOf, withDefaults, type PendingPermission } from "./answers";
import { permissionsHere } from "../bots/tell";
import { allowRefusal } from "./policy";
import { approvalOf } from "./approval";
import { appsNamed, finishGoal, goalProgress, goalProject, maySpend, progressRefused, proposalRefused, proposeGoal, runningGoal } from "./goals";
import { findApps } from "./apps";
import { isObject } from "../../shared/json";
import fs from "node:fs";
import path from "node:path";
import { readProjects } from "../areas/projects";
import { gitIn } from "../git";
import { HERE } from "../home";
import { answerOf, askWork, botAllows, doWork } from "./asks";
import type { ResetGiven } from "./plan-reset";
import { cloneable, folderName, isEmptyFolder, namedPlace, projectPlace, shownPath } from "./projects";
import { projectsFolder } from "./settings";
import { describeModels, modelsHere } from "./models";
import { atWorkNow, stopWork } from "./background";
import { botOfConversation, contextOf, describeWork, placeWords, under, workingNow, workSessions, worksFor } from "./tree";
import type { Target } from "../../shared/records";
import type { KitRule } from "../bots/kit";
import type { SessionPlace } from "../letters/letter";
import type { ToolAnswer } from "../letters/tools";
import type { Listed } from "./tree";
import type { Row } from "./elsewhere";
import type { WorksFor } from "../../shared/routes/work";

/** The conversation calling: its root's address and place, and its name as the others know it. */
export interface Caller {
  session: string;
  place: SessionPlace;
  name: string;
}

/** Who runs its sessions with these tools, as the box it lives on knows it (`leadOf`), and as a
 * call carries it to a box its sessions are on (PROTOCOL.md, "Peers", `call`, `as`): its address,
 * its name, the bot it is, the rules it goes by there (that box's Settings › Permissions, then its
 * own conversation's), and whether its own commands run free of the sandbox (Full Access, or no
 * sandbox there). `from`: the box it lives on, for one that lives elsewhere (that box's name). */
export interface Lead {
  session: string;
  name: string;
  bot: WorksFor | null;
  rules: KitRule[];
  free: boolean;
  from?: string;
}

// Whether `target` is the coding agents' bridge rather than the engine.
const onBridge = (target: Target): boolean => { try { return readEngineFile().port !== target.port; } catch { return false; } };

/** The conversation calling, as a lead: worked out here, where it lives. */
export function leadOf(caller: Caller): Lead {
  const bot = botOfConversation(caller.session);
  const free = approvalOf(caller.place.data, { agents: onBridge(caller.place.target), bot: Boolean(bot) }).effective === "fullAccess" || !commandsInSandbox(caller.place.target, { sandboxed: true } as PendingPermission);
  return { session: caller.session, name: caller.name, bot, rules: [...(permissionsHere() ?? []), ...((caller.place.data.permissions ?? []) as KitRule[])], free };
}

/** A session of the caller's as list_sessions shows it: where it stands, its last reply, and how
 * full its context is. */
export type LiveRow = Row & { lastReply?: string; replyBeforeStop?: true; context?: { used: number } | { summarized: true } };

/** The rows of `lead`'s sessions here, the latest first, at most `most`. */
export async function liveRows(lead: string, targets: Target[], signal?: AbortSignal, most = 40): Promise<LiveRow[]> {
  const listed = (await mine(lead, targets, signal)).slice(0, most);
  if (!listed.length) return [];
  const working = await atWorkNow(targets, signal);
  const rows: LiveRow[] = [];
  for (const each of listed) {
    const work = await describeWork(each, working, { replies: true, signal });
    const context = await contextOf(each, signal);
    rows.push({ ...work, ...(context ? { context } : {}) });
  }
  return rows;
}

/** One session, in a line (and its last reply under it), as list_sessions says it. */
export function rowLine(work: LiveRow): string {
  const model = work.model ? ` · ${work.model.providerID}/${work.model.id}${work.model.variant ? ` (${work.model.variant})` : ""}` : "";
  const state = work.state === "asking" ? `asks to ${(work.asks ?? "").replace(/^Wants to /, "").replace(/\.$/, "")}${work.askID ? ` (ask ${work.askID})` : ""}` : work.state;
  const under = work.depth > 1 ? `, started by ${work.startedBy}` : "";
  const reply = work.lastReply && work.state !== "asking" ? `\n  ${work.replyBeforeStop ? "Last reply, from its turn that ended before it was stopped" : "Last reply"}: ${work.lastReply}` : "";
  const held = !work.context ? "" : "used" in work.context ? ` · ${work.context.used.toLocaleString("en-US")} tokens in context now` : " · just summarized, context size known after its next step";
  return `- ${work.title} (address ${work.session}), ${placeWords(work)}: ${state}${model}${under}${held}${work.tokens ? ` · ${work.tokens.toLocaleString("en-US")} tokens used in total` : ""}${reply}`;
}

/** The caller's sessions on another computer, as list_sessions says them: by that computer's
 * name, live, or as of when it last told (`asOf`) when it isn't answering (`away`, why). */
export interface RowsThere {
  name: string;
  rows: LiveRow[];
  asOf?: number;
  away?: string;
}

// How long ago `at` was, in words.
const ago = (at: number, now = Date.now()): string => {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 2) return "a minute ago";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
};

const said = (text: string): ToolAnswer => ({ text, isError: false });
// How long an allow given on another computer may wait to be given here.
export const ALLOW_LIFE = 86_400_000;
const refused = (text: string): ToolAnswer => ({ text, isError: true });
const why = (error: unknown) => String((error as Error | null)?.message ?? error);
// A change to the work of the bot a session works for, for clients to read it again; and, done by
// the bot itself, what it did, for clients to show it looking after its sessions.
const changed = (data: Listed["data"], did?: { kind: "stopped" | "answered"; by: Pick<Lead, "session"> }) => {
  const bot = worksFor(data)?.bot;
  if (!bot) return;
  noteWorkChanged(bot);
  if (did) noteOversightBy(did.by.session, data, did.kind);
};

// The caller's sessions (the ones it started, and theirs), the latest first.
const mine = async (lead: string, targets: Target[], signal?: AbortSignal) => under(lead, await workSessions(targets, signal));

// One of the caller's sessions by its address, or what to say when it isn't one.
async function oneOfMine(caller: Pick<Lead, "session">, session: unknown, targets: Target[], doing: string, signal?: AbortSignal): Promise<{ listed: Listed } | { error: ToolAnswer }> {
  if (typeof session !== "string" || !session.trim()) return { error: refused("Say which session (session), by its address from list_sessions.") };
  const listed = (await mine(caller.session, targets, signal)).find(each => each.data.id === session.trim());
  if (listed) return { listed };
  const any = (await workSessions(targets, signal)).find(each => each.data.id === session.trim());
  let title: string | null = any?.data.title ?? null;
  if (!any) {
    for (const target of targets) {
      const found = await call(target, "GET", `/api/session/${encodeURIComponent(session.trim())}`, undefined, signal).catch(() => null) as { title?: string } | null;
      if (found) {
        title = found.title || "New Session";
        break;
      }
    }
  }
  if (title === null) return { error: refused(`There's no session ${session.trim()} here. Use list_sessions to see yours.`) };
  return { error: refused(doing === "answer" ? `"${title}" isn't one of your sessions: only the user answers what it asks.` : `"${title}" isn't yours to ${doing}: ask the user.`) };
}

/** list_sessions' words: the caller's sessions here (`rows`), then those on each other computer
 * (`there`), live or as of when it last told. */
export function describeList(rows: LiveRow[], there: RowsThere[], now = Date.now()): ToolAnswer {
  const others = there.filter(each => each.rows.length);
  if (!rows.length && !others.length) return said("You haven't started any sessions (or they're archived). Start one with start_session.");
  const parts: string[] = [];
  if (rows.length) parts.push(`Your sessions${others.length ? ` on ${HERE}` : ""}, the latest first:\n${rows.map(rowLine).join("\n")}`);
  for (const each of others) {
    const head = each.away
      ? `On ${each.name}, as of ${each.asOf ? ago(each.asOf, now) : "when it last told"}. ${each.name} isn't answering (${each.away}): what it asks waits, and a stop or an answer you give is kept and done when it's back.`
      : `On ${each.name}, the latest first:`;
    parts.push(`${head}\n${each.rows.map(rowLine).join("\n")}`);
  }
  return said(parts.join("\n\n"));
}

/** stop_session: one of the caller's sessions stopped (what waits for it held), and put away if
 * it says so. */
export async function stopSessionTool(caller: Pick<Lead, "session" | "name">, args: Record<string, unknown>, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const found = await oneOfMine(caller, args.session, targets, "stop", signal);
  if ("error" in found) return found.error;
  const { target, data } = found.listed;
  try {
    await stopWork(target, data.id);
  } catch (error) {
    return refused(`Couldn't stop "${data.title || "New Session"}": ${why(error)}`);
  }
  changed(data, { kind: "stopped", by: caller });
  if (args.archive === true) {
    await noteSession(target, data.id, (kuvo, metadata) => {
      metadata["kuvo.archived"] = true;
      return kuvo;
    }).then(() => holdArchived(data.id, true)).catch(() => {});
    return said(`Stopped and archived "${data.title || "New Session"}".`);
  }
  return said(`Stopped "${data.title || "New Session"}".`);
}

/** compact_session: one of the caller's sessions summarizes its conversation to free up its
 * context, as its `/compact` does: what can't says why. */
export async function compactSessionTool(caller: Pick<Lead, "session" | "name">, args: Record<string, unknown>, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const found = await oneOfMine(caller, args.session, targets, "compact", signal);
  if ("error" in found) return found.error;
  const { target, data } = found.listed;
  const title = data.title || "New Session";
  const working = (await workingNow([target], signal)).has(data.id);
  let answer: unknown;
  try {
    answer = await call(target, "POST", `/api/session/${encodeURIComponent(data.id)}/compact`, {}, signal);
  } catch (error) {
    return refused(`Couldn't summarize "${title}": ${why(error)}`);
  }
  changed(data);
  // (The coding agents' bridge says; the engine takes it at its next step.)
  const state = isObject(answer) ? answer.state : undefined;
  if (state === "waiting") return said(`"${title}" will be summarized when its turn ends.`);
  if (working && state !== "compacting") return said(`"${title}" will be summarized at its next step.`);
  return said(`Summarizing "${title}" now. list_sessions shows its context size again after its next step.`);
}

/** Whether the commands `permission` asks about run in the sandbox: the engine's, as it stands; a
 * coding agent's, as the agents' bridge says of the one asking (its whole program in it, started
 * while the sandbox was on), and while it's still on; and kept from all it hides (`fenceWhole`). */
function commandsInSandbox(target: Target, permission: PendingPermission): boolean {
  let engine = false;
  try { engine = readEngineFile().port === target.port; } catch {}
  if (!fenceWhole()) return false;
  return engine ? engineCommandsInSandbox() : permission.sandboxed === true && agentsCommandsInSandbox();
}

// A project's other folders, which its sessions work in as in its own.
const projectFolders = (folder: string): readonly string[] => readProjects().find(each => each.directory === folder)?.folders ?? [];

/** answer_ask: what one of the caller's sessions asks, answered. A permission it may allow only
 * where it could go ahead itself, as its own rules and mode say, and never in a session that's in
 * Ask First (the user answers all of its asks); it may always say no. A
 * question it answers in words. Kept on the session, with why. */
export async function answerAskTool(caller: Lead, args: Record<string, unknown>, targets: Target[], signal?: AbortSignal, { made }: { made?: number } = {}): Promise<ToolAnswer> {
  const found = await oneOfMine(caller, args.session, targets, "answer", signal);
  if ("error" in found) return found.error;
  const { target, data } = found.listed;
  const title = data.title || "New Session";
  if (typeof args.ask !== "string" || !args.ask.trim()) return refused("Say which ask (ask), by its id from the [Session asks] message or list_sessions.");
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return refused("Say why, in a line (reason): the user sees it with your answer.");
  const ask = await pendingAsk(target, data.id, args.ask.trim(), signal);
  if (!ask) return refused(`"${title}" doesn't ask ${args.ask.trim()} now: it was answered, or it moved on.`);
  const by = caller.bot ?? { name: caller.name };
  if ("question" in ask) {
    const answer = typeof args.answer === "string" ? args.answer.trim() : "";
    if (!answer) return refused(`"${title}" asks: ${ask.question.text} Answer it in words (answer).`);
    if (!ask.question.key) return refused(`"${title}"'s question has more than one part: tell the user, who answers it in the session.`);
    try {
      await call(target, "POST", `/api/session/${encodeURIComponent(ask.question.asker)}/form/${encodeURIComponent(ask.question.id)}/reply`, { answer: { [ask.question.key]: answer } }, signal);
    } catch (error) {
      return refused(`Couldn't answer it: ${why(error)}`);
    }
    await keepAnswer(target, data.id, { ask: ask.question.id, what: `Asks: ${ask.question.text}`, decision: "answer", reason: `${answer}${reason ? ` (${reason})` : ""}`, by, at: Date.now() }).catch(() => {});
    changed(data, { kind: "answered", by: caller });
    return said(`Answered "${title}".`);
  }
  const { permission } = ask;
  const what = permissionWords(permission);
  const shown = permission.resources.filter(each => each !== "*").join(", ") || permission.action;
  if (args.decision !== "allow" && args.decision !== "deny") return refused("Say allow or deny (decision).");
  if (args.decision === "allow") {
    // A session in Ask First always asks the user, whatever its bot's mode: as it stands here now
    // (a Full Access or Auto that can't be had here is the lower one), on the engine or the coding
    // agents' bridge alike. The user sees the ask on the session; the bot may still say no. (First,
    // so a stale allow isn't told to be given again.)
    const mode = approvalOf(data, { agents: onBridge(target), bot: Boolean(botOfConversation(data.id) ?? worksFor(data)) });
    if (mode.effective === "askFirst") {
      const state = mode.held ? `"${title}" asks first for now (${mode.held.why.replace(/\.$/, "")})` : `"${title}" is in Ask First`;
      return refused(`You can't allow that: ${state}, so the user answers every ask it makes, whatever mode you're in. The user sees the ask on "${title}" and answers it there. Tell them in a line why it's needed if it matters, and carry on with the rest. You can still deny it.`);
    }
    // An allow given on another computer and kept while this one was away, for a day at most: by
    // then what it was given for may have changed.
    if (made !== undefined && Date.now() - made > ALLOW_LIFE) return refused(`Your allow for "${title}" wasn't given: this computer was away for over a day after you gave it, so it's out of date. Look at what it asks now (list_sessions), and answer again if it still should go ahead.`);
    const folder = data.location?.directory ?? data.directory ?? "";
    const seen = await callOf(target, permission, signal);
    // What its own conversation could do without asking, as its own rules and mode say
    // (`allowRefusal`): a command in the sandbox where its own run there (the session's, as it runs
    // here), anywhere in Full Access.
    const sandboxed = commandsInSandbox(target, permission);
    const judged = (rules: KitRule[]) => allowRefusal(permission.action, permission.resources, folder ? [folder, ...projectFolders(folder)] : [], rules, ruleFor, seen, { sandboxed, free: caller.free });
    // By the rules its own conversation goes by where it lives, and, for a lead from another
    // computer, by this computer's own as well (the engine's defaults and Settings › Permissions,
    // Don't Allow and Ask alike): each judged on its own, so moving never loosens an allow (joined
    // into one list, the last match would let this box's Allow override the lead's Ask).
    const why = judged(withDefaults(caller.rules)) ?? (caller.from ? judged(rulesOf([])) : null);
    if (why) return refused(`You can't allow that: you'd have to ask the user about it yourself. The user sees the ask on "${title}" and answers it there. Tell them in a line why it's needed, and carry on with the rest.`);
  }
  try {
    await call(target, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, args.decision === "allow" ? { decision: "once" } : { decision: "reject", message: `${by.name}: ${reason}` }, signal);
  } catch (error) {
    return refused(`Couldn't answer it: ${why(error)}`);
  }
  await keepAnswer(target, data.id, { ask: permission.id, ...(permission.call ? { call: permission.call } : {}), what, decision: args.decision, reason, by, at: Date.now() }).catch(() => {});
  changed(data, { kind: "answered", by: caller });
  return said(args.decision === "allow" ? `Allowed: ${shown}.` : `Denied: ${shown}. "${title}" is told why.`);
}

/** list_models: the models that run here, by the one rule every client's picker offers by
 * (`modelsHere`, model-rule.ts). */
export async function listModelsTool(engine: Target | null, bridge: Target | null, signal?: AbortSignal, where = HERE): Promise<ToolAnswer> {
  const here = await modelsHere(engine, bridge, undefined, where, signal);
  return said(describeModels(here.models, undefined, where, here));
}

/** make_project: a new project, in the projects folder you picked (or the folder you named for it),
 * made once you allow it (at once for a bot you said Always to, or one whose goal you started with
 * it in the plan); what it is, or why not. Waits for your answer up to `wait` ms; after that it
 * stays asked, and the conversation is told when you answer. */
export async function makeProjectTool(caller: Caller, args: Record<string, unknown>, { signal, wait, every }: { signal?: AbortSignal; wait?: number; every?: number } = {}): Promise<ToolAnswer> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return refused("Say what it's called (name).");
  if (!folderName(name)) return refused(`${name} can't be a folder's name: use letters or numbers.`);
  const clone = typeof args.clone === "string" && args.clone.trim() ? args.clone.trim() : undefined;
  if (clone && !cloneable(clone)) return refused(`${clone} isn't a repository address git can clone: give an https or ssh one.`);
  const bot = botOfConversation(caller.session);
  // In the goal you started: by its name, or by the folder you named for it there.
  const inPlan = bot ? (runningGoal(bot.bot)?.projects ?? []).map(goalProject) : [];
  let named: string | undefined;
  if (typeof args.folder === "string" && args.folder.trim()) {
    const checked = namedPlace(args.folder);
    if ("refused" in checked) return refused(checked.refused);
    named = checked.folder;
  } else {
    named = inPlan.find(each => each.folder && folderName(each.name) === folderName(name))?.folder;
  }
  const planned = inPlan.some(each => (each.folder ? each.folder === named : !named && each.name.toLowerCase() === name.toLowerCase()));
  // What would fail anyway isn't asked.
  const place = named ?? projectPlace(name);
  const listed = place ? readProjects().find(each => each.directory === place && !each.removed) : null;
  if (listed) return refused(`There's a project at ${shownPath(place!)} already: ${listed.name ?? path.basename(place!)}. Start sessions in it with start_session.`);
  if (place && fs.existsSync(place) && !isEmptyFolder(place)) return refused(`There's a folder at ${shownPath(place)} already, with files in it. ${named ? `To work on what's there, start sessions in it with start_session (folder: "${shownPath(place)}").` : "Pick another name."}`);
  const asker = { session: caller.session, name: bot?.name ?? caller.name, ...(bot ? { bot: bot.bot } : {}) };
  const action = clone ? "cloneProject" : "makeProject";
  const given = { name, ...(args.git === false ? { git: false } : {}), ...(clone ? { clone } : {}), ...(named ? { folder: named } : {}) };
  // Named in the goal you started, or allowed Always.
  if (bot && (planned || botAllows(bot.bot, action)) && (named || projectsFolder())) {
    try {
      const done = await doWork(action, given, asker);
      return done.isError ? refused(done.text) : said(done.text);
    } catch (error) {
      return refused(`Couldn't make it: ${why(error)}`);
    }
  }
  const ask = askWork(asker, action, given);
  // On Autopilot it doesn't wait for you: it stays asked, for when you're back.
  const away = (await callerOf(caller.session, readEngineFile, readBridgeFile)).autopilot === true;
  const { value: answer } = await untilOnAutopilot(away ? undefined : caller.session, signal, stops =>
    answerOf(ask.id, { wait: away ? 0 : wait ?? (Number(process.env.KUVO_WORK_ASK_WAIT) || undefined), every, signal: stops }));
  if (!answer) return said(`The user hasn't answered yet: it stays asked on ${HERE}, and you'll hear when they answer. Carry on with what you can meanwhile.`);
  return answer.isError ? refused(answer.text) : said(answer.text);
}

/**
 * use_limit_reset's card (`plan-reset.ts`): asked of the user in the conversation, and its answer
 * once they give it (the reset used, or why not); on Autopilot it stays asked, for when they're back.
 */
export async function askReset(caller: Caller, given: ResetGiven, { signal, wait, every }: { signal?: AbortSignal; wait?: number; every?: number } = {}): Promise<ToolAnswer> {
  const bot = botOfConversation(caller.session);
  const asker = { session: caller.session, name: bot?.name ?? caller.name, ...(bot ? { bot: bot.bot } : {}) };
  const ask = askWork(asker, "resetLimits", { name: given.account, reset: given });
  const away = (await callerOf(caller.session, readEngineFile, readBridgeFile)).autopilot === true;
  const { value: answer } = await untilOnAutopilot(away ? undefined : caller.session, signal, stops =>
    answerOf(ask.id, { wait: away ? 0 : wait ?? (Number(process.env.KUVO_WORK_ASK_WAIT) || undefined), every, signal: stops }));
  if (!answer) return said(`The user hasn't answered yet: it stays asked on ${HERE}, and you'll hear when they answer. Carry on with what you can meanwhile.`);
  return answer.isError ? refused(answer.text) : said(answer.text);
}

/** list_projects: the projects here, with where each is, whether it's a git repository, and who
 * made it. */
export function listProjectsTool(where = HERE): ToolAnswer {
  const projects = readProjects().filter(each => !each.removed);
  const root = projectsFolder();
  const folder = root ? ` New ones go in ${shownPath(root)}.` : " No projects folder is picked yet: the user picks one the first time you make a project.";
  if (!projects.length) return said(`There are no projects on ${where} yet.${folder}`);
  const lines = projects.slice(0, 60).map(each => {
    const git = gitIn(each.directory, ["rev-parse", "--is-inside-work-tree"]) === "true" ? "git" : "not git";
    return `- ${each.name ?? path.basename(each.directory)}: ${shownPath(each.directory)} (${git})${each.madeBy ? `, made by ${each.madeBy.name}` : ""}`;
  });
  return said(`Projects on ${where}:\n${lines.join("\n")}\n${folder.trim()}`);
}

// The bot a conversation is, for the goal's tools: only a bot works through a goal of this kind (a
// session's /goal is the conversation's own, `agents/goals.ts`).
const goalBot = (caller: Caller) => botOfConversation(caller.session);
const ONLY_BOTS = "Only a bot takes a goal with a plan: ask the user to give it to one of their bots.";
const answered = (outcome: { said: string } | { refused: string }): ToolAnswer => ("said" in outcome ? said(outcome.said) : refused(outcome.refused));

/** propose_goal: the goal's plan and checks, put to the user on the goal card (once it's checked,
 * the apps its steps name looked for on this computer first). */
export async function proposeGoalTool(caller: Caller, args: Record<string, unknown>): Promise<ToolAnswer> {
  const bot = goalBot(caller);
  if (!bot) return refused(ONLY_BOTS);
  const wrong = proposalRefused(bot.bot, args);
  if (wrong) return refused(wrong);
  await findApps(appsNamed(args)).catch(() => {});
  const outcome = proposeGoal({ ...bot, session: caller.session }, args);
  if ("refused" in outcome) return refused(outcome.refused);
  const { goal, yours: set } = outcome;
  const yours = goal.checks.filter(check => check.state === "needs").map(check => check.text);
  // A spend line the user pays for themselves, left out of the plan's spending.
  const theirs = (Array.isArray(args.spend) ? args.spend.slice(0, 10) : []).map(each => (isObject(each) && typeof each.what === "string" ? each.what.trim() : "")).filter(what => what && !goal.spend.some(line => line.what.toLowerCase() === what.slice(0, 200).toLowerCase()));
  const paid = theirs.length ? ` ${theirs.join("; ")} ${theirs.length > 1 ? "are" : "is"} the user's to pay, as one of the checks: not yours to spend, so not in the plan's spending.` : "";
  const alone = goal.alone ? "" : ` ${HERE[0].toUpperCase()}${HERE.slice(1)} can't work on it alone yet, so once it starts, what your sessions ask waits for the user rather than for you.`;
  // The projects the user set on the card before: kept, or replaced by others the bot proposed.
  const names = set ? set.projects.map(each => `"${each}"`).join(", ") : "";
  const projects = !set ? "" : set.kept ? ` The user set its projects on the card: ${names}. They're kept: call them that.` : ` The user had set its projects on the card to ${names}; the ones you gave replace them. If they didn't ask you to change those, propose it again with theirs.`;
  return said(`The card is up on ${HERE}: the user starts the goal from it, or says not now.${projects} ${yours.length ? `What's theirs to do first: ${yours.join("; ")}. ` : ""}Don't start the work until you hear [Goal started].${paid} If they change something, propose it again as it is now.${alone}`);
}

/** goal_progress: the goal's steps, what waits for the user, what's spent and what's still watched
 * (once it's checked, the apps it names looked for on this computer first). */
export async function goalProgressTool(caller: Caller, args: Record<string, unknown>): Promise<ToolAnswer> {
  const bot = goalBot(caller);
  if (!bot) return refused(ONLY_BOTS);
  const wrong = progressRefused(bot.bot, args);
  if (wrong) return refused(wrong);
  await findApps(appsNamed(args)).catch(() => {});
  return answered(goalProgress(bot.bot, args));
}

/** may_spend: whether a purchase fits the plan's cap for it, in its period. */
export function maySpendTool(caller: Caller, args: Record<string, unknown>): ToolAnswer {
  const bot = goalBot(caller);
  return bot ? answered(maySpend(bot.bot, args)) : refused(ONLY_BOTS);
}

/** finish_goal: the goal done, with the report. */
export async function finishGoalTool(caller: Caller, args: Record<string, unknown>, targets: Target[]): Promise<ToolAnswer> {
  const bot = goalBot(caller);
  return bot ? answered(await finishGoal(bot.bot, args, () => targets)) : refused(ONLY_BOTS);
}
