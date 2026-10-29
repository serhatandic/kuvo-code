// What a bot may allow its sessions (answer_ask, PROTOCOL.md "Work"): the policy before fencing.
// Reading a command can't be made airtight, so until sessions are fenced (phase 5) a bot answers
// only edits inside the session's folder (never what a later command runs) and a handful of
// commands that read, with literal paths inside the folder. Everything else goes to the user,
// however it's phrased.

import fs from "node:fs";
import path from "node:path";
import { homeFolder, K } from "../home";
import type { KitRule } from "../bots/kit";

/** A command line read as a shell would run it: its parts (separated by `;`, `&&`, `||`, `|` or a
 * new line), each one's words and where its output goes, and each part's own text. */
interface Line {
  parts: { words: string[]; writes: string[]; text: string }[];
}

/** Why a line can't be read as plain programs (something a shell expands or runs besides), or
 * the line. */
export function readLine(line: string): Line | { unreadable: string } {
  const parts: Line["parts"] = [];
  let words: string[] = [], writes: string[] = [], word = "", has = false, quote: string | null = null, start = 0;
  let redirect: "write" | "read" | null = null;
  const no = (what: string) => ({ unreadable: what });
  const endWord = () => {
    if (has) {
      if (redirect === "write") writes.push(word);
      else if (redirect !== "read") words.push(word);
      redirect = null;
    }
    word = "";
    has = false;
  };
  const endPart = (at: number) => {
    endWord();
    if (redirect) return false;
    const text = line.slice(start, at).trim();
    if (words.length) parts.push({ words, writes, text });
    else if (text) return false;
    words = [];
    writes = [];
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
      // Before fencing: where a command reads or writes is only what its words name.
      return no("input or output sent elsewhere");
    } else {
      word += char;
      has = true;
    }
  }
  if (quote) return no("an unclosed quote");
  if (!endPart(line.length)) return no("a part it can't read");
  return { parts };
}

/** Where a command runs, and the folders it may read and change things in. */
interface Place {
  cwd: string;
  folders: readonly string[];
}

// A path as the file system has it: `~` taken as the home folder, from where the command runs,
// every link followed as far as there's something there (what doesn't exist yet, under its
// parent's real place).
function realPath(target: string, cwd: string): string {
  let full = path.resolve(cwd, target.replace(/^~(?=$|\/)/, homeFolder()));
  const rest: string[] = [];
  for (let step = 0; step < 64; step++) {
    try {
      return path.join(fs.realpathSync(full), ...rest);
    } catch {
      const parent = path.dirname(full);
      if (parent === full) break;
      rest.unshift(path.basename(full));
      full = parent;
    }
  }
  return path.join(full, ...rest);
}
const under = (full: string, folder: string) => full.startsWith(folder.endsWith("/") ? folder : folder + "/");

// Where your keys and sign-ins are: never a bot's to let a session read or change, wherever its
// folder is.
function isSecret(full: string): boolean {
  const home = realPath(homeFolder(), "/");
  const kuvo = realPath(K, "/");
  const secrets = [path.join(kuvo, "keys"), path.join(kuvo, "box"), path.join(kuvo, "run"), path.join(kuvo, "agents"), path.join(kuvo, "integrations"),
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".netrc", ".git-credentials", ".npmrc", ".pypirc", "Library/Keychains", ".claude", ".codex", ".grok"].map(name => path.join(home, name))];
  return secrets.some(secret => full === secret || under(full, secret));
}

