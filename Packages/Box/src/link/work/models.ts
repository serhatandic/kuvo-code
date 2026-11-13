// The models a session can be started on here (list_models, and start_session's `model`): those
// that run here by the one rule every client's picker offers by (`modelsHere`, model-rule.ts), the
// engine's and the coding agents'.

import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { HERE } from "../home";
import type { Target } from "../../shared/records";
import { listsHere, offeredHere, onAgents, stateOf, stillListing } from "./model-rule";
import { holdOf, holdWords, isFree, unansweringNow, type Unanswering } from "./unanswering";

/** A model a session can run on here: its provider and id, its name, its efforts (variants), where
 * it runs (the engine, or the coding agents' bridge), and whether it costs nothing. */
export interface Usable {
  providerID: string;
  id: string;
  name: string;
  efforts: string[];
  /** Other ids it's known by (Claude Code's `default` is whichever model it recommends now). */
  aliases: string[];
  target: Target;
  agents: boolean;
  retiring: boolean;
  /** One its coding agent keeps out of its picker but still runs (Codex's hidden ones). */
  hidden: boolean;
  free: boolean;
}

function modelsIn(listed: unknown, target: Target, agents: boolean, ready: Set<string> | null): Usable[] {
  const models: Usable[] = [];
  for (const each of Array.isArray(listed) ? listed : []) {
    if (!isObject(each) || typeof each.id !== "string" || typeof each.providerID !== "string" || each.enabled === false) continue;
    if (ready && !ready.has(each.providerID)) continue;
    const efforts = Array.isArray(each.variants) ? each.variants.map(variant => (isObject(variant) ? variant.id : null)).filter((id): id is string => typeof id === "string") : [];
    const aliases = Array.isArray(each.aliases) ? each.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    models.push({ providerID: each.providerID, id: each.id, aliases, name: typeof each.name === "string" && each.name ? each.name : each.id, efforts, target, agents, retiring: each.status === "deprecated", hidden: each.hidden === true, free: isFree(each) });
  }
  return models;
}

/** Every model there's an account for here, by the providers the engine says are ready: the
 * engine's first, then the coding agents'. (What a reviewer's small model and a new bot's model
 * go by while the rule can't say; an agent's list_models and start_session go by `modelsHere`.) */
export async function usableModels(engine: Target | null, bridge: Target | null, signal?: AbortSignal): Promise<Usable[]> {
  const models: Usable[] = [];
  if (engine) {
    const [providers, listed] = await Promise.all([call(engine, "GET", "/api/provider", undefined, signal).catch(() => null), call(engine, "GET", "/api/model", undefined, signal).catch(() => null)]);
    const ready = new Set((Array.isArray(providers) ? providers : []).map(each => (isObject(each) ? each.id : null)).filter((id): id is string => typeof id === "string"));
    models.push(...modelsIn(listed, engine, false, ready));
  }
  if (bridge) models.push(...modelsIn(await call(bridge, "GET", "/api/model", undefined, signal).catch(() => null), bridge, true, null));
  return models;
}

/** What an agent naming a model goes by (list_models, start_session's `model`), as the one rule
 * says (model-rule.ts, "The models offered"): `models`, those that run here now, the engine's, the
 * coding agents' and your Custom Auto lists, as every client's picker offers them; `listing`, the
 * coding agents' accounts whose list isn't all they run yet (one of theirs not in `models` may
 * still run); `unsaid`, the places running that can't say now (an engine that hasn't loaded yet,
 * the bridge starting); and `refusal`, why one named that doesn't run can't, where that's said. */
export interface Here {
  models: Usable[];
  listing: string[];
  unsaid: ("engine" | "agents")[];
  bridge: Target | null;
  refusal: (ref: { providerID: string; id: string }) => string | undefined;
}

/** The models that run here by the one rule, for a session in `folder` (where a project's own
 * settings may add to the engine's). */
