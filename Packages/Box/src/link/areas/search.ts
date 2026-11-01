// What was said in this box's conversations, searched (`kuvo/search`), for a client's sidebar
// search: every session's (archived ones too, the coding agents' too), the latest first, each with
// the words around its first mention. A subagent's words find the conversation it works for, which
// shows what it found. Only what was said and worked on is
// searched: no names of who's speaking, none of the app's words for a step.
//
// Each conversation's text is kept in the box's `search` folder until its session changes, so a
// search reads only what's new since: from the link that runs, and from a `box route` of its own
// (how a Mac reaches a machine), alike.

import fs from "node:fs";
import path from "node:path";
import { conversationOf, everySession } from "../engine/conversations";
import type { EngineMessage } from "../engine/conversations";
import { isHiddenRun } from "../engine/sessions";
import type { EngineSession } from "../engine/sessions";
import { SEARCH } from "../home";
import { isBoxWritten } from "../../shared/queues";
import type { Target } from "../../shared/records";
import type { SearchFound } from "../../shared/routes/misc";
import type { AnswerPiece, RouteContext } from "../server/context";

/** How many it finds at most, unless asked for fewer. */
const MOST = 50;
/** How much of a conversation is kept to search: what a command printed is kept to its start. */
const MOST_TEXT = 400_000;
const MOST_OUTPUT = 2_000;

/** A conversation's text as kept in the folder: as said, and as compared (no case, no accents),
 * letter for letter. */
/** How a conversation's text is put together: one kept in an older way is read again. */
const TEXT_VERSION = 2;

interface Kept {
  version?: number;
  updated: number;
  text: string;
  folded: string;
}

/** What's kept in memory of each, by `key`: only what's compared (what was said is read from its
 * file for the few found). And those being read. */
const texts = new Map<string, Pick<Kept, "updated" | "folded">>();
const reading = new Map<string, Promise<Kept | null>>();

export async function* searchRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const query = new URLSearchParams(request.path.split("?")[1] ?? "");
  const words = (query.get("q") ?? "").trim();
  if (!words) return yield* json(400, { message: "Say what to search for (q)." });
  const limit = Math.min(MOST, Math.max(1, Number(query.get("limit")) || 20));
  // Where its sessions are: the engine, and the coding agents' bridge while it runs.
  let places: { name: string; target: Target }[];
  try {
    places = [{ name: "engine", target: readEngine() }];
  } catch {
    return yield* json(503, { message: "This computer's engine isn't running yet. Search again in a moment." });
  }
  const agents = (() => { try { return bridge(); } catch { return null; } })();
  if (agents) places.push({ name: "agents", target: agents });
  const lists = await Promise.all(places.map(place => everySession(place.target).then(sessions => ({ place, sessions }), () => ({ place, sessions: null }))));
  // Its engine's list it must have: without it, nothing found would say what isn't so. (The coding
  // agents' bridge may be starting: its sessions are left out until it answers.)
  if (!lists[0]!.sessions) return yield* json(503, { message: "This computer's engine didn't answer. Search again in a moment." });
  const conversations = lists.flatMap(({ place, sessions }) => byConversation(sessions ?? []).map(conversation => ({ ...conversation, place })))
    .sort((one, other) => other.top.time.updated - one.top.time.updated);
  const wanted = fold(words);
  const results: SearchFound["results"][number][] = [];
  // In a conversation, its own words first, then its subagents', the latest first, a few at a
  // time, until one has them: the first that does is what it's found by.
  const findIn = async ({ top, subagents, place }: (typeof conversations)[number]) => {
    const sessions = [top, ...subagents];
    for (let start = 0; start < sessions.length; start += start === 0 ? 1 : 4) {
      const some = sessions.slice(start, start === 0 ? 1 : start + 4);
      const kept = await Promise.all(some.map(session => textOf(place.name, place.target, session)));
      const which = kept.findIndex(found => found !== null && found.folded.includes(wanted));
      if (which < 0) continue;
      const found = kept[which]!;
      const session = some[which]!;
      const text = "text" in found ? found.text : fromDisk(key(place.name, session.id))?.text;
      if (text === undefined) continue;
      return { session: top.id, snippet: snippet(text, found.folded.indexOf(wanted), wanted.length), info: top, ...(session === top ? {} : { subagent: session }) };
    }
    return null;
  };
  // The latest first, a few at a time, reading only what changed since; done once there are enough.
  for (let start = 0; start < conversations.length && results.length < limit; start += 4) {
    for (const found of await Promise.all(conversations.slice(start, start + 4).map(findIn))) {
      if (found && results.length < limit) results.push(found);
    }
  }
  // Only where the list was read: one that couldn't be keeps what it had.
  const known = conversations.flatMap(({ top, subagents, place }) => [top, ...subagents].map(session => key(place.name, session.id)));
  forgetGone(new Set(known), lists.filter(list => list.sessions).map(list => list.place.name));
  return yield* json(200, { results } satisfies SearchFound);
}

