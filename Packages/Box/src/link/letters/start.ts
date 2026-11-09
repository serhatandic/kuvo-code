// A new session started with a task (PROTOCOL.md, "Agents' tools": `POST kuvo/sessions`, and the
// start_session tool on every box)
// From a conversation: an agent of its own, in that one's folder (or the one given), on its model,
// in its mode (Plan stays Plan), with its approval, so Ask First isn't got around; it gets the task as a message from the
// conversation, so it knows who to report to, and its metadata says who started it, for every client
// to show it beside them. From a client (no `startedBy`): the task as the user's own first message.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { asked, call, engineGet } from "../engine/client";
import { writtenByYou } from "../engine/queue";
import { messageID } from "../engine/sessions";
import { BOTS, CHATS, HERE, homeFolder, IS_MAC } from "../home";
import { macLink, readLink } from "../state";
import { plainName } from "../../shared/text";
import { realish } from "../fence/policy";
import { changeProjects, PROJECTS_FILE, readProjects } from "../areas/projects";
import { projectOf as projectOfFolder, readWorktrees } from "../areas/worktree-records";
import { answerWorktrees, settleNewSession } from "../areas/worktrees";
import { composeLetter } from "./letter";
import { allowed, noteStarting, startedAs, startsBefore, takeBack } from "./limits";
import { answerTo } from "./take";
import { noteWorkChanged } from "../work/changes";
import { noteOversight } from "../work/oversight";
import { botLimits, limitsFrom, pastLimit } from "../work/limits";
import { describeModels, pickModel, usableModels } from "../work/models";
import { failedOn, holdOf, holdWords, turnError, unansweringNow } from "../work/unanswering";
import { approvalOf, approvalRules, defaultApproval, effectiveApproval, isApproval, lowerOf, otherComputersAllowed, rememberApproval, unavailable } from "../work/approval";
import { holdsBack } from "../bots/tell";
import { rowsOfLeads } from "../work/elsewhere";
import { settleAgain } from "../areas/approval";
import { noteFullAccess } from "../work/full";
import { keptFromSessions } from "../work/reviewer";
import { botHere } from "../bots/here";
import type { Approval } from "../work/approval";
import { linkSession, pauseGoal, runningGoal } from "../work/goals";
import { nextMidnight, startOfDay } from "../work/clock";
import { atWorkNow } from "../work/background";
import { botOfConversation, depthOf, isArchived, lineOf, ofBot, workSessions, worksFor } from "../work/tree";
import { isAutopilot, tellAutopilot } from "../work/autopilot";
import type { WorkLimits, WorksFor } from "../../shared/routes/work";
import type { Target } from "../../shared/records";
import type { KitRule } from "../bots/kit";
import type { EngineSession } from "../engine/sessions";
import type { SessionPlace } from "./letter";

/** What a session's start is given: its task, and what's optional: where (a folder, a project by
 * name or folder, a chat), in a worktree, on which model and effort, in which mode, with which
 * approval, on Autopilot (a client's start; a conversation's starts take its own), and what its
 * starter hears of it (`wake`). (Unknown fields are ignored, so a newer
 * client can ask an older box.) */
export interface StartGiven {
  task?: unknown;
  title?: unknown;
  folder?: unknown;
  project?: unknown;
  chat?: unknown;
  worktree?: unknown;
  model?: unknown;
  effort?: unknown;
  mode?: unknown;
  approval?: unknown;
  autopilot?: unknown;
  wake?: unknown;
  /** The goal's step it works on (its number or id), for that step's track. */
  step?: unknown;
  computer?: unknown;
  wait?: unknown;
}

/** The conversation starting it: its root (a subagent's, an engine run's), where it runs, and its
 * name as the other agents know it; or an agent outside any conversation this box has
 * (`OUTSIDE`). */
export interface Starter {
  session: string;
  place: SessionPlace | null;
  name: string;
  /** A lead on another of your computers, as its call carries it: then `place` is null. */
  remote?: RemoteLead;
}

/** A lead on another of your computers starting a session here (PROTOCOL.md, "Peers", `call`,
 * `as.start`), as its own computer knows it, never from the agent's words: its approval as it comes
 * to there now and the Don't Allows it goes by there (`held`, kept with the session so they hold
 * here too), its mode and model, whether it's on Autopilot, the bot its work is for (`works`;
 * `own`, the lead is that bot), the new session's depth and line (`line`: its lead's own, then the
 * lead), and the limits you set for that bot. `call`: the call's id, marked on the session so it's
 * made once; `computer` and `key`: the lead's computer, as this one names it. */
export interface RemoteLead {
  call: string;
  computer: string;
  key: string;
  approval: Approval;
  held: KitRule[];
  agent: "plan" | "build" | null;
  model: { providerID: string; id: string; variant?: string } | null;
  autopilot: boolean;
  works: WorksFor | null;
  own: boolean;
  depth: number;
  line: string[];
  limits: WorkLimits | null;
}

/** What a session's start keeps of itself as it goes, so it can be finished from the step it got
 * to (a call's journal, `start-call.ts`): the worktree made for it, once it's made; what it's made
 * with, before it's made; then that it's made, marked and told its task. */
