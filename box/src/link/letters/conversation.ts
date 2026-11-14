// A conversation as another agent reads it (read_conversation)
// What the user and others wrote, its replies and a line for each step, as Kuvo Code's export words
// it; a long one as its start and its latest part, or with a query, the parts that mention it.

import { keptParts, partsOf } from "../messages/parts";
import { boxNoteOf } from "../../shared/queues";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";

/** About how much of a conversation goes back at once, in characters. */
export const READ_LIMIT = 24_000;
/** As much as goes back from another computer, where it comes by mail. */
export const READ_BY_MAIL = 20_000;

/** A message as the engine (or the agents' bridge) answers it, as far as it's read here. */
interface ReadMessage {
  id: string;
  type: string;
  status?: string;
  /** A summary's: one you asked for (`manual`), or one the agent made by itself (`auto`). */
  reason?: string;
  text?: string;
  files?: { name?: string }[];
  content?: { type: string; text?: string; name?: string; state?: { input?: Record<string, unknown> } }[];
  command?: string;
  output?: { output?: string };
  /** `boxNote`'s mark, on one the box wrote. */
  metadata?: unknown;
  /** A turn's end: how it went, and the error it failed with. */
  outcome?: string;
  error?: { message?: string };
}

/** A page of a session's messages, and where the next (older) one starts. */
interface MessagePage {
  data?: ReadMessage[];
  cursor?: { next?: string; previous?: string };
}

/** A conversation as Markdown, as Kuvo Code's export words it: a step as its tool and what it
 * worked on. */
export function conversationMarkdown(title: string, messages: ReadMessage[], agent: string): string {
  const blocks = ["# " + title];
  let speaker: string | null = null;
  let steps: string[] = [];
  const say = (who: string, words: string): void => {
    if (steps.length) {
      const list = steps.map(step => "- " + step).join("\n");
      steps = [];
      say(agent, list);
    }
    if (speaker !== who) blocks.push(`**${who}**`);
    speaker = who;
    blocks.push(words);
  };
  for (const [at, message] of messages.entries()) {
    if (message.type === "user") {
      const written = String(message.text ?? "");
      // Its parts, as the box keeps them, or reads one from before (messages/parts.ts).
      const parts = keptParts(message.metadata) ?? partsOf(written);
      const work = /^\[Work from (.*) · [^\]\n]+\]\n\n([\s\S]*?)(\n\n---\n[\s\S]*)?$/.exec(written);
      // What the box told the agent (a goal's word, its sessions' news): never the user's, and
      // whole, as the agent read it (the export shows its line).
      const note = boxNoteOf(written, message.metadata);
      if (note) say(note.from, written.trim());
      else if (parts.mail) say(`Message from ${parts.mail.name}`, parts.words);
      else if (written.startsWith("[Wake-up] ")) say("Wake-up", written.slice("[Wake-up] ".length));
      else if (work) say(`Work from ${work[1]}`, work[2].trim());
      else {
        const words = parts.keyword ? `${parts.keyword} ${parts.words}` : parts.words.trim();
        const files = (message.files ?? []).map(file => file.name).filter(Boolean);
        if (words || files.length) say("User", [words, files.length ? "Attached: " + files.join(", ") : ""].filter(Boolean).join("\n\n"));
      }
    } else if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type === "text" && part.text?.trim()) say(agent, part.text.trim());
        else if (part.type === "tool") {
          const input = part.state?.input ?? {};
          const what = input.description ?? input.filePath ?? input.path ?? input.command ?? input.url ?? input.pattern ?? input.query ?? input.to ?? input.of;
          steps.push(String(part.name ?? "").replace(/^kuvo-browser_/, "") + (typeof what === "string" && what ? `: ${what.split("\n")[0].slice(0, 120)}` : ""));
        }
      }
    } else if (message.type === "shell") {
      const output = String(message.output?.output ?? "").trim();
      say("User", "Ran `" + message.command + "`" + (output ? "\n\n```\n" + output + "\n```" : ""));
    } else if (message.type === "idle" && message.outcome === "failed") {
      // Why a turn stopped, as the conversation shows it. (A summary you asked for that failed says
      // so itself; one the agent made by itself was only part of the turn.)
      const before = messages[at - 1];
      if (before?.type === "compaction" && before.reason === "manual" && before.status === "failed") continue;
      say("Stopped", `It stopped with an error: ${message.error?.message?.trim() || "the engine gave no reason."}`);
    } else if (message.type === "compaction") {
      if (message.status === "completed") say(agent, "_Summarized the conversation so far._");
      else if (message.status === "failed") say(agent, "_Couldn't summarize the conversation._");
    }
  }
  if (steps.length) say(agent, "");
  return blocks.filter(Boolean).join("\n\n") + "\n";
}

