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

/** The most of one file read: an agent's instructions or a command's prompt is a few kilobytes. */
export const CLAUDE_FILE_LIMIT = 256 * 1024;

/** A file's text, if it's an ordinary file of `CLAUDE_FILE_LIMIT` at most inside `root` (Claude
 * Code's folder, as its links lead): never a link out of it (an agent may write in ~/.claude, and
 * could leave one to a file it can't read itself), nor a pipe or a device, which would hold the
 * read, nor a file so big it would. Opened where its links lead, without waiting on a pipe, and
 * checked as opened, so one swapped in meanwhile isn't read either. */
async function readClaudeFile(file: string, root: string): Promise<string | null> {
  let real: string;
  try { real = await fs.promises.realpath(file); } catch { return null; }
  if (!real.startsWith(root + path.sep)) return null;
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CLAUDE_FILE_LIMIT) return null;
    // (No more than it said, though it grows as it's read.)
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The Markdown files in a folder of `root`, read; `nested`, in its folders too, each named with
 * them ("frontend/component" for frontend/component.md), as Claude Code names its commands. A link
 * to a folder isn't followed (one to itself would list it again and again); a link to a file is
 * read where it stays in `root` (`readClaudeFile`). Read off the box's thread, so one that macOS
 * asks about holds this request only. */
async function markdownFiles(folder: string, root: string, nested = false): Promise<{ name: string; text: string }[]> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { return []; }
  const found = await Promise.all(entries.map(async entry => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return nested && !entry.name.startsWith(".") ? (await markdownFiles(file, root, true)).map(each => ({ name: `${entry.name}/${each.name}`, text: each.text })) : [];
    if (path.extname(entry.name) !== ".md") return [];
    const text = await readClaudeFile(file, root);
    return text === null ? [] : [{ name: entry.name.slice(0, -3), text }];
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
  // (Where its links lead: a ~/.claude that's a link to your dotfiles is read there.)
  let root: string;
  try { root = await fs.promises.realpath(folder); } catch { return { agents: [], commands: [] }; }
  const agents = (await markdownFiles(path.join(folder, "agents"), root)).flatMap(file => {
    const { fields, body } = parseClaudeFile(file.text);
    const name = fields.name || file.name;
    let id = claudeID(name);
    if (!id) return [];
    if (BUILT_IN_AGENTS.has(id)) id += "-claude";
    // (Claude Code writes "\n" for line breaks in a one-line description.)
    const description = (fields.description ?? "").replaceAll("\\n", "\n");
    return [{ id, name, description, body }];
  }).sort((one, other) => one.name.localeCompare(other.name, undefined, { sensitivity: "base" }));
  const commands = (await markdownFiles(path.join(folder, "commands"), root, true)).flatMap(file => {
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

// `GET kuvo/claude-code`: this computer's own, on every box. (`?machine=`, which a Mac's app once
// answered with the Mac's ~/.claude for one of its machines, isn't another's here: each machine's
// box lists its own.)
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