export interface StartSteps {
  tree?: (tree: MadeTree) => void;
  making?: (making: Making) => void;
  made?: (session: string) => void;
  marked?: () => void;
  prompted?: () => void;
}

/** A worktree made for a start: its folder, what removes it again (`root`), its branch. */
export interface MadeTree {
  folder: string;
  root: string | null;
  branch?: string;
}

/** A session about to be made, as it's to be finished: its marks once it's made (`kuvo`), what
 * it's told (`prompt`), whether it's on the coding agents' bridge (else the engine: never the
 * address of either, which changes each time it starts, nor its password) and on Autopilot, its
 * project's other folders, and what the start says of it. */
export interface Making {
  agents: boolean;
  asBefore: boolean;
  autopilot: boolean;
  kuvo: Record<string, unknown>;
  prompt: { id: string; text: string };
  folders: string[];
  folder: string;
  started: Omit<Started, "session">;
}

/** An agent's call from no conversation this box has: counted together, its task from "another
 * agent" that can't be answered, and asking first, as nothing says it may do more. */
export const OUTSIDE: Starter = { session: "unknown", place: null, name: "another agent" };
const ASKS_FIRST: NonNullable<EngineSession["permissions"]> = [{ action: "shell", resource: "*", effect: "ask" }];

/** A session started: its address, title, folder and project (null for a chat), and with `wait`,
 * its first answer (null for none yet). For its starter's words: what it picked (model, effort,
 * mode), whether its approval was brought down to the starter's, and what the starter hears of it. */
export interface Started {
  session: string;
  title: string | null;
  folder: string;
  project: string | null;
  answer?: string | null;
  picked?: string;
  /** Its approval, where that's less than it was asked for or would have (said to its agent). */
  got?: Approval;
  wakes?: string[];
  /** Its model can't answer now, as far as the box knows: said to its agent. */
  warning?: string;
  /** Waited for, its turn failed before it answered: why. */
  stopped?: string;
  /** Started for a lead on another computer on a model of this one's, as its own has no account
   * here: said to its agent. */
  model?: string;
  /** For a lead on another computer, why it got less than asked (`got`): this computer's. */
  held?: string;
}

/** Why one wasn't started (a 502 was, but its task didn't reach it: `session`). */
export interface StartRefusal {
  status: 400 | 403 | 409 | 429 | 502 | 503;
  message: string;
  session?: string;
  /** Full Access refused (409): without its switch. */
  reason?: "fullAccessOff";
}

/** Where it's started, and how it's waited for: the engine here (and the coding agents' bridge, for
 * one of their models), between looks for its answer (ms), until its asker goes. */
export interface StartPlace {
  readEngine: () => Target;
  bridge?: () => Target | null;
  step?: number;
  signal?: AbortSignal;
  steps?: StartSteps;
  /** The worktree a start cut short made already: it goes on in that one, not a second. */
  tree?: MadeTree;
}

/** What a session a bot started is told with its task: its half of the playbook (PROTOCOL.md,
 * "Work"), in the task's text, so it works with any agent. */
/** What a session a bot starts for its goal is told: no one may be there to answer. */
export const goalNote = "This is part of a goal the user may not be watching: what you ask can wait a while, so carry on with what doesn't depend on it, and report what you couldn't do.";
export const sessionNote = (bot: string) => `You were started by ${bot}, a bot coordinating this work. When you're done, review your work with reviewer subagents, fix what they find, and end with a short report as your last reply: what you did, what the reviewers found and how you fixed it, and anything left. ${bot} reads that report.`;

// What a start's wake names: what its starter hears of it.
const WAKES = ["finished", "asks"];
function wakesFrom(given: unknown, byBot: boolean, waits: boolean): string[] {
  // (One waited for answers here: hearing it finish again would say it twice.)
  if (given === undefined || given === null) return byBot ? WAKES.filter(each => !waits || each !== "finished") : [];
  if (given === "both") return [...WAKES];
  if (given === "none" || given === false) return [];
  const named = Array.isArray(given) ? given : [given];
  return WAKES.filter(each => named.includes(each));
}

// The approval a start asks for: one of the box's, or as an older client says it (`ask` Ask First;
// `approveAll`, its default, this computer's default: never Full Access unless you picked it last);
// none for the starter's own.
function approvalGiven(given: unknown): Approval | null | undefined {
  if (given === undefined || given === null) return null;
  if (given === "ask") return "askFirst";
  if (given === "approveAll") return defaultApproval();
  return isApproval(given) ? given : undefined;
}

/** What this box calls itself to your other computers: a machine by its name, this Mac by its own. */
export const ownName = (): string => plainName(IS_MAC ? macLink.config?.name : readLink()?.name) || (IS_MAC ? "the Mac" : "a machine");
/** Why a call that starts work isn't taken here: its switch is off. */
export const takesNoWork = (): string => `${ownName()} doesn't take work from your other computers. Ask the user to allow it in Settings › Permissions on ${ownName()}.`;

const SEAT = "Not from a group chat: talk it through here; the work is handed out after the wrap-up.";
export const seatRefusal = (): StartRefusal => ({ status: 403, message: SEAT });

