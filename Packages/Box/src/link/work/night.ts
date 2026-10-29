// A bot's night (PROTOCOL.md, "Work › A night"): you give a bot a goal at bedtime, it works out
// the plan and checks what the night needs, and puts it to you on one card (propose_night). Only you
// start it (`POST kuvo/work/nights/<id>`, from a client: never a tool, an agent's message or
// another computer's mail), and only where this box may work unattended (`sandboxOn`). While it
// runs, the bot works through the plan on its own: what only you can do waits for the morning as a
// blocker (a quiet notification), asks no one answers turn to no after a while and are worked
// around, the Mac stays awake on power, and the night ends with the bot's morning report.
//
// Kept in `run/work/nights.json`, each bot's latest, on the box doing the work, so it goes on with
// no client there and every client shows the same night.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { pause } from "../../shared/wait";
import { botHere } from "../bots/here";
import { asked, call } from "../engine/client";
import { messageID } from "../engine/sessions";
import { locked, textOf, writePrivate } from "../files";
import { HERE } from "../home";
import { placeOfSession } from "../letters/letter";
import { answerWork, workAsks } from "./asks";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { asksAlways, withAlwaysAsk } from "./always";
import { asksIn, keepAnswer, permissionWords } from "./answers";
import { keepAwake, keepsAwake, onPower } from "./awake";
import { sandboxOn } from "./sandbox";
import { projectsFolder } from "./settings";
import { stopBotWork } from "./stop";
import { ofBot, workSessions } from "./tree";
import type { Target } from "../../shared/records";
import type { NightBlockerShape, NightCheckShape, NightShape } from "../../shared/routes/work";
import type { Notice } from "../notices/notice";
import type { KitRule } from "../bots/kit";

export const NIGHTS_FILE = path.join(WORK_FOLDER, "nights.json");
const LOCK = path.join(WORK_FOLDER, ".nights.lock");

/** How long an ask waits overnight before it's no (and worked around, for the morning). */
export const NIGHT_ASK_WAIT = 15 * 60_000;
/** How long a night may run: past it, it ends, with a word for the morning. */
export const NIGHT_LONGEST = 12 * 3_600_000;
/** How long a night that ended (or a card left unanswered) is still shown. */
const SHOWN = 24 * 3_600_000;

/** A night as it's kept: as it's shown, less what's worked out when it's shown, with the asks seen
 * waiting (ms, by session and ask), and the blockers and the report already told to your phones. */
export interface KeptNight extends Omit<NightShape, "canStart" | "steps" | "spend" | "blockers"> {
  steps: NightShape["steps"][number][];
  spend: NightShape["spend"][number][];
  blockers: NightBlockerShape[];
  waiting?: Record<string, number>;
  told?: string[];
  reportTold?: boolean;
}

/** Those following the nights here, in this process. */
export const nightFollowers = new Set<() => void>();

const STATES = ["proposed", "running", "done", "stopped", "declined"];
const readKept = (file = NIGHTS_FILE): KeptNight[] => {
  try {
    const nights = JSON.parse(textOf(file) ?? "").nights;
    return Array.isArray(nights) ? nights.filter(each => isObject(each) && typeof each.id === "string" && typeof each.bot === "string" && STATES.includes(each.state as string)) : [];
  } catch {
    return [];
  }
};

// The nights as `change` leaves them, under the lock: each bot's latest, while its bot is here.
function changeKept<T>(change: (nights: KeptNight[]) => T, file = NIGHTS_FILE): T {
  fs.mkdirSync(WORK_FOLDER, { recursive: true });
  const result = locked(LOCK, () => {
    const nights = readKept(file);
    const value = change(nights);
    const latest = new Map<string, KeptNight>();
    for (const night of nights) if (botHere(night.bot) && (!latest.has(night.bot) || latest.get(night.bot)!.proposed <= night.proposed)) latest.set(night.bot, night);
    writePrivate(file, JSON.stringify({ nights: [...latest.values()] }, null, 2));
    return value;
  });
  for (const tell of nightFollowers) tell();
  return result;
}

