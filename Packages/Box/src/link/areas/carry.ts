// A conversation this box's engine runs carried on with its coding agents (`kuvo/sessions/<id>/agents`).

import fs from "node:fs";
import path from "node:path";
import { parsed } from "../../shared/json";
import type { Body, Fields } from "../../shared/json";
import { botHere, isModel, isMoving, MOVING } from "../bots/here";
import { readKit, runsWithAgents } from "../bots/kit";
import { tellBot, toldNow } from "../bots/tell";
import { call, engineGet } from "../engine/client";
import { carryQueue } from "../engine/queue";
import { conversationOf } from "../engine/conversations";
import { messageID } from "../engine/sessions";
import { listOf } from "../files";
import { BOTS, HERE, SESSION_WAKES } from "../home";
import { settleAgain } from "./approval";
import { holdArchived } from "./wakes";
import { carryDecided, tellAutopilot } from "../work/autopilot";
import { tellWorktree } from "./worktrees";
import { PROJECT_FOLDERS_ENTRY, projectFoldersNote, readProjects } from "./projects";
import { projectOf as projectOfFolder } from "./worktree-records";
import type { Target } from "../../shared/records";
import type { EngineAnswer, UncheckedAnswer } from "../engine/client";
import type { EngineMessage } from "../engine/conversations";
import type { EngineSession } from "../engine/sessions";
import type { Carried } from "../../shared/routes/sessions";
import type { AnswerPiece, JSONAnswer, OtherStatus, RouteContext } from "../server/context";

/** What `carryToAgents` answers: the coding agents' session it goes on in, or why not. */
export type CarryAnswer = JSONAnswer<Carried, { message: string }>;

/** A plan of the coding agents' as their bridge has it (`api/integration/<id>`), as far as this
 * reads it: its name, whether it's installed, and its sign-ins. */
