// A message's envelope and its parts (PROTOCOL.md, "A message's parts")
// A client sends what was written and what goes with it as fields (the keyword it was sent with, the
// widget it answers, its comments on the changes, the files it sent by path); the box writes the
// text the agent reads, in these words, and keeps the parts with the message (`metadata.kuvo.parts`)
// for every client to draw it by. Messages from before have none: the box reads them from their
// text (`partsOf`), the old forms too. Both directions read the same cases
// (Vectors/message-parts.json).

import { isObject } from "../../shared/json";
import { agentIs, agentsNamed, ATTACHED_BLOCK, ATTACHED_HEADINGS, FROM_PHONE_BLOCK, messageBlock, NAMED_BLOCK, NAMING_HEADING, REVIEW_BLOCK } from "../peers/naming";
import type { NameableAgent } from "../peers/naming";

/** A comment on one line of the changes: its file, the line's number on its side (a removed line's
 * on the old side), the line as it read, and what was said of it. */
export interface ReviewComment {
  file: string;
  line: number;
  side: "new" | "old";
  snippet: string;
  text: string;
}

/** Where the files a message sent are: with their contents (`included`), as paths for the agent to
 * open, and those that stayed with the client (it couldn't read or send them). */
export interface FilesNote {
  included?: string[];
  paths?: string[];
  unsent?: string[];
}

/** What was written, and what goes with it, as a client sends it. */
export interface MessageFields {
  words: string;
  /** The keyword it was sent with, as typed ("/loop every hour"). */
  keyword?: string;
  /** The title of the widget it answers ("" for one without). */
  widget?: string;
  comments?: ReviewComment[];
  /** Sessions picked from the "&" list as it was written: of two with one name, these. */
  named?: string[];
  notes?: FilesNote;
}

/** A message's parts, as clients draw it: its words, then what went with them. */
export interface MessageParts {
  words: string;
  keyword?: string;
  widget?: string;
  comments?: ReviewComment[];
  /** Files its note names for the agent to open, or that stayed behind (not those it carries). */
  paths?: string[];
  /** Agents it names with "&": as written, and their address. */
  agents?: { name: string; session: string }[];
  /** Sent from a phone. */
  phone?: true;
  /** A message from another agent: its name and address ("unknown" when it can't be answered). */
  mail?: { name: string; session: string };
}

/** Where a message goes and who's around it: the conversation it's written in (left out of who's
 * named), this box's name on its Macs (null on a Mac's own), and everyone "&" can name. */
export interface Naming {
  excluding: string | null;
  here: string | null;
  agents: NameableAgent[];
}

// ——— The words ———

const KEYWORD_HEADING = "The user sent this with a Kuvo Code keyword, which Kuvo Code has already done (switched to Plan, or set the message to repeat), so there's nothing for you to do about it:";
/** /goal in a bot's chat (`askGoal`): the bot plans it before any of the work. */
export const GOAL_HEADING = "The user sent this as a goal, with Kuvo Code's /goal. Plan it, check what it needs, and put it to them with propose_goal before doing any of the work:";
const KEYWORD_BLOCK = messageBlock("<sent-with>", "</sent-with>", [KEYWORD_HEADING, GOAL_HEADING]);
// How a box sent /goal before it went in the block: its marker, the words, then this.
const OLD_GOAL = { marker: "[Goal] ", note: "\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)" };
const WIDGET_HEADING = "The user sent this from a widget shown in this conversation (show_widget), titled:";
const WIDGET_BLOCK = messageBlock("<from-widget>", "</from-widget>", [WIDGET_HEADING]);
const REVIEW_INTRO = "Comments on lines of the current changes:";
/** How a file that stayed on the Mac used to be listed, on its path's line. */
const UNSENT_SUFFIX = " (on the user's Mac: it couldn't be copied to this machine)";
/** The block a phone's message ends with, for the agent: it's never shown. */
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join("\n");
const MAIL_OPENING = "[Message from ";

