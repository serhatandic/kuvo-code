// What a session's model button shows and whether its model can run (PROTOCOL.md, "A session's
// model"): `GET kuvo/sessions/models?sessions=<id>,<id>…`. Decided here, from what the engine and
// the coding agents' bridge list, so every client shows the same: the model a session runs on, by
// the name its provider or agent lists it, whether it can run now, and what's missing if it can't
// (a model to choose, a sign-in, a key, its coding agent installed, or the model gone from its
// provider's list). What can't be said yet (a place not answering, an agent's models still being
// listed, a provider only a project's own settings add) is left out, and a client lets it go.

import { isObject } from "../../shared/json";
import { isEngineModel } from "../../shared/subagents";
import type { Target } from "../../shared/records";
import type { SessionModel } from "../../shared/routes/sessions";
import { call } from "../engine/client";
import { targetsOf } from "../letters/tools";
import { isFree } from "../work/unanswering";
import { sessionHere, sessionsAsked, Unreached, GLANCE_MOST } from "./glance";
import type { AnswerPiece, RouteContext } from "../server/context";

export const SESSION_MODELS_ROUTE = "kuvo/sessions/models";

/** How long the engine or the bridge has to say what it lists. */
const ASK_WAIT = 5_000;

type Ref = { providerID: string; id: string; variant?: string };

/** A model as a place lists it; `provisional`, one of its agent's usual ones, listed until it says
 * which your account has (Claude Code's, as it starts). */
interface Listed { providerID: string; id: string; name: string; aliases: string[]; free: boolean; provisional: boolean }

/** An account as a place lists it (`api/integration`): its ways to sign in, whether it's signed
 * in, and for a coding agent's, whether its program is installed. */
interface Account { id: string; name: string; label?: string; methods: string[][]; signedIn: boolean; installed: boolean }

/** The engine's providers whose plan Kuvo Code signs in to through a coding agent instead (a ChatGPT
 * plan through Codex, a SuperGrok plan through Grok): Accounts offers the engine only their key, so
 * a sign-in with the plan (`hidden`, by its method's id) never makes the engine's models run. */
const PLANS: Record<string, { name: string; agent: string; provider: string; hidden: (method: string) => boolean }> = {
  openai: { name: "ChatGPT", agent: "Codex", provider: "codex-cli", hidden: method => method.startsWith("chatgpt") },
  xai: { name: "SuperGrok", agent: "Grok", provider: "grok-cli", hidden: method => method === "device" },
};

const asked = (target: Target, route: string, signal?: AbortSignal, folder?: string): Promise<unknown> => {
  const wait = AbortSignal.timeout(ASK_WAIT);
  return call(target, "GET", route, undefined, signal ? AbortSignal.any([signal, wait]) : wait, folder).catch(() => null);
};

function modelsIn(listed: unknown): Listed[] | null {
  if (!Array.isArray(listed)) return null;
  return listed.flatMap(each => {
    // (One turned off is as good as gone.)
    if (!isObject(each) || typeof each.id !== "string" || typeof each.providerID !== "string" || each.enabled === false) return [];
    const aliases = Array.isArray(each.aliases) ? each.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    return [{ providerID: each.providerID, id: each.id, name: typeof each.name === "string" && each.name ? each.name : each.id, aliases, free: isFree(each), provisional: each.provisional === true }];
  });
}

function accountsIn(listed: unknown): Map<string, Account> | null {
  if (!Array.isArray(listed)) return null;
  const accounts = new Map<string, Account>();
  for (const each of listed) {
    if (!isObject(each) || typeof each.id !== "string") continue;
    const metadata = isObject(each.metadata) ? each.metadata : {};
    const label = metadata.source === "agent" && typeof metadata.accountLabel === "string" && metadata.accountLabel.trim() ? metadata.accountLabel.trim() : undefined;
    const methods = (Array.isArray(each.methods) ? each.methods : []).flatMap(method => (isObject(method) && typeof method.type === "string" ? [[method.type, typeof method.id === "string" ? method.id : ""]] : []));
    accounts.set(each.id, {
      id: each.id, name: typeof each.name === "string" && each.name.trim() ? each.name.trim() : each.id, ...(label ? { label } : {}),
      methods, signedIn: Array.isArray(each.connections) && each.connections.length > 0, installed: metadata.installed !== false,
    });
  }
  return accounts;
}

