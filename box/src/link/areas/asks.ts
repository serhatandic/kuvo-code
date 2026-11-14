// What agents ask you for while they browse here (PROTOCOL.md, "kuvo/asks")
// The browser on this machine keeps what's asked in run/browser-asks.json (kuvo-browser.js): a
// phone answers it here as on the Mac, with the Mac closed too, and the answer goes to the
// browser over its socket. Its sign-ins are typed on the phone: saved passwords are the Mac's.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parsed } from "../../shared/json";
import { processRuns as runs } from "../../shared/platform";
import type { EngineRecord } from "../../shared/records";
import { pause } from "../../shared/wait";
import { engineGet, readEngineFile } from "../engine/client";
import type { EngineAnswer } from "../engine/client";
import type { EngineSession } from "../engine/sessions";
import { RUN, socketKey } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";
import type { ListedAskShape } from "../../shared/routes/asks";

/** What an agent asks for, as the browser keeps it (`run/browser-asks.json`): a sign-in (whether
 * it wants a username and a password), a code (with its prompt), or a step of yours (with what to
 * do); on a page at `host`, from `session`. */
export interface BrowserAsk {
  id: string;
  kind: "signIn" | "code" | "action";
  host?: string;
  session?: string;
  username?: boolean;
  password?: boolean;
  prompt?: string;
  instruction?: string;
  /** The site asked for a passkey, which the browser can't use yet. */
  passkey?: boolean;
}

/** An ask as `kuvo/asks` lists it, as the Mac's does. */
export type ListedAsk = ListedAskShape;

/** A phone's answer to an ask, as it sends it (`POST kuvo/asks/<id>`). */
export interface GivenAnswer {
  answer?: unknown;
  username?: unknown;
  password?: unknown;
  code?: unknown;
  /** A saved password named: the Mac's alone. */
  saved?: unknown;
}

/** An answer as the browser takes it (`Kuvo.answer`). */
export type AskAnswer =
  | { type: "signIn"; username: string | undefined; password: string | undefined }
  | { type: "code"; code: string }
  | { type: "done" }
  | { type: "declined" };

/** The notification for an ask, as the Mac words it. */
export interface AskNotice {
  title: string;
  subtitle: string | undefined;
  body: string;
  category: "ask";
  thread: string;
  data: { session?: string; ask: string };
}

/** The conversation an ask goes to: its id, and its name if it has one. */
interface Conversation {
  id: string;
  name: string | null;
}

export const ASKS_FILE = path.join(RUN, "browser-asks.json");
const BROWSER_SOCKET = path.join(RUN, "browser.sock");
const BROWSER_PID = path.join(RUN, "browser.pid");

// What's asked now: none while the browser isn't running (what one that ended, or a restart, left
// was asked of no one now).
export function readAsks(browserRuns: () => boolean = () => runs(Number(fs.readFileSync(BROWSER_PID, "utf8")), "kuvo-browser")) {
  try {
    if (!browserRuns()) return [];
    const asks: unknown = JSON.parse(fs.readFileSync(ASKS_FILE, "utf8")).asks;
    return Array.isArray(asks) ? asks.filter(ask => typeof ask?.id === "string" && ["signIn", "code", "action"].includes(ask.kind)) : [];
  } catch {
    return [];
  }
}

// One as the Mac's `kuvo/asks` lists it: this machine's name, who asks (`asker`, the asking
// conversation's name), and no saved passwords to pick from.
export function listedAsk(ask: BrowserAsk, machine: string, asker: string | null | undefined): ListedAsk {
  const listed: ListedAsk = { id: ask.id, kind: ask.kind, host: String(ask.host ?? ""), machine };
  if (typeof ask.session === "string") listed.session = ask.session;
  if (asker) listed.asker = asker;
  if (ask.kind === "signIn") Object.assign(listed, { username: Boolean(ask.username), password: Boolean(ask.password), saved: [], offersToSave: false });
  if (ask.kind === "code") listed.prompt = String(ask.prompt ?? "");
  if (ask.kind === "action") listed.instruction = String(ask.instruction ?? "");
  if (ask.passkey === true) listed.passkey = true;
  return listed;
}

// A phone's answer (`POST kuvo/asks/<id>`) as the browser takes it, by the Mac's rules; null for
// one that doesn't fit the ask, or names a saved password (the Mac's alone).
export function askAnswer(ask: BrowserAsk, given: GivenAnswer | null | undefined): AskAnswer | null {
  const text = (value: unknown) => typeof value === "string" && value !== "" ? value : undefined;
  switch (given?.answer) {
    case "signIn": {
      if (ask.kind !== "signIn" || given.saved != null) return null;
      const username = text(given.username), password = text(given.password);
      return username || password ? { type: "signIn", username, password } : null;
    }
    case "code": {
      const code = typeof given.code === "string" ? given.code.trim() : "";
      return ask.kind === "code" && code ? { type: "code", code } : null;
    }
    case "done":
      return ask.kind === "action" ? { type: "done" } : null;
    case "declined":
      return { type: "declined" };
    default:
      return null;
  }
}

