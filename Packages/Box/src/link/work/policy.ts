// What a bot may allow its sessions (answer_ask, PROTOCOL.md "Work"). Where the session's commands
// run in the sandbox, which holds what they can write and read, a bot may allow its commands, but
// never one that acts beyond this computer with your accounts (pushing, publishing, deploying,
// reaching another computer). Elsewhere, the policy until the sandbox: reading a command can't be
// made airtight, so a bot answers only a handful of commands that read, with literal paths inside
// the folder. Either way, edits only inside the session's folder (never what a later command runs),
// as the engine makes them itself, outside the sandbox. Everything else goes to the user, however
// it's phrased.

import fs from "node:fs";
import path from "node:path";
import { gitIn } from "../git";
import { homeFolder, K } from "../home";
import type { KitRule } from "../bots/kit";
import type { ToolCallSeen } from "./answers";

/** A command line read as a shell would run it: its parts (separated by `;`, `&&`, `||`, `|` or a
 * new line), each one's words and where its output goes, and each part's own text. */
interface Line {
  parts: { words: string[]; writes: string[]; text: string }[];
}

/** Why a line can't be read as plain programs (something a shell expands or runs besides), or
 * the line. `redirects`: where its output goes or its input comes from is read too (in the sandbox,
 * which holds what's written), rather than refused. */
export function readLine(line: string, redirects = false): Line | { unreadable: string } {
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

/** Where a command runs, and the folders it may read and change things in. */
interface Place {
  cwd: string;
  folders: readonly string[];
}

const under = (full: string, folder: string) => full.startsWith(folder.endsWith("/") ? folder : folder + "/");
const realOf = (folder: string) => {
  try {
    return fs.realpathSync(folder);
  } catch {
    return path.resolve(folder);
  }
};

// Where your keys and sign-ins are: never a bot's to let a session read or change, wherever its
// folder is.
function isSecret(full: string): boolean {
  const home = realOf(homeFolder()).toLowerCase();
  const kuvo = realOf(K).toLowerCase();
  const secrets = [path.join(kuvo, "keys"), path.join(kuvo, "box"), path.join(kuvo, "run"), path.join(kuvo, "agents"), path.join(kuvo, "integrations"),
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".netrc", ".git-credentials", ".npmrc", ".pypirc", "library/keychains", ".claude", ".codex", ".grok"].map(name => path.join(home, name))];
  const lower = full.toLowerCase();
  return secrets.some(secret => lower === secret || under(lower, secret));
}

/** A path inside the session's folders as its parts below one of them, each a plain name, none a
 * link: or why it isn't one. Written plainly (letters, digits, `.`, `_`, `-`, `/`), never `..`,
 * never a part starting with `.` (git's, settings, `.env`), never through a link (a link may lead
 * anywhere, and `..` after one goes where the link leads). Compared without case, as macOS does. */
function partsInside(target: string, place: Place): { folder: string; parts: string[] } | { refused: string } {
  if (!/^[A-Za-z0-9._/-]+$/.test(target)) return { refused: "a path it can't read plainly" };
  const folders = place.folders.map(realOf);
  // Written in full: from one of the folders (as named, or as its real place).
  let folder: string | undefined, rest: string;
  if (target.startsWith("/")) {
    const named = [...place.folders.map(each => path.resolve(each)), ...folders];
    const from = named.find(each => target === each || under(target, each));
    if (!from) return { refused: "reading outside the project" };
    folder = folders[named.indexOf(from) % folders.length] ?? realOf(from);
    rest = target.slice(from.length);
  } else {
    folder = realOf(place.cwd);
    rest = target;
  }
  const parts = rest.split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.startsWith("."))) return { refused: "a hidden or parent path" };
  let at = folder;
  for (const part of parts) {
    at = path.join(at, part);
    let link = false;
    try { link = fs.lstatSync(at).isSymbolicLink(); } catch { break; }
    if (link) return { refused: "a path through a link" };
  }
  if (isSecret(path.join(folder, ...parts))) return { refused: "your keys and sign-ins" };
  return { folder, parts };
}

