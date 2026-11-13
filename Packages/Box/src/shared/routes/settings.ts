// This box's own settings (PROTOCOL.md, "kuvo/config"), Also Apply, Settings › MCP Servers'
// popular servers, and its integrations' keys.

import { any, bool, type Infer, list, map, NOTHING, object, type RouteShape, string, words } from "../shape";

/** The engine's settings file, the whole document as it is: the engine's to define, so `any`. */
export const CONFIG = map(any);

/** What Also Apply made of the changes here: each made, at its path; the entries this box doesn't
 * have that some were to (their paths); the paths it keeps its own; the servers that stay on Macs;
 * the keys those made name, for a client to bring first; whether something was made (or every
 * change was already so); and the settings as they are now (with `dry`, as they'd be). */
export const CONFIG_APPLIED = object({
  made: list(object({ path: list(string), value: any })),
  leftOut: list(list(string)),
  kept: list(list(string)),
  macOnly: list(string),
  keys: list(string),
  applied: bool,
  settings: CONFIG,
});

/** One of Settings › MCP Servers' popular servers, as this box has it: how it's reached
 * (`signIn`, `open` or `local`), whether it's added, whether Integrations added it, and whether
 * it uses a Mac's own apps (only ever true on a Mac's box). */
/** How a popular server is reached: what a box can say of one it offers. */
export const MCP_ACCESS = ["signIn", "open", "local"] as const;
export const MCP_CATALOG_SERVER = object({
  id: string,
  title: string,
  summary: string,
  access: words(...MCP_ACCESS),
  added: bool,
  integration: bool,
  macOnly: bool,
});
/** The popular servers (on a machine, without those that use a Mac's own apps). */
export const MCP_CATALOG = object({ servers: list(MCP_CATALOG_SERVER) });

/** This box's integrations' keys, by name (a bot's own aren't among them). */
export const KEYS = object({ keys: list(string) });
/** One key's value. */
export const KEY = object({ value: string });

/** One of Claude Code's agents or commands on this computer, as it comes over: shown by `name` (a
 * command's, the one it comes over as), written as `settings` at `path` through `kuvo/config`, and
 * `imported` when this box's settings have it there. */
export const CLAUDE_CODE_IMPORT = object({ name: string, description: string, path: list(string), settings: map(string), imported: bool });
/** What Settings › Agents and Commands offer from this computer's `~/.claude`. */
export const CLAUDE_CODE = object({ agents: list(CLAUDE_CODE_IMPORT), commands: list(CLAUDE_CODE_IMPORT) });

export type Config = Infer<typeof CONFIG>;
export type ConfigApplied = Infer<typeof CONFIG_APPLIED>;
export type MCPCatalogServer = Infer<typeof MCP_CATALOG_SERVER>;
export type MCPCatalog = Infer<typeof MCP_CATALOG>;
export type Keys = Infer<typeof KEYS>;
export type Key = Infer<typeof KEY>;
export type ClaudeCodeImport = Infer<typeof CLAUDE_CODE_IMPORT>;
export type ClaudeCode = Infer<typeof CLAUDE_CODE>;

export const SETTINGS_ROUTES: RouteShape[] = [
  { route: "GET kuvo/config", answers: { 200: CONFIG } },
  { route: "PATCH kuvo/config", answers: { 200: CONFIG } },
  { route: "POST kuvo/config/apply", answers: { 200: CONFIG_APPLIED } },
  { route: "GET kuvo/mcp/catalog", answers: { 200: MCP_CATALOG } },
  { route: "POST kuvo/mcp/catalog/:id", answers: { 200: CONFIG } },
  { route: "GET kuvo/keys", answers: { 200: KEYS } },
  { route: "GET kuvo/keys/:name", answers: { 200: KEY } },
  { route: "PUT kuvo/keys/:name", answers: { 200: NOTHING } },
  { route: "DELETE kuvo/keys/:name", answers: { 200: NOTHING } },
  { route: "GET kuvo/claude-code", answers: { 200: CLAUDE_CODE } },
];
