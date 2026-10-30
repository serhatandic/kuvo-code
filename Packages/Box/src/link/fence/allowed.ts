// Also Allowed (PROTOCOL.md, "Sandbox"): what you let a project's commands do beyond the sandbox,
// from an ask's Always for This or added in Settings: a folder (or file) its commands write in the
// sandbox. Kept in the box's own folder, which nothing in a project can write. (Never a command
// that runs outside it without asking: what a command runs, its scripts and its project's settings,
// is what the sandbox writes.)
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
    return Array.isArray(kept?.allowed) ? kept.allowed.filter((rule: SandboxRule) => rule && typeof rule.id === "string" && typeof rule.project === "string" && rule.kind === "write" && typeof rule.path === "string") : [];
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
  for (const rule of rules) byProject.set(projectSum(rule.project), [...(byProject.get(projectSum(rule.project)) ?? []), rule.path]);
  fs.mkdirSync(FOR_LAUNCHER, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(FOR_LAUNCHER)) if (!byProject.has(name)) fs.rmSync(path.join(FOR_LAUNCHER, name), { force: true });
  for (const [sum, folders] of byProject) writePrivate(path.join(FOR_LAUNCHER, sum), folders.slice(0, MOST_FOLDERS).join("\n") + "\n");
}

const inside = (child: string, top: string) => child === top || child.startsWith(top === "/" ? "/" : top + "/");

// The system's own folders, and where installed programs live: what's there runs later, outside the
// sandbox.
const SYSTEM = ["/bin", "/sbin", "/usr", "/opt", "/etc", "/var", "/nix", "/snap", "/boot", "/lib", "/lib64", "/root",
  "/System", "/Library", "/Applications", "/private/etc", "/private/var", "/cores"];
// In your home folder: your own programs (`~/bin`, `~/Applications`). Its hidden folders and
// `Library` are its settings, which the shells, git, SSH, the coding agents, editors and your login
// read: none of them is given, nor a folder inside one (the tools' caches the sandbox writes anyway).
const HOME_PROGRAMS = ["bin", "Applications"];
// Folders that hold what runs outside the sandbox when you work there: a repository's own folder,
// the engine's and the coding agents' settings. (Inside a folder given, the same files as in a
// project are kept from its commands: fence/seatbelt.ts.)
const SETTINGS_FOLDER = /^\.(git|opencode|claude|codex|cursor|gemini|grok)$/;

/** The folders on the box's PATH, by their real paths: programs that run later, outside the sandbox. */
const programFolders = () => (process.env.PATH ?? "").split(":").filter(folder => path.isAbsolute(folder)).map(realish);

/** A folder (or file) that may be given to a project's commands: one of your projects, or a folder
 * of your own on a drive; never one of Kuvo Code's own, a secret or a folder that holds one, your home
 * folder, its settings, the system's folders, programs on your PATH or the whole disk. */
function checkedPath(given: unknown): string {
  if (typeof given !== "string" || !path.isAbsolute(given) || given.includes("\n")) throw new RuleRefusal("Name the folder by its full path.");
  const where = realish(given);
  const policy = fencePolicy();
  // (Your account's own home folder, the one the sandbox hides secrets in and the box's HOME, where a
  // test's is another; the nearest first.)
  const homes = [...new Set([policy.home, realish(accountHome()), ...(process.env.HOME ? [realish(process.env.HOME)] : [])])].sort((a, b) => b.length - a.length);
  if (where === "/" || homes.includes(where)) throw new RuleRefusal("That's too much to give: name a folder inside it.");
  if (policy.kuvo.some(folder => inside(where, folder) || inside(folder, where)) || policy.kuvoPatterns.some(pattern => new RegExp(pattern).test(where + "/"))) {
    throw new RuleRefusal("Kuvo Code's own folders stay out of the sandbox.");
  }
  if (policy.secrets.some(secret => inside(where, secret) || inside(secret, where))) throw new RuleRefusal("That's where your secrets are kept: it stays out of the sandbox.");
  const later = "What's there runs later, outside the sandbox: it can only be allowed once.";
  const inHome = homes.find(home => inside(where, home));
  if (inHome) {
    const first = path.relative(inHome, where).split("/")[0];
    if (first.startsWith(".") || first === "Library" || HOME_PROGRAMS.includes(first)) throw new RuleRefusal(later);
  } else if (SYSTEM.some(folder => inside(where, folder) || inside(where, realish(folder)))) {
    throw new RuleRefusal(later);
  }
  if (where.split("/").some(name => SETTINGS_FOLDER.test(name))) throw new RuleRefusal(later);
  if ([...programFolders(), ...policy.readOnly].some(place => inside(where, place) || inside(place, where))) throw new RuleRefusal(later);
  return where;
}

/** Adds a rule; the same one again is the one there already. */
export function addRule(given: { project?: unknown; kind?: unknown; path?: unknown; by?: string }): SandboxRule {
  if (typeof given.project !== "string" || !path.isAbsolute(given.project)) throw new RuleRefusal("Name the project by its folder's full path.");
  if (given.kind !== "write") throw new RuleRefusal("Send {project, kind: \"write\", path}: a folder its commands may write in.");
  const project = realProject(given.project);
  const rules = readAllowed();
  const where = checkedPath(given.path);
  const same = rules.find(each => each.project === project && each.path === where);
  if (same) return same;
  if (rules.filter(each => each.project === project).length >= MOST_FOLDERS) throw new RuleRefusal(`A project's commands can be given at most ${MOST_FOLDERS} folders: remove one first.`);
  const rule: SandboxRule = { id: newID("al_"), project, kind: "write", path: where, at: Date.now(), ...(given.by ? { by: given.by } : {}) };
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
