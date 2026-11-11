// What a bot may allow its sessions (answer_ask, PROTOCOL.md "Work"): what its own conversation
// could do without asking, as any conversation in its mode does. Its own rules say (the engine's
// defaults, Settings › Permissions, and what you set in Edit Bot), part by part as the engine
// matches each, and a file outside the session's folders also as working outside the project. A
// command its own would run in the sandbox it allows only where the session's runs there too; in
// Full Access, anywhere. Everything else goes to the user. And a command line read as a shell
// would (`readLine`), which Auto's reviewer reads too.

import fs from "node:fs";
import path from "node:path";
import type { KitRule } from "../bots/kit";
import type { ToolCallSeen } from "./answers";

/** A command line read as a shell would run it: its parts (separated by `;`, `&&`, `||`, `|` or a
 * new line), each one's words, where its output goes and its input comes from, and each part's own
 * text. */
export interface Line {
  parts: { words: string[]; writes: string[]; reads: string[]; text: string }[];
}

/** Why a line can't be read as plain programs (something a shell expands or runs besides), or
 * the line. `redirects`: where its output goes or its input comes from is read too (in the sandbox,
 * which holds what's written), rather than refused. */
export function readLine(line: string, redirects = false): Line | { unreadable: string } {
  const parts: Line["parts"] = [];
  let words: string[] = [], writes: string[] = [], reads: string[] = [], word = "", has = false, quote: string | null = null, start = 0;
  let redirect: "write" | "read" | null = null;
  const no = (what: string) => ({ unreadable: what });
  const endWord = () => {
    if (has) {
      if (redirect === "write") writes.push(word);
      else if (redirect === "read") reads.push(word);
      else words.push(word);
      redirect = null;
    }
    word = "";
    has = false;
  };
  const endPart = (at: number) => {
    endWord();
    if (redirect) return false;
    const text = line.slice(start, at).trim();
    if (words.length) parts.push({ words, writes, reads, text });
    else if (text) return false;
    words = [];
    writes = [];
    reads = [];
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "$" || char === "`") return no("something the shell fills in");
      else if (char === "\\" && i + 1 < line.length) word += line[++i];
      else word += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      has = true;
    } else if (char === "\\" && i + 1 < line.length) {
      if (line[i + 1] === "\n") i++;
      else {
        word += line[++i];
        has = true;
      }
    } else if (char === "$" || char === "`") {
      return no("something the shell fills in");
    } else if ("(){}".includes(char)) {
      return no("a group of commands");
    } else if (char === "~" && !has && !["/", " ", "\t", "\n", undefined].includes(line[i + 1])) {
      return no("another user's folder");
    } else if (char === "#" && !has) {
      return no("a comment");
    } else if (/\s/.test(char) && char !== "\n") {
      endWord();
    } else if (char === "\n" || char === ";") {
      if (!endPart(i)) return no("a part it can't read");
      start = i + 1;
    } else if (char === "|" || char === "&") {
      const pair = line[i + 1] === char;
      if (char === "&" && !pair) {
        // `2>&1` and `>&2`: one stream into another.
        if (line[i - 1] === ">" && /[0-9]/.test(line[i + 1] ?? "")) {
          i++;
          redirect = null;
          continue;
        }
        return no("something running in the background");
      }
      if (char === "|" && line[i + 1] === "&") return no("a part it can't read");
      if (!endPart(i)) return no("a part it can't read");
      if (pair) i++;
      start = i + 1;
    } else if (char === ">" || char === "<") {
      // Until the sandbox: where a command reads or writes is only what its words name.
      if (!redirects) return no("input or output sent elsewhere");
      if (char === "<" && line[i + 1] === "<") return no("a here-document");
      // (A stream's number, `2>`, is no word of its own.)
      if (has && /^[0-9]+$/.test(word)) { word = ""; has = false; } else endWord();
      if (line[i + 1] === char) i++;
      redirect = char === ">" ? "write" : "read";
    } else {
      word += char;
      has = true;
    }
  }
  if (quote) return no("an unclosed quote");
  if (!endPart(line.length)) return no("a part it can't read");
  return { parts };
}

/** The parts of a command line as the engine's rules match each: its own text, part by part. */
export function partsOf(line: string): string[] {
  const read = readLine(line);
  return "unreadable" in read ? [line] : read.parts.map(part => part.text);
}

const FILES = new Set(["edit", "write", "patch", "multiedit", "read", "list", "glob", "grep"]);
// Where a path really is: its nearest folder that's there with the links in it followed, and the
// rest as written (a file not made yet).
function realOf(given: string): string {
  const full = path.resolve(given);
  for (let at = full, rest = ""; ; rest = path.join(path.basename(at), rest), at = path.dirname(at)) {
    try {
      return path.join(fs.realpathSync(at), rest);
    } catch {
      if (path.dirname(at) === at) return full;
    }
  }
}
const within = (full: string, folder: string) => full === folder || full.startsWith(folder.endsWith("/") ? folder : folder + "/");

/** Why a bot can't allow what's asked (`action` on `resources`, by the tool call `seen`, whole), for
 * a session working in `folders`, within its own `rules` (`rulesOf`); null when it may. "above"
 * where its own conversation would have to ask too. `sandboxed`: the session's command runs in the
 * sandbox; `free`: the bot's own commands run outside it (Full Access, or no sandbox here). */
export function allowRefusal(action: string, resources: readonly string[], folders: readonly string[], rules: readonly KitRule[], ruleFor: (rules: readonly KitRule[], action: string, resource: string) => KitRule["effect"], seen: ToolCallSeen | null, { sandboxed = false, free = false }: { sandboxed?: boolean; free?: boolean } = {}): string | null {
  const asked = resources.length ? resources : ["*"];
  if (action === "shell" || action === "bash") {
    // (Its own would run in the sandbox: so must the session's.)
    if (!free && !sandboxed) return "above";
    const command = typeof seen?.input.command === "string" ? seen.input.command : null;
    return [...(command ? partsOf(command) : []), ...asked].every(part => ruleFor(rules, action, part) === "allow") ? null : "above";
  }
  // (The engine reads a \ as a / as it matches a rule for a folder outside: `notes\x` would pass
  // for a file in `notes`, while it's beside it. Never one a bot allows.)
  const named = FILES.has(action) && seen ? [seen.input.filePath, seen.input.file_path, seen.input.path, seen.input.file].filter((each): each is string => typeof each === "string") : [];
  if ((action === "external_directory" || FILES.has(action)) && [...asked, ...named].some(each => each.includes("\\"))) return "above";
  if (!asked.every(resource => ruleFor(rules, action, resource) === "allow")) return "above";
  // A file outside the session's folders (where it really is, a link in it followed), as its own
  // would be asked: working outside the project, allowed there as written and where it leads.
  if (FILES.has(action)) {
    // (A path not from `/` is from the session's folder, as the engine takes it.)
    const full = [...asked, ...named].filter(each => each !== "*" && (path.isAbsolute(each) || folders.length)).map(each => path.resolve(folders[0] ?? "/", each));
    const outside = full.filter(each => !folders.some(folder => within(realOf(each), realOf(folder))));
    if (outside.some(each => [each, realOf(each)].some(at => ruleFor(rules, "external_directory", at) !== "allow"))) return "above";
  }
  return null;
}
