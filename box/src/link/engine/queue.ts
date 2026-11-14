// The queue (PROTOCOL.md, "The queue")
// The engine keeps what you send in a session's inbox: a message for the agent's next step
// (`steer`), or one that waits for the run to end (`queue`). The engine doesn't start the next one
// after an interrupt, nor in every case after a run, so every box carries its queue on itself, the
// same for every client and with none connected: once a run ends, after a moment, the next one
// goes. A run that fails, a Stop (from any client), and a queue found with nothing running once
// the engine started again pause it until Resume; Stop holds what was for the next step ahead of
// the queue, the latest Stop's first. Kept in `run/queues.json`, by session.

import { keptParts, partsOf, withPartsOf } from "../messages/parts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isObject } from "../../shared/json";
import { locked, writePrivate } from "../files";
import { RUN } from "../home";
import { asked } from "./client";
import { carryUnderWay } from "./carrying";
import { summaryAtEnd } from "../../shared/summaries";
import { messageID } from "./sessions";
import * as files from "../../shared/queues";
import { boxNoteOf, isBoxNote, showsQueue, wakeMarkOf, type Outgoing, type QueueState, type Shown, type Waiting } from "../../shared/queues";
import type { QueueItem } from "../../shared/routes/sessions";
import type { Target } from "../../shared/records";

export type { Outgoing, QueueState, Shown, Waiting } from "../../shared/queues";
export { showsQueue };

const FILES = files.queueFiles(RUN);
export const QUEUES_FILE = FILES.file;
/** What waits on the box for a paused conversation, whole, as it goes to the engine: `<message id>.json`. */
export const WAITING_DIR = FILES.waiting;
/** How long after a run ends (or a message is queued while none runs) the next one goes: the engine
 * may still be handing over what it had. */
export const DRAIN_AFTER = 1500;

/** A message in a session's inbox, as far as the queue reads it (and a move carries it): what it
 * says and the files it brings, in the engine's form. */
interface InboxEntry {
  id: string;
  delivery: "steer" | "queue";
  type?: string;
  text?: unknown;
  payload?: { text?: unknown; files?: unknown; metadata?: unknown };
}

/** A queue as a client reads it. */
export const shownQueue = ({ paused, held, waiting }: QueueState): QueueState => ({ paused, held, ...(waiting?.length ? { waiting } : {}) });

/** Every session's queue the box keeps (one that's neither paused nor holds anything isn't kept). */
export const readQueues = (): Record<string, QueueState> => files.readQueues(FILES);

export const queueOf = (session: string): QueueState => readQueues()[session] ?? { paused: false, held: [] };

/** Told of each change this process makes (`kuvo/sessions/queues/events`). */
export const queueFollowers = new Set<() => void>();
const tellFollowers = () => { for (const tell of queueFollowers) tell(); };

/** `session`'s queue as `change` makes it, read again just before, under its lock. */
export const changeQueue = (session: string, change: (state: QueueState) => QueueState): QueueState => files.changeQueue(FILES, session, change, tellFollowers);

const address = (session: string) => encodeURIComponent(session);

async function inboxOf(target: Target, session: string, patience?: number): Promise<InboxEntry[]> {
  const answer = await asked(target, "GET", `api/session/${address(session)}/inbox`, undefined, patience) as { data?: unknown } | null;
  return Array.isArray(answer?.data) ? answer.data.filter((item): item is InboxEntry => isObject(item) && typeof item.id === "string" && (item.delivery === "steer" || item.delivery === "queue")) : [];
}

// (As the engine and the agents' bridge answer it: the sessions at work, as a list or by id.)
async function isRunning(target: Target, session: string): Promise<boolean> {
  const active = (await asked(target, "GET", "api/session/active") as { data?: string[] | Record<string, unknown> } | null)?.data ?? {};
  return Array.isArray(active) ? active.includes(session) : Boolean(active[session]);
}

// A summary asked for waits in an inbox too, but it's no message of yours: Stop and a failed run
// let it go, and nothing waits for Resume on its account.
const messagesIn = (inbox: InboxEntry[]) => inbox.filter(item => item.type !== "compaction");

/** What a run's end leaves of a summary that was waiting: on the bridge it's gone by then, with a
 * note in the conversation; the engine would run it unseen with whatever comes next. */
async function letSummariesGo(target: Target, session: string): Promise<void> {
  for (const item of await inboxOf(target, session)) {
    if (item.type === "compaction") await asked(target, "DELETE", `api/session/${address(session)}/inbox/${address(item.id)}`).catch(() => {});
  }
}

/** Whether a failed run was only a summary: the conversation is as it was. */
async function onlyASummaryFailed(target: Target, session: string): Promise<boolean> {
  const page = await asked(target, "GET", `api/session/${address(session)}/message?limit=6&order=desc`).catch(() => null) as { data?: unknown } | null;
  return summaryAtEnd(page?.data) === "failed";
}

const setDelivery = (target: Target, session: string, item: string, delivery: InboxEntry["delivery"]) =>
  asked(target, "PATCH", `api/session/${address(session)}/inbox/${address(item)}`, { delivery });
const interrupt = (target: Target, session: string, resume = false) =>
  asked(target, "POST", `api/session/${address(session)}/interrupt${resume ? "?resume=true" : ""}`);

/** What waits, by its ID, in the order it goes, as clients show it: what's held, in its order (in
 * the engine's inbox, or on the box), then the engine's for the next step, then its queue, then what
 * waits on the box. */
