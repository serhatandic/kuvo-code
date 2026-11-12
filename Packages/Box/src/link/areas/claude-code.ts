// What Settings › Agents and Settings › Commands offer to bring over from Claude Code on this box's
// computer (PROTOCOL.md, `kuvo/claude-code`): the subagents and slash commands in its own
// `~/.claude`, which the engine doesn't read by itself (it does read skills), each with what Import
// writes in this box's settings and whether they have it already. Each box lists its own, a Mac's
// and a machine's alike, with its app closed too; a client writes one through `kuvo/config`.

import fs from "node:fs";
import path from "node:path";
import { homeFolder } from "../home";
import { engineGet } from "../engine/client";
import { askedAbout } from "../fence/policy";
import { readSettings, valueAt } from "./config";
import type { EngineRecord } from "../../shared/records";
import type { ClaudeCode, ClaudeCodeImport } from "../../shared/routes/settings";
import type { AnswerPiece, RouteContext } from "../server/context";

/** The engine's own agents, on every computer whether its settings name them or not: one of
 * Claude Code's by a name of theirs comes over as `<name>-claude`. */
const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);
/** The engine's own commands, taken also before its list can be read. */
const ENGINE_COMMANDS = new Set(["init", "review"]);

/** A file's header of fields (between `---` lines) and what comes after it. */
export function parseClaudeFile(text: string): { fields: Record<string, string>; body: string } {
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) return { fields: {}, body: text.trim() };
  const fields: Record<string, string> = {};
  const lines = text.slice(3, end).split("\n");
  for (let index = 0; index < lines.length;) {
    const line = lines[index++];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" ") || line.startsWith("\t")) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // A block (| or >): the indented lines after it.
    if (["|", ">", "|-", ">-"].includes(value)) {
      const block: string[] = [];
      while (index < lines.length && (lines[index].startsWith(" ") || lines[index] === "")) block.push(lines[index++].trim());
      value = block.join(value.startsWith("|") ? "\n" : " ").trim();
    }
    fields[key] = unquote(value);
  }
  let body = text.slice(end + 4);
  const newline = body.indexOf("\n");
  if (newline >= 0) body = body.slice(newline + 1);
  return { fields, body: body.trim() };
}

function unquote(text: string): string {
  const first = text[0];
  if (text.length < 2 || first !== text[text.length - 1] || (first !== "\"" && first !== "'")) return text;
  const inner = text.slice(1, -1);
  return first === "\"" ? inner.replaceAll("\\\"", "\"") : inner.replaceAll("''", "'");
}

/** A name the engine takes: lowercase, with hyphens for anything else. */
export const claudeID = (name: string): string => [...name.toLowerCase()].map(each => /[\p{L}\p{N}_-]/u.test(each) ? each : "-").join("");

/** The Markdown files in a folder, read; `nested`, in its folders too, each named with them
 * ("frontend/component" for frontend/component.md), as Claude Code names its commands. A link to a
 * folder isn't followed (one to itself would list it again and again); a link to a file is read.
 * Read off the box's thread, so one that macOS asks about holds this request only. */
async function markdownFiles(folder: string, nested = false): Promise<{ name: string; text: string }[]> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { return []; }
  const found = await Promise.all(entries.map(async entry => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return nested && !entry.name.startsWith(".") ? (await markdownFiles(file, true)).map(each => ({ name: `${entry.name}/${each.name}`, text: each.text })) : [];
    if (path.extname(entry.name) !== ".md") return [];
    try { return [{ name: entry.name.slice(0, -3), text: await fs.promises.readFile(file, "utf8") }]; } catch { return []; }
  }));
  return found.flat();
}

/** Claude Code's subagents (`agents`) and commands (`commands`) in `folder`, as they'd come over to
 * this box: named so they take none of its own (the engine's agents and commands, and `others`,
 * the commands its engine has that aren't in its settings: a plugin's, an MCP server's), and marked
 * `imported` where `settings` have them already. */
export async function claudeCodeList(folder: string, settings: unknown, others: ReadonlySet<string>): Promise<ClaudeCode> {
  const entry = (name: string, description: string, at: string[], value: Record<string, string>): ClaudeCodeImport =>
    ({ name, description, path: at, settings: value, imported: valueAt(settings, at) !== undefined });
  const agents = (await markdownFiles(path.join(folder, "agents"))).flatMap(file => {
    const { fields, body } = parseClaudeFile(file.text);
    const name = fields.name || file.name;
    let id = claudeID(name);
    if (!id) return [];
    if (BUILT_IN_AGENTS.has(id)) id += "-claude";
    // (Claude Code writes "\n" for line breaks in a one-line description.)
    const description = (fields.description ?? "").replaceAll("\\n", "\n");
    return [{ id, name, description, body }];
  }).sort((one, other) => one.name.localeCompare(other.name, undefined, { sensitivity: "base" }));
  const commands = (await markdownFiles(path.join(folder, "commands"), true)).flatMap(file => {
    const { fields, body } = parseClaudeFile(file.text);
    const id = claudeID(file.name);
    return id && body ? [{ id, description: fields.description ?? "", body }] : [];
  }).sort((one, other) => one.id < other.id ? -1 : one.id > other.id ? 1 : 0);
  return {
    agents: agents.map(agent => entry(agent.name, agent.description, ["agents", agent.id], { mode: "subagent", description: agent.description, system: agent.body })),
    commands: commands.map(command => {
      const name = others.has(command.id) || ENGINE_COMMANDS.has(command.id) ? `${command.id}-claude` : command.id;
      return entry(name, command.description, ["commands", name], { template: command.body, description: command.description });
    }),
  };
}

/** The names of the commands this box's engine has that aren't in its settings: none while it
 * isn't answering. */
async function otherCommands(engine: EngineRecord | null, settings: unknown): Promise<Set<string>> {
  if (!engine?.port) return new Set();
  const yours = valueAt(settings, ["commands"]);
  const listed = await engineGet(engine, "api/command").catch(() => null) as { data?: { name?: unknown }[] } | null;
  return new Set((Array.isArray(listed?.data) ? listed.data : []).map(each => each?.name)
    .filter((name): name is string => typeof name === "string" && !(yours && typeof yours === "object" && name in yours)));
}

// `GET kuvo/claude-code`: this computer's own. (A Mac's app answered `?machine=` for one of its
// machines, with the Mac's ~/.claude; this Mac's box hands that to it still: link/mac/relay.ts.)
export async function* claudeCodeRoute({ request, readEngine, json }: RouteContext): AsyncGenerator<AnswerPiece> {
  if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
  if (new URLSearchParams(request.path.split("?")[1] ?? "").has("machine")) return yield* json(404, { message: "This computer lists its own Claude Code only." });
  const folder = path.join(homeFolder(), ".claude");
  // (~/.claude may lead into a folder macOS asks about, your Desktop say: asked off the box's
  // thread first, so only this request waits for the answer.)
  await askedAbout([path.join(folder, "agents"), path.join(folder, "commands")]);
  const { settings } = readSettings();
  let engine: EngineRecord | null = null;
  try { engine = readEngine(); } catch {}
  return yield* json(200, await claudeCodeList(folder, settings ?? {}, await otherCommands(engine, settings ?? {})));
}
