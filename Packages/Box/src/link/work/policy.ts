// What a bot may allow its sessions (answer_ask, PROTOCOL.md "Work"), failing closed: a command it
// can read whole, every part of it, as programs on a short list, every flag on that program's own
// list, nothing a shell would expand or run besides, and every file it reads, writes or deletes
// inside the session's folder by its real place (links followed), never your keys, and never a
// file later commands run. Nothing that builds, tests or installs. Anything else goes to the user,
// however it's phrased. Besides commands: reading and editing inside the project, fetching pages,
// subagents; any other tool (an integration's, say) goes to the user.

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
      // A stream's number before it (`2>`) isn't a word.
      if (has && /^[0-9]$/.test(word)) {
        word = "";
        has = false;
      } else endWord();
      if (char === "<" && line[i + 1] === "<") return no("text written into the command");
      if (char === ">" && line[i + 1] === ">") i++;
      if (char === "<" && line[i + 1] === ">") return no("a part it can't read");
      if (line[i + 1] === "&") continue;
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
const realFolders = (place: Place) => place.folders.map(folder => realPath(folder, "/"));
const under = (full: string, folder: string) => full.startsWith(folder.endsWith("/") ? folder : folder + "/");

// Where your keys and sign-ins are: never a bot's to let a session read or change, wherever its
// folder is.
function isSecret(full: string): boolean {
  const home = realPath(homeFolder(), "/");
  const kuvo = realPath(K, "/");
  const secrets = [path.join(kuvo, "keys"), path.join(kuvo, "box"), path.join(kuvo, "run"), path.join(kuvo, "agents"), path.join(kuvo, "integrations"),
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config/gh", ".netrc", ".git-credentials", ".npmrc", ".pypirc", "Library/Keychains", ".claude", ".codex", ".grok"].map(name => path.join(home, name))];
  return secrets.some(secret => full === secret || under(full, secret));
}

// Files whose contents later commands run (hooks, build and test settings, package scripts): a
// change to one is the user's to allow, as running it would be.
const RUNS_LATER = /(^|\/)(\.git|\.husky|\.githooks|node_modules\/\.bin|\.cargo)(\/|$)|(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|package\.json|Makefile|makefile|GNUmakefile|[^/]+\.mk|build\.rs|conftest\.py|setup\.py|setup\.cfg|pyproject\.toml|tox\.ini|pytest\.ini|Package\.swift|project\.pbxproj|Podfile|Gemfile|Rakefile|[^/]+\.gradle(\.kts)?|lefthook\.ya?ml|\.pre-commit-config\.yaml|\.envrc)$/;

/** Why `target` can't be read (`read`), written (`write`) or deleted (`delete`) by what a bot
 * allows, or null: inside the session's folders (strictly, to delete one), by its real place,
 * never your keys, nor (to change) a file later commands run. */
export function pathRefusal(target: string, place: Place, use: "read" | "write" | "delete"): string | null {
  if (target === "/dev/null" && use !== "delete") return null;
  // A pattern of files may take in a link that leads anywhere: which files it is, it can't see.
  if (/[*?[\]]/.test(target)) return "a pattern of files it can't see";
  const full = realPath(target, place.cwd);
  if (isSecret(full)) return "your keys and sign-ins";
  const inside = realFolders(place).some(folder => under(full, folder) || (use !== "delete" && full === folder));
  if (!inside) return use === "read" ? "reading outside the project" : use === "delete" ? "deleting outside the project" : "changing files outside the project";
  if (use !== "read" && RUNS_LATER.test(full)) return "changing a file that later commands run";
  return null;
}

const CANT = "a command it can't tell is safe";

/** A word a program takes: a path it reads, writes or deletes, a number, a web address, or text
 * it doesn't act on. */
type Kind = "read" | "write" | "delete" | "number" | "url" | "text";

/** What a program may be given: its flags (each with the kind of value it takes, or null for
 * none), the one-letter flags that may go together (`-la`), and what its other words are (the
 * first few, then the rest), at most `most` of them. */
interface Spec {
  flags?: Record<string, Kind | null>;
  letters?: string;
  args?: Kind[];
  rest?: Kind;
  most?: number;
  /** A number as a flag (`head -20`). */
  counts?: boolean;
  /** Its first word is a pattern unless `-e` gave one (grep). */
  pattern?: boolean;
  /** Checks of its own, on all its words. */
  also?: (words: string[]) => string | null;
}

function checkValue(kind: Kind, value: string, place: Place): string | null {
  switch (kind) {
    case "number": return /^[0-9]+[kKmMgG]?$/.test(value) ? null : CANT;
    case "url": return /^https?:\/\/[^\s]+$/.test(value) ? null : CANT;
    case "text": return null;
    default: return pathRefusal(value, place, kind);
  }
}

/** Why words for `spec` aren't safe, or null: every flag on its list, every path inside. */
function checkSpec(spec: Spec, words: string[], place: Place): string | null {
  const flags = spec.flags ?? {};
  const positional: string[] = [];
  let patternGiven = false;
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    if (word === "--") {
      positional.push(...words.slice(at + 1));
      break;
    }
    if (word.startsWith("-") && word.length > 1) {
      const [name, inline] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
      if (name in flags) {
        const kind = flags[name];
        if (kind === null) {
          if (inline !== undefined) return CANT;
          continue;
        }
        const value = inline ?? words[++at];
        if (value === undefined) return CANT;
        if (name === "-e" && spec.pattern) patternGiven = true;
        const why = checkValue(kind, value, place);
        if (why) return why;
        continue;
      }
      if (spec.counts && /^-[0-9]+$/.test(word)) continue;
      if (!word.startsWith("--") && spec.letters && [...word.slice(1)].every(letter => spec.letters!.includes(letter))) continue;
      return CANT;
    }
    positional.push(word);
  }
  const kinds = [...(spec.pattern && !patternGiven ? ["text" as Kind] : []), ...(spec.args ?? [])];
  if (spec.most !== undefined && positional.length > spec.most + (spec.pattern && !patternGiven ? 1 : 0)) return CANT;
  for (const [index, word] of positional.entries()) {
    const kind = kinds[index] ?? spec.rest;
    if (!kind) return CANT;
    const why = checkValue(kind, word, place);
    if (why) return why;
  }
  return spec.also?.(words) ?? null;
}

