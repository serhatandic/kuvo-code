// A bot's goal (PROTOCOL.md, "Work › Goals"): you give a bot a goal of any length, a couple of hours
// or a month, and it takes it end to end. It plans it, checks what it needs, and puts it to you on
// one card (propose_goal, or /goal in its chat, `askGoal`). Only you start it (`POST
// kuvo/work/goals/<id>`, from a client: never a tool, an agent's message or another computer's
// mail). Then it's the conversation's goal (the agents bridge's, `agents/goals.ts`, which keeps the
// bot at it turn after turn), with the plan kept here beside it: its steps, one track each; what
// waits for you, which never stalls the rest and never turns into a no; what's paused at a limit,
// which carries on by itself once the limit resets; what it may spend in a period; a digest as
// often as you asked; and the final report. A goal ends only when it's done, you stop it, or an end
// you set comes (and then with its report).
//
// Kept in `run/work/goals.json`, each bot's latest, on the box doing the work, so it goes on with no
// client there, through restarts, and every client shows the same goal.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { isLimit, resetsIn, resetTime } from "../../shared/limits";
import { pause } from "../../shared/wait";
import { botHere } from "../bots/here";
import { asked, bridgeTarget, call } from "../engine/client";
import { changeQueue, queueOf, readQueues, resumeQueue, sendInto, stopSession } from "../engine/queue";
import { PAUSED_BY_YOU } from "../../shared/goals";
import { boxNote } from "../../shared/queues";
import { messageID } from "../engine/sessions";
import { MOVING } from "../bots/here";
import { frozen } from "../moves/records";
import { locked, textOf, writePrivate } from "../files";
import { BOTS, HERE } from "../home";
import { placeOfSession } from "../letters/letter";
import { readWakes } from "../areas/wakes";
import { periodEnd, periodOf, startOfDay, timeGiven } from "./clock";
import { asksIn, CHOICE_MOST, decisionChanged, permissionWords, type PendingQuestion } from "./answers";
import { decidedByYou as decidedInConversation, declineSharedIn, goAheadOnQuestion, isAutopilot, setAutopilot } from "./autopilot";
import type { EngineSession } from "../engine/sessions";
import { keepAwake, keepsAwake, onPower } from "./awake";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { sandboxOn } from "./sandbox";
import { appNamed, appNameGiven } from "./apps";
import { folderName, isEmptyFolder, namedPlace, projectPlace, shownPath } from "./projects";
import { projectsFolder } from "./settings";
import { stopBotWork } from "./stop";
import { readBackground } from "./background";
import { ofBot, workingNow, workSessions } from "./tree";
import type { Listed } from "./tree";
import type { Target } from "../../shared/records";
import type { GoalAppShape, GoalCheckShape, GoalDecidedShape, GoalFolderShape, GoalPlanShape, GoalStepShape, GoalWaitingShape } from "../../shared/routes/work";
import type { Notice } from "../notices/notice";

export const GOALS_FILE = path.join(WORK_FOLDER, "goals.json");
const LOCK = path.join(WORK_FOLDER, ".goals.lock");
/** Whether you're here: a client in use lately, as this box's watch last saw it. */
export const HERE_FILE = path.join(WORK_FOLDER, "here.json");

/** How a bot runs its goal: asking you the calls that are yours (Interactive), or deciding what its
 * research settles and stopping only at what only you can do (Autopilot). */
export type GoalMode = GoalPlanShape["mode"];
const MODES: readonly GoalMode[] = ["interactive", "autopilot"];
const modeOf = (goal: Pick<KeptGoal, "mode">): GoalMode => goal.mode ?? "interactive";

/** How long a goal that ended (or a card left unanswered) is still shown. */
const SHOWN = 24 * 3_600_000;
/** How long an ask goes unanswered by the bot before it's listed as waiting for you. */
export const ASK_SETTLES = 2 * 60_000;
/** How long a bot has to wrap up once its goal's end has come, before the box ends it. */
const WRAP_UP = 2 * 3_600_000;
/** How long to wait for a limit that didn't say when it resets, before trying again. */
const UNKNOWN_RESET = 30 * 60_000;
// How long what a goal's sessions left running holds off its nudge (a dev server would stall it).
const NUDGE_HOLD = 30 * 60_000;
const DAY = 86_400_000;

/** A goal as it's kept: as it's shown, less what's worked out when it's shown, with what the box
 * keeps besides. */
export interface KeptGoal extends Omit<GoalPlanShape, "alone" | "folders" | "steps" | "spend" | "waiting" | "paused" | "public" | "checks" | "mode" | "decided"> {
  steps: GoalStepShape[];
  /** How it runs; one kept from before has none, and runs Interactive. */
  mode?: GoalMode;
  /** The calls the bot made on its own; one kept from before has none. */
  decided?: GoalDecidedShape[];
  spend: GoalPlanShape["spend"][number][];
  waiting: GoalWaitingShape[];
  paused: GoalPlanShape["paused"][number][];
  public: GoalPlanShape["public"][number][];
  checks: GoalCheckShape[];
  /** The period each spend line's `spent` counts in ("2026-10-29", "2026-W44", "2026-10"). */
  periods?: string[];
  /** Asks first seen pending (ms), by session and ask, so one lists as waiting once settled. */
  asksSeen?: Record<string, number>;
  /** A session's failed turn already taken as a limit, by session: its turn's end. */
  limitsSeen?: Record<string, string>;
  /** What's been told to your phones: waiting items, and the report. */
  told?: string[];
  reportTold?: boolean;
  /** When it was told its end had come. */
  endTold?: number;
  /** The phases done when the last digest went, for "at milestones". */
  phasesDone?: string[];
  /** Steps done when the last digest went. */
  doneAtDigest?: number;
  /** Since when something has been paused (none is now: no time). */
  pausedSince?: number;
  /** Since when nothing of it has been at work, and how many times the bot was told to carry on. */
  idleSince?: number;
  nudges?: number;
  /** The plan as it stood when the bot was last told to carry on (`planNow`): not told again
   * until it changes, so a bot that answers and changes nothing is never looped. */
  nudgedPlan?: string;
  /** Its conversation's goal (the agents bridge's) is set: taken away once the plan ends. */
  loop?: boolean;
  /** Since when you've had it paused (its conversation's goal, from any app): nothing of it goes
   * on, not even at a limit's reset, until you resume it. */
  heldByYou?: number;
  /** A switch of its mode hasn't reached all of its sessions yet (`followMode`). */
  following?: boolean;
  /** Its conversation was on Autopilot before it started (or couldn't be read then): it's left as it is when the goal ends. */
  wasAutopilot?: boolean;
  /** The projects the bot proposed, while you've set others on its card (`projects`): a proposal
   * again with these keeps yours. */
  botProjects?: readonly string[];
}

/** Those following the goals here, in this process. */
export const goalFollowers = new Set<() => void>();

const STATES = ["proposed", "running", "done", "stopped", "declined"];
const readKept = (file = GOALS_FILE): KeptGoal[] => {
  try {
    const goals = JSON.parse(textOf(file) ?? "").goals;
    return Array.isArray(goals) ? goals.filter(each => isObject(each) && typeof each.id === "string" && typeof each.bot === "string" && STATES.includes(each.state as string)) : [];
  } catch {
    return [];
  }
};

/** Whether `bot` has a goal running here (kept on this box, in `goals.json`: it doesn't move with
 * the bot). */
export const goalRuns = (bot: string, file = GOALS_FILE): boolean => readKept(file).some(goal => goal.bot === bot && goal.state === "running");

/** The running goal `conversation` works on: its bot's own conversation, or `bot`'s work. */
export const runningGoalOf = (conversation: string, bot: string | null, file = GOALS_FILE): KeptGoal | null =>
  readKept(file).find(goal => goal.state === "running" && (goal.session === conversation || goal.bot === bot)) ?? null;

// The goals as `change` leaves them, under the lock: each bot's latest, while its bot is here.
// Those following them are told only when that changed something (the watch's own look, finding
// nothing new, would otherwise start the next at once, and every app read them again).
function changeKept<T>(change: (goals: KeptGoal[]) => T, file = GOALS_FILE): T {
  fs.mkdirSync(WORK_FOLDER, { recursive: true });
  let changed = false;
  const result = locked(LOCK, () => {
    const goals = readKept(file);
    const value = change(goals);
    const latest = new Map<string, KeptGoal>();
    for (const goal of goals) if (botHere(goal.bot) && (!latest.has(goal.bot) || latest.get(goal.bot)!.proposed <= goal.proposed)) latest.set(goal.bot, goal);
    // Each bot's latest, and one that ended with a report not told yet.
    const kept = goals.filter(goal => botHere(goal.bot) && (latest.get(goal.bot) === goal || (goal.report && !goal.reportTold && goal.state !== "running")));
    const text = JSON.stringify({ goals: kept }, null, 2);
    if (text !== textOf(file)) {
      writePrivate(file, text);
      changed = true;
    }
    return value;
  });
  if (changed) for (const tell of goalFollowers) tell();
  return result;
}

const Here = `${HERE[0].toUpperCase()}${HERE.slice(1)}`;

/** Whether `goal` may go on alone here: its bot's commands in the sandbox, a coding agent's too. */
const alone = (goal: Pick<KeptGoal, "bot">): boolean => sandboxOn(botHere(goal.bot)?.agents ?? false);

/** A project a plan names: by name, to go in the projects folder, or by the folder the user named
 * for it (a full path, or one with `~`), named after that folder. */
export function goalProject(entry: string): { name: string; folder?: string } {
  if (!/^(~\/|\/)/.test(entry)) return { name: entry };
  const named = namedPlace(entry);
  return "folder" in named ? { name: path.basename(named.folder), folder: named.folder } : { name: path.basename(entry) };
}

/** Where Start makes each project the plan names, as making it will (`make_project`, the way the
 * bot is told to): in the folder named for it, or in the projects folder by its name (none while
 * none is picked), and whether something with files is there already. Only shown: it holds nothing
 * back. */
export function goalFolders(goal: Pick<KeptGoal, "projects">): GoalFolderShape[] {
  return goal.projects.map(entry => {
    const { name, folder: named } = goalProject(entry);
    const folder = named ?? projectPlace(name);
    if (!folder) return { project: name, folder: null, shown: null };
    return { project: name, folder, shown: shownPath(folder), there: fs.existsSync(folder) && !isEmptyFolder(folder) };
  });
}

/** The checks the box makes itself, as they stand now: whether it may work on its own here, on
 * power (a Mac), and where new projects go (when the plan makes one without a folder named for it,
 * and none is picked). */
export function boxChecks(goal: Pick<KeptGoal, "projects" | "name" | "bot">): GoalCheckShape[] {
  const checks: GoalCheckShape[] = [];
  if (!alone(goal)) checks.push({ id: "alone", text: `${Here} can't work on its own yet`, detail: `${goal.name} works on it with you here: what it asks waits for you`, state: "failed", by: "box" });
  if (keepsAwake() && onPower() === false) checks.push({ id: "power", text: "Your Mac is on battery", detail: "If it sleeps, the goal carries on once it wakes", state: "needs", by: "box" });
  const placeless = goal.projects.filter(each => !/^(~\/|\/)/.test(each));
  if (placeless.length && !projectsFolder()) {
    checks.push({ id: "projectsFolder", text: "Pick where new projects go", detail: `for ${placeless.join(", ")}`, state: "needs", by: "box", action: { kind: "projectsFolder", label: "Pick" } });
  }
  return checks;
}