/** The checks the box makes itself, as they stand now: working unattended here, on power (a Mac),
 * and where new projects go (when the plan makes one and none is picked). */
export function boxChecks(night: Pick<KeptNight, "projects" | "name">): NightCheckShape[] {
  const checks: NightCheckShape[] = [];
  const Here = `${HERE[0].toUpperCase()}${HERE.slice(1)}`;
  checks.push(sandboxOn()
    ? { id: "unattended", text: `${Here} can run a night`, state: "ok", by: "box" }
    : { id: "unattended", text: `${Here} can't run a night yet`, detail: `${night.name} can do the same plan with you here instead`, state: "failed", by: "box" });
  if (keepsAwake()) {
    const power = onPower();
    if (power === true) checks.push({ id: "power", text: "Mac on power", detail: "With its lid open, it stays awake till it's done", state: "ok", by: "box" });
    else if (power === false) checks.push({ id: "power", text: "Plug in your Mac", detail: "It stays awake only on power, with its lid open", state: "needs", by: "box" });
  }
  if (night.projects.length && !projectsFolder()) {
    checks.push({ id: "projectsFolder", text: "Pick where new projects go", detail: `for ${night.projects.join(", ")}`, state: "needs", by: "box", action: { kind: "projectsFolder", label: "Pick" } });
  }
  return checks;
}

const shown = (night: KeptNight): NightShape => {
  const { waiting: _, told: __, reportTold: ___, ...rest } = night;
  return { ...rest, checks: night.state === "proposed" ? [...boxChecks(night), ...night.checks] : night.checks, canStart: sandboxOn() };
};

/** The nights here, as clients show them: each bot's latest while it's proposed or running, or
 * ended (or left unanswered) within the last day. */
export function nights(file = NIGHTS_FILE): NightShape[] {
  const now = Date.now();
  return readKept(file)
    .filter(night => botHere(night.bot) && (night.state === "running" || now - (night.ended ?? night.proposed) < SHOWN))
    .sort((a, b) => b.proposed - a.proposed)
    .map(shown);
}

