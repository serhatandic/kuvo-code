// The one rule for which models can run here, and which one a new session starts on (PROTOCOL.md,
// "A session's model" and "The models offered"): decided from what the engine and the coding
// agents' bridge list, so every client (and a lead starting a session from another computer) has
// the same answer. What can't be said yet (a place not answering, an agent's models still being
// listed, a provider only a project's own settings add) is left unsaid.

import { isObject } from "../../shared/json";
import { isEngineModel } from "../../shared/subagents";
import type { Target } from "../../shared/records";
import type { SessionModel } from "../../shared/routes/sessions";
import { call } from "../engine/client";
import { isFree } from "./unanswering";

/** How long the engine or the bridge has to say what it lists. */
const ASK_WAIT = 5_000;

export type Ref = { providerID: string; id: string; variant?: string };

/** What a model can do here: whether it runs, and what it needs if not (`SessionModel` without
 * the model it's about). */
export type ModelState = Omit<SessionModel, "model">;

/** A model as a place lists it; `provisional`, one of its agent's usual ones, listed until it says
 * which your account has (Claude Code's, as it starts); `hidden`, one its agent keeps out of its
 * picker but still runs (Codex's); `retiring`, one its provider deprecated; `efforts`, its
 * variants' ids. */
export interface Listed {
  providerID: string; id: string; name: string; aliases: string[]; efforts: string[]; free: boolean; provisional: boolean;
  hidden: boolean; retiring: boolean; released: number;
}

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

/** Whether the engine's sign-in `method` (an oauth way's id) for `provider` is a plan's that goes
 * through a coding agent instead, which Accounts doesn't offer for the engine's (areas/sign-in.ts). */
export const planHides = (provider: string, method: string): boolean => PLANS[provider]?.hidden(method) ?? false;

/** The engine's providers a picker lists first, in this order; the rest after, by id. A new session
 * with no model it can start on otherwise starts on the newest of the first of them that runs. */
export const FEATURED = ["openai", "github-copilot", "anthropic", "google", "xai", "openrouter", "opencode", "deepseek", "mistral", "groq"];

/** What a signed-out account of the engine's needs: its key, where the ways Accounts offers to sign
 * in to it (`[type, id]`) are only that, else a sign-in; a plan that goes through a coding agent of
 * its own isn't offered for the engine's. With the ways it's offered, as their ids
 * (`oauth:<id>`, `key`, `external:<id>`). */
export function signInNeed(providerID: string, methods: string[][]): { missing: "key" | "signIn"; offered: string[]; plan?: { name: string; agent: string; provider: string } } {
  const plan = PLANS[providerID];
  const offered = methods.filter(([type, id]) => ["oauth", "key", "external"].includes(type!) && !(type === "oauth" && planHides(providerID, id ?? "")));
  const key = offered.length > 0 && offered.every(([type]) => type === "key");
  return {
    missing: key ? "key" : "signIn",
    offered: offered.map(([type, id]) => (type === "key" ? "key" : `${type}:${id}`)),
    ...(key && plan ? { plan: { name: plan.name, agent: plan.agent, provider: plan.provider } } : {}),
  };
}

/** `target`'s answer to `route`; undefined when it didn't answer (not there, too slow, an error). */
const asked = (target: Target, route: string, folder?: string): Promise<unknown> =>
  call(target, "GET", route, undefined, AbortSignal.timeout(ASK_WAIT), folder).catch(() => undefined);

/** How long what a place listed is used again: until it says something changed, or this long. */
const KEPT_FOR = 10_000;
const kept = new Map<string, { at: number; lists: Promise<unknown> }>();

/** What a place lists, read again only once it's older than `KEPT_FOR` or a change was heard;
 * what it couldn't wholly say (`whole`) isn't kept. Read with its own time limit, never one
 * caller's: an ask that's let go doesn't cut short another's read. */
function keptOr<T>(key: string, read: () => Promise<T | null>, whole: (value: T) => boolean): Promise<T | null> {
  const now = Date.now();
  const before = kept.get(key);
  if (before && now - before.at < KEPT_FOR) return before.lists as Promise<T | null>;
  const lists = read();
  kept.set(key, { at: now, lists });
  void lists.then(value => { if ((value === null || !whole(value)) && kept.get(key)?.lists === lists) kept.delete(key); });
  if (kept.size > 200) kept.delete(kept.keys().next().value!);
  return lists;
}

/** The events after which what's kept is read again: accounts, models, settings or Custom Auto's
 * lists changed on the engine or the bridge. */
const CHANGES = new Set(["integration.updated", "model.updated", "provider.updated", "config.updated", "global.disposed", "kuvo.auto.updated"]);