const shown = (goal: KeptGoal): GoalPlanShape => {
  const { following: _following, wasAutopilot: _wasAutopilot, periods: _, asksSeen: __, limitsSeen: ___, told: ____, reportTold: _____, endTold: ______, phasesDone: _______, doneAtDigest: ________, pausedSince: _________, idleSince: __________, nudges: ___________, loop: ____________, heldByYou: _____________, nudgedPlan: ______________, botProjects: _______________, ...rest } = goal;
  // A step whose session waits for a limit to reset is paused, until then.
  const steps = goal.steps.map(step => {
    const paused = goal.state === "running" && step.state !== "done" && step.state !== "skipped" ? goal.paused.find(each => each.session && step.sessions?.includes(each.session)) : undefined;
    return paused ? { ...step, state: "paused" as const, ...(paused.until ? { resumes: paused.until } : {}) } : step;
  });
  const proposed = goal.state === "proposed";
  // Public steps aren't held back any more, a goal kept from before too: none is shown.
  return { ...rest, steps, public: [], checks: proposed ? [...boxChecks(goal), ...goal.checks] : goal.checks, mode: modeOf(goal), decided: goal.decided ?? [], alone: alone(goal), ...(proposed ? { folders: goalFolders(goal) } : {}) };
};

/** The goals here, as clients show them: each bot's latest while it's proposed or running, or
 * ended (or left unanswered) within the last day. */
export function goalPlans(file = GOALS_FILE): GoalPlanShape[] {
  const now = Date.now();
  return latestOf(readKept(file))
    .filter(goal => botHere(goal.bot) && (goal.state === "running" || now - (goal.ended ?? goal.proposed) < SHOWN))
    .sort((a, b) => b.proposed - a.proposed)
    .map(shown);
}

/** The goals proposed and waiting for your word (a day at most: one older can't be started). */
export const proposedGoals = (file = GOALS_FILE, now = Date.now()): KeptGoal[] =>
  latestOf(readKept(file)).filter(goal => goal.state === "proposed" && now - goal.proposed < SHOWN);

/** `bot`'s goal while it runs; null otherwise. */
export const runningGoal = (bot: string | null | undefined, file = GOALS_FILE): KeptGoal | null => (bot ? readKept(file).find(goal => goal.bot === bot && goal.state === "running") ?? null : null);

// The latest goal of each bot, as clients list them (one ended and still to be told goes after).
const latestOf = (goals: KeptGoal[]): KeptGoal[] => {
  const latest = new Map<string, KeptGoal>();
  for (const goal of goals) if (!latest.has(goal.bot) || latest.get(goal.bot)!.proposed <= goal.proposed) latest.set(goal.bot, goal);
  return [...latest.values()];
};

/** Whether you're here now: a client in use within the last couple of minutes, as this box's
 * watch saw it. */
export function isHere(file = HERE_FILE): boolean {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    return kept?.here === true && Date.now() - Number(kept.at) < 3 * 60_000;
  } catch {
    return false;
  }
}

// ——— Periods ———

export { periodEnd, periodOf } from "./clock";

// Each spend line's period as it is now: a new one starts again from nothing.
function freshPeriods(goal: KeptGoal, now = Date.now()): boolean {
  let changed = false;
  goal.periods = goal.spend.map((line, at) => {
    const period = periodOf(line.per, now);
    if (goal.periods?.[at] !== period) {
      if (goal.periods?.[at] !== undefined) {
        line.spent = 0;
        delete line.until;
      }
      changed = true;
    }
    return period;
  });
  return changed;
}

// ——— What the bot gives ———