// One line, naming no agents: an "&" in it would read as one named.
const oneLine = (text: string): string => text.split(/[\n\r\v\f\u0085\u2028\u2029]+/u).filter(Boolean).join(" ").replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "").replace(/&/g, "＆");
// Whitespace and newlines off both ends, as the apps trim what was written.
const trimmed = (text: string): string => text.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
// `text`, then a blank line and `block`; `block` alone after nothing.
const ending = (text: string, block: string[]): string => (text ? `${text}\n\n` : "") + block.join("\n");

/** The text the agent reads for `fields`: what was written (with the widget it answers), the keyword
 * it was sent with, the agents it names with "&" (as `naming` has everyone), the comments on the
 * changes, the note of its files (the client's lines, then `kept`: those this box keeps of the
 * files it carries), and, from a phone, that it's from there. */
export function composeMessage(fields: MessageFields, naming: Naming, kept: FilesNote = {}, phone = false): string {
  let text = fields.widget !== undefined ? [fields.words, "", WIDGET_BLOCK.start, WIDGET_HEADING, oneLine(fields.widget), WIDGET_BLOCK.end].join("\n") : fields.words;
  text = trimmed(text);
  if (fields.keyword !== undefined) text = [text, "", KEYWORD_BLOCK.start, KEYWORD_HEADING, oneLine(fields.keyword), KEYWORD_BLOCK.end].join("\n");
  text = NAMED_BLOCK.escaping(text);
  const named = agentsNamed([text], new Set(naming.excluding ? [naming.excluding] : []), naming.agents, new Set(fields.named ?? []));
  if (named.length) {
    const lines = named.map(agent => `- &${agent.name} (${agent.session}): ${agentIs(agent, naming.here)}${typeof agent.about === "string" && agent.about ? `: ${agent.about}` : ""}`);
    text = ending(text, [NAMED_BLOCK.start, NAMING_HEADING, ...lines, NAMED_BLOCK.end]);
  }
  text = REVIEW_BLOCK.escaping(text);
  if (fields.comments?.length) {
    const lines = [REVIEW_BLOCK.start, REVIEW_INTRO];
    for (const comment of fields.comments) lines.push("", `[${location(comment)}]`, `> ${comment.snippet}`, comment.text);
    text = ending(text, [...lines, REVIEW_BLOCK.end]);
  }
  text = ATTACHED_BLOCK.escaping(text);
  const notes = [...noteLines(fields.notes ?? {}), ...noteLines(kept)];
  if (notes.length) text = ending(text, [ATTACHED_BLOCK.start, ...notes, ATTACHED_BLOCK.end]);
  if (phone && !text.trimEnd().endsWith("</from-phone>")) text = `${text}\n\n${FROM_PHONE}`;
  return text;
}

/** A command's arguments as the engine's command gets them: as written, with only the note of its
 * files after them (the client's lines, then `kept`), as Kuvo Code wrote it before. */
export function composeArguments(words: string, notes: FilesNote = {}, kept: FilesNote = {}): string {
  const text = ATTACHED_BLOCK.escaping(words);
  const lines = [...noteLines(notes), ...noteLines(kept)];
  return lines.length ? ending(text, [ATTACHED_BLOCK.start, ...lines, ATTACHED_BLOCK.end]) : text;
}

const noteLines = (note: FilesNote): string[] => [
  ...(note.included?.length ? [ATTACHED_HEADINGS[0], ...note.included] : []),
  ...(note.paths?.length ? [ATTACHED_HEADINGS[1], ...note.paths] : []),
  ...(note.unsent?.length ? [ATTACHED_HEADINGS[2], ...note.unsent] : []),
];

/** "Sources/App.swift:124", "notes.md:3 (removed)". */
const location = (comment: ReviewComment): string => `${comment.file}:${comment.line}${comment.side === "old" ? " (removed)" : ""}`;

// ——— The parts ———

/** A message's parts, read from its text: a message from another agent, or your words and the
 * blocks at their end, in the order they're added (from the last). One without any is its text. */
