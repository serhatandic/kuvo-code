// A bot answering what its sessions ask (answer_ask, PROTOCOL.md "Work"): a permission it may allow
// only where it could go ahead itself (the engine's rules for its own conversation allow it), never
// what always comes to you (pushing, publishing, releasing, deploying, deleting outside the
// project), and saying no is always its to do. An ask one of a session's subagents makes is the
// session's. Each answer is kept on the session (`kuvo.answers`), for every client to show it on
// the step that asked ("Allowed by Pixel") and in the bot's work. A question it answers in words.

import path from "node:path";
import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { lockedWhile } from "../files";
import { homeFolder } from "../home";
import { permissionsHere } from "../bots/tell";
import { describePermission } from "../notices/news";
import { WORK_FOLDER } from "./changes";
import type { Target } from "../../shared/records";
import type { WorkAnswer } from "../../shared/routes/work";
import type { KitRule } from "../bots/kit";
import type { EngineSession } from "../engine/sessions";

// The parts of a command line: each simple command's words, quotes taken off.
function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote: string | null = null, has = false;
  const end = () => {
    if (has) words.push(word);
    word = "";
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && i + 1 < line.length) word += line[++i];
      else word += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      has = true;
    } else if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      has = true;
    } else if (/\s/.test(char)) {
      end();
    } else if (";|&\n()`".includes(char) || (char === "$" && line[i + 1] === "(")) {
      end();
      if (words.length) commands.push(words);
      words = [];
    } else {
      word += char;
      has = true;
    }
  }
  end();
  if (words.length) commands.push(words);
  return commands;
}

// A command's own words: what it runs, past `VAR=…`, `sudo`, `env`, `command`, `time`, `nohup`.
function ownWords(words: string[]): string[] {
  let at = 0;
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || ["sudo", "env", "command", "time", "nohup", "exec", "xargs"].includes(words[at]))) at++;
  return words.slice(at);
}

// Whether a path the command names is outside `folders` (or anywhere, with none).
function outside(target: string, folders: readonly string[]): boolean {
  const written = target.replace(/^~(?=$|\/)/, homeFolder()).replace(/^\$\{?HOME\}?(?=$|\/)/, homeFolder());
  if (!folders.length) return path.isAbsolute(written) || written.startsWith("..");
  return !folders.some(folder => {
    const full = path.resolve(folder, written);
    return full === folder || full.startsWith(folder.endsWith("/") ? folder : folder + "/");
  });
}

const RELEASE_WORD = /(^|[^a-z])(deploy|release|publish)([^a-z]|$)/i;