/** `bot`'s night while it runs; null otherwise. */
export const runningNight = (bot: string | null | undefined, file = NIGHTS_FILE): KeptNight | null => (bot ? readKept(file).find(night => night.bot === bot && night.state === "running") ?? null : null);

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
const newID = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "")}`;

/** A night proposed by `bot` (its name, and its conversation), from what propose_night was given:
 * the card it puts to you, replacing one it proposed before. Refused while one runs. */
export function proposeNight(bot: { bot: string; name: string; session: string }, given: Record<string, unknown>, file = NIGHTS_FILE): { night: NightShape } | { refused: string } {
  const goal = text(given.goal, 2000);
  if (!goal) return { refused: "Say the goal, in the user's words (goal)." };
  const steps = (Array.isArray(given.steps) ? given.steps : []).map(each => text(each, 300)).filter((each): each is string => Boolean(each));
  if (!steps.length) return { refused: "Give the plan, as its steps in order (steps)." };
  if (steps.length > 30) return { refused: "That's more than 30 steps: make them bigger." };
  const checks: NightCheckShape[] = [];
  for (const each of Array.isArray(given.checks) ? given.checks.slice(0, 12) : []) {
    if (!isObject(each)) continue;
    const said = text(each.text, 200);
    if (!said) continue;
    const url = https(each.url);
    const state = each.ok === true ? "ok" : "needs";
    checks.push({ id: `c${checks.length + 1}`, text: said, ...(text(each.detail, 300) ? { detail: text(each.detail, 300)! } : {}), state, by: "bot", ...(url && state === "needs" ? { action: { kind: "open" as const, label: text(each.button, 30) ?? "Open", url } } : {}) });
  }
  const spend: NightShape["spend"][number][] = [];
  for (const each of Array.isArray(given.spend) ? given.spend.slice(0, 10) : []) {
    if (!isObject(each) || !text(each.what, 200) || typeof each.cap !== "number" || !(each.cap > 0)) return { refused: "Each spend line needs what it's for (what) and a cap above 0 (cap)." };
    spend.push({ what: text(each.what, 200)!, cap: each.cap, currency: (text(each.currency, 3) ?? "USD").toUpperCase() });
  }
  const publics: KeptNight["public"] = (Array.isArray(given.public) ? given.public.slice(0, 8) : []).map(each => text(each, 200)).filter((each): each is string => Boolean(each)).map((each, at) => ({ id: `p${at + 1}`, text: each, on: false }));
  const projects = (Array.isArray(given.projects) ? given.projects.slice(0, 5) : []).map(each => text(each, 80)).filter((each): each is string => Boolean(each));
  const made = changeKept(all => {
    if (all.some(night => night.bot === bot.bot && night.state === "running")) return null;
    const night: KeptNight = {
      id: newID("night"),
      bot: bot.bot,
      name: bot.name,
      session: bot.session,
      goal,
      state: "proposed",
      steps: steps.map(each => ({ text: each, state: "todo" })),
      checks,
      spend,
      public: publics,
      projects,
      wake: false,
      proposed: Date.now(),
      blockers: [],
      watching: [],
    };
    // (The one proposed before goes: this one's the card now.)
    for (let at = all.length - 1; at >= 0; at--) if (all[at].bot === bot.bot && all[at].state === "proposed") all.splice(at, 1);
    all.push(night);
    return night;
  }, file);
  if (!made) return { refused: "A night is running already: report on it with night_progress, and end it with finish_night." };
  noteWorkChanged(bot.bot);
  return { night: shown(made) };
}

/** Why your answer can't be taken: no such night (404), one that won't do (400), or one that can't
 * start here (409, `needs` what it needs). */
export interface NightRefusal {
  status: 400 | 404 | 409;
  message: string;
  needs?: string;
}

/** Your answer to the night `id`: `start` (with your switches for its public steps, `public: {id:
 * on}`, and `wake`), `decline` or `stop`. A night starts only where this box may work unattended. */
export async function answerNight(id: string, given: Record<string, unknown>, targets: () => Target[], file = NIGHTS_FILE): Promise<{ night: NightShape } | { refused: NightRefusal }> {
  const action = given.action;
  if (action !== "start" && action !== "decline" && action !== "stop") return { refused: { status: 400, message: "Say start, decline or stop (action)." } };
  const before = readKept(file).find(night => night.id === id);
  if (!before || !botHere(before.bot)) return { refused: { status: 404, message: "There's no such night here." } };
  if (action === "start" && !sandboxOn()) return { refused: { status: 409, message: `${HERE[0].toUpperCase()}${HERE.slice(1)} can't run a night yet.`, needs: "sandbox" } };
  const switches = isObject(given.public) ? given.public : {};
  const changed = changeKept(all => {
    const night = all.find(each => each.id === id);
    if (!night) return { status: 404 as const, message: "There's no such night here." };
    if (action === "stop") {
      if (night.state !== "running") return { status: 400 as const, message: "That night isn't running." };
      night.state = "stopped";
      night.ended = Date.now();
      return night;
    }
    if (night.state !== "proposed") return { status: 400 as const, message: night.state === "running" ? "That night is running already." : "That night has ended." };
    if (action === "start" && Date.now() - night.proposed >= SHOWN) return { status: 400 as const, message: "That plan is from more than a day ago: ask for it again." };
    if (action === "decline") {
      night.state = "declined";
      night.ended = Date.now();
      return night;
    }
    if (all.some(each => each.bot === night.bot && each.state === "running")) return { status: 400 as const, message: "A night is running for this bot already." };
    night.state = "running";
    night.started = Date.now();
    night.public = night.public.map(each => ({ ...each, on: switches[each.id] === true }));
    night.wake = given.wake === true;
    return night;
  }, file);
  if (!("id" in changed)) return { refused: changed };
  noteWorkChanged(changed.bot);
  if (action === "stop") await stopBotWork(changed.bot, targets()).catch(() => 0);
  else await tellBot(changed, action === "start" ? startWords(changed) : "[Not tonight] The user said not tonight: don't start the night's work. Ask them in a line if they'd like it some other time.", targets);
  return { night: shown(changed) };
}

