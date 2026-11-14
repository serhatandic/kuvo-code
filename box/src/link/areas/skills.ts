// Skills (PROTOCOL.md, "Skills"): every box's, a Mac's too, and every client's way to GitHub's collections.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parsed } from "../../shared/json";
import type { EngineRecord } from "../../shared/records";
import type { DeletedSkill, SkillAbout, SkillCollection, SkillRepository as LibraryRepository, SkillLibrary, SkillNamed, Skills, SkillText, SkillTrash } from "../../shared/routes/skills";
import { pluginsSetUp } from "../engine/client";
import { listOf, textOf } from "../files";
import { ENGINE_CONFIG, IN_TEST_FOLDER, K, homeFolder } from "../home";
import type { AnswerPiece, JSONAnswer, OtherStatus, RouteContext } from "../server/context";

/** A collection of skills on GitHub, as the library lists it, and the branch its skills are read
 * from. */
export interface SkillRepository extends LibraryRepository {
  branch: string;
}

/** A skill in a repository: its name, its folder there (`""` for the repository itself), and the
 * files in it. */
export interface RepositorySkill {
  name: string;
  path: string;
  files: string[];
}

/** A Recently Deleted entry's id read: the folder it goes back to, and when it was put away
 * (seconds since 1970). */
export interface SkillTrashEntry {
  folder: string;
  deleted: number;
}

/** What `answerSkills` answers: a skills route's value, as its shape has it, or why not. */
export type SkillsAnswer = JSONAnswer<Skills | SkillText | SkillTrash | SkillNamed | SkillLibrary | SkillCollection | SkillAbout | Record<string, never>, { message: string } | Record<string, never>>;

/** A skill the engine lists (`api/skill`): its name, and its SKILL.md's path. */
interface EngineSkill {
  id: string;
  path?: string;
}

/** What a client sends to the skills' routes: a SKILL.md's text (and whether it's a new skill's),
 * or a skill to install, by its repository and folder there. */
export interface SkillsBody {
  text?: unknown;
  new?: unknown;
  repository?: unknown;
  path?: unknown;
}

/** A repository's file list, as GitHub's API answers it (`git/trees`). */
interface GitHubTree {
  tree?: { type?: string; path: string }[];
  truncated?: boolean;
}

// Where its engine reads the skills you add: its settings folder's (its XDG_CONFIG_HOME), which is
// in this box's folder on a machine, and the app's engine's on a Mac (KUVO_ENGINE_CONFIG), so a
// Mac's skills stay where they've always been.
const SKILLS = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "skills");
const SKILL_SOURCE = ".kuvo-source.json";
// GitHub, or a test's stand-in for it, in a test's folder only (never a machine's own).
const testGitHub = IN_TEST_FOLDER ? process.env.KUVO_TEST_GITHUB : undefined;
const GITHUB = { api: testGitHub ?? "https://api.github.com", raw: testGitHub ?? "https://raw.githubusercontent.com" };
// The well-known collections, roughly most popular first. Anyone can open another by name.
export const SKILL_REPOSITORIES: SkillRepository[] = [
  ["anthropics", "skills", "Anthropic", "The reference set: documents, spreadsheets, slides, PDFs, design and more."],
  ["openai", "skills", "OpenAI", "Codex's catalog of curated skills."],
  ["obra", "superpowers", "Superpowers", "Ways of working: test-driven development, debugging, planning, code review."],
  ["mattpocock", "skills", "Matt Pocock", "Engineering and productivity skills, TypeScript-minded."],
  ["addyosmani", "agent-skills", "Addy Osmani", "Production engineering practices: performance, accessibility, testing."],
  ["vercel-labs", "agent-skills", "Vercel", "React, Next.js and deploying to Vercel."],
  ["github", "awesome-copilot", "GitHub Awesome Copilot", "Hundreds of community skills; quality varies."],
  ["huggingface", "skills", "Hugging Face", "Models, datasets and training with Hugging Face."],
  ["cloudflare", "skills", "Cloudflare", "Workers, Pages and the rest of Cloudflare's platform."],
  ["trailofbits", "skills", "Trail of Bits", "Security auditing and code review."],
  ["K-Dense-AI", "scientific-agent-skills", "Scientific Skills", "A large library for science: biology, chemistry, data analysis."],
  ["wshobson", "agents", "wshobson/agents", "A big set of plugins with skills for many languages and tools."],
].map(([owner, name, title, summary]) => ({ id: `${owner}/${name}`, owner, name, title, summary, branch: "main" }));