/** The model `ref` names among `models` (its provider's): by its own id, or one it's known by
 * (Claude Code's `default`, which stands for the model it recommends now). */
const named = (ref: Ref, models: Listed[]): Listed | undefined =>
  models.find(model => model.providerID === ref.providerID && model.id === ref.id) ?? models.find(model => model.providerID === ref.providerID && model.aliases.includes(ref.id));

/** What the engine lists, read once for all the sessions asked about; null when it can't say. */
interface EngineLists { ready: Set<string>; models: Listed[]; accounts: Map<string, Account>; fallback: Ref | null }
/** What the bridge lists: its accounts and their models (only signed-in ones'), and your Custom
 * Auto lists (null where it can't say). */
interface BridgeLists { models: Listed[]; accounts: Map<string, Account>; auto: { id: string; name: string; entries: number }[] | null }

/** What the engine lists in `folder` (a project's own settings may add providers, models or its
 * default model there). */
async function engineLists(engine: Target, folder: string | undefined, signal?: AbortSignal): Promise<EngineLists | null> {
  const [providers, listed, integrations, fallback] = await Promise.all(["/api/provider", "/api/model", "/api/integration", "/api/model/default"].map(route => asked(engine, route, signal, folder)));
  const models = modelsIn(listed), accounts = accountsIn(integrations);
  if (!Array.isArray(providers) || !models || !accounts) return null;
  const ready = new Set(providers.flatMap(each => (isObject(each) && typeof each.id === "string" ? [each.id] : [])));
  const given = isObject(fallback) && typeof fallback.providerID === "string" && typeof fallback.id === "string" ? { providerID: fallback.providerID, id: fallback.id } : null;
  return { ready, models, accounts, fallback: given };
}

async function bridgeLists(bridge: Target, signal?: AbortSignal): Promise<BridgeLists | null> {
  // (Those an agent keeps out of its picker but still runs, Codex's hidden ones, too: only one
  // absent from its list is gone.)
  const [listed, integrations, auto] = await Promise.all(["/api/model?hidden=1", "/api/integration", "/api/kuvo/auto"].map(route => asked(bridge, route, signal)));
  const models = modelsIn(listed), accounts = accountsIn(integrations);
  if (!models || !accounts) return null;
  const lists = isObject(auto) && Array.isArray(auto.lists)
    ? auto.lists.flatMap(each => (isObject(each) && typeof each.id === "string" ? [{ id: each.id, name: typeof each.name === "string" && each.name ? each.name : "Custom Auto", entries: Array.isArray(each.entries) ? each.entries.length : 0 }] : []))
    : null;
  return { models, accounts, auto: lists };
}

const accountOf = (account: Account): NonNullable<SessionModel["account"]> => ({ id: account.id, name: account.name, ...(account.label ? { label: account.label } : {}) });

/** What `ref`, a model of the engine's, can do; undefined for what the engine can't say. */
function onEngine(ref: Ref, engine: EngineLists | null): Omit<SessionModel, "model"> | undefined {
  if (!engine) return undefined;
  const listed = named(ref, engine.models);
  const name = listed ? { name: listed.name } : {};
  // OpenCode Zen's free models need no account.
  if (listed && ref.providerID === "opencode" && listed.free) return { ...name, runs: true };
  const account = engine.accounts.get(ref.providerID);
  // Signed in, or with nothing to sign in to (one of your own, or a local one).
  const ready = engine.ready.has(ref.providerID) || !account || account.signedIn || account.methods.length === 0;
  if (ready) {
    if (listed) return { ...name, runs: true };
    // A provider the engine doesn't know at all here: one only a project's own settings add, which
    // the engine lists in that project alone.
    if (!account && !engine.models.some(model => model.providerID === ref.providerID)) return undefined;
    return { runs: false, missing: "gone", ...(account ? { account: accountOf(account) } : {}) };
  }
  // Signed out: its key, where the ways Accounts offers to sign in to it are only that, or a
  // sign-in. A plan that goes through a coding agent of its own isn't offered for the engine's.
  const plan = PLANS[ref.providerID];
  const offered = account!.methods.filter(([type, id]) => ["oauth", "key", "external"].includes(type!) && !(type === "oauth" && plan?.hidden(id!)));
  const key = offered.length > 0 && offered.every(([type]) => type === "key");
  return { ...name, runs: false, missing: key ? "key" : "signIn", account: accountOf(account!), ...(key && plan ? { plan: { name: plan.name, agent: plan.agent, provider: plan.provider } } : {}) };
}

