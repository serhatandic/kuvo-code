// A new session started with a task (PROTOCOL.md, "Agents' tools": `POST kuvo/sessions`, and the
// start_session tool on every box)
// From a conversation: an agent of its own, in that one's folder (or the one given), on its model,
// in its mode (Plan stays Plan), with its approval, so Ask First isn't got around; it gets the task as a message from the
// conversation, so it knows who to report to, and its metadata says who started it, for every client
// to show it beside them. From a client (no `startedBy`): the task as the user's own first message.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { asked, call } from "../engine/client";
import { messageID } from "../engine/sessions";
import { BOTS, CHATS, HERE, homeFolder } from "../home";
import { changeProjects, PROJECTS_FILE, readProjects } from "../areas/projects";
import { readWorktrees } from "../areas/worktree-records";
import { answerWorktrees, tellWorktree } from "../areas/worktrees";
import { permissionsHere, refreshedRules } from "../bots/tell";
import { composeLetter } from "./letter";
import { allowed, takeBack } from "./limits";
import { answerTo } from "./take";
import { noteWorkChanged } from "../work/changes";
import { botLimits, pastLimit } from "../work/limits";
import { pickModel, usableModels } from "../work/models";
import { withAlwaysAsk } from "../work/always";
import { linkSession, pauseGoal, runningGoal } from "../work/goals";
import { nextMidnight, startOfDay } from "../work/clock";
import { botOfConversation, depthOf, ofBot, workingNow, workSessions, worksFor } from "../work/tree";
import type { WorksFor } from "../../shared/routes/work";
import type { Target } from "../../shared/records";
import type { KitRule } from "../bots/kit";
import type { EngineSession } from "../engine/sessions";
import type { SessionPlace } from "./letter";

/** What a session's start is given: its task, and what's optional: where (a folder, a project by
 * name or folder, a chat), in a worktree, on which model and effort, in which mode, with which
 * approval, and what its starter hears of it (`wake`). (Unknown fields are ignored, so a newer
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
  askedFirst?: boolean;
  wakes?: string[];
}

/** Why one wasn't started (a 502 was, but its task didn't reach it: `session`). */
export interface StartRefusal {
  status: 400 | 403 | 429 | 502 | 503;
  message: string;
  session?: string;
}

/** Where it's started, and how it's waited for: the engine here (and the coding agents' bridge, for
 * one of their models), between looks for its answer (ms), until its asker goes. */
export interface StartPlace {
  readEngine: () => Target;
  bridge?: () => Target | null;
  step?: number;
  signal?: AbortSignal;
}

/** What a session a bot started is told with its task: its half of the playbook (PROTOCOL.md,
 * "Work"), in the task's text, so it works with any agent. */
/** What a session a bot starts for its goal is told: no one may be there to answer. */
export const goalNote = "This is part of a goal the user may not be watching: what you ask can wait a while, so carry on with what doesn't depend on it. Prepare rather than act on the world: don't publish, deploy, send or pay anything unless your task says it's approved, and report what you couldn't do.";
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

const askFirstRules = () => refreshedRules(ASKS_FIRST, permissionsHere() ?? []);
const asksFirst = (rules: unknown) => Array.isArray(rules) && rules.some(rule => rule?.action === "shell" && rule?.resource === "*" && rule?.effect === "ask");

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

// Its rules: the starting conversation's approval (Approve All from a client), made again with
// Settings › Permissions as they are now where they're this box's own, else as they are; its own
// folders' rules for its project's (a bot's own folder stays allowed). None from a client on a box
// whose settings aren't its own: the engine's own then.
function rulesFor(parent: Partial<EngineSession> | null, folders: readonly string[]): KitRule[] | undefined {
  const own = Array.isArray(parent?.permissions) ? parent.permissions.filter(rule => !isFolderRule(rule) || rule.resource.includes("/bots/bot_")) : null;
  const settings = permissionsHere();
  const made = settings ? refreshedRules(own ?? [], settings) : own;
  if (!made && !folders.length) return undefined;
  return [...(made ?? []), ...folderRules(folders)];
}