const reading = (letters = "", flags: Spec["flags"] = {}, extra: Partial<Spec> = {}): Spec => ({ letters, flags, rest: "read", ...extra });

// The programs a bot may let a session run, with what each may be given. Nothing that builds,
// tests or installs (they run the project's code, or a package's), nothing that runs a command of
// its own, nothing that reaches beyond the project. (Phase 5's fencing will let more through.)
const PROGRAMS: Record<string, Spec | ((words: string[], place: Place) => string | null)> = {
  ls: reading("1aAlhRtrSdFGT"),
  cat: reading("nbsvetA"),
  head: reading("", { "-n": "number", "-c": "number" }, { counts: true }),
  tail: reading("fF", { "-n": "number", "-c": "number" }, { counts: true }),
  wc: reading("lwcm"),
  nl: reading("ba"),
  file: reading("bL"),
  stat: reading("Lx"),
  du: reading("shkacx", { "-d": "number" }),
  df: reading("hk"),
  tree: reading("adfiFC", { "-L": "number", "-I": "text", "-P": "text" }),
  basename: { rest: "text" }, dirname: { rest: "text" }, realpath: reading(""),
  md5: reading("q"), shasum: reading("", { "-a": "number" }), sha256sum: reading(""),
  diff: reading("uNqwbBi", { "-U": "number", "--color": null, "--brief": null }),
  cmp: reading("ls"),
  grep: reading("rniIlLcvwxEFHhoqsz", { "-e": "text", "-A": "number", "-B": "number", "-C": "number", "--include": "text", "--exclude": "text", "--exclude-dir": "text", "--color": null, "-m": "number" }, { pattern: true }),
  rg: reading("inlcwFSuHoq", { "-e": "text", "-g": "text", "-t": "text", "-T": "text", "-A": "number", "-B": "number", "-C": "number", "--hidden": null, "--no-ignore": null, "--files": null, "--json": null, "-m": "number" }, { pattern: true }),
  sort: reading("nrufhVb", { "-k": "text", "-t": "text" }),
  uniq: reading("cdui", {}, { most: 1 }),
  cut: reading("s", { "-d": "text", "-f": "text", "-c": "text" }),
  comm: reading("123"),
  column: reading("t", { "-s": "text" }),
  tr: { letters: "dsc", rest: "text", most: 2 },
  echo: { letters: "ne", rest: "text" },
  printf: (words) => (words[0]?.startsWith("-") ? CANT : null),
  pwd: { letters: "LP" }, whoami: {}, true: { rest: "text" }, false: { rest: "text" },
  date: { letters: "uR", rest: "text", also: words => (words.some(word => !word.startsWith("+") && !/^-[uR]+$/.test(word)) ? CANT : null) },
  uname: { letters: "amsrnp" },
  which: { letters: "a", rest: "text" },
  sleep: { args: ["number"], most: 1 },
  test: { rest: "text" }, "[": { rest: "text" },
  // Printing lines only (`sed -n '1,40p' file`): never in place, nor a script that writes or runs.
  sed: { letters: "nE", args: ["text"], rest: "read", also: words => (/^([0-9]+(,([0-9]+|\$))?|\$|\/[^/]*\/)p$/.test(words.find(word => !word.startsWith("-")) ?? "") ? null : CANT) },
  jq: { letters: "rcensSM", args: ["text"], rest: "read", also: words => (words.some(word => /\benv\b|\$ENV|\$__|input_filename|@sh/.test(word)) ? CANT : null) },
  find: (words, place) => {
    let at = 0;
    for (; at < words.length && !words[at].startsWith("-") && words[at] !== "!" && words[at] !== "("; at++) {
      const why = pathRefusal(words[at], place, "read");
      if (why) return why;
    }
    const valued = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-size", "-newer", "-regex"]);
    for (; at < words.length; at++) {
      const word = words[at];
      if (valued.has(word)) {
        if (word === "-newer" && pathRefusal(words[at + 1] ?? "", place, "read")) return "reading outside the project";
        at++;
      } else if (!["!", "-not", "-o", "-or", "-a", "-and", "-print", "-print0", "-empty", "-prune"].includes(word)) return CANT;
    }
    return null;
  },
  mkdir: { letters: "p", rest: "write" },
  touch: { rest: "write" },
  cp: { letters: "rRpfn", rest: "write", also: undefined },
  mv: { letters: "fn", rest: "write" },
  rm: { letters: "rRfd", rest: "delete" },
  rmdir: { letters: "p", rest: "delete" },
  chmod: { letters: "R", args: ["text"], rest: "write", also: words => (/^[ugoa]*[+=-][rwx]+$|^[0-7]{3,4}$/.test(words.find(word => !word.startsWith("-")) ?? "") ? null : CANT) },
  cd: (words, place) => (words.length === 1 && words[0] !== "-" ? pathRefusal(words[0], place, "read") : CANT),
  git: (words, place) => git(words, place),
  gh: words => {
    const reads: Record<string, string[]> = { pr: ["view", "list", "diff", "checks", "status"], issue: ["view", "list", "status"], run: ["view", "list", "watch"], repo: ["view"], release: ["view", "list"] };
    const [area, action, ...rest] = words;
    if (!reads[area ?? ""]?.includes(action ?? "")) return ["repo", "release", "pr", "secret", "workflow", "variable", "issue", "api"].includes(area ?? "") ? "changing what's on GitHub" : CANT;
    return checkSpec({ flags: { "--json": "text", "--limit": "number", "-L": "number", "--state": "text", "--log": null, "--log-failed": null, "-R": "text", "--repo": "text", "--jq": "text", "--name-only": null }, rest: "text" }, rest, { cwd: "/", folders: [] });
  },
  curl: (words, place) => checkSpec({ letters: "sSLIifv", flags: { "--fail": null, "--compressed": null, "--max-time": "number", "-m": "number", "-H": "text", "--header": "text", "-A": "text", "--retry": "number", "-X": "text", "--request": "text" }, rest: "url",
    also: all => (all.some((word, at) => /^(-X|--request)$/.test(word) && !/^(GET|HEAD)$/i.test(all[at + 1] ?? "")) ? CANT : null) }, words, place),
  node: words => (words.length === 1 && /^(-v|--version)$/.test(words[0]) ? null : CANT),
  python: words => (words.length === 1 && /^(-V|--version)$/.test(words[0]) ? null : words[0] === "-m" ? "building, testing or installing" : CANT),
  python3: words => (words.length === 1 && /^(-V|--version)$/.test(words[0]) ? null : words[0] === "-m" ? "building, testing or installing" : CANT),
  npm: words => (words.length === 1 && /^(-v|--version)$/.test(words[0]) ? null : "building, testing or installing"),
};

