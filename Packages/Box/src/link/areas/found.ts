// What this computer already has that Kuvo Code can use, for the first launch's "Bring your
// subscriptions" (PROTOCOL.md, "kuvo/accounts/found"): the coding agents' programs and their
// sign-ins, as the agents bridge sees them; the keys and sign-ins of an opencode you use apart
// from Kuvo Code; and keys in the shell that the engine already uses. The same on macOS and
// Linux. No key leaves the box: a client sees names, and asks for one to be used by its id.

import { readFileSync } from "node:fs";
import path from "node:path";
import { type Body, isObject, parsed } from "../../shared/json";
import type { Target } from "../../shared/records";
import type { Found } from "../../shared/routes/box";
import { call } from "../engine/client";
import { K, homeFolder } from "../home";
import type { AnswerPiece, RouteContext } from "../server/context";

/** One entry of opencode's `auth.json`, in the engine's own form for `api/credential`. */
export interface OpencodeEntry {
  integrationID: string;
  kind: "key" | "signIn";
  value?: Record<string, unknown>;
}

/**
 * Where an opencode used apart from Kuvo Code keeps its sign-ins, on both systems: in its data
 * folder, your own `XDG_DATA_HOME` if you set one. On a machine, the box's points into Kuvo Code's
 * folder; yours is what its launch kept (`KUVO_OWN_XDG_DATA_HOME`).
 */
export function opencodeAuthFile(home = homeFolder(), env: NodeJS.ProcessEnv = process.env): string {
  const own = "KUVO_OWN_XDG_DATA_HOME" in env ? env.KUVO_OWN_XDG_DATA_HOME
    : env.XDG_DATA_HOME && !path.resolve(env.XDG_DATA_HOME).startsWith(path.resolve(K)) ? env.XDG_DATA_HOME : undefined;
  return path.join(own || path.join(home, ".local", "share"), "opencode", "auth.json");
}

/** The one this box reads: a demo copy, or a test, names one of its own (`KUVO_DEMO_OPENCODE_AUTH`). */
const readFrom = (): string => process.env.KUVO_DEMO_OPENCODE_AUTH || opencodeAuthFile();

/**
 * opencode's sign-ins, as the engine's own import of them makes them: an API key as a key, which
 * can be copied in; a sign-in with a refresh token as a sign-in, which can't (both apps renewing one
 * refresh token sign each other out), so it's offered as a sign-in here instead. A well-known
 * server's (`opencode auth login <url>`, named by its address) is no provider Kuvo Code has.
 */
export function readOpencode(file: string): OpencodeEntry[] {
  let entries: unknown;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isObject(entries)) return [];
  const found: OpencodeEntry[] = [];
  for (const [name, entry] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const integrationID = name.replace(/\/+$/, "");
    if (!integrationID || !isObject(entry)) continue;
    if (entry.type === "api" && typeof entry.key === "string" && entry.key) {
      found.push({ integrationID, kind: "key", value: { type: "key", key: entry.key, ...(isObject(entry.metadata) ? { metadata: entry.metadata } : {}) } });
    } else if (entry.type === "oauth" && typeof entry.refresh === "string") {
      found.push({ integrationID, kind: "signIn" });
    }
  }
  return found;
}

/** An integration as the engine and the agents bridge list them, as far as this reads it. */
interface Integration {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  connections: { type?: unknown; name?: unknown; status?: unknown }[];
}

/** `target`'s integrations, or none when it isn't running or doesn't answer. */
async function integrations(target: Target | null, signal?: AbortSignal, fresh = false): Promise<Integration[]> {
  if (!target?.port) return [];
  const data = await call(target, "GET", `/api/integration${fresh ? "?fresh=1" : ""}`, undefined, signal ?? AbortSignal.timeout(20_000)).catch(() => null);
  if (!Array.isArray(data)) return [];
  return data.filter(isObject).filter(each => typeof each.id === "string").map(each => ({
    id: each.id as string,
    name: typeof each.name === "string" ? each.name : each.id as string,
    metadata: isObject(each.metadata) ? each.metadata : {},
    connections: Array.isArray(each.connections) ? each.connections.filter(isObject) : [],
  }));
}

