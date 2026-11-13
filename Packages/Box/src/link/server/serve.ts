// The box's server on this Mac (`serve`)

import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import { readEngineFile } from "../engine/client";
import { canonicalPath } from "./paths";
import { engineHandler } from "./router";
import type { AnyPiece, LinkHandler } from "./context";

// `serve`: this box's routes over HTTP, for a Mac, whose app starts its own box as it starts the
// coding agents' bridge: on 127.0.0.1, `{"url"}` said once it listens, answering only with the
// password in OPENCODE_PASSWORD, and gone when its stdin closes, so it never outlives the app. The
// same routes as a phone's through the relay, the path checked the same way; a stream goes as it
// comes, and stops when the client goes. The engine and the agents' bridge are found as on a
// machine (`run/engine.json`, `run/bridge.json`), which the app writes.
//
// A connection left open between requests is closed by its client first: clients are told 5
// seconds (`Keep-Alive: timeout=5`), and the box closes one only a minute after that.
// Closed after a second more, Node's and Bun's own, a busy client (its timers late, its loop held
// up) sent its next request on a connection the box had just closed: the request never arrived,
// and a POST, which a client doesn't send again, failed (`ECONNRESET`), an agent's sandbox_ask
// with it. (A request it's holding, an ask waiting for your answer, is never timed out: only
// a connection with none.)
const IDLE_TOLD = 5_000;
const IDLE_KEPT = 60_000;
/** How often a request whose answer's head hasn't come says it's still being worked on, with an
 * interim `102 Processing` (ms): a route that holds a request (an ask waiting for you, a sandbox
 * tool, a vault wait, a move) never looks gone to a client's wait between bytes (a URLSession
 * request's timeout, which counts it as activity; Node's fetch's for a head, five minutes) while it
 * works. Clients ignore it otherwise (Node's and Bun's fetch, curl, URLSession), and a client that
 * wants a limit on the whole request keeps its own (the keeper's, KeeperBoxTools). An HTTP/1.0
 * client, which mustn't get one, never does. */
export const HEARTBEAT = 20_000;
export function serveBox(password: string, handle: LinkHandler = engineHandler(readEngineFile, { name: os.hostname() })): http.Server {
  const expected = Buffer.from("Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
  // (`any`: nothing reads what it gives back, and its early `return response.end()` lines would
  // otherwise each need a return on every path.)
  return http.createServer({ keepAliveTimeout: IDLE_TOLD, keepAliveTimeoutBuffer: IDLE_KEPT }, async (request, response): Promise<any> => {
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      response.writeHead(401);
      return response.end();
    }
    const sent = canonicalPath((request.url ?? "").replace(/^\/+/, ""));
    if (sent === null) {
      response.writeHead(403);
      return response.end();
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    let headed = false;
    const alive = request.httpVersionMajor > 1 || (request.httpVersionMajor === 1 && request.httpVersionMinor >= 1)
      ? setInterval(() => {
        if (headed || response.headersSent || response.destroyed || response.writableEnded) return;
        try { response.writeProcessing(); } catch {}
      }, HEARTBEAT)
      : undefined;
    alive?.unref?.();
    const quiet = () => clearInterval(alive);
    response.once("close", quiet);
    try {
      // The app's own (the Mac's link says which aren't a phone's), not a phone using this box; or
      // Kuvo Code on this computer reaching a box that isn't its own (`mac`, a machine's attached
      // in place: `box.serve.mac`), taken as `box route` takes it, streams and all.
      const from = request.headers["x-kuvo-from"];
      const fromApp = from === "app";
      const fromMac = from === "mac";
      for await (const part of handle({ method: request.method ?? "GET", path: sent, headers: request.headers, body: Buffer.concat(chunks), fromApp, fromMac }, {}, abort.signal) as AsyncIterable<AnyPiece>) {
        if (abort.signal.aborted) break;
        if (part.head && !headed) {
          quiet();
          response.writeHead(part.head.status, part.head.headers ?? {});
          response.flushHeaders();
          headed = true;
        }
        if (part.body) response.write(part.body);
      }
    } catch (error) {
      // Cut off once it's begun (the engine gone halfway): ends cut off, not as a whole answer.
      if (headed) return response.destroy(error as Error);
      response.writeHead(500, { "content-type": "application/json" });
      response.write(JSON.stringify({ message: String((error as Error | undefined)?.message ?? error) }));
      headed = true;
    } finally {
      quiet();
    }
    if (!headed) response.writeHead(502);
    response.end();
  });
}