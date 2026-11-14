// What's news for your phones in an engine's or a group chat's events, said as the Mac's
// notifications say it.

import os from "node:os";
import path from "node:path";
import { outsideShown } from "../../shared/text";
import { boxNoteOf, wakeMarkOf } from "../../shared/queues";
import { filedUnder, readProjects } from "../areas/projects";
import { engineGet } from "../engine/client";
import { summaryAtEnd } from "../../shared/summaries";
import { isHiddenRun } from "../engine/sessions";
import { sessionsWaitingOnServer } from "../work/answers";
import { isAutopilot } from "../work/autopilot";
import { isChatsFolder } from "../engine/chats";
import { masked, showsAll } from "./mask";
import { oneSentence, plain, reasonLine } from "./sentence";
import { writtenByYou } from "../engine/queue";
import { isObject, type Fields } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { EngineAnswer, UncheckedAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import type { NoticeHold } from "./hold";
import type { Notice, NoticeCategory, NoticeData } from "./notice";

/** A permission an engine asks for (`permission.asked`): its id, the session asking, what it
 * would do and what it covers. */
export interface PermissionAsked {
  id: string;
  sessionID: string;
  action: string;
  resources?: unknown;
  /** The rule Always saves (the engine's), when it names one. */
  save?: unknown;
}

/** One of a form's fields, as this reads it. */
export interface FormField {
  type?: string;
  hidden?: boolean;
  when?: unknown[];
  title?: string;
  description?: string;
  options?: { label?: unknown }[];
}

/** A form an engine asks you to fill (`form.created`): a question, or an MCP server's
 * (`mcp-elicitation`, filed under the session "global"). */
export interface EngineForm {
  id: string;
  sessionID: string;
  title?: string;
  metadata?: { kind?: string; message?: string; server?: string; tool?: { messageID?: string; id?: string } };
  fields?: FormField[];
}

/** What an engine event carries, as this reads it: a permission asked, a form (under `form`, or
 * as it is), or the session whose run ended. */
export type EngineEventData = Partial<PermissionAsked> & { form?: EngineForm; error?: { message?: unknown } | null };

/** An engine's event, as this reads it: its type, what it carries, and the folder it came from. */
export interface EngineEvent {
  type: string;
  data?: EngineEventData;
  location?: { directory?: string };
}

/** A group chat's event (`kuvo.group.met`, `kuvo.group.done`, from the agents' bridge): its chat
 * and name, who spoke last or finished, and what they said. */
export interface GroupEvent {
  type: string;
  data?: {
    id?: unknown;
    name?: unknown;
    last?: { kind?: string; text?: unknown };
    who?: unknown;
    text?: unknown;
  };
}

/** A message in a session, as far as this reads it: its blocks of text and tools, and a message
 * written to it, its text and marks. */
interface EngineMessage {
  type: string;
  text?: unknown;
  metadata?: unknown;
  content?: { type: string; text?: string; name?: string; state?: { status?: string; input?: { code?: unknown } } }[];
}

/** Asks the engine `route`: its JSON, whatever came. */
export type EngineAsk = (route: string, folder?: string) => Promise<unknown>;

// "Wants to run a command: npm test", as the Mac says it: every one it covers (a command line's
// commands each, as Allow takes them all), up to four, then how many more. With `home` (for people:
// a notice), folders outside the project as they know them ("~/notes", not "/Users/me/notes/*");
// an agent's told the paths.
export function describePermission(request: Pick<PermissionAsked, "action" | "resources">, home?: string): string {
  const what = ({ edit: "edit files", write: "edit files", patch: "edit files", shell: "run a command", bash: "run a command", read: "read a file", external_directory: "work outside the project", webfetch: "open a web page" } as Record<string, string>)[request.action] ?? request.action;
  const shown = (Array.isArray(request.resources) ? request.resources : []).filter(each => each !== "*")
    .map(each => home !== undefined && request.action === "external_directory" ? outsideShown(String(each), home) : each);
  if (!shown.length) return `Wants to ${what}.`;
  const more = shown.length > 4 ? ` · and ${shown.length - 4} more` : "";
  return `Wants to ${what}: ${shown.slice(0, 4).join(" · ")}${more}`;
}

// Whether Always saves only what a permission's notice shows. The engine's rule for it can be wider
// (`git push *` for `git push origin main`, any file for one): then a phone that can't name what
// Always saves (one from before `alwaysTitle`) offers Allow Once and Don't Allow only.
const offersAlways = (request: { resources?: unknown; save?: unknown }): boolean => {
  const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((each): each is string => typeof each === "string");
  const shown = strings(request.resources);
  const saved = Array.isArray(request.save) ? strings(request.save) : shown;
  return saved.length > 0 && !saved.includes("*") && saved.every(each => shown.includes(each));
};
// What a permission's Always saves, as its button says it: "Always Allow Edits", "Always Allow git
// push", "Always Allow ~/notes" (the Mac's and the phone's `AlwaysWords`, whose cases it matches).
export function alwaysTitle(request: { action?: string; resources?: unknown; save?: unknown }, home: string | null): string {
  const { title, named } = alwaysWords(request, home);
  return named === null ? title : `${title} ${named}`;
}

// The same, as a card's button draws it (KuvoClient's `AlwaysWords`): its words, then what it names
// (`named`, shown as code: a command's kind, a folder), null where it names nothing.
export function alwaysWords(request: { action?: string; resources?: unknown; save?: unknown }, home: string | null): { title: string; named: string | null } {
  const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((each): each is string => typeof each === "string");
  const asked = strings(request.resources);
  const saved = Array.isArray(request.save) ? strings(request.save) : asked;
  // The line asked about, saved beside its kind (`git --no-pager diff` with `git diff *`): the kind
  // says what it lets through.
  const kinds = saved.filter(each => !asked.includes(each));
  const patterns = kinds.length ? kinds : saved;
  const kind = (pattern: string) => pattern.endsWith(" *") || pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
  // Cut by what people see as characters, as Swift counts them.
  const characters = (text: string) => [...new Intl.Segmenter().segment(text)].map(each => each.segment);
  const short = (text: string) => characters(text).length > ALWAYS_LONGEST ? characters(text).slice(0, ALWAYS_LONGEST - 1).join("") + "…" : text;
  const only = (title: string) => ({ title, named: null });
  switch (request.action) {
    case "edit": case "patch": case "write": return only("Always Allow Edits");
    case "shell": case "bash":
      if (!patterns.length || patterns.length === 1 && patterns[0] === "*") return only("Always Allow Commands");
      return patterns.length === 1 ? { title: "Always Allow", named: short(kind(patterns[0])) } : only("Always Allow These Commands");
    case "external_directory": {
      if (patterns.length !== 1) return only("Always Allow These Folders");
      const shown = outsideShown(patterns[0], home);
      return { title: "Always Allow", named: short(characters(shown).length > ALWAYS_LONGEST ? `…/${path.basename(shown)}` : shown) };
    }
    default:
      return patterns.length === 1 && patterns[0] !== "*" ? { title: "Always Allow", named: short(kind(patterns[0])) } : only("Always Allow");
  }
}
const ALWAYS_LONGEST = 24;

// Whether a permission's notice shows all it covers: Allow there would allow what it leaves out.
const showsAllCovered = (request: { resources?: unknown }): boolean => (Array.isArray(request.resources) ? request.resources : []).filter(each => each !== "*").length <= 4;

// A question's one field and its choices, as the Mac answers it from a notification.
const singleQuestion = (form: EngineForm): FormField | null => {
  if (form.metadata?.kind !== "question") return null;
  const fields = (form.fields ?? []).filter(field => !field.hidden && !field.when?.length);
  return fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
};

// What a form asks, as the Mac's notification says it.
export function describeForm(form: EngineForm): string {
  const kind = form.metadata?.kind;
  if (kind === "mcp-elicitation") return form.metadata?.message || form.fields?.[0]?.description || form.fields?.[0]?.title || "Needs your answer.";
  if (kind !== "question") return "Needs your answer.";
  const fields = (form.fields ?? []).filter(field => !field.hidden && !field.when?.length);
  if (fields.length === 1 && fields[0].type === "string") return fields[0].description || fields[0].title || form.title || "Has a question for you.";
  return "Has a question for you.";
}

/** Whether a session is a bot's own conversation. */
export const isBot = (session: EngineSession): boolean => Boolean(session.metadata?.kuvo?.bot) || /\/bots\/bot_[^/]+\//.test(`${session.location?.directory ?? ""}/`);


// How a session's latest messages are read for its turn: a page, then more, back to its start.
const TURN_PAGE = 50;
const TURN_PAGES = 20;

/** What began a session's latest turn, from its messages (newest first): you (your message, or your
 * answer, approval or pick passed on), another agent (its letter or work for it), the session's own
 * accord (its wake-up or watch, a goal's word to its bot), what it left running or started
 * (a command or subagent done, its sessions' news: `follow`), or `unknown`, its start out of reach. */
export type TurnBegan = "you" | "agent" | "own" | "follow" | "unknown";

const beganWith = (message: EngineMessage): TurnBegan => {
  if (message.type !== "user") return "follow";
  const text = typeof message.text === "string" ? message.text : "";
  if (wakeMarkOf(message.metadata) || text.startsWith("[Wake-up]")) return "own";
  if (text.startsWith("[Message from ") || text.startsWith("[Work from ")) return "agent";
  if (text.startsWith("[The user ") || text.startsWith("[Decision changed]")) return "you";
  const note = boxNoteOf(text, message.metadata);
  if (note) return note.from === "Your answer" || note.from === "Autopilot" ? "you" : note.from === "Its sessions" ? "follow" : "own";
  return writtenByYou(text, message.metadata) ? "you" : "own";
};

const rowsOf = (messages: unknown): EngineMessage[] => (Array.isArray(messages) ? messages : []).filter((row): row is EngineMessage => typeof row?.type === "string");
const ofTurn = (row: EngineMessage) => row.type === "user" || row.type === "synthetic" || row.type === "assistant";

// Where the latest turn lies in `rows` (newest first): from its end (past what's written since, a
// message waiting its turn) back to, not including, the end before it (`end`, -1 where it's not in them).
function turnIn(rows: EngineMessage[]): { from: number; end: number } {
  const lastEnd = rows.findIndex(row => row.type === "idle");
  const from = lastEnd >= 0 && !rows.slice(0, lastEnd).some(row => ofTurn(row) && row.type !== "user") ? lastEnd + 1 : 0;
  return { from, end: rows.findIndex((row, index) => index >= from && row.type === "idle") };
}

/** A session's latest messages, newest first, as far back as its latest turn begins (a long one is
 * many steps): `whole` once that's in them, or there's nothing older. */
async function latestTurn(session: string, get: EngineAsk): Promise<{ data: EngineMessage[]; whole: boolean }> {
  const data: EngineMessage[] = [];
  let query = `limit=${TURN_PAGE}&order=desc`;
  for (let pages = 0; pages < TURN_PAGES; pages++) {
    const page = await get(`api/session/${encodeURIComponent(session)}/message?${query}`).catch(() => null) as { data?: unknown; cursor?: { next?: string; previous?: string } | null } | null;
    const rows = rowsOf(page?.data);
    data.push(...rows);
    const next = page?.cursor?.next ?? page?.cursor?.previous;
    if (!rows.length || !next) return { data, whole: true };
    if (turnIn(data).end >= 0) return { data, whole: true };
    query = `limit=100&cursor=${encodeURIComponent(next)}`;
  }
  return { data, whole: false };
}

/** What began the latest turn in `messages` (a session's, newest first): any word of yours in it
 * makes it yours; else what began it. `whole`: they reach back to its start (or there's nothing
 * older); one whose start is out of reach is `unknown`, unless a word of yours is in what's there. */
export function turnFor(messages: unknown, whole = true): TurnBegan {
  const rows = rowsOf(messages);
  const { from, end } = turnIn(rows);
  const kinds = rows.slice(from, end < 0 ? undefined : end).filter(row => row.type === "user" || row.type === "synthetic").map(beganWith);
  if (kinds.includes("you")) return "you";
  if (end < 0 && !whole) return "unknown";
  return kinds.at(-1) ?? "you";
}

/** NOTIFY_RULE: whether a reply is news for you. A reply to you is; one to another agent, or of the
 * session's own accord (a wake-up, a watch, a goal's word), isn't. What it left running or started
 * coming back is, in a conversation of yours (not a bot's, nor one an agent started), and so is a
 * turn whose start is out of reach there. A question, a permission or a failure always is, and so
 * is an agent's notify_user. */
export function answersYou(began: TurnBegan, session: EngineSession): boolean {
  if (began === "you") return true;
  // (Its start out of reach: news in a conversation of yours, as most turns there are yours.)
  if (began !== "follow" && began !== "unknown") return false;
  return !isBot(session) && !session.metadata?.kuvo?.startedBy;
}

// A project's name, as every client shows it: its own, or its folder's; a worktree's or another
// folder's is its project's, and so is that of a session filed under it from there (`kuvo.filed`,
// `session`'s, while it's in that folder).
export function projectNameOf(directory: string | undefined, session?: Partial<EngineSession> | null): string | undefined {
  if (!directory) return undefined;
  if (isChatsFolder(directory)) return "Chats";
  const under = filedUnder(directory);
  const mark = session?.metadata?.kuvo?.filed;
  const project = under === directory && isObject(mark) && mark.folder === directory && typeof mark.project === "string" ? mark.project : under;
  return readProjects().find(each => each.directory === project)?.name || path.basename(project) || undefined;
}

// The notification for an engine event, or null for one that isn't news. `get(route)` asks the
// engine.
/** Whether the engine still lists `form` as asked: when it can't say, it's taken as asked. */
export const stillAsked = (form: EngineForm, get: EngineAsk, folder?: string): Promise<boolean> =>
  get(`api/session/${encodeURIComponent(form.sessionID)}/form`, folder).then(answer => {
    const forms = (answer as EngineAnswer<EngineForm[]> | null)?.data;
    return !Array.isArray(forms) || forms.some(each => each?.id === form.id);
  }, () => true);

export async function noticeFor(event: EngineEvent, get: EngineAsk): Promise<Notice | null> {
  const data = event.data ?? {};
  // (As the engine answers it: a session it has, whole; one it hasn't is an error.)
  const session = async (id: string): Promise<EngineSession> => (await get(`api/session/${encodeURIComponent(id)}`) as EngineAnswer<EngineSession>).data;
  // A subagent's request shows in the session that started it.
  const shown = async (id: string): Promise<EngineSession> => {
    let current = await session(id);
    for (let step = 0; step < 5 && current.parentID; step++) current = await session(current.parentID);
    return current;
  };
  // A form an MCP server asks for is filed under no session ("global"): it's the running session
  // of its folder with a tool of that server under way, as the Mac finds it; null for none.
  const waitingOn = async (server: string | undefined, folder: string | undefined): Promise<string | null> =>
    server ? (await sessionsWaitingOnServer(String(server), folder, get))[0] ?? null : null;
  // `answerable` false: its buttons would answer what it can't show, so it has none, and you
  // answer in the conversation. `untitled`: what one without a title is called.
  const about = (shown: EngineSession, category: NoticeCategory, body: string, extra: NoticeData = {}, { answerable = true, untitled = "New Session" }: { answerable?: boolean; untitled?: string } = {}): Notice => {
    const bot = isBot(shown);
    return {
      title: shown.title || untitled,
      subtitle: bot ? undefined : projectNameOf(shown.location?.directory ?? "", shown),
      body,
      category,
      thread: shown.id,
      data: { session: shown.id, ...extra, ...(answerable ? {} : { answerable: "0" as const }) },
    };
  };
  switch (event.type) {
    case "permission.asked": {
      const where = await shown(data.sessionID!);
      if (isHiddenRun(where)) return null;
      const body = describePermission(data as PermissionAsked, os.homedir());
      return about(where, "permission", body, { request: data.id, ...(where.id !== data.sessionID ? { requestSession: data.sessionID } : {}), ...(offersAlways(data as PermissionAsked) ? {} : { always: "0" as const }), alwaysTitle: masked(alwaysTitle(data, os.homedir())) },
        { answerable: showsAllCovered(data) && showsAll(body), untitled: "Kuvo Code" });
    }
    case "form.created": {
      // The form comes under `form`, with its session.
      const form = data.form ?? data as EngineForm;
      const asker = form.sessionID === "global" ? await waitingOn(form.metadata?.server, event.location?.directory) : form.sessionID;
      if (!asker) return null;
      const where = await shown(asker);
      if (isHiddenRun(where)) return null;
      // On Autopilot nothing waits for you, unless it's still asked once the box has looked (its goal
      // paused, or the engine didn't take the answer).
      if (isAutopilot(where) && !await stillAsked(form, get, event.location?.directory)) return null;
      const body = describeForm(form);
      const choices = (singleQuestion(form)?.options ?? []).map(option => String(option?.label ?? ""));
      return about(where, "question", body, { request: form.id, ...(where.id !== form.sessionID ? { requestSession: form.sessionID } : {}) },
        { answerable: showsAll(body) && choices.every(showsAll), untitled: "Kuvo Code" });
    }
    case "session.execution.succeeded":
    case "session.execution.failed": {
      const id = data.sessionID!;
      const ended = await session(id);
      // A subagent's run is part of its parent's.
      if (ended.parentID || isHiddenRun(ended)) return null;
      const page = await latestTurn(id, get);
      // Only a summary it was asked for: that it failed, whichever way its run ended (the engine's
      // says `succeeded`), and otherwise not news.
      const summary = summaryAtEnd(page.data);
      if (summary === "failed") return about(ended, "failed", "Couldn't summarize the conversation.");
      if (event.type === "session.execution.failed") {
        const reason = reasonLine(data.error?.message);
        return about(ended, "failed", reason ? `Stopped with an error: ${reason}` : "Stopped with an error.");
      }
      if (summary === "completed") return null;
      // A reply is news only when it answers you (NOTIFY_RULE).
      if (!answersYou(turnFor(page.data, page.whole), ended)) return null;
      let reply = "";
      try {
        for (const message of page.data) {
          if (message.type !== "assistant") continue;
          reply = oneSentence((message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n\n"));
          if (reply) break;
        }
      } catch {}
      // What it said first, in a sentence.
      return about(ended, isBot(ended) ? "report" : "finished", reply || "Finished.");
    }
    default:
      return null;
  }
}

// What `hold` keeps of `engine`'s that it asked you (a permission, a question) and isn't asked any
// more: answered while its events couldn't be heard, or let go as its run ended, so it never goes.
// `only`: just what that session asked. One it can't tell about stays as it is.
export async function settleHeld(engine: Target, hold: NoticeHold, only?: string): Promise<void> {
  for (const entry of [...hold.held]) {
    const { request, requestSession, session } = entry.notice?.data ?? {};
    const kind = ({ permission: "permission", question: "form" } as Partial<Record<NoticeCategory, string>>)[entry.notice?.category];
    if (only !== undefined && (requestSession ?? session) !== only) continue;
    // A form an MCP server asks for is filed under no session ("global"), where the engine lists
    // none without its folder: one it can't tell about.
    if (!kind || typeof request !== "string" || typeof (requestSession ?? session) !== "string" || (requestSession ?? session) === "global") continue;
    const asked = (await engineGet(engine, `api/session/${encodeURIComponent(requestSession ?? session!)}/${kind}`).catch(() => null) as UncheckedAnswer)?.data;
    if (Array.isArray(asked) && !(asked as (Fields<"id"> | null)[]).some(each => each?.id === request)) hold.resolve(request);
  }
}

// The events that can be news: a session's (the engine's, or a coding agent's) and a group
// chat's.
export const NEWS = new Set(["permission.asked", "form.created", "session.execution.succeeded", "session.execution.failed"]);
export const GROUP_NEWS = new Set(["kuvo.group.met", "kuvo.group.done"]);
// A permission or a form answered (or cancelled): its notice, if it waits, never goes.
export const ANSWERED = new Set(["permission.replied", "form.replied", "form.cancelled"]);
// A run's end, which takes what it asked with it.
export const RUN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

// A group chat's news, as the Mac tells it: its meeting held (who spoke last, or no one could take
// part), or a bot done with the part it took on.
export function groupNotice(event: GroupEvent): Notice | null {
  const data = event.data ?? {};
  if (typeof data.id !== "string") return null;
  const about: Notice = { title: String(data.name ?? ""), category: "message", thread: data.id, data: { group: data.id } };
  if (event.type === "kuvo.group.met") {
    if (!data.last) return { ...about, body: "The meeting came, but no one could take part." };
    const who = data.who ? (data.last.kind === "wrapUp" ? `${data.who}’s wrap-up` : String(data.who)) : undefined;
    return { ...about, subtitle: who, body: oneSentence(data.last.text) };
  }
  if (event.type === "kuvo.group.done") return { ...about, subtitle: `${data.who} finished its part`, body: oneSentence(data.text) };
  return null;
}