export function partsOf(message: string): MessageParts {
  const mail = mailOf(message);
  if (mail) return { words: mail.text, mail: { name: mail.name, session: mail.session } };
  const fromPhone = FROM_PHONE_BLOCK.split(message);
  const withFiles = fromPhone ? fromPhone.before : message;
  const files = filesOf(withFiles);
  const comments = commentsOf(files.text);
  const agents = agentsOf(comments.text);
  const widget = WIDGET_BLOCK.split(agents.text);
  const withKeyword = widget ? widget.before : agents.text;
  const keyword = keywordOf(withKeyword);
  return {
    words: keyword.text,
    ...(keyword.keyword !== undefined ? { keyword: keyword.keyword } : {}),
    ...(widget ? { widget: trimmed(widget.lines.slice(1).join(" ")) } : {}),
    ...(comments.comments.length ? { comments: comments.comments } : {}),
    ...(files.paths.length ? { paths: files.paths } : {}),
    ...(agents.agents.length ? { agents: agents.agents } : {}),
    ...(fromPhone ? { phone: true as const } : {}),
  };
}

// The note of attached files: the paths it names for the agent to open, or that stayed behind.
function filesOf(text: string): { text: string; paths: string[] } {
  const found = ATTACHED_BLOCK.split(text);
  if (!found) return { text, paths: [] };
  let heading = "";
  const paths: string[] = [];
  for (const line of found.lines) {
    if ((ATTACHED_HEADINGS as readonly string[]).includes(line)) heading = line;
    else if (line.startsWith("/") && heading !== ATTACHED_HEADINGS[0]) paths.push(line.endsWith(UNSENT_SUFFIX) ? line.slice(0, -UNSENT_SUFFIX.length) : line);
  }
  return { text: found.before, paths };
}

// The comments on the changes. One starts after a blank line, with its line of the changes under it;
// a line like "[b.swift:10]" in what was said is part of it.
function commentsOf(text: string): { text: string; comments: ReviewComment[] } {
  const found = REVIEW_BLOCK.split(text);
  if (!found) return { text, comments: [] };
  const { lines } = found;
  const comments: ReviewComment[] = [];
  let current: ReviewComment | null = null;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const header = lines[index - 1] === "" && index + 1 < lines.length && lines[index + 1].startsWith("> ") ? commentHeader(line) : null;
    if (header) {
      if (current) comments.push(current);
      current = { ...header, snippet: "", text: "" };
    } else if (current) {
      if (line.startsWith("> ") && !current.snippet && !current.text) current.snippet = line.slice(2);
      else current.text += (current.text ? "\n" : "") + line;
    }
  }
  if (current) comments.push(current);
  return { text: found.before, comments: comments.map(comment => ({ ...comment, text: trimmed(comment.text) })) };
}

// "[path/to/file.swift:124]" or "[notes.md:3 (removed)]".
function commentHeader(line: string): { file: string; line: number; side: "new" | "old" } | null {
  if (!line.startsWith("[") || !line.endsWith("]")) return null;
  let body = line.slice(1, -1);
  let side: "new" | "old" = "new";
  if (body.endsWith(" (removed)")) {
    body = body.slice(0, -" (removed)".length);
    side = "old";
  }
  const colon = body.lastIndexOf(":");
  const number = colon < 0 ? "" : body.slice(colon + 1);
  if (!/^[+-]?[0-9]{1,18}$/.test(number)) return null;
  return { file: body.slice(0, colon), line: Number(number), side };
}

// The agents named with "&": "- &Name (ses_…): what it is", read up to the first " (ses_", as a
// name can hold most else.
function agentsOf(text: string): { text: string; agents: { name: string; session: string }[] } {
  const found = NAMED_BLOCK.split(text);
  if (!found) return { text, agents: [] };
  const agents = found.lines.slice(1).flatMap(line => {
    const open = line.startsWith("- &") ? line.indexOf(" (ses_") : -1;
    if (open < 0) return [];
    const close = line.indexOf(")", open + 2);
    const name = line.slice(3, open);
    return close < 0 || !name ? [] : [{ name, session: line.slice(open + 2, close) }];
  });
  return { text: found.before, agents };
}

