// The tools a conversation runs its sessions with (PROTOCOL.md, "Work"): list_sessions, where each
// it started stands; stop_session, one of them stopped; answer_ask, what one asks, answered within
// what the asker may do itself; list_models, what a session can be started on; make_project, a new
// project made (asking you first, once for a bot if you say Always); list_projects, the projects
// here. Every box answers them alike, through `POST kuvo/agent-tools`.

import { call, readEngineFile } from "../engine/client";
import { agentsCommandsInSandbox, engineCommandsInSandbox } from "../fence/state";
import { stopSession } from "../engine/queue";
import { holdArchived } from "../areas/wakes";
import { noteWorkChanged } from "./changes";
import { callOf, keepAnswer, noteSession, pendingAsk, permissionWords, ruleFor, rulesOf, type PendingPermission } from "./answers";
import { allowRefusal } from "./policy";
import fs from "node:fs";
import path from "node:path";
import { readProjects } from "../areas/projects";
import { gitIn } from "../git";
import { HERE } from "../home";
import { answerOf, askWork, botAllows, doWork } from "./asks";
import { cloneable, folderName, isEmptyFolder, projectPlace, shownPath } from "./projects";
import { projectsFolder } from "./settings";
import { describeModels, usableModels } from "./models";
import { botOfConversation, describeWork, placeWords, under, workingNow, workSessions, worksFor } from "./tree";
import type { Target } from "../../shared/records";
import type { KitRule } from "../bots/kit";
import type { SessionPlace } from "../letters/letter";
import type { ToolAnswer } from "../letters/tools";
import type { Listed } from "./tree";

/** The conversation calling: its root's address and place, and its name as the others know it. */
export interface Caller {
  session: string;
  place: SessionPlace;
  name: string;
}

const said = (text: string): ToolAnswer => ({ text, isError: false });
const refused = (text: string): ToolAnswer => ({ text, isError: true });
const why = (error: unknown) => String((error as Error | null)?.message ?? error);
// A change to the work of the bot a session works for, for clients to read it again.
const changed = (data: Listed["data"]) => {
  const bot = worksFor(data)?.bot;
  if (bot) noteWorkChanged(bot);
};

// The caller's sessions (the ones it started, and theirs), the latest first.
const mine = async (caller: Caller, targets: Target[], signal?: AbortSignal) => under(caller.session, await workSessions(targets, signal));

// One of the caller's sessions by its address, or what to say when it isn't one.
async function oneOfMine(caller: Caller, session: unknown, targets: Target[], doing: string, signal?: AbortSignal): Promise<{ listed: Listed } | { error: ToolAnswer }> {
  if (typeof session !== "string" || !session.trim()) return { error: refused("Say which session (session), by its address from list_sessions.") };
  const listed = (await mine(caller, targets, signal)).find(each => each.data.id === session.trim());
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
  return { error: refused(doing === "stop" ? `"${title}" isn't yours to stop: ask the user.` : `"${title}" isn't one of your sessions: only the user answers what it asks.`) };
}

/** list_sessions: the caller's sessions, where each stands, the latest first. */
export async function listSessionsTool(caller: Caller, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const listed = await mine(caller, targets, signal);
  if (!listed.length) return said("You haven't started any sessions (or they're archived). Start one with start_session.");
  const working = await workingNow(targets, signal);
  const lines: string[] = [];
  for (const each of listed.slice(0, 40)) {
    const work = await describeWork(each, working, { replies: true, signal });
    const model = work.model ? ` · ${work.model.providerID}/${work.model.id}${work.model.variant ? ` (${work.model.variant})` : ""}` : "";
    const state = work.state === "asking" ? `asks to ${work.asks!.replace(/^Wants to /, "").replace(/\.$/, "")} (ask ${work.askID})` : work.state;
    const under = work.depth > 1 ? `, started by ${work.startedBy}` : "";
    const reply = work.lastReply && work.state !== "asking" ? `\n  Last reply: ${work.lastReply}` : "";
    lines.push(`- ${work.title} (address ${work.session}), ${placeWords(work)}: ${state}${model}${under}${work.tokens ? ` · ${work.tokens.toLocaleString("en-US")} tokens` : ""}${reply}`);
  }
  return said(`Your sessions, the latest first:\n${lines.join("\n")}`);
}

