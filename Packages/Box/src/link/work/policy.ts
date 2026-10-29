// What a bot may allow its sessions (answer_ask, PROTOCOL.md "Work"), failing closed: a command it
// can read whole, every part of it, as programs from a known-safe set, with known-safe arguments,
// nothing a shell would expand or run besides, and every file it deletes or writes inside the
// session's folder. Anything it can't read that way goes to the user, however it's phrased. What it
// may allow besides a command (an edit, a read, a fetch) is a short list too; any other tool (an
// integration's, say) goes to the user.

import path from "node:path";
import { homeFolder } from "../home";
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

/** Where a command runs, and the folders it may change things in. */
interface Place {
  cwd: string;
  folders: readonly string[];
}

const written = (target: string) => target.replace(/^~(?=$|\/)/, homeFolder());
const resolved = (target: string, place: Place) => path.resolve(place.cwd, written(target));
const under = (full: string, folder: string) => full.startsWith(folder.endsWith("/") ? folder : folder + "/");

/** Whether `target` is inside the session's folders (strictly, for what's deleted). */
export function insideFolders(target: string, place: Place, strictly = false): boolean {
  if (target === "/dev/null") return !strictly;
  const full = resolved(target, place);
  return place.folders.some(folder => under(full, path.resolve(folder)) || (!strictly && full === path.resolve(folder)));
}

type Check = (rest: string[], place: Place) => string | null;

const CANT = "a command it can't tell is safe";
const flags = (rest: string[]) => rest.filter(word => word.startsWith("-"));
const plain = (rest: string[]) => rest.filter(word => !word.startsWith("-"));
const noneOf = (rest: string[], banned: RegExp): boolean => !rest.some(word => banned.test(word));