// The keyword it was sent with, as typed: in the block, or as a box sent /goal before.
function keywordOf(text: string): { text: string; keyword?: string } {
  if (text.startsWith(OLD_GOAL.marker) && text.endsWith(OLD_GOAL.note) && text.length >= OLD_GOAL.marker.length + OLD_GOAL.note.length) {
    return { text: trimmed(text.slice(OLD_GOAL.marker.length, text.length - OLD_GOAL.note.length)), keyword: "/goal" };
  }
  const found = KEYWORD_BLOCK.split(text);
  const typed = found?.lines[1];
  if (!found || typed === undefined || !typed.startsWith("/")) return { text };
  return { text: found.before, keyword: typed };
}

// A message from another agent: its first line is "[Message from <name> · <session>] (…)", read
// from the end, as a name can hold anything; what it says follows a blank line.
function mailOf(message: string): { name: string; session: string; text: string } | null {
  if (!message.startsWith(MAIL_OPENING)) return null;
  const end = message.indexOf("\n");
  const first = end < 0 ? message : message.slice(0, end);
  const dot = first.lastIndexOf(" · ");
  if (dot < 0) return null;
  const after = first.slice(dot + 3);
  const close = after.indexOf("]");
  if (close < 0) return null;
  const session = after.slice(0, close);
  if (!(session.startsWith("ses_") || session === "unknown") || session.includes(" ")) return null;
  // No name ("[Message from · ses_1]"): the " · " is the opening's own space.
  if (dot < MAIL_OPENING.length) return null;
  const rest = end < 0 ? "" : message.slice(end);
  const blank = rest.indexOf("\n\n");
  return { name: first.slice(MAIL_OPENING.length, dot), session, text: blank >= 0 ? rest.slice(blank + 2) : rest.replace(/^\n+/, "") };
}

// ——— Kept with the message ———

/** `metadata` (a message's, as given) with the parts of `text` kept in it (`kuvo.parts`). */
export function withParts(metadata: unknown, parts: MessageParts): Record<string, unknown> {
  const given = isObject(metadata) ? metadata : {};
  const kuvo = isObject(given.kuvo) ? given.kuvo : {};
  return { ...given, kuvo: { ...kuvo, parts } };
}

/** `metadata` with the parts of `text` kept in it where there's more to them than the text (a
 * message from another agent, one with blocks), as a box keeps them with a message a client wrote
 * itself the way before; else as it was (a client asks about a plain one once). */
export function withPartsOf<M extends Record<string, unknown> | undefined>(metadata: M, text: string): M | Record<string, unknown> {
  const parts = partsOf(text);
  return parts.mail !== undefined || parts.words !== text ? withParts(metadata, parts) : metadata;
}

/** The parts kept in `metadata` (a message's), or null for none. */
export function keptParts(metadata: unknown): MessageParts | null {
  const parts = isObject(metadata) && isObject(metadata.kuvo) ? metadata.kuvo.parts : null;
  return isObject(parts) && typeof parts.words === "string" ? (parts as unknown as MessageParts) : null;
}

/** The fields a client sent, read: null when what was written isn't there. Anything else that
 * isn't as described is left out. */
export function fieldsOf(given: Record<string, unknown>): MessageFields | null {
  if (typeof given.words !== "string") return null;
  const strings = (value: unknown, most = 200): string[] | undefined => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string").slice(0, most) : undefined);
  const comments = Array.isArray(given.comments)
    ? given.comments.flatMap(each => (isObject(each) && typeof each.file === "string" && Number.isSafeInteger(each.line) && typeof each.snippet === "string" && typeof each.text === "string"
      ? [{ file: each.file, line: each.line as number, side: each.side === "old" ? "old" as const : "new" as const, snippet: each.snippet, text: each.text }]
      : [])).slice(0, 500)
    : undefined;
  const notes = isObject(given.notes) ? given.notes : null;
  return {
    words: given.words,
    ...(typeof given.keyword === "string" ? { keyword: given.keyword } : {}),
    ...(typeof given.widget === "string" ? { widget: given.widget } : {}),
    ...(comments?.length ? { comments } : {}),
    ...(strings(given.named) ? { named: strings(given.named) } : {}),
    ...(notes ? { notes: { included: strings(notes.included, 1000), paths: strings(notes.paths, 1000), unsent: strings(notes.unsent, 1000) } } : {}),
  };
}
