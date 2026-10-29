// Also Allowed (PROTOCOL.md, "Sandbox"): what you let a project's commands do beyond the sandbox,
// from an ask's Always for This or added in Settings. A folder (or file) its commands write in the
// sandbox (`write`), or a command that runs outside it without asking (`outside`, by its first
// words). Kept in the box's own folder, which nothing in a project can write.
//
// The launcher takes a project's folders as each command starts, from a file of their own for that
// project in the sandbox's folder (`run/fence/allowed/<sum>`, one path a line, its name the same sum
// of the project's folder the launcher makes for its temporary files).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SandboxRule } from "../../shared/routes/sandbox";
import { newID } from "../../shared/text";
import { writePrivate } from "../files";
import { accountHome, BOX, RUN } from "../home";
import { fencePolicy, realish } from "./policy";

const FILE = path.join(BOX, "sandbox-allowed.json");
const FOR_LAUNCHER = path.join(realish(path.join(RUN, "fence")), "allowed");
/** How many folders a project's commands may be given: the profile's places for them on a Mac. */
export const MOST_FOLDERS = 8;

/** A refusal a client is told (400). */
export class RuleRefusal extends Error {}

const realProject = (project: string) => {
  try { return fs.realpathSync(project); } catch { return path.resolve(project); }
};

/** The launcher's name for a project's folder (its real path), as `sha256sum | cut -c 1-32` makes it. */
export const projectSum = (project: string) => crypto.createHash("sha256").update(realProject(project)).digest("hex").slice(0, 32);

export function readAllowed(): SandboxRule[] {
  try {
    const kept = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(kept?.allowed) ? kept.allowed.filter((rule: SandboxRule) => rule && typeof rule.id === "string" && typeof rule.project === "string") : [];
  } catch {
    return [];
  }
}

/** A project's rules (any project's with none named), oldest first. */
export function allowedFor(project?: string): SandboxRule[] {
  const all = readAllowed();
  if (!project) return all;
  const real = realProject(project);
  return all.filter(rule => rule.project === real);
}

function keep(rules: SandboxRule[]): void {
  writePrivate(FILE, JSON.stringify({ allowed: rules }, null, 2) + "\n");
  tellLauncher(rules);
}

/** Each project's folders, where the launcher reads them; the files of projects with none gone. */
export function tellLauncher(rules: SandboxRule[] = readAllowed()): void {
  const byProject = new Map<string, string[]>();
  for (const rule of rules) if (rule.kind === "write" && rule.path) byProject.set(projectSum(rule.project), [...(byProject.get(projectSum(rule.project)) ?? []), rule.path]);
  fs.mkdirSync(FOR_LAUNCHER, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(FOR_LAUNCHER)) if (!byProject.has(name)) fs.rmSync(path.join(FOR_LAUNCHER, name), { force: true });
  for (const [sum, folders] of byProject) writePrivate(path.join(FOR_LAUNCHER, sum), folders.slice(0, MOST_FOLDERS).join("\n") + "\n");
}

const inside = (child: string, top: string) => child === top || child.startsWith(top === "/" ? "/" : top + "/");

// What runs later, outside the sandbox, from your home folder: shells' startup files, what SSH, git
// and the coding agents read as they start, what your login starts, programs on your PATH. Never
// given to a project's commands, nor a folder that holds one: that would be a way out.
const RUNS_LATER = [".ssh", ".gnupg", ".profile", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".zshrc", ".zshenv",
  ".zprofile", ".zlogin", ".zlogout", ".config/fish", ".config/nushell", ".inputrc", ".gitconfig", ".config/git", ".claude",
  ".claude.json", ".codex", ".cursor", ".gemini", ".grok", ".config/opencode", ".local/bin", "bin", ".config/autostart",
  ".config/systemd", ".config/environment.d", "Library/LaunchAgents", "Library/Application Scripts", ".tmux.conf", ".vimrc",
  ".config/nvim", ".emacs", ".emacs.d", ".npmrc", ".pip", ".config/pip", ".gemrc", ".curlrc", ".wgetrc", ".pam_environment", ".xprofile",
  ".xinitrc", ".xsession"];

/** A folder (or file) that may be given to a project's commands: never one of Kuvo Code's own, a
 * secret or a folder that holds one, your home folder or the whole disk. */