/** stop_session: one of the caller's sessions stopped (what waits for it held), and put away if
 * it says so. */
export async function stopSessionTool(caller: Caller, args: Record<string, unknown>, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const found = await oneOfMine(caller, args.session, targets, "stop", signal);
  if ("error" in found) return found.error;
  const { target, data } = found.listed;
  try {
    await stopSession(target, data.id);
  } catch (error) {
    return refused(`Couldn't stop "${data.title || "New Session"}": ${why(error)}`);
  }
  changed(data);
  if (args.archive === true) {
    await noteSession(target, data.id, (kuvo, metadata) => {
      metadata["kuvo.archived"] = true;
      return kuvo;
    }).then(() => holdArchived(data.id, true)).catch(() => {});
    return said(`Stopped and archived "${data.title || "New Session"}".`);
  }
  return said(`Stopped "${data.title || "New Session"}".`);
}

/** Whether the commands `permission` asks about run in the sandbox: the engine's, as it stands; a
 * coding agent's, as the agents' bridge says of the one asking (its whole program in it, started
 * while the sandbox was on), and while it's still on. */
function commandsInSandbox(target: Target, permission: PendingPermission): boolean {
  let engine = false;
  try { engine = readEngineFile().port === target.port; } catch {}
  return engine ? engineCommandsInSandbox() : permission.sandboxed === true && agentsCommandsInSandbox();
}

// A project's other folders, which its sessions work in as in its own.
const projectFolders = (folder: string): readonly string[] => readProjects().find(each => each.directory === folder)?.folders ?? [];

/** answer_ask: what one of the caller's sessions asks, answered. A permission it may allow only
 * where it could go ahead itself and never what always comes to the user; it may always say no. A
 * question it answers in words. Kept on the session, with why. */
export async function answerAskTool(caller: Caller, args: Record<string, unknown>, targets: Target[], signal?: AbortSignal): Promise<ToolAnswer> {
  const found = await oneOfMine(caller, args.session, targets, "answer", signal);
  if ("error" in found) return found.error;
  const { target, data } = found.listed;
  const title = data.title || "New Session";
  if (typeof args.ask !== "string" || !args.ask.trim()) return refused("Say which ask (ask), by its id from the [Session asks] message or list_sessions.");
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) return refused("Say why, in a line (reason): the user sees it with your answer.");
  const ask = await pendingAsk(target, data.id, args.ask.trim(), signal);
  if (!ask) return refused(`"${title}" doesn't ask ${args.ask.trim()} now: it was answered, or it moved on.`);
  const bot = botOfConversation(caller.session);
  const by = bot ?? { name: caller.name };
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
    changed(data);
    return said(`Answered "${title}".`);
  }
  const { permission } = ask;
  const what = permissionWords(permission);
  const shown = permission.resources.filter(each => each !== "*").join(", ") || permission.action;
  if (args.decision !== "allow" && args.decision !== "deny") return refused("Say allow or deny (decision).");
  if (args.decision === "allow") {
    const folder = data.location?.directory ?? data.directory ?? "";
    const rules = rulesOf((caller.place.data.permissions ?? []) as KitRule[]);
    const seen = await callOf(target, permission, signal);
    const why = allowRefusal(permission.action, permission.resources, folder ? [folder, ...projectFolders(folder)] : [], rules, ruleFor, seen, commandsInSandbox(target, permission));
    const user = `The user sees the ask on "${title}" and answers it there. Tell them in a line why it's needed, and carry on with the rest.`;
    if (why === "above") return refused(`You can't allow that: you'd have to ask the user about it yourself. ${user}`);
    if (why) return refused(`That's ${why}, which always comes to the user: you can't allow it. ${user}`);
  }
  try {
    await call(target, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, args.decision === "allow" ? { decision: "once" } : { decision: "reject", message: `${by.name}: ${reason}` }, signal);
  } catch (error) {
    return refused(`Couldn't answer it: ${why(error)}`);
  }
  await keepAnswer(target, data.id, { ask: permission.id, ...(permission.call ? { call: permission.call } : {}), what, decision: args.decision, reason, by, at: Date.now() }).catch(() => {});
  changed(data);
  return said(args.decision === "allow" ? `Allowed: ${shown}.` : `Denied: ${shown}. "${title}" is told why.`);
}

