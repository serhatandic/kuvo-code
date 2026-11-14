// Which process holds the vault: the box's long-running one (`run` on a machine, `serve`), which
// keeps a machine's store key in memory and is the only one that touches the vault. A `box route`
// (the Mac over SSH, kuvo-browser.js) passes `kuvo/vault…` to it over `run/vault.sock` (only you can
// reach it), one request a connection: first each says hello (a nonce each way, the client's with
// the box's socket key, which a command in the sandbox can't read, and the holder's proof that it
// holds the unlock key), then a line of JSON there, the answer's line back. The Mac's
// unlock key never crosses the socket while the holder can prove it has it: the request carries a
// proof of it for this connection instead, which nothing that reads the socket can use again.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isSocketKey, RUN, socketKey } from "../home";
import type { AnyPiece, LinkHandler, LinkRequest } from "../server/context";
import { keepSshAgents } from "./ssh";
import { LOCKED, provesUnlock, unlockProof } from "./store";

export const VAULT_SOCKET = path.join(RUN, "vault.sock");

let holding = false;

/** Whether this process holds the vault. */
export const holdsVault = () => holding;

/** Whether a route is one only the holding process answers: the vault's, and the sandbox's asks
 * and its agents' tool (fence/outside.ts), whose asks wait in it, what it stopped (which the
 * engine's plugin tells it), and Also Allowed, which an ask's Always adds to there (one process
 * changes it). */
export const heldHere = (route: string) => /^kuvo\/(vault|sandbox\/(asks|tools|allowed|stopped))(\/|\?|$)/.test(route);

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
const KEY = "x-kuvo-vault-key";
const AUTH = "x-kuvo-vault-auth";
const nonce = () => crypto.randomBytes(18).toString("base64url");
/** What a client's proof covers: the holder's nonce for this connection, and the request itself. */
const covered = (theirs: string, method: string, route: string, body: string) =>
  `${theirs}\0${method.toUpperCase()}\0${route}\0${crypto.createHash("sha256").update(body).digest("base64url")}`;

/** This process holds the vault from now on, answering the socket with `handle` (as a local request:
 * neither a phone nor this Mac's app, whatever it says). */