// What the bot is told as the night starts: what's approved, and how the night goes.
function startWords(night: KeptNight): string {
  const on = night.public.filter(each => each.on).map(each => `"${each.text}"`);
  const off = night.public.filter(each => !each.on).map(each => `"${each.text}"`);
  const lines = [
    `[Night started] The user approved the night and went to sleep. Work through the plan now: ${night.steps.map((each, at) => `${at + 1}. ${each.text}`).join(" ")}`,
    on.length ? `Switched on, so do them when they're ready: ${on.join(", ")}.` : "",
    off.length ? `Switched off, so prepare them as drafts and leave them for the morning: ${off.join(", ")}.` : "",
    night.spend.length ? `What you may spend, never more: ${night.spend.map(each => `${each.what}, up to ${each.cap} ${each.currency}`).join("; ")}.` : "Spend nothing.",
    night.projects.length ? `You may make these projects without asking: ${night.projects.join(", ")}.` : "",
    "Report each step with night_progress as it starts and ends, and anything only the user can fix as a blocker (it waits for the morning; never wait on it). End with finish_night and your morning report.",
  ];
  return lines.filter(Boolean).join("\n");
}

// `text` to the night's bot, as a message in its conversation.
async function tellBot(night: KeptNight, said: string, targets: () => Target[]): Promise<boolean> {
  const place = await placeOfSession(night.session, targets()).catch(() => null);
  if (!place) return false;
  return asked(place.target, "POST", `api/session/${encodeURIComponent(night.session)}/prompt`, { id: messageID(), text: said, delivery: "queue" }).then(() => true, () => false);
}

// ——— What the bot does as it goes ———

const STEP_STATES = ["todo", "doing", "done", "blocked", "skipped"] as const;
const BLOCKER_KINDS = ["you", "judgment", "outside"] as const;

/** A blocker kept on `bot`'s running night (deduplicated by its words), for the morning. */
export function addBlocker(bot: string, blocker: Omit<NightBlockerShape, "id" | "at">, file = NIGHTS_FILE): NightBlockerShape | null {
  const added = changeKept(all => {
    const night = all.find(each => each.bot === bot && each.state === "running");
    if (!night) return null;
    const same = night.blockers.find(each => each.text === blocker.text && each.kind === blocker.kind);
    if (same) return same;
    const made: NightBlockerShape = { id: newID("blk"), ...blocker, at: Date.now() };
    night.blockers.push(made);
    night.blockers = night.blockers.slice(-40);
    return made;
  }, file);
  if (added) noteWorkChanged(bot);
  return added;
}

