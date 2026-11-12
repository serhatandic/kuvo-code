// A new project made on this box (PROTOCOL.md, "Work": `POST kuvo/projects/new`, and the
// make_project tool): a folder in the projects folder you picked (or the one you named for it), a
// new git repository there (or one cloned into it), added to the box's projects, marked with the
// bot that made it. The box makes projects only there, and never deletes one.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { changeProjects, readProjects } from "../areas/projects";
import { askedArgs } from "../../shared/git";
import { firstCommit, gitIn } from "../git";
import { homeFolder } from "../home";
import { projectsFolder } from "./settings";
import type { Project } from "../../shared/routes/projects";
import { noteFolderFound } from "./found-folders";

/** Who made a project, kept with it: a bot by its id and name, and when (ms since 1970). */
export interface MadeBy {
  bot: string;
  name: string;
  at: number;
}

/** A project made: what's kept of it, and what it is: a new git repository, one cloned, or a plain
 * folder (as asked, or as git isn't there). */
export interface Made {
  project: Project;
  kind: "git" | "cloned" | "plain" | "noGit";
}

/** What a new project is given: its name, whether it's a git repository (yes unless it says
 * otherwise), a repository to clone into it, and the folder you named for it (a full path; in the
 * projects folder otherwise). */
export interface NewProject {
  name?: unknown;
  git?: unknown;
  clone?: unknown;
  folder?: unknown;
}

/** Why one wasn't made: no projects folder picked yet (403), a name or address that won't do
 * (400), a folder that's there with files in it already (409), or git failing (502). */
export interface ProjectRefusal {
  status: 400 | 403 | 409 | 502;
  message: string;
  needs?: "projectsFolder";
}

/** A folder's name for a project called `name`: lowercase, dashes between words, nothing a path
 * would take apart; null for one with nothing left. */
export function folderName(name: string): string | null {
  const folded = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60).replace(/[-.]+$/, "");
  return folded || null;
}

/** A repository address git clones without asking anything: https, or ssh (`git@host:path`,
 * `ssh://`). Never a path here, or a command in disguise. */
export function cloneable(address: string): boolean {
  if (address.startsWith("-")) return false;
  return /^https:\/\/[A-Za-z0-9][^\s/]*\/\S+$/.test(address) || /^ssh:\/\/[A-Za-z0-9][^\s/]*\/\S+$/.test(address) || /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s]+$/.test(address);
}

/** Where a project called `name` would go here (null without a projects folder, or a name that
 * won't do). */
export function projectPlace(name: string, root = projectsFolder()): string | null {
  const folder = folderName(name);
  return root && folder ? path.join(root, folder) : null;
}

/** The folder you named for a project (written with `~` or in full), as a full path, or why it
 * can't be one: the folder it goes in has to be there. */
export function namedPlace(given: unknown, home = homeFolder()): { folder: string } | { refused: string } {
  if (typeof given !== "string" || !given.trim()) return { refused: "Give the folder as a full path." };
  const written = given.trim().replace(/^~(?=$|\/)/, home);
  if (!path.isAbsolute(written)) return { refused: `Give the folder as a full path, like ~/${given.trim().replace(/^\.?\//, "")}.` };
  const folder = path.resolve(written);
  if (folder === path.parse(folder).root || folder === home) return { refused: `${shownPath(folder, home)} can't be a project's folder: name one inside it.` };
  return { folder };
}

/** A path as you'd write it: under your home folder with `~`. */
export function shownPath(folder: string, home = homeFolder()): string {
  return folder === home || folder.startsWith(home + "/") ? "~" + folder.slice(home.length) : folder;
}

export const isEmptyFolder = (folder: string) => {
  try {
    return fs.readdirSync(folder).filter(name => name !== ".DS_Store").length === 0;
  } catch {
    return false;
  }
};

