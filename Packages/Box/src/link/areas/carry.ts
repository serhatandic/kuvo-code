// A conversation this box's engine runs carried on with its coding agents (`kuvo/sessions/<id>/agents`).

import fs from "node:fs";
import path from "node:path";
import { parsed } from "../../shared/json";
import { botHere, isModel, isMoving, MOVING } from "../bots/here";
import { readKit, runsWithAgents } from "../bots/kit";
import { tellBot, toldNow } from "../bots/tell";
import { call, engineGet } from "../engine/client";
import { messageID } from "../engine/sessions";
import { listOf } from "../files";
import { BOTS, HERE, SESSION_WAKES } from "../home";
import { holdArchived } from "./wakes";
import { tellWorktree } from "./worktrees";
import type { Target } from "../../shared/records";
import type { Carried } from "../../shared/routes/sessions";
import type { BotModel } from "../bots/here";
import type { EngineSession } from "../peers/agents";
import type { AnswerPiece, JSONAnswer, RouteContext } from "../server/context";

/** What `carryToAgents` answers: the coding agents' session it goes on in, or why not. */
export type CarryAnswer = JSONAnswer<Carried | { message: string }>;

/** A conversation as the engine has it (`api/session/<id>`), as far as carrying it on reads it: its
 * title, agent, folder and permissions, an undo waiting to be kept, and whose it is. */
export interface CarriedSession extends EngineSession {
  agent?: string;
  permissions?: unknown;
  revert?: { messageID?: string } | null;
  metadata?: EngineSession["metadata"] & { kuvoAgent?: unknown; "kuvo.carriedTo"?: unknown; kuvo?: { bot?: unknown; [more: string]: unknown }; [more: string]: unknown };
}

/** A message of the conversation's, as the engine lists it: carried over whole. */
interface EngineMessage {
  id: string;
}

/** A page of the conversation's messages (`…/message`), and where the next one starts. */
interface MessagePage {
  data?: EngineMessage[];
  cursor?: { next?: string; previous?: string };
}

/** What was sent and waits in the conversation's inbox (`…/inbox`), as the engine keeps it. */
interface InboxItem {
  id: string;
  type?: string;
  text: string;
  payload?: WaitingPayload;
}

/** What a waiting message brings, in the engine's form: its files, each by a link or its data. */
interface WaitingPayload {
  files?: { name?: unknown; uri?: unknown; source?: { uri?: unknown }; data?: unknown; mime?: unknown }[];
}

/** A file a waiting message brings, as the agents' bridge takes one: a link (or its data, as a
 * `data:` link), and its name. */
export interface AgentFile {
  uri: string;
  name?: string;
}

// Conversations being carried on with the coding agents now (`carryToAgents`): one at a time each.
const carrying = new Set<string>();

// A file a waiting message brings (the engine's form of it), as the agents' bridge takes one.
const promptFiles = (payload: WaitingPayload | undefined): AgentFile[] => (Array.isArray(payload?.files) ? payload.files : []).map(file => {
  const name = typeof file?.name === "string" ? { name: file.name } : {};
  const uri = file?.source?.uri ?? file?.uri;
  if (typeof uri === "string") return { uri, ...name };
  return typeof file?.data === "string" ? { uri: `data:${file.mime ?? "application/octet-stream"};base64,${file.data}`, ...name } : null;
}).filter(Boolean) as AgentFile[];

