// What a typed message means (PROTOCOL.md, "What a typed message means"): the order a text is tried
// in (a goal, a keyword, the engine's own review, a "!" command, a command of the engine's, else a
// message), what each keyword does alone and with words, and what goes back to the composer when it
// can't be done, decided once here for every client. Pure: what it takes is what the route read
// (areas/typed.ts), and what it gives is what the route does or tells the client to.

import { commandsOffered, firstWake, keepsTimeOfDay, parseCommand, parseGoal, parseKeyword, parseLoop, parseReview, QUICK_REVIEW, repeatText, reviewUnfinished, scopeAsked, focusAsked, shellCommand, splitCommand, type Command, type GoalCommand, type Keyword, type ModelRef, type Reader, type ReviewScope } from "./words";

/** What the box knows of the conversation and the composer as the text is sent. */
export interface Facts {
  /** The keywords this conversation offers (`keywordsOffered`). */
  keywords: readonly Keyword[];
  /** The engine's commands in the conversation's folder, as it lists them (the keywords' names not
   * taken yet). */
  commands: Command[];
  /** Pictures or files are attached. */
  files: boolean;
  /** The composer asks the side thread that shows over it (its tag is on), not the conversation. */
  side: boolean;
  /** Why the conversation's model can't run now, as the client shows it; none when it can. */
  refusal: string | null;
  /** The models "/review with …" can name here (none for a coding agent's conversation). */
  readers: Reader[];
  /** The one picked last in "Who reads it", which wins a tie. */
  reviewer: ModelRef | null;
  /** A subagent's conversation. */
  subagent: boolean;
  /** It has a goal (or one it met), as its box has it. */
  hasGoal: boolean;
  /** A bot's own chat: its goal starts from the bot's plan. */
  botChat: boolean;
  /** The agents bridge beside the engine runs (goals, side questions, handoffs, reviews). */
  bridge: boolean;
  /** Now, in ms since 1970, and the box's time zone. */
  now: number;
  timeZone?: string;
}

/** What goes back to the composer: `text` into an empty one; beside words written since, `beside`
 * in front of them where it's given (a keyword's words alone, which the keyword would take in;
 * nothing for a goal's pause, resume or clear), else `text`. */
export interface Restore {
  text: string;
  beside?: string;
}

/** What the box is to do for it, and what goes back if that fails. */
export type BoxStep =
  | { do: "goal"; command: Exclude<GoalCommand, { kind: "show" }> }
  | { do: "askBot"; words: string }
  | { do: "autopilot" }
  | { do: "wake"; due: number; every: string; note: string }
  | { do: "btw"; question: string }
  | { do: "handoff"; next: string | null }
  | { do: "review"; model: ModelRef | null; focus: string | null; scope: ReviewScope | null };

/** What the client does, in this order, once the box has done its step: with `send` and `command`
 * the composer's files go too (else they stay), and with `send.quoted` its quotes (else they stay);
 * `send.steer`: to the agent now, whatever it's doing (a /loop's first), never to wait in the queue. */
export interface ClientSteps {
  showGoal?: true;
  plan?: "toggle" | "on";
  toggleAutopilot?: true;
  compact?: true;
  shell?: string;
  command?: { name: string; arguments: string };
  send?: { text: string; typed?: string; quoted?: true; steer?: true };
  sideThread?: true;
}

export interface Decision extends ClientSteps {
  /** The keyword it ran (for what a client counts). */
  keyword?: Keyword;
  box?: BoxStep;
  /** When the box's step fails: what goes back (its error says why). */
  failed?: Restore;
  restore?: Restore;
  error?: string;
}

export const SUBAGENT_GOAL = "A subagent’s conversation can’t have a goal of its own. Set it in the conversation it works for.";
export const GOALS_NOT_RUNNING = "Goals run in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment.";
export const KEYWORD_UNAVAILABLE = "This runs in the agents bridge beside the engine on this conversation’s computer, and it isn’t running now. Try again in a moment.";
export const LOOP_NO_SCHEDULE = "Can’t tell how often from that. Start with one like “every 30 min” or “weekdays at 9”, or pick one from the list after /loop.";
export const LOOP_NO_MESSAGE = "Write what to do each time after how often, like “/loop every morning at 9 sum up the new issues”.";
export const REVIEW_PICK = "Pick who reads it from the list, or write a model’s name after “with”.";
export const REVIEW_FINISH = "Finish the model’s name, or pick it from the list.";

/** What was written for a keyword that couldn't be done, put back: as written into an empty
 * composer; beside words written since, its words alone (a goal's pause, resume or clear none:
 * "pause" would go as a message). */
export function writtenBack(written: string): Restore {
  const typed = parseKeyword(written);
  if (!typed) return { text: written };
  const goal = parseGoal(written);
  return { text: written, beside: !goal || goal.kind === "set" ? typed.rest : "" };
}

/** The keyword a message starts with, of those offered here ("/goal" is the goal's own). */
function typedKeyword(text: string, keywords: readonly Keyword[]) {
  const typed = parseKeyword(text);
  return typed && typed.keyword !== "goal" && keywords.includes(typed.keyword) ? typed : null;
}

/** What runs as typed (a "!" command, a goal, a keyword or command offered here), even while the side
 * thread's tag shows. */
