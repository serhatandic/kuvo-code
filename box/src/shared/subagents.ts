// The subagents you make in Settings › Agents, and the one model they use (Settings › Agents,
// "Subagents use"), as each box keeps them: in its engine's settings file, its own. The link puts
// the model where the engine's subagents read it (its settings layer, engine/compatibility.ts);
// the coding agents' bridge hands both to each agent that has subagents of its own
// (agents/subagents.ts). What both sides read is here.

import { isObject } from "./json";

/** Where the setting is in the engine's settings file: a model as `provider/model`, or none for
 * the conversation's own. The engine doesn't read it (it leaves keys it doesn't know alone). */
export const SUBAGENT_MODEL = ["subagent_model"];

/** The engine's own agents: never handed to another agent as yours. */
export const ENGINE_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);

/** The engine's own subagents, which use the setting too unless you gave them a model. */
export const ENGINE_SUBAGENTS = ["general", "explore"];

/** The coding agents' providers (accounts.ts `baseProvider`; an added account's is `<base>@<id>`):
 * the engine can't run their models, so its own subagents keep the conversation's then. */
export const AGENT_PROVIDERS = new Set(["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"]);

/** A model the engine runs itself (not a coding agent's). */
export const isEngineModel = (ref: { providerID: string }): boolean => !AGENT_PROVIDERS.has(ref.providerID.split("@")[0]);

/** A model as the settings write it (`provider/model`), or undefined for anything else. */
export function modelRef(value: unknown): { providerID: string; id: string } | undefined {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf("/");
  if (at <= 0 || at === value.length - 1) return undefined;
  return { providerID: value.slice(0, at), id: value.slice(at + 1) };
}

/** The model subagents use on this box, as its settings say (none: the conversation's). */
export function subagentModel(settings: unknown): string | undefined {
  const value = isObject(settings) ? settings[SUBAGENT_MODEL[0]] : undefined;
  return modelRef(value) ? (value as string) : undefined;
}

/** An agent of yours used as a subagent (a subagent, or both a mode and a subagent), not turned off. */
export const isSubagent = (entry: unknown): boolean =>
  isObject(entry) && (entry.mode === "subagent" || entry.mode === "all") && entry.disabled !== true;

/**
 * What the engine's settings layer adds for the setting: the model on each of the engine's
 * subagents, and on each subagent of yours, that has none of its own (the layer is read after your
 * settings, so one that has a model is left out: its own wins). Nothing when it isn't set, or
 * it's a coding agent's model, which only that agent's subagents run.
 */
export function subagentLayer(settings: unknown): Record<string, unknown> {
  const model = subagentModel(settings);
  if (!model || !isEngineModel(modelRef(model)!)) return {};
  const agents = isObject(settings) && isObject(settings.agents) ? settings.agents : {};
  const ids = [...ENGINE_SUBAGENTS, ...Object.keys(agents).filter(id => !ENGINE_AGENTS.has(id) && isSubagent(agents[id]))];
  const layer: Record<string, unknown> = {};
  for (const id of ids) {
    const own = agents[id];
    if (isObject(own) && (own.model !== undefined || own.disabled === true)) continue;
    layer[id] = { model };
  }
  return Object.keys(layer).length ? { agents: layer } : {};
}