class SkillFailure extends Error {
  declare status: OtherStatus;
  constructor(status: OtherStatus, message: string) { super(message); this.status = status; }
}
const limited = () => new SkillFailure(503, "GitHub is limiting requests for now. Try again in a while.");

/** A folder's name in the skills folder: not a path, nor hidden. */
const isSkillFolder = (name: unknown): name is string => typeof name === "string" && name.length > 0 && name.length <= 128 && !name.startsWith(".") && !/[\/\\\0]/.test(name);

/** A skill's name from what's typed, as Settings makes it (SkillFile.name). */
export function skillName(text: unknown): string {
  // Composed first (an "é" typed as "e" and a mark is one letter, left out whole), as Settings does.
  const words = String(text).normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).map(word => [...word].filter(c => c.charCodeAt(0) < 128).join("")).filter(Boolean);
  return words.join("-").slice(0, 64).replace(/-+$/, "");
}

/** The skills folder's own folders (not hidden), by name: what a new skill's name mustn't take,
 * whether its engine lists it or not. */
function skillFolders(): string[] {
  return listOf(SKILLS).filter(name => !name.startsWith(".") && (() => { try { return fs.statSync(path.join(SKILLS, name)).isDirectory(); } catch { return false; } })()).sort();
}

// Recently Deleted: a skill put away, in this box's own trash, as `<its folder's name>-<when, in
// seconds>`, kept 30 days from then. Its name says when, never its folder's date, which a Finder
// visit or a backup put back can change.
const SKILL_TRASH = path.join(K, "trash", "skills");
const SKILL_TRASH_DAYS = 30;
const DAY = 86_400_000;

const isDirectory = (file: string) => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };

/** A Recently Deleted entry's id read: the folder's name it goes back to and when it was put away
 * (seconds since 1970), or null for what isn't an entry's id (a path, a hidden name, anything not
 * `<name>-<seconds>`). */
export function skillTrashEntry(entry: unknown): SkillTrashEntry | null {
  const found = typeof entry === "string" && entry.length <= 141 ? /^(.+)-(\d{1,12})$/.exec(entry) : null;
  return found && isSkillFolder(found[1]) && isSkillFolder(entry) ? { folder: found[1], deleted: Number(found[2]) } : null;
}

/** What's been in Recently Deleted 30 days or more, gone for good. */
function clearSkillTrash(now = Date.now()) {
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    if (entry && entry.deleted * 1000 <= now - SKILL_TRASH_DAYS * DAY) try { fs.rmSync(path.join(SKILL_TRASH, id), { recursive: true, force: true }); } catch {}
  }
}

/** Recently Deleted cleared as the box starts and once a day while it runs, so what's past its 30
 * days goes with no client there too. Its timer, which never keeps the process up. */
export function keepSkillTrashClear() {
  clearSkillTrash();
  const timer = setInterval(() => clearSkillTrash(), DAY);
  timer.unref?.();
  return timer;
}

/** Recently Deleted, newest first: each with what its SKILL.md says it is, when it was put away and
 * when it goes, in seconds since 1970. */
function skillTrashEntries(): DeletedSkill[] {
  const entries: DeletedSkill[] = [];
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    const away = path.join(SKILL_TRASH, id);
    if (!entry || !isDirectory(away)) continue;
    const about = skillAbout(textOf(path.join(away, "SKILL.md")) ?? "");
    entries.push({
      id, folder: entry.folder, name: about.name || entry.folder, ...(about.description ? { description: about.description } : {}),
      deleted: entry.deleted, goes: entry.deleted + SKILL_TRASH_DAYS * 86_400,
    });
  }
  return entries.sort((a, b) => b.deleted - a.deleted || a.id.localeCompare(b.id));
}