/** Why `target` can't be read by a command a bot allows, or null. */
export function readRefusal(target: string, place: Place): string | null {
  const inside = partsInside(target, place);
  return "refused" in inside ? inside.refused : null;
}

// What a bot may let a session write, until the sandbox: source and text files, by their extension,
// none of them a file a later command runs or reads as settings. Anything else is the user's.
const EDITABLE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "swift", "kt", "kts", "java", "scala", "c", "h", "cc", "cpp", "hpp", "m", "mm", "cs", "php",
  "dart", "lua", "ex", "exs", "erl", "hs", "ml", "clj", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "md", "mdx", "txt", "rst", "json", "yaml", "yml",
  "csv", "tsv", "sql", "graphql", "gql", "svg", "xcstrings", "strings"]);
const PROTECTED_NAMES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "tsconfig.json", "jsconfig.json",
  "opencode.json", "opencode.jsonc", "composer.json", "deno.json", "deno.jsonc", "app.json", "eas.json", "firebase.json", "vercel.json", "turbo.json", "nx.json", "lerna.json", "angular.json",
  "project.json", "workspace.json", "renovate.json", "nodemon.json", "devcontainer.json", "cmakelists.txt", "requirements.txt", "constraints.txt", "build.rs", "conftest.py", "setup.py",
  "manage.py", "noxfile.py", "fabfile.py", "tasks.py", "dodo.py", "package.swift", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "taskfile.yml", "taskfile.yaml",
  "azure-pipelines.yml", "bitbucket-pipelines.yml", "appveyor.yml", "mkdocs.yml", "pubspec.yaml", "codemagic.yaml", "bitrise.yml", "lefthook.yml", "lefthook.yaml", "dangerfile.swift",
  "gems.rb", "agents.md", "claude.md", "gemini.md"]);
const PROTECTED_PATTERN = /(^|\.)(config|conf|workspace|setup|rc|override)\.|-local\.|requirements[^/]*\.txt$|^tsconfig\..*\.json$|^(rakefile|taskfile|gatsby-)|^(gulpfile|gruntfile|jakefile|dangerfile|fastfile|appfile|matchfile|pluginfile|webpack|vite|rollup|esbuild|tsup|metro|babel|jest|vitest|karma|playwright|cypress|next|nuxt|astro|svelte|remix|tailwind|postcss|eslint|prettier|stylelint|commitlint|lint-staged|release|mocha|nodemon|pm2|ecosystem|wrangler|vercel|netlify|serverless)\b/;
const PROTECTED_FOLDERS = new Set(["node_modules", "hooks", "refs", "objects", "info", "fastlane", "gradle", "buildsrc", "requirements"]);