/** Why one simple command always comes to you, or null. `folders`: its session's. */
function yoursFor(words: string[], folders: readonly string[]): string | null {
  const own = ownWords(words);
  if (!own.length) return null;
  const program = path.basename(own[0]);
  const rest = own.slice(1);
  // What a package runner runs (`npx vercel --prod`, `pnpm dlx …`), judged as itself.
  if (["npx", "bunx"].includes(program) || (["pnpm", "yarn"].includes(program) && rest[0] === "dlx")) {
    const runs = (program === "pnpm" || program === "yarn" ? rest.slice(1) : rest).filter((word, at, all) => !word.startsWith("-") || all.slice(0, at).some(each => !each.startsWith("-")));
    if (runs.length) return yoursFor(runs, folders);
  }
  if (program === "git") {
    // Its subcommand: the first word past its options (and their values).
    let at = 0;
    while (at < rest.length && rest[at].startsWith("-")) at += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(rest[at]) ? 2 : 1;
    if (rest[at] === "push") return "pushing";
  }
  if (program === "gh") {
    const [area, action] = rest;
    if (area === "repo" && ["create", "delete", "edit", "rename", "archive", "fork"].includes(action)) return "changing what's on GitHub";
    if (area === "release" && action !== "list" && action !== "view" && action !== "download") return "changing what's on GitHub";
    if ((area === "pr" && action === "merge") || area === "secret" || (area === "workflow" && action === "run") || area === "variable") return "changing what's on GitHub";
    if (area === "api" && rest.some((word, at) => /^(-X|--method)$/.test(word) ? !/^get$/i.test(rest[at + 1] ?? "") : /^--method=(?!get$)/i.test(word) || /^-X(?!get$)./i.test(word))) return "changing what's on GitHub";
    if (area === "api" && rest.some(word => /^(-f|-F|--field|--raw-field|--input)$/.test(word))) return "changing what's on GitHub";
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(program) && rest[0] === "publish") return "publishing";
  if ((program === "cargo" && rest[0] === "publish") || (program === "pod" && rest[0] === "trunk" && rest[1] === "push") || (program === "gem" && rest[0] === "push") || (program === "twine" && rest[0] === "upload") || (program === "docker" && rest[0] === "push")) return "publishing";
  if (program === "fastlane" && rest.some(word => /^(deliver|pilot|beta|release|supply|submit|upload_to_\w+)$/.test(word))) return "sending to a store";
  if ((program === "eas" && rest[0] === "submit") || (program === "xcrun" && (rest[0] === "altool" || (rest[0] === "notarytool" && rest[1] === "submit")))) return "sending to a store";
  if (["vercel", "netlify", "wrangler", "firebase", "flyctl", "fly", "heroku", "terraform", "kubectl", "pulumi", "railway", "render"].includes(program)
    && rest.some(word => /^(deploy|publish|up|apply|destroy|delete|rollout|--prod)$/.test(word))) return "deploying";
  if (program === "rm") {
    const recursive = rest.some(word => /^-[a-zA-Z]*[rR]/.test(word) || word === "--recursive");
    const targets = rest.filter(word => !word.startsWith("-"));
    if (recursive && targets.some(target => outside(target, folders))) return "deleting outside the project";
  }
  // A script or task named for it (`./scripts/publish.sh`, `npm run deploy`, `make release`), not
  // a flag or an argument (`cargo build --release`).
  const task = ["make", "just", "task", "rake", "invoke", "gradle", "gradlew", "mix"].includes(program) ? rest.find(word => !word.startsWith("-"))
    : ["npm", "pnpm", "bun"].includes(program) && rest[0] === "run" ? rest[1]
    : program === "yarn" ? (rest[0] === "run" ? rest[1] : rest[0]) : undefined;
  if ([own[0], task].some(word => word && !word.startsWith("-") && RELEASE_WORD.test(path.basename(word)))) return "releasing or deploying";
  return null;
}

/** Why a permission always comes to you, or null for one a bot may allow. `folders`: the asking
 * session's, for what deleting outside them is. */
export function alwaysYours(action: string, resources: readonly string[], folders: readonly string[] = []): string | null {
  if (!["shell", "bash"].includes(action)) return null;
  for (const resource of resources) for (const words of commandsOf(resource)) {
    const why = yoursFor(words, folders);
    if (why) return why;
  }
  return null;
}