/** Skills installed from GitHub, by their folder's name, with where they came from. */
function skillSources(): Skills["github"] {
  const sources: Skills["github"] = {};
  for (const name of listOf(SKILLS)) {
    try {
      const source = JSON.parse(fs.readFileSync(path.join(SKILLS, name, SKILL_SOURCE), "utf8"));
      if (typeof source?.repository === "string") sources[name] = { repository: source.repository, path: typeof source.path === "string" ? source.path : "" };
    } catch {}
  }
  return sources;
}

async function github(url: string, json = true): Promise<Response> {
  const response = await fetch(url, { headers: json ? { accept: "application/vnd.github+json", "user-agent": "Kuvo Code" } : { "user-agent": "Kuvo Code" }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 403 || response.status === 429) throw limited();
  return response;
}

/** Repositories looked up on GitHub lately, by their name in lowercase: a collection's skills'
 * descriptions are asked for one by one, and GitHub allows few lookups an hour. */
const lookedUp = new Map<string, { repository: SkillRepository; at: number }>();

/** One of the well-known collections, or any other by its name on GitHub, with its default branch. */
async function skillRepository(owner: string, name: string): Promise<SkillRepository> {
  const known = SKILL_REPOSITORIES.find(each => each.owner.toLowerCase() === owner.toLowerCase() && each.name.toLowerCase() === name.toLowerCase());
  if (known) return known;
  const key = `${owner}/${name}`.toLowerCase();
  const kept = lookedUp.get(key);
  if (kept && Date.now() - kept.at < 15 * 60_000) return kept.repository;
  const response = await github(`${GITHUB.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const info = response.status === 200 ? await (response.json() as Promise<{ default_branch?: unknown; description?: string | null }>).catch(() => null) : null;
  if (typeof info?.default_branch !== "string") throw new SkillFailure(404, `${owner}/${name} wasn’t found on GitHub.`);
  const repository = { id: `${owner}/${name}`, owner, name, title: `${owner}/${name}`, summary: info.description ?? "", branch: info.default_branch };
  if (lookedUp.size > 50) lookedUp.clear();
  lookedUp.set(key, { repository, at: Date.now() });
  return repository;
}

/** The skills the engine lists (its own, and those in other tools' folders), `{id, path?}`, which a
 * new one mustn't take; none when it doesn't answer. (Once its plugins are set up: those they give
 * aren't listed before.) */
async function engineSkills(engine: EngineRecord | null): Promise<EngineSkill[]> {
  if (!engine?.port) return [];
  try {
    await pluginsSetUp(engine, undefined, AbortSignal.timeout(5_000));
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/skill`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5_000),
    });
    const listed = response.ok ? (await response.json() as { data?: unknown })?.data : null;
    return Array.isArray(listed)
      ? listed.filter(skill => typeof skill?.id === "string").map(skill => ({ id: skill.id, ...(typeof skill.path === "string" ? { path: skill.path } : {}) }))
      : [];
  } catch {
    return [];
  }
}

const engineSkillNames = async (engine: EngineRecord | null) => (await engineSkills(engine)).map(skill => skill.id);

/** Where a skill the engine lists is, said short: "in ~/.claude/skills", "built in". */
function skillPlace(file: string | undefined): string {
  if (typeof file !== "string" || !file) return "elsewhere";
  if (file.startsWith("/builtin/")) return "built in";
  const folder = path.dirname(path.dirname(file));
  const home = homeFolder();
  return `in ${folder === home || folder.startsWith(home + path.sep) ? "~" + folder.slice(home.length) : folder}`;
}

/** A repository's skills, from its file list (one request to GitHub's API): each folder with a
 * SKILL.md, with every file in it (the deepest skill's, for skills inside skills), or the
 * repository itself when its SKILL.md is at the top (without its hidden folders). */
