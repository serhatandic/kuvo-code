// Also Allowed (PROTOCOL.md, "Sandbox"): what you let a project's commands do beyond the sandbox,
// from an ask's Always or added in Settings: a folder (or file) its commands write in the
// sandbox. A bot's own folder and the chats' are projects here too, each rule listed by whose it is
// (`ownerOf`); a bot's go once it's no longer here (`forgetGoneBots`). Kept in the box's own folder,
// which nothing in a project can write, and changed only by the box's long-running process. (Never a command
// that runs outside it without asking: what a command runs, its scripts and its project's settings,
// is what the sandbox writes.)
//
// The launcher takes a project's folders as each command starts, from a file of their own for that
// project in the sandbox's folder (`run/fence/allowed/<sum>`, one path a line, its name the same sum
// of the project's folder the launcher makes for its temporary files).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SandboxOwner, SandboxRule } from "../../shared/routes/sandbox";
import { botHere } from "../bots/here";
import { newID } from "../../shared/text";
import { writePrivate } from "../files";
import { accountHome, BOTS, BOX, CHATS, RUN } from "../home";
import { askedAbout, fencePolicy, realish } from "./policy";

const FILE = path.join(BOX, "sandbox-allowed.json");
const FOR_LAUNCHER = path.join(realish(path.join(RUN, "fence")), "allowed");
/** How many folders a project's commands may be given: the profile's places for them on a Mac. */
export const MOST_FOLDERS = 8;

/** A refusal a client is told (400). */
export class RuleRefusal extends Error {}

/** A project's folder by its real path; a worktree of a repository (a session's branch) is its
 * repository's own folder, so it has the project's folders and Always there keeps them for it.
 * (Only one the repository names back, as the sandbox's plugin finds it.) */