/** Told each event of the engine's and the bridge's (engine/watch.ts). */
export function noteModelsEvent(event: { type?: string }): void {
  if (event.type && CHANGES.has(event.type)) kept.clear();
}

/** Lets go of everything kept (a test's own lists). */
export function forgetModelLists(): void {
  kept.clear();
  lastNames.clear();
}

/** Each model's name as last listed here, for one since gone from its list (its refusal names it so). */
const lastNames = new Map<string, string>();
const nameKey = (ref: { providerID: string; id: string }) => `${ref.providerID}\u0000${ref.id}`;

/** `ref`'s name as it was last listed here; none for one never listed since the box started. */
export const lastName = (ref: { providerID: string; id: string }): string | undefined => lastNames.get(nameKey(ref));

/** `name` kept as the one last listed for `providerID`'s models `ids` (its own, and those it's
 * known by: Claude Code's `default`, the newest saying it last). */
function noteNames(providerID: string, ids: string[], name: string): void {
  for (const id of ids) {
    const key = nameKey({ providerID, id });
    lastNames.delete(key);
    lastNames.set(key, name);
  }
  while (lastNames.size > 20_000) lastNames.delete(lastNames.keys().next().value!);
}

function modelsIn(listed: unknown): Listed[] | null {
  if (!Array.isArray(listed)) return null;
  const models = modelsListed(listed);
  for (const model of models) noteNames(model.providerID, [model.id, ...model.aliases], model.name);
  return models;
}