const text = (value: unknown, most: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, most) : null);
const https = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};
// The site something is done at: an address's host, or a site named (`stripe.com`).
const siteOf = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const host = new URL(value.includes("://") ? value.trim() : `https://${value.trim()}`).hostname.toLowerCase();
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
};
const newID = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "")}`;
const PERIODS = ["day", "week", "month", "goal"] as const;
const DIGESTS = ["day", "week", "milestones", "none"] as const;

// One line of words: what wraps (a newline, runs of spaces) said as one space.
const line = (value: unknown, most: number): string | null => text(typeof value === "string" ? value.replace(/\s+/g, " ") : value, most);

// The app something is done in, as the bot names it ("Xcode", or {name}): with its id once it's
// found on this computer (`findApps`, as the tools are called).
const appGiven = (value: unknown): GoalAppShape | null => {
  const name = appNameGiven(value);
  return name ? appNamed(name) : null;
};

/** The apps a goal's tool call names, for the box to look for before it's kept (`findApps`). */
export function appsNamed(given: Record<string, unknown>): string[] {
  const named = (value: unknown) => (isObject(value) ? [appNameGiven(value.app)] : []);
  const lists = [given.steps, given.add].flatMap(each => (Array.isArray(each) ? each : []));
  return [...lists.flatMap(named), ...named(given), ...named(given.waiting)].filter((each): each is string => Boolean(each));
}

// A step as given: its words, or {text, detail, phase, site, app, after: [step numbers]}.
function stepGiven(each: unknown): (Pick<GoalStepShape, "text" | "detail" | "phase" | "site" | "app"> & { after?: number[] }) | null {
  if (typeof each === "string") return text(each, 300) ? { text: text(each, 300)! } : null;
  if (!isObject(each)) return null;
  const said = text(each.text, 300);
  if (!said) return null;
  const after = Array.isArray(each.after) ? each.after.filter((one): one is number => Number.isInteger(one) && (one as number) >= 1) : [];
  const site = siteOf(each.site);
  const app = appGiven(each.app);
  const detail = line(each.detail, 120);
  return { text: said, ...(detail ? { detail } : {}), ...(text(each.phase, 80) ? { phase: text(each.phase, 80)! } : {}), ...(site ? { site } : {}), ...(app ? { app } : {}), ...(after.length ? { after } : {}) };
}
// Steps as kept: ids in order, and what each comes after by id (only steps before it).
const keptSteps = (given: ReturnType<typeof stepGiven>[], from = 0): GoalStepShape[] => given.filter((each): each is NonNullable<typeof each> => Boolean(each)).map((each, at) => {
  const { after, ...rest } = each;
  const ids = (after ?? []).filter(number => number - 1 < from + at).map(number => `s${number}`);
  return { id: `s${from + at + 1}`, ...rest, ...(ids.length ? { after: ids } : {}), state: "todo" };
});

// An end as given: a date or time (in your zone unless it says) or ms, to come.
function endGiven(value: unknown, now = Date.now()): number | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const at = timeGiven(value);
  return at !== null && at > now ? at : null;
}

// The projects a plan makes, as the bot or you give them: each a name, or a full path (`~/…` or
// `/…`, not `~` or `/` itself), in a line; each one make_project can make (a folder's name with
// letters or numbers), and no two the same folder ("Tide Pool" and "tide-pool").
function projectsGiven(given: unknown[]): { projects: string[] } | { refused: string } {
  const projects: string[] = [];
  const places = new Map<string, string>();
  for (const each of given) {
    const entry = line(each, 201);
    if (!entry || entry.length > 200) return { refused: "Each project is a name or a full path (~/… or /…), of 200 characters at most." };
    let name = entry;
    let place: string | null = null;
    if (/^(~\/|\/)/.test(entry) || entry === "~") {
      const named = namedPlace(entry);
      if ("refused" in named) return { refused: named.refused };
      name = path.basename(named.folder);
      place = named.folder;
    }
    const folder = folderName(name);
    // (As make_project says it.)
    if (!folder) return { refused: `${name} can't be a folder's name: use letters or numbers.` };
    place ??= projectPlace(name) ?? `name:${folder}`;
    const twin = places.get(place);
    if (twin) return { refused: `${twin} and ${entry} would be the same folder: give them names apart.` };
    places.set(place, entry);
    projects.push(entry);
  }
  return { projects };
}

// Two lists of projects that are the same, but for case.
const sameProjects = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each, at) => each.toLowerCase() === b[at].toLowerCase());

type Plan = Pick<KeptGoal, "goal" | "title" | "steps" | "checks" | "spend" | "public" | "projects" | "digest" | "ends">;

const RUNS_ALREADY = "A goal is running already: report on it with goal_progress, and end it with finish_goal.";

/** Why propose_goal can't take what it was given (as `proposeGoal` would refuse it), before anything
 * is looked for; null for nothing. */
export function proposalRefused(bot: string, given: Record<string, unknown>, file = GOALS_FILE): string | null {
  const planned = planGiven(given);
  if ("refused" in planned) return planned.refused;
  return goalRuns(bot, file) ? RUNS_ALREADY : null;
}

/** What `proposeGoal` makes of the user's projects, when they set some on the card it replaces:
 * theirs, and whether they're kept (the bot proposed its own again) or the bot's replaced them. */
export interface ProjectsByYou {
  projects: readonly string[];
  kept: boolean;
}

/** A goal proposed by `bot` (its name, and its conversation), from what propose_goal was given: the
 * card it puts to you, replacing one it proposed before. Refused while one runs. The projects you
 * set on the card it replaces stay, unless the bot proposes others than it did then. */
export function proposeGoal(bot: { bot: string; name: string; session: string }, given: Record<string, unknown>, file = GOALS_FILE): { goal: GoalPlanShape; yours?: ProjectsByYou } | { refused: string } {
  const planned = planGiven(given);
  if ("refused" in planned) return planned;
  const { plan } = planned;
  let yours: ProjectsByYou | undefined;
  const made = changeKept(all => {
    if (all.some(each => each.bot === bot.bot && each.state === "running")) return null;
    const kept: KeptGoal = {
      id: newID("goal"),
      bot: bot.bot,
      name: bot.name,
      session: bot.session,
      ...plan,
      state: "proposed",
      wake: false,
      proposed: Date.now(),
      waiting: [],
      paused: [],
      waited: 0,
      watching: [],
    };
    // The projects you set on the card it replaces: kept while the bot proposes the ones it did.
    const before = all.find(each => each.bot === bot.bot && each.state === "proposed" && each.botProjects);
    if (before?.botProjects) {
      const keep = sameProjects(plan.projects, before.botProjects);
      yours = { projects: before.projects, kept: keep };
      if (keep) Object.assign(kept, { projects: before.projects, botProjects: before.botProjects });
    }
    // (The one proposed before goes: this one's the card now.)
    for (let at = all.length - 1; at >= 0; at--) if (all[at].bot === bot.bot && all[at].state === "proposed") all.splice(at, 1);
    all.push(kept);
    return kept;
  }, file);
  if (!made) return { refused: RUNS_ALREADY };
  noteWorkChanged(bot.bot);
  return { goal: shown(made), ...(yours ? { yours } : {}) };
}

// A line's words, in lower case, without the marks between them.
const wordsOf = (said: string) => said.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
// Whether a check names what a spend line is for: its words in a row there, two or more (one word,
// like "ads", may only be near it).
const names = (check: string[], what: string[]) => what.length > 1 && check.some((_, at) => what.every((word, by) => check[at + by] === word));
// The amounts a check gives ("99 USD a year", "$99.00", "99,00 €").
const pricesIn = (said: string) => [...said.matchAll(/\d+(?:[.,]\d+)?/g)].map(each => Number(each[0].replace(",", ".")));

// A plan as propose_goal gives it, checked: what's kept of it, or why it won't do.
function planGiven(given: Record<string, unknown>): { plan: Plan } | { refused: string } {
  const goal = text(given.goal, 2000);
  if (!goal) return { refused: "Say the goal, in the user's words (goal)." };
  // (Too many refused before any is read.)
  if (Array.isArray(given.steps) && given.steps.length > 200) return { refused: "That's more than 200 steps: make them bigger." };
  const steps = (Array.isArray(given.steps) ? given.steps : []).map(stepGiven).filter((each): each is NonNullable<typeof each> => Boolean(each));
  if (!steps.length) return { refused: "Give the plan, as its steps in order (steps)." };
  const checks: GoalCheckShape[] = [];
  for (const each of Array.isArray(given.checks) ? given.checks.slice(0, 12) : []) {
    if (!isObject(each)) continue;
    const said = text(each.text, 200);
    if (!said) continue;
    const url = https(each.url);
    const state = each.ok === true ? "ok" : "needs";
    const site = siteOf(each.site) ?? siteOf(url);
    checks.push({ id: `c${checks.length + 1}`, text: said, ...(text(each.detail, 300) ? { detail: text(each.detail, 300)! } : {}), state, by: "bot", ...(site ? { site } : {}), ...(url && state === "needs" ? { action: { kind: "open" as const, label: text(each.button, 30) ?? "Open", url } } : {}) });
  }
  const spend: KeptGoal["spend"] = [];
  const yours = checks.filter(each => each.state === "needs").map(each => ({ words: wordsOf(each.text), prices: pricesIn(`${each.text} ${each.detail ?? ""}`) }));
  for (const each of Array.isArray(given.spend) ? given.spend.slice(0, 10) : []) {
    if (!isObject(each) || !text(each.what, 200) || typeof each.cap !== "number" || !(each.cap > 0)) return { refused: "Each spend line needs what it's for (what) and a cap above 0 (cap)." };
    // What the plan has you pay for yourself (a membership you join, at its price) stays under what
    // needs you, and isn't the bot's to spend. (A check that only names it, like a key for a service
    // the bot then spends on, leaves the bot its line.)
    if (yours.some(check => check.prices.includes(each.cap as number) && names(check.words, wordsOf(each.what as string)))) continue;
    const per = PERIODS.includes(each.per as (typeof PERIODS)[number]) ? each.per as (typeof PERIODS)[number] : "goal";
    spend.push({ what: text(each.what, 200)!, cap: each.cap, currency: (text(each.currency, 3) ?? "USD").toUpperCase(), per, spent: 0 });
  }
  const named = projectsGiven((Array.isArray(given.projects) ? given.projects.slice(0, 5) : []).filter(each => !(typeof each === "string" && !each.trim())));
  if ("refused" in named) return named;
  const { projects } = named;
  const ends = endGiven(given.ends);
  if (ends === null) return { refused: "An end (ends) is a date and time to come, like 2026-11-30T18:00." };
  // A digest for a long goal, by the plan's size unless the bot says: a day's for one with phases or
  // many steps, none for a short one.
  const digest = DIGESTS.includes(given.digest as (typeof DIGESTS)[number]) ? given.digest as (typeof DIGESTS)[number] : steps.length > 12 || steps.some(step => step.phase) ? "day" : "none";
  return { plan: { goal, ...(text(given.title, 80) ? { title: text(given.title, 80)! } : {}), steps: keptSteps(steps), checks, spend, public: [], projects, digest, ...(ends ? { ends } : {}) } };
}

/** Why your answer can't be taken: no such goal (404), or one that won't do (400). */
export interface GoalRefusal {
  status: 400 | 404 | 409 | 502;
  message: string;
}

/** Your answer to the goal `id`: `projects` (its projects as you set them, while it's proposed),
 * `start` (with `mode`, `wake`, `digest`, an end, `ends` (null for none, taking away the bot's), and each spend line's cap and period, `spend: [{cap,
 * per}]`), `decline` or `stop`; while it runs, `change`, `clear`, or `decided` (your choice on a call
 * it made on its own). */
export async function answerGoal(id: string, given: Record<string, unknown>, targets: () => Target[], file = GOALS_FILE): Promise<{ goal: GoalPlanShape } | { refused: GoalRefusal }> {
  const action = given.action;
  if (action === "change" || action === "clear") return changeGoal(id, action, given, targets, file);
  if (action === "projects") return goalProjects(id, given.projects, file);
  if (action === "decided") return decidedByYou(id, given, targets, file);
  if (action !== "start" && action !== "decline" && action !== "stop") return { refused: { status: 400, message: "Say start, change, clear, decided, projects, decline or stop (action)." } };
  if (given.mode !== undefined && !MODES.includes(given.mode as GoalMode)) return { refused: { status: 400, message: MODE_WORDS } };
  const before = readKept(file).find(goal => goal.id === id);
  if (!before || !botHere(before.bot)) return { refused: { status: 404, message: "There's no such goal here." } };
  // Not while its bot moves: a goal stays on the computer it started on, and nothing reaches the bot
  // meanwhile.
  if (action === "start" && frozen().has(before.bot)) return { refused: { status: 409, message: MOVING } };
  const ends = action === "start" ? endGiven(given.ends) : undefined;
  if (ends === null) return { refused: { status: 400, message: "The end (ends) is a date and time to come." } };
  // Started without saying how it runs (a client from before Autopilot): as its conversation runs
  // now, rather than turning the conversation's Autopilot off.
  const runsNow = action === "start" ? await placeOfSession(before.session, targets()).catch(() => null) : null;
  const wasAutopilot = action === "start" && (!runsNow || isAutopilot(runsNow.data));
  const asItRuns = runsNow && isAutopilot(runsNow.data) && given.mode === undefined && before.mode === undefined ? "autopilot" as const : undefined;
  const changed = changeKept(all => {
    const goal = all.find(each => each.id === id);
    if (!goal) return { status: 404 as const, message: "There's no such goal here." };
    if (action === "stop") {
      if (goal.state !== "running") return { status: 400 as const, message: "That goal isn't running." };
      goal.state = "stopped";
      goal.ended = Date.now();
      return goal;
    }
    if (goal.state !== "proposed") return { status: 400 as const, message: goal.state === "running" ? "That goal is running already." : "That goal has ended." };
    if (action === "start" && Date.now() - goal.proposed >= SHOWN) return { status: 400 as const, message: "That plan is from more than a day ago: ask for it again." };
    if (action === "decline") {
      goal.state = "declined";
      goal.ended = Date.now();
      return goal;
    }
    if (all.some(each => each.bot === goal.bot && each.state === "running")) return { status: 400 as const, message: "A goal is running for this bot already." };
    goal.state = "running";
    goal.started = Date.now();
    goal.wake = given.wake === true;
    goal.mode = MODES.includes(given.mode as GoalMode) ? given.mode as GoalMode : asItRuns ?? modeOf(goal);
    if (wasAutopilot) goal.wasAutopilot = true;
    if (DIGESTS.includes(given.digest as (typeof DIGESTS)[number])) goal.digest = given.digest as (typeof DIGESTS)[number];
    if (ends !== undefined) goal.ends = ends;
    // No end on the card (null): the bot's proposed one goes.
    if (given.ends === null) delete goal.ends;
    goal.spend = capsGiven(goal.spend, given.spend);
    freshPeriods(goal);
    return goal;
  }, file);
  if (!("id" in changed)) return { refused: changed };
  noteWorkChanged(changed.bot);
  if (action === "stop") {
    await stopBotWork(changed.bot, targets()).catch(() => 0);
    await setGoalLoop(changed, null, targets);
    await followMode(changed, targets, file);
  } else if (action === "decline") {
    await tellBot(changed, "[Not now] The user didn't start this goal. Don't start its work: ask them in a line what they'd like instead, if anything.", "You said not now", targets);
  } else {
    await setGoalLoop(changed, loopCondition(changed), targets);
    await followMode(changed, targets);
    await tellBot(changed, startWords(changed), "Goal started", targets);
  }
  return { goal: shown(changed) };
}

// The bot's conversation and the sessions at its goal run Interactive or on Autopilot as the goal
// does: one setting, which the goal card and the bot's composer both show and change, and a switch
// reaches what's running. What it couldn't reach, it tries again on the box's next look. A goal's
// end takes them back to Interactive, unless its conversation was on Autopilot before it.
async function followMode(goal: KeptGoal, targets: () => Target[], file = GOALS_FILE): Promise<void> {
  const ended = goal.state !== "running";
  if (ended && goal.wasAutopilot) return;
  const on = !ended && modeOf(goal) === "autopilot";
  const own = await placeOfSession(goal.session, targets()).catch(() => null);
  let reached = Boolean(own?.data.id);
  const listed = await workSessions(targets(), undefined, { whole: true }).catch(() => {
    reached = false;
    return workSessions(targets()).catch((): Listed[] => []);
  });
  for (const each of [...(own ? [own] : []), ...goalWork(goal, listed)]) {
    if (!each.data.id || isAutopilot(each.data) === on) continue;
    if (!await setAutopilot(each.target, { ...each.data, id: each.data.id }, on).catch(() => false)) reached = false;
  }
  // (Ended, it's one try: a later look could turn off what you've switched on since.)
  if (ended) reached = true;
  changeKept(all => {
    const kept = all.find(one => one.id === goal.id);
    if (!kept || Boolean(kept.following) === !reached) return;
    if (reached) delete kept.following;
    else kept.following = true;
  }, file);
}

// The projects a plan makes, as you set them on its card before it starts (renamed, or moved to
// another folder): each a name, or a full path (~/… or /…), one to five, in their order. The bot
// isn't told now: it hears them as the goal starts, or as it proposes the plan again (which keeps
// them, unless it proposes other projects than it did).
function goalProjects(id: string, given: unknown, file: string): { goal: GoalPlanShape } | { refused: GoalRefusal } {
  const no = (message: string) => ({ refused: { status: 400 as const, message } });
  if (!Array.isArray(given) || !given.length || given.length > 5) return no("Send the plan's projects (projects): one to five, each a name or a full path (~/… or /…).");
  const named = projectsGiven(given);
  if ("refused" in named) return no(named.refused);
  const { projects } = named;
  const changed = changeKept(all => {
    const goal = all.find(each => each.id === id);
    if (!goal || !botHere(goal.bot)) return { status: 404 as const, message: "There's no such goal here." };
    if (goal.state !== "proposed") return { status: 400 as const, message: goal.state === "running" ? "That goal is running: its projects are made already." : "That goal has ended." };
    const bots = goal.botProjects ?? goal.projects;
    goal.projects = projects;
    if (sameProjects(projects, bots)) delete goal.botProjects;
    else goal.botProjects = bots;
    return goal;
  }, file);
  if (!("id" in changed)) return { refused: changed };
  noteWorkChanged(changed.bot);
  return { goal: shown(changed) };
}

// A spend line's cap and period as you set them (`spend: [{cap?, per?}]`, by line).
function capsGiven(lines: KeptGoal["spend"], given: unknown): KeptGoal["spend"] {
  if (!Array.isArray(given)) return lines;
  return lines.map((line, at) => {
    const yours = given[at];
    if (!isObject(yours)) return line;
    const next = { ...line, ...(typeof yours.cap === "number" && yours.cap > 0 ? { cap: yours.cap } : {}), ...(PERIODS.includes(yours.per as (typeof PERIODS)[number]) ? { per: yours.per as (typeof PERIODS)[number] } : {}) };
    // A cap raised past what's spent lets what spends go on.
    if (next.spent < next.cap) delete next.until;
    return next;
  });
}

/** Your change to a running goal (`change`: its caps, switches, Wake me, digest or end), or what
 * waits for you put away (`clear` with `waiting`, its id). The bot hears of a change. */
async function changeGoal(id: string, action: "change" | "clear", given: Record<string, unknown>, targets: () => Target[], file: string): Promise<{ goal: GoalPlanShape } | { refused: GoalRefusal }> {
  const ends = action === "change" ? endGiven(given.ends) : undefined;
  if (ends === null) return { refused: { status: 400, message: "The end (ends) is a date and time to come." } };
  if (action === "change" && given.mode !== undefined && !MODES.includes(given.mode as GoalMode)) return { refused: { status: 400, message: MODE_WORDS } };
  // What the bot's told of: how it runs, once that's another; its limits, once any is given.
  let switched = false;
  const limits = ["wake", "digest", "ends", "spend"].some(key => given[key] !== undefined);
  const changed = changeKept(all => {
    const goal = all.find(each => each.id === id);
    if (!goal) return { status: 404 as const, message: "There's no such goal here." };
    if (goal.state !== "running") return { status: 400 as const, message: "That goal isn't running." };
    if (action === "clear") {
      if (typeof given.waiting !== "string" || !goal.waiting.some(each => each.id === given.waiting)) return { status: 404 as const, message: "That isn't waiting any more." };
      goal.waiting = goal.waiting.filter(each => each.id !== given.waiting);
      return goal;
    }
    if (typeof given.wake === "boolean") goal.wake = given.wake;
    if (MODES.includes(given.mode as GoalMode) && given.mode !== modeOf(goal)) {
      goal.mode = given.mode as GoalMode;
      switched = true;
    }
    if (DIGESTS.includes(given.digest as (typeof DIGESTS)[number])) goal.digest = given.digest as (typeof DIGESTS)[number];
    if (ends !== undefined) goal.ends = ends;
    if (given.ends === null) delete goal.ends;
    // A new end (or none): told of it once it comes, not ended at once for the last one's.
    if (ends !== undefined || given.ends === null) delete goal.endTold;
    goal.spend = capsGiven(goal.spend, given.spend);
    return goal;
  }, file);
  if (!("id" in changed)) return { refused: changed };
  noteWorkChanged(changed.bot);
  if (switched) await followMode(changed, targets);
  const limitWords = `The user changed the goal's limits.${changed.spend.length ? ` What you may spend now: ${changed.spend.map(each => `${each.what}, up to ${each.cap} ${each.currency}${each.per === "goal" ? "" : ` a ${each.per}`}`).join("; ")}.` : ""}${changed.ends ? ` It ends at ${resetTime(changed.ends)}.` : ""}`;
  const modeWords = `The user switched the goal to ${modeName(modeOf(changed))}. ${howItRuns(modeOf(changed))}`;
  if (action === "change" && (switched || limits)) await tellBot(changed, `[Goal changed] ${[switched ? modeWords : "", limits ? limitWords : ""].filter(Boolean).join("\n")}`, switched && !limits ? `Now ${modeName(modeOf(changed))}` : "You changed the goal's limits", targets);
  return { goal: shown(changed) };
}