// git: reading, and changing this checkout only. git keeps what it's given to the repository, so
// its other words are names and refs; never pushing, its settings, worktrees elsewhere, or what
// runs a command of its own.
const GIT: Record<string, Spec> = {
  status: { letters: "sbu", flags: { "--short": null, "--branch": null, "--porcelain": null, "--untracked-files": "text" }, rest: "text" },
  diff: { letters: "wR", flags: { "--stat": null, "--cached": null, "--staged": null, "--name-only": null, "--name-status": null, "--color": null, "--no-color": null, "--word-diff": null, "-U": "number", "--shortstat": null, "--numstat": null, "--check": null }, rest: "text" },
  log: { letters: "p", flags: { "--oneline": null, "-n": "number", "--stat": null, "--graph": null, "--decorate": null, "--all": null, "--format": "text", "--pretty": "text", "--grep": "text", "--author": "text", "--since": "text", "--until": "text", "--patch": null, "--reverse": null, "--name-only": null, "--name-status": null, "--follow": null, "--first-parent": null, "--no-merges": null, "--merges": null }, rest: "text", counts: true },
  show: { flags: { "--stat": null, "--name-only": null, "--name-status": null, "--format": "text", "--pretty": "text", "--oneline": null, "--no-patch": null }, rest: "text" },
  add: { letters: "Auv", flags: { "--all": null, "--update": null, "--intent-to-add": null, "-N": null }, rest: "text" },
  commit: { letters: "aqv", flags: { "-m": "text", "--message": "text", "--amend": null, "--no-edit": null, "--allow-empty": null, "--no-verify": null, "--quiet": null }, most: 0 },
  checkout: { letters: "bBq", flags: { "--quiet": null }, rest: "text" },
  switch: { letters: "cCq", flags: { "--create": null, "--detach": null, "--quiet": null }, rest: "text" },
  restore: { letters: "SW", flags: { "--staged": null, "--worktree": null, "--source": "text" }, rest: "text" },
  branch: { letters: "arvdDm", flags: { "--list": null, "--show-current": null, "--all": null, "--merged": null, "--no-merged": null }, rest: "text" },
  stash: { letters: "pu", flags: { "-m": "text", "--message": "text", "--include-untracked": null }, rest: "text", also: words => (["push", "pop", "list", "show", "apply", "drop", undefined].includes(words.find(word => !word.startsWith("-"))) || !words.some(word => !word.startsWith("-")) ? null : CANT) },
  fetch: { letters: "pq", flags: { "--all": null, "--prune": null, "--tags": null, "--quiet": null }, rest: "text", also: words => (words.every(word => word.startsWith("-") || /^[A-Za-z0-9._/-]+$/.test(word) && !word.includes("//")) ? null : CANT) },
  pull: { letters: "q", flags: { "--rebase": null, "--ff-only": null, "--no-rebase": null, "--quiet": null }, rest: "text", also: words => (words.every(word => word.startsWith("-") || /^[A-Za-z0-9._/-]+$/.test(word) && !word.includes("//")) ? null : CANT) },
  merge: { flags: { "--no-ff": null, "--ff-only": null, "--abort": null, "--continue": null, "--squash": null, "-m": "text", "--no-edit": null }, rest: "text" },
  rebase: { flags: { "--continue": null, "--abort": null, "--skip": null, "--onto": "text" }, rest: "text" },
  init: { flags: { "-b": "text", "--initial-branch": "text", "-q": null }, most: 0 },
  "rev-parse": { flags: { "--show-toplevel": null, "--abbrev-ref": null, "--short": null, "--verify": null, "--git-dir": null, "--is-inside-work-tree": null }, rest: "text" },
  "ls-files": { letters: "comdz", flags: { "--others": null, "--exclude-standard": null, "--modified": null, "--deleted": null }, rest: "text" },
  blame: { letters: "wM", flags: { "-L": "text" }, rest: "text" },
  grep: { letters: "nilwcIE", flags: { "-e": "text" }, rest: "text" },
  tag: { letters: "l", flags: { "--list": null, "--sort": "text" }, rest: "text" },
  describe: { flags: { "--tags": null, "--always": null, "--abbrev": "number" }, rest: "text" },
  shortlog: { letters: "sne", rest: "text" },
  reset: { flags: { "--soft": null, "--mixed": null, "--hard": null, "--keep": null, "-q": null }, rest: "text" },
  "cherry-pick": { flags: { "--continue": null, "--abort": null, "--no-commit": null, "-n": null, "-x": null }, rest: "text" },
  revert: { flags: { "--no-edit": null, "--continue": null, "--abort": null, "--no-commit": null, "-n": null }, rest: "text" },
  clean: { letters: "nfdxq", most: 0 },
  mv: { letters: "fk", rest: "text" },
  rm: { letters: "rfq", flags: { "--cached": null }, rest: "text" },
  remote: { letters: "v", rest: "text", also: words => (words.filter(word => !word.startsWith("-")).length === 0 || ["show", "get-url"].includes(words.find(word => !word.startsWith("-")) ?? "") ? null : CANT) },
  config: { flags: { "--get": "text", "--get-all": "text", "--list": null, "-l": null, "--local": null }, most: 0, also: words => (words.some(word => /^(--get|--get-all|--list|-l)$/.test(word)) ? null : CANT) },
  "worktree": { rest: "text", most: 1, also: words => (words[0] === "list" ? null : CANT) },
  reflog: { flags: { "-n": "number" }, rest: "text" },
  "show-ref": { rest: "text" }, "merge-base": { rest: "text" }, version: {},
  "rev-list": { flags: { "--count": null, "--all": null, "-n": "number" }, rest: "text" },
  "cat-file": { letters: "pts", rest: "text" },
};
function git(words: string[], place: Place): string | null {
  const [command, ...rest] = words[0] === "--no-pager" ? words.slice(1) : words;
  if (command === "push") return "pushing";
  const spec = GIT[command ?? ""];
  if (!spec) return CANT;
  // (git confines its paths to the repository, so its words are checked as text.)
  return checkSpec(spec, rest, place);
}