export function orderOf(inbox: InboxEntry[], { held, waiting = [] }: QueueState): string[] {
  const first = held.filter(id => inbox.some(item => item.id === id) || waiting.some(each => each.id === id));
  const then = (ids: string[]) => ids.filter(id => !first.includes(id));
  return [...first, ...then(inbox.filter(item => item.delivery === "steer").map(item => item.id)),
    ...then(inbox.filter(item => item.delivery === "queue").map(item => item.id)), ...then(waiting.map(each => each.id))];
}

const waitingFile = (id: string) => files.waitingFile(FILES, id);

/** `message` kept on the box while `session`'s queue is paused (see `Shown`): true. Not paused,
 * false: it isn't kept. `place`: where it goes (last, else). */
export const keepWaiting = (session: string, message: Outgoing & { id: string }, shown: Shown = {}, place?: files.Place): boolean => files.keepWaiting(FILES, session, message, shown, tellFollowers, place);

/** Where one put back (Undo) goes: just ahead of `before`, as `orderOf` shows them with `inbox`:
 * ahead of it in what waits on the box, or in what's held, one the engine has holding what's ahead
 * of it too (so they go in the same order); last when it isn't there any more. */
export const placedBefore = (inbox: InboxEntry[], before: string | undefined): files.Place => (given, item) => {
  const state = { ...given, held: given.held.filter(id => id !== item.id) };
  const waiting = state.waiting ?? [];
  const order = orderOf(inbox, state);
  const at = before && before !== item.id ? order.indexOf(before) : -1;
  if (at < 0) return { ...state, waiting: [...waiting, item] };
  const inHeld = state.held.indexOf(before!);
  if (inHeld >= 0) return { ...state, held: [...state.held.slice(0, inHeld), item.id, ...state.held.slice(inHeld)], waiting: [...waiting, item] };
  if (inbox.some(entry => entry.id === before)) {
    // (Not held: only the engine's are ahead of it.)
    return { ...state, held: [...state.held, ...order.slice(0, at).filter(id => !state.held.includes(id)), item.id], waiting: [...waiting, item] };
  }
  const there = waiting.findIndex(each => each.id === before);
  return { ...state, waiting: [...waiting.slice(0, there), item, ...waiting.slice(there)] };
};

/** `keepWaiting`, put back just ahead of `before` (`placedBefore`), as the engine's inbox is now. */
export async function keepWaitingBefore(target: Target, session: string, message: Outgoing & { id: string }, shown: Shown, before?: string): Promise<boolean> {
  const inbox = before ? await inboxOf(target, session).catch(() => []) : [];
  return keepWaiting(session, message, shown, placedBefore(inbox, before));
}

/** `message` to `session`, from the box itself (another agent's letter, a wake-up, a bot's work
 * news, an answer's note): while its queue is paused, kept to go once it goes on ("waits", see
 * `keepWaiting`); else sent now ("sent"). It throws when the engine doesn't take it. */
export async function sendInto(target: Target, session: string, message: Outgoing, shown: Shown = {}): Promise<"sent" | "waits"> {
  // (Its parts kept with it, for clients to draw it by, as `kuvo/sessions/<id>/send`'s are, where
  // there's more to them than its text: a message from another agent, one with a client's blocks.
  // Never the box's own notes, which clients draw as notes; a plain one a client asks about once.)
  const metadata = isBoxNote(message.metadata) ? message.metadata : withPartsOf(message.metadata, message.text);
  const whole = { ...message, id: message.id ?? messageID(), ...(metadata !== undefined ? { metadata } : {}) };
  if (keepWaiting(session, whole, shown)) return "waits";
  await asked(target, "POST", `api/session/${address(session)}/prompt`, whole);
  return "sent";
}

/** `item` (else the first) taken from what waits on the box for `session` (`resume`: the queue no
 * longer paused either): how it was shown, what goes, whole (null if its file is lost), and whether
 * it was held; null when it isn't waiting. `before`: what came after it then, as `orderOf` shows
 * them with `inbox`. */
function takeWaiting(session: string, item?: string, resume = false, inbox: InboxEntry[] = []): { shown: Waiting; message: (Outgoing & { id: string }) | null; held: boolean; before?: string } | null {
  let shown: Waiting | undefined;
  let held = false;
  let before: string | undefined;
  changeQueue(session, state => {
    shown = item ? state.waiting?.find(each => each.id === item) : state.waiting?.[0];
    if (!shown) return state;
    const order = orderOf(inbox, state);
    before = order[order.indexOf(shown.id) + 1];
    held = state.held.includes(shown.id);
    return { ...state, ...(resume ? { paused: false, resumed: Date.now() } : {}), held: state.held.filter(id => id !== shown!.id), waiting: state.waiting!.filter(each => each !== shown) };
  });
  if (!shown) return null;
  let whole: unknown = null;
  try { whole = JSON.parse(fs.readFileSync(waitingFile(shown.id), "utf8")); } catch {}
  fs.rmSync(waitingFile(shown.id), { force: true });
  const message = isObject(whole) && typeof whole.text === "string" && (whole.delivery === "steer" || whole.delivery === "queue")
    ? { id: shown.id, text: whole.text, delivery: whole.delivery, ...(Array.isArray(whole.files) ? { files: whole.files } : {}), ...(isObject(whole.metadata) ? { metadata: whole.metadata } : {}) } as Outgoing & { id: string }
    : null;
  return { shown, message, held, ...(before ? { before } : {}) };
}

/** `from`'s queue as `to`'s, its conversation going on in another session (carried on with the
 * coding agents): stopped, it stays stopped, and what waited on the box goes with it. `renamed`:
 * what the engine held, by its id where the conversation goes on. */
