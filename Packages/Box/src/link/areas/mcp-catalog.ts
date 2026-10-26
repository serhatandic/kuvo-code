// Settings › MCP Servers' popular servers (PROTOCOL.md, `kuvo/mcp/catalog`): the catalog a Mac
// leaves in the box's `bin`, as this box has it, and one added as its Add button adds it.

import fs from "node:fs";
import path from "node:path";
import { isObject } from "../../shared/json";
import { CONFIG_LOCK, IS_MAC, K } from "../home";
import { changeSettings, CONFIG_FILE, readSettings, SERVERS, valueAt } from "./config";
import type { Settings, SettingsChanged } from "./config";
import { MCP_ACCESS } from "../../shared/routes/settings";
import type { MCPCatalog, MCPCatalogServer } from "../../shared/routes/settings";

/** One of the popular servers, as the Mac's catalog has it: `settings` is what Add puts in the
 * engine's settings. */
interface CatalogServer {
  id?: unknown;
  title?: unknown;
  summary?: unknown;
  access?: unknown;
  macOnly?: unknown;
  integration?: unknown;
  settings?: unknown;
}

// How a server is reached, as this box can say it: one that doesn't say is open; one whose word
// this box doesn't know (a newer Mac's) has none here, and isn't offered.
const accessOf = (server: CatalogServer): MCPCatalogServer["access"] | null => {
  const access = server.access ?? "open";
  return (MCP_ACCESS as readonly unknown[]).includes(access) ? (access as MCPCatalogServer["access"]) : null;
};
// One this box offers: its own id, a way to reach it this box can say, and on a machine, not one
// that uses a Mac's own apps.
const offered = (server: CatalogServer, mac: boolean): server is CatalogServer & { id: string } =>
  typeof server?.id === "string" && (mac || !server.macOnly) && accessOf(server) !== null;

// Settings › MCP Servers' popular servers, as the Mac lists them, which it puts here as it connects.
export const CATALOG_FILE = path.join(K, "bin", "mcp-catalog.json");

// The popular servers, as this box has them: on a machine, those that use the Mac's own apps left out.
export function mcpCatalog(settings: Settings, file = CATALOG_FILE, mac = IS_MAC): MCPCatalog {
  let servers: CatalogServer[] = [];
  try { servers = JSON.parse(fs.readFileSync(file, "utf8")).servers ?? []; } catch {}
  return {
    servers: servers.filter(server => offered(server, mac)).map(server => {
      const added = valueAt(settings, [...SERVERS, server.id]) !== undefined;
      return { id: server.id, title: String(server.title ?? ""), summary: String(server.summary ?? ""), access: accessOf(server)!,
        added, integration: added && Boolean(server.integration), macOnly: mac && Boolean(server.macOnly) };
    }),
  };
}

// One of them added, as its Add button does; one already there stays as it is.
export function addFromCatalog(id: string, file = CONFIG_FILE, catalog = CATALOG_FILE, lock = CONFIG_LOCK, mac = IS_MAC): SettingsChanged | { status: 404 } {
  let servers: CatalogServer[] = [];
  try { servers = JSON.parse(fs.readFileSync(catalog, "utf8")).servers ?? []; } catch {}
  const server = servers.find(each => each?.id === id && offered(each, mac));
  if (!server || !isObject(server.settings)) return { status: 404 };
  const { settings, problem } = readSettings(file);
  if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
  if (valueAt(settings, [...SERVERS, id]) !== undefined) return { status: 200, settings: settings! };
  return changeSettings([{ path: [...SERVERS, id], value: { codemode: false, ...server.settings } }], file, lock);
}
