// What was said in this box's conversations, searched (`kuvo/search`), for a client's sidebar
// search: every session's (archived ones too, the coding agents' too, not subagents'), the latest
// first, each with the words around its first mention. Only what was said and worked on is
// searched: no names of who's speaking, none of the app's words for a step.
//
// Each conversation's text is kept in the box's `search` folder until its session changes, so a
// search reads only what's new since: from the link that runs, and from a `box route` of its own
// (how a Mac reaches a machine), alike.

import fs from "node:fs";
import path from "node:path";
import { conversationOf, rootSessions } from "../engine/conversations";
import type { EngineMessage } from "../engine/conversations";
import { isHiddenRun } from "../engine/sessions";
import type { EngineSession } from "../engine/sessions";
import { SEARCH } from "../home";
import type { Target } from "../../shared/records";
import type { SearchFound } from "../../shared/routes/misc";
import type { AnswerPiece, RouteContext } from "../server/context";

/** How many it finds at most, unless asked for fewer. */
const MOST = 50;
/** How much of a conversation is kept to search: what a command printed is kept to its start. */
const MOST_TEXT = 400_000;
const MOST_OUTPUT = 2_000;

/** A conversation's text as kept: as said, and as compared (no case, no accents), letter for letter. */
interface Kept {
  updated: number;
  text: string;
  folded: string;
}

/** Each conversation's text, read here since the box started, by `key`; and those being read. */
const texts = new Map<string, Kept>();
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
  // Where a list can't be read now (an engine restarting), what was kept from it stays.
  const read = new Set<string>();
  const listed = (await Promise.all(places.map(place => rootSessions(place.target).then(sessions => {
    read.add(place.name);
    return sessions.map(session => ({ session, place }));
  }, () => []))))
    .flat()
    // Not one a group chat or the coding agents run for a seat or a turn: they show where they run.
    .filter(({ session }) => !isHiddenRun(session))
    .sort((one, other) => other.session.time.updated - one.session.time.updated);
  const wanted = fold(words);
  const results: SearchFound["results"][number][] = [];
  // The latest first, a few at a time, reading only what changed since; done once there are enough.
  for (let start = 0; start < listed.length && results.length < limit; start += 4) {
    const kept = await Promise.all(listed.slice(start, start + 4).map(({ session, place }) => textOf(place.name, place.target, session)));
    for (const [index, text] of kept.entries()) {
      const at = text ? text.folded.indexOf(wanted) : -1;
      if (!text || at < 0 || results.length >= limit) continue;
      const { session } = listed[start + index]!;
      results.push({ session: session.id, snippet: snippet(text.text, at, wanted.length), info: session });
    }
  }
  forgetGone(read, new Set(listed.map(({ session, place }) => key(place.name, session.id))));
  return yield* json(200, { results } satisfies SearchFound);
}

/** A conversation's text's key: where it's read (the engine, the coding agents' bridge), and its session. */
const key = (place: string, id: string) => `${place}.${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** A session's conversation's text: as kept, while its session hasn't changed; else read again,
 * once however many searches ask meanwhile. Null when it can't be read. */
function textOf(place: string, target: Target, session: EngineSession): Promise<Kept | null> {
  const name = key(place, session.id);
  const updated = session.time.updated;
  const known = texts.get(name) ?? fromDisk(name);
  if (known?.updated === updated) return Promise.resolve(known);
  const already = reading.get(name);
  if (already) return already;
  const read = conversationOf(target, session.id).then(messages => {
    // Without what an undo took back.
    const cut = session.revert?.messageID ? messages.findIndex(message => message.id === session.revert!.messageID) : -1;
    const text = searchText(cut >= 0 ? messages.slice(0, cut) : messages, session.location?.directory ?? session.directory ?? "").slice(0, MOST_TEXT);
    const kept = { updated, text, folded: fold(text) };
    texts.set(name, kept);
    toDisk(name, kept);
    return kept;
  }, () => null).finally(() => reading.delete(name));
  reading.set(name, read);
  return read;
}

function fromDisk(name: string): Kept | null {
  try {
    const kept = JSON.parse(fs.readFileSync(path.join(SEARCH, name + ".json"), "utf8")) as Kept;
    if (typeof kept.updated !== "number" || typeof kept.text !== "string" || typeof kept.folded !== "string") return null;
    texts.set(name, kept);
    return kept;
  } catch {
    return null;
  }
}

function toDisk(name: string, kept: Kept) {
  try {
    fs.mkdirSync(SEARCH, { recursive: true });
    fs.writeFileSync(path.join(SEARCH, name + ".json"), JSON.stringify(kept));
  } catch {}
}

/** Sessions gone since (deleted, moved away) from the places whose lists were `read` aren't kept,
 * here or in the folder. */
function forgetGone(read: Set<string>, known: Set<string>) {
  const gone = (name: string) => read.has(name.slice(0, name.indexOf("."))) && !known.has(name);
  for (const name of texts.keys()) if (gone(name)) texts.delete(name);
  try {
    for (const file of fs.readdirSync(SEARCH)) {
      if (file.endsWith(".json") && gone(file.slice(0, -5))) fs.rmSync(path.join(SEARCH, file), { force: true });
    }
  } catch {}
}

/** What was said and worked on in `messages`, as the Mac's export has it without its labels: what
 * you wrote (your review comments, and the files' names, not the rest Kuvo Code adds to its end),
 * what other agents and wake-ups said, the agent's replies, what each step worked on (its files
 * in the session's folder, its command, what it looked for), and the commands you ran with the
 * start of what they printed. */
export function searchText(messages: EngineMessage[], directory: string): string {
  const relative = (value: string) => directory && value.startsWith(directory + "/") ? value.slice(directory.length + 1) : value;
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.type === "user") {
      const written = String(message.text ?? "");
      const mail = /^\[Message from (.*) · (ses_\S+|unknown)\] \([^\n]*\)\n\n([\s\S]*)$/.exec(written);
      const work = /^\[Work from (.*) · [^\]\n]+\]\n\n([\s\S]*?)(\n\n---\n[\s\S]*)?$/.exec(written);
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
          if (named.length) blocks.push(named.map(value => value.split("\n")[0]).join(" "));
        }
      }
    } else if (message.type === "shell") {
      const output = String((message.output as Record<string, unknown> | undefined)?.output ?? "").trim().slice(0, MOST_OUTPUT);
      blocks.push([String(message.command ?? ""), output].filter(Boolean).join("\n\n"));
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

/** A message as you wrote it: what Kuvo Code adds to its end comes off (who's named, a keyword it
 * was sent with, the widget it answers, that it's from your phone), but for your review comments, and the names of the
 * files it brought. */
function ownWords(written: string): string {
  let words = written.trim();
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
 * place in it is the same place in what it came from, counted in letters). */
function fold(text: string): string {
  return Array.from(text, letter => letter.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().slice(0, 1) || "\u0000").join("");
}

/** A line's worth of `text` from just before the match at `at` (in letters, `length` long),
 * without Markdown's marks, as the Mac's sidebar showed it. */
function snippet(text: string, at: number, length: number): string {
  const letters = Array.from(text);
  const start = Math.max(0, at - 16);
  const end = Math.min(letters.length, at + length + 80);
  const words = letters.slice(start, end).join("").replace(/[*`#>]/g, "").split(/\s+/).filter(Boolean).join(" ");
  return (start > 0 ? "…" : "") + words + (end < letters.length ? "…" : "");
}