// A bot's own folder, whose sessions would be listed nowhere: one it starts there is a chat.
const isBotFolder = (folder: string) => folder.startsWith(path.resolve(BOTS) + "/");

// Its project's other folders, allowed to it as the Mac allows them (ProjectFolders): symlinks
// resolved too, after its approval's rules (the last that matches wins).
function folderRules(folders: readonly string[]): KitRule[] {
  const paths: string[] = [];
  for (const folder of folders) {
    let real = folder;
    try { real = fs.realpathSync(folder); } catch {}
    for (const each of [folder, real]) if (!paths.includes(each)) paths.push(each);
  }
  return paths.map(each => ({ action: "external_directory", resource: path.join(each, "*"), effect: "allow" }));
}
const isFolderRule = (rule: KitRule) => rule.action === "external_directory" && rule.effect === "allow" && rule.resource.endsWith("/*");

// Its rules: made for its approval with Settings › Permissions as they are now (where they're this
// box's own; else the starting conversation's Don't Allows), its project's folders after (a bot's
// own folder stays allowed).
function rulesFor(approval: Approval, parent: Partial<EngineSession> | null, folders: readonly string[], held: readonly KitRule[] = []): KitRule[] {
  const own = Array.isArray(parent?.permissions) ? parent.permissions.filter(rule => !isFolderRule(rule) || rule.resource.includes("/bots/bot_")) : [];
  return approvalRules(approval, [...own, ...folderRules(folders)], held);
}

const projectsNote = (primary: string, folders: readonly string[]) =>
  `This project spans several folders. You work in its primary folder, ${path.basename(primary)} (${primary}). These folders belong to the project too, and you can read, search and change files in them the same way:\n${folders.map(folder => `- ${path.basename(folder)}: ${folder}`).join("\n")}\nWhen the user mentions one of these folders by name, they mean that folder.`;

// The project a folder is (one of its worktrees is its project's), its name and other folders; a
// folder that's none yet becomes one, as a Mac adds it when a session starts there. Null for chats.
function projectOf(folder: string): { name: string; folders: readonly string[] } | null {
  if (folder === CHATS) return null;
  // (A worktree's, removed ones too, as every client files its sessions: `worktreeProjects`.)
  const directory = projectOfFolder(folder);
  const known = readProjects().find(each => each.directory === directory);
  // (Only once the box keeps its projects: before, they're its Mac's.)
  if (!known && directory === folder && fs.existsSync(PROJECTS_FILE)) {
    try { changeProjects(projects => (projects.some(each => each.directory === directory) ? projects : [{ directory, folders: [] }, ...projects])); } catch {}
  }
  return { name: known?.name ?? path.basename(directory), folders: directory !== folder ? [] : (known?.folders ?? []) };
}

// The project `named` names here (its name, or its folder), or null.
function findProject(named: string): { directory: string; name: string } | null {
  const written = named.trim().replace(/^~(?=$|\/)/, homeFolder());
  const projects = readProjects().filter(each => !each.removed);
  const found = projects.find(each => each.directory === written) ?? projects.find(each => (each.name ?? path.basename(each.directory)).toLowerCase() === written.toLowerCase());
  return found ? { directory: found.directory, name: found.name ?? path.basename(found.directory) } : null;
}
const projectNames = () => readProjects().filter(each => !each.removed).map(each => each.name ?? path.basename(each.directory)).slice(0, 12);

/** A new session with `given`'s task, from the conversation `by` (null: from a client). A bot's
 * (and its sessions') are its work: marked so, held to the limits you set for it, if any, with a
 * net against a runaway; another conversation's, a few in a while (`limits.ts`). */