/** Why a bot can't let a session write `target` (making it, or changing it), or null. */
export function editRefusal(target: string, place: Place): string | null {
  const inside = partsInside(target, place);
  if ("refused" in inside) return inside.refused === "reading outside the project" ? "changing files outside the project" : inside.refused;
  const { folder, parts } = inside;
  // A file, made or changed: never a folder (one named like a file, `x.md`, included).
  try {
    if (fs.lstatSync(path.join(folder, ...parts)).isDirectory()) return "a folder, not a file";
  } catch {}
  const name = (parts[parts.length - 1] ?? "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (!EDITABLE.has(extension)) return "a kind of file it can't tell is safe to change";
  if (PROTECTED_NAMES.has(name) || PROTECTED_PATTERN.test(name) || parts.slice(0, -1).some(part => PROTECTED_FOLDERS.has(part.toLowerCase()))) return "changing a file that later commands run";
  return null;
}

const CANT = "a command it can't tell is safe";

/** What a program may be given, until the sandbox: its flags (each taking a number, or nothing), the
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
      const why = readRefusal(word, place);
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
 * The policy until the sandbox: a bot may allow only a handful of commands that read
 * (`ls`, `cat`, `head`, `tail`, `wc`, and `git status`, `diff` and `log` with a few options), each
 * part of the line one of those, with literal paths inside the session's folder, and nothing
 * else: no redirects, no patterns of files, no settings before it, nothing a shell expands or runs
 * besides. Reading a command can't be made airtight, so everything else goes to the user until
 * the sandbox. */
export function commandRefusal(line: string, folders: readonly string[]): string | null {
  // What a shell would split on, or take apart, beyond a space: never.
  if (!/^[\x20-\x7E]*$/.test(line)) return `${CANT} (a character it can't read plainly)`;
  const read = readLine(line);
  if ("unreadable" in read) return `${CANT} (${read.unreadable})`;
  if (!read.parts.length || !folders.length) return CANT;
  const place: Place = { cwd: realOf(folders[0]), folders };
  for (const part of read.parts) {
    const [program, ...rest] = part.words;
    if (!program || program.includes("=")) return CANT;
    if (program === "git") {
      if (rest[0] === "push") return "pushing";
      // Only the session folder's own repository: never one above it (a parent's, your home's).
      if (gitIn(place.cwd, ["rev-parse", "--show-toplevel"]) !== place.cwd) return "a repository that isn't the project's own";
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

// Programs that run the one after them, which counts as the command's.
const WRAPPERS = new Set(["sudo", "doas", "env", "nohup", "time", "exec", "command", "nice", "xargs", "timeout", "npx", "bunx", "pnpx", "uvx"]);
// What acts beyond this computer with your accounts, whatever the sandbox holds here.
const OUTWARD: Record<string, string> = {
  ...Object.fromEntries(Object.entries(NAMED).filter(([, what]) => ["deploying", "sending to a store", "your keys and sign-ins", "reaching another computer"].includes(what))),
  sftp: "reaching another computer", ftp: "reaching another computer", gh: "using your GitHub account", glab: "using your GitLab account",
};

// Programs that run code given on their command line (`sh -c`, `node -e`), which can't be read for
// what it does: with that, the user's to answer.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INLINE: Record<string, string[]> = {
  node: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval", "-p", "--print"], deno: ["eval"], python: ["-c"], python3: ["-c"],
  ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"], osascript: ["-e"], lua: ["-e"],
};
// Package managers whose `run <script>` (or, for some, the script's name alone) runs a script of the
// project's: read by the script's name.
const RUNS_SCRIPTS = new Set(["npm", "pnpm", "yarn", "bun"]);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i;
// curl's and wget's options that send something, rather than fetch (with what they send in the same
// word, `-d@file`, or not).
const SENDS = /^(-[a-zA-Z]*[TFdX]|--upload-file|--form|--data|--json|--post-(data|file)|--body-(data|file)|--request|--method)/;

// Package runners' commands that run a package's program, which counts as the command's (`npm exec
// vercel`, `pnpm dlx`, `bun x`).
const RUNNERS: Record<string, string[]> = { npm: ["exec", "x"], pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], bun: ["x"] };
// find's options that run a command of their own on what it finds.
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// A program's commands that send beyond this computer, wherever they are among its words, whatever
// options come before (`npm --prefix . publish`, `git --git-dir .git push`, `git subtree push`).
const SENDING: Record<string, string> = {
  push: "sending it beyond this computer", upload: "sending it beyond this computer", publish: "publishing", deploy: "releasing or deploying",
  "send-pack": "pushing", "send-email": "pushing", "http-push": "pushing", dcommit: "pushing",
};
// Programs that only read or print their words, whatever they say (`grep -r deploy`).
const QUIET = new Set(["grep", "rg", "ag", "echo", "printf", "cat", "ls", "head", "tail", "wc", "sort", "uniq", "diff", "file", "stat", "du", "which", "type", "man", "jq", "less", "tree"]);
// The options a wrapper may have and still plainly run the program after it; any other (`env -u`,
// `sudo -u`, `timeout -s`) takes a value that could be read as that program.
const BARE: Record<string, RegExp> = {
  npx: /^(-y|--yes|-q|--quiet)$/, bunx: /^--bun$/, timeout: /^([0-9.]+[smhd]?|--foreground|--preserve-status|-v|--verbose)$/,
  nice: /^(-n|-?[0-9]+)$/, env: /^(-i|--ignore-environment)$/, time: /^-p$/, command: /^-p$/,
};
// git's own settings and hooks, which a command in the project can name or write (on Linux the
// sandbox doesn't keep them, as macOS's does): what git runs next isn't on the line.
const GIT_OWN = /(^|\/)\.git(\/|$)|(^|\/)\.git(config|modules)$/;
// git's own options that take the next word as their value.
const GIT_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--exec-path)$/;
// What `git config` only reads with (`--get`, `--list`, or `git config get`), and what writes even then.
const GIT_CONFIG_READS = /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/;
const GIT_CONFIG_WRITES = /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|--edit|-e)$/;
// `git config`'s own options that take the next word as their value (so `--default get` isn't `get`).
const GIT_CONFIG_VALUED = /^(-f|--file|--blob|--type|--default|--comment|--value|--url)$/;