export function carryQueue(from: string, to: string, renamed: Record<string, string>): void {
  // Once for each carry: a conversation brought back keeps its mark, which comes again as it's
  // archived again (a client sends its metadata whole), and its queue is its own by then.
  const again = locked(FILES.lock, () => {
    let carried: Record<string, unknown> = {};
    try { carried = JSON.parse(fs.readFileSync(CARRIED_FILE, "utf8")) ?? {}; } catch {}
    if (carried[from] === to) return true;
    delete carried[from];
    carried[from] = to;
    const kept = Object.entries(carried).slice(-MOST_CARRIED);
    try { writePrivate(CARRIED_FILE, JSON.stringify(Object.fromEntries(kept))); } catch {}
    return false;
  });
  if (again) return;
  let was: QueueState = { paused: false, held: [] };
  changeQueue(from, state => { was = state; return { paused: false, held: [] }; });
  if (!showsQueue(was)) return;
  // (What waits on the box goes as it is, by its own ID.)
  const held = was.held.flatMap(id => renamed[id] ? [renamed[id]] : was.waiting?.some(each => each.id === id) ? [id] : []);
  changeQueue(to, state => ({ ...state, paused: state.paused || was.paused, held: [...state.held, ...held],
    ...(was.waiting?.length ? { waiting: [...(state.waiting ?? []), ...was.waiting] } : {}) }));
}

// The carries made, from one session to the one it went on in, the latest few hundred.
const CARRIED_FILE = path.join(RUN, "queues-carried.json");
const MOST_CARRIED = 300;

/** What waits for a conversation, as a move carries it to another box (`move.json`'s `queues`):
 * whether it's paused, what's held, and what waits (on the box, and what the engine held for it), as
 * it's shown and whole, in its order. */
export interface CarriedQueue {
  paused: boolean;
  held: string[];
  waiting: { shown: Waiting; message: unknown }[];
}

// What a file a carried message brings can weigh (as a model reads one, `attachedIn`'s); a
// bigger one stays behind.
const CARRIED_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
};

/** The files a message brings (as a prompt takes them, or the engine's inbox keeps them), as
 * another box can open them: each with what's in it, as a `data:` link; a file of this box's read
 * now. One that can't be read here, or is too big, stays behind. */
function carriedFiles(given: unknown): { uri: string; name?: string }[] {
  return (Array.isArray(given) ? given : []).flatMap(file => {
    if (!isObject(file)) return [];
    const name = typeof file.name === "string" ? { name: file.name } : {};
    const uri = isObject(file.source) && typeof file.source.uri === "string" ? file.source.uri : file.uri;
    const type = typeof file.mime === "string" && file.mime ? file.mime : null;
    if (typeof uri === "string" && uri.startsWith("data:")) return BASE64_DATA.test(uri) ? [{ uri, ...name }] : [];
    if (typeof file.data === "string") return [{ uri: `data:${type ?? "application/octet-stream"};base64,${file.data}`, ...name }];
    if (typeof uri !== "string" || !uri.startsWith("file:")) return [];
    try {
      const at = fileURLToPath(uri);
      if (fs.statSync(at).size > CARRIED_FILE_BYTES) return [];
      const bytes = fs.readFileSync(at);
      return [{ uri: `data:${type ?? FILE_TYPES[path.extname(at).toLowerCase()] ?? "application/octet-stream"};base64,${bytes.toString("base64")}`, name: name.name ?? path.basename(at) }];
    } catch {
      return [];
    }
  });
}

/** How a message the engine held is shown waiting (as one the box kept would be): another agent's
 * letter or a wake-up by who it's from, in its own words; yours as it is. */
function shownOfHeld(text: string): Shown {
  const mail = /^\[Message from (.*) · (?:ses_\S+|unknown)\] \([^\n]*\)\n\n([\s\S]*)$/.exec(text);
  if (mail) return { from: mail[1], words: mail[2] };
  if (text.startsWith("[Wake-up] ")) return { from: "Wake-up", words: text.slice("[Wake-up] ".length) };
  return {};
}

const fileNamesOf = (carried: { name?: string }[]): string[] => carried.map(file => file.name ?? "file");
// A file as a `data:` link with what's in it, as a carried message's files are.
const BASE64_DATA = /^data:[^,]*;base64,/;

/** One the engine held that a move can't carry (not a message, or one without words): the move
 * waits rather than leave it behind. */
export class CantCarry extends Error {}

/** The queues of `sessions` that are paused or have something waiting on the box, for a move
 * (`unpackQueues` sets them up on the box it goes to): what waits on the box, and for one that's
 * paused, what its engine (`target`) held, in the order they'd go (`orderOf`), with their files.
 * One not paused has nothing in the engine by then (a move waits for its inbox to empty). */