// git clone, without holding up the box, for as long as a big repository takes (ten minutes at most).
function cloneInto(address: string, folder: string): Promise<string | null> {
  return new Promise(resolve => {
    // Never asking anything: ssh too, unless you set how git runs it.
    const ownSSH = Boolean(process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) || gitIn(path.dirname(folder), ["config", "--get", "core.sshCommand"]) !== null;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(ownSSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }) };
    // (A clone makes a repository, so it never has one's commondir to refuse.)
    const args = askedArgs(["clone", "--quiet", "--", address, folder]) ?? [];
    execFile("git", args, { encoding: "utf8", env, timeout: 600_000 }, (error, _stdout, stderr) => {
      resolve(error ? (String(stderr ?? "").trim().split("\n").pop() || String(error.message)) : null);
    });
  });
}

/** A new project called `given.name`, in the projects folder (or the folder named for it): what's
 * kept of it, or why not. */
export async function makeProject(given: NewProject, madeBy: MadeBy | null, root = projectsFolder()): Promise<{ made: Made } | { refused: ProjectRefusal }> {
  const no = (status: ProjectRefusal["status"], message: string, needs?: "projectsFolder") => ({ refused: { status, message, ...(needs ? { needs } : {}) } });
  const name = typeof given.name === "string" ? given.name.trim() : "";
  if (!name) return no(400, "Say what it's called (name).");
  const named = given.folder === undefined || given.folder === null ? null : namedPlace(given.folder);
  if (named && "refused" in named) return no(400, named.refused);
  if (!named && !root) return no(403, "There's no projects folder here yet: the user picks one.", "projectsFolder");
  const folder = named ? named.folder : projectPlace(name, root);
  if (!folder) return no(400, `${name} can't be a folder's name: use letters or numbers.`);
  const clone = typeof given.clone === "string" && given.clone.trim() ? given.clone.trim() : null;
  if (clone && !cloneable(clone)) return no(400, `${clone} isn't a repository address git can clone: give an https or ssh one.`);
  const listed = readProjects().find(each => each.directory === folder && !each.removed);
  if (listed) return no(409, `There's a project at ${shownPath(folder)} already: ${listed.name ?? path.basename(folder)}.`);
  const there = fs.existsSync(folder);
  if (there && !isEmptyFolder(folder)) return no(409, `There's a folder at ${shownPath(folder)} already, with files in it. ${named ? `To work on what's there, start sessions in it with start_session (folder: "${shownPath(folder)}").` : "Pick another name."}`);
  let kind: Made["kind"] = "plain";
  if (clone) {
    // git makes the folder, and takes away what it made of one that failed. (An empty one there
    // goes first: git clones only into a folder it makes, and a Finder note isn't anything.)
    if (there) {
      fs.rmSync(path.join(folder, ".DS_Store"), { force: true });
      fs.rmdirSync(folder);
    }
    const failed = await cloneInto(clone, folder);
    if (failed) {
      if (!there && fs.existsSync(folder) && isEmptyFolder(folder)) fs.rmdirSync(folder);
      return no(502, `Couldn't clone ${clone}: ${failed}`);
    }
    kind = "cloned";
  } else {
    fs.mkdirSync(folder, { recursive: true });
    if (given.git !== false) kind = gitIn(folder, ["init", "--quiet", "--initial-branch=main"]) !== null || gitIn(folder, ["init", "--quiet"]) !== null ? "git" : "noGit";
  }
  if (kind === "git" || kind === "cloned") firstCommit(folder);
  // (Where it is now is where it is, as its maker's own: `found-folders.ts`.)
  await noteFolderFound(folder).catch(() => {});
  let project!: Project;
  changeProjects(projects => {
    const before = projects.find(each => each.directory === folder);
    project = { ...before, directory: folder, folders: before?.folders ?? [], ...(path.basename(folder) !== name ? { name } : {}), ...(madeBy ? { madeBy } : {}) };
    delete project.removed;
    return [project, ...projects.filter(each => each !== before)];
  });
  return { made: { project, kind } };
}

/** What a made project is, in the words its maker reads. */
export function madeWords(made: Made, here: string): string {
  const name = made.project.name ?? path.basename(made.project.directory);
  const what = { git: "a new git repository", cloned: "cloned into it", plain: "a plain folder", noGit: `a plain folder (git isn't on ${here})` }[made.kind];
  return `Made ${name} at ${shownPath(made.project.directory)}, ${what}, on ${here}. It's in the sidebar; start sessions in it with start_session (project: "${name}").`;
}