// What the conversation's goal checks after each of the bot's turns.
const loopCondition = (goal: KeptGoal) => `${goal.goal}\n\nIt's met once the work is done and ${goal.name} has given its report with finish_goal, or the user stops it.`;

// The conversation's goal (the agents bridge keeps the bot at it), set as the goal starts or taken
// away as it ends; nothing where this box has no agents bridge running (the plan goes on by wakes).
async function setGoalLoop(goal: KeptGoal, condition: string | null, _targets?: () => Target[], file = GOALS_FILE): Promise<boolean> {
  const bridge = bridgeTarget();
  if (!bridge) return false;
  const at = `/api/kuvo/goals/${encodeURIComponent(goal.session)}`;
  const done = condition
    ? await call(bridge, "PUT", at, { condition: condition.slice(0, 4000), long: true }).then(() => true, () => false)
    : await call(bridge, "DELETE", at).then(() => true, (error: { status?: number }) => error?.status === 404);
  if (done) {
    changeKept(all => {
      const kept = all.find(each => each.id === goal.id);
      if (kept) kept.loop = Boolean(condition);
    }, file);
  }
  return done;
}

// How a bot works through its goal, as a person who leads a team does: its sessions do the work,
// and it makes the projects, hands each step to one and follows them up. Told as it plans and as
// the goal starts, where even a small model reads it, unless the user said to do it all itself.
const LEAD_WORDS = (projects: { name: string; folder?: string }[]) => [
  "How you work through it: you lead, and sessions you start do the work. Unless the user told you to do it yourself:",
  `1. ${projects.length ? `Make ${projects.map(each => (each.folder ? `${each.name} with make_project (name "${each.name}", folder "${shownPath(each.folder)}")` : `${each.name} with make_project`)).join(", ")} first: you may, without asking.` : "Make a new project with make_project first, if the work needs one."} Never make a project's folder with mkdir or git init.`,
  "2. Hand each step to a session with start_session: in the project, with the step's number (step), and a task it can do from the message alone (what to do, where, what's there already, when it's done, what to report). Start every step that waits for nothing at once, each in a worktree of its own (worktree) when others work in the same project.",
  "3. Follow them up: you're woken when one finishes or asks. Read its report, answer what it asks, start the steps that waited for it, and send it back to fix what isn't done.",
  "Write no code and make no files of the work yourself, not even the first ones: a session does. If the plan is one small step, you may do it yourself.",
].join("\n");

const MODE_WORDS = "A goal runs interactive or autopilot (mode).";
const modeName = (mode: GoalMode) => (mode === "autopilot" ? "Autopilot" : "Interactive");

// How the bot runs its goal in each mode, told as it starts and as you switch it. Either way the
// plan's spending caps what it spends, and its conversations' modes what they may do.
function howItRuns(mode: GoalMode): string {
  if (mode === "autopilot") return [
    "How it runs: Autopilot. The user wants it done without being asked. Make every call your research settles yourself, taste and close options too, by what serves the goal best: keep each with goal_progress (decided: what, your choice, why, the choices there were), say it in a line, and go on.",
    "Take the plan's steps all the way, publishing, submitting, posting and sending included: the user's Start approved them.",
    "Nothing waits for the user. Never ask for what only they can do: pay for something on their own account (a membership, a subscription), sign in, make an account, hand over a key or a code, or anything destructive that can't be undone. Don't ask it with any tool, and don't decide it or do it for them: leave that step undone, keep it as waiting (goal_progress waiting, kind you), carry on with everything that doesn't depend on it, and list what's left in your report at the end.",
    "Anything else you do ask, mark your recommendation (Recommended): you go ahead on it at once, and the user's later answer confirms or redirects it. A question with no choice marked isn't put to them: it comes back declined. What's outside the plan is kept as waiting too, for the user to take up, and you spend only what the plan names.",
  ].join(" ");
  return [
    "How it runs: Interactive. The user wants a say in the calls that are theirs: taste and brand, options your research leaves close, a change of scope.",
    "Ask those gathered into one question, with your recommendation marked (Recommended). While other steps can go on, keep it as waiting (goal_progress waiting, kind judgment, your recommendation in its detail) and carry on with them; ask with the question tool only once nothing else can.",
    "Decide yourself what your research settles clearly and how the work gets done, and say it in a line (goal_progress decided). Never ask the user to approve your work.",
  ].join(" ");
}

// What the bot is told as the goal starts: what's approved, and how it goes.
function startWords(goal: KeptGoal): string {
  const lines = [
    `[Goal started] The user approved the plan. Work through it now, steps side by side where they don't depend on each other: ${goal.steps.map((each, at) => `${at + 1}. ${each.text}`).join(" ")}`,
    goal.spend.length ? `What you may spend, never more: ${goal.spend.map(each => `${each.what}, up to ${each.cap} ${each.currency}${each.per === "goal" ? "" : ` a ${each.per}`}`).join("; ")}. Ask may_spend before each purchase.` : "Spend nothing.",
    goal.ends ? `It ends at ${resetTime(goal.ends)}: be done by then, or wrap up and report.` : "",
    howItRuns(modeOf(goal)),
    LEAD_WORDS(goal.projects.map(goalProject)),
    "Mark each step with goal_progress as it starts, moves and ends (with progress where you can measure it), and keep what only the user can fix as waiting (it never stalls the rest: carry on with other steps). End with finish_goal and your report.",
  ];
  return lines.filter(Boolean).join("\n");
}

// Only what the bot started for a goal (once it started) is the goal's.
const goalWork = (goal: KeptGoal, sessions: Listed[]) => ofBot(goal.bot, sessions).filter(each => (each.data.time?.created ?? 0) >= (goal.started ?? goal.proposed) - 60_000);

/**
 * A conversation's goal paused or resumed, from any app: those go to the agents' bridge, which
 * keeps the goal and says so (`kuvo.goal.updated`, which this box follows). Paused by you, the turn
 * under way stops at once, what's been said kept, and the conversation is held as Stop holds it
 * (what reaches it meanwhile waits on the box); for a bot's goal, each of its sessions at work stops
 * too, and nothing of it goes on, not even at a limit's reset. Resumed, the conversation goes on,
 * and the bot is told to carry on from its plan. Cleared or ended while paused, it stays held for
 * you to Resume, as after a Stop. (Paused at a limit, for an error, or as you stopped a turn isn't
 * its Pause: left as it is.) The hold is kept on disk (its queue's `heldFor`, the bot's goal's
 * `heldByYou`), so a box that restarts carries on with it (`settleGoalHolds`). One change at a
 * time, in the order they came.
 */
export function goalHolds(targets: () => Target[], file = GOALS_FILE): (event: { type?: string; data?: any }) => Promise<void> {
  let order: Promise<void> = Promise.resolve();
  return event => {
    const session = event.data?.sessionID;
    if (event.type !== "kuvo.goal.updated" || typeof session !== "string") return order;
    const goal = isObject(event.data?.goal) ? event.data.goal : null;
    order = order.then(() => followGoal(session, goal, targets, file)).catch(() => {});
    return order;
  };
}

/** What the bridge says now of each conversation this box holds for its goal, and of each of its
 * bots' goals, read once it's found again (it, or this box, restarted, or the stream dropped and a
 * change went by unheard). */
export async function settleGoalHolds(bridge: Target, follow: (event: { type?: string; data?: any }) => Promise<void>, file = GOALS_FILE): Promise<void> {
  // (A bot's goal here, held or not: its hold goes only with its Resume, so one paused by you that
  // isn't held was missed. A conversation's own goal isn't caught up: you may have carried on in it
  // since, which lets its hold go while its goal stays paused.)
  const sessions = new Set([
    ...Object.entries(readQueues()).filter(([, state]) => state.heldFor === "goal").map(([session]) => session),
    ...readKept(file).filter(each => each.state === "running" && (each.heldByYou || botHere(each.bot))).map(each => each.session),
  ]);
  for (const session of sessions) {
    const goal = await asked(bridge, "GET", `api/kuvo/goals/${encodeURIComponent(session)}`).then(
      answer => (isObject(answer) && isObject(answer.data) ? answer.data : null),
      (error: Error) => (/\b404\b/.test(error.message) ? null : undefined),
    );
    if (goal !== undefined) await follow({ type: "kuvo.goal.updated", data: { sessionID: session, goal } });
  }
}

const pausedByYou = (goal: Record<string, unknown> | null) => goal?.state === "paused" && goal.pausedBy === "you" && goal.note === PAUSED_BY_YOU;

// Whether `session` is held for its goal: its queue says so, or, its queue let go with Resume on
// its own, its bot's goal still does.
const heldForGoal = (session: string, file: string) =>
  queueOf(session).heldFor === "goal" || readKept(file).some(each => each.session === session && each.state === "running" && each.heldByYou);

async function followGoal(session: string, goal: Record<string, unknown> | null, targets: () => Target[], file: string): Promise<void> {
  const held = heldForGoal(session, file);
  if (pausedByYou(goal)) {
    if (!held) await holdForGoal(session, targets, file);
  } else if (held && goal?.state === "working") {
    await letGoForGoal(session, targets, file);
  } else if (held && goal?.state !== "paused") {
    forgetHold(session, file);
  }
}