// Gives the browser an answer over its socket; true once it took it.
export function answerAsk(id: string, answer: AskAnswer, socketPath = BROWSER_SOCKET): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let key: string;
    try { key = socketKey(); } catch { return resolve(false); }
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5000);
    socket.on("error", () => done(false));
    // The box's socket key first, as the keeper asks of every connection.
    socket.on("connect", () => socket.write(JSON.stringify({ method: "Kuvo.key", params: { key } }) + "\n" + JSON.stringify({ id: 1, method: "Kuvo.answer", params: { id, answer } }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { if (JSON.parse(line).id === 1) return done(true); } catch {}
      }
    });
  });
}

// The notification for an ask, as the Mac words it.
export function askNotice(ask: BrowserAsk, asker: string | null | undefined): AskNotice {
  const host = String(ask.host ?? "");
  const title = { signIn: `Sign in to ${host}`, code: `Code for ${host}`, action: `Your turn on ${host}` }[ask.kind];
  const body = ask.kind === "signIn" ? "The agent needs your sign-in to go on."
    : ask.kind === "code" ? (ask.prompt || "The agent needs a code to go on.") : String(ask.instruction ?? "");
  const session = typeof ask.session === "string" ? ask.session : undefined;
  return { title, subtitle: asker || undefined, body, category: "ask", thread: session ?? ask.id, data: { ...(session ? { session } : {}), ask: ask.id } };
}

// The conversation an ask goes to, as the Mac has it: a subagent's is the one it works for, which
// shows it and waits on you; with its name. From the engine, kept a while.
const conversations = new Map<string, Conversation>();
async function conversationOf(session: string | undefined, readEngine: () => EngineRecord = readEngineFile): Promise<Conversation | null> {
  if (!session) return null;
  if (conversations.has(session)) return conversations.get(session)!;
  try {
    const engine = readEngine();
    // (As the engine answers it: a session it has, whole; one it hasn't is an error.)
    let current = (await engineGet(engine, `api/session/${encodeURIComponent(session)}`) as EngineAnswer<EngineSession>).data;
    for (let step = 0; step < 5 && current?.parentID; step++) current = (await engineGet(engine, `api/session/${encodeURIComponent(current.parentID)}`) as EngineAnswer<EngineSession>).data;
    const found = { id: current?.id ?? session, name: current?.title || null };
    if (conversations.size > 200) conversations.clear();
    conversations.set(session, found);
    return found;
  } catch {
    return { id: session, name: null };
  }
}

// An ask as it's listed and told: in its conversation, by its name.
export async function inConversation(ask: BrowserAsk, readEngine?: () => EngineRecord): Promise<{ ask: BrowserAsk; asker: string | null }> {
  const conversation = await conversationOf(ask.session, readEngine);
  return { ask: conversation ? { ...ask, session: conversation.id } : ask, asker: conversation?.name ?? null };
}

// What's asked, to your phones' notifications, once (again if it didn't go): each once it's still
// asked a look later, so one a Mac answers at once (with a saved password) never buzzes a phone.
// `tell` says whether it went; `answered` hears of one told that's no longer asked. Every `every`
// ms, until `signal` stops it; `read`: what's asked (a test's).
export async function watchAsks(
  tell: (notice: AskNotice) => boolean,
  { signal, every = 2000, read = readAsks, answered = () => {} }: { signal?: AbortSignal; every?: number; read?: () => BrowserAsk[]; answered?: (id: string) => void } = {},
): Promise<void> {
  const told = new Set<string>();
  let seen = new Set<string>();
  while (!signal?.aborted) {
    try {
      const asks = read();
      const open = new Set(asks.map(ask => ask.id));
      for (const id of told) {
        if (open.has(id)) continue;
        told.delete(id);
        answered(id);
      }
      for (const ask of asks) {
        if (told.has(ask.id) || !seen.has(ask.id)) continue;
        const { ask: shown, asker } = await inConversation(ask);
        if (tell(askNotice(shown, asker))) told.add(ask.id);
      }
      seen = open;
    } catch {}
    await pause(every, signal);
  }
}

// What agents ask for while they browse here: listed, followed (a line each time it changes,
// as a Mac's), and answered.
export async function* asksRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, readEngine, info, json } = context;
  // The list is read with GET or HEAD, as every box's lists are; its events with GET.
  const method = request.method.toUpperCase();
  if (method !== "GET" && !(method === "HEAD" && route === "kuvo/asks")) return yield* json(405, {});
  const read = async () => ({
    asks: await Promise.all(readAsks().map(async ask => {
      const { ask: shown, asker } = await inConversation(ask, readEngine);
      return listedAsk(shown, info.name ?? os.hostname(), asker);
    })),
  });
  if (route === "kuvo/asks") return yield* json(200, await read());
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  let last = "";
  while (!signal?.aborted) {
    const line = JSON.stringify(await read());
    if (line !== last) {
      yield { body: Buffer.from(line + "\n") };
      last = line;
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  return;
}

export async function* askAnswerRoute(context: RouteContext, answering: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  const ask = readAsks().find(each => each.id === decodeURIComponent(answering[1]));
  if (!ask) return yield* json(404, {});
  const given = parsed(request.body) as GivenAnswer | null | undefined;
  const answer = askAnswer(ask, given);
  if (!answer) return yield* json(400, given?.saved != null ? { message: "Saved passwords are on your Mac: type this one." } : {});
  return yield* json((await answerAsk(ask.id, answer)) ? 200 : 503, {});
}
