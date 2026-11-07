// The engine and the coding agents' bridge beside it, as this box reaches them: on 127.0.0.1, at
// what their records say, with their passwords.

import fs from "node:fs";
import { processRuns as runs } from "../../shared/platform";
import type { Fields } from "../../shared/json";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import { BRIDGE_FILE, ENGINE_FILE } from "../home";

export const readEngineFile = (): EngineRecord => JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8"));
// The coding agents' bridge beside the engine, when it runs: its port and password.
export const readBridgeFile = (): BridgeRecord => JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));

/** The coding agents' bridge beside the engine, while it runs; null otherwise. */
export function bridgeTarget(): Target | null {
  try {
    const bridge = readBridgeFile();
    return bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents") ? bridge : null;
  } catch {
    return null;
  }
}

/** Where a letter's agent can be here (`targets`): the engine, and the coding agents' bridge while
 * it runs; and whether both can be asked now (`bridge`), as only then is one neither knows gone. One
 * the engine doesn't know while the bridge isn't running may be the bridge's, and one the bridge
 * doesn't know while the engine's starting may be the engine's: kept to try again. */
export interface PeerPlaces {
  targets: Target[];
  bridge: boolean;
}

export function peerPlaces(): PeerPlaces {
  const targets: Target[] = [];
  let engine = false;
  try {
    targets.push(readEngineFile());
    engine = true;
  } catch {}
  const bridge = bridgeTarget();
  if (bridge) targets.push(bridge);
  return { targets, bridge: engine && bridge !== null };
}

// Where a letter's agent can be here: the engine, and the coding agents' bridge while it runs.
export const peerTargets = (): Target[] => peerPlaces().targets;

/** An answer of the engine's (or the coding agents' bridge's) as their APIs always give one, with
 * what was asked for under `data`, before that's checked: whatever came there (unknown), or null
 * for an empty answer or none. */
export type UncheckedAnswer = Fields<"data"> | null;

/** An answer of the engine's (or the coding agents' bridge's) as their APIs always give one: what
 * was asked for under `data`, in `T`, the shape they document for it. (As they answer it: a type
 * that trusts them, for what's read without a check.) */
export interface EngineAnswer<T> {
  data: T;
}

// Asks the engine for `route` (a path under its API), as JSON.
export function engineGet(engine: Target, route: string, folder?: string): Promise<unknown> {
  return fetch(`http://127.0.0.1:${engine.port}/${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}`, ...(folder ? { "x-opencode-directory": encodeURIComponent(folder) } : {}) }, signal: AbortSignal.timeout(10_000) })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)));
}

/** `target`'s answer to `method route` (with `body` as JSON), as JSON, or null for an empty one; it throws for a status that isn't ok. */
export async function asked(target: Target, method: string, route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${target.port}/${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`It answered ${response.status}.`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * `target`'s answer to `method route` (a path from its root, with `body` as JSON), as its API
 * answers: what's under `data`, or the whole answer; it throws with the answer's message for a
 * status that isn't ok. `folder`: the folder it's about, as the engine reads it.
 */
export async function call(target: Target, method: string, route: string, body?: unknown, signal?: AbortSignal, folder?: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${target.port}${route}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`,
      ...(body ? { "content-type": "application/json" } : {}),
      // The folder it's about, as the engine reads it (a query naming one is ignored).
      ...(folder ? { "x-opencode-directory": encodeURIComponent(folder) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  // Whatever it answered, as JSON ({} for none), read for its `message` (why it failed, in words,
  // as their APIs say it) and `data` where it has them.
  const value = await response.json().catch(() => ({})) as Fields<"message" | "data"> | null;
  if (!response.ok) throw Object.assign(new Error((typeof value?.message === "string" && value.message) || `It answered ${response.status}.`), { status: response.status });
  return value?.data ?? value;
}

// `url`'s body, at most `most` bytes, within `timeout` ms.
export async function fetched(url: string, most: number, timeout: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "follow" });
  if (!response.ok) throw new Error(`It answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > most) throw new Error("It's larger than a release can be.");
  return data;
}