async function holdForGoal(session: string, targets: () => Target[], file: string): Promise<void> {
  const place = await placeOfSession(session, targets()).catch(() => null);
  if (place) {
    await stopSession(place.target, session).catch(() => {});
    changeQueue(session, current => ({ ...current, paused: true, heldFor: "goal" }));
  }
  const goal = changeKept(all => {
    const kept = all.find(each => each.session === session && each.state === "running" && botHere(each.bot));
    if (kept) kept.heldByYou = Date.now();
    return kept ?? null;
  }, file);
  if (!goal) return;
  // (Turns only: a pause goes on from where it was, so what they left running and set stays.)
  const [sessions, working] = await Promise.all([workSessions(targets()).catch((): Listed[] => []), workingNow(targets()).catch(() => new Set<string>())]);
  for (const each of goalWork(goal, sessions)) {
    if (working.has(each.data.id)) await stopSession(each.target, each.data.id, false).catch(() => {});
  }
  noteWorkChanged(goal.bot);
}

async function letGoForGoal(session: string, targets: () => Target[], file: string): Promise<void> {
  const place = await placeOfSession(session, targets()).catch(() => null);
  if (place) await resumeQueue(place.target, session).catch(() => {});
  const goal = forgetHold(session, file);
  if (!goal) return;
  await tellBot(goal, "[Goal resumed] The user resumed the goal you paused. Carry on from where it stopped: goal_progress shows the plan as it stands, and a session of it that stopped as it paused needs telling to carry on. Once it's all done, end with finish_goal.", "Goal resumed", targets);
}

// The hold's marks taken off, the conversation left as it is (still paused, unless it went on):
// the bot's goal it held, if any.
function forgetHold(session: string, file: string): KeptGoal | null {
  changeQueue(session, ({ heldFor: _, ...rest }) => rest);
  const goal = changeKept(all => {
    const kept = all.find(each => each.session === session && each.state === "running" && each.heldByYou);
    if (kept) delete kept.heldByYou;
    return kept ?? null;
  }, file);
  if (goal) noteWorkChanged(goal.bot);
  return goal;
}

// What a conversation shows as a limit it waited for resets: "The model's limit reset".
const resetLine = (why: string) => `${why.charAt(0).toUpperCase()}${why.slice(1)} reset`;

// `said` to the goal's bot, as a message in its conversation marked as the goal's, which a client
// shows as `line`. Not while it moves (nothing reaches it then): false, as for one not reached.
async function tellBot(goal: Pick<KeptGoal, "session">, said: string, line: string, targets: () => Target[]): Promise<boolean> {
  if (frozen().has(goal.session)) return false;
  const place = await placeOfSession(goal.session, targets()).catch(() => null);
  if (!place) return false;
  return sendInto(place.target, goal.session, { id: messageID(), text: said, delivery: "queue", metadata: boxNote("Goal", line) }, { from: "Goal", words: line }).then(() => true, () => false);
}

// What the bot's told of a goal asked for with /goal, after your words, in the block your bubble
// leaves out to show /goal in front of them, as the composer did (KuvoClient's
// SentWithKeyword.goalHeading, in these words).
const GOAL_ASKED = "The user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:";
// How to plan it, after /goal in the block (clients read only its first two lines).
const GOAL_PLANNING = [
  "Plan it as a lead whose sessions do the work: make each step one session's whole task (\"Build the app's screens\", \"Write the tests\"), not a command.",
  "Put each project it needs in projects: by name, or, where the user named a folder for it, that folder as a full path (~/… or /…). You make it with make_project once the goal starts.",
  "Make nothing before [Goal started]: no folders, files or code.",
];

/** /goal in a bot's chat: the bot asked to plan `words` as a goal and put it to you, now. */
export async function askGoal(session: string, words: string, targets: () => Target[]): Promise<{ text: string } | { refused: GoalRefusal }> {
  const said = text(words, 2000);
  if (!said) return { refused: { status: 400, message: "Say the goal (goal)." } };
  if (frozen().has(session)) return { refused: { status: 409, message: MOVING } };
  const place = await placeOfSession(session, targets()).catch(() => null);
  if (!place) return { refused: { status: 404, message: "There's no such conversation here." } };
  // You asked for it now: as a message of yours to go now, the queue goes on.
  changeQueue(session, state => ({ ...state, paused: false }));
  const sent = await asked(place.target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, {
    id: messageID(),
    text: [said, "", "<sent-with>", GOAL_ASKED, "/goal", ...GOAL_PLANNING, "</sent-with>"].join("\n"),
    delivery: "queue",
  }).then(() => true, () => false);
  return sent ? { text: "Asked for a plan." } : { refused: { status: 404, message: "The conversation can't be reached now." } };
}

// ——— What the bot does as it goes ———

const STEP_STATES = ["todo", "doing", "done", "waiting", "paused", "skipped"] as const;
const WAITING_KINDS = ["you", "judgment", "outside"] as const;

/** Something kept on `bot`'s running goal as waiting for you (deduplicated by its words). */
export function addWaiting(bot: string, item: Omit<GoalWaitingShape, "id" | "at">, file = GOALS_FILE, key?: string): GoalWaitingShape | null {
  const added = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return null;
    const same = goal.waiting.find(each => (key ? each.id === key : each.text === item.text && each.kind === item.kind));
    if (same) return same;
    const made: GoalWaitingShape = { id: key ?? newID("wait"), ...item, at: Date.now() };
    goal.waiting.push(made);
    goal.waiting = goal.waiting.slice(-60);
    return made;
  }, file);
  if (added) noteWorkChanged(bot);
  return added;
}

/** A call `bot` made on its own, kept on its running goal for you to see (once: by `key`, a
 * question the box answered, or by its words and choice). */
export function addDecided(bot: string, item: Omit<GoalDecidedShape, "id" | "at" | "yours">, file = GOALS_FILE, key?: string): GoalDecidedShape | null {
  const added = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return null;
    const decided = goal.decided ?? [];
    const same = decided.find(each => (key ? each.id === key : each.text === item.text && each.choice === item.choice));
    if (same) return same;
    const made: GoalDecidedShape = { id: key ?? newID("dec"), ...item, at: Date.now() };
    goal.decided = [...decided, made].slice(-60);
    return made;
  }, file);
  if (added) noteWorkChanged(bot);
  return added;
}

/** Your choice on a call a question went ahead on, on the goal that shows it too. */
export function yoursOnGoal(conversation: string, form: string, choice: string, file = GOALS_FILE): void {
  const bots = changeKept(all => all.flatMap(goal => {
    const call = goal.state === "running" ? goal.decided?.find(each => each.id === `ask:${conversation}:${form}`) : undefined;
    if (!call) return [];
    call.yours = { choice, at: Date.now() };
    return [goal.bot];
  }), file);
  for (const bot of bots) noteWorkChanged(bot);
}

/** The calls a question went ahead on in a conversation carried on as `to`, on the goal that shows
 * them: its own from now on. */
export function carriedOnGoal(from: string, to: string, file = GOALS_FILE): void {
  changeKept(all => {
    for (const goal of all) {
      // A bot's conversation carried on: its goal goes on there.
      if (goal.state === "running" && goal.session === from) goal.session = to;
      for (const call of goal.decided ?? []) {
        if (!call.id.startsWith(`ask:${from}:`)) continue;
        call.id = `ask:${to}:${call.id.slice(`ask:${from}:`.length)}`;
        call.session = to;
      }
    }
  }, file);
}

/** A conversation gone from this box: the calls made in it go from its goal too. */
export function forgottenOnGoal(session: string, file = GOALS_FILE): void {
  const mine = (call: GoalDecidedShape) => call.id.startsWith(`ask:${session}:`);
  if (!readKept(file).some(goal => goal.decided?.some(mine))) return;
  changeKept(all => {
    for (const goal of all) if (goal.decided?.some(mine)) goal.decided = goal.decided.filter(call => !mine(call));
  }, file);
}

// Your choice on a call the bot made on its own: the same confirms it, quietly; another has the
// bot go that way from here.
async function decidedByYou(id: string, given: Record<string, unknown>, targets: () => Target[], file: string): Promise<{ goal: GoalPlanShape } | { refused: GoalRefusal }> {
  const choice = line(given.choice, CHOICE_MOST);
  if (!choice) return { refused: { status: 400, message: "Say your choice (choice)." } };
  const goal = readKept(file).find(each => each.id === id);
  if (!goal || !botHere(goal.bot)) return { refused: { status: 404, message: "There's no such goal here." } };
  if (goal.state !== "running") return { refused: { status: 400, message: "That goal isn't running." } };
  const decided = goal.decided?.find(each => each.id === given.decided);
  if (!decided) return { refused: { status: 404, message: "There's no such call on it." } };
  // One a question went ahead on: its conversation's, which it tells (and which keeps it here too).
  const asked = decided.id.match(/^ask:([^:]+):(.+)$/);
  if (asked) {
    const place = await placeOfSession(asked[1], targets()).catch(() => null);
    if (!place) return { refused: { status: 404, message: "That conversation isn't here." } };
    const answered = await decidedInConversation(place.target, asked[1], asked[2], choice);
    if ("status" in answered) return { refused: { status: answered.status, message: answered.message } };
    return { goal: shown(readKept(file).find(each => each.id === id) ?? goal) };
  }
  const was = decided.yours?.choice ?? decided.choice;
  // Kept once the bot is told, so a choice that didn't reach it can be made again.
  if (choice.toLowerCase() !== was.toLowerCase() && !await tellBot(goal, decisionChanged({ text: decided.text, was, yours: choice, again: Boolean(decided.yours) }), `You picked ${choice}`, targets)) {
    return { refused: { status: 502, message: "The bot couldn't be told: try again." } };
  }
  const changed = changeKept(all => {
    const kept = all.find(each => each.id === id);
    const call = kept?.decided?.find(each => each.id === decided.id);
    if (call) call.yours = { choice, at: Date.now() };
    return kept ?? goal;
  }, file);
  noteWorkChanged(changed.bot);
  return { goal: shown(changed) };
}

/** Asks answered or skipped lately, by id, and when: a look at a conversation's asks begun
 * before the answer doesn't bring one back. */
const settledAsks = new Map<string, number>();
const SETTLED_KEPT = 5 * 60_000;

/** An ask answered or skipped (`ask`, a permission's or a form's id): what stands for it on a
 * running goal goes at once, rather than on the watch's next look. */
export function settleAsk(ask: string, file = GOALS_FILE, now = Date.now()): void {
  for (const [id, at] of settledAsks) if (now - at > SETTLED_KEPT) settledAsks.delete(id);
  settledAsks.set(ask, now);
  const settled = changeKept(all => {
    const bots: string[] = [];
    for (const goal of all.filter(each => each.state === "running")) {
      const left = goal.waiting.filter(item => !(item.kind === "ask" && item.id.startsWith("ask:") && item.id.endsWith(`:${ask}`)));
      if (left.length === goal.waiting.length) continue;
      goal.waiting = left;
      bots.push(goal.bot);
    }
    return bots;
  }, file);
  for (const bot of settled) noteWorkChanged(bot);
}

/** A pause of `bot`'s running goal (or one of its sessions) until a limit resets: kept, its steps
 * marked, and carried on by the box's watch once `until` comes; or, with no `until`, until it's
 * let go (Auto's reviewer's, once you resume it). */
export function pauseGoal(bot: string, pause: { why: string; until?: number; session?: string }, file = GOALS_FILE): boolean {
  const done = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return false;
    const key = pause.session ?? "bot";
    // (Auto's reviewer's stays until you resume it: a limit there doesn't take its place.)
    if (pause.why !== REVIEW_PAUSE && goal.paused.some(each => each.session === pause.session && each.why === REVIEW_PAUSE)) return true;
    if (!goal.paused.length) goal.pausedSince = Date.now();
    goal.paused = [...goal.paused.filter(each => (each.session ?? "bot") !== key), pause];
    return true;
  }, file);
  if (done) noteWorkChanged(bot);
  return done;
}

