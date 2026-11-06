// What some providers need from the engine until opencode handles it itself, kept by each box for
// its own engine: a settings layer its engine starts with, on top of your own settings, which this
// Mac's app and a machine's start scripts (with no Mac there too) add with `engine-config`.
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
import { deepMerged } from "../areas/config";
import { writePrivate } from "../files";
import { RUN, SANDBOX_NOTE } from "../home";
import { engineGet } from "./client";
import type { Target } from "../../shared/records";

/** The layer as this box last learned it, ready to go on top of its engine's settings. */
export const COMPATIBILITY_FILE = path.join(RUN, "compatibility.json");

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

/** Learns Copilot's Claude models from `engine`'s list, for the next start of it: none with no
 * Copilot account there (the engine lists Copilot's models anyway while its settings name it); one
 * that only these settings put there has no family, so it's left out, and the next start leaves it
 * out of its settings. An account whose models haven't come yet leaves what was learned. It throws
 * when the engine can't say what accounts it has (one just started answers 404 for a moment), and
 * changes nothing. True when the layer changed. */
export async function learnCompatibility(engine: Target, file = COMPATIBILITY_FILE): Promise<boolean> {
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
  const layer = JSON.stringify(compatibilityLayer(claude));
  let before: string | null = null;
  try { before = fs.readFileSync(file, "utf8"); } catch {}
  if (before === layer) return false;
  writePrivate(file, layer);
  return true;
}

/** `content` (an `OPENCODE_CONFIG_CONTENT`, or none) with the layer on top: what `engine-config`
 * prints for a machine's start scripts. Content that isn't JSON is left as it is. With the
 * sandbox's note for agents among its instructions, which the engine reads again as the box
 * changes it: what commands can do here while they run in the sandbox, nothing while they don't. */
export function engineConfigContent(content: string | undefined, file = COMPATIBILITY_FILE): string {
  const layer = readCompatibility(file);
  let given: unknown = {};
  if (content?.trim()) {
    try { given = JSON.parse(content); } catch { return content; }
  }
  const merged = deepMerged(given, layer);
  if (!isObject(merged)) return JSON.stringify(merged);
  const instructions = Array.isArray(merged.instructions) ? merged.instructions : [];
  return JSON.stringify({ ...merged, instructions: [...new Set([...instructions, SANDBOX_NOTE])] });
}
