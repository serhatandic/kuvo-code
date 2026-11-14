// The box talking to its browser's keeper (`kuvo-browser.js host`) on `run/browser.sock`, as the
// agents' tools and the live view do: Chrome's DevTools protocol through it. The box's own calls
// (its cookies, removing a site's data) go in quietly (`quiet` with its key): they don't keep the
// browser running, nor start it.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { RUN, socketKey } from "../home";

/** One call: its method, its parameters, and the page session it's for. */
export type KeeperCall = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;

/** Whether the keeper runs now (its record names a process that's alive): Chrome is up, or starting. */
export function keeperRuns(run = RUN): boolean {
  let pid = 0;
  try { pid = Number(fs.readFileSync(path.join(run, "browser.pid"), "utf8")); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** `work` done with a connection to the keeper, given a way to call it; null when it can't be
 * reached in `wait` ms (not running, or still starting) or a call fails. */
export async function withKeeper<T>(work: (call: KeeperCall) => Promise<T>, { run = RUN, wait = 10_000, key = socketKey }: { run?: string; wait?: number; key?: () => string } = {}): Promise<T | null> {
  const deadline = Date.now() + wait;
  let socket: net.Socket | null = null;
  while (!socket && Date.now() < deadline) {
    socket = await new Promise<net.Socket | null>(resolve => {
      const each = net.createConnection(path.join(run, "browser.sock"));
      each.once("connect", () => resolve(each));
      each.once("error", () => resolve(null));
    });
    if (!socket) await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (!socket) return null;
  const connection = socket;
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let hello: () => void = () => {};
  const greeted = new Promise<void>(resolve => (hello = resolve));
  let buffer = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "Kuvo.hello") hello();
      if (message.id === undefined || !waiting.has(message.id)) continue;
      const { resolve, reject } = waiting.get(message.id)!;
      waiting.delete(message.id);
      if (message.error) reject(new Error(String(message.error.message ?? "The browser refused that.")));
      else resolve(message.result ?? {});
    }
  });
  const closed = new Promise<void>(resolve => connection.once("close", () => {
    for (const { reject } of waiting.values()) reject(new Error("The browser stopped."));
    waiting.clear();
    resolve();
  }));
  connection.on("error", () => {});
  let next = 1;
  const call: KeeperCall = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (connection.destroyed) return reject(new Error("The browser stopped."));
    const id = next++;
    waiting.set(id, { resolve, reject });
    connection.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\n");
  });
  const timer = setTimeout(() => connection.destroy(), Math.max(1_000, deadline - Date.now() + 20_000));
  try {
    connection.write(JSON.stringify({ method: "Kuvo.key", params: { key: key(), quiet: true } }) + "\n");
    if (!(await Promise.race([greeted.then(() => true), closed.then(() => false)]))) return null;
    return await work(call);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    connection.destroy();
  }
}