export async function modelsHere(engine: Target | null, bridge: Target | null, folder?: string, where = HERE): Promise<Here> {
  const lists = await listsHere(engine, bridge, folder);
  const models = offeredHere(lists).flatMap(each => {
    const target = each.agents ? bridge : engine;
    return target ? [{ ...each, target }] : [];
  });
  const unsaid = [...(engine && !lists.engine ? ["engine" as const] : []), ...(bridge && !lists.bridge ? ["agents" as const] : [])];
  const refusal = (ref: { providerID: string; id: string }) => {
    const state = stateOf(ref, lists);
    if (!state || state.runs || !state.account || !["signIn", "key", "install"].includes(state.missing ?? "")) return undefined;
    const account = state.account.label ? `${state.account.name} (${state.account.label})` : state.account.name;
    const why = state.missing === "signIn" ? `it isn't signed in: ask the user to sign in to ${account} in Settings › Accounts`
      : state.missing === "key" ? `it needs a key: ask the user to add one for ${account} in Settings › Accounts${state.plan ? ` (a ${state.plan.name} plan runs ${state.plan.agent}'s models, as ${state.plan.provider}/…)` : ""}`
      : `${account}'s coding agent isn't installed there: ask the user to install it in Settings › Accounts`;
    return `There's no account for ${ref.providerID} ready on ${where}: ${why}. Or use list_models to see the models you can use.`;
  };
  return { models, listing: stillListing(lists), unsaid, bridge, refusal };
}

/** The model `ref` names among `models`: by its own id, or else one it's known by (a session on
 * Claude Code's `default` runs on the model that stands for now). */
export const modelNamed = (ref: { providerID: string; id: string } | null | undefined, models: Usable[]): Usable | undefined => {
  const ofProvider = ref ? models.filter(model => model.providerID === ref.providerID) : [];
  return ofProvider.find(model => model.id === ref?.id) ?? ofProvider.find(model => model.aliases.includes(ref?.id ?? ""));
};

/** The list, for an agent to read: those that can't answer now (`held`) apart, at its end; the
 * coding agents' accounts still listing theirs (`here.listing`), and places that can't say now
 * (`here.unsaid`), said after it. */
export function describeModels(all: Usable[], held: Unanswering[] = unansweringNow(), where = HERE, here?: Pick<Here, "listing" | "unsaid">): string {
  // Not one its provider is retiring, nor one its agent keeps out of its picker, as every
  // client's picker leaves them out (start_session still takes one named).
  const models = all.filter(model => !model.retiring && !model.hidden);
  const notes = [
    ...(here?.listing.length ? [`Still listing their models: ${here.listing.join(", ")}. One of theirs not above may still run: name it to start_session as provider/model.`] : []),
    ...(here?.unsaid.includes("engine") ? [`The engine on ${where} can't say which of its models run yet: try list_models again in a moment.`] : []),
    ...(here?.unsaid.includes("agents") ? [`The coding agents on ${where} can't say which of their models run yet: try list_models again in a moment.`] : []),
  ];
  if (!models.length) return notes.length ? notes.join("\n") : `There's no model with an account on ${where}. Ask the user to sign in to one in Settings › Accounts.`;
  const line = (model: Usable) => `- ${model.providerID}/${model.id} (${model.name})${model.efforts.length ? `, efforts: ${model.efforts.join(", ")}` : ""}`;
  const answering = models.filter(model => !holdOf(model, held));
  const holds = held.filter(each => models.some(model => holdOf(model, [each])));
  const list = answering.length ? `Models you can start a session on, as provider/model (give it to start_session as model, and an effort as effort):\n${answering.map(line).join("\n")}` : `No model here can answer now: tell the user why, from below.`;
  const whole = holds.length ? `${list}\n\nLeft out, as a session on them just failed:\n${holds.map(each => "- " + holdWords(each)).join("\n")}` : list;
  return notes.length ? `${whole}\n\n${notes.join("\n")}` : whole;
}

/** The model `given` names ("provider/model", or {providerID, id}), with the effort it runs at, or
 * why there's none to take. With `here` (`modelsHere`): one of a coding agent's account still
 * listing its models is taken as it's named (the bridge says whether it runs); one that doesn't
 * run is refused saying why, where that's said; one of a place that can't say now, saying so. */
export function pickModel(given: unknown, effort: unknown, models: Usable[], here?: Omit<Here, "models">, where = HERE): { model: Usable; variant: string | null } | { refused: string } {
  let providerID = "", id = "";
  if (typeof given === "string") {
    const at = given.trim().indexOf("/");
    if (at > 0) [providerID, id] = [given.trim().slice(0, at), given.trim().slice(at + 1)];
    else id = given.trim();
  } else if (isObject(given) && typeof given.id === "string") {
    id = given.id;
    providerID = typeof given.providerID === "string" ? given.providerID : "";
  }
  if (!id) return { refused: "Name the model as provider/model, from list_models." };
  const matches = models.filter(model => (model.id === id || model.aliases.includes(id)) && (!providerID || model.providerID === providerID));
  if (!matches.length) {
    if (here && providerID) {
      const ref = { providerID, id };
      if (here.listing.includes(providerID) && here.bridge) {
        const variant = typeof effort === "string" && effort ? effort : null;
        return { model: { providerID, id, name: id, efforts: [], aliases: [], target: here.bridge, agents: true, retiring: false, hidden: false, free: false }, variant };
      }
      const why = here.refusal(ref);
      if (why) return { refused: why };
      if (here.unsaid.includes(onAgents(ref) ? "agents" : "engine")) {
        return { refused: `${onAgents(ref) ? "The coding agents" : "The engine"} on ${where} can't say which of ${onAgents(ref) ? "their" : "its"} models run yet: try again in a moment.` };
      }
    }
    const known = providerID && models.some(model => model.providerID === providerID);
    return { refused: known ? `There's no ${id} among ${providerID}'s models here. Use list_models to see what there is.` : `There's no account for ${providerID || id} on ${where}. Use list_models to see the models you can use.` };
  }
  // (One named by its own id before one it's an alias of.)
  const model = matches.find(each => each.id === id) ?? matches[0];
  if (effort === undefined || effort === null || effort === "") return { model, variant: null };
  if (!model.efforts.length) return { refused: `${model.name} has no efforts to choose from: leave effort out.` };
  if (typeof effort !== "string" || !model.efforts.includes(effort)) return { refused: `${model.name}'s efforts are ${model.efforts.join(", ")}.` };
  return { model, variant: effort };
}