// Settings a command's parts may set before them (`CI=1 git log`): none that change what runs.
const SAFE_SETTINGS = /^(CI|FORCE_COLOR|NO_COLOR|TZ|LANG|LC_ALL|TERM|GIT_PAGER|PAGER)=[A-Za-z0-9._:-]*$/;

/** Why a bot can't allow running `line` in the session's folder (`folders[0]`; its project's other
 * folders count as inside too), or null when every part of it is a program on its list, with
 * every flag on that program's list, reading and changing only what's inside. Until a plan the user
 * approved can name a command (phase 4), nothing that builds, tests or installs is a bot's to allow. */
export function commandRefusal(line: string, folders: readonly string[]): string | null {
  const read = readLine(line);
  if ("unreadable" in read) return `${CANT} (${read.unreadable})`;
  if (!read.parts.length || !folders.length) return CANT;
  const place: Place = { cwd: realPath(folders[0], "/"), folders };
  for (const part of read.parts) {
    let at = 0;
    while (at < part.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(part.words[at])) {
      if (!SAFE_SETTINGS.test(part.words[at])) return CANT;
      at++;
    }
    const [program, ...rest] = part.words.slice(at);
    if (!program) return CANT;
    // A program named by a path (a script of its own) runs what it can't see.
    if (program.includes("/")) return /(deploy|release|publish)/i.test(path.basename(program)) ? "releasing or deploying" : CANT;
    const known = PROGRAMS[program];
    if (!known) return NAMED[program] ?? CANT;
    const why = typeof known === "function" ? known(rest, place) : checkSpec(known, rest, place);
    if (why) return why;
    for (const target of part.writes) {
      const refused = pathRefusal(target, place, "write");
      if (refused) return refused;
    }
    // `cd` moves where the parts after it run.
    if (program === "cd") place.cwd = realPath(rest[0], place.cwd);
  }
  return null;
}

