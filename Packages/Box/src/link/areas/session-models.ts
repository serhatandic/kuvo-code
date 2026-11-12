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
 * in, and for a coding agent's, whether its program is installed and whether its list is every
 * model it runs (`metadata.modelsComplete`, from a bridge that says so: one missing from it is gone). */
interface Account { id: string; name: string; label?: string; methods: string[][]; signedIn: boolean; installed: boolean; complete: boolean }

/** The engine's providers whose plan Kuvo Code signs in to through a coding agent instead (a ChatGPT
 * plan through Codex, a SuperGrok plan through Grok): Accounts offers the engine only their key, so
 * a sign-in with the plan (`hidden`, by its method's id) never makes the engine's models run. */
/** (Held to the same cases as the apps' Accounts and KuvoClient's PlanSignIns:
 * Packages/KuvoLink/Vectors/plan-sign-ins.json.) */
const PLANS: Record<string, { name: string; agent: string; provider: string; hidden: (method: string) => boolean }> = {
  openai: { name: "ChatGPT", agent: "Codex", provider: "codex-cli", hidden: method => method.startsWith("chatgpt") },
  xai: { name: "SuperGrok", agent: "Grok", provider: "grok-cli", hidden: method => method === "device" },
};

/** What a signed-out account of the engine's needs: its key, where the ways Accounts offers to sign
 * in to it (`[type, id]`) are only that, else a sign-in; a plan that goes through a coding agent of
 * its own isn't offered for the engine's. With the ways it's offered, as their ids
 * (`oauth:<id>`, `key`, `external:<id>`). */
export function signInNeed(providerID: string, methods: string[][]): { missing: "key" | "signIn"; offered: string[]; plan?: { name: string; agent: string; provider: string } } {
  const plan = PLANS[providerID];
  const offered = methods.filter(([type, id]) => ["oauth", "key", "external"].includes(type!) && !(type === "oauth" && plan?.hidden(id ?? "")));
  const key = offered.length > 0 && offered.every(([type]) => type === "key");
  return {
    missing: key ? "key" : "signIn",
    offered: offered.map(([type, id]) => (type === "key" ? "key" : `${type}:${id}`)),
    ...(key && plan ? { plan: { name: plan.name, agent: plan.agent, provider: plan.provider } } : {}),
  };
}

/** `target`'s answer to `route`; undefined when it didn't answer (not there, too slow, an error). */
const asked = (target: Target, route: string, signal?: AbortSignal, folder?: string): Promise<unknown> => {
  const wait = AbortSignal.timeout(ASK_WAIT);
  return call(target, "GET", route, undefined, signal ? AbortSignal.any([signal, wait]) : wait, folder).catch(() => undefined);
};

/** How long what a place listed is used again: until it says something changed, or this long. */
const KEPT_FOR = 10_000;
const kept = new Map<string, { at: number; lists: Promise<unknown> }>();

/** What a place lists, read again only once it's older than `KEPT_FOR` or a change was heard;
 * what it couldn't say isn't kept. */
function keptOr<T>(key: string, read: () => Promise<T | null>): Promise<T | null> {
  const now = Date.now();
  const before = kept.get(key);
  if (before && now - before.at < KEPT_FOR) return before.lists as Promise<T | null>;
  const lists = read();
  kept.set(key, { at: now, lists });
  void lists.then(value => { if (value === null && kept.get(key)?.lists === lists) kept.delete(key); });
  if (kept.size > 200) kept.delete(kept.keys().next().value!);
  return lists;
}

/** The events after which what's kept is read again: accounts, models, settings or Custom Auto's
 * lists changed on the engine or the bridge. */
const CHANGES = new Set(["integration.updated", "model.updated", "provider.updated", "config.updated", "kuvo.auto.updated", "server.instance.disposed"]);

/** Told each event of the engine's and the bridge's (engine/watch.ts). */
export function noteModelsEvent(event: { type?: string }): void {
  if (event.type && CHANGES.has(event.type)) kept.clear();
}

/** Lets go of everything kept (a test's own lists). */
export function forgetModelLists(): void {
  kept.clear();
}

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
      complete: metadata.modelsComplete === true,
    });
  }
  return accounts;
}

