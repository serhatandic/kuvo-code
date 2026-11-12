// What Kuvo Code promises of the engine's own agents, on every box, sandbox or not: working in a
// folder outside a conversation's project asks you first, as Settings › Permissions says ("Work
// outside the project: Ask"). opencode 2.2.6 doesn't: its agents' rules are `* allow` and the
// `.env` asks, so an agent's read and write tools reached any file in your home folder.
//
// The engine's plugin (`kuvo-defaults.js`, which each box writes for its own engine) gives its
// agents the ask after their own rules and before your settings': the engine sets up plugins in
// its plugins folder before it adds your settings' rules to its agents, and the last rule that
// matches wins, so what you set there (and a project's own settings, and a conversation's) still
// does. Only agents that would let it through get it: one that refuses everything (the one naming
// conversations) stays refused. Agents you make yourself in Settings › Agents are added by your
// settings, after the plugin, so they don't get it (PROTOCOL.md says so).
//
// What Kuvo Code and the engine keep for an agent to open stays open to it, with the same order:
// files sent with a message (the box's `attachments`, this Mac's app's `Attachments`), what the
// agent's browser downloads on a machine, the engine's long outputs saved whole and the repositories
// it reads, Plan's plans, and skills' folders, as the engine finds them.

import path from "node:path";
import { textOf, writePrivate } from "../files";
import { ENGINE_CONFIG, IS_MAC, K } from "../home";
import { realish } from "../fence/policy";

/** The plugin, where the engine reads its plugins (a machine's in its box's folder). */
export const DEFAULTS_PLUGIN = path.join(ENGINE_CONFIG || path.join(K, "config"), "opencode", "plugins", "kuvo-defaults.js");

/** Kuvo Code's own folders an agent is given files in, here. */
export function keptFolders(): string[] {
  const folders = [path.join(K, "attachments"), path.join(K, "browser", "downloads")];
  // This Mac's app keeps what you attach beside its box's folder (BoxProcess: `<support>/box`).
  if (IS_MAC) folders.push(path.join(path.dirname(K), "Attachments"));
  return [...new Set(folders.flatMap(folder => [folder, realish(folder)]))];
}

export function defaultsPlugin(kept: string[]): string {
  return `// Kuvo Code writes this each time its box starts: changes here don't last.
// Working in a folder outside a conversation's project asks you first, as Settings › Permissions
// says. The engine's own agents get that rule after their own and before your settings', so what
// you set there wins. What's kept for the agent to open stays open to it: files sent with a
// message, the engine's long outputs saved whole and the repositories it reads, Plan's plans,
// skills' files.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const KEPT = ${JSON.stringify(kept)}
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
// Where the engine keeps Plan's plans (its home folder's \`.opencode/plan\`).
const PLANS = path.join(process.env.OPENCODE_TEST_HOME || os.homedir(), ".opencode", "plan")
const OUTSIDE = "/kuvo-code/an/outside/folder/*"

// A rule's pattern as the engine matches it: \`*\` any text, \`?\` one character, a trailing " *"
// optional.
function matches(text, pattern) {
  let source = pattern.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*/g, ".*").replace(/\\?/g, ".")
  if (source.endsWith(" .*")) source = source.slice(0, -3) + "( .*)?"
  return new RegExp("^" + source + "$", "s").test(text)
}
const letsOut = (rules) => rules.findLast((rule) => matches("external_directory", rule.action) && matches(OUTSIDE, rule.resource))?.effect !== "deny"
const real = (folder) => { try { return fs.realpathSync(folder) } catch { return folder } }
// (Never \`/\`, nor your home folder or one holding it, whatever a skill's folder says.)
const HOME = real(process.env.OPENCODE_TEST_HOME || os.homedir())
const opened = (folders) => [...new Set(folders.flatMap((folder) => [folder, real(folder)]))]
  .map((folder) => path.resolve(folder))
  .filter((folder) => folder !== "/" && !(HOME + "/").startsWith(folder.replace(/\\/+$/, "") + "/"))
  .map((folder) => ({ action: "external_directory", resource: folder + "/*", effect: "allow" }))

export default {
  id: "kuvo-code.defaults",
  setup: async (ctx) => {
    let skills = []
    await ctx.agent.transform((draft) => {
      const rules = [{ action: "external_directory", resource: "*", effect: "ask" }, ...opened([...KEPT, path.join(DATA, "tool-output"), path.join(DATA, "repos"), PLANS, ...skills])]
      for (const agent of draft.list()) if (letsOut(agent.permissions)) draft.update(agent.id, (it) => { it.permissions.push(...rules) })
    })
    // Skills' folders, as the engine finds them: after this plugin is set up, and as they change.
    const learn = async () => {
      const listed = await ctx.skill.list().catch(() => null)
      const found = [...new Set((Array.isArray(listed) ? listed : listed?.data ?? []).flatMap((skill) =>
        typeof skill?.path === "string" && path.isAbsolute(skill.path) && !skill.path.startsWith("/builtin/") ? [path.dirname(skill.path)] : []))].sort()
      if (found.join("\\n") === skills.join("\\n")) return
      skills = found
      await ctx.agent.reload()
    }
    void (async () => {
      try { for await (const _ of ctx.event.subscribe({ types: ["skill.updated"] })) await learn().catch(() => {}) } catch {}
    })()
    await learn().catch(() => {})
  },
}
`;
}

/** Writes the plugin, unless it's there as it should be. */
export function setUpEngineDefaults(): void {
  const plugin = defaultsPlugin(keptFolders());
  if (textOf(DEFAULTS_PLUGIN) !== plugin) writePrivate(DEFAULTS_PLUGIN, plugin);
}

/** Set up as the box starts, and put back each minute if it went or was changed. */
export function keepEngineDefaults(): void {
  try { setUpEngineDefaults(); } catch {}
  setInterval(() => {
    try { setUpEngineDefaults(); } catch {}
  }, 60_000).unref?.();
}