/** Whether git's words set its own settings, or carry them in (a clone's `--config`, a template's
 * hooks): what git runs next (`core.hooksPath`, `core.fsmonitor`, an alias) isn't on the line. */
function setsGitSettings(rest: string[]): boolean {
  let at = 0;
  while (at < rest.length && rest[at].startsWith("-")) at += GIT_VALUED.test(rest[at]) ? 2 : 1;
  const [sub, ...args] = rest.slice(at);
  if (sub === "config") return gitConfigSets(args);
  return (sub === "clone" || sub === "init" || sub === "submodule") && args.some(word => /^--(config|template)(=|$)/.test(word));
}

/** Whether `git config`'s words (past `config`) change a setting, rather than read one: in either
 * syntax, past its options that take a value. */
export function gitConfigSets(args: string[]): boolean {
  const words: string[] = [];
  let reads = false;
  for (let at = 0; at < args.length; at++) {
    const word = args[at];
    if (word === "--") {
      words.push(...args.slice(at + 1));
      break;
    }
    if (GIT_CONFIG_VALUED.test(word)) at++;
    else if (GIT_CONFIG_WRITES.test(word)) return true;
    else if (GIT_CONFIG_READS.test(word)) reads = true;
    else if (!word.startsWith("-")) words.push(word);
  }
  const [first] = words;
  if (first === "get" || first === "list") return false;
  if (["set", "unset", "rename-section", "remove-section", "edit"].includes(first)) return true;
  // The older way: a key alone reads it, a key and a value set it.
  return !reads && words.length > 1;
}

/** Why a bot can't allow a command even in the sandbox: it pushes, publishes, deploys, uploads or
 * reaches another computer, or runs code that can't be read (a shell's `-c`, `node -e`), or can't be
 * read plainly at all; or null. Whatever it can't be sure of is the user's to answer. */
export function outwardRefusal(line: string): string | null {
  const read = readLine(line, true);
  if ("unreadable" in read) return `${CANT} (${read.unreadable})`;
  for (const part of read.parts) {
    if (part.writes.some(each => GIT_OWN.test(each))) return `${CANT} (it changes git's own settings)`;
    const why = outwardWords(part.words);
    if (why) return why;
  }
  return null;
}