// `POST kuvo/sessions/<id>/agents`, as a Mac's (Workspace.moveToAgents): a conversation this
// machine's engine runs, carried on with its coding agents on `model` (one of theirs, or Custom
// Auto), as picking it in the conversation does: a session of theirs with the whole conversation
// and what was waiting; the engine's goes to Archived, and a bot's conversation becomes the new
// one. `{status, value}`: 200 `{session}`, the new one.
export async function carryToAgents(id: string, model: Partial<BotModel> | null | undefined, readEngine: () => Target, agents: Target | null | undefined, signal?: AbortSignal): Promise<CarryAnswer> {
  const no = (status: number, message: string): CarryAnswer => ({ status, value: { message } });
  if (!isModel(model) || !runsWithAgents(model)) return no(400, "That isn’t a coding agent’s model.");
  let engine: Target | undefined;
  try { engine = readEngine(); } catch {}
  if (!engine) return no(503, "The engine isn’t running.");
  if (!agents) return no(503, `The coding agents aren’t running on ${HERE}.`);
  const route = `api/session/${encodeURIComponent(id)}`;
  let session: CarriedSession | undefined;
  try { session = (await engineGet(engine, route))?.data; } catch {}
  if (!session) {
    // One of theirs already, or none.
    const theirs = await engineGet(agents, route).catch(() => null);
    return theirs?.data ? no(409, "It’s with the coding agents already.") : no(404, "That conversation isn’t there any more.");
  }
  if (session.metadata?.kuvoAgent || session.metadata?.["kuvo.carriedTo"]) return no(409, "It’s with the coding agents already.");
  const bot = listOf(BOTS).map(botHere).find(here => here?.session === id) ?? null;
  if (isMoving(bot?.folder ?? path.join(SESSION_WAKES, id))) return no(409, MOVING);
  // Signed in there, unless it's Auto, which picks among those that are.
  if (model.providerID !== "auto") {
    const integration = (await engineGet(agents, `api/integration/${encodeURIComponent(model.providerID)}`).catch(() => null))?.data;
    const name = integration?.name ?? model.providerID;
    if (integration?.metadata?.installed === false) return no(422, `${name} isn’t installed on ${HERE}: install it in Settings › Accounts, or choose another model.`);
    if (!integration?.connections?.length) return no(422, `${name} needs a sign-in on ${HERE}: sign in in Settings › Accounts, or choose another model.`);
  }
  if (carrying.has(id)) return no(409, "It’s being carried on with the coding agents already.");
  carrying.add(id);
  try {
    // From here on it goes to its end, whatever becomes of the phone's request: cut off halfway, it
    // would be in two places, or what waited would run twice.
    const directory = session.location?.directory ?? session.directory;
    let messages: EngineMessage[] = [], waiting: InboxItem[] = [];
    for (let round = 0; round < 3; round++) {
      // Not partway through a turn (one a client started again from what waited, since).
      const active: Record<string, unknown> = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (id in active) {
        await call(engine, "POST", `/${route}/interrupt`).catch(() => {});
        await call(engine, "POST", `/api/experimental/session/${encodeURIComponent(id)}/wait`).catch(() => {});
      }
      // Its whole conversation, page by page (a great many messages at most).
      let page: MessagePage | undefined = await engineGet(engine, `${route}/message?limit=200&order=desc`);
      messages = [...(page?.data ?? [])].reverse();
      while ((page?.data?.length ?? 0) >= 200 && messages.length < 20_000) {
        const cursor = page!.cursor?.next ?? page!.cursor?.previous;
        if (!cursor) break;
        page = await engineGet(engine, `${route}/message?limit=200&cursor=${encodeURIComponent(cursor)}`);
        if (!page?.data?.length) break;
        messages = [...page.data].reverse().concat(messages);
      }
      // An undo waiting to be kept: the conversation as it is now, without what it took back.
      const cut = session.revert?.messageID ? messages.findIndex(message => message.id === session.revert!.messageID) : -1;
      if (cut >= 0) messages = messages.slice(0, cut);
      // What was sent and waiting comes along, still waiting.
      waiting = ((await engineGet(engine, `${route}/inbox`).catch(() => null))?.data ?? []).filter((item: InboxItem | null) => item?.type === "user" && typeof item.text === "string");
      const still: Record<string, unknown> = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (!(id in still)) break;
    }
    const moved: { id?: unknown } | null | undefined = await call(agents, "POST", "/api/session/import", {
      title: session.title, agent: session.agent, model, location: { directory }, permissions: session.permissions, messages,
      waiting: waiting.map(item => ({ id: messageID(), text: item.text, files: promptFiles(item.payload) })),
    });
    if (typeof moved?.id !== "string") return no(502, "The coding agents didn’t take it.");
    for (const item of waiting) await call(engine, "DELETE", `/${route}/inbox/${encodeURIComponent(item.id)}`).catch(() => {});
    const entries = `/api/experimental/session/${encodeURIComponent(moved.id)}/instructions/entries`;
    await tellWorktree(agents, moved.id).catch(() => {});
    if (bot) {
      // The bot's conversation is the new one, marked as its, told what it is.
      await call(agents, "PATCH", `/api/session/${encodeURIComponent(moved.id)}`, { metadata: { kuvo: session.metadata?.kuvo ?? { bot: bot.described.id } } }).catch(() => {});
      const kit = readKit();
      if (kit) await tellBot(agents, bot, moved.id, toldNow(kit, bot));
      fs.writeFileSync(path.join(bot.folder, "session"), moved.id);
      fs.writeFileSync(path.join(bot.folder, "via"), "bridge");
      await call(engine, "DELETE", `/${route}`).catch(() => {});
    } else {
      // Its wake-ups and watches go with it, as on a Mac (WakeUps.carry).
      const from = path.join(SESSION_WAKES, id), to = path.join(SESSION_WAKES, moved.id);
      if (fs.existsSync(path.join(from, "session")) && !fs.existsSync(to)) {
        try {
          fs.renameSync(from, to);
          fs.writeFileSync(path.join(to, "session"), moved.id);
          fs.writeFileSync(path.join(to, "directory"), directory ?? "");
          fs.writeFileSync(path.join(to, "via"), "bridge");
        } catch {}
      }
      // Archived, and marked as carried on, so it isn't carried twice.
      await call(engine, "PATCH", `/${route}`, { metadata: { ...(session.metadata ?? {}), "kuvo.archived": true, "kuvo.carriedTo": moved.id } }).catch(() => {});
      try { holdArchived(id, true); } catch {}
    }
    return { status: 200, value: { session: moved.id } };
  } catch (error) {
    return no(502, (error as Error | null)?.message ?? String(error));
  } finally {
    carrying.delete(id);
  }
}

// A conversation here carried on with the coding agents here, as picking one of their models
// in it does.
export async function* carryRoute(context: RouteContext, toAgents: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, signal, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  let id: string;
  try { id = decodeURIComponent(toAgents[1]); } catch { return yield* json(404, { message: "That conversation isn’t there any more." }); }
  const { status, value } = await carryToAgents(id, parsed(request.body)?.model, readEngine, bridge(), signal);
  return yield* json(status, value);
}