export async function packQueues(target: Target, sessions: readonly string[]): Promise<Record<string, CarriedQueue>> {
  const all = readQueues();
  const packed: Record<string, CarriedQueue> = {};
  for (const session of sessions) {
    const state = all[session];
    if (!state || (!state.paused && !state.waiting?.length)) continue;
    const inbox = state.paused ? await inboxOf(target, session) : [];
    const renamed: Record<string, string> = {};
    const waiting = orderOf(inbox, state).flatMap(id => {
      const shown = state.waiting?.find(each => each.id === id);
      if (shown) {
        let message: unknown = null;
        try { message = JSON.parse(fs.readFileSync(waitingFile(id), "utf8")); } catch {}
        if (!isObject(message) || !Array.isArray(message.files)) return [{ shown, message }];
        // Shown with the files that go with it.
        const carried = carriedFiles(message.files);
        const { files: _names, ...rest } = shown;
        return [{ shown: { ...rest, ...(carried.length ? { files: fileNamesOf(carried) } : {}) }, message: { ...message, files: carried } }];
      }
      // One the engine held: waiting on the box there, as one kept here would.
      const held = inbox.find(item => item.id === id);
      const text = typeof held?.text === "string" ? held.text : typeof held?.payload?.text === "string" ? held.payload.text : null;
      if (!held) return [];
      if (held.type !== "user" || text === null) throw new CantCarry(id);
      // (An ID the box can't name a file by: one of its own, the same each time it's packed.)
      const ownID = /^msg_[A-Za-z0-9]{1,80}$/.test(id) ? id : (renamed[id] = `msg_${crypto.createHash("sha256").update(id).digest("hex").slice(0, 32)}`);
      const carried = carriedFiles(held.payload?.files);
      const { from, words } = shownOfHeld(text);
      return [{
        shown: { id: ownID, ...(from ? { from } : {}), text: words ?? text, ...(carried.length ? { files: fileNamesOf(carried) } : {}), at: Date.now() },
        message: { id: ownID, text, delivery: "queue", ...(carried.length ? { files: carried } : {}), ...(isObject(held.payload?.metadata) ? { metadata: held.payload.metadata } : {}) },
      }];
    });
    const ids = new Set(waiting.map(each => each.shown.id));
    packed[session] = { paused: state.paused, held: state.held.map(id => renamed[id] ?? id).filter(id => ids.has(id)), waiting };
  }
  return packed;
}

/** The queues a move brought (`packQueues`'s), for `sessions` only, kept here paused while its copy
 * is held, in place of any it had: what waits, whole, in its order (one whose contents didn't come,
 * left out; a file only with what's in it). The sessions whose queue went on where it came from, to
 * go on here once it's switched to. */
export function unpackQueues(carried: unknown, sessions: readonly string[]): string[] {
  if (!isObject(carried)) return [];
  const goOn: string[] = [];
  for (const session of sessions) {
    const queue = carried[session];
    if (!isObject(queue)) continue;
    forgetQueue(session);
    const waiting: Waiting[] = [];
    for (const each of Array.isArray(queue.waiting) ? queue.waiting : []) {
      const [shown] = files.keptWaiting([isObject(each) ? each.shown : null]);
      const message = isObject(each) && isObject(each.message) ? each.message : null;
      if (!shown || !message || typeof message.text !== "string" || waiting.some(other => other.id === shown.id)) continue;
      const brought = (Array.isArray(message.files) ? message.files : []).flatMap(file => isObject(file) && typeof file.uri === "string" && BASE64_DATA.test(file.uri)
        ? [{ uri: file.uri, ...(typeof file.name === "string" ? { name: file.name } : {}) }] : []);
      writePrivate(waitingFile(shown.id), JSON.stringify({ id: shown.id, text: message.text, delivery: message.delivery === "steer" ? "steer" : "queue", ...(brought.length ? { files: brought } : {}) }));
      waiting.push(shown);
    }
    const held = (Array.isArray(queue.held) ? queue.held : []).filter((id): id is string => typeof id === "string" && waiting.some(each => each.id === id));
    changeQueue(session, () => ({ paused: true, held, ...(waiting.length ? { waiting } : {}) }));
    if (queue.paused !== true) goOn.push(session);
  }
  return goOn;
}

/** `session`'s queue forgotten, and what waited on the box for it (its conversation is gone). */
export function forgetQueue(session: string): void {
  let gone: Waiting[] = [];
  changeQueue(session, state => {
    gone = state.waiting ?? [];
    return { paused: false, held: [] };
  });
  for (const each of gone) fs.rmSync(waitingFile(each.id), { force: true });
}

/** One taken away from what waits on the box (Remove, or Edit): how it was shown, what would have
 * gone, and what came after it, as `orderOf` shows them with `inbox` (for Undo to put back as it
 * was, where it was); null when it isn't there. */
export function dropWaiting(session: string, item: string, inbox: InboxEntry[] = []): ReturnType<typeof takeWaiting> {
  return takeWaiting(session, item, false, inbox);
}

/** The engine's inbox for `session`, as far as the queue reads it (none, when it can't be read). */
export const inboxFor = (target: Target, session: string): Promise<InboxEntry[]> => inboxOf(target, session).catch(() => []);

/** The engine's inbox for `session` as it is now, its messages only (no summary waiting); it throws
 * when it can't be read. */
export const inboxNow = (target: Target, session: string, patience?: number): Promise<InboxEntry[]> => inboxOf(target, session, patience).then(messagesIn);

/** Told, with its session, each time an engine's (or the coding agents' bridge's) inbox changes
 * (`session.inbox.*`), in the box's long-running process. */
export const inboxFollowers = new Set<(session: string) => void>();

/** A message the engine holds, as clients show it waiting (as one the box keeps is): who it's from
 * (another agent, a wake-up, the box's own note; none for yours), what you wrote (its kept parts'
 * words, or its text without what the box added for the agent), the keyword it was sent with, and
 * its files' names. */