/** Why a goal's session is paused by Auto's reviewer, as its card says it. */
export const REVIEW_PAUSE = "Auto's reviewer refused too many times: waiting for you";

/** A session paused by Auto's reviewer let go again (you resumed it): off any running goal's card. */
export function resumeReviewedSession(session: string, file = GOALS_FILE): void {
  for (const goal of readKept(file)) {
    if (goal.state === "running" && goal.paused.some(each => each.session === session && each.why === REVIEW_PAUSE)) unpause(goal.id, session, Date.now(), file);
  }
}

/** A session the bot started for one of its goal's steps (by number or id): the step's track
 * follows it. */
export function linkSession(bot: string, step: unknown, session: string, file = GOALS_FILE): boolean {
  const linked = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    const at = !goal ? -1 : typeof step === "number" ? step - 1 : goal.steps.findIndex(each => each.id === step);
    if (!goal || !goal.steps[at]) return false;
    const each = goal.steps[at];
    goal.steps[at] = { ...each, state: each.state === "todo" ? "doing" : each.state, began: each.began ?? Date.now(), sessions: [...new Set([...(each.sessions ?? []), session])] };
    return true;
  }, file);
  if (linked) noteWorkChanged(bot);
  return linked;
}

// Where you are, in a line, for what the bot does next, and how it runs.
const presence = (mode: GoalMode = "interactive") => `${isHere() ? "The user is here now." : "The user is away now: carry on with what doesn't need them."} ${mode === "autopilot" ? "On Autopilot: decide what your research settles, and leave what only the user can do undone, kept as waiting, while the rest goes on." : "Interactive: ask the user only the calls that are theirs."}`;

// A time a step waits for, as goal_progress takes it (ISO words, or ms; seconds, as wake-ups give
// it, read as such): null for one it can't read.
function untilOf(value: unknown): number | null {
  const at = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? Date.parse(value.trim()) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

const stepAt = (step: unknown, steps: readonly GoalStepShape[]) => (typeof step === "number" ? step - 1 : typeof step === "string" ? steps.findIndex(each => each.id === step) : -1);

/** Why goal_progress can't take what it was given (as `goalProgress` would refuse it), before
 * anything is looked for; null for nothing. */
export function progressRefused(bot: string, given: Record<string, unknown>, file = GOALS_FILE): string | null {
  const checked = progressGiven(bot, given, file);
  return "refused" in checked ? checked.refused : null;
}

// goal_progress's call, checked whole: nothing's kept of a call that's wrong somewhere.
function progressGiven(bot: string, given: Record<string, unknown>, file: string): { marks: Record<string, unknown>[]; spent: Record<string, unknown>[] } | { refused: string } {
  const running = runningGoal(bot, file);
  if (!running) return { refused: "No goal is running: propose one with propose_goal, and the user starts it." };
  const marks = Array.isArray(given.steps) ? given.steps : given.step !== undefined ? [{ step: given.step, state: given.state, progress: given.progress, note: given.note, until: given.until, app: given.app }] : [];
  for (const mark of marks) {
    if (!isObject(mark) || !running.steps[stepAt(mark.step, running.steps)]) return { refused: `There's no step ${isObject(mark) ? String(mark.step) : ""}: the plan has ${running.steps.length} (add new ones with add).` };
    if (mark.state !== undefined && !STEP_STATES.includes(mark.state as (typeof STEP_STATES)[number])) return { refused: "A step's state is todo, doing, done, waiting, paused or skipped." };
    if (mark.progress !== undefined && mark.progress !== null && !(typeof mark.progress === "number" && mark.progress >= 0 && mark.progress <= 1)) return { refused: "A step's progress is a share from 0 to 1, given only where you can measure it (3 of 8 pages is 0.375)." };
    // The user sees what was counted, and the track fills by it: never a bare share.
    if (typeof mark.progress === "number" && mark.progress < 1 && !text(mark.note, 300)) return { refused: "Say what you counted with the share, in note: progress 0.375 with note \"3 of 8 pages\". The user sees the count." };
    if (mark.until !== undefined && mark.until !== null && untilOf(mark.until) === null) return { refused: "until is when the step can start, as a time like 2026-11-02T09:00 (or null to take it away)." };
    if (mark.app !== undefined && mark.app !== null && mark.app !== "" && !appNameGiven(mark.app)) return { refused: "app is the app the step is done in on the computer, by its name, like \"Xcode\" (or null to take it away)." };
  }
  if (isObject(given.waiting) && (!text(given.waiting.text, 300) || !WAITING_KINDS.includes(given.waiting.kind as (typeof WAITING_KINDS)[number]))) return { refused: "What waits needs its kind (you, judgment or outside) and what it is (text)." };
  if (given.decided !== undefined && (!isObject(given.decided) || !text(given.decided.text, 300) || !text(given.decided.choice, 200))) return { refused: "A call you made is {text (what it was), choice, why}." };
  if (isObject(given.waiting) && given.waiting.step !== undefined && given.waiting.step !== null && !running.steps[stepAt(given.waiting.step, running.steps)]) return { refused: `The step it holds up (step) is one of the plan's, from 1 to ${running.steps.length}.` };
  const spent = Array.isArray(given.spent) ? given.spent : isObject(given.spent) ? [given.spent] : [];
  for (const each of spent) if (!isObject(each) || !text(each.what, 200) || typeof each.amount !== "number" || !(each.amount > 0)) return { refused: "What's spent is {what, amount}." };
  return { marks: marks as Record<string, unknown>[], spent: spent as Record<string, unknown>[] };
}

/** goal_progress: steps marked (and added as the plan changes), something waiting for you, what's
 * spent, what's still watched. */
export function goalProgress(bot: string, given: Record<string, unknown>, file = GOALS_FILE): { said: string } | { refused: string } {
  const checked = progressGiven(bot, given, file);
  if ("refused" in checked) return checked;
  const { marks, spent } = checked;
  const added = (Array.isArray(given.add) ? given.add : []).map(stepGiven).filter((each): each is NonNullable<typeof each> => Boolean(each));
  const resolved = (Array.isArray(given.resolved) ? given.resolved : []).map(each => text(each, 300)).filter((each): each is string => Boolean(each));
  const notes: string[] = [];
  const unplanned: string[] = [];
  const goneOn = new Set<string>();
  let holds: string | undefined;
  changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return;
    if (isObject(given.waiting)) holds = goal.steps[stepAt(given.waiting.step, goal.steps)]?.id;
    for (const mark of marks) {
      const at = stepAt(mark.step, goal.steps);
      const step = goal.steps[at];
      const next: GoalStepShape = { ...step };
      if (mark.state !== undefined) next.state = mark.state as GoalStepShape["state"];
      if (typeof mark.progress === "number") next.progress = mark.progress;
      if (mark.progress === null) delete next.progress;
      if (next.state === "done") next.progress = 1;
      // When it began and ended, for a time axis: begun as it's first under way, ended as it's
      // done or set aside (and begun again if it's taken up again).
      if (next.state !== "todo" && next.began === undefined) next.began = Date.now();
      if (next.state === "done" || next.state === "skipped") next.ended = next.ended ?? Date.now();
      else delete next.ended;
      if (text(mark.note, 300)) next.note = text(mark.note, 300)!;
      else if (mark.note === null || mark.note === "") delete next.note;
      if (next.state !== "paused") delete next.resumes;
      // The app it's done in, named again, or taken away.
      const app = appGiven(mark.app);
      if (app) next.app = app;
      else if (mark.app === null || mark.app === "") delete next.app;
      // Put off until a time, or no longer: taken up (or set aside), it's at it now.
      const until = mark.until === null ? null : untilOf(mark.until);
      if (until !== null) next.until = until;
      else if (mark.until === null || (mark.state !== undefined && next.state !== "todo")) delete next.until;
      goal.steps[at] = next;
      notes.push(`step ${at + 1} ${next.state}${next.until ? ` until ${new Date(next.until).toISOString()}` : ""}`);
      // Gone on with, by this mark: not a word on how far a step under way has got.
      if (next.state !== step.state && (next.state === "doing" || next.state === "done" || next.state === "skipped")) goneOn.add(next.id);
    }
    // What held up a step the bot goes on with now is settled.
    if (goneOn.size) {
      const before = goal.waiting.length;
      goal.waiting = goal.waiting.filter(item => !(item.step && goneOn.has(item.step)));
      if (goal.waiting.length < before) notes.push(`${before - goal.waiting.length} no longer waiting, as its step goes on`);
    }
    for (const step of keptSteps(added, goal.steps.length)) {
      goal.steps.push(step);
      notes.push(`step ${goal.steps.length} added`);
    }
    if (Array.isArray(given.watching)) {
      goal.watching = given.watching.map(each => text(each, 200)).filter((each): each is string => Boolean(each)).slice(0, 10);
      notes.push(goal.watching.length ? `watching ${goal.watching.length}` : "watching nothing");
    }
    freshPeriods(goal);
    // What waited and is dealt with now (by its id, or its words).
    if (resolved.length) {
      const before = goal.waiting.length;
      goal.waiting = goal.waiting.filter(item => item.kind === "ask" || !resolved.some(each => each === item.id || each.toLowerCase() === item.text.toLowerCase()));
      if (goal.waiting.length < before) notes.push(`${before - goal.waiting.length} no longer waiting`);
    }
    // At it now: the bot is told to carry on only once it's quiet again a while.
    delete goal.idleSince;
    goal.nudges = 0;
    for (const each of spent) {
      const line = goal.spend.find(line => line.what.toLowerCase() === String(each.what).trim().toLowerCase());
      if (!line) {
        unplanned.push(String(each.what).trim());
        notes.push(`${String(each.what)} isn't one of the plan's spend lines: it's kept as waiting for the user`);
        continue;
      }
      line.spent += each.amount as number;
      if (line.spent >= line.cap) line.until = periodEnd(line.per, Date.now());
      notes.push(`${line.what}: ${line.spent} of ${line.cap} ${line.currency}${line.until ? `, the cap is reached until ${resetTime(line.until)}` : line.per === "goal" && line.spent >= line.cap ? ", the cap is reached" : ""}`);
    }
  }, file);
  for (const what of unplanned) addWaiting(bot, { kind: "outside", text: `Spent on ${what}, which isn't in the plan` }, file);
  if (isObject(given.waiting)) {
    const url = https(given.waiting.url);
    const site = siteOf(given.waiting.site) ?? siteOf(url);
    const app = appGiven(given.waiting.app);
    addWaiting(bot, { kind: given.waiting.kind as (typeof WAITING_KINDS)[number], text: text(given.waiting.text, 300)!, ...(text(given.waiting.detail, 500) ? { detail: text(given.waiting.detail, 500)! } : {}), ...(url ? { url } : {}), ...(site ? { site } : {}), ...(app ? { app } : {}), ...(holds && !goneOn.has(holds) ? { step: holds } : {}) }, file);
    notes.push("kept as waiting for the user: carry on with what doesn't depend on it");
  }
  if (isObject(given.decided)) {
    const options = (Array.isArray(given.decided.options) ? given.decided.options : []).map(each => line(each, 200)).filter((each): each is string => Boolean(each)).slice(0, 10);
    const why = line(given.decided.why, 300);
    addDecided(bot, { text: line(given.decided.text, 300)!, choice: line(given.decided.choice, 200)!, ...(why ? { why } : {}), ...(options.length ? { options } : {}) }, file);
    notes.push("decided, kept for the user to see: go on with it");
  }
  noteWorkChanged(bot);
  const mode = runningGoal(bot, file)?.mode;
  return { said: `${notes.length ? `Noted: ${notes.join("; ")}.` : "Nothing to note: give steps, add, waiting, decided, spent or watching."} ${presence(mode)}` };
}

