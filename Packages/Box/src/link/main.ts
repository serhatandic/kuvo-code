// @ts-nocheck
// (Typed modules take its parts out one at a time: Packages/Box/README.md. Until then it's checked
// as it runs, by the bridge's tests.)
// Kuvo Code's link on a machine: lets the phones you've paired reach this machine's engine
// through the relay, so its sessions and bots work from the phone with the Mac closed. The
// engine's own runtime runs it, so the machine needs nothing else:
//
//   BUN_BE_BUN=1 opencode kuvo-link.js run             the bridge, started beside the engine, which
//                                                      also tells your phones what happens in the
//                                                      machine's sessions while no Mac does
//   BUN_BE_BUN=1 opencode kuvo-link.js setup           the Mac's phones and relay, as JSON on stdin
//   BUN_BE_BUN=1 opencode kuvo-link.js pair [relay]    a link to pair a phone with this machine
//   BUN_BE_BUN=1 opencode kuvo-link.js selftest        checks the runtime has what it needs
//
// It keeps its state in ~/.kuvo-code/run/link.json (mode 600), reads the engine's port and
// password from run/engine.json, and connects out to the relay; it never listens. The protocol
// is in PROTOCOL.md beside this file's source (kuvo-ai's Packages/KuvoLink), with the same in
// Swift for the Mac and the phone.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOC_KINDS } from "../shared/documents";
import { isObject, sortedJSON } from "../shared/json";
import { alive, processRuns as runs, promptedFolders } from "../shared/platform";
import { addressOf, EMPTY, newKey, publicOf } from "./crypto/keys";
import { CipherState, IKInitiator, IKResponder, MAIL_PROLOGUE, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
import { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, readRelay, relayHello, relayPush, relaySend } from "./relay/frames";
import { masked, showsAll } from "./notices/mask";
import { bodyHash, DOC_PART, docBytes, docKey, held, MOST_DOC, MOST_PARTS, newSigningSeed, ownSign, readDoc, shortHash, SIGN, signDoc, signingKeyOf } from "./documents/format";

// What moved into modules, as this file exported it (the bridge's tests import it from here).
export { addressOf, newKey, publicOf } from "./crypto/keys";
export { CipherState, IKInitiator, IKResponder, MAIL_PROLOGUE, openOneWay, PROLOGUE, sealOneWay } from "./crypto/noise";
export { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, readRelay, relayHello, relayPush, relaySend } from "./relay/frames";
export { isSecretName, markingHashes, masked, maskedHexValues, maskedNamed, namesHash, showsAll } from "./notices/mask";
export { docBytes, MOST_DOC, newSigningSeed, ownSign, readDoc, signDoc, signingKeyOf } from "./documents/format";

// Goes up with every change, so `setup` replaces a running bridge that's older. Clients don't
// compare it: they check `FEATURES`.
export const BRIDGE_VERSION = "0.9.71";
// What this box answers, one name per route or group of routes a client might check, as
// `kuvo/info` says (PROTOCOL.md, "Features"). A name comes with what it names and never changes
// meaning. A Mac's list (PhoneLink's `features`) has the same but `engine.start` and `update`,
// and the Mac's own routes besides.
export const FEATURES = [
  "accounts.credentials", "accounts.ended", "agents", "asks", "attention", "bots", "bots.edit", "bots.keys", "bots.make", "config", "config.apply",
  "engine.restart", "engine.start", "file", "folders", "goals", "groups", "groups.delete", "groups.edit", "groups.joinable", "groups.make", "groups.seats", "integrations", "keys",
  "mcp.catalog", "named", "personalities", "plugins.search", "personalities.events", "phones", "phones.pair", "projects", "sessions.agents", "shell.stop", "sign-in.return",
  "skills", "skills.trash", "update", "wakes", "wakes.edit", "wakes.events", "worktrees", "worktrees.events", "worktrees.where", "bots.events", "bots.job",
];
const K = process.env.KUVO_HOME || path.join(os.homedir(), ".kuvo-code");
const RUN = path.join(K, "run");
export const LINK_FILE = path.join(RUN, "link.json");
const ENGINE_FILE = path.join(RUN, "engine.json");
// The coding agents' bridge beside the engine (kuvo-agents.js): its port and password.
const BRIDGE_FILE = path.join(RUN, "bridge.json");
const PID_FILE = path.join(RUN, "link.pid");
// While it's there, the box's keeper keeps this bridge running (`bin/kuvo-start keep`).
const NEEDED_FILE = path.join(RUN, "link.needed");
const VERSION_FILE = path.join(RUN, "link.version");
const PAIRING_MINUTES = 10;

// ---- The host: answers paired phones' sessions (the Mac app's LinkServer, in JavaScript) ----

export class LinkHost {
  // authorize(key, hello, address) → whether to let the phone in; handle(request, phone, signal) → an
  // async iterable of { head: { status, headers } } and { body }; connect(request, phone,
  // { open, text, binary, end }) → a socket's { send, close } (PROTOCOL.md, "Sockets");
  // send(bytes) → to the relay; confirmed(phone) → its session proved its own: its first message
  // opened with the handshake's keys, which a replayed first handshake message can't do.
  // mail(from, body, frame) → a mail frame sent to this machine (its Mac's phone list).
  constructor({ key, hello, authorize, handle, connect, send, confirmed, mail }) {
    Object.assign(this, { key, hello, authorize, handle, connect, send, confirmed, mail });
    this.sessions = new Map();
  }

  // The relay connection dropped: what was under way is gone.
  reset() {
    for (const session of this.sessions.values()) this.end(session, false);
  }

  get active() { return this.sessions.size; }

  // A phone the relay can't reach any more (asleep, gone), or whose relay connection the relay says
  // went or was replaced (it ended its sessions with it): what it asked for has nobody to go to.
  // While this host's own relay connection stays up, a session ends only with the phone told, or
  // by the phone's own doing: phones count on that rather than checking before each request
  // (PROTOCOL.md, "The relay").
  forget(address) {
    for (const session of this.sessions.values()) if (session.from.equals(address)) this.end(session, false);
  }

  // Phones no longer paired (removed on the Mac) lose the sessions they have open.
  keepOnly(keys) {
    for (const session of this.sessions.values()) if (!keys.has(session.phone.key.toString("base64url"))) this.end(session, true);
  }

  async receive(from, payload) {
    try {
      await this.receiveFrame(from, payload);
    } catch {
      // Nothing a phone sends gets to stop the bridge.
    }
  }

  async receiveFrame(from, payload) {
    const parsed = readFrame(payload);
    if (!parsed) return;
    const id = `${from.toString("base64url")}:${parsed.session}`;
    const session = this.sessions.get(id);
    switch (parsed.kind) {
      case Frame.handshake1:
        return this.handshake(from, parsed.session, id, parsed.body);
      case Frame.transport: {
        if (!session) return this.send(relaySend(from, frame(Frame.close, parsed.session)));
        let message;
        try {
          message = decodeMessage(session.transport.open(parsed.body));
        } catch {
          message = null;
        }
        if (!message || typeof message.head !== "object" || message.head === null) return this.end(session, true);
        if (!session.confirmed) {
          session.confirmed = true;
          this.confirmed?.(session.phone);
        }
        return this.message(session, message);
      }
      case Frame.close:
        if (session) this.end(session, false);
        return;
      case Frame.mail:
        // (And the frame whole, for this Mac's box to hand its app.)
        return this.mail?.(from, parsed.body, payload);
    }
  }

  async handshake(from, number, id, body) {
    const refuse = () => this.send(relaySend(from, frame(Frame.close, number)));
    const responder = new IKResponder(this.key, PROLOGUE);
    let hello;
    try {
      hello = JSON.parse(responder.readMessage1(body).toString("utf8"));
    } catch {
      return refuse();
    }
    if (hello?.v !== 1 || !(await this.authorize(responder.rs, hello, from))) return refuse();
    const { message, transport } = responder.writeMessage2(Buffer.from(JSON.stringify(this.hello)));
    // One session per phone: a new one replaces what's left of the last.
    for (const old of this.sessions.values()) if (old.from.equals(from)) this.end(old, false);
    const phone = { key: responder.rs, name: String(hello.name ?? ""), address: from };
    this.sessions.set(id, { id, from, number, phone, transport, incoming: new Map(), running: new Map(), sockets: new Map() });
    this.send(relaySend(from, frame(Frame.handshake2, number, message)));
  }

  message(session, { head, body }) {
    switch (head.t) {
      case "req": {
        const request = { method: head.m ?? "GET", path: head.p ?? "", headers: head.h ?? {}, body };
        if (String(request.headers.upgrade ?? "").toLowerCase() === "websocket") this.open(session, head.id, request);
        else if (head.end === false) session.incoming.set(head.id, request);
        else this.run(session, head.id, request);
        return;
      }
      case "data": {
        const socket = session.sockets.get(head.id);
        if (socket) {
          if (body.length) socket.handle?.send(body);
          if (head.end === true) {
            session.sockets.delete(head.id);
            socket.handle?.close();
          }
          return;
        }
        const request = session.incoming.get(head.id);
        if (!request) return;
        request.body = Buffer.concat([request.body, body]);
        if (head.end === true) {
          session.incoming.delete(head.id);
          this.run(session, head.id, request);
        }
        return;
      }
      case "cancel":
        session.running.get(head.id)?.abort();
        session.running.delete(head.id);
        session.incoming.delete(head.id);
        session.sockets.get(head.id)?.handle?.close();
        session.sockets.delete(head.id);
        return;
      case "ping":
        return this.seal(session, encodeMessage({ t: "pong" }));
    }
  }

  run(session, id, request) {
    const controller = new AbortController();
    session.running.set(id, controller);
    const live = () => !controller.signal.aborted && this.sessions.get(session.id) === session;
    const reply = (head, body, end) => {
      if (!live()) return;
      for (const piece of pieces(head, body, end)) this.seal(session, piece);
    };
    (async () => {
      let head = null;
      let started = false;
      try {
        for await (const part of this.handle(request, session.phone, controller.signal)) {
          if (!live()) return;
          if (part.head) {
            head = { t: "res", id, s: part.head.status, h: part.head.headers };
          } else if (part.body?.length) {
            // The head goes with the first piece of the body.
            reply(started ? { t: "data", id } : head ?? { t: "data", id }, part.body, false);
            started = true;
          }
        }
        reply(started ? { t: "data", id } : head ?? { t: "data", id }, EMPTY, true);
      } catch (error) {
        if (!live()) return;
        if (!started) reply({ t: "res", id, s: 502, h: { "content-type": "text/plain" } }, Buffer.from(String(error?.message ?? error)), true);
        else this.seal(session, encodeMessage({ t: "cancel", id }));
      } finally {
        if (session.running.get(id) === controller) session.running.delete(id);
      }
    })();
  }

  // A socket: open once the engine's is, then messages both ways until either side ends it.
  open(session, id, request) {
    const socket = { handle: null, opened: false };
    session.sockets.set(id, socket);
    const live = () => this.sessions.get(session.id) === session && session.sockets.get(id) === socket;
    const reply = (head, body, end) => {
      if (!live()) return;
      for (const piece of pieces(head, body, end)) this.seal(session, piece);
    };
    const end = error => {
      if (!live()) return;
      if (socket.opened) reply({ t: "data", id }, EMPTY, true);
      else reply({ t: "res", id, s: 502, h: { "content-type": "text/plain" } }, Buffer.from(String(error?.message ?? "It closed.")), true);
      session.sockets.delete(id);
    };
    if (!this.connect) return end(new Error("Sockets aren't available here."));
    socket.handle = this.connect(request, session.phone, {
      open: () => {
        socket.opened = true;
        reply({ t: "res", id, s: 101 }, EMPTY, false);
      },
      text: data => reply({ t: "data", id }, data, false),
      // Binary messages are small (the engine's notes on a terminal); one too long to go whole
      // doesn't go.
      binary: data => { if (data.length <= 60_000) reply({ t: "data", id, h: { type: "binary" } }, data, false); },
      end,
    });
  }

  seal(session, plaintext) {
    this.send(relaySend(session.from, frame(Frame.transport, session.number, session.transport.seal(plaintext))));
  }

  end(session, notify) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    for (const controller of session.running.values()) controller.abort();
    session.running.clear();
    for (const socket of session.sockets.values()) socket.handle?.close();
    session.sockets.clear();
    if (notify) this.send(relaySend(session.from, frame(Frame.close, session.number)));
  }
}

// ---- Forwarding to the engine ----

// The sockets a phone may open: a terminal's.
const SOCKETS = [/^api\/pty\/[^/?]+\/connect(\?|$)/];
const REQUEST_HEADERS = ["content-type", "accept", "x-opencode-directory", "last-event-id"];
const RESPONSE_HEADERS = ["content-type", "cache-control"];

// `path` written one way only, which is what's checked and what's sent, or null when it isn't
// what it seems, as the Mac's EngineRoutes.canonical: each part between slashes, and each name
// and value in its query, percent-decoded once and encoded again the same way every time; empty
// parts left out. Also refused: a fragment (`#`, which isn't sent) or a space at either end,
// which a phone never sends; a part between slashes that holds a slash, or is "." or ".."; a name
// or value in the query with a ".." between its slashes. (Only what's ASCII counts there, so a
// mark or joiner hides neither, and "[...slug]" is a name.)
export const canonicalPath = path => {
  try {
    if (path.includes("#") || path.startsWith(" ") || path.endsWith(" ")) return null;
    const at = path.indexOf("?");
    const parts = [];
    for (const raw of (at < 0 ? path : path.slice(0, at)).split("/").filter(Boolean)) {
      const part = decodedPart(raw);
      if (part === null || part.includes("/") || [".", ".."].includes(ascii(part))) return null;
      parts.push(encodeURIComponent(part).replace(/%(24|26|2B|2C|3B|3D|3A|40)/g, plainly));
    }
    const fields = [];
    for (const raw of at < 0 ? [] : path.slice(at + 1).split("&").filter(Boolean)) {
      // Its name and value, a "+" in them a space, as a query is read.
      const spaced = raw.replaceAll("+", " "), equals = spaced.indexOf("=");
      const halves = (equals < 0 ? [spaced] : [spaced.slice(0, equals), spaced.slice(equals + 1)]).map(decodedPart);
      if (halves.some(half => half === null || half.split("/").some(piece => ascii(piece) === ".."))) return null;
      fields.push(halves.map(half => encodeURIComponent(half).replace(/%(24|2C|3B|3A|40|2F|3F)/g, plainly).replaceAll("'", "%27")).join("="));
    }
    return parts.join("/") + (fields.length ? `?${fields.join("&")}` : "");
  } catch {
    // A lone surrogate, which can't be encoded.
    return null;
  }
};
// Percent-decoded once, or null when it doesn't decode or holds a backslash or a control character.
const decodedPart = raw => {
  let text;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /[\u0000-\u001f\u007f\\]/.test(text) ? null : text;
};
const ascii = text => text.replace(/[^\u0000-\u007f]/g, "");
// What's written as it is beyond what encodeURIComponent leaves (letters, digits, `-_.!~*'()`):
// between slashes `$&+,;=:@`, and in a query `$,;:@/?`, but not `'`, which URL parsers encode
// there. As the Mac writes them.
const plainly = (_, hex) => String.fromCharCode(parseInt(hex, 16));

// A paired phone is yours: the engine's whole API, as the app has it (sessions, files, terminals,
// commands, accounts and keys, settings, MCP servers). Only a path that isn't what it seems
// (`canonicalPath` refuses it) is refused. As the Mac allows them (KuvoLink's EngineRoutes.allows).
export const allowed = (path, method = "GET") => /^api(\/|\?|$)/.test(canonicalPath(path) ?? "");
export const socketAllowed = path => SOCKETS.some(pattern => pattern.test(canonicalPath(path) ?? ""));

// The same of the coding agents' bridge (`kuvo/agents/api/…`), but for the two routes only the
// app wires things with: where the engine is, and its group chats' own steps (moves), which a
// phone does through `kuvo/groups`. Checked on the path as it's sent, which the bridge reads part
// by part. As the Mac allows them (EngineRoutes.allowsAgents; both are checked against
// Vectors/link.json).
export const agentsAllowed = (path, method = "GET") => {
  const sent = canonicalPath(path) ?? "";
  return /^api(\/|\?|$)/.test(sent) && !/^api\/kuvo\/(engine|groups)(\/|\?|$)/.test(sent);
};

// Where a sign-in's page sent the browser back to this machine, for it to load
// (`kuvo/sign-in/return`), as the Mac's EngineRoutes.signInReturn: only its own address
// (127.0.0.1, localhost, [::1]) over http, at a port, with what the page sent back (a query),
// written plainly, in the characters an address may hold as it is (so it's loaded exactly as
// written). The address without its fragment, which a browser doesn't send; null otherwise.
const RETURN = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})(?:\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*)?\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})+)(?:#.*)?$/;
export const signInReturn = url => {
  if (typeof url !== "string" || Buffer.byteLength(url) > 8192 || !/^[!-~]*$/.test(url) || url.includes("\\")) return null;
  const match = url.match(RETURN);
  return match && Number(match[2]) <= 65535 ? match[1] : null;
};

const readEngineFile = () => JSON.parse(fs.readFileSync(ENGINE_FILE, "utf8"));
// The coding agents' bridge beside the engine, when it runs: its port and password.
const readBridgeFile = () => JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
const AGENTS = "kuvo/agents/";

// The block a prompt from a phone ends with, for the agent, in the Mac's words (FromPhone.swift):
// the user is on their iPhone, where a file is shown with show_file. Never shown.
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join("\n");

// A prompt's body with the agents its text names with "&" told at its end (`naming(text, session)`),
// as this box lists everyone now; any other body as it is.
async function namedIn(body, session, naming) {
  if (!naming) return body;
  let prompt;
  try { prompt = JSON.parse(Buffer.from(body ?? "").toString()); } catch { return body; }
  if (typeof prompt?.text !== "string" || !prompt.text.includes("&")) return body;
  const text = await naming(prompt.text, session).catch(() => prompt.text);
  return text === prompt.text ? body : Buffer.from(JSON.stringify({ ...prompt, text }));
}

// Who a message from a phone names with "&", for `forward`: everyone as this box lists them now,
// at once, and where it is; its own worked out again meanwhile, and waited for (two seconds at most)
// only when a name after "&" isn't there yet (one made a moment ago). One working out at a time.
let refreshingOwn = null;
const refreshOwnShared = readEngine => (refreshingOwn ??= refreshOwn(readEngine).catch(() => {}).finally(() => { refreshingOwn = null; }));
// That working out, done (what a test waits for before it removes its folders).
export const ownRefreshed = () => refreshingOwn ?? Promise.resolve();
// Everyone, as this box lists them now (`run/agents.json`), and its name there.
function listedAgents() {
  try {
    const read = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
    return { machine: read?.machine ?? null, agents: Array.isArray(read?.agents) ? read.agents : [] };
  } catch {
    return { machine: null, agents: [] };
  }
}
function namingHere(readEngine) {
  return async (text, session) => {
    let everyone = listedAgents();
    const working = refreshOwnShared(readEngine);
    if (nameMissing(text, everyone.agents)) {
      await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
      everyone = listedAgents();
    }
    return nameAgents(text, { excluding: session, here: everyone.machine, agents: everyone.agents });
  };
}

// Whether `text` names with "&" someone `agents` don't have: an "&" starting a word, with none of
// their names after it, whole ("&Miranda" isn't "&Mira").
// (Its characters as `namesIn` reads them: what's before an "&" is a whole character.)
function nameMissing(text, agents) {
  if (!text.includes("&")) return false;
  const references = agents.map(agent => ({ name: String(agent.name ?? ""), session: agent.session }));
  const named = new Set(namesIn(text, references).map(each => each.lower));
  const characters = graphemes(text);
  for (let i = 0; i < characters.length; i++) {
    const { segment, index } = characters[i];
    if (segment !== "&" || named.has(index)) continue;
    if (wordCharacter.test(characters[i - 1]?.segment ?? "")) continue;
    const next = characters[i + 1]?.segment;
    if (next && !/^\s/u.test(next)) return true;
  }
  return false;
}

// A prompt's body with the block at the end of its text, once; any other body as it is.
export function fromPhone(body) {
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || prompt.text.trimEnd().endsWith("</from-phone>")) return body;
  return Buffer.from(JSON.stringify({ ...prompt, text: `${prompt.text}\n\n${FROM_PHONE}` }));
}

// Passes `path` to the engine or the agents' bridge on this machine, with its password, and
// streams back what it answers. What's sent is the path as `canonicalPath` writes it, which is
// what `allows` checks.
async function* forward(target, path, request, signal, allows, naming = null, down = engineDown) {
  const method = request.method.toUpperCase();
  const sent = canonicalPath(path);
  if (sent === null || !allows(sent, method)) {
    yield { head: { status: 403, headers: { "content-type": "text/plain" } } };
    yield { body: Buffer.from("That isn't available over the link.") };
    return;
  }
  const url = new URL(`http://127.0.0.1:${target.port}/${sent}`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const given = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
  // A message the phone sends: who it names with "&" (`naming`), and that it's from the phone, go
  // with it.
  const prompt = method === "POST" && /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
  // A session's metadata changed: whether it was archived before, as the engine has it (null when
  // it can't say). A phone sends all of it with any change (a pin, say), the flag as it was too.
  const changed = method === "PATCH" && /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  let wasArchived = null;
  if (changed) {
    try {
      const before = await fetch(url, { headers, signal });
      if (before.ok) wasArchived = (await before.json())?.data?.metadata?.["kuvo.archived"] === true;
    } catch {}
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : prompt ? fromPhone(await namedIn(request.body, decodeURIComponent(prompt[1]), naming)) : request.body,
      signal,
    });
  } catch (error) {
    // Not answering (starting again, say): said so, unless the asker went.
    if (signal?.aborted) throw error;
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: down() })) };
    return;
  }
  const out = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out[name] = value;
  }
  // Archived or brought back (`kuvo.archived` in its metadata), here with the Mac closed too: its
  // wake-ups wait, or come back, as a Mac's Archive has it. Only when that changed.
  if (changed && response.ok) {
    let archived;
    try { archived = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"))?.metadata?.["kuvo.archived"]; } catch {}
    if (typeof archived === "boolean" && archived !== wasArchived) try { holdArchived(decodeURIComponent(changed[1]), archived); } catch {}
  }
  yield { head: { status: response.status, headers: out } };
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield { body: Buffer.from(value) };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// MARK: Integrations (PROTOCOL.md, "Integrations"), as the Mac's Settings › Integrations has them.

const INTEGRATIONS_FILE = path.join(K, "bin", "integrations.json");
// What integrations' servers keep (a sign-in), where the engine runs them with it (KUVO_INTEGRATIONS:
// this Mac's in the app's own folder, a machine's in `integrations`).
const INTEGRATION_DATA = process.env.KUVO_INTEGRATIONS || path.join(K, "integrations");
// Bots' own keys (`answerBotKeys`), the box's own beside its shared ones: a start from a Mac
// replaces what it sent in `keys`, and leaves `box` alone.
const BOT_KEYS = path.join(K, "box", "bot-keys");

// MARK: Where keys are kept (PROTOCOL.md, "Host interface"): integrations' keys by their variable's
// name (`KUVO_KEY_<ID>_<NAME>`, a bot's own `…__<BOT>`). A machine keeps them in files only you can
// read (its shared ones in `box/keys`, its bots' own in `box/bot-keys`); this Mac's box asks its
// app (where `run/host.json` says it answers), which keeps them in the Keychain and writes the files
// its engine reads them from. What else only the app can tell (its browser's sign-ins) it asks there too.

/** The only names the box ever asks for. */
const STORED_KEY = /^KUVO_KEY_[A-Z0-9_]+$/;

/** A key store's trouble, said in plain words: the caller answers `503 {"message"}` with it. */
class KeysUnavailable extends Error {}

// Where this Mac's app answers, as it writes it each time its host interface starts (`run/host.json`,
// `{"url", "password"}`, only you can read it): read again for each call, so an app whose host
// interface started again, at a new address, is reached without the box starting again. One started
// with it in its environment (`KUVO_HOST_URL`, `KUVO_HOST_PASSWORD`) uses that while there's no file,
// its password out of its environment at once, so nothing it runs (git, kuvo-wake) has it.
const HOST_FILE = path.join(RUN, "host.json");
const LAUNCH_HOST = process.env.KUVO_HOST_URL && process.env.KUVO_HOST_PASSWORD
  ? { url: process.env.KUVO_HOST_URL.replace(/\/+$/, ""), password: process.env.KUVO_HOST_PASSWORD } : null;
// A box whose keys its app keeps (this Mac's, KUVO_KEYS_ON_HOST), without a way to reach it: its
// keys can't be reached, rather than kept in files of its own instead of your Keychain.
const KEYS_ON_HOST = process.env.KUVO_KEYS_ON_HOST === "1" || Boolean(process.env.KUVO_HOST_URL);
delete process.env.KUVO_HOST_PASSWORD;

const NOT_ANSWERING = "Kuvo Code isn't answering for this Mac's keys. Try again in a moment.";

/** Where this Mac's app says it answers now, or null: none for a machine's box, nor while the app
 * isn't answering. `said` is what said so (the file's text), for the proof it gave. */
function appHost() {
  if (!KEYS_ON_HOST) return null;
  try {
    const text = fs.readFileSync(HOST_FILE, "utf8");
    const said = JSON.parse(text);
    if (typeof said?.url === "string" && said.url && typeof said?.password === "string" && said.password) {
      return { url: said.url.replace(/\/+$/, ""), password: said.password, said: text };
    }
  } catch {}
  return LAUNCH_HOST && { ...LAUNCH_HOST, said: "launch" };
}

/** What the app signs for `hello`: the nonce and where it was reached (`127.0.0.1:<port>`). */
function helloProof(password, nonce, url) {
  const reached = new URL(url);
  return crypto.createHmac("sha256", password).update(`kuvo-host-hello\0${nonce}\0${reached.hostname}:${reached.port || 80}`).digest("hex");
}

// What last proved it's this Mac's app (the host.json text it was found by): asked once for each.
let provenBy = null;

/** That it's this Mac's app at `host`, not whatever took its port after it (a host.json left by an
 * app that crashed): it signs a nonce of ours, with where we reached it, with the password (`hello`,
 * asked without the password, so nothing else can learn it there). Bound to where we reached it, a
 * proof relayed from the app at another port (by another user's process on this Mac) fails. Nothing
 * else is sent until it has. */
async function proveHost(host) {
  if (provenBy === host.said) return;
  const nonce = crypto.randomBytes(32).toString("hex");
  let proof = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(15_000),
    });
    const answer = await response.json().catch(() => null);
    if (response.ok && typeof answer?.proof === "string") proof = Buffer.from(answer.proof);
  } catch {}
  const expected = Buffer.from(helloProof(host.password, nonce, host.url));
  if (!proof || proof.length !== expected.length || !crypto.timingSafeEqual(proof, expected)) throw new KeysUnavailable(NOT_ANSWERING);
  provenBy = host.said;
}

/** The app that keeps this box's keys, or null for its files; this Mac's box without its app says so. */
function keyHost() {
  const host = appHost();
  if (KEYS_ON_HOST && !host) throw new KeysUnavailable(NOT_ANSWERING);
  return host;
}

// Key work, one change at a time: on this Mac each key is a round trip to the app, and two changes
// (a phone's and Edit Bot's, or a save during the refresh at start) would each write a bot's
// settings from the names they read before the other's.
let keyQueue = Promise.resolve();
function keyWork(work) {
  const run = keyQueue.then(work, work);
  keyQueue = run.catch(() => {});
  return run;
}

const checkedKeyName = name => {
  if (typeof name !== "string" || !STORED_KEY.test(name)) throw new KeysUnavailable("That isn't a key's name.");
  return name;
};

/** The file one is kept in on a machine: a bot's own beside the others, the shared ones in `box/keys`. */
const keyFile = name => path.join(checkedKeyName(name).includes("__") ? BOT_KEYS : BOX_KEYS, name);

/** What this Mac's box let go of (in its trash), moved on by its app to the Finder's Trash (`trash`);
 * nothing without its app. */
async function hostTrash(folder) {
  const host = appHost();
  if (!host) return;
  await proveHost(host);
  const response = await fetch(`${host.url}/trash`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
    body: JSON.stringify({ path: folder }),
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel().catch(() => {});
}

/** One of the app's host calls (`keys/names`, `sites/signed-in`…): its answer's JSON, or null for a 404 when `missing` is fine. */
async function askHost(host, call, body, missing = false) {
  await proveHost(host);
  let response;
  try {
    response = await fetch(`${host.url}/${call}`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      // Reading or saving one can wait on you (a Keychain prompt on this Mac): two minutes for those.
      signal: AbortSignal.timeout(["keys/get", "keys/set", "link/identity"].includes(call) ? 120_000 : 15_000),
    });
  } catch {
    // Gone from there: proved again before anything more is sent there.
    provenBy = null;
    throw new KeysUnavailable(NOT_ANSWERING);
  }
  if (missing && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let answer = null;
  try { answer = await response.json(); } catch {}
  if (response.status < 200 || response.status > 299) {
    const said = typeof answer?.message === "string" && answer.message.trim() ? ` ${oneLine(answer.message, 300)}` : "";
    throw new KeysUnavailable(`This Mac's keys couldn't be reached (${response.status}).${said}`);
  }
  return answer ?? {};
}

/** The names of the keys kept, those that begin with `prefix` and end with `suffix`, sorted. */
async function keyNames({ prefix = "", suffix = "" } = {}) {
  if (typeof prefix !== "string" || typeof suffix !== "string" || (prefix && !/^KUVO_KEY_[A-Z0-9_]*$/.test(prefix)) || (suffix && !/^[A-Z0-9_]+$/.test(suffix))) {
    throw new KeysUnavailable("That isn't a part of a key's name.");
  }
  const host = keyHost();
  let names;
  if (host) {
    const answer = await askHost(host, "keys/names", { ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) });
    // An answer without its list isn't "no keys" (a refresh would take every bot's servers away).
    if (!Array.isArray(answer.names)) throw new KeysUnavailable("This Mac's keys couldn't be read.");
    names = answer.names;
  } else {
    names = [...listOf(BOX_KEYS).filter(name => !name.includes("__")), ...listOf(BOT_KEYS).filter(name => name.includes("__"))];
  }
  return [...new Set(names.filter(name => typeof name === "string" && STORED_KEY.test(name) && name.startsWith(prefix) && name.endsWith(suffix)))].sort();
}

/** One key's value as it's kept; null for one there isn't. */
async function readKey(name) {
  checkedKeyName(name);
  const host = keyHost();
  if (!host) return textOf(keyFile(name));
  const answer = await askHost(host, "keys/get", { name }, true);
  return typeof answer?.value === "string" ? answer.value : null;
}

/** One key kept, in place of one there was. */
async function writeKey(name, value) {
  checkedKeyName(name);
  if (typeof value !== "string") throw new KeysUnavailable("A key is text.");
  const host = keyHost();
  if (host) return void await askHost(host, "keys/set", { name, value });
  // A shared one under the settings' lock, as a Mac making the machine's settings its own copies them.
  if (name.includes("__")) writePrivate(keyFile(name), value);
  else locked(CONFIG_LOCK, () => writePrivate(keyFile(name), value));
}

/** One key gone (nothing for one there wasn't). */
async function deleteKey(name) {
  checkedKeyName(name);
  const host = keyHost();
  if (host) return void await askHost(host, "keys/delete", { name });
  if (name.includes("__")) fs.rmSync(keyFile(name), { force: true });
  else locked(CONFIG_LOCK, () => fs.rmSync(keyFile(name), { force: true }));
}

/** Whether this Mac's browser is signed in to the sites the agent uses there, by integration, as its
 * app reads their cookies; null where that can't be told (a machine's box, or its app not answering). */
async function siteSignIns() {
  const host = appHost();
  if (!host) return null;
  try {
    const answer = await askHost(host, "sites/signed-in", {});
    return isObject(answer?.sites) ? answer.sites : null;
  } catch {
    return null;
  }
}

/** The integrations this box offers, from the catalog its Mac leaves in `bin` (this Mac's app, as it
 * starts its box): on a machine, not those that use a Mac's own apps. */
function integrationCatalog(file = INTEGRATIONS_FILE) {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")).integrations ?? []).filter(each => typeof each?.id === "string" && (IS_MAC || !each.macOnly)); } catch { return []; }
}

/** How it's doing here, as Settings › Integrations says it: `off`, turned off in MCP Servers, so it
 * won't start until it's turned on. Just turned on, while the engine still says it's off, it's
 * starting. A server that signs in by itself with a code the first time it's used (Outlook's,
 * `signInFile` in the catalog) waits for that code until its sign-in is there. */
function integrationHealth(entry, server, off, signedIn) {
  if (off) return "disabled";
  let health = { connected: "connected", needs_auth: "needsSignIn", failed: "failed" }[server?.status?.status] ?? "starting";
  if (health === "connected" && server?.integrationID && !signedIn.has(server.integrationID) && ["official", "app"].includes(entry.way)) health = "needsSignIn";
  if (health === "connected" && typeof entry.signInFile === "string" && !fs.existsSync(path.join(INTEGRATION_DATA, entry.id, path.basename(entry.signInFile)))) health = "waitsForCode";
  return health;
}

/** Each as `kuvo/integrations` lists it, from the catalog, with how it's doing on this machine. */
/** Each as `kuvo/integrations` lists it, and whether its engine couldn't say how they're doing
 * (`engineDown`: not running, or not answering), when an added one's `health` is left out. */
async function integrationEntries(catalog, engine, signal) {
  const { settings } = readSettings();
  let servers = null;
  let signedIn = new Set();
  if (engine) {
    servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => null);
    const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
    signedIn = new Set((Array.isArray(credentials) ? credentials : []).filter(each => each?.active && each?.value?.type === "oauth").map(each => each.integrationID));
  }
  const engineDown = !Array.isArray(servers);
  // Which keys it keeps, by name, never reading one (left unsaid where they can't be reached now).
  let names = null;
  try {
    names = await keyNames();
  } catch (error) {
    if (!(error instanceof KeysUnavailable)) throw error;
  }
  const sites = catalog.some(entry => entry.way === "browser") ? await siteSignIns() : null;
  const entries = catalog.map(({ settings: _, variables, signInFile, ...entry }) => {
    const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
    const shown = { ...entry, added };
    if (variables && names) shown.keysSaved = Object.values(variables).every(name => names.includes(name));
    if (entry.way === "browser" && typeof sites?.[entry.id] === "boolean") shown.siteSignedIn = sites[entry.id];
    if (added) {
      const off = valueAt(settings ?? {}, [...SERVERS, entry.id, "disabled"]) === true;
      const server = (servers ?? []).find(each => each?.name === entry.id);
      // Without its engine, only one turned off can be told: it won't start whatever the engine says.
      if (!engineDown || off) shown.health = integrationHealth({ ...entry, signInFile }, server, off, signedIn);
      if (server?.integrationID) shown.signIn = server.integrationID;
    }
    return shown;
  });
  return { entries, engineDown };
}

/** Its bots' own keys for it (`KUVO_KEY_<ID>_<NAME>__<BOT>`) and their folders' settings naming its server, gone. */
function dropBotsIntegration(entry) {
  return keyWork(() => droppingBotsIntegration(entry));
}

async function droppingBotsIntegration(entry) {
  const own = Object.values(entry.variables ?? {}).filter(variable => STORED_KEY.test(variable));
  // Their settings first, so none names a key that's gone if one can't be taken away.
  const named = [];
  for (const variable of own) named.push(...await keyNames({ prefix: `${variable}__` }));
  for (const bot of listOf(BOTS)) {
    const folder = path.join(BOTS, bot, "workspace", ".opencode");
    const file = path.join(folder, "opencode.json");
    let settings;
    try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    // Only its server as the bot's own keys made it, as the Mac's BotKeys has it: one written
    // there by hand stays.
    const server = settings?.mcp?.servers?.[entry.id];
    if (!server || !own.some(variable => JSON.stringify(server).includes(`${variable}__`))) continue;
    delete settings.mcp.servers[entry.id];
    if (!Object.keys(settings.mcp.servers).length) delete settings.mcp.servers;
    if (!Object.keys(settings.mcp).length) delete settings.mcp;
    if (Object.keys(settings).length) writePrivate(file, JSON.stringify(settings));
    else {
      fs.rmSync(file, { force: true });
      try { fs.rmdirSync(folder); } catch {}
    }
  }
  for (const name of named) await deleteKey(name);
}

/** Whether this box keeps every one of `variables`. */
async function keepsAll(variables) {
  const kept = await keyNames();
  return variables.every(variable => kept.includes(variable));
}

/** Runs `run` in `ms`, without keeping the bridge up for it. */
const soon = (run, ms) => setTimeout(run, ms).unref?.();

// Set by `box route`, a command that answers once and ends: what waits a moment goes in a process
// of its own, which outlives it.
let answersOnce = false;

/** Its server connected again a moment after its keys changed, once the engine has read them. */
function reconnectLater(engine, id, later) {
  if (!engine) return;
  if (answersOnce && later === soon) {
    spawn(process.execPath, [fileURLToPath(import.meta.url), "box", "reconnect", id], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
    return;
  }
  later(() => reconnectEverywhere(engine, id), 2_000);
}

/** An MCP server connected again everywhere its engine runs a copy: its own, and each folder it
 * has open (`api/debug/location`), as sessions and bots there each have theirs. */
export async function reconnectEverywhere(engine, id) {
  const connect = `/api/experimental/mcp/${encodeURIComponent(id)}/connect`;
  await call(engine, "POST", connect).catch(() => {});
  const open = await call(engine, "GET", "/api/debug/location").catch(() => []);
  const folders = new Set((Array.isArray(open) ? open : []).map(each => each?.directory).filter(folder => typeof folder === "string" && folder));
  for (const folder of folders) await call(engine, "POST", connect, undefined, undefined, folder).catch(() => {});
}

/** `kuvo/integrations…`, for this box's own, its keys where it keeps them (a machine's files, this
 * Mac's Keychain through its app). `later` runs what waits a moment (a test's own). */
export async function answerIntegrations(method, requestPath, body, engine, signal, file = INTEGRATIONS_FILE, later = soon) {
  try {
    return await integrationsAnswer(method, requestPath, body, engine, signal, file, later);
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

async function integrationsAnswer(method, requestPath, body, engine, signal, file, later) {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return ""; } });
  const catalog = integrationCatalog(file);
  if (parts.length === 2) {
    if (method !== "GET") return { status: 405, value: {} };
    const { problem } = readSettings();
    const { entries, engineDown } = await integrationEntries(catalog, engine, signal);
    return { status: 200, value: { integrations: entries, ...(engineDown ? { engineDown } : {}), ...(problem ? { problem } : {}) } };
  }
  const entry = parts.length === 3 ? catalog.find(each => each.id === parts[2]) : null;
  if (!entry) return { status: 404, value: {} };
  const { settings, problem } = readSettings();
  if (problem) return { status: 409, value: { message: `The engine's settings file can't be changed from here: ${problem}` } };
  const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
  if (method === "POST") {
    if (entry.way === "browser" || !entry.settings) return { status: 409, value: { message: `The agent uses ${entry.title} on its site: sign in to it in the browser on ${IS_MAC ? "this Mac" : "this machine"}.` } };
    const variables = entry.variables ?? {};
    const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
    const names = Object.keys(variables);
    if (!Object.values(variables).every(variable => typeof variable === "string" && STORED_KEY.test(variable))) {
      return { status: 409, value: { message: `${entry.title} can't be added here: its keys aren't named as Kuvo Code names them.` } };
    }
    let newKeys = false;
    if (names.length) {
      if (names.every(name => typeof given[name] === "string" && given[name].trim())) {
        // All of them, one change at a time with any other key work here.
        await keyWork(async () => {
          for (const name of names) await writeKey(variables[name], given[name].trim());
        });
        newKeys = true;
      } else if (!(await keepsAll(names.map(name => variables[name])))) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ");
        return { status: 400, value: { message: `${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.` } };
      }
    }
    // One there already is written again as it is (the engine reads its keys again).
    const value = added ? valueAt(settings, [...SERVERS, entry.id]) : entry.settings;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    // The engine reads its keys as it reads its settings again: its server connects again a
    // moment later, with the new ones, in every folder the engine has open.
    if (newKeys) reconnectLater(engine, entry.id, later);
    const { entries: [listed] } = await integrationEntries([entry], engine, signal);
    return { status: 200, value: { integration: listed } };
  }
  if (method === "DELETE") {
    if (!added) {
      // Its keys, left by a Remove that couldn't take them away: they go now. Nothing left, 404.
      const own = Object.values(entry.variables ?? {}).filter(variable => STORED_KEY.test(variable));
      const kept = own.length ? (await keyNames()).filter(name => own.includes(name)) : [];
      if (!kept.length) return { status: 404, value: {} };
      await keyWork(async () => {
        for (const name of kept) await deleteKey(name);
      });
      return { status: 200, value: {} };
    }
    // Bots here with keys of their own for it stop using it first: where their keys can't be taken
    // away, nothing goes, rather than leave a bot using an integration you removed.
    try {
      await dropBotsIntegration(entry);
    } catch (error) {
      if (!(error instanceof KeysUnavailable)) throw error;
      return { status: 503, value: { message: `${entry.title} wasn't removed: its bots' own keys for it couldn't be taken away. ${error.message}` } };
    }
    // Its sign-in as the engine has it, asked before it leaves the settings.
    let signIn;
    if (engine) signIn = (await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => [])).find?.(each => each?.name === entry.id)?.integrationID;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value: null }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    if (engine && signIn) {
      const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
      for (const each of Array.isArray(credentials) ? credentials : []) {
        if (each?.integrationID === signIn) await call(engine, "DELETE", `/api/credential/${encodeURIComponent(each.id)}`, undefined, signal).catch(() => {});
      }
    }
    // What its server kept: its own folder (and the file it once kept).
    for (const name of [entry.id, `${entry.id}.json`]) fs.rmSync(path.join(INTEGRATION_DATA, name), { recursive: true, force: true });
    try {
      await keyWork(async () => {
        for (const variable of Object.values(entry.variables ?? {})) if (STORED_KEY.test(variable)) await deleteKey(variable);
      });
    } catch (error) {
      if (!(error instanceof KeysUnavailable)) throw error;
      return { status: 503, value: { message: `${entry.title} is removed, but its key is still kept. ${error.message}` } };
    }
    return { status: 200, value: {} };
  }
  return { status: 405, value: {} };
}

// MARK: Bots' own keys (PROTOCOL.md, "Bots' own keys"): keys a bot here has of its own for the
// integrations you bring a key for, kept where this box keeps its keys (`<variable>__<BOT>`: a
// machine's in `box/bot-keys`, this Mac's in its Keychain, through the app) and named by a settings
// file of its folder's own, so only its conversation uses them. A bot that works in a project uses
// that project's.

/** A bot's own variable for one of an integration's, as the Mac's IntegrationKeys names it. */
export const botVariable = (variable, bot) => `${variable}__${String(bot).toUpperCase().replace(/[^\p{L}\p{N}]/gu, "_")}`;

/** Where the engine reads a bot's own keys, as its settings name the folder: this Mac's app's
 * (`KUVO_KEYS`, where it keeps each key in a file named by its variable), or a machine's
 * `box/bot-keys`. */
const BOT_KEY_FOLDER = process.env.KUVO_KEYS ? process.env.KUVO_KEYS.replace(/\/+$/, "") : null;
const botKeyFolder = () => BOT_KEY_FOLDER ?? `${shownRoot}/box/bot-keys`;

/** The integrations a bot can have keys of its own for: those you bring a key for. */
const botKeyed = catalog => catalog.filter(entry => ["token", "package"].includes(entry.way) && entry.settings && Object.keys(entry.variables ?? {}).length
  && Object.values(entry.variables).every(variable => typeof variable === "string" && STORED_KEY.test(variable)));

/** Whether `bot` has every key of its own for `entry`, among the keys kept (`names`). */
const hasOwnKeys = (bot, entry, names) => Object.values(entry.variables).every(variable => names.includes(botVariable(variable, bot)));

/** `entry`'s server as `bot`'s conversation runs it: each of its keys (`{file:<a folder>/<variable>}`)
 * the bot's own in its place (`{file:<bot keys' folder>/<variable>__<BOT>}`). */
function botServer(entry, bot) {
  const folder = botKeyFolder();
  const swapped = value => {
    if (typeof value === "string") {
      return Object.values(entry.variables).reduce((text, variable) =>
        text.replace(new RegExp(`\\{file:[^{}]*/${variable}\\}`, "g"), () => `{file:${folder}/${botVariable(variable, bot)}}`), value);
    }
    if (Array.isArray(value)) return value.map(swapped);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swapped(inner)]));
    return value;
  };
  return swapped(entry.settings);
}

/** Its folder's settings as they are, and where; `problem` when they aren't plain JSON (left alone). */
function botSettings(bot) {
  const folder = path.join(BOTS, bot, "workspace", ".opencode");
  const file = path.join(folder, "opencode.json");
  const text = textOf(file);
  if (text === null || !text.trim()) return { folder, file, settings: {} };
  let settings;
  try { settings = JSON.parse(text); } catch {}
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(settings) || (settings.mcp !== undefined && !isObject(settings.mcp)) || (settings.mcp?.servers !== undefined && !isObject(settings.mcp.servers))) {
    return { folder, file, problem: "Its folder's settings aren't plain JSON, so its own keys can't be named there." };
  }
  return { folder, file, settings };
}

/** Its folder's settings naming a server for each integration it has its own keys for (among the
 * keys kept, `names`), and no longer one for those it had them for; the rest of the file as it was
 * (the Mac's BotKeys.change). */
function writeBotSettings(bot, catalog, names) {
  const { folder, file, settings: old, problem } = botSettings(bot);
  if (problem) return { status: 409, message: problem };
  const suffix = botVariable("", bot);
  const usesOwn = server => (JSON.stringify(server).match(/KUVO_KEY_[A-Z0-9_]+/g) ?? []).some(name => name.endsWith(suffix));
  const servers = Object.fromEntries(Object.entries(old.mcp?.servers ?? {}).filter(([, server]) => !usesOwn(server)));
  for (const entry of botKeyed(catalog)) if (hasOwnKeys(bot, entry, names)) servers[entry.id] = botServer(entry, bot);
  const mcp = { ...(old.mcp ?? {}) };
  if (Object.keys(servers).length) mcp.servers = servers;
  else delete mcp.servers;
  const next = { ...old };
  if (Object.keys(mcp).length) next.mcp = mcp;
  else delete next.mcp;
  if (JSON.stringify(next) === JSON.stringify(old)) return { status: 200 };
  if (Object.keys(next).length) {
    writePrivate(file, JSON.stringify(next, null, 2) + "\n");
  } else {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(folder); } catch {}
  }
  return { status: 200 };
}

/** Each bot here: its folder's settings as its keys and this box's integrations are now (a
 * server's newer version, say, or settings that came with it from another computer naming its
 * keys there). As the box starts, and from a client (`POST kuvo/bots/keys/refresh`). */
export function refreshBotsKeys(file = INTEGRATIONS_FILE) {
  return keyWork(() => refreshingBotsKeys(file));
}

async function refreshingBotsKeys(file) {
  const bots = listOf(BOTS).filter(bot => {
    const here = botHere(bot);
    return here && !here.described.project;
  });
  if (!bots.length) return;
  const catalog = integrationCatalog(file);
  const names = await keyNames();
  for (const bot of bots) writeBotSettings(bot, catalog, names);
}

/** Its server, connected again in the bot's folder a moment later, with the keys it has now. */
function reconnectForBot(engine, id, bot, later) {
  if (!engine?.port) return;
  const folder = path.join(BOTS, bot, "workspace");
  later(() => fetch(`http://127.0.0.1:${engine.port}/api/experimental/mcp/${encodeURIComponent(id)}/connect`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) },
  }).catch(() => {}), 2_000);
}

/** `kuvo/bots/<id>/keys…`, for a bot that lives on this box. `later` runs what waits a moment (a
 * test's own). Where its keys are kept can't be reached (this Mac's app not answering): `503 {"message"}`. */
export async function answerBotKeys(method, requestPath, body, engine, file = INTEGRATIONS_FILE, later = soon) {
  try {
    return await keyWork(() => botKeysAnswer(method, requestPath, body, engine, file, later));
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

async function botKeysAnswer(method, requestPath, body, engine, file, later) {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  const message = text => ({ message: text });
  const bot = parts[2];
  const here = botHere(bot);
  if (!here) return { status: 404, value: message("That bot isn’t on this computer.") };
  if (here.described.project) return { status: 409, value: message(`${here.described.name} works in a project, so it uses the keys that project's sessions use.`) };
  const catalog = integrationCatalog(file);
  const keyed = botKeyed(catalog);
  // Which keys are kept, by name: whether it has its own, and whether the box has shared ones, never
  // reading a key to say so.
  const names = await keyNames();
  const shared = entry => Object.values(entry.variables).every(variable => names.includes(variable));
  const without = gone => names.filter(name => !gone.includes(name));
  if (parts.length === 4) {
    // Each with what Edit Bot shows of it: its name, symbol, the keys it takes and where to get them.
    if (method === "GET") return { status: 200, value: { keys: keyed.map(entry => ({ integration: entry.id, own: hasOwnKeys(bot, entry, names), shared: shared(entry),
      title: entry.title, symbol: entry.symbol, keys: (entry.keys ?? []).map(({ name, label, prompt }) => ({ name, label, prompt })), ...(entry.help ? { help: entry.help } : {}) })) } };
    if (method !== "DELETE") return { status: 405, value: {} };
    // All of them, as it leaves this box: what it moved with goes with it, and any left from
    // integrations no longer here.
    const had = keyed.filter(entry => hasOwnKeys(bot, entry, names));
    const own = names.filter(name => name.endsWith(botVariable("", bot)));
    // Its settings without them first, so none names a key that's gone if one can't be taken away.
    const written = writeBotSettings(bot, catalog, without(own));
    for (const name of own) await deleteKey(name);
    for (const entry of had) reconnectForBot(engine, entry.id, bot, later);
    return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
  }
  if (parts.length !== 5) return { status: 404, value: {} };
  const entry = keyed.find(each => each.id === parts[4]);
  if (!entry) return { status: 404, value: message("A bot can't have a key of its own for that here.") };
  const fields = Object.keys(entry.variables);
  const variableOf = name => botVariable(entry.variables[name], bot);
  switch (method) {
    case "GET": {
      if (!hasOwnKeys(bot, entry, names)) return { status: 404, value: {} };
      const keys = {};
      for (const name of fields) keys[name] = (await readKey(variableOf(name))) ?? "";
      return { status: 200, value: { keys } };
    }
    case "PUT": {
      const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
      if (!fields.every(name => typeof given[name] === "string" && given[name].trim())) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ") || fields.join(" and ");
        return { status: 400, value: message(`${entry.title} needs ${labels}: send them as {"keys": {"${fields[0]}": …}}.`) };
      }
      // Its folder's settings are checked first: none are written where they can't be named.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      for (const name of fields) await writeKey(variableOf(name), given[name].trim());
      writeBotSettings(bot, catalog, [...names, ...fields.map(variableOf)]);
      reconnectForBot(engine, entry.id, bot, later);
      return { status: 200, value: { integration: entry.id, own: true, shared: shared(entry) } };
    }
    case "DELETE": {
      if (!hasOwnKeys(bot, entry, names)) return { status: 404, value: {} };
      // Its folder's settings are checked first: its key stays while they can't say it's gone.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      const own = fields.map(variableOf);
      const written = writeBotSettings(bot, catalog, without(own));
      for (const name of own) await deleteKey(name);
      reconnectForBot(engine, entry.id, bot, later);
      return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
    }
    default:
      return { status: 405, value: {} };
  }
}

// MARK: Worktrees (PROTOCOL.md, "Worktrees"): the git worktrees sessions here run in, each on a
// branch of its own, kept by this box (`box/worktrees.json`): made, named after their session,
// listed and removed here, from a Mac (through `box route`) or a phone, with the Mac closed too.

const WORKTREES_FILE = path.join(K, "box", "worktrees.json");
// The branch prefix a client last gave (Settings › Git's), for one that doesn't give one.
const BRANCH_PREFIX_FILE = path.join(K, "box", "git.json");
const branchPrefix = () => {
  try {
    const kept = JSON.parse(fs.readFileSync(BRANCH_PREFIX_FILE, "utf8")).branchPrefix;
    return typeof kept === "string" ? kept : "kuvo/";
  } catch {
    return "kuvo/";
  }
};
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** git in `folder`: what it printed (trimmed), or null when it failed. */
function gitIn(folder, args) {
  const ran = spawnSync("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60_000 });
  return ran.status === 0 ? String(ran.stdout ?? "").trim() : null;
}

/** The same without holding up the bridge, for what takes a while in a big worktree. */
function gitLater(folder, args) {
  return new Promise(resolve => {
    execFile("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout ?? "").trim()));
  });
}

/** The room `folder` takes, in bytes; undefined when `du` can't say. */
function sizeLater(folder) {
  return new Promise(resolve => {
    execFile("du", ["-sk", folder], { encoding: "utf8", timeout: 60_000 }, (error, stdout) => {
      const kilobytes = Number(String(stdout ?? "").split(/\s/)[0]);
      resolve(!error && Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined);
    });
  });
}

// ---- Projects: the box's own list (PROTOCOL.md, "Projects") ----

const PROJECTS_FILE = path.join(K, "box", "projects.json");
const PROJECTS_LOCK = PROJECTS_FILE + ".lock";

/** The box's projects: `{directory, name?, folders, run?, terminal?, removed?}` each. One removed
 * (Remove Project) keeps its settings, for when one of its sessions is brought back. */
export function readProjects(file = PROJECTS_FILE) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8")).projects;
    return Array.isArray(list) ? list.filter(each => typeof each?.directory === "string" && path.isAbsolute(each.directory)).map(each => ({ ...each, folders: Array.isArray(each.folders) ? each.folders.filter(folder => typeof folder === "string") : [] })) : [];
  } catch {
    return [];
  }
}

/** The projects New Bot offers here, `{directory, name}` each: the box's own, once it keeps them;
 * before, those its Mac named in the kit. */
export function boxProjects(kit, file = PROJECTS_FILE) {
  if (!fs.existsSync(file)) return kit?.projects ?? [];
  return readProjects(file).filter(each => !each.removed).map(each => ({ directory: each.directory, name: each.name ?? path.basename(each.directory) }));
}

/** The list as `change` makes it, read again just before, under its lock. */
export function changeProjects(change, file = PROJECTS_FILE, lock = PROJECTS_LOCK) {
  const projects = locked(lock, () => {
    const projects = change(readProjects(file));
    writePrivate(file, JSON.stringify({ version: 1, projects }, null, 2));
    return projects;
  });
  for (const tell of projectFollowers) tell();
  return projects;
}

/** A project as it's kept: its name only when it's not the folder's, a command only when there
 * is one, its other folders without its own. */
function keptProject(directory, given, before = {}) {
  const project = { ...before, directory, folders: before.folders ?? [] };
  // Brought back, unless it's sent as removed (a client's copy of one, with its settings).
  if (given.removed === true) project.removed = true;
  else delete project.removed;
  const text = value => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  if ("name" in given) project.name = text(given.name) === path.basename(directory) ? undefined : text(given.name);
  if ("folders" in given) project.folders = [...new Set((Array.isArray(given.folders) ? given.folders : []).filter(folder => typeof folder === "string" && path.isAbsolute(folder) && folder !== directory))];
  if ("run" in given) project.run = text(given.run);
  if ("terminal" in given) project.terminal = text(given.terminal);
  for (const key of ["name", "run", "terminal"]) if (project[key] === undefined) delete project[key];
  return project;
}

/** Every session of the project, its worktrees' too, archived, on the engine and the coding
 * agents' bridge, page after page; how many weren't. */
async function archiveProject(directory, readEngine, readBridge, signal) {
  const folders = [directory, ...readWorktrees().filter(tree => tree.project === directory && typeof tree.folder === "string").map(tree => tree.folder)];
  const targets = [];
  try { targets.push(readEngine()); } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  if (!targets.length) return { archived: 0, kept: null };
  let archived = 0, kept = 0;
  for (const target of targets) {
    for (const folder of folders) {
      let query = `limit=100&order=desc&parentID=null&directory=${encodeURIComponent(folder)}`;
      for (let page = 0; page < 1000 && query; page++) {
        // The page whole (`call` keeps only its data), for its cursor.
        let listed;
        try {
          const response = await fetch(`http://127.0.0.1:${target.port}/api/session?${query}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal });
          if (!response.ok) throw new Error();
          listed = await response.json();
        } catch {
          kept += 1;
          break;
        }
        const sessions = Array.isArray(listed?.data) ? listed.data : [];
        for (const session of sessions) {
          if (session?.location?.directory !== folder || session.time?.archived || session.metadata?.["kuvo.archived"] === true) continue;
          try {
            await call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { ...(session.metadata ?? {}), "kuvo.archived": true } }, signal);
            holdArchived(session.id, true);
            archived += 1;
          } catch {
            kept += 1;
          }
        }
        const next = listed?.cursor?.next;
        query = sessions.length === 100 && next ? `limit=100&cursor=${encodeURIComponent(next)}` : null;
      }
    }
  }
  return { archived, kept };
}

/** `kuvo/projects`: the box's projects, read and changed by any client, as Settings and the
 * sidebar change them on a Mac. A folder is kept as the client names it. */
export async function* answerProjects(request, readEngine = readEngineFile, readBridge = readBridgeFile, signal, file = PROJECTS_FILE, lock = PROJECTS_LOCK) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const [route, query = ""] = request.path.split("?");
  const method = request.method.toUpperCase();
  const listed = () => ({ projects: readProjects(file) });
  if (route === "kuvo/projects/events") {
    if (method !== "GET") return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(listed, projectFollowers, signal);
  }
  if (route !== "kuvo/projects") return yield* json(404, {});
  if (method === "GET") return yield* json(200, listed());
  const given = new URLSearchParams(query).get("directory");
  if (!given || !path.isAbsolute(given)) return yield* json(400, { message: "Say which folder (directory)." });
  if (method === "PUT") {
    const body = parsed(request.body) ?? {};
    if (!isObject(body)) return yield* json(400, { message: "That isn’t a project." });
    // Kept as it's named: its sessions run there, by that name (a link followed would be another
    // project), and one whose drive isn't there now stays.
    let project;
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      project = keptProject(given, body, before);
      return before ? projects.map(each => (each === before ? project : each)) : [project, ...projects];
    }, file, lock);
    return yield* json(200, { project });
  }
  if (method === "DELETE") {
    const { archived, kept } = await archiveProject(given, readEngine, readBridge, signal);
    if (kept === null) return yield* json(503, { message: "Its sessions can’t be reached: the engine isn’t running." });
    if (kept > 0) return yield* json(409, { message: `${kept === 1 ? "One of its sessions" : `${kept} of its sessions`} couldn’t be archived, so it stays with them. Try again in a moment.`, archived, kept });
    changeProjects(projects => {
      const before = projects.find(each => each.directory === given);
      return before ? projects.map(each => (each === before ? { ...each, removed: true } : each)) : projects;
    }, file, lock);
    return yield* json(200, { archived });
  }
  return yield* json(405, {});
}

/** The worktrees this box keeps: `{project, root, folder, branch, base?}` each (`folder`: where
 * its session runs, the project's place in its repository; one made here also has `made`, the
 * branch it was made on, and `prefix`, what its name starts with). */
export function readWorktrees() {
  try {
    const list = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).worktrees;
    return Array.isArray(list) ? list.filter(each => typeof each?.root === "string" && typeof each?.project === "string" && typeof each?.branch === "string") : [];
  } catch {
    return [];
  }
}

/** Worktrees removed here: the project each was of, by the folder its sessions ran in, so a
 * conversation that ran in one is still named after its project, as the Mac names it. */
export function readRemovedWorktrees() {
  try {
    const removed = JSON.parse(fs.readFileSync(WORKTREES_FILE, "utf8")).removed;
    return isObject(removed) ? Object.fromEntries(Object.entries(removed).filter(([, project]) => typeof project === "string")) : {};
  } catch {
    return {};
  }
}

/** The list as `change` makes it, read again just before: a phone's request and a Mac's run
 * beside each other, each in a process of its own. `gone`: a worktree removed, kept in `removed`
 * (the latest 200). */
function updateWorktrees(change, gone) {
  let removed = readRemovedWorktrees();
  if (gone) removed = Object.fromEntries([...Object.entries(removed).filter(([folder]) => folder !== (gone.folder ?? gone.root)), [gone.folder ?? gone.root, gone.project]].slice(-200));
  writePrivate(WORKTREES_FILE, JSON.stringify({ worktrees: change(readWorktrees()), removed }, null, 2));
  for (const tell of worktreeFollowers) tell();
}

// Those following this box's worktrees (`kuvo/worktrees/events`), told of each change made here.
const worktreeFollowers = new Set();
// Those following its projects (`kuvo/projects/events`).
const projectFollowers = new Set();

/** `folders` watched, with what's in them (`recursive`) or only their own files, for `changed`:
 * whether the system tells of every change (a watch it can't keep goes, and so does that), and how
 * to stop. */
function watchFolders(folders, changed, { recursive = true } = {}) {
  let whole = folders.length > 0;
  const watchers = [];
  for (const folder of folders) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      const watcher = fs.watch(folder, { recursive }, changed);
      watcher.on("error", () => {
        whole = false;
        watcher.close();
      });
      watchers.push(watcher);
    } catch {
      whole = false;
    }
  }
  return { get whole() { return whole; }, close: () => { for (const watcher of watchers) watcher.close(); } };
}

/** What `read` says, a line now and one for each change after, in order: each change this process
 * makes as it's made (`followers` are told), and what another made, looked for each second; or,
 * given `folders` to watch, as the system says they change, looked for again every half minute
 * only for a change it missed. A watch starts a moment after it's asked for (a change in that
 * moment isn't told), so it's looked at once more just after. `watch`: the system's (a test's own). */
export async function* followed(read, followers, signal, { folders = [], recursive = true, watch = watchFolders } = {}) {
  let wake = null;
  const queue = [];
  const told = () => {
    queue.push(JSON.stringify(read()));
    wake?.();
  };
  followers.add(told);
  const watching = watch(folders, told, { recursive });
  queue.push(JSON.stringify(read()));
  // (Later still under load: looked at again a little later, then a little later again; what
  // didn't change isn't sent twice.)
  const settled = WATCH_SETTLES.map(ms => setTimeout(told, ms));
  // Its client gone: it stops now, not at the next look.
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  try {
    let last = "";
    while (!signal?.aborted) {
      while (queue.length) {
        const line = queue.shift();
        if (line !== last) {
          yield { body: Buffer.from(line + "\n") };
          last = line;
        }
      }
      if (signal?.aborted) break;
      await new Promise(done => {
        // Its look-again timer goes once it's woken, so a client gone leaves nothing waiting.
        const timer = setTimeout(done, watching.whole ? 30_000 : 1000);
        wake = () => { clearTimeout(timer); done(); };
      });
      wake = null;
      queue.push(JSON.stringify(read()));
    }
  } finally {
    for (const timer of settled) clearTimeout(timer);
    followers.delete(told);
    watching.close();
  }
}

// When a watch on folders may have started telling changes: looked at again then.
const WATCH_SETTLES = [250, 1000, 5000];

/** `name`, or `name-2` and so on when that's a branch already, as the Mac's Git.newBranch picks. */
function freeBranch(folder, name) {
  for (let suffix = 1; suffix <= 20; suffix++) {
    const candidate = suffix === 1 ? name : `${name}-${suffix}`;
    if (gitIn(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) === null) return candidate;
  }
  return null;
}

// Cyrillic and Greek letters in Latin ones, as ICU writes them without their marks: "Исправить
// вход" is ispravit-vhod, "Διόρθωση σύνδεσης" diorthose-syndeses.
const LATIN = Object.fromEntries([
  ...[..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ"].map((letter, at) =>
    [letter, ["a", "b", "v", "g", "d", "e", "e", "z", "z", "i", "j", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "c", "c", "s", "s", "", "y", "", "e", "u", "a", "i", "i", "e", "g"][at]]),
  ...[..."αβγδεζηθικλμνξοπρσςτυφχψω"].map((letter, at) =>
    [letter, ["a", "b", "g", "d", "e", "z", "e", "th", "i", "k", "l", "m", "n", "x", "o", "p", "r", "s", "s", "t", "y", "ph", "ch", "ps", "o"][at]]),
]);
const inLatin = text => [...text].map(letter => LATIN[letter] ?? letter).join("");

/** A branch name made from a title, in Latin letters without their marks: "Trim note titles" is
 * trim-note-titles, "Giriş düzeltmesi" giris-duzeltmesi, "Исправить вход" ispravit-vhod. A title
 * in other letters (Chinese, Arabic) names none: its branch keeps the name it was made with. */
export function branchSlug(title, limit = 40) {
  // Whole letters first (й is j, not i), then those that came apart from their marks (ό).
  const latin = inLatin(inLatin(String(title).toLowerCase()).normalize("NFKD")).replace(/\p{M}/gu, "").replace(/ı/g, "i");
  let name = "";
  for (const word of latin.split(/[^\p{L}\p{N}]+/u)) {
    const ascii = [...word].filter(character => character.charCodeAt(0) < 128).join("");
    if (!ascii) continue;
    const next = name ? `${name}-${ascii}` : ascii;
    if (next.length > limit) break;
    name = next;
  }
  return name;
}

/** Its engine's project for a folder, as it names projects. */
async function projectOf(engine, folder, signal) {
  const located = await call(engine, "GET", "/api/location", undefined, signal, folder);
  const id = located?.project?.id;
  if (typeof id !== "string") throw new Error("The engine didn't say which project that is.");
  return id;
}

/** Sessions by the folder they run in, and which are at work, as its engine has them; none when it can't say. */
async function sessionsHere(engine, signal) {
  if (!engine?.port) return { sessions: [], active: new Set() };
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
  try {
    const listed = await fetch(`http://127.0.0.1:${engine.port}/api/session?parentID=null&limit=200&order=desc`, { headers, signal: AbortSignal.timeout(10_000) });
    const sessions = listed.ok ? (await listed.json())?.data ?? [] : [];
    const busy = await fetch(`http://127.0.0.1:${engine.port}/api/session/active`, { headers, signal: AbortSignal.timeout(10_000) });
    const active = new Set(Object.keys(busy.ok ? (await busy.json())?.data ?? {} : {}));
    return { sessions, active };
  } catch {
    return { sessions: [], active: new Set() };
  }
}

const inside = (folder, root) => folder === root || folder?.startsWith(root + "/");

/** `tree`'s branch named `to` (or `to-2` and so on), unless it's been pushed: whether it was. */
function renameWorktree(tree, to) {
  if (gitIn(tree.root, ["rev-parse", "--abbrev-ref", `${tree.branch}@{upstream}`]) !== null) return false;
  const name = freeBranch(tree.root, to);
  if (!name || gitIn(tree.root, ["branch", "-m", tree.branch, name]) === null) {
    // Renamed meanwhile (by this box's other process, named as it was read): kept as git has it.
    const now = gitIn(tree.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (now && now !== tree.branch) updateWorktrees(list => list.map(each => (each.root === tree.root ? { ...each, branch: now } : each)));
    return false;
  }
  updateWorktrees(list => list.map(each => (each.root === tree.root ? { ...each, branch: name } : each)));
  return true;
}

/** A worktree made here, named after its session once that has a title (this box names its own,
 * Mac connected or not; a Mac names only its own): one still on the branch it was made on, and
 * not pushed. Its session is told the new name, as it was told the one before. */
export async function nameWorktreeBranch(engine, sessionID) {
  if (typeof sessionID !== "string") return;
  const session = (await engineGet(engine, `api/session/${encodeURIComponent(sessionID)}`))?.data;
  // Not after a subagent's title, nor an engine run's a coding agent's session started.
  if (!session || session.parentID || isHiddenRun(session)) return;
  const folder = session.location?.directory ?? session.directory;
  // Read now, after the wait: what another naming did meanwhile shows.
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  const slug = branchSlug(session.title ?? "");
  if (!tree?.made || tree.branch !== tree.made || !slug) return;
  if (renameWorktree(tree, (tree.prefix ?? "") + slug)) await tellWorktree(engine, sessionID);
}

/** The worktrees made here whose session has a title by now, named: as they're read, so a reader
 * never sees one before this box named it (it heard of the title a moment later, or wasn't
 * running then). */
async function nameDueWorktrees(engine, signal) {
  const due = readWorktrees().filter(tree => tree.made && tree.branch === tree.made);
  if (!due.length || !engine?.port) return;
  const { sessions } = await sessionsHere(engine, signal);
  for (const tree of due) {
    const titled = sessions.find(session => (session.location?.directory ?? session.directory) === (tree.folder ?? tree.root) && !isHiddenRun(session) && branchSlug(session.title ?? ""));
    if (titled) await nameWorktreeBranch(engine, titled.id).catch(() => {});
  }
}

/** A session just made in one of this box's worktrees (by a phone, in one it asked for here):
 * told it works there, as a Mac tells one it makes. */
export async function tellWorktree(target, sessionID) {
  if (typeof sessionID !== "string") return;
  const session = (await engineGet(target, `api/session/${encodeURIComponent(sessionID)}`))?.data;
  const folder = session?.location?.directory ?? session?.directory;
  const tree = readWorktrees().find(each => (each.folder ?? each.root) === folder);
  if (!tree) return;
  const told = `You work in a git worktree of this project, on the branch ${tree.branch}, so your changes stay apart from the user's own checkout at ${tree.project} until they merge them. Make your changes here, not there.`;
  await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/kuvo.worktree`, { value: told });
}

/** `kuvo/worktrees…`, for this box's own. */
export async function answerWorktrees(method, requestPath, body, engine, signal) {
  const route = requestPath.split("?")[0];
  const message = text => ({ message: text });
  const list = readWorktrees();
  if (route === "kuvo/worktrees" && method === "GET") {
    // As a Mac reads them (as it connects, and as a session in one gets its title): without what
    // git says, their branches named.
    if (/(^|[?&])records=1(&|$)/.test(requestPath.split("?")[1] ?? "")) {
      await nameDueWorktrees(engine, signal);
      return { status: 200, value: { worktrees: readWorktrees() } };
    }
    const { sessions, active } = await sessionsHere(engine, signal);
    const worktrees = [];
    for (const tree of list) {
      const here = sessions.filter(session => inside(session.location?.directory ?? session.directory, tree.root));
      const entry = { path: tree.root, folder: tree.folder ?? tree.root, project: tree.project, projectName: path.basename(tree.project), branch: tree.branch, sessions: here.length, working: here.some(session => active.has(session.id)) };
      if (tree.base) entry.base = tree.base;
      if (fs.existsSync(tree.root)) {
        const status = await gitLater(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
        if (status !== null) {
          entry.uncommitted = status.length > 0;
          const ahead = tree.base ? await gitLater(tree.root, ["rev-list", "--count", `${tree.base}..HEAD`]) : null;
          if (ahead !== null && /^\d+$/.test(ahead)) entry.ahead = Number(ahead);
        }
        const size = await sizeLater(tree.root);
        if (size !== undefined) entry.size = size;
      }
      worktrees.push(entry);
    }
    return { status: 200, value: { worktrees } };
  }
  if (method !== "POST") return { status: route.startsWith("kuvo/worktrees") ? 405 : 404, value: {} };
  if (route === "kuvo/worktrees") {
    // A new one of a project's repository, on a branch of its own, for a session to run in.
    const project = body?.project;
    if (typeof project !== "string" || !path.isAbsolute(project) || !fs.existsSync(project)) return { status: 400, value: message("Send the project's folder on this machine as {\"project\"}.") };
    if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
    // What its branch's name starts with: as given, and kept for a client that doesn't say (a
    // phone), so one made from there starts as yours do.
    const kept = branchPrefix();
    const prefix = typeof body?.branchPrefix === "string" ? body.branchPrefix : kept;
    // Where the project is in its repository, as git sees it (through any links in its path).
    const subpath = gitIn(project, ["rev-parse", "--show-prefix"]);
    if (subpath === null) return { status: 409, value: message("That folder isn't in a git repository.") };
    const base = gitIn(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let id, root;
    try {
      id = await projectOf(engine, project, signal);
      root = (await call(engine, "POST", "/api/worktree", { projectID: id }, signal, project))?.directory;
    } catch (error) {
      return { status: 502, value: message(error?.message ?? String(error)) };
    }
    if (typeof root !== "string") return { status: 502, value: message("The engine didn't make it.") };
    // The engine leaves it on no branch; one of its own makes the work easy to commit, push and merge.
    const branch = freeBranch(root, prefix + path.basename(root));
    if (!branch || gitIn(root, ["switch", "--quiet", "-c", branch]) === null && gitIn(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== branch) {
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: root, force: true }, signal, project).catch(() => {});
      return { status: 502, value: message("Its branch couldn't be made.") };
    }
    // The prefix it was made with, kept for a client that gives none, once a branch with it was made.
    if (prefix !== kept) writePrivate(BRANCH_PREFIX_FILE, JSON.stringify({ branchPrefix: prefix }));
    const tree = { project, root, folder: subpath ? path.join(root, subpath.replace(/\/$/, "")) : root, branch, ...(base ? { base } : {}), made: branch, prefix };
    updateWorktrees(list => [...list.filter(each => each.root !== root), tree]);
    return { status: 200, value: tree };
  }
  // COMPAT(0.7 worktrees): a machine's worktrees an older Mac kept, given to its box. Goes 3 months after 0.8.0.
  if (route === "kuvo/worktrees/record") {
    // One a Mac made here before this box kept them: kept here from now on, if it's still here
    // (one removed since, from a phone, say, doesn't come back).
    const given = { project: body?.project, root: body?.root, folder: typeof body?.folder === "string" ? body.folder : body?.root, branch: body?.branch, ...(typeof body?.base === "string" ? { base: body.base } : {}) };
    const absolute = folder => typeof folder === "string" && path.isAbsolute(folder);
    if (!absolute(given.project) || !absolute(given.root) || !absolute(given.folder) || typeof given.branch !== "string" || !given.branch) return { status: 400, value: message("Send {project, root, folder?, branch, base?}.") };
    if (!fs.existsSync(given.root)) return { status: 404, value: message("That worktree isn't on this machine any more.") };
    // One it has already stays as it keeps it (its branch to be named, say).
    updateWorktrees(list => (list.some(each => each.root === given.root) ? list : [...list, given]));
    return { status: 200, value: {} };
  }
  const tree = list.find(each => each.root === body?.path);
  if (!tree) return { status: 404, value: message("That worktree isn't on this machine any more.") };
  if (route === "kuvo/worktrees/remove") {
    // Not while an agent works there; with changes not committed only when they're to go.
    const { sessions, active } = await sessionsHere(engine, signal);
    if (sessions.some(session => inside(session.location?.directory ?? session.directory, tree.root) && active.has(session.id))) {
      return { status: 409, value: message(`An agent is still working in the worktree of ${tree.branch}, so it stays. Stop it first, then remove the worktree.`) };
    }
    // One made for a session that never started (`forget`): not one a session has after all.
    if (body?.forget === true && sessions.some(session => inside(session.location?.directory ?? session.directory, tree.root))) {
      return { status: 409, value: message(`A session works in the worktree of ${tree.branch}, so it stays. Remove it with the session, or in Settings › Worktrees.`) };
    }
    const discard = body?.discard !== false;
    if (!discard && fs.existsSync(tree.root) && gitIn(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]) !== "") {
      return { status: 409, value: message(`The worktree of ${tree.branch} has changes that aren’t committed, so it stays. Commit them, or remove it in Settings › Worktrees, which throws them away.`) };
    }
    if (!engine?.port) return { status: 503, value: message("The engine isn't running.") };
    try {
      const id = await projectOf(engine, tree.project, signal);
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: tree.root, force: discard }, signal, tree.project);
    } catch (error) {
      return { status: 502, value: message(error?.message ?? String(error)) };
    }
    // Its branch goes only if it's merged (made for nothing, it goes whatever: `forget`).
    gitIn(tree.project, ["branch", body?.forget === true ? "-D" : "-d", tree.branch]);
    updateWorktrees(list => list.filter(each => each.root !== tree.root), tree);
    return { status: 200, value: {} };
  }
  return { status: 404, value: {} };
}

// Where its engine keeps what's its own (its XDG_DATA_HOME's `opencode`): in this box's folder on
// a machine, and in the app's on a Mac (KUVO_ENGINE_DATA). New worktrees go in its `worktree`
// folder, unless Settings › Worktrees names another.
const ENGINE_DATA = process.env.KUVO_ENGINE_DATA || path.join(K, "data", "opencode");

/** `kuvo/worktrees/where`: where new worktrees go with `directory` as Settings' Worktrees folder
 * (none: the engine's own), as the engine reads it, for each of this box's projects in a git
 * repository: the folder, whether it's there or can be made, and whether it's in the repository's
 * own checkout without git ignoring it (git would list them all as new files there). A relative
 * one starts at the repository's own checkout, not at the project's folder in it. */
export async function worktreesWhere(directory, engine, signal, projects = readProjects().filter(each => !each.removed).map(each => each.directory)) {
  const value = typeof directory === "string" && directory !== "" ? directory : null;
  const answer = { directory: value, default: path.join(ENGINE_DATA, "worktree"), home: os.homedir(), projects: [] };
  // The engine's projects, by their own checkout, from one call about none of them (one about a
  // folder would start the engine there): their ids name the engine's own folders.
  const ids = new Map();
  if (engine?.port) {
    try {
      for (const known of await call(engine, "GET", "/api/project", undefined, signal)) {
        if (typeof known?.id === "string" && typeof known?.canonical === "string") ids.set(realOr(known.canonical), known.vcs === "git" && known.id !== "global" ? known.id : null);
      }
    } catch {}
  }
  for (const project of projects) {
    if (!fs.existsSync(project)) continue;
    // The repository's own checkout (of a worktree, or of a folder in it, its main one), which
    // the engine resolves a relative folder from. (Without --path-format, which older git lacks.)
    const common = await gitLater(project, ["rev-parse", "--git-common-dir"]);
    if (!common) continue;
    const gitFolder = path.resolve(project, common);
    if (path.basename(gitFolder) !== ".git") continue;
    const checkout = realOr(path.dirname(gitFolder));
    // One the engine doesn't take for a repository has no worktrees: a repository with no commit
    // yet is its "global" project.
    const id = ids.get(checkout);
    if (id === null) continue;
    // The engine's own: a folder for each project, named by the start of its id.
    const folder = value === null ? (id ? path.join(answer.default, id.slice(0, 6)) : null)
      : value.startsWith("~/") ? path.join(answer.home, value.slice(2)) : path.resolve(checkout, value);
    const entry = { project, name: path.basename(project), folder };
    if (folder) {
      entry.exists = (() => { try { return fs.statSync(folder).isDirectory(); } catch { return false; } })();
      if (!entry.exists) entry.canMake = canMake(folder);
      if (inside(folder, checkout)) {
        entry.inside = true;
        // What's in it, as git sees a worktree there: ignored, or a new folder in the checkout.
        entry.ignored = (await gitLater(checkout, ["check-ignore", "-q", path.join(folder, "worktree")])) !== null;
      }
    }
    answer.projects.push(entry);
  }
  return answer;
}

/** A folder through any links in its path, as the engine names a checkout; as it is when it isn't there. */
function realOr(folder) {
  try { return fs.realpathSync(folder); } catch { return folder; }
}

/** Whether `folder` can be made: the nearest folder of it that's there is one you can write in. */
function canMake(folder) {
  for (let at = path.dirname(folder); ; at = path.dirname(at)) {
    try {
      if (!fs.statSync(at).isDirectory()) return false;
      fs.accessSync(at, fs.constants.W_OK);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT" || at === path.dirname(at)) return false;
    }
  }
}

// MARK: Folders (PROTOCOL.md, `kuvo/folders`): this box's folders, for a client to choose one.

/** `kuvo/folders?path=`: the folders in one of this box's folders (none: the home folder; `~/`
 * starts there), as a client shows them to choose one: `{path, home, parent, folders: [{name,
 * repository?}]}`, ordered as Finder orders names, hidden ones (starting with ".") only with
 * `hidden=1`. `repository`: a git repository's own checkout. */
export function listFolders(requestPath) {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const home = os.homedir();
  const given = (query.get("path") ?? "").trim();
  const folder = !given || given === "~" ? home : given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(folder)) return { status: 400, value: { message: "Send a folder's full path, or one that starts with ~/." } };
  const at = path.resolve(folder);
  let entries;
  try {
    entries = fs.readdirSync(at, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { status: 404, value: { message: `There's no folder ${at} here.` } };
    return { status: 403, value: { message: `${at} can't be read here.` } };
  }
  const hidden = query.get("hidden") === "1";
  // Platform: on a Mac, looking into these from the home folder would have macOS ask you for them.
  const asks = at === home ? promptedFolders() : new Set();
  const isFolder = entry => entry.isDirectory() || (entry.isSymbolicLink() && (() => { try { return fs.statSync(path.join(at, entry.name)).isDirectory(); } catch { return false; } })());
  const folders = entries
    .filter(entry => (hidden || !entry.name.startsWith(".")) && isFolder(entry))
    .map(entry => (!asks.has(entry.name) && fs.existsSync(path.join(at, entry.name, ".git")) ? { name: entry.name, repository: true } : { name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { status: 200, value: { path: at, home, parent: at === path.dirname(at) ? null : path.dirname(at), folders } };
}

/** `POST kuvo/folders {"path"}`: a new folder, in one that's there, as a folder panel's New Folder
 * makes one: `{path}` (`~/` starts at the home folder). */
export function makeFolder(body) {
  const given = typeof body?.path === "string" ? body.path.trim() : "";
  const home = os.homedir();
  const folder = given.startsWith("~/") ? path.join(home, given.slice(2)) : given;
  if (!path.isAbsolute(folder)) return { status: 400, value: { message: "Send the new folder's full path, or one that starts with ~/." } };
  const at = path.resolve(folder);
  // Platform: a Mac's disk usually ignores case, so "Trees" is taken by "trees" there, not on Linux.
  if (fs.existsSync(at)) return { status: 409, value: { message: `There's already something called ${path.basename(at)} there.` } };
  try {
    fs.mkdirSync(at);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: 404, value: { message: `There's no folder ${path.dirname(at)} here.` } };
    return { status: 403, value: { message: `A folder can't be made in ${path.dirname(at)} here.` } };
  }
  return { status: 200, value: { path: at } };
}

// MARK: Plugins (PROTOCOL.md, `kuvo/plugins/search`): npm's packages its engine can load, found from this box.

// npm's registry, or a test's stand-in for it, in a test's folder only (never a machine's own).
const testNpm = path.resolve(K) !== path.join(os.homedir(), ".kuvo-code") ? process.env.KUVO_TEST_NPM : undefined;
const NPM = testNpm ?? "https://registry.npmjs.org";
// A package as npm names it, with a version or tag after it or not.
const NPM_SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s@/]+))?$/;

/** `kuvo/plugins/search?q=`: npm's packages for opencode that `q` finds (with none, the most used
 * plugins), each `{name, version, description, weekly}`, the one it names exactly first. `q`
 * that names a package npm doesn't have says so (`missing`). */
export async function searchPlugins(query, signal) {
  const text = String(query ?? "").trim().toLowerCase();
  // A package's record as npm installs from it (its versions and tags, not its whole history).
  const ask = async (address, headers = {}) => {
    const answered = await fetch(address, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (answered.status === 404) return null;
    if (!answered.ok) throw new Error(`npm answered ${answered.status}.`);
    return answered.json();
  };
  const spec = text.match(NPM_SPEC);
  const [found, named] = await Promise.all([
    ask(`${NPM}/-/v1/search?size=20&text=${encodeURIComponent(text ? `${text} keywords:opencode` : "keywords:opencode-plugin")}`),
    // Not known (npm didn't answer) is not missing.
    spec ? ask(`${NPM}/${spec[1].replace("/", "%2F")}`, { accept: "application/vnd.npm.install-v1+json" }).catch(() => undefined) : undefined,
  ]);
  const packages = (found?.objects ?? []).map(each => ({
    name: each.package?.name,
    version: each.package?.version,
    description: each.package?.description || undefined,
    weekly: each.downloads?.weekly,
  })).filter(each => typeof each.name === "string");
  const answer = { packages };
  if (spec && named?.name) {
    const listed = packages.find(each => each.name === named.name);
    const version = spec[2] && named.versions?.[spec[2]] ? spec[2] : named["dist-tags"]?.[spec[2]] ?? named["dist-tags"]?.latest;
    answer.packages = [{ name: named.name, version, description: listed?.description, weekly: listed?.weekly }, ...packages.filter(each => each !== listed)];
    // A version or a tag it doesn't have (a range, like ^1.2.0, it may well have).
    const exact = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec[2] ?? "") || /^[a-z][\w-]*$/i.test(spec[2] ?? "");
    if (spec[2] && exact && !named.versions?.[spec[2]] && !named["dist-tags"]?.[spec[2]]) answer.missing = `${named.name}@${spec[2]}`;
  } else if (named === null) {
    answer.missing = spec[1];
  }
  return answer;
}

// MARK: Skills (PROTOCOL.md, "Skills"): every box's, a Mac's too, and every client's way to GitHub's collections.

// Where its engine reads the skills you add: its settings folder's (its XDG_CONFIG_HOME), which is
// in this box's folder on a machine, and the app's engine's on a Mac (KUVO_ENGINE_CONFIG), so a
// Mac's skills stay where they've always been.
const SKILLS = path.join(process.env.KUVO_ENGINE_CONFIG || path.join(K, "config"), "opencode", "skills");
const SKILL_SOURCE = ".kuvo-source.json";
// GitHub, or a test's stand-in for it, in a test's folder only (never a machine's own).
const testGitHub = path.resolve(K) !== path.join(os.homedir(), ".kuvo-code") ? process.env.KUVO_TEST_GITHUB : undefined;
const GITHUB = { api: testGitHub ?? "https://api.github.com", raw: testGitHub ?? "https://raw.githubusercontent.com" };
// The well-known collections, roughly most popular first. Anyone can open another by name.
export const SKILL_REPOSITORIES = [
  ["anthropics", "skills", "Anthropic", "The reference set: documents, spreadsheets, slides, PDFs, design and more."],
  ["openai", "skills", "OpenAI", "Codex's catalog of curated skills."],
  ["obra", "superpowers", "Superpowers", "Ways of working: test-driven development, debugging, planning, code review."],
  ["mattpocock", "skills", "Matt Pocock", "Engineering and productivity skills, TypeScript-minded."],
  ["addyosmani", "agent-skills", "Addy Osmani", "Production engineering practices: performance, accessibility, testing."],
  ["vercel-labs", "agent-skills", "Vercel", "React, Next.js and deploying to Vercel."],
  ["github", "awesome-copilot", "GitHub Awesome Copilot", "Hundreds of community skills; quality varies."],
  ["huggingface", "skills", "Hugging Face", "Models, datasets and training with Hugging Face."],
  ["cloudflare", "skills", "Cloudflare", "Workers, Pages and the rest of Cloudflare's platform."],
  ["trailofbits", "skills", "Trail of Bits", "Security auditing and code review."],
  ["K-Dense-AI", "scientific-agent-skills", "Scientific Skills", "A large library for science: biology, chemistry, data analysis."],
  ["wshobson", "agents", "wshobson/agents", "A big set of plugins with skills for many languages and tools."],
].map(([owner, name, title, summary]) => ({ id: `${owner}/${name}`, owner, name, title, summary, branch: "main" }));

class SkillFailure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const limited = () => new SkillFailure(503, "GitHub is limiting requests for now. Try again in a while.");

/** A folder's name in the skills folder: not a path, nor hidden. */
const isSkillFolder = name => typeof name === "string" && name.length > 0 && name.length <= 128 && !name.startsWith(".") && !/[\/\\\0]/.test(name);

/** A skill's name from what's typed, as Settings makes it (SkillFile.name). */
export function skillName(text) {
  // Composed first (an "é" typed as "e" and a mark is one letter, left out whole), as Settings does.
  const words = String(text).normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).map(word => [...word].filter(c => c.charCodeAt(0) < 128).join("")).filter(Boolean);
  return words.join("-").slice(0, 64).replace(/-+$/, "");
}

/** The skills folder's own folders (not hidden), by name: what a new skill's name mustn't take,
 * whether its engine lists it or not. */
function skillFolders() {
  return listOf(SKILLS).filter(name => !name.startsWith(".") && (() => { try { return fs.statSync(path.join(SKILLS, name)).isDirectory(); } catch { return false; } })()).sort();
}

// Recently Deleted: a skill put away, in this box's own trash, as `<its folder's name>-<when, in
// seconds>`, kept 30 days from then. Its name says when, never its folder's date, which a Finder
// visit or a backup put back can change.
const SKILL_TRASH = path.join(K, "trash", "skills");
const SKILL_TRASH_DAYS = 30;
const DAY = 86_400_000;

const isDirectory = file => { try { return fs.statSync(file).isDirectory(); } catch { return false; } };

/** A Recently Deleted entry's id read: the folder's name it goes back to and when it was put away
 * (seconds since 1970), or null for what isn't an entry's id (a path, a hidden name, anything not
 * `<name>-<seconds>`). */
export function skillTrashEntry(entry) {
  const found = typeof entry === "string" && entry.length <= 141 ? /^(.+)-(\d{1,12})$/.exec(entry) : null;
  return found && isSkillFolder(found[1]) && isSkillFolder(entry) ? { folder: found[1], deleted: Number(found[2]) } : null;
}

/** What's been in Recently Deleted 30 days or more, gone for good. */
function clearSkillTrash(now = Date.now()) {
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    if (entry && entry.deleted * 1000 <= now - SKILL_TRASH_DAYS * DAY) try { fs.rmSync(path.join(SKILL_TRASH, id), { recursive: true, force: true }); } catch {}
  }
}

/** Recently Deleted cleared as the box starts and once a day while it runs, so what's past its 30
 * days goes with no client there too. Its timer, which never keeps the process up. */
export function keepSkillTrashClear() {
  clearSkillTrash();
  const timer = setInterval(() => clearSkillTrash(), DAY);
  timer.unref?.();
  return timer;
}

/** Recently Deleted, newest first: each with what its SKILL.md says it is, when it was put away and
 * when it goes, in seconds since 1970. */
function skillTrashEntries() {
  const entries = [];
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    const away = path.join(SKILL_TRASH, id);
    if (!entry || !isDirectory(away)) continue;
    const about = skillAbout(textOf(path.join(away, "SKILL.md")) ?? "");
    entries.push({
      id, folder: entry.folder, name: about.name || entry.folder, ...(about.description ? { description: about.description } : {}),
      deleted: entry.deleted, goes: entry.deleted + SKILL_TRASH_DAYS * 86_400,
    });
  }
  return entries.sort((a, b) => b.deleted - a.deleted || a.id.localeCompare(b.id));
}

/** Skills installed from GitHub, by their folder's name, with where they came from. */
function skillSources() {
  const sources = {};
  for (const name of listOf(SKILLS)) {
    try {
      const source = JSON.parse(fs.readFileSync(path.join(SKILLS, name, SKILL_SOURCE), "utf8"));
      if (typeof source?.repository === "string") sources[name] = { repository: source.repository, path: typeof source.path === "string" ? source.path : "" };
    } catch {}
  }
  return sources;
}

async function github(url, json = true) {
  const response = await fetch(url, { headers: json ? { accept: "application/vnd.github+json", "user-agent": "Kuvo Code" } : { "user-agent": "Kuvo Code" }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 403 || response.status === 429) throw limited();
  return response;
}

/** Repositories looked up on GitHub lately, by their name in lowercase: a collection's skills'
 * descriptions are asked for one by one, and GitHub allows few lookups an hour. */
const lookedUp = new Map();

/** One of the well-known collections, or any other by its name on GitHub, with its default branch. */
async function skillRepository(owner, name) {
  const known = SKILL_REPOSITORIES.find(each => each.owner.toLowerCase() === owner.toLowerCase() && each.name.toLowerCase() === name.toLowerCase());
  if (known) return known;
  const key = `${owner}/${name}`.toLowerCase();
  const kept = lookedUp.get(key);
  if (kept && Date.now() - kept.at < 15 * 60_000) return kept.repository;
  const response = await github(`${GITHUB.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const info = response.status === 200 ? await response.json().catch(() => null) : null;
  if (typeof info?.default_branch !== "string") throw new SkillFailure(404, `${owner}/${name} wasn’t found on GitHub.`);
  const repository = { id: `${owner}/${name}`, owner, name, title: `${owner}/${name}`, summary: info.description ?? "", branch: info.default_branch };
  if (lookedUp.size > 50) lookedUp.clear();
  lookedUp.set(key, { repository, at: Date.now() });
  return repository;
}

/** The skills the engine lists (its own, and those in other tools' folders), `{id, path?}`, which a
 * new one mustn't take; none when it doesn't answer. */
async function engineSkills(engine) {
  if (!engine?.port) return [];
  try {
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/skill`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5_000),
    });
    const listed = response.ok ? (await response.json())?.data : null;
    return Array.isArray(listed)
      ? listed.filter(skill => typeof skill?.id === "string").map(skill => ({ id: skill.id, ...(typeof skill.path === "string" ? { path: skill.path } : {}) }))
      : [];
  } catch {
    return [];
  }
}

const engineSkillNames = async engine => (await engineSkills(engine)).map(skill => skill.id);

/** Where a skill the engine lists is, said short: "in ~/.claude/skills", "built in". */
function skillPlace(file) {
  if (typeof file !== "string" || !file) return "elsewhere";
  if (file.startsWith("/builtin/")) return "built in";
  const folder = path.dirname(path.dirname(file));
  const home = os.homedir();
  return `in ${folder === home || folder.startsWith(home + path.sep) ? "~" + folder.slice(home.length) : folder}`;
}

/** A repository's skills, from its file list (one request to GitHub's API): each folder with a
 * SKILL.md, with every file in it (the deepest skill's, for skills inside skills), or the
 * repository itself when its SKILL.md is at the top (without its hidden folders). */
export async function skillsIn(repository) {
  const response = await github(`${GITHUB.api}/repos/${repository.owner}/${repository.name}/git/trees/${repository.branch}?recursive=1`);
  if (response.status !== 200) throw new SkillFailure(404, `${repository.id} wasn’t found on GitHub.`);
  const tree = await response.json();
  const files = (tree.tree ?? []).filter(entry => entry.type === "blob").map(entry => entry.path);
  const dirname = file => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
  const folders = new Set(files.filter(file => file.split("/").at(-1) === "SKILL.md").map(dirname).filter(Boolean));
  const isSkill = files.includes("SKILL.md");
  const byFolder = new Map();
  for (const file of files) {
    let folder = dirname(file);
    while (folder && !folders.has(folder)) folder = dirname(folder);
    if (folder) byFolder.set(folder, [...(byFolder.get(folder) ?? []), file]);
    else if (isSkill && !file.startsWith(".")) byFolder.set("", [...(byFolder.get("") ?? []), file]);
  }
  const nameOf = folder => (folder ? folder.split("/").at(-1) : repository.name);
  let skills = [...(isSkill ? [""] : []), ...[...folders].sort()].map(folder => ({ name: nameOf(folder), path: folder, files: byFolder.get(folder) ?? [] }));
  // A copy kept for another tool in a hidden folder, of one in plain sight: listed once.
  const hidden = skill => skill.path.split("/").some(part => part.startsWith("."));
  const shown = new Set(skills.filter(skill => !hidden(skill)).map(skill => skill.name));
  skills = skills.filter(skill => !(hidden(skill) && shown.has(skill.name)));
  return { skills, partial: tree.truncated === true };
}

/** What skills' SKILL.md files say they are, by repository, branch and folder, kept while the box
 * runs: a collection's are read once, however often it's opened or a phone asks for one. */
const skillAbouts = new Map();
/** At most this many read from GitHub at once, the rest waiting their turn, so a big collection
 * never holds up an install or another client's request. */
const ABOUT_READS = 16;
let aboutReading = 0;
const aboutWaiting = [];

/** What a skill's SKILL.md says it is: `{name?, description?}`, `{}` when GitHub doesn't say. */
async function aboutSkill(repository, folder) {
  const key = `${repository.id.toLowerCase()}@${repository.branch}:${folder}`;
  if (skillAbouts.has(key)) return skillAbouts.get(key);
  if (aboutReading >= ABOUT_READS) await new Promise(resolve => aboutWaiting.push(resolve));
  aboutReading++;
  try {
    if (skillAbouts.has(key)) return skillAbouts.get(key);
    const response = await github(rawURL(repository, folder ? `${folder}/SKILL.md` : "SKILL.md"), false).catch(() => null);
    if (response?.status !== 200) return {};
    const about = skillAbout(await response.text());
    if (skillAbouts.size > 5_000) skillAbouts.clear();
    skillAbouts.set(key, about);
    return about;
  } finally {
    aboutReading--;
    aboutWaiting.shift()?.();
  }
}

const rawURL = (repository, file) => `${GITHUB.raw}/${repository.owner}/${repository.name}/${repository.branch}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** The front matter's name and description. */
export function skillAbout(markdown) {
  const lines = String(markdown).split(/\r\n|\r|\n/);
  const about = {};
  if (lines[0]?.trim() !== "---") return about;
  for (let index = 1; index < lines.length && lines[index].trim() !== "---"; index++) {
    const line = lines[index];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ([">", "|", ">-", "|-"].includes(value)) {
      const parts = [];
      while (index + 1 < lines.length && lines[index + 1].startsWith(" ")) parts.push(lines[++index].trim());
      value = parts.join(" ");
    }
    value = value.replace(/^["']+|["']+$/g, "");
    if (key === "name") about.name = value;
    if (key === "description") about.description = value;
  }
  return about;
}

/** Fetches a skill's files beside the folder, then moves them in whole, so the engine never finds half of it. */
async function installSkill(repository, skill) {
  const target = path.join(SKILLS, skill.name);
  if (fs.existsSync(target)) throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
  // Its own: two installs at once never share one.
  const staging = path.join(SKILLS, `.${skill.name}.kuvo-new-${crypto.randomUUID()}`);
  try {
    for (const file of skill.files) {
      const response = await github(rawURL(repository, file), false);
      if (response.status !== 200) throw new SkillFailure(404, `${file} wasn’t found on GitHub.`);
      const relative = skill.path ? file.slice(skill.path.length + 1) : file;
      const into = path.join(staging, relative);
      if (!into.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(into), { recursive: true });
      fs.writeFileSync(into, Buffer.from(await response.arrayBuffer()));
    }
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, SKILL_SOURCE), JSON.stringify({ branch: repository.branch, path: skill.path, repository: repository.id }, null, 2));
    if (fs.existsSync(target)) throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** `kuvo/skills…`, `kuvo/skill-trash…` and `kuvo/skill-library…`, for this box's own folder. */
export async function answerSkills(method, requestPath, body, engine = null) {
  const [route, query = ""] = requestPath.split("?");
  const parts = route.split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  if (parts.includes(null)) return { status: 400, value: { message: "That isn’t a path." } };
  const message = text => ({ message: text });
  try {
    if (parts[1] === "skills" && parts.length === 2) {
      if (method !== "GET") return { status: 405, value: {} };
      return { status: 200, value: { folder: SKILLS, folders: skillFolders(), github: skillSources() } };
    }
    if (parts[1] === "skills" && parts.length === 3) {
      const name = parts[2];
      if (!isSkillFolder(name)) return { status: 400, value: message("That isn’t a skill’s name.") };
      const folder = path.join(SKILLS, name);
      const file = path.join(folder, "SKILL.md");
      if (method === "GET") {
        const text = textOf(file);
        return text === null ? { status: 404, value: {} } : { status: 200, value: { text } };
      }
      if (method === "PUT") {
        const text = body?.text;
        if (typeof text !== "string" || !text.trim()) return { status: 400, value: message('Send the skill\'s SKILL.md as {"text": …}.') };
        if (body?.new === true) {
          if (skillName(name) !== name) return { status: 400, value: message("Names use lowercase letters a to z, digits and hyphens.") };
          if (fs.existsSync(folder) || (await engineSkillNames(engine)).includes(name)) return { status: 409, value: message(`There’s a skill called ${name} already.`) };
        } else if (!fs.existsSync(folder)) {
          return { status: 404, value: {} };
        } else if (skillSources()[name]) {
          // As Settings has it: one from GitHub is as it came, not edited.
          return { status: 409, value: message(`${name} came from GitHub, so it isn’t edited here.`) };
        }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(`${file}.new`, text);
        fs.renameSync(`${file}.new`, file);
        return { status: 200, value: {} };
      }
      if (method === "DELETE") {
        if (!fs.existsSync(folder)) return { status: 404, value: {} };
        // To this box's own trash (Recently Deleted), kept 30 days.
        fs.mkdirSync(SKILL_TRASH, { recursive: true });
        let when = Math.floor(Date.now() / 1000);
        while (fs.existsSync(path.join(SKILL_TRASH, `${name}-${when}`))) when++;
        fs.renameSync(folder, path.join(SKILL_TRASH, `${name}-${when}`));
        clearSkillTrash();
        return { status: 200, value: {} };
      }
      return { status: 405, value: {} };
    }
    if (parts[1] === "skill-trash") {
      // Recently Deleted: what's past its 30 days goes first, whatever's asked.
      clearSkillTrash();
      if (parts.length === 2) {
        if (method !== "GET") return { status: 405, value: {} };
        return { status: 200, value: { entries: skillTrashEntries() } };
      }
      if (parts.length === 4 && parts[3] === "restore") {
        if (method !== "POST") return { status: 405, value: {} };
        const entry = parts[2];
        const name = skillTrashEntry(entry)?.folder;
        if (!name) return { status: 400, value: message("That isn’t an entry in Recently Deleted.") };
        const away = path.join(SKILL_TRASH, entry);
        if (!isDirectory(away)) return { status: 404, value: {} };
        const back = path.join(SKILLS, name);
        // Never over another: one by its name now stays, and so does this one, to restore later.
        if (fs.existsSync(back)) return { status: 409, value: message(`There’s a skill called ${name} now. Delete it first to restore this one.`) };
        // Nor beside one the engine finds elsewhere by that name (another tool's folder), which it
        // would hide; the one put away, which the engine can list a moment longer, doesn't count.
        const elsewhere = (await engineSkills(engine)).find(skill => skill.id === name && !skill.path?.startsWith(SKILLS + path.sep));
        if (elsewhere) return { status: 409, value: message(`There’s a skill called ${name} ${skillPlace(elsewhere.path)}, so this one can’t be restored under that name.`) };
        fs.mkdirSync(SKILLS, { recursive: true });
        fs.renameSync(away, back);
        return { status: 200, value: { name } };
      }
      return { status: 404, value: {} };
    }
    if (parts[1] === "skill-library") {
      if (parts.length === 2 && method === "GET") return { status: 200, value: { repositories: SKILL_REPOSITORIES.map(({ branch, ...shown }) => shown) } };
      if (parts.length === 3 && parts[2] === "install" && method === "POST") {
        const [owner, name] = String(body?.repository ?? "").split("/");
        if (!owner || !name || typeof body?.path !== "string") return { status: 400, value: message('Send {"repository": "owner/name", "path": …}.') };
        const repository = await skillRepository(owner, name);
        const skill = (await skillsIn(repository)).skills.find(each => each.path === body.path);
        if (!skill) return { status: 404, value: message(`There’s no skill at ${body.path} in ${repository.id}.`) };
        await installSkill(repository, skill);
        return { status: 200, value: { name: skill.name } };
      }
      if (parts.length === 4 && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        const { skills, partial } = await skillsIn(repository);
        const { branch, ...shown } = repository;
        // Each with what its SKILL.md says it is, so a client shows them without asking for each.
        const described = await Promise.all(skills.map(async skill => ({ ...skill, about: await aboutSkill(repository, skill.path) })));
        return { status: 200, value: { repository: shown, skills: described, partial } };
      }
      if (parts.length === 5 && parts[4] === "about" && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        // As written: a "+" is a plus.
        const pair = query.split("&").find(each => each.startsWith("path="));
        let at = "";
        try { at = pair ? decodeURIComponent(pair.slice(5)) : ""; } catch { return { status: 400, value: message("That isn’t a path.") }; }
        return { status: 200, value: await aboutSkill(repository, at) };
      }
    }
    return { status: 404, value: {} };
  } catch (error) {
    return { status: error instanceof SkillFailure ? error.status : 502, value: message(error?.message ?? String(error)) };
  }
}

// The handler LinkHost runs for each request. `hold`: the running bridge's notices held while
// you're at a computer (none in `box route`, a command of its own).
export function engineHandler(readEngine = readEngineFile, info = {}, readBridge = readBridgeFile, phonesChanged = () => {}, hold = null) {
  // The agents' bridge, while it runs: its record, while the process it names is still it.
  const bridge = () => {
    try {
      const found = readBridge();
      return found?.port && found?.password && runs(found.pid, "kuvo-agents") ? found : null;
    } catch {
      return null;
    }
  };
  return async function* (request, phone, signal) {
    const text = (status, words) => [{ head: { status, headers: { "content-type": "text/plain" } } }, { body: Buffer.from(words) }];
    // A phone using this machine, whatever it asks; not the app beside a Mac's own box.
    if (!request.fromApp) phoneHere();
    // Which route answers, by its path alone: a query string never changes it (as on a Mac).
    const route = request.path.split("?")[0];
    if (route === "kuvo/info") {
      let engine = {};
      try { engine = readEngine(); } catch {}
      // When the engine running now came up, in seconds since 1970 (each start writes its record):
      // a restart changes it.
      let started = null;
      if (engine.pid) try { started = fs.statSync(ENGINE_FILE).mtimeMs / 1000; } catch {}
      // COMPAT(0.7 engine-stop): `stopped`, an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
      // Whether it runs now, and whether it's stopped on purpose (until it's started, from anywhere).
      const running = Boolean(engine.pid && runs(engine.pid, `${K}/engine/`));
      const stopped = fs.existsSync(path.join(RUN, "stopped"));
      // Its folder of chats (conversations of no project), as a Mac names its own: made if it isn't
      // there yet, so a phone can start the first one.
      const chats = path.join(K, "chats");
      try { fs.mkdirSync(chats, { recursive: true }); } catch {}
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents: Boolean(bridge()), chats, features: FEATURES, ...info })) };
      return;
    }
    const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
    if (route === "kuvo/file") return yield* fileAt(request.path, json);
    // This box's updates (PROTOCOL.md, "Updates"): how it stands, Update Now. It always updates
    // by itself: there's no switch.
    if (route === "kuvo/update") {
      const method = request.method.toUpperCase();
      if (method === "GET") return yield* json(200, updateStatus());
      if (method === "POST") {
        if (parsed(request.body)?.now !== true) return yield* json(400, { message: "Say to update now (now)." });
        if (!UPDATE_KEYS.length) return yield* json(409, { message: "Updates aren't set up for this machine yet." });
        const blocked = updatesBlocked();
        if (blocked) return yield* json(409, { message: blocked });
        return yield* (startUpdate({ now: true }) ? json(202, updateStatus()) : json(409, { message: "It's updating already." }));
      }
      return yield* json(405, {});
    }
    // Settings › Integrations (PROTOCOL.md, "Integrations"): this machine's own, added and removed
    // here from the catalog the Mac leaves (`bin/integrations.json`), with the Mac closed too.
    if (/^kuvo\/integrations(\/|\?|$)/.test(request.path)) {
      if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerIntegrations(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
      return yield* json(status, value);
    }
    // A folder of this box's to choose, for a setting that names one (PROTOCOL.md, `kuvo/folders`).
    if (route === "kuvo/folders") {
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "POST") return yield* json(405, {});
      const { status, value } = method === "GET" ? listFolders(request.path) : makeFolder(parsed(request.body));
      return yield* json(status, value);
    }
    // Settings › Engine's plugins (PROTOCOL.md, `kuvo/plugins/search`): npm's, found from this box.
    if (route === "kuvo/plugins/search") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      try {
        return yield* json(200, await searchPlugins(new URLSearchParams(request.path.split("?")[1] ?? "").get("q"), signal));
      } catch (error) {
        return yield* json(502, { message: "npm couldn't be reached from here. Check this computer's internet connection, then try again." });
      }
    }
    // Settings › Skills (PROTOCOL.md, "Skills"): this box's own skills folder, its Recently Deleted, and GitHub's
    // collections, which it reaches itself (a machine's with the Mac closed too).
    if (/^kuvo\/(skills|skill-library|skill-trash)(\/|\?|$)/.test(request.path)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerSkills(request.method.toUpperCase(), request.path, parsed(request.body), engine);
      return yield* json(status, value);
    }
    // Its own settings, and its integrations' keys (PROTOCOL.md, "Settings per box").
    if (/^kuvo\/(config|mcp\/catalog|keys)(\/|\?|$)/.test(request.path)) {
      // Its own, once Kuvo Code has made them so; until then, as the Mac that started it has them.
      if (!ownsSettings()) return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
      const method = request.method.toUpperCase();
      // A file that can't be used says why twice: in words to show (`message`), and the file's
      // problem alone (`problem`), for a page that names the file already.
      const answered = ({ status, settings, message, problem }) => json(status, message ? (problem ? { message, problem } : { message }) : settings ?? {});
      if (route === "kuvo/config") {
        if (method === "GET") {
          const { settings, problem } = readSettings();
          return yield* (problem ? json(409, { message: `The engine's settings file can't be changed from here: ${problem}`, problem }) : json(200, settings));
        }
        if (method === "PATCH") return yield* answered(changeSettings(parsed(request.body)?.changes));
        return yield* json(405, {});
      }
      if (route === "kuvo/config/apply") {
        if (method !== "POST") return yield* json(405, {});
        const { status, ...answer } = applySettings(parsed(request.body));
        return yield* json(status, answer);
      }
      if (route === "kuvo/mcp/catalog") {
        if (method !== "GET") return yield* json(405, {});
        return yield* json(200, mcpCatalog(readSettings().settings ?? {}));
      }
      const adding = route.match(/^kuvo\/mcp\/catalog\/([^/]+)$/);
      if (adding && method === "POST") return yield* answered(addFromCatalog(decodeURIComponent(adding[1])));
      // Its integrations' keys, where it keeps them (a machine's files, this Mac's Keychain through
      // its app): a bot's own aren't among them.
      if (route === "kuvo/keys" || route.startsWith("kuvo/keys/")) {
        const { status, value } = await answerKeys(method, route, parsed(request.body));
        return yield* json(status, value);
      }
      return yield* json(404, {});
    }
    // The phones paired with this machine, and removing some (a lost one, say), from any phone
    // paired with it: what a removal takes off stays off (see `removePhones`).
    if (route === "kuvo/phones") {
      const link = readLink();
      const asking = phone?.key?.toString("base64url");
      return yield* json(200, {
        phones: (link?.phones ?? []).map(each => ({ key: each.key, name: each.name, added: each.added ?? null, pairing: each.pairing ?? "", you: each.key === asking })),
      });
    }
    if (route === "kuvo/phones/remove") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      // This Mac's app removes as the Mac does (Settings › Phone, or a removal a machine's
      // document brought).
      const asMac = IS_MAC && request.fromApp;
      // On this Mac, one before any phone's paired here (no link file yet) is kept all the same,
      // so the phone stays out once it's taken.
      const changed = updateLink(kept => {
        const link = kept ?? (asMac ? { phones: [], removed: [] } : null);
        return link && (asMac ? removeAsMac(link, given?.phones) : removePhones(link, phone?.key?.toString("base64url"), given?.phones)) ? link : null;
      });
      if (!changed) return yield* json(400, { message: "Only phones paired here can be removed, and never your Mac." });
      noteDocsChanged();
      // Once this answer is on its way: a phone that removed itself gets it too.
      setTimeout(() => phonesChanged(readLink() ?? changed), 200);
      return yield* json(200, {});
    }
    // A link for another phone to pair with this machine, as `kuvo-link.js pair` shows one: good
    // once, for a while; a new one takes the place of the last. DELETE ends it.
    if (route === "kuvo/phones/pair") {
      const method = request.method.toUpperCase();
      // This Mac's Settings › Phone has one of its own, apart from a phone's.
      const slot = IS_MAC && request.fromApp ? "appPairing" : "pairing";
      if (method === "DELETE") {
        // `?token=`: that link alone, so one closed late never ends a newer one.
        const token = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("token");
        updateLink(link => {
          if (!link?.[slot] || (token && link[slot].token !== token)) return null;
          delete link[slot];
          return link;
        });
        macLink.wake?.();
        return yield* json(200, {});
      }
      if (method !== "POST") return yield* json(405, {});
      if (IS_MAC && !macLink.config?.phones) return yield* json(409, { message: "The phone link is off on this Mac." });
      const link = updateLink(current => current?.relay && current?.secret ? { ...current, [slot]: newPairingToken() } : null);
      if (!link) return yield* json(409, { message: IS_MAC ? "The phone link isn't ready yet. Try again in a moment." : "This machine has no relay to pair through." });
      macLink.wake?.();
      return yield* json(200, { link: pairingLink({ ...link, pairing: link[slot] }), ends: Math.floor(link[slot].expires / 1000) });
    }
    // This Mac's box's link, for its app alone (PROTOCOL.md, "This Mac's box: the relay").
    if (route === "kuvo/link" || route.startsWith("kuvo/link/")) {
      if (!IS_MAC || !request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      return yield* macLinkRoute(route, request, signal);
    }
    // On this Mac, what only its app knows for your phones (an ask from its panel's browser), held
    // with the box's own; and one answered there, which then never goes. Its app's alone.
    if (route === "kuvo/attention/notice" || route === "kuvo/attention/answered") {
      if (!IS_MAC || !request.fromApp || !hold) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (route === "kuvo/attention/answered") {
        if (typeof given?.id !== "string") return yield* json(400, { message: "Send {id}." });
        hold.resolve(given.id);
        return yield* json(200, {});
      }
      if (!isObject(given?.notice) || typeof given.notice.title !== "string") return yield* json(400, { message: "Send {notice}." });
      macTell(given.notice);
      return yield* json(200, {});
    }
    // A client in use here (PROTOCOL.md, "kuvo/attention"): notices for your phones wait a little
    // while one is. GET says whether one is, and how many wait.
    if (route === "kuvo/attention") {
      const method = request.method.toUpperCase();
      if (!hold) return yield* json(503, { message: "Only this machine's bridge holds its notices." });
      if (method === "GET" || method === "HEAD") return yield* json(200, { inUse: hold.inUse, held: hold.count });
      if (method !== "POST") return yield* json(405, {});
      const given = attentionGiven(parsed(request.body));
      if (!given) return yield* json(400, { message: "Say for how many seconds you're in use (for: 0 for not), and which conversations are on your screen (sessions)." });
      // This Mac's app is "mac", as a Mac's word by mail is to a machine; and your machines hear it.
      hold.attend(IS_MAC && request.fromApp ? "mac" : `phone:${phone?.key?.toString("base64url") ?? ""}`, given);
      if (IS_MAC && request.fromApp) macAttendPeers(parsed(request.body), given);
      return yield* json(200, { for: given.seconds });
    }
    // Who `&` can name in a message here, as a Mac's composer offers them: this machine's bots and
    // latest sessions (`machine` null), then those its other computers told it of.
    if (route === "kuvo/named") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      const link = readLink();
      // Its own as last worked out while its engine can't say (starting), rather than none.
      const fresh = await ownAgents(readEngine, link?.id).catch(() => null);
      if (fresh) {
        ownList = fresh;
        ownMachine = link?.id ?? null;
      }
      const own = fresh ?? ownAsLast(link?.id ?? null);
      return yield* json(200, { agents: namedAgents(own, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link)) });
    }
    // What agents ask for while they browse here: listed, followed (a line each time it changes,
    // as a Mac's), and answered.
    if (route === "kuvo/asks" || route === "kuvo/asks/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      const read = async () => ({
        asks: await Promise.all(readAsks().map(async ask => {
          const { ask: shown, asker } = await inConversation(ask, readEngine);
          return listedAsk(shown, info.name ?? os.hostname(), asker);
        })),
      });
      if (route === "kuvo/asks") return yield* json(200, await read());
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      let last = "";
      while (!signal?.aborted) {
        const line = JSON.stringify(await read());
        if (line !== last) {
          yield { body: Buffer.from(line + "\n") };
          last = line;
        }
        await new Promise(done => setTimeout(done, 1000));
      }
      return;
    }
    const answering = route.match(/^kuvo\/asks\/([^/]+)$/);
    if (answering) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const ask = readAsks().find(each => each.id === decodeURIComponent(answering[1]));
      if (!ask) return yield* json(404, {});
      const given = parsed(request.body);
      const answer = askAnswer(ask, given);
      if (!answer) return yield* json(400, given?.saved != null ? { message: "Saved passwords are on your Mac: type this one." } : {});
      return yield* json((await answerAsk(ask.id, answer)) ? 200 : 503, {});
    }
    // COMPAT(0.7 engine-stop): `kuvo/engine/start`, for an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
    // (No Stop: a machine's engine keeps running, and up to date. Start is for one an older Mac stopped.)
    const control = route.match(/^kuvo\/engine\/(start|restart)$/);
    if (control) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      const { status, message } = await engineControl(control[1]);
      return yield* json(status, message ? { message } : {});
    }
    if (route === "kuvo/sign-in/return") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      return yield* loadSignInReturn(request.body, signal);
    }
    // The coding agents' sessions, accounts and Auto, through their bridge, as the engine's go
    // to it; never where the engine is, nor an agent's update.
    if (request.path.startsWith(AGENTS)) {
      const path = request.path.slice(AGENTS.length);
      if (!agentsAllowed(path, request.method)) return yield* text(403, "That isn't available over the link.");
      const target = bridge();
      if (!target) {
        yield { head: { status: 503, headers: { "content-type": "application/json" } } };
        yield { body: Buffer.from(JSON.stringify({ message: "The coding agents aren't running on this machine." })) };
        return;
      }
      return yield* forward(target, path, request, signal, agentsAllowed, namingHere(readEngine), () => "The coding agents aren't answering on this computer. Try again in a moment.");
    }
    // The plans whose sign-in ran out and couldn't be renewed (a run on one was refused), and
    // signing out of one, as Settings › Accounts' Disconnect does (PROTOCOL.md, "kuvo/accounts").
    if (route === "kuvo/accounts/ended" || /^kuvo\/accounts\/[^/]+\/forget$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      if (!engine?.port) return yield* json(503, { message: "The engine isn't running." });
      if (route === "kuvo/accounts/ended") {
        if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* json(405, {});
        return yield* json(200, { providers: await endedProviders(engine).catch(() => []) });
      }
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id = null;
      try { id = decodeURIComponent(route.slice("kuvo/accounts/".length, -"/forget".length)); } catch {}
      if (!id || id.includes("/")) return yield* json(404, {});
      return yield* ((await forgetPlan(engine, id).catch(() => false)) ? json(200, {}) : json(404, {}));
    }
    // This machine's sign-ins, listed (`api/credential` has what each is signed in with too).
    if (route === "kuvo/accounts/credentials") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      let engine;
      try {
        engine = readEngine();
      } catch {
        return yield* text(503, "The engine isn't running.");
      }
      let listed;
      try {
        const response = await fetch(`http://127.0.0.1:${engine.port}/api/credential`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
          signal,
        });
        if (!response.ok) return yield* text(502, "The engine didn't answer.");
        listed = ((await response.json())?.data ?? []).map(credential => ({
          id: String(credential.id), integrationID: String(credential.integrationID), label: String(credential.label ?? ""), active: Boolean(credential.active),
        }));
      } catch {
        return yield* text(502, "The engine didn't answer.");
      }
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ credentials: listed })) };
      return;
    }
    // New bots and group chats, made here as New Bot and New Group Chat make them on the Mac,
    // which takes them in when it next connects.
    // The library followed: a line now, and again as it changes, from a route here, a peer's copy
    // met, or another process (a Mac's `box personalities` over SSH, the bridge beside this box).
    if (route === "kuvo/personalities/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ personalities: readPersonalities().personalities }), personalityFollowers, signal, { folders: [path.dirname(PERSONALITIES_FILE)], recursive: false });
    }
    // The library whole, and another computer's copy met with it: for the app beside this box only
    // (it signs the library for your other computers), never a phone.
    if (route === "kuvo/personalities/document" || route === "kuvo/personalities/take") {
      if (!request.fromApp) return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
      const method = request.method.toUpperCase();
      if (route === "kuvo/personalities/document") return yield* method === "GET" ? json(200, personalitiesDocument()) : json(405, {});
      if (method !== "POST") return yield* json(405, {});
      const [status, value] = takePersonalitiesDocument(parsed(request.body), readEngine, readBridge);
      return yield* json(status, value);
    }
    // The personalities you make, this machine's copy of the library.
    const personality = route.match(/^kuvo\/personalities(?:\/([^/]+))?$/);
    if (personality) {
      let id;
      try { id = personality[1] === undefined ? undefined : decodeURIComponent(personality[1]); } catch { return yield* json(404, {}); }
      const [status, value] = answerPersonalities(request.method.toUpperCase(), id, parsed(request.body));
      // Its bots with it are told what it is now, or that it's gone.
      if (status === 200 && id !== undefined) retellBots([id], readEngine, readBridge).catch(() => {});
      return yield* json(status, value);
    }
    if (route === "kuvo/bots/templates") {
      const kit = readKit();
      if (!kit) return yield* json(409, { message: NO_KIT });
      return yield* json(200, botTemplates(kit, info.name));
    }
    if (request.method.toUpperCase() === "POST" && route === "kuvo/bots") {
      const { status, value } = await makeBot(parsed(request.body), readEngine, bridge, info.name, signal);
      return yield* json(status, value);
    }
    // The box's projects, as the sidebar and Edit Project change them (PROTOCOL.md, "Projects").
    if (route === "kuvo/projects" || route === "kuvo/projects/events") return yield* answerProjects(request, readEngine, readBridge, signal);
    // Its worktrees' records followed: a line now, and again each time they change (one made for
    // a phone, renamed, removed), as a Mac shows them.
    if (route === "kuvo/worktrees/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ worktrees: readWorktrees() }), worktreeFollowers, signal);
    }
    // Settings › Worktrees, and a new session's worktree (PROTOCOL.md, "Worktrees").
    if (/^kuvo\/worktrees(\/(remove|record|where))?$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      if (route === "kuvo/worktrees/where") {
        if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
        return yield* json(200, await worktreesWhere(new URLSearchParams(request.path.split("?")[1] ?? "").get("directory"), engine, signal));
      }
      const { status, value } = await answerWorktrees(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
      return yield* json(status, value);
    }
    // Its bots' folders' settings as their keys and this box's integrations are now, as a client
    // asks after it changes them (before the bot keys' route, which would take "keys" for a bot).
    if (route === "kuvo/bots/keys/refresh") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      try {
        await refreshBotsKeys();
      } catch (error) {
        if (!(error instanceof KeysUnavailable)) throw error;
        return yield* json(503, { message: error.message });
      }
      return yield* json(200, {});
    }
    // A bot's keys of its own, as Edit Bot shows and changes them.
    if (/^kuvo\/bots\/[^/]+\/keys(\/[^/]+)?$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerBotKeys(request.method.toUpperCase(), request.path, parsed(request.body), engine);
      return yield* json(status, value);
    }
    // A conversation here carried on with the coding agents here, as picking one of their models
    // in it does.
    const toAgents = route.match(/^kuvo\/sessions\/([^/]+)\/agents$/);
    if (toAgents) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id;
      try { id = decodeURIComponent(toAgents[1]); } catch { return yield* json(404, { message: "That conversation isn’t there any more." }); }
      const { status, value } = await carryToAgents(id, parsed(request.body)?.model, readEngine, bridge(), signal);
      return yield* json(status, value);
    }
    // A bot here changed as Edit Bot changes it, or deleted as Delete Bot… deletes it.
    const oneBot = route.match(/^kuvo\/bots\/([^/]+)$/);
    if (oneBot && ["PATCH", "DELETE"].includes(request.method.toUpperCase())) {
      let id;
      try {
        id = decodeURIComponent(oneBot[1]);
      } catch {
        return yield* json(404, { message: "That bot isn’t there any more." });
      }
      const { status, value } = request.method.toUpperCase() === "PATCH"
        ? await changeBot(id, parsed(request.body), readEngine, bridge, info.name, signal)
        : await deleteBot(id, readEngine, bridge, signal);
      return yield* json(status, value);
    }
    // The group chats that live here (`kuvo/groups`), from the coding agents' bridge, which runs them.
    if (GROUP_ROUTE.test(route)) {
      const target = bridge();
      if (!target) return yield* groupJSON(503, { message: IS_MAC ? "Group chats on this Mac are starting. Try again in a moment." : "Group chats run with the coding agents' bridge, which isn't running on this machine." });
      // Who a message names with "&" is worked out there, from the list as it is now: worked out
      // again meanwhile, and waited for (two seconds at most) only when a name after "&" isn't
      // there yet, as a message from a phone (`namingHere`).
      if (request.method.toUpperCase() === "POST" && route.split("/").length === 3 && Buffer.from(request.body ?? []).includes("&")) {
        let text = "";
        try { text = JSON.parse(Buffer.from(request.body).toString())?.text; } catch {}
        const working = refreshOwnShared(readEngine);
        if (typeof text === "string" && nameMissing(text, listedAgents().agents)) {
          await Promise.race([working, new Promise(resolve => setTimeout(resolve, 2000).unref?.())]);
        }
      }
      return yield* forwardGroups(target, route, request, signal);
    }
    // A bot brought here from another computer, made this box's (Move to Computer).
    const arrived = route.match(/^kuvo\/bots\/([^/]+)\/arrived$/);
    if (arrived) {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      let id;
      try { id = decodeURIComponent(arrived[1]); } catch { return yield* json(404, { message: "That bot isn’t there any more." }); }
      const { status, value } = await settleBot(id, readEngine, bridge, info.name);
      return yield* json(status, value);
    }
    // Its bots told what they are now where that changed, as its app asks after a change to its kit
    // (your personalities, on a Mac).
    if (route === "kuvo/bots/retell") {
      if (request.method.toUpperCase() !== "POST") return yield* json(405, {});
      for (const read of [readEngine, readBridge]) {
        let target = null;
        try { target = read(); } catch {}
        if (target?.port) await freshenBots(target);
      }
      return yield* json(200, {});
    }
    // Its bots followed: a line now, and again as they change (made, changed, deleted, a wake-up
    // added or sent), as a client shows them.
    if (route === "kuvo/bots/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ bots: listBots(info.name) }), botFollowers, signal, { folders: [BOTS] });
    }
    // This machine's bots and wake-ups, from their folders.
    if (route === "kuvo/bots") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      // A Mac's read (`?memory=1`): with each one's job as its memory has it now.
      const memory = /(^|[?&])memory=1(&|$)/.test(request.path.split("?")[1] ?? "");
      yield { body: Buffer.from(JSON.stringify({ bots: listBots(info.name, { memory }) })) };
      return;
    }
    if (route === "kuvo/wakes") {
      if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return yield* text(405, "Read them with GET.");
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ sessions: listWakes() })) };
      return;
    }
    // Every conversation's wake-ups and watches followed: a line now, and again as they change
    // (added, fired, canceled, paused), as a Mac shows them (PROTOCOL.md, "Wake-ups").
    if (route === "kuvo/wakes/events") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => ({ sessions: allWakes() }), wakeFollowers, signal, { folders: [BOTS, SESSION_WAKES] });
    }
    const wakes = route.match(/^kuvo\/wakes\/([^/]+)(?:\/(cancel|now|pause|watch))?$/);
    if (wakes) {
      let session;
      try {
        session = decodeURIComponent(wakes[1]);
      } catch {
        return yield* text(404, "No such session.");
      }
      return yield* answerWakes(session, wakes[2], request, readEngine, bridge, signal);
    }
    const stop = route.match(/^kuvo\/shell\/([^/]+)\/stop$/);
    if (!stop && !allowed(request.path, request.method)) return yield* text(403, "That isn't available over the link.");
    let engine = null;
    try {
      engine = readEngine();
    } catch {
      // A coding agent's command stops without the engine.
      if (!stop || !bridge()) return yield* json(503, { message: engineDown() });
    }
    if (stop) {
      if (request.method.toUpperCase() !== "POST") return yield* text(405, "Stop it with POST.");
      const headers = {};
      const given = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
      for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
      // The engine's, else a coding agent's, through their bridge.
      const runners = [engine, bridge()].filter(Boolean);
      return yield* stopShell(decodeURIComponent(stop[1]), runners, headers, signal);
    }
    return yield* forward(engine, request.path, request, signal, allowed, namingHere(readEngine));
  };
}

// Why the engine can't be asked now: stopped on purpose (until it's started, from anywhere); on a
// Mac, given up on, with why (the app's `run/engine-stopped`, until it starts it again); on a
// machine, stopping again and again, with its keeper's next start a while away (`run/engine.retry`,
// when, in seconds since 1970); or starting (again).
const engineDown = () => {
  // COMPAT(0.7 engine-stop): an engine an older Mac's Stop left down. Goes 3 months after 0.8.0.
  if (fs.existsSync(path.join(RUN, "stopped"))) return "The engine isn't running.";
  if (IS_MAC) {
    let why = "";
    try { why = fs.readFileSync(path.join(RUN, "engine-stopped"), "utf8").trim(); } catch {}
    if (why) return `This Mac's engine isn't running. ${why} Try Again in Kuvo Code on the Mac starts it.`;
    return "This Mac's engine is starting. Try again in a moment.";
  }
  const retry = Number(fs.existsSync(path.join(RUN, "engine.retry")) ? fs.readFileSync(path.join(RUN, "engine.retry"), "utf8").trim() : NaN);
  // (The keeper looks every fifteen seconds, and a start takes a few more.)
  const minutes = Math.ceil((retry - Date.now() / 1000) / 60);
  if (Number.isFinite(retry) && retry - Date.now() / 1000 > 30) {
    return `This machine's engine keeps stopping. It's started again in ${minutes === 1 ? "about a minute" : `about ${minutes} minutes`}.`;
  }
  return "This machine's engine is starting. Try again in a moment.";
};

// COMPAT(0.7 engine-stop): `start`, for an engine an older Mac's Stop left down (`restart` stays). Goes 3 months after 0.8.0.
// The engine here started, or started over, by the box's own tool (`bin/kuvo-start`, as the Mac
// has it do): `start` for one an older Mac's Stop left down (until it's started, from anywhere),
// and `restart`. This bridge stays up through each. Answered at once (202), and the phone sees it
// come up as `kuvo/info` says (`running`, `started`).
export async function engineControl(command) {
  const start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return { status: 409, message: "Kuvo Code hasn't set this machine up yet." };
  // Started from a Mac once, which keeps how (`run/launch.env`) and what starts it (`bin/kuvo-launch`).
  if (![path.join(K, "bin", "kuvo-launch"), path.join(RUN, "launch.env")].every(file => fs.existsSync(file))) {
    return { status: 409, message: "Start it once from Kuvo Code on your Mac." };
  }
  // Not with what runs this bridge (the engine's runtime as Bun), which would make `opencode
  // serve` a script to look for.
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const workspace = path.join(K, "workspace");
  const options = { cwd: fs.existsSync(workspace) ? workspace : K, env: environment };
  try {
    const child = spawn("sh", [start, command], { ...options, detached: true, stdio: "ignore" });
    lastToolRun = { child, ended: new Promise(resolve => { child.on("exit", resolve); child.on("error", resolve); }) };
    child.unref();
  } catch {
    return { status: 503, message: "It couldn't be started." };
  }
  return { status: 202 };
}

// The box's tool, as last started here, ending as it does (what a test waits for).
let lastToolRun = null;
export const toolRun = () => {
  lastToolRun?.child.ref();
  return lastToolRun?.ended ?? Promise.resolve();
};

// `kuvo/sign-in/return` with {"url"}: where a sign-in's page sent the browser back to this
// machine (an MCP server's, or a coding agent's), which a phone can't load, loaded here as the
// browser would have: only this machine's own address (`signInReturn`), and no further than it
// answers (a redirect isn't followed). Answers with the status it got: 2xx or 3xx, it took it.
async function* loadSignInReturn(body, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let given = {};
  try {
    given = JSON.parse(Buffer.from(body ?? []).toString("utf8") || "{}");
  } catch {}
  const url = signInReturn(given?.url);
  if (!url) return yield* json(400, { message: "That isn't an address a sign-in returns to on this computer." });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 15_000);
  const cancel = () => stop.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await fetch(url, { redirect: "manual", signal: stop.signal });
    await response.arrayBuffer().catch(() => {});
    return yield* json(200, { status: response.status });
  } catch {
    return yield* json(502, { message: "Nothing on this computer took it. Start the sign-in again." });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

// Stops a command an agent runs (the engine's, or a coding agent's through their bridge: the first
// of `runners` that has it): SIGTERM to its process group, here, so it sees it end and tells the
// agent, with what it printed. Its own remove deletes the output too, and the agent hears the
// command was never found, so it's only for when the signal can't be sent.
async function* stopShell(id, runners, headers, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let job, url;
  for (const runner of runners) {
    url = `http://127.0.0.1:${runner.port}/api/shell/${encodeURIComponent(id)}`;
    const asking = { ...headers, authorization: `Basic ${Buffer.from(`opencode:${runner.password}`).toString("base64")}` };
    try {
      const response = await fetch(url, { headers: asking, signal });
      if (response.ok) job = (await response.json()).data;
    } catch {}
    if (job) {
      headers = asking;
      break;
    }
  }
  if (!job || job.status !== "running") return yield* json(404, {});
  if (Number.isInteger(job.pid) && job.pid > 1) {
    try {
      process.kill(-job.pid, "SIGTERM");
      return yield* json(200, { stopped: "signal" });
    } catch {}
  }
  try {
    const response = await fetch(url, { method: "DELETE", headers, signal });
    if (response.ok) return yield* json(200, { stopped: "removed" });
  } catch {}
  return yield* json(404, {});
}

// What LinkHost runs to open a socket: the engine's WebSocket at that path, with its password.
export function engineConnect(readEngine = readEngineFile) {
  return (request, phone, events) => {
    let ended = false;
    const end = error => {
      if (ended) return;
      ended = true;
      events.end(error);
    };
    const refuse = words => {
      queueMicrotask(() => end(new Error(words)));
      return { send() {}, close() {} };
    };
    if (!socketAllowed(request.path)) return refuse("That isn't available over the link.");
    let engine;
    try {
      engine = readEngine();
    } catch {
      return refuse("The engine isn't running.");
    }
    phoneHere();
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
    const directory = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "x-opencode-directory")?.[1];
    if (directory) headers["x-opencode-directory"] = directory;
    const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/${canonicalPath(request.path)}`, { headers });
    socket.binaryType = "arraybuffer";
    socket.onopen = () => events.open();
    socket.onmessage = event => typeof event.data === "string" ? events.text(Buffer.from(event.data)) : events.binary(Buffer.from(event.data));
    socket.onerror = () => end(new Error("The engine closed it."));
    socket.onclose = () => end();
    return {
      send: data => { if (socket.readyState === 1) socket.send(data.toString("utf8")); },
      close: () => {
        ended = true;
        try { socket.close(); } catch {}
      },
    };
  };
}

// COMPAT(0.7 leave-running): `run/link.seen`, which a 0.7 Mac reads before it stops a machine's engine as it quits. Goes 3 months after 0.8.0.
// When a phone last used this machine, in `run/link.seen`: a Mac with Kuvo Code 0.7.x leaves the
// engine running as it quits while one has in the last week (later ones always do), so
// the machine's sessions and bots are there whenever it asks; a phone lost or unpaired elsewhere
// stops keeping it after that.
export const SEEN_FILE = path.join(RUN, "link.seen");
export const KEEP_FOR = 7 * 24 * 60 * 60_000;
let seen = 0;
function phoneHere() {
  if (Date.now() - seen < 5 * 60_000) return;
  seen = Date.now();
  try {
    const now = new Date();
    if (fs.existsSync(SEEN_FILE)) {
      fs.utimesSync(SEEN_FILE, now, now);
    } else {
      fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
      fs.writeFileSync(SEEN_FILE, "", { mode: 0o600 });
    }
  } catch {}
}

// No phone is paired any more: none keeps the engine up.
export function forgetPhones() {
  seen = 0;
  try {
    fs.rmSync(SEEN_FILE, { force: true });
  } catch {}
}

export function phoneSeenLately(file = SEEN_FILE, now = Date.now()) {
  try {
    return now - fs.statSync(file).mtimeMs < KEEP_FOR;
  } catch {
    return false;
  }
}

// ---- This machine's bots and wake-ups, from their folders ----

// What the Mac answers for them (PROTOCOL.md, `kuvo/bots` and `kuvo/wakes`), answered here from
// the folders the app keeps on the machine, so a phone has them with the Mac closed: a bot's
// description (`bot.json`, which the app writes from its list), its session, and the wake-ups,
// watches and pause that `kuvo-wake` keeps beside them.
// A Mac's box finds them where its app keeps them, as the engine does (KUVO_BOTS, KUVO_WAKES, and the
// app's own kuvo-wake); a machine's, in its folder.
const BOTS = process.env.KUVO_BOTS || path.join(K, "bots");
// This Mac's box (BoxProcess says so as it starts it): its bots are the Mac's own, made with the
// kit its app gives it and told they run on this Mac; it names no machine, keeps no notes for a
// Mac to take in, and goes by the Mac's own clock.
const ON_MAC = process.env.KUVO_BOX === "mac";
// This box's computer, as what it says names it.
const HERE = ON_MAC ? "this Mac" : "this machine";
const SESSION_WAKES = process.env.KUVO_WAKES || path.join(K, "wakes");
const WAKE_COMMAND = process.env.KUVO_WAKE_COMMAND || path.join(K, "bin", "kuvo-wake");
// The version of `bot.json` this reads (the app's `Bot.Descriptor`).
const DESCRIPTION = 1;
const WAKE_MARKER = "[Wake-up] ";

const textOf = file => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const listOf = folder => {
  try {
    return fs.readdirSync(folder);
  } catch {
    return [];
  }
};
// On one line, cut to `limit` characters, as the Mac lists a machine's.
const oneLine = (text, limit) => Array.from(String(text).replace(/[\t\r\n]/g, " ")).slice(0, limit).join("");

// How often a wake-up comes back, as its name says (the app's Wakes.Repeat): 30m, 2h, 1d, 1w or
// weekdays, within a year; null for anything else.
export function repeatText(text) {
  if (text === "weekdays") return text;
  const match = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text ?? "");
  if (!match) return null;
  const count = Number(match[1]);
  const fits = { m: count >= 5 && count <= 525_600, h: count <= 8_760, d: count <= 366, w: count <= 52 }[match[2]];
  return fits ? text : null;
}

// A wake-up from its file's name (the app's Wakes.Pending): when it's due, in seconds since 1970,
// the letters that name it for good, and how often it comes back; null for another file.
export function wakeOf(name, note = "") {
  const [due, letters = "", ...more] = name.split("-");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(due ?? "")) return null;
  const repeating = more.join("-");
  return { id: name, due: Number(due), note, every: repeating ? repeatText(repeating.split("@")[0]) : null, letters };
}

/**
 * A conversation archived (or brought back) from a phone: its wake-ups wait while it's archived,
 * as WakeUps.setPaused has a Mac hold them, and come back with it. A hold of your own (`paused`)
 * stays; a move's (`moving`) becomes archiving's.
 */
export function holdArchived(session, archived) {
  if (!/^ses_[A-Za-z0-9]+$/.test(session)) return;
  const folder = path.join(SESSION_WAKES, session);
  const file = path.join(folder, "paused");
  const held = textOf(file);
  if (archived) {
    if (!fs.existsSync(folder) || (held !== null && held !== "moving")) return;
    fs.writeFileSync(file, "archived");
  } else if (held === "archived" || held === "") {
    fs.rmSync(file, { force: true });
  }
}

// The folder keeping a session's wake-ups: its bot's, or its own in `wakes`; null for none.
export function wakeFolder(session) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session)) return null;
  for (const id of listOf(BOTS)) {
    if ((textOf(path.join(BOTS, id, "session")) ?? "").trim() === session) return path.join(BOTS, id);
  }
  const own = path.join(SESSION_WAKES, session);
  return textOf(path.join(own, "session")) === null ? null : own;
}

// Each session here with a wake-up or a watch, as the Mac lists them in `kuvo/wakes`: its soonest
// wake-up and whether it watches. Bots' come with `kuvo/bots`.
export function listWakes() {
  const sessions = [];
  for (const name of listOf(SESSION_WAKES)) {
    const folder = path.join(SESSION_WAKES, name);
    const session = (textOf(path.join(folder, "session")) ?? "").trim();
    if (!session) continue;
    const { wakes, watches } = readWakes(folder);
    if (!wakes.length && !watches.length) continue;
    sessions.push({ session, ...(wakes.length ? { next: wakes[0].due } : {}), watching: watches.length > 0 });
  }
  return sessions;
}

// A folder's waiting wake-ups (soonest first), its watches, and whether you paused them: their
// notes and checks on a line each, or `whole`.
export function readWakes(folder, { whole = false } = {}) {
  const line = (text, limit) => whole ? text : oneLine(text, limit);
  const wakes = listOf(path.join(folder, "wakes"))
    .map(name => wakeOf(name, line(textOf(path.join(folder, "wakes", name)) ?? "", 400)))
    .filter(Boolean)
    .sort((a, b) => a.due - b.due);
  const watches = listOf(path.join(folder, "watches")).sort().map(letters => {
    const at = path.join(folder, "watches", letters);
    const check = textOf(path.join(at, "check")) ?? "";
    if (!check) return null;
    return { letters, every: (textOf(path.join(at, "every")) ?? "").trim(), check: line(check, 300), note: line(textOf(path.join(at, "note")) ?? "", 400) };
  }).filter(Boolean);
  return { wakes, watches, paused: fs.existsSync(path.join(folder, "paused")) };
}

// A wake-up as a client takes it.
const listedWake = ({ id, due, note, every }) => ({ id, due, note, every: every ?? undefined });

// Every conversation here with wake-ups, watches or a pause, a bot's or its own, whole: what a
// client keeps of them, followed (`kuvo/wakes/events`).
export function allWakes() {
  const sessions = [];
  const add = folder => {
    const session = (textOf(path.join(folder, "session")) ?? "").trim();
    if (!session) return;
    const { wakes, watches, paused } = readWakes(folder, { whole: true });
    if (wakes.length || watches.length || paused) sessions.push({ session, wakes: wakes.map(listedWake), watches, paused });
  };
  for (const id of listOf(BOTS)) add(path.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES)) add(path.join(SESSION_WAKES, name));
  return sessions;
}

// When `kuvo-wake fire` next has something to send, in seconds since 1970: the soonest wake-up of a
// conversation that isn't paused, or the time one that couldn't go is tried again; null for none.
export function nextWake() {
  let soonest = null;
  const look = folder => {
    if (fs.existsSync(path.join(folder, "paused")) || textOf(path.join(folder, "session")) === null) return;
    const [retry = 0] = (textOf(path.join(folder, ".retry")) ?? "").trim().split(/\s+/).map(Number);
    for (const name of listOf(path.join(folder, "wakes"))) {
      const due = wakeOf(name)?.due;
      if (due === undefined) continue;
      const at = Math.max(due, Number.isFinite(retry) ? retry : 0);
      if (soonest === null || at < soonest) soonest = at;
    }
  };
  for (const id of listOf(BOTS)) look(path.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES)) look(path.join(SESSION_WAKES, name));
  return soonest;
}

/** This computer's wake-ups and watches sent by its box, as a machine's keeper sends its own with
 * the same `kuvo-wake fire` (which keeps two runs apart itself): at the soonest one's time, at
 * least each minute (for watches), and again as they change, here or by an agent's kuvo-wake. One
 * still due after a run that was due before it (it couldn't go, or its conversation is archived)
 * waits for the next minute; one that came due during it goes right after. The returned function
 * stops it: nothing runs after, and its promise settles once a run already going is over. */
export function sendWakes() {
  let timer = null, settling = null, running = false, again = false, stopped = false, started = 0, said = false, over = null, ending = null;
  const schedule = (afterFire = false) => {
    if (stopped) return;
    clearTimeout(timer);
    const due = nextWake(), now = Date.now() / 1000;
    const missed = afterFire && due !== null && due <= now && due < started;
    const wait = due === null || missed ? 60_000 : Math.min(60_000, Math.max(500, (due + 1 - now) * 1000));
    timer = setTimeout(fire, wait);
  };
  const fire = () => {
    if (stopped) return;
    if (running) return void (again = true);
    running = true;
    started = Date.now() / 1000;
    execFile(WAKE_COMMAND, ["fire", BOTS, path.join(RUN, "engine.json")], error => {
      running = false;
      if (error?.code === "ENOENT" && !said) {
        said = true;
        console.error(`Wake-ups can't be sent: there's no kuvo-wake at ${WAKE_COMMAND}.`);
      }
      if (stopped) {
        over?.();
      } else if (again) {
        again = false;
        fire();
      } else {
        schedule(true);
      }
    });
  };
  // A change, here or beside it, once the folders settle (a wake-up is a file or two).
  const changed = () => {
    clearTimeout(settling);
    settling = setTimeout(() => schedule(), 200);
  };
  wakeFollowers.add(changed);
  const watching = watchFolders([BOTS, SESSION_WAKES], changed);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(settling);
    wakeFollowers.delete(changed);
    watching.close();
    if (!running) return Promise.resolve();
    return ending ??= new Promise(resolve => { over = resolve; });
  };
}

// Those following them (`kuvo/wakes/events`), told of each change made here; `kuvo-wake fire`'s
// as the system sees their folders change.
const wakeFollowers = new Set();
const wakesChanged = () => {
  for (const tell of wakeFollowers) tell();
};

// ---- Group chats that live here ----

// What a client asks of them (PROTOCOL.md, `kuvo/groups`): the list and one chat (read, or followed
// as they change), who can be in one, and what it does (makes, changes or deletes one, writes to it,
// stops it, lets it keep going, looks at it, takes a message back, starts the work a wrap-up split
// up). The coding agents' bridge that runs them answers in the shapes a client takes, with every
// rule of what can be: passed on as it answers.
const GROUP_ROUTE = /^kuvo\/groups(?:\/(events|joinable|grp_[a-z0-9]+(?:\/(?:events|stop|keep-going|viewed|undo|start))?))?$/;

async function askGroups(target, method, route, body, signal) {
  const response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/groups${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value };
}

// A client's group chat route, to the bridge that runs them and back as it answers (a followed
// one as its lines come). Not answering now: 503, to ask again, never taken as having none.
async function* forwardGroups(target, route, request, signal) {
  const method = request.method.toUpperCase();
  const sends = !["GET", "HEAD", "DELETE"].includes(method);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/link/groups${route.slice("kuvo/groups".length)}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(sends ? { "content-type": "application/json" } : {}) },
      body: sends ? Buffer.from(request.body ?? []) : undefined,
      signal,
    });
  } catch {
    if (signal?.aborted) return;
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  yield { head: { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } } };
  try {
    for await (const chunk of response.body ?? []) yield { body: Buffer.from(chunk) };
  } catch {}
}

const groupsNotAnswering = () => (IS_MAC ? "Group chats on this Mac aren’t answering. Try again in a moment." : "The coding agents’ bridge here isn’t answering. Try again in a moment.");

function* groupJSON(status, value) {
  yield { head: { status, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify(value)) };
}

// The biggest file `kuvo/file` sends.
export const FILE_LIMIT = 25 * 1024 * 1024;

const TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
  svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg",
  wav: "audio/wav", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", css: "text/css", js: "text/javascript",
};

// `kuvo/file?uri=<file:// URI>`: a file on this machine, as an agent's reply or tool names it:
// its bytes with its type; 404 with a message for one that isn't there (or isn't a file), 413
// over FILE_LIMIT.
async function* fileAt(requestPath, json) {
  const query = requestPath.includes("?") ? requestPath.slice(requestPath.indexOf("?") + 1) : "";
  const uri = new URLSearchParams(query).get("uri");
  let file;
  try {
    file = uri ? fileURLToPath(uri) : undefined;
  } catch {}
  if (!file) return yield* json(400, { message: "That isn’t a file:// address." });
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {}
  if (!stat?.isFile()) return yield* json(404, { message: "That file isn’t there anymore." });
  if (stat.size > FILE_LIMIT) return yield* json(413, { message: "That file is too big to open here." });
  const type = TYPES[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
  // Opened before it's answered: one that can't be read says so, with no path in it.
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch (error) {
    const refused = ["EACCES", "EPERM"].includes(error?.code);
    return yield* json(refused ? 403 : 404, { message: refused ? "That file can’t be opened here." : "That file isn’t there anymore." });
  }
  yield { head: { status: 200, headers: { "content-type": type, "content-length": String(stat.size) } } };
  // In pieces, as the engine's bodies go.
  try {
    for await (const piece of handle.createReadStream({ highWaterMark: 32 * 1024 })) yield { body: piece };
  } finally {
    await handle.close().catch(() => {});
  }
}

// A bot that lives here, as its folder has it now: its description (as the app last wrote it, or
// as changed here), its conversation, and whether that runs with the coding agents; null for one
// without a description (made before them, until the Mac connects) or a conversation.
function botHere(id) {
  if (typeof id !== "string" || !/^bot_[A-Za-z0-9]+$/.test(id)) return null;
  const folder = path.join(BOTS, id);
  let described;
  try {
    described = JSON.parse(textOf(path.join(folder, "bot.json")) ?? "");
  } catch {
    return null;
  }
  const session = (textOf(path.join(folder, "session")) ?? "").trim();
  if (described?.kuvo !== DESCRIPTION || described.id !== id || typeof described.name !== "string" || !session) return null;
  return { folder, described, session, agents: (textOf(path.join(folder, "via")) ?? "").trim() === "bridge" };
}

// On its way to another computer: a move holds its wake-ups (the Mac's Moves.hold), and nothing
// reaches it or changes here until it's there, as on the Mac.
const isMoving = folder => (textOf(path.join(folder, "paused")) ?? "").trim() === "moving";
const MOVING = "It’s moving to another computer. Try again once it’s there.";

const isModel = model => Boolean(model) && typeof model.id === "string" && typeof model.providerID === "string";
const sameModel = (a, b) => (a?.id ?? null) === (b?.id ?? null) && (a?.providerID ?? null) === (b?.providerID ?? null) && (a?.variant ?? null) === (b?.variant ?? null);

// This machine's bots, as the Mac lists them in `kuvo/bots`: each by its session, with its name,
// look, job, personality and model as the app last described it (or as changed here), and what its
// folder says now (paused, its next wake-up, how many things it watches, whether it runs with the
// coding agents). One without a description or a session isn't listed. With `memory`, each also
// with `memoryJob`, its job as its memory has it now (`{line, section}`, empty for none), left out
// when its memory can't be read.
export function listBots(machine, { memory = false } = {}) {
  const bots = [];
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (!here) continue;
    const { folder, described, session, agents } = here;
    const { wakes, watches, paused } = readWakes(folder);
    const job = jobOf(here);
    bots.push({
      created: String(described.created ?? ""),
      bot: {
        id,
        session,
        name: described.name,
        look: described.look,
        machine: ON_MAC ? undefined : machine || undefined,
        job: job.line,
        jobDetails: job.details,
        paused,
        wakes: wakes.length ? Math.min(...wakes.map(wake => wake.due)) : undefined,
        watching: watches.length,
        agents,
        personality: typeof described.personality === "string" ? described.personality : undefined,
        model: isModel(described.model) ? described.model : undefined,
        // Its folder (its memory, wake-ups and workspace), and the project it works in, as this
        // box names them; when it was made.
        folder,
        project: typeof described.project === "string" ? described.project : undefined,
        created: typeof described.created === "string" ? described.created : undefined,
        // What a Mac of an earlier version reads a machine's bots' jobs by.
        memoryJob: memory && !ON_MAC ? { line: job.line, section: job.details } : undefined,
      },
    });
  }
  // In the order they were made, as the Mac's list is.
  return bots.sort((a, b) => a.created.localeCompare(b.created)).map(entry => entry.bot);
}

// A bot's job, kept in its folder (`job.json`): `{line, details}`, what it does in a few words (what
// shows under its name) and all of it, which the bot sets with its set_job tool and Edit Bot can
// change (`PATCH kuvo/bots/<id>` with `job`). Its memory is its own to write as it likes.
const JOB_FILE = "job.json";
const MOST_JOB_LINE = 200, MOST_JOB_DETAILS = 8000;

function readJob(folder) {
  try {
    const kept = JSON.parse(textOf(path.join(folder, JOB_FILE)) ?? "");
    return isObject(kept) ? { line: typeof kept.line === "string" ? kept.line : "", details: typeof kept.details === "string" ? kept.details : "" } : null;
  } catch {
    return null;
  }
}

function writeJob(here, job) {
  const file = path.join(here.folder, JOB_FILE);
  fs.writeFileSync(`${file}.new`, JSON.stringify({ line: job.line, details: job.details, updated: stamp() }, null, 2));
  fs.renameSync(`${file}.new`, file);
  // COMPAT(0.7 bot-json-job): the job's line in `bot.json` too, where an older Mac reads it. Goes 3 months after 0.8.0.
  // Its description says it in a few words too, for what reads only that (a Mac of an earlier version).
  if ((here.described.job ?? "") !== job.line) {
    const described = path.join(here.folder, "bot.json");
    fs.writeFileSync(`${described}.new`, JSON.stringify({ ...here.described, job: job.line }, null, 2));
    fs.renameSync(`${described}.new`, described);
    here.described = { ...here.described, job: job.line };
  }
}

// A bot's job. One from before bots kept it here is taken once from where it was: its memory's
// Job section, as bots kept it, which stays in its memory as it is; or, without one, what Edit Bot
// wrote before memories kept jobs (in the app's list, `bots.json`, for one of this Mac's; in its
// description, for a machine's).
function jobOf(here) {
  const kept = readJob(here.folder);
  if (kept) return kept;
  const memory = jobInMemory(textOf(path.join(here.folder, "MEMORY.md")) ?? "");
  // Without one in its memory, what its description said (a Mac kept a job Edit Bot gave it there).
  let job = memory ? { line: memory.line, details: detailsBeyond(memory.line, memory.section) } : { line: plainName(here.described.job ?? ""), details: "" };
  if (ON_MAC && !memory) {
    const listed = macListed().find(each => each?.id === here.described.id);
    if (listed && listed.jobInMemory !== true) job = { line: plainName(listed.job ?? ""), details: detailsBeyond(plainName(listed.job ?? ""), listed.instructions) };
  }
  // Not while it moves: its folder is the move's until it's there.
  if (!isMoving(here.folder)) try { writeJob(here, job); } catch {}
  return job;
}

// This Mac's app's list of its bots (`bots.json`, beside their folders), for a job from before:
// read only for a bot whose job isn't kept yet, once each.
function macListed() {
  try {
    const listed = JSON.parse(textOf(path.join(path.dirname(BOTS), "bots.json")) ?? "[]");
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

// Every bot's job kept in its folder, for one from before (as the box starts): what reads a bot's
// folder without asking the box (the coding agents' bridge, for group chats) finds it there.
export function keepJobs() {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (here) jobOf(here);
  }
}

// A job as a bot or Edit Bot gives it: its line on one line, as it shows under the bot's name
// (Bots' `jobLine`), and its details as they are. An error's words for one that can't be.
function givenJob(given) {
  if (!isObject(given) || (given.line !== undefined && typeof given.line !== "string") || (given.details !== undefined && typeof given.details !== "string")) {
    return { error: "A job is {line, details}: what it does in a few words, and the details." };
  }
  const line = jobLine(plainName(given.line ?? ""));
  const details = trimmed(given.details ?? "");
  if ([...line].length > MOST_JOB_LINE) return { error: "Say what it does in a few words: that line is too long." };
  if ([...details].length > MOST_JOB_DETAILS) return { error: "That job is too long to keep: shorten its details." };
  return { job: { line, details } };
}

// ---- Bots and group chats made here ----

// What New Bot needs here, which the Mac gives the machine as it connects (Bots.MachineKit), and
// what's said while there's none.
const NO_KIT = ON_MAC ? "Kuvo Code is still setting up bots on this Mac. Try again in a moment." : "Connect to this machine from your Mac once, then try again.";
const KIT_FILE = path.join(BOTS, "kit.json");
// The coding agents' providers (the Mac's OutsideAgents): a bot on one of theirs runs with them.
const AGENT_PROVIDERS = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"];
const runsWithAgents = model => model?.providerID === "auto" || AGENT_PROVIDERS.includes(String(model?.providerID ?? "").split("@")[0]);

// What a box makes its bots with and tells them, as Kuvo Code words it (KuvoLink's
// `Resources/bot-words.json`, which a client puts beside the bridge and a release brings): New
// Bot's templates, Kuvo Code's own personalities and the looks a bot can have, and what a bot is
// told, paragraph by paragraph, with ⟦place⟧, ⟦clock⟧ and ⟦browser⟧ for where it runs (`here`:
// this Mac, or a machine, by ⟦machine⟧ and ⟦timeZone⟧), ⟦jobLine⟧ and ⟦jobPart⟧ for its job
// (`job`), and ⟦name⟧, ⟦folder⟧ and ⟦personality⟧ for its own. Every box tells its bots its own
// release's words, whichever Mac connects.
const WORDS_FILE = path.join(K, "bin", "bot-words.json");

export function readWords(file = WORDS_FILE) {
  try {
    const words = JSON.parse(textOf(file) ?? "");
    return words?.kuvo === 1 && Array.isArray(words.templates) && Array.isArray(words.personalities) && Array.isArray(words.instructions)
      && isObject(words.looks) && isObject(words.here?.mac) && isObject(words.here?.machine) && isObject(words.job)
      && ["personalityWords", "projectNote", "identityNote", "memory", "greeting"].every(key => typeof words[key] === "string") ? words : null;
  } catch {
    return null;
  }
}

// What this box makes bots with: its own words, filled in for where it runs, with what's its own
// from the kit its Mac gave it (the name the Mac calls it, your time zone, the model a bot starts
// on, its projects, the rules a new conversation gets, and the personalities you made, until its
// library has them), or else its own. This Mac's box needs its app's kit; a machine makes bots
// without one. An older Mac's kit has its own words too, which aren't used: the box is never older
// than a Mac that connects.
export function readKit() {
  const words = readWords();
  const mac = readMacKit();
  if (!words || (ON_MAC && !mac)) return null;
  const timeZone = zoneOf(mac);
  const machine = (typeof mac?.machine === "string" && mac.machine) || readLink()?.id || os.hostname();
  const here = ON_MAC ? words.here.mac : words.here.machine;
  const fill = text => text.replace(/⟦(place|clock|browser)⟧/g, (_, key) => String(here[key] ?? ""))
    .replaceAll("⟦machine⟧", () => machine).replaceAll("⟦timeZone⟧", () => timeZone || "UTC");
  const told = each => words.personalityWords.replaceAll("⟦name⟧", () => each.name).replaceAll("⟦description⟧", () => each.description);
  return {
    kuvo: 1,
    templates: words.templates,
    // Kuvo Code's own, then the ones you made that a Mac's kit has.
    personalities: [
      ...words.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: false, instruction: told(each) })),
      ...(Array.isArray(mac?.personalities) ? mac.personalities.filter(each => each?.custom) : []),
    ],
    personalityWords: words.personalityWords,
    looks: words.looks,
    instructions: fill(words.instructions.join("\n\n")),
    job: { none: String(words.job.none ?? ""), line: String(words.job.line ?? ""), details: String(words.job.details ?? "") },
    projectNote: words.projectNote, identityNote: words.identityNote, memory: words.memory, greeting: words.greeting,
    startingModel: mac?.startingModel ?? null, projects: Array.isArray(mac?.projects) ? mac.projects : [], rules: Array.isArray(mac?.rules) ? mac.rules : [],
    timeZone: timeZone || "UTC",
    ...(typeof mac?.zoneinfo === "string" ? { zoneinfo: mac.zoneinfo } : {}),
  };
}

// What a Mac gave this box of what's its own (`bots/kit.json`), or null.
function readMacKit() {
  try {
    const kit = JSON.parse(textOf(KIT_FILE) ?? "");
    return kit?.kuvo === 1 ? kit : null;
  } catch {
    return null;
  }
}

// The time zone a machine's bots go by: yours, as a Mac's kit has it, or else the machine's own
// ("" on a Mac, whose bots go by its own clock).
function zoneOf(mac) {
  if (ON_MAC) return "";
  if (typeof mac?.timeZone === "string" && mac.timeZone) return mac.timeZone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

// A release's kit from before boxes had their words of their own (`bin/bot-kit.json`), gone once no
// release this box installed lists it (so its own files still look as it installed them).
function forgetOldKit() {
  const file = path.join(K, "bin", "bot-kit.json");
  try {
    const installed = JSON.parse(textOf(path.join(UPDATES, "installed.json")) ?? "{}");
    if (isObject(installed?.files) && "bin/bot-kit.json" in installed.files) return;
  } catch {}
  fs.rmSync(file, { force: true });
}

const parsed = body => {
  try {
    return JSON.parse(Buffer.from(body ?? "").toString() || "{}");
  } catch {
    return undefined;
  }
};

// As Swift writes dates: to the second.
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const newID = prefix => prefix + Array.from(crypto.randomBytes(10), byte => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
// A name as one line of plain text, as the Mac's name field has it.
const plainName = text => String(text ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").split(/\s+/).filter(Boolean).join(" ");

// `kuvo/bots/templates`, as the Mac's: what New Bot offers, the model a bot starts on here (by
// this machine's name, as its bots' `machine` has it), and its projects.
export function botTemplates(kit, machine) {
  return {
    templates: kit.templates.map(({ firstMessage: _, ...template }) => template),
    personalities: botPersonalities(kit).map(({ instruction: _, ...personality }) => personality),
    looks: kit.looks,
    startingModel: { [ON_MAC ? "mac" : machine || "machine"]: kit.startingModel ?? null },
    projects: boxProjects(kit).map(project => ({ ...project, machine: ON_MAC ? undefined : machine || undefined })),
  };
}

async function call(target, method, route, body, signal, folder) {
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
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.message || `It answered ${response.status}.`);
  return value?.data ?? value;
}

// What a bot is told, from the kit's words with its own name, folder, personality and project,
// and its job (`{line, section}`), for one that has one.
export function botInstructions(kit, name, folder, personality, project, job) {
  const working = Boolean(job?.section || job?.line);
  let text = kit.instructions.replaceAll("⟦name⟧", () => name).replaceAll("⟦folder⟧", () => folder);
  text = personality ? text.replace("⟦personality⟧", () => personality) : text.replace("\n⟦personality⟧\n", "");
  if (project) text = text.replace(`\n\n${kit.identityNote}`, () => `\n\n${kit.projectNote}\n\n${kit.identityNote}`);
  text = text.replace("⟦jobLine⟧", () => (job?.line ? kit.job.line.replace("⟦job⟧", () => job.line) : ""));
  const part = working ? kit.job.details.replace("⟦jobDetails⟧", () => job.section || job.line) : kit.job.none;
  return part ? text.replace("⟦jobPart⟧", () => part) : text.replace(/(\n\n)?⟦jobPart⟧/, "");
}

// A bot's job as its memory kept it before bots kept it in a record (Bots.job(inMemory:), held to
// `Agents/test/box-vectors.json`), for taking it from there once (`jobOf`): its line, what shows
// under its name, and its section, all of it; null for a memory without one.
const spaces = text => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
const trimmed = text => text.replace(/^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu, "");
function headingLevel(line) {
  const text = spaces(line);
  let marks = 0;
  while (marks < text.length && text[marks] === "#") marks++;
  if (marks < 1 || marks > 6) return undefined;
  const after = text.slice(marks);
  return after.length === 0 || after[0] === " " ? marks : undefined;
}
function isJobHeading(line) {
  const text = spaces(line);
  if (!text.startsWith("#")) return false;
  const title = spaces(text.replace(/^#+/, "")).toLowerCase();
  if (title === "job" || title === "my job" || title === "the job" || title.startsWith("job:")) return true;
  if (!title.startsWith("job ")) return false;
  const first = spaces(title.slice(4))[0];
  return first !== undefined && "-–—:(".includes(first);
}
// What a job heading says after "Job" ("Job: …", "Job — …", "Job (…)"), and whether after a colon.
function jobInHeading(line) {
  const title = spaces(spaces(line).replace(/^#+/, ""));
  if (!title.toLowerCase().startsWith("job")) return undefined;
  let rest = spaces(title.slice(3));
  const mark = rest[0];
  if (mark === undefined || !":-–—(".includes(mark)) return undefined;
  rest = spaces(rest.slice(1));
  if (mark === "(" && rest.endsWith(")")) rest = spaces(rest.slice(0, -1));
  return rest.length === 0 ? undefined : { text: rest, isColon: mark === ":" };
}
export function jobInMemory(text) {
  const all = text.split("\n");
  const start = all.findIndex(isJobHeading);
  if (start < 0) return null;
  const level = headingLevel(all[start]) ?? 1;
  let end = all.length;
  let inCode = false;
  for (let index = start + 1; index < all.length; index++) {
    const line = spaces(all[index]);
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inCode = !inCode;
      continue;
    }
    const other = inCode ? undefined : headingLevel(all[index]);
    if (other !== undefined && other <= level) {
      end = index;
      break;
    }
  }
  let section = trimmed(all.slice(start + 1, end).join("\n"));
  const inline = jobInHeading(all[start]);
  if (inline && (inline.isColon || section.length === 0)) section = [inline.text, section].filter(part => part.length > 0).join("\n");
  return { line: jobLine(section.split("\n").map(spaces).find(part => part.length > 0) ?? ""), section };
}

// A job's line as it shows under a bot's name: no list mark, bold or "Job:", its first sentence when
// it goes on, without the sentence's end ("Keeps the build green.").
export function jobLine(text) {
  let line = spaces(text);
  for (const mark of ["- ", "* ", "> "]) if (line.startsWith(mark)) line = line.slice(mark.length);
  line = line.replaceAll("**", "").replaceAll("__", "");
  if (line.toLowerCase().startsWith("job:")) line = line.slice(4);
  line = spaces(line);
  // Long: its first sentence. (In characters as Swift counts them, what you'd see.)
  if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].length > 48 && line.includes(". ")) line = line.slice(0, line.indexOf(". "));
  if (line.endsWith(".") && !line.endsWith("..")) line = line.slice(0, -1);
  return line;
}

// A bot's job as the first message to it, for your composer (BotTemplate.firstMessage): what it does
// in a few words, then how, then to start. Details that begin with the job's line say it once. ""
// for no job at all.
export function firstMessageOf(line, details) {
  const job = trimmed(String(line ?? ""));
  const rest = detailsBeyond(job, details);
  if (!job && !rest) return "";
  return [job ? `Your job, in a few words: ${job}.` : "", rest,
    "Start now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up."]
    .filter(part => part.length > 0).join("\n\n");
}

// A job's details without its line, for details that begin with it (as a memory's Job section did,
// and a template's or shared bot's job does): said once. A first line that goes on after the job's
// sentence keeps the rest.
function detailsBeyond(job, details) {
  const lines = trimmed(String(details ?? "")).split("\n");
  if (!job || !lines.length || jobLine(lines[0]) !== job) return lines.join("\n");
  const first = lines[0];
  const end = first.indexOf(". ");
  if (end >= 0 && spaces(first.slice(end + 2)) && jobLine(first.slice(0, end)) === job) lines[0] = spaces(first.slice(end + 2));
  else lines.shift();
  return trimmed(lines.join("\n"));
}

// Those following this box's bots (`kuvo/bots/events`), told of a change made here at once (one
// made beside it, by kuvo-wake or a move, they see as their folders change).
const botFollowers = new Set();
const noteBotsChanged = () => { for (const tell of botFollowers) tell(); };

const fitsLook = (looks, look) => Boolean(look) && looks.colors.includes(look.color) && looks.shapes.includes(look.shape) && looks.faces.includes(look.face);

// Why a model of the engine's can't run here: its account isn't signed in here, and the engine
// would drop a message on it without a word; null when it can (or the engine doesn't say).
async function signInRefusal(model, engine, signal) {
  const ready = await call(engine, "GET", "/api/provider", undefined, signal).catch(() => undefined);
  const ids = Array.isArray(ready) ? ready.map(each => each?.id) : [];
  return ids.length && !ids.includes(model.providerID) ? `${model.id} needs a sign-in on ${HERE}: sign in to it in Settings › Accounts, or choose another model.` : null;
}

// `POST kuvo/bots`, as the Mac's: the bot made here, its folder, conversation and instructions,
// and the template's job for your composer, or else its greeting, so it writes first.
export async function makeBot(given, readEngine, readBridge, machine, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const kit = readKit();
  if (!kit) return no(409, NO_KIT);
  if (!given || typeof given !== "object") return no(400, "That isn’t a bot to make.");
  const name = plainName(given.name);
  if (!name) return no(400, "A bot needs a name.");
  // This Mac's box makes this Mac's bots: one for a machine is made on that machine's box.
  if (ON_MAC && given.machine !== undefined && given.machine !== null && given.machine !== "mac") {
    return no(400, `This Mac makes only bots that live on it: make one for “${plainName(given.machine)}” there.`);
  }
  let template;
  if (given.template !== undefined && given.template !== null) {
    template = kit.templates.find(each => each.id === given.template);
    if (!template) return no(400, `There’s no template “${given.template}”.`);
  }
  // A shared bot's job (File › Import Bot…): typed in its conversation for you, as a template's is.
  const shared = isObject(given.job) && (typeof given.job.line === "string" || typeof given.job.details === "string")
    ? firstMessageOf(given.job.line, given.job.details) || null
    : null;
  const personalityID = given.personality ?? template?.personality;
  const personality = personalityID ? botPersonalities(kit).find(each => each.id === personalityID) : undefined;
  if (personalityID && !personality) return no(400, `There’s no personality “${personalityID}”.`);
  const project = given.project ?? undefined;
  if (project !== undefined && !boxProjects(kit).some(each => each.directory === project)) return no(400, "That project isn’t in Kuvo Code.");
  const looks = kit.looks;
  const pick = list => list[crypto.randomInt(list.length)];
  const look = fitsLook(looks, given.look) ? given.look : template?.look ?? { color: pick(looks.colors), shape: pick(looks.shapes), face: pick(looks.faces) };
  const model = isModel(given.model) ? given.model : kit.startingModel;
  if (!model) return no(422, `There’s no model to start it on here: sign in to an account on ${HERE} first.`);
  const agents = runsWithAgents(model);
  let target;
  try {
    target = agents ? readBridge() : readEngine();
  } catch {}
  if (!target) return no(503, agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  if (!agents) {
    const refused = await signInRefusal(model, target, signal);
    if (refused) return no(422, refused);
  }

  const id = newID("bot_");
  const folder = path.join(BOTS, id);
  const directory = project ?? path.join(folder, "workspace");
  const discard = () => fs.rmSync(folder, { recursive: true, force: true });
  let session;
  try {
    fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
    fs.writeFileSync(path.join(folder, "MEMORY.md"), kit.memory.replaceAll("⟦name⟧", name));
    const rules = [...(kit.rules ?? []), { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" }];
    session = await call(target, "POST", "/api/session", { title: name, location: { directory }, model, permissions: rules }, signal);
    if (!session?.id) throw new Error("No conversation was made.");
    await call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { kuvo: { bot: id } } }, signal).catch(() => {});
    const told = botInstructions(kit, name, folder, personality?.instruction, project);
    await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session.id)}/instructions/entries/kuvo.bot`, { value: told }, signal);
    fs.writeFileSync(path.join(folder, "session"), session.id);
    noteTold(folder, { session: session.id, instructions: toldDigest(told), rules: folder });
    fs.writeFileSync(path.join(folder, "directory"), directory);
    // A machine's wake-ups go by your time zone; this Mac's, by its own clock as you change it.
    if (kit.timeZone && !ON_MAC) fs.writeFileSync(path.join(folder, "timezone"), kit.timeZone);
    if (kit.zoneinfo && !ON_MAC) fs.writeFileSync(path.join(folder, "zoneinfo"), Buffer.from(kit.zoneinfo, "base64"));
    if (agents) fs.writeFileSync(path.join(folder, "via"), "bridge");
    const now = stamp();
    const described = { created: now, id, job: "", kuvo: DESCRIPTION, look, model, name, ...(personality ? { personality: personality.id } : {}), ...(project ? { project } : {}), updated: now };
    fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify(described, null, 2));
  } catch (error) {
    if (session?.id) await call(target, "DELETE", `/api/session/${encodeURIComponent(session.id)}`, undefined, signal).catch(() => {});
    discard();
    return no(503, `The bot couldn’t be made: ${error?.message ?? error}`);
  }
  // Without a template's or a shared bot's job for you to send, it writes first.
  const firstMessage = (template ? firstMessageOf(template.job, template.instructions) || null : null) ?? shared;
  if (!firstMessage) await call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/synthetic`, { text: kit.greeting, description: "A new bot's first message" }, signal).catch(() => {});
  noteBotsChanged();
  const bot = listBots(machine).find(each => each.id === id);
  return { status: 201, value: { bot, firstMessage: firstMessage ?? null } };
}

// `PATCH kuvo/bots/<id>`, as the Mac's: a bot that lives here changed as Edit Bot changes it (its
// name, look, personality or model), in its description and in its conversation, which is told as
// the Mac tells it: the kit's words, with its job as its memory has it now. The Mac takes the
// change in as it next connects (Bots.takeIn).
// What a bot's conversation was last told, kept in its folder (`told.json`, so a restart doesn't
// tell every bot again): its conversation, what it was told (a digest), and the folder its own
// rules were last put right for. It's told again only when what it would be told changes.
const TOLD_FILE = "told.json";
const toldDigest = text => crypto.createHash("sha256").update(text).digest("hex");
function toldOf(folder) {
  try {
    const told = JSON.parse(textOf(path.join(folder, TOLD_FILE)) ?? "");
    return isObject(told) ? told : {};
  } catch {
    return {};
  }
}
function noteTold(folder, changes) {
  try {
    const file = path.join(folder, TOLD_FILE);
    fs.writeFileSync(`${file}.new`, JSON.stringify({ ...toldOf(folder), ...changes }));
    fs.renameSync(`${file}.new`, file);
  } catch {}
}

// What a bot here is told now: the kit's words, with its name, folder, personality and project,
// and its job as its memory has it.
function toldNow(kit, here, described = here.described) {
  const personality = botPersonalities(kit).find(each => each.id === described.personality)?.instruction;
  const job = jobOf(here);
  return botInstructions(kit, described.name, here.folder, personality, described.project, { line: job.line, section: job.details });
}

// Tells a bot's conversation (on `target`) `text`, and notes it. Whether it got there.
async function tellBot(target, here, session, text, signal) {
  const told = await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries/kuvo.bot`, { value: text }, signal).then(() => true, () => false);
  if (told) noteTold(here.folder, { session, instructions: toldDigest(text) });
  return told;
}

// A bot's run started (`target` runs its conversation): what it's told brought up to date (new
// words in an update, a personality changed), once, at its run rather than every bot at once as the
// box starts, since telling one opens its folder on the engine; its own rules put right for the
// folder it's in; and its memory file made, for one made before it was made with it.
// One bot at a time: asked again while it's being told (its run starting as the box finds its
// engine, or as its app asks), it's looked at again once that's done, so it's never told twice.
const freshening = new Map();
function oneAtATime(sessionID, work) {
  const now = (freshening.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(work);
  freshening.set(sessionID, now);
  const done = () => { if (freshening.get(sessionID) === now) freshening.delete(sessionID); };
  now.then(done, done);
  return now;
}

export function freshenBot(target, sessionID) {
  return oneAtATime(sessionID, () => freshenOne(target, sessionID));
}

async function freshenOne(target, sessionID) {
  const here = listOf(BOTS).map(botHere).find(bot => bot?.session === sessionID);
  if (!here || isMoving(here.folder)) return;
  const kit = readKit();
  settleFolder(here, kit);
  if (!kit) return;
  const told = toldOf(here.folder);
  const text = toldNow(kit, here);
  // What its conversation has now, where that can be read: one that told it something else (a Mac
  // of an earlier version) is put right; otherwise what was last told it here.
  const there = await toldThere(target, sessionID);
  const stale = there === undefined ? told.session !== sessionID || told.instructions !== toldDigest(text) : there !== text;
  if (stale) await tellBot(target, here, sessionID, text);
  if (told.rules !== here.folder && await repairRules(target, here, sessionID)) noteTold(here.folder, { rules: here.folder });
}

// What a bot's folder says of where it is, as this box has it: the folder it works in, the time zone
// its wake-ups go by and that zone's rules, for a machine without zone files of its own (a
// machine's: yours, as its kit has it; this Mac's go by its own clock), and its memory file (for
// one made before it was made with it), which needs this box's words (`kit`, null without them).
// For one that came from another computer (Move to Computer), those are this one's from now on.
function settleFolder(here, kit) {
  const write = (name, data) => {
    const file = path.join(here.folder, name);
    let now = null;
    try { now = fs.readFileSync(file); } catch {}
    if (!now || !now.equals(Buffer.from(data))) fs.writeFileSync(file, data);
  };
  try {
    write("directory", typeof here.described.project === "string" ? here.described.project : path.join(here.folder, "workspace"));
    if (ON_MAC) {
      for (const name of ["timezone", "zoneinfo"]) fs.rmSync(path.join(here.folder, name), { force: true });
    } else {
      const mac = readMacKit(), zone = zoneOf(mac);
      if (zone) write("timezone", zone);
      if (typeof mac?.zoneinfo === "string" && mac.zoneinfo) write("zoneinfo", Buffer.from(mac.zoneinfo, "base64"));
    }
    if (kit && !fs.existsSync(path.join(here.folder, "MEMORY.md"))) write("MEMORY.md", kit.memory.replaceAll("⟦name⟧", () => here.described.name));
  } catch {}
}

// `POST kuvo/bots/<id>/arrived`: a bot whose folder and conversation were just brought here from
// another computer (Move to Computer), made this box's: what its folder says of where it is, its
// rules here (for its folder here, and from this box's Settings › Permissions), and what it's told
// here (where it runs, now). Done while its move still holds it, before its wake-ups go on, and
// one at a time with its other tellings. `{status, value}`: 200 `{bot}`.
export async function settleBot(id, readEngine, readBridge, machine) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  return oneAtATime(here.session, async () => {
    const kit = readKit();
    // Where it works and the clock it goes by, whatever else can't be done yet.
    settleFolder(here, kit);
    noteBotsChanged();
    if (!kit) return no(409, NO_KIT);
    let target;
    try { target = here.agents ? readBridge() : readEngine(); } catch {}
    if (!target) return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
    const text = toldNow(kit, here);
    const there = await toldThere(target, here.session);
    // Told already (by its box before, or here): noted as told here, so what was noted where it came
    // from doesn't have it told again.
    if (there === text) noteTold(here.folder, { session: here.session, instructions: toldDigest(text) });
    const told = there === text || await tellBot(target, here, here.session, text);
    const ruled = await repairRules(target, here, here.session);
    if (ruled) noteTold(here.folder, { rules: here.folder });
    if (!told || !ruled) return no(503, "Its conversation here didn’t take what it is now. It’s tried again as its next run starts.");
    return { status: 200, value: { bot: listBots(machine).find(each => each.id === id) ?? null } };
  });
}

// What a conversation on `target` is told as a bot (its `kuvo.bot` entry): its words, null for
// none, undefined when that can't be read (it isn't there, or `target` doesn't say).
async function toldThere(target, sessionID) {
  try {
    const entries = await call(target, "GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries`);
    if (!Array.isArray(entries)) return undefined;
    const entry = entries.find(each => each?.key === "kuvo.bot");
    return typeof entry?.value === "string" ? entry.value : null;
  } catch {
    return undefined;
  }
}

// Every bot whose conversation is on `target`, told what it is now if that changed (after an update,
// or what a Mac of an earlier version told it), and its rules put right: as the box finds its engine
// or its coding agents' bridge (it started, or they did), so a bot's next turn starts on its own
// words. The ones on the other are left to it.
export async function freshenBots(target) {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (!here || isMoving(here.folder)) continue;
    if (await toldThere(target, here.session) === undefined && !(await call(target, "GET", `/api/session/${encodeURIComponent(here.session)}`).then(() => true, () => false))) continue;
    await freshenBot(target, here.session).catch(() => {});
  }
}

// What "Ask First" asks about (the Mac's ToolApproval.askFirst): a conversation that asks before
// running commands asks first.
const ASK_FIRST = ["edit", "write", "patch", "shell", "webfetch", "external_directory", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"];
const isRule = rule => isObject(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && ["allow", "deny", "ask"].includes(rule.effect);
// A folder a conversation may work in, of its own (the Mac's ToolApproval.isParticular).
const isParticular = rule => rule.action === "external_directory" && rule.effect === "allow" && rule.resource !== "*";

// This box's Settings › Permissions (its settings' `permissions`), or null where they can't be read,
// or aren't its own yet (a machine whose Mac hasn't made them so, which runs with what its Mac gave it).
function permissionsHere() {
  if (!ownsSettings()) return null;
  const { settings } = readSettings();
  if (!settings) return null;
  const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
  return rules.every(isRule) ? rules : [];
}

// A conversation's rules made again from its approval (it asks first when it asks before commands)
// and Settings › Permissions (`settings`) as they are now, with its own folders after, as the Mac
// makes them (ToolApproval.refreshed): Approve All runs what Settings asks first about, Ask First
// still lets through what Settings allows, and both keep what Settings doesn't allow.
export function refreshedRules(current, settings) {
  const asks = current.some(rule => rule.action === "shell" && rule.effect === "ask");
  const denied = settings.filter(rule => rule.effect === "deny");
  let made;
  if (asks) {
    const everywhere = settings.findLast(rule => rule.action === "external_directory" && rule.resource === "*")?.effect === "allow";
    made = [
      ...ASK_FIRST.filter(action => everywhere || action !== "external_directory").map(action => ({ action, resource: "*", effect: "ask" })),
      ...settings.filter(rule => rule.effect !== "deny" && rule.resource !== "*" && rule.action !== "external_directory"),
      ...denied,
    ];
  } else {
    made = [...settings.filter(rule => rule.effect === "ask").map(rule => ({ action: rule.action, resource: rule.resource, effect: "allow" })), ...denied];
  }
  return [...made, ...current.filter(isParticular)];
}

// A bot's own rules as they're made now: its approval with this box's Settings › Permissions, then
// `external_directory` for its folder here. An earlier version allowed its kuvo-wake commands
// (which let one that also wrote a file through), a move left the folder it had, and the computer
// it came from had Settings of its own. Whether they're right now.
async function repairRules(target, here, sessionID) {
  const id = here.described.id;
  let rules;
  try {
    rules = (await call(target, "GET", `/api/session/${encodeURIComponent(sessionID)}`))?.permissions;
  } catch {
    return false;
  }
  if (!Array.isArray(rules)) return false;
  const own = { action: "external_directory", resource: path.join(here.folder, "*"), effect: "allow" };
  const commands = [`kuvo-wake ${id} `, `"${WAKE_COMMAND}" ${id} `, `"$HOME/.kuvo-code/bin/kuvo-wake" ${id} `];
  const old = rule => (rule?.action === "shell" && commands.some(command => String(rule.resource ?? "").startsWith(command)))
    || (rule?.action === "external_directory" && String(rule.resource ?? "").endsWith(`/bots/${id}/*`));
  const kept = rules.filter(rule => !old(rule));
  const settings = kept.every(isRule) ? permissionsHere() : null;
  const repaired = [...(settings ? refreshedRules(kept, settings) : kept), own];
  if (JSON.stringify(repaired) === JSON.stringify(rules)) return true;
  return call(target, "PATCH", `/api/session/${encodeURIComponent(sessionID)}`, { permissions: repaired }).then(() => true, () => false);
}

// Conversations being carried on with the coding agents now (`carryToAgents`): one at a time each.
const carrying = new Set();

// A file a waiting message brings (the engine's form of it), as the agents' bridge takes one.
const promptFiles = payload => (Array.isArray(payload?.files) ? payload.files : []).map(file => {
  const name = typeof file?.name === "string" ? { name: file.name } : {};
  const uri = file?.source?.uri ?? file?.uri;
  if (typeof uri === "string") return { uri, ...name };
  return typeof file?.data === "string" ? { uri: `data:${file.mime ?? "application/octet-stream"};base64,${file.data}`, ...name } : null;
}).filter(Boolean);

// `POST kuvo/sessions/<id>/agents`, as a Mac's (Workspace.moveToAgents): a conversation this
// machine's engine runs, carried on with its coding agents on `model` (one of theirs, or Custom
// Auto), as picking it in the conversation does: a session of theirs with the whole conversation
// and what was waiting; the engine's goes to Archived, and a bot's conversation becomes the new
// one. `{status, value}`: 200 `{session}`, the new one.
export async function carryToAgents(id, model, readEngine, agents, signal) {
  const no = (status, message) => ({ status, value: { message } });
  if (!isModel(model) || !runsWithAgents(model)) return no(400, "That isn’t a coding agent’s model.");
  let engine;
  try { engine = readEngine(); } catch {}
  if (!engine) return no(503, "The engine isn’t running.");
  if (!agents) return no(503, `The coding agents aren’t running on ${HERE}.`);
  const route = `api/session/${encodeURIComponent(id)}`;
  let session;
  try { session = (await engineGet(engine, route))?.data; } catch {}
  if (!session) {
    // One of theirs already, or none.
    const theirs = await engineGet(agents, route).catch(() => null);
    return theirs?.data ? no(409, "It’s with the coding agents already.") : no(404, "That conversation isn’t there any more.");
  }
  if (session.metadata?.kuvoAgent || session.metadata?.["kuvo.carriedTo"]) return no(409, "It’s with the coding agents already.");
  const bot = listOf(BOTS).map(botHere).find(here => here?.session === id) ?? null;
  if (isMoving(bot?.folder ?? path.join(SESSION_WAKES, id))) return no(409, MOVING);
  // Signed in there, unless it's Auto, which picks among those that are.
  if (model.providerID !== "auto") {
    const integration = (await engineGet(agents, `api/integration/${encodeURIComponent(model.providerID)}`).catch(() => null))?.data;
    const name = integration?.name ?? model.providerID;
    if (integration?.metadata?.installed === false) return no(422, `${name} isn’t installed on ${HERE}: install it in Settings › Accounts, or choose another model.`);
    if (!integration?.connections?.length) return no(422, `${name} needs a sign-in on ${HERE}: sign in in Settings › Accounts, or choose another model.`);
  }
  if (carrying.has(id)) return no(409, "It’s being carried on with the coding agents already.");
  carrying.add(id);
  try {
    // From here on it goes to its end, whatever becomes of the phone's request: cut off halfway, it
    // would be in two places, or what waited would run twice.
    const directory = session.location?.directory ?? session.directory;
    let messages = [], waiting = [];
    for (let round = 0; round < 3; round++) {
      // Not partway through a turn (one a client started again from what waited, since).
      const active = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (id in active) {
        await call(engine, "POST", `/${route}/interrupt`).catch(() => {});
        await call(engine, "POST", `/api/experimental/session/${encodeURIComponent(id)}/wait`).catch(() => {});
      }
      // Its whole conversation, page by page (a great many messages at most).
      let page = await engineGet(engine, `${route}/message?limit=200&order=desc`);
      messages = [...(page?.data ?? [])].reverse();
      while ((page?.data?.length ?? 0) >= 200 && messages.length < 20_000) {
        const cursor = page.cursor?.next ?? page.cursor?.previous;
        if (!cursor) break;
        page = await engineGet(engine, `${route}/message?limit=200&cursor=${encodeURIComponent(cursor)}`);
        if (!page?.data?.length) break;
        messages = [...page.data].reverse().concat(messages);
      }
      // An undo waiting to be kept: the conversation as it is now, without what it took back.
      const cut = session.revert?.messageID ? messages.findIndex(message => message.id === session.revert.messageID) : -1;
      if (cut >= 0) messages = messages.slice(0, cut);
      // What was sent and waiting comes along, still waiting.
      waiting = ((await engineGet(engine, `${route}/inbox`).catch(() => null))?.data ?? []).filter(item => item?.type === "user" && typeof item.text === "string");
      const still = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (!(id in still)) break;
    }
    const moved = await call(agents, "POST", "/api/session/import", {
      title: session.title, agent: session.agent, model, location: { directory }, permissions: session.permissions, messages,
      waiting: waiting.map(item => ({ id: messageID(), text: item.text, files: promptFiles(item.payload) })),
    });
    if (typeof moved?.id !== "string") return no(502, "The coding agents didn’t take it.");
    for (const item of waiting) await call(engine, "DELETE", `/${route}/inbox/${encodeURIComponent(item.id)}`).catch(() => {});
    const entries = `/api/experimental/session/${encodeURIComponent(moved.id)}/instructions/entries`;
    await tellWorktree(agents, moved.id).catch(() => {});
    if (bot) {
      // The bot's conversation is the new one, marked as its, told what it is.
      await call(agents, "PATCH", `/api/session/${encodeURIComponent(moved.id)}`, { metadata: { kuvo: session.metadata?.kuvo ?? { bot: bot.described.id } } }).catch(() => {});
      const kit = readKit();
      if (kit) await tellBot(agents, bot, moved.id, toldNow(kit, bot));
      fs.writeFileSync(path.join(bot.folder, "session"), moved.id);
      fs.writeFileSync(path.join(bot.folder, "via"), "bridge");
      await call(engine, "DELETE", `/${route}`).catch(() => {});
    } else {
      // Its wake-ups and watches go with it, as on a Mac (WakeUps.carry).
      const from = path.join(SESSION_WAKES, id), to = path.join(SESSION_WAKES, moved.id);
      if (fs.existsSync(path.join(from, "session")) && !fs.existsSync(to)) {
        try {
          fs.renameSync(from, to);
          fs.writeFileSync(path.join(to, "session"), moved.id);
          fs.writeFileSync(path.join(to, "directory"), directory ?? "");
          fs.writeFileSync(path.join(to, "via"), "bridge");
        } catch {}
      }
      // Archived, and marked as carried on, so it isn't carried twice.
      await call(engine, "PATCH", `/${route}`, { metadata: { ...(session.metadata ?? {}), "kuvo.archived": true, "kuvo.carriedTo": moved.id } }).catch(() => {});
      try { holdArchived(id, true); } catch {}
    }
    return { status: 200, value: { session: moved.id } };
  } catch (error) {
    return no(502, error?.message ?? String(error));
  } finally {
    carrying.delete(id);
  }
}

export async function changeBot(id, given, readEngine, readBridge, machine, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder)) return no(409, MOVING);
  const kit = readKit();
  if (!kit) return no(409, NO_KIT);
  if (!isObject(given)) return no(400, "That isn’t a change to a bot.");
  const { described } = here;
  const changed = { ...described };
  if ("name" in given) {
    changed.name = plainName(given.name);
    if (!changed.name) return no(400, "A bot needs a name.");
  }
  if ("look" in given) {
    if (!fitsLook(kit.looks, given.look)) return no(400, "That isn’t a look a bot can have.");
    changed.look = { color: given.look.color, shape: given.look.shape, face: given.look.face };
  }
  const personalities = botPersonalities(kit);
  if ("personality" in given) {
    if (given.personality === null) delete changed.personality;
    else if (personalities.some(each => each.id === given.personality)) changed.personality = given.personality;
    else return no(400, `There’s no personality “${given.personality}”.`);
  }
  let job;
  if ("job" in given) {
    const checked = givenJob(given.job);
    if (checked.error) return no(400, checked.error);
    job = checked.job;
  }
  if ("model" in given) {
    if (!isModel(given.model)) return no(400, "That isn’t a model.");
    const model = { id: given.model.id, providerID: given.model.providerID, ...(typeof given.model.variant === "string" ? { variant: given.model.variant } : {}) };
    // The one it has is kept, whatever; another has to run where its conversation does.
    if (!sameModel(model, described.model)) {
      if (runsWithAgents(model)) {
        // Its conversation goes on with the coding agents, as it does on a Mac.
        if (!here.agents) {
          let agents = null;
          try { agents = readBridge(); } catch {}
          const carried = await carryToAgents(here.session, model, readEngine, agents, signal);
          if (carried.status !== 200) return carried;
          Object.assign(here, botHere(id) ?? {});
        }
      } else {
        let engine;
        try {
          engine = readEngine();
        } catch {}
        if (!engine) return no(503, "The engine isn’t running.");
        const refused = await signInRefusal(model, engine, signal);
        if (refused) return no(422, refused);
      }
    }
    changed.model = model;
  }
  let target;
  try {
    target = here.agents ? readBridge() : readEngine();
  } catch {}
  if (!target) return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  const renamed = changed.name !== described.name;
  const was = jobOf(here);
  const newJob = job !== undefined && (job.line !== was.line || job.details !== was.details);
  const retold = renamed || changed.personality !== described.personality || newJob;
  const switched = !sameModel(changed.model, described.model);
  const looks = ["color", "shape", "face"].some(part => changed.look?.[part] !== described.look?.[part]);
  if (retold || switched || looks) {
    // (Its job isn't an edit of its description's: the bot keeps it, and Edit Bot can too.)
    if (renamed || switched || looks || changed.personality !== described.personality) changed.updated = stamp();
    try {
      if (newJob) {
        writeJob(here, job);
        changed.job = job.line;
      }
      const file = path.join(here.folder, "bot.json");
      fs.writeFileSync(`${file}.new`, JSON.stringify(changed, null, 2));
      fs.renameSync(`${file}.new`, file);
      here.described = changed;
    } catch (error) {
      return no(503, `The bot couldn’t be changed: ${error?.message ?? error}`);
    }
    // Its conversation hears of a new name, personality or model, as from Edit Bot.
    const session = encodeURIComponent(here.session);
    if (renamed) await call(target, "PATCH", `/api/session/${session}`, { title: changed.name }, signal).catch(() => {});
    if (switched && changed.model) await call(target, "POST", `/api/session/${session}/model`, { model: changed.model }, signal).catch(() => {});
    if (retold) await tellBot(target, here, here.session, toldNow(kit, here, changed), signal);
    noteBotsChanged();
  }
  return { status: 200, value: { bot: listBots(machine).find(each => each.id === id) ?? null } };
}

// Bots deleted here whose keys of their own are still to go (`run/bot-keys-left.json`): where the
// keys couldn't be reached as one was deleted (this Mac's app not answering), they go the next time
// they can be, as the box starts or another bot is deleted.
const KEYS_LEFT_FILE = path.join(RUN, "bot-keys-left.json");
function keysLeft() {
  try {
    const listed = JSON.parse(textOf(KEYS_LEFT_FILE) ?? "");
    return Array.isArray(listed?.bots) ? listed.bots.filter(each => typeof each === "string" && /^bot_[A-Za-z0-9]+$/.test(each)) : [];
  } catch {
    return [];
  }
}
function noteKeysLeft(id, left) {
  const bots = keysLeft().filter(each => each !== id);
  if (left) bots.push(id);
  try {
    fs.mkdirSync(RUN, { recursive: true });
    if (!bots.length) return fs.rmSync(KEYS_LEFT_FILE, { force: true });
    fs.writeFileSync(`${KEYS_LEFT_FILE}.new`, JSON.stringify({ bots }));
    fs.renameSync(`${KEYS_LEFT_FILE}.new`, KEYS_LEFT_FILE);
  } catch {}
}
export async function forgetLeftKeys() {
  for (const id of keysLeft()) {
    if (botHere(id)) {
      // Here again (a move brought it back): its keys are its own.
      noteKeysLeft(id, false);
      continue;
    }
    try {
      for (const name of await keyNames({ suffix: botVariable("", id) })) await deleteKey(name);
      noteKeysLeft(id, false);
    } catch {}
  }
}

// COMPAT(beta.1 deleted-bots): `bots/deleted.json`, for a Mac of 0.8.0-beta.1 or earlier. Goes when 0.8.0 ships.
// The bots deleted here, the latest first (the last 500), for the Mac to let go of as it next
// connects: `{"deleted": [<bot id>…]}` (Bots.deletedFile).
const DELETED_FILE = path.join(BOTS, "deleted.json");

function noteDeleted(id) {
  let kept = [];
  try {
    const listed = JSON.parse(textOf(DELETED_FILE) ?? "");
    if (Array.isArray(listed?.deleted)) kept = listed.deleted.filter(each => typeof each === "string" && each !== id);
  } catch {}
  fs.mkdirSync(BOTS, { recursive: true });
  fs.writeFileSync(`${DELETED_FILE}.new`, JSON.stringify({ deleted: [id, ...kept].slice(0, 500) }));
  fs.renameSync(`${DELETED_FILE}.new`, DELETED_FILE);
}

// `DELETE kuvo/bots/<id>`, as the Mac's Delete Bot…: a bot that lives here goes, its folder (its
// memory, wake-ups and what it made) to Kuvo Code's trash here, then its keys of its own, its
// place in the group chats here and its conversation. It's noted for the Mac (`noteDeleted`) first,
// so it lets the bot go too.
export async function deleteBot(id, readEngine, readBridge, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here) return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder)) return no(409, MOVING);
  let trashed;
  try {
    // For a Mac to let go of it as it next connects (this Mac's own box needs no note).
    if (!ON_MAC) noteDeleted(id);
    // To the trash as the Mac sends one there: a folder by when, and this process.
    const now = new Date();
    const two = number => String(number).padStart(2, "0");
    const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const trash = path.join(K, "trash", `${when}-${process.pid}`);
    fs.mkdirSync(trash, { recursive: true });
    trashed = path.join(trash, id);
    fs.renameSync(here.folder, trashed);
  } catch (error) {
    return no(503, `The bot couldn’t be deleted: ${error?.message ?? error}`);
  }
  // On this Mac, on to the Finder's Trash, where you look for what you deleted, and the folder that
  // held it here goes once it's empty.
  if (ON_MAC) {
    await hostTrash(trashed).catch(() => {});
    if (!fs.existsSync(trashed)) try { fs.rmdirSync(path.dirname(trashed)); } catch {}
  }
  // Its keys of its own (`KUVO_KEY_…__<ID>`). Where they can't be reached now (this Mac's app not
  // answering), the bot is deleted all the same, and its keys go once they can be.
  noteKeysLeft(id, true);
  await forgetLeftKeys();
  let agents;
  try {
    agents = readBridge();
  } catch {}
  // Its group chats here go on without it, as the Mac's leave it.
  if (agents) {
    const listed = await askGroups(agents, "GET", "", undefined, signal).catch(() => null);
    for (const chat of listed?.status === 200 && Array.isArray(listed.value?.data) ? listed.value.data : []) {
      const members = chat?.group?.members;
      if (!Array.isArray(members) || !members.includes(id)) continue;
      await askGroups(agents, "PATCH", `/${encodeURIComponent(chat.group.id)}`, { members: members.filter(member => member !== id) }, signal).catch(() => {});
    }
  }
  let target;
  try {
    target = here.agents ? agents : readEngine();
  } catch {}
  if (target) await call(target, "DELETE", `/api/session/${encodeURIComponent(here.session)}`, undefined, signal).catch(() => {});
  noteBotsChanged();
  return { status: 200, value: {} };
}

const LETTERS = /^[A-Za-z0-9]+$/;
// The most wake-ups a conversation keeps waiting, as the Mac's (Wakes.limit).
const WAKE_LIMIT = 50;

// A folder for a session's wake-ups here, made as a Mac makes one (WakeUps.makeFolder): its
// session, its folder, whether the coding agents run it, and held while it's archived. Null when
// it isn't a conversation here.
async function wakeFolderFor(session, readEngine, bridge) {
  if (!/^ses_[A-Za-z0-9]+$/.test(session)) return null;
  const ask = async target => target ? (await engineGet(target, `api/session/${encodeURIComponent(session)}`).catch(() => null))?.data ?? null : null;
  let engine = null;
  try { engine = readEngine(); } catch {}
  let found = await ask(engine), agents = false;
  if (!found) {
    found = await ask(bridge());
    agents = Boolean(found);
  }
  if (!found) return null;
  const folder = path.join(SESSION_WAKES, session);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, "session"), session);
  fs.writeFileSync(path.join(folder, "directory"), found.location?.directory ?? found.directory ?? "");
  if (agents) fs.writeFileSync(path.join(folder, "via"), "bridge");
  if (found.metadata?.["kuvo.archived"] === true) fs.writeFileSync(path.join(folder, "paused"), "archived");
  return folder;
}

// Takes a wake-up off the schedule by its letters, which a repeating one keeps as its time moves on.
function cancelWake(folder, letters) {
  if (!LETTERS.test(letters)) return;
  for (const name of listOf(path.join(folder, "wakes"))) {
    if (wakeOf(name)?.letters === letters) fs.rmSync(path.join(folder, "wakes", name), { force: true });
  }
}

// A message ID that sorts after earlier ones, as the engine's own do.
let lastMessage = { time: 0, counter: 0 };
export function messageID(now = Date.now()) {
  lastMessage = lastMessage.time === now ? { time: now, counter: lastMessage.counter + 1 } : { time: now, counter: 1 };
  const time = ((BigInt(now) * 0x1000n + BigInt(lastMessage.counter)) & 0xFFFFFFFFFFFFn).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(crypto.randomBytes(14), byte => alphabet[byte % alphabet.length]).join("")}`;
}

// Until the MCP servers of the folder a conversation works in are connected, twenty seconds at
// most, as the app and the engine's watchdog wait before a wake-up: one sent sooner reaches a
// model without their tools.
async function waitForTools(port, authorization, directory, signal) {
  const started = Date.now();
  let waited = false;
  while (Date.now() - started < 20_000) {
    let listed;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: { authorization, "x-opencode-directory": encodeURIComponent(directory) }, signal });
      if (!response.ok) return;
      listed = await response.text();
    } catch {
      return;
    }
    // A folder it has only just opened lists none for a moment before they're pending.
    const none = !listed.includes('"status"');
    if (!listed.includes('"pending"') && !(none && Date.now() - started < 3_000)) {
      if (waited && !none) await sleep(1_500);
      return;
    }
    waited = true;
    await sleep(none ? 100 : 250);
  }
}

// Wake-ups being sent with Wake Up Now, so a second tap doesn't send one twice.
const wakingNow = new Set();

// `kuvo/wakes/<session>`: its wake-ups, watches and pause; `…/cancel` with {"wake"} or {"watch"};
// `…/now` with {"wake"}, sent at once (one that repeats still comes back at its time); `…/watch`
// with {"every", "check", "note"}, a watch made as its agent makes one.
async function* answerWakes(session, action, request, readEngine, bridge, signal) {
  const changed = function* (status, value) {
    wakesChanged();
    yield* json(status, value);
  };
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  let folder = wakeFolder(session);
  const listed = () => {
    if (!folder) return { wakes: [], watches: [], paused: false };
    const { wakes, watches, paused } = readWakes(folder);
    return { wakes: wakes.map(listedWake), watches, paused };
  };
  if (!action && (method === "GET" || method === "HEAD")) return yield* json(200, listed());
  if (method !== "POST") return yield* json(405, {});
  let given = {};
  try {
    given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}") ?? {};
  } catch {}
  // Its own kuvo-wake (this computer's clock, its weekends), as its agent runs it: its message when it
  // says no, else null.
  const kuvoWake = args => new Promise(resolve => execFile(WAKE_COMMAND, [folder, ...args], { encoding: "utf8", timeout: 30_000 },
    (error, _out, said) => resolve(error ? { missing: error.code === "ENOENT", refused: error.code === 2, said: String(said ?? "").trim() } : null)));
  const unavailable = (failed, what) => failed.missing
    ? json(503, { message: "Wake-ups aren’t set up on this computer." })
    : json(failed.refused && failed.said ? 400 : 503, { message: failed.refused && failed.said ? failed.said : `${what} couldn’t be saved. Try again.` });
  if (action === "watch") {
    const every = typeof given.every === "string" ? given.every.trim() : "";
    const check = typeof given.check === "string" ? given.check.trim() : "";
    const note = typeof given.note === "string" ? given.note.trim() : "";
    if (!every || !check || !note) return yield* json(400, { message: "Send how often (`every`, like 5m, 2h or 1d), the check to run (`check`) and what to do when it changes (`note`)." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made) return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder)) return yield* json(409, { message: MOVING });
    const failed = await kuvoWake(["watch", every, check, note]);
    if (failed) return yield* unavailable(failed, "The watch");
    return yield* changed(200, listed());
  }
  if (!action) {
    // One added as the bar over the composer adds one.
    const due = Number(given.due), note = typeof given.note === "string" ? given.note.trim() : "";
    const every = given.every == null ? null : String(given.every);
    if (!Number.isFinite(due) || !note) return yield* json(400, { message: "Send when it comes (`due`, seconds since 1970) and what it says (`note`)." });
    if (every !== null && !/^(weekdays|[1-9][0-9]{0,5}[mhdw])$/.test(every)) return yield* json(400, { message: "That isn’t a repeat: 30m, 2h, 1d, 1w or weekdays." });
    if (due < Date.now() / 1000 + 60) return yield* json(400, { message: "Pick a time at least a minute from now." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made) return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder)) return yield* json(409, { message: MOVING });
    if (readWakes(folder).wakes.length >= WAKE_LIMIT) return yield* json(409, { message: `There are ${WAKE_LIMIT} wake-ups waiting already. Cancel some first.` });
    const failed = await kuvoWake(["add", String(Math.floor(due)), ...(every ? ["--every", every] : []), note]);
    if (failed) return yield* unavailable(failed, "The wake-up");
    return yield* changed(200, listed());
  }
  // Held while it's archived, and let go when it's back, as its archiving (the Mac's, or a phone's
  // through this box) says: a hold of your own stays through both.
  if (action === "pause" && typeof given.archived === "boolean") {
    if (folder && isMoving(folder)) return yield* json(409, { message: MOVING });
    holdArchived(session, given.archived);
    return yield* changed(200, listed());
  }
  if (action === "pause" && typeof given.paused !== "boolean") return yield* json(400, { message: "Send {\"paused\": true} or false." });
  if (!folder) return yield* json(action === "pause" ? 200 : 404, action === "pause" ? listed() : {});
  if (isMoving(folder)) return yield* json(409, { message: MOVING });
  if (action === "pause") {
    // A hold of your own, until you take it away (archiving's and a move's are theirs).
    if (given.paused) fs.writeFileSync(path.join(folder, "paused"), "paused");
    else fs.rmSync(path.join(folder, "paused"), { force: true });
    return yield* changed(200, listed());
  }
  const { wakes, watches } = readWakes(folder);
  const chosen = typeof given.wake === "string" ? wakes.find(each => each.id === given.wake || each.letters === given.wake) : undefined;
  if (action === "cancel") {
    if (chosen && LETTERS.test(chosen.letters)) {
      cancelWake(folder, chosen.letters);
      return yield* changed(200, {});
    }
    const watch = typeof given.watch === "string" ? watches.find(each => each.letters === given.watch) : undefined;
    if (watch && LETTERS.test(watch.letters)) {
      fs.rmSync(path.join(folder, "watches", watch.letters), { recursive: true, force: true });
      return yield* changed(200, {});
    }
    return yield* json(404, {});
  }
  if (!chosen) return yield* json(404, {});
  const key = `${folder}/${chosen.id}`;
  if (wakingNow.has(key)) return yield* json(200, {});
  wakingNow.add(key);
  try {
    // The whole note, as its time would send it, not the line it's listed by.
    const note = textOf(path.join(folder, "wakes", chosen.id));
    if (note === null) return yield* json(404, {});
    const agents = (textOf(path.join(folder, "via")) ?? "").trim() === "bridge";
    let target = null;
    try {
      target = agents ? bridge() : readEngine();
    } catch {}
    if (!target) return yield* json(503, { message: agents ? "The coding agents aren’t running on this computer." : "The engine isn’t running." });
    const authorization = `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`;
    const directory = textOf(path.join(folder, "directory"));
    if (!agents && directory) await waitForTools(target.port, authorization, directory, signal);
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ id: messageID(), text: WAKE_MARKER + note, delivery: "queue" }),
        signal,
      });
    } catch {
      return yield* json(503, { message: "The wake-up couldn’t be sent." });
    }
    if (!response.ok) return yield* json(503, { message: `The wake-up couldn’t be sent (${response.status}).` });
    if (!chosen.every) cancelWake(folder, chosen.letters);
    return yield* changed(200, {});
  } finally {
    wakingNow.delete(key);
  }
}

// ---- Notifications ----

// The bridge tells your phones what happens in this machine's sessions, Mac connected or not: a
// permission or a question asked, a run finished or failed, a bot's news (PROTOCOL.md,
// "Notifications"). A Mac never tells them a machine's news, so each comes once, from here.
export const NOTICE_LIMIT = 2500;

// The characters of `text` that fit in `bytes` of UTF-8.
function prefixBytes(text, bytes) {
  let out = "", count = 0;
  for (const character of text) {
    count += Buffer.byteLength(character);
    if (count > bytes) break;
    out += character;
  }
  return out;
}

const cut = (text, count) => text.length <= count ? text : text.slice(0, count - 1) + "…";

// A notification's JSON, under NOTICE_LIMIT bytes: what doesn't fit of the body ends in "…".
export function noticeJSON(notice) {
  // What it shows masked, as the Mac's own notifications are: a phone's lock screen never shows
  // a key.
  const value = { t: "notify", title: cut(masked(String(notice.title ?? "")), 200), category: notice.category, thread: String(notice.thread ?? ""), data: notice.data ?? {} };
  if (notice.subtitle) value.subtitle = cut(masked(String(notice.subtitle)), 200);
  let body = masked(String(notice.body ?? ""));
  while (true) {
    const json = Buffer.from(sortedJSON({ ...value, body }));
    if (json.length <= NOTICE_LIMIT || !body) return json;
    const room = Buffer.byteLength(body) - (json.length - NOTICE_LIMIT) - Buffer.byteLength("…");
    body = room <= 0 ? "" : prefixBytes(body, room).trimEnd() + "…";
  }
}

// The relay's push of `json` to a phone ({key, address}, base64url), sealed for it alone.
export function pushTo(phone, json, hostKey) {
  const mail = frame(Frame.mail, 0, sealOneWay(json, hostKey, Buffer.from(phone.key, "base64url")).message);
  return relayPush(Buffer.from(phone.address, "base64url"), mail);
}

// ---- Notices held while you're at a computer (PROTOCOL.md, "kuvo/attention") ----
// A client in use (the Mac app, while you're at the Mac) tells the box so, for a short lease it
// renews. While one is, each notice waits a little before it goes to your phones, and doesn't go
// if it was answered meanwhile (a permission, a question, an ask) or seen: its conversation came
// on that client's screen, or the client showed it in a notification of its own. When the last
// lease ends (it ran out, or the client said it's not in use), what waits goes at once; with none,
// notices go at once. So a client that vanishes (a Mac's lid closed) holds nothing back for longer
// than a hold.

// How long a notice waits while you're at a computer: what's asked of you less than news.
export const ASK_HOLD = 30_000;
export const NEWS_HOLD = 60_000;
// The longest lease a client gets: one it doesn't renew is over by then.
export const LONGEST_LEASE = 60_000;
// A client's notification of a notice's news and the notice itself come apart (each box hears the
// engine on its own): one shown this long before the notice still counts.
export const SHOWN_WITHIN = 10_000;
// Where a running bridge keeps what's held.
const HELD_FILE = path.join(RUN, "held-notices.json");
// What a bridge before held waits this long for its clients to say they're still in use (a Mac
// renews every 15 seconds), as they were when it stopped: then it goes, unless they're back.
export const RESTORED_WAIT = 20_000;
// A notice that couldn't go (no relay just now) is tried again this often, for this long.
const RETRY_EVERY = 5_000;
const TRY_FOR = 10 * 60_000;
// Requests answered lately: one answered before its notice was made (the engine is asked who's
// asking first) never goes.
const MOST_ANSWERED = 200;
const ASKED = new Set(["permission", "question", "ask"]);
export const holdFor = category => ASKED.has(category) ? ASK_HOLD : NEWS_HOLD;

// What a notice is about (its conversation, or group chat), and what answering takes it back.
const shownIn = notice => notice?.data?.session ?? notice?.data?.group ?? notice?.thread;
const answeredBy = notice => notice?.data?.request ?? notice?.data?.ask;
// Whether a client's notification (`{session, ask, request?}`) is of this notice: the request or
// ask it's about, when it names one; else its conversation, and asked of you or news alike.
const showsNotice = (shown, notice) => shown.request !== undefined
  ? shown.request === answeredBy(notice)
  : shown.session === shownIn(notice) && shown.ask === ASKED.has(notice.category);

// What a client said (`POST kuvo/attention`'s body, or a Mac's mail): `{seconds, sessions,
// shown}`, its lease cut to the longest; null for what isn't that.
export function attentionGiven(given) {
  if (!isObject(given) || typeof given.for !== "number" || !Number.isFinite(given.for) || given.for < 0) return null;
  if (given.sessions !== undefined && (!Array.isArray(given.sessions) || !given.sessions.every(each => typeof each === "string"))) return null;
  if (given.shown !== undefined && (!Array.isArray(given.shown)
    || !given.shown.every(each => isObject(each) && typeof each.session === "string" && (each.ask === undefined || typeof each.ask === "boolean")
      && (each.request === undefined || typeof each.request === "string")))) return null;
  return {
    seconds: Math.min(given.for, LONGEST_LEASE / 1000),
    sessions: (given.sessions ?? []).slice(0, 50),
    shown: (given.shown ?? []).slice(0, 50).map(each => ({ session: each.session, ask: each.ask === true, ...(each.request !== undefined ? { request: each.request } : {}) })),
  };
}

// A clock for time gone by that a change of the date or time can't move.
const monotonic = () => performance.now();

export class NoticeHold {
  // `send(notice)`: to your phones; false when it can't go now. `now`, `setTimer` and `clearTimer`:
  // the clock (a test's own), `now` for time gone by; `wall`, the date, for what's kept. `save(entries)`:
  // what's held, kept for a bridge that starts again, which gives them back as `held`: what was held
  // for a client in use with the rest of its hold, and what was seen kept seen, while its clients
  // have a moment to say they're still there (`RESTORED_WAIT`); what was only waiting for the relay,
  // at once.
  constructor({ send, now = monotonic, wall = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, save = () => {}, held = [] }) {
    Object.assign(this, { send, now, wall, setTimer, clearTimer, save });
    this.leases = new Map();
    // When each client last spoke (its word's `at`): an older word, come late, is let go.
    this.heard = new Map();
    // Notifications clients showed lately, for notices that come after them.
    this.shown = [];
    this.answered = [];
    this.timer = null;
    const start = this.now(), today = this.wall();
    const restored = (Array.isArray(held) ? held : []).filter(entry => isObject(entry?.notice) && typeof entry.at === "number");
    this.held = restored.map(entry => {
      const age = Math.min(Math.max(today - entry.at, 0), TRY_FOR);
      // One held for a client keeps the rest of its hold; one only waiting for the relay goes now.
      // (One kept before bridge 0.9.61 doesn't say: taken as held for a client, that once.)
      const due = entry.attended !== false ? start - age + holdFor(entry.notice.category) : start - age;
      return { notice: entry.notice, wall: entry.at, at: start - age, due: Math.max(due, start - age), seen: entry.seen === true };
    });
    if (restored.some(entry => entry.attended !== false)) this.leases.set("restored", start + RESTORED_WAIT);
    this.saved = NoticeHold.kept(this.held);
    this.settle();
  }

  // What's kept of what's held, as JSON: when each was made, by the date.
  static kept(entries) {
    // `attended`: held because a client was in use, not only waiting for the relay.
    return JSON.stringify(entries.map(({ notice, wall, seen, at, due }) => ({ notice, at: wall, seen, attended: due > at })));
  }

  // Whether a client is in use now, and how many notices wait.
  get inUse() {
    const now = this.now();
    return [...this.leases.values()].some(until => until > now);
  }
  get count() { return this.held.length; }

  // `client` is in use for `seconds` more, with `sessions` on its screen and `shown` in its own
  // notifications just now; 0: it isn't any more. `at`: when it said so, by its own clock, for words
  // that can come out of order (mail).
  attend(client, { seconds, sessions = [], shown = [] }, at) {
    if (typeof at === "number") {
      if (at < (this.heard.get(client) ?? -Infinity)) return;
      this.heard.set(client, at);
    }
    if (seconds > 0) {
      const now = this.now();
      this.leases.set(client, now + seconds * 1000);
      const onScreen = new Set(sessions);
      for (const entry of this.held) if (onScreen.has(shownIn(entry.notice))) entry.seen = true;
      // Each notification stands for one notice: the oldest held of it, or the next to come.
      this.shown = this.shown.filter(each => now - each.at < SHOWN_WITHIN);
      for (const each of shown) {
        const entry = this.held.find(entry => !entry.seen && showsNotice(each, entry.notice));
        if (entry) entry.seen = true;
        else this.shown.push({ ...each, at: now });
      }
      this.shown = this.shown.slice(-200);
    } else {
      this.leases.delete(client);
    }
    this.settle();
  }

  // A notice for your phones: it goes now, or once its hold ends. True: it's taken.
  tell(notice) {
    const answer = answeredBy(notice);
    if (answer !== undefined && this.answered.includes(answer)) return true;
    const now = this.now();
    const inUse = this.inUse;
    // Shown by a client in use just before it came: that notification is spent.
    const mark = inUse ? this.shown.findIndex(each => now - each.at < SHOWN_WITHIN && showsNotice(each, notice)) : -1;
    const seen = mark >= 0;
    if (seen) this.shown.splice(mark, 1);
    this.held.push({ notice, at: now, wall: this.wall(), due: inUse ? now + holdFor(notice.category) : now, seen });
    this.settle();
    return true;
  }

  // A request or an ask answered (or gone): its notice, waiting, never goes.
  resolve(id) {
    if (typeof id !== "string" || !id) return;
    this.answered.push(id);
    if (this.answered.length > MOST_ANSWERED) this.answered.shift();
    this.held = this.held.filter(entry => answeredBy(entry.notice) !== id);
    this.settle();
  }

  // Sends what's due, and wakes again when the next is (or a lease ends with something waiting).
  settle() {
    const now = this.now();
    for (const [client, until] of this.leases) if (until <= now) this.leases.delete(client);
    const waiting = this.leases.size > 0;
    // When an entry may go: its hold's end while a client's in use, else now; one that couldn't
    // go waits for its next try.
    const when = entry => Math.max(waiting ? entry.due : -Infinity, entry.retry ?? -Infinity);
    const kept = [];
    for (const entry of this.held) {
      if (when(entry) > now) {
        kept.push(entry);
        continue;
      }
      // Seen: news needs telling no more; what's asked of you waits until it's answered, and goes
      // once no one's at a client (you saw it, and left it unanswered).
      if (entry.seen && !ASKED.has(entry.notice.category)) continue;
      if (entry.seen && waiting) {
        kept.push({ ...entry, due: Infinity });
        continue;
      }
      if (this.send(entry.notice)) continue;
      if (now - entry.at < TRY_FOR) kept.push({ ...entry, retry: now + RETRY_EVERY });
    }
    this.held = kept;
    const text = NoticeHold.kept(kept);
    if (text !== this.saved) {
      this.saved = text;
      this.save(JSON.parse(text));
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const next = Math.min(...kept.map(when), ...(kept.length ? this.leases.values() : []));
    if (Number.isFinite(next)) this.timer = this.setTimer(() => this.settle(), Math.max(0, next - now));
  }
}

// Markdown's marks taken off, not the words (as ReplyPreview does on the Mac): headings and
// quotes at a line's start, emphasis around words, code ticks, a link's address.
const plain = text => String(text ?? "")
  .replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]+/gm, "")
  .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1")
  .replace(/(?<![\w*_])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\w*_])/g, "")
  .replace(/`/g, "")
  .replace(/\s+/g, " ").trim();

// "Wants to run a command: npm test", as the Mac says it: every one it covers (a command line's
// commands each, as Allow takes them all), up to four, then how many more.
export function describePermission(request) {
  const what = { edit: "edit files", write: "edit files", patch: "edit files", shell: "run a command", bash: "run a command", read: "read a file", external_directory: "work outside the project", webfetch: "open a web page" }[request.action] ?? request.action;
  const shown = (Array.isArray(request.resources) ? request.resources : []).filter(each => each !== "*");
  if (!shown.length) return `Wants to ${what}.`;
  const more = shown.length > 4 ? ` · and ${shown.length - 4} more` : "";
  return `Wants to ${what}: ${shown.slice(0, 4).join(" · ")}${more}`;
}

// Whether a permission's notice shows all it covers: Allow there would allow what it leaves out.
const showsAllCovered = request => (Array.isArray(request.resources) ? request.resources : []).filter(each => each !== "*").length <= 4;

// A question's one field and its choices, as the Mac answers it from a notification.
const singleQuestion = form => {
  if (form.metadata?.kind !== "question") return null;
  const fields = (form.fields ?? []).filter(field => !field.hidden && !field.when?.length);
  return fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
};

// What a form asks, as the Mac's notification says it.
export function describeForm(form) {
  const kind = form.metadata?.kind;
  if (kind === "mcp-elicitation") return form.metadata?.message || "Needs your answer.";
  if (kind !== "question") return "Needs your answer.";
  const fields = (form.fields ?? []).filter(field => !field.hidden && !field.when?.length);
  if (fields.length === 1 && fields[0].type === "string") return fields[0].description || fields[0].title || form.title || "Has a question for you.";
  return "Has a question for you.";
}

const isBot = session => Boolean(session.metadata?.kuvo?.bot) || /\/bots\/bot_[^/]+\//.test(`${session.location?.directory ?? ""}/`);

// Kept out of sight, as the Mac keeps them: an engine run a coding agents' session started (Auto on
// one of the engine's models), whose news the agents' bridge tells as its session's; and a bot's
// seat in a group chat, whose chat tells what matters.
const isHiddenRun = session => Boolean(session?.metadata?.kuvo?.engineFor || session?.metadata?.kuvo?.seat);

// Asks the engine for `route` (a path under its API), as JSON.
function engineGet(engine, route) {
  return fetch(`http://127.0.0.1:${engine.port}/${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) })
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)));
}

// This box's chats, conversations of no project: a machine's in its folder, a Mac's beside its box.
const chatsFolder = () => (IS_MAC ? path.join(path.dirname(K), "Chats") : path.join(K, "chats"));

// A project's name, as the Mac shows it: its own, or its folder's; a worktree's is its project's.
export function projectNameOf(directory) {
  if (!directory) return undefined;
  if (directory === chatsFolder()) return "Chats";
  const project = readWorktrees().find(each => (each.folder ?? each.root) === directory || each.root === directory)?.project
    ?? readRemovedWorktrees()[directory] ?? directory;
  return readProjects().find(each => each.directory === project)?.name || path.basename(project) || undefined;
}

// The notification for an engine event, or null for one that isn't news. `get(route)` asks the
// engine.
export async function noticeFor(event, get) {
  const data = event.data ?? {};
  const session = async id => (await get(`api/session/${encodeURIComponent(id)}`)).data;
  // A subagent's request shows in the session that started it.
  const shown = async id => {
    let current = await session(id);
    for (let step = 0; step < 5 && current.parentID; step++) current = await session(current.parentID);
    return current;
  };
  // A form an MCP server asks for is filed under no session ("global"): it's the running session
  // of its folder with a tool of that server under way, as the Mac finds it; null for none.
  const waitingOn = async (server, folder) => {
    if (!server) return null;
    const active = (await get("api/session/active").catch(() => null))?.data ?? {};
    const name = String(server).replace(/[^\p{L}\p{N}_-]/gu, "_");
    for (const id of Array.isArray(active) ? active : Object.keys(active)) {
      const candidate = await session(id).catch(() => null);
      if (!candidate || (folder && candidate.location?.directory !== folder)) continue;
      const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=8&order=desc`).catch(() => null);
      const steps = (page?.data ?? []).filter(message => message.type === "assistant").flatMap(message => message.content ?? []);
      if (steps.some(block => block.type === "tool" && block.state?.status === "running"
        && (block.name?.startsWith(name + "_") || (block.name === "execute" && String(block.state.input?.code ?? "").includes(server))))) return id;
    }
    return null;
  };
  // `answerable` false: its buttons would answer what it can't show, so it has none, and you
  // answer in the conversation. `untitled`: what one without a title is called.
  const about = (shown, category, body, extra = {}, { answerable = true, untitled = "New Session" } = {}) => {
    const bot = isBot(shown);
    return {
      title: shown.title || untitled,
      subtitle: bot ? undefined : projectNameOf(shown.location?.directory ?? ""),
      body,
      category,
      thread: shown.id,
      data: { session: shown.id, ...extra, ...(answerable ? {} : { answerable: "0" }) },
    };
  };
  switch (event.type) {
    case "permission.asked": {
      const where = await shown(data.sessionID);
      if (isHiddenRun(where)) return null;
      const body = describePermission(data);
      return about(where, "permission", body, { request: data.id, ...(where.id !== data.sessionID ? { requestSession: data.sessionID } : {}) },
        { answerable: showsAllCovered(data) && showsAll(body), untitled: "Kuvo Code" });
    }
    case "form.created": {
      // The form comes under `form`, with its session.
      const form = data.form ?? data;
      const asker = form.sessionID === "global" ? await waitingOn(form.metadata?.server, event.location?.directory) : form.sessionID;
      if (!asker) return null;
      const where = await shown(asker);
      if (isHiddenRun(where)) return null;
      const body = describeForm(form);
      const choices = (singleQuestion(form)?.options ?? []).map(option => String(option?.label ?? ""));
      return about(where, "question", body, { request: form.id, ...(where.id !== form.sessionID ? { requestSession: form.sessionID } : {}) },
        { answerable: showsAll(body) && choices.every(showsAll), untitled: "Kuvo Code" });
    }
    case "session.execution.succeeded":
    case "session.execution.failed": {
      const id = data.sessionID;
      const ended = await session(id);
      // A subagent's run is part of its parent's.
      if (ended.parentID || isHiddenRun(ended)) return null;
      if (event.type === "session.execution.failed") return about(ended, "failed", "Stopped with an error.");
      let reply = "";
      try {
        const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=6&order=desc`);
        for (const message of page.data ?? []) {
          if (message.type !== "assistant") continue;
          reply = plain((message.content ?? []).filter(part => part.type === "text").map(part => part.text).join(" "));
          if (reply) break;
        }
      } catch {}
      // What it said last, as long as the Mac shows it.
      return about(ended, isBot(ended) ? "report" : "finished", reply ? cut(reply, 220) : "Finished.");
    }
    default:
      return null;
  }
}

// What `hold` keeps of `engine`'s that it asked you (a permission, a question) and isn't asked any
// more: answered while its events couldn't be heard, so it never goes. One it can't tell about
// stays as it is.
export async function settleHeld(engine, hold) {
  for (const entry of [...hold.held]) {
    const { request, requestSession, session } = entry.notice?.data ?? {};
    const kind = { permission: "permission", question: "form" }[entry.notice?.category];
    // A form an MCP server asks for is filed under no session ("global"), where the engine lists
    // none without its folder: one it can't tell about.
    if (!kind || typeof request !== "string" || typeof (requestSession ?? session) !== "string" || (requestSession ?? session) === "global") continue;
    const asked = (await engineGet(engine, `api/session/${encodeURIComponent(requestSession ?? session)}/${kind}`).catch(() => null))?.data;
    if (Array.isArray(asked) && !asked.some(each => each?.id === request)) hold.resolve(request);
  }
}

// The events in a `text/event-stream` body, parsed.
async function* serverEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length) {
          try { yield JSON.parse(data.join("\n")); } catch {}
        }
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}

// The events that can be news: a session's (the engine's, or a coding agent's) and a group
// chat's.
const NEWS = new Set(["permission.asked", "form.created", "session.execution.succeeded", "session.execution.failed"]);
const GROUP_NEWS = new Set(["kuvo.group.met", "kuvo.group.done"]);
// A permission or a form answered (or cancelled): its notice, if it waits, never goes.
const ANSWERED = new Set(["permission.replied", "form.replied", "form.cancelled"]);

// A group chat's news, as the Mac tells it: its meeting held (who spoke last, or no one could take
// part), or a bot done with the part it took on.
export function groupNotice(event) {
  const data = event.data ?? {};
  if (typeof data.id !== "string") return null;
  const about = { title: String(data.name ?? ""), category: "message", thread: data.id, data: { group: data.id } };
  if (event.type === "kuvo.group.met") {
    if (!data.last) return { ...about, body: "The meeting came, but no one could take part." };
    const who = data.who ? (data.last.kind === "wrapUp" ? `${data.who}’s wrap-up` : String(data.who)) : undefined;
    return { ...about, subtitle: who, body: cut(plain(data.last.text), 220) };
  }
  if (event.type === "kuvo.group.done") return { ...about, subtitle: `${data.who} finished its part`, body: cut(plain(data.text), 220) };
  return null;
}

// A message that reaches an agent while it waits on a command or a subagent it started in the
// foreground is read at once, as it would be at the agent's next step, rather than when the command
// ends: what it waits on goes on in the background, and the agent is told when it ends (the engine's
// own Ctrl+B in its terminal). Only messages sent to steer (yours, or another agent's letter), never
// one queued for after the turn, a wake-up or the engine's own notes; and only once what it waits
// on has run for `after` ms, so a quick command simply ends first. While one still waits behind it
// (the call was asking you something first, say), it's tried again every `after` ms.
// `background(session)` does it; each event from the engine goes to what this returns.
export const STEER_AFTER = 3000;
export function steering(background, { after = STEER_AFTER, now = Date.now, schedule = setTimeout, cancel = clearTimeout, signal } = {}) {
  const sessions = new Map(); // session → { names: call → tool, blocking: call → when it started, steers: messages waiting for its next step }
  const users = new Set(); // messages sent as a message (steered or queued) that wait
  const timers = new Map();
  const of = session => {
    if (!sessions.has(session)) sessions.set(session, { names: new Map(), blocking: new Map(), steers: new Set() });
    return sessions.get(session);
  };
  const forget = session => {
    sessions.delete(session);
    cancel(timers.get(session));
    timers.delete(session);
  };
  signal?.addEventListener("abort", () => { for (const session of [...timers.keys()]) forget(session); }, { once: true });
  const consider = session => {
    const { blocking, steers } = of(session);
    if (!blocking.size || !steers.size || timers.has(session) || signal?.aborted) return;
    const due = Math.min(...blocking.values()) + after;
    timers.set(session, schedule(() => {
      timers.delete(session);
      const { blocking, steers } = of(session);
      if (!blocking.size || !steers.size) return;
      // The call it was timed by ended meanwhile: the next one gets its moment too.
      if (Math.min(...blocking.values()) + after > now()) return consider(session);
      background(session);
      timers.set(session, schedule(() => { timers.delete(session); consider(session); }, after));
    }, Math.max(0, due - now())));
  };
  const steer = (session, inbox) => {
    of(session).steers.add(inbox);
    consider(session);
  };
  return event => {
    const data = event?.data ?? {};
    const session = data.sessionID;
    if (typeof session !== "string") return;
    switch (event.type) {
      case "session.tool.input.started":
        if (typeof data.id === "string") of(session).names.set(data.id, data.name);
        break;
      case "session.tool.called": {
        const kept = of(session);
        const name = data.name ?? kept.names.get(data.id);
        kept.names.delete(data.id);
        if (!["shell", "subagent"].includes(name) || data.input?.background === true) break;
        kept.blocking.set(data.id, now());
        consider(session);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed":
        sessions.get(session)?.names.delete(data.id);
        sessions.get(session)?.blocking.delete(data.id);
        break;
      case "session.inbox.enqueued":
        if (data.item?.type !== "user") break;
        users.add(data.inboxID);
        if (data.item.delivery === "steer") steer(session, data.inboxID);
        break;
      // Sent now, from the queue (Send Now): read at once too; put back in the queue: not.
      case "session.inbox.delivery.changed":
        if (data.delivery === "steer" && users.has(data.inboxID)) steer(session, data.inboxID);
        else sessions.get(session)?.steers.delete(data.inboxID);
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        users.delete(data.inboxID);
        sessions.get(session)?.steers.delete(data.inboxID);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        forget(session);
        break;
    }
  };
}

// Moves what a session waits on in the foreground (its commands, its subagents) to the background.
function backgroundTools(engine, session) {
  return fetch(`http://127.0.0.1:${engine.port}/api/session/${encodeURIComponent(session)}/background`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(10_000),
  });
}

// Waits `ms`, or until `signal` stops it.
const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

// Follows `source`'s events (the engine's, or the coding agents' bridge's: `read` gives its port
// and password) for as long as the bridge runs (or until `signal` stops it, a test's), handing
// each one's notification to `tell` and each request answered to `answered`, and doing what the
// box does as they come.
// `bots`: only its bots' part (this Mac's box, whose app does the rest of a machine's work);
// `notices`: news for your phones too (a machine's, and this Mac's box while its phone link is
// on); `signIns`: sign-ins its engine's runs were refused noted (`kuvo/accounts/ended`); `hold`:
// where those notices wait, settled each time the events are heard again (`settleHeld`).
// What a box watches its engine and its coding agents' bridge for, as a machine's link (`run`)
// and a box's own work (`serve`) both start it: its bots kept told what they are, its sign-ins that
// ended noted, and with `notices`, its news for your phones (`tell`, held in `hold`). `bots`: only
// its bots' part of the box's work (this Mac's box, whose app does the rest).
export function watchBox({ tell = () => true, hold = null, bots = false, notices = !bots, signal, signedIn } = {}) {
  const answered = id => hold?.resolve(id);
  watchEvents(readEngineFile, tell, signal, answered, { bots, notices, signIns: true, hold, signedIn, steers: true });
  watchEvents(readBridgeFile, tell, signal, answered, { bots, notices });
}

// `signedIn`: told once each event's been looked at for sign-ins (a test waits on it).
// `steers`: your messages to an agent waiting on a command read at once (`steering`), the engine's.
export async function watchEvents(read, tell, signal, answered = () => {}, { bots = false, notices = !bots, signIns = false, hold = null, signedIn = () => {}, steers = false, steerAfter } = {}) {
  let attempt = 0;
  while (!signal?.aborted) {
    // What this connection set going ends with it: what it heard of can't be settled once it's gone.
    const connection = new AbortController();
    const stop = () => connection.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const source = read();
      const steer = steers ? steering(session => backgroundTools(source, session).catch(() => {}), { after: steerAfter, signal: connection.signal }) : null;
      const response = await fetch(`http://127.0.0.1:${source.port}/api/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${source.password}`).toString("base64")}`, accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      attempt = 0;
      // What was answered while its events couldn't be heard (it restarted, the stream dropped).
      if (notices && hold) settleHeld(source, hold).catch(() => {});
      // Found it (it started, or this did): its bots told what they are now, before their next turn.
      freshenBots(source).catch(() => {});
      for await (const event of serverEvents(response.body)) {
        // The box's own work, Mac connected or not: a session made in one of its worktrees told
        // so; a worktree's branch named after its session; a bot's job read from its memory as
        // its run ends.
        // A bot's run starting: what it's told brought up to date first.
        if (event.type === "session.execution.started") freshenBot(source, event.data?.sessionID).catch(() => {});
        steer?.(event);
        if (signIns) noteSignIn(event, source).catch(() => {}).finally(() => signedIn(event));
        if (!bots) {
          if (event.type === "session.created") tellWorktree(source, event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
          if (event.type === "session.renamed") nameWorktreeBranch(source, event.data?.sessionID).catch(() => {});
        }
        if (!notices) continue;
        if (ANSWERED.has(event.type)) answered(event.data?.requestID ?? event.data?.id);
        if (!NEWS.has(event.type) && !GROUP_NEWS.has(event.type)) continue;
        if (GROUP_NEWS.has(event.type)) {
          const notice = groupNotice(event);
          if (notice) tell(notice);
          continue;
        }
        noticeFor(event, route => engineGet(source, route)).then(notice => notice && tell(notice)).catch(() => {});
      }
    } catch {}
    stop();
    signal?.removeEventListener("abort", stop);
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}

// ---- Sign-ins that ended (PROTOCOL.md, "kuvo/accounts") ----
// A run on this box's engine refused its model's sign-in (it ran out and couldn't be renewed: the
// engine says only "Request failed" then), by provider: the credential in use then. A step on that
// provider's model that ends well says it works after all; signed in again, the one in use is
// another, and it isn't ended. Kept in `run/ended-sign-ins.json`, so whichever of the box's
// processes answers (its link, `box route`) says the same, and a box started again still knows.

const ENDED_SIGN_INS_FILE = path.join(RUN, "ended-sign-ins.json");

function readEndedSignIns() {
  try {
    const kept = JSON.parse(fs.readFileSync(ENDED_SIGN_INS_FILE, "utf8"));
    return new Map(Object.entries(isObject(kept) ? kept : {}).filter(([, credential]) => typeof credential === "string"));
  } catch {
    return new Map();
  }
}

function changeEndedSignIns(change) {
  const ended = readEndedSignIns();
  change(ended);
  try {
    if (ended.size) writePrivate(ENDED_SIGN_INS_FILE, JSON.stringify(Object.fromEntries(ended)));
    else fs.rmSync(ENDED_SIGN_INS_FILE, { force: true });
  } catch {}
}

export async function noteSignIn(event, source) {
  const ended = event.type === "session.execution.failed";
  if (!ended && (event.type !== "session.step.ended" || !readEndedSignIns().size)) return;
  if (ended && (event.data?.error?.type !== "provider.auth" || !String(event.data?.error?.message ?? "").startsWith("Request failed"))) return;
  const id = event.data?.sessionID;
  if (typeof id !== "string") return;
  const provider = (await engineGet(source, `api/session/${encodeURIComponent(id)}`))?.data?.model?.providerID;
  if (typeof provider !== "string") return;
  if (!ended) return void changeEndedSignIns(each => each.delete(provider));
  const active = await activeCredential(source, provider);
  if (active?.method === "oauth" && active.credentialID) changeEndedSignIns(each => each.set(provider, active.credentialID));
}

// `provider`'s sign-in in use, as its engine lists it.
async function activeCredential(engine, provider) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  return (Array.isArray(integrations) ? integrations : []).find(each => each?.id === provider)?.connections?.find(each => each?.type === "credential") ?? null;
}

// The plans whose sign-in in use ended.
export async function endedProviders(engine) {
  const providers = [];
  for (const [provider, credential] of readEndedSignIns()) {
    if ((await activeCredential(engine, provider).catch(() => null))?.credentialID === credential) providers.push(provider);
  }
  return providers.sort();
}

// Signs this box out of one of your plans (Settings › Accounts' Disconnect): its sign-ins and keys,
// never an integration's server. False for what isn't a plan here.
export async function forgetPlan(engine, id) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  const plan = (Array.isArray(integrations) ? integrations : []).find(each => each?.id === id);
  if (!plan || plan.metadata?.source === "mcp") return false;
  const entries = (await engineGet(engine, "api/credential"))?.data;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.integrationID !== id || typeof entry.id !== "string") continue;
    await fetch(`http://127.0.0.1:${engine.port}/api/credential/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    }).then(response => response.body?.cancel()).catch(() => {});
  }
  changeEndedSignIns(each => each.delete(id));
  return true;
}

// ---- What agents ask you for while they browse here (PROTOCOL.md, "kuvo/asks") ----
// The browser on this machine keeps what's asked in run/browser-asks.json (kuvo-browser.js): a
// phone answers it here as on the Mac, with the Mac closed too, and the answer goes to the
// browser over its socket. Its sign-ins are typed on the phone: saved passwords are the Mac's.

const ASKS_FILE = path.join(RUN, "browser-asks.json");
const BROWSER_SOCKET = path.join(RUN, "browser.sock");
const BROWSER_PID = path.join(RUN, "browser.pid");

// What's asked now: none while the browser isn't running (what one that ended, or a restart, left
// was asked of no one now).
export function readAsks(browserRuns = () => runs(Number(fs.readFileSync(BROWSER_PID, "utf8")), "kuvo-browser")) {
  try {
    if (!browserRuns()) return [];
    const asks = JSON.parse(fs.readFileSync(ASKS_FILE, "utf8")).asks;
    return Array.isArray(asks) ? asks.filter(ask => typeof ask?.id === "string" && ["signIn", "code", "action"].includes(ask.kind)) : [];
  } catch {
    return [];
  }
}

// One as the Mac's `kuvo/asks` lists it: this machine's name, who asks (`asker`, the asking
// conversation's name), and no saved passwords to pick from.
export function listedAsk(ask, machine, asker) {
  const listed = { id: ask.id, kind: ask.kind, host: String(ask.host ?? ""), machine };
  if (typeof ask.session === "string") listed.session = ask.session;
  if (asker) listed.asker = asker;
  if (ask.kind === "signIn") Object.assign(listed, { username: Boolean(ask.username), password: Boolean(ask.password), saved: [], offersToSave: false });
  if (ask.kind === "code") listed.prompt = String(ask.prompt ?? "");
  if (ask.kind === "action") listed.instruction = String(ask.instruction ?? "");
  return listed;
}

// A phone's answer (`POST kuvo/asks/<id>`) as the browser takes it, by the Mac's rules; null for
// one that doesn't fit the ask, or names a saved password (the Mac's alone).
export function askAnswer(ask, given) {
  const text = value => typeof value === "string" && value !== "" ? value : undefined;
  switch (given?.answer) {
    case "signIn": {
      if (ask.kind !== "signIn" || given.saved != null) return null;
      const username = text(given.username), password = text(given.password);
      return username || password ? { type: "signIn", username, password } : null;
    }
    case "code": {
      const code = typeof given.code === "string" ? given.code.trim() : "";
      return ask.kind === "code" && code ? { type: "code", code } : null;
    }
    case "done":
      return ask.kind === "action" ? { type: "done" } : null;
    case "declined":
      return { type: "declined" };
    default:
      return null;
  }
}

// Gives the browser an answer over its socket; true once it took it.
export function answerAsk(id, answer, socketPath = BROWSER_SOCKET) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const done = ok => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5000);
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "Kuvo.answer", params: { id, answer } }) + "\n"));
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try { if (JSON.parse(line).id === 1) return done(true); } catch {}
      }
    });
  });
}

// The notification for an ask, as the Mac words it.
export function askNotice(ask, asker) {
  const host = String(ask.host ?? "");
  const title = { signIn: `Sign in to ${host}`, code: `Code for ${host}`, action: `Your turn on ${host}` }[ask.kind];
  const body = ask.kind === "signIn" ? "The agent needs your sign-in to go on."
    : ask.kind === "code" ? (ask.prompt || "The agent needs a code to go on.") : String(ask.instruction ?? "");
  const session = typeof ask.session === "string" ? ask.session : undefined;
  return { title, subtitle: asker || undefined, body, category: "ask", thread: session ?? ask.id, data: { ...(session ? { session } : {}), ask: ask.id } };
}

// The conversation an ask goes to, as the Mac has it: a subagent's is the one it works for, which
// shows it and waits on you; with its name. From the engine, kept a while.
const conversations = new Map();
async function conversationOf(session, readEngine = readEngineFile) {
  if (!session) return null;
  if (conversations.has(session)) return conversations.get(session);
  try {
    const engine = readEngine();
    let current = (await engineGet(engine, `api/session/${encodeURIComponent(session)}`)).data;
    for (let step = 0; step < 5 && current?.parentID; step++) current = (await engineGet(engine, `api/session/${encodeURIComponent(current.parentID)}`)).data;
    const found = { id: current?.id ?? session, name: current?.title || null };
    if (conversations.size > 200) conversations.clear();
    conversations.set(session, found);
    return found;
  } catch {
    return { id: session, name: null };
  }
}

// An ask as it's listed and told: in its conversation, by its name.
async function inConversation(ask, readEngine) {
  const conversation = await conversationOf(ask.session, readEngine);
  return { ask: conversation ? { ...ask, session: conversation.id } : ask, asker: conversation?.name ?? null };
}

// What's asked, to your phones' notifications, once (again if it didn't go): each once it's still
// asked a look later, so one a Mac answers at once (with a saved password) never buzzes a phone.
// `tell` says whether it went; `answered` hears of one told that's no longer asked. Every `every`
// ms, until `signal` stops it; `read`: what's asked (a test's).
export async function watchAsks(tell, { signal, every = 2000, read = readAsks, answered = () => {} } = {}) {
  const told = new Set();
  let seen = new Set();
  while (!signal?.aborted) {
    try {
      const asks = read();
      const open = new Set(asks.map(ask => ask.id));
      for (const id of told) {
        if (open.has(id)) continue;
        told.delete(id);
        answered(id);
      }
      for (const ask of asks) {
        if (told.has(ask.id) || !seen.has(ask.id)) continue;
        const { ask: shown, asker } = await inConversation(ask);
        if (tell(askNotice(shown, asker))) told.add(ask.id);
      }
      seen = open;
    } catch {}
    await pause(every, signal);
  }
}

// ---- Personalities you make (PROTOCOL.md, "Personalities") ----
// One library on every computer: each keeps its copy, and copies meet box to box (each box's view
// is a document of its own, PROTOCOL.md "Documents") and as a Mac connects: per personality a
// removal wins, and stays noted so no copy brings it back; otherwise the newest change, by a count
// each change moves on from the one before it (`updated`), whatever any clock says. Kuvo Code's own
// presets aren't in it; they come with the kit.

// Beside the bots: where a Mac's app keeps them (KUVO_BOTS), a machine in its own folder.
const PERSONALITIES_FILE = path.join(BOTS, "personalities.json");
const PERSONALITIES_LOCK = path.join(RUN, ".personalities.lock");
// Those following the library (`kuvo/personalities/events`), told of each change written here.
const personalityFollowers = new Set();
const PERSONALITY_ID = /^custom\.[A-Za-z0-9._-]{1,80}$/;
// Removals noted, the newest kept.
const MOST_REMOVALS = 500;
// A change's count no higher than this, so the next one is always higher.
const MOST_COUNT = 2 ** 52;

const changedAt = entry => Number(entry?.removed ?? entry?.updated ?? 0) || 0;
const isRemoval = entry => entry?.removed !== undefined;

// One personality as kept: what's needed, plain and of a sane length; null for what isn't one.
function keptPersonality(entry) {
  if (!isObject(entry) || !PERSONALITY_ID.test(String(entry.id)) || changedAt(entry) > MOST_COUNT) return null;
  if (isRemoval(entry)) return Number.isFinite(Number(entry.removed)) ? { id: entry.id, removed: Number(entry.removed) } : null;
  const name = plainName(entry.name).slice(0, 80);
  const description = String(entry.description ?? "").trim().slice(0, 2000);
  if (!name || !description) return null;
  return { id: entry.id, name, description, symbol: typeof entry.symbol === "string" && entry.symbol ? entry.symbol.slice(0, 80) : "person.crop.circle", updated: Number(entry.updated) || 0 };
}

// The take of one personality that wins: a removal over any change; else the newer change, and at
// the same count the one whose words sort last, so every copy picks the same.
function newerTake(a, b) {
  if (isRemoval(a) !== isRemoval(b)) return isRemoval(a) ? a : b;
  const at = changedAt(a), bt = changedAt(b);
  if (at !== bt) return at > bt ? a : b;
  return `${a.name ?? ""}\n${a.description ?? ""}` >= `${b.name ?? ""}\n${b.description ?? ""}` ? a : b;
}

// Libraries as one: `{personalities, removed}`, in the order they were first seen.
export function mergePersonalities(...libraries) {
  const byID = new Map();
  for (const library of libraries) {
    for (const entry of [...(Array.isArray(library?.personalities) ? library.personalities : []), ...(Array.isArray(library?.removed) ? library.removed : [])]) {
      const kept = keptPersonality(entry);
      if (!kept) continue;
      const had = byID.get(kept.id);
      byID.set(kept.id, had ? newerTake(had, kept) : kept);
    }
  }
  const all = [...byID.values()];
  return {
    personalities: all.filter(entry => !isRemoval(entry)),
    removed: all.filter(isRemoval).sort((a, b) => b.removed - a.removed).slice(0, MOST_REMOVALS),
  };
}

export function readPersonalities(file = PERSONALITIES_FILE) {
  try {
    return mergePersonalities(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { personalities: [], removed: [] };
  }
}

// Changes this computer's copy under its lock: `change` gets it and gives it back changed.
export function changePersonalities(change, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  return locked(lock, () => {
    const library = mergePersonalities(change(readPersonalities(file)));
    // Written only when it changed (a Mac meets this copy every minute).
    const text = JSON.stringify({ kuvo: 1, ...library }, null, 2) + "\n";
    if (textOf(file) !== text) {
      writePrivate(file, text);
      for (const tell of personalityFollowers) tell();
    }
    return library;
  });
}

// Another copy met with this one's, under its lock: the ids whose personality or removal changed
// here. Met whole, past what a document holds too, so every copy comes to the same (one past it
// just isn't given to the others until it's smaller, `ownDocs`).
function meetPersonalities(given, file, lock) {
  let changed = [];
  changePersonalities(library => {
    const was = new Map([...library.personalities, ...library.removed].map(entry => [entry.id, JSON.stringify(entry)]));
    const met = mergePersonalities(library, given);
    changed = [...met.personalities, ...met.removed].filter(entry => was.get(entry.id) !== JSON.stringify(entry)).map(entry => entry.id);
    return met;
  }, file, lock);
  return changed;
}

// Another copy met with this one's (a peer's view, a Mac's over SSH): the personalities that changed
// here, whose bots here are told what they are now.
export async function takePersonalities(given, readEngine = readEngineFile, readBridge = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const changed = meetPersonalities(given, file, lock);
  if (changed.length) await retellBots(changed, readEngine, readBridge).catch(() => {});
  return changed;
}

// The library whole, as this box keeps it and signs it (`kuvo/personalities/document`).
export function personalitiesDocument(file = PERSONALITIES_FILE) {
  return { kuvo: 1, ...readPersonalities(file) };
}

// Another computer's copy, given by the app beside this box (`kuvo/personalities/take`), met with
// this one's by the same rules as a peer's: `[status, value]`, with the ids that changed here. Their
// bots here are told (not waited for), and the other boxes, as after a change through the routes.
export function takePersonalitiesDocument(body, readEngine = readEngineFile, readBridge = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const given = body?.document;
  if (!isObject(given) || !Array.isArray(given.personalities) || (given.removed !== undefined && !Array.isArray(given.removed))) {
    return [400, { message: "Send a library of personalities: {document: {personalities, removed}}." }];
  }
  const changed = meetPersonalities(given, file, lock);
  if (changed.length) {
    noteDocsChanged();
    retellBots(changed, readEngine, readBridge).catch(() => {});
  }
  return [200, { changed }];
}

// Bots here whose personality is among `ids` (changed, or gone), told what they are now, as a
// Mac asks after a change to your personalities (`kuvo/bots/retell`).
export async function retellBots(ids, readEngine = readEngineFile, readBridge = readBridgeFile) {
  const kit = readKit();
  if (!kit) return;
  for (const here of listOf(BOTS).map(botHere)) {
    if (!here || !ids.includes(here.described.personality) || isMoving(here.folder)) continue;
    let target = null;
    try { target = here.agents ? readBridge() : readEngine(); } catch {}
    if (!target?.port) continue;
    await tellBot(target, here, here.session, toldNow(kit, here));
  }
}

// What a phone asks of the library (`kuvo/personalities`): `[status, value]`.
export function answerPersonalities(method, id, body, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const now = Date.now();
  const incomplete = [400, { message: "A personality needs a name and a description." }];
  const full = [400, { message: FULL_LIBRARY }];
  if (id === undefined) {
    if (method === "GET") return [200, { personalities: readPersonalities(file).personalities }];
    if (method !== "POST") return [405, {}];
    const made = keptPersonality({ id: `custom.${crypto.randomUUID().toLowerCase()}`, name: body?.name, description: body?.description, updated: now });
    if (!made) return incomplete;
    let refused = false;
    changePersonalities(library => {
      const after = { ...library, personalities: [...library.personalities, made] };
      if (fitsLibrary(after)) return after;
      refused = true;
      return library;
    }, file, lock);
    if (refused) return full;
    noteDocsChanged();
    return [200, made];
  }
  if (!PERSONALITY_ID.test(id)) return [404, {}];
  let found = null;
  if (method === "PATCH") {
    let refused = null;
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      const changed = keptPersonality({ ...kept, name: body?.name ?? kept.name, description: body?.description ?? kept.description, updated: kept.updated + 1 });
      if (!changed) { refused = incomplete; return library; }
      const after = { ...library, personalities: library.personalities.map(each => each.id === id ? changed : each) };
      if (!fitsLibrary(after)) { refused = full; return library; }
      found = changed;
      return after;
    }, file, lock);
    if (refused) return refused;
    if (found) noteDocsChanged();
    return found ? [200, found] : [404, {}];
  }
  if (method === "DELETE") {
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      found = kept;
      // Counted past its last change; among removals, the newest are the ones kept.
      return { personalities: library.personalities.filter(each => each.id !== id), removed: [...library.removed, { id, removed: Math.max(now, kept.updated + 1) }] };
    }, file, lock);
    if (found) noteDocsChanged();
    return found ? [200, {}] : [404, {}];
  }
  return [405, {}];
}

// The library fits in one document, with room to spare; a change that would take it past that is
// refused, as on the Mac.
const FULL_LIBRARY = "There’s no room for more in your personalities. Shorten or remove one, then try again.";
const fitsLibrary = library => Buffer.byteLength(JSON.stringify(mergePersonalities(library))) <= MOST_DOC - 4096;

// The personalities a bot made here can have: the kit's presets, then the library's, each with
// what the bot is told (`personalityWords`, as the Mac words it).
export function botPersonalities(kit, library = readPersonalities()) {
  const told = each => kit.personalityWords.replaceAll("⟦name⟧", each.name).replaceAll("⟦description⟧", each.description);
  const presets = kit.personalities.filter(each => !each.custom);
  // Ones you made that a Mac's kit lists and this copy of the library hasn't had yet: the kit's,
  // until the library has them.
  const fromKit = kit.personalities.filter(each => each.custom && !library.personalities.some(mine => mine.id === each.id) && !library.removed.some(gone => gone.id === each.id));
  return [...presets, ...fromKit, ...library.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: true, instruction: told(each) }))];
}

// ---- This box's own settings (PROTOCOL.md, "kuvo/config") ----
// The engine's settings file, which the engine reloads when it changes: this box's own, changed
// from any client (the Mac app, a phone) by the same rules. Each computer keeps its own; nothing
// copies them between computers but you ("Also Apply to…", `applySettings`). Writes take
// `run/.config.lock`.

// COMPAT(0.7 settings): until a Mac adopts them (`adoptBox`), a machine's settings are the ones an older Mac's start left. Goes 3 months after 0.8.0.
// A machine's own settings and keys, in a folder of their own (`box`), which no older Kuvo Code
// writes: the engine reads the file (`OPENCODE_CONFIG`, over the global one) and reloads it when it
// changes. Before a Mac made them the machine's own (`adoptBox`), its Mac's.
const BOX = path.join(K, "box");
// This Mac's box: its settings are the app's engine's, where they've always been (KUVO_ENGINE_CONFIG,
// the engine's XDG_CONFIG_HOME), its own from the start; its keys are in the Mac's Keychain, which
// the engine reads from the files the app writes them to (KUVO_KEYS); and the servers that use a
// Mac's own apps run here.
const ENGINE_CONFIG = process.env.KUVO_ENGINE_CONFIG;
export const IS_MAC = Boolean(ENGINE_CONFIG);
const CONFIG_FILE = IS_MAC ? path.join(ENGINE_CONFIG, "opencode", "opencode.json") : path.join(BOX, "opencode.json");
const BOX_KEYS = path.join(BOX, "keys");
const OWN_MARK = IS_MAC ? null : CONFIG_FILE;
const CONFIG_LOCK = path.join(RUN, ".config.lock");
// What a Mac's start used to write: its settings in the global file, the rest beside its keys.
const GLOBAL_FILE = path.join(K, "config", "opencode", "opencode.json");
const MAC_SETTINGS = path.join(K, "keys", "settings.json");
const MAC_KEYS = path.join(K, "keys");
const LAUNCH_LOCK = path.join(RUN, ".launching");
// Settings › MCP Servers' popular servers, as the Mac lists them, which it puts here as it connects.
const CATALOG_FILE = path.join(K, "bin", "mcp-catalog.json");
const SERVERS = ["mcp", "servers"];

// COMPAT(0.7 settings): the routes answer 409 until a Mac adopts the settings an older Mac's start left. Goes 3 months after 0.8.0.
export const ownsSettings = (mark = OWN_MARK) => mark === null || fs.existsSync(mark);

const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;

// The file's settings: {settings}, none for a file that isn't there yet, or {problem} for one that
// can't be read (not plain JSON, a link to a file that isn't there, no permission), left alone:
// a write would put something else in its place.
export function readSettings(file = CONFIG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch {}
    if (error?.code === "ENOENT" && !link) return { settings: {} };
    return { problem: link && error?.code === "ENOENT"
      ? "It's a link to a file that isn't there, so Kuvo Code leaves it alone."
      : `It couldn't be read, so Kuvo Code leaves it alone (${error?.code ?? error?.message}).` };
  }
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!isObject(parsed)) throw new Error("not an object");
    return { settings: parsed };
  } catch {
    return { problem: "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)" };
  }
}

const valueAt = (object, keys) => keys.reduce((current, key) => isObject(current) ? current[key] : undefined, object);

// `object` with `value` at `keys` (nil removes it, and an object it leaves empty).
function settingAt(object, keys, value) {
  const [key, ...rest] = keys;
  const next = { ...object };
  if (!rest.length) {
    if (value === null || value === undefined) delete next[key]; else next[key] = value;
    return next;
  }
  const inner = settingAt(isObject(next[key]) ? next[key] : {}, rest, value);
  if (Object.keys(inner).length) next[key] = inner; else delete next[key];
  return next;
}

// `PATCH kuvo/config`'s changes ({path, value, was?}), made in one write: {status, settings} or
// {status, message}, as the Mac answers.
export function changeSettings(changes, file = CONFIG_FILE, lock = CONFIG_LOCK) {
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every(change =>
    Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16
    && change.path.every(key => typeof key === "string" && key.length >= 1 && key.length <= 200) && "value" in change);
  if (!fits) return { status: 400, message: "Send {\"changes\": [{\"path\": [keys…], \"value\": …}]}." };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    // Keys go through objects only: one through a list or a plain value would replace it whole.
    if (changes.some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    if (changes.some(change => "was" in change && sortedJSON(valueAt(settings, change.path) ?? null) !== sortedJSON(change.was))) {
      return { status: 409, message: "It changed since you read it." };
    }
    return writeSettings(settings, changes, file);
  });
}

// `changes` ({path, value}) made to `settings` and written, under the settings' lock: {status,
// settings}, or {status, message}.
function writeSettings(settings, changes, file) {
  let next = settings;
  for (const change of changes) next = settingAt(next, change.path, keysNamedHere(change.value));
  // Through a link (to a dotfiles folder, say) to the file it names, so the link stays a link.
  const target = linkTarget(file);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(sortedKeys(next), null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    // Nothing half written left beside it.
    fs.rmSync(temporary, { force: true });
    return { status: 500, message: `It couldn't be saved: ${error.message}` };
  }
  return { status: 200, settings: next };
}

// The file a link names, link after link; `file` itself when it isn't a link.
function linkTarget(file) {
  let target = file;
  for (let i = 0; i < 8; i++) {
    let destination;
    try { destination = fs.readlinkSync(target); } catch { break; }
    target = path.resolve(path.dirname(target), destination);
  }
  return target;
}

// Objects merged key by key, `over` winning; a list or a plain value is replaced whole.
export function deepMerged(under, over) {
  if (!isObject(under) || !isObject(over)) return over === undefined ? under : over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) merged[key] = key in under ? deepMerged(under[key], value) : value;
  return merged;
}

// The box's folder as its settings name it: "~/.kuvo-code", as the Mac's start wrote key paths.
const home = os.homedir();
const shownRoot = K.startsWith(home + "/") ? "~" + K.slice(home.length) : K;

// Key paths the Mac's start wrote (`<root>/keys/KUVO_KEY_…`), as the box keeps its keys now.
function boxKeyPaths(value) {
  if (typeof value === "string") {
    return value.split(`{file:${shownRoot}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`)
      .split(`{file:${K}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`);
  }
  if (Array.isArray(value)) return value.map(boxKeyPaths);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, boxKeyPaths(inner)]));
  return value;
}

const KEY_NAME = /^KUVO_KEY_[A-Za-z0-9_]+$/;

// Where this box's settings name its keys: its own keys' folder, or on a Mac the files the app
// writes its Keychain's keys to (KUVO_KEYS).
const KEYS_NAMED = IS_MAC && process.env.KUVO_KEYS ? process.env.KUVO_KEYS.replace(/\/+$/, "") : `${shownRoot}/box/keys`;

// A key named where another computer keeps its keys (`{file:<its folder>/KUVO_KEY_…}`, from Also
// Apply), named where this box keeps them.
export function keysNamedHere(value) {
  if (typeof value === "string") return value.replace(/\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g, (_, name) => `{file:${KEYS_NAMED}/${name}}`);
  if (Array.isArray(value)) return value.map(keysNamedHere);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, keysNamedHere(inner)]));
  return value;
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Makes the machine's settings its own, once (a box of its own: PROTOCOL.md, "Settings per box"):
// what it runs with now, as its Mac's start left them (the global file under the Mac's own, which
// wins), with the keys beside them, goes in its box; or, on a machine with none, `seed` ({settings,
// keys}: the Mac's, as it would have sent them). The launch's lines for them go, so no start writes
// them back. An engine running now keeps reading what it started with, untouched; the next start
// reads the box, and clears what's below it (`global-adopted` says the global file came in whole).
// Under the launch's lock and the settings' own, so no start or change comes between.
// {status: "own" | "adopted", seeded, settings}.
// COMPAT(0.7 settings): makes the settings an older Mac's start left the box's own. Goes 3 months after 0.8.0.
export function adoptBox(seed) {
  return locked(LAUNCH_LOCK, () => locked(CONFIG_LOCK, () => {
    if (fs.existsSync(CONFIG_FILE)) {
      addDefaultRules();
      return { status: "own", settings: readSettings().settings ?? {} };
    }
    const global = readSettings(GLOBAL_FILE);
    const mac = readSettings(MAC_SETTINGS);
    const before = deepMerged(global.settings ?? {}, mac.settings ?? {});
    const seeded = !Object.keys(before).length && isObject(seed?.settings);
    const settings = boxKeyPaths(seeded ? seed.settings : before);
    fs.mkdirSync(BOX_KEYS, { recursive: true, mode: 0o700 });
    fs.chmodSync(BOX, 0o700);
    if (seeded) {
      for (const [name, value] of Object.entries(isObject(seed.keys) ? seed.keys : {})) {
        if (KEY_NAME.test(name) && typeof value === "string") writePrivate(path.join(BOX_KEYS, name), value);
      }
    } else {
      // The shared keys; a bot's own (`…__<bot>`) stay where its folder names them.
      let names = [];
      try { names = fs.readdirSync(MAC_KEYS); } catch {}
      for (const name of names) {
        if (!KEY_NAME.test(name) || name.includes("__")) continue;
        try { writePrivate(path.join(BOX_KEYS, name), fs.readFileSync(path.join(MAC_KEYS, name), "utf8")); } catch {}
      }
    }
    // What it was made from, kept beside it.
    const kept = path.join(BOX, "adopted-from");
    fs.mkdirSync(kept, { recursive: true, mode: 0o700 });
    for (const [file, name] of [[GLOBAL_FILE, "opencode.json"], [MAC_SETTINGS, "settings.json"]]) {
      try { writePrivate(path.join(kept, name), fs.readFileSync(file, "utf8")); } catch {}
    }
    writePrivate(CONFIG_FILE, JSON.stringify(sortedKeys(settings), null, 2) + "\n");
    addDefaultRules();
    // The global file came in whole: the next start empties it (one you edited by hand, with
    // comments, it leaves as it is).
    if (!global.problem) writePrivate(path.join(BOX, "global-adopted"), "");
    const launchEnv = path.join(RUN, "launch.env");
    try {
      const lines = fs.readFileSync(launchEnv, "utf8").split("\n").filter(line => !/^KUVO_(PRIVATE_)?SETTINGS=/.test(line));
      writePrivate(launchEnv, lines.join("\n"));
    } catch {}
    return { status: "adopted", seeded, settings: readSettings().settings ?? settings };
  }, { stale: 300_000, wait: 120_000 }));
}

// What a box starts its engine with, unless its settings set it, each once (`defaults-added` names
// those done), so one you take out stays out:
// - bots' memory, theirs to write in any mode (Plan changes no files): a rule in Settings ›
//   Permissions you see and can take out (`bot-memory`);
// - on a Mac, web search through Exa, which needs no key (the engine has none chosen, and every
//   search fails): in settings that are new or empty, or never given it (`websearch`); and once,
//   Exa in place of "random", as Kuvo Code chose it before (`search-exa`). (A machine's came with
//   the Mac's settings it started from.)
// Under the settings' lock.
export const BOT_MEMORY_RULE = { action: "edit", resource: "*/bots/bot_*/MEMORY.md", effect: "allow" };
const DEFAULTS_ADDED = path.join(BOX, "defaults-added");
function addDefaultRules(mac = IS_MAC, file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  let done = [];
  try { done = fs.readFileSync(marks, "utf8").split("\n").filter(Boolean); } catch {}
  const wanted = mac ? ["bot-memory", "websearch", "search-exa"] : ["bot-memory"];
  if (wanted.every(mark => done.includes(mark))) return;
  const { settings, problem } = readSettings(file);
  if (problem) return;
  const changes = [];
  const exa = { provider: "exa" };
  if (mac && (!Object.keys(settings).length || !done.includes("websearch"))) {
    if (settings.websearch === undefined) changes.push({ path: ["websearch"], value: exa });
    done.push("websearch", "search-exa");
  } else if (mac && !done.includes("search-exa")) {
    if (sameJSON(settings.websearch, { provider: "random" })) changes.push({ path: ["websearch"], value: exa });
    done.push("search-exa");
  }
  if (!done.includes("bot-memory")) {
    const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
    if (!rules.some(rule => sameJSON(rule, BOT_MEMORY_RULE))) changes.push({ path: ["permissions"], value: [...rules, BOT_MEMORY_RULE] });
    done.push("bot-memory");
  }
  if (changes.length && writeSettings(settings, changes, file).status !== 200) return;
  writePrivate(marks, [...new Set(done)].join("\n") + "\n");
}

// This Mac's box, as it starts: its defaults, before any client reads its settings.
export function addMacDefaults(file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  locked(CONFIG_LOCK, () => addDefaultRules(true, file, marks));
}

// `kuvo/keys…`: the box's integrations' keys, through its key store (`keyNames`, `readKey`…), a
// bot's own not among them; where they can't be reached now (this Mac's app not answering), `503`.
async function answerKeys(method, route, body) {
  try {
    if (route === "kuvo/keys") return method === "GET" ? { status: 200, value: { keys: (await keyNames()).filter(name => !name.includes("__")) } } : { status: 405, value: {} };
    const parts = route.split("/");
    let name = "";
    try { name = parts.length === 3 ? decodeURIComponent(parts[2]) : ""; } catch {}
    if (!STORED_KEY.test(name) || name.includes("__")) return { status: 400, value: { message: "That isn't a key's name." } };
    switch (method) {
      case "GET": {
        const value = await readKey(name);
        return value == null ? { status: 404, value: {} } : { status: 200, value: { value } };
      }
      case "PUT": {
        const value = body?.value;
        if (typeof value !== "string" || !value) return { status: 400, value: { message: "Send {\"value\": \"…\"}." } };
        await keyWork(() => writeKey(name, value));
        return { status: 200, value: {} };
      }
      case "DELETE":
        await keyWork(() => deleteKey(name));
        return { status: 200, value: {} };
      default:
        return { status: 405, value: {} };
    }
  } catch (error) {
    if (error instanceof KeysUnavailable) return { status: 503, value: { message: error.message } };
    throw error;
  }
}

// A key of the box's own, set (`value`) or removed (null): integrations' servers read it there.
export function setBoxKey(name, value) {
  if (!KEY_NAME.test(String(name)) || String(name).includes("__")) return { status: 400, message: "That isn't a key's name." };
  return locked(CONFIG_LOCK, () => {
    if (value == null) fs.rmSync(path.join(BOX_KEYS, name), { force: true });
    else writePrivate(path.join(BOX_KEYS, name), String(value));
    return { status: 200 };
  });
}

// The popular servers, as this box has them: on a machine, those that use the Mac's own apps left out.
export function mcpCatalog(settings, file = CATALOG_FILE, mac = IS_MAC) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(file, "utf8")).servers ?? []; } catch {}
  return {
    servers: servers.filter(server => typeof server?.id === "string" && (mac || !server.macOnly)).map(server => {
      const added = valueAt(settings, [...SERVERS, server.id]) !== undefined;
      return { id: server.id, title: String(server.title ?? ""), summary: String(server.summary ?? ""), access: String(server.access ?? "open"),
        added, integration: added && Boolean(server.integration), macOnly: mac && Boolean(server.macOnly) };
    }),
  };
}

// One of them added, as its Add button does; one already there stays as it is.
export function addFromCatalog(id, file = CONFIG_FILE, catalog = CATALOG_FILE, lock = CONFIG_LOCK, mac = IS_MAC) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(catalog, "utf8")).servers ?? []; } catch {}
  const server = servers.find(each => each?.id === id && (mac || !each.macOnly));
  if (!server || !isObject(server.settings)) return { status: 404 };
  const { settings, problem } = readSettings(file);
  if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
  if (valueAt(settings, [...SERVERS, id]) !== undefined) return { status: 200, settings };
  return changeSettings([{ path: [...SERVERS, id], value: { codemode: false, ...server.settings } }], file, lock);
}

// ---- Also Apply (PROTOCOL.md, "kuvo/config/apply") ----
// Changes made to another computer's settings, made to this box's too, when you ask ("Also Apply
// to…"): each as it was made there, {path, before, after} (absent or null: nothing). A list of
// rules (Settings › Permissions' rules and blocks, an agent's) gets what was added there and loses
// what was taken out, keeping the rest of this box's own; anything else (another list, like a
// server's command, too) is set as it is there. What each computer keeps its own (its shell, a
// worktrees folder on its disk) stays as it is; a server that uses a Mac's own apps stays off
// machines; and a field of a server, agent, command or provider this box doesn't have isn't made.

// The engine's own agents, on every computer whether its settings name them or not.
const BUILT_IN_AGENTS = ["build", "plan", "general", "explore", "compaction", "title", "summary"];
const sameJSON = (a, b) => sortedJSON(a ?? null) === sortedJSON(b ?? null);
const isRules = keys => ["permissions", "policies"].includes(keys[keys.length - 1]);

// Something each computer keeps its own: its shell (each picks from its own), and a worktrees
// folder on its disk (one relative to each project goes).
function keptOwn(change) {
  if (sameJSON(change.path, ["shell"])) return true;
  if (!sameJSON(change.path, ["worktree", "directory"])) return false;
  const folder = typeof change.after === "string" ? change.after : typeof change.before === "string" ? change.before : null;
  return folder !== null && (folder.startsWith("/") || folder.startsWith("~"));
}

// The named entry (an MCP server, an agent, a command, a provider) `keys` is a field of, when it's
// one a computer may not have (the engine's own agents it always has).
function entryOf(keys) {
  if (keys[0] === "mcp" && keys.length >= 4 && keys[1] === "servers") return keys.slice(0, 3);
  if (keys[0] === "agents" && keys.length >= 3 && BUILT_IN_AGENTS.includes(keys[1])) return null;
  if (["agents", "commands", "providers"].includes(keys[0]) && keys.length >= 3) return keys.slice(0, 2);
  return null;
}

// What a computer needs to have for `change` to be made there: the entry it's a field of, or the
// agent `default_agent` names.
function neededFor(change) {
  if (sameJSON(change.path, ["default_agent"]) && typeof change.after === "string" && !BUILT_IN_AGENTS.includes(change.after)) return ["agents", change.after];
  return entryOf(change.path);
}

// The servers that use a Mac's own apps, as a Mac's catalog names them (its `macOnly`, and the
// servers it marks so).
function macOnlyServers(file = CATALOG_FILE) {
  try {
    const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
    const named = [...(Array.isArray(catalog.macOnly) ? catalog.macOnly : []), ...(catalog.servers ?? []).filter(server => server?.macOnly).map(server => server.id)];
    return new Set(named.filter(id => typeof id === "string"));
  } catch {
    return new Set();
  }
}

// The keys `value` names: integrations' shared keys, not a bot's own.
function keyNamesIn(value, names = new Set()) {
  if (typeof value === "string") for (const [name] of value.matchAll(/KUVO_KEY_[A-Z0-9_]+/g)) { if (!name.includes("__")) names.add(name); }
  else if (Array.isArray(value)) value.forEach(each => keyNamesIn(each, names));
  else if (isObject(value)) Object.values(value).forEach(each => keyNamesIn(each, names));
  return names;
}

// What `changes` make of `settings`, here: {made: [{path, value}], leftOut: [entry], kept: [path],
// macOnly: [server]}: what's made; the entries it doesn't have that some were to; what it keeps its
// own; and the servers that stay on Macs.
export function translateSettings(changes, settings, { mac = IS_MAC, macOnly = macOnlyServers() } = {}) {
  let here = settings;
  const made = [], leftOut = [], kept = [], stayed = [];
  const has = (list, item) => list.some(each => sameJSON(each, item));
  for (const change of changes) {
    const keys = change.path;
    if (!mac && keys.length >= 3 && keys[0] === "mcp" && keys[1] === "servers" && macOnly.has(keys[2])) {
      if (!stayed.includes(keys[2])) stayed.push(keys[2]);
      continue;
    }
    if (keptOwn(change)) {
      if (!has(kept, keys)) kept.push(keys);
      continue;
    }
    // A field of something this box doesn't have, or the mode new sessions start in when it's an
    // agent it doesn't have: none made with only that (adding or removing a whole one still goes).
    const entry = neededFor(change);
    if (entry && valueAt(here, entry) === undefined) {
      if (!has(leftOut, entry)) leftOut.push(entry);
      continue;
    }
    const before = change.before ?? null, after = change.after ?? null;
    let value = keysNamedHere(after);
    // Rules: none is an empty list, so the first one added (or the last taken out) joins (or
    // leaves) this box's own, rather than standing in for them.
    if (isRules(keys) && (Array.isArray(before) || Array.isArray(after)) && (before === null || Array.isArray(before)) && (after === null || Array.isArray(after))) {
      const was = (before ?? []).map(keysNamedHere), now = (after ?? []).map(keysNamedHere);
      const current = Array.isArray(valueAt(here, keys)) ? valueAt(here, keys) : [];
      const removed = was.filter(item => !has(now, item));
      const added = now.filter(item => !has(was, item));
      const staying = current.filter(item => !has(removed, item));
      const merged = [...staying, ...added.filter(item => !has(staying, item))];
      value = merged.length ? merged : null;
    }
    made.push({ path: keys, value });
    here = settingAt(here, keys, value);
  }
  return { made, leftOut, kept, macOnly: stayed };
}

// `POST kuvo/config/apply` with {changes: [{path, before?, after?}], dry?}: the changes made here
// as `translateSettings` makes them, in one write (none with `dry`). {status, made, leftOut, kept,
// macOnly, keys, applied, settings}: `keys`, those `made` names, for a client to bring along first
// where this box hasn't its own; `applied`, something was made, or every change was already so.
export function applySettings(body, file = CONFIG_FILE, lock = CONFIG_LOCK, options = {}) {
  const changes = body?.changes;
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every(change =>
    Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16
    && change.path.every(key => typeof key === "string" && key.length >= 1 && key.length <= 200));
  if (!fits) return { status: 400, message: "Send {\"changes\": [{\"path\": [keys…], \"before\": …, \"after\": …}]}." };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    const result = translateSettings(changes, settings, options);
    if (result.made.some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    const keys = [...keyNamesIn(result.made.map(change => change.value))].sort();
    const applied = result.made.length > 0 || (!result.leftOut.length && !result.kept.length && !result.macOnly.length);
    if (body.dry === true || !result.made.length) return { status: 200, ...result, keys, applied, settings };
    const written = writeSettings(settings, result.made, file);
    if (written.status !== 200) return written;
    return { status: 200, ...result, keys, applied, settings: written.settings };
  });
}

// ---- State ----

// This Mac's box's link (`runMacLink`): what its app said (`kuvo/link/config`), its keys from the
// app once it has them (with the relay and name, `overlay`, never written), how it stands, and who
// follows that and its phones.
const MAC_OVERLAY = ["key", "secret", "sign", "relay", "name"];
export const macLink = { config: null, overlay: null, status: { state: "off" }, host: null, wake: null, statusFollowers: new Set(), phoneFollowers: new Set() };

export function readLink() {
  let link = null;
  try {
    link = migratedLink(JSON.parse(fs.readFileSync(LINK_FILE, "utf8")));
  } catch {}
  // This Mac's: its keys from its app (kept in your Keychain, never in a file here), and its relay
  // and name as its app says, beside what the file keeps.
  if (IS_MAC && macLink.overlay) return { phones: [], ...(link ?? {}), ...macLink.overlay };
  return link;
}

export function writeLink(link) {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const temporary = `${LINK_FILE}.${process.pid}.tmp`;
  // This Mac's keys and what its app says stay out of the file.
  const kept = IS_MAC ? Object.fromEntries(Object.entries(link).filter(([key]) => !MAC_OVERLAY.includes(key))) : link;
  fs.writeFileSync(temporary, JSON.stringify(kept, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, LINK_FILE);
  if (IS_MAC) {
    for (const tell of macLink.phoneFollowers) tell();
    // Phones no longer paired lose what they have open, whoever removed them, and a link no longer
    // wanted (the last phone gone) leaves the relay: a moment after, so a phone that removed itself
    // gets its answer first (as a machine's bridge does). Known: closing once that answer has gone
    // would be surer than a moment's wait.
    setTimeout(() => {
      macLink.host?.keepOnly(new Set((readLink()?.phones ?? []).map(phone => phone.key)));
      macLinkCheck();
    }, 200);
    return;
  }
  // For the box's keeper, which keeps this bridge running while it's needed.
  if (needed(link)) fs.writeFileSync(NEEDED_FILE, "", { mode: 0o600 });
  else fs.rmSync(NEEDED_FILE, { force: true });
}

// One change to link.json at a time, here and from `setup` and `pair` (other processes): read,
// changed and written under a lock (run/.link.lock), so none writes over another's (a removal,
// say). `change` returns the link to write, or nothing to leave it. A lock left by one that was
// cut off goes after ten seconds; one not had in three goes ahead all the same.
const LOCK = path.join(RUN, ".link.lock");
export function updateLink(change) {
  return locked(LOCK, () => {
    const changed = change(readLink());
    if (changed) writeLink(changed);
    return changed ?? null;
  });
}

// `work` done holding `lock` (a folder, made while it's held): one process at a time. A lock left by
// one that was cut off goes after `stale` ms (ten seconds); one not had in `wait` ms (three) goes
// ahead all the same.
function locked(lock, work, { stale = 10_000, wait = 3_000 } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let i = 0; i < wait / 10 && !held; i++) {
    try {
      fs.mkdirSync(lock);
      held = true;
    } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > stale) fs.rmdirSync(lock); } catch {}
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    if (held) try { fs.rmdirSync(lock); } catch {}
  }
}

// Nothing to answer any more (the last phone gone, a pairing run out, no link.json): the keeper
// starts this bridge no more, unless a pairing began meanwhile.
export function noLongerNeeded() {
  try { fs.rmSync(NEEDED_FILE, { force: true }); } catch {}
  if (needed(readLink())) try { fs.writeFileSync(NEEDED_FILE, "", { mode: 0o600 }); } catch {}
}

// Lets in phones in link.json, and a new one showing the pairing token (once, in time), noting
// where it is on the relay, for its notifications. Where a paired one is changes once its session
// proves its own (confirmPhone): the first handshake message can be replayed from elsewhere.
export function authorizePhone(key, hello, address) {
  const encoded = key.toString("base64url");
  if (!hello?.pair) return Boolean(readLink()?.phones?.some(phone => phone.key === encoded));
  // Showing the token: a pairing of its own, paired before or not (one removed comes back).
  let paired = false;
  updateLink(link => {
    // A phone's (`kuvo/phones/pair`), or, on a Mac, the one its Settings › Phone shows: each apart,
    // so neither ends the other.
    const given = Buffer.from(String(hello.pair), "base64url");
    const slot = ["pairing", "appPairing"].find(name => {
      const pairing = link?.[name];
      if (!pairing || Date.now() > pairing.expires) return false;
      const expected = Buffer.from(pairing.token, "base64url");
      return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
    if (!slot) return null;
    pairPhone(link, { key: encoded, name: String(hello.name ?? "").slice(0, 100), added: Math.floor(Date.now() / 1000), from: "pair", address: address?.toString("base64url"), pairing: newPairing() });
    delete link[slot];
    paired = true;
    return link;
  });
  if (paired) noteDocsChanged();
  return paired || Boolean(readLink()?.phones?.some(phone => phone.key === encoded));
}

// ---- Paired phones (PROTOCOL.md, "Paired phones") ----
// A pairing adds a phone; a removal, from a phone on the list, takes one off for good (`removed`,
// with the pairing it ended): only a pairing of its own, with a new pairing id, lets it back in,
// and nobody removes a Mac. The phones this box pairs and removes are its own phones document; a
// Mac's come in that Mac's, and a removal in any document this box takes is noted here too
// (PROTOCOL.md, "Documents"). The Mac's are the same rules (PairedPhones in KuvoLink), and both
// are held to Vectors/link.json.

const KEY = /^[A-Za-z0-9_-]{43}$/;
const PAIRING = /^[A-Za-z0-9_-]{0,32}$/;
const ADDRESS = /^[A-Za-z0-9_-]{22}$/;
// At most so many in one removal, and so many removals kept (the oldest go first).
const MOST_AT_ONCE = 16;
const MOST_KEPT = 256;

// The Macs that set this machine up (`setup`), whose documents and mail it takes.
export const macsOf = link => [...new Set([...(Array.isArray(link?.macs) ? link.macs : []), ...(typeof link?.mac === "string" ? [link.mac] : [])])];

// A Mac this machine hasn't heard from in 30 days, by its own clock (gone, or its key made anew):
// it's no longer one of its Macs, and its documents no longer count. One back sets the machine up
// again. `keep`, heard from now.
const MAC_GONE_AFTER = 30 * 24 * 3600 * 1000;
export function forgetOldMacs(link, keep, now = Date.now()) {
  link.macSeen ??= {};
  for (const mac of macsOf(link)) link.macSeen[mac] ??= now;
  if (keep) link.macSeen[keep] = now;
  const gone = macsOf(link).filter(mac => mac !== keep && now - link.macSeen[mac] > MAC_GONE_AFTER);
  if (!gone.length) return;
  for (const mac of gone) leaveMac(link, mac);
  if (gone.includes(link.mac)) link.mac = keep;
}

const removedAlready = (link, key, pairing) => (link.removed ?? []).some(r => r.key === key && r.pairing === pairing);

function noteRemoved(link, key, pairing) {
  link.removed ??= [];
  if (!removedAlready(link, key, pairing)) link.removed = [...link.removed, { key, pairing }].slice(-MOST_KEPT);
}

// A phone's key, and its pairing if given, as a removal or a list names it: never a Mac's.
const fits = (entry, macs) => typeof entry?.key === "string" && KEY.test(entry.key) && !macs.includes(entry.key)
  && (entry.pairing == null || (typeof entry.pairing === "string" && PAIRING.test(entry.pairing)));

// `key`'s pairing `pairing` (the one it has here, when not given) taken off: one paired again
// since, with another pairing, stays.
function takeOff(link, key, pairing) {
  const current = (link.phones ?? []).find(phone => phone.key === key);
  const which = pairing == null ? (current?.pairing ?? "") : String(pairing);
  noteRemoved(link, key, which);
  if (current && (current.pairing ?? "") === which) link.phones = link.phones.filter(phone => phone.key !== key);
}

// A new pairing id, made where a phone pairs.
export const newPairing = () => crypto.randomBytes(12).toString("base64url");

// A phone paired here (its pairing token): in, with a pairing of its own, which nothing removed.
// What removed its others still keeps them out.
export function pairPhone(link, phone) {
  link.phones = [...(link.phones ?? []).filter(each => each.key !== phone.key), phone];
}

// Phones this Mac removes (its own box, from its app): Settings › Phone, or the removals a
// machine's phones document brought. Only phones; false, changing nothing, for anything else.
export function removeAsMac(link, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MOST_KEPT || !entries.every(entry => fits(entry, []))) return false;
  for (const entry of entries) takeOff(link, entry.key, entry.pairing);
  return true;
}

// Phones `by` removes ({key, pairing}): only a phone on the list, or a Mac, removes, and only
// phones, a few at a time. False, changing nothing, otherwise.
export function removePhones(link, by, entries) {
  const macs = macsOf(link);
  const allowed = new Set([...(link.phones ?? []).map(phone => phone.key), ...macs]);
  if (!allowed.has(by) || !Array.isArray(entries) || !entries.length || entries.length > MOST_AT_ONCE) return false;
  if (!entries.every(entry => fits(entry, macs))) return false;
  for (const entry of entries) takeOff(link, entry.key, entry.pairing);
  return true;
}

// The phones this box lets in, from its documents (`link.phones`, which the rest reads): the ones
// each of its Macs lists in its phones document (or, for a Mac that hasn't signed one yet, as it
// listed them before), and the ones paired here, less every pairing removed in a document this box
// takes, which it notes as its own removal too, so it stays removed whatever becomes of that
// document. Each keeps when it was added here and where it was last seen.
export function foldPhones(link, now = Date.now()) {
  const macs = macsOf(link);
  for (const doc of phoneDocs(link)) {
    for (const entry of Array.isArray(doc.body.removed) ? doc.body.removed.slice(0, MOST_KEPT) : []) {
      if (fits(entry, macs) && typeof entry.pairing === "string") noteRemoved(link, entry.key, entry.pairing);
    }
  }
  const known = new Map((link.phones ?? []).map(phone => [phone.key, phone]));
  const signed = macs.filter(mac => macDoc(link, mac, "phones"));
  const listed = [];
  const add = phone => {
    if (!fits(phone, macs) || removedAlready(link, phone.key, phone.pairing ?? "") || listed.some(each => each.key === phone.key)) return;
    listed.push(phone);
  };
  for (const mac of macs) {
    const doc = macDoc(link, mac, "phones");
    if (!doc) {
      for (const phone of link.phones ?? []) if (phone.from === "mac" && phone.mac === mac) add(phone);
      continue;
    }
    for (const phone of Array.isArray(doc.body.phones) ? doc.body.phones.slice(0, 64) : []) {
      if (!isObject(phone)) continue;
      add({
        key: phone.key,
        name: String(phone.name ?? "").slice(0, 100),
        added: known.get(phone.key)?.added ?? Math.floor(now / 1000),
        from: "mac",
        mac,
        address: ADDRESS.test(phone.address ?? "") ? phone.address : known.get(phone.key)?.address,
        pairing: typeof phone.pairing === "string" ? phone.pairing : "",
      });
    }
  }
  // One from before Macs were named: kept until a Mac signs its phones.
  if (!signed.length) for (const phone of link.phones ?? []) if (phone.from === "mac" && phone.mac == null) add(phone);
  for (const phone of link.phones ?? []) if (phone.from === "pair") add(phone);
  link.phones = listed;
}

// This box's own phones document: the phones paired here, and every removal it knows of.
const ownPhones = link => ({
  phones: (link.phones ?? []).filter(phone => phone.from === "pair").map(phone => ({ key: phone.key, name: phone.name ?? "", ...(phone.address ? { address: phone.address } : {}), pairing: phone.pairing ?? "" })),
  removed: (link.removed ?? []).map(({ key, pairing }) => ({ key, pairing })),
});

// ---- Documents (PROTOCOL.md, "Documents") ----
// What boxes copy between them: who a Mac's boxes are (its peers document), the phones each box
// pairs and removes (its phones document), and your personalities (each box's view of the
// library). Each origin signs its own with a key of its own (Ed25519: `sign` in link.json, made
// with this box's other keys; a Mac's comes in setup, over SSH), and numbers each version; any box
// passes a copy on, and a box keeps the newest one it can verify from each origin it takes that
// kind from. No clock decides anything: boxes tell each other what they have as they meet
// (`have`), what changed as it changes (`give`), and what they have again with their agents.


// COMPAT(beta.1 peers-list): a Mac that gave no signing key signs no documents. Goes when 0.8.0 ships.
// The signing key a Mac of this box's gave in setup, over SSH; null for one that gave none yet (a
// Mac with Kuvo Code 0.8.0-beta.1, PROTOCOL.md "For released Macs").
const macSign = (link, mac) => (typeof link?.macSigns?.[mac] === "string" && SIGN.test(link.macSigns[mac]) ? link.macSigns[mac] : null);
function macDoc(link, mac, kind) {
  const sign = macSign(link, mac);
  return sign ? held(link.docs?.[docKey(sign, kind)]) : null;
}
// The phones documents this box takes now: its Macs' and its peers'.
const phoneDocs = link => Object.values(link?.docs ?? {}).map(held).filter(doc => doc?.kind === "phones");

// Whether this box takes `kind` from `origin`: who its boxes are, only from its own Macs; phones and
// personalities from those Macs, its peers, and itself (a copy of its own it lost count of).
function takesFrom(link, origin, kind) {
  const macs = macsOf(link).map(mac => macSign(link, mac)).filter(Boolean);
  // (This Mac takes a copy of its own, one it lost count of.)
  if (kind === "peers") return macs.includes(origin) || (IS_MAC && origin === ownSign(link));
  return macs.includes(origin) || origin === ownSign(link) || peersOf(link).some(peer => peer.sign === origin);
}

// Whether the box with the key `to` takes `kind` from `origin`, as far as this box knows: one of
// this box's Macs lists them both (or is `origin`; who a Mac's boxes are, only from that Mac).
function takenBy(link, to, origin, kind) {
  // This Mac's: each of its machines takes all of this Mac's, and the phones and personalities of
  // the others it names (who its boxes are, only from this Mac).
  if (IS_MAC) {
    const peers = peersOf(link);
    return peers.some(peer => peer.key === to) && (origin === ownSign(link) || (kind !== "peers" && peers.some(peer => peer.sign === origin)));
  }
  for (const mac of macsOf(link)) {
    const doc = macDoc(link, mac, "peers");
    const boxes = Array.isArray(doc?.body.boxes) ? doc.body.boxes : [];
    if (!boxes.some(box => box?.key === to)) continue;
    if (origin === doc.origin || (kind !== "peers" && boxes.some(box => box?.sign === origin))) return true;
  }
  return false;
}

// Who this box gives documents to: its peers that sign their own (a Mac that gave no signing key
// yet takes none).
const docPeers = link => peersOf(link).filter(peer => typeof peer.sign === "string");

// A document given (`{d, s}`), taken when it verifies, comes from an origin this box takes that kind
// from, and is newer than the one it has (at the same version, the one whose hash sorts first, so
// every box keeps the same one). Another's personalities aren't kept, only met with this box's own
// (`link.views` notes how far each has come); one of this box's own, newer than it knew of (it lost
// count), moves its count on. The document (`mine` for one of its own), or null.
export function takeDoc(link, envelope) {
  const doc = readDoc(envelope);
  if (!doc || !takesFrom(link, doc.origin, doc.kind)) return null;
  if (doc.origin === ownSign(link)) {
    if ((doc.kind === "peers" && !IS_MAC) || doc.n > MOST_COUNT) return null;
    const had = link.own?.[doc.kind];
    if (had && (doc.n < had.n || (doc.n === had.n && doc.h === had.h))) return null;
    link.own = { ...(link.own ?? {}), [doc.kind]: { n: Math.max(doc.n, had?.n ?? 0), h: doc.h, b: bodyHash(doc.body) } };
    return { ...doc, mine: true };
  }
  const newer = had => !had || doc.n > had.n || (doc.n === had.n && doc.h < had.h);
  if (doc.kind === "personalities") {
    if (!newer(link.views?.[doc.origin])) return null;
    link.views = { ...(link.views ?? {}), [doc.origin]: { n: doc.n, h: doc.h } };
    return doc;
  }
  const key = docKey(doc.origin, doc.kind);
  if (!newer(held(link.docs?.[key]))) return null;
  link.docs = { ...(link.docs ?? {}), [key]: doc.envelope };
  return doc;
}

// Documents from origins this box no longer takes them from (a Mac gone, a box it no longer lists):
// let go. Who its boxes are first, as the rest follows from it.
function pruneDocs(link) {
  for (const kind of DOC_KINDS) {
    for (const [key, envelope] of Object.entries(link.docs ?? {})) {
      const doc = held(envelope);
      if (!doc) delete link.docs[key];
      else if (doc.kind === kind && !takesFrom(link, doc.origin, doc.kind)) delete link.docs[key];
    }
  }
  for (const origin of Object.keys(link.views ?? {})) if (!takesFrom(link, origin, "personalities")) delete link.views[origin];
}

// This box's own document of `kind` with `body`: the version it has, or the next one when `body`
// changed. `{envelope, changed}`, or null without a signing key.
export function ownDoc(link, kind, body) {
  if (!ownSign(link)) return null;
  const b = bodyHash(body);
  const had = link.own?.[kind];
  const changed = !had || had.b !== b;
  const n = changed ? (had?.n ?? 0) + 1 : had.n;
  const envelope = signDoc(link.sign, kind, n, body);
  if (changed) link.own = { ...(link.own ?? {}), [kind]: { n, h: shortHash(Buffer.from(envelope.d, "base64url")), b } };
  return { envelope, changed };
}

// This box's own documents as they are now (its phones, its view of your personalities), each with
// its next version where it changed: `{phones, personalities}`, each `{envelope, changed}`.
function ownDocs(state) {
  const docs = {};
  // This Mac's: who its computers are too; its phones only while the phone link's on (its machines
  // keep what they have meanwhile).
  if (IS_MAC) {
    const peers = ownDoc(state.link, "peers", macPeersBody(state.link));
    if (peers) docs.peers = peers;
  }
  const phones = IS_MAC && !macLink.config?.phones ? null : ownDoc(state.link, "phones", ownPhones(state.link));
  if (phones) docs.phones = phones;
  const library = mergePersonalities(state.library);
  if (Buffer.byteLength(JSON.stringify(library)) <= MOST_DOC - 4096) {
    const personalities = ownDoc(state.link, "personalities", library);
    if (personalities) docs.personalities = personalities;
  }
  return docs;
}

// The kinds a box signs itself: who its boxes are, only a Mac.
const ownKinds = () => (IS_MAC ? DOC_KINDS : ["phones", "personalities"]);

// Who this Mac's computers are, as its peers document says: itself and its machines, each with
// the key it signs with; the conversations being moved; and the machines it removed, so they let
// it go (never one that's still one of its machines).
function macPeersBody(link) {
  const peers = peersOf(link).filter(peer => typeof peer.sign === "string");
  let address = null;
  try { address = addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"); } catch {}
  const me = { key: ownKey(link), sign: ownSign(link), address, name: String(link.name ?? "Mac").slice(0, 100), kind: "mac" };
  const current = new Set(peers.map(peer => peer.key));
  return { boxes: [me, ...peers.map(peer => ({ ...peer, kind: "machine" }))], moved: cleanMoved(link.macMoved), left: (Array.isArray(link.left) ? link.left : []).filter(key => !current.has(key)) };
}

// What this box has, as it tells other boxes: each document's origin, kind, version and hash.
export function digestOf(link) {
  const have = [];
  for (const envelope of Object.values(link?.docs ?? {})) {
    const doc = held(envelope);
    if (doc) have.push([doc.origin, doc.kind, doc.n, doc.h]);
  }
  for (const [origin, seen] of Object.entries(link?.views ?? {})) have.push([origin, "personalities", seen.n, seen.h]);
  const own = ownSign(link);
  if (own) for (const kind of ownKinds()) if (link.own?.[kind]) have.push([own, kind, link.own[kind].n, link.own[kind].h]);
  return have;
}

// A document too big for one mail comes in parts (`{whole, i, of, d, s}`: `whole`, its `d`'s hash),
// put together here, at most four on their way from one box at a time. The document once all are
// here, or null.
function assemble(parts, from, part) {
  if (!isObject(part) || typeof part.whole !== "string" || !Number.isInteger(part.i) || !Number.isInteger(part.of) || part.of < 2 || part.of > MOST_PARTS
    || part.i < 0 || part.i >= part.of || typeof part.d !== "string" || part.d.length > DOC_PART || typeof part.s !== "string") return null;
  const key = `${from} ${part.whole}`;
  let pending = parts.get(key);
  if (!pending || pending.of !== part.of) {
    const theirs = [...parts.keys()].filter(each => each.startsWith(`${from} `));
    if (theirs.length >= 4) parts.delete(theirs[0]);
    pending = { of: part.of, s: part.s, pieces: new Map() };
    parts.set(key, pending);
  }
  pending.pieces.set(part.i, part.d);
  if (pending.pieces.size < part.of) return null;
  parts.delete(key);
  const d = Array.from({ length: part.of }, (_, i) => pending.pieces.get(i)).join("");
  if (crypto.createHash("sha256").update(d).digest("base64url") !== part.whole) return null;
  return { d, s: pending.s };
}

// What goes to one box (`{give, have, reply}`), as the mails it takes: documents together while
// they fit, a bigger one in parts, the digest last.
export function docMails(docs) {
  const mails = [];
  let give = [], size = 0;
  for (const envelope of docs.give ?? []) {
    const length = envelope.d.length + envelope.s.length + 16;
    if (length > 48_000) {
      const whole = crypto.createHash("sha256").update(envelope.d).digest("base64url");
      const of = Math.ceil(envelope.d.length / DOC_PART);
      for (let i = 0; i < of; i++) mails.push({ part: { whole, i, of, d: envelope.d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: envelope.s } });
      continue;
    }
    if (size + length > 48_000 && give.length) {
      mails.push({ give });
      give = [];
      size = 0;
    }
    give.push(envelope);
    size += length;
  }
  if (give.length) mails.push({ give });
  if (docs.have) mails.push({ have: docs.have, ...(docs.reply ? { reply: true } : {}) });
  return mails;
}

// What this box does with documents another box or Mac sent it (`sender`, `{key, sign?}`; `docs`,
// `{give?, part?, have?, reply?}`), as work on `state` (`{link, library, parts}`, changed in place):
// what it takes, the Macs that said this box is no longer theirs, and what goes to whom now
// (`send`, `[{to, docs}]`). Each document it took goes on to the boxes that take it, but back to the
// one it came from; its own that changed, to all of them; and for a digest, what the sender lacks,
// and, unless it's an answer, this box's own digest when the sender has something newer.
// `stay`: a Mac whose removal of this box it doesn't take (the Mac setting it up over SSH now).
export function docsWork(state, sender, docs, { stay = null } = {}) {
  const { link } = state;
  const sends = new Map();
  const to = (peer, change) => {
    const docs = sends.get(peer.key) ?? { peer, give: [] };
    change(docs);
    sends.set(peer.key, docs);
  };
  const given = Array.isArray(docs?.give) ? docs.give.slice(0, 64) : [];
  if (isObject(docs?.part)) {
    state.parts ??= new Map();
    const whole = assemble(state.parts, sender.key, docs.part);
    if (whole) given.push(whole);
  }
  // Who its boxes are first: the rest is taken from the boxes they name.
  const took = [];
  for (const kind of DOC_KINDS) {
    for (const envelope of given) {
      const peeked = held(envelope);
      if (peeked?.kind !== kind) continue;
      const doc = takeDoc(link, envelope);
      if (doc) took.push(doc);
    }
  }
  const left = [];
  const own = ownKey(link);
  for (const doc of took) {
    if (doc.kind !== "peers") continue;
    const mac = macsOf(link).find(each => macSign(link, each) === doc.origin);
    const named = Array.isArray(doc.body.boxes) && doc.body.boxes.some(box => box?.key === own);
    if (mac && !named && Array.isArray(doc.body.left) && doc.body.left.includes(own)) left.push(mac);
  }
  for (const mac of left.filter(each => each !== stay)) leaveMac(link, mac);
  pruneDocs(link);
  foldPhones(link);
  const personalities = took.filter(doc => doc.kind === "personalities").map(doc => doc.body);
  if (personalities.length) state.library = mergePersonalities(state.library, ...personalities);
  // A digest: what the sender lacks, and whether it has something this box lacks.
  let ask = false;
  if (Array.isArray(docs?.have)) {
    const theirs = new Map();
    for (const entry of docs.have.slice(0, 512)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && DOC_KINDS.includes(entry[1]) && Number.isSafeInteger(entry[2])) theirs.set(docKey(entry[0], entry[1]), { n: entry[2], h: String(entry[3] ?? "") });
    }
    const self = ownSign(link);
    // One of this box's own further on than it knew (it lost count): its next one goes past it.
    for (const kind of ownKinds()) {
      const there = self && theirs.get(docKey(self, kind));
      if (there && there.n <= MOST_COUNT && there.n > (link.own?.[kind]?.n ?? 0)) link.own = { ...(link.own ?? {}), [kind]: { n: there.n, h: there.h, b: "" } };
    }
    const senderSign = sender.sign ?? macSign(link, sender.key);
    const behind = (key, n, h) => {
      const there = theirs.get(key);
      return !there || there.n < n || (there.n === n && there.h > h);
    };
    for (const envelope of Object.values(link.docs ?? {})) {
      const doc = held(envelope);
      if (doc && behind(docKey(doc.origin, doc.kind), doc.n, doc.h) && takenBy(link, sender.key, doc.origin, doc.kind)) to(sender, docs => docs.give.push(envelope));
    }
    if (!docs.reply) {
      for (const [key, there] of theirs) {
        const [origin, kind] = key.split(" ");
        if (origin === self || (kind === "personalities" && origin !== senderSign) || !takesFrom(link, origin, kind)) continue;
        const have = kind === "personalities" ? link.views?.[origin] : held(link.docs?.[key]);
        if (!have || have.n < there.n || (have.n === there.n && have.h > there.h)) ask = true;
      }
    }
    state.theirs = theirs;
  }
  const ownNow = ownDocs(state);
  const peers = docPeers(link);
  const mine = ownSign(link);
  for (const doc of took.filter(doc => doc.kind !== "personalities" && !doc.mine)) {
    for (const peer of peers) {
      if (peer.key !== sender.key && peer.sign !== doc.origin && takenBy(link, peer.key, doc.origin, doc.kind)) to(peer, docs => docs.give.push(doc.envelope));
    }
  }
  for (const made of Object.values(ownNow)) {
    if (made.changed) for (const peer of peers) if (takenBy(link, peer.key, mine, "phones")) to(peer, docs => docs.give.push(made.envelope));
  }
  // What the sender's digest lacks of this box's own (those that changed went already).
  if (state.theirs) {
    const senderPeer = peers.find(peer => peer.key === sender.key);
    for (const [kind, made] of Object.entries(ownNow)) {
      const record = link.own[kind];
      const there = state.theirs.get(docKey(mine, kind));
      if (senderPeer && !made.changed && (!there || there.n < record.n || (there.n === record.n && there.h > record.h))) to(senderPeer, docs => docs.give.push(made.envelope));
    }
    delete state.theirs;
  }
  if (ask) {
    const senderPeer = peers.find(peer => peer.key === sender.key) ?? sender;
    to(senderPeer, docs => {
      docs.have = digestOf(link);
      docs.reply = true;
    });
  }
  return {
    took,
    left: left.filter(each => each !== stay),
    send: [...sends.values()].filter(docs => docs.give.length || docs.have).map(({ peer, ...docs }) => ({ to: peer, docs: { ...docs, give: dedupe(docs.give) } })),
  };
}
const dedupe = envelopes => [...new Map(envelopes.map(envelope => [envelope.d, envelope])).values()];

// Meeting the others (just connected): this box's own documents as they are now, and its digest to
// each, so each gives what this one lacks, and asks for what it has.
export function greetWork(state) {
  ownDocs(state);
  const have = digestOf(state.link);
  return { send: docPeers(state.link).map(peer => ({ to: peer, docs: { have } })) };
}

// Something changed here (a phone paired or removed, a personality, a Mac's documents that came by
// SSH): this box's own documents that changed go to every box that takes them, and with `tell`,
// its digest too, so each gives what this one lacks and asks for what it has.
export function changedWork(state, tell = false) {
  const made = Object.values(ownDocs(state)).filter(each => each.changed).map(each => each.envelope);
  const mine = ownSign(state.link);
  const have = tell ? digestOf(state.link) : null;
  return {
    send: docPeers(state.link).filter(peer => takenBy(state.link, peer.key, mine, "phones"))
      .map(peer => ({ to: peer, docs: { give: made, ...(have ? { have } : {}) } }))
      .filter(each => each.docs.give.length || each.docs.have),
  };
}

// A Mac that no longer counts here (it removed this machine, or wasn't heard from in 30 days): what
// it gave goes, and the phones it listed with it; another Mac's stay.
export function leaveMac(link, mac) {
  link.macs = macsOf(link).filter(each => each !== mac);
  if (link.mac === mac) {
    if (link.macs.length) link.mac = link.macs[0];
    else delete link.mac;
  }
  // COMPAT(beta.1 peers-list): `legacy`, a beta.1 Mac's list. Goes when 0.8.0 ships.
  for (const field of ["macSeen", "macSigns", "legacy"]) if (link[field]) delete link[field][mac];
  link.phones = (link.phones ?? []).filter(phone => !(phone.from === "mac" && phone.mac === mac));
}

// ---- Peers (PROTOCOL.md, "Peers") ----
// The other boxes a Mac set this one up with: itself and its other machines, each as that Mac's
// newest peers document names them, so one a Mac removed leaves every box it lists.

const MOST_PEERS = 64;
const fitsPeer = peer => isObject(peer) && typeof peer.key === "string" && KEY.test(peer.key)
  && typeof peer.address === "string" && ADDRESS.test(peer.address) && (peer.kind === "mac" || peer.kind === "machine");
const cleanPeer = ({ key, address, name, kind, id, sign }) => ({ key, address, kind, name: plainName(name).slice(0, 100), ...(typeof id === "string" ? { id: id.slice(0, 200) } : {}), ...(typeof sign === "string" && SIGN.test(sign) ? { sign } : {}) });
const cleanMoved = moved => (Array.isArray(moved) ? moved : []).filter(each => isObject(each) && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && KEY.test(each.key))
  .slice(0, 500).map(({ session, key }) => ({ session, key }));

// COMPAT(beta.1 peers-list): a beta.1 Mac's list of peers, as its peers document. Goes when 0.8.0 ships.
// A list of peers from a Mac that signs no documents yet (Kuvo Code 0.8.0-beta.1, PROTOCOL.md "For
// released Macs"): that Mac's newest, by its own `at`, used as its peers document would be, and
// never passed on. False when it isn't taken.
export function takeLegacyPeers(link, mac, peers, at, moved = []) {
  if (macSign(link, mac) || !Array.isArray(peers) || typeof at !== "number") return false;
  link.legacy ??= {};
  if (at <= (link.legacy[mac]?.at ?? 0)) return false;
  link.legacy[mac] = { at, peers: peers.filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer), moved: cleanMoved(moved) };
  return true;
}

// Each of this box's Macs' word on its boxes: its peers document, or the list it gave before it
// signed them (`legacy`).
function macWords(link) {
  return macsOf(link).map(mac => {
    const doc = macDoc(link, mac, "peers");
    if (doc) return { boxes: Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, MOST_PEERS) : [], moved: doc.body.moved };
    // COMPAT(beta.1 peers-list): a beta.1 Mac's list, in place of its peers document. Goes when 0.8.0 ships.
    return link?.legacy?.[mac] ? { boxes: link.legacy[mac].peers ?? [], moved: link.legacy[mac].moved } : null;
  }).filter(Boolean);
}

// Conversations a Mac moved from one box to another, by where each lives now (its box's key): the
// box it left may still list it, until it's back to let it go.
export function movedOf(link) {
  const moved = new Map();
  // This Mac's own word: what its app says (`kuvo/link/peers`).
  if (IS_MAC) {
    for (const { session, key } of cleanMoved(link?.macMoved)) moved.set(session, key);
    return moved;
  }
  for (const word of macWords(link)) for (const { session, key } of cleanMoved(word.moved)) moved.set(session, key);
  return moved;
}

// This box's peers now: every box its Macs name, itself left out.
export function peersOf(link) {
  if (!link) return [];
  // This Mac's box: its machines, as its app set them up (`kuvo/link/peers`).
  if (IS_MAC) return (Array.isArray(link.macPeers) ? link.macPeers : []).filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer);
  const own = ownKey(link);
  const byKey = new Map();
  for (const word of macWords(link)) {
    for (const peer of word.boxes) if (fitsPeer(peer) && peer.key !== own && !byKey.has(peer.key)) byKey.set(peer.key, cleanPeer(peer));
  }
  return [...byKey.values()];
}

// This box's own public key, as peers name it.
function ownKey(link) {
  try { return publicOf(Buffer.from(link.key, "base64url")).toString("base64url"); } catch { return null; }
}

// COMPAT(beta.1 peers-list): link.json as the bridge beta.1 put on machines (0.9.23) left it. Goes when 0.8.0 ships.
// link.json as an earlier bridge left it: each Mac's list it had (`peersFrom`) kept as that Mac's
// word until it signs a document; what lists passed on and their dates needed, gone.
function migratedLink(link) {
  if (!isObject(link) || !(link.peersFrom || link.vouched || link.macAts)) return link;
  for (const [mac, given] of Object.entries(link.peersFrom ?? {})) {
    if (!macSign(link, mac) && isObject(given)) {
      link.legacy ??= {};
      link.legacy[mac] ??= { at: given.at ?? 0, peers: Array.isArray(given.peers) ? given.peers : [], moved: given.moved ?? [] };
    }
  }
  delete link.peersFrom;
  delete link.vouched;
  delete link.macAts;
  return link;
}

// A mail frame's body opened: from one of this box's Macs, or one of its peers. `{sender, payload}`,
// or null for one from anyone else (or that isn't one).
export function openMail(body, link) {
  if (!link?.key) return null;
  const key = Buffer.from(link.key, "base64url");
  const senders = [...macsOf(link).map(mac => ({ key: mac, kind: "mac" })), ...peersOf(link).filter(peer => !macsOf(link).includes(peer.key))];
  for (const sender of senders) {
    try {
      const payload = JSON.parse(openOneWay(body, key, Buffer.from(sender.key, "base64url")).payload.toString("utf8"));
      return isObject(payload) ? { sender: peersOf(link).find(peer => peer.key === sender.key) ?? sender, payload } : null;
    } catch {}
  }
  return null;
}

// Mail for a peer, as the relay takes it, sealed for its key alone; null for one too big to go.
export function mailFor(peer, payload, link) {
  const sealed = frame(Frame.mail, 0, sealOneWay(Buffer.from(JSON.stringify(payload)), Buffer.from(link.key, "base64url"), Buffer.from(peer.key, "base64url")).message);
  if (sealed.length > MAX_MAIL) return null;
  return relaySend(Buffer.from(peer.address, "base64url"), sealed);
}
const MAX_MAIL = 65_600 - 17;

// ---- Agents and letters between boxes (PROTOCOL.md, "Peers") ----
// Each box tells its peers who its agents are (its bots, its latest titled sessions), and keeps
// what each told it, for list_agents here (`run/agents.json`, which kuvo-browser.js reads). An
// agent's message to one on another box (left in `run/outbox/sending` by kuvo-browser.js) goes to
// that box by mail, until it says it has it; one that comes here is checked, delivered once, and
// with `wait`, answered by a letter back.

const PEER_AGENTS_FILE = path.join(RUN, "peer-agents.json");
// What a Mac connected over SSH says its agents are (as it mails them), for when the relay can't
// be reached.
const MAC_AGENTS_FILE = path.join(RUN, "mac-agents.json");
const AGENTS_FILE = path.join(RUN, "agents.json");
const OUTBOX = path.join(RUN, "outbox");
const SENDING = path.join(OUTBOX, "sending");
const REPLIES = path.join(RUN, "replies");
const LETTERS_SEEN = path.join(RUN, "letters-seen.json");
const PEER_LOCK = path.join(RUN, ".peers.lock");
// A letter older than a day isn't delivered; one is remembered two days (no doubles, no replays).
const LETTER_LIFE = 86_400_000;
const LETTER_MEMORY = 2 * 86_400_000;
const LETTER_TEXT = 32_000;
// At most `most` UTF-16 units of `text`, never half a character.
const cutText = (text, most = LETTER_TEXT) => {
  const words = String(text ?? "");
  if (words.length <= most) return words;
  return words.slice(0, /[\uDC00-\uDFFF]/.test(words[most]) ? most - 1 : most);
};
const LETTER_BYTES = 24_000;
const MOST_AGENTS = 120;
const LETTER_ID = /^[A-Za-z0-9_-]{6,80}$/;
// Without the relay this long, this box's letters go to the Mac instead, which collects them
// over SSH.
const RELAY_GONE_AFTER = 5 * 60_000;

const fitsAgent = agent => isObject(agent) && typeof agent.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(agent.session)
  && typeof agent.name === "string" && (agent.kind === "bot" || agent.kind === "session");
// A bot's `id` too (`bot_…`, as group chats name their members), and how it looks (`look`: color,
// shape, face), so a chat on another computer can have it and show it.
// Only colors, shapes and faces the apps draw (BotLook): another (a newer computer's) is the plain
// one's, so a phone can always read it.
const LOOKS = {
  color: ["mint", "sky", "indigo", "violet", "pink", "coral", "orange", "amber", "lime", "graphite"],
  shape: ["round", "squircle", "pebble", "gem", "bloom"],
  face: ["calm", "happy", "sleepy", "wink", "curious", "bright"],
};
const PLAIN_LOOK = { color: "graphite", shape: "round", face: "calm" };
const keptLook = look => (isObject(look)
  ? Object.fromEntries(Object.keys(LOOKS).map(key => [key, LOOKS[key].includes(look[key]) ? look[key] : PLAIN_LOOK[key]])) : undefined);
const keptAgent = ({ session, name, kind, project, about, machine, id, look }) => ({ session, name: plainName(name).slice(0, 200), kind,
  ...(kind === "bot" && typeof id === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(id) ? { id } : {}),
  ...(kind === "bot" && keptLook(look) ? { look: keptLook(look) } : {}),
  ...(typeof project === "string" && project ? { project: project.slice(0, 200) } : {}), ...(typeof about === "string" && about ? { about: about.slice(0, 500) } : {}),
  ...(typeof machine === "string" && machine ? { machine: machine.slice(0, 200) } : {}) });
// What a peer says it answers (`features`, as kuvo/info's), kept with its agents.
const keptFeatures = features => (Array.isArray(features) ? features.filter(each => typeof each === "string" && each.length <= 60).slice(0, 80) : []);

// What a peer said its agents are, the newest it said: false for an older list.
export function takeAgents(sender, given, file = PEER_AGENTS_FILE, lock = PEER_LOCK) {
  if (!isObject(given) || typeof given.at !== "number" || !Array.isArray(given.list)) return false;
  return locked(lock, () => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (given.at <= (all[sender.key]?.at ?? 0)) return false;
    all[sender.key] = { at: given.at, kind: sender.kind, ...(sender.id ? { id: sender.id } : {}), list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent),
      ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}) };
    writePrivate(file, JSON.stringify(all));
    return true;
  });
}

// What each peer told, by its key; a Mac's as it last said it, by mail or over SSH, whichever's newer.
export function readPeerAgents(file = PEER_AGENTS_FILE, macFile = MAC_AGENTS_FILE, link = null) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch {}
  try {
    const given = JSON.parse(fs.readFileSync(macFile, "utf8"));
    const macs = macsOf(link ?? readLink() ?? {});
    if (macs.includes(given?.key) && typeof given.at === "number" && Array.isArray(given.list) && given.at > (all[given.key]?.at ?? 0)) {
      all[given.key] = { at: given.at, kind: "mac", list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent) };
    }
  } catch {}
  return all;
}

// The box a session is on, among the peers: the one a Mac says it moved to, else the one that
// lists it. One listed by more than one is a Mac's when a Mac lists it, else nobody's (one of them
// could be claiming another's).
export function peerOf(session, peers, told, moved = new Map()) {
  if (moved.has(session)) return peers.find(peer => peer.key === moved.get(session)) ?? null;
  const listing = peers.filter(peer => (told[peer.key]?.list ?? []).some(agent => agent.session === session));
  if (listing.length <= 1) return listing[0] ?? null;
  const macs = listing.filter(peer => peer.kind === "mac");
  return macs.length === 1 ? macs[0] : null;
}

// ---- "&" in a message from a phone (the Mac's AgentReferences, in the same words) ----
// A message names another conversation with "&Name"; a block at its end tells the agent who each
// one is, with its address, so it can read it (read_conversation) or write to it (send_message).
// Both sides read the same cases (Vectors/routes/names/agent-naming.json), so they can't drift.

// A block the app adds to the end of a message (MessageBlock.swift): its tag on a line of its own,
// its heading, what's in it, then its closing tag, with nothing after.
function messageBlock(start, end, headings) {
  const find = text => {
    const body = text.replace(/\s+$/u, "");
    if (!body.endsWith(`\n${end}`)) return null;
    const close = body.length - end.length;
    const opening = `${start}\n`;
    let before = close;
    for (;;) {
      const open = before - opening.length < 0 ? -1 : text.lastIndexOf(opening, before - opening.length);
      if (open < 0) return null;
      before = open;
      if (open !== 0 && text[open - 1] !== "\n") continue;
      const lines = text.slice(open + opening.length, close).split("\n").slice(0, -1);
      if (lines.length && headings.includes(lines[0])) return { open, lines };
    }
  };
  return {
    start,
    // The words before the block that ends `text` (trimmed), and its lines from its heading on.
    split: text => {
      const found = find(text);
      return found ? { before: text.slice(0, found.open).trim(), lines: found.lines } : null;
    },
    // `text` as it can't be read as ending with a block (one copied from a message): its tag gets
    // a space after it.
    escaping: text => {
      let found;
      while ((found = find(text))) text = text.slice(0, found.open + start.length) + " " + text.slice(found.open + start.length);
      return text;
    },
  };
}

const FROM_PHONE_BLOCK = messageBlock("<from-phone>", "</from-phone>", ["The user sent this from Kuvo Code on their iPhone."]);
const ATTACHED_BLOCK = messageBlock("<attached-files>", "</attached-files>", [
  "The attached files are on disk here (what's in them is in this message already):",
  "Open these attached files with your tools if you need them:",
  "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):",
]);
const REVIEW_BLOCK = messageBlock("<review-comments>", "</review-comments>", ["Comments on lines of the current changes:"]);
const NAMING_HEADING = "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:";
const NAMED_BLOCK = messageBlock("<named-agents>", "</named-agents>", [NAMING_HEADING,
  "Agents the user named with & in this message. Read one's conversation with read_conversation, or write to it with send_message, by its address:"]);

// A name as it's compared: case and accents aside.
// (A ligature as its letters, ß as "ss", a final sigma as any other, as Swift folds them.)
const foldName = text => text.replace(/[\uFB00-\uFB06]/g, ligature => ligature.normalize("NFKD")).normalize("NFD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/ς/g, "σ").replace(/ß/g, "ss");
const wordCharacter = /^[\p{L}\p{N}]/u;
// Its characters as people see them (a letter with its accents, an emoji with its joiners).
const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];

// Where each of `references` ({name, session}) is named with "&" in `text`, last first: longer names
// win ("&Miranda" isn't "&Mira"), the "&" starts a word and the name ends where a word does.
export function namesIn(text, references) {
  if (!text.includes("&")) return [];
  // The text folded a character at a time, with the character each folded unit came from: a name
  // starts and ends where a character does, and what's around it is whole characters.
  let folded = "";
  const from = [];
  const at = new Map(), ending = new Map();
  for (const { segment, index } of graphemes(text)) {
    at.set(index, segment);
    ending.set(index + segment.length, segment);
    const each = foldName(segment);
    for (let i = 0; i < each.length; i++) from.push(index);
    folded += each;
  }
  from.push(text.length);
  const found = [];
  const length = name => graphemes(foldName(name)).length;
  for (const reference of [...references].sort((a, b) => length(b.name) - length(a.name))) {
    if (!reference.name) continue;
    const wanted = `&${foldName(reference.name)}`;
    for (let start = folded.indexOf(wanted); start >= 0; start = folded.indexOf(wanted, start + 1)) {
      const end = start + wanted.length;
      if ((start > 0 && from[start - 1] === from[start]) || (end < folded.length && from[end - 1] === from[end])) continue;
      const lower = from[start], upper = from[end];
      if (wordCharacter.test(ending.get(lower) ?? "") || wordCharacter.test(at.get(upper) ?? "")) continue;
      if (found.some(each => lower < each.upper && each.lower < upper)) continue;
      found.push({ lower, upper, reference });
    }
  }
  return found.sort((a, b) => b.lower - a.lower);
}

// What an agent is, for one `here` (null: the Mac) to read: "bot, on the Mac", "session, on lab,
// in api" (AgentMail.what).
const agentIs = (agent, here) => {
  const machine = agent.machine ?? null;
  const place = machine === (here ?? null) ? (here == null ? "on the Mac" : "here") : machine == null ? "on the Mac" : `on ${machine}`;
  return `${agent.kind}, ${place}${typeof agent.project === "string" ? `, in ${agent.project}` : ""}`;
};

// The agents `texts` name, each once, in the order they're first named, not those `excluding`; of
// two with the same name, the first `agents` has (bots, then the latest sessions).
function agentsNamed(texts, excluding, agents) {
  if (!texts.some(text => text.includes("&"))) return [];
  const byName = new Map();
  for (const agent of agents) {
    if (excluding.has(agent.session)) continue;
    const name = foldName(agent.name);
    if (!byName.has(name)) byName.set(name, agent);
  }
  const references = [...byName.values()].map(agent => ({ name: agent.name, session: agent.session }));
  const named = [];
  for (const text of texts) {
    for (const { reference } of namesIn(text, references).reverse()) {
      if (named.some(agent => agent.session === reference.session)) continue;
      const agent = byName.get(foldName(reference.name));
      if (agent) named.push(agent);
    }
  }
  return named;
}

// A message from a phone with the block naming its agents among the others at its end: after its
// words, before its comments on the changes and its note of attached files (and without the block
// that says it's from the phone, which goes on again after). One sent again (Retry, Edit) with the
// block it had loses that, and its agents are named afresh. `excluding`: the conversation it's
// written in; `here`: this box's name on its Macs (null on a Mac); `agents`: everyone.
export function nameAgents(message, { excluding = null, here = null, agents = [] } = {}) {
  message = FROM_PHONE_BLOCK.split(message)?.before ?? message;
  const withComments = ATTACHED_BLOCK.split(message)?.before ?? message;
  const words = REVIEW_BLOCK.split(withComments)?.before ?? withComments;
  const bare = NAMED_BLOCK.split(words)?.before ?? words;
  if (!bare.includes("&") && bare === words) return message;
  const text = NAMED_BLOCK.escaping(bare);
  const agentsHere = agentsNamed([text], new Set(excluding ? [excluding] : []), agents);
  const lines = agentsHere.map(agent => `- &${agent.name} (${agent.session}): ${agentIs(agent, here)}${typeof agent.about === "string" && agent.about ? `: ${agent.about}` : ""}`);
  const named = lines.length ? `${text ? `${text}\n\n` : ""}${["<named-agents>", NAMING_HEADING, ...lines, "</named-agents>"].join("\n")}` : text;
  if (named === words) return message;
  const at = message.indexOf(words);
  return at < 0 ? message : message.slice(0, at) + named + message.slice(at + words.length);
}

// Everyone, for list_agents here: this box's own (`machine` its name on its Macs), then each peer's
// it alone lists (`peerOf`): a machine's by its name; a Mac's its own (none), and the agents of
// machines it speaks for (those whose link doesn't talk to other computers yet), by theirs.
export function composeAgents(own, ownID, peers, told, moved = new Map()) {
  const agents = own.map(agent => ({ ...keptAgent({ ...agent, machine: undefined }), ...(ownID ? { machine: ownID } : {}) }));
  const seen = new Set(agents.map(agent => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key) continue;
      seen.add(agent.session);
      const { machine, ...rest } = agent;
      agents.push(peer.kind === "machine" ? { ...rest, ...(peer.id ? { machine: peer.id } : {}) } : { ...rest, ...(machine ? { machine } : {}) });
    }
  }
  return { machine: ownID ?? null, agents };
}

// Who `&` can name here (`kuvo/named`), as a Mac's composer offers them: this box's own (`machine`
// null), then each peer's it alone lists (`peerOf`): a machine's by its id, a Mac's own by the
// Mac's name, and those of machines a Mac speaks for by theirs. Every bot, and only sessions with a
// title (the lists name one without "New session").
export function namedAgents(own, peers, told, moved = new Map()) {
  const entry = (agent, machine) => ({ session: agent.session, name: agent.name, kind: agent.kind, machine, project: agent.project ?? null, about: agent.about ?? null });
  const titled = agent => agent.kind === "bot" || (Boolean(agent.name) && agent.name !== "New session");
  const agents = own.filter(titled).map(agent => entry(agent, null));
  const seen = new Set(agents.map(agent => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (!titled(agent) || seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key) continue;
      seen.add(agent.session);
      agents.push(entry(agent, peer.kind === "machine" ? peer.id ?? peer.name ?? null : agent.machine ?? peer.name ?? null));
    }
  }
  return agents;
}

// Put away: archived, as a Mac archives one (`kuvo.archived` in its metadata) or the engine does.
const isPutAway = session => session?.metadata?.["kuvo.archived"] === true || Boolean(session?.metadata?.kuvo?.archived) || Boolean(session?.time?.archived);

// This box's own agents: its bots, then its latest sessions, its engine's and its coding
// agents' (not a bot's, a subagent's, a group chat's seat, nor one put away), as the Mac lists its
// own: one without a title is "New session", and a chat's project is "Chats". Null when its engine
// can't say (then what it last said stands).
export async function ownAgents(readEngine, machine, kit = readKit(), readBridge = readBridgeFile) {
  const bots = listBots(machine).map(bot => ({ session: bot.session, name: bot.name, kind: "bot", id: bot.id, ...(bot.job ? { about: bot.job } : {}), ...(bot.look ? { look: bot.look } : {}) }));
  const botSessions = new Set(bots.map(bot => bot.session));
  const sessionsOf = async target => {
    const response = await fetch(`http://127.0.0.1:${target.port}/api/session?parentID=null&limit=100&order=desc`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`It answered ${response.status}.`);
    return (await response.json())?.data ?? [];
  };
  let sessions;
  try { sessions = await sessionsOf(readEngine()); } catch { return null; }
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) sessions = sessions.concat(await sessionsOf(bridge));
  } catch {}
  const projects = boxProjects(kit);
  const named = directory => projects.find(project => project.directory === directory)?.name
    ?? (directory === path.join(K, "chats") ? "Chats" : directory ? path.basename(directory) : undefined);
  const recent = sessions
    .filter(session => !session.parentID && !botSessions.has(session.id) && !session.metadata?.kuvo?.seat && !isPutAway(session))
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .slice(0, 40)
    .map(session => ({ session: session.id, name: session.title || "New session", kind: "session", ...(named(session.location?.directory ?? session.directory) ? { project: named(session.location?.directory ?? session.directory) } : {}) }));
  return [...bots, ...recent].map(keptAgent);
}

// Letters remembered, by id, with when: one seen again is said to be there, not delivered twice.
function lettersSeen(now) {
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(LETTERS_SEEN, "utf8")); } catch {}
  for (const [key, at] of Object.entries(seen)) if (now - at > LETTER_MEMORY) delete seen[key];
  return seen;
}
const seenAlready = (id, now = Date.now()) => id in lettersSeen(now);
function noteSeen(id, now = Date.now()) {
  locked(PEER_LOCK, () => {
    const seen = lettersSeen(now);
    seen[id] = now;
    writePrivate(LETTERS_SEEN, JSON.stringify(seen));
  });
}
// Letters being delivered now: one that comes again meanwhile waits for that one's answer.
const delivering = new Set();

// Letters from each peer lately, a few at a time (as the Mac counts a machine's).
const lettersFrom = new Map();
function tooMany(key, now = Date.now()) {
  const lately = (lettersFrom.get(key) ?? []).filter(at => now - at < 600_000);
  if (lately.length >= 20) return true;
  lettersFrom.set(key, [...lately, now]);
  return false;
}

// What the receiving agent reads, as the Mac and kuvo-browser.js word it (AgentMail.compose).
export const composeLetter = (name, session, words, waits) =>
  `[Message from ${name} · ${session}] (${waits ? "They're waiting for your reply: just answer, in your words." : session === "unknown" ? "It can't be answered: who sent it isn't known." : `To answer, use send_message to ${session}.`})\n\n${words}`;

// A session here, where it runs: the engine's or the coding agents' bridge's, by asking each, and
// what it is. Null when each says there's no such session; it throws when one can't be asked (try
// again later).
async function placeOfSession(session, targets) {
  if (!targets.length) throw new Error("Its engine isn't running.");
  let unsure = null;
  for (const target of targets) {
    try {
      const response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return { target, data: (await response.json().catch(() => null))?.data ?? {} };
      if (response.status !== 404) unsure = new Error(`It answered ${response.status}.`);
    } catch (error) {
      unsure = error;
    }
  }
  if (unsure) throw unsure;
  return null;
}

async function asked(target, method, route, body) {
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

// Its answer to message `id`, as kuvo-browser.js's replyTo waits for it: what it wrote after,
// once it's done, ten minutes at most; null for none.
async function answerTo(target, session, id, wait = 2000) {
  const began = Date.now();
  let started = false;
  while (Date.now() - began < 600_000) {
    await sleep(wait);
    const active = (await asked(target, "GET", "api/session/active").catch(() => null))?.data ?? {};
    if (Array.isArray(active) ? active.includes(session) : active[session]) {
      started = true;
      continue;
    }
    if (!started && Date.now() - began < 3 * wait) continue;
    const page = await asked(target, "GET", `api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`).catch(() => null);
    const replies = (page?.data ?? [])
      .filter(message => message.type === "assistant" && message.id > id)
      .reverse()
      .map(message => (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n"))
      .filter(Boolean);
    if (replies.length) return replies.join("\n\n").slice(0, 8000);
    if (started) break;
  }
  return null;
}

// A letter from a peer: delivered once, said to be there (or why not, and whether to try again),
// and with `wait`, answered by a letter back. Who it's from is the sending box's own agent, by the
// name that box gave it, only when that box alone lists it and it isn't one of this box's own;
// otherwise "an agent on" that box, with no address to answer (anything there could claim
// another's). It goes to a conversation here that an agent could be (not a subagent's, a group
// chat's seat, nor one put away); an answer (`answers`) to a letter a tool here waits for goes to
// that tool. One for a conversation moving to or from another computer now (`moving`), or that
// lives on another now, comes again, and reaches it where it lives then. `send(peer, payload)`
// mails the peer; `answer(letter)` sends this box's answer back.
export async function takeLetter(sender, letter, { send, targets, answer = () => {}, told = readPeerAgents(), peers = peersOf(readLink()), moved = movedOf(readLink()), now = Date.now(), wait, moving = async () => false } = {}) {
  if (!isObject(letter) || typeof letter.id !== "string" || !LETTER_ID.test(letter.id)) return;
  const { id } = letter;
  const no = (why, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  if (typeof letter.at !== "number" || Math.abs(now - letter.at) > LETTER_LIFE) return no("It's too old to deliver.");
  if (typeof letter.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.to) || typeof letter.text !== "string" || !letter.text.trim()) return no("That isn't a letter.");
  if (delivering.has(id)) return;
  if (seenAlready(id, now)) return send(sender, { delivered: { id, ok: true } });
  // An answer a tool here waits for (from the box its letter went to): to it.
  if (typeof letter.answers === "string" && LETTER_ID.test(letter.answers) && answered(sender, letter, now)) {
    noteSeen(id, now);
    return send(sender, { delivered: { id, ok: true } });
  }
  if (tooMany(sender.key, now)) return no("It's sent a lot of messages in the last few minutes.", true);
  delivering.add(id);
  let place, prompt, fromAgent = null;
  try {
    const lives = moved.get(letter.to);
    if ((lives && lives !== ownKey(readLink() ?? {})) || (await moving(letter.to))) return no("It's moving to another computer: it comes again once it's there.", true);
    place = await placeOfSession(letter.to, targets);
    if (!place) return no("There's no such conversation here.");
    const kuvo = place.data?.metadata?.kuvo ?? {};
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data)) return no("That conversation doesn't take messages.");
    // Its sender: that box's own agent, as it named it; one of this box's own claimed from there isn't.
    const listed = peerOf(letter.from, peers, told, moved)?.key === sender.key ? (told[sender.key]?.list ?? []).find(agent => agent.session === letter.from) : null;
    if (listed && !(await placeOfSession(letter.from, targets).catch(() => ({})))) fromAgent = listed;
    const name = fromAgent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}`;
    prompt = messageID();
    const waits = letter.wait === true && Boolean(fromAgent);
    await asked(place.target, "POST", `api/session/${encodeURIComponent(letter.to)}/prompt`, { id: prompt, text: composeLetter(name, fromAgent ? letter.from : "unknown", cutText(letter.text), waits), delivery: "steer" });
  } catch (error) {
    return no(`It didn't reach it: ${String(error?.message ?? error)}`, true);
  } finally {
    delivering.delete(id);
  }
  noteSeen(id, now);
  // Waiting for an answer it can't have (its sender couldn't be told): it hears no answer's coming.
  if (letter.wait === true && !fromAgent) return send(sender, { delivered: { id, ok: true, answer: false, why: "Its answer can't come back to you: it doesn't know who you are." } });
  send(sender, { delivered: { id, ok: true } });
  if (letter.wait !== true) return;
  const text = await answerTo(place.target, letter.to, prompt, wait);
  if (text) answer({ from: letter.to, to: letter.from, text, answers: id, peer: sender.key });
}

// An answer to a peer's ask for this box's agents, under way; when each last asked.
let answeringAsk = null;
const asksFrom = new Map();

// What peers tell each other: their agents, letters, and how letters went (PROTOCOL.md, "Peers").
export function peerMail(sender, payload, host, targets = () => []) {
  const send = (peer, message) => {
    const link = readLink();
    const bytes = link && mailFor(peer, { ...message, at: Date.now() }, link);
    if (bytes) try { host?.send(bytes); } catch {}
  };
  if (isObject(payload.agents)) {
    if (takeAgents(sender, payload.agents)) writeAgents();
  }
  // Documents (PROTOCOL.md, "Documents"): given, in parts, or a digest of what it has.
  if (isObject(payload.docs)) receiveDocs(sender, payload.docs, host).catch(() => {});
  // It's just connected, and may have missed what this box told it (the relay keeps nothing):
  // told again now.
  if (payload.ask === "agents") {
    toldPeers.delete(sender.key);
    // One answer at a time, and once in a while from each (an ask again soon after is the same).
    const now = Date.now();
    if (host?.welcomed && !answeringAsk && now - (asksFrom.get(sender.key) ?? 0) > 10_000) {
      asksFrom.set(sender.key, now);
      answeringAsk = announce(host, readEngineFile).catch(() => {}).finally(() => { answeringAsk = null; });
    }
  }
  if (isObject(payload.letter)) takeLetter(sender, payload.letter, { send, targets: targets(), answer: leaveAnswer, ...(IS_MAC ? { moving: macMoving } : {}) }).catch(() => {});
  // Group chats across your computers: to the coding agents' bridge here.
  if (isObject(payload.seat) || isObject(payload.seatPart)) takeSeat(sender, payload, send).catch(() => {});
  if (isObject(payload.delivered) && typeof payload.delivered.id === "string") letterWent(sender, payload.delivered);
}

// This box's own agents, as last worked out (`refreshOwn`), for `run/agents.json`.
let ownList = null;
let ownMachine = null;

// This box's own agents as last worked out: since it started, else as `run/agents.json` last had
// them (`ownID`: this box's name there).
function ownAsLast(ownID) {
  if (ownList) return ownList;
  try { return (JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"))?.agents ?? []).filter(agent => fitsAgent(agent) && (agent.machine ?? null) === ownID); } catch { return []; }
}

// Writes `run/agents.json`: this box's agents and its peers'. Its own as last written while it
// can't say yet (its engine starting), rather than none.
export function writeAgents(link = readLink()) {
  const ownID = ownMachine ?? link?.id ?? null;
  const own = ownAsLast(ownID);
  const composed = composeAgents(own, ownID, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link));
  try {
    const text = JSON.stringify(composed);
    if (textOf(AGENTS_FILE) !== text) writePrivate(AGENTS_FILE, text);
  } catch {}
  // Who can be in its group chats from your other computers, as they told it.
  tellSeatPeers(link).catch(() => {});
}

// ---- Group chats across your computers (PROTOCOL.md, "Peers": `seat`) ----
// The coding agents' bridge here runs this box's group chats, and its bots' turns in chats on your
// other computers (Agents/src/groups/peer.ts). This link carries what goes between them: what the
// bridge sends, now (a turn, how it goes) or until it's there (a part of the work, its report, what
// a bot remembers, a seat gone: as letters go, resent each minute until `delivered`); in parts
// when it's big, as documents go; and what comes, to the bridge. Who your other computers are and
// their bots, the bridge hears from here.

// A mail's whole seat at most this big; bigger, in parts of DOC_PART.
const SEAT_WHOLE = 48_000;
const seatParts = new Map();

const bridgeAsk = async (method, route, body, signal) => {
  const target = readBridgeFile();
  if (!target?.port || !target?.password) throw new Error("The coding agents' bridge isn't running.");
  const response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/peers${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error(`The coding agents' bridge answered ${response.status}.`), { status: response.status });
  return response;
};

// A group chat's letter is given up after two days of this link online without a word from its
// computer. Only time online counts: while this computer sleeps, or has no relay, nobody could have
// answered, so a laptop closed over the weekend doesn't give up what it sent on Friday. From one
// round of the outbox to the next counts ONLINE_STEP at most: a longer gap is this computer asleep.
const SEAT_LETTER_LIFE = LETTER_MEMORY;
const ONLINE_STEP = 5 * 60_000;
// Each letter's last round, as counted (none yet since the link started: its first round doesn't count).
const seatRounds = new Map();
const seatAge = letter => (typeof letter?.aged === "number" && Number.isFinite(letter.aged) ? letter.aged : 0);

// What goes for one seat mail: whole, or in parts that are put together where it goes (its JSON's
// UTF-8 bytes, base64url, so each part fits a mail whatever the words are); null for one too big to
// be put together there (more than MOST_PARTS). `id`: one that mustn't be lost, as its letter is
// named (said back, `delivered`, once it's whole there).
export function seatPayloads(mail, id) {
  const json = JSON.stringify(mail);
  if (Buffer.byteLength(json) <= SEAT_WHOLE) return [{ seat: mail, ...(id ? { seatID: id } : {}) }];
  const d = Buffer.from(json).toString("base64url");
  const of = Math.ceil(d.length / DOC_PART);
  if (of > MOST_PARTS) return null;
  const whole = crypto.createHash("sha256").update(d).digest("base64url");
  return Array.from({ length: of }, (_, i) => ({ seatPart: { whole, i, of, d: d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: id ?? "" } }));
}

// The bridge's mail for `to`, sent now, each part as a mail of its own: whether it all went, or
// "too big" for one that can't go at all (said in the log).
function sendSeat(host, to, mail, id, link = readLink()) {
  const peer = peersOf(link).find(each => each.key === to);
  if (!peer || !host) return false;
  const payloads = seatPayloads(mail, id);
  if (!payloads) {
    console.error(`kuvo-link: a group chat's ${String(mail?.kind ?? "mail")} for ${plainName(peer.name) || "another computer"} is too big to send, so it wasn't.`);
    return "too big";
  }
  for (const payload of payloads) {
    const bytes = mailFor(peer, { ...payload, at: Date.now() }, link);
    if (!bytes) return false;
    try { host.send(bytes); } catch { return false; }
  }
  return true;
}

// A seat mail that came (whole, or once its parts are all here), to the bridge; one that mustn't be
// lost said to have come, once the bridge has it, or to be sent again when it couldn't be given.
export async function takeSeat(sender, payload, send, ask = bridgeAsk) {
  let mail = null, id = null;
  if (isObject(payload.seat)) {
    mail = payload.seat;
    id = typeof payload.seatID === "string" ? payload.seatID : null;
  } else if (isObject(payload.seatPart)) {
    const whole = assemble(seatParts, sender.key, payload.seatPart);
    if (!whole) return;
    try { mail = JSON.parse(Buffer.from(whole.d, "base64url").toString("utf8")); } catch { return; }
    id = whole.s || null;
  }
  if (!isObject(mail) || (id !== null && !LETTER_ID.test(id))) return;
  try {
    await ask("POST", "/mail", { from: sender.key, mail });
  } catch {
    if (id) send(sender, { delivered: { id, ok: false, why: "Not now.", retry: true } });
    return;
  }
  if (id) send(sender, { delivered: { id, ok: true } });
}

// Who can be in this box's group chats from your other computers: each peer (taking a chat's turns
// when its `features` say `groups.seats`), and the bots it told of, by their id.
export function seatPeers(link = readLink(), told = readPeerAgents(undefined, undefined, link)) {
  const peers = peersOf(link);
  return {
    boxes: peers.map(peer => ({ key: peer.key, name: plainName(peer.name) || "another computer", seats: (told[peer.key]?.features ?? []).includes("groups.seats") })),
    bots: peers.flatMap(peer => (told[peer.key]?.list ?? []).filter(agent => agent.kind === "bot" && agent.id)
      .map(agent => ({ id: agent.id, name: agent.name, job: agent.about ?? "", box: peer.key, session: agent.session, ...(agent.look ? { look: agent.look } : {}) }))),
  };
}

let toldSeatPeers = "";
export async function tellSeatPeers(link = readLink(), force = false, ask = bridgeAsk) {
  const peers = seatPeers(link);
  const text = JSON.stringify(peers);
  if (!force && text === toldSeatPeers) return;
  await ask("PUT", "", peers);
  toldSeatPeers = text;
}

// One line of what the bridge sends (`{id, to, mail, durable}`): what goes now, sent; what mustn't
// be lost, left as a letter (`run/outbox/sending`, which `sendOutbox` sends again each minute until
// it's there) and sent at once. What a bot remembers of a chat goes for any of the same bot and chat
// still waiting to go: only the newest matters. True once it's this link's to deliver.
export function carrySeat(host, given, link = readLink(), now = Date.now()) {
  if (!isObject(given) || typeof given.to !== "string" || !isObject(given.mail) || typeof given.id !== "string") return false;
  if (given.durable !== true) {
    sendSeat(host, given.to, given.mail, undefined, link);
    return true;
  }
  const id = given.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (!LETTER_ID.test(id)) return false;
  const letter = { peer: given.to, seat: given.mail, at: now };
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    if (given.mail.kind === "memory") {
      for (const name of listOf(SENDING)) {
        if (!name.endsWith(".json")) continue;
        let other;
        try { other = JSON.parse(fs.readFileSync(path.join(SENDING, name), "utf8")); } catch { continue; }
        if (other?.peer !== given.to || other?.seat?.kind !== "memory" || other.seat.memory?.bot !== given.mail.memory?.bot || other.seat.memory?.chat !== given.mail.memory?.chat) continue;
        fs.rmSync(path.join(SENDING, name), { force: true });
        letterTries.delete(name.slice(0, -5));
      }
    }
    writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify(letter));
  } catch { return false; }
  const to = peersOf(link).find(each => each.key === given.to);
  if (to && host) sendSeatLetter(host, to, id, letter, link, now);
  return true;
}

// A letter of a group chat's mail that mustn't be lost, sent to its computer now: noted as tried
// (sent again in a minute), or, too big ever to go, given up (the log says so).
function sendSeatLetter(host, to, id, letter, link, now, ask = bridgeAsk) {
  const file = path.join(SENDING, `${id}.json`);
  if (letter.sentTo !== to.key) try { writePrivate(file, JSON.stringify({ ...letter, sentTo: to.key })); } catch {}
  const went = sendSeat(host, to.key, letter.seat, id, link);
  if (went === "too big") return giveUpSeat(id, letter, ask);
  if (went) letterTries.set(id, now);
  return null;
}

// A letter of a group chat's mail given up (two days online without its computer saying it has it,
// too big ever to go, or turned down): the bridge is told (`POST /gaveup`), which decides what comes
// of it (sent again as a new letter while that computer is one of yours and it still matters), and
// the letter goes once the bridge has answered at all: a 4xx (an older bridge, group chats off here)
// is an answer too, so it isn't told again forever. Until then it's kept, marked, and not sent. The
// telling, or null while one is under way.
const tellingGaveUp = new Set();
function giveUpSeat(id, letter, ask = bridgeAsk) {
  const file = path.join(SENDING, `${id}.json`);
  letterTries.delete(id);
  if (letter.gaveUp !== true) try { writePrivate(file, JSON.stringify({ ...letter, gaveUp: true })); } catch {}
  if (tellingGaveUp.has(id)) return null;
  tellingGaveUp.add(id);
  const heard = () => fs.rmSync(file, { force: true });
  return ask("POST", "/gaveup", { to: letter.peer, mail: letter.seat, at: letter.at })
    .then(heard, error => { if (error?.status >= 400 && error.status < 500) heard(); })
    .finally(() => tellingGaveUp.delete(id));
}

// Follows what the bridge sends, while it runs (`carrySeat`), saying what mustn't be lost is taken
// once it's left as a letter. Each time it follows anew, it tells the bridge who your computers are.
export async function watchSeats(host, signal) {
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      const response = await bridgeAsk("GET", "/mail", undefined, signal);
      attempt = 0;
      await tellSeatPeers(readLink(), true).catch(() => {});
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let given;
          try { given = JSON.parse(line); } catch { continue; }
          if (carrySeat(host(), given) && given.durable === true) bridgeAsk("POST", "/sent", { ids: [given.id] }).catch(() => {});
        }
      }
    } catch {}
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}

// This box's own agents, worked out again, and `run/agents.json` with them, relay or not.
export async function refreshOwn(readEngine, link = readLink()) {
  // (This Mac's box lists its agents with its link off too: its group chats name them.)
  if (!link?.key && !IS_MAC) return ownList;
  ownMachine = link?.id ?? null;
  const list = await ownAgents(readEngine, link?.id);
  if (list) ownList = list;
  writeAgents(link);
  return ownList;
}

// What this box answers, as its agents' mail says (`kuvo/info`'s features): on a Mac, its app's
// list, as the app gives it (`kuvo/link/config`).
const ownFeatures = () => (IS_MAC && Array.isArray(macLink.config?.features) ? macLink.config.features : FEATURES);

// Tells each peer this box's agents: when they change, and every ten minutes, with a digest of
// its documents to each that takes them, so one that missed what was given gets it then (PROTOCOL.md,
// "Documents"). `told` remembers what went to whom, and when. `ask`: just connected, so each is
// told, and asked for theirs.
const toldPeers = new Map();
export async function announce(host, readEngine, link = readLink(), now = Date.now(), ask = false) {
  if (!link?.key) return;
  await refreshOwn(readEngine, link);
  if (!ownList) return;
  const json = JSON.stringify(ownList);
  let have = null;
  for (const peer of peersOf(link)) {
    const last = toldPeers.get(peer.key);
    if (!ask && last && last.json === json && now - last.at < 600_000) continue;
    // Not as it connects: `docsChanged` greets each with its digest then.
    if (have === null) have = ask ? false : currentDigest();
    const docs = peer.sign && have ? { docs: { have } } : {};
    // As many as fit in one mail: the first (bots, then the latest sessions) first.
    let bytes = null, sent = [];
    for (const count of [ownList.length, Math.floor(ownList.length / 2), Math.floor(ownList.length / 4)]) {
      sent = ownList.slice(0, count);
      bytes = mailFor(peer, { agents: { at: now, list: sent, features: ownFeatures() }, ...docs, at: now, ...(ask ? { ask: "agents" } : {}) }, link);
      if (bytes) break;
    }
    if (!bytes) continue;
    try {
      host.send(bytes);
      toldPeers.set(peer.key, { json, at: now, sessions: new Set(sent.map(agent => agent.session)) });
    } catch {}
  }
}

// ---- Documents, between this box and the others ----

// Parts of documents on their way here, from each box (`assemble`).
const docParts = new Map();
// Something changed here, from another process (`setup`, `pair`, a Mac's `box personalities`, over
// SSH): the bridge notes it within seconds (`docsNoted`), and tells the others.
const DOCS_CHANGED = path.join(RUN, "docs.changed");
export function noteDocsChanged() {
  // This Mac's box holds its link in this process: told now.
  if (IS_MAC) return macDocsChanged();
  try {
    fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
    fs.writeFileSync(DOCS_CHANGED, "", { mode: 0o600 });
  } catch {}
}
function docsNoted() {
  try {
    fs.rmSync(DOCS_CHANGED);
    return true;
  } catch {
    return false;
  }
}

// This box's digest, its own documents brought up to date first.
function currentDigest() {
  const library = readPersonalities();
  let have = null;
  updateLink(link => {
    if (!link?.sign) return null;
    const before = JSON.stringify(link.own ?? {});
    greetWork({ link, library });
    have = digestOf(link);
    return JSON.stringify(link.own ?? {}) === before ? null : link;
  });
  return have;
}

// Sends what `work` says goes (`[{to, docs}]`), in as many mails as each takes.
function sendDocs(host, link, sends) {
  if (!host || !link?.key) return;
  for (const { to, docs } of sends ?? []) {
    for (const payload of docMails(docs)) {
      const bytes = mailFor(to, { docs: payload, at: Date.now() }, link);
      if (bytes) try { host.send(bytes); } catch {}
    }
  }
}

// What another box or a Mac sent of documents, taken under link.json's lock: your personalities met
// with this box's (its bots told of those that changed), its phones as its documents say now (one
// removed losing its sessions), a Mac that's let it go forgotten, and what goes on, sent.
export async function receiveDocs(sender, docs, host) {
  const before = readPersonalities();
  let work = null, library = before;
  const link = updateLink(link => {
    if (!link) return null;
    const state = { link, library: before, parts: docParts };
    work = docsWork(state, sender, docs);
    library = state.library;
    return link;
  });
  if (!work || !link) return;
  await afterDocs(work, before, library, link, host);
}

async function afterDocs(work, before, library, link, host) {
  if (library !== before) await takePersonalities(library).catch(() => {});
  for (const mac of work.left) forgetMacsAgents(mac, link);
  host?.keepOnly?.(new Set((link.phones ?? []).map(phone => phone.key)));
  writeAgents(link);
  sendDocs(host, link, work.send);
}

// Something changed here, or this box just connected (`greet`): its own documents that changed go
// to the others, and with `tell` (a Mac's documents came over SSH) or `greet`, its digest.
export function docsChanged(host, { greet = false, tell = false } = {}) {
  const library = readPersonalities();
  let work = null;
  const link = updateLink(link => {
    if (!link?.sign) return null;
    work = greet ? greetWork({ link, library }) : changedWork({ link, library }, tell);
    return link;
  });
  if (work && link) {
    // (This Mac's box lets phones go a moment after, as it writes its link: a phone that removed
    // itself gets its answer first.)
    if (!IS_MAC) host?.keepOnly?.(new Set((link.phones ?? []).map(phone => phone.key)));
    sendDocs(host, link, work.send);
  }
}

// ---- The outbox: letters this box's agents leave for agents elsewhere ----
// Each goes by mail to the box its agent is on, again each minute until that box says it has it
// (or why not), for two days. A waiting tool reads its answer from `run/replies/<id>.json`.

const letterTries = new Map();
// Senders being told of to their letters' boxes first (one made a moment ago, which those boxes
// don't know yet): its letter goes the round after.
const introducing = new Map();

// This Mac's conversations waiting for a letter's answer, by the letter (`kuvo/link/letters`):
// answered here, in memory, as the box takes the answer itself; once it's there, which box it went
// to (only that one's answer counts).
const macWaiting = new Map();

function reply(id, value) {
  // On this Mac: to the conversation waiting, if it still is.
  if (IS_MAC) return void macWaiting.get(id)?.done(value);
  try {
    fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
    writePrivate(path.join(REPLIES, `${id}.json`), JSON.stringify(value));
  } catch {}
}

// A letter for the outbox, from this box (an answer, say).
function leaveLetter(letter, now = Date.now()) {
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    const id = "ltr_" + crypto.randomBytes(16).toString("base64url");
    writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ ...letter, wait: false, at: now }));
  } catch {}
}
const leaveAnswer = letter => leaveLetter(letter);

// How a letter went, from the box it went to (anyone else's word is dropped): there, so it's not
// sent again, and with `wait`, its answer awaited (`replies/<id>.wait`, whose box it's from), or
// none to wait for; not now, so it's sent again; or why not, for a waiting tool.
export function letterWent(sender, { id, ok, why, retry, answer }) {
  if (!LETTER_ID.test(id)) return;
  const file = path.join(SENDING, `${id}.json`);
  let letter = null;
  try { letter = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (letter?.sentTo !== sender.key) return;
  // Not now: sent again. A group chat's waits as long as it takes (the outbox counts its time online).
  if (!ok && retry === true && (isObject(letter.seat) || Date.now() - (letter.at ?? 0) < LETTER_MEMORY)) return;
  // A group chat's that can't be delivered is given up, and the bridge told, never just dropped.
  if (!ok && isObject(letter.seat)) return void giveUpSeat(id, letter);
  letterTries.delete(id);
  const words = typeof why === "string" ? why.slice(0, 500) : null;
  if (ok && letter.wait === true && answer !== false) {
    // On this Mac: the conversation waiting is told by whom its answer comes.
    const waiter = IS_MAC ? macWaiting.get(id) : null;
    if (waiter) {
      waiter.sentTo = sender.key;
      fs.rmSync(file, { force: true });
      return;
    }
    if (!IS_MAC) try {
      fs.mkdirSync(REPLIES, { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(REPLIES, `${id}.wait`));
      return;
    } catch {}
  }
  fs.rmSync(file, { force: true });
  // Only a tool waiting for its answer reads how it went.
  if (letter.wait !== true) return;
  if (!ok) reply(id, { failed: words ?? "It wasn't delivered." });
  else if (answer === false) reply(id, { note: words ?? "It got your message, but its answer can't come back to you here." });
}

// The answer (`letter`) to letter `answers`, from the box it went to, for the tool waiting for it
// here: true when one still waits (it notes it does, `<id>.alive`, every two seconds as it looks);
// else it comes as a message. One the tool doesn't take after all (it stopped as it came) comes as
// a message too (`deliverLeftAnswers`): it's kept with who it's from and for.
function answered(sender, { answers: id, text, from }, now = Date.now()) {
  // On this Mac: the request still waiting for it, if it's still there.
  if (IS_MAC) {
    const waiter = macWaiting.get(id);
    if (!waiter || waiter.sentTo !== sender.key || waiter.gone()) return false;
    waiter.done({ text: cutText(text, 8000) });
    return true;
  }
  const waiting = path.join(REPLIES, `${id}.wait`);
  let letter = null;
  try { letter = JSON.parse(fs.readFileSync(waiting, "utf8")); } catch { return false; }
  if (letter?.sentTo !== sender.key) return false;
  fs.rmSync(waiting, { force: true });
  let alive = 0;
  try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
  if (now - alive > 10_000) return false;
  // Its sender as that box named it, when that box alone lists it.
  const told = readPeerAgents();
  const agent = peerOf(from, peersOf(readLink()), told)?.key === sender.key ? (told[sender.key]?.list ?? []).find(each => each.session === from) : null;
  // For the conversation that asked (as this box's letter has it, not as the answer says).
  reply(id, { text: cutText(text, 8000), to: letter.from, from: agent ? from : "unknown", name: agent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}` });
  return true;
}

// Answers a tool here was given but never took (its turn stopped as one came): to the conversation
// that asked, as a message, once the tool's gone (it left `<id>.gaveup`, or stopped noting it
// waits), if it still takes letters (not a subagent's, a group chat's seat, nor one put away). Each
// once at most: taken out of the tool's way first, put back to try again if it can't go now; one
// cut off as it's delivered (this bridge stopped) stays `.delivering`, and is dropped.
export async function deliverLeftAnswers(now = Date.now(), targets = peerTargets()) {
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const file = path.join(REPLIES, name);
    let answer;
    try { answer = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (typeof answer?.text !== "string" || typeof answer.to !== "string") continue;
    let alive = 0;
    try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
    if (!fs.existsSync(path.join(REPLIES, `${id}.gaveup`)) && now - alive <= 10_000) continue;
    const taken = `${file}.delivering`;
    try { fs.renameSync(file, taken); } catch { continue; }
    try {
      const place = await placeOfSession(answer.to, targets);
      const kuvo = place?.data?.metadata?.kuvo ?? {};
      if (place && !place.data?.parentID && !kuvo.seat && !isPutAway(place.data)) {
        await asked(place.target, "POST", `api/session/${encodeURIComponent(answer.to)}/prompt`,
          { id: messageID(), text: composeLetter(String(answer.name ?? "another agent"), String(answer.from ?? "unknown"), answer.text, false), delivery: "steer" });
      }
      fs.rmSync(taken, { force: true });
      fs.rmSync(path.join(REPLIES, `${id}.gaveup`), { force: true });
    } catch {
      try { fs.renameSync(taken, file); } catch {}
    }
  }
}

// A letter as mail for `peer`, its words cut to fit what the relay takes (UTF-8, and escaped as
// JSON, they can be several times as many bytes as characters); null if even a short one won't.
export function letterMail(peer, letter, link, now = Date.now()) {
  const words = String(letter.text ?? "");
  for (const most of [LETTER_BYTES, LETTER_BYTES / 4, 2000]) {
    const bytes = mailFor(peer, { letter: { ...letter, text: prefixBytes(words, most) }, at: now }, link);
    if (bytes) return bytes;
  }
  return null;
}

// The outbox, sent: each letter the tool left for this link (in `outbox/sending`; the Mac collects
// the rest over SSH) goes to the box its agent is on (an answer, to the box it answers), again
// each minute until that box says it has it (or why not), for two days. A tool that gave up
// waiting (`replies/<id>.gaveup`) has its letter go on without waiting, and an answer that comes
// later reaches its conversation as a message. Without the relay for a while (`offline`), letters
// not yet sent go to the Mac instead. A group chat's letters given up are told to the coding
// agents' bridge (`ask`); the tellings are what it returns.
export function sendOutbox(host, link = readLink(), now = Date.now(), offline = 0, ask = bridgeAsk) {
  const telling = [];
  if (!link?.key) return Promise.all(telling);
  const peers = peersOf(link);
  const told = readPeerAgents(undefined, undefined, link);
  const moved = movedOf(link);
  // The relay back: letters given to the Mac it hasn't taken come back. (Not one a Mac took to
  // deliver, `.mac-…`: each goes one way, by whichever renames it first.)
  if (!offline) {
    for (const name of listOf(OUTBOX)) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const letter = JSON.parse(fs.readFileSync(path.join(OUTBOX, name), "utf8"));
        if (typeof letter?.handed !== "number") continue;
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        fs.renameSync(path.join(OUTBOX, name), path.join(SENDING, name));
      } catch {}
    }
  }
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".gaveup")) continue;
    const id = name.slice(0, -7);
    fs.rmSync(path.join(REPLIES, name), { force: true });
    fs.rmSync(path.join(REPLIES, `${id}.wait`), { force: true });
    const file = path.join(SENDING, `${id}.json`);
    try { writePrivate(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wait: false })); } catch {}
  }
  const listed = new Set();
  // Oldest first, as they were left.
  const waiting = [];
  for (const name of listOf(SENDING)) {
    if (!name.endsWith(".json")) continue;
    try { waiting.push({ name, letter: JSON.parse(fs.readFileSync(path.join(SENDING, name), "utf8")) }); } catch {}
  }
  waiting.sort((a, b) => (typeof a.letter?.at === "number" ? a.letter.at : now) - (typeof b.letter?.at === "number" ? b.letter.at : now));
  for (const { name, letter: kept } of waiting) {
    const id = name.slice(0, -5);
    const file = path.join(SENDING, name);
    let letter = kept;
    if (!isObject(letter)) continue;
    listed.add(id);
    const made = typeof letter.at === "number" ? letter.at : now;
    // A group chat's mail that mustn't be lost: to its computer only (never through a Mac), each
    // minute until it says it has it, for two days of this link online (SEAT_LETTER_LIFE).
    if (isObject(letter.seat)) {
      const last = seatRounds.get(id);
      seatRounds.set(id, now);
      if (!offline && last !== undefined && now > last) {
        const before = seatAge(letter);
        letter = { ...letter, aged: before + Math.min(now - last, ONLINE_STEP) };
        // Kept a minute at a time: a restart loses no more.
        if (Math.floor(letter.aged / 60_000) !== Math.floor(before / 60_000)) try { writePrivate(file, JSON.stringify(letter)); } catch {}
      }
      if (letter.gaveUp === true || seatAge(letter) > SEAT_LETTER_LIFE) {
        const told = giveUpSeat(id, letter, ask);
        if (told) telling.push(told);
        continue;
      }
      const to = peers.find(each => each.key === letter.peer);
      if (!to || offline || now - (letterTries.get(id) ?? 0) < 60_000) continue;
      letterTries.set(id, now);
      const told = sendSeatLetter(host, to, id, letter, link, now, ask);
      if (told) telling.push(told);
      continue;
    }
    // Where its agent lives now: a conversation moved goes where it went, whoever it was left for.
    const lives = moved.get(letter.to);
    const peer = lives ? peers.find(each => each.key === lives) ?? null
      : typeof letter.peer === "string" ? peers.find(each => each.key === letter.peer) ?? null : peerOf(letter.to, peers, told, moved);
    if (now - made > LETTER_MEMORY) {
      fs.rmSync(file, { force: true });
      if (letter.wait === true) reply(id, { failed: "Its agent couldn't be reached." });
      continue;
    }
    // No box lists its agent now (lists change as boxes come and go): it waits.
    if (!peer) continue;
    // No relay for a while: one never sent goes to the Mac, which takes it on over SSH (on a
    // machine: this Mac's box waits for the relay).
    if (!IS_MAC && offline > RELAY_GONE_AFTER && !letter.sentTo && !letter.answers) {
      try {
        const { via, sentTo, peer: _, ...rest } = letter;
        writePrivate(path.join(OUTBOX, `${id}.json`), JSON.stringify({ ...rest, wait: false, handed: now }));
        fs.rmSync(file, { force: true });
        if (letter.wait === true) reply(id, { note: "Your other computers can't be reached through the relay now: it goes through your Mac instead, and its answer comes to you as a message." });
      } catch {}
      continue;
    }
    if (offline || now - (letterTries.get(id) ?? 0) < 60_000) continue;
    // Its sender, told of to that box first, so it's taken for one of this box's agents.
    if (letter.from && !toldPeers.get(peer.key)?.sessions?.has(letter.from) && !introducing.has(id)) {
      introducing.set(id, now);
      announce(host, readEngineFile, link).catch(() => {});
      continue;
    }
    letterTries.set(id, now);
    const bytes = letterMail(peer, { id, from: letter.from, to: letter.to, text: cutText(letter.text), wait: letter.wait === true, at: made,
      ...(letter.answers ? { answers: letter.answers } : {}) }, link, now);
    if (!bytes) {
      fs.rmSync(file, { force: true });
      if (letter.wait === true) reply(id, { failed: "It's too long to send." });
      continue;
    }
    // Which box it went to: only that one's word on how it went counts.
    if (letter.sentTo !== peer.key) try { writePrivate(file, JSON.stringify({ ...letter, sentTo: peer.key })); } catch {}
    try { host.send(bytes); } catch {}
  }
  for (const id of letterTries.keys()) if (!listed.has(id)) letterTries.delete(id);
  for (const id of seatRounds.keys()) if (!listed.has(id)) seatRounds.delete(id);
  for (const id of introducing.keys()) if (!listed.has(id)) introducing.delete(id);
  // Answers no tool came for (it gave up waiting), and ones never answered, after a day.
  for (const name of listOf(REPLIES)) {
    try {
      if (now - fs.statSync(path.join(REPLIES, name)).mtimeMs > LETTER_LIFE) fs.rmSync(path.join(REPLIES, name), { force: true });
    } catch {}
  }
  return Promise.all(telling);
}

// What came by mail, from a Mac or a peer: a Mac's lists, or what peers tell each other
// (`peerMail`, its agents and their letters); `attended(mac, given, at)`: a Mac in use, or not any
// more, as of its mail's `at` (PROTOCOL.md, "kuvo/attention").
export function receiveMail(body, host, peerMail = () => {}, attended = () => {}) {
  const link = readLink();
  const opened = openMail(body, link);
  if (!opened) return;
  const { sender, payload } = opened;
  if (macsOf(link).includes(sender.key)) heardFromMac(sender.key, payload);
  const attention = macsOf(link).includes(sender.key) ? attentionGiven(payload.attention) : null;
  if (attention && typeof payload.at === "number") attended(sender.key, attention, payload.at);
  peerMail(sender, payload);
}

// COMPAT(beta.1 peers-list): the list of peers a beta.1 Mac mails. Goes when 0.8.0 ships.
// Mail from one of this box's Macs: heard from (the 30 days a Mac counts for start again, noted
// once an hour at most), and, from a Mac that signs no documents yet, its list of peers (Kuvo Code
// 0.8.0-beta.1, PROTOCOL.md "For released Macs").
function heardFromMac(mac, payload, now = Date.now()) {
  const link = readLink();
  const legacy = !macSign(link, mac) && Array.isArray(payload.peers) && typeof payload.at === "number" && payload.at > (link?.legacy?.[mac]?.at ?? 0);
  if (!legacy && now - (link?.macSeen?.[mac] ?? 0) < 3_600_000) return;
  const changed = updateLink(link => {
    if (!link || !macsOf(link).includes(mac)) return null;
    if (legacy) takeLegacyPeers(link, mac, payload.peers, payload.at, payload.moved);
    forgetOldMacs(link, mac, now);
    return link;
  });
  if (changed && legacy) writeAgents(changed);
}

// A phone's session proved its own: its notifications go where it is now.
export function confirmPhone(phone) {
  const where = phone.address?.toString("base64url");
  const known = readLink()?.phones?.find(each => each.key === phone.key.toString("base64url"));
  if (!known || !where || known.address === where) return;
  updateLink(link => {
    const known = link?.phones?.find(each => each.key === phone.key.toString("base64url"));
    if (!known || !where || known.address === where) return null;
    known.address = where;
    return link;
  });
}

// ---- Updates (PROTOCOL.md, "Updates") ----
// A box updates itself to a newer Kuvo Code's release: at night (02:00 to 05:00 where you are) when
// nothing runs on it, or now (Update Now, from a Mac or a phone). Never to an older one, only what
// a key pinned here signed, only in a machine's own ~/.kuvo-code (not a test's or a demo's), and
// only while every Mac that started its engine lately leaves a newer box as it is. It checks what
// it got, tries the new engine and bridge, keeps what it had, swaps its files one by one and
// starts again; if that doesn't come up well, or the new bridge never says it's well (the keeper
// waits twenty minutes), it goes back to what it had.

// The releases' public keys (scripts/set-box-key.sh, scripts/sign-box.mjs), base64: with none, no
// box updates itself.
export const UPDATE_KEYS = ["iLSFoygG8wg+r2yj+/qnoMHpZIhPKRNLlf9vpEKmx0A="];
const UPDATE_URL = "https://github.com/serhatandic/kuvo-code/releases/latest/download/boxes.json";
const UPDATE_STATE = path.join(RUN, "update.json");
const UPDATE_TRIAL = path.join(RUN, "update-trial");
const UPDATE_LOCK = path.join(RUN, ".updating");
const UPDATES = path.join(K, "updates");
const ROLLBACK = path.join(UPDATES, "rollback");
const LAUNCHERS = path.join(RUN, "launchers.json");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
// A release this old before a box takes it by itself (most Macs have updated by then, and a bad
// one doesn't reach every box the night it's out).
const RELEASE_AGE = 3 * 86_400_000;
const MAC_MEMORY = 30 * 86_400_000;
const BOX_FILE = /^(bin\/[A-Za-z0-9._-]+|bin\/runtime\/[A-Za-z0-9._-]+|config\/opencode\/plugins\/[A-Za-z0-9._-]+)$/;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;

// A version as versions are ordered (a beta before its release), or null for one that isn't.
export function versionOrder(version) {
  const found = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version ?? "");
  return found ? [+found[1], +found[2], +found[3], found[4] == null ? Infinity : +found[4]] : null;
}

// Whether `version` is newer than `than` (none: any is).
export function newerVersion(version, than) {
  const a = versionOrder(version), b = versionOrder(than);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// A release's manifest, from boxes.json as the release workflow signs it: only with a key that's
// pinned, its signature over "kuvo-box v1\n" and its bytes. It throws for anything else.
export function verifyBoxes(text, keys = UPDATE_KEYS) {
  let given;
  try { given = JSON.parse(text); } catch { throw new Error("That isn't a release."); }
  if (typeof given?.manifest !== "string" || typeof given.signature !== "string" || typeof given.key !== "string") throw new Error("That isn't a release.");
  const key = keys.map(each => Buffer.from(each, "base64")).find(each => each.length === 32 && each.equals(Buffer.from(given.key, "base64")));
  if (!key) throw new Error("It isn't signed with a key this machine trusts.");
  const bytes = Buffer.from(given.manifest, "base64");
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: "der", type: "spki" });
  if (!crypto.verify(null, Buffer.concat([Buffer.from("kuvo-box v1\n"), bytes]), publicKey, Buffer.from(given.signature, "base64"))) throw new Error("Its signature doesn't match.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.kuvo !== "box/1" || !RELEASE_VERSION.test(manifest.version ?? "") || typeof manifest.engine !== "string" || !/^[0-9][0-9A-Za-z.-]*$/.test(manifest.engine)
    || !isObject(manifest.pack) || typeof manifest.pack.url !== "string" || !/^[0-9a-f]{64}$/.test(manifest.pack.sha256 ?? "")) throw new Error("That isn't a release.");
  return manifest;
}

// This box's version, as the Kuvo Code that put its files there marked it (`bin/box-version`).
export const boxVersion = () => {
  const version = textOf(path.join(K, "bin", "box-version"))?.trim();
  return versionOrder(version) ? version : null;
};

const updateState = () => { try { return JSON.parse(fs.readFileSync(UPDATE_STATE, "utf8")) ?? {}; } catch { return {}; } };
function noteUpdate(change) {
  const state = { ...updateState(), ...change };
  for (const [key, value] of Object.entries(change)) if (value == null) delete state[key];
  try { writePrivate(UPDATE_STATE, JSON.stringify(state)); } catch {}
  return state;
}

// Who started this box's engine lately: each Mac by its ID (in its launches' notes), with when.
export function noteLauncher(readEngine = readEngineFile, now = Date.now()) {
  let mac = null;
  try { mac = readEngine()?.notes?.mac; } catch {}
  if (typeof mac !== "string" || !mac || mac.length > 100) return;
  let all = {};
  try { all = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  if (now - (all[mac] ?? 0) < 3600_000) return;
  all[mac] = now;
  for (const [key, at] of Object.entries(all)) if (now - at > MAC_MEMORY) delete all[key];
  try { writePrivate(LAUNCHERS, JSON.stringify(all)); } catch {}
}

// COMPAT(0.7 visits): `launchers.json`, Macs that started the engine without saying they tolerate newer boxes, hold updates back. Goes 3 months after 0.8.0.
// Why this box doesn't update itself now, or null: it isn't a machine's own folder, or a Mac that
// started its engine lately would put back older versions (one that didn't say it leaves a newer
// box as it is).
export function updatesBlocked(link = readLink(), now = Date.now(), root = K) {
  if (path.resolve(root) !== path.join(os.homedir(), ".kuvo-code")) return "Only a machine's own Kuvo Code folder updates itself.";
  let launchers = {};
  try { launchers = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  const behind = Object.entries(launchers).filter(([mac, at]) => now - at < MAC_MEMORY && link?.tolerantIDs?.[mac] !== true);
  if (behind.length) return "A Mac that connects to this machine has an older Kuvo Code, which would put back older versions: update Kuvo Code there first.";
  return null;
}

// Whether something runs on the box: a conversation working (the engine's, the coding agents'),
// or an agent's browser waiting on you.
async function boxBusy(readEngine = readEngineFile, readBridge = readBridgeFile) {
  for (const read of [readEngine, readBridge]) {
    let target = null;
    try { target = read(); } catch {}
    if (!target?.port || !target?.password) continue;
    const active = (await asked(target, "GET", "api/session/active").catch(() => null))?.data;
    if (Array.isArray(active) ? active.length : isObject(active) && Object.keys(active).length) return true;
  }
  try { if ((JSON.parse(fs.readFileSync(ASKS_FILE, "utf8")) ?? []).length) return true; } catch {}
  return false;
}

// `url`'s body, at most `most` bytes, within `timeout` ms.
async function fetched(url, most, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "follow" });
  if (!response.ok) throw new Error(`It answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > most) throw new Error("It's larger than a release can be.");
  return data;
}

const hexSHA256 = data => crypto.createHash("sha256").update(data).digest("hex");

// `command` with `args`, in the box's folder, its environment the bridge's: its exit status and
// output, within `timeout` ms.
function ran(command, args, env = {}, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd: K, env: { ...process.env, ...env }, encoding: "utf8", timeout });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

// An update under way, by its process (`run/.updating/pid`): one at a time, and one whose process
// went isn't one.
export function isUpdating() {
  if (!fs.existsSync(UPDATE_LOCK)) return false;
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(UPDATE_LOCK, "pid"), "utf8")); } catch {}
  if (pid) return runs(pid, "kuvo-link");
  // Just made, its process not written yet.
  try { return Date.now() - fs.statSync(UPDATE_LOCK).mtimeMs < 60_000; } catch { return false; }
}

function takeUpdateLock() {
  try {
    fs.mkdirSync(UPDATE_LOCK);
  } catch {
    if (isUpdating()) return false;
    fs.rmSync(UPDATE_LOCK, { recursive: true, force: true });
    try { fs.mkdirSync(UPDATE_LOCK); } catch { return false; }
  }
  fs.writeFileSync(path.join(UPDATE_LOCK, "pid"), String(process.pid), { mode: 0o600 });
  return true;
}

// Keeps what's there now of each of a release's files, and with another engine version the
// engine's data (stopped), with `restore.sh`, which puts them back: run by the update when the new
// version doesn't come up, or by the keeper once the update's trial runs out (not while an update
// runs). Each step checked: one that fails leaves what was kept, for the next try.
function keepForRollback(files, withData) {
  fs.rmSync(ROLLBACK, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROLLBACK, "files"), { recursive: true, mode: 0o700 });
  const lines = [
    "#!/bin/sh",
    `K=${quote(K)}; B=${quote(ROLLBACK)}`,
    `p=$(cat "$K/run/.updating/pid" 2>/dev/null)`,
    `if [ -n "$p" ] && [ "$p" != "\${KUVO_UPDATER:-}" ] && kill -0 "$p" 2>/dev/null && { [ ! -d /proc ] || grep -q kuvo-link "/proc/$p/cmdline" 2>/dev/null; }; then exit 0; fi`,
    `sh "$K/bin/kuvo-start" stop >/dev/null 2>&1 || exit 1`,
  ];
  for (const file of files) {
    const from = path.join(K, file);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(path.join(ROLLBACK, "files", file)), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, path.join(ROLLBACK, "files", file));
      fs.chmodSync(path.join(ROLLBACK, "files", file), fs.statSync(from).mode & 0o777);
      lines.push(`cp -p "$B/files/"${quote(file)} "$K/"${quote(file)}.new && mv -f "$K/"${quote(file)}.new "$K/"${quote(file)} || exit 1`);
    } else {
      lines.push(`rm -f "$K/"${quote(file)} || exit 1`);
    }
  }
  if (withData) {
    // The database as it was kept, moved back (on the same disk: no room needed), with its own
    // journal and index (none, when it was closed cleanly), never the new engine's beside it. Only
    // once it was kept (the update may have stopped before).
    lines.push(
      `D="$K/data/opencode"`,
      `if [ -f "$B/data/opencode.db" ]; then`,
      `  rm -f "$D/opencode.db-wal" "$D/opencode.db-shm" || exit 1`,
      `  for n in opencode.db opencode.db-wal opencode.db-shm; do if [ -f "$B/data/$n" ]; then mv -f "$B/data/$n" "$D/$n" || exit 1; fi; done`,
      `fi`,
    );
  }
  lines.push(`sh "$K/bin/kuvo-start" start >/dev/null 2>&1`, `rm -f "$K/run/update-trial" "$K/run/update-restore"`, `rm -rf "$B"`);
  writePrivate(path.join(ROLLBACK, "restore.sh"), lines.join("\n") + "\n");
}

// The engine's data as it is, the engine stopped, beside what's put back: whole or not at all (a
// copy cut short is never put back).
function keepData() {
  const folder = path.join(K, "data", "opencode"), partial = path.join(ROLLBACK, "data.partial");
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true, mode: 0o700 });
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    if (fs.existsSync(path.join(folder, name))) fs.copyFileSync(path.join(folder, name), path.join(partial, name));
  }
  fs.renameSync(partial, path.join(ROLLBACK, "data"));
}

// Whether there's room to keep the engine's data beside it, with some to spare.
function roomForData() {
  let size = 0;
  for (const name of ["opencode.db", "opencode.db-wal"]) try { size += fs.statSync(path.join(K, "data", "opencode", name)).size; } catch {}
  const free = ran("df", ["-Pk", K]).output.split("\n").pop()?.trim().split(/\s+/)[3];
  return !free || Number(free) * 1024 > size * 1.1 + 200_000_000;
}

// Whether the engine came up as `version` and answers, and the coding agents' bridge with it when
// it ran before, within `timeout` ms.
async function cameUp(version, withAgents, timeout = 120_000, readEngine = readEngineFile, readBridge = readBridgeFile) {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    await sleep(Math.min(2000, timeout / 10));
    let engine = null;
    try { engine = readEngine(); } catch {}
    if (engine?.version !== version) continue;
    if (!(await asked(engine, "GET", "api/session?limit=1").then(() => true, () => false))) continue;
    if (!withAgents) return true;
    let bridge = null;
    try { bridge = readBridge(); } catch {}
    if (bridge?.port && (await asked(bridge, "GET", "api/session/active").then(() => true, () => false))) return true;
  }
  return false;
}

// COMPAT(0.7 files): `bin/.own`, the box's own copies of the tools an older Mac puts its own over. Goes 3 months after 0.8.0.
// The box's tools that an older Kuvo Code on a Mac (0.7 and before) puts its own over as it
// connects: the box keeps copies of its own (`bin/.own`), which its keeper puts back.
const OWN_TOOLS = ["kuvo-agents.js", "kuvo-browser.js", "kuvo-wake", "kuvo-npx"];

// The order files go in: its version first (a Mac connecting meanwhile leaves the box as it is),
// the keeper's mark last (the keeper starts its new script only once the script is there).
const installOrder = files => [...files].sort((a, b) => (a === "bin/box-version" ? -1 : b === "bin/box-version" ? 1 : a === "bin/.kuvo-boot" ? 1 : b === "bin/.kuvo-boot" ? -1 : a < b ? -1 : 1));

// Updates the box to the newest release, when it's newer: `now` (Update Now) takes it whatever its
// age. What happened: `{result: "updated" | "current" | "waiting" | "busy" | "off" | "blocked" |
// "failed", version?, message?}`; once "updated", the bridge goes for the keeper to start the new
// one. `keys` and `url`: a test's (a test's folder only).
export async function update({ now = false, keys = UPDATE_KEYS, url = UPDATE_URL, blocked = updatesBlocked(), clock = Date.now, step = () => {}, upWithin = 120_000 } = {}) {
  if (!keys.length) return { result: "off", message: "Updates aren't set up for this machine yet." };
  if (blocked) return { result: "blocked", message: blocked };
  // COMPAT(0.7 engine-stop): no update while an older Mac's Stop holds the engine down. Goes 3 months after 0.8.0.
  if (fs.existsSync(path.join(RUN, "stopped"))) return { result: "blocked", message: "Its engine is stopped: start it to update it." };
  const before = boxVersion();
  if (!before) return { result: "blocked", message: "This machine's version isn't known: connect to it from Kuvo Code on your Mac once." };
  if (!takeUpdateLock()) return { result: "busy", message: "It's updating already." };
  let trial = false, stopped = false, swapped = false, stage = null;
  try {
    step("checking");
    let released;
    try {
      released = await fetched(url, 1_000_000, 30_000);
    } catch (error) {
      // COMPAT(0.7 no-boxes-json): a newest release without `boxes.json` (0.7.2) is "current". Goes once a release with one is the newest.
      // The newest release has none for machines (one from before them): nothing newer for it.
      if (/answered 404/.test(String(error?.message))) return { result: "current", version: before };
      throw error;
    }
    const manifest = verifyBoxes(released.toString("utf8"), keys);
    noteUpdate({ latest: manifest.version, checked: clock() });
    if (!newerVersion(manifest.version, before)) return { result: "current", version: before };
    if (!now && clock() - (Date.parse(manifest.released) || clock()) < RELEASE_AGE) return { result: "waiting", version: manifest.version, message: "It takes a release a few days after it's out." };
    if (await boxBusy()) return { result: "busy", message: "Something is running there now." };

    step("downloading");
    stage = path.join(UPDATES, manifest.version);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, "files"), { recursive: true, mode: 0o700 });
    const pack = await fetched(manifest.pack.url, 100_000_000, 300_000);
    if (hexSHA256(pack) !== manifest.pack.sha256) throw new Error("The release's files aren't what it says.");
    fs.writeFileSync(path.join(stage, "pack.tgz"), pack, { mode: 0o600 });
    if (ran("tar", ["xzf", path.join(stage, "pack.tgz"), "-C", path.join(stage, "files")]).status !== 0) throw new Error("The release's files couldn't be unpacked.");
    const box = JSON.parse(fs.readFileSync(path.join(stage, "files", "box.json"), "utf8"));
    if (box?.version !== manifest.version || box.engine !== manifest.engine || !isObject(box.files)) throw new Error("The release's files aren't what it says.");
    const files = installOrder(Object.keys(box.files));
    for (const file of files) {
      if (!BOX_FILE.test(file) || file.split("/").includes("..")) throw new Error("The release names a file outside the box.");
      if (hexSHA256(fs.readFileSync(path.join(stage, "files", file))) !== box.files[file]) throw new Error("The release's files aren't what it says.");
    }
    if (!files.includes("bin/box-version") || fs.readFileSync(path.join(stage, "files", "bin", "box-version"), "utf8").trim() !== manifest.version) throw new Error("The release's files aren't what it says.");
    // COMPAT(0.7 files): the release's tools kept in `bin/.own`. Goes 3 months after 0.8.0.
    // Its tools kept as the box's own too (and put back with the rest, if it goes back).
    for (const tool of OWN_TOOLS) {
      if (!files.includes(`bin/${tool}`)) continue;
      const from = path.join(stage, "files", "bin", tool), own = path.join(stage, "files", "bin", ".own", tool);
      fs.mkdirSync(path.dirname(own), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, own);
      fs.chmodSync(own, fs.statSync(from).mode & 0o777);
      files.push(`bin/.own/${tool}`);
    }
    files.splice(0, files.length, ...installOrder(files));

    // Its engine, unless it's here already.
    const engineFolder = path.join(K, "engine", manifest.engine);
    let staged = null;
    if (!fs.existsSync(path.join(engineFolder, "opencode"))) {
      const kind = { x64: "x86_64", arm64: "aarch64" }[os.arch()];
      const build = manifest.linux?.[kind];
      if (!build?.url || !/^sha512-/.test(build.integrity ?? "")) throw new Error("The release has no engine for this machine.");
      step("downloading the engine");
      const tarball = await fetched(build.url, 400_000_000, 900_000);
      if (crypto.createHash("sha512").update(tarball).digest("base64") !== build.integrity.slice(7)) throw new Error("The engine isn't what the release says.");
      fs.writeFileSync(path.join(stage, "engine.tgz"), tarball, { mode: 0o600 });
      fs.mkdirSync(path.join(stage, "engine"), { mode: 0o700 });
      if (ran("tar", ["xzf", path.join(stage, "engine.tgz"), "-C", path.join(stage, "engine"), "package/bin/opencode"]).status !== 0) throw new Error("The engine couldn't be unpacked.");
      staged = path.join(stage, "engine", "package", "bin", "opencode");
      fs.chmodSync(staged, 0o755);
    }

    // Tried before anything's swapped: the engine runs, the new bridge works with it, the keeper reads.
    step("checking it");
    const engine = staged ?? path.join(engineFolder, "opencode");
    if (ran(engine, ["--version"]).status !== 0) throw new Error("The new engine doesn't run here.");
    const tried = ran(engine, [path.join(stage, "files", "bin", "kuvo-link.js"), "selftest"], { BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: K });
    if (tried.status !== 0 || !tried.output.includes("ok")) throw new Error("The new link doesn't work with it here.");
    if (ran("sh", ["-n", path.join(stage, "files", "bin", "kuvo-start")]).status !== 0) throw new Error("The new keeper doesn't read.");
    if (!now && await boxBusy()) return { result: "busy", message: "Something is running there now." };

    // Stopped, for sure, before anything's copied; what's there kept; then the new in its place,
    // one file at a time, and started again.
    step("installing");
    let previous = {};
    try { previous = readEngineFile(); } catch {}
    const withAgents = Boolean(previous?.agentsPort) && fs.existsSync(path.join(stage, "files", "bin", "kuvo-agents.js"));
    const otherEngine = previous?.version !== manifest.engine;
    if (otherEngine && !roomForData()) throw new Error("There isn't room on it to keep its data while it updates.");
    // What's there kept, and how to put it back, before the engine stops: a stop the update
    // doesn't get past (the machine going down) is put back too, its engine started again.
    keepForRollback(files, otherEngine);
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock() }, running: null });
    fs.writeFileSync(UPDATE_TRIAL, manifest.version, { mode: 0o600 });
    trial = true;
    stopped = true;
    const stop = ran("sh", [path.join(K, "bin", "kuvo-start"), "stop"], {}, 300_000);
    if (stop.status !== 0 || (previous?.pid && alive(previous.pid))) throw new Error("Its engine couldn't be stopped to update it.");
    if (otherEngine) keepData();
    swapped = true;
    if (staged) {
      fs.mkdirSync(engineFolder, { recursive: true, mode: 0o700 });
      fs.renameSync(staged, path.join(engineFolder, "opencode"));
    }
    for (const file of files) {
      const from = path.join(stage, "files", file), to = path.join(K, file);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, `${to}.new`);
      fs.chmodSync(`${to}.new`, fs.statSync(from).mode & 0o777);
      fs.renameSync(`${to}.new`, to);
    }
    ran("sh", [path.join(K, "bin", "kuvo-start"), "start"]);
    step("starting");
    if (!(await cameUp(manifest.engine, withAgents, upWithin))) throw new Error("The new version didn't come up.");
    // What it put there, for telling later whether an older Mac put its own back (`checkDrift`).
    writePrivate(path.join(UPDATES, "installed.json"), JSON.stringify({ version: box.version, files: box.files }));
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock(), healthy: true } });
    return { result: "updated", version: manifest.version };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    // Room first: what was downloaded goes before anything's put back.
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (swapped) {
      ran("sh", [path.join(ROLLBACK, "restore.sh")], { KUVO_UPDATER: String(process.pid) }, 600_000);
    } else {
      // Nothing changed: what was kept goes, and the engine starts again if it was stopped.
      if (trial) {
        fs.rmSync(UPDATE_TRIAL, { force: true });
        fs.rmSync(ROLLBACK, { recursive: true, force: true });
      }
      if (stopped) ran("sh", [path.join(K, "bin", "kuvo-start"), "start"]);
    }
    if (trial) noteUpdate({ trial: null });
    noteUpdate({ last: { at: clock(), result: "failed", message, from: before } });
    return { result: "failed", message };
  } finally {
    for (const name of listOf(UPDATES)) if (name !== "rollback" && name !== "installed.json") fs.rmSync(path.join(UPDATES, name), { recursive: true, force: true });
    fs.rmSync(UPDATE_LOCK, { recursive: true, force: true });
  }
}

// The new bridge, once an update put it there: well, the update's done. What was kept goes, and
// engines but this one.
export function confirmUpdate(clock = Date.now) {
  const state = updateState();
  if (!state.trial?.healthy || boxVersion() !== state.trial.to || isUpdating()) return false;
  let engine = null;
  try { engine = readEngineFile()?.version; } catch {}
  fs.rmSync(UPDATE_TRIAL, { force: true });
  fs.rmSync(ROLLBACK, { recursive: true, force: true });
  if (engine) for (const name of listOf(path.join(K, "engine"))) if (name !== engine && !name.startsWith(".")) fs.rmSync(path.join(K, "engine", name), { recursive: true, force: true });
  noteUpdate({ trial: null, last: { at: clock(), result: "updated", from: state.trial.from, to: state.trial.to } });
  return true;
}

// COMPAT(0.7 visits): "an older Mac" in `launchers.json`. Goes 3 months after 0.8.0.
// An older Mac (Kuvo Code 0.7 and before) to hold updates back for, from now: it would put back
// its own files.
function noteOlderMac(at) {
  let launchers = {};
  try { launchers = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  if ((launchers["an older Mac"] ?? 0) >= at) return;
  launchers["an older Mac"] = at;
  try { writePrivate(LAUNCHERS, JSON.stringify(launchers)); } catch {}
}

// COMPAT(0.7 visits): `run/attached` and `run/older-mac`, an older Mac's visits. Goes 3 months after 0.8.0.
// An older Kuvo Code on a Mac touches `run/attached` each time it connects, and this one never
// does: one that did lately holds this box's updates back (it would put back its own files). Not
// a touch from before a Kuvo Code that marks the box last put its files there: that was most
// likely the same Mac before it updated, and an older one still around touches it again.
export function noteOlderMacs() {
  let at = 0, marked = 0;
  try {
    at = fs.statSync(path.join(RUN, "attached")).mtimeMs;
    marked = fs.statSync(path.join(K, "bin", "box-version")).mtimeMs;
  } catch {}
  if (at <= marked) at = 0;
  // One a Mac's mark saw since the last check (`run/older-mac`), which marking hides.
  try { at = Math.max(at, fs.statSync(path.join(RUN, "older-mac")).mtimeMs); } catch {}
  if (!at || Date.now() - at > MAC_MEMORY) return false;
  noteOlderMac(at);
  return true;
}

// COMPAT(0.7 visits): drift, an older Mac's files put back over an update's. Goes 3 months after 0.8.0.
// Whether a Mac that doesn't leave a newer box as it is (an older Kuvo Code) put its own files back
// since the box updated itself (seen twice, ten minutes apart, and not while a Mac says it puts its
// files in place): then the box doesn't update itself for a while, as that Mac would undo it, and
// says why. Its version mark stays, so no other older Mac takes it further back.
export function checkDrift(now = Date.now()) {
  const record = path.join(UPDATES, "installed.json"), pending = path.join(RUN, "update-drift");
  // Not while the box updates itself, or tries what it updated to: its files and version change then.
  if (isUpdating() || fs.existsSync(UPDATE_TRIAL)) return false;
  let installed = null;
  try { installed = JSON.parse(fs.readFileSync(record, "utf8")); } catch { return false; }
  // A Mac marked it since (its own files, as they should be).
  if (installed?.version !== boxVersion() || !isObject(installed.files)) {
    fs.rmSync(record, { force: true });
    fs.rmSync(pending, { force: true });
    return false;
  }
  const changed = Object.entries(installed.files).some(([file, sha]) => {
    try { return hexSHA256(fs.readFileSync(path.join(K, file))) !== sha; } catch { return true; }
  });
  let installing = 0;
  try { installing = fs.statSync(path.join(RUN, "mac-installing")).mtimeMs; } catch {}
  if (!changed || isUpdating() || now - installing < 3600_000) {
    fs.rmSync(pending, { force: true });
    return false;
  }
  if (textOf(pending)?.trim() !== installed.version) {
    try { writePrivate(pending, installed.version); } catch {}
    return false;
  }
  noteOlderMac(now);
  noteUpdate({ last: { at: now, result: "failed", message: "An older Kuvo Code on a Mac put its own files back here: update Kuvo Code on your Macs." } });
  return true;
}

// Whether it's the night's window where you are (02:00 to 05:00, `KUVO_TZ`), and which night.
export function updateNight(date = new Date(), zone = process.env.KUVO_TZ) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" })
      .formatToParts(date).map(part => [part.type, part.value]));
  } catch {
    return null;
  }
  const hour = Number(parts.hour);
  return hour >= 2 && hour < 5 ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

// What `kuvo/update` says: whether updates are set up, this version and the newest heard of, how
// the last went, whether one runs now, and why not, when it can't.
export function updateStatus() {
  const state = updateState();
  let engine = null;
  try { engine = readEngineFile()?.version ?? null; } catch {}
  return {
    setUp: UPDATE_KEYS.length > 0,
    version: boxVersion(),
    engine,
    latest: state.latest ?? null,
    last: state.last ?? null,
    updating: isUpdating() ? state.running ?? "checking" : null,
    blocked: updatesBlocked(),
  };
}

// An update run by the bridge (a phone's or a Mac's Update Now, or the night's): one at a time;
// once it's "updated", the bridge goes, for the keeper to start the new one.
let updating = null;
export function startUpdate(options = {}) {
  if (updating || isUpdating()) return null;
  updating = update({ ...options, step: running => noteUpdate({ running }) })
    .then(outcome => {
      noteUpdate({ running: null, ...(outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } }) });
      if (outcome.result === "updated") setTimeout(() => process.exit(0), 1000);
      return outcome;
    }, () => null)
    .finally(() => { updating = null; });
  return updating;
}

// ---- This Mac's box's link (PROTOCOL.md, "This Mac's box: the relay") ----
// On a Mac, `serve` holds the relay connection a machine's `run` holds, in the same process: your
// phones' sessions, paired and pairing as on a machine, answered here. Its keys stay in your
// Keychain: the app gives them as the link starts (`link/identity`), and they're kept in memory
// only; without them the link stays off and says why, and never makes keys of its own. Its app says
// whether it's wanted (`kuvo/link/config`: the phone link on, machines to meet). Your other
// computers' mail is taken here, as a machine takes it: documents, agents, letters, group chats'.
// What a phone asks of the Mac's own routes, which only the app answers yet, goes to it through the
// host (`link/route`).

// What this Mac's box answers a phone itself: the areas that have moved onto it (PhoneLink's
// `boxRoutes`), and its phones. The rest the app answers, through the host.
export const MAC_BOX_ROUTES = ["kuvo/projects", "kuvo/worktrees", "kuvo/plugins", "kuvo/folders", "kuvo/wakes", "kuvo/config", "kuvo/mcp/catalog", "kuvo/skills", "kuvo/skill-library",
  "kuvo/skill-trash", "kuvo/integrations", "kuvo/keys", "kuvo/bots", "kuvo/personalities", "kuvo/phones", "kuvo/attention", "kuvo/accounts/ended",
  "kuvo/accounts/credentials", "kuvo/file", "kuvo/sign-in/return", "kuvo/named", "kuvo/groups"];
// (A plan signed out from a phone, `kuvo/accounts/<id>/forget`, and a command stopped,
// `kuvo/shell/<id>/stop`: the box's too.)
const macAnswersAlso = route => /^kuvo\/accounts\/[^/]+\/forget$/.test(route) || /^kuvo\/shell\/[^/]+\/stop$/.test(route);
export const macAnswers = route => MAC_BOX_ROUTES.some(area => route === area || route.startsWith(`${area}/`)) || macAnswersAlso(route);

const APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";

// Whether the link's wanted now: the phone link on, with a phone paired or a pairing waiting; or
// machines to meet.
function macNeeded(link, now = Date.now()) {
  const config = macLink.config;
  if (!config) return false;
  if (config.machines) return true;
  const pairing = ["pairing", "appPairing"].some(slot => link?.[slot] && now < link[slot].expires);
  return Boolean(config.phones && ((link?.phones ?? []).length || pairing));
}

// Off the relay once it's no longer wanted (the phone link turned off, the last phone gone, a
// pairing that ran out, no machines any more).
function macLinkCheck() {
  if (macLink.host && !macNeeded(readLink())) macLink.host.disconnect?.();
}

function setLinkStatus(state, reason) {
  const next = reason ? { state, reason } : { state };
  if (JSON.stringify(next) === JSON.stringify(macLink.status)) return;
  macLink.status = next;
  for (const tell of macLink.statusFollowers) tell();
}

// Waits `ms`, or until the link's told something changed (`macLink.wake`).
function macLinkWait(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (macLink.wake === done) macLink.wake = null;
      resolve();
    }
    macLink.wake = done;
  });
}

// One of the app's host calls for the link, its JSON, once the app has proved it's this Mac's
// (`askHost`); null when it isn't there or doesn't answer it.
async function linkHost(call, body) {
  const host = appHost();
  if (!host) return null;
  try {
    return await askHost(host, call, body ?? {});
  } catch {
    return null;
  }
}

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

// This Mac's keys, from its app (your Keychain): its link key, relay secret and signing key, kept
// with the relay and name it says once it's on. False when the app couldn't give them (the link
// says so).
async function macKeys() {
  const config = macLink.config;
  if (macLink.overlay || !config || !(config.phones || config.machines)) return true;
  const given = await linkHost("link/identity", {});
  if (!given || !["key", "secret", "sign"].every(name => KEY_TEXT.test(given[name] ?? ""))) {
    setLinkStatus("failed", "Kuvo Code couldn't give this Mac's link its keys from your Keychain. It tries again in a moment.");
    return false;
  }
  macLink.overlay = { key: given.key, secret: given.secret, sign: given.sign, relay: macLink.config.relay, name: macLink.config.name };
  // What it said of the keys before isn't so any more.
  if (macLink.status.state === "failed") setLinkStatus(macNeeded(readLink()) ? "connecting" : "off");
  return true;
}

// What a phone asks of the Mac's own routes, answered by the app (`link/route`), as it comes; 503,
// at once, when the app isn't answering, and a stream that ends when the app goes.
async function* toApp(request, phone, signal) {
  let response = null;
  const host = appHost();
  if (host) {
    try {
      // Nothing goes until it's proved it's this Mac's app: once for each host.json, which is
      // enough because this box (`serve`) ends with its app (its stdin closes), so no other
      // process can take the app's port while this box still trusts it, without the file changing.
      await proveHost(host);
      response = await fetch(`${host.url}/link/route`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          body: Buffer.from(request.body ?? EMPTY).toString("base64"),
          phone: phone?.key?.toString("base64url") ?? null,
        }),
        signal,
      });
    } catch {
      // Gone from there (or not proved): proved again before anything more is sent there.
      if (!signal?.aborted) provenBy = null;
      response = null;
    }
  }
  // The app's own answer says so (`x-kuvo-answer`), whatever its status: without it, the app
  // isn't there to answer (gone, starting again, or an older one).
  if (!response || response.headers.get("x-kuvo-answer") !== "1") {
    await response?.body?.cancel().catch(() => {});
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
    return;
  }
  const headers = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const cache = response.headers.get("cache-control");
  if (cache) headers["cache-control"] = cache;
  yield { head: { status: response.status, headers } };
  if (!response.body) return;
  // One cut off as it came (the app gone halfway) ends as cut off, not as a whole answer.
  for await (const chunk of response.body) {
    if (signal?.aborted) break;
    yield { body: Buffer.from(chunk) };
  }
}

// A phone's request on this Mac: the box's own areas here, the rest from the app.
export function macFront(handle = engineHandler(readEngineFile, { name: os.hostname() })) {
  return async function* (request, phone, signal) {
    const route = String(request.path ?? "").split("?")[0];
    // (The engine's API and the coding agents', as a machine's bridge passes them on, who a message
    // names with "&" told: bridge 0.9.64.)
    if (macAnswers(route) || /^api(\/|$)/.test(route) || route.startsWith(AGENTS)) return yield* handle(request, phone, signal);
    yield* toApp(request, phone, signal);
  };
}

// Phones from where an earlier Kuvo Code kept them (`phone-link.json`), met with this box's: each
// paired one in, unless a removal of its pairing is known; each removal noted, and taking off what
// it removes.
export function takePhones(link, given) {
  const phones = Array.isArray(given?.phones) ? given.phones.slice(0, 64) : [];
  const removed = Array.isArray(given?.removed) ? given.removed.slice(0, MOST_KEPT) : [];
  for (const entry of removed) if (fits(entry, []) && typeof entry.pairing === "string") takeOff(link, entry.key, entry.pairing);
  for (const phone of phones) {
    if (!isObject(phone) || !fits(phone, []) || removedAlready(link, phone.key, phone.pairing ?? "")) continue;
    const known = (link.phones ?? []).find(each => each.key === phone.key);
    if (known && (known.pairing ?? "") === (phone.pairing ?? "")) continue;
    pairPhone(link, {
      key: phone.key,
      name: String(phone.name ?? "").slice(0, 100),
      added: Number.isFinite(phone.added) ? Math.floor(phone.added) : Math.floor(Date.now() / 1000),
      from: "pair",
      ...(ADDRESS.test(phone.address ?? "") ? { address: phone.address } : {}),
      pairing: typeof phone.pairing === "string" ? phone.pairing : "",
    });
  }
  return link;
}

// The phones as the app keeps a copy of them (all of each, with where it is, and every removal),
// and whether Settings › Phone's pairing link is still waiting (a phone came in with it, or it ran
// out: it's done).
const macPhones = () => {
  const link = readLink();
  return {
    phones: link?.phones ?? [],
    removed: link?.removed ?? [],
    pairing: Boolean(link?.appPairing && Date.now() < link.appPairing.expires),
    // For the app's copy (an older Kuvo Code goes on from these counts, never back).
    documents: { own: link?.own ?? {}, held: link?.docs ?? {}, views: link?.views ?? {}, left: link?.left ?? [] },
  };
};

// What an earlier Kuvo Code kept of this Mac's documents (`phone-link.json`): how far each of its
// own has come (never back: your machines would refuse what comes next), the phones documents its
// machines signed, how far each machine's view of your personalities has come, and the machines it
// removed. Its machines are this box's peers by then, so what they signed is checked as it's taken.
export function takeMacDocuments(link, given) {
  if (!isObject(given)) return link;
  for (const [kind, had] of Object.entries(isObject(given.own) ? given.own : {})) {
    if (!DOC_KINDS.includes(kind) || !isObject(had) || !Number.isSafeInteger(had.n) || had.n < 1 || had.n > MOST_COUNT) continue;
    const now = link.own?.[kind];
    if (!now || had.n > now.n) link.own = { ...(link.own ?? {}), [kind]: { n: had.n, h: String(had.h ?? ""), b: String(had.b ?? "") } };
  }
  for (const envelope of Object.values(isObject(given.held) ? given.held : {}).slice(0, 256)) takeDoc(link, envelope);
  for (const [origin, seen] of Object.entries(isObject(given.views) ? given.views : {}).slice(0, 256)) {
    if (!SIGN.test(origin) || !isObject(seen) || !Number.isSafeInteger(seen.n) || seen.n < 1) continue;
    if (!link.views?.[origin] || seen.n > link.views[origin].n) link.views = { ...(link.views ?? {}), [origin]: { n: seen.n, h: String(seen.h ?? "") } };
  }
  const left = Array.isArray(given.left) ? given.left.filter(key => typeof key === "string" && KEY.test(key)) : [];
  if (left.length) link.left = [...new Set([...(Array.isArray(link.left) ? link.left : []), ...left])].slice(-64);
  return link;
}

// Your machines this Mac set up (over SSH), as its app says: those that sign their documents, each
// `{key, sign, address, name, id}`; the conversations being moved, `{session, key}` each; and the
// machines you removed, by key (`removed`): its peers document names them so they let this Mac go,
// and they hear that once. One just missing from the list (it can't be reached to be set up, say)
// isn't a peer now, and nothing more; one set up again is no longer removed. One that isn't a
// machine's record is left out (a line in the box's log says so), never the rest with it. No link
// for what isn't a list.
export function setMacPeers(link, given) {
  if (!isObject(given) || !Array.isArray(given.peers)) return { link: null, gone: [] };
  const now = given.peers.slice(0, MOST_PEERS).map(peer => ({ ...peer, kind: "machine" }))
    .filter(peer => fitsPeer(peer) && typeof peer.sign === "string" && SIGN.test(peer.sign)).map(cleanPeer);
  const skipped = Math.min(given.peers.length, MOST_PEERS) - now.length;
  if (skipped) console.error(`${skipped} of this Mac's machines weren't records the box could take, and were left out.`);
  const removed = (Array.isArray(given.removed) ? given.removed : []).filter(key => typeof key === "string" && KEY.test(key) && !now.some(peer => peer.key === key));
  const gone = peersOf(link).filter(peer => removed.includes(peer.key));
  const kept = (Array.isArray(link.left) ? link.left : []).filter(key => !now.some(peer => peer.key === key) && !removed.includes(key));
  link.left = [...kept, ...removed].slice(-64);
  link.macPeers = now;
  link.macMoved = cleanMoved(given.moved);
  pruneDocs(link);
  return { link, gone };
}

// Machines this Mac removed hear its peers document once, while it still knows where they are: they
// let this Mac go. Those it couldn't tell now (off the relay, or the connection closing) hear it
// once it's back (`link.untold`), each kept until it went.
function tellGone(gone) {
  if (!gone.length) return;
  const went = sendGone(gone);
  const left = gone.filter(peer => !went.includes(peer.key));
  updateLink(link => {
    if (!link) return null;
    const untold = (Array.isArray(link.untold) ? link.untold : []).filter(peer => !gone.some(each => each.key === peer.key));
    if (!left.length && untold.length === (link.untold?.length ?? 0)) return null;
    link.untold = [...untold, ...left].slice(-64);
    if (!link.untold.length) delete link.untold;
    return link;
  });
}

// Mails `gone` this Mac's peers document; the keys of those it went to.
function sendGone(gone) {
  const host = macLink.host;
  if (!host?.welcomed) return [];
  let envelope = null;
  const link = updateLink(link => {
    const made = link?.sign ? ownDoc(link, "peers", macPeersBody(link)) : null;
    envelope = made?.envelope ?? null;
    return made?.changed ? link : null;
  }) ?? readLink();
  if (!envelope || !link?.key) return [];
  const went = [];
  for (const peer of gone) {
    // (One that signs no documents takes none: nothing to tell it.)
    if (!peer.sign) {
      went.push(peer.key);
      continue;
    }
    const bytes = mailFor(peer, { docs: { give: [envelope] }, at: Date.now() }, link);
    try { if (bytes && host.send(bytes)) went.push(peer.key); } catch {}
  }
  return went;
}

// On the relay again: the machines removed meanwhile hear it now (one set up again since, not).
function tellUntold() {
  const link = readLink();
  const untold = (Array.isArray(link?.untold) ? link.untold : []).filter(fitsPeer);
  const again = untold.filter(peer => peersOf(link).some(each => each.key === peer.key));
  if (again.length) {
    updateLink(link => {
      if (!link?.untold) return null;
      link.untold = link.untold.filter(peer => !again.some(each => each.key === peer.key));
      return link;
    });
  }
  tellGone(untold.filter(peer => !again.includes(peer)).map(cleanPeer));
}

const ADDRESS_TEXT = /^[A-Za-z0-9_-]{22}$/;

// `kuvo/link/…`, for this Mac's app.
async function* macLinkRoute(route, request, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  switch (route) {
    case "kuvo/link/config": {
      if (method !== "PUT") return yield* json(405, {});
      const given = parsed(request.body);
      let relay = null;
      try { relay = given?.relay ? new URL(String(given.relay)) : null; } catch {}
      if (!isObject(given) || typeof given.phones !== "boolean" || typeof given.machines !== "boolean" || !relay || !["ws:", "wss:"].includes(relay.protocol)) {
        return yield* json(400, { message: "Say whether the phone link is on (phones) and there are machines (machines), and the relay." });
      }
      const config = { phones: given.phones, machines: given.machines, relay: relay.toString().replace(/\/$/, ""), name: String(given.name ?? "Mac").slice(0, 100), app: String(given.app ?? ""),
        ...(Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}) };
      const before = macLink.config;
      macLink.config = config;
      if (macLink.overlay) macLink.overlay = { ...macLink.overlay, relay: config.relay, name: config.name };
      // Phones not let in any more (the phone link off) lose what they have open; another relay
      // means another connection.
      if (!config.phones) macLink.host?.keepOnly(new Set());
      if (before && (before.relay !== config.relay || before.name !== config.name)) macLink.host?.disconnect?.();
      // Its keys before this answers, so a pairing link can be made right after.
      await macKeys();
      macLinkCheck();
      macLink.wake?.();
      // The phone link on or off: this Mac's phones document comes, or stops changing.
      if (before?.phones !== config.phones) macDocsChanged();
      return yield* json(200, macLink.status);
    }
    case "kuvo/link/status":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macLink.status);
    case "kuvo/link/status/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => macLink.status, macLink.statusFollowers, signal);
    case "kuvo/link/phones":
      if (method !== "GET") return yield* json(405, {});
      return yield* json(200, macPhones());
    case "kuvo/link/phones/events":
      if (method !== "GET") return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(macPhones, macLink.phoneFollowers, signal);
    case "kuvo/link/phones/take": {
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (!isObject(given) || !Array.isArray(given.phones ?? []) || !Array.isArray(given.removed ?? [])) return yield* json(400, { message: "Send {phones, removed}." });
      updateLink(link => takeMacDocuments(takePhones(link ?? { phones: [] }, given), given.documents));
      macLink.wake?.();
      macDocsChanged();
      return yield* json(200, macPhones());
    }
    case "kuvo/link/peers": {
      if (method !== "PUT") return yield* json(405, {});
      let gone = [];
      const changed = updateLink(link => {
        const made = setMacPeers(link ?? { phones: [] }, parsed(request.body));
        gone = made.gone;
        return made.link;
      });
      if (!changed) return yield* json(400, { message: "Send {peers: [{key, sign, address, name, id}], moved}." });
      macDocsChanged();
      tellGone(gone);
      return yield* json(200, {});
    }
    case "kuvo/link/setup": {
      // What setting up a machine over SSH gives it: this Mac's key, the key its documents are
      // signed with, its own documents as they are now and those it keeps of your machines.
      if (method !== "GET") return yield* json(405, {});
      await macKeys();
      // `?key=`: a machine set up again, no longer one this Mac removed.
      const again = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("key");
      const library = readPersonalities();
      let docs = [];
      const link = updateLink(link => {
        if (!link?.sign) return null;
        if (again && Array.isArray(link.left)) link.left = link.left.filter(key => key !== again);
        const own = ownDocs({ link, library });
        docs = [...Object.values(own).map(made => made.envelope), ...Object.values(link.docs ?? {}).sort((a, b) => (a.d < b.d ? -1 : 1))];
        return link;
      });
      if (!link) return yield* json(503, { message: "This Mac's link has no keys yet." });
      return yield* json(200, { mac: ownKey(link), macSign: ownSign(link), docs });
    }
    case "kuvo/link/docs": {
      // Documents a machine gave as it was set up (over SSH): taken as if they'd come by mail.
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      const sender = peersOf(readLink()).find(peer => peer.key === given?.from);
      if (!sender || !isObject(given.docs)) return yield* json(404, { message: "That isn't one of this Mac's machines." });
      await receiveDocs(sender, given.docs, macLink.host);
      return yield* json(200, {});
    }
    case "kuvo/link/documents": {
      // This Mac's documents, its own brought up to date first, and its digest (what its agents'
      // mail carries, so a machine that missed one gets it).
      if (method !== "GET") return yield* json(405, {});
      const library = readPersonalities();
      updateLink(link => {
        if (!link?.sign) return null;
        const before = JSON.stringify(link.own ?? {});
        ownDocs({ link, library });
        return JSON.stringify(link.own ?? {}) === before ? null : link;
      });
      const link = readLink();
      return yield* json(200, { ...macPhones().documents, have: link?.sign ? digestOf(link) : [] });
    }
    case "kuvo/link/letters": {
      // A letter from one of this Mac's conversations for an agent on another of your computers
      // (`peer`, its key), left in the outbox as a machine's tool leaves one: sent now, and each
      // minute until it's there; with `wait`, its answer, for as long as this is asked.
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      const link = readLink();
      const peer = peersOf(link).find(each => each.key === given?.peer);
      const from = typeof given?.from === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(given.from) ? given.from : null;
      if (!isObject(given) || typeof given.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(given.to) || typeof given.text !== "string" || !given.text.trim()) {
        return yield* json(400, { message: "Send {peer, to, text}, and from, wait." });
      }
      if (!peer) return yield* json(404, { message: "That isn't one of this Mac's computers." });
      const id = "ltr_" + crypto.randomBytes(16).toString("base64url");
      // Off the relay now: it goes once this Mac's back on it, and its answer can't be waited for.
      const online = Boolean(macLink.host?.welcomed);
      const wait = given.wait === true && Boolean(from) && online;
      try {
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ from, to: given.to, text: cutText(given.text), wait, at: Date.now(), peer: peer.key }));
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep it." });
      }
      if (!wait) {
        macSendOutbox();
        return yield* json(200, given.wait === true && from && !online ? { id, note: OFFLINE_LETTER } : { id });
      }
      // Waited for: a line once it's kept (so a request cut off after it knows it went), then one
      // with how it went.
      const answer = macLetterAnswer(id, signal);
      macSendOutbox();
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      yield { body: Buffer.from(JSON.stringify({ id }) + "\n") };
      yield { body: Buffer.from(JSON.stringify(await answer) + "\n") };
      return;
    }
    // COMPAT(beta.1 mac-letters): the letters an earlier Kuvo Code kept (`agent-letters.json`), into the outbox. Goes 3 months after 0.8.0.
    case "kuvo/link/letters/take": {
      // What an earlier Kuvo Code kept itself (PhoneLink, before this Mac's box took its peers): its
      // letters on their way, and the letters it had delivered (so one sent again isn't twice).
      if (method !== "POST") return yield* json(405, {});
      const given = parsed(request.body);
      if (!isObject(given)) return yield* json(400, { message: "Send {letters, seen}." });
      const now = Date.now();
      try {
        fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
        for (const letter of Array.isArray(given.letters) ? given.letters.slice(0, 500) : []) {
          if (!isObject(letter) || !LETTER_ID.test(letter.id ?? "") || typeof letter.to !== "string" || typeof letter.text !== "string" || typeof letter.peer !== "string") continue;
          const kept = { from: typeof letter.from === "string" ? letter.from : null, to: letter.to, text: cutText(letter.text), wait: false,
            at: typeof letter.at === "number" ? letter.at : now, peer: letter.peer, ...(typeof letter.answers === "string" ? { answers: letter.answers } : {}) };
          writePrivate(path.join(SENDING, `${letter.id}.json`), JSON.stringify(kept));
        }
        if (isObject(given.seen)) {
          locked(PEER_LOCK, () => {
            const seen = lettersSeen(now);
            for (const [id, at] of Object.entries(given.seen)) if (LETTER_ID.test(id) && typeof at === "number" && now - at < LETTER_MEMORY) seen[id] = Math.max(seen[id] ?? 0, at);
            writePrivate(LETTERS_SEEN, JSON.stringify(seen));
          });
        }
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep them." });
      }
      macSendOutbox();
      return yield* json(200, {});
    }
    case "kuvo/link/agents/refresh": {
      // The list of everyone made again from this Mac's conversations as they are now (one made a
      // moment ago), before a group chat here names someone with &.
      if (method !== "POST") return yield* json(405, {});
      await refreshOwn(readEngineFile).catch(() => {});
      return yield* json(200, {});
    }
    case "kuvo/link/agents": {
      // The agents your other computers told this Mac of, by computer (its key, and its id here).
      if (method !== "GET") return yield* json(405, {});
      const link = readLink();
      const told = readPeerAgents(undefined, undefined, link);
      return yield* json(200, { peers: peersOf(link).map(peer => ({ key: peer.key, id: peer.id ?? null, at: told[peer.key]?.at ?? 0,
        list: told[peer.key]?.list ?? [], features: told[peer.key]?.features ?? [] })) });
    }
    default:
      return yield* json(404, {});
  }
}

// This Mac's notices for your phones (PROTOCOL.md, "kuvo/attention"): held a little while you're at
// a computer (the app says when, as "mac"), then sealed here for each paired phone that's said where
// it is and pushed on the link's connection; kept for a box that starts again, as a machine's are.
// `clock`: a test's own (NoticeHold's `now`, `setTimer`, `clearTimer`).
export function macNoticeHold(clock = {}) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); } catch {}
  return new NoticeHold({
    ...clock,
    send: notice => {
      const link = readLink();
      const phones = (link?.phones ?? []).filter(phone => phone.address);
      // Not told yet whether the phone link's on (the app hasn't said, as it starts): held.
      if (!macLink.config) return false;
      if (!phones.length || !macLink.config.phones) return true;
      const host = macLink.host;
      if (!host?.welcomed || !link?.key) return false;
      const json = noticeJSON(notice);
      const key = Buffer.from(link.key, "base64url");
      // Gone out to one at least, or held to try again (a connection closing as it's sent).
      let sent = 0;
      for (const phone of phones) {
        try { if (host.send(pushTo(phone, json, key))) sent += 1; } catch {}
      }
      return sent > 0;
    },
    held,
    save: entries => {
      try {
        if (entries.length) writePrivate(HELD_FILE, JSON.stringify(entries));
        else fs.rmSync(HELD_FILE, { force: true });
      } catch {}
    },
  });
}

// A notice of this Mac's for your phones (its news, its app's own asks): held and sent while the
// phone link's on, or until its app says whether it is (as it starts); none while it's off.
export function macTell(notice) {
  // Off: let go now, so turning it on later never sends what came while it was off.
  if (!macLink.hold || (macLink.config && !macLink.config.phones)) return true;
  return macLink.hold.tell(notice);
}

// This Mac's box's link: up while it's wanted, its keys from the app, your phones answered here,
// what's the app's yet passed to it. Nothing it meets (the relay gone, a frame that isn't one, the
// app away) stops the box's own routes.
export async function runMacLink() {
  let attempt = 0;
  macLink.stopped = false;
  while (!macLink.stopped) {
    try {
      const config = macLink.config;
      // Its keys as soon as it's on (a pairing link needs them before any phone's paired).
      if (!(await macKeys())) {
        await macLinkWait(30_000);
        continue;
      }
      if (macLink.stopped) break;
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        await macLinkWait(60_000);
        continue;
      }
      const link = readLink();
      setLinkStatus("connecting");
      let engine = {};
      try { engine = readEngineFile(); } catch {}
      const host = new LinkHost({
        key: Buffer.from(link.key, "base64url"),
        hello: { v: 1, kind: "mac", name: config.name, app: config.app, engine: engine.version ?? null },
        // Phones only while the phone link's on (the relay can be up for your machines alone).
        authorize: (key, hello, address) => Boolean(macLink.config?.phones) && authorizePhone(key, hello, address),
        confirmed: confirmPhone,
        // Mail from your machines, taken here as a machine takes it (`peerMail`).
        mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets)),
        handle: macFront(engineHandler(readEngineFile, { name: config.name }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), macLink.hold)),
        connect: engineConnect(readEngineFile),
        send: () => {},
      });
      macLink.host = host;
      // A pairing can run out while it's up: looked at now and then.
      const looking = setInterval(macLinkCheck, 30_000);
      const started = Date.now();
      const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host, () => {
        setLinkStatus("connected");
        // Meeting your machines: who this Mac's agents are, asking for theirs; this Mac's
        // documents as they are now, and its digest to each; and those removed while it was away
        // hear it.
        announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
        try { docsChanged(host, { greet: true }); } catch {}
        try { tellUntold(); } catch {}
      });
      clearInterval(looking);
      if (macLink.host === host) macLink.host = null;
      if (macLink.stopped) break;
      // Not wanted any more: off now, not after a wait.
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        continue;
      }
      // Well only once a connection's held a while: one dropped right after its welcome (another
      // copy on the same address, say) backs off as one that never came up does.
      attempt = welcomed && Date.now() - started >= 60_000 ? 0 : attempt + 1;
      if (!welcomed) setLinkStatus("failed", `Can't reach the relay at ${new URL(link.relay).host}.`);
      else setLinkStatus("connecting");
      await macLinkWait(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
    } catch (error) {
      macLink.host = null;
      setLinkStatus("failed", String(error?.message ?? error));
      await macLinkWait(5_000);
    }
  }
  setLinkStatus("off");
}

// Something of this Mac's documents changed (a phone, a personality, your machines): what changed
// goes to your machines now, if it's on the relay; they get it as they meet otherwise.
export function macDocsChanged() {
  const host = macLink.host;
  if (host?.welcomed) try { docsChanged(host); } catch {}
}

// This Mac in use, or not any more, as its app says (`kuvo/attention`): each of your machines hears
// it by mail, with what of its own this Mac's notifications showed (`elsewhere`, by its id here), so
// notices for your phones wait a little there too, and one you saw here doesn't go.
function macAttendPeers(body, given) {
  const host = macLink.host;
  const link = readLink();
  if (!host?.welcomed || !link?.key) return;
  const at = Date.now();
  for (const peer of peersOf(link)) {
    const shown = isObject(body?.elsewhere) && Array.isArray(body.elsewhere[peer.id]) ? body.elsewhere[peer.id] : [];
    const theirs = attentionGiven({ for: 0, shown })?.shown ?? [];
    const bytes = mailFor(peer, { attention: { for: given.seconds, sessions: given.sessions, ...(theirs.length ? { shown: theirs } : {}) }, at }, link);
    if (bytes) try { host.send(bytes); } catch {}
  }
}

// Whether one of this Mac's conversations is moving to or from another computer now: its app runs
// the move (`link/moving`). Not when the app can't say (it isn't answering).
async function macMoving(session) {
  return (await linkHost("link/moving", { session }))?.moving === true;
}

// This Mac's box's agents and their letters, as a machine's link keeps them (`run`): its own listed
// here, link or not (its group chats name them); told to your other computers, and its letters
// sent, while the link's up; its group chats' mail carried on it.
export function runMacPeers() {
  const stop = new AbortController();
  takeSeatLetters();
  watchSeats(() => macLink.host, stop.signal);
  refreshOwn(readEngineFile).catch(() => {});
  const rounds = [
    setInterval(() => {
      const host = macLink.host;
      if (host?.welcomed) announce(host, readEngineFile).catch(() => {});
      else refreshOwn(readEngineFile).catch(() => {});
    }, 60_000),
    setInterval(macSendOutbox, 3_000),
  ];
  macLink.stopPeers = () => {
    stop.abort();
    for (const round of rounds) clearInterval(round);
  };
}

// Stops them (a test's, as it ends).
export function stopMacPeers() {
  macLink.stopPeers?.();
  macLink.stopPeers = null;
}

// The outbox, sent now while this Mac's box is on the relay (and its letters kept, not sent, while
// it isn't).
function macSendOutbox() {
  const host = macLink.host;
  try { sendOutbox(host?.welcomed ? host : { send() {} }, undefined, Date.now(), host?.welcomed ? 0 : 1); } catch {}
}

// How long one of this Mac's conversations waits for a letter's answer at most.
export const LETTER_WAIT = 660_000;
const OFFLINE_LETTER = "Your other computers can't be reached through the relay now: it goes once this Mac's back on it, and its answer comes to you as a message.";

// The answer to letter `id` (`macWaiting`): its words; or how it went, when it didn't get there or
// its answer can't come; or `{text: null}` once it's waited `most`, or its asker went (`signal`).
// Then it goes on without waiting, and an answer that comes later reaches the conversation as a
// message.
function macLetterAnswer(id, signal, most = LETTER_WAIT) {
  return new Promise(resolve => {
    const waiter = { sentTo: null, gone: () => Boolean(signal?.aborted), done: value => finish(value) };
    const timer = setTimeout(() => finish(null), most);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(value) {
      if (macWaiting.get(id) !== waiter) return;
      macWaiting.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!value) {
        const file = path.join(SENDING, `${id}.json`);
        try { writePrivate(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), wait: false })); } catch {}
      }
      resolve(value ?? { text: null });
    }
    macWaiting.set(id, waiter);
  });
}

// Group chats' letters an earlier Kuvo Code kept itself (`run/seat-letters.json`, its SeatRelay),
// in the outbox now, as this box carries them.
export function takeSeatLetters(file = path.join(RUN, "seat-letters.json")) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  try {
    fs.mkdirSync(SENDING, { recursive: true, mode: 0o700 });
    for (const [id, letter] of Object.entries(isObject(kept) ? kept : {})) {
      if (!LETTER_ID.test(id) || !isObject(letter) || typeof letter.peer !== "string" || typeof letter.seat !== "string") continue;
      let seat = null;
      try { seat = JSON.parse(Buffer.from(letter.seat, "base64").toString("utf8")); } catch {}
      if (!isObject(seat)) continue;
      writePrivate(path.join(SENDING, `${id}.json`), JSON.stringify({ peer: letter.peer, seat, at: typeof letter.at === "number" ? letter.at : Date.now(),
        ...(typeof letter.sentTo === "string" ? { sentTo: letter.sentTo } : {}), ...(letter.gaveUp === true ? { gaveUp: true } : {}),
        ...(typeof letter.aged === "number" ? { aged: letter.aged } : {}) }));
    }
    fs.rmSync(file, { force: true });
  } catch {}
}

// Stops it (a test's, as it ends): what's open goes, and the loop with it.
export function stopMacLink() {
  macLink.stopped = true;
  macLink.host?.disconnect?.();
  macLink.wake?.();
}

// ---- The relay connection ----

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What the relay sends once it's welcomed this connection, for `host`: something for it, or a phone
// gone (unreachable, or its connection went or was replaced), whose sessions end with nothing more
// sent. What this connection sends itself, to check it's alive, is only that.
export function fromRelay(host, message, self) {
  if (message.address.equals(self)) return;
  if (message.kind === "deliver") host.receive(message.address, message.payload);
  if (message.kind === "unreachable" || message.kind === "gone") host.forget(message.address);
}

// What a machine's link does once the relay's welcomed it: your other computers hear who's here,
// and it tells who's there; a new bridge an update put here says it's well.
function machineWelcomed(host) {
  announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
  try { docsChanged(host, { greet: true }); } catch {}
  try { confirmUpdate(); } catch {}
}

// Connects once, serves until the connection ends (or `host.disconnect()`). Resolves whether it got
// as far as welcome. `onWelcome(host)`: what's done then.
export function connectOnce(relay, secret, host, onWelcome = machineWelcomed) {
  return new Promise(resolve => {
    const self = addressOf(secret);
    let welcomed = false;
    let lastHeard = Date.now();
    const socket = new WebSocket(relay);
    socket.binaryType = "arraybuffer";
    // Something sent to ourselves comes back through the relay: that shows the connection's
    // alive, where WebSocket pings can't be seen from here.
    const check = setInterval(() => {
      if (Date.now() - lastHeard > 90_000) return finish();
      if (welcomed) socket.send(relaySend(self, EMPTY));
    }, 30_000);
    // Once, however it ends: Node's WebSocket reports a refused connection as an error alone,
    // with no close to follow, and one that never opens has to be given up on.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(check);
      clearTimeout(opening);
      try { socket.close(); } catch {}
      host.reset();
      host.send = () => {};
      host.welcomed = false;
      resolve(welcomed);
    };
    const opening = setTimeout(() => { if (!welcomed) finish(); }, 15_000);
    host.disconnect = finish;
    // What's queued for the relay and not sent yet (a push, as the app quits).
    host.unsent = () => (finished ? 0 : socket.bufferedAmount ?? 0);
    socket.onopen = () => socket.send(relayHello(secret));
    socket.onmessage = event => {
      lastHeard = Date.now();
      const message = readRelay(Buffer.from(event.data));
      if (!message) return;
      if (!welcomed) {
        if (message.kind !== "welcome" || !message.address.equals(self)) return socket.close();
        welcomed = true;
        // Whether it went out (a connection that's closing takes nothing).
        host.send = bytes => {
          if (socket.readyState !== 1) return false;
          socket.send(bytes);
          return true;
        };
        host.welcomed = true;
        try { onWelcome(host); } catch {}
        return;
      }
      fromRelay(host, message, self);
    };
    socket.onerror = finish;
    socket.onclose = finish;
  });
}

// (Whether a process is alive, and runs what it should: `alive` and `runs`, ../shared/platform.)

// Another bridge.
const isBridge = pid => pid !== process.pid && runs(pid, "kuvo-link.js");

// The box's keeper (`bin/kuvo-start`), started again if it went: it keeps the engine and this
// bridge running.
export function keepKeeper() {
  let start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return;
  // COMPAT(0.7 keeper): the keeper started from its own copy (`bin/.kuvo-start-keeper`) when an older Mac's kuvo-start has no `keep)`. Goes 3 months after 0.8.0.
  // An older Kuvo Code on a Mac (0.7 and before) put its own kuvo-start here, which only starts
  // the engine after a restart: the box's keeper, from the copy it keeps of itself (which puts
  // itself back).
  const copy = path.join(K, "bin", ".kuvo-start-keeper");
  if (!/\nkeep\)/.test(textOf(start) ?? "") && fs.existsSync(copy)) start = copy;
  let keeper = null;
  try { keeper = Number(fs.readFileSync(path.join(RUN, "box.pid"), "utf8")); } catch {}
  if (keeper && runs(keeper, "kuvo-start")) return;
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  try {
    spawn("sh", [start], { cwd: K, env: environment, detached: true, stdio: "ignore" }).unref();
  } catch {}
}

// Something to answer: a paired phone, a pairing code waiting, or other boxes of yours to talk to.
const needed = link => Boolean(link && ((link.phones ?? []).length || (link.pairing && Date.now() < link.pairing.expires) || peersOf(link).length));

async function run() {
  // One bridge at a time: a newer one (the engine restarted) takes over.
  let old = null;
  try {
    old = Number(fs.readFileSync(PID_FILE, "utf8"));
    if (isBridge(old)) process.kill(old, "SIGTERM");
  } catch {}
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  fs.writeFileSync(VERSION_FILE, BRIDGE_VERSION, { mode: 0o600 });
  // COMPAT(beta.1 connected): `run/connected` (beta.1) and `run/present` (0.7 with the phone link on), cleared. Goes when 0.8.0 ships.
  // The notes an earlier Kuvo Code on a Mac left that it was connected (it did some of the box's
  // work then): nothing reads them now.
  for (const folder of ["present", "connected"]) fs.rmSync(path.join(RUN, folder), { recursive: true, force: true });
  // Its bots' jobs kept in their folders, taken once from where they were before.
  try { keepJobs(); } catch {}
  forgetOldKit();
  // Its bots' folders' settings, as its integrations are now (after an update, say).
  await refreshBotsKeys().catch(() => {});
  // A link from an earlier bridge: its signing key made, and kept as this one keeps it.
  updateLink(link => {
    if (!link) return null;
    link.sign ??= newSigningSeed();
    foldPhones(link);
    return link;
  });
  const cleanUp = () => {
    try { if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanUp);
  process.on("SIGINT", cleanUp);

  // Stops when nothing's paired any more, or when another bridge took over; up while the engine
  // is down too, so a phone can start it. Phones removed since lose what they have open, and the
  // box's keeper, if it went, starts again (it keeps this bridge, and the engine, running).
  let current = null;
  setInterval(() => {
    let owner = null;
    try { owner = Number(fs.readFileSync(PID_FILE, "utf8")); } catch {}
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
    }
    if (!needed(link) || owner !== process.pid) return cleanUp();
    current?.keepOnly(new Set((link.phones ?? []).map(phone => phone.key)));
    keepKeeper();
  }, 30_000);

  // Your phones' notifications, on whichever relay connection is up: the engine's news, and what
  // agents ask for as they browse.
  // False when it can't go now (the relay isn't there), to be tried again.
  const tellPhones = notice => {
    const link = readLink();
    const phones = (link?.phones ?? []).filter(phone => phone.address);
    if (!phones.length) return true;
    if (!current?.welcomed || !link?.key) return false;
    const json = noticeJSON(notice);
    const key = Buffer.from(link.key, "base64url");
    let sent = false;
    for (const phone of phones) {
      try {
        current.send(pushTo(phone, json, key));
        sent = true;
      } catch {}
    }
    return sent;
  };
  // Each held a little while a client's in use here (PROTOCOL.md, "kuvo/attention"); what's held
  // is kept in run/held-notices.json, for the next bridge to send if this one stops first: read
  // once the one before has gone (a few seconds at most), so it neither sends nor holds one more.
  for (let tries = 0; tries < 60 && old && isBridge(old); tries++) await sleep(50);
  let held = [];
  try { held = JSON.parse(fs.readFileSync(HELD_FILE, "utf8")); } catch {}
  const hold = new NoticeHold({
    send: tellPhones,
    held,
    save: entries => {
      try {
        if (entries.length) writePrivate(HELD_FILE, JSON.stringify(entries));
        else fs.rmSync(HELD_FILE, { force: true });
      } catch {}
    },
  });
  const tell = notice => hold.tell(notice);
  const answered = id => hold.resolve(id);
  // Its engine and the coding agents here (their sessions, and group chats that live here),
  // through their bridge.
  watchBox({ tell, hold });
  // What its group chats send your other computers, carried on the relay connection that's up.
  watchSeats(() => current);
  watchAsks(tell, { answered });
  // Your other computers: this box's agents told to them while the relay connection is up (and
  // listed here, relay or not), and its agents' letters sent; without the relay a while, those
  // not sent yet go to the Mac.
  let lastWelcomed = Date.now();
  refreshOwn(readEngineFile).catch(() => {});
  // Updates: the new bridge, once one put it here, says it's well (after the relay's welcome, or
  // three minutes); each night's window, one, when nothing runs (PROTOCOL.md, "Updates").
  setTimeout(() => { try { confirmUpdate(); } catch {} }, 180_000);
  const nightly = () => {
    noteLauncher();
    noteOlderMacs();
    try { checkDrift(); } catch {}
    const night = updateNight();
    if (!night || updateState().night === night || !UPDATE_KEYS.length) return;
    startUpdate({})?.then(outcome => { if (outcome && outcome.result !== "busy") noteUpdate({ night }); });
  };
  setTimeout(nightly, 60_000);
  setInterval(nightly, 600_000);
  // Recently Deleted's skills past their 30 days, gone with no client there too.
  keepSkillTrashClear();
  setInterval(() => {
    if (current?.welcomed) announce(current, readEngineFile).catch(() => {});
    else refreshOwn(readEngineFile).catch(() => {});
  }, 60_000);
  setInterval(() => {
    if (current?.welcomed && docsNoted()) try { docsChanged(current, { tell: true }); } catch {}
    if (current?.welcomed) lastWelcomed = Date.now();
    try { sendOutbox(current ?? { send() {} }, undefined, Date.now(), current?.welcomed ? 0 : Date.now() - lastWelcomed); } catch {}
    deliverLeftAnswers().catch(() => {});
  }, 3_000);

  let attempt = 0;
  while (true) {
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
      return cleanUp();
    }
    let engine = {};
    try { engine = readEngineFile(); } catch {}
    const host = new LinkHost({
      key: Buffer.from(link.key, "base64url"),
      hello: { v: 1, kind: "machine", name: link.name || os.hostname(), app: BRIDGE_VERSION, engine: engine.version ?? null },
      authorize: authorizePhone,
      confirmed: confirmPhone,
      mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets), (mac, given, at) => hold.attend(`mac:${mac}`, given, at)),
      handle: engineHandler(readEngineFile, { name: link.name || os.hostname() }, readBridgeFile, changed => host.keepOnly(new Set((changed.phones ?? []).map(phone => phone.key))), hold),
      connect: engineConnect(readEngineFile),
      send: () => {},
    });
    current = host;
    const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host);
    attempt = welcomed ? 0 : attempt + 1;
    await sleep(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
  }
}

function runningBridge() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8"));
    return isBridge(pid) ? pid : null;
  } catch {
    return null;
  }
}

// Starts the bridge on its own, outliving this command, from the machine's workspace.
function startBridge() {
  const workspace = path.join(K, "workspace");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
    detached: true,
    stdio: "ignore",
    cwd: fs.existsSync(workspace) ? workspace : K,
    env: process.env,
  });
  child.unref();
}

// What the Mac sends: the relay, this machine's name, and the phones you've paired with the Mac,
// which may reach it directly. Keeps the machine's own keys (made the first time, and never
// leaving it) and phones paired with the machine itself, starts the bridge or restarts it (on
// another relay, or a newer one), and prints the machine's address and public key for the Mac
// to tell your phones. Nothing left to answer: the bridge stops, and the keys stay.
// `kuvo-link.js box <command>`: a Mac's way to a machine's own settings, over SSH, the same way a
// phone's goes (one answer, JSON, on stdout). `adopt` (a seed on stdin), `read`, `change`
// ({changes} on stdin), `key <name>` (its value on stdin; none removes it), `route` (a request,
// {method, path, body?}, answered as a phone's is: {status, body}), `bot-keys-refresh`.
async function box(command) {
  const input = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const say = value => console.log(JSON.stringify(value));
  switch (command) {
    // COMPAT(0.7 settings): `box adopt`, which a Mac runs over SSH. Goes 3 months after 0.8.0.
    case "adopt": {
      let seed = null;
      try { seed = JSON.parse((await input()) || "null"); } catch {}
      return say(adoptBox(seed));
    }
    // COMPAT(beta.1 box-read-change): `box read` and `box change`, which beta.1 runs over SSH (`box route` took their place). Goes when 0.8.0 ships.
    case "read": {
      const { settings, problem } = readSettings();
      return say(problem ? { status: 409, message: problem } : { status: 200, settings, own: ownsSettings() });
    }
    case "change": {
      let given = {};
      try { given = JSON.parse(await input()); } catch {}
      return say(ownsSettings() ? changeSettings(given?.changes) : { status: 409, message: "This machine's settings aren't its own yet." });
    }
    case "key": {
      const name = process.argv[4];
      const value = await input();
      return say(setBoxKey(name, value.length ? value : null));
    }
    case "update-status":
      return say({ status: 200, ...updateStatus() });
    case "update-now": {
      // On its own, outliving this command: what it does shows in update-status.
      if (!UPDATE_KEYS.length) return say({ status: 409, message: "Updates aren't set up for this machine yet." });
      const blocked = updatesBlocked();
      if (blocked) return say({ status: 409, message: blocked });
      if (isUpdating()) return say({ status: 409, message: "It's updating already." });
      spawn(process.execPath, [fileURLToPath(import.meta.url), "update", "--now"], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
      return say({ status: 202, ...updateStatus(), updating: "checking" });
    }
    case "route": {
      // A client's request, answered as the bridge answers a phone's: one that answers once,
      // never a stream that follows.
      answersOnce = true;
      let given = {};
      try { given = JSON.parse(await input()); } catch {}
      const handle = engineHandler(readEngineFile, { name: os.hostname() });
      const request = { method: String(given?.method ?? "GET"), path: String(given?.path ?? ""), headers: { "content-type": "application/json" }, body: Buffer.from(given?.body === undefined ? "" : JSON.stringify(given.body)) };
      let status = 502;
      const chunks = [];
      for await (const part of handle(request, {}, undefined)) {
        if (part.head) status = part.head.status;
        if (part.body) chunks.push(Buffer.from(part.body));
      }
      return say({ status, body: Buffer.concat(chunks).toString("utf8") });
    }
    case "reconnect": {
      // An integration's server connected again everywhere, a moment after `route` changed its
      // keys, once the engine has read them.
      const id = process.argv[4];
      await new Promise(done => setTimeout(done, 2_000));
      let engine;
      try { engine = readEngineFile(); } catch { return; }
      if (id) await reconnectEverywhere(engine, id);
      return;
    }
    case "bot-keys-refresh":
      // Its bots' folders' settings as their keys and this machine's integrations are now.
      await refreshBotsKeys();
      return say({ status: 200 });
    case "personalities": {
      // A Mac's copy met with this one's: both end up as one, and the bridge tells your other
      // computers if this one changed.
      let given = null;
      try { given = JSON.parse((await input()) || "null"); } catch {}
      const before = JSON.stringify(readPersonalities());
      const met = changePersonalities(library => mergePersonalities(library, given));
      if (JSON.stringify(met) !== before) noteDocsChanged();
      return say({ status: 200, ...met });
    }
    default:
      console.error("Usage: kuvo-link.js box adopt | read | change | key <name> | route | reconnect <server> | bot-keys-refresh | personalities | update-status | update-now");
      process.exit(2);
  }
}

// `serve`: this box's routes over HTTP, for a Mac, whose app starts its own box as it starts the
// coding agents' bridge: on 127.0.0.1, `{"url"}` said once it listens, answering only with the
// password in OPENCODE_PASSWORD, and gone when its stdin closes, so it never outlives the app. The
// same routes as a phone's through the relay, the path checked the same way; a stream goes as it
// comes, and stops when the client goes. The engine and the agents' bridge are found as on a
// machine (`run/engine.json`, `run/bridge.json`), which the app writes.
export function serveBox(password, handle = engineHandler(readEngineFile, { name: os.hostname() })) {
  const expected = Buffer.from("Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
  return http.createServer(async (request, response) => {
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
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    let headed = false;
    try {
      // The app's own (the Mac's link says which aren't a phone's), not a phone using this box.
      const fromApp = request.headers["x-kuvo-from"] === "app";
      for await (const part of handle({ method: request.method ?? "GET", path: sent, headers: request.headers, body: Buffer.concat(chunks), fromApp }, {}, abort.signal)) {
        if (abort.signal.aborted) break;
        if (part.head && !headed) {
          response.writeHead(part.head.status, part.head.headers ?? {});
          response.flushHeaders();
          headed = true;
        }
        if (part.body) response.write(part.body);
      }
    } catch (error) {
      if (!headed) {
        response.writeHead(500, { "content-type": "application/json" });
        response.write(JSON.stringify({ message: String(error?.message ?? error) }));
        headed = true;
      }
    }
    if (!headed) response.writeHead(502);
    response.end();
  });
}

async function serve() {
  const password = process.env.OPENCODE_PASSWORD;
  if (!password) {
    console.error("serve answers only with a password: set OPENCODE_PASSWORD.");
    process.exit(2);
  }
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  // This Mac's settings with what its engine starts with, before a client reads them.
  if (IS_MAC) addMacDefaults();
  // This Mac's notices for your phones, held while you're at a computer, as a machine's are.
  if (IS_MAC) macLink.hold = macNoticeHold();
  const server = serveBox(password, engineHandler(readEngineFile, { name: os.hostname() }, readBridgeFile, () => {}, macLink.hold));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
  // Its bots' folders' settings, as its keys and integrations are now (after an update, say), as a
  // machine's bridge does as it starts; where its keys can't be reached yet, they stay as they were.
  refreshBotsKeys().catch(() => {});
  // Keys of bots deleted while they couldn't be reached.
  forgetLeftKeys().catch(() => {});
  // Its wake-ups and watches, sent while it runs, with the app's window closed too.
  sendWakes();
  // This Mac's link to your phones and machines, once its app says it's wanted.
  if (IS_MAC) runMacLink().catch(() => {});
  // Its agents and their letters, and its group chats' mail, for your other computers. (Not for
  // the app's route scenarios, `KUVO_TEST_NO_PEERS`, whose fixture tells its bridge who they are.)
  // Never the real app's box (`run.kuvo.code/box`).
  const testsAlone = process.env.KUVO_TEST_NO_PEERS && path.basename(path.dirname(path.resolve(K))) !== "run.kuvo.code";
  if (IS_MAC && !testsAlone) runMacPeers();
  // Recently Deleted's skills past their 30 days, gone with no client there too.
  keepSkillTrashClear();
  // Its bots' jobs kept in their folders, taken once from where they were before, once its app
  // makes them this box's (it gives the box its kit then).
  if (readKit()) try { keepJobs(); } catch {}
  // Its bots kept told what they are as their runs start, on the engine and with the coding agents;
  // on a Mac, its news for your phones too (while the phone link's on), and its sign-ins that ended.
  watchBox({ tell: macTell, hold: macLink.hold, bots: true, notices: IS_MAC });
  // Its app gone (its stdin closed): so is it, once what its link has queued for the relay is out
  // (a notice sent as the app quit), a moment at most.
  const leave = async () => {
    for (let tries = 0; tries < 30 && (macLink.host?.unsent?.() ?? 0) > 0; tries++) await sleep(50);
    // What didn't get out in time isn't lost without a word.
    if ((macLink.host?.unsent?.() ?? 0) > 0) console.error("Kuvo Code quit before what its link had for your phones and machines went out.");
    process.exit(0);
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
  process.stdin.resume();
}

// Where a letter's agent can be here: the engine, and the coding agents' bridge while it runs.
function peerTargets() {
  const targets = [];
  try { targets.push(readEngineFile()); } catch {}
  try {
    const bridge = readBridgeFile();
    if (bridge?.port && bridge?.password && runs(bridge.pid, "kuvo-agents")) targets.push(bridge);
  } catch {}
  return targets;
}

async function setup() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("setup takes JSON on stdin: {relay, name, mac, macSign, docs: [{d, s}], id, …}");
    process.exit(2);
  }
  const mac = typeof input.mac === "string" ? input.mac : undefined;
  const running = runningBridge();
  const old = readLink();
  const before = readPersonalities();
  let link = null, work = null, library = before;
  updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), phones: [] };
    next.sign ??= newSigningSeed();
    if (mac) {
      next.mac = mac;
      next.macs = [...new Set([...macsOf(next), mac])];
      forgetOldMacs(next, mac);
      // The key its documents are signed with (over SSH, so this box knows it's that Mac's), which
      // takes the place of a list it gave before it signed them.
      if (typeof input.macSign === "string" && SIGN.test(input.macSign)) {
        next.macSigns = { ...(next.macSigns ?? {}), [mac]: input.macSign };
        if (next.legacy) delete next.legacy[mac];
      } else if (Array.isArray(input.peers)) {
        // COMPAT(beta.1 peers-list): the list of peers a beta.1 Mac's setup gives. Goes when 0.8.0 ships.
        // A Mac that signs none yet (0.8.0-beta.1): its peers as it lists them.
        takeLegacyPeers(next, mac, input.peers, typeof input.peersAt === "number" ? input.peersAt : (typeof input.at === "number" ? input.at : 0), input.moved);
      }
    }
    if (typeof input.id === "string") next.id = input.id.slice(0, 200);
    // COMPAT(0.7 visits): a Mac that doesn't say it `tolerates` newer boxes holds updates back. Goes 3 months after 0.8.0.
    // Whether this Mac leaves a newer box as it is, by its ID (as its engine launches name it): the
    // box updates itself only while every Mac that started its engine lately does (PROTOCOL.md, "Updates").
    if (typeof input.macID === "string" && /^[A-Za-z0-9-]{1,100}$/.test(input.macID)) next.tolerantIDs = { ...(next.tolerantIDs ?? {}), [input.macID]: input.tolerates === 1 };
    // Its documents, and those it carries of your other computers: taken as any are.
    const state = { link: next, library: before };
    // (The Mac setting it up wants it: a removal it signed before never counts here now.)
    work = docsWork(state, { key: mac ?? "", sign: mac ? macSign(next, mac) : undefined }, { give: Array.isArray(input.docs) ? input.docs : [] }, { stay: mac ?? null });
    library = state.library;
    if (!next.phones.length && !peersOf(next).length) return current ? next : null;
    next.relay = String(input.relay);
    next.name = String(input.name || next.name || os.hostname()).slice(0, 100);
    link = next;
    return next;
  });
  if (work && library !== before) await takePersonalities(library).catch(() => {});
  // The running bridge tells your other computers what changed.
  noteDocsChanged();
  // None paired any more (each removed for good, as one at a time would be): no bridge.
  if (!link) {
    if (running) process.kill(running, "SIGTERM");
    forgetPhones();
    console.log("{}");
    return;
  }
  // A new relay or name needs a new connection, and a newer bridge replaces an older one.
  let runningVersion = null;
  try { runningVersion = fs.readFileSync(VERSION_FILE, "utf8").trim(); } catch {}
  const restart = old?.relay !== link.relay || old?.name !== link.name || runningVersion !== BRIDGE_VERSION;
  // Not while the box updates itself: the bridge running it would end, and the keeper starts the
  // new one once it's done.
  if (!isUpdating()) {
    if (running && restart) process.kill(running, "SIGTERM");
    if (!running || restart) startBridge();
  }
  console.log(JSON.stringify({
    address: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    // Talks to other boxes itself (PROTOCOL.md, "Peers").
    peers: true,
    // Its signing key, and the documents it has, for the Mac to take (PROTOCOL.md, "Documents").
    sign: ownSign(link),
    docs: setupDocs(link),
  }));
}

// What setup gives back of documents: those this box keeps, and its own as they are now.
function setupDocs(link) {
  const state = { link, library: readPersonalities() };
  const own = ownDocs(state);
  return [...Object.values(link.docs ?? {}), ...Object.values(own).map(each => each.envelope)];
}

// `leave <mac>`: Mac `mac` removed this machine. It's no longer one of its Macs: its lists of
// peers and phones no longer count here, and what peers only it named told goes. Another Mac's
// stay; with no peers or phones left, the bridge stops.
export function leave(mac) {
  if (typeof mac !== "string" || !KEY.test(mac)) return false;
  const link = updateLink(link => {
    if (!link || !macsOf(link).includes(mac)) return null;
    leaveMac(link, mac);
    pruneDocs(link);
    foldPhones(link);
    return link;
  });
  if (!link) return false;
  forgetMacsAgents(mac, link);
  noteDocsChanged();
  return true;
}

// What peers only `mac` named told this box, and what that Mac said over SSH, gone with it.
function forgetMacsAgents(mac, link) {
  const keep = new Set(peersOf(link).map(peer => peer.key));
  locked(PEER_LOCK, () => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(PEER_AGENTS_FILE, "utf8")); } catch { return; }
    for (const key of Object.keys(all)) if (!keep.has(key)) delete all[key];
    writePrivate(PEER_AGENTS_FILE, JSON.stringify(all));
  });
  try { if (JSON.parse(fs.readFileSync(MAC_AGENTS_FILE, "utf8"))?.key === mac) fs.rmSync(MAC_AGENTS_FILE, { force: true }); } catch {}
  writeAgents(link);
}

// A pairing's token, good once, for `PAIRING_MINUTES`.
const newPairingToken = () => ({ token: crypto.randomBytes(16).toString("base64url"), expires: Date.now() + PAIRING_MINUTES * 60_000 });

// The link a phone pairs with, for `link`'s pairing.
export function pairingLink(link) {
  const query = new URLSearchParams({
    v: "1",
    relay: link.relay,
    host: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    token: link.pairing.token,
    name: link.name,
  });
  return `kuvo-link://pair?${query}`;
}

function pair(relay) {
  const link = updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), name: os.hostname(), phones: [] };
    next.sign ??= newSigningSeed();
    if (relay) next.relay = relay;
    if (!next.relay) return null;
    next.pairing = newPairingToken();
    return next;
  });
  if (!link) {
    console.error("Give the relay's address: kuvo-link.js pair wss://…");
    process.exit(1);
  }
  console.log(pairingLink(link));
  console.error(`Open this link on your phone within ${PAIRING_MINUTES} minutes. It works once.`);
  if (!runningBridge()) startBridge();
}

// Checks this runtime has what the link needs, both ends of a session and a mail.
export function selftest() {
  const phone = newKey(), host = newKey();
  const initiator = new IKInitiator(phone, publicOf(host), PROLOGUE);
  const responder = new IKResponder(host, PROLOGUE);
  const said = responder.readMessage1(initiator.writeMessage1(Buffer.from("hello")));
  const { message, transport: hostSide } = responder.writeMessage2(Buffer.from("welcome"));
  const { payload, transport: phoneSide } = initiator.readMessage2(message);
  const echoed = hostSide.open(phoneSide.seal(Buffer.from("ping")));
  const mail = openOneWay(sealOneWay(Buffer.from("mail"), host, publicOf(phone)).message, phone, publicOf(host)).payload;
  const ok = said.toString() === "hello" && payload.toString() === "welcome" && echoed.toString() === "ping" && mail.toString() === "mail"
    && responder.rs.equals(publicOf(phone)) && typeof WebSocket === "function" && typeof fetch === "function";
  return ok;
}

const main = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (main) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "run") await run();
  else if (mode === "setup") await setup();
  else if (mode === "pair") pair(argument);
  else if (mode === "box") await box(argument);
  else if (mode === "serve") await serve();
  else if (mode === "leave") leave(argument);
  else if (mode === "update") {
    // `update [--now]`, and for a test's folder only, `--url <boxes.json> --key <public key>`. Once
    // it's updated, the running bridge goes, for the keeper to start the new one.
    const args = process.argv.slice(3);
    const option = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
    const test = option("--url") && option("--key") && path.resolve(K) !== path.join(os.homedir(), ".kuvo-code");
    const outcome = await update({ now: args.includes("--now"), step: running => noteUpdate({ running }), ...(test ? { url: option("--url"), keys: [option("--key")], blocked: null } : {}) });
    noteUpdate({ running: null, ...(outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } }) });
    if (outcome.result === "updated") {
      const pid = runningBridge();
      if (pid) process.kill(pid, "SIGTERM");
      // No bridge to start again (nothing for it to answer): the new version came up, so it's done.
      if (!needed(readLink())) confirmUpdate();
    }
    console.log(JSON.stringify(outcome));
  }
  else if (mode === "selftest") {
    const ok = selftest();
    console.log(ok ? "ok" : "failed");
    process.exit(ok ? 0 : 1);
  } else {
    console.error("Usage: kuvo-link.js run | serve | setup | pair [relay] | box <command> | leave <mac> | update [--now] | selftest");
    process.exit(2);
  }
}
