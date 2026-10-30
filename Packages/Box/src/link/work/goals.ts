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
import { changeQueue, sendInto } from "../engine/queue";
import { messageID } from "../engine/sessions";
import { locked, textOf, writePrivate } from "../files";
import { HERE } from "../home";
import { placeOfSession } from "../letters/letter";
import { asksAlways, withAlwaysAsk } from "./always";
import { periodEnd, periodOf, startOfDay, timeGiven } from "./clock";
import { asksIn, permissionWords } from "./answers";
import { keepAwake, keepsAwake, onPower } from "./awake";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { sandboxOn } from "./sandbox";
import { projectsFolder } from "./settings";
import { stopBotWork } from "./stop";
import { ofBot, workingNow, workSessions } from "./tree";
import type { Listed } from "./tree";
import type { Target } from "../../shared/records";
import type { GoalCheckShape, GoalPlanShape, GoalStepShape, GoalWaitingShape } from "../../shared/routes/work";
import type { KitRule } from "../bots/kit";
import type { Notice } from "../notices/notice";

export const GOALS_FILE = path.join(WORK_FOLDER, "goals.json");
const LOCK = path.join(WORK_FOLDER, ".goals.lock");
/** Whether you're here: a client in use lately, as this box's watch last saw it. */
export const HERE_FILE = path.join(WORK_FOLDER, "here.json");

/** How long a goal that ended (or a card left unanswered) is still shown. */
const SHOWN = 24 * 3_600_000;
/** How long an ask goes unanswered by the bot before it's listed as waiting for you. */
export const ASK_SETTLES = 2 * 60_000;
/** How long a bot has to wrap up once its goal's end has come, before the box ends it. */
const WRAP_UP = 2 * 3_600_000;
/** How long to wait for a limit that didn't say when it resets, before trying again. */
const UNKNOWN_RESET = 30 * 60_000;
const DAY = 86_400_000;

/** A goal as it's kept: as it's shown, less what's worked out when it's shown, with what the box
 * keeps besides. */
