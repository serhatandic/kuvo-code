// What a conversation waits on you for (PROTOCOL.md, "A conversation's asks"): every permission and
// question waiting in it and in its subagents, worded as the cards over the composer show them, so
// every client draws them alike; followed as they change; and answered here, where they were asked.

import { isObject, parsed } from "../../shared/json";
import { outsideShown } from "../../shared/text";
import { call } from "../engine/client";
import fs from "node:fs";
import { ASKS_FILE, askFollowers, askTimes } from "../glance/asked";
import { listSandboxAsks } from "../fence/outside";
import { listAsks as listVaultAsks } from "../vault/asks";
import { homeFolder } from "../home";
import { targetsOf } from "../letters/tools";
import { alwaysWords, describeForm, type EngineForm } from "../notices/news";
import { askersOf, callOf, sessionsWaitingOnServer } from "../work/answers";
import { listAskReviews } from "../work/reviewing";
import { followedLive } from "../follow";
import { sessionHere, Unreached } from "./glance";
import type { AskedQuestion, PermissionAsk, SessionAsk } from "../../shared/routes/sessions";
import type { Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_ASKS_ROUTE = /^kuvo\/sessions\/([^/]+)\/asks(?:\/([^/]+))?$/;

/** A permission as the engine (or the coding agents' bridge) lists it. */
interface EnginePermission {
  id: string;
  sessionID?: string;
  action?: unknown;
  resources?: unknown;
  save?: unknown;
  metadata?: { files?: unknown };
  source?: { messageID?: unknown; id?: unknown };
  message?: unknown;
  time?: { created?: unknown };
}

/** One of a form's fields, as this reads it. */
interface Field {
  key?: unknown;
  type?: unknown;
  title?: unknown;
  description?: unknown;
  options?: unknown;
  custom?: unknown;
  required?: unknown;
  hidden?: unknown;
  when?: unknown;
  format?: unknown;
  default?: unknown;
}

/** An ask found: as clients get it, and what answering it needs (where, and the form it is). */
interface Found {
  shown: SessionAsk;
  target: Target;
  asker: string;
  form?: { fields: Field[] };
  /** For an MCP server's form, filed under no session (`global`): the folder it's in. */
  folder?: string;
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

/** `file` as the card shows it: from the conversation's folder where it's in it. */
export function relativeTo(folder: string, file: string): string {
  if (!folder) return file;
  const base = folder.endsWith("/") ? folder : folder + "/";
  return file.startsWith(base) ? file.slice(base.length) : file;
}

/** A permission's card title, as the Mac's (AttentionCards.swift): what it would do, to the first
 * thing it covers (and how many more). */
export function permissionTitle(action: string, resources: string[], folder: string, command: string | null): string {
  const subject = resources.length ? relativeTo(folder, resources[0]!) + (resources.length > 1 ? ` and ${resources.length - 1} more` : "") : "this";
  switch (action) {
    case "edit": case "patch": return `Allow editing ${subject}?`;
    case "write": return `Allow writing ${subject}?`;
    case "read": return `Allow reading ${subject}?`;
    case "shell": case "bash": return resources.length > 1 && command === null ? "Allow running these commands?" : "Allow running this command?";
    case "external_directory": return "Allow working outside the project?";
    case "subagent": return `Allow starting the ${subject} agent?`;
    case "webfetch": return `Allow fetching ${subject}?`;
    default: return `Allow ${action.replaceAll("_", " ")}?`;
  }
}

/** A permission's answers, in the cards' order (KuvoClient's PermissionAnswer): Always's words as
 * its button draws them. */
export function choicesOf(request: { action: string; resources: string[]; save?: unknown }, home: string | null): PermissionAsk["choices"] {
  const always = alwaysWords(request, home);
  return [
    { answer: "once", title: "Allow Once", named: null, placeholder: null },
    { answer: "always", title: always.title, named: always.named, placeholder: null },
    { answer: "reject", title: "Don’t Allow", named: null, placeholder: null },
    { answer: "instead", title: "Tell It What to Do Instead…", named: null, placeholder: "Tell it what to do instead…" },
  ];
}

const STATUSES = new Set(["added", "deleted", "modified"]);

/** A permission as clients draw it. `command`: the whole command line its tool call runs. */
export function permissionAsk(request: EnginePermission, asker: string, folder: string, command: string | null, home: string): PermissionAsk {
  const action = String(request.action ?? "");
  const resources = strings(request.resources);
  const files = (Array.isArray(request.metadata?.files) ? request.metadata.files : []).flatMap(file => (isObject(file) && typeof file.file === "string"
    ? [{ file: file.file, patch: String(file.patch ?? ""), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, status: STATUSES.has(file.status as string) ? file.status as "added" | "deleted" | "modified" : null }]
    : []));
  return {
    id: request.id,
    kind: "permission",
    session: asker,
    title: permissionTitle(action, resources, folder, command),
    message: text(request.message),
    command,
    files,
    resources: resources.map(each => (action === "external_directory" ? outsideShown(each, home) : relativeTo(folder, each))),
    choices: choicesOf({ action, resources, ...(request.save !== undefined ? { save: request.save } : {}) }, home),
  };
}

// A question the cards take: a string (not a password) or a pick of several, shown as it is.
const takesChoiceOrWords = (field: Field) => (field.type === "string" && field.format !== "password") || field.type === "multiselect";
const shownFields = (fields: Field[]) => fields.filter(field => field.hidden !== true);

/** The agent's questions (its question tool's form), as the cards ask them, one at a time; null for
 * any other form (an MCP server's, a field a card can't take, one shown only after another answer). */
export function questionsOf(form: { metadata?: { kind?: unknown }; fields?: unknown; title?: unknown }): AskedQuestion[] | null {
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(isObject) as Field[];
  if (form.metadata?.kind !== "question" || !fields.length || !fields.every(takesChoiceOrWords)) return null;
  const shown = shownFields(fields);
  if (!shown.length || shown.some(field => Array.isArray(field.when) && field.when.length) || shown.some(field => typeof field.key !== "string")) return null;
  return shown.map(field => {
    const options = (Array.isArray(field.options) ? field.options : []).filter(isObject).map(option => ({
      value: String(option.value ?? option.label ?? ""), label: String(option.label ?? option.value ?? ""), description: text(option.description),
    }));
    const multiple = field.type === "multiselect";
    return {
      key: field.key as string,
      title: text(field.title),
      question: text(field.description) ?? text(field.title) ?? text(form.title) ?? "",
      options,
      multiple,
      // (Words of your own: where it takes them, or a question in words with no choices.)
      custom: field.custom === true || (!multiple && !options.length),
      required: field.required === true,
    };
  });
}

/** Everything `session` (on `target`, in `folder`) and its subagents wait on you for, oldest first:
 * not what Auto's reviewer took up. Throws `Unreached` when one asking can't be read. */
async function asksOf(target: Target, session: string, folder: string, signal?: AbortSignal): Promise<Found[]> {
  const wait = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000));
  const reviewed = new Set(listAskReviews().filter(review => review.state !== "yours").map(review => review.id));
  const noted = askTimes();
  const home = homeFolder();
  const found: { at: number; ask: Found }[] = [];
  const timeOf = (id: string, given: unknown) => noted.get(id) ?? (typeof given === "number" ? given : 0);
  // (A subagent listing that fails: the place isn't answering, so what was said last stands.)
  const askers = await askersOf(target, session, undefined, { wait }).catch(() => { throw new Unreached("The engine isn't answering."); });
  for (const asker of askers) {
    const at = `/api/session/${encodeURIComponent(asker)}`;
    let permissions: unknown, forms: unknown;
    try {
      [permissions, forms] = await Promise.all([call(target, "GET", `${at}/permission`, undefined, wait()), call(target, "GET", `${at}/form`, undefined, wait())]);
    } catch (error) {
      // (A subagent gone meanwhile asks nothing.)
      if ((error as { status?: number }).status === 404 && asker !== session) continue;
      throw new Unreached("The engine isn't answering.");
    }
    for (const request of (Array.isArray(permissions) ? permissions : []) as EnginePermission[]) {
      if (!isObject(request) || typeof request.id !== "string" || reviewed.has(request.id)) continue;
      const action = String(request.action ?? "");
      const source = isObject(request.source) ? request.source : null;
      const seen = (action === "shell" || action === "bash") && typeof source?.id === "string"
        ? await callOf(target, { asker, call: source.id, ...(typeof source.messageID === "string" ? { message: source.messageID } : {}) }, signal).catch(() => null)
        : null;
      const command = typeof seen?.input.command === "string" ? seen.input.command : null;
      found.push({ at: timeOf(request.id, request.time?.created), ask: { shown: permissionAsk(request, asker, folder, command, home), target, asker } });
    }
    for (const form of (Array.isArray(forms) ? forms : []) as (EngineForm & { fields?: unknown; time?: { created?: unknown } })[]) {
      if (!isObject(form) || typeof form.id !== "string") continue;
      const fields = ((Array.isArray(form.fields) ? form.fields : []) as unknown[]).filter(isObject) as Field[];
      const questions = questionsOf(form);
      const title = text(form.title) || "Question";
      const shown: SessionAsk = questions
        ? { id: form.id, kind: "question", session: asker, title, questions }
        : { id: form.id, kind: "other", session: asker, title, message: describeForm(form as EngineForm), dismiss: true };
      found.push({ at: timeOf(form.id, form.time?.created), ask: { shown, target, asker, form: { fields } } });
    }
  }
  // What MCP servers ask in its folder (filed under no session): one is the conversation's whose
  // step runs that server's tool, decided once for the folder as its notification decides it.
  const shared = folder ? await call(target, "GET", "/api/session/global/form", undefined, wait(), folder).catch(() => { throw new Unreached("The engine isn't answering."); }) : null;
  const get = (route: string) => call(target, "GET", `/${route}`, undefined, wait()).then(data => ({ data }));
  for (const form of (Array.isArray(shared) ? shared : []) as (EngineForm & { time?: { created?: unknown } })[]) {
    const server = isObject(form) && isObject(form.metadata) ? text((form.metadata as Record<string, unknown>).server) : null;
    if (!isObject(form) || typeof form.id !== "string" || !server) continue;
    const owner = (await sessionsWaitingOnServer(server, folder, get))[0];
    if (!owner || !askers.includes(owner)) continue;
    const shown: SessionAsk = { id: form.id, kind: "other", session, title: text(form.title) || server, message: describeForm(form), dismiss: true };
    found.push({ at: timeOf(form.id, form.time?.created), ask: { shown, target, asker: "global", folder } });
  }
  // What the box itself asks you for it: answered where its own cards are (the Mac, a phone).
  const asking = new Set(askers);
  for (const asked of listSandboxAsks()) {
    if (!asked.session || !asking.has(asked.session)) continue;
    const why = asked.why.trim();
    const shown: SessionAsk = { id: asked.id, kind: "other", session: asked.session, title: "Allow running this outside the sandbox?", message: why ? `${asked.command}\n${why}` : asked.command, dismiss: false };
    found.push({ at: asked.at, ask: { shown, target, asker: asked.session } });
  }
  for (const asked of listVaultAsks()) {
    if (!asked.session || !asking.has(asked.session)) continue;
    const what = asked.itemName ?? asked.need ?? asked.site;
    const title = asked.kind === "item" ? "Allow it something from the vault?" : "Allow it to use the vault?";
    const message = [what, asked.why].filter((each): each is string => typeof each === "string" && each.trim() !== "").join("\n") || "It asks for something from the vault.";
    found.push({ at: asked.at, ask: { shown: { id: asked.id, kind: "other", session: asked.session, title, message, dismiss: false }, target, asker: asked.session } });
  }
  // (Stable: what came at the same time, or unnoted, stays in the order it was listed.)
  return found.sort((a, b) => a.at - b.at).map(each => each.ask);
}