// Only reads, or writes nothing it's told to: fine with any arguments but these.
const reads = (banned?: RegExp): Check => rest => (banned && !noneOf(rest, banned) ? CANT : null);
// Changes files: every path it names inside the folders (and, for `strictly`, never the folders
// themselves).
const changes = (strictly: boolean): Check => (rest, place) => {
  // (`.*` may take in `..`.)
  if (plain(rest).some(target => /(^|\/)\.[*?[]/.test(target))) return CANT;
  return plain(rest).every(target => insideFolders(target, place, strictly)) ? null : strictly ? "deleting outside the project" : "changing files outside the project";
};

// A script its project names that's safe to run by name: building, testing, checking.
const SAFE_SCRIPTS = /^(test|tests|build|lint|typecheck|type-check|check|format|fmt|dev|start|compile|tsc|prettier|eslint)(:[a-z0-9-]+)?$/;
// Packages a package runner may fetch and run: compilers, linters, test runners.
const SAFE_PACKAGES: Record<string, (rest: string[]) => boolean> = {
  tsc: () => true, typescript: () => true, eslint: () => true, prettier: () => true, jest: () => true, vitest: () => true, knip: () => true, depcheck: () => true,
  biome: rest => ["check", "format", "lint", "ci"].includes(plain(rest)[0] ?? ""), "@biomejs/biome": rest => ["check", "format", "lint", "ci"].includes(plain(rest)[0] ?? ""),
  playwright: rest => ["test", "install"].includes(plain(rest)[0] ?? ""), "@playwright/test": rest => ["test", "install"].includes(plain(rest)[0] ?? ""),
  expo: rest => ["install", "doctor", "lint", "start", "export", "prebuild", "customize"].includes(plain(rest)[0] ?? ""),
  tailwindcss: () => true, "@tailwindcss/cli": () => true,
};

/** What a package runner runs (`npx tsc`, `bunx expo install`): a package from the safe list only,
 * named plainly (never `-p`/`--package`, nor a path or address). */
function runsPackage(rest: string[]): string | null {
  const at = rest.findIndex(word => !word.startsWith("-"));
  if (at < 0 || rest.slice(0, at).some(word => !/^(-y|--yes|--no-install|--quiet|-q)$/.test(word))) return CANT;
  const name = rest[at].replace(/(?<=.)@[^/]*$/, "");
  const check = SAFE_PACKAGES[name];
  if (!check) return /^(vercel|netlify|wrangler|firebase(-tools)?|eas(-cli)?|surge|gh-pages|np|release-it|semantic-release|changeset)$/.test(name) ? "deploying or publishing" : CANT;
  return check(rest.slice(at + 1)) ? null : CANT;
}

// npm, pnpm, yarn and bun: installing, testing and running a safe script; their runners as above.
function packageManager(program: string): Check {
  return rest => {
    const [first, ...more] = rest.filter(word => !/^(--silent|-s|--loglevel=\w+|--frozen-lockfile|--prefer-offline)$/.test(word));
    if (first === undefined || ["--version", "-v", "ls", "list", "outdated", "view", "info", "why", "audit", "doctor"].includes(first)) return first === "audit" && more.includes("fix") ? CANT : null;
    if (["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade"].includes(first)) return more.some(word => /^(--global|-g)$/.test(word)) ? "installing on the computer itself" : null;
    if (first === "test" || first === "t") return null;
    if (first === "publish" || (first === "pm" && more[0] === "publish")) return "publishing";
    if ((program === "npm" && first === "exec") || (program === "pnpm" && (first === "dlx" || first === "exec")) || (program === "yarn" && first === "dlx") || (program === "bun" && first === "x")) return runsPackage(more);
    const script = first === "run" || first === "run-script" ? more[0] : program === "yarn" || program === "pnpm" ? first : undefined;
    if (script !== undefined) return SAFE_SCRIPTS.test(script) ? null : /(deploy|release|publish)/i.test(script) ? "releasing or deploying" : CANT;
    return CANT;
  };
}

// git: what only changes this checkout, or reads; never pushing, its settings, or what runs a
// command of its own (`-c`, aliases, `--exec`, `--upload-pack`).
const GIT_SAFE = new Set(["status", "diff", "log", "show", "add", "commit", "checkout", "switch", "restore", "branch", "stash", "fetch", "pull", "merge", "rebase", "init", "rev-parse", "ls-files", "blame", "grep", "tag", "describe", "shortlog", "cherry-pick", "revert", "reset", "mv", "rm", "clean", "worktree", "remote", "config", "submodule", "reflog", "show-ref", "cat-file", "diff-tree", "merge-base", "rev-list", "count-objects", "version"]);
const git: Check = (rest, place) => {
  let at = 0;
  while (at < rest.length && rest[at].startsWith("-")) {
    if (rest[at] === "-C") {
      if (!rest[at + 1] || !insideFolders(rest[at + 1], place)) return "changing files outside the project";
      at += 2;
    } else if (["--no-pager", "--no-optional-locks", "--paginate", "-P"].includes(rest[at])) at++;
    else return CANT;
  }
  const command = rest[at];
  const args = rest.slice(at + 1);
  if (command === "push") return "pushing";
  if (!command || !GIT_SAFE.has(command)) return CANT;
  if (args.some(word => /^(--exec|--upload-pack|--receive-pack|--config|--ext-diff|--open-files-in-pager)/.test(word) || (command === "rebase" && /^-x/.test(word)))) return CANT;
  if (command === "remote" && !(args.length === 0 || ["-v", "show", "get-url"].includes(args[0]))) return CANT;
  if (command === "config" && !(args.length && args.every(word => /^(--get|--get-all|--list|-l|--show-origin|--local|--global)$/.test(word) || !word.startsWith("-")) && args.some(word => /^(--get|--get-all|--list|-l)$/.test(word)))) return CANT;
  if (command === "submodule" && !["status", "update", "init", "foreach"].includes(args[0] ?? "status")) return CANT;
  if (command === "submodule" && args[0] === "foreach") return CANT;
  if (command === "worktree" && !["list", "add", "prune"].includes(args[0] ?? "")) return CANT;
  return null;
};

// gh: only what reads.
const gh: Check = rest => {
  const [area, action] = plain(rest);
  if (area === "api") {
    if (plain(rest)[1] === "graphql") return CANT;
    return rest.some((word, at) => /^(-X|--method)$/.test(word) ? !/^get$/i.test(rest[at + 1] ?? "") : /^--method=(?!get$)/i.test(word) || /^-X(?!get$)./i.test(word) || /^(-f|-F|--field|--raw-field|--input)/.test(word)) ? "changing what's on GitHub" : null;
  }
  const reading: Record<string, string[]> = { pr: ["view", "list", "status", "diff", "checks"], issue: ["view", "list", "status"], run: ["view", "list", "watch"], repo: ["view"], release: ["view", "list"], workflow: ["view", "list"], auth: ["status"] };
  if (reading[area ?? ""]?.includes(action ?? "")) return null;
  return area && ["repo", "release", "pr", "secret", "workflow", "variable", "issue"].includes(area) ? "changing what's on GitHub" : CANT;
};

// What runs code from files it can't see, or reaches beyond the project: never on its own.
const PROGRAMS: Record<string, Check> = {
  ls: reads(), cat: reads(), head: reads(), tail: reads(), wc: reads(), echo: reads(), printf: reads(), pwd: reads(), which: reads(), whoami: reads(), date: reads(), true: reads(), false: reads(),
  test: reads(), "[": reads(), diff: reads(), cmp: reads(), uniq: reads(), cut: reads(), tr: reads(), jq: reads(), file: reads(), stat: reads(), du: reads(), df: reads(), tree: reads(),
  basename: reads(), dirname: reads(), realpath: reads(), nl: reads(), column: reads(), comm: reads(), md5: reads(), shasum: reads(), sha256sum: reads(), uname: reads(), sleep: reads(),
  grep: reads(), egrep: reads(), fgrep: reads(), rg: reads(/^--pre/), sort: reads(/^(-o|--output)/),
  find: reads(/^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/),
  // Printing lines only (`sed -n '1,40p' file`): never editing in place, nor a script that writes
  // or runs anything.
  sed: rest => {
    const options = rest.filter(word => word.startsWith("-"));
    const others = rest.filter(word => !word.startsWith("-"));
    if (!options.every(word => /^-[nEr]+$/.test(word)) || !others.length) return CANT;
    return /^([0-9]+(,([0-9]+|\$))?|\$|\/[^/]*\/)p$/.test(others[0]) ? null : CANT;
  },
  mkdir: changes(false), touch: changes(false), cp: changes(false), mv: changes(false), ln: changes(false), chmod: changes(false),
  rm: changes(true), rmdir: changes(true), unlink: changes(true),
  cd: (rest, place) => (rest.length === 1 && rest[0] !== "-" && insideFolders(rest[0], place) ? null : CANT),
  git, gh,
  npm: packageManager("npm"), pnpm: packageManager("pnpm"), yarn: packageManager("yarn"), bun: packageManager("bun"),
  npx: runsPackage, bunx: runsPackage,
  pip: rest => (["install", "list", "show", "freeze", "--version"].includes(plain(rest)[0] ?? rest[0] ?? "") && !rest.some(word => /^(--user|--target|-t|--prefix|--root)$/.test(word)) ? null : CANT),
  python: rest => python(rest), python3: rest => python(rest),
  node: rest => (rest.length === 1 && /^(-v|--version)$/.test(rest[0]) ? null : CANT),
  swift: rest => (["build", "test", "package", "--version"].includes(rest[0] ?? "") && (rest[0] !== "package" || ["resolve", "update", "describe", "show-dependencies", "dump-package"].includes(rest[1] ?? "")) ? null : CANT),
  xcodebuild: rest => (rest.some(word => /^-exportArchive$/.test(word)) ? "sending to a store" : null),
  xcrun: rest => (rest[0] === "simctl" && ["list", "boot", "install", "launch", "terminate", "shutdown", "io", "ui", "openurl", "get_app_container"].includes(rest[1] ?? "") ? null : rest[0] === "altool" || rest[0] === "notarytool" ? "sending to a store" : CANT),
  cargo: rest => (["build", "check", "test", "fmt", "clippy", "doc", "tree", "metadata", "add", "remove", "update", "fetch", "bench", "--version"].includes(rest[0] ?? "") ? null : rest[0] === "publish" ? "publishing" : CANT),
  go: rest => (["build", "test", "vet", "fmt", "list", "version", "env", "generate"].includes(rest[0] ?? "") || (rest[0] === "mod" && ["tidy", "download", "verify", "graph", "why"].includes(rest[1] ?? "")) ? (rest[0] === "generate" ? CANT : null) : CANT),
  make: rest => {
    const target = plain(rest)[0] ?? "";
    if (rest.some(word => /^(-f|--file|-C|--directory|-e)$/.test(word))) return CANT;
    return ["", "test", "build", "check", "lint", "all", "fmt", "format", "clean"].includes(target) ? null : /(deploy|release|publish)/i.test(target) ? "releasing or deploying" : CANT;
  },
  pod: rest => (["install", "update", "--version"].includes(rest[0] ?? "") ? null : rest[0] === "trunk" ? "publishing" : CANT),
  bundle: rest => (["install", "check", "--version"].includes(rest[0] ?? "") ? null : CANT),
  curl: (rest, place) => {
    if (rest.some(word => /^(-d|--data|--data-\w+|-F|--form|--form-string|-T|--upload-file|--json|-K|--config|-u|--user)/.test(word))) return CANT;
    if (rest.some((word, at) => /^(-X|--request)$/.test(word) ? !/^(get|head)$/i.test(rest[at + 1] ?? "") : /^-X(?!get$|head$)./i.test(word))) return CANT;
    const outputs = rest.flatMap((word, at) => (/^(-o|--output)$/.test(word) ? [rest[at + 1] ?? ""] : []));
    if (rest.some(word => /^(-O|--remote-name)/.test(word))) return null;
    return outputs.every(target => insideFolders(target, place)) ? null : "changing files outside the project";
  },
  docker: rest => (["ps", "images", "logs", "inspect", "version", "info"].includes(rest[0] ?? "") ? null : rest[0] === "push" ? "publishing" : CANT),
};

function python(rest: string[]): string | null {
  if (rest.length === 1 && /^(-V|--version)$/.test(rest[0])) return null;
  if (rest[0] !== "-m") return CANT;
  const [module, ...more] = rest.slice(1);
  if (["pytest", "unittest", "mypy", "ruff", "black", "py_compile", "compileall"].includes(module ?? "")) return null;
  if (module === "pip") return PROGRAMS.pip(more, { cwd: "/", folders: [] });
  if (module === "venv") return null;
  return CANT;
}

// Settings a command's parts may set before them (`CI=1 npm test`): none that change what runs.
const SAFE_SETTINGS = /^(CI|NODE_ENV|FORCE_COLOR|NO_COLOR|RUST_BACKTRACE|DEBUG|PORT|TZ|LANG|LC_ALL|TERM)=/;

/** Why a bot can't allow running `line` in `folder` (the session's; its project's other folders
 * count as inside too), or null when every part of it is a known-safe program, with known-safe
 * arguments, changing nothing outside. */
export function commandRefusal(line: string, folders: readonly string[]): string | null {
  const read = readLine(line);
  if ("unreadable" in read) return `${CANT} (${read.unreadable})`;
  if (!read.parts.length) return CANT;
  if (!folders.length) return CANT;
  const place: Place = { cwd: path.resolve(folders[0]), folders };
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
    const check = PROGRAMS[program];
    if (!check) return CANT;
    const why = check(rest, place);
    if (why) return why;
    if (!part.writes.every(target => insideFolders(target, place))) return "changing files outside the project";
    // `cd` moves where the parts after it run.
    if (program === "cd") place.cwd = resolved(rest[0], place);
  }
  return null;
}

/** The parts of a command line as the engine's rules match each: its own text, part by part. */
export function partsOf(line: string): string[] {
  const read = readLine(line);
  return "unreadable" in read ? [line] : read.parts.map(part => part.text);
}

// What a bot may allow besides a command: reading, editing files inside the project, fetching
// pages, starting subagents. Anything else (outside the project, an integration's tool) is the
// user's.
const READS = new Set(["read", "list", "glob", "grep", "webfetch", "websearch", "codesearch", "lsp", "todowrite", "todoread", "question"]);
const EDITS = new Set(["edit", "write", "patch", "multiedit"]);
const STARTS = new Set(["subagent", "task", "doom_loop"]);

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
  if (!READS.has(action) && !EDITS.has(action) && !STARTS.has(action)) return action === "external_directory" ? "working outside the project" : "a tool it can't tell is safe";
  if (EDITS.has(action) && !asked.every(resource => resource !== "*" && insideFolders(resource, { cwd: path.resolve(folders[0] ?? "/"), folders }))) return "changing files outside the project";
  return asked.every(resource => ruleFor(rules, action, resource) === "allow") ? null : "above";
}
