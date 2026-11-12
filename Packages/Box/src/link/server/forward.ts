// Forwarding to the engine
// What isn't the box's own goes on to the engine, or to the coding agents' bridge (`kuvo/agents/…`),
// a phone's prompts with who they name told, and that they're from a phone.

import { agentsDown } from "../areas/agents-down";
import { engineDown, stopShell } from "../areas/engine";
import { IS_MAC } from "../home";
import { holdArchived } from "../areas/wakes";
import { MOVING } from "../bots/here";
import { frozen } from "../moves/records";
import { inTurnOn } from "../engine/notes";
import { NOTES_STEP } from "../../shared/session-notes";
import { pause } from "../../shared/wait";
import { stopIfWaiting } from "../work/answers";
import { attachedIn } from "./attached";
import type { ModelInput } from "./attached";
import { namedIn, namingHere } from "./naming";
import { agentsAllowed, allowed, canonicalPath, REQUEST_HEADERS, RESPONSE_HEADERS } from "./paths";
import type { EngineRecord, Target } from "../../shared/records";
import type { EngineSession } from "../engine/sessions";
import type { AnswerPiece, LinkRequest, RouteContext } from "./context";
import type { Naming } from "./naming";

export const AGENTS = "kuvo/agents/";

// The block a prompt from a phone ends with, for the agent, in the Mac's words (FromPhone.swift):
// the user is on their iPhone, where a file is shown with show_file. Never shown.
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join("\n");

// A prompt's body with the block at the end of its text, once; any other body as it is.
export function fromPhone(body: Buffer | undefined): Buffer | undefined {
  let prompt: { text?: unknown } | null;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || prompt.text.trimEnd().endsWith("</from-phone>")) return body;
  return Buffer.from(JSON.stringify({ ...prompt, text: `${prompt.text}\n\n${FROM_PHONE}` }));
}

// What the model of `session` takes as input, as the engine at `base` says (its own model, or the
// engine's default): for the files a message carries (`attachedIn`).
export function modelInput(base: URL, headers: Record<string, string>, signal: AbortSignal | undefined): ModelInput {
  const read = async (at: string): Promise<unknown> => {
    const response = await fetch(new URL(at, base), { headers, signal });
    return response.ok ? ((await response.json()) as { data?: unknown } | null)?.data ?? null : null;
  };
  type Listed = { id?: unknown; providerID?: unknown; aliases?: unknown; capabilities?: { input?: unknown } } | null;
  return async session => {
    const own = ((await read(`/api/session/${encodeURIComponent(session)}`)) as { model?: Listed } | null)?.model;
    const ref = own ?? ((await read("/api/model/default")) as Listed);
    if (!ref) return null;
    const model = Array.isArray(ref.capabilities?.input) ? ref
      : (((await read("/api/model")) as Listed[] | null) ?? []).find(listed => (listed?.id === ref.id || (Array.isArray(listed?.aliases) && listed.aliases.includes(ref.id))) && listed?.providerID === ref.providerID);
    const input = model?.capabilities?.input;
    return Array.isArray(input) ? input.filter((kind): kind is string => typeof kind === "string") : null;
  };
}