/** night_progress: steps marked, a blocker kept, what's still watched. */
export function nightProgress(bot: string, given: Record<string, unknown>, file = NIGHTS_FILE): { said: string } | { refused: string } {
  if (!runningNight(bot, file)) return { refused: "No night is running: propose one with propose_night, and the user starts it." };
  const notes: string[] = [];
  const marks = Array.isArray(given.steps) ? given.steps : given.step !== undefined ? [{ step: given.step, state: given.state, note: given.note }] : [];
  // All of it checked first: nothing's kept of a call that's wrong somewhere.
  const steps = runningNight(bot, file)!.steps.length;
  for (const mark of marks) {
    if (!isObject(mark) || typeof mark.step !== "number" || mark.step < 1 || mark.step > steps) return { refused: `There's no step ${isObject(mark) ? String(mark.step) : ""}: the plan has ${steps}.` };
    if (!STEP_STATES.includes(mark.state as (typeof STEP_STATES)[number])) return { refused: "A step's state is todo, doing, done, blocked or skipped." };
  }
  if (isObject(given.blocker) && (!text(given.blocker.text, 300) || !BLOCKER_KINDS.includes(given.blocker.kind as (typeof BLOCKER_KINDS)[number]))) return { refused: "A blocker needs its kind (you, judgment or outside) and what it is (text)." };
  let wrong: string | null = null;
  changeKept(all => {
    const night = all.find(each => each.bot === bot && each.state === "running");
    if (!night) return;
    for (const mark of marks) {
      if (!isObject(mark)) continue;
      const at = typeof mark.step === "number" ? mark.step - 1 : -1;
      if (!night.steps[at]) {
        wrong = `There's no step ${String(mark.step)}: the plan has ${night.steps.length}.`;
        continue;
      }
      if (!STEP_STATES.includes(mark.state as (typeof STEP_STATES)[number])) {
        wrong = "A step's state is todo, doing, done, blocked or skipped.";
        continue;
      }
      night.steps[at] = { text: night.steps[at].text, state: mark.state as (typeof STEP_STATES)[number], ...(text(mark.note, 300) ? { note: text(mark.note, 300)! } : {}) };
      notes.push(`step ${at + 1} ${mark.state}`);
    }
    if (Array.isArray(given.watching)) {
      night.watching = given.watching.map(each => text(each, 200)).filter((each): each is string => Boolean(each)).slice(0, 10);
      notes.push(night.watching.length ? `watching ${night.watching.length}` : "watching nothing");
    }
  }, file);
  if (wrong) return { refused: wrong };
  if (isObject(given.blocker)) {
    const said = text(given.blocker.text, 300);
    const kind = given.blocker.kind;
    if (!said || !BLOCKER_KINDS.includes(kind as (typeof BLOCKER_KINDS)[number])) return { refused: "A blocker needs its kind (you, judgment or outside) and what it is (text)." };
    const url = https(given.blocker.url);
    addBlocker(bot, { kind: kind as (typeof BLOCKER_KINDS)[number], text: said, ...(text(given.blocker.detail, 500) ? { detail: text(given.blocker.detail, 500)! } : {}), ...(url ? { url } : {}) }, file);
    notes.push("blocker kept for the morning");
  }
  noteWorkChanged(bot);
  return { said: notes.length ? `Noted: ${notes.join(", ")}.` : "Nothing to note: give steps, a blocker or watching." };
}

/** may_publish: whether a public step of the running night is switched on. */
export function mayPublish(bot: string, given: Record<string, unknown>, file = NIGHTS_FILE): { said: string } | { refused: string } {
  const night = runningNight(bot, file);
  if (!night) return { refused: "No night is running. While the user is here, ask them." };
  const asked = text(given.step, 200);
  if (!asked) return { refused: `Say which public step (step): ${night.public.map(each => `${each.id} "${each.text}"`).join(", ") || "the plan has none"}.` };
  const found = night.public.find(each => each.id === asked || each.text.toLowerCase() === asked.toLowerCase());
  if (!found) return { said: `"${asked}" isn't one of the night's public steps, so it's not approved: prepare it as a draft for the morning.` };
  return { said: found.on ? `Yes: "${found.text}" is switched on. Do it once it's ready.` : `No: "${found.text}" is switched off. Prepare it as a draft for the morning.` };
}

/** finish_night: the night done, with the morning report. */
export function finishNight(bot: string, given: Record<string, unknown>, file = NIGHTS_FILE): { said: string } | { refused: string } {
  const report = text(given.report, 4000);
  if (!report) return { refused: "Give the morning report (report): what got done and where, what it spent, and what needs the user first." };
  const done = changeKept(all => {
    const night = all.find(each => each.bot === bot && each.state === "running");
    if (!night) return false;
    night.state = "done";
    night.ended = Date.now();
    night.report = report;
    if (Array.isArray(given.watching)) night.watching = given.watching.map(each => text(each, 200)).filter((each): each is string => Boolean(each)).slice(0, 10);
    return true;
  }, file);
  if (!done) return { refused: "No night is running." };
  noteWorkChanged(bot);
  return { said: "The night is done. Say the report in your reply too, briefly: the user reads it in the morning." };
}