export interface KeptGoal extends Omit<GoalPlanShape, "alone" | "steps" | "spend" | "waiting" | "paused" | "public" | "checks"> {
  steps: GoalStepShape[];
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
  /** Its conversation's goal (the agents bridge's) is set: taken away once the plan ends. */
  loop?: boolean;
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

// The goals as `change` leaves them, under the lock: each bot's latest, while its bot is here.
function changeKept<T>(change: (goals: KeptGoal[]) => T, file = GOALS_FILE): T {
  fs.mkdirSync(WORK_FOLDER, { recursive: true });
  const result = locked(LOCK, () => {
    const goals = readKept(file);
    const value = change(goals);
    const latest = new Map<string, KeptGoal>();
    for (const goal of goals) if (botHere(goal.bot) && (!latest.has(goal.bot) || latest.get(goal.bot)!.proposed <= goal.proposed)) latest.set(goal.bot, goal);
    // Each bot's latest, and one that ended with a report not told yet.
    const kept = goals.filter(goal => botHere(goal.bot) && (latest.get(goal.bot) === goal || (goal.report && !goal.reportTold && goal.state !== "running")));
    writePrivate(file, JSON.stringify({ goals: kept }, null, 2));
    return value;
  });
  for (const tell of goalFollowers) tell();
  return result;
}

const Here = `${HERE[0].toUpperCase()}${HERE.slice(1)}`;

/** The checks the box makes itself, as they stand now: whether it may work on its own here, on
 * power (a Mac), and where new projects go (when the plan makes one and none is picked). */
export function boxChecks(goal: Pick<KeptGoal, "projects" | "name">): GoalCheckShape[] {
  const checks: GoalCheckShape[] = [];
  if (!sandboxOn()) checks.push({ id: "alone", text: `${Here} can't work on its own yet`, detail: `${goal.name} works on it with you here: what it asks waits for you`, state: "failed", by: "box" });
  if (keepsAwake() && onPower() === false) checks.push({ id: "power", text: "Your Mac is on battery", detail: "If it sleeps, the goal carries on once it wakes", state: "needs", by: "box" });
  if (goal.projects.length && !projectsFolder()) {
    checks.push({ id: "projectsFolder", text: "Pick where new projects go", detail: `for ${goal.projects.join(", ")}`, state: "needs", by: "box", action: { kind: "projectsFolder", label: "Pick" } });
  }
  return checks;
}

const shown = (goal: KeptGoal): GoalPlanShape => {
  const { periods: _, asksSeen: __, limitsSeen: ___, told: ____, reportTold: _____, endTold: ______, phasesDone: _______, doneAtDigest: ________, pausedSince: _________, idleSince: __________, nudges: ___________, loop: ____________, ...rest } = goal;
  // A step whose session waits for a limit to reset is paused, until then.
  const steps = goal.steps.map(step => {
    const paused = goal.state === "running" && step.state !== "done" && step.state !== "skipped" ? goal.paused.find(each => each.session && step.sessions?.includes(each.session)) : undefined;
    return paused ? { ...step, state: "paused" as const, ...(paused.until ? { resumes: paused.until } : {}) } : step;
  });
  return { ...rest, steps, checks: goal.state === "proposed" ? [...boxChecks(goal), ...goal.checks] : goal.checks, alone: sandboxOn() };
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
// A service's site, for its icon: an address's host, or a site named (`stripe.com`).
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

// A step as given: its words, or {text, phase, after: [step numbers]}.
function stepGiven(each: unknown): (Pick<GoalStepShape, "text" | "phase" | "site"> & { after?: number[] }) | null {
  if (typeof each === "string") return text(each, 300) ? { text: text(each, 300)! } : null;
  if (!isObject(each)) return null;
  const said = text(each.text, 300);
  if (!said) return null;
  const after = Array.isArray(each.after) ? each.after.filter((one): one is number => Number.isInteger(one) && (one as number) >= 1) : [];
  const site = siteOf(each.site);
  return { text: said, ...(text(each.phase, 80) ? { phase: text(each.phase, 80)! } : {}), ...(site ? { site } : {}), ...(after.length ? { after } : {}) };
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

/** A goal proposed by `bot` (its name, and its conversation), from what propose_goal was given: the
 * card it puts to you, replacing one it proposed before. Refused while one runs. */
export function proposeGoal(bot: { bot: string; name: string; session: string }, given: Record<string, unknown>, file = GOALS_FILE): { goal: GoalPlanShape } | { refused: string } {
  const goal = text(given.goal, 2000);
  if (!goal) return { refused: "Say the goal, in the user's words (goal)." };
  const steps = (Array.isArray(given.steps) ? given.steps : []).map(stepGiven).filter((each): each is NonNullable<typeof each> => Boolean(each));
  if (!steps.length) return { refused: "Give the plan, as its steps in order (steps)." };
  if (steps.length > 200) return { refused: "That's more than 200 steps: make them bigger, in phases." };
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
  for (const each of Array.isArray(given.spend) ? given.spend.slice(0, 10) : []) {
    if (!isObject(each) || !text(each.what, 200) || typeof each.cap !== "number" || !(each.cap > 0)) return { refused: "Each spend line needs what it's for (what) and a cap above 0 (cap)." };
    const per = PERIODS.includes(each.per as (typeof PERIODS)[number]) ? each.per as (typeof PERIODS)[number] : "goal";
    spend.push({ what: text(each.what, 200)!, cap: each.cap, currency: (text(each.currency, 3) ?? "USD").toUpperCase(), per, spent: 0 });
  }
  const publics: KeptGoal["public"] = (Array.isArray(given.public) ? given.public.slice(0, 8) : []).map(each => text(each, 200)).filter((each): each is string => Boolean(each)).map((each, at) => ({ id: `p${at + 1}`, text: each, on: false }));
  const projects = (Array.isArray(given.projects) ? given.projects.slice(0, 5) : []).map(each => text(each, 80)).filter((each): each is string => Boolean(each));
  const ends = endGiven(given.ends);
  if (ends === null) return { refused: "An end (ends) is a date and time to come, like 2026-11-30T18:00." };
  // A digest for a long goal, by the plan's size unless the bot says: a day's for one with phases or
  // many steps, none for a short one.
  const digest = DIGESTS.includes(given.digest as (typeof DIGESTS)[number]) ? given.digest as (typeof DIGESTS)[number] : steps.length > 12 || steps.some(step => step.phase) ? "day" : "none";
  const made = changeKept(all => {
    if (all.some(each => each.bot === bot.bot && each.state === "running")) return null;
    const kept: KeptGoal = {
      id: newID("goal"),
      bot: bot.bot,
      name: bot.name,
      session: bot.session,
      goal,
      ...(text(given.title, 80) ? { title: text(given.title, 80)! } : {}),
      state: "proposed",
      steps: keptSteps(steps),
      checks,
      spend,
      public: publics,
      projects,
      wake: false,
      digest,
      ...(ends ? { ends } : {}),
      proposed: Date.now(),
      waiting: [],
      paused: [],
      waited: 0,
      watching: [],
    };
    // (The one proposed before goes: this one's the card now.)
    for (let at = all.length - 1; at >= 0; at--) if (all[at].bot === bot.bot && all[at].state === "proposed") all.splice(at, 1);
    all.push(kept);
    return kept;
  }, file);
  if (!made) return { refused: "A goal is running already: report on it with goal_progress, and end it with finish_goal." };
  noteWorkChanged(bot.bot);
  return { goal: shown(made) };
}

/** Why your answer can't be taken: no such goal (404), or one that won't do (400). */
export interface GoalRefusal {
  status: 400 | 404;
  message: string;
}

/** Your answer to the goal `id`: `start` (with your switches for its public steps, `public: {id:
 * on}`, `wake`, `digest`, an end, `ends` (null for none, taking away the bot's), and each spend line's cap and period, `spend: [{cap,
 * per}]`), `decline` or `stop`. */
export async function answerGoal(id: string, given: Record<string, unknown>, targets: () => Target[], file = GOALS_FILE): Promise<{ goal: GoalPlanShape } | { refused: GoalRefusal }> {
  const action = given.action;
  if (action === "change" || action === "clear") return changeGoal(id, action, given, targets, file);
  if (action !== "start" && action !== "decline" && action !== "stop") return { refused: { status: 400, message: "Say start, change, clear, decline or stop (action)." } };
  const before = readKept(file).find(goal => goal.id === id);
  if (!before || !botHere(before.bot)) return { refused: { status: 404, message: "There's no such goal here." } };
  const switches = isObject(given.public) ? given.public : {};
  const ends = action === "start" ? endGiven(given.ends) : undefined;
  if (ends === null) return { refused: { status: 400, message: "The end (ends) is a date and time to come." } };
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
    goal.public = goal.public.map(each => ({ ...each, on: switches[each.id] === true }));
    goal.wake = given.wake === true;
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
  } else if (action === "decline") {
    await tellBot(changed, "[Not now] The user didn't start this goal. Don't start its work: ask them in a line what they'd like instead, if anything.", targets);
  } else {
    await setGoalLoop(changed, loopCondition(changed), targets);
    await tellBot(changed, startWords(changed), targets);
  }
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
  const changed = changeKept(all => {
    const goal = all.find(each => each.id === id);
    if (!goal) return { status: 404 as const, message: "There's no such goal here." };
    if (goal.state !== "running") return { status: 400 as const, message: "That goal isn't running." };
    if (action === "clear") {
      if (typeof given.waiting !== "string" || !goal.waiting.some(each => each.id === given.waiting)) return { status: 404 as const, message: "That isn't waiting any more." };
      goal.waiting = goal.waiting.filter(each => each.id !== given.waiting);
      return goal;
    }
    if (isObject(given.public)) goal.public = goal.public.map(each => ({ ...each, on: typeof (given.public as Record<string, unknown>)[each.id] === "boolean" ? (given.public as Record<string, boolean>)[each.id] : each.on }));
    if (typeof given.wake === "boolean") goal.wake = given.wake;
    if (DIGESTS.includes(given.digest as (typeof DIGESTS)[number])) goal.digest = given.digest as (typeof DIGESTS)[number];
    if (ends !== undefined) goal.ends = ends;
    if (given.ends === null) delete goal.ends;
    goal.spend = capsGiven(goal.spend, given.spend);
    return goal;
  }, file);
  if (!("id" in changed)) return { refused: changed };
  noteWorkChanged(changed.bot);
  if (action === "change") await tellBot(changed, `[Goal changed] The user changed the goal's limits. ${changed.spend.length ? `What you may spend now: ${changed.spend.map(each => `${each.what}, up to ${each.cap} ${each.currency}${each.per === "goal" ? "" : ` a ${each.per}`}`).join("; ")}. ` : ""}Switched on: ${changed.public.filter(each => each.on).map(each => `"${each.text}"`).join(", ") || "nothing"}.${changed.ends ? ` It ends at ${resetTime(changed.ends)}.` : ""}`, targets);
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

// What the bot is told as the goal starts: what's approved, and how it goes.
function startWords(goal: KeptGoal): string {
  const on = goal.public.filter(each => each.on).map(each => `"${each.text}"`);
  const off = goal.public.filter(each => !each.on).map(each => `"${each.text}"`);
  const lines = [
    `[Goal started] The user approved the plan. Work through it now, steps side by side where they don't depend on each other: ${goal.steps.map((each, at) => `${at + 1}. ${each.text}`).join(" ")}`,
    on.length ? `Switched on, so do them when they're ready: ${on.join(", ")}.` : "",
    off.length ? `Switched off, so prepare them as drafts for the user: ${off.join(", ")}.` : "",
    goal.spend.length ? `What you may spend, never more: ${goal.spend.map(each => `${each.what}, up to ${each.cap} ${each.currency}${each.per === "goal" ? "" : ` a ${each.per}`}`).join("; ")}. Ask may_spend before each purchase.` : "Spend nothing.",
    goal.projects.length ? `You may make these projects without asking: ${goal.projects.join(", ")}.` : "",
    goal.ends ? `It ends at ${resetTime(goal.ends)}: be done by then, or wrap up and report.` : "",
    "Mark each step with goal_progress as it starts, moves and ends (with progress where you can measure it), and keep what only the user can fix as waiting (it never stalls the rest: carry on with other steps). End with finish_goal and your report.",
  ];
  return lines.filter(Boolean).join("\n");
}

// `said` to the goal's bot, as a message in its conversation.
async function tellBot(goal: Pick<KeptGoal, "session">, said: string, targets: () => Target[]): Promise<boolean> {
  const place = await placeOfSession(goal.session, targets()).catch(() => null);
  if (!place) return false;
  return sendInto(place.target, goal.session, { id: messageID(), text: said, delivery: "queue" }, { from: "Goal" }).then(() => true, () => false);
}

/** /goal in a bot's chat: the bot asked to plan `words` as a goal and put it to you, now. */
export async function askGoal(session: string, words: string, targets: () => Target[]): Promise<{ text: string } | { refused: GoalRefusal }> {
  const said = text(words, 2000);
  if (!said) return { refused: { status: 400, message: "Say the goal (goal)." } };
  const place = await placeOfSession(session, targets()).catch(() => null);
  if (!place) return { refused: { status: 404, message: "There's no such conversation here." } };
  // You asked for it now: as a message of yours to go now, the queue goes on.
  changeQueue(session, state => ({ ...state, paused: false }));
  const sent = await asked(place.target, "POST", `api/session/${encodeURIComponent(session)}/prompt`, {
    id: messageID(),
    text: `[Goal] ${said}\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)`,
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

/** A pause of `bot`'s running goal (or one of its sessions) until a limit resets: kept, its steps
 * marked, and carried on by the box's watch once `until` comes. */
export function pauseGoal(bot: string, pause: { why: string; until?: number; session?: string }, file = GOALS_FILE): boolean {
  const done = changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return false;
    const key = pause.session ?? "bot";
    if (!goal.paused.length) goal.pausedSince = Date.now();
    goal.paused = [...goal.paused.filter(each => (each.session ?? "bot") !== key), pause];
    return true;
  }, file);
  if (done) noteWorkChanged(bot);
  return done;
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

// Where you are, in a line, for what the bot does next.
const presence = () => (isHere() ? "The user is here now." : "The user is away now: prepare anything public or sent as a draft, unless its switch is on, and carry on with what doesn't need them.");

/** goal_progress: steps marked (and added as the plan changes), something waiting for you, what's
 * spent, what's still watched. */
export function goalProgress(bot: string, given: Record<string, unknown>, file = GOALS_FILE): { said: string } | { refused: string } {
  const running = runningGoal(bot, file);
  if (!running) return { refused: "No goal is running: propose one with propose_goal, and the user starts it." };
  const marks = Array.isArray(given.steps) ? given.steps : given.step !== undefined ? [{ step: given.step, state: given.state, progress: given.progress, note: given.note }] : [];
  const added = (Array.isArray(given.add) ? given.add : []).map(stepGiven).filter((each): each is NonNullable<typeof each> => Boolean(each));
  // All of it checked first: nothing's kept of a call that's wrong somewhere.
  const stepAt = (step: unknown, steps: readonly GoalStepShape[]) => (typeof step === "number" ? step - 1 : typeof step === "string" ? steps.findIndex(each => each.id === step) : -1);
  for (const mark of marks) {
    if (!isObject(mark) || !running.steps[stepAt(mark.step, running.steps)]) return { refused: `There's no step ${isObject(mark) ? String(mark.step) : ""}: the plan has ${running.steps.length} (add new ones with add).` };
    if (mark.state !== undefined && !STEP_STATES.includes(mark.state as (typeof STEP_STATES)[number])) return { refused: "A step's state is todo, doing, done, waiting, paused or skipped." };
    if (mark.progress !== undefined && mark.progress !== null && !(typeof mark.progress === "number" && mark.progress >= 0 && mark.progress <= 1)) return { refused: "A step's progress is a share from 0 to 1, given only where you can measure it (3 of 8 pages is 0.375)." };
    // The user sees what was counted, and the track fills by it: never a bare share.
    if (typeof mark.progress === "number" && mark.progress < 1 && !text(mark.note, 300)) return { refused: "Say what you counted with the share, in note: progress 0.375 with note \"3 of 8 pages\". The user sees the count." };
  }
  if (isObject(given.waiting) && (!text(given.waiting.text, 300) || !WAITING_KINDS.includes(given.waiting.kind as (typeof WAITING_KINDS)[number]))) return { refused: "What waits needs its kind (you, judgment or outside) and what it is (text)." };
  const spent = Array.isArray(given.spent) ? given.spent : isObject(given.spent) ? [given.spent] : [];
  for (const each of spent) if (!isObject(each) || !text(each.what, 200) || typeof each.amount !== "number" || !(each.amount > 0)) return { refused: "What's spent is {what, amount}." };
  const resolved = (Array.isArray(given.resolved) ? given.resolved : []).map(each => text(each, 300)).filter((each): each is string => Boolean(each));
  const notes: string[] = [];
  const unplanned: string[] = [];
  changeKept(all => {
    const goal = all.find(each => each.bot === bot && each.state === "running");
    if (!goal) return;
    for (const mark of marks as Record<string, unknown>[]) {
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
      goal.steps[at] = next;
      notes.push(`step ${at + 1} ${next.state}`);
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
    for (const each of spent as Record<string, unknown>[]) {
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
    addWaiting(bot, { kind: given.waiting.kind as (typeof WAITING_KINDS)[number], text: text(given.waiting.text, 300)!, ...(text(given.waiting.detail, 500) ? { detail: text(given.waiting.detail, 500)! } : {}), ...(url ? { url } : {}), ...(site ? { site } : {}) }, file);
    notes.push("kept as waiting for the user: carry on with what doesn't depend on it");
  }
  noteWorkChanged(bot);
  return { said: `${notes.length ? `Noted: ${notes.join("; ")}.` : "Nothing to note: give steps, add, waiting, spent or watching."} ${presence()}` };
}

/** may_publish: whether a public step of the running goal is switched on. */
export function mayPublish(bot: string, given: Record<string, unknown>, file = GOALS_FILE): { said: string } | { refused: string } {
  const goal = runningGoal(bot, file);
  if (!goal) return { refused: "No goal is running. Ask the user." };
  const asked = text(given.step, 200);
  if (!asked) return { refused: `Say which public step (step): ${goal.public.map(each => `${each.id} "${each.text}"`).join(", ") || "the plan has none"}.` };
  const found = goal.public.find(each => each.id === asked || each.text.toLowerCase() === asked.toLowerCase());
  if (!found) return { said: `"${asked}" isn't one of the goal's public steps, so it's not approved: prepare it as a draft and keep it as waiting for the user.` };
  return { said: found.on ? `Yes: "${found.text}" is switched on. Do it once it's ready.` : `No: "${found.text}" is switched off. Prepare it as a draft, and keep it as waiting for the user.` };
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

/** How long a goal with nothing at work waits before its bot is told to carry on: longer each time. */
const NUDGE_AFTER = [10, 30, 60, 120, 240, 480, 720].map(minutes => minutes * 60_000);

/** One look at the goals running here (`now`, a test's clock):
 * - whether you're here, kept for the tools (`here`);
 * - an end that has come: the bot told to wrap up, and the goal ended with a word if it doesn't;
 * - the conversation's goal (its loop) kept as the plan is: set while it runs, taken away once it
 *   ends; its pause at a model's limit shown as the plan's;
 * - the Mac kept awake only while some goal's work is at it (on power);
 * - its sessions' rules (only those started for it) asking for what always comes to you, and for
 *   publishing unless a public step is on;
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
      await tellBot(goal, "[Goal's end] The end the user set has come. Finish the step under way, start nothing new, and end with finish_goal and your report.", targets);
    } else if (now - goal.endTold >= WRAP_UP) {
      const ended = changeKept(all => {
        const kept = all.find(each => each.id === goal.id && each.state === "running");
        if (!kept) return false;
        kept.state = "stopped";
        kept.ended = now;
        kept.report = `${kept.name} reached the end you set: ${kept.steps.filter(step => step.state === "done" || step.state === "skipped").length} of ${kept.steps.length} steps done. Ask it where things stand.`;
        return true;
      }, file);
      if (ended) {
        noteWorkChanged(goal.bot);
        await stopBotWork(goal.bot, targets(), signal).catch(() => 0);
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
    const loop = await call(bridge, "GET", `/api/kuvo/goals/${encodeURIComponent(goal.session)}`, undefined, signal).then(data => (isObject(data) ? data : null), () => null);
    if (!loop) {
      await setGoalLoop(goal, loopCondition(goal), targets, file);
      continue;
    }
    // The bot's own turn waits for a model's limit: shown as the goal's pause.
    const atLimit = loop.state === "paused" && loop.pausedBy === "limit" && typeof loop.resumesAt === "number";
    const shownPause = goal.paused.find(each => each.session === goal.session);
    if (atLimit && shownPause?.until !== loop.resumesAt) pauseGoal(goal.bot, { why: "the model's limit", until: loop.resumesAt as number, session: goal.session }, file);
    if (!atLimit && shownPause) unpause(goal.id, goal.session, now, file);
  }
  const running = readKept(file).filter(goal => goal.state === "running" && botHere(goal.bot));
  const sessions = running.length ? await workSessions(targets(), signal).catch((): Listed[] => []) : [];
  const working = running.length ? await workingNow(targets(), signal).catch(() => new Set<string>()) : new Set<string>();
  // Only what the bot started for this goal (once it started) is the goal's.
  const workOf = (goal: KeptGoal) => ofBot(goal.bot, sessions).filter(each => (each.data.time?.created ?? 0) >= (goal.started ?? goal.proposed) - 60_000);
  // Awake only while some goal's work is at it: the bot, or one of its sessions.
  keepAwake(running.some(goal => working.has(goal.session) || workOf(goal).some(each => working.has(each.data.id))));
  for (const goal of running) {
    const work = workOf(goal);
    const own = await placeOfSession(goal.session, targets()).catch(() => null);
    // Its rules, and its sessions', ask for what always comes to you, and for publishing unless a
    // public step is switched on.
    const publishing = !goal.public.some(step => step.on);
    for (const place of [...(own ? [{ target: own.target, id: goal.session, rules: own.data.permissions }] : []), ...work.map(each => ({ target: each.target, id: each.data.id, rules: each.data.permissions }))]) {
      if (asksAlways(place.rules, { publishing })) continue;
      await call(place.target, "PATCH", `/api/session/${encodeURIComponent(place.id)}`, { permissions: withAlwaysAsk((place.rules ?? []) as KitRule[], { publishing }) }, signal).catch(() => {});
    }
    // A session whose turn failed at a model's limit: paused until it resets.
    const limitsSeen = { ...(goal.limitsSeen ?? {}) };
    for (const each of work) {
      if (working.has(each.data.id)) continue;
      const failed = await failedTurn(each.target, each.data.id, signal);
      if (!failed || limitsSeen[each.data.id] === failed.idle || !isLimit(failed.error)) continue;
      limitsSeen[each.data.id] = failed.idle;
      pauseGoal(goal.bot, { why: limitName(each.data.model), until: resetsIn(failed.error, failed.at ?? now) ?? now + UNKNOWN_RESET, session: each.data.id }, file);
    }
    // A pause whose time has come: carried on (a session that's gone, or put away, let go).
    const kept = readKept(file).find(each => each.id === goal.id);
    for (const paused of kept?.paused ?? []) {
      if (paused.session === goal.session) continue;
      if (paused.session) {
        const place = await placeOfSession(paused.session, targets()).catch(() => undefined);
        if (place === null || place?.data.metadata?.kuvo?.archived === true) {
          unpause(goal.id, paused.session, now, file);
          continue;
        }
        if (!paused.until || now < paused.until || !place) continue;
        const carried = await sendInto(place.target, paused.session, { id: messageID(), text: `[Limit reset] ${paused.why} has reset. Carry on where you stopped.`, delivery: "queue" }, { from: "Goal" }).then(() => true, () => false);
        if (carried) unpause(goal.id, paused.session, now, file);
        continue;
      }
      if (!paused.until || now < paused.until) continue;
      if (await tellBot(goal, `[Limit reset] ${paused.why} has reset. Carry on with the goal.`, targets)) unpause(goal.id, undefined, now, file);
    }
    // What its sessions, and the bot itself, ask that the bot hasn't answered: waiting for you,
    // never a no.
    const asksSeen: Record<string, number> = {};
    const open = new Set<string>();
    const askers = [...work.map(each => ({ target: each.target, id: each.data.id, title: each.data.title || "New Session" })), ...(own ? [{ target: own.target, id: goal.session, title: goal.name }] : [])];
    for (const each of askers) {
      const { permissions, questions } = await asksIn(each.target, each.id, signal).catch(() => ({ permissions: [], questions: [] }));
      for (const ask of [...permissions.map(one => ({ id: one.id, what: permissionWords(one).replace(/\.$/, "") })), ...questions.map(one => ({ id: one.id, what: `Asks: ${one.text}` }))]) {
        const key = `${each.id}:${ask.id}`;
        open.add(key);
        asksSeen[key] = kept?.asksSeen?.[key] ?? now;
        // (The bot's own: yours at once; its sessions': once the bot has had a moment.)
        if (each.id === goal.session || now - asksSeen[key] >= ASK_SETTLES) addWaiting(goal.bot, { kind: "ask", text: `${each.title}: ${ask.what}`, session: each.id }, file, `ask:${key}`);
      }
    }
    // Nothing of it at work a while, and something it can do: the bot is told to carry on.
    const live = readKept(file).find(each => each.id === goal.id);
    const atWork = working.has(goal.session) || work.some(each => working.has(each.data.id));
    const left = (live?.steps ?? []).filter(step => step.state !== "done" && step.state !== "skipped");
    const pausedSessions = new Set((live?.paused ?? []).map(each => each.session).filter(Boolean));
    const canGoOn = !(live?.paused ?? []).some(each => !each.session || each.session === goal.session)
      && left.some(step => step.state !== "waiting" && !(step.sessions?.length && step.sessions.every(id => pausedSessions.has(id))));
    let nudge = false;
    changeKept(all => {
      const kept = all.find(each => each.id === goal.id);
      if (!kept) return;
      kept.asksSeen = asksSeen;
      kept.limitsSeen = limitsSeen;
      // Asks answered since (here, on a phone, by the bot) leave the list.
      kept.waiting = kept.waiting.filter(item => item.kind !== "ask" || open.has(item.id.replace(/^ask:/, "")));
      if (freshPeriods(kept, now)) noteWorkChanged(kept.bot);
      if (atWork || !canGoOn) {
        if (atWork) {
          delete kept.idleSince;
          kept.nudges = 0;
        }
        return;
      }
      if (kept.idleSince === undefined) {
        kept.idleSince = now;
        return;
      }
      const wait = NUDGE_AFTER[Math.min(kept.nudges ?? 0, NUDGE_AFTER.length - 1)];
      if (now - kept.idleSince < wait) return;
      kept.idleSince = now;
      kept.nudges = (kept.nudges ?? 0) + 1;
      nudge = true;
    }, file);
    if (nudge) await tellBot(goal, "[Goal] Nothing of the goal is at work now. Carry on with the next step that doesn't wait on the user (goal_progress shows the plan as it stands). If all that's left waits on them, say so in a line and stop until they answer. Once it's all done, end with finish_goal.", targets);
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