/** The model `ref` names among `models` (its provider's): by its own id, or one it's known by
 * (Claude Code's `default`, which stands for the model it recommends now). */
const named = (ref: Ref, models: Listed[]): Listed | undefined =>
  models.find(model => model.providerID === ref.providerID && model.id === ref.id) ?? models.find(model => model.providerID === ref.providerID && model.aliases.includes(ref.id));

/** What the engine lists, read once for all the sessions asked about; null when it can't say.
 * `fallback`: its default model, null when it has none, undefined when it didn't say. */
interface EngineLists { ready: Set<string>; models: Listed[]; accounts: Map<string, Account>; fallback: Ref | null | undefined }
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
  // None ready, or no models: an engine that hasn't loaded the folder yet answers so at first
  // (agents/engine.ts's `offered`): it can't say yet.
  if (!ready.size || !models.length) return null;
  // (Its answer `data: null` is no default; no answer, not known.)
  const given = fallback === undefined ? undefined
    : isObject(fallback) && typeof fallback.providerID === "string" && typeof fallback.id === "string" ? { providerID: fallback.providerID, id: fallback.id } : null;
  return { ready, models, accounts, fallback: given };
}

async function bridgeLists(bridge: Target, signal?: AbortSignal): Promise<BridgeLists | null> {
  // (Those an agent keeps out of its picker but still runs, Codex's hidden ones, too: only one
  // absent from its list is gone.)
  // (The models first: an account's word that its list is whole is of the list it has then.)
  const listed = await asked(bridge, "/api/model?hidden=1", signal);
  const [integrations, auto] = await Promise.all(["/api/integration", "/api/kuvo/auto"].map(route => asked(bridge, route, signal)));
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
  // Signed in, or with nothing to sign in to (one of your own, or a local one). OpenCode Zen is
  // ready for its free models alone: its others need its account.
  const ready = ref.providerID === "opencode" && account ? account.signedIn
    : engine.ready.has(ref.providerID) || !account || account.signedIn || account.methods.length === 0;
  if (ready) {
    if (listed) return { ...name, runs: true };
    // A provider the engine doesn't know at all here: one only a project's own settings add, which
    // the engine lists in that project alone.
    if (!account && !engine.models.some(model => model.providerID === ref.providerID)) return undefined;
    return { runs: false, missing: "gone", ...(account ? { account: accountOf(account) } : {}) };
  }
  // Signed out: its key, or a sign-in (`signInNeed`).
  const need = signInNeed(ref.providerID, account!.methods);
  return { ...name, runs: false, missing: need.missing, account: accountOf(account!), ...(need.plan ? { plan: need.plan } : {}) };
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
  // Nor from a bridge (or an agent) that can't say its list is all it runs, Codex's hidden ones
  // with it: one missing may still run.
  if (!ofIt.length || ofIt.every(model => model.provisional) || !account.complete) return undefined;
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
    if (!engineRead.has(key)) engineRead.set(key, engine ? keptOr(`engine:${engine.port}:${key}`, () => engineLists(engine, folder, signal)) : Promise.resolve(null));
    return engineRead.get(key)!;
  };
  const fromBridge = () => (bridgeRead ??= bridge ? keptOr(`bridge:${bridge.port}`, () => bridgeLists(bridge, signal)) : Promise.resolve(null));
  const answer: Record<string, SessionModel> = {};
  await Promise.all(found.map(async ({ target, data }) => {
    const folder = data.location?.directory ?? data.directory;
    const own = isObject(data.model) && typeof data.model.providerID === "string" && typeof data.model.id === "string" ? data.model : null;
    const onBridge = bridge !== null && target.port === bridge.port;
    // None of its own: the engine's default (a coding agents' session always has one).
    const fallback = own || onBridge ? null : (await fromEngine(folder))?.fallback;
    // (An engine that can't say, or didn't say its default, has none to tell yet.)
    if (!own && !onBridge && fallback === undefined) return;
    const ref: Ref | null = own ? { providerID: own.providerID, id: own.id, ...(typeof own.variant === "string" ? { variant: own.variant } : {}) } : fallback ?? null;
    if (!ref) {
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
