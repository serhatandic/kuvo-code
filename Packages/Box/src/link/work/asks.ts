// What a bot asks you before it does it (PROTOCOL.md, "Work": `kuvo/work/asks`): making a
// project, or cloning one; and what any agent asks before it uses one of your plans' resets
// (`use_limit_reset`). Kept in `run/work/asks.json` until you answer, on whichever client you
// use; what you answer is done here, on the box, and its tool hears of it. A project's "Always" is
// kept with the bot (`work.allowed` in its bot.json), so it asks once for each kind; Edit Bot takes
// it back. A reset's is kept with the account (`limits-resets.ts`); Settings › Accounts takes it back.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { pause } from "../../shared/wait";
import { botHere, changeDescription, noteBotsChanged } from "../bots/here";
import { asked, bridgeTarget, peerPlaces } from "../engine/client";
import { resetAskWords, spendReset, type ResetGiven } from "./plan-reset";
import { sendInto } from "../engine/queue";
import { boxNote } from "../../shared/queues";
import { messageID } from "../engine/sessions";
import { locked, textOf, writePrivate } from "../files";
import { HERE } from "../home";
import { placeOfSession } from "../letters/letter";
import { tellMovedAway } from "../letters/outbox";
import { frozen } from "../moves/records";
import { noteWorkChanged, WORK_FOLDER } from "./changes";
import { folderName, madeWords, makeProject, projectPlace, shownPath } from "./projects";
import { folderGiven, projectsFolder, setProjectsFolder, suggestedFolder } from "./settings";
import type { Target } from "../../shared/records";
import type { WorkAskShape } from "../../shared/routes/work";

export const WORK_ASKS = path.join(WORK_FOLDER, "asks.json");
const LOCK = path.join(WORK_FOLDER, ".asks.lock");

/** What may be asked: making a project, or cloning one into a new project; using a plan's reset. */
export type WorkAction = "makeProject" | "cloneProject" | "resetLimits";
export const WORK_ACTIONS: readonly WorkAction[] = ["makeProject", "cloneProject", "resetLimits"];
/** What a bot may be allowed Always (kept with it): a project's; a reset's is the account's. */
const BOT_ACTIONS = ["makeProject", "cloneProject"] as const;

/** An ask as it's kept: as it's listed, what it was given, and once answered, how it went (and
 * whether its tool had stopped waiting, so its conversation is told instead). */
export interface KeptAsk extends WorkAskShape {
  /** What make_project was given, with the folder named for it as a full path (`namedPlace`); or the reset asked for. */
  given: { name: string; git?: boolean; clone?: string; folder?: string; reset?: ResetGiven };
  late?: boolean;
  /** For one answered after its tool stopped waiting: whether its conversation has been told. */
  toldLate?: boolean;
  /** Being answered now (ms): one answer at a time does what's asked. */
  answering?: number;
  answered?: { answer: "allow" | "always" | "deny"; text: string; isError: boolean; at: number };
}

/** Those following the asks here, in this process. */
export const askFollowers = new Set<() => void>();

const readKept = (file = WORK_ASKS): KeptAsk[] => {
  try {
    const asks = JSON.parse(textOf(file) ?? "").asks;
    return Array.isArray(asks) ? asks.filter(each => isObject(each) && typeof each.id === "string" && WORK_ACTIONS.includes(each.action as WorkAction)) : [];
  } catch {
    return [];
  }
};

// The asks as `change` leaves them, under the lock; answered ones go after a quarter hour, once
// their tool has had them.
function changeKept<T>(change: (asks: KeptAsk[]) => T, file = WORK_ASKS): T {
  fs.mkdirSync(WORK_FOLDER, { recursive: true });
  const result = locked(LOCK, () => {
    const asks = readKept(file);
    const value = change(asks);
    // Answered ones once their tool has had them (or their conversation, told a week at most);
    // unanswered ones of a bot that's gone, or asked a week ago and more.
    const kept = asks.filter(each => (each.answered ? Date.now() - each.answered.at < 15 * 60_000 || (each.late === true && !each.toldLate && Date.now() - each.answered.at < 7 * 86_400_000) : (!each.bot || botHere(each.bot)) && Date.now() - each.at < 7 * 86_400_000));
    writePrivate(file, JSON.stringify({ asks: kept }, null, 2));
    return value;
  });
  for (const tell of askFollowers) tell();
  return result;
}

/** What's asked now (not answered), as clients list them: of bots still here, and of other
 * conversations. */