/** What `ref`, a coding agent's model or a Custom Auto list, can do; undefined for what the bridge
 * can't say. */
function withAgents(ref: Ref, bridge: BridgeLists | null): Omit<SessionModel, "model"> | undefined {
  if (!bridge) return undefined;
  if (ref.providerID === "auto") {
    if (!bridge.auto) return undefined;
    // A list deleted runs on the first, as the bridge runs it (`Auto.list`).
    const list = bridge.auto.find(each => each.id === ref.id) ?? bridge.auto[0];
    if (!list) return { runs: false, missing: "gone" };
    return list.entries ? { name: list.name, runs: true } : { name: list.name, runs: false, missing: "gone" };
  }
  const account = bridge.accounts.get(ref.providerID);
  // An account you removed: its models went with it.
  if (!account) return { runs: false, missing: "gone" };
  if (!account.installed) return { runs: false, missing: "install", account: accountOf(account) };
  if (!account.signedIn) return { runs: false, missing: "signIn", account: accountOf(account) };
  const ofIt = bridge.models.filter(model => model.providerID === ref.providerID);
  const listed = named(ref, ofIt);
  if (listed) return { name: listed.name, runs: true };
  // Signed in with none listed, or only its agent's usual ones: its models are still being read.
  if (!ofIt.length || ofIt.every(model => model.provisional)) return undefined;
  return { runs: false, missing: "gone", account: accountOf(account) };
}

/** What each of `ids` runs on, and whether it can, by session; one this box doesn't have, or can't
 * say about now, is left out. Throws `Unreached` while a place that might have one isn't answering. */
export async function sessionModels(ids: string[], engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<Record<string, SessionModel>> {
  const targets = [engine, bridge].filter((each): each is Target => each !== null);
  const found = (await Promise.all(ids.map(id => sessionHere(targets, id, signal)))).filter(each => each !== null);
  // Each place's lists read once (the engine's once a folder), and only where one's needed.
  const engineRead = new Map<string, Promise<EngineLists | null>>();
  let bridgeRead: Promise<BridgeLists | null> | undefined;
  const fromEngine = (folder: string | undefined) => {
    const key = folder ?? "";
    if (!engineRead.has(key)) engineRead.set(key, engine ? engineLists(engine, folder, signal) : Promise.resolve(null));
    return engineRead.get(key)!;
  };
  const fromBridge = () => (bridgeRead ??= bridge ? bridgeLists(bridge, signal) : Promise.resolve(null));
  const answer: Record<string, SessionModel> = {};
  await Promise.all(found.map(async ({ target, data }) => {
    const folder = data.location?.directory ?? data.directory;
    const own = isObject(data.model) && typeof data.model.providerID === "string" && typeof data.model.id === "string" ? data.model : null;
    const onBridge = bridge !== null && target.port === bridge.port;
    // None of its own: the engine's default (a coding agents' session always has one).
    const ref: Ref | null = own ? { providerID: own.providerID, id: own.id, ...(typeof own.variant === "string" ? { variant: own.variant } : {}) } : onBridge ? null : (await fromEngine(folder))?.fallback ?? null;
    if (!ref) {
      // (An engine that can't say has no default to tell.)
      if (!onBridge && !(await fromEngine(folder))) return;
      answer[data.id] = { model: null, runs: false, missing: "model" };
      return;
    }
    const state = isEngineModel(ref) && ref.providerID !== "auto" ? onEngine(ref, await fromEngine(folder)) : withAgents(ref, await fromBridge());
    if (state) answer[data.id] = { model: ref, ...state };
  }));
  return answer;
}

export async function* sessionModelsRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, readEngine, bridge, signal, json } = context;
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  const ids = sessionsAsked(request.path);
  if (!ids) return yield* json(400, { message: `Name the sessions: sessions=<id>,<id>… (${GLANCE_MOST} at most).` });
  const targets = targetsOf({ readEngine, bridge });
  if (!targets.length) return yield* json(503, { message: "The engine isn't running." });
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  try {
    return yield* json(200, { sessions: await sessionModels(ids, engine, bridge(), signal ?? undefined) });
  } catch (error) {
    if (error instanceof Unreached) return yield* json(503, { message: error.message });
    throw error;
  }
}