function checkedPath(given: unknown): string {
  if (typeof given !== "string" || !path.isAbsolute(given) || given.includes("\n")) throw new RuleRefusal("Name the folder by its full path.");
  const where = realish(given);
  const policy = fencePolicy();
  // (The home folder the sandbox hides secrets in: your account's own.)
  const home = policy.home;
  if (where === "/" || where === home) throw new RuleRefusal("That's too much to give: name a folder inside it.");
  if (policy.kuvo.some(folder => inside(where, folder) || inside(folder, where)) || policy.kuvoPatterns.some(pattern => new RegExp(pattern).test(where + "/"))) {
    throw new RuleRefusal("Kuvo Code's own folders stay out of the sandbox.");
  }
  if (policy.secrets.some(secret => inside(where, secret) || inside(secret, where))) throw new RuleRefusal("That's where your secrets are kept: it stays out of the sandbox.");
  // (In your account's own home too, where a test's HOME is another.)
  const homes = [...new Set([home, realish(accountHome())])];
  if (homes.includes(where)) throw new RuleRefusal("That's too much to give: name a folder inside it.");
  const later = [...homes.flatMap(each => RUNS_LATER.map(name => realish(path.join(each, name)))), ...policy.readOnly];
  if (later.some(place => inside(where, place) || inside(place, where))) throw new RuleRefusal("What's there runs later, outside the sandbox: it can only be allowed once.");
  return where;
}

// Programs that run whatever they're given: allowed always only with what they run (`node build.js`,
// `npx prisma`), never by their name alone.
const RUNNERS = new Set(["sh", "bash", "zsh", "dash", "fish", "env", "sudo", "doas", "xargs", "eval", "exec", "nohup", "time", "command", "nice", "timeout", "watch",
  "node", "python", "python3", "ruby", "perl", "php", "deno", "bun", "npx", "bunx", "pnpx", "uvx", "osascript", "open"]);

/** The command's first words, for an `outside` rule: its program, and what it's asked to do when
 * that's a word of its own (`npm install`, `git push`, `./scripts/setup.sh`); null for a command that
 * isn't simple (one chained to another, piped, redirected, with a command inside it, or one that
 * runs whatever it's given), which can only be allowed once. */
export function prefixOf(command: string): string | null {
  const text = command.trim();
  if (!text || /[;&|<>`\n\r\\'"]|\$\(/.test(text)) return null;
  const [first, second] = text.split(/\s+/);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  const own = second !== undefined && !second.startsWith("-");
  if (RUNNERS.has(path.basename(first))) return own ? `${first} ${second}` : null;
  return own ? `${first} ${second}` : first;
}

/** Whether `command` is one an `outside` rule's `prefix` allows: a simple command that starts with it. */
export function matches(prefix: string, command: string): boolean {
  if (prefixOf(command) === null) return false;
  const words = command.trim().split(/\s+/);
  const wanted = prefix.split(" ");
  return wanted.every((word, at) => words[at] === word);
}

/** The `outside` rule of `project` that allows `command`, if one does. */
export const outsideRuleFor = (project: string, command: string) =>
  allowedFor(project).find(rule => rule.kind === "outside" && rule.prefix && matches(rule.prefix, command)) ?? null;

/** Adds a rule; the same one again is the one there already. */
export function addRule(given: { project?: unknown; kind?: unknown; path?: unknown; prefix?: unknown; by?: string }): SandboxRule {
  if (typeof given.project !== "string" || !path.isAbsolute(given.project)) throw new RuleRefusal("Name the project by its folder's full path.");
  const project = realProject(given.project);
  const rules = readAllowed();
  let rule: SandboxRule;
  if (given.kind === "write") {
    const where = checkedPath(given.path);
    const same = rules.find(each => each.project === project && each.kind === "write" && each.path === where);
    if (same) return same;
    if (rules.filter(each => each.project === project && each.kind === "write").length >= MOST_FOLDERS) throw new RuleRefusal(`A project's commands can be given at most ${MOST_FOLDERS} folders: remove one first.`);
    rule = { id: newID("al_"), project, kind: "write", path: where, at: Date.now(), ...(given.by ? { by: given.by } : {}) };
  } else if (given.kind === "outside") {
    const prefix = typeof given.prefix === "string" ? prefixOf(given.prefix) : null;
    if (!prefix || prefix !== (given.prefix as string).trim()) throw new RuleRefusal("Name a command by its first words, with nothing chained to it.");
    const same = rules.find(each => each.project === project && each.kind === "outside" && each.prefix === prefix);
    if (same) return same;
    rule = { id: newID("al_"), project, kind: "outside", prefix, at: Date.now(), ...(given.by ? { by: given.by } : {}) };
  } else {
    throw new RuleRefusal("Send {project, kind: \"write\", path} or {project, kind: \"outside\", prefix}.");
  }
  keep([...rules, rule]);
  return rule;
}

/** Removes a rule: false for one that isn't there. */
export function removeRule(id: string): boolean {
  const rules = readAllowed();
  const left = rules.filter(rule => rule.id !== id);
  if (left.length === rules.length) return false;
  keep(left);
  return true;
}

/** A write rule for what Always would allow, checked as one added by hand would be; null for none. */
export function writeRuleWouldBe(where: string): string | null {
  try { return checkedPath(where); } catch { return null; }
}
