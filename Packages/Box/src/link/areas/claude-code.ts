// What Settings › Agents and Settings › Commands offer to bring over from Claude Code on this box's
// computer (PROTOCOL.md, `kuvo/claude-code`): the subagents and slash commands in its own
// `~/.claude`, which the engine doesn't read by itself (it does read skills), each with what Import
// writes in this box's settings and whether they have it already. Each box lists its own, a Mac's
// and a machine's alike, with its app closed too; a client writes one through `kuvo/config`.

import fs from "node:fs";
import path from "node:path";
import { homeFolder } from "../home";
import { engineList } from "../engine/client";
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

/** The most read of one file (an agent's instructions or a command's prompt is a few kilobytes),
 * of all of them, of the files and folders looked at, and how deep commands' folders go. */
export const CLAUDE_FILE_LIMIT = 256 * 1024;
const CLAUDE_TOTAL_LIMIT = 4 * 1024 * 1024;
const CLAUDE_ENTRY_LIMIT = 2000;
const CLAUDE_DEPTH_LIMIT = 4;

/** What's left of one listing's limits. */
type Budget = { bytes: number; entries: number };

/** Where an open file is, as the system says it (Linux): null where it can't say (macOS). */
async function openedAt(handle: fs.promises.FileHandle): Promise<string | null> {
  if (process.platform !== "linux") return null;
  try { return await fs.promises.readlink(`/proc/self/fd/${handle.fd}`); } catch { return null; }
}

/** A file's text, if it's an ordinary file of `CLAUDE_FILE_LIMIT` at most inside `root` (Claude
 * Code's folder, as its links lead): never a link out of it (an agent may write in ~/.claude, and
 * could leave one to a file it can't read itself), nor a pipe or a device, which would hold the
 * read, nor a file so big it would, nor one with other names (a hard link). Opened where its links
 * lead, without waiting on a pipe, and checked again as opened: where the system says the open
 * file is (Linux), or that the path still leads to that same file (macOS), so a folder swapped for
 * a link meanwhile isn't read through. */
async function readClaudeFile(file: string, root: string, budget: Budget): Promise<string | null> {
  const inside = (where: string) => where.startsWith(root + path.sep);
  let real: string;
  try { real = await fs.promises.realpath(file); } catch { return null; }
  if (!inside(real)) return null;
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > CLAUDE_FILE_LIMIT || stat.size > budget.bytes) return null;
    const at = await openedAt(handle);
    if (at !== null && !inside(at)) return null;
    const again = await fs.promises.stat(real).catch(() => null);
    if (!again || again.dev !== stat.dev || again.ino !== stat.ino) return null;
    // (No more than it said, though it grows as it's read.)
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (await fs.promises.realpath(file).catch(() => null) !== real) return null;
    budget.bytes -= read;
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The Markdown files in a folder of `root`, read one at a time, within `budget`; `depth`, how
 * many folders deep it may go into (commands: in their folders too, each named with them,
 * "frontend/component" for frontend/component.md, as Claude Code names them). A link to a folder
 * isn't followed (one to itself would list it again and again); a link to a file is read where it
 * stays in `root` (`readClaudeFile`). Read off the box's thread, so one that macOS asks about holds
 * this request only. */
async function markdownFiles(folder: string, root: string, budget: Budget, depth = 0): Promise<{ name: string; text: string }[]> {
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); } catch { return []; }
  const found: { name: string; text: string }[] = [];
  for (const entry of entries.sort((one, other) => one.name < other.name ? -1 : one.name > other.name ? 1 : 0)) {
    if (budget.entries-- <= 0 || budget.bytes <= 0) break;
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && !entry.name.startsWith(".")) {
        for (const each of await markdownFiles(file, root, budget, depth - 1)) found.push({ name: `${entry.name}/${each.name}`, text: each.text });
      }
      continue;
    }
    if (path.extname(entry.name) !== ".md") continue;
    const text = await readClaudeFile(file, root, budget);
    if (text !== null) found.push({ name: entry.name.slice(0, -3), text });
  }
  return found;
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
  const budget: Budget = { bytes: CLAUDE_TOTAL_LIMIT, entries: CLAUDE_ENTRY_LIMIT };
  const agents = (await markdownFiles(path.join(folder, "agents"), root, budget)).flatMap(file => {
    const { fields, body } = parseClaudeFile(file.text);
    const name = fields.name || file.name;
    let id = claudeID(name);
    if (!id) return [];
    if (BUILT_IN_AGENTS.has(id)) id += "-claude";
    // (Claude Code writes "\n" for line breaks in a one-line description.)
    const description = (fields.description ?? "").replaceAll("\\n", "\n");
    return [{ id, name, description, body }];
  }).sort((one, other) => one.name.localeCompare(other.name, undefined, { sensitivity: "base" }));
  const commands = (await markdownFiles(path.join(folder, "commands"), root, budget, CLAUDE_DEPTH_LIMIT)).flatMap(file => {
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
  // (Once its plugins are set up: one just started lists its own before theirs.)
  const listed = await engineList(engine, "api/command") as { name?: unknown }[] | null;
  return new Set((listed ?? []).map(each => each?.name)
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