interface AgentsIntegration {
  name?: string;
  metadata?: { installed?: boolean };
  connections?: unknown[];
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

/** `kuvo/sessions/<id>/agents`: a conversation carried on with the coding agents, on every box. */
export const CARRY_ROUTE = /^kuvo\/sessions\/([^/]+)\/agents$/;

// How long the coding agents' bridge has to take a conversation: it takes one at once, so one that
// says nothing for this long is stuck, and what it may have made goes.
const IMPORT_TIMEOUT = 120_000;

// What an import may have left in the bridge (it answered nothing, or not in words this reads): the
// conversations there carried on from `id`, made since `since`, deleted. Only a carry under way
// makes one, as one carried on already isn't carried again (its `kuvo.carriedTo`).
async function dropCopies(agents: Target, id: string, directory: string | undefined, since: number): Promise<void> {
  const listed = (await engineGet(agents, `api/session?limit=20${directory ? `&directory=${encodeURIComponent(directory)}` : ""}`).catch(() => null) as EngineAnswer<EngineSession[]> | null)?.data;
  for (const each of Array.isArray(listed) ? listed : []) {
    const from = (each?.metadata?.kuvo as { carriedFrom?: unknown } | undefined)?.carriedFrom;
    if (from === id && (each.time?.created ?? since) >= since) await call(agents, "DELETE", `/api/session/${encodeURIComponent(each.id)}`).catch(() => {});
  }
}

// `POST kuvo/sessions/<id>/agents`, from any client (a Mac's model picker, a phone's): a
// conversation this box's engine runs, carried on with its coding agents on `model` (one of theirs,
// or Custom Auto), as picking it in the conversation does: a session of theirs with the whole
// conversation and what was waiting, told of its project's other folders and worktree; the
// engine's goes to Archived, and a bot's conversation becomes the new one. All or nothing: until
// the engine's is marked as carried on (a bot's, its record), anything that fails takes the new
// one away again, so a move that fails leaves no copy and can be tried again. `{status, value}`:
// 200 `{session}`, the new one.
export async function carryToAgents(id: string, model: unknown, readEngine: () => Target, agents: Target | null | undefined): Promise<CarryAnswer> {
  const no = (status: OtherStatus, message: string): CarryAnswer => ({ status, value: { message } });
  if (!isModel(model) || !runsWithAgents(model)) return no(400, "That isn’t a coding agent’s model.");
  let engine: Target | undefined;
  try { engine = readEngine(); } catch {}
  if (!engine) return no(503, "The engine isn’t running.");
  if (!agents) return no(503, `The coding agents aren’t running on ${HERE}.`);
  const route = `api/session/${encodeURIComponent(id)}`;
  let session: EngineSession | undefined;
  // (As the engine answers it: a session it has, whole; one it hasn't is an error.)
  try { session = (await engineGet(engine, route) as EngineAnswer<EngineSession>)?.data; } catch {}
  if (!session) {
    // One of theirs already, or none.
    const theirs = await engineGet(agents, route).catch(() => null) as UncheckedAnswer;
    return theirs?.data ? no(409, "It’s with the coding agents already.") : no(404, "That conversation isn’t there any more.");
  }
  if (session.metadata?.kuvoAgent || session.metadata?.["kuvo.carriedTo"]) return no(409, "It’s with the coding agents already.");
  const bot = listOf(BOTS).map(botHere).find(here => here?.session === id) ?? null;
  if (isMoving(bot?.folder ?? path.join(SESSION_WAKES, id))) return no(409, MOVING);
  // Signed in there, unless it's Auto, which picks among those that are.
  if (model.providerID !== "auto") {
    const integration = (await engineGet(agents, `api/integration/${encodeURIComponent(model.providerID)}`).catch(() => null) as EngineAnswer<AgentsIntegration> | null)?.data;
    const name = integration?.name ?? model.providerID;
    if (integration?.metadata?.installed === false) return no(422, `${name} isn’t installed on ${HERE}: install it in Settings › Accounts, or choose another model.`);
    if (!integration?.connections?.length) return no(422, `${name} needs a sign-in on ${HERE}: sign in in Settings › Accounts, or choose another model.`);
  }
  if (carrying.has(id)) return no(409, "It’s being carried on with the coding agents already.");
  carrying.add(id);
  const directory = session.location?.directory ?? session.directory;
  const started = Date.now();
  // The new one, until the engine's is marked as carried on there (from then on, it's the one).
  let made: string | null = null;
  let kept = false;
  try {
    // From here on it goes to its end, whatever becomes of the client's request: cut off halfway,
    // it would be in two places, or what waited would run twice.
    let messages: EngineMessage[] = [], waiting: InboxItem[] = [];
    for (let round = 0; round < 3; round++) {
      // Not partway through a turn (one a client started again from what waited, since).
      const active: Record<string, unknown> = (await engineGet(engine, "api/session/active").catch(() => null) as EngineAnswer<Record<string, unknown>> | null)?.data ?? {};
      if (id in active) {
        await call(engine, "POST", `/${route}/interrupt`).catch(() => {});
        await call(engine, "POST", `/api/experimental/session/${encodeURIComponent(id)}/wait`).catch(() => {});
      }
      // Its whole conversation, page by page (a great many messages at most); carried over whole.
      messages = await conversationOf(engine, id);
      // An undo waiting to be kept: the conversation as it is now, without what it took back.
      const cut = session.revert?.messageID ? messages.findIndex(message => message.id === session.revert!.messageID) : -1;
      if (cut >= 0) messages = messages.slice(0, cut);
      // What was sent and waiting comes along, still waiting.
      waiting = ((await engineGet(engine, `${route}/inbox`).catch(() => null) as EngineAnswer<(InboxItem | null)[]> | null)?.data ?? []).filter((item: InboxItem | null): item is InboxItem => item?.type === "user" && typeof item.text === "string");
      const still: Record<string, unknown> = (await engineGet(engine, "api/session/active").catch(() => null) as EngineAnswer<Record<string, unknown>> | null)?.data ?? {};
      if (!(id in still)) break;
    }
    const renamed: Record<string, string> = Object.fromEntries(waiting.map(item => [item.id, messageID()]));
    // Marked as carried on from this one, whose files its words show (they stay while it does:
    // `letAttachmentsGo`); a bot's as its too; in the mode it was in, its rules made for it. As
    // it's made, so nothing takes it for a new conversation of yours.
    const kuvo = bot ? session.metadata?.kuvo ?? { bot: bot.described.id } : {};
    const { approval, applied, autopilot } = session.metadata?.kuvo ?? {};
    const marks = { kuvo: { ...(approval ? { approval } : {}), ...(applied ? { applied } : {}), ...(autopilot === true ? { autopilot } : {}), ...kuvo, carriedFrom: id } };
    let imported: Fields<"id"> | null = null;
    try {
      imported = await call(agents, "POST", "/api/session/import", {
        title: session.title, agent: session.agent, model, location: { directory }, permissions: session.permissions, metadata: marks, messages,
        waiting: waiting.map(item => ({ id: renamed[item.id], text: item.text, files: promptFiles(item.payload) })),
      }, AbortSignal.timeout(IMPORT_TIMEOUT)) as Fields<"id"> | null;
    } catch (error) {
      // Refused, or no answer: what it may have made goes.
      await dropCopies(agents, id, directory, started);
      throw error;
    }
    if (typeof imported?.id !== "string") {
      await dropCopies(agents, id, directory, started);
      return no(502, "The coding agents didn’t take it.");
    }
    made = imported.id;
    const moved = made;
    // All it's told, before anything of the engine's changes. (Again, the marks, for an engine that
    // drops what an import carries; then its rules made for what its approval comes to with the
    // coding agents, which may be less than where it was.)
    await tellWorktree(agents, moved).catch(() => {});
    await call(agents, "PATCH", `/api/session/${encodeURIComponent(moved)}`, { metadata: marks }).catch(() => {});
    // Its project's other folders, as a session started there is told of them.
    const folders = directory ? readProjects().find(each => each.directory === projectOfFolder(directory))?.folders ?? [] : [];
    if (directory && folders.length) {
      await call(agents, "PUT", `/api/experimental/session/${encodeURIComponent(moved)}/instructions/entries/${PROJECT_FOLDERS_ENTRY}`, { value: projectFoldersNote(directory, folders) }).catch(() => {});
    }
    await settleAgain(agents, moved, true).catch(() => {});
    // On Autopilot, its new agent is told so too; the calls it made come along (`carryDecided`).
    if (autopilot === true) await tellAutopilot(agents, moved, true).catch(() => {});
    if (bot) {
      // The bot's conversation is the new one, told what it is.
      const kit = readKit();
      if (kit) await tellBot(agents, bot, moved, toldNow(kit, bot));
      const via = path.join(bot.folder, "via");
      let wasVia: string | null = null;
      try { wasVia = fs.readFileSync(via, "utf8"); } catch {}
      try {
        fs.writeFileSync(via, "bridge");
        fs.writeFileSync(path.join(bot.folder, "session"), moved);
      } catch (error) {
        try { if (wasVia === null) fs.rmSync(via, { force: true }); else fs.writeFileSync(via, wasVia); } catch {}
        throw error;
      }
      kept = true;
    } else {
      // Carried on meanwhile by another of this box's processes (a client's `box route` beside a
      // phone's): that one stands, and this one's goes.
      const now = (await engineGet(engine, route).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
      if (now?.metadata?.["kuvo.carriedTo"]) {
        await call(agents, "DELETE", `/api/session/${encodeURIComponent(moved)}`).catch(() => {});
        made = null;
        return no(409, "It’s with the coding agents already.");
      }
      // Archived, and marked as carried on, so it isn't carried twice: it's the new one's from here.
      // (One the engine took without saying so is taken.)
      try {
        await call(engine, "PATCH", `/${route}`, { metadata: { ...(session.metadata ?? {}), "kuvo.archived": true, "kuvo.carriedTo": moved } });
      } catch (error) {
        const now = (await engineGet(engine, route).catch(() => null) as EngineAnswer<EngineSession> | null)?.data;
        if (now?.metadata?.["kuvo.carriedTo"] !== moved) throw error;
      }
      kept = true;
    }
    // Stopped by you, it stays stopped there, with what waited on the box.
    carryQueue(id, moved, renamed);
    for (const item of waiting) await call(engine, "DELETE", `/${route}/inbox/${encodeURIComponent(item.id)}`).catch(() => {});
    carryDecided(id, moved);
    if (bot) {
      await call(engine, "DELETE", `/${route}`).catch(() => {});
    } else {
      // Its wake-ups and watches go with it, as on a Mac (WakeUps.carry).
      const from = path.join(SESSION_WAKES, id), to = path.join(SESSION_WAKES, moved);
      if (fs.existsSync(path.join(from, "session")) && !fs.existsSync(to)) {
        try {
          fs.renameSync(from, to);
          fs.writeFileSync(path.join(to, "session"), moved);
          fs.writeFileSync(path.join(to, "directory"), directory ?? "");
          fs.writeFileSync(path.join(to, "via"), "bridge");
        } catch {}
      }
      try { holdArchived(id, true); } catch {}
    }
    return { status: 200, value: { session: moved } };
  } catch (error) {
    // Nothing of it stays: the new one goes, and the engine's goes on as it was.
    if (made && !kept) await call(agents, "DELETE", `/api/session/${encodeURIComponent(made)}`).catch(() => {});
    return no(502, (error as Error | null)?.message ?? String(error));
  } finally {
    carrying.delete(id);
  }
}

// A conversation here carried on with the coding agents here, as picking one of their models
// in it does.
export async function* carryRoute(context: RouteContext, toAgents: RegExpMatchArray): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
  let id: string;
  try { id = decodeURIComponent(toAgents[1]); } catch { return yield* json(404, { message: "That conversation isn’t there any more." }); }
  const { status, value } = await carryToAgents(id, (parsed(request.body) as Body<"model">)?.model, readEngine, bridge());
  return yield* json(status, value);
}
