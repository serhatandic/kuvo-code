// What's news for your phones in an engine's or a group chat's events, said as the Mac's
// notifications say it.

import os from "node:os";
import path from "node:path";
import { cut, outsideShown } from "../../shared/text";
import { readProjects } from "../areas/projects";
import { readRemovedWorktrees, readWorktrees } from "../areas/worktree-records";
import { engineGet } from "../engine/client";
import { isHiddenRun } from "../engine/sessions";
import { recommendationOf } from "../work/answers";
import { isAutopilot } from "../work/autopilot";
import { IS_MAC, K } from "../home";
import { masked, showsAll } from "./mask";
import type { Fields } from "../../shared/json";
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
  metadata?: { kind?: string; message?: string; server?: string };
  fields?: FormField[];
}

/** What an engine event carries, as this reads it: a permission asked, a form (under `form`, or
 * as it is), or the session whose run ended. */
export type EngineEventData = Partial<PermissionAsked> & { form?: EngineForm };

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

/** A message in a session, as far as this reads it: its blocks of text and tools. */
interface EngineMessage {
  type: string;
  content?: { type: string; text?: string; name?: string; state?: { status?: string; input?: { code?: unknown } } }[];
}

/** Asks the engine `route`: its JSON, whatever came. */
export type EngineAsk = (route: string) => Promise<unknown>;

// Markdown's marks taken off, not the words (as ReplyPreview does on the Mac): headings and
// quotes at a line's start, emphasis around words, code ticks, a link's address.
const plain = (text: unknown): string => String(text ?? "")
  .replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]+/gm, "")
  .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
  .replace(/(?<![\w*_])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\w*_])/g, "")
  .replace(/`/g, "")
  .replace(/\s+/g, " ").trim();

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
  switch (request.action) {
    case "edit": case "patch": case "write": return "Always Allow Edits";
    case "shell": case "bash":
      if (!patterns.length || patterns.length === 1 && patterns[0] === "*") return "Always Allow Commands";
      return patterns.length === 1 ? `Always Allow ${short(kind(patterns[0]))}` : "Always Allow These Commands";
    case "external_directory": {
      if (patterns.length !== 1) return "Always Allow These Folders";
      const shown = outsideShown(patterns[0], home);
      return `Always Allow ${short(characters(shown).length > ALWAYS_LONGEST ? `…/${path.basename(shown)}` : shown)}`;
    }
    default:
      return patterns.length === 1 && patterns[0] !== "*" ? `Always Allow ${short(kind(patterns[0]))}` : "Always Allow";
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
  if (kind === "mcp-elicitation") return form.metadata?.message || "Needs your answer.";
  if (kind !== "question") return "Needs your answer.";
  const fields = (form.fields ?? []).filter(field => !field.hidden && !field.when?.length);
  if (fields.length === 1 && fields[0].type === "string") return fields[0].description || fields[0].title || form.title || "Has a question for you.";
  return "Has a question for you.";
}

const isBot = (session: EngineSession): boolean => Boolean(session.metadata?.kuvo?.bot) || /\/bots\/bot_[^/]+\//.test(`${session.location?.directory ?? ""}/`);


// This box's chats, conversations of no project: a machine's in its folder, a Mac's beside its box.
const chatsFolder = (): string => (IS_MAC ? path.join(path.dirname(K), "Chats") : path.join(K, "chats"));

// A project's name, as the Mac shows it: its own, or its folder's; a worktree's is its project's.
export function projectNameOf(directory: string | undefined): string | undefined {
  if (!directory) return undefined;
  if (directory === chatsFolder()) return "Chats";
  const project = readWorktrees().find(each => (each.folder ?? each.root) === directory || each.root === directory)?.project
    ?? readRemovedWorktrees()[directory] ?? directory;
  return readProjects().find(each => each.directory === project)?.name || path.basename(project) || undefined;
}

// The notification for an engine event, or null for one that isn't news. `get(route)` asks the
// engine.
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
  const waitingOn = async (server: string | undefined, folder: string | undefined): Promise<string | null> => {
    if (!server) return null;
    const active = (await get("api/session/active").catch(() => null) as EngineAnswer<string[] | Record<string, unknown>> | null)?.data ?? {};
    const name = String(server).replace(/[^\p{L}\p{N}_-]/gu, "_");
    for (const id of Array.isArray(active) ? active : Object.keys(active)) {
      const candidate = await session(id).catch(() => null);
      if (!candidate || (folder && candidate.location?.directory !== folder)) continue;
      const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=8&order=desc`).catch(() => null) as EngineAnswer<EngineMessage[]> | null;
      const steps = (page?.data ?? []).filter(message => message.type === "assistant").flatMap(message => message.content ?? []);
      if (steps.some(block => block.type === "tool" && block.state?.status === "running"
        && (block.name?.startsWith(name + "_") || (block.name === "execute" && String(block.state.input?.code ?? "").includes(server))))) return id;
    }
    return null;
  };
  // `answerable` false: its buttons would answer what it can't show, so it has none, and you
  // answer in the conversation. `untitled`: what one without a title is called.
  const about = (shown: EngineSession, category: NoticeCategory, body: string, extra: NoticeData = {}, { answerable = true, untitled = "New Session" }: { answerable?: boolean; untitled?: string } = {}): Notice => {
    const bot = isBot(shown);
    return {
      title: shown.title || untitled,
      subtitle: bot ? undefined : projectNameOf(shown.location?.directory ?? ""),
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
      // On Autopilot, one that recommends a choice goes ahead on it: nothing waits for you.
      if (isAutopilot(where) && recommendationOf(form as unknown as Record<string, unknown>)) return null;
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
      if (event.type === "session.execution.failed") return about(ended, "failed", "Stopped with an error.");
      let reply = "";
      try {
        const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=6&order=desc`) as EngineAnswer<EngineMessage[]>;
        for (const message of page.data ?? []) {
          if (message.type !== "assistant") continue;
          reply = plain((message.content ?? []).filter(part => part.type === "text").map(part => part.text).join(" "));
          if (reply) break;
        }
      } catch {}
      // What it said last, as long as the Mac shows it.
      return about(ended, isBot(ended) ? "report" : "finished", reply ? cut(reply, 220) : "Finished.");
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
    return { ...about, subtitle: who, body: cut(plain(data.last.text), 220) };
  }
  if (event.type === "kuvo.group.done") return { ...about, subtitle: `${data.who} finished its part`, body: cut(plain(data.text), 220) };
  return null;
}