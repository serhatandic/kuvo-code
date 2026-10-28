// Which process holds the vault: the box's long-running one (`run` on a machine, `serve`), which
// keeps a machine's store key in memory and is the only one that touches the vault. A `box route`
// (the Mac over SSH, kuvo-browser.js) passes `kuvo/vault…` to it over `run/vault.sock` (only you can
// reach it), one request a connection: a line of JSON there, the answer's line back.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { RUN } from "../home";
import type { AnyPiece, LinkHandler, LinkRequest } from "../server/context";

export const VAULT_SOCKET = path.join(RUN, "vault.sock");

let holding = false;

/** Whether this process holds the vault. */
export const holdsVault = () => holding;

/** A request as it goes over the socket, and its answer back. */
interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
interface Answered {
  status: number;
  type: string;
  body: string;
}

const MOST = 8 * 1024 * 1024;

/** This process holds the vault from now on, answering the socket with `handle` (as a local request:
 * neither a phone nor this Mac's app, whatever it says). */
export function holdVault(handle: LinkHandler): net.Server {
  holding = true;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // Copies a box that ended mid-command left (it was killed): gone.
  try { fs.rmSync(path.join(RUN, "vault-run"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(VAULT_SOCKET, { force: true }); } catch {}
  const server = net.createServer(socket => {
    let given = "";
    const stop = new AbortController();
    socket.on("close", () => stop.abort());
    socket.on("error", () => stop.abort());
    socket.setEncoding("utf8");
    socket.on("data", async (chunk): Promise<void> => {
      given += chunk;
      if (given.length > MOST) return void socket.destroy();
      const end = given.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      let sent: Partial<Sent> | null = null;
      try { sent = JSON.parse(given.slice(0, end)); } catch {}
      const request: LinkRequest = {
        method: String(sent?.method ?? "GET"),
        path: String(sent?.path ?? ""),
        headers: typeof sent?.headers === "object" && sent.headers ? sent.headers : {},
        body: Buffer.from(String(sent?.body ?? ""), "base64"),
        fromMac: true,
      };
      // Only the vault's own routes answer here.
      if (!/^kuvo\/vault(\/|\?|$)/.test(request.path)) return void socket.end(JSON.stringify({ status: 404, type: "application/json", body: Buffer.from("{}").toString("base64") }) + "\n");
      let status = 502;
      let type = "";
      const chunks: Buffer[] = [];
      try {
        for await (const part of handle(request, undefined, stop.signal) as AsyncIterable<AnyPiece>) {
          if (part.head) {
            status = part.head.status;
            type = String(part.head.headers?.["content-type"] ?? "");
          }
          if (part.body) chunks.push(Buffer.from(part.body));
          // A stream's first line is what it says now.
          if (type.startsWith("application/x-ndjson") && Buffer.concat(chunks).includes(10)) {
            stop.abort();
            break;
          }
        }
      } catch (error) {
        status = 500;
        type = "application/json";
        chunks.splice(0, chunks.length, Buffer.from(JSON.stringify({ message: String((error as Error)?.message ?? error) })));
      }
      let body = Buffer.concat(chunks);
      if (type.startsWith("application/x-ndjson") && body.includes(10)) body = body.subarray(0, body.indexOf(10) + 1);
      if (!socket.destroyed) socket.end(JSON.stringify({ status, type, body: body.toString("base64") } satisfies Answered) + "\n");
    });
  });
  const old = process.umask(0o177);
  try {
    server.listen(VAULT_SOCKET);
  } finally {
    process.umask(old);
  }
  // Without its socket, `box route` (the Mac over SSH, the browser here) can't reach the vault: said where it's seen.
  server.on("error", error => console.error(`The vault's socket (${VAULT_SOCKET}) couldn't listen: ${error.message}`));
  server.unref();
  return server;
}

/** `request` asked of the process that holds the vault; null when none does (nothing listens). */
export function askHolder(request: LinkRequest, signal?: AbortSignal): Promise<Answered | null> {
  return new Promise(resolve => {
    const socket = net.createConnection(VAULT_SOCKET);
    let answer = "";
    let done = false;
    const finish = (value: Answered | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    signal?.addEventListener("abort", () => finish(null), { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) if (typeof value === "string") headers[name] = value;
      socket.write(JSON.stringify({ method: request.method, path: request.path, headers, body: Buffer.from(request.body ?? Buffer.alloc(0)).toString("base64") } satisfies Sent) + "\n");
    });
    socket.on("data", chunk => {
      answer += chunk;
      if (answer.length > MOST * 2) return finish(null);
      const end = answer.indexOf("\n");
      if (end < 0) return;
      try { finish(JSON.parse(answer.slice(0, end))); } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