/** may_spend: whether `amount` for `what` fits the plan's cap for it, in its period now. */
export function maySpend(bot: string, given: Record<string, unknown>, file = GOALS_FILE): { said: string } | { refused: string } {
  const goal = runningGoal(bot, file);
  if (!goal) return { refused: "No goal is running. Ask the user." };
  const what = text(given.what, 200);
  const amount = given.amount;
  if (!what || typeof amount !== "number" || !(amount > 0)) return { refused: "Say what it's for (what) and how much (amount)." };
  freshPeriods(goal);
  const line = goal.spend.find(each => each.what.toLowerCase() === what.toLowerCase());
  if (!line) return { said: `No: "${what}" isn't one of the plan's spend lines. Keep it as waiting for the user.` };
  const left = line.cap - (goal.periods?.[goal.spend.indexOf(line)] === periodOf(line.per, Date.now()) ? line.spent : 0);
  if (amount <= left) return { said: `Yes: ${amount} ${line.currency} fits (${left} ${line.currency} left${line.per === "goal" ? "" : ` this ${line.per}`}). Report it with goal_progress spent once it's paid.` };
  const end = periodEnd(line.per, Date.now());
  return { said: `No: only ${Math.max(0, left)} ${line.currency} is left${end ? ` until ${resetTime(end)}, when it starts again: carry on with what doesn't spend, and it can wait till then` : ": keep it as waiting for the user, who can raise the cap on the goal"}.` };
}

/** finish_goal: the goal done, with the report. */
export async function finishGoal(bot: string, given: Record<string, unknown>, targets: () => Target[], file = GOALS_FILE): Promise<{ said: string } | { refused: string }> {
  const report = text(given.report, 6000);
  if (!report) return { refused: "Give the report (report): what needs the user first, then what got done and where, what it spent, and what you're still watching." };
  const done = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return null;
    goal.state = "done";
    goal.ended = Date.now();
    goal.report = report;
    if (Array.isArray(given.watching)) goal.watching = given.watching.map(each => text(each, 200)).filter((each): each is string => Boolean(each)).slice(0, 10);
    return goal;
  }, file);
  if (!done) return { refused: "No goal is running." };
  noteWorkChanged(bot);
  await setGoalLoop(done, null, targets);
  await followMode(done, targets, file);
  return { said: "The goal is done. Say the report in your reply too, briefly." };
}

// ——— The box's watch over goals ———

// "Claude's limit", from a session's model.
const limitName = (model: unknown): string => {
  const provider = isObject(model) && typeof model.providerID === "string" ? model.providerID : "";
  const names: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", google: "Gemini", "github-copilot": "Copilot", xai: "Grok", deepseek: "DeepSeek", openrouter: "OpenRouter", opencode: "OpenCode" };
  return `${names[provider] ?? (provider || "the model")}'s limit`;
};

// A session's last turn, if it failed: its end's id, when it ended, and the error's words.
async function failedTurn(target: Target, session: string, signal?: AbortSignal): Promise<{ idle: string; at: number | null; error: string } | null> {
  const page = await call(target, "GET", `/api/session/${encodeURIComponent(session)}/message?limit=5&order=desc`, undefined, signal).catch(() => null);
  for (const message of Array.isArray(page) ? page : []) {
    if (!isObject(message) || message.type !== "idle") continue;
    if (message.outcome !== "failed") return null;
    const error = isObject(message.error) ? String(message.error.message ?? "") : "";
    const at = isObject(message.time) && typeof message.time.created === "number" ? message.time.created : null;
    return { idle: String(message.id ?? ""), at, error };
  }
  return null;
}

// A question answered with what it recommends; whether it went.
// A digest of the goal since the last: steps done since, what waits, how long it waited at limits.
function digestWords(goal: KeptGoal, now: number): string {
  const done = goal.steps.filter(step => step.state === "done" || step.state === "skipped").length;
  const since = Math.max(0, done - (goal.doneAtDigest ?? 0));
  const day = Math.max(1, Math.floor((now - (goal.started ?? now)) / DAY));
  const parts = [`${since} ${since === 1 ? "step" : "steps"} done (${done} of ${goal.steps.length} in all)`];
  if (goal.waiting.length) parts.push(`${goal.waiting.length} ${goal.waiting.length === 1 ? "waits" : "wait"} for you`);
  const waited = goal.waited + (goal.paused.length && goal.pausedSince ? now - goal.pausedSince : 0);
  if (waited > 0) {
    const hours = Math.round(waited / 3_600_000);
    parts.push(hours >= 1 ? `waited ${hours} h at limits in all` : `waited ${Math.max(1, Math.round(waited / 60_000))} min at limits in all`);
  }
  if (goal.paused.length) parts.push(`paused: ${goal.paused.map(each => `${each.why}${each.until ? ` until ${resetTime(each.until)}` : ""}`).join(", ")}`);
  return `${goal.digest === "week" ? `Week ${Math.max(1, Math.floor(day / 7))}` : `Day ${day}`}: ${parts.join(", ")}.`;
}

// The plan as it stands, for whether anything changed since the bot was told to carry on: each
// step's state, progress, put-off time and sessions, and what waits.
const planNow = (goal: KeptGoal) => JSON.stringify([goal.steps.map(step => [step.id, step.state, step.progress ?? null, step.until ?? null, step.sessions?.length ?? 0]), goal.waiting.map(item => item.id)]);

/** How long a goal with nothing at work waits before its bot is told to carry on: longer each time. */
const NUDGE_AFTER = [10, 30, 60, 120, 240, 480, 720].map(minutes => minutes * 60_000);

/** One look at the goals running here (`now`, a test's clock):
 * - whether you're here, kept for the tools (`here`);
 * - an end that has come: the bot told to wrap up, and the goal ended with a word if it doesn't;
 * - the conversation's goal (its loop) kept as the plan is: set while it runs, taken away once it
 *   ends; its pause at a model's limit shown as the plan's;
 * - the Mac kept awake only while some goal's work is at it (on power);
 * - a session that failed at a model's limit paused until the reset (from when it failed), and told
 *   to carry on then; a paused session that's gone let go;
 * - what its sessions (and the bot itself) ask that the bot hasn't answered, listed as waiting for
 *   you (it waits; it never turns into a no);
 * - the bot told to carry on once nothing of the goal has been at work for a while (longer each
 *   time), unless all that's left waits for you or a limit;
 * - what's new told to your phones: what waits for you (quietly, unless Wake me), a digest as often
 *   as it was asked for, and the report. */