export async function skillsIn(repository: SkillRepository): Promise<{ skills: RepositorySkill[]; partial: boolean }> {
  const response = await github(`${GITHUB.api}/repos/${repository.owner}/${repository.name}/git/trees/${repository.branch}?recursive=1`);
  if (response.status !== 200) throw new SkillFailure(404, `${repository.id} wasn’t found on GitHub.`);
  const tree = await response.json() as GitHubTree;
  const files = (tree.tree ?? []).filter(entry => entry.type === "blob").map(entry => entry.path);
  const dirname = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
  const folders = new Set(files.filter(file => file.split("/").at(-1) === "SKILL.md").map(dirname).filter(Boolean));
  const isSkill = files.includes("SKILL.md");
  const byFolder = new Map<string, string[]>();
  for (const file of files) {
    let folder = dirname(file);
    while (folder && !folders.has(folder)) folder = dirname(folder);
    if (folder) byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    else if (isSkill && !file.startsWith(".")) byFolder.set("", [...(byFolder.get("") ?? []), file]);
  }
  const nameOf = (folder: string) => (folder ? folder.split("/").at(-1)! : repository.name);
  let skills = [...(isSkill ? [""] : []), ...[...folders].sort()].map(folder => ({ name: nameOf(folder), path: folder, files: byFolder.get(folder) ?? [] }));
  // A copy kept for another tool in a hidden folder, of one in plain sight: listed once.
  const hidden = (skill: RepositorySkill) => skill.path.split("/").some(part => part.startsWith("."));
  const shown = new Set(skills.filter(skill => !hidden(skill)).map(skill => skill.name));
  skills = skills.filter(skill => !(hidden(skill) && shown.has(skill.name)));
  return { skills, partial: tree.truncated === true };
}

/** What skills' SKILL.md files say they are, by repository, branch and folder, kept while the box
 * runs: a collection's are read once, however often it's opened or a phone asks for one. */
const skillAbouts = new Map<string, SkillAbout>();
/** At most this many read from GitHub at once, the rest waiting their turn, so a big collection
 * never holds up an install or another client's request. */
const ABOUT_READS = 16;
let aboutReading = 0;
const aboutWaiting: (() => void)[] = [];

/** What a skill's SKILL.md says it is: `{name?, description?}`, `{}` when GitHub doesn't say. */
async function aboutSkill(repository: SkillRepository, folder: string): Promise<SkillAbout> {
  const key = `${repository.id.toLowerCase()}@${repository.branch}:${folder}`;
  if (skillAbouts.has(key)) return skillAbouts.get(key)!;
  if (aboutReading >= ABOUT_READS) await new Promise<void>(resolve => aboutWaiting.push(resolve));
  aboutReading++;
  try {
    if (skillAbouts.has(key)) return skillAbouts.get(key)!;
    const response = await github(rawURL(repository, folder ? `${folder}/SKILL.md` : "SKILL.md"), false).catch(() => null);
    if (response?.status !== 200) return {};
    const about = skillAbout(await response.text());
    if (skillAbouts.size > 5_000) skillAbouts.clear();
    skillAbouts.set(key, about);
    return about;
  } finally {
    aboutReading--;
    aboutWaiting.shift()?.();
  }
}

