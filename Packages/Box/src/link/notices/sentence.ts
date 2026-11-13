// A notice says what's news in one sentence (PROTOCOL.md, "Notifications"): a reply's first, its
// Markdown taken off, a question's own, a failure's reason on one line.

import { cut } from "../../shared/text";

// Markdown's marks taken off, not the words (as ReplyPreview does on the Mac): headings, quotes
// and list items' marks at a line's start, emphasis around words, code ticks, a link's address.
export const plain = (text: unknown): string => String(text ?? "")
  .replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]+/gm, "")
  .replace(/^[ \t]*([-*+]|\d{1,9}[.)])[ \t]+/gm, "")
  .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
  .replace(/(?<![\w*_])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\w*_])/g, "")
  .replace(/`/g, "")
  .replace(/\s+/g, " ").trim();

/** The longest a notice's sentence is, in characters: what a lock screen shows in two lines or so. */
export const SENTENCE_LONGEST = 160;

// Words whose full stop doesn't end a sentence.
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|vs|cf|approx|incl|Mr|Mrs|Ms|Dr|Fig)\.$/i;

// The first sentence of a run of plain words: up to the first ".", "!", "?" or "…" with a space or
// the end after it (not a version's dot, "v1.2", nor an abbreviation's).
function firstOf(words: string): string {
  const ending = /[.!?…]+["”’)\]]*(?=\s|$)/g;
  for (let found = ending.exec(words); found; found = ending.exec(words)) {
    const end = found.index + found[0].length;
    if (ABBREVIATIONS.test(words.slice(0, found.index + 1))) continue;
    return words.slice(0, end);
  }
  return words;
}

// Cut at a word, ending in "…", to `longest` characters (never through one, an emoji's say).
function cutAtWord(text: string, longest: number): string {
  const characters = Array.from(text);
  if (characters.length <= longest) return text;
  const room = characters.slice(0, longest - 1).join("");
  const space = room.lastIndexOf(" ");
  return (space > longest / 2 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, "") + "…";
}

/** What `text` (an agent's reply, in Markdown) says first, as one sentence of plain words: its
 * first paragraph's first sentence, past headings, code, tables and rules; a line that leads into a
 * list ("Done:") with the list's first item. Cut at a word to `longest`; "" for nothing to say. */
export function oneSentence(text: unknown, longest = SENTENCE_LONGEST): string {
  const lines = String(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/g, "\n\n")
    .split("\n");
  // Paragraphs: lines together until a blank line, a heading, a table or a rule; each list item its own.
  const paragraphs: string[] = [];
  let current: string[] = [];
  let heading = "";
  const close = () => {
    if (current.length) paragraphs.push(plain(current.join(" ")));
    current = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    // (A line all in bold, as a heading's often written, is one; so is HTML's own line.)
    if (!line || /^#{1,6}\s/.test(line) || line.startsWith("|") || /^([-*_])(\s*\1){2,}$/.test(line) || /^(\*\*|__)[^*_]+\1:?$/.test(line) || /^<\/?[a-z][^>]*>$/i.test(line)) {
      close();
      // (A heading says it, where nothing else does: "**Done.**" alone.)
      if (!heading && /^(#{1,6}\s|\*\*|__)/.test(line)) heading = plain(line.replace(/^#{1,6}\s+/, ""));
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      close();
      current.push(item[1]);
      close();
      continue;
    }
    current.push(line);
  }
  close();
  const found = paragraphs.filter(Boolean);
  if (!found.length) return heading ? cutAtWord(firstOf(heading), longest) : "";
  let sentence = firstOf(found[0]);
  // "Here's what changed:" says nothing alone: with what comes first after it.
  if (sentence === found[0] && sentence.endsWith(":") && found[1]) sentence = `${sentence} ${firstOf(found[1])}`;
  return cutAtWord(sentence, longest);
}

/** A failure's reason as one line, cut short; "" for none. */
export const reasonLine = (reason: unknown, longest = 120): string => {
  const line = String(reason ?? "").split("\n").map(each => each.trim()).find(Boolean) ?? "";
  return line ? cut(line, longest) : "";
};