export function workAsks(file = WORK_ASKS): WorkAskShape[] {
  return readKept(file).filter(each => !each.answered && (!each.bot || botHere(each.bot))).map(kept => {
    const { given: _, late: __, answering: ____, answered: ___, toldLate: _____, ...listed } = kept;
    // A reset's: the account and what it has, nothing of folders; and its notification's words, the
    // box's, so every client says the same.
    if (kept.action === "resetLimits") return { ...listed, folder: null, ...(kept.reset ? { words: resetAskWords(kept.name, kept.reset) } : {}) };
    // Where it would go, as it stands now: the folder may have been picked since (unless one was
    // named for it).
    const root = projectsFolder();
    const named = kept.given?.folder;
    const folder = named ?? projectPlace(listed.project, root);
    const suggested = root || named ? null : suggestedFolder();
    const shown: WorkAskShape = { ...listed, folder: folder ?? null };
    delete shown.suggested;
    if (suggested) shown.suggested = suggested;
    return shown;
  });
}

/** Whether you allowed the bot `bot` to do `action` without asking ("Always"). */
export function botAllows(bot: string | undefined, action: WorkAction): boolean {
  if (!bot) return false;
  const work = botHere(bot)?.described.work;
  return (BOT_ACTIONS as readonly WorkAction[]).includes(action) && isObject(work) && Array.isArray(work.allowed) && work.allowed.includes(action);
}

/** What you allowed `bot` to do without asking, as it's kept. */
export function allowedOf(described: Record<string, unknown>): ("makeProject" | "cloneProject")[] {
  const work = described.work;
  return isObject(work) && Array.isArray(work.allowed) ? BOT_ACTIONS.filter(each => (work.allowed as unknown[]).includes(each)) : [];
}

// "Always": `action` kept with the bot, for its next time (with what's in its description now).
function allowAlways(bot: string, action: WorkAction) {
  const here = botHere(bot);
  if (!here) return;
  changeDescription(here.folder, now => {
    const described = { ...(now ?? here.described) };
    const work = isObject(described.work) ? { ...described.work } : {};
    work.allowed = [...new Set([...allowedOf(described), action])];
    described.work = work;
    return described;
  });
  noteBotsChanged();
}

/** Who asks: the conversation (its root), by its name, and the bot it is, if it's one. */
export interface Asker {
  session: string;
  name: string;
  bot?: string;
}

/** An ask for `given`, kept until you answer it; the same one asked again by the same conversation
 * is the ask it already has. */
export function askWork(asker: Asker, action: WorkAction, given: KeptAsk["given"], file = WORK_ASKS): KeptAsk {
  const ask = changeKept(asks => {
    // (One open card a conversation for each project, or for each account's resets.)
    const same = asks.find(each => !each.answered && each.session === asker.session && each.action === action && (action === "resetLimits" ? each.given?.reset?.row === given.reset?.row : each.project.toLowerCase() === given.name.toLowerCase()));
    if (same) {
      delete same.late;
      return same;
    }
    const made: KeptAsk = {
      id: `wak_${crypto.randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "")}`,
      action,
      session: asker.session,
      name: asker.name,
      ...(asker.bot ? { bot: asker.bot } : {}),
      project: given.name,
      ...(given.clone ? { clone: given.clone } : {}),
      ...(action === "resetLimits" && given.reset
        ? { folderName: "", folder: null, reset: given.reset }
        : { folderName: given.folder ? path.basename(given.folder) : folderName(given.name) ?? given.name, folder: given.folder ?? projectPlace(given.name) }),
      at: Date.now(),
      given,
    };
    asks.push(made);
    return made;
  }, file);
  if (ask.bot) noteWorkChanged(ask.bot);
  return ask;
}

/** Its answer, once you give it (`every` ms between looks), until `wait` ms go by or its asker goes;
 * null then, and it stays asked: its conversation is told when you answer. */
export async function answerOf(id: string, { wait = 10 * 60_000, every = 1000, signal, file = WORK_ASKS }: { wait?: number; every?: number; signal?: AbortSignal; file?: string } = {}): Promise<KeptAsk["answered"] | null> {
  const until = Date.now() + wait;
  while (!signal?.aborted) {
    const ask = readKept(file).find(each => each.id === id);
    // (Its bot gone: there's no one to answer for.)
    if (!ask || (ask.bot && !botHere(ask.bot))) return null;
    if (ask.answered) return ask.answered;
    if (Date.now() >= until) break;
    await pause(Math.min(every, until - Date.now()), signal);
  }
  // No longer waited for: told to its conversation once answered; one answered just now, here.
  return changeKept(asks => {
    const ask = asks.find(each => each.id === id);
    if (ask?.answered) return ask.answered;
    if (ask) ask.late = true;
    return null;
  }, file);
}