const rawURL = (repository: SkillRepository, file: string) => `${GITHUB.raw}/${repository.owner}/${repository.name}/${repository.branch}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** The front matter's name and description. */
export function skillAbout(markdown: unknown): SkillAbout {
  const lines = String(markdown).split(/\r\n|\r|\n/);
  const about: SkillAbout = {};
  if (lines[0]?.trim() !== "---") return about;
  for (let index = 1; index < lines.length && lines[index].trim() !== "---"; index++) {
    const line = lines[index];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ([">", "|", ">-", "|-"].includes(value)) {
      const parts = [];
      while (index + 1 < lines.length && lines[index + 1].startsWith(" ")) parts.push(lines[++index].trim());
      value = parts.join(" ");
    }
    value = value.replace(/^["']+|["']+$/g, "");
    if (key === "name") about.name = value;
    if (key === "description") about.description = value;
  }
  return about;
}

/** Fetches a skill's files beside the folder, then moves them in whole, so the engine never finds half of it. */
async function installSkill(repository: SkillRepository, skill: RepositorySkill): Promise<void> {
  const target = path.join(SKILLS, skill.name);
  if (fs.existsSync(target)) throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
  // Its own: two installs at once never share one.
  const staging = path.join(SKILLS, `.${skill.name}.kuvo-new-${crypto.randomUUID()}`);
  try {
    for (const file of skill.files) {
      const response = await github(rawURL(repository, file), false);
      if (response.status !== 200) throw new SkillFailure(404, `${file} wasn’t found on GitHub.`);
      const relative = skill.path ? file.slice(skill.path.length + 1) : file;
      const into = path.join(staging, relative);
      if (!into.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(into), { recursive: true });
      fs.writeFileSync(into, Buffer.from(await response.arrayBuffer()));
    }
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, SKILL_SOURCE), JSON.stringify({ branch: repository.branch, path: skill.path, repository: repository.id }, null, 2));
    if (fs.existsSync(target)) throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** `kuvo/skills…`, `kuvo/skill-trash…` and `kuvo/skill-library…`, for this box's own folder. */
export async function answerSkills(method: string, requestPath: string, body: SkillsBody | null | undefined, engine: EngineRecord | null = null): Promise<SkillsAnswer> {
  const [route, query = ""] = requestPath.split("?");
  const parts = route.split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  if (parts.includes(null)) return { status: 400, value: { message: "That isn’t a path." } };
  const message = (text: string) => ({ message: text });
  try {
    if (parts[1] === "skills" && parts.length === 2) {
      if (method !== "GET") return { status: 405, value: {} };
      return { status: 200, value: { folder: SKILLS, folders: skillFolders(), github: skillSources() } satisfies Skills };
    }
    if (parts[1] === "skills" && parts.length === 3) {
      const name = parts[2];
      if (!isSkillFolder(name)) return { status: 400, value: message("That isn’t a skill’s name.") };
      const folder = path.join(SKILLS, name);
      const file = path.join(folder, "SKILL.md");
      if (method === "GET") {
        const text = textOf(file);
        return text === null ? { status: 404, value: {} } : { status: 200, value: { text } satisfies SkillText };
      }
      if (method === "PUT") {
        const text = body?.text;
        if (typeof text !== "string" || !text.trim()) return { status: 400, value: message('Send the skill\'s SKILL.md as {"text": …}.') };
        if (body?.new === true) {
          if (skillName(name) !== name) return { status: 400, value: message("Names use lowercase letters a to z, digits and hyphens.") };
          if (fs.existsSync(folder) || (await engineSkillNames(engine)).includes(name)) return { status: 409, value: message(`There’s a skill called ${name} already.`) };
        } else if (!fs.existsSync(folder)) {
          return { status: 404, value: {} };
        } else if (skillSources()[name]) {
          // As Settings has it: one from GitHub is as it came, not edited.
          return { status: 409, value: message(`${name} came from GitHub, so it isn’t edited here.`) };
        }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(`${file}.new`, text);
        fs.renameSync(`${file}.new`, file);
        return { status: 200, value: {} };
      }
      if (method === "DELETE") {
        if (!fs.existsSync(folder)) return { status: 404, value: {} };
        // To this box's own trash (Recently Deleted), kept 30 days.
        fs.mkdirSync(SKILL_TRASH, { recursive: true });
        let when = Math.floor(Date.now() / 1000);
        while (fs.existsSync(path.join(SKILL_TRASH, `${name}-${when}`))) when++;
        fs.renameSync(folder, path.join(SKILL_TRASH, `${name}-${when}`));
        clearSkillTrash();
        return { status: 200, value: {} };
      }
      return { status: 405, value: {} };
    }
    if (parts[1] === "skill-trash") {
      // Recently Deleted: what's past its 30 days goes first, whatever's asked.
      clearSkillTrash();
      if (parts.length === 2) {
        if (method !== "GET") return { status: 405, value: {} };
        return { status: 200, value: { entries: skillTrashEntries() } satisfies SkillTrash };
      }
      if (parts.length === 4 && parts[3] === "restore") {
        if (method !== "POST") return { status: 405, value: {} };
        const entry = parts[2];
        const name = skillTrashEntry(entry)?.folder;
        if (!name) return { status: 400, value: message("That isn’t an entry in Recently Deleted.") };
        const away = path.join(SKILL_TRASH, entry!);
        if (!isDirectory(away)) return { status: 404, value: {} };
        const back = path.join(SKILLS, name);
        // Never over another: one by its name now stays, and so does this one, to restore later.
        if (fs.existsSync(back)) return { status: 409, value: message(`There’s a skill called ${name} now. Delete it first to restore this one.`) };
        // Nor beside one the engine finds elsewhere by that name (another tool's folder), which it
        // would hide; the one put away, which the engine can list a moment longer, doesn't count.
        const elsewhere = (await engineSkills(engine)).find(skill => skill.id === name && !skill.path?.startsWith(SKILLS + path.sep));
        if (elsewhere) return { status: 409, value: message(`There’s a skill called ${name} ${skillPlace(elsewhere.path)}, so this one can’t be restored under that name.`) };
        fs.mkdirSync(SKILLS, { recursive: true });
        fs.renameSync(away, back);
        return { status: 200, value: { name } satisfies SkillNamed };
      }
      return { status: 404, value: {} };
    }
    if (parts[1] === "skill-library") {
      if (parts.length === 2 && method === "GET") return { status: 200, value: { repositories: SKILL_REPOSITORIES.map(({ branch, ...shown }) => shown) } satisfies SkillLibrary };
      if (parts.length === 3 && parts[2] === "install" && method === "POST") {
        const [owner, name] = String(body?.repository ?? "").split("/");
        if (!owner || !name || typeof body?.path !== "string") return { status: 400, value: message('Send {"repository": "owner/name", "path": …}.') };
        const repository = await skillRepository(owner, name);
        const skill = (await skillsIn(repository)).skills.find(each => each.path === body.path);
        if (!skill) return { status: 404, value: message(`There’s no skill at ${body.path} in ${repository.id}.`) };
        await installSkill(repository, skill);
        return { status: 200, value: { name: skill.name } satisfies SkillNamed };
      }
      if (parts.length === 4 && method === "GET") {
        const repository = await skillRepository(parts[2]!, parts[3]!);
        const { skills, partial } = await skillsIn(repository);
        const { branch, ...shown } = repository;
        // Each with what its SKILL.md says it is, so a client shows them without asking for each.
        const described = await Promise.all(skills.map(async skill => ({ ...skill, about: await aboutSkill(repository, skill.path) })));
        return { status: 200, value: { repository: shown, skills: described, partial } satisfies SkillCollection };
      }
      if (parts.length === 5 && parts[4] === "about" && method === "GET") {
        const repository = await skillRepository(parts[2]!, parts[3]!);
        // As written: a "+" is a plus.
        const pair = query.split("&").find(each => each.startsWith("path="));
        let at = "";
        try { at = pair ? decodeURIComponent(pair.slice(5)) : ""; } catch { return { status: 400, value: message("That isn’t a path.") }; }
        return { status: 200, value: await aboutSkill(repository, at) };
      }
    }
    return { status: 404, value: {} };
  } catch (error) {
    return { status: error instanceof SkillFailure ? error.status : 502, value: message((error as Error)?.message ?? String(error)) };
  }
}

// Settings › Skills (PROTOCOL.md, "Skills"): this box's own skills folder, its Recently Deleted, and GitHub's
// collections, which it reaches itself (a machine's with the Mac closed too).
export async function* skillsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, json } = context;
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  const { status, value } = await answerSkills(request.method.toUpperCase(), request.path, parsed(request.body) as SkillsBody | null | undefined, engine);
  return yield* json(status, value);
}