/** Lists what's found. A server that isn't running leaves its part empty. */
export async function found({ engine, bridge, authFile = readFrom() }: { engine: Target | null; bridge: Target | null; authFile?: string }, signal?: AbortSignal): Promise<Found> {
  // The agents' programs looked for again (an install a moment ago, a PATH changed since).
  const [engineList, agentList] = await Promise.all([integrations(engine, signal), integrations(bridge, signal, true)]);
  const byID = new Map(engineList.map(integration => [integration.id, integration]));
  const agents = agentList
    .filter(integration => integration.metadata.source === "agent")
    .map((integration): Found["agents"][number] => {
      // The bridge lists a connection only for an agent that's signed in; `account` is who as.
      const signedIn = integration.connections.length > 0;
      const label = integration.metadata.account;
      return { id: integration.id, name: integration.name, installed: integration.metadata.installed !== false, signedIn, ...(signedIn && typeof label === "string" && label ? { label } : {}) };
    });
  const opencode = readOpencode(authFile).map((entry): Found["opencode"][number] => {
    const known = byID.get(entry.integrationID);
    return { id: `opencode:${entry.integrationID}`, integrationID: entry.integrationID, name: known?.name ?? entry.integrationID, kind: entry.kind, connected: (known?.connections.length ?? 0) > 0 };
  });
  const shell = engineList.flatMap(integration => integration.connections
    .filter(connection => connection.type === "env" && typeof connection.name === "string" && connection.name)
    .map((connection): Found["shell"][number] => ({ integrationID: integration.id, name: integration.name, variable: connection.name as string })));
  // Signed in to through the engine already (a plan, a key): not a key in the shell.
  const connected = engineList.filter(integration => integration.connections.some(connection => connection.type !== "env")).map(integration => integration.id);
  return { agents, opencode, shell, connected };
}

/**
 * Copies a found key into the engine, as this computer's active sign-in for its provider. Only keys:
 * a sign-in is done again here. Says why it couldn't, in words for the person who asked.
 */
export async function useFound(id: string, { engine, authFile = readFrom() }: { engine: Target | null; authFile?: string }, signal?: AbortSignal): Promise<{ status: 200 } | { status: 404 | 409 | 502 | 503; message: string }> {
  const entry = id.startsWith("opencode:") ? readOpencode(authFile).find(each => `opencode:${each.integrationID}` === id) : undefined;
  if (!entry) return { status: 404, message: "That key isn’t in opencode’s sign-ins any more." };
  if (entry.kind !== "key" || !entry.value) return { status: 409, message: "This is a sign-in, not a key: sign in to it here instead." };
  if (!engine?.port) return { status: 503, message: "The engine isn’t running." };
  try {
    // Brought over already (a second tap, the phone too): once is enough.
    const known = (await integrations(engine, signal)).find(each => each.id === entry.integrationID);
    if (known?.connections.some(connection => connection.type === "credential")) return { status: 200 };
    await call(engine, "POST", "/api/credential", { integrationID: entry.integrationID, label: "API key", value: entry.value, activate: true }, signal);
    return { status: 200 };
  } catch {
    return { status: 502, message: "The engine didn’t take the key. Try again in a moment." };
  }
}

/** `kuvo/accounts/found` (GET) and `kuvo/accounts/found/use` (POST `{id}`). */
export async function* foundRoute(context: RouteContext): AsyncGenerator<AnswerPiece> {
  const { request, route, signal, readEngine, bridge, json } = context;
  const method = request.method.toUpperCase();
  let engine: Target | null = null;
  try { engine = readEngine(); } catch {}
  if (route === "kuvo/accounts/found") {
    if (!["GET", "HEAD"].includes(method)) return yield* json(405, {});
    return yield* json(200, await found({ engine, bridge: bridge() }, signal));
  }
  if (method !== "POST") return yield* json(405, {});
  const id = (parsed(request.body) as Body<"id">)?.id;
  if (typeof id !== "string" || !id) return yield* json(400, { message: "Say which one to use." });
  const used = await useFound(id, { engine }, signal);
  return yield* json(used.status, used.status === 200 ? {} : { message: used.message });
}