const projectsNote = (primary: string, folders: readonly string[]) =>
  `This project spans several folders. You work in its primary folder, ${path.basename(primary)} (${primary}). These folders belong to the project too, and you can read, search and change files in them the same way:\n${folders.map(folder => `- ${path.basename(folder)}: ${folder}`).join("\n")}\nWhen the user mentions one of these folders by name, they mean that folder.`;

// The project a folder is (one of its worktrees is its project's), its name and other folders; a
// folder that's none yet becomes one, as a Mac adds it when a session starts there. Null for chats.
function projectOf(folder: string): { name: string; folders: readonly string[] } | null {
  if (folder === CHATS) return null;
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  const directory = tree?.project ?? folder;
  const known = readProjects().find(each => each.directory === directory);
  // (Only once the box keeps its projects: before, they're its Mac's.)
  if (!known && !tree && fs.existsSync(PROJECTS_FILE)) {
    try { changeProjects(projects => (projects.some(each => each.directory === directory) ? projects : [{ directory, folders: [] }, ...projects])); } catch {}
  }
  return { name: known?.name ?? path.basename(directory), folders: tree ? [] : (known?.folders ?? []) };
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
export async function startSession(given: StartGiven, by: Starter | null, place: StartPlace): Promise<{ started: Started } | { refused: StartRefusal }> {
  const no = (status: StartRefusal["status"], message: string, session?: string) => ({ refused: { status, message, ...(session ? { session } : {}) } });
  const task = typeof given.task === "string" ? given.task.trim() : "";
  if (!task) return no(400, "Say what it's to do (task).");
  if (by?.place?.data.metadata?.kuvo?.seat) return { refused: seatRefusal() };
  if (given.computer !== undefined && given.computer !== null && given.computer !== "" && given.computer !== "here") return no(400, `Starting work on another computer isn't here yet: start it on ${HERE}, or ask the user to start it there.`);
  const parent = by ? by.place?.data ?? { permissions: ASKS_FIRST } : null;
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
    folder = isBotFolder(full) ? CHATS : full;
  }
  if (!folder) return no(400, "Give the folder it works in (folder), as a full path.");
  if (given.mode !== undefined && given.mode !== null && given.mode !== "build" && given.mode !== "plan") return no(400, "mode is build or plan.");
  if (given.approval !== undefined && given.approval !== null && given.approval !== "ask" && given.approval !== "approveAll") return no(400, "approval is ask or approveAll.");
  // A conversation that plans starts sessions that plan: Build would get round it, as Approve All
  // would round Ask First.
  if (given.mode === "build" && parent?.agent === "plan") return no(400, "This conversation is in Plan mode, so the sessions it starts plan too. Start it in plan mode, or ask the user to switch to Build.");
  // The bot this is work for: the conversation itself, or the bot its own starter works for.
  const ownBot = by?.place ? botOfConversation(by.session) : null;
  const bot: WorksFor | null = ownBot ?? (by?.place ? worksFor(by.place.data) : null);
  const depth = ownBot ? 1 : depthOf(by?.place?.data) + 1;
  // The goal its bot is at, if any.
  const goal = bot ? runningGoal(bot.bot) : null;
  // Where it runs: the engine, the coding agents' bridge for one of theirs, or the conversation's.
  let engine: Target | null = null;
  try { engine = place.readEngine(); } catch {}
  const bridge = place.bridge?.() ?? null;
  let target: Target | null = by?.place?.target ?? engine;
  let model = parent?.model ? { ...parent.model } : null;
  let picked: string[] = [];
  if ((given.model !== undefined && given.model !== null && given.model !== "") || (given.effort !== undefined && given.effort !== null && given.effort !== "")) {
    const models = await usableModels(engine, bridge, place.signal);
    const choice = pickModel(given.model ?? (model ? { providerID: model.providerID, id: model.id } : null), given.effort, models);
    if ("refused" in choice) return no(400, choice.refused);
    model = { providerID: choice.model.providerID, id: choice.model.id, ...(choice.variant ? { variant: choice.variant } : {}) };
    target = choice.model.target;
    picked = [choice.model.name, ...(choice.variant ? [choice.variant] : [])];
  }
  if (given.mode === "plan") picked.push("Plan");
  if (!target) return no(503, `The engine on ${HERE} isn't running.`);
  // The limits you set for its bot, if any.
  if (bot) {
    const limits = botLimits(bot.bot);
    if (limits) {
      const targets = [engine, bridge].filter((each): each is Target => Boolean(each));
      const work = ofBot(bot.bot, await workSessions(targets, place.signal, { archived: true }));
      const working = await workingNow(targets, place.signal);
      const midnight = startOfDay(Date.now());
      const today = work.filter(each => (each.data.time?.created ?? 0) >= midnight);
      const tokens = today.reduce((sum, each) => sum + (each.data.tokens?.input ?? 0) + (each.data.tokens?.output ?? 0) + (each.data.tokens?.reasoning ?? 0), 0);
      const past = pastLimit(limits, { depth, working: work.filter(each => working.has(each.data.id)).length, started: today.length, tokens });
      // A day's limit, during a goal: new sessions wait for midnight, when the bot is woken.
      if (past?.daily && goal) {
        pauseGoal(bot.bot, { why: "your daily limit", until: nextMidnight(Date.now()) });
        return no(429, `${past.words} New sessions for your goal wait for it to reset at midnight, and you're woken then: carry on meanwhile with what doesn't start a session.`);
      }
      if (past) return no(429, past.daily ? `${past.words} Ask the user to raise it (Edit Bot › Work), or go on tomorrow.` : past.words);
    }
  }
  // A few at a time: an agent shouldn't fill the window with sessions unattended. A bot's work is
  // its to size, with only a net against a runaway.
  const kind = bot ? "botSessions" : "sessions";
  const key = by ? (bot ? `bot:${bot.bot}` : by.place ? by.session : "outside") : null;
  const counted = key ? allowed(kind, key) : null;
  if (key && counted === null) return no(429, bot ? "You've started a great many sessions in the last few minutes, which looks like a loop. Stop, check on the ones you have (list_sessions), and tell the user." : "You've started several sessions in the last few minutes. Write to those (send_message), or ask the user before starting more.");
  const giveBack = () => { if (key && counted !== null) takeBack(kind, key, counted); };
  // In a worktree of its project's, on a branch of its own (taken away again should the session not
  // start).
  let madeTree: string | null = null;
  if (given.worktree === true) {
    const project = projectDirectory ?? (folder !== CHATS ? (readWorktrees().find(each => (each.folder ?? each.root) === folder)?.project ?? folder) : null);
    if (!project) {
      giveBack();
      return no(400, "A chat has no worktree: give a project.");
    }
    const made = await answerWorktrees("POST", "kuvo/worktrees", { project }, engine, place.signal);
    const tree = made.value as { folder?: unknown; branch?: unknown; message?: unknown };
    if (made.status !== 200 || typeof tree.folder !== "string") {
      giveBack();
      return no(made.status === 409 ? 400 : 502, `Couldn't make a worktree of ${path.basename(project)}: ${String(tree.message ?? "it failed")}`);
    }
    folder = tree.folder;
    madeTree = typeof (tree as { root?: unknown }).root === "string" ? (tree as { root: string }).root : null;
    if (typeof tree.branch === "string") picked.push(`worktree ${tree.branch}`);
  }
  // Its approval: the starter's, or asking first if it says so, and never above the starter's.
  const wantsAsk = given.approval === "ask" || (given.approval === "approveAll" && asksFirst(parent?.permissions));
  const askedFirst = given.approval === "approveAll" && asksFirst(parent?.permissions);
  const project = projectOf(folder);
  const title = typeof given.title === "string" && given.title.trim() ? given.title.trim() : null;
  const made = rulesFor(wantsAsk && !asksFirst(parent?.permissions) ? { ...parent, permissions: askFirstRules() as EngineSession["permissions"] } : parent, project?.folders ?? []);
  // A bot's work asks for what always comes to you, whatever its approval (last, so they win).
  // For a goal, publishing too, unless you switched on a public step.
  const rules = bot ? withAlwaysAsk(made ?? [], { publishing: Boolean(goal && !goal.public.some(step => step.on)) }) : made;
  // Its mode: the one asked for, else the conversation's (one that plans starts sessions that plan).
  const agent = given.mode === "plan" || given.mode === "build" ? given.mode : parent?.agent ?? null;
  let session: string;
  try {
    const made = await call(target, "POST", "/api/session", { location: { directory: folder }, ...(title ? { title } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(rules ? { permissions: rules } : {}) }, place.signal);
    if (!isObject(made) || typeof made.id !== "string" || !made.id) throw new Error("No session was made.");
    session = made.id;
  } catch (error) {
    giveBack();
    if (madeTree) await answerWorktrees("POST", "kuvo/worktrees/remove", { path: madeTree, discard: true }, engine, place.signal).catch(() => {});
    return no(502, `Couldn't start a session in ${folder}: ${String((error as Error | null)?.message ?? error)}`);
  }
  const address = encodeURIComponent(session);
  if (project?.folders.length) {
    await call(target, "PUT", `/api/experimental/session/${address}/instructions/entries/kuvo.project-folders`, { value: projectsNote(folder, project.folders) }).catch(() => {});
  }
  await tellWorktree(target, session).catch(() => {});
  const wakes = wakesFrom(given.wake, Boolean(ownBot), given.wait === true);
  if (by?.place) {
    const kuvo = { startedBy: by.session, ...(bot ? { by: bot, depth } : {}), ...(wakes.length ? { wake: wakes } : {}) };
    await call(target, "PATCH", `/api/session/${address}`, { metadata: { kuvo } }).catch(() => {});
    if (bot) noteWorkChanged(bot.bot);
  }
  if (bot && goal && given.step !== undefined && given.step !== null) linkSession(bot.bot, given.step, session);
  const waits = given.wait === true;
  const id = messageID();
  const text = by ? composeLetter(by.name, by.session, task, waits) + (bot ? `\n\n${sessionNote(bot.name)}${goal ? `\n\n${goalNote}` : ""}` : "") : task;
  try {
    await asked(target, "POST", `api/session/${address}/prompt`, { id, text, delivery: "steer" });
  } catch (error) {
    return no(502, `Started a session (${session}), but the task didn't reach it: ${String((error as Error | null)?.message ?? error)}`, session);
  }
  const started: Started = { session, title, folder, project: project?.name ?? null, ...(picked.length ? { picked: picked.join(" · ") } : {}), ...(askedFirst ? { askedFirst } : {}), ...(wakes.length ? { wakes } : {}) };
  if (!waits) return { started };
  // A new session: anything it says is its answer.
  return { started: { ...started, answer: await answerTo(target, session, id, { wait: place.step, signal: place.signal }) } };
}

/** How a start went, in the words the tool gives its agent. */
export function startedWords(outcome: { started: Started } | { refused: StartRefusal }, waits: boolean): { text: string; isError: boolean } {
  if ("refused" in outcome) return { text: outcome.refused.message, isError: true };
  const { session, title, project, answer, picked, askedFirst, wakes = [] } = outcome.started;
  const name = title ? `"${title}"` : "a new session";
  const where = project ? ` in ${project}` : "";
  const what = picked ? `: ${picked}.` : ".";
  const asks = askedFirst ? " It asks first, as you do." : "";
  const hears = wakes.length ? ` You'll be woken when it ${wakes.length === 2 ? "finishes or asks for something" : wakes[0] === "finished" ? "finishes" : "asks for something"}, so don't check on it.` : "";
  if (!waits) return { text: `Started ${name}${where} (address ${session})${what}${asks} It's on it now.${hears || " Write to it with send_message; it can write back to you the same way."}`, isError: false };
  return { text: `Started ${name}${where} (address ${session})${what}${asks} ` + (answer ? `It answered:\n\n${answer}` : "It hasn't answered yet; it may still write back with send_message."), isError: false };
}
