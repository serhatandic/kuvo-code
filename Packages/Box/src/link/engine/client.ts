// The engine and the coding agents' bridge beside it, as this box reaches them: on 127.0.0.1, at
// what their records say, with their passwords.

import fs from "node:fs";
import type { BridgeRecord, EngineRecord, Target } from "../../shared/records";
import { BRIDGE_FILE, ENGINE_FILE } from "../home";

export const readEngineFile = (): EngineRecord => JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8"));
// The coding agents' bridge beside the engine, when it runs: its port and password.
export const readBridgeFile = (): BridgeRecord => JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));

// Asks the engine for `route` (a path under its API), as JSON.
export function engineGet(engine: Target, route: string): Promise<any> {
  return fetch(`http://127.0.0.1:${engine.port}/${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)));
}

/** `target`'s answer to `method route` (with `body` as JSON), as JSON, or null for an empty one; it throws for a status that isn't ok. */
export async function asked(target: Target, method: string, route: string, body?: unknown): Promise<any> {
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
export async function call(target: Target, method: string, route: string, body?: unknown, signal?: AbortSignal, folder?: string): Promise<any> {
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
  const value: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.message || `It answered ${response.status}.`);
  return value?.data ?? value;
}

// `url`'s body, at most `most` bytes, within `timeout` ms.
export async function fetched(url: string, most: number, timeout: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "follow" });
  if (!response.ok) throw new Error(`It answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > most) throw new Error("It's larger than a release can be.");
  return data;
}