/** The session here, where it runs and its folder; null for none. Throws `Unreached`. */
async function placeOf(context: RouteContext, session: string) {
  const targets = targetsOf({ readEngine: context.readEngine, bridge: context.bridge });
  if (!targets.length) throw new Unreached("The engine isn't running.");
  const here = await sessionHere(targets, session, context.signal ?? undefined);
  if (!here) return null;
  const data: EngineSession = here.data;
  return { target: here.target, folder: data.location?.directory ?? data.directory ?? "" };
}

const NONE = { message: "There's no such conversation here." };
const GONE = { message: "It isn't waiting any more." };

/** A client's answer to a question, checked against what it asks, with the defaults of what it
 * didn't answer (its hidden fields' too), as the engine takes it; or why it doesn't fit. */
export function questionAnswer(fields: Field[], questions: AskedQuestion[], given: unknown): { answer: Record<string, unknown> } | { refused: string } {
  if (!isObject(given)) return { refused: "Send the answers, by each question's key." };
  const answer: Record<string, unknown> = {};
  for (const field of fields) if (typeof field.key === "string" && field.default !== undefined) answer[field.key] = field.default;
  for (const [key, value] of Object.entries(given)) {
    const question = questions.find(each => each.key === key);
    if (!question) return { refused: `It doesn't ask "${key}".` };
    const picked = question.multiple ? (typeof value === "string" ? [value] : value) : value;
    const each = question.multiple ? picked : [picked];
    if (!Array.isArray(each) || !each.every(one => typeof one === "string")) return { refused: `Answer "${question.title ?? key}" with ${question.multiple ? "a list of words" : "words"}.` };
    if (!question.custom && question.options.length && !each.every(one => question.options.some(option => option.value === one))) return { refused: `Pick one of the choices for "${question.title ?? key}".` };
    answer[key] = picked;
  }
  for (const question of questions) {
    if (!question.required) continue;
    const value = answer[question.key];
    const answered = Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.trim() !== "" : value !== undefined;
    if (!answered) return { refused: `Answer "${question.title ?? question.question}": it needs an answer.` };
  }
  return { answer };
}