/** What the asked action does, in its maker's words; done now. `always`: a reset's Always Allow, kept with the account first. */
export async function doWork(action: WorkAction, given: KeptAsk["given"], asker: Asker, always = false): Promise<{ text: string; isError: boolean }> {
  if (action === "resetLimits") {
    const bridge = bridgeTarget();
    if (!given.reset) return { text: "There's no reset to use in that ask.", isError: true };
    if (!bridge) return { text: `The coding agents aren't running on ${HERE} now, so the reset wasn't used.`, isError: true };
    return spendReset(bridge, given.reset.row, asker.name, { always });
  }
  const madeBy = asker.bot ? { bot: asker.bot, name: asker.name, at: Date.now() } : null;
  const outcome = await makeProject({ name: given.name, git: given.git, clone: action === "cloneProject" ? given.clone : undefined, folder: given.folder }, madeBy);
  if ("refused" in outcome) return { text: outcome.refused.message, isError: true };
  if (asker.bot) noteWorkChanged(asker.bot);
  return { text: madeWords(outcome.made, HERE), isError: false };
}

/** Why an answer can't be taken: an ask that isn't there (404), or one that won't do (400). */
export interface AnswerRefusal {
  status: 400 | 404;
  message: string;
}

/** Your answer to the ask `id` (`allow`, `always` or `deny`, and the projects folder, when none is
 * picked here yet): done, and its asker told, as its tool waits or, after, in its conversation. */
export async function answerWork(id: string, given: Record<string, unknown>, targets: () => Target[], file = WORK_ASKS): Promise<{ answered: NonNullable<KeptAsk["answered"]> } | { refused: AnswerRefusal }> {
  const ask = readKept(file).find(each => each.id === id && !each.answered);
  if (!ask) return { refused: { status: 404, message: "That's been answered, or it isn't asked any more." } };
  const answer = given.answer;
  if (answer !== "allow" && answer !== "always" && answer !== "deny") return { refused: { status: 400, message: "Answer allow, always or deny." } };
  // The projects folder, picked with the first: only where none is, and kept once it's claimed (not
  // for one with a folder named for it).
  let picked: string | null = null;
  if (answer !== "deny" && ask.action !== "resetLimits" && !projectsFolder() && !ask.given.folder) {
    if (given.folder === undefined || given.folder === null) return { refused: { status: 400, message: "Pick the folder new projects go in." } };
    const checked = folderGiven(given.folder);
    if ("refused" in checked) return { refused: { status: 400, message: checked.refused } };
    picked = checked.folder;
  }
  // One answer at a time: another given meanwhile (from a phone, say) finds it taken.
  const claimed = changeKept(asks => {
    const kept = asks.find(each => each.id === id && !each.answered);
    if (!kept || (kept.answering && Date.now() - kept.answering < 15 * 60_000)) return false;
    kept.answering = Date.now();
    return true;
  }, file);
  if (!claimed) return { refused: { status: 404, message: "That's been answered, or it isn't asked any more." } };
  const asker: Asker = { session: ask.session, name: ask.name, ...(ask.bot ? { bot: ask.bot } : {}) };
  const what = ask.action === "resetLimits" ? `using one of ${ask.project}'s resets` : ask.action === "cloneProject" ? `cloning ${ask.clone} as ${ask.project}` : `making ${ask.project}`;
  let outcome: { text: string; isError: boolean };
  if (answer === "deny" && given.overnight === true) {
    outcome = { text: `No one could answer ${what} overnight, so it's no for now. Go on without it; it waits for the user in the morning report.`, isError: true };
  } else if (answer === "deny") {
    outcome = { text: `The user said no to ${what}. Don't ask again for it: go on without it, or ask them in a line what they'd like instead.`, isError: true };
  } else {
    // Whatever goes wrong is its answer, so the ask is never left half answered.
    try {
      if (picked && !projectsFolder()) setProjectsFolder(picked);
      if (answer === "always" && ask.bot && (BOT_ACTIONS as readonly WorkAction[]).includes(ask.action)) allowAlways(ask.bot, ask.action);
      outcome = await doWork(ask.action, ask.given, asker, answer === "always");
    } catch (error) {
      outcome = { text: `Couldn't do it: ${String((error as Error | null)?.message ?? error)}`, isError: true };
    }
  }
  const answered = { answer, ...outcome, at: Date.now() } as NonNullable<KeptAsk["answered"]>;
  const late = changeKept(asks => {
    const kept = asks.find(each => each.id === id);
    if (kept) {
      kept.answered = answered;
      delete kept.answering;
    }
    return Boolean(kept?.late);
  }, file);
  if (ask.bot) noteWorkChanged(ask.bot);
  // Its tool stopped waiting: its conversation hears of it as a message (and, should the box stop
  // first, as it starts again: `tellLateAnswers`).
  if (late) await tellLate(id, targets, file);
  return { answered };
}

