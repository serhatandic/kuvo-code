// What some providers need from the engine until opencode handles it itself, kept by each box for
// its own engine: a settings file of the box's own beside yours in the engine's settings folder
// (`opencode.jsonc`, which opencode reads with `opencode.json` and reads again as either changes),
// so what the box learns applies at once, to the engine running now, with no restart. (The engine
// reads OPENCODE_CONFIG_CONTENT only as it starts, a reload of its folders cuts their terminals and
// commands, and on a machine OPENCODE_CONFIG is your settings: anomalyco/opencode 2.2.5.)
//
// GitHub Copilot's Claude models reject the `thinking.block_binding` the engine adds to requests for
// Claude 5.1 and later ("thinking.adaptive.block_binding: Extra inputs are not permitted"). opencode
// (2.2.5 still) leaves it out only for models named in its settings, one by one
// (anomalyco/opencode#55160). A model named there that the provider doesn't have shows up in its
// list as a model of its own, so the names come from Copilot's list as this box's engine last gave
// it. And only while there's a Copilot account: named in its settings with none, Copilot counts as
// set up, its newest model becomes the engine's default, and every message left to that default
// fails ("missing required Authorization header"), a new box's first one included.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { subagentLayer } from "../../shared/subagents";
import { CONFIG_FILE, deepMerged, readSettings } from "../areas/config";
import { writePrivate } from "../files";
import { ENGINE_CONFIG, K, RUN, SANDBOX_NOTE } from "../home";
import { engineGet } from "./client";
import type { Target } from "../../shared/records";

/** The layer as this box last learned it, ready to go on top of its engine's settings. */
export const COMPATIBILITY_FILE = path.join(RUN, "compatibility.json");

/** Where the engine reads it: beside your settings in its settings folder (its XDG_CONFIG_HOME),
 * this Mac's app's engine's (KUVO_ENGINE_CONFIG), or in this box's folder on a machine. */
export const ENGINE_LAYER_FILE = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "opencode.jsonc");

// What the file starts with: whose it is (`LAYER_MARK`, which never changes, so a box knows its own
// file whatever an older one wrote under it), so the box only ever changes its own.
const LAYER_MARK = "// Kept by Kuvo Code";
const LAYER_HEADER = `${LAYER_MARK}: what some providers need from this engine, as this computer learned it from\n// it, and the model your subagents use (Settings › Agents). Not your settings, which Kuvo Code keeps\n// apart; changes here are replaced.\n`;

/** Whether this process knows where its engine's settings are, to write the layer there: this
 * Mac's box (KUVO_ENGINE_CONFIG), a machine's box as it runs, or `engine-config` from a machine's
 * start, which names the engine's folder (XDG_CONFIG_HOME, in this box's folder). This Mac's app
 * runs `engine-config` with neither: its box, started first, has written it already. */
export function knowsEngineSettings(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (ENGINE_CONFIG) return true;
  const named = environment.XDG_CONFIG_HOME;
  if (!named) return false;
  const real = (folder: string) => { try { return fs.realpathSync(folder); } catch { return path.resolve(folder); } };
  return real(named) === real(path.join(K, "config"));
}

// Said once: a file of yours where the box keeps its own.
let saidNotOurs = false;

/** The engine's copy of the layer brought to `layer` (what this box learned, by default), with the
 * model your subagents use as `settings` say (this box's settings file, by default; see
 * shared/subagents.ts): written when there's one, gone when there's none, so the engine reads it
 * again at once. A file there that isn't the box's (one you wrote) is left as it is. True when it
 * changed. */