// A rule's resource as the engine matches it: `*` any text, `?` one character.
const matches = (pattern: string, resource: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, ".")}$`).test(resource);

/** What `rules` say for `action` on `resource`: the last that matches wins, and none matching lets
 * it through. */
export function ruleFor(rules: readonly KitRule[], action: string, resource: string): KitRule["effect"] {
  let effect: KitRule["effect"] = "allow";
  for (const rule of rules) if ((rule.action === action || rule.action === "*") && matches(rule.resource, resource)) effect = rule.effect;
  return effect;
}

/** The engine's own, before Settings › Permissions: a folder outside the project asks. */
const ENGINE_DEFAULTS: KitRule[] = [{ action: "external_directory", resource: "*", effect: "ask" }];

/** The rules a conversation goes by, as the engine applies them: its defaults, this box's Settings ›
 * Permissions, then the conversation's own. */
export const rulesOf = (own: readonly KitRule[]): KitRule[] => [...ENGINE_DEFAULTS, ...(permissionsHere() ?? []), ...own];

/** Whether a conversation with `rules` (all of them, `rulesOf`) could do all of what's asked without
 * asking itself. */
export const withinLevel = (rules: readonly KitRule[], action: string, resources: readonly string[]) =>
  (resources.length ? resources : ["*"]).every(resource => ruleFor(rules, action, resource) === "allow");

/** A permission a session asks (it, or one of its subagents: `asker`), as the engine lists it. */
export interface PendingPermission {
  id: string;
  asker: string;
  action: string;
  resources: string[];
  call?: string;
}

/** A question a session asks (it, or a subagent: `asker`): its one field's key. */
export interface PendingQuestion {
  id: string;
  asker: string;
  key: string | null;
  text: string;
}

/** The session and its subagents (theirs too, a few levels down), which ask in its name. */
export async function askersOf(target: Target, session: string, signal?: AbortSignal): Promise<string[]> {
  const found = [session];
  for (let at = 0; at < found.length && at < 40; at++) {
    if (at > 0 && found.length > 30) break;
    const listed = await call(target, "GET", `/api/session?limit=50&order=desc&parentID=${encodeURIComponent(found[at])}`, undefined, signal).catch(() => null);
    for (const child of Array.isArray(listed) ? listed : []) if (isObject(child) && typeof child.id === "string" && !found.includes(child.id)) found.push(child.id);
  }
  return found;
}

/** What `session` (or one of its subagents) asks now: its permissions and questions. */
export async function asksIn(target: Target, session: string, signal?: AbortSignal): Promise<{ permissions: PendingPermission[]; questions: PendingQuestion[] }> {
  const permissions: PendingPermission[] = [];
  const questions: PendingQuestion[] = [];
  for (const asker of await askersOf(target, session, signal)) {
    const at = `/api/session/${encodeURIComponent(asker)}`;
    const listed = await call(target, "GET", `${at}/permission`, undefined, signal).catch(() => null);
    for (const each of Array.isArray(listed) ? listed : []) {
      if (!isObject(each) || typeof each.id !== "string") continue;
      const resources = Array.isArray(each.resources) ? each.resources.filter((one: unknown): one is string => typeof one === "string") : [];
      const source = isObject(each.source) ? each.source : null;
      permissions.push({ id: each.id, asker, action: String(each.action ?? ""), resources, ...(typeof source?.id === "string" ? { call: source.id } : {}) });
    }
    const forms = await call(target, "GET", `${at}/form`, undefined, signal).catch(() => null);
    for (const form of Array.isArray(forms) ? forms : []) {
      if (!isObject(form) || typeof form.id !== "string") continue;
      const fields = (Array.isArray(form.fields) ? form.fields : []).filter((field: unknown) => isObject(field) && !field.hidden && !(Array.isArray(field.when) && field.when.length));
      const one = fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
      questions.push({ id: form.id, asker, key: typeof one?.key === "string" ? one.key : null, text: String(one?.description || one?.title || form.title || "a question") });
    }
  }
  return { permissions, questions };
}

/** The ask `ask` in `session` (or one of its subagents), as it's asked now; null when it isn't
 * (answered, or it moved on). */
export async function pendingAsk(target: Target, session: string, ask: string, signal?: AbortSignal): Promise<{ permission: PendingPermission } | { question: PendingQuestion } | null> {
  const { permissions, questions } = await asksIn(target, session, signal);
  const permission = permissions.find(each => each.id === ask);
  if (permission) return { permission };
  const question = questions.find(each => each.id === ask);
  return question ? { question } : null;
}

/** The answers kept on a session, at most this many (the latest). */
const KEPT = 40;

/** A session's notes changed, one change at a time across processes: the engine keeps them whole,
 * so they're read first and sent back with the change (to its `kuvo`, and to the rest of them). */
export async function noteSession(target: Target, session: string, change: (kuvo: Record<string, unknown>, metadata: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  await lockedWhile(path.join(WORK_FOLDER, ".notes.lock"), async () => {
    const at = `/api/session/${encodeURIComponent(session)}`;
    const data = await call(target, "GET", at) as Partial<EngineSession> | null;
    const metadata: Record<string, unknown> = isObject(data?.metadata) ? { ...data.metadata } : {};
    const kuvo = change(isObject(metadata.kuvo) ? { ...metadata.kuvo } : {}, metadata);
    await call(target, "PATCH", at, { metadata: { ...metadata, kuvo } });
  });
}

/** An answer kept on its session, for every client to show. */
export async function keepAnswer(target: Target, session: string, answer: Omit<WorkAnswer, "session">): Promise<void> {
  await noteSession(target, session, kuvo => {
    const before = Array.isArray(kuvo.answers) ? kuvo.answers : [];
    return { ...kuvo, answers: [...before, answer].slice(-KEPT) };
  });
}

/** What a permission asks, in words, as the session's card and the bot's work say it. */
export const permissionWords = (permission: Pick<PendingPermission, "action" | "resources">) => describePermission({ action: permission.action, resources: permission.resources });

/** A session's answers as kept on it. */
export function answersOn(metadata: unknown): WorkAnswer[] {
  const answers = isObject(metadata) && isObject(metadata.kuvo) ? metadata.kuvo.answers : null;
  return Array.isArray(answers) ? answers.filter((each): each is WorkAnswer => isObject(each) && typeof each.ask === "string" && typeof each.decision === "string") : [];
}
