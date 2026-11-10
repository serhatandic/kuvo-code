// The models a session can be started on here (list_models, and start_session's `model`): the
// engine's, from the providers there's an account for, and the coding agents', from the bridge.

import { isObject } from "../../shared/json";
import { call } from "../engine/client";
import { HERE } from "../home";
import type { Target } from "../../shared/records";
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
  free: boolean;
}

function modelsIn(listed: unknown, target: Target, agents: boolean, ready: Set<string> | null): Usable[] {
  const models: Usable[] = [];
  for (const each of Array.isArray(listed) ? listed : []) {
    if (!isObject(each) || typeof each.id !== "string" || typeof each.providerID !== "string" || each.enabled === false) continue;
    if (ready && !ready.has(each.providerID)) continue;
    const efforts = Array.isArray(each.variants) ? each.variants.map(variant => (isObject(variant) ? variant.id : null)).filter((id): id is string => typeof id === "string") : [];
    const aliases = Array.isArray(each.aliases) ? each.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    models.push({ providerID: each.providerID, id: each.id, aliases, name: typeof each.name === "string" && each.name ? each.name : each.id, efforts, target, agents, retiring: each.status === "deprecated", free: isFree(each) });
  }
  return models;
}

/** Every model there's an account for here: the engine's first, then the coding agents'. */
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

/** The model `ref` names among `models`: by its own id, or else one it's known by (a session on
 * Claude Code's `default` runs on the model that stands for now). */
export const modelNamed = (ref: { providerID: string; id: string } | null | undefined, models: Usable[]): Usable | undefined => {
  const ofProvider = ref ? models.filter(model => model.providerID === ref.providerID) : [];
  return ofProvider.find(model => model.id === ref?.id) ?? ofProvider.find(model => model.aliases.includes(ref?.id ?? ""));
};

/** The list, for an agent to read: those that can't answer now (`held`) apart, at its end. */
export function describeModels(all: Usable[], held: Unanswering[] = unansweringNow()): string {
  // Not one its provider is retiring, as the engine's own picker leaves it out.
  const models = all.filter(model => !model.retiring);
  if (!models.length) return `There's no model with an account on ${HERE}. Ask the user to sign in to one in Settings › Accounts.`;
  const line = (model: Usable) => `- ${model.providerID}/${model.id} (${model.name})${model.efforts.length ? `, efforts: ${model.efforts.join(", ")}` : ""}`;
  const answering = models.filter(model => !holdOf(model, held));
  const holds = held.filter(each => models.some(model => holdOf(model, [each])));
  const list = answering.length ? `Models you can start a session on, as provider/model (give it to start_session as model, and an effort as effort):\n${answering.map(line).join("\n")}` : `No model here can answer now: tell the user why, from below.`;
  return holds.length ? `${list}\n\nLeft out, as a session on them just failed:\n${holds.map(each => "- " + holdWords(each)).join("\n")}` : list;
}

/** The model `given` names ("provider/model", or {providerID, id}), with the effort it runs at, or
 * why there's none to take. */
export function pickModel(given: unknown, effort: unknown, models: Usable[]): { model: Usable; variant: string | null } | { refused: string } {
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
    const known = providerID && models.some(model => model.providerID === providerID);
    return { refused: known ? `There's no ${id} among ${providerID}'s models here. Use list_models to see what there is.` : `There's no account for ${providerID || id} on ${HERE}. Use list_models to see the models you can use.` };
  }
  // (One named by its own id before one it's an alias of.)
  const model = matches.find(each => each.id === id) ?? matches[0];
  if (effort === undefined || effort === null || effort === "") return { model, variant: null };
  if (!model.efforts.length) return { refused: `${model.name} has no efforts to choose from: leave effort out.` };
  if (typeof effort !== "string" || !model.efforts.includes(effort)) return { refused: `${model.name}'s efforts are ${model.efforts.join(", ")}.` };
  return { model, variant: effort };
}