// Passes `path` to the engine or the agents' bridge on this machine, with its password, and
// streams back what it answers. What's sent is the path as `canonicalPath` writes it, which is
// what `allows` checks.
export async function* forward(target: Target, path: string, request: LinkRequest, signal: AbortSignal | undefined, allows: (path: string, method: string) => boolean, naming: Naming | null = null, down: () => string = engineDown, toAgents = false): AsyncGenerator<AnswerPiece> {
  const method = request.method.toUpperCase();
  const sent = canonicalPath(path);
  if (sent === null || !allows(sent, method)) {
    yield { head: { status: 403, headers: { "content-type": "text/plain" } } };
    yield { body: Buffer.from("That isn't available over the link.") };
    return;
  }
  const url = new URL(`http://127.0.0.1:${target.port}/${sent}`);
  const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const given = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  // (These are single headers, never a list.)
  for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name] as string;
  // A message or command with files: they're kept here, and the model gets as files what it reads
  // (`attachedIn`), from a phone or a Mac alike. A phone's message also says who it names with "&"
  // (`naming`), and that it's from the phone.
  const sending = method === "POST" && /^\/api\/session\/([^/]+)\/(prompt|command)$/.exec(url.pathname);
  const prompt = sending && sending[2] === "prompt" && !request.fromMac ? sending : null;
  // One moving to or from another computer now takes nothing until it's there.
  let moving = false;
  try { moving = Boolean(sending) && frozen().has(decodeURIComponent(sending ? sending[1]! : "")); } catch {}
  if (moving) {
    yield { head: { status: 409, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: MOVING })) };
    return;
  }
  // A session's metadata changed: whether it was archived before, as the engine has it (null when
  // it can't say). A phone sends all of it with any change (a pin, say), the flag as it was too.
  const changed = method === "PATCH" && /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  let wasArchived: boolean | null = null;
  const readBefore = async () => {
    try {
      const before = await fetch(url, { headers, signal });
      if (before.ok) wasArchived = (await before.json() as { data?: EngineSession } | null)?.data?.metadata?.["kuvo.archived"] === true;
    } catch {}
  };
  // A message that's here whole goes on to its conversation even if whoever sent it goes
  // meanwhile (a phone that gave up waiting while a big file was still on its way, #358): its
  // files are kept here by then, and it isn't lost without a word. Sent again under the same id
  // (as the share sheet does), the conversation takes it once. A command still stops with its
  // sender: it has no id, and sent again it would run twice.
  const delivering = sending && sending[2] === "prompt" ? undefined : signal;
  // What goes to the engine: a message as above, anything else as it came.
  const outgoing = async (): Promise<Buffer | undefined> => {
    if (!sending) return request.body;
    const session = decodeURIComponent(sending[1]!);
    const body = await attachedIn(request.body, session, modelInput(url, headers, delivering), request.fromMac === true, toAgents);
    return prompt ? fromPhone(await namedIn(body, session, naming)) : body;
  };
  const send = async () => fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : await outgoing(),
    signal: delivering,
  });
  let response: Response;
  try {
    // A session's written in its turn, as the box's own writers of it write (`../engine/notes.ts`),
    // so none of theirs lands between what it read and this; held until it's answered (at most as
    // long as one of theirs may take).
    if (changed) {
      const turn: { sent?: Promise<Response> } = {};
      await inTurnOn(target, decodeURIComponent(changed[1]!), async () => {
        await readBefore();
        const sent = turn.sent = send();
        const done = new AbortController();
        await Promise.race([sent.catch(() => {}), pause(NOTES_STEP, done.signal)]);
        done.abort();
      });
      if (!turn.sent) throw new Error("It wasn't sent.");
      response = await turn.sent;
    } else response = await send();
  } catch (error) {
    // Not answering (starting again, say): said so, unless the asker went.
    if (signal?.aborted) throw error;
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: down() })) };
    return;
  }
  const out: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out[name] = value;
  }
  // Archived or brought back (`kuvo.archived` in its metadata), here with the Mac closed too: its
  // wake-ups wait, or come back, as a Mac's Archive has it. Only when that changed.
  if (changed && response.ok) {
    let archived: unknown;
    try { archived = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"))?.metadata?.["kuvo.archived"]; } catch {}
    if (typeof archived === "boolean" && archived !== wasArchived) {
      try { holdArchived(decodeURIComponent(changed[1]!), archived); } catch {}
      // Archived while it waits on you: it stops, as a Mac's Archive has it.
      if (archived) await stopIfWaiting(target, decodeURIComponent(changed[1]!));
    }
  }
  yield { head: { status: response.status, headers: out } };
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { body: Buffer.from(value) };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// The coding agents' sessions, accounts and Auto, through their bridge, as the engine's go
// to it; never where the engine is, nor an agent's update.
export async function* agentsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, bridge, text } = context;
  const path = request.path.slice(AGENTS.length);
  if (!agentsAllowed(path, request.method)) return yield* text(403, "That isn't available over the link.");
  const target = bridge();
  if (!target) {
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: agentsDown() ?? (IS_MAC ? "The coding agents on this Mac are starting. Try again in a moment." : "The coding agents aren't running on this machine.") })) };
    return;
  }
  return yield* forward(target, path, request, signal, agentsAllowed, namingHere(readEngine), () => "The coding agents aren't answering on this computer. Try again in a moment.", true);
}

// What's left goes to the engine (the paths a phone may ask for), and a command stopped to whichever
// runs it.
export async function* engineRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, signal, route, readEngine, bridge, json, text } = context;
  const stop = route.match(/^kuvo\/shell\/([^/]+)\/stop$/);
  // A route of a box's own that this box doesn't have: 404, as every box answers it (one whose
  // path isn't what it seems is refused, below).
  if (!stop && route.startsWith("kuvo/") && canonicalPath(request.path) === request.path) return yield* json(404, {});
  if (!stop && !allowed(request.path, request.method)) return yield* text(403, "That isn't available over the link.");
  let engine: EngineRecord | null = null;
  try {
    engine = readEngine();
  } catch {
    // A coding agent's command stops without the engine.
    if (!stop || !bridge()) return yield* json(503, { message: engineDown() });
  }
  if (stop) {
    if (request.method.toUpperCase() !== "POST") return yield* text(405, "Stop it with POST.");
    const headers: Record<string, string> = {};
    const given = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name] as string;
    // The engine's, else a coding agent's, through their bridge.
    const runners = [engine, bridge()].filter(Boolean) as Target[];
    return yield* stopShell(decodeURIComponent(stop[1]!), runners, headers, signal);
  }
  // (Read: without a stop, one that couldn't be read answered 503 above.)
  return yield* forward(engine!, request.path, request, signal, allowed, namingHere(readEngine));
}