// ——— The night's watch ———

const ASK_TEXT = "No one could answer this overnight, so it's no for now. Work around it if you can; it waits for the user in the morning report.";
const QUESTION_TEXT = "No one could answer this overnight. Go on with your best judgment where it's safe, and leave the rest for the morning.";

/** One look at the nights running here: the Mac kept awake while any runs; a night past its time
 * ended; a Mac on battery, and asks and questions no one answered in time (said no to, and kept as
 * blockers); the rules of the bot and its sessions asking for what always comes to you, and for
 * publishing and deploying, overnight; what's new told to your phones (`tell`: blockers quietly,
 * louder where you asked to be woken, and the morning report). */
export async function lookAtNights(tell: (notice: Notice) => boolean, targets: () => Target[], { file = NIGHTS_FILE, wait = NIGHT_ASK_WAIT, longest = NIGHT_LONGEST, signal }: { file?: string; wait?: number; longest?: number; signal?: AbortSignal } = {}): Promise<void> {
  const now = Date.now();
  // A night that ran past its time ends: its bot stopped, with a word for the morning.
  for (const night of readKept(file).filter(each => each.state === "running" && botHere(each.bot) && now - (each.started ?? each.proposed) >= longest)) {
    const ended = changeKept(all => {
      const kept = all.find(each => each.id === night.id && each.state === "running");
      if (!kept) return false;
      kept.state = "stopped";
      kept.ended = now;
      kept.report = `${kept.name} didn't finish in the night's time, so it stopped: ${kept.steps.filter(step => step.state === "done" || step.state === "skipped").length} of ${kept.steps.length} steps done. Ask it where things stand.`;
      return true;
    }, file);
    if (ended) {
      noteWorkChanged(night.bot);
      await stopBotWork(night.bot, targets(), signal).catch(() => 0);
    }
  }
  const running = readKept(file).filter(night => night.state === "running" && botHere(night.bot));
  keepAwake(running.length > 0);
  if (running.length && onPower() === false) for (const night of running) addBlocker(night.bot, { kind: "you", text: "Your Mac is on battery", detail: "It may sleep before the work is done. Plug it in to carry on." }, file);
  const sessions = running.length ? await workSessions(targets(), signal).catch(() => []) : [];
  for (const night of running) {
    const waiting: Record<string, number> = {};
    const work = ofBot(night.bot, sessions);
    const own = await placeOfSession(night.session, targets()).catch(() => null);
    // The bot's own rules, and its sessions', ask for what always comes to you and for publishing,
    // whatever their approval was set to since.
    // (With a public step switched on, publishing goes ahead: you approved it for tonight.)
    const publishing = !night.public.some(step => step.on);
    for (const place of [...(own ? [{ target: own.target, id: night.session, rules: own.data.permissions }] : []), ...work.map(each => ({ target: each.target, id: each.data.id, rules: each.data.permissions }))]) {
      if (asksAlways(place.rules, { publishing })) continue;
      await call(place.target, "PATCH", `/api/session/${encodeURIComponent(place.id)}`, { permissions: withAlwaysAsk((place.rules ?? []) as KitRule[], { publishing }) }, signal).catch(() => {});
    }
    const places = [...work.map(each => ({ target: each.target, id: each.data.id, title: each.data.title || "New Session" })), ...(own ? [{ target: own.target, id: night.session, title: night.name }] : [])];
    for (const place of places) {
      const { permissions, questions } = await asksIn(place.target, place.id, signal).catch(() => ({ permissions: [], questions: [] }));
      for (const permission of permissions) {
        const key = `${place.id}:${permission.id}`;
        const first = night.waiting?.[key] ?? now;
        waiting[key] = first;
        if (now - first < wait) continue;
        const said = await call(place.target, "POST", `/api/session/${encodeURIComponent(permission.asker)}/permission/${encodeURIComponent(permission.id)}/reply`, { decision: "reject", message: ASK_TEXT }, signal).then(() => true, () => false);
        if (!said) continue;
        delete waiting[key];
        const what = permissionWords(permission);
        await keepAnswer(place.target, place.id, { ask: permission.id, ...(permission.call ? { call: permission.call } : {}), what, decision: "deny", reason: "No one answered overnight", by: { name: "Kuvo Code" }, at: now }).catch(() => {});
        addBlocker(night.bot, { kind: "ask", text: `${place.title}: ${what.replace(/\.$/, "")}`, detail: "No one answered overnight, so it was no", session: place.id }, file);
      }
      // A question no one answers: put away, so the session goes on without it.
      for (const question of questions) {
        const key = `${place.id}:${question.id}`;
        const first = night.waiting?.[key] ?? now;
        waiting[key] = first;
        if (now - first < wait) continue;
        const said = await call(place.target, "DELETE", `/api/session/${encodeURIComponent(question.asker)}/form/${encodeURIComponent(question.id)}?message=${encodeURIComponent(QUESTION_TEXT)}`, undefined, signal).then(() => true, () => false);
        if (!said) continue;
        delete waiting[key];
        addBlocker(night.bot, { kind: "ask", text: `${place.title} asks: ${question.text}`, detail: "No one answered overnight", session: place.id }, file);
      }
    }
    // What the bot asks you itself (making a project the plan didn't name).
    for (const ask of workAsks().filter(each => each.bot === night.bot && now - each.at >= wait)) {
      const answered = await answerWork(ask.id, { answer: "deny", overnight: true }, targets).catch(() => null);
      if (answered && "answered" in answered) addBlocker(night.bot, { kind: "outside", text: `Make the project ${ask.project}`, detail: "It wasn't in the plan, so it waits for you" }, file);
    }
    changeKept(all => {
      const kept = all.find(each => each.id === night.id);
      if (kept) kept.waiting = waiting;
    }, file);
  }
  // What's new, to your phones.
  for (const night of readKept(file).filter(each => botHere(each.bot) && (each.state === "running" || each.state === "done" || each.state === "stopped"))) {
    const told = new Set(night.told ?? []);
    const fresh = night.state === "running" || night.state === "done" ? night.blockers.filter(each => !told.has(each.id)) : [];
    let reportTold = night.reportTold === true;
    for (const blocker of fresh) {
      if (tell({ title: night.name, subtitle: "Needs you in the morning", body: blocker.text, category: "blocked", thread: night.session, data: { session: blocker.session ?? night.session, ...(night.wake && blocker.kind === "you" ? { wake: "1" as const } : { quiet: "1" as const }) } })) told.add(blocker.id);
    }
    if (night.state !== "running" && !reportTold && night.report) {
      reportTold = tell({ title: `${night.name}'s night`, subtitle: night.blockers.length ? `${night.blockers.length} ${night.blockers.length === 1 ? "thing needs" : "things need"} you` : night.state === "done" ? "Done" : "Stopped", body: night.report, category: "report", thread: night.session, data: { session: night.session, quiet: "1" } });
    }
    if (told.size !== (night.told ?? []).length || reportTold !== (night.reportTold === true)) {
      changeKept(all => {
        const kept = all.find(each => each.id === night.id);
        if (!kept) return;
        kept.told = [...told];
        kept.reportTold = reportTold;
      }, file);
    }
  }
}

/** The nights here watched, every `every` ms and as they change, until `signal` stops it. */
export async function watchNights(tell: (notice: Notice) => boolean, targets: () => Target[], { signal, every = 30_000 }: { signal?: AbortSignal; every?: number } = {}): Promise<void> {
  let soon = false;
  const look = () => { soon = true; };
  nightFollowers.add(look);
  try {
    while (!signal?.aborted) {
      soon = false;
      try { await lookAtNights(tell, targets, { signal }); } catch {}
      for (let waited = 0; waited < every && !soon && !signal?.aborted; waited += 1000) await pause(1000, signal);
    }
  } finally {
    nightFollowers.delete(look);
    keepAwake(false);
  }
}