function modelsListed(listed: unknown[]): Listed[] {
  return listed.flatMap(each => {
    // (One turned off is as good as gone.)
    if (!isObject(each) || typeof each.id !== "string" || typeof each.providerID !== "string" || each.enabled === false) return [];
    const aliases = Array.isArray(each.aliases) ? each.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    const released = isObject(each.time) && typeof each.time.released === "number" ? each.time.released : 0;
    const efforts = Array.isArray(each.variants) ? each.variants.flatMap(variant => (isObject(variant) && typeof variant.id === "string" ? [variant.id] : [])) : [];
    return [{
      providerID: each.providerID, id: each.id, name: typeof each.name === "string" && each.name ? each.name : each.id, aliases, efforts, free: isFree(each),
      provisional: each.provisional === true, hidden: each.hidden === true, retiring: each.status === "deprecated", released,
    }];
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
export interface EngineLists { ready: Set<string>; models: Listed[]; accounts: Map<string, Account>; fallback: Ref | null | undefined }
/** What the bridge lists: its accounts and their models (only signed-in ones'), and your Custom
 * Auto lists (null where it can't say). */
export interface BridgeLists { models: Listed[]; accounts: Map<string, Account>; auto: { id: string; name: string; entries: number }[] | null }
/** What both places list: null for one that can't say now (not there, or not answering). */
export interface Lists { engine: EngineLists | null; bridge: BridgeLists | null }

/** What the engine lists in `folder` (a project's own settings may add providers, models or its
 * default model there). */
async function engineLists(engine: Target, folder: string | undefined): Promise<EngineLists | null> {
  const [providers, listed, integrations, fallback] = await Promise.all(["/api/provider", "/api/model", "/api/integration", "/api/model/default"].map(route => asked(engine, route, folder)));
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

async function bridgeLists(bridge: Target): Promise<BridgeLists | null> {
  // (Those an agent keeps out of its picker but still runs, Codex's hidden ones, too: only one
  // absent from its list is gone.)
  // (The models first: an account's word that its list is whole is of the list it has then.)
  const listed = await asked(bridge, "/api/model?hidden=1");
  const [integrations, auto] = await Promise.all(["/api/integration", "/api/kuvo/auto"].map(route => asked(bridge, route)));
  const models = modelsIn(listed), accounts = accountsIn(integrations);
  if (!models || !accounts) return null;
  const lists = isObject(auto) && Array.isArray(auto.lists)
    ? auto.lists.flatMap(each => (isObject(each) && typeof each.id === "string" ? [{ id: each.id, name: typeof each.name === "string" && each.name ? each.name : "Custom Auto", entries: Array.isArray(each.entries) ? each.entries.length : 0 }] : []))
    : null;
  for (const list of lists ?? []) noteNames("auto", [list.id], list.name);
  return { models, accounts, auto: lists };
}

/** What the engine lists in `folder` (nothing for none there), as kept. */
export function engineListsIn(engine: Target | null, folder: string | undefined): Promise<EngineLists | null> {
  // (Whole: its default said too, none or one.)
  return engine ? keptOr(`engine:${engine.port}:${folder ?? ""}`, () => engineLists(engine, folder), lists => lists.fallback !== undefined) : Promise.resolve(null);
}

/** What the bridge lists, as kept; null where it can't say (not running now: starting, or
 * started again). */
export function bridgeListsOf(bridge: Target | null): Promise<BridgeLists | null> {
  // (Whole: Custom Auto's lists said too.)
  return bridge ? keptOr(`bridge:${bridge.port}`, () => bridgeLists(bridge), lists => lists.auto !== null) : Promise.resolve(null);
}

/** What both places list, for a session in `folder`. `noBridgeIsNone`: no bridge running counts as
 * no coding agents here (a session started now can't run on one), not as one that can't say yet. */
export async function listsHere(engine: Target | null, bridge: Target | null, folder?: string, noBridgeIsNone = false): Promise<Lists> {
  const [fromEngine, fromBridge] = await Promise.all([engineListsIn(engine, folder), bridgeListsOf(bridge)]);
  return { engine: fromEngine, bridge: fromBridge ?? (!bridge && noBridgeIsNone ? { models: [], accounts: new Map(), auto: [] } : null) };
}

const accountOf = (account: Account): NonNullable<SessionModel["account"]> => ({ id: account.id, name: account.name, ...(account.label ? { label: account.label } : {}) });

/** What `ref`, a model of the engine's, can do; undefined for what the engine can't say. */
function onEngine(ref: Ref, engine: EngineLists | null): ModelState | undefined {
  if (!engine) return undefined;
  const listed = named(ref, engine.models);
  const name = listed ? { name: listed.name } : {};
  // OpenCode Zen's free models need no account; its others the engine lists only with its account
  // or a key of its own (in your settings, say), listed, they run.
  if (listed && ref.providerID === "opencode") return { ...name, runs: true };
  const account = engine.accounts.get(ref.providerID);
  // Signed in, or with nothing to sign in to (one of your own, or a local one). OpenCode Zen is
  // ready for its free models alone: its others need its account.
  const ready = ref.providerID === "opencode" && account ? account.signedIn
    : engine.ready.has(ref.providerID) || !account || account.signedIn || account.methods.length === 0;
  if (ready) {
    if (listed) return { ...name, runs: true };
    // None of its provider's listed: one only a project's own settings add (the engine lists it in
    // that project alone), or one whose models aren't in yet (a plugin's, as the engine settles).
    if (!engine.models.some(model => model.providerID === ref.providerID)) return undefined;
    return { runs: false, missing: "gone", ...(account ? { account: accountOf(account) } : {}) };
  }
  // Signed out: its key, or a sign-in (`signInNeed`).
  const need = signInNeed(ref.providerID, account!.methods);
  return { ...name, runs: false, missing: need.missing, account: accountOf(account!), ...(need.plan ? { plan: need.plan } : {}) };
}

/** What `ref`, a coding agent's model or a Custom Auto list, can do; undefined for what the bridge
 * can't say. */
function withAgents(ref: Ref, bridge: BridgeLists | null): ModelState | undefined {
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

/** Whether `ref` runs in the coding agents' bridge (a coding agent's model, or a Custom Auto list). */
export const onAgents = (ref: Ref): boolean => !isEngineModel(ref) || ref.providerID === "auto";

/** What `ref` can do here; undefined for what can't be said now. */
export function stateOf(ref: Ref, lists: Lists): ModelState | undefined {
  return onAgents(ref) ? withAgents(ref, lists.bridge) : onEngine(ref, lists.engine);
}

/** `ref` as its place lists it (by its own id, for one named by another it's known by). */
export function listedOf(ref: Ref, lists: Lists): Listed | undefined {
  const models = onAgents(ref) ? lists.bridge?.models : lists.engine?.models;
  return models ? named(ref, models) : undefined;
}

/** A model that runs here, as a picker offers it (with the other ids it's known by, its efforts,
 * and whether it's one of its agent's usual ones, for an agent naming it: list_models and
 * start_session). */
export interface Offered { providerID: string; id: string; name: string; aliases: string[]; efforts: string[]; provisional: boolean; retiring: boolean; hidden: boolean; agents: boolean; free: boolean }

/** Every model that runs here now, as a picker offers it: the engine's, newest first in its
 * featured providers' order and the others' by id; then the coding agents', as the bridge lists
 * them; then your Custom Auto lists with models in them. One its provider is retiring
 * (`retiring`), or its agent keeps out of its picker (`hidden`, Codex's), is among them: a
 * conversation on it carries on, though a picker leaves it out. Nothing of a place that can't say. */
export function offeredHere(lists: Lists): Offered[] {
  const order = (providerID: string) => {
    const at = FEATURED.indexOf(providerID);
    return at < 0 ? FEATURED.length : at;
  };
  const engine = (lists.engine?.models ?? [])
    .filter(model => onEngine(model, lists.engine)?.runs === true)
    .sort((a, b) => order(a.providerID) - order(b.providerID) || (a.providerID < b.providerID ? -1 : a.providerID > b.providerID ? 1 : 0) || b.released - a.released);
  // (Those an agent keeps out of its picker too, `hidden`: a conversation, or a new one, on one runs.)
  const agents = (lists.bridge?.models ?? []).filter(model => withAgents(model, lists.bridge)?.runs === true);
  const auto = (lists.bridge?.auto ?? []).filter(list => list.entries > 0);
  return [
    ...[...engine, ...agents].map(model => ({ providerID: model.providerID, id: model.id, name: model.name, aliases: model.aliases, efforts: model.efforts, provisional: model.provisional, retiring: model.retiring, hidden: model.hidden, agents: onAgents(model), free: model.free })),
    ...auto.map(list => ({ providerID: "auto", id: list.id, name: list.name, aliases: [], efforts: [], provisional: false, retiring: false, hidden: false, agents: true, free: false })),
  ];
}

/** The coding agents' accounts whose list isn't all they run yet: signed in and installed, with
 * none listed, only their agent's usual ones (Claude Code's as it starts), or from a bridge (or an
 * agent) that can't say its list is whole. One of theirs not listed may still run. */
export function stillListing(lists: Lists): string[] {
  if (!lists.bridge) return [];
  const bridge = lists.bridge;
  return [...bridge.accounts.values()].filter(account => {
    if (!account.installed || !account.signedIn) return false;
    const ofIt = bridge.models.filter(model => model.providerID === account.id);
    return !ofIt.length || ofIt.every(model => model.provisional) || !account.complete;
  }).map(account => account.id);
}

/** Whether `ref`'s place knows its provider or account, so one it can't say about yet is only
 * still being listed (a coding agent's as it starts, one a project's settings add), not one with
 * no account here at all. A bridge that can't say now knows its agents' as far as can be said. */
function knownHere(ref: Ref, lists: Lists): boolean {
  if (onAgents(ref)) return !lists.bridge || ref.providerID === "auto" || lists.bridge.accounts.has(ref.providerID);
  return Boolean(lists.engine && (lists.engine.ready.has(ref.providerID) || lists.engine.accounts.has(ref.providerID)));
}

/** Why a session starts on the model it does (`startingModel`): the one wanted; the engine's
 * default, as none wanted can run; or the first that runs, as the default can't either. */
export type StartingWhy = "wanted" | "default" | "first";

/** The model a new session starts on here: the first of `wanted` (the one picked, the one picked
 * last) that runs now and isn't being retired, under the id its place lists it by (the effort
 * kept), or one that can't be said about yet but whose provider or account is here (its models
 * still being listed), as it is; else the engine's default, if it runs and isn't being retired;
 * else the first model that does (`offeredHere`: the engine's first, then the coding agents').
 * Null for none: nothing runs here; undefined while the engine can't say, or didn't say its default
 * (and none wanted could be taken as it is). */
export function startingModel(wanted: (Ref | null | undefined)[], lists: Lists): { model: Ref; why: StartingWhy } | null | undefined {
  for (const ref of wanted) {
    if (!ref) continue;
    const state = stateOf(ref, lists);
    if (!state) {
      if (knownHere(ref, lists)) return { model: ref, why: "wanted" };
      // (The engine's, while it can't say: nor can anything be said of what it would start on.)
      if (!lists.engine && !onAgents(ref)) return undefined;
      continue;
    }
    if (!state.runs) continue;
    // A Custom Auto list deleted runs on the first (`withAgents`): that one.
    if (ref.providerID === "auto") {
      const list = lists.bridge?.auto?.find(each => each.id === ref.id) ?? lists.bridge?.auto?.[0];
      return { model: { providerID: "auto", id: list?.id ?? ref.id }, why: "wanted" };
    }
    const listed = listedOf(ref, lists);
    if (listed?.retiring) continue;
    return { model: { providerID: ref.providerID, id: listed?.id ?? ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }, why: "wanted" };
  }
  // (Not one of the coding agents' meanwhile, as if the engine had none.)
  if (!lists.engine) return undefined;
  const fallback = lists.engine.fallback;
  // (A default it didn't say isn't none: nor can the first be taken for it.)
  if (fallback === undefined) return undefined;
  if (fallback && stateOf(fallback, lists)?.runs && !listedOf(fallback, lists)?.retiring) return { model: fallback, why: "default" };
  const first = offeredHere(lists).find(model => !model.retiring && !model.hidden && model.providerID !== "auto");
  return first ? { model: { providerID: first.providerID, id: first.id }, why: "first" } : null;
}