export function runsAsTyped(text: string, commands: Command[], keywords: readonly Keyword[]): boolean {
  if (shellCommand(text) !== null || parseCommand(text, commands) !== null || parseGoal(text) !== null) return true;
  return typedKeyword(text, keywords) !== null;
}

/** Whether what's written needs the conversation's model to go: everything but a "!" command, and
 * showing, pausing, resuming or taking away a goal. */
export function needsModel(text: string): boolean {
  if (shellCommand(text) !== null) return false;
  const goal = parseGoal(text);
  return !goal || goal.kind === "set";
}

export function decide(text: string, facts: Facts): Decision {
  // A model that can't run: said instead, all of it kept.
  if (facts.refusal && needsModel(text)) return { restore: { text }, error: facts.refusal };
  const commands = commandsOffered(facts.commands, facts.keywords);
  // The side thread's tag on the composer: a follow-up there, unless it runs as typed.
  if (facts.side && !runsAsTyped(text, commands, facts.keywords)) return { sideThread: true };
  const goal = parseGoal(text);
  if (goal) return decideGoal(text, goal, facts);
  const typed = typedKeyword(text, facts.keywords);
  if (typed) return { keyword: typed.keyword, ...decideKeyword(typed.keyword, typed.rest, text, facts) };
  const split = splitCommand(text);
  // The engine's own /review, which ours took the name of.
  if (split && split.name === QUICK_REVIEW && commands.some(command => command.name === QUICK_REVIEW)) return { command: { name: "review", arguments: split.arguments } };
  const shell = shellCommand(text);
  if (shell !== null) return { shell };
  const command = parseCommand(text, commands);
  if (command) return { command };
  return { send: { text, quoted: true } };
}

function decideGoal(written: string, goal: GoalCommand, facts: Facts): Decision {
  // "/goal" alone shows it; with none, what to type is left ready to finish.
  if (goal.kind === "show") return { showGoal: true, ...(facts.hasGoal ? {} : { restore: { text: "/goal " } }) };
  // A bot's goal starts from its plan: the bot is asked for one, and puts it to you.
  if (goal.kind === "set" && facts.botChat) return { box: { do: "askBot", words: goal.words }, failed: writtenBack(written) };
  if (facts.subagent) return { restore: writtenBack(written), error: SUBAGENT_GOAL };
  if (!facts.bridge) return { restore: writtenBack(written), error: GOALS_NOT_RUNNING };
  return { box: { do: "goal", command: goal }, failed: writtenBack(written) };
}

function decideKeyword(keyword: Keyword, rest: string, written: string, facts: Facts): Decision {
  switch (keyword) {
    case "goal":
      return {};
    case "plan":
      // Alone, it turns Plan on or off; with words, it plans them.
      if (!rest && !facts.files) return { plan: "toggle" };
      return { plan: "on", ...(rest ? { send: { text: rest, typed: "/plan" } } : {}) };
    case "autopilot":
      // Alone, it turns Autopilot on or off; with words, it does them on Autopilot (on first, so its
      // agent works that way from the first word).
      if (!rest && !facts.files) return { toggleAutopilot: true };
      return { box: { do: "autopilot" }, failed: writtenBack(written), ...(rest ? { send: { text: rest, typed: "/autopilot" } } : {}) };
    case "compact":
      return { compact: true };
    case "loop": {
      // "/loop <how often> <what to do>": the message sent now for one every so long (and then each
      // time), and a wake-up on its computer that sends it again, by its clock.
      const loop = parseLoop(rest);
      if (!loop.schedule) return { restore: writtenBack(written), error: LOOP_NO_SCHEDULE };
      if (!loop.message) return { restore: writtenBack(written), error: LOOP_NO_MESSAGE };
      const due = Math.floor(firstWake(loop.schedule, facts.now, facts.timeZone) / 1000);
      return {
        box: { do: "wake", due, every: repeatText(loop.schedule.every), note: loop.message },
        failed: writtenBack(written),
        // A wake-up sends words: what's attached goes with the message sent now, or stays.
        ...(keepsTimeOfDay(loop.schedule.every) ? {} : { send: { text: loop.message, typed: `/loop ${loop.scheduleText}`, steer: true } }),
      };
    }
    case "btw":
      if (!rest) return { restore: { text: "/btw " } };
      if (!facts.bridge) return { restore: writtenBack(written), error: KEYWORD_UNAVAILABLE };
      return { box: { do: "btw", question: rest }, failed: writtenBack(written) };
    case "handoff":
      if (!facts.bridge) return { restore: writtenBack(written), error: KEYWORD_UNAVAILABLE };
      return { box: { do: "handoff", next: rest || null }, failed: writtenBack(written) };
    case "review": {
      const review = parseReview(rest, facts.readers, facts.reviewer);
      if (review.searching !== null) return { restore: writtenBack(written), error: review.searching ? REVIEW_FINISH : REVIEW_PICK };
      const unfinished = reviewUnfinished(review);
      if (unfinished) return { restore: writtenBack(written), error: unfinished };
      if (!facts.bridge) return { restore: writtenBack(written), error: KEYWORD_UNAVAILABLE };
      const scope = scopeAsked(review);
      return { box: { do: "review", model: review.reader?.ref ?? null, focus: focusAsked(review), scope: scope?.kind === "uncommitted" ? null : scope }, failed: writtenBack(written) };
    }
  }
}