// What some programs are, for the words a refusal says.
const NAMED: Record<string, string> = {
  vercel: "deploying", netlify: "deploying", wrangler: "deploying", firebase: "deploying", fly: "deploying", flyctl: "deploying", heroku: "deploying", fastlane: "sending to a store", eas: "sending to a store",
  security: "your keys and sign-ins", ssh: "reaching another computer", scp: "reaching another computer", rsync: "reaching another computer",
  npx: "running a package's code", bunx: "running a package's code", pnpm: "building, testing or installing", yarn: "building, testing or installing", bun: "building, testing or installing",
  pip: "installing", pip3: "installing", go: "building, testing or installing", cargo: "building, testing or installing", make: "building, testing or installing",
  swift: "building, testing or installing", xcodebuild: "building, testing or installing", pytest: "building, testing or installing", pod: "installing", bundle: "installing", brew: "installing",
};

/** The parts of a command line as the engine's rules match each: its own text, part by part. */
export function partsOf(line: string): string[] {
  const read = readLine(line);
  return "unreadable" in read ? [line] : read.parts.map(part => part.text);
}

// What a bot may allow besides a command: reading inside the project, editing there (never what
// later commands run), fetching pages, starting subagents. Anything else (outside the project, an
// integration's tool) is the user's.
const READS = new Set(["read", "list", "glob", "grep", "lsp", "codesearch"]);
const FREE = new Set(["webfetch", "websearch", "todowrite", "todoread", "question", "subagent", "task", "doom_loop"]);
const EDITS = new Set(["edit", "write", "patch", "multiedit"]);

/** Why a bot can't allow what's asked (`action` on `resources`), within its `rules` (`rulesOf`),
 * for a session working in `folders`; null when it may. */
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
  if (!READS.has(action) && !EDITS.has(action) && !FREE.has(action)) return action === "external_directory" ? "working outside the project" : "a tool it can't tell is safe";
  const place: Place = { cwd: realPath(folders[0] ?? "/", "/"), folders };
  if (READS.has(action) || EDITS.has(action)) {
    for (const resource of asked) {
      // A pattern (`*`, `**/*.ts`) is the session's folder; a path, its real place.
      if (!folders.length) return "working outside the project";
      if (READS.has(action) && !resource.includes("/") && /[*?]/.test(resource)) continue;
      const why = pathRefusal(resource.replace(/\/\*+$/, "") || ".", place, EDITS.has(action) ? "write" : "read");
      if (why) return why;
    }
  }
  return asked.every(resource => ruleFor(rules, action, resource) === "allow") ? null : "above";
}