// `GET kuvo/sessions/<id>/asks`, `…/asks/events`, and `POST …/asks/<ask>` to answer one.
export async function* sessionAsksRoute(context: RouteContext, match: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, json } = context;
  const method = request.method.toUpperCase();
  const session = decodeURIComponent(match[1]!);
  const ask = match[2] ? decodeURIComponent(match[2]) : null;
  const events = ask === "events" && method === "GET";
  if (ask && !events ? method !== "POST" : method !== "GET") return yield* json(405, {});
  let place: Awaited<ReturnType<typeof placeOf>>;
  try {
    place = await placeOf(context, session);
  } catch (error) {
    if (error instanceof Unreached) return yield* json(503, { message: error.message });
    throw error;
  }
  if (!place) return yield* json(404, NONE);
  const { target, folder } = place;
  const read = async () => ({ asks: (await asksOf(target, session, folder, signal ?? undefined)).map(each => each.shown) });
  // Followed, where it runs is found again each time (its engine started again on another port).
  const readAgain = async () => {
    const now = await placeOf(context, session);
    return now ? { asks: (await asksOf(now.target, session, now.folder, signal ?? undefined)).map(each => each.shown) } : { asks: [] };
  };
  if (!ask) {
    try {
      return yield* json(200, await read());
    } catch (error) {
      if (error instanceof Unreached) return yield* json(503, { message: error.message });
      throw error;
    }
  }
  if (events) {
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    // (A place not answering: what was said last stands.)
    // Told as an ask comes or goes in this process, and a look each second at the asks another
    // process noted (a machine's kept server isn't the one hearing its engine).
    const look = () => { try { return String(fs.statSync(ASKS_FILE).mtimeMs); } catch { return ""; } };
    return yield* followedLive(() => readAgain().catch(error => { if (error instanceof Unreached) return undefined; throw error; }), told => {
      askFollowers.add(told);
      return () => { askFollowers.delete(told); };
    }, signal ?? undefined, { look });
  }
  let found: Found | undefined;
  try {
    found = (await asksOf(target, session, folder, signal ?? undefined)).find(each => each.shown.id === ask);
  } catch (error) {
    if (error instanceof Unreached) return yield* json(503, { message: error.message });
    throw error;
  }
  if (!found) return yield* json(404, GONE);
  const given = parsed(request.body);
  const at = `/api/session/${encodeURIComponent(found.asker)}`;
  let sent: { method: string; route: string; body?: unknown };
  if (found.shown.kind === "permission") {
    const answer = isObject(given) ? given.answer : undefined;
    if (answer === "once" || answer === "always" || answer === "reject") sent = { method: "POST", route: `${at}/permission/${encodeURIComponent(found.shown.id)}/reply`, body: { decision: answer } };
    else if (answer === "instead") {
      const words = isObject(given) && typeof given.message === "string" ? given.message.trim() : "";
      if (!words) return yield* json(400, { message: "Say what it should do instead." });
      sent = { method: "POST", route: `${at}/permission/${encodeURIComponent(found.shown.id)}/reply`, body: { decision: "reject", message: words } };
    } else return yield* json(400, { message: "Answer once, always, reject or instead." });
  } else if (isObject(given) && given.dismiss === true && (found.shown.kind !== "other" || found.shown.dismiss)) {
    sent = { method: "DELETE", route: `${at}/form/${encodeURIComponent(found.shown.id)}` };
  } else if (found.shown.kind === "question") {
    const checked = questionAnswer(found.form?.fields ?? [], found.shown.questions as AskedQuestion[], isObject(given) ? given.answers : undefined);
    if ("refused" in checked) return yield* json(400, { message: checked.refused });
    sent = { method: "POST", route: `${at}/form/${encodeURIComponent(found.shown.id)}/reply`, body: { answer: checked.answer } };
  } else {
    const elsewhere = found.shown.kind === "other" && !found.shown.dismiss;
    return yield* json(400, { message: elsewhere ? "Answer this one in Kuvo Code on a Mac or a phone." : "This one is answered where it was asked: only dismissing it goes from here." });
  }
  try {
    await call(found.target, sent.method, sent.route, sent.body, AbortSignal.timeout(15_000), found.folder);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return yield* json(404, GONE);
    if (status === undefined) return yield* json(503, { message: "The engine isn't answering." });
    return yield* json(502, { message: String((error as Error).message) });
  }
  return yield* json(200, {});
}