// For finding words as the user means them: case and accents aside.
export const folded = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** As much of `markdown` as `limit` allows: all of it; with `query`, the paragraphs around each
 * mention of it; else how it began and its latest part. What's left out is marked. */
export function excerpt(markdown: string, query: string | null, limit: number): string {
  const paragraphs = markdown.split("\n\n");
  if (query) {
    const wanted = folded(query);
    const hits = paragraphs.flatMap((paragraph, index) => (folded(paragraph).includes(wanted) ? [index] : []));
    if (!hits.length) return `Nothing in it mentions "${query}". Read it without query for its latest part.`;
    // Each with the paragraph before and after it (who's speaking, and what came next), the latest
    // first as room runs out.
    const shown = new Set<number>();
    let used = 0;
    for (const hit of [...hits].reverse()) {
      const around = [hit - 1, hit, hit + 1].filter(index => index >= 0 && index < paragraphs.length && !shown.has(index));
      const size = around.reduce((sum, index) => sum + paragraphs[index].length + 2, 0);
      if (used + size > limit && shown.size) break;
      for (const index of around) shown.add(index);
      used += size;
    }
    const parts: string[] = [];
    let last: number | null = null;
    for (const index of [...shown].sort((a, b) => a - b)) {
      if (last !== null && index > last + 1) parts.push("[…]");
      parts.push(paragraphs[index].slice(0, limit));
      last = index;
    }
    const where = hits.length === 1 ? "1 place mentions" : `${hits.length} places mention`;
    return `${where} "${query}"` + (shown.size < paragraphs.length ? " (the rest left out as […])" : "") + ":\n\n" + parts.join("\n\n");
  }
  if (markdown.length <= limit) return markdown;
  // How it began: the title and the first message.
  let head = paragraphs.slice(0, 3).join("\n\n");
  if (head.length > limit / 4) head = head.slice(0, limit / 4) + "…";
  const tail: string[] = [];
  let used = head.length;
  for (const paragraph of paragraphs.slice(3).reverse()) {
    if (used + paragraph.length + 2 > limit) {
      if (!tail.length) tail.push("…" + paragraph.slice(paragraph.length - (limit - used)));
      break;
    }
    tail.unshift(paragraph);
    used += paragraph.length + 2;
  }
  return head + "\n\n[… the middle is left out; read it with query, to find a part …]\n\n" + tail.join("\n\n");
}

/** The conversation `session` (as its engine, `target`, answers for it in `data`), the whole of it
 * oldest first, up to an undo waiting to be kept; as Markdown, its agent named `name`. */
export async function readConversation(target: Target, session: string, data: Partial<EngineSession>, name: string, signal?: AbortSignal): Promise<string> {
  const address = encodeURIComponent(session);
  // A page whole, with where the next one starts.
  const whole = async (route: string): Promise<MessagePage> => {
    const response = await fetch(`http://127.0.0.1:${target.port}/${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal });
    if (!response.ok) throw new Error(`It answered ${response.status}.`);
    return ((await response.json()) as MessagePage | null) ?? {};
  };
  let latest = await whole(`api/session/${address}/message?limit=200&order=desc`);
  let messages = [...(latest.data ?? [])].reverse();
  for (let count = 0; count < 100 && latest.data?.length; count++) {
    const cursor = latest.cursor?.next ?? latest.cursor?.previous;
    if (!cursor) break;
    const older = await whole(`api/session/${address}/message?limit=200&cursor=${encodeURIComponent(cursor)}`);
    const found = [...(older.data ?? [])].reverse();
    if (!found.length || messages.some(message => message.id === found[found.length - 1].id)) break;
    messages = [...found, ...messages];
    latest = older;
  }
  const revert = data.revert?.messageID;
  const cut = revert ? messages.findIndex(message => message.id === revert) : -1;
  if (cut >= 0) messages = messages.slice(0, cut);
  return conversationMarkdown(name, messages, name);
}