function shownOfInbox(entry: InboxEntry): { from: string | null; words: string; keyword: string | null; files: string[] } {
  const text = typeof entry.payload?.text === "string" ? entry.payload.text : typeof entry.text === "string" ? entry.text : "";
  const metadata = entry.payload?.metadata;
  const files = (Array.isArray(entry.payload?.files) ? entry.payload.files : []).flatMap(file => {
    if (!isObject(file)) return [];
    const uri = isObject(file.source) && typeof file.source.uri === "string" ? file.source.uri : typeof file.uri === "string" ? file.uri : "";
    if (typeof file.name === "string" && file.name) return [file.name];
    // (A link the system can't read as a path here, `file://host/…`: named as a file.)
    try { return [uri.startsWith("file:") ? path.basename(fileURLToPath(uri)) : "file"]; } catch { return ["file"]; }
  });
  const note = boxNoteOf(text, metadata);
  if (note) return { from: note.from, words: note.line, keyword: null, files };
  const parts = keptParts(metadata) ?? partsOf(text);
  if (parts.mail) return { from: parts.mail.name, words: parts.words, keyword: null, files };
  const held = shownOfHeld(text);
  if (held.from) return { from: held.from, words: held.words ?? text, keyword: null, files };
  if (wakeMarkOf(metadata)) return { from: "Wake-up", words: parts.words, keyword: null, files };
  return { from: null, words: parts.words, keyword: parts.keyword ?? null, files };
}

/** Every message waiting for `session`, in the order clients show them (`orderOf`), with `inbox`
 * (the engine's, its messages only) and what waits on the box (`state`). */
export function queueItems(inbox: InboxEntry[], state: QueueState): QueueItem[] {
  return orderOf(inbox, state).flatMap((id): QueueItem[] => {
    const held = state.held.includes(id);
    const kept = state.waiting?.find(each => each.id === id);
    if (kept) {
      let delivery: "steer" | "queue" = "queue";
      try { if (JSON.parse(fs.readFileSync(waitingFile(id), "utf8"))?.delivery === "steer") delivery = "steer"; } catch {}
      return [{ id, words: kept.text, files: kept.files ?? [], keyword: kept.keyword ?? null, from: kept.from ?? null, on: "box", delivery, held }];
    }
    const entry = inbox.find(each => each.id === id);
    return entry ? [{ id, ...shownOfInbox(entry), on: "engine", delivery: entry.delivery, held }] : [];
  });
}

/** The files a message the engine holds brings, as a send takes them (`{uri, name}`), so they can
 * go again: by where they are, or, sent in the message itself, with what's in them. */
function sendableFiles(given: unknown): { uri: string; name?: string }[] {
  return (Array.isArray(given) ? given : []).flatMap(file => {
    if (!isObject(file)) return [];
    const name = typeof file.name === "string" ? { name: file.name } : {};
    const uri = isObject(file.source) && typeof file.source.uri === "string" ? file.source.uri : file.uri;
    if (typeof uri === "string" && uri) return [{ uri, ...name }];
    if (typeof file.data === "string") return [{ uri: `data:${typeof file.mime === "string" && file.mime ? file.mime : "application/octet-stream"};base64,${file.data}`, ...name }];
    return [];
  });
}

/** `item` taken back from what the engine (or the coding agents' bridge) holds for `session`
 * (Edit, or Remove): as `DELETE …/queue/<item>` answers one waiting on the box (`removed`), with
 * what came after it (`before`, as `orderOf` shows them). Null when it isn't waiting there (any
 * more: the agent took it first). It throws when the engine doesn't answer, or keeps it. */
export async function takeBackFromInbox(target: Target, session: string, item: string): Promise<{ id: string; text: string; files?: { uri: string; name?: string }[]; delivery: "steer" | "queue"; from?: string; words: string; before?: string } | null> {
  const inbox = messagesIn(await inboxOf(target, session));
  const entry = inbox.find(each => each.id === item);
  if (!entry) return null;
  const order = orderOf(inbox, queueOf(session));
  const before = order[order.indexOf(item) + 1];
  try {
    await asked(target, "DELETE", `api/session/${address(session)}/inbox/${address(item)}`);
  } catch (error) {
    if (/ 404\.$/.test(String((error as Error | null)?.message))) return null;
    throw error;
  }
  // (A cancel that comes too late changes nothing, and says nothing: what it holds now, and the
  // conversation, say which won.)
  if ((await inboxOf(target, session)).some(each => each.id === item)) throw new Error("It couldn't be taken back. Try again in a moment.");
  const recent = await asked(target, "GET", `api/session/${address(session)}/message?limit=40&order=desc`).catch(() => null) as { data?: unknown } | null;
  if (Array.isArray(recent?.data) && recent.data.some(message => isObject(message) && message.id === item)) return null;
  changeQueue(session, state => ({ ...state, held: state.held.filter(id => id !== item) }));
  const shown = shownOfInbox(entry);
  const text = typeof entry.payload?.text === "string" ? entry.payload.text : typeof entry.text === "string" ? entry.text : "";
  const files = sendableFiles(entry.payload?.files);
  return { id: item, text, ...(files.length ? { files } : {}), delivery: entry.delivery, ...(shown.from ? { from: shown.from } : {}), words: shown.words, ...(before ? { before } : {}) };
}

/** `session`'s next waiting message started, unless its queue is paused or a run is under way: as
 * `orderOf` has them, one in the engine's inbox by steering it (which starts a run) if it's queued,
 * by resuming if it's for the next step; one waiting on the box, sent to go now. */
export async function drain(target: Target, session: string): Promise<void> {
  if (queueOf(session).paused || (await isRunning(target, session))) return;
  const inbox = await inboxOf(target, session);
  const first = orderOf(inbox, queueOf(session))[0];
  // (Stopped, or started, while it looked: as it is now.)
  if (queueOf(session).paused || (await isRunning(target, session))) return;
  if (!first) return;
  const next = inbox.find(item => item.id === first);
  if (!next) return sendWaiting(target, session, first);
  if (next.delivery === "queue") await setDelivery(target, session, next.id, "steer");
  else await interrupt(target, session, true);
  changeQueue(session, state => ({ ...state, held: state.held.filter(id => id !== next.id) }));
}