// Files whose contents a later command runs or reads as settings: git's own (a repository's
// `config`, `HEAD`, hooks, wherever they are, as a bare one makes them), hooks, package and build
// settings, tools' configs, editors' tasks, what's installed. A change to one is the user's to allow.
const RUNS_LATER = new RegExp([
  "(^|/)(\\.git|\\.husky|\\.githooks|node_modules|\\.cargo|\\.vscode|\\.idea|\\.github|hooks|refs|objects|info)(/|$)",
  "(^|/)(config|HEAD|packed-refs|commondir|gitdir|\\.gitattributes|\\.gitmodules|\\.npmrc|\\.yarnrc(\\.yml)?|\\.pnpmfile\\.cjs|package\\.json|bunfig\\.toml|Makefile|makefile|GNUmakefile|[^/]+\\.mk|build\\.rs|conftest\\.py|setup\\.py|setup\\.cfg|pyproject\\.toml|tox\\.ini|pytest\\.ini|[^/]+\\.pth|Package\\.swift|project\\.pbxproj|[^/]+\\.xcconfig|Podfile|Gemfile|Rakefile|[^/]+\\.gradle(\\.kts)?|lefthook\\.ya?ml|\\.pre-commit-config\\.yaml|\\.envrc|\\.eslintrc[^/]*|\\.babelrc[^/]*|\\.prettierrc[^/]*|[^/]+\\.config\\.[cm]?[jt]sx?|[^/]+rc\\.[cm]?js|Dockerfile|docker-compose\\.ya?ml)$",
].join("|"));

/** Why `target` can't be read (`read`) or changed (`write`) by what a bot allows, or null: a literal
 * path inside the session's folders by its real place, never your keys, nor (to change) a file a
 * later command runs or reads as settings. */
export function pathRefusal(target: string, place: Place, use: "read" | "write"): string | null {
  if (/[*?[\]]/.test(target)) return "a pattern of files it can't see";
  const full = realPath(target, place.cwd);
  if (isSecret(full)) return "your keys and sign-ins";
  const folders = place.folders.map(folder => realPath(folder, "/"));
  if (!folders.some(folder => under(full, folder) || full === folder)) return use === "read" ? "reading outside the project" : "changing files outside the project";
  if (use === "write" && RUNS_LATER.test(full)) return "changing a file that later commands run";
  return null;
}

const CANT = "a command it can't tell is safe";

/** What a program may be given, before fencing: its flags (each taking a number, or nothing), the
 * one-letter flags that may go together, and whether its other words are paths it reads (literal,
 * inside the project) or git's revisions. */
interface Spec {
  flags?: Record<string, "number" | null>;
  letters?: string;
  counts?: boolean;
  rest?: "read" | "revisions";
}

const PROGRAMS: Record<string, Spec> = {
  ls: { letters: "1aAlhtrSdF", rest: "read" },
  cat: { letters: "n", rest: "read" },
  head: { flags: { "-n": "number" }, counts: true, rest: "read" },
  tail: { flags: { "-n": "number" }, counts: true, rest: "read" },
  wc: { letters: "lwcm", rest: "read" },
};
// git, reading only, with none of its options that write, read settings or run anything.
const GIT: Record<string, Spec> = {
  status: { flags: { "-s": null, "--short": null, "-b": null, "--branch": null } },
  diff: { flags: { "--stat": null, "--cached": null, "--staged": null, "--name-only": null } },
  log: { flags: { "--oneline": null, "-n": "number" }, counts: true, rest: "revisions" },
};

function checkSpec(spec: Spec, words: string[], place: Place): string | null {
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    if (word.startsWith("-")) {
      if (spec.flags && word in spec.flags) {
        if (spec.flags[word] === "number" && !/^[0-9]+$/.test(words[++at] ?? "")) return CANT;
        continue;
      }
      if (spec.counts && /^-[0-9]+$/.test(word)) continue;
      if (spec.letters && word.length > 1 && [...word.slice(1)].every(letter => spec.letters!.includes(letter))) continue;
      return CANT;
    }
    if (spec.rest === "read") {
      const why = pathRefusal(word, place, "read");
      if (why) return why;
    } else if (spec.rest === "revisions") {
      if (!/^[A-Za-z0-9._/~^-]+$/.test(word) || word.includes("..")) return CANT;
    } else return CANT;
  }
  return null;
}