// One command's words, as `outwardRefusal` reads them (and the command a runner or find runs, alike).
function outwardWords(words: string[]): string | null {
  for (;;) {
    const first = words[0];
    if (first === undefined) return null;
    // git's settings, given before it, can name what it runs (an alias, an SSH command, a diff tool).
    if (/^GIT_[A-Za-z0-9_]*=/.test(first)) return CANT;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      words = words.slice(1);
      continue;
    }
    const wrapper = path.basename(first);
    // (What xargs runs takes its words from elsewhere.)
    if (wrapper === "xargs") return CANT;
    if (!WRAPPERS.has(wrapper)) break;
    words = words.slice(1);
    for (; words.length && (words[0].startsWith("-") || /^[0-9]/.test(words[0])); words = words.slice(1)) {
      if (words[0] === "--") continue;
      if (!BARE[wrapper]?.test(words[0])) return CANT;
    }
  }
  const [program, ...given] = words;
  // (`git-config`, `/usr/lib/git-core/git-push`: git's own commands by their programs.)
  const gitOwn = /^git-([a-z][a-z0-9-]*)$/.exec(path.basename(program));
  const name = gitOwn ? "git" : path.basename(program);
  const rest = gitOwn ? [gitOwn[1], ...given] : given;
  if (OUTWARD[name]) return OUTWARD[name];
  if (name === "eval") return "running a command it can't read";
  if (SHELLS.has(name) && (rest.length === 0 || rest.some(word => /^-[a-zA-Z]*c/.test(word)))) return "running a command it can't read";
  if (INLINE[name] && rest.some(word => INLINE[name].includes(word))) return "running code it can't read";
  if (words.some(word => GIT_OWN.test(word))) return `${CANT} (it changes git's own settings)`;
  // A program or script named for releasing (`./deploy.sh`, `node scripts/release.js`).
  if ([program, ...rest].some(word => !word.startsWith("-") && /(deploy|release|publish)/i.test(path.basename(word)) && (word === program || /\.[a-z]+$/i.test(word)))) return "releasing or deploying";
  // Building an image and sending it on (`docker buildx build --push`, `--output type=registry`).
  if (rest.some(word => /^--push(=|$)/.test(word) || /(^|[=,])(type=registry|push=true)(,|$)/.test(word))) return "sending it beyond this computer";
  // git's settings on its line can name what one of its commands runs.
  if (name === "git" && rest.some(word => /^(-c|--config-env)/.test(word))) return CANT;
  if (name === "git" && setsGitSettings(rest)) return `${CANT} (it changes git's own settings)`;
  const subs = rest.filter(word => !word.startsWith("-"));
  if (!QUIET.has(name)) {
    // (`git stash push` keeps your changes aside, here.)
    const sending = subs.find((word, at) => Object.hasOwn(SENDING, word) && !(name === "git" && subs[at - 1] === "stash"));
    if (sending) return name === "git" ? "pushing" : SENDING[sending];
  }
  if (name === "git" && subs.includes("p4") && subs.includes("submit")) return "pushing";
  if ((subs[0] === "release" && name !== "git") || (name === "xcrun" && subs.some(word => word === "altool" || word === "notarytool"))) return subs[0] === "release" ? "releasing or deploying" : "sending to a store";
  // A project's script named for it (`npm run release`, `yarn --cwd app ship-release`).
  if (RUNS_SCRIPTS.has(name) && subs.some(word => /(deploy|release|publish|push|upload)/i.test(word))) return "releasing or deploying";
  // A package's program, run by a package runner: judged as that program; one given as a line of
  // its own (`npm exec -c`) can't be read.
  if (RUNNERS[name]) {
    if (rest.some(word => /^(-c|--call)(=|$)/.test(word))) return "running a command it can't read";
    const at = rest.findIndex(word => RUNNERS[name].includes(word));
    if (at >= 0) {
      let after = rest.slice(at + 1);
      for (; after[0]?.startsWith("-"); after = after.slice(1)) if (!/^(-y|--yes|--)$/.test(after[0])) return CANT;
      const why = outwardWords(after);
      if (why) return why;
    }
  }
  // What find runs on each thing it finds, up to its `;` or `+`.
  if (name === "find") {
    for (const [at, word] of rest.entries()) {
      if (!FIND_RUNS.has(word)) continue;
      const after = rest.slice(at + 1);
      const end = after.findIndex(each => each === ";" || each === "+");
      const why = outwardWords(end < 0 ? after : after.slice(0, end));
      if (why) return why;
    }
  }
  // (To this computer's own servers, as a test does, it may.)
  if ((name === "curl" || name === "wget") && rest.some(word => SENDS.test(word))) {
    const targets = rest.filter(word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || LOCAL_URL.test(word) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(word));
    if (!targets.length || !targets.every(word => LOCAL_URL.test(word))) return "sending something beyond this computer";
  }
  return null;
}