/** Each conversation of `sessions`: the session at the top, and the subagents working for it, or
 * for them, the latest first. Not one a group chat or the coding agents run for a seat or a turn,
 * nor theirs: they show where they run. A subagent whose conversation is gone has none. */
function byConversation(sessions: EngineSession[]): { top: EngineSession; subagents: EngineSession[] }[] {
  const byID = new Map(sessions.map(session => [session.id, session]));
  const topOf = (session: EngineSession): EngineSession | null => {
    let at = session;
    for (let depth = 0; at.parentID && depth < 100; depth++) {
      const above = byID.get(at.parentID);
      if (!above || isHiddenRun(above)) return null;
      at = above;
    }
    return at.parentID ? null : at;
  };
  const conversations = new Map<string, { top: EngineSession; subagents: EngineSession[] }>();
  for (const session of sessions) if (!session.parentID && !isHiddenRun(session)) conversations.set(session.id, { top: session, subagents: [] });
  for (const session of sessions) {
    if (!session.parentID || isHiddenRun(session)) continue;
    const top = topOf(session);
    if (top) conversations.get(top.id)?.subagents.push(session);
  }
  for (const conversation of conversations.values()) conversation.subagents.sort((one, other) => other.time.updated - one.time.updated);
  return [...conversations.values()];
}