/** Why a bot can't allow running `line` in the session's folder (`folders[0]`; its project's other
 * folders count as inside too), or null.
 *
 * The policy before fencing (phase 5): a bot may allow only a handful of commands that read
 * (`ls`, `cat`, `head`, `tail`, `wc`, and `git status`, `diff` and `log` with a few options), each
 * part of the line one of those, with literal paths inside the session's folder, and nothing
 * else: no redirects, no patterns of files, no settings before it, nothing a shell expands or runs
 * besides. Reading a command can't be made airtight, so everything else goes to the user until
 * the session is fenced. */
export function commandRefusal(line: string, folders: readonly string[]): string | null {
  const read = readLine(line);
  if ("unreadable" in read) return `${CANT} (${read.unreadable})`;
  if (!read.parts.length || !folders.length) return CANT;
  const place: Place = { cwd: realPath(folders[0], "/"), folders };
  for (const part of read.parts) {
    const [program, ...rest] = part.words;
    if (!program || program.includes("=")) return CANT;
    if (program === "git") {
      if (rest[0] === "push") return "pushing";
      const spec = GIT[rest[0] ?? ""];
      const why = spec ? checkSpec(spec, rest.slice(1), place) : CANT;
      if (why) return why;
      continue;
    }
    const spec = PROGRAMS[program];
    if (!spec) return NAMED[program] ?? (/(deploy|release|publish)/i.test(path.basename(program)) ? "releasing or deploying" : CANT);
    const why = checkSpec(spec, rest, place);
    if (why) return why;
  }
  return null;
}

// What some programs are, for the words a refusal says.
const NAMED: Record<string, string> = {
  vercel: "deploying", netlify: "deploying", wrangler: "deploying", firebase: "deploying", fly: "deploying", flyctl: "deploying", heroku: "deploying", fastlane: "sending to a store", eas: "sending to a store",
  security: "your keys and sign-ins", ssh: "reaching another computer", scp: "reaching another computer", rsync: "reaching another computer",
  npm: "building, testing or installing", npx: "running a package's code", bunx: "running a package's code", pnpm: "building, testing or installing", yarn: "building, testing or installing", bun: "building, testing or installing",
  pip: "installing", pip3: "installing", go: "building, testing or installing", cargo: "building, testing or installing", make: "building, testing or installing",
  swift: "building, testing or installing", xcodebuild: "building, testing or installing", pytest: "building, testing or installing", pod: "installing", bundle: "installing", brew: "installing",
};

/** The parts of a command line as the engine's rules match each: its own text, part by part. */
export function partsOf(line: string): string[] {
  const read = readLine(line);
  return "unreadable" in read ? [line] : read.parts.map(part => part.text);
}

const EDITS = new Set(["edit", "write", "patch", "multiedit"]);

/** Why a bot can't allow what's asked (`action` on `resources`), within its `rules` (`rulesOf`),
 * for a session working in `folders`; null when it may.
 *
 * Before fencing (phase 5), a bot answers only two kinds of ask: an edit to files inside the
 * session's folder (by their real place, never your keys nor a file a later command runs or reads
 * as settings), and the few commands `commandRefusal` reads as safe. Everything else, reading
 * included, goes to the user. */
export function allowRefusal(action: string, resources: readonly string[], folders: readonly string[], rules: readonly KitRule[], ruleFor: (rules: readonly KitRule[], action: string, resource: string) => KitRule["effect"]): string | null {
  const asked = resources.length ? resources : ["*"];
  if (action === "shell" || action === "bash") {
    for (const resource of asked) {
      const why = commandRefusal(resource, folders);
      if (why) return why;
      // The engine's rules, for each part as it judges each.
      if (!partsOf(resource).every(part => ruleFor(rules, action, part) === "allow")) return "above";
    }
    return null;
  }
  if (!EDITS.has(action)) return action === "external_directory" ? "working outside the project" : "a tool it can't tell is safe";
  if (!folders.length) return "changing files outside the project";
  const place: Place = { cwd: realPath(folders[0], "/"), folders };
  for (const resource of asked) {
    const why = pathRefusal(resource, place, "write");
    if (why) return why;
  }
  return asked.every(resource => ruleFor(rules, action, resource) === "allow") ? null : "above";
}