export function holdVault(handle: LinkHandler): net.Server {
  holding = true;
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // Copies a box that ended mid-command left (it was killed): gone.
  try { fs.rmSync(path.join(RUN, "vault-run"), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(VAULT_SOCKET, { force: true }); } catch {}
  // The key made now, before anyone asks (one that can't be made yet is made by the first who does).
  try { socketKey(); } catch {}
  const server = net.createServer(socket => {
    let given = "";
    let hello: string | null = null;
    const mine = nonce();
    const stop = new AbortController();
    // A few seconds to say hello in.
    const unheard = setTimeout(() => { if (hello === null) socket.destroy(); }, 10_000);
    socket.on("close", () => { clearTimeout(unheard); stop.abort(); });
    socket.on("error", () => stop.abort());
    socket.setEncoding("utf8");
    socket.on("data", async (chunk): Promise<void> => {
      given += chunk;
      if (given.length > MOST) return void socket.destroy();
      // Hello first: its nonce, answered with this one's and, while the unlock key is here, the proof of it.
      if (hello === null) {
        const end = given.indexOf("\n");
        if (end < 0) return;
        let said: { hello?: unknown; key?: unknown } | null = null;
        try { said = JSON.parse(given.slice(0, end)); } catch {}
        // Only from Kuvo Code's own processes: nothing at all for one without the key.
        if (!isSocketKey(said?.key)) return void socket.destroy();
        given = given.slice(end + 1);
        hello = typeof said?.hello === "string" ? said.hello.slice(0, 100) : "";
        const proof = hello ? unlockProof("holder", hello) : null;
        socket.write(JSON.stringify({ nonce: mine, ...(proof ? { proof } : {}) }) + "\n");
      }
      const end = given.indexOf("\n");
      if (end < 0) return;
      socket.removeAllListeners("data");
      let sent: Partial<Sent> | null = null;
      try { sent = JSON.parse(given.slice(0, end)); } catch {}
      const headers: Record<string, string> = typeof sent?.headers === "object" && sent.headers ? { ...sent.headers } : {};
      // A client proves it holds the unlock key for this connection and this request alone.
      const proved = provesUnlock("client", covered(mine, String(sent?.method ?? "GET"), String(sent?.path ?? ""), String(sent?.body ?? "")), headers[AUTH]);
      delete headers[AUTH];
      const request: LinkRequest = {
        method: String(sent?.method ?? "GET"),
        path: String(sent?.path ?? ""),
        headers,
        body: Buffer.from(String(sent?.body ?? ""), "base64"),
        fromMac: true,
        ...(proved ? { vaultClient: true } : {}),
      };
      // Only the routes of what this process alone keeps answer here: the vault's, and the sandbox's
      // asks and its agents' tool, which wait in it.
      if (!heldHere(request.path)) return void socket.end(JSON.stringify({ status: 404, type: "application/json", body: Buffer.from("{}").toString("base64") }) + "\n");
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
  // Each conversation's SSH agent, from the vault's SSH keys, while its commands are in the sandbox.
  const stopAgents = keepSshAgents();
  server.on("close", stopAgents);
  return server;
}

/** Whether the socket is one only this user could have made, as the holder makes it. */
function socketLooksHeld(): boolean {
  try {
    const stat = fs.lstatSync(VAULT_SOCKET);
    return stat.isSocket() && (process.getuid ? stat.uid === process.getuid() : true) && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Why a request wasn't passed on: the process at the socket couldn't prove it holds the vault. */
export const NOT_THE_HOLDER = "That isn't this vault's key, or what answers for it couldn't prove it's Kuvo Code's own: nothing was sent to it.";

/** `request` asked of the process that holds the vault; null when none does (nothing listens). A
 * request with the unlock key sends a proof of it instead, once the holder proved it has it too;
 * to one that can't (it's locked), the key itself only to unlock it (`kuvo/vault/unlock`, which a
 * client sends when you ask): anything else is told it's locked, and nothing is sent. */
export function askHolder(request: LinkRequest, signal?: AbortSignal): Promise<Answered | null> {
  return new Promise(resolve => {
    if (!socketLooksHeld()) return resolve(null);
    // Only Kuvo Code's own processes can read the key; without it nothing answers.
    let key: string;
    try { key = socketKey(); } catch { return resolve(null); }
    const socket = net.createConnection(VAULT_SOCKET);
    const ours = nonce();
    let theirs: { nonce?: unknown; proof?: unknown } | null = null;
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
    socket.on("connect", () => socket.write(JSON.stringify({ hello: ours, key }) + "\n"));
    const body = Buffer.from(request.body ?? Buffer.alloc(0)).toString("base64");
    const send = () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) if (typeof value === "string" && name !== AUTH) headers[name] = value;
      const key = headers[KEY];
      if (key && typeof theirs?.proof !== "string" && !/^kuvo\/vault\/unlock(\?|$)/.test(request.path)) {
        finish({ status: 423, type: "application/json", body: Buffer.from(JSON.stringify({ message: LOCKED })).toString("base64") });
        return;
      }
      if (key) {
        const unlock = Buffer.from(key, "base64url");
        if (typeof theirs?.proof === "string") {
          // It holds the key: proved, and the key stays here.
          // It doesn't: the key isn't this vault's any more (made again), or what answers isn't the
          // holder. Either way nothing is sent, and the client hears its key isn't this vault's.
          if (theirs.proof !== unlockProof("holder", ours, unlock)) {
            finish({ status: 403, type: "application/json", body: Buffer.from(JSON.stringify({ message: NOT_THE_HOLDER })).toString("base64") });
            return;
          }
          delete headers[KEY];
          headers[AUTH] = unlockProof("client", covered(String(theirs.nonce ?? ""), request.method, request.path, body), unlock)!;
        }
      }
      socket.write(JSON.stringify({ method: request.method, path: request.path, headers, body } satisfies Sent) + "\n");
    };
    socket.on("data", chunk => {
      answer += chunk;
      if (answer.length > MOST * 2) return finish(null);
      let end = answer.indexOf("\n");
      if (end < 0) return;
      if (!theirs) {
        try { theirs = JSON.parse(answer.slice(0, end)); } catch { return finish(null); }
        answer = answer.slice(end + 1);
        send();
        end = answer.indexOf("\n");
        if (end < 0) return;
      }
      try { finish(JSON.parse(answer.slice(0, end))); } catch { finish(null); }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