// One answered after its tool stopped waiting, told to its conversation, and noted once it is. Not
// while it moves to or from another computer (a turn here would be left behind), nor while it can't
// be reached: tried again every few minutes (`workWatcher`) and as the box starts.
async function tellLate(id: string, targets: () => Target[], file: string, bridgeRuns = () => peerPlaces().bridge) {
  const ask = readKept(file).find(each => each.id === id);
  if (!ask?.answered || !ask.late || ask.toldLate || frozen().has(ask.session)) return;
  const said = `[The user answered] ${ask.answered.text}`;
  const note = { from: "Your answer", words: ask.answered.text, line: `You answered: ${ask.answered.text}`, delivery: "queue" } as const;
  const place = await placeOfSession(ask.session, targets()).catch(() => undefined);
  if (place === undefined) return;
  if (place === null) {
    // Moved to another computer since: told there, as a letter. Else not known while the coding
    // agents' bridge isn't running (it may be the bridge's); else gone for sure: no one to tell.
    if (!tellMovedAway(ask.session, said, note) && !bridgeRuns()) return;
  } else {
    const sent = await sendInto(place.target, ask.session, { id: messageID(), text: said, delivery: note.delivery, metadata: boxNote(note.from, note.line) }, { from: note.from, words: note.words }).then(() => true, () => false);
    if (!sent) return;
  }
  changeKept(asks => {
    const kept = asks.find(each => each.id === id);
    if (kept) kept.toldLate = true;
  }, file);
}

/** What was answered after its tool stopped waiting and not told yet (the box stopping in
 * between), told now, as a box starts. */
export async function tellLateAnswers(targets: () => Target[], file = WORK_ASKS, bridgeRuns?: () => boolean): Promise<void> {
  for (const ask of readKept(file).filter(each => each.answered && each.late && !each.toldLate)) await tellLate(ask.id, targets, file, bridgeRuns);
}

/** The ask in words for a notification: who asks, and what. */
export function workAskWords(ask: WorkAskShape): { title: string; body: string } {
  if (ask.action === "resetLimits" && ask.reset) return resetAskWords(ask.name, ask.reset);
  const where = ask.folder ? ` in ${shownPath(path.dirname(ask.folder))}` : "";
  return ask.action === "cloneProject"
    ? { title: `${ask.name} asks to clone a project`, body: `${ask.clone ?? ""} as ${ask.project}${where}` }
    : { title: `${ask.name} asks to make a project`, body: `${ask.project}${where}` };
}

/** Each new ask, to your phones' notifications, once; `answered` hears of one told that's no longer
 * asked. Every `every` ms, until `signal` stops it. */
export async function watchWorkAsks(
  tell: (notice: { title: string; body: string; category: "ask"; thread: string; data: { session: string; ask: string; answerable: "0" } }) => boolean,
  { signal, every = 2000, read = workAsks, answered = () => {} }: { signal?: AbortSignal; every?: number; read?: () => WorkAskShape[]; answered?: (id: string) => void } = {},
): Promise<void> {
  const told = new Set<string>();
  while (!signal?.aborted) {
    try {
      const asks = read();
      const open = new Set(asks.map(ask => ask.id));
      for (const id of told) {
        if (open.has(id)) continue;
        told.delete(id);
        answered(id);
      }
      for (const ask of asks) {
        // (One asked a while ago was told by the bridge before this one.)
        if (told.has(ask.id) || Date.now() - ask.at > 30 * 60_000) continue;
        if (tell({ ...workAskWords(ask), category: "ask", thread: ask.session, data: { session: ask.session, ask: ask.id, answerable: "0" } })) told.add(ask.id);
      }
    } catch {}
    await pause(every, signal);
  }
}