export function applyCompatibility(layer: Record<string, unknown> = readCompatibility(), file = ENGINE_LAYER_FILE, settings: unknown = readSettings().settings): boolean {
  // (Settings that can't be read keep what the layer had for them: what was read last.)
  const subagents = settings === undefined ? lastSubagents(file) : subagentLayer(settings);
  layer = deepMerged(layer, subagents) as Record<string, unknown>;
  let there: string | null = null;
  try { there = fs.readFileSync(file, "utf8"); } catch {}
  if (there !== null && !there.startsWith(LAYER_MARK)) {
    if (!saidNotOurs) console.error(`Kuvo Code: ${file} isn't Kuvo Code's, so what GitHub Copilot's Claude models need from the engine isn't applied. Move it aside to let Kuvo Code keep it.`);
    saidNotOurs = true;
    return false;
  }
  if (!Object.keys(layer).length) {
    if (there === null) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
  const wanted = `${LAYER_HEADER}${JSON.stringify(layer, null, 2)}\n`;
  if (there === wanted) return false;
  writePrivate(file, wanted);
  return true;
}

// Your settings file as the layer last followed it (when it was changed, how big).
let settingsSeen: string | undefined;

/** The layer brought to your settings file once it changed since it last was (by hand, say: one
 * changed through the box is followed at once), so an agent you took away isn't named there. */
export function followSettingsFile(file = CONFIG_FILE): void {
  let stamp = "none";
  try {
    const info = fs.statSync(file);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {}
  if (stamp === settingsSeen) return;
  settingsSeen = stamp;
  try { applyCompatibility(); } catch {}
}

/** What the layer at `file` has for the subagents now. */
function lastSubagents(file: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (!text.startsWith(LAYER_MARK)) return {};
    const kept = JSON.parse(text.split("\n").filter(line => !line.startsWith("//")).join("\n"));
    return isObject(kept) && isObject(kept.agents) ? { agents: kept.agents } : {};
  } catch {
    return {};
  }
}

/** The settings that leave `models` of Copilot's without the field they reject. */
export function compatibilityLayer(models: string[]): Record<string, unknown> {
  if (!models.length) return {};
  const settings = Object.fromEntries(models.map(model => [model, { compatibility: { supportsThinkingBlockBinding: false } }]));
  return { providers: { "github-copilot": { models: settings } } };
}

/** The layer as it is: what this box learned, or nothing before it has. */
export function readCompatibility(file = COMPATIBILITY_FILE): Record<string, unknown> {
  try {
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(kept)) return kept;
  } catch {}
  return {};
}

/** Learns Copilot's Claude models from `engine`'s list and applies them to it at once (`layerFile`,
 * which it reads again as it changes): none with no Copilot account there (the engine lists
 * Copilot's models anyway while its settings name it); one that only these settings put there has
 * no family, so it's left out, and the engine leaves it out of its list as it reads them again. An
 * account whose models haven't come yet leaves what was learned. It throws when the engine can't
 * say what accounts it has (one just started answers 404 for a moment), and changes nothing. True
 * when the layer changed. */
export async function learnCompatibility(engine: Target, file = COMPATIBILITY_FILE, layerFile = ENGINE_LAYER_FILE): Promise<boolean> {
  const account = await engineGet(engine, "api/integration/github-copilot");
  const connections = isObject(account) && isObject(account.data) ? account.data.connections : undefined;
  if (!Array.isArray(connections)) throw new Error("The engine didn't say what Copilot accounts it has.");
  let claude: string[] = [];
  if (connections.length) {
    const listed = await engineGet(engine, "api/model");
    const models = (Array.isArray(listed) ? listed : isObject(listed) && Array.isArray(listed.data) ? listed.data : []) as unknown[];
    const copilot = models.filter((model): model is Record<string, unknown> => isObject(model) && model.providerID === "github-copilot");
    if (!copilot.length) return false;
    claude = copilot
      .filter(model => typeof model.id === "string" && model.id.startsWith("claude-") && model.family != null)
      .map(model => model.id as string)
      .sort();
  }
  const layer = compatibilityLayer(claude);
  const text = JSON.stringify(layer);
  let before: string | null = null;
  try { before = fs.readFileSync(file, "utf8"); } catch {}
  if (before !== text) writePrivate(file, text);
  return applyCompatibility(layer, layerFile) || before !== text;
}

/** `content` (an `OPENCODE_CONFIG_CONTENT`, or none) as the engine starts with it: what `engine-config`
 * prints for this Mac's app and a machine's start scripts. Content that isn't JSON is left as it is.
 * With the sandbox's note for agents among its instructions, which the engine reads again as the
 * box changes it: what commands can do here while they run in the sandbox, nothing while they
 * don't. (What providers need isn't in it any more: the engine reads that from its settings folder,
 * where it can change while it runs, and content would hold an old one over it until a restart.) */
export function engineConfigContent(content: string | undefined): string {
  let given: unknown = {};
  if (content?.trim()) {
    try { given = JSON.parse(content); } catch { return content; }
  }
  if (!isObject(given)) return JSON.stringify(given);
  const instructions = Array.isArray(given.instructions) ? given.instructions : [];
  return JSON.stringify({ ...given, instructions: [...new Set([...instructions, SANDBOX_NOTE])] });
}