/** A project's folder by where it really is, as its rules are kept. */
export const realProject = (project: string) => {
  let real: string;
  try { real = fs.realpathSync(project); } catch { return realish(project); }
  try {
    const named = fs.readFileSync(path.join(real, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!named) return real;
    const own = fs.realpathSync(path.resolve(real, named));
    if (path.basename(path.dirname(own)) !== "worktrees") return real;
    if (fs.realpathSync(fs.readFileSync(path.join(own, "gitdir"), "utf8").trim()) !== path.join(real, ".git")) return real;
    const common = fs.realpathSync(path.resolve(own, fs.readFileSync(path.join(own, "commondir"), "utf8").trim()));
    return path.basename(common) === ".git" && common === path.dirname(path.dirname(own)) ? path.dirname(common) : real;
  } catch {
    return real;
  }
};

/** The launcher's name for a project's folder (its real path), as `sha256sum | cut -c 1-32` makes it. */
const sumOf = (real: string) => crypto.createHash("sha256").update(real).digest("hex").slice(0, 32);

export function readAllowed(): SandboxRule[] {
  try {
    const kept = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(kept?.allowed) ? kept.allowed.filter((rule: SandboxRule) => rule && typeof rule.id === "string" && typeof rule.project === "string" && rule.kind === "write" && typeof rule.path === "string") : [];
  } catch {
    return [];
  }
}

/** A project's rules (any project's with none named), oldest first. */
export async function allowedFor(project?: string): Promise<SandboxRule[]> {
  const all = readAllowed();
  if (!project) return all;
  await askedAbout([project]);
  const real = realProject(project);
  return all.filter(rule => rule.project === real);
}

const BOT_ID = /^bot_[A-Za-z0-9]+$/;

/** Whose a conversation's folder is: the chats', a bot's own (its folder's workspace, by the name
 * it has now) or else a project's, by its folder's name. (macOS asked about it first: `askedAbout`.) */
export function ownerOf(project: string): SandboxOwner {
  const real = realProject(project);
  if (real === realish(CHATS)) return { kind: "chats", name: "Chats" };
  const [id, workspace, ...more] = path.relative(realish(BOTS), real).split(path.sep);
  if (BOT_ID.test(id) && workspace === "workspace" && !more.length) {
    return { kind: "bot", id, name: botHere(id)?.described.name || "A bot" };
  }
  return { kind: "project", name: path.basename(real) || real };
}

/** The rules as a client lists them: each with whose it is, and whether its folder is gone. */
export async function listed(rules: SandboxRule[]): Promise<SandboxRule[]> {
  await askedAbout(rules.map(rule => rule.project));
  const owners = new Map<string, { owner: SandboxOwner; gone: boolean }>();
  return rules.map(rule => {
    let known = owners.get(rule.project);
    if (!known) owners.set(rule.project, known = { owner: ownerOf(rule.project), gone: !fs.existsSync(rule.project) });
    return { ...rule, owner: known.owner, ...(known.gone ? { gone: true } : {}) };
  });
}

/** Those a client may add a folder for besides its projects: each bot here working in its own
 * folder (not a project), by name, then the chats. */
export function addableOwners(): SandboxOwner[] {
  const bots: SandboxOwner[] = [];
  let ids: string[] = [];
  try { ids = fs.readdirSync(BOTS).filter(id => BOT_ID.test(id)); } catch {}
  for (const id of ids) {
    const here = botHere(id);
    if (here && typeof here.described.project !== "string") bots.push({ kind: "bot", id, name: here.described.name });
  }
  bots.sort((a, b) => a.name.localeCompare(b.name));
  return [...bots, { kind: "chats", name: "Chats" }];
}

/** The folder a rule for `owner` is kept under: a bot's own (one here, in its own folder) or the
 * chats', made if it isn't yet (no chat yet), so it's kept by where it really is. */
export function folderOfOwner(owner: unknown): string {
  const given = owner && typeof owner === "object" ? owner as { kind?: unknown; id?: unknown } : {};
  const made = (folder: string) => (fs.mkdirSync(folder, { recursive: true, mode: 0o700 }), folder);
  if (given.kind === "chats") return made(CHATS);
  if (given.kind === "bot" && typeof given.id === "string" && BOT_ID.test(given.id)) {
    const here = botHere(given.id);
    if (!here) throw new RuleRefusal("That bot isn't on this computer any more.");
    if (typeof here.described.project === "string") throw new RuleRefusal(`${here.described.name} works in a project: add the folder for that project.`);
    return made(path.join(here.folder, "workspace"));
  }
  throw new RuleRefusal("Name whose it is: {kind: \"bot\", id} or {kind: \"chats\"}.");
}

function keep(rules: SandboxRule[]): void {
  writePrivate(FILE, JSON.stringify({ allowed: rules }, null, 2) + "\n");
  tellLauncher(rules);
}

/** Each project's folders, where the launcher reads them; the files of projects with none gone. */
export function tellLauncher(rules: SandboxRule[] = readAllowed()): void {
  const byProject = new Map<string, string[]>();
  // (By the real path each rule keeps, never opening its project: this runs as the box starts, and
  // macOS holds a process that opens one on your Desktop until you answer it.)
  for (const rule of rules) byProject.set(sumOf(rule.project), [...(byProject.get(sumOf(rule.project)) ?? []), rule.path]);
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
 * folder, its settings, the system's folders, programs on your PATH or the whole disk. (macOS asked
 * about it first: `askedAbout`.) */
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
export async function addRule(given: { project?: unknown; kind?: unknown; path?: unknown; by?: string }): Promise<SandboxRule> {
  if (typeof given.project !== "string" || !path.isAbsolute(given.project)) throw new RuleRefusal("Name the project by its folder's full path.");
  if (given.kind !== "write") throw new RuleRefusal("Send {project, kind: \"write\", path}: a folder its commands may write in.");
  await askedAbout([given.project, given.path]);
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

/** Removes the rules of bots no longer here (deleted, or moved to another computer): their folder
 * is gone. */
export function forgetGoneBots(): void {
  const rules = readAllowed();
  const bots = realish(BOTS);
  const left = rules.filter(rule => {
    const [id, workspace, ...more] = path.relative(bots, rule.project).split(path.sep);
    return !(BOT_ID.test(id) && workspace === "workspace" && !more.length && !fs.existsSync(path.join(bots, id)));
  });
  if (left.length !== rules.length) keep(left);
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
export async function writeRuleWouldBe(where: string): Promise<string | null> {
  await askedAbout([where]);
  try { return checkedPath(where); } catch { return null; }
}