/** list_models: the models there's an account for here. */
export async function listModelsTool(engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<ToolAnswer> {
  return said(describeModels(await usableModels(engine, bridge, signal)));
}

/** make_project: a new project, in the projects folder you picked, made once you allow it (at once
 * for a bot you said Always to); what it is, or why not. Waits for your answer up to `wait` ms;
 * after that it stays asked, and the conversation is told when you answer. */
export async function makeProjectTool(caller: Caller, args: Record<string, unknown>, { signal, wait, every }: { signal?: AbortSignal; wait?: number; every?: number } = {}): Promise<ToolAnswer> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) return refused("Say what it's called (name).");
  if (!folderName(name)) return refused(`${name} can't be a folder's name: use letters or numbers.`);
  const clone = typeof args.clone === "string" && args.clone.trim() ? args.clone.trim() : undefined;
  if (clone && !cloneable(clone)) return refused(`${clone} isn't a repository address git can clone: give an https or ssh one.`);
  // What would fail anyway isn't asked.
  const place = projectPlace(name);
  const listed = place ? readProjects().find(each => each.directory === place && !each.removed) : null;
  if (listed) return refused(`There's a project at ${shownPath(place!)} already: ${listed.name ?? path.basename(place!)}. Start sessions in it with start_session.`);
  if (place && fs.existsSync(place) && !isEmptyFolder(place)) return refused(`There's a folder at ${shownPath(place)} already, with files in it. Pick another name.`);
  const bot = botOfConversation(caller.session);
  const asker = { session: caller.session, name: bot?.name ?? caller.name, ...(bot ? { bot: bot.bot } : {}) };
  const action = clone ? "cloneProject" : "makeProject";
  const given = { name, ...(args.git === false ? { git: false } : {}), ...(clone ? { clone } : {}) };
  if (bot && botAllows(bot.bot, action) && projectsFolder()) {
    try {
      const done = await doWork(action, given, asker);
      return done.isError ? refused(done.text) : said(done.text);
    } catch (error) {
      return refused(`Couldn't make it: ${why(error)}`);
    }
  }
  const ask = askWork(asker, action, given);
  const answer = await answerOf(ask.id, { wait: wait ?? (Number(process.env.KUVO_WORK_ASK_WAIT) || undefined), every, signal });
  if (!answer) return said(`The user hasn't answered yet: it stays asked on ${HERE}, and you'll hear when they answer. Carry on with what you can meanwhile.`);
  return answer.isError ? refused(answer.text) : said(answer.text);
}

/** list_projects: the projects here, with where each is, whether it's a git repository, and who
 * made it. */
export function listProjectsTool(): ToolAnswer {
  const projects = readProjects().filter(each => !each.removed);
  const root = projectsFolder();
  const folder = root ? ` New ones go in ${shownPath(root)}.` : " No projects folder is picked yet: the user picks one the first time you make a project.";
  if (!projects.length) return said(`There are no projects on ${HERE} yet.${folder}`);
  const lines = projects.slice(0, 60).map(each => {
    const git = gitIn(each.directory, ["rev-parse", "--is-inside-work-tree"]) === "true" ? "git" : "not git";
    return `- ${each.name ?? path.basename(each.directory)}: ${shownPath(each.directory)} (${git})${each.madeBy ? `, made by ${each.madeBy.name}` : ""}`;
  });
  return said(`Projects on ${HERE}:\n${lines.join("\n")}\n${folder.trim()}`);
}