// Whether `session`'s turn answers what you wrote: its latest message to it is yours, not a
// letter, a wake-up or the box's (looked for back past a long turn's steps, page by page).
async function answersYou(target: Target, session: string): Promise<boolean> {
  const address = encodeURIComponent(session);
  let query = "limit=100&order=desc";
  for (let pages = 0; pages < 20; pages++) {
    const page = await engineGet(target, `api/session/${address}/message?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: string; previous?: string } | null } | null;
    const messages: unknown[] = Array.isArray(page?.data) ? page.data : [];
    const latest = messages.find(message => isObject(message) && message.type === "user") as { text?: unknown; metadata?: unknown } | undefined;
    if (latest) return writtenByYou(latest.text, latest.metadata);
    // (Older, as reading the whole conversation pages back.)
    const next = page?.cursor?.next ?? page?.cursor?.previous;
    if (!messages.length || !next) return false;
    query = `limit=100&cursor=${encodeURIComponent(next)}`;
  }
  return false;
}

export async function startSession(given: StartGiven, by: Starter | null, place: StartPlace): Promise<{ started: Started } | { refused: StartRefusal }> {
  const no = (status: StartRefusal["status"], message: string, session?: string) => ({ refused: { status, message, ...(session ? { session } : {}) } });
  const task = typeof given.task === "string" ? given.task.trim() : "";
  if (!task) return no(400, "Say what it's to do (task).");
  if (by?.place?.data.metadata?.kuvo?.seat) return { refused: seatRefusal() };
  if (given.computer !== undefined && given.computer !== null && given.computer !== "" && given.computer !== "here") return no(400, `Starting work on another computer isn't here yet: start it on ${HERE}, or ask the user to start it there.`);
  const remote = by?.remote ?? null;
  // (A lead on another computer: what its own computer says of it, with no folder here.)
  const parent: Partial<EngineSession> | null = remote ? { permissions: remote.held, ...(remote.agent ? { agent: remote.agent } : {}), ...(remote.model ? { model: remote.model } : {}) } as Partial<EngineSession> : by ? by.place?.data ?? { permissions: ASKS_FIRST } : null;
  const parentFolder = parent?.location?.directory ?? parent?.directory;
  let folder = parentFolder ? (isBotFolder(parentFolder) ? CHATS : parentFolder) : null;
  let projectDirectory: string | null = null;
  if (given.chat === true) {
    folder = CHATS;
  } else if (typeof given.project === "string" && given.project.trim()) {
    const found = findProject(given.project);
    if (!found) {
      const names = projectNames();
      return no(400, `There's no project called ${given.project.trim()} on ${HERE}.${names.length ? ` Its projects: ${names.join(", ")}.` : ""}`);
    }
    folder = projectDirectory = found.directory;
  } else if (typeof given.folder === "string" && given.folder.trim()) {
    const written = given.folder.trim();
    const full = written.replace(/^~(?=$|\/)/, homeFolder());
    let isFolder = false;
    try { isFolder = fs.statSync(full).isDirectory(); } catch {}
    if (!path.isAbsolute(full) || !isFolder) return no(400, `${written} isn't a folder on ${HERE}. Give a full path to one.`);
    // (Its commands would write it whole, in the sandbox: an agent in Auto never starts one where
    // that's real damage, its own conversation's folder and your projects aside; one in Full
    // Access, anywhere, as its own commands go.)
    const ours = [...readProjects().filter(each => !each.removed).flatMap(each => [each.directory, ...(each.folders ?? [])]),
      ...readWorktrees().map(each => each.folder ?? each.root), ...(parentFolder ? [parentFolder] : [])].map(realish);
    // (An agent's by where it really is as it's checked: a link swapped in after is never followed.)
    const at = by ? fs.realpathSync(full) : full;
    const bridgeNow = place.bridge?.() ?? null;
    const fullAccess = remote ? effectiveApproval(remote.approval).approval === "fullAccess"
      : Boolean(by?.place && approvalOf(by.place.data, { agents: Boolean(bridgeNow && by.place.target.port === bridgeNow.port), bot: Boolean(botOfConversation(by.session) ?? worksFor(by.place.data)) }).effective === "fullAccess");
    const kept = by && !fullAccess && !ours.includes(at) ? keptFromSessions(at) : null;
    if (kept) return no(403, `An agent in Auto can't start a session in ${written} on ${HERE}: ${kept}. Ask the user to start it there.`);
    folder = isBotFolder(at) ? CHATS : at;
  }
  if (!folder) return no(400, remote ? `Say where it works on ${HERE}: one of its projects (project, from list_projects with this computer), a folder there (folder, a full path), or chat.` : "Give the folder it works in (folder), as a full path.");
  if (given.mode !== undefined && given.mode !== null && given.mode !== "build" && given.mode !== "plan") return no(400, "mode is build or plan.");
  const requested = approvalGiven(given.approval);
  if (requested === undefined) return no(400, "approval is askFirst, acceptEdits, auto or fullAccess.");
  // A conversation that plans starts sessions that plan: Build would get round it, as Approve All
  // would round Ask First.
  if (given.mode === "build" && parent?.agent === "plan") return no(400, "This conversation is in Plan mode, so the sessions it starts plan too. Start it in plan mode, or ask the user to switch to Build.");
  // The bot this is work for: the conversation itself, or the bot its own starter works for.
  const ownBot = by?.place ? botOfConversation(by.session) : null;
  const bot: WorksFor | null = remote ? remote.works : ownBot ?? (by?.place ? worksFor(by.place.data) : null);
  const depth = remote ? remote.depth : ownBot ? 1 : depthOf(by?.place?.data) + 1;
  // Full Access from a client where it can't be had says why, rather than starting it with less.
  const notFull = !by && requested === "fullAccess" ? unavailable("fullAccess") : null;
  if (notFull) return { refused: { status: 409, message: notFull.why, reason: notFull.reason as "fullAccessOff" } };
  // The goal its bot is at, if any. Paused by you, nothing of it goes on until you resume it, so
  // none of its sessions (one woken by a letter, say) starts another meanwhile, nor the bot's own
  // conversation, but for what you ask it for there (its turn answering what you wrote).
  const goal = bot ? runningGoal(bot.bot) : null;
  if (goal?.heldByYou && !(ownBot && by?.place && await answersYou(by.place.target, by.session))) return no(403, "The user paused this goal: nothing new starts until they resume it.");
  // Where it runs: the engine, the coding agents' bridge for one of theirs, or the conversation's.
  let engine: Target | null = null;
  try { engine = place.readEngine(); } catch {}
  const bridge = place.bridge?.() ?? null;
  let target: Target | null = by?.place?.target ?? engine;
  let model = parent?.model ? { ...parent.model } : null;
  let picked: string[] = [];
  let warning: string | undefined;
  let free: boolean | undefined;
  if ((given.model !== undefined && given.model !== null && given.model !== "") || (given.effort !== undefined && given.effort !== null && given.effort !== "")) {
    const models = await usableModels(engine, bridge, place.signal);
    const choice = pickModel(given.model ?? (model ? { providerID: model.providerID, id: model.id } : null), given.effort, models);
    if ("refused" in choice) return no(400, choice.refused);
    // An agent's, on one that just failed at its account or its limit, is started all the same (it
    // may answer again), with a word on it and a model that can. (You choose for yourself.)
    const held = by ? holdOf(choice.model, unansweringNow()) : null;
    const own = model && models.find(each => each.providerID === model?.providerID && each.id === model?.id);
    if (held) warning = `${holdWords(held)}, so this may fail the same way. If it does, start it on a model that can, from list_models${own && !holdOf(own, unansweringNow()) ? `, like the one you run on (${own.providerID}/${own.id})` : ""}, or tell the user.`;
    free = choice.model.free;
    model = { providerID: choice.model.providerID, id: choice.model.id, ...(choice.variant ? { variant: choice.variant } : {}) };
    target = choice.model.target;
    picked = [choice.model.name, ...(choice.variant ? [choice.variant] : [])];
  }
  let modelNote: string | undefined;
  if (remote && !picked.length) {
    // A lead on another computer: on its own model where there's an account for it here, else on
    // this computer's default; none at all, it can't start here.
    // (An engine that doesn't answer isn't one with no accounts.)
    const answering = engine ? await call(engine, "GET", "/api/provider", undefined, place.signal).then(() => true, () => false) : false;
    if (!answering && !bridge) return no(503, `The engine on ${HERE} isn't running.`);
    const models = (await usableModels(engine, bridge, place.signal)).filter(each => !each.retiring);
    if (!models.length) return no(400, describeModels([]));
    const own = model ? models.find(each => each.providerID === model?.providerID && each.id === model?.id) : undefined;
    if (own) {
      target = own.target;
      free = own.free;
    } else {
      if (model) modelNote = `It runs on the default model there: yours (${model.providerID}/${model.id}) has no account on that computer.`;
      model = null;
      target = engine;
    }
  }
  if (given.mode === "plan") picked.push("Plan");
  if (!target) return no(503, `The engine on ${HERE} isn't running.`);
  // The limits you set for its bot, if any. This start is noted before they're looked at, so ones
  // asked for at once each count those before them that the engine doesn't show yet.
  // (Where the bot isn't, those its lead's computer said, or marked on the conversation starting it.)
  const limits = bot ? botLimits(bot.bot) ?? (remote ? remote.limits : limitsFrom(parent?.metadata?.kuvo?.limits)) : null;
  const limited = bot && limits ? await heldByLimits(bot, limits, depth, Boolean(goal), [engine, bridge].filter((each): each is Target => Boolean(each)), place.signal) : null;
  if (limited && "refused" in limited) return { refused: limited.refused };
  const went = limited?.went ?? (() => {});
  // A few at a time: an agent shouldn't fill the window with sessions unattended. A bot's work is
  // its to size, with only a net against a runaway.
  const kind = bot ? "botSessions" : "sessions";
  const key = by ? (bot ? `bot:${bot.bot}` : by.place || remote ? by.session : "outside") : null;
  const counted = key ? allowed(kind, key) : null;
  if (key && counted === null) {
    went(null);
    return no(429, bot ? "You've started a great many sessions in the last few minutes, which looks like a loop. Stop, check on the ones you have (list_sessions), and tell the user." : "You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.");
  }
  const giveBack = () => {
    if (key && counted !== null) takeBack(kind, key, counted);
    went(null);
  };
  // In a worktree of its project's, on a branch of its own (taken away again should the session not
  // start).
  let madeTree: string | null = null;
  const removeTree = async () => {
    if (madeTree) await answerWorktrees("POST", "kuvo/worktrees/remove", { path: madeTree, discard: true }, engine, place.signal).catch(() => {});
  };
  if (given.worktree === true) {
    const project = projectDirectory ?? (folder !== CHATS ? projectOfFolder(folder) : null);
    if (!project) {
      giveBack();
      return no(400, "A chat has no worktree: give a project.");
    }
    // (One a start cut short made: that one, still there.)
    const before = place.tree && fs.existsSync(place.tree.folder) ? place.tree : null;
    if (before) {
      folder = before.folder;
      madeTree = before.root;
      if (before.branch) picked.push(`worktree ${before.branch}`);
    } else {
      const made = await answerWorktrees("POST", "kuvo/worktrees", { project }, engine, place.signal).catch((error: unknown) => ({ status: 502, value: { message: String((error as Error | null)?.message ?? error) } }));
      const tree = made.value as { folder?: unknown; branch?: unknown; message?: unknown };
      if (made.status !== 200 || typeof tree.folder !== "string") {
        giveBack();
        return no(made.status === 409 ? 400 : 502, `Couldn't make a worktree of ${path.basename(project)}: ${String(tree.message ?? "it failed")}`);
      }
      folder = tree.folder;
      madeTree = typeof (tree as { root?: unknown }).root === "string" ? (tree as { root: string }).root : null;
      if (typeof tree.branch === "string") picked.push(`worktree ${tree.branch}`);
      place.steps?.tree?.({ folder, root: madeTree, ...(typeof tree.branch === "string" ? { branch: tree.branch } : {}) });
    }
  }
  // Its approval: the one asked for, never above the starter's (an agent outside any conversation
  // here asks first); from a client, this computer's default unless it says (and what it says is
  // the last one picked here). Kept with it, and its rules made for
  // what that comes to here now: never Full Access without its switch, nor Auto without the sandbox.
  const agents = Boolean(bridge && target.port === bridge.port);
  const from = by?.place ? approvalOf(by.place.data, { agents: Boolean(bridge && by.place.target.port === bridge.port), bot: Boolean(bot) }) : null;
  // (A lead on another computer: its approval as it comes to there now, never more.)
  const starters: Approval | null = remote ? remote.approval : by ? from?.approval ?? "askFirst" : null;
  const wanted: Approval = starters ? lowerOf(requested ?? starters, starters) : requested ?? defaultApproval();
  // Taking the approval of a conversation from before, it runs as that one does, and is one from
  // before too: nothing kept, so the box never makes its rules again. (Never a bot's: its work is
  // kept with its own.)
  const asBefore = Boolean(from && !from.stored && wanted === starters && !bot);
  const effective = effectiveApproval(wanted, { agents });
  const applied = asBefore ? wanted : effective.approval;
  // (Kept, for a lead on another computer, as no more than this computer gives it now: Full Access
  // only where it's confirmed here, so it never rises to that later, when Full Access is confirmed
  // here for something else. Auto stays Auto, asking while the sandbox isn't running, as here.)
  const kept: Approval = remote && wanted === "fullAccess" && unavailable("fullAccess") ? "auto" : wanted;
  const got = applied !== (requested ?? wanted) && lowerOf(applied, requested ?? wanted) === applied ? applied : undefined;
  const project = projectOf(folder);
  const title = typeof given.title === "string" && given.title.trim() ? given.title.trim() : null;
  // (A lead's Don't Allows from its own computer: kept with it, so they hold here however its rules are made again.)
  const brought = remote ? remote.held.filter(holdsBack) : [];
  const rules = rulesFor(applied, parent, project?.folders ?? [], brought);
  // Its mode: the one asked for, else the conversation's (one that plans starts sessions that plan).
  const agent = given.mode === "plan" || given.mode === "build" ? given.mode : parent?.agent ?? null;
  // On Autopilot where its starter is, or where a client asked. An agent's word isn't enough: one
  // the box can't place starts it asking.
  const autopilot = remote ? remote.autopilot : by ? Boolean(by.place && isAutopilot(by.place.data)) : given.autopilot === true;
  // Its line (the conversations above it, its starter's first: so it's found under a lead whose
  // line crosses computers), and where the bot isn't, the limits it goes by.
  const line = remote ? remote.line : by?.place ? [...lineOf(by.place.data), by.session].slice(-20) : null;
  // (Only where it says more than who started it: one above is `startedBy` itself.)
  const marksOfLine = { ...(line && line.length > 1 ? { line } : {}), ...(bot && limits ? { limits } : {}),
    ...(remote ? { call: remote.call, lead: { box: remote.computer, key: remote.key, name: by!.name }, ...(brought.length ? { held: brought } : {}) } : {}) };
  // (Kept with it as it's made, so the box never takes it for one a client made without saying.)
  const starter = Boolean(by?.place || remote);
  const marks = { ...(starter ? { startedBy: by!.session } : {}), ...(asBefore ? {} : { approval: kept, applied }), ...(autopilot ? { autopilot: true } : {}), ...marksOfLine };
  const waits = given.wait === true && !remote;
  const wakes = wakesFrom(given.wait === true && remote ? given.wake ?? "both" : given.wake, remote ? remote.own : Boolean(ownBot), waits);
  // What its starter hears of it, only once it's marked so: none for an agent outside any
  // conversation here, or for a mark the engine didn't take (it's told to write to it instead).
  const kuvo = { ...(starter ? { startedBy: by!.session, ...(bot ? { by: bot, depth } : {}), ...(wakes.length ? { wake: wakes } : {}) } : {}), ...(asBefore ? {} : { approval: kept, applied }), ...(autopilot ? { autopilot: true } : {}), ...marksOfLine };
  const from_ = remote ? `${by!.name} on ${remote.computer}` : by?.name ?? "";
  const text = by ? composeLetter(from_, by.session, task, waits) + (bot ? `\n\n${sessionNote(bot.name)}${goal ? `\n\n${goalNote}` : ""}` : "") : task;
  const making: Making = { agents, asBefore, autopilot, kuvo, prompt: { id: messageID(), text }, folders: [...(project?.folders ?? [])], folder,
    started: { title, folder, project: project?.name ?? null, ...(picked.length ? { picked: picked.join(" · ") } : {}), ...(got ? { got } : {}), ...(wakes.length ? { wakes } : {}), ...(warning ? { warning } : {}), ...(modelNote ? { model: modelNote } : {}),
      // (Less than its lead's because of this computer: why, for a lead on another.)
      ...(remote && got && effective.held ? { held: heldThere(wanted, applied, agents) } : {}) } };
  // (Switched off while it was got ready: not made. A worktree made for it goes again.)
  if (remote && !otherComputersAllowed()) {
    giveBack();
    await removeTree();
    return no(403, takesNoWork());
  }
  place.steps?.making?.(making);
  let session: string;
  try {
    const made = await call(target, "POST", "/api/session", { location: { directory: folder }, ...(title ? { title } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), permissions: rules, metadata: { kuvo: marks } }, place.signal);
    if (!isObject(made) || typeof made.id !== "string" || !made.id) throw new Error("No session was made.");
    session = made.id;
    went(session);
    place.steps?.made?.(session);
    // (What a client picked is the next one's here.)
    if (!by && requested) rememberApproval(requested);
  } catch (error) {
    giveBack();
    await removeTree();
    return no(502, `Couldn't start a session in ${folder}: ${String((error as Error | null)?.message ?? error)}`);
  }
  const marked = await markMade(making, target, session, place.signal);
  if (marked) place.steps?.marked?.();
  if ((by?.place || remote) && bot) noteWorkChanged(bot.bot);
  // Started by the bot itself, for clients to show it looking after its new session: now, before
  // a wait for its answer, so it shows before the session finishes.
  if (marked && by?.place && bot && botOfConversation(by.session)?.bot === bot.bot) noteOversight(bot.bot, session, "started");
  if (bot && goal && given.step !== undefined && given.step !== null) linkSession(bot.bot, given.step, session);
  const id = making.prompt.id;
  try {
    await promptMade(making, target, session);
  } catch (error) {
    went(session, true);
    return no(502, `Started a session (address ${session}), but the task didn't reach it: ${String((error as Error | null)?.message ?? error)}`, session);
  }
  place.steps?.prompted?.();
  went(session, true);
  const started: Started = { session, ...making.started, ...(!marked || !starter ? { wakes: undefined } : {}) };
  if (!started.wakes) delete started.wakes;
  if (!waits) return { started };
  // A new session: anything it says is its answer; a turn that failed before it said anything, why.
  const answer = await answerTo(target, session, id, { wait: place.step, signal: place.signal, by: by?.place ? by.session : null, fresh: true });
  const error = answer === null && !place.signal?.aborted ? await turnError(target, session, place.signal).catch(() => null) : null;
  const held = error && model ? await failedOn(target, { ...model, free }, error).catch(() => null) : null;
  const stopped = held ? `${holdWords(held)}.` : error ? error.message || "The engine gave no reason." : undefined;
  return { started: { ...started, answer, ...(stopped ? { stopped, warning: undefined } : {}) } };
}

/** The limits you set for `bot` (`limits`), looked at for a new session at `depth`: why it can't
 * start, or how its start went is kept (`went`), so starts asked for at once each count those
 * before them that the engine doesn't show yet. Its sessions here and, as they last told, on your
 * other computers. A day's limit during a goal pauses the goal till midnight. */
export async function heldByLimits(bot: WorksFor, limits: WorkLimits, depth: number, goal: boolean, targets: Target[], signal?: AbortSignal): Promise<{ refused: StartRefusal } | { went: (session: string | null, prompted?: boolean) => void }> {
  const noted = noteStarting(bot.bot);
  const went = (session: string | null, prompted = false) => startedAs(bot.bot, noted.token, session, prompted);
  const work = ofBot(bot.bot, await workSessions(targets, signal, { archived: true }));
  const working = await atWorkNow(targets, signal);
  const midnight = startOfDay(Date.now());
  const today = work.filter(each => (each.data.time?.created ?? 0) >= midnight);
  const workIDs = new Set(work.map(each => each.data.id));
  const todayIDs = new Set(today.map(each => each.data.id));
  // (One carried on with the coding agents is one start: the copy left counts only where the one it
  // was carried to isn't counted as the bot's.)
  const startedToday = today.filter(each => { const to = each.data.metadata?.["kuvo.carriedTo"]; return typeof to !== "string" || !workIDs.has(to); }).length;
  // Its sessions on your other computers too, as those last told this one.
  const far = elsewhereOf(bot.bot, workIDs).filter(row => !workIDs.has(row.session));
  const farToday = far.filter(row => row.started >= midnight);
  const tokens = today.reduce((sum, each) => sum + (each.data.tokens?.input ?? 0) + (each.data.tokens?.output ?? 0) + (each.data.tokens?.reasoning ?? 0), 0) + farToday.reduce((sum, row) => sum + row.tokens, 0);
  // One the engine shows as the bot's, given its task, is working or not as the engine says.
  const earlier = startsBefore(bot.bot, noted.before);
  const known = (session: string, ids: Set<string>, rows: { session: string }[]) => ids.has(session) || rows.some(row => row.session === session);
  const past = pastLimit(limits, {
    depth,
    // (One put away doesn't take a place for what it left running.)
    working: work.filter(each => working.has(each.data.id) && !isArchived(each.data)).length + far.filter(row => row.state === "working" || row.state === "asking").length + earlier.filter(each => !each.session || !each.prompted || !known(each.session, workIDs, far)).length,
    started: startedToday + farToday.length + earlier.filter(each => !each.session || !known(each.session, todayIDs, farToday)).length,
    tokens,
  });
  if (!past) return { went };
  went(null);
  // A day's limit, during a goal: new sessions wait for midnight, when the bot is woken.
  if (past.daily && goal) {
    pauseGoal(bot.bot, { why: "your daily limit", until: nextMidnight(Date.now()) });
    return { refused: { status: 429, message: `${past.words} New sessions for your goal wait for it to reset at midnight, and you're woken then: carry on meanwhile with what doesn't start a session.` } };
  }
  return { refused: { status: 429, message: past.daily ? `${past.words} Ask the user to raise it (Edit Bot › Work), or go on tomorrow.` : past.words } };
}

/** A session just made on `target`, finished as it's to be (each step can be taken again): its
 * project's other folders and Autopilot told it, its worktree's branch named, its marks put on, its
 * rules made for what its approval comes to now, and Full Access noted. Whether its marks are on. */
export async function markMade(making: Making, target: Target, session: string, signal?: AbortSignal): Promise<boolean> {
  const address = encodeURIComponent(session);
  if (making.folders.length) {
    await call(target, "PUT", `/api/experimental/session/${address}/instructions/entries/kuvo.project-folders`, { value: projectsNote(making.folder, making.folders) }).catch(() => {});
  }
  if (making.autopilot) await tellAutopilot(target, session, true).catch(() => {});
  await settleNewSession(target, session).catch(() => {});
  const marked = await call(target, "PATCH", `/api/session/${address}`, { metadata: { kuvo: making.kuvo } }).then(() => true, () => false);
  // (What it comes to may have changed while it was made.)
  if (marked && !making.asBefore) await settleAgain(target, session, making.agents, signal).catch(() => {});
  // In Full Access, its commands outside the sandbox from the first.
  await noteFullAccess(session).catch(() => {});
  return marked;
}

/** A session just made on `target`, given its task (it throws where that didn't reach it). */
export async function promptMade(making: Making, target: Target, session: string): Promise<void> {
  await asked(target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, { id: making.prompt.id, text: making.prompt.text, delivery: "steer" });
}

// The rows your other computers last told of `bot`'s work: of its own conversation, and of its
// sessions here (whose own sessions are there).
function elsewhereOf(bot: string, here: Set<string>) {
  const own = botHere(bot)?.session;
  return rowsOfLeads(new Set([...(own ? [own] : []), ...here]));
}

// Why a lead on another computer got less than `wanted` here (`applied`), in words for that lead:
// Full Access not confirmed here, Auto's sandbox not running here, or both.
function heldThere(wanted: Approval, applied: Approval, agents: boolean): string {
  const why: string[] = [];
  if (wanted === "fullAccess" && unavailable("fullAccess")) why.push("Full Access hasn't been allowed on that computer yet: only the user can allow it, by picking Full Access once in a session there.");
  if ((wanted === "fullAccess" || wanted === "auto") && applied === "askFirst" && unavailable("auto", { agents })) why.push("Auto needs the sandbox, which isn't running on that computer.");
  return why.join(" ");
}

// What a session started with less than it was asked for does on its own.
const GOT: Record<Approval, string> = {
  askFirst: "It asks before it edits or runs commands.",
  acceptEdits: "It edits on its own, and asks before it runs commands.",
  auto: "It works on its own inside the sandbox, and asks for anything beyond it.",
  fullAccess: "",
};

/** How a start went, in the words the tool gives its agent. */
export function startedWords(outcome: { started: Started } | { refused: StartRefusal }, waits: boolean): { text: string; isError: boolean } {
  if ("refused" in outcome) return { text: outcome.refused.message, isError: true };
  const { session, title, project, answer, picked, got, wakes = [], warning, stopped, model, held } = outcome.started;
  const name = title ? `"${title}"` : "a new session";
  const where = project ? ` in ${project}` : "";
  const what = picked ? `: ${picked}.` : ".";
  const asks = (model ? ` ${model}` : "") + (got ? ` ${GOT[got]}${held ? ` ${held}` : ""}` : "");
  const hears = wakes.length ? ` You'll be woken when it ${wakes.length === 2 ? "finishes or asks for something" : wakes[0] === "finished" ? "finishes" : "asks for something"}, so don't check on it.` : "";
  const warned = warning ? ` ${warning}` : "";
  if (!waits) return { text: `Started ${name}${where} (address ${session})${what}${asks} It's on it now.${hears || " Write to it with send_message; it can write back to you the same way."}${warned}`, isError: false };
  if (stopped) return { text: `Started ${name}${where} (address ${session})${what} It stopped with an error before it answered: ${stopped} Start it again on a model that can, from list_models, or tell the user.`, isError: true };
  return { text: `Started ${name}${where} (address ${session})${what}${asks} ` + (answer ? `It answered:\n\n${answer}` : "It hasn't answered yet; it may still write back with send_message.") + warned, isError: false };
}