/** A conversation's text's key: where it's read (the engine, the coding agents' bridge), and its session. */
const key = (place: string, id: string) => `${place}.${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** A session's conversation's text: as kept, while its session hasn't changed; else read again,
 * once however many searches ask meanwhile. Null when it can't be read. */
function textOf(place: string, target: Target, session: EngineSession): Promise<Pick<Kept, "updated" | "folded"> | Kept | null> {
  const name = key(place, session.id);
  const updated = session.time.updated;
  const known = texts.get(name) ?? fromDisk(name);
  if (known?.updated === updated) return Promise.resolve(known);
  const already = reading.get(name);
  if (already) return already;
  const read = conversationOf(target, session.id).then(messages => {
    // Without what an undo took back.
    const cut = session.revert?.messageID ? messages.findIndex(message => message.id === session.revert!.messageID) : -1;
    // Its latest part, when it's long: what was said last is what's looked for most.
    const text = searchText(cut >= 0 ? messages.slice(0, cut) : messages, session.location?.directory ?? session.directory ?? "");
    const kept = { version: TEXT_VERSION, updated, text, folded: fold(text) };
    texts.set(name, { updated, folded: kept.folded });
    toDisk(name, kept);
    return kept;
  }, () => null).finally(() => reading.delete(name));
  reading.set(name, read);
  return read;
}

function fromDisk(name: string): Kept | null {
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(SEARCH, name + ".json"), "utf8")) as Kept;
    if (kept.version !== TEXT_VERSION || typeof kept.updated !== "number" || typeof kept.text !== "string" || typeof kept.folded !== "string") return null;
    texts.set(name, { updated: kept.updated, folded: kept.folded });
    return kept;
  } catch {
    return null;
  }
}

/** Written whole or not at all: another search (a `box route` of its own) may read it meanwhile. */
function toDisk(name: string, kept: Kept) {
  const file = path.join(SEARCH, name + ".json");
  const writing = `${file}.${process.pid}.writing`;
  try {
    fs.mkdirSync(SEARCH, { recursive: true });
    fs.writeFileSync(writing, JSON.stringify(kept));
    fs.renameSync(writing, file);
  } catch {
    fs.rmSync(writing, { force: true });
  }
}

/** Sessions gone since (deleted, moved away) aren't kept, here or in the folder: of the places
 * (`engine`, `agents`) whose lists were read. A file left half written by a search that ended
 * goes too. */
function forgetGone(known: Set<string>, places: string[]) {
  const listed = (name: string) => places.some(place => name.startsWith(place + "."));
  for (const name of texts.keys()) if (listed(name) && !known.has(name)) texts.delete(name);
  try {
    for (const file of fs.readdirSync(SEARCH)) {
      const name = file.slice(0, -5);
      const gone = file.endsWith(".json") ? listed(name) && !known.has(name) : file.endsWith(".writing") && Date.now() - fs.statSync(path.join(SEARCH, file)).mtimeMs > 60_000;
      if (gone) fs.rmSync(path.join(SEARCH, file), { force: true });
    }
  } catch {}
}

/** What was said and worked on in `messages`, as the Mac's export has it without its labels: what
 * you wrote (your review comments, and the files' names, not the rest Kuvo Code adds to its end),
 * what other agents and wake-ups said, the agent's replies, what each step worked on (its files
 * in the session's folder, its command, what it looked for), and the commands you ran with the
 * start of what they printed. What the steps worked on comes last, so words said in the
 * conversation are found, and shown, there first. */
export function searchText(messages: EngineMessage[], directory: string): string {
  const relative = (value: string) => directory && value.startsWith(directory + "/") ? value.slice(directory.length + 1) : value;
  const blocks: string[] = [];
  const steps: string[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      const written = String(message.text ?? "");
      const mail = /^\[Message from (.*) · (ses_\S+|unknown)\] \([^\n]*\)\n\n([\s\S]*)$/.exec(written);
      const work = /^\[Work from (.*) · [^\]\n]+\]\n\n([\s\S]*?)(\n\n---\n[\s\S]*)?$/.exec(written);
      // What the box told the agent: never what was said.
      if (isBoxWritten(written, message.metadata)) continue;
      if (mail) blocks.push(mail[3]!);
      else if (written.startsWith("[Wake-up] ")) blocks.push(written.slice("[Wake-up] ".length));
      else if (work) blocks.push(work[2]!.trim());
      else {
        const files = (Array.isArray(message.files) ? message.files as { name?: unknown }[] : []).map(file => file.name).filter((name): name is string => typeof name === "string" && !!name);
        blocks.push([ownWords(written), files.join(", ")].filter(Boolean).join("\n\n"));
      }
    } else if (message.type === "assistant") {
      for (const part of (Array.isArray(message.content) ? message.content as Record<string, unknown>[] : [])) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) blocks.push(part.text.trim());
        else if (part.type === "tool") {
          const input = ((part.state as Record<string, unknown> | undefined)?.input ?? {}) as Record<string, unknown>;
          const named = [input.filePath, input.path].filter((value): value is string => typeof value === "string").map(relative)
            .concat([input.command, input.pattern, input.query, input.url, input.description].filter((value): value is string => typeof value === "string"));
          if (named.length) steps.push(named.map(value => value.split("\n")[0]).join(" "));
        }
      }
    } else if (message.type === "shell") {
      const output = String((message.output as Record<string, unknown> | undefined)?.output ?? "").trim().slice(0, MOST_OUTPUT);
      blocks.push([String(message.command ?? ""), output].filter(Boolean).join("\n\n"));
    }
  }
  // Its latest part, when it's long: what was said last is what's looked for most, and what was
  // said comes before the steps, which fill only the room it leaves.
  const said = blocks.filter(Boolean).join("\n\n").slice(-MOST_TEXT);
  const room = MOST_TEXT - said.length - 2;
  const done = room > 0 ? steps.filter(Boolean).join("\n\n").slice(-room) : "";
  return [said, done].filter(Boolean).join("\n\n");
}

/** A message as you wrote it: what Kuvo Code adds to its end comes off (who's named, a keyword it
 * was sent with, the widget it answers, that it's from your phone), but for your review comments, and the names of the
 * files it brought. */
function ownWords(written: string): string {
  let words = written.trim();
  // /goal in a bot's chat as a box sent it before it went in the block: its marker, then the note.
  const oldGoal = "\n\n(The user asked for this as a goal: plan it, check what it needs, and put it to them with propose_goal before doing any of the work.)";
  if (words.startsWith("[Goal] ") && words.endsWith(oldGoal)) return words.slice("[Goal] ".length, -oldGoal.length).trim();
  const kept: string[] = [];
  for (;;) {
    const block = [["<attached-files>", "</attached-files>"], ["<review-comments>", "</review-comments>"], ["<named-agents>", "</named-agents>"], ["<sent-with>", "</sent-with>"], ["<from-widget>", "</from-widget>"], ["<from-phone>", "</from-phone>"]]
      .find(([, end]) => words.endsWith("\n" + end));
    const open = block ? words.lastIndexOf(block[0] + "\n") : -1;
    if (!block || open < 0 || (open > 0 && words[open - 1] !== "\n")) break;
    const inside = words.slice(open + block[0]!.length + 1, words.length - block[1]!.length - 1).trim();
    if (block[0] === "<review-comments>") kept.unshift(inside);
    if (block[0] === "<attached-files>") kept.unshift(inside.split("\n").map(line => path.basename(line.trim())).filter(Boolean).join(", "));
    words = words.slice(0, open).trim();
  }
  return [words, ...kept].filter(Boolean).join("\n\n");
}

/** Text as it's compared: no case, no accents, letter for letter (one unit for each letter, so a
 * place in it is the same place in what it came from, counted in letters). A letter beyond one
 * unit (an emoji) stands for itself in one of the units kept for private use. */
function fold(text: string): string {
  return Array.from(text, letter => {
    const plain = Array.from(letter.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC"));
    const point = (plain.length === 1 ? plain[0]! : letter).codePointAt(0) ?? 0;
    return point <= 0xFFFF ? String.fromCharCode(point) : String.fromCharCode(0xE000 + (point % 0x1900));
  }).join("");
}

/** A line's worth of `text` from just before the match at `at` (in letters, `length` long),
 * without Markdown's marks, as the Mac's sidebar showed it: whole words, never cut in one. */
export function snippet(text: string, at: number, length: number): string {
  const all = Array.from(text);
  // Only the block it's in (a message, or a step), not the one beside it.
  const gap = (index: number) => all[index] === "\n" && all[index + 1] === "\n";
  let blockStart = at;
  while (blockStart > 0 && !gap(blockStart - 2)) blockStart--;
  let blockEnd = at + length;
  while (blockEnd < all.length && !gap(blockEnd)) blockEnd++;
  const letters = all.slice(0, blockEnd);
  const space = (index: number) => /\s/.test(letters[index] ?? " ");
  let start = Math.max(blockStart, at - 16);
  // Back to the start of the word it's in, or on to the next one where that's far.
  for (let back = start; back >= blockStart && back > start - 12; back--) if (space(back - 1)) { start = back; break; }
  while (start > blockStart && start < at && !space(start - 1)) start++;
  let end = Math.min(letters.length, at + length + 80);
  // Back to the end of the last whole word.
  while (end < letters.length && end > at + length && !space(end)) end--;
  const words = letters.slice(start, end).join("").replace(/[*`#>]/g, "").split(/\s+/).filter(Boolean).join(" ");
  return (start > blockStart ? "…" : "") + words + (end < letters.length ? "…" : "");
}