export async function lookAtGoals(tell: (notice: Notice) => boolean, targets: () => Target[], { file = GOALS_FILE, here, now = Date.now(), signal }: { file?: string; here?: () => boolean; now?: number; signal?: AbortSignal } = {}): Promise<void> {
  if (here) {
    try { writePrivate(HERE_FILE, JSON.stringify({ here: here(), at: Date.now() })); } catch {}
  }
  // An end that has come: told once to wrap up; ended with a word if it hasn't by a while after.
  for (const goal of readKept(file).filter(each => each.state === "running" && each.ends && now >= each.ends && botHere(each.bot))) {
    if (!goal.endTold) {
      changeKept(all => {
        const kept = all.find(each => each.id === goal.id);
        if (kept) kept.endTold = now;
      }, file);
      await tellBot(goal, "[Goal's end] The end the user set has come. Finish the step under way, start nothing new, and end with finish_goal and your report.", "The goal's end came", targets);
    } else if (now - goal.endTold >= WRAP_UP) {
      const ended = changeKept((all): KeptGoal | null => {
        const kept = all.find(each => each.id === goal.id && each.state === "running");
        if (!kept) return null;
        kept.state = "stopped";
        kept.ended = now;
        kept.report = `${kept.name} reached the end you set: ${kept.steps.filter(step => step.state === "done" || step.state === "skipped").length} of ${kept.steps.length} steps done. Ask it where things stand.`;
        return kept;
      }, file);
      if (ended) {
        noteWorkChanged(goal.bot);
        await stopBotWork(goal.bot, targets(), signal, { tell: false }).catch(() => 0);
        await followMode(ended, targets, file);
      }
    }
  }
  // Its conversation's goal (the loop), as the plan is.
  const bridge = bridgeTarget();
  for (const goal of readKept(file).filter(each => botHere(each.bot) && each.state !== "proposed" && each.state !== "declined")) {
    if (goal.state !== "running") {
      if (goal.loop) await setGoalLoop(goal, null, targets, file);
      continue;
    }
    if (!bridge) continue;
    // (Set again only once the bridge says it has none: one it couldn't read now may be one you paused.)
    const loop = await call(bridge, "GET", `/api/kuvo/goals/${encodeURIComponent(goal.session)}`, undefined, signal).then(
      data => (isObject(data) ? data : null),
      (error: { status?: number }) => (error?.status === 404 ? null : undefined),
    );
    if (loop === undefined) continue;
    if (!loop) {
      await setGoalLoop(goal, loopCondition(goal), targets, file);
      continue;
    }
    // The bot's own turn waits for a model's limit: shown as the goal's pause.
    const atLimit = loop.state === "paused" && loop.pausedBy === "limit" && typeof loop.resumesAt === "number";
    const shownPause = goal.paused.find(each => each.session === goal.session);
    // (Not one Auto's reviewer put there: that's yours to resume.)
    if (shownPause?.why === REVIEW_PAUSE) continue;
    if (atLimit && shownPause?.until !== loop.resumesAt) pauseGoal(goal.bot, { why: "the model's limit", until: loop.resumesAt as number, session: goal.session }, file);
    if (!atLimit && shownPause) unpause(goal.id, goal.session, now, file);
  }
  const running = readKept(file).filter(goal => goal.state === "running" && botHere(goal.bot));
  const sessions = running.length ? await workSessions(targets(), signal).catch((): Listed[] => []) : [];
  // Turns under way, and what's left running besides: that keeps the Mac awake, but only for a time
  // does it hold off a nudge (a dev server would stall the goal), and it never hides a failed turn.
  const turns = running.length ? await workingNow(targets(), signal).catch(() => new Set<string>()) : new Set<string>();
  const left = running.length ? readBackground() : {};
  const working = new Set([...turns, ...Object.keys(left)]);
  const busy = new Set([...turns, ...Object.keys(left).filter(id => now - left[id]!.since < NUDGE_HOLD)]);
  const workOf = (goal: KeptGoal) => goalWork(goal, sessions);
  // Awake only while some goal's work is at it: the bot, or one of its sessions.
  keepAwake(running.some(goal => working.has(goal.session) || workOf(goal).some(each => working.has(each.data.id))));
  for (const goal of running) {
    const work = workOf(goal);
    const own = await placeOfSession(goal.session, targets()).catch(() => null);
    // A session whose turn failed at a model's limit: paused until it resets.
    const limitsSeen = { ...(goal.limitsSeen ?? {}) };
    for (const each of work) {
      if (turns.has(each.data.id)) continue;
      const failed = await failedTurn(each.target, each.data.id, signal);
      if (!failed || limitsSeen[each.data.id] === failed.idle || !isLimit(failed.error)) continue;
      limitsSeen[each.data.id] = failed.idle;
      pauseGoal(goal.bot, { why: limitName(each.data.model), until: resetsIn(failed.error, failed.at ?? now) ?? now + UNKNOWN_RESET, session: each.data.id }, file);
    }
    // A pause whose time has come: carried on (a session that's gone, or put away, let go).
    const kept = readKept(file).find(each => each.id === goal.id);
    // (Not while you have it paused: once you resume it.)
    for (const paused of kept?.heldByYou ? [] : kept?.paused ?? []) {
      if (paused.session === goal.session) continue;
      if (paused.session) {
        const place = await placeOfSession(paused.session, targets()).catch(() => undefined);
        if (place === null || place?.data.metadata?.kuvo?.archived === true) {
          unpause(goal.id, paused.session, now, file);
          continue;
        }
        if (!paused.until || now < paused.until || !place) continue;
        const carried = await sendInto(place.target, paused.session, { id: messageID(), text: `[Limit reset] ${paused.why} has reset. Carry on where you stopped.`, delivery: "queue", metadata: boxNote("Goal", resetLine(paused.why)) }, { from: "Goal", words: resetLine(paused.why) }).then(() => true, () => false);
        if (carried) unpause(goal.id, paused.session, now, file);
        continue;
      }
      if (!paused.until || now < paused.until) continue;
      if (await tellBot(goal, `[Limit reset] ${paused.why} has reset. Carry on with the goal.`, resetLine(paused.why), targets)) unpause(goal.id, undefined, now, file);
    }
    // What its sessions, and the bot itself, ask that the bot hasn't answered: waiting for you,
    // never a no. On Autopilot, a question that recommends a choice goes ahead on it instead, kept
    // as a call the bot made (a permission never: its conversation's mode decides those).
    if (kept?.following) await followMode(kept, targets, file);
    const asksSeen: Record<string, number> = {};
    const open = new Set<string>();
    const askers = [...work.map(each => ({ target: each.target, id: each.data.id, title: each.data.title || "New Session", data: each.data as Pick<EngineSession, "id" | "metadata" | "location"> })), ...(own ? [{ target: own.target, id: goal.session, title: goal.name, data: { ...own.data, id: goal.session } as Pick<EngineSession, "id" | "metadata" | "location"> }] : [])];
    for (const each of askers) {
      const { permissions, questions } = await asksIn(each.target, each.id, signal).catch(() => ({ permissions: [], questions: [] }));
      const asks: { id: string; text: string; question?: PendingQuestion }[] = [...permissions.map(one => ({ id: one.id, text: `${each.title}: ${permissionWords(one).replace(/\.$/, "")}` })), ...questions.map(one => ({ id: one.id, text: `${each.title} asks: ${one.text}`, question: one }))];
      if (isAutopilot(each.data)) await declineSharedIn(each.target, each.data, signal);
      for (const ask of asks) {
        const key = `${each.id}:${ask.id}`;
        if (settledAsks.has(ask.id)) continue;
        open.add(key);
        asksSeen[key] = kept?.asksSeen?.[key] ?? now;
        // (The bot's own: yours at once; its sessions': once the bot has had a moment.)
        if (each.id !== goal.session && now - asksSeen[key] < ASK_SETTLES) continue;
        // (Already followed, or missed as the event went by: as the box does as they come.)
        if (ask.question && isAutopilot(each.data) && await goAheadOnQuestion(each.target, each.data, ask.question, undefined, signal)) {
          open.delete(key);
          continue;
        }
        addWaiting(goal.bot, { kind: "ask", text: ask.text, session: each.id }, file, `ask:${key}`);
      }
    }
    // Nothing of it at work a while, and something it can do now: the bot is told to carry on. Not
    // while all that's left waits for you, a limit or a time (a wake-up the bot set itself, or the
    // steps it put off until then): the goal says when it goes on next, and the wait for a nudge
    // starts from that time, so one comes only if what came then started nothing.
    const live = readKept(file).find(each => each.id === goal.id);
    const atWork = busy.has(goal.session) || work.some(each => busy.has(each.data.id));
    const left = (live?.steps ?? []).filter(step => step.state !== "done" && step.state !== "skipped");
    const pausedSessions = new Set((live?.paused ?? []).map(each => each.session).filter(Boolean));
    const doable = left.filter(step => (step.state === "todo" || step.state === "doing") && !(step.sessions?.length && step.sessions.every(id => pausedSessions.has(id))));
    const nowDoable = doable.filter(step => !(step.until && step.until > now));
    // (A wake-up that comes back, a daily check, holds nothing back while there's work to do now.)
    const wakes = readWakes(path.join(BOTS, goal.bot));
    const woken = wakes.paused ? undefined : wakes.wakes.filter(each => !each.every || !nowDoable.length).map(each => each.due * 1000).find(due => due > now);
    const putOff = nowDoable.length ? [] : doable.map(step => step.until!).filter(until => until > now);
    const next = [woken, ...putOff].filter((at): at is number => at !== undefined).sort((a, b) => a - b)[0];
    const canGoOn = !live?.heldByYou && !(live?.paused ?? []).some(each => !each.session || each.session === goal.session)
      && nowDoable.length > 0 && woken === undefined;
    // Told already and nothing changed, but its turn failed: told again, after a while as before.
    const failed = !atWork && canGoOn && live?.nudgedPlan && own ? await failedTurn(own.target, goal.session, signal) : null;
    let nudge = false;
    changeKept(all => {
      const kept = all.find(each => each.id === goal.id);
      if (!kept) return;
      kept.asksSeen = asksSeen;
      kept.limitsSeen = limitsSeen;
      // Asks answered since (here, on a phone, by the bot) leave the list, and clients are told.
      const asked = kept.waiting.length;
      kept.waiting = kept.waiting.filter(item => item.kind !== "ask" || open.has(item.id.replace(/^ask:/, "")));
      if (freshPeriods(kept, now) || kept.waiting.length < asked) noteWorkChanged(kept.bot);
      const shownNext = atWork || kept.heldByYou ? undefined : next;
      if (kept.next !== shownNext) {
        if (shownNext === undefined) delete kept.next;
        else kept.next = shownNext;
        noteWorkChanged(kept.bot);
      }
      if (atWork) {
        delete kept.idleSince;
        kept.nudges = 0;
        return;
      }
      // Waiting on a time: quiet from then on, as if it went quiet as the time came, and told (as
      // soon as the first time) if what came then started nothing, though the plan's the same. A
      // wait taken away leaves no quiet time ahead.
      if (next !== undefined) {
        kept.idleSince = next;
        kept.nudges = 0;
        delete kept.nudgedPlan;
      } else if (kept.idleSince !== undefined && kept.idleSince > now) kept.idleSince = now;
      if (!canGoOn) return;
      if (kept.idleSince === undefined) {
        kept.idleSince = now;
        return;
      }
      const wait = NUDGE_AFTER[Math.min(kept.nudges ?? 0, NUDGE_AFTER.length - 1)];
      if (now - kept.idleSince < wait) return;
      // Told already, and nothing changed since: it said what it could; never told it again.
      const plan = planNow(kept);
      if (kept.nudgedPlan === plan && !failed) return;
      kept.idleSince = now;
      kept.nudges = (kept.nudges ?? 0) + 1;
      kept.nudgedPlan = plan;
      nudge = true;
    }, file);
    if (nudge) await tellBot(goal, "[Goal] Nothing of the goal is at work now. Carry on with the next step that doesn't wait on the user (goal_progress shows the plan as it stands). If all that's left waits on them, say so in a line and stop until they answer. If what's next can only start at a time, put it off with goal_progress (until) and a wake-up for then, and stop. Once it's all done, end with finish_goal.", "Reminded to carry on", targets);
  }
  // What's new, to your phones.
  for (const goal of readKept(file).filter(each => botHere(each.bot) && each.state !== "proposed" && each.state !== "declined")) {
    const told = new Set(goal.told ?? []);
    let reportTold = goal.reportTold === true;
    let digest: KeptGoal["lastDigest"] | undefined;
    let phasesDone: string[] | undefined;
    if (goal.state === "running") {
      for (const item of goal.waiting.filter(each => !told.has(each.id) && each.kind !== "ask")) {
        if (tell({ title: goal.name, subtitle: "Needs you", body: item.text, category: "blocked", thread: goal.session, data: { session: item.session ?? goal.session, ...(goal.wake && item.kind === "you" ? { wake: "1" as const } : { quiet: "1" as const }) } })) told.add(item.id);
      }
      const last = goal.lastDigest?.at ?? goal.started ?? now;
      const every = goal.digest === "day" ? DAY : goal.digest === "week" ? 7 * DAY : 0;
      const phases = [...new Set(goal.steps.map(step => step.phase).filter((each): each is string => Boolean(each)))];
      const done = phases.filter(phase => goal.steps.filter(step => step.phase === phase).every(step => step.state === "done" || step.state === "skipped"));
      const milestone = goal.digest === "milestones" && done.some(phase => !(goal.phasesDone ?? []).includes(phase));
      if ((every && now - last >= every) || milestone) {
        const words = `${milestone ? `${done.filter(phase => !(goal.phasesDone ?? []).includes(phase)).join(", ")} done. ` : ""}${digestWords(goal, now)}`;
        const title = goal.title ?? (goal.goal.length > 60 ? `${goal.goal.slice(0, 59)}…` : goal.goal);
        if (tell({ title, subtitle: goal.name, body: words, category: "report", thread: goal.session, data: { session: goal.session, quiet: "1" } })) {
          digest = { at: now, text: words };
          phasesDone = done;
        }
      }
    }
    if (goal.state !== "running" && !reportTold && goal.report) {
      const title = goal.title ?? goal.name;
      reportTold = tell({ title: goal.state === "done" ? `${goal.name} finished ${goal.title ?? "its goal"}` : `${goal.name}'s goal ended`, subtitle: goal.waiting.length ? `${goal.waiting.length} ${goal.waiting.length === 1 ? "thing needs" : "things need"} you` : title === goal.name ? undefined : title, body: goal.report, category: "report", thread: goal.session, data: { session: goal.session } });
    }
    if (told.size !== (goal.told ?? []).length || reportTold !== (goal.reportTold === true) || digest) {
      changeKept(all => {
        const kept = all.find(each => each.id === goal.id);
        if (!kept) return;
        kept.told = [...told];
        kept.reportTold = reportTold;
        if (digest) {
          kept.lastDigest = digest;
          kept.doneAtDigest = kept.steps.filter(step => step.state === "done" || step.state === "skipped").length;
        }
        if (phasesDone) kept.phasesDone = phasesDone;
      }, file);
      if (digest) noteWorkChanged(goal.bot);
    }
  }
}

// A pause let go (a session's, or the bot's own with none): how long anything was paused counts
// once, however many were at the same time.
function unpause(id: string, session: string | undefined, now: number, file: string) {
  const done = changeKept(all => {
    const kept = all.find(each => each.id === id);
    if (!kept) return null;
    const before = kept.paused.length;
    kept.paused = kept.paused.filter(each => each.session !== session);
    if (kept.paused.length === before) return null;
    if (!kept.paused.length) {
      kept.waited += Math.max(0, now - (kept.pausedSince ?? now));
      delete kept.pausedSince;
    }
    return kept.bot;
  }, file);
  if (done) noteWorkChanged(done);
}

/** The goals here watched, every `every` ms and as they change, until `signal` stops it. */
export async function watchGoals(tell: (notice: Notice) => boolean, targets: () => Target[], { signal, every = 30_000, here }: { signal?: AbortSignal; every?: number; here?: () => boolean } = {}): Promise<void> {
  let soon = false;
  const look = () => { soon = true; };
  goalFollowers.add(look);
  try {
    while (!signal?.aborted) {
      soon = false;
      try { await lookAtGoals(tell, targets, { signal, here }); } catch {}
      for (let waited = 0; waited < every && !soon && !signal?.aborted; waited += 1000) await pause(1000, signal);
    }
  } finally {
    goalFollowers.delete(look);
    keepAwake(false);
  }
}