// `item` waiting on the box for `session`, to go now (nothing runs): back where it was if the
// engine doesn't take it, unless the conversation is gone. One whose contents were lost goes no
// further, and the next goes instead.
async function sendWaiting(target: Target, session: string, item: string): Promise<void> {
  const taken = takeWaiting(session, item);
  if (!taken) return;
  if (!taken.message) return drain(target, session);
  try {
    await asked(target, "POST", `api/session/${address(session)}/prompt`, { ...taken.message, delivery: "steer" });
  } catch (error) {
    if (/ 404\.$/.test(String((error as Error | null)?.message))) return;
    putBack(session, { ...taken, message: taken.message });
    throw error;
  }
}

// A message taken to go that didn't: where `place` puts it, as it was shown; else (it was the first
// to go) first again, held first if it was held.
function putBack(session: string, { message, shown, held }: { message: Outgoing & { id: string }; shown: Waiting; held: boolean }, place?: files.Place) {
  changeQueue(session, state => {
    writePrivate(waitingFile(message.id), JSON.stringify(message));
    const without = { ...state, held: state.held.filter(id => id !== shown.id), waiting: (state.waiting ?? []).filter(each => each.id !== shown.id) };
    if (place) return place(without, shown);
    return { ...without, ...(held ? { held: [shown.id, ...without.held] } : {}), waiting: [shown, ...without.waiting] };
  });
}

/** What waits for `session`'s next step held in its queue, ahead of what was queued (the latest
 * first), and the queue paused when anything waits, in the engine or on the box: what Stop does
 * before it stops the run, and a failed run's. */
// `since`: for an interrupt then (ms), unless Resume or Send Now went on with it after. `items`:
// messages a client held as they went (queued or not), put first, in that order.
export async function holdQueue(target: Target, session: string, since?: number, items: string[] = []): Promise<QueueState> {
  const resumedSince = () => since !== undefined && (queueOf(session).resumed ?? 0) >= since;
  const inbox = messagesIn(await inboxOf(target, session));
  if (resumedSince()) return queueOf(session);
  const held = queueOf(session).held;
  const named = items.filter(id => inbox.some(item => item.id === id));
  const steering = inbox.filter(item => item.delivery === "steer" && !held.includes(item.id) && !named.includes(item.id)).map(item => item.id);
  // Held only once it's in the queue (the agent may take one first).
  const moved: string[] = [];
  for (const id of [...named, ...steering]) {
    if (inbox.find(item => item.id === id)?.delivery !== "steer") moved.push(id);
    else if (await setDelivery(target, session, id, "queue").then(() => true, () => false)) moved.push(id);
  }
  const waiting = await inboxOf(target, session).then(messagesIn, () => inbox);
  return changeQueue(session, state => {
    // (One held that waits on the box stays held.)
    const there = (id: string) => waiting.some(item => item.id === id) || Boolean(state.waiting?.some(each => each.id === id));
    return since !== undefined && (state.resumed ?? 0) >= since ? state
      : { ...state, paused: state.paused || waiting.length > 0 || Boolean(state.waiting?.length), held: [...moved.filter(there), ...state.held.filter(id => !moved.includes(id) && there(id))] };
  });
}

/** Stop: what waits held, the queue paused whether anything waits or not (what arrives later waits
 * on the box), then the run stopped. `holds` false (a bot stopping a session of its work, which it
 * may write to again): paused only when something waits, as a failed run's. */
export async function stopSession(target: Target, session: string, holds = true): Promise<QueueState> {
  const held = await holdQueue(target, session);
  const state = holds ? changeQueue(session, current => ({ ...current, paused: true })) : held;
  await interrupt(target, session);
  return state;
}

/** Resume: the queue goes on, its next message now. */
export async function resumeQueue(target: Target, session: string): Promise<QueueState> {
  changeQueue(session, current => ({ ...current, paused: false, resumed: Date.now() }));
  await drain(target, session);
  return queueOf(session);
}

/** Send Now: `item` to the agent right away, the step under way stopped for it (one that runs goes
 * on from there with it), the queue no longer paused. False when it isn't waiting. */
export async function sendNow(target: Target, session: string, item: string): Promise<boolean> {
  // One waiting on the box: to the engine for now (back where it was if the engine doesn't take it).
  const inbox = await inboxFor(target, session);
  const kept = takeWaiting(session, item, true, inbox);
  if (kept) {
    if (!kept.message) return false;
    const running = await isRunning(target, session);
    try {
      await asked(target, "POST", `api/session/${address(session)}/prompt`, { ...kept.message, delivery: "steer" });
    } catch (error) {
      putBack(session, { ...kept, message: kept.message }, placedBefore(inbox, kept.before));
      throw error;
    }
    if (running) await interrupt(target, session, true);
    return true;
  }
  const entry = (await inboxOf(target, session)).find(each => each.id === item);
  if (!entry) return false;
  // (What waits on the box stays, to go after it.)
  changeQueue(session, state => ({ ...state, paused: false, held: state.held.filter(id => id !== item), resumed: Date.now() }));
  const running = await isRunning(target, session);
  // Steering wakes an idle session; a running one gets it once the step stops.
  if (entry.delivery === "queue") await setDelivery(target, session, item, "steer");
  if (running || entry.delivery === "steer") await interrupt(target, session, true);
  return true;
}

/** An event, as far as the queue reads it. */
export interface QueueEvent {
  type: string;
  data?: { sessionID?: string; inboxID?: string; item?: { type?: string; delivery?: string; payload?: { text?: unknown; metadata?: unknown } }; reason?: string; metadata?: Record<string, unknown> };
}

