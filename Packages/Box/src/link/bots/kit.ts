// @ts-nocheck
// Bots and group chats made here

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isObject } from "../../shared/json";
import { boxProjects } from "../areas/projects";
import { textOf } from "../files";
import { BOTS, IS_MAC, K, UPDATES } from "../home";
import { botPersonalities } from "../personalities/library";
import { readLink } from "../state";

// What New Bot needs here, which the Mac gives the machine as it connects (Bots.MachineKit), and
// what's said while there's none.
export const NO_KIT = IS_MAC ? "Kuvo Code is still setting up bots on this Mac. Try again in a moment." : "Connect to this machine from your Mac once, then try again.";
const KIT_FILE = path.join(BOTS, "kit.json");
// The coding agents' providers (the Mac's OutsideAgents): a bot on one of theirs runs with them.
const AGENT_PROVIDERS = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"];
export const runsWithAgents = model => model?.providerID === "auto" || AGENT_PROVIDERS.includes(String(model?.providerID ?? "").split("@")[0]);

// What a box makes its bots with and tells them, as Kuvo Code words it (KuvoLink's
// `Resources/bot-words.json`, which a client puts beside the bridge and a release brings): New
// Bot's templates, Kuvo Code's own personalities and the looks a bot can have, and what a bot is
// told, paragraph by paragraph, with ⟦place⟧, ⟦clock⟧ and ⟦browser⟧ for where it runs (`here`:
// this Mac, or a machine, by ⟦machine⟧ and ⟦timeZone⟧), ⟦jobLine⟧ and ⟦jobPart⟧ for its job
// (`job`), and ⟦name⟧, ⟦folder⟧ and ⟦personality⟧ for its own. Every box tells its bots its own
// release's words, whichever Mac connects.
const WORDS_FILE = path.join(K, "bin", "bot-words.json");

export function readWords(file = WORDS_FILE) {
  try {
    const words = JSON.parse(textOf(file) ?? "");
    return words?.kuvo === 1 && Array.isArray(words.templates) && Array.isArray(words.personalities) && Array.isArray(words.instructions)
      && isObject(words.looks) && isObject(words.here?.mac) && isObject(words.here?.machine) && isObject(words.job)
      && ["personalityWords", "projectNote", "identityNote", "memory", "greeting"].every(key => typeof words[key] === "string") ? words : null;
  } catch {
    return null;
  }
}

// What this box makes bots with: its own words, filled in for where it runs, with what's its own
// from the kit its Mac gave it (the name the Mac calls it, your time zone, the model a bot starts
// on, its projects, the rules a new conversation gets, and the personalities you made, until its
// library has them), or else its own. This Mac's box needs its app's kit; a machine makes bots
// without one. An older Mac's kit has its own words too, which aren't used: the box is never older
// than a Mac that connects.
export function readKit() {
  const words = readWords();
  const mac = readMacKit();
  if (!words || (IS_MAC && !mac)) return null;
  const timeZone = zoneOf(mac);
  const machine = (typeof mac?.machine === "string" && mac.machine) || readLink()?.id || os.hostname();
  const here = IS_MAC ? words.here.mac : words.here.machine;
  const fill = text => text.replace(/⟦(place|clock|browser)⟧/g, (_, key) => String(here[key] ?? ""))
    .replaceAll("⟦machine⟧", () => machine).replaceAll("⟦timeZone⟧", () => timeZone || "UTC");
  const told = each => words.personalityWords.replaceAll("⟦name⟧", () => each.name).replaceAll("⟦description⟧", () => each.description);
  return {
    kuvo: 1,
    templates: words.templates,
    // Kuvo Code's own, then the ones you made that a Mac's kit has.
    personalities: [
      ...words.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: false, instruction: told(each) })),
      ...(Array.isArray(mac?.personalities) ? mac.personalities.filter(each => each?.custom) : []),
    ],
    personalityWords: words.personalityWords,
    looks: words.looks,
    instructions: fill(words.instructions.join("\n\n")),
    job: { none: String(words.job.none ?? ""), line: String(words.job.line ?? ""), details: String(words.job.details ?? "") },
    projectNote: words.projectNote, identityNote: words.identityNote, memory: words.memory, greeting: words.greeting,
    startingModel: mac?.startingModel ?? null, projects: Array.isArray(mac?.projects) ? mac.projects : [], rules: Array.isArray(mac?.rules) ? mac.rules : [],
    timeZone: timeZone || "UTC",
    ...(typeof mac?.zoneinfo === "string" ? { zoneinfo: mac.zoneinfo } : {}),
  };
}

// What a Mac gave this box of what's its own (`bots/kit.json`), or null.
export function readMacKit() {
  try {
    const kit = JSON.parse(textOf(KIT_FILE) ?? "");
    return kit?.kuvo === 1 ? kit : null;
  } catch {
    return null;
  }
}

// The time zone a machine's bots go by: yours, as a Mac's kit has it, or else the machine's own
// ("" on a Mac, whose bots go by its own clock).
export function zoneOf(mac) {
  if (IS_MAC) return "";
  if (typeof mac?.timeZone === "string" && mac.timeZone) return mac.timeZone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

// A release's kit from before boxes had their words of their own (`bin/bot-kit.json`), gone once no
// release this box installed lists it (so its own files still look as it installed them).
export function forgetOldKit() {
  const file = path.join(K, "bin", "bot-kit.json");
  try {
    const installed = JSON.parse(textOf(path.join(UPDATES, "installed.json")) ?? "{}");
    if (isObject(installed?.files) && "bin/bot-kit.json" in installed.files) return;
  } catch {}
  fs.rmSync(file, { force: true });
}



// `kuvo/bots/templates`, as the Mac's: what New Bot offers, the model a bot starts on here (by
// this machine's name, as its bots' `machine` has it), and its projects.
export function botTemplates(kit, machine) {
  return {
    templates: kit.templates.map(({ firstMessage: _, ...template }) => template),
    personalities: botPersonalities(kit).map(({ instruction: _, ...personality }) => personality),
    looks: kit.looks,
    startingModel: { [IS_MAC ? "mac" : machine || "machine"]: kit.startingModel ?? null },
    projects: boxProjects(kit).map(project => ({ ...project, machine: IS_MAC ? undefined : machine || undefined })),
  };
}

// What a bot is told, from the kit's words with its own name, folder, personality and project,
// and its job (`{line, section}`), for one that has one.
export function botInstructions(kit, name, folder, personality, project, job) {
  const working = Boolean(job?.section || job?.line);
  let text = kit.instructions.replaceAll("⟦name⟧", () => name).replaceAll("⟦folder⟧", () => folder);
  text = personality ? text.replace("⟦personality⟧", () => personality) : text.replace("\n⟦personality⟧\n", "");
  if (project) text = text.replace(`\n\n${kit.identityNote}`, () => `\n\n${kit.projectNote}\n\n${kit.identityNote}`);
  text = text.replace("⟦jobLine⟧", () => (job?.line ? kit.job.line.replace("⟦job⟧", () => job.line) : ""));
  const part = working ? kit.job.details.replace("⟦jobDetails⟧", () => job.section || job.line) : kit.job.none;
  return part ? text.replace("⟦jobPart⟧", () => part) : text.replace(/(\n\n)?⟦jobPart⟧/, "");
}