/** The parts of a command line as the engine's rules match each: its own text, part by part. */
export function partsOf(line: string): string[] {
  const read = readLine(line);
  return "unreadable" in read ? [line] : read.parts.map(part => part.text);
}

const EDITS = new Set(["edit", "write", "patch", "multiedit"]);
// The tools that make or change files: an ask from any other tool (removing a worktree, say) isn't
// an edit, whatever it's asked as.
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

/** Why a bot can't allow what's asked (`action` on `resources`, by the tool call `seen`, whole),
 * within its `rules` (`rulesOf`), for a session working in `folders`; null when it may.
 *
 * Until the sandbox, a bot answers only two kinds of ask, judged by the tool call itself (never
 * only what the engine lists in the ask, which leaves out a command's `cd` and the folder it runs
 * in): making or changing a source or text file inside the session's folder (`editRefusal`: by
 * extension, never a hidden path, a link, a folder, nor a file a later command runs or reads as
 * settings), and the few commands `commandRefusal` reads as safe, run in the session's folder.
 * Everything else, reading included, goes to the user. */
export function allowRefusal(action: string, resources: readonly string[], folders: readonly string[], rules: readonly KitRule[], ruleFor: (rules: readonly KitRule[], action: string, resource: string) => KitRule["effect"], seen: ToolCallSeen | null, sandboxed = false): string | null {
  const asked = resources.length ? resources : ["*"];
  if (!folders.length) return "working outside the project";
  if (action === "shell" || action === "bash") {
    // The command as it would run, whole, and where.
    const command = typeof seen?.input.command === "string" ? seen.input.command : null;
    if (!command) return `${CANT} (it can't see the whole command)`;
    // In the sandbox (which writes only in the session's folder, wherever it runs): anything but
    // what acts beyond this computer, within the engine's rules.
    if (sandboxed) {
      for (const line of [command, ...asked.filter(each => each !== "*")]) {
        const why = outwardRefusal(line);
        if (why) return why;
      }
      return [...partsOf(command), ...asked].every(part => ruleFor(rules, action, part) === "allow") ? null : "above";
    }
    const where = [seen!.input.workdir, seen!.input.cwd, seen!.input.directory].find(each => each !== undefined && each !== null && each !== "");
    if (where !== undefined && (typeof where !== "string" || realOf(path.resolve(realOf(folders[0]), where)) !== realOf(folders[0]))) return "a command run somewhere other than the project";
    for (const line of [command, ...asked.filter(each => each !== "*")]) {
      const why = commandRefusal(line, folders);
      if (why) return why;
    }
    // The engine's rules, for each part as it judges each.
    if (![...partsOf(command), ...asked].every(part => ruleFor(rules, action, part) === "allow")) return "above";
    return null;
  }
  if (!EDITS.has(action)) return action === "external_directory" ? "working outside the project" : "a tool it can't tell is safe";
  if (!seen || !EDIT_TOOLS.has(seen.tool.toLowerCase())) return "a tool it can't tell is safe";
  const place: Place = { cwd: realOf(folders[0]), folders };
  const named = [seen.input.filePath, seen.input.path, seen.input.file].filter((each): each is string => typeof each === "string");
  for (const target of [...asked, ...named]) {
    const why = editRefusal(target, place);
    if (why) return why;
  }
  return asked.every(resource => ruleFor(rules, action, resource) === "allow") ? null : "above";
}