// A message you wrote, not one Kuvo Code sent the agent for you or another (an agent's letter, a
// wake-up, a group chat's work, a note).
// (Those marked as the box's own, and the ones a box sent before it marked them.)
const NOT_YOURS = ["[Message from ", "[Wake-up]", "[Work from ", "[Session ", "[Goal started]", "[Goal changed]", "[Goal's end]", "[Goal resumed]", "[Not now]", "[Limit reset]", "[The user answered]"];
export const writtenByYou = (text: unknown, metadata: unknown) => !isBoxNote(metadata) && !NOT_YOURS.some(start => String(text ?? "").startsWith(start));
// What the box says of its own accord (what another session did, a limit that reset), rather than
// passes on from someone: a letter or work from an agent, or what you answered, approved or picked.
const FROM_SOMEONE = ["[Message from ", "[Work from ", "[The user ", "[Decision changed]"];
export const isBoxsOwnWord = (text: unknown, metadata: unknown) => !writtenByYou(text, metadata) && !FROM_SOMEONE.some(start => String(text ?? "").startsWith(start));
const isYours = (item: NonNullable<NonNullable<QueueEvent["data"]>["item"]>) => item.type === "user" && writtenByYou(item.payload?.text, item.payload?.metadata);

/** How the queue's watcher waits (a test's clock). */
export interface QueueWatch {
  after?: number;
  /** The sessions `scanQueues` found at work as this stream connected (`ScanFound`): each settled
   * as it would have, once the session says it's free. */
  found?: ScanFound;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** What the box does with its engine's (or the coding agents' bridge's) events for the queue. A
 * run that ends well: the next message, a moment later. Stopped (the engine says by you, or as it
 * shut down; the bridge says nothing): held and paused a moment later, unless a run started again
 * meanwhile (Send Now's resume does at once), whichever client stopped it; one the engine ended
 * itself (superseded, idle too long) goes on as one that ended well. Failed: held and paused. A message queued while nothing runs: it goes, a moment
 * later; one for the next step: the queue isn't paused any more (you sent a message to go now).
 * One delivered or taken back leaves what's held. Paused, it stays so until Resume, Send Now or a
 * message of yours to go now, though nothing is left waiting: what arrives then waits on the box. */
export function queueWatcher(target: Target, { after = DRAIN_AFTER, schedule = setTimeout, cancel = clearTimeout as (timer: unknown) => void, found }: QueueWatch = {}): (event: QueueEvent) => void {
  const drains = new Map<string, unknown>();
  const stops = new Map<string, unknown>();
  const later = (timers: Map<string, unknown>, session: string, work: () => Promise<unknown>) => {
    if (timers.has(session)) cancel(timers.get(session));
    timers.set(session, schedule(() => {
      timers.delete(session);
      work().catch(() => {});
    }, after));
  };
  const forget = (timers: Map<string, unknown>, session: string) => {
    if (timers.has(session)) cancel(timers.get(session));
    timers.delete(session);
  };
  // A run's end, a moment on: `then`, once the session's no longer at work (`waited`: it said it
  // was free since). Still at work (the coding agents' bridge keeping the files a run changed),
  // looked at again once it says it's free (`session.idle`). Only the latest end, until a run starts.
  interface End { timers: Map<string, unknown>; then: (waited: boolean) => Promise<unknown> }
  const ends = new Map<string, End>();
  const look = (session: string, end: End, waited: boolean) => later(end.timers, session, async () => {
    if (ends.get(session) !== end) return;
    const running = await isRunning(target, session).catch(() => false);
    if (running || ends.get(session) !== end) return;
    ends.delete(session);
    await end.then(waited);
  });
  const ended = (session: string, timers: Map<string, unknown>, then: End["then"]) => {
    const end = { timers, then };
    ends.set(session, end);
    look(session, end, false);
  };
  return event => {
    const session = event.data?.sessionID;
    if (!session) return;
    // (What a client follows of the queue, read again.)
    if (event.type.startsWith("session.inbox.")) for (const told of inboxFollowers) try { told(session); } catch {}
    switch (event.type) {
      case "session.execution.started":
        forget(drains, session);
        forget(stops, session);
        ends.delete(session);
        break;
      case "session.execution.succeeded":
        forget(stops, session);
        ended(session, drains, () => drain(target, session).catch(() => drain(target, session)));
        break;
      case "session.execution.interrupted": {
        if (event.data?.reason === "superseded" || event.data?.reason === "inactivity") {
          ended(session, drains, () => drain(target, session));
          break;
        }
        // A Stop: held and paused, unless it was resumed since (Resume, or Send Now's stop-and-go,
        // which go on by themselves). Resumed by the time the bridge says it's free (Resume's own
        // look may have found it still at work), its next goes now.
        const at = Date.now();
        ended(session, stops, async waited => {
          if ((queueOf(session).resumed ?? 0) < at) {
            await holdQueue(target, session, at);
            await letSummariesGo(target, session);
          } else if (waited) await drain(target, session);
        });
        break;
      }
      case "session.idle": {
        // Free now (the coding agents' bridge, once it kept what a run changed or put files
        // back): what its end left to do; one this stream connected to while it was at work (a
        // run's end not heard), as `scanQueues` would have.
        const end = ends.get(session);
        const known = found?.get(session);
        found?.delete(session);
        if (end) look(session, end, true);
        else if (known !== undefined) later(drains, session, async () => { if (!(await isRunning(target, session))) await settleFound(target, session, known); });
        break;
      }
      case "session.execution.failed": {
        forget(stops, session);
        // (Not when resumed since.) Resumed while the bridge was still keeping what it changed:
        // its next goes once it's free.
        const at = Date.now();
        // Only a summary that failed: what's queued goes on, as after any turn.
        const onlySummary = onlyASummaryFailed(target, session);
        onlySummary.then(async only => {
          if (only) return;
          await holdQueue(target, session, at);
          await letSummariesGo(target, session);
        }).catch(() => {});
        ended(session, stops, async waited => {
          if (await onlySummary) await drain(target, session);
          else if (waited && (queueOf(session).resumed ?? 0) >= at) await drain(target, session);
        });
        break;
      }
      case "session.inbox.enqueued":
        // You writing to it for now: it goes on. (Not a letter, a wake-up or a note.)
        if (event.data?.item?.delivery === "steer" && isYours(event.data.item)) changeQueue(session, state => ({ ...state, paused: false }));
        else if (!queueOf(session).paused) later(drains, session, () => drain(target, session));
        break;
      case "session.metadata.updated": {
        // Carried on in another session (moved to the coding agents, by a client or this box): its
        // queue goes on there. (Only while it's put away as carried: one brought back keeps the
        // mark, which a client sends again with every later change, and its queue is its own.)
        const metadata = event.data?.metadata;
        const to = metadata?.["kuvo.carriedTo"];
        // (Not while this box carries it: the carry takes its queue itself, with what it renames.)
        if (metadata?.["kuvo.archived"] === true && typeof to === "string" && to.startsWith("ses_") && to !== session && !carryUnderWay(session)) carryQueue(session, to, {});
        break;
      }
      case "session.deleted":
        // Gone: its queue and what waited for it with it.
        forget(drains, session);
        forget(stops, session);
        ends.delete(session);
        forgetQueue(session);
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        const gone = event.data?.inboxID;
        if (!queueOf(session).held.length) break;
        inboxOf(target, session).then(inbox => changeQueue(session, state => ({
          ...state,
          // (One held that waits on the box stays held.)
          held: state.held.filter(id => (id !== gone && inbox.some(item => item.id === id)) || Boolean(state.waiting?.some(each => each.id === id))),
        }))).catch(() => {});
        break;
      }
    }
  };
}

// The engine (or the agents' bridge) whose queues were last looked over, by its port, kept in
// `run/` so a box that starts again beside the same engine doesn't take it for a new one.
const SCANNED_FILE = path.join(RUN, "queues-scanned.json");

// Whether `session`'s last run was stopped or failed, as its newest message says (the run's end,
// as the engine and the bridge mark it, or an answer that ended in an error); unknown, it was.
async function endedBadly(target: Target, session: string): Promise<boolean> {
  const page = await asked(target, "GET", `api/session/${address(session)}/message?limit=1&order=desc`).catch(() => null) as { data?: { type?: string; outcome?: unknown; error?: unknown }[] } | null;
  if (!Array.isArray(page?.data)) return true;
  const last = page.data[0];
  if (last?.type === "idle") return last.outcome !== "succeeded";
  return last?.type === "assistant" && isObject(last.error);
}

/** Sessions with messages waiting that `scanQueues` found at work: whether it knew their engine
 * (else it started anew), for the watcher to settle each once it's free. */
export type ScanFound = Map<string, boolean>;

// A queue found as an engine was found: one the same engine left (`known`) goes on unless its run
// stopped or failed; else held and paused, as Stop holds them.
async function settleFound(target: Target, session: string, known: boolean): Promise<void> {
  if (known && !(await endedBadly(target, session))) await drain(target, session);
  else await holdQueue(target, session);
}

/** Once for each engine started anew (its process changed): each of its latest sessions with
 * messages waiting and nothing running held and paused, as Stop holds them. The same engine (the
 * box started again, or its stream dropped and came back): their queues go on, as after a run
 * that ended while it couldn't hear; held and paused as above if it was stopped or failed. One at
 * work then goes in `found`, for the watcher. */
export async function scanQueues(target: Target & { pid?: number }, found?: ScanFound): Promise<void> {
  const known = locked(FILES.lock, () => {
    let scanned: Record<string, unknown> = {};
    try { scanned = JSON.parse(fs.readFileSync(SCANNED_FILE, "utf8")) ?? {}; } catch {}
    if (target.pid !== undefined && scanned[target.port] === target.pid) return true;
    scanned[target.port] = target.pid;
    try { writePrivate(SCANNED_FILE, JSON.stringify(scanned)); } catch {}
    return false;
  });
  const page = await asked(target, "GET", "api/session?parentID=null&limit=100&order=desc") as { data?: { id?: string; time?: { updated?: number } }[] } | null;
  const week = Date.now() - 7 * 86_400_000;
  for (const session of page?.data ?? []) {
    if (typeof session.id !== "string" || (session.time?.updated ?? 0) < week) continue;
    try {
      if (!(await inboxOf(target, session.id)).length) continue;
      if (await isRunning(target, session.id)) {
        found?.set(session.id, known);
        // (Its word that it's free may have come before it was found: free now, it's settled here,
        // unless the watcher heard that and took it.)
        if (!found || (await isRunning(target, session.id)) || !found.delete(session.id)) continue;
      }
      await settleFound(target, session.id, known);
    } catch {}
  }
  // What waits on the box for one that isn't paused (the box stopped before it went): it goes now.
  // (A session of the engine's or the bridge's: the other one doesn't have it, and keeps it.)
  for (const [session, state] of Object.entries(readQueues())) {
    if (state.paused || !state.waiting?.length) continue;
    try {
      await asked(target, "GET", `api/session/${address(session)}`);
    } catch {
      continue;
    }
    await drain(target, session).catch(() => {});
  }
}
