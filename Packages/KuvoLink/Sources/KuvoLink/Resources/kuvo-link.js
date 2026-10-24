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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Goes up with every change, so `setup` replaces a running bridge that's older.
export const BRIDGE_VERSION = "0.9.28";
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

// ---- Keys: X25519 keys are kept as their raw 32 bytes ----

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const EMPTY = Buffer.alloc(0);

const privateKey = raw => crypto.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
const publicKey = raw => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
export const newKey = () => crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length);
export const publicOf = raw => crypto.createPublicKey(privateKey(raw)).export({ format: "der", type: "spki" }).subarray(SPKI.length);
const dh = (raw, remote) => crypto.diffieHellman({ privateKey: privateKey(raw), publicKey: publicKey(remote) });
export const addressOf = secret => crypto.createHash("sha256").update("kuvo-link address v1").update(secret).digest().subarray(0, 16);

// ---- Noise: IK for sessions, K for mail, with X25519, AES-GCM and SHA-256 ----

const sha256 = data => crypto.createHash("sha256").update(data).digest();
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
function hkdf(chainingKey, input) {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Buffer.from([1]));
  return [first, hmac(temp, Buffer.concat([first, Buffer.from([2])]))];
}

export class CipherState {
  constructor(key) {
    this.key = key;
    this.n = 0n;
  }

  nonce() {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.n, 4);
    return nonce;
  }

  encrypt(ad, plaintext) {
    if (!this.key) return plaintext;
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, this.nonce());
    cipher.setAAD(ad);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.n += 1n;
    return sealed;
  }

  decrypt(ad, ciphertext) {
    if (!this.key) return ciphertext;
    if (ciphertext.length < 16) throw new Error("decrypt");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, this.nonce());
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    } catch {
      throw new Error("decrypt");
    }
    this.n += 1n;
    return plaintext;
  }
}

class SymmetricState {
  constructor(name, prologue) {
    const bytes = Buffer.from(name);
    this.h = bytes.length <= 32 ? Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]) : sha256(bytes);
    this.ck = this.h;
    this.cipher = new CipherState();
    this.mixHash(prologue);
  }

  mixKey(input) {
    const [chainingKey, key] = hkdf(this.ck, input);
    this.ck = chainingKey;
    this.cipher = new CipherState(key);
  }

  mixHash(data) {
    this.h = sha256(Buffer.concat([this.h, data]));
  }

  encryptAndHash(plaintext) {
    const ciphertext = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    const [first, second] = hkdf(this.ck, EMPTY);
    return [new CipherState(first), new CipherState(second)];
  }
}

const IK = "Noise_IK_25519_AESGCM_SHA256";
const ONE_WAY = "Noise_K_25519_AESGCM_SHA256";
export const PROLOGUE = Buffer.from("kuvo-link v1");
export const MAIL_PROLOGUE = Buffer.from("kuvo-link mail v1");

const transport = (sending, receiving, hash) => ({
  hash,
  seal: plaintext => sending.encrypt(EMPTY, plaintext),
  open: ciphertext => receiving.decrypt(EMPTY, ciphertext),
});

// The side that starts (the phone), knowing the other's static key. Here for tests.
export class IKInitiator {
  constructor(s, rs, prologue, e = newKey()) {
    Object.assign(this, { s, rs, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(rs);
  }

  writeMessage1(payload) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.rs));
    const s = state.encryptAndHash(publicOf(this.s));
    state.mixKey(dh(this.s, this.rs));
    return Buffer.concat([ephemeral, s, state.encryptAndHash(payload)]);
  }

  readMessage2(message) {
    if (message.length < 48) throw new Error("malformed");
    const state = this.state;
    const re = message.subarray(0, 32);
    state.mixHash(re);
    state.mixKey(dh(this.e, re));
    state.mixKey(dh(this.s, re));
    const payload = state.decryptAndHash(message.subarray(32));
    const [first, second] = state.split();
    return { payload, transport: transport(first, second, state.h) };
  }
}

// The side that answers (this machine), learning the phone's static key.
export class IKResponder {
  constructor(s, prologue, e = newKey()) {
    Object.assign(this, { s, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(publicOf(s));
  }

  readMessage1(message) {
    if (message.length < 96) throw new Error("malformed");
    const state = this.state;
    this.re = message.subarray(0, 32);
    state.mixHash(this.re);
    state.mixKey(dh(this.s, this.re));
    this.rs = state.decryptAndHash(message.subarray(32, 80));
    state.mixKey(dh(this.s, this.rs));
    return state.decryptAndHash(message.subarray(80));
  }

  writeMessage2(payload) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.re));
    state.mixKey(dh(this.e, this.rs));
    const message = Buffer.concat([ephemeral, state.encryptAndHash(payload)]);
    const [first, second] = state.split();
    return { message, transport: transport(second, first, state.h) };
  }
}

// One message to a device that knows the sender, for pushes.
export function sealOneWay(payload, s, rs, prologue = MAIL_PROLOGUE, e = newKey()) {
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(publicOf(s));
  state.mixHash(rs);
  const ephemeral = publicOf(e);
  state.mixHash(ephemeral);
  state.mixKey(dh(e, rs));
  state.mixKey(dh(s, rs));
  return { message: Buffer.concat([ephemeral, state.encryptAndHash(payload)]), following: state.split()[0] };
}

export function openOneWay(message, s, rs, prologue = MAIL_PROLOGUE) {
  if (message.length < 48) throw new Error("malformed");
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(rs);
  state.mixHash(publicOf(s));
  const re = message.subarray(0, 32);
  state.mixHash(re);
  state.mixKey(dh(s, re));
  state.mixKey(dh(s, rs));
  return { payload: state.decryptAndHash(message.subarray(32)), following: state.split()[0] };
}

// ---- Frames ----

export const Frame = { handshake1: 1, handshake2: 2, transport: 3, close: 4, mail: 5 };
const MAX_MESSAGE = 65535 - 16;

export const relayHello = secret => Buffer.concat([Buffer.from([1]), secret]);
export const relaySend = (to, payload) => Buffer.concat([Buffer.from([2]), to, payload]);
export const relayPush = (to, payload) => Buffer.concat([Buffer.from([5]), to, payload]);

// What the relay sent, or null.
export function readRelay(bytes) {
  const kind = bytes[0];
  const address = bytes.subarray(1, 17);
  if (kind === 1 && bytes.length === 17) return { kind: "welcome", address };
  if (kind === 2 && bytes.length >= 17) return { kind: "deliver", address, payload: bytes.subarray(17) };
  if (kind === 3 && bytes.length === 17) return { kind: "unreachable", address };
  if (kind === 6 && bytes.length === 18) return { kind: "pushed", address, status: bytes[17] };
  return null;
}

export function frame(kind, session, body = EMPTY) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(session, 1);
  return Buffer.concat([header, body]);
}

export function readFrame(bytes) {
  if (bytes.length < 5 || bytes[0] < 1 || bytes[0] > 5) return null;
  return { kind: bytes[0], session: bytes.readUInt32BE(1), body: bytes.subarray(5) };
}

// JSON with sorted keys, as the Swift side writes it.
function sortedJSON(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${sortedJSON(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function encodeMessage(head, body = EMPTY) {
  const json = Buffer.from(sortedJSON(head));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(json.length);
  return Buffer.concat([length, json, body]);
}

export function decodeMessage(bytes) {
  if (bytes.length < 2) return null;
  const length = bytes.readUInt16BE(0);
  if (bytes.length < 2 + length) return null;
  try {
    return { head: JSON.parse(bytes.subarray(2, 2 + length).toString("utf8")), body: bytes.subarray(2 + length) };
  } catch {
    return null;
  }
}

// `head` and `body` as messages that each fit: the first with `head`, the rest as `data`.
export function pieces(head, body, end) {
  if (Buffer.byteLength(sortedJSON(head)) > 60_000) throw new Error("head too long");
  const out = [];
  let current = { ...head, end: false };
  let offset = 0;
  do {
    const room = MAX_MESSAGE - 2 - Buffer.byteLength(sortedJSON(current)) - 8;
    out.push([current, body.subarray(offset, offset + room)]);
    offset += room;
    current = { t: "data", id: head.id, end: false };
  } while (offset < body.length);
  out[out.length - 1][0].end = end;
  return out.map(([h, b]) => encodeMessage(h, b));
}

// ---- The host: answers paired phones' sessions (the Mac app's LinkServer, in JavaScript) ----

export class LinkHost {
  // authorize(key, hello, address) → whether to let the phone in; handle(request, phone, signal) → an
  // async iterable of { head: { status, headers } } and { body }; connect(request, phone,
  // { open, text, binary, end }) → a socket's { send, close } (PROTOCOL.md, "Sockets");
  // send(bytes) → to the relay; confirmed(phone) → its session proved its own: its first message
  // opened with the handshake's keys, which a replayed first handshake message can't do.
  // mail(from, body) → a mail frame sent to this machine (its Mac's phone list).
  constructor({ key, hello, authorize, handle, connect, send, confirmed, mail }) {
    Object.assign(this, { key, hello, authorize, handle, connect, send, confirmed, mail });
    this.sessions = new Map();
  }

  // The relay connection dropped: what was under way is gone.
  reset() {
    for (const session of this.sessions.values()) this.end(session, false);
  }

  get active() { return this.sessions.size; }

  // A phone the relay can't reach any more (asleep, gone): what it asked for has nobody to go to.
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
        return this.mail?.(from, parsed.body);
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
export const FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it.", "</from-phone>"].join("\n");

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
async function* forward(target, path, request, signal, allows) {
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
  // A message the phone sends: that it's from the phone goes with it.
  const prompt = method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(url.pathname);
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
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : prompt ? fromPhone(request.body) : request.body,
    signal,
  });
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
const INTEGRATION_DATA = path.join(K, "integrations");
// Bots' own keys (`answerBotKeys`), the box's own beside its shared ones: a start from a Mac
// replaces what it sent in `keys`, and leaves `box` alone.
const BOT_KEYS = path.join(K, "box", "bot-keys");

function integrationCatalog(file = INTEGRATIONS_FILE) {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")).integrations ?? []).filter(each => typeof each?.id === "string" && !each.macOnly); } catch { return []; }
}

/** How it's doing here, as the Mac's Integrations.health says it: `off`, turned off in MCP Servers. */
function integrationHealth(entry, server, off, signedIn) {
  if (off) return "disabled";
  let health = { connected: "connected", needs_auth: "needsSignIn", failed: "failed", disabled: "disabled" }[server?.status?.status] ?? "starting";
  if (health === "connected" && server?.integrationID && !signedIn.has(server.integrationID) && ["official", "app"].includes(entry.way)) health = "needsSignIn";
  return health;
}

/** Each as `kuvo/integrations` lists it, from the catalog, with how it's doing on this machine. */
async function integrationEntries(catalog, engine, signal) {
  const { settings } = readSettings();
  let servers = [];
  let signedIn = new Set();
  if (engine) {
    servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => []);
    const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
    signedIn = new Set((Array.isArray(credentials) ? credentials : []).filter(each => each?.active && each?.value?.type === "oauth").map(each => each.integrationID));
  }
  return catalog.map(({ settings: _, variables, ...entry }) => {
    const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
    const shown = { ...entry, added };
    if (variables) shown.keysSaved = Object.values(variables).every(name => fs.existsSync(path.join(BOX_KEYS, name)));
    if (added) {
      const server = (Array.isArray(servers) ? servers : []).find(each => each?.name === entry.id);
      shown.health = integrationHealth(entry, server, valueAt(settings ?? {}, [...SERVERS, entry.id, "disabled"]) === true, signedIn);
      if (server?.integrationID) shown.signIn = server.integrationID;
    }
    return shown;
  });
}

/** Its bots' own keys for it (`KUVO_KEY_<ID>_<NAME>__<BOT>`) and their folders' settings naming its server, gone. */
function dropBotsIntegration(entry) {
  const own = Object.values(entry.variables ?? {});
  for (const name of listOf(BOT_KEYS)) if (own.some(variable => name.startsWith(`${variable}__`))) fs.rmSync(path.join(BOT_KEYS, name), { force: true });
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
}

/** Runs `run` in `ms`, without keeping the bridge up for it. */
const soon = (run, ms) => setTimeout(run, ms).unref?.();

/** `kuvo/integrations…`, for this machine's own. `later` runs what waits a moment (a test's own). */
export async function answerIntegrations(method, requestPath, body, engine, signal, file = INTEGRATIONS_FILE, later = soon) {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return ""; } });
  const catalog = integrationCatalog(file);
  if (parts.length === 2) {
    if (method !== "GET") return { status: 405, value: {} };
    const { problem } = readSettings();
    return { status: 200, value: { integrations: await integrationEntries(catalog, engine, signal), ...(problem ? { problem } : {}) } };
  }
  const entry = parts.length === 3 ? catalog.find(each => each.id === parts[2]) : null;
  if (!entry) return { status: 404, value: {} };
  const { settings, problem } = readSettings();
  if (problem) return { status: 409, value: { message: `The engine's settings file can't be changed from here: ${problem}` } };
  const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
  if (method === "POST") {
    if (entry.way === "browser" || !entry.settings) return { status: 409, value: { message: `The agent uses ${entry.title} on its site: sign in to it in the browser on this machine.` } };
    const variables = entry.variables ?? {};
    const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
    const names = Object.keys(variables);
    let newKeys = false;
    if (names.length) {
      if (names.every(name => typeof given[name] === "string" && given[name].trim())) {
        for (const name of names) {
          const saved = setBoxKey(variables[name], given[name].trim());
          if (saved.status !== 200) return { status: saved.status, value: { message: saved.message } };
        }
        newKeys = true;
      } else if (!names.every(name => fs.existsSync(path.join(BOX_KEYS, variables[name])))) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ");
        return { status: 400, value: { message: `${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.` } };
      }
    }
    // One there already is written again as it is (the engine reads its keys again).
    const value = added ? valueAt(settings, [...SERVERS, entry.id]) : entry.settings;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value }]);
    if (changed.status !== 200) return { status: changed.status, value: { message: changed.message } };
    // The engine reads its keys as it reads its settings again: its server connects again a
    // moment later, with the new ones, as Settings does it.
    if (newKeys && engine) {
      later(() => call(engine, "POST", `/api/experimental/mcp/${encodeURIComponent(entry.id)}/connect`).catch(() => {}), 2_000);
    }
    const [listed] = await integrationEntries([entry], engine, signal);
    return { status: 200, value: { integration: listed } };
  }
  if (method === "DELETE") {
    if (!added) return { status: 404, value: {} };
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
    for (const variable of Object.values(entry.variables ?? {})) setBoxKey(variable, null);
    for (const name of [entry.id, `${entry.id}.json`]) fs.rmSync(path.join(INTEGRATION_DATA, name), { recursive: true, force: true });
    dropBotsIntegration(entry);
    return { status: 200, value: {} };
  }
  return { status: 405, value: {} };
}

// MARK: Bots' own keys (PROTOCOL.md, "Bots' own keys"): keys a bot here has of its own for the
// integrations you bring a key for, kept on this machine (`box/bot-keys/<variable>__<BOT>`) and named by a
// settings file of its folder's own, so only its conversation uses them. A bot that works in a
// project uses that project's.

/** A bot's own variable for one of an integration's, as the Mac's IntegrationKeys names it. */
export const botVariable = (variable, bot) => `${variable}__${String(bot).toUpperCase().replace(/[^\p{L}\p{N}]/gu, "_")}`;

/** The integrations a bot can have keys of its own for: those you bring a key for. */
const botKeyed = catalog => catalog.filter(entry => ["token", "package"].includes(entry.way) && entry.settings && Object.keys(entry.variables ?? {}).length);

/** Whether `bot` has every key of its own for `entry`. */
const hasOwnKeys = (bot, entry) => Object.values(entry.variables).every(variable => fs.existsSync(path.join(BOT_KEYS, botVariable(variable, bot))));

/** `entry`'s server as `bot`'s conversation runs it: its own keys in place of the shared ones. */
function botServer(entry, bot) {
  let text = JSON.stringify(entry.settings);
  for (const variable of Object.values(entry.variables)) text = text.split(`/box/keys/${variable}}`).join(`/box/bot-keys/${botVariable(variable, bot)}}`);
  return JSON.parse(text);
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

/** Its folder's settings naming a server for each integration it has its own keys for, and no
 * longer one for those it had them for; the rest of the file as it was (the Mac's BotKeys.change). */
function writeBotSettings(bot, catalog) {
  const { folder, file, settings: old, problem } = botSettings(bot);
  if (problem) return { status: 409, message: problem };
  const suffix = botVariable("", bot);
  const usesOwn = server => (JSON.stringify(server).match(/KUVO_KEY_[A-Z0-9_]+/g) ?? []).some(name => name.endsWith(suffix));
  const servers = Object.fromEntries(Object.entries(old.mcp?.servers ?? {}).filter(([, server]) => !usesOwn(server)));
  for (const entry of botKeyed(catalog)) if (hasOwnKeys(bot, entry)) servers[entry.id] = botServer(entry, bot);
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

/** Each bot here: its folder's settings as its keys and this machine's integrations are now (a
 * server's newer version, say, or settings that came with it from another computer naming its
 * keys there). As the bridge starts, and from a Mac. */
export function refreshBotsKeys(file = INTEGRATIONS_FILE) {
  const catalog = integrationCatalog(file);
  for (const bot of listOf(BOTS)) {
    const here = botHere(bot);
    if (here && !here.described.project) writeBotSettings(bot, catalog);
  }
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

/** `kuvo/bots/<id>/keys…`, for a bot that lives on this machine. `later` runs what waits a moment (a test's own). */
export async function answerBotKeys(method, requestPath, body, engine, file = INTEGRATIONS_FILE, later = soon) {
  const parts = requestPath.split("?")[0].split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  const message = text => ({ message: text });
  const bot = parts[2];
  const here = botHere(bot);
  if (!here) return { status: 404, value: message("That bot isn't on this machine.") };
  if (here.described.project) return { status: 409, value: message(`${here.described.name} works in a project, so it uses the keys that project's sessions use.`) };
  const catalog = integrationCatalog(file);
  const keyed = botKeyed(catalog);
  const shared = entry => Object.values(entry.variables).every(variable => fs.existsSync(path.join(BOX_KEYS, variable)));
  const drop = entries => {
    for (const entry of entries) for (const variable of Object.values(entry.variables)) fs.rmSync(path.join(BOT_KEYS, botVariable(variable, bot)), { force: true });
  };
  if (parts.length === 4) {
    // Each with what Edit Bot shows of it: its name, symbol, the keys it takes and where to get them.
    if (method === "GET") return { status: 200, value: { keys: keyed.map(entry => ({ integration: entry.id, own: hasOwnKeys(bot, entry), shared: shared(entry),
      title: entry.title, symbol: entry.symbol, keys: (entry.keys ?? []).map(({ name, label, prompt }) => ({ name, label, prompt })), ...(entry.help ? { help: entry.help } : {}) })) } };
    if (method !== "DELETE") return { status: 405, value: {} };
    // All of them, as it leaves this machine: what it moved with goes with it.
    const had = keyed.filter(entry => hasOwnKeys(bot, entry));
    drop(keyed);
    for (const name of listOf(BOT_KEYS)) if (name.startsWith("KUVO_KEY_") && name.endsWith(botVariable("", bot))) fs.rmSync(path.join(BOT_KEYS, name), { force: true });
    const written = writeBotSettings(bot, catalog);
    for (const entry of had) reconnectForBot(engine, entry.id, bot, later);
    return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
  }
  if (parts.length !== 5) return { status: 404, value: {} };
  const entry = keyed.find(each => each.id === parts[4]);
  if (!entry) return { status: 404, value: message("A bot can't have a key of its own for that here.") };
  const names = Object.keys(entry.variables);
  switch (method) {
    case "GET": {
      if (!hasOwnKeys(bot, entry)) return { status: 404, value: {} };
      return { status: 200, value: { keys: Object.fromEntries(names.map(name => [name, textOf(path.join(BOT_KEYS, botVariable(entry.variables[name], bot))) ?? ""])) } };
    }
    case "PUT": {
      const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
      if (!names.every(name => typeof given[name] === "string" && given[name].trim())) {
        const labels = (entry.keys ?? []).map(key => key.label).join(" and ") || names.join(" and ");
        return { status: 400, value: message(`${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.`) };
      }
      // Its folder's settings are checked first: none are written where they can't be named.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      fs.mkdirSync(BOT_KEYS, { recursive: true, mode: 0o700 });
      for (const name of names) writePrivate(path.join(BOT_KEYS, botVariable(entry.variables[name], bot)), given[name].trim());
      writeBotSettings(bot, catalog);
      reconnectForBot(engine, entry.id, bot, later);
      return { status: 200, value: { integration: entry.id, own: true, shared: shared(entry) } };
    }
    case "DELETE": {
      if (!hasOwnKeys(bot, entry)) return { status: 404, value: {} };
      // Its folder's settings are checked first: its key stays while they can't say it's gone.
      const { problem } = botSettings(bot);
      if (problem) return { status: 409, value: message(problem) };
      drop([entry]);
      const written = writeBotSettings(bot, catalog);
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

/** The list as `change` makes it, read again just before: a phone's request and a Mac's run
 * beside each other, each in a process of its own. */
function updateWorktrees(change) {
  writePrivate(WORKTREES_FILE, JSON.stringify({ worktrees: change(readWorktrees()) }, null, 2));
}

/** `name`, or `name-2` and so on when that's a branch already, as the Mac's Git.newBranch picks. */
function freeBranch(folder, name) {
  for (let suffix = 1; suffix <= 20; suffix++) {
    const candidate = suffix === 1 ? name : `${name}-${suffix}`;
    if (gitIn(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) === null) return candidate;
  }
  return null;
}

/** A branch name made from a title, as the Mac's Git.slug makes it: "Trim note titles" is
 * trim-note-titles, "Giriş düzeltmesi" giris-duzeltmesi. */
export function branchSlug(title, limit = 40) {
  const latin = String(title).normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i").toLowerCase();
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
    const prefix = typeof body?.branchPrefix === "string" ? body.branchPrefix : "kuvo/";
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
    const tree = { project, root, folder: subpath ? path.join(root, subpath.replace(/\/$/, "")) : root, branch, ...(base ? { base } : {}), made: branch, prefix };
    updateWorktrees(list => [...list.filter(each => each.root !== root), tree]);
    return { status: 200, value: tree };
  }
  if (route === "kuvo/worktrees/record") {
    // One a Mac made here before this box kept them: kept here from now on, if it's still here
    // (one removed since, from a phone, say, doesn't come back).
    const given = { project: body?.project, root: body?.root, folder: typeof body?.folder === "string" ? body.folder : body?.root, branch: body?.branch, ...(typeof body?.base === "string" ? { base: body.base } : {}) };
    const absolute = folder => typeof folder === "string" && path.isAbsolute(folder);
    if (!absolute(given.project) || !absolute(given.root) || !absolute(given.folder) || typeof given.branch !== "string" || !given.branch) return { status: 400, value: message("Send {project, root, folder?, branch, base?}.") };
    if (!fs.existsSync(given.root)) return { status: 404, value: message("That worktree isn't on this machine any more.") };
    updateWorktrees(list => [...list.filter(each => each.root !== given.root), given]);
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
    updateWorktrees(list => list.filter(each => each.root !== tree.root));
    return { status: 200, value: {} };
  }
  return { status: 404, value: {} };
}

// MARK: Skills (PROTOCOL.md, "Skills"), as the Mac's SkillsPlace and SkillLibrary have them.

const SKILLS = path.join(K, "config", "opencode", "skills");
const SKILL_SOURCE = ".kuvo-source.json";
// GitHub, or a test's stand-in for it, in a test's folder only (never a machine's own).
const testGitHub = path.resolve(K) !== path.join(os.homedir(), ".kuvo-code") ? process.env.KUVO_TEST_GITHUB : undefined;
const GITHUB = { api: testGitHub ?? "https://api.github.com", raw: testGitHub ?? "https://raw.githubusercontent.com" };
// The well-known collections, as the Mac lists them (SkillLibrary.repositories).
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

/** A skill's name from what's typed, as the Mac's SkillFile.name makes it. */
export function skillName(text) {
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).map(word => [...word].filter(c => c.charCodeAt(0) < 128).join("")).filter(Boolean);
  return words.join("-").slice(0, 64).replace(/-+$/, "");
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
  if (typeof info?.default_branch !== "string") throw new SkillFailure(404, `${owner}/${name} wasn't found on GitHub.`);
  const repository = { id: `${owner}/${name}`, owner, name, title: `${owner}/${name}`, summary: info.description ?? "", branch: info.default_branch };
  if (lookedUp.size > 50) lookedUp.clear();
  lookedUp.set(key, { repository, at: Date.now() });
  return repository;
}

/** The names of the skills the engine lists (its own, and those in other tools' folders), which a
 * new one mustn't take; none when it doesn't answer. */
async function engineSkillNames(engine) {
  if (!engine?.port) return [];
  try {
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/skill`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5_000),
    });
    const listed = response.ok ? (await response.json())?.data : null;
    return Array.isArray(listed) ? listed.map(skill => skill?.id).filter(id => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** A repository's skills, from its file list, as SkillLibrary.skills(in:) reads it. */
export async function skillsIn(repository) {
  const response = await github(`${GITHUB.api}/repos/${repository.owner}/${repository.name}/git/trees/${repository.branch}?recursive=1`);
  if (response.status !== 200) throw new SkillFailure(404, `${repository.id} wasn't found on GitHub.`);
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

const rawURL = (repository, file) => `${GITHUB.raw}/${repository.owner}/${repository.name}/${repository.branch}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** The front matter's name and description, as SkillLibrary.about(markdown:) reads them. */
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
      if (response.status !== 200) throw new SkillFailure(404, `${file} wasn't found on GitHub.`);
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

/** `kuvo/skills…` and `kuvo/skill-library…`, for this machine's own folder. */
export async function answerSkills(method, requestPath, body, engine = null) {
  const [route, query = ""] = requestPath.split("?");
  const parts = route.split("/").map(part => { try { return decodeURIComponent(part); } catch { return null; } });
  if (parts.includes(null)) return { status: 400, value: { message: "That isn't a path." } };
  const message = text => ({ message: text });
  try {
    if (parts[1] === "skills" && parts.length === 2) {
      if (method !== "GET") return { status: 405, value: {} };
      return { status: 200, value: { folder: SKILLS, github: skillSources() } };
    }
    if (parts[1] === "skills" && parts.length === 3) {
      const name = parts[2];
      if (!isSkillFolder(name)) return { status: 400, value: message("That isn't a skill's name.") };
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
          if (fs.existsSync(folder) || (await engineSkillNames(engine)).includes(name)) return { status: 409, value: message(`There's a skill called ${name} already.`) };
        } else if (!fs.existsSync(folder)) {
          return { status: 404, value: {} };
        } else if (skillSources()[name]) {
          // As Settings has it: one from GitHub is as it came, not edited.
          return { status: 409, value: message(`${name} came from GitHub, so it isn't edited here.`) };
        }
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(`${file}.new`, text);
        fs.renameSync(`${file}.new`, file);
        return { status: 200, value: {} };
      }
      if (method === "DELETE") {
        if (!fs.existsSync(folder)) return { status: 404, value: {} };
        // To Kuvo Code's own trash, kept 30 days, as the Mac puts a machine's away.
        const trash = path.join(K, "trash", "skills");
        fs.mkdirSync(trash, { recursive: true });
        const away = path.join(trash, `${name}-${Math.floor(Date.now() / 1000)}`);
        fs.renameSync(folder, away);
        // Dated now: moving it kept its own date, and an old one would go at once.
        const now = new Date();
        fs.utimesSync(away, now, now);
        const old = Date.now() - 30 * 86_400_000;
        for (const each of listOf(trash)) try { if (fs.statSync(path.join(trash, each)).mtimeMs < old) fs.rmSync(path.join(trash, each), { recursive: true, force: true }); } catch {}
        return { status: 200, value: {} };
      }
      return { status: 405, value: {} };
    }
    if (parts[1] === "skill-library") {
      if (parts.length === 2 && method === "GET") return { status: 200, value: { repositories: SKILL_REPOSITORIES.map(({ branch, ...shown }) => shown) } };
      if (parts.length === 3 && parts[2] === "install" && method === "POST") {
        const [owner, name] = String(body?.repository ?? "").split("/");
        if (!owner || !name || typeof body?.path !== "string") return { status: 400, value: message('Send {"repository": "owner/name", "path": …}.') };
        const repository = await skillRepository(owner, name);
        const skill = (await skillsIn(repository)).skills.find(each => each.path === body.path);
        if (!skill) return { status: 404, value: message(`There's no skill at ${body.path} in ${repository.id}.`) };
        await installSkill(repository, skill);
        return { status: 200, value: { name: skill.name } };
      }
      if (parts.length === 4 && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        const { skills, partial } = await skillsIn(repository);
        const { branch, ...shown } = repository;
        return { status: 200, value: { repository: shown, skills, partial } };
      }
      if (parts.length === 5 && parts[4] === "about" && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        // As written: a "+" is a plus, as the Mac reads it.
        const pair = query.split("&").find(each => each.startsWith("path="));
        let at = "";
        try { at = pair ? decodeURIComponent(pair.slice(5)) : ""; } catch { return { status: 400, value: message("That isn't a path.") }; }
        const response = await github(rawURL(repository, at ? `${at}/SKILL.md` : "SKILL.md"), false).catch(() => null);
        return { status: 200, value: response?.status === 200 ? skillAbout(await response.text()) : {} };
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
    // A phone using this machine, whatever it asks.
    phoneHere();
    // Which route answers, by its path alone: a query string never changes it (as on a Mac).
    const route = request.path.split("?")[0];
    if (route === "kuvo/info") {
      let engine = {};
      try { engine = readEngine(); } catch {}
      // When the engine running now came up, in seconds since 1970 (each start writes its record):
      // a restart changes it.
      let started = null;
      if (engine.pid) try { started = fs.statSync(ENGINE_FILE).mtimeMs / 1000; } catch {}
      // Whether it runs now, and whether it's stopped on purpose (until it's started, from anywhere).
      const running = Boolean(engine.pid && runs(engine.pid, `${K}/engine/`));
      const stopped = fs.existsSync(path.join(RUN, "stopped"));
      // Its folder of chats (conversations of no project), as a Mac names its own: made if it isn't
      // there yet, so a phone can start the first one.
      const chats = path.join(K, "chats");
      try { fs.mkdirSync(chats, { recursive: true }); } catch {}
      yield { head: { status: 200, headers: { "content-type": "application/json" } } };
      yield { body: Buffer.from(JSON.stringify({ kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents: Boolean(bridge()), chats, ...info })) };
      return;
    }
    const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
    if (route === "kuvo/file") return yield* fileAt(request.path, json);
    // This box's updates (PROTOCOL.md, "Updates"): how it stands, Update Now. It always updates
    // by itself: there's no switch.
    if (route === "kuvo/update") {
      const method = request.method.toUpperCase();
      if (method === "GET") return yield* json(200, updateStatus());
      if (method === "PATCH") return yield* json(400, { message: ALWAYS_UPDATES });
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
    // Settings › Skills (PROTOCOL.md, "Skills"): this machine's own skills folder, and GitHub's
    // collections, which this machine reaches itself, with the Mac closed too.
    if (/^kuvo\/(skills|skill-library)(\/|\?|$)/.test(request.path)) {
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
      const answered = ({ status, settings, message }) => json(status, message ? { message } : settings ?? {});
      if (route === "kuvo/config") {
        if (method === "GET") {
          const { settings, problem } = readSettings();
          return yield* (problem ? json(409, { message: `The engine's settings file can't be changed from here: ${problem}` }) : json(200, settings));
        }
        if (method === "PATCH") return yield* answered(changeSettings(parsed(request.body)?.changes));
        return yield* json(405, {});
      }
      if (route === "kuvo/mcp/catalog") {
        if (method !== "GET") return yield* json(405, {});
        return yield* json(200, mcpCatalog(readSettings().settings ?? {}));
      }
      const adding = route.match(/^kuvo\/mcp\/catalog\/([^/]+)$/);
      if (adding && method === "POST") return yield* answered(addFromCatalog(decodeURIComponent(adding[1])));
      if (route === "kuvo/keys") return yield* (method === "GET" ? json(200, { keys: boxKeyNames() }) : json(405, {}));
      const key = route.match(/^kuvo\/keys\/([^/]+)$/);
      if (key) {
        let name = "";
        try { name = decodeURIComponent(key[1]); } catch {}
        if (!/^KUVO_KEY_[A-Za-z0-9_]+$/.test(name) || name.includes("__")) return yield* json(400, { message: "That isn't a key's name." });
        if (method === "GET") {
          const value = boxKey(name);
          return yield* (value == null ? json(404, {}) : json(200, { value }));
        }
        if (method === "PUT") {
          const value = parsed(request.body)?.value;
          if (typeof value !== "string" || !value) return yield* json(400, { message: "Send {\"value\": \"…\"}." });
          return yield* answered(setBoxKey(name, value));
        }
        if (method === "DELETE") return yield* answered(setBoxKey(name, null));
        return yield* json(405, {});
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
      const changed = updateLink(link => link && removePhones(link, phone?.key?.toString("base64url"), given?.phones) ? link : null);
      if (!changed) return yield* json(400, { message: "Only phones paired here can be removed, and never your Mac." });
      // Once this answer is on its way: a phone that removed itself gets it too.
      setTimeout(() => phonesChanged(readLink() ?? changed), 200);
      return yield* json(200, {});
    }
    // A link for another phone to pair with this machine, as `kuvo-link.js pair` shows one: good
    // once, for a while; a new one takes the place of the last. DELETE ends it.
    if (route === "kuvo/phones/pair") {
      const method = request.method.toUpperCase();
      if (method === "DELETE") {
        updateLink(link => {
          if (!link?.pairing) return null;
          delete link.pairing;
          return link;
        });
        return yield* json(200, {});
      }
      if (method !== "POST") return yield* json(405, {});
      const link = updateLink(current => current?.relay ? { ...current, pairing: newPairingToken() } : null);
      if (!link) return yield* json(409, { message: "This machine has no relay to pair through." });
      return yield* json(200, { link: pairingLink(link), ends: Math.floor(link.pairing.expires / 1000) });
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
      hold.attend(`phone:${phone?.key?.toString("base64url") ?? ""}`, given);
      return yield* json(200, { for: given.seconds });
    }
    // Who `&` can name in a message here, as a Mac's composer offers them: this machine's bots and
    // latest sessions (`machine` null), then those its other computers told it of.
    if (route === "kuvo/named") {
      if (request.method.toUpperCase() !== "GET") return yield* json(405, {});
      const link = readLink();
      const own = (await ownAgents(readEngine, link?.id).catch(() => null)) ?? [];
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
      return yield* forward(target, path, request, signal, agentsAllowed);
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
      if (!kit) return yield* json(409, { message: "Connect to this machine from your Mac once, then try again." });
      return yield* json(200, botTemplates(kit, info.name));
    }
    if (request.method.toUpperCase() === "POST" && route === "kuvo/bots") {
      const { status, value } = await makeBot(parsed(request.body), readEngine, bridge, info.name, signal);
      return yield* json(status, value);
    }
    // Settings › Worktrees, and a new session's worktree (PROTOCOL.md, "Worktrees").
    if (/^kuvo\/worktrees(\/(remove|rename|record))?$/.test(route)) {
      let engine = null;
      try { engine = readEngine(); } catch {}
      const { status, value } = await answerWorktrees(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
      return yield* json(status, value);
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
    if (request.method.toUpperCase() === "POST" && route === "kuvo/groups") {
      const target = bridge();
      if (!target) return yield* json(503, { message: "Group chats run with the coding agents' bridge, which isn't running on this machine." });
      const { status, value } = await makeGroup(parsed(request.body), target, signal);
      return yield* json(status, value);
    }
    // The group chats that live here, as the Mac answers its own (`kuvo/groups`), from the
    // coding agents' bridge, which runs them.
    const group = route.match(GROUP_ROUTE);
    if (group) {
      const target = bridge();
      if (!target) {
        yield { head: { status: 503, headers: { "content-type": "application/json" } } };
        yield { body: Buffer.from(JSON.stringify({ message: "Group chats run with the coding agents' bridge, which isn't running on this machine." })) };
        return;
      }
      return yield* answerGroups(target, group[1], group[2], request, signal);
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
    const wakes = route.match(/^kuvo\/wakes\/([^/]+)(?:\/(cancel|now|pause))?$/);
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
    let engine;
    try {
      engine = readEngine();
    } catch {
      return yield* text(503, "The engine isn't running.");
    }
    if (stop) {
      if (request.method.toUpperCase() !== "POST") return yield* text(405, "Stop it with POST.");
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
      const given = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
      for (const name of REQUEST_HEADERS) if (given[name]) headers[name] = given[name];
      return yield* stopShell(decodeURIComponent(stop[1]), engine, headers, signal);
    }
    return yield* forward(engine, request.path, request, signal, allowed);
  };
}

// The engine here started, stopped or started over by the box's own tool (`bin/kuvo-start`, as
// the Mac has it do): `start` after a stop, `stop` until it's started again (from anywhere), and
// `restart`. This bridge stays up through each. A start or restart is answered at once (202), and
// the phone sees it come up as `kuvo/info` says (`running`, `started`); a stop once it's done.
export async function engineControl(command) {
  const start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return { status: 409, message: "Kuvo Code hasn't set this machine up yet." };
  // Started from a Mac once, which keeps how (`run/launch.env`) and what starts it (`bin/kuvo-launch`).
  if (command !== "stop" && ![path.join(K, "bin", "kuvo-launch"), path.join(RUN, "launch.env")].every(file => fs.existsSync(file))) {
    return { status: 409, message: "Start it once from Kuvo Code on your Mac." };
  }
  // Not with what runs this bridge (the engine's runtime as Bun), which would make `opencode
  // serve` a script to look for.
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const workspace = path.join(K, "workspace");
  const options = { cwd: fs.existsSync(workspace) ? workspace : K, env: environment };
  if (command === "stop") {
    // Answered once it's down; one that takes over a minute (a start under way, which it waits
    // for) goes on by itself, never cut off halfway.
    let child;
    try {
      child = spawn("sh", [start, "stop"], { ...options, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      return { status: 503, message: "It couldn't be stopped." };
    }
    let said = "";
    child.stderr.on("data", data => { said += data; });
    const status = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 60_000);
      child.on("exit", code => { clearTimeout(timer); resolve(code); });
      child.on("error", () => { clearTimeout(timer); resolve(-1); });
    });
    if (status === null) {
      child.stderr.destroy();
      child.unref();
      return { status: 202 };
    }
    return status === 0 ? { status: 200 } : { status: 503, message: said.trim() || "It couldn't be stopped." };
  }
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

// Stops a command the engine runs for an agent: SIGTERM to its process group, here on the
// machine, so the engine sees it end and tells the agent, with what it printed. The engine's own
// remove deletes the output too, and the agent hears the command was never found, so it's only
// for when the signal can't be sent.
async function* stopShell(id, engine, headers, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const url = `http://127.0.0.1:${engine.port}/api/shell/${encodeURIComponent(id)}`;
  let job;
  try {
    const response = await fetch(url, { headers, signal });
    if (response.ok) job = (await response.json()).data;
  } catch {}
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

// When a phone last used this machine, in `run/link.seen`: while one has in the last week, the
// engine stays up for it (the bridge's timer, and the Mac leaving it running as it quits), so the
// machine's sessions and bots are there whenever it asks; a phone lost or unpaired elsewhere
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
const BOTS = path.join(K, "bots");
const SESSION_WAKES = path.join(K, "wakes");
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

// A folder's waiting wake-ups (soonest first), its watches, and whether you paused them.
export function readWakes(folder) {
  const wakes = listOf(path.join(folder, "wakes"))
    .map(name => wakeOf(name, oneLine(textOf(path.join(folder, "wakes", name)) ?? "", 400)))
    .filter(Boolean)
    .sort((a, b) => a.due - b.due);
  const watches = listOf(path.join(folder, "watches")).sort().map(letters => {
    const at = path.join(folder, "watches", letters);
    const check = textOf(path.join(at, "check")) ?? "";
    if (!check) return null;
    return { letters, every: (textOf(path.join(at, "every")) ?? "").trim(), check: oneLine(check, 300), note: oneLine(textOf(path.join(at, "note")) ?? "", 400) };
  }).filter(Boolean);
  return { wakes, watches, paused: fs.existsSync(path.join(folder, "paused")) };
}

// ---- Group chats that live here ----

// What a phone asks of them, as of a Mac's: the list and one chat (read, or followed as they
// change), and what it does in one (writes to it, stops it, lets it keep going, looks at it, takes
// a message back, starts the work a wrap-up split up).
const GROUP_ROUTE = /^kuvo\/groups(?:\/(grp_[a-z0-9]+))?(?:\/(events|stop|keep-going|viewed|undo|start))?$/;

// Times as the Mac sends them to a phone: seconds since 1970.
const seconds = text => {
  const time = Date.parse(text ?? "");
  return Number.isFinite(time) ? time / 1000 : undefined;
};

// A message as the Mac sends it: its times in seconds, without the block naming agents (the
// machine's own record of who you named) nor, in a list, what each bot did on its turn.
export function phoneMessage(message, withSteps = true) {
  if (!message) return undefined;
  const { named: _, steps, time, tasks, ...rest } = message;
  const out = { ...rest, time: seconds(time) };
  if (withSteps && steps) out.steps = steps;
  if (tasks) out.tasks = tasks.map(({ started, finished, ...task }) => ({ ...task, ...(started ? { started: seconds(started) } : {}), ...(finished ? { finished: seconds(finished) } : {}) }));
  return out;
}

// A chat's bot as the Mac lists it: who it is, how it looks, its own conversation and folder.
function groupMember(id) {
  if (!/^bot_[A-Za-z0-9]+$/.test(id)) return null;
  const folder = path.join(BOTS, id);
  let described;
  try {
    described = JSON.parse(textOf(path.join(folder, "bot.json")) ?? "");
  } catch {
    return null;
  }
  const session = (textOf(path.join(folder, "session")) ?? "").trim();
  if (!described?.name || !session) return null;
  return {
    id, name: described.name, look: described.look, session,
    directory: (textOf(path.join(folder, "directory")) ?? "").trim() || path.join(folder, "workspace"),
    agents: (textOf(path.join(folder, "via")) ?? "").trim() === "bridge",
  };
}

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

// The list, as the Mac's `kuvo/groups` has it; null when none run here. Throws when the bridge
// couldn't be asked (it's there, but not answering now).
export async function groupsList(target, signal) {
  const { status, value } = await askGroups(target, "GET", "", undefined, signal);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`The coding agents' bridge answered ${status}.`);
  const groups = (value.data ?? []).filter(chat => chat.status === "active").map(({ group, state, said, fromBot }) => {
    const meeting = group.meeting ? { ...group.meeting, next: seconds(group.meeting.next) } : undefined;
    return {
      id: group.id, name: group.name, purpose: group.purpose, members: group.members.map(groupMember).filter(Boolean),
      speaking: state?.speaking, discussing: Boolean(state?.discussing), paused: Boolean(state?.paused),
      unread: Boolean(fromBot && (!group.viewed || Date.parse(fromBot.time) > Date.parse(group.viewed))),
      last: phoneMessage(said, false), meeting,
    };
  });
  return { groups };
}

// One chat, as the Mac's `kuvo/groups/<id>/events` sends it; null once it's gone (or moving).
// Throws when the bridge couldn't be asked.
export async function groupChat(target, id, signal) {
  const { status, value } = await askGroups(target, "GET", `/${id}`, undefined, signal);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`The coding agents' bridge answered ${status}.`);
  if (value.data?.status !== "active") return null;
  const { messages, state } = value.data;
  return {
    messages: messages.slice(-300).map(message => phoneMessage(message)), speaking: state?.speaking, discussing: Boolean(state?.discussing), paused: Boolean(state?.paused),
    ...(state?.activity?.length ? { activity: state.activity } : {}),
  };
}

async function* answerGroups(target, id, action, request, signal) {
  const method = request.method.toUpperCase();
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  // Read, or followed: a line of JSON each time it changes, as a Mac's.
  if (method === "GET" && (!action || action === "events")) {
    const read = () => (id ? groupChat(target, id, signal) : groupsList(target, signal));
    let now;
    try {
      now = await read();
    } catch {
      // There, but not answering now: asked again later, not taken as having none.
      return yield* json(503, {});
    }
    if (!now) return yield* json(404, {});
    if (!action) return yield* json(200, now);
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    // One chat's lines leave out its messages when they're as they were (who's talking, or
    // what they're doing, changed): the phone keeps the ones it has.
    let last = "";
    let lastMessages = null;
    while (!signal?.aborted && now) {
      const line = JSON.stringify(now);
      if (line !== last) {
        const messages = id ? JSON.stringify(now.messages) : null;
        const { messages: _, ...state } = now;
        yield { body: Buffer.from((id && messages === lastMessages ? JSON.stringify(state) : line) + "\n") };
        last = line;
        lastMessages = messages;
      }
      await new Promise(done => setTimeout(done, 1000));
      if (signal?.aborted) break;
      now = await read().catch(() => now);
    }
    return;
  }
  // Its name, purpose, bots or meeting changed, as Edit Group Chat changes them: a meeting
  // as you set it up, worked out by the bridge that runs it, on your clock.
  if (method === "PATCH" && id && !action) {
    const given = parsed(request.body);
    if (!isObject(given)) return yield* json(400, { message: "That isn’t a change to a group chat." });
    const edits = {};
    if ("name" in given) {
      const name = plainName(given.name);
      if (!name) return yield* json(400, { message: "A group chat needs a name." });
      edits.name = name;
    }
    if ("purpose" in given) edits.purpose = typeof given.purpose === "string" && given.purpose.trim() ? given.purpose.trim() : null;
    if ("members" in given) {
      if (!Array.isArray(given.members) || !given.members.every(each => typeof each === "string")) return yield* json(400, { message: "Those aren’t bots." });
      const members = [...new Set(given.members)];
      if (members.length < 2) return yield* json(400, { message: "A group chat needs at least two bots." });
      const here = new Set(listBots().map(bot => bot.id));
      const missing = members.find(member => !here.has(member));
      if (missing) return yield* json(404, { message: `There’s no bot “${missing}”.` });
      edits.members = members;
    }
    if ("meeting" in given) edits.meetingPlan = given.meeting;
    const asked = await askGroups(target, "PATCH", `/${id}`, edits, signal).catch(error => ({ status: 503, value: { message: String(error?.message ?? error) } }));
    if (asked.status !== 200) return yield* json(asked.status === 400 || asked.status === 404 || asked.status === 409 ? asked.status : 503, { message: asked.value?.message ?? "The group chat couldn’t be changed." });
    const listed = await groupsList(target, signal).catch(() => null);
    return yield* json(200, { group: listed?.groups.find(each => each.id === id) ?? null });
  }
  // Deleted, as Delete Group Chat deletes it: its messages and seats go, and its bots forget it.
  // Not one moving, which the bridge refuses; one gone already is as good as deleted.
  if (method === "DELETE" && id && !action) {
    const { status, value } = await askGroups(target, "DELETE", `/${id}`, undefined, signal).catch(() => ({ status: 503 }));
    if (status === 200 || (status === 404 && value?.message === "No such chat.")) return yield* json(200, {});
    if (status === 409) return yield* json(409, { message: "That chat is moving. Try again once it’s there." });
    return yield* json(503, { message: value?.message ?? "The coding agents’ bridge here isn’t answering. Try again in a moment." });
  }
  if (method !== "POST" || !id || action === "events") return yield* json(405, {});
  let given = {};
  try {
    given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}");
  } catch {}
  let asked;
  switch (action) {
    case undefined:
      if (typeof given.text !== "string" || !given.text.trim()) return yield* json(400, {});
      asked = await askGroups(target, "POST", `/${id}/send`, { text: given.text }, signal);
      break;
    case "stop":
    case "keep-going":
      asked = await askGroups(target, "POST", `/${id}/${action}`, {}, signal);
      break;
    case "viewed":
      asked = await askGroups(target, "PATCH", `/${id}`, { viewed: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }, signal);
      break;
    case "undo": {
      if (typeof given.message !== "string") return yield* json(404, {});
      asked = await askGroups(target, "POST", `/${id}/undo`, { message: given.message }, signal);
      // Moving: 409, as for what you write.
      if (asked.status !== 200) return yield* json(failed(asked.status), {});
      return yield* json(200, { text: asked.value.data?.text ?? "" });
    }
    case "start":
      if (typeof given.message !== "string") return yield* json(404, {});
      asked = await askGroups(target, "POST", `/${id}/start-work`, { wrapUp: given.message }, signal);
      break;
  }
  return yield* json(asked.status === 200 ? 200 : failed(asked.status), {});
}

// What a phone hears of a group chat's action the coding agents' bridge didn't take: moving (409),
// there but not answering now (503: ask again), or no such chat or message (404).
const failed = status => (status === 409 ? 409 : status >= 500 ? 503 : 404);

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
  yield { head: { status: 200, headers: { "content-type": type, "content-length": String(stat.size) } } };
  // In pieces, as the engine's bodies go.
  for await (const piece of fs.createReadStream(file, { highWaterMark: 32 * 1024 })) yield { body: piece };
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
    bots.push({
      created: String(described.created ?? ""),
      bot: {
        id,
        session,
        name: described.name,
        look: described.look,
        machine: machine || undefined,
        job: typeof described.job === "string" ? described.job : "",
        paused,
        wakes: wakes.length ? Math.min(...wakes.map(wake => wake.due)) : undefined,
        watching: watches.length,
        agents,
        personality: typeof described.personality === "string" ? described.personality : undefined,
        model: isModel(described.model) ? described.model : undefined,
        memoryJob: memory ? memoryJob(folder) : undefined,
      },
    });
  }
  // In the order they were made, as the Mac's list is.
  return bots.sort((a, b) => a.created.localeCompare(b.created)).map(entry => entry.bot);
}

// A bot's job as its memory has it now: `{line, section}`, both empty for a memory without one;
// undefined when its memory can't be read.
function memoryJob(folder) {
  const text = textOf(path.join(folder, "MEMORY.md"));
  if (typeof text !== "string") return undefined;
  const job = jobInMemory(text);
  return { line: job?.line ?? "", section: job?.section ?? "" };
}

// ---- Bots and group chats made here ----

// What New Bot needs here, which the Mac gives the machine as it connects (Bots.MachineKit).
const KIT_FILE = path.join(BOTS, "kit.json");
// The coding agents' providers (the Mac's OutsideAgents): a bot on one of theirs runs with them.
const AGENT_PROVIDERS = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"];
const runsWithAgents = model => model?.providerID === "auto" || AGENT_PROVIDERS.includes(String(model?.providerID ?? "").split("@")[0]);

// What this box's release brought to make bots with (BoxRelease): its words, with ⟦machine⟧ and
// ⟦timeZone⟧ to fill in, and nothing that's a machine's own.
const RELEASE_KIT_FILE = path.join(K, "bin", "bot-kit.json");

// What this machine makes bots with: what a Mac last gave it, or its release's words where those
// are newer (it updated itself since) or no Mac gave it any, with what's a machine's own from the
// Mac's (its name, your time zone, the starting model, projects and rules), or else its own.
export function readKit() {
  const read = file => {
    try {
      const kit = JSON.parse(textOf(file) ?? "");
      return kit?.kuvo === 1 && Array.isArray(kit.templates) && Array.isArray(kit.personalities) && typeof kit.instructions === "string" ? kit : null;
    } catch {
      return null;
    }
  };
  const mac = read(KIT_FILE), release = read(RELEASE_KIT_FILE);
  if (!release || (mac && !newerVersion(release.version, mac.version))) return mac;
  const machine = readLink()?.id || os.hostname();
  let timeZone = mac?.timeZone;
  if (!timeZone) try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const filled = JSON.parse(JSON.stringify(release)
    .replaceAll("⟦machine⟧", JSON.stringify(machine).slice(1, -1))
    .replaceAll("⟦timeZone⟧", JSON.stringify(timeZone || "UTC").slice(1, -1)));
  return {
    ...filled,
    // The release's presets, and the ones you made that a Mac's kit has.
    personalities: [...filled.personalities, ...(mac?.personalities ?? []).filter(each => each.custom)],
    startingModel: mac?.startingModel ?? null, projects: mac?.projects ?? [], rules: mac?.rules ?? [], timeZone: timeZone || "UTC",
    ...(mac?.zoneinfo ? { zoneinfo: mac.zoneinfo } : {}),
  };
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
    startingModel: { [machine || "machine"]: kit.startingModel ?? null },
    projects: (kit.projects ?? []).map(project => ({ ...project, machine: machine || undefined })),
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
// and its job as its memory has it (`jobInMemory`), for one that has one; null when the kit, from
// a Mac before Kuvo Code had its words for that, can't say it.
export function botInstructions(kit, name, folder, personality, project, job) {
  const working = Boolean(job?.section);
  if (working && typeof kit.jobInstructions !== "string") return null;
  let text = (working ? kit.jobInstructions : kit.instructions).replaceAll("⟦name⟧", () => name).replaceAll("⟦folder⟧", () => folder);
  text = personality ? text.replace("⟦personality⟧", () => personality) : text.replace("\n⟦personality⟧\n", "");
  if (project) text = text.replace(`\n\n${kit.identityNote}`, () => `\n\n${kit.projectNote}\n\n${kit.identityNote}`);
  if (working) text = text.replace(": ⟦job⟧", () => (job.line ? `: ${job.line}` : "")).replace("⟦jobDetails⟧", () => job.section);
  return text;
}

// A bot's job as its memory keeps it, as the Mac reads it (Bots.job(inMemory:), and the coding
// agents' bridge's jobInMemory, all held to `Agents/test/groups-vectors.json`): its line, what
// shows under its name, and its section, all of it; null for a memory without one.
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
  let line = section.split("\n").map(spaces).find(part => part.length > 0) ?? "";
  for (const mark of ["- ", "* ", "> "]) if (line.startsWith(mark)) line = line.slice(mark.length);
  line = line.replaceAll("**", "").replaceAll("__", "");
  if (line.toLowerCase().startsWith("job:")) line = line.slice(4);
  line = spaces(line);
  // Long: its first sentence. (In characters as Swift counts them, what you'd see.)
  if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].length > 48 && line.includes(". ")) line = line.slice(0, line.indexOf(". "));
  if (line.endsWith(".") && !line.endsWith("..")) line = line.slice(0, -1);
  return { line, section };
}

const fitsLook = (looks, look) => Boolean(look) && looks.colors.includes(look.color) && looks.shapes.includes(look.shape) && looks.faces.includes(look.face);

// Why a model of the engine's can't run here: its account isn't signed in here, and the engine
// would drop a message on it without a word; null when it can (or the engine doesn't say).
async function signInRefusal(model, engine, signal) {
  const ready = await call(engine, "GET", "/api/provider", undefined, signal).catch(() => undefined);
  const ids = Array.isArray(ready) ? ready.map(each => each?.id) : [];
  return ids.length && !ids.includes(model.providerID) ? `${model.id} needs a sign-in on this machine: sign in to it in Settings › Accounts, or choose another model.` : null;
}

// `POST kuvo/bots`, as the Mac's: the bot made here, its folder, conversation and instructions,
// and the template's job for your composer, or else its greeting, so it writes first.
export async function makeBot(given, readEngine, readBridge, machine, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const kit = readKit();
  if (!kit) return no(409, "Connect to this machine from your Mac once, then try again.");
  if (!given || typeof given !== "object") return no(400, "That isn’t a bot to make.");
  const name = plainName(given.name);
  if (!name) return no(400, "A bot needs a name.");
  let template;
  if (given.template !== undefined && given.template !== null) {
    template = kit.templates.find(each => each.id === given.template);
    if (!template) return no(400, `There’s no template “${given.template}”.`);
  }
  const personalityID = given.personality ?? template?.personality;
  const personality = personalityID ? botPersonalities(kit).find(each => each.id === personalityID) : undefined;
  if (personalityID && !personality) return no(400, `There’s no personality “${personalityID}”.`);
  const project = given.project ?? undefined;
  if (project !== undefined && !(kit.projects ?? []).some(each => each.directory === project)) return no(400, "That project isn’t in Kuvo Code.");
  const looks = kit.looks;
  const pick = list => list[crypto.randomInt(list.length)];
  const look = fitsLook(looks, given.look) ? given.look : template?.look ?? { color: pick(looks.colors), shape: pick(looks.shapes), face: pick(looks.faces) };
  const model = isModel(given.model) ? given.model : kit.startingModel;
  if (!model) return no(422, "There’s no model to start it on here: sign in to an account on this machine first.");
  const agents = runsWithAgents(model);
  let target;
  try {
    target = agents ? readBridge() : readEngine();
  } catch {}
  if (!target) return no(503, agents ? "The coding agents aren’t running on this machine." : "The engine isn’t running.");
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
    toldBots.set(session.id, told);
    fs.writeFileSync(path.join(folder, "session"), session.id);
    fs.writeFileSync(path.join(folder, "directory"), directory);
    if (kit.timeZone) fs.writeFileSync(path.join(folder, "timezone"), kit.timeZone);
    if (kit.zoneinfo) fs.writeFileSync(path.join(folder, "zoneinfo"), Buffer.from(kit.zoneinfo, "base64"));
    if (agents) fs.writeFileSync(path.join(folder, "via"), "bridge");
    const now = stamp();
    const described = { created: now, id, job: "", kuvo: DESCRIPTION, look, model, name, ...(personality ? { personality: personality.id } : {}), ...(project ? { project } : {}), updated: now };
    fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify(described, null, 2));
  } catch (error) {
    if (session?.id) await call(target, "DELETE", `/api/session/${encodeURIComponent(session.id)}`, undefined, signal).catch(() => {});
    discard();
    return no(503, `The bot couldn’t be made: ${error?.message ?? error}`);
  }
  // Without a template's job for you to send, it writes first.
  if (!template) await call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/synthetic`, { text: kit.greeting, description: "A new bot's first message" }, signal).catch(() => {});
  const bot = listBots(machine).find(each => each.id === id);
  return { status: 201, value: { bot, firstMessage: template?.firstMessage ?? null } };
}

// `PATCH kuvo/bots/<id>`, as the Mac's: a bot that lives here changed as Edit Bot changes it (its
// name, look, personality or model), in its description and in its conversation, which is told as
// the Mac tells it: the kit's words, with its job as its memory has it now. The Mac takes the
// change in as it next connects (Bots.takeIn).
// What each bot here was last told, by its conversation: told again only when it changes.
const toldBots = new Map();

// A bot's run ended: its job as its memory has it now, in its description and what it's told, as
// a Mac does when one of its own bots' runs ends (Bots.syncJob). `target` runs its conversation
// (the engine, or the coding agents' bridge).
export async function refreshBotJob(target, sessionID) {
  const here = listOf(BOTS).map(botHere).find(bot => bot?.session === sessionID);
  const kit = readKit();
  if (!here || !kit || isMoving(here.folder)) return;
  const job = jobInMemory(textOf(path.join(here.folder, "MEMORY.md")) ?? "");
  if ((job?.line ?? "") !== (here.described.job ?? "")) {
    // (Not an edit of its description's: a Mac takes its job from its memory too.)
    const file = path.join(here.folder, "bot.json");
    fs.writeFileSync(`${file}.new`, JSON.stringify({ ...here.described, job: job?.line ?? "" }, null, 2));
    fs.renameSync(`${file}.new`, file);
  }
  const personality = botPersonalities(kit).find(each => each.id === here.described.personality)?.instruction;
  const told = botInstructions(kit, here.described.name, here.folder, personality, here.described.project, job);
  if (told === null || toldBots.get(sessionID) === told) return;
  await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/kuvo.bot`, { value: told });
  toldBots.set(sessionID, told);
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
  if (!agents) return no(503, "The coding agents aren’t running on this machine.");
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
    if (integration?.metadata?.installed === false) return no(422, `${name} isn’t installed on this machine: install it in Settings › Accounts, or choose another model.`);
    if (!integration?.connections?.length) return no(422, `${name} needs a sign-in on this machine: sign in in Settings › Accounts, or choose another model.`);
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
      const personality = kit ? botPersonalities(kit).find(each => each.id === bot.described.personality)?.instruction : undefined;
      const told = kit ? botInstructions(kit, bot.described.name, bot.folder, personality, bot.described.project, jobInMemory(textOf(path.join(bot.folder, "MEMORY.md")) ?? "")) : null;
      if (told !== null && await call(agents, "PUT", `${entries}/kuvo.bot`, { value: told }).then(() => true, () => false)) toldBots.set(moved.id, told);
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
  if (!kit) return no(409, "Connect to this machine from your Mac once, then try again.");
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
  if (!target) return no(503, here.agents ? "The coding agents aren’t running on this machine." : "The engine isn’t running.");
  const renamed = changed.name !== described.name;
  const retold = renamed || changed.personality !== described.personality;
  const switched = !sameModel(changed.model, described.model);
  const looks = ["color", "shape", "face"].some(part => changed.look?.[part] !== described.look?.[part]);
  if (retold || switched || looks) {
    changed.updated = stamp();
    try {
      const file = path.join(here.folder, "bot.json");
      fs.writeFileSync(`${file}.new`, JSON.stringify(changed, null, 2));
      fs.renameSync(`${file}.new`, file);
    } catch (error) {
      return no(503, `The bot couldn’t be changed: ${error?.message ?? error}`);
    }
    // Its conversation hears of a new name, personality or model, as from Edit Bot.
    const session = encodeURIComponent(here.session);
    if (renamed) await call(target, "PATCH", `/api/session/${session}`, { title: changed.name }, signal).catch(() => {});
    if (switched && changed.model) await call(target, "POST", `/api/session/${session}/model`, { model: changed.model }, signal).catch(() => {});
    if (retold) {
      const job = jobInMemory(textOf(path.join(here.folder, "MEMORY.md")) ?? "");
      const personality = personalities.find(each => each.id === changed.personality)?.instruction;
      const told = botInstructions(kit, changed.name, here.folder, personality, described.project, job);
      if (told !== null && await call(target, "PUT", `/api/experimental/session/${session}/instructions/entries/kuvo.bot`, { value: told }, signal).then(() => true, () => false)) toldBots.set(here.session, told);
    }
  }
  return { status: 200, value: { bot: listBots(machine).find(each => each.id === id) ?? null } };
}

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
  try {
    noteDeleted(id);
    // To the trash as the Mac sends one there: a folder by when, and this process.
    const now = new Date();
    const two = number => String(number).padStart(2, "0");
    const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const trash = path.join(K, "trash", `${when}-${process.pid}`);
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(here.folder, path.join(trash, id));
  } catch (error) {
    return no(503, `The bot couldn’t be deleted: ${error?.message ?? error}`);
  }
  // Its keys of its own (`KUVO_KEY_…__<ID>`).
  const own = botVariable("", id);
  for (const name of listOf(BOT_KEYS)) {
    if (name.startsWith("KUVO_KEY_") && name.endsWith(own)) fs.rmSync(path.join(BOT_KEYS, name), { force: true });
  }
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
  return { status: 200, value: {} };
}

// `POST kuvo/groups`, as the Mac's: a group chat of this machine's bots, which lives here and runs
// in the coding agents' bridge, as the others here do.
export async function makeGroup(given, target, signal) {
  const no = (status, message) => ({ status, value: { message } });
  if (!given || typeof given !== "object") return no(400, "That isn’t a group chat to make.");
  const name = plainName(given.name);
  if (!name) return no(400, "A group chat needs a name.");
  const members = [...new Set(Array.isArray(given.members) ? given.members.filter(each => typeof each === "string") : [])];
  if (members.length < 2) return no(400, "A group chat needs at least two bots.");
  const here = new Set(listBots().map(bot => bot.id));
  const missing = members.find(member => !here.has(member));
  if (missing) return no(404, `There’s no bot “${missing}”.`);
  const purpose = typeof given.purpose === "string" && given.purpose.trim() ? given.purpose.trim() : undefined;
  const id = newID("grp_");
  const now = stamp();
  const group = { id, name, ...(purpose ? { purpose } : {}), members, seats: {}, heard: {}, created: now, viewed: now };
  const { status, value } = await askGroups(target, "PUT", `/${id}`, { group, messages: [], status: "active" }, signal).catch(error => ({ status: 503, value: { message: String(error?.message ?? error) } }));
  if (status !== 200) return no(status === 409 ? 409 : 503, value?.message ?? "The group chat couldn’t be made.");
  // Its meeting, worked out by the bridge that runs it, on your clock; one that can't be, and
  // the chat with it, doesn't stay.
  if (given.meeting !== undefined && given.meeting !== null) {
    const planned = await askGroups(target, "PATCH", `/${id}`, { meetingPlan: given.meeting }, signal).catch(error => ({ status: 503, value: { message: String(error?.message ?? error) } }));
    if (planned.status !== 200) {
      await askGroups(target, "DELETE", `/${id}`, undefined, signal).catch(() => {});
      return no(planned.status === 400 ? 400 : 503, planned.value?.message ?? "Its meeting couldn’t be set.");
    }
  }
  const listed = await groupsList(target, signal).catch(() => null);
  return { status: 201, value: { group: listed?.groups.find(each => each.id === id) ?? null } };
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
// `…/now` with {"wake"}, sent at once (one that repeats still comes back at its time).
async function* answerWakes(session, action, request, readEngine, bridge, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  let folder = wakeFolder(session);
  const listed = () => {
    if (!folder) return { wakes: [], watches: [], paused: false };
    const { wakes, watches, paused } = readWakes(folder);
    return { wakes: wakes.map(({ id, due, note, every }) => ({ id, due, note, every: every ?? undefined })), watches, paused };
  };
  if (!action && (method === "GET" || method === "HEAD")) return yield* json(200, listed());
  if (method !== "POST") return yield* json(405, {});
  let given = {};
  try {
    given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}") ?? {};
  } catch {}
  if (!action) {
    // One added as the bar over a Mac's composer adds one, with this machine's own kuvo-wake (its
    // clock, its weekends).
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
    const failed = await new Promise(resolve => execFile(path.join(K, "bin", "kuvo-wake"), [folder, "add", String(Math.floor(due)), ...(every ? ["--every", every] : []), note],
      { encoding: "utf8", timeout: 30_000 }, error => resolve(error)));
    if (failed?.code === "ENOENT") return yield* json(503, { message: "Wake-ups aren’t set up on this machine yet. Connect to it from your Mac once, then try again." });
    if (failed) return yield* json(503, { message: "The wake-up couldn’t be added. Try again." });
    return yield* json(200, listed());
  }
  if (action === "pause" && typeof given.paused !== "boolean") return yield* json(400, { message: "Send {\"paused\": true} or false." });
  if (!folder) return yield* json(action === "pause" ? 200 : 404, action === "pause" ? listed() : {});
  if (isMoving(folder)) return yield* json(409, { message: MOVING });
  if (action === "pause") {
    // A hold of your own, until you take it away (archiving's and a move's are theirs).
    if (given.paused) fs.writeFileSync(path.join(folder, "paused"), "paused");
    else fs.rmSync(path.join(folder, "paused"), { force: true });
    return yield* json(200, listed());
  }
  const { wakes, watches } = readWakes(folder);
  const wake = typeof given.wake === "string" ? wakes.find(each => each.id === given.wake || each.letters === given.wake) : undefined;
  if (action === "cancel") {
    if (wake && LETTERS.test(wake.letters)) {
      cancelWake(folder, wake.letters);
      return yield* json(200, {});
    }
    const watch = typeof given.watch === "string" ? watches.find(each => each.letters === given.watch) : undefined;
    if (watch && LETTERS.test(watch.letters)) {
      fs.rmSync(path.join(folder, "watches", watch.letters), { recursive: true, force: true });
      return yield* json(200, {});
    }
    return yield* json(404, {});
  }
  if (!wake) return yield* json(404, {});
  const key = `${folder}/${wake.id}`;
  if (wakingNow.has(key)) return yield* json(200, {});
  wakingNow.add(key);
  try {
    // The whole note, as its time would send it, not the line it's listed by.
    const note = textOf(path.join(folder, "wakes", wake.id));
    if (note === null) return yield* json(404, {});
    const agents = (textOf(path.join(folder, "via")) ?? "").trim() === "bridge";
    let target = null;
    try {
      target = agents ? bridge() : readEngine();
    } catch {}
    if (!target) return yield* json(503, { message: agents ? "The coding agents aren't running on this machine." : "The engine isn't running." });
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
      return yield* json(503, { message: "The wake-up couldn't be sent." });
    }
    if (!response.ok) return yield* json(503, { message: `The wake-up couldn't be sent (${response.status}).` });
    if (!wake.every) cancelWake(folder, wake.letters);
    return yield* json(200, {});
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
  const value = { t: "notify", title: cut(String(notice.title ?? ""), 200), category: notice.category, thread: String(notice.thread ?? ""), data: notice.data ?? {} };
  if (notice.subtitle) value.subtitle = cut(String(notice.subtitle), 200);
  let body = String(notice.body ?? "");
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
// if it was answered meanwhile (a permission, a question, an ask) or its conversation came on that
// client's screen. When the last lease ends (it ran out, or the client said it's not in use), what
// waits goes at once; with none, notices go at once. So a client that vanishes (a Mac's lid closed)
// holds nothing back for longer than a hold.

// How long a notice waits while you're at a computer: what's asked of you less than news.
export const ASK_HOLD = 30_000;
export const NEWS_HOLD = 60_000;
// The longest lease a client gets: one it doesn't renew is over by then.
export const LONGEST_LEASE = 60_000;
// Where a running bridge keeps what's held.
const HELD_FILE = path.join(RUN, "held-notices.json");
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

// What a client said (`POST kuvo/attention`'s body, or a Mac's mail): `{seconds, sessions}`, its
// lease cut to the longest; null for what isn't that.
export function attentionGiven(given) {
  if (!isObject(given) || typeof given.for !== "number" || !Number.isFinite(given.for) || given.for < 0) return null;
  if (given.sessions !== undefined && (!Array.isArray(given.sessions) || !given.sessions.every(each => typeof each === "string"))) return null;
  return { seconds: Math.min(given.for, LONGEST_LEASE / 1000), sessions: (given.sessions ?? []).slice(0, 50) };
}

export class NoticeHold {
  // `send(notice)`: to your phones; false when it can't go now. `now`, `setTimer` and `clearTimer`:
  // the clock (a test's own). `save(entries)`: what's held, kept for a bridge that starts again,
  // which gives them back as `held` (no client is in use with it yet, so they go).
  constructor({ send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, save = () => {}, held = [] }) {
    Object.assign(this, { send, now, setTimer, clearTimer, save });
    this.leases = new Map();
    // When each client last spoke (its word's `at`): an older word, come late, is let go.
    this.heard = new Map();
    this.answered = [];
    this.timer = null;
    this.held = (Array.isArray(held) ? held : []).filter(entry => isObject(entry?.notice) && typeof entry.at === "number")
      .map(entry => ({ notice: entry.notice, at: entry.at, due: 0, seen: entry.seen === true }));
    this.saved = NoticeHold.kept(this.held);
    this.settle();
  }

  // What's kept of what's held, as JSON.
  static kept(entries) {
    return JSON.stringify(entries.map(({ notice, at, seen }) => ({ notice, at, seen })));
  }

  // Whether a client is in use now, and how many notices wait.
  get inUse() {
    const now = this.now();
    return [...this.leases.values()].some(until => until > now);
  }
  get count() { return this.held.length; }

  // `client` is in use for `seconds` more, with `sessions` on its screen; 0: it isn't any more.
  // `at`: when it said so, by its own clock, for words that can come out of order (mail).
  attend(client, { seconds, sessions = [] }, at) {
    if (typeof at === "number") {
      if (at < (this.heard.get(client) ?? -Infinity)) return;
      this.heard.set(client, at);
    }
    if (seconds > 0) {
      this.leases.set(client, this.now() + seconds * 1000);
      const shown = new Set(sessions);
      for (const entry of this.held) if (shown.has(shownIn(entry.notice))) entry.seen = true;
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
    this.held.push({ notice, at: now, due: this.inUse ? now + holdFor(notice.category) : now, seen: false });
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
    const when = entry => Math.max(waiting ? entry.due : 0, entry.retry ?? 0);
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

// "Wants to run a command: npm test", as the Mac says it.
export function describePermission(request) {
  const what = { edit: "edit files", write: "edit files", patch: "edit files", shell: "run a command", bash: "run a command", read: "read a file", external_directory: "work outside the project", webfetch: "open a web page" }[request.action] ?? request.action;
  const resource = request.resources?.[0];
  return !resource || resource === "*" ? `Wants to ${what}.` : `Wants to ${what}: ${resource}`;
}

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
  const about = (shown, category, body, extra = {}) => {
    const bot = isBot(shown);
    const folder = shown.location?.directory ?? "";
    return {
      title: shown.title || "New Session",
      subtitle: bot ? undefined : path.basename(folder) || undefined,
      body,
      category,
      thread: shown.id,
      data: { session: shown.id, ...extra },
    };
  };
  switch (event.type) {
    case "permission.asked": {
      const where = await shown(data.sessionID);
      if (isHiddenRun(where)) return null;
      return about(where, "permission", describePermission(data), { request: data.id, ...(where.id !== data.sessionID ? { requestSession: data.sessionID } : {}) });
    }
    case "form.created": {
      // The form comes under `form`, with its session.
      const form = data.form ?? data;
      const asker = form.sessionID === "global" ? await waitingOn(form.metadata?.server, event.location?.directory) : form.sessionID;
      if (!asker) return null;
      const where = await shown(asker);
      if (isHiddenRun(where)) return null;
      return about(where, "question", describeForm(form), { request: form.id, ...(where.id !== form.sessionID ? { requestSession: form.sessionID } : {}) });
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
export async function watchEvents(read, tell, signal, answered = () => {}) {
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      const source = read();
      const response = await fetch(`http://127.0.0.1:${source.port}/api/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${source.password}`).toString("base64")}`, accept: "text/event-stream" },
        signal,
      });
      if (!response.ok || !response.body) throw new Error(`${response.status}`);
      attempt = 0;
      for await (const event of serverEvents(response.body)) {
        // The box's own work, Mac connected or not: a session made in one of its worktrees told
        // so; a worktree's branch named after its session; a bot's job read from its memory as
        // its run ends.
        if (event.type === "session.created") tellWorktree(source, event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
        if (event.type === "session.renamed") nameWorktreeBranch(source, event.data?.sessionID).catch(() => {});
        if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") refreshBotJob(source, event.data?.sessionID).catch(() => {});
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
    attempt += 1;
    await pause(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
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
// One library on every computer: each keeps its copy, and copies meet as a Mac connects (or as a
// phone changes each): per personality, the newest change wins, a removal too, which stays noted
// so no copy brings it back. Kuvo Code's own presets aren't in it; they come with the kit.

const PERSONALITIES_FILE = path.join(K, "bots", "personalities.json");
const PERSONALITIES_LOCK = path.join(RUN, ".personalities.lock");
const PERSONALITY_ID = /^custom\.[A-Za-z0-9._-]{1,80}$/;
// Removals noted, the newest kept.
const MOST_REMOVALS = 500;

const changedAt = entry => Number(entry?.removed ?? entry?.updated ?? 0) || 0;
const isRemoval = entry => entry?.removed !== undefined;

// One personality as kept: what's needed, plain and of a sane length; null for what isn't one.
function keptPersonality(entry) {
  if (!isObject(entry) || !PERSONALITY_ID.test(String(entry.id))) return null;
  if (isRemoval(entry)) return Number.isFinite(Number(entry.removed)) ? { id: entry.id, removed: Number(entry.removed) } : null;
  const name = plainName(entry.name).slice(0, 80);
  const description = String(entry.description ?? "").trim().slice(0, 2000);
  if (!name || !description) return null;
  return { id: entry.id, name, description, symbol: typeof entry.symbol === "string" && entry.symbol ? entry.symbol.slice(0, 80) : "person.crop.circle", updated: Number(entry.updated) || 0 };
}

// The newer of two takes of one personality: a removal over a change made at the same moment,
// else the one whose words sort last, so every copy picks the same.
function newerTake(a, b) {
  const at = changedAt(a), bt = changedAt(b);
  if (at !== bt) return at > bt ? a : b;
  if (isRemoval(a) !== isRemoval(b)) return isRemoval(a) ? a : b;
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
    if (textOf(file) !== text) writePrivate(file, text);
    return library;
  });
}

// A copy from elsewhere without what's dated ahead of this box's clock by more than a day, which
// would win over every change to come.
export function timelyPersonalities(given, now = Date.now()) {
  const timely = list => (Array.isArray(list) ? list : []).filter(entry => changedAt(entry) <= now + 86_400_000);
  return { personalities: timely(given?.personalities), removed: timely(given?.removed) };
}

// A peer's copy met with this one's (each box tells the others its own, box to box, with no Mac
// needed): the personalities that changed here, whose bots here are told what they are now.
export async function takePersonalities(given, readEngine = readEngineFile, readBridge = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK, now = Date.now()) {
  given = timelyPersonalities(given, now);
  const before = readPersonalities(file);
  const was = new Map([...before.personalities, ...before.removed].map(entry => [entry.id, JSON.stringify(entry)]));
  const after = changePersonalities(library => mergePersonalities(library, given), file, lock);
  const changed = [...after.personalities, ...after.removed].filter(entry => was.get(entry.id) !== JSON.stringify(entry)).map(entry => entry.id);
  if (changed.length) await retellBots(changed, readEngine, readBridge).catch(() => {});
  return changed;
}

// Bots here whose personality is among `ids` (changed, or gone), told what they are now, as a
// Mac tells its own (Bots.personalityChanged).
export async function retellBots(ids, readEngine = readEngineFile, readBridge = readBridgeFile) {
  const kit = readKit();
  if (!kit) return;
  const personalities = botPersonalities(kit);
  for (const here of listOf(BOTS).map(botHere)) {
    if (!here || !ids.includes(here.described.personality) || isMoving(here.folder)) continue;
    let target = null;
    try { target = here.agents ? readBridge() : readEngine(); } catch {}
    if (!target?.port) continue;
    const personality = personalities.find(each => each.id === here.described.personality)?.instruction;
    const told = botInstructions(kit, here.described.name, here.folder, personality, here.described.project, jobInMemory(textOf(path.join(here.folder, "MEMORY.md")) ?? ""));
    if (told === null) continue;
    await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(here.session)}/instructions/entries/kuvo.bot`, { value: told })
      .then(() => toldBots.set(here.session, told), () => {});
  }
}

// What a phone asks of the library (`kuvo/personalities`): `[status, value]`.
export function answerPersonalities(method, id, body, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const now = Date.now();
  if (id === undefined) {
    if (method === "GET") return [200, { personalities: readPersonalities(file).personalities }];
    if (method !== "POST") return [405, {}];
    const made = keptPersonality({ id: `custom.${crypto.randomUUID().toLowerCase()}`, name: body?.name, description: body?.description, updated: now });
    if (!made) return [400, { message: "A personality needs a name and a description." }];
    changePersonalities(library => ({ ...library, personalities: [...library.personalities, made] }), file, lock);
    return [200, made];
  }
  if (!PERSONALITY_ID.test(id)) return [404, {}];
  let found = null;
  if (method === "PATCH") {
    let refused = false;
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      const changed = keptPersonality({ ...kept, name: body?.name ?? kept.name, description: body?.description ?? kept.description, updated: Math.max(now, kept.updated + 1) });
      if (!changed) { refused = true; return library; }
      found = changed;
      return { ...library, personalities: library.personalities.map(each => each.id === id ? changed : each) };
    }, file, lock);
    if (refused) return [400, { message: "A personality needs a name and a description." }];
    return found ? [200, found] : [404, {}];
  }
  if (method === "DELETE") {
    changePersonalities(library => {
      const kept = library.personalities.find(each => each.id === id);
      if (!kept) return library;
      found = kept;
      return { personalities: library.personalities.filter(each => each.id !== id), removed: [...library.removed, { id, removed: Math.max(now, kept.updated + 1) }] };
    }, file, lock);
    return found ? [200, {}] : [404, {}];
  }
  return [405, {}];
}

// The personalities a bot made here can have: the kit's presets, then the library's, each with
// what the bot is told (`personalityWords`, as the Mac words it).
export function botPersonalities(kit, library = readPersonalities()) {
  const words = typeof kit.personalityWords === "string" ? kit.personalityWords : "Your personality: ⟦name⟧. ⟦description⟧";
  const told = each => words.replaceAll("⟦name⟧", each.name).replaceAll("⟦description⟧", each.description);
  const presets = kit.personalities.filter(each => !each.custom);
  // A kit from before the library: its own, until the library has them.
  const older = kit.personalities.filter(each => each.custom && !library.personalities.some(mine => mine.id === each.id) && !library.removed.some(gone => gone.id === each.id));
  return [...presets, ...older, ...library.personalities.map(each => ({ id: each.id, name: each.name, description: each.description, custom: true, instruction: told(each) }))];
}

// ---- This machine's own settings (PROTOCOL.md, "kuvo/config") ----
// The engine's settings file here, which the engine reloads when it changes: this machine's own,
// once Kuvo Code has made it so (`.kuvo-own` beside it), changed from a phone or a Mac by the
// rules the Mac's own follows (`PhoneLink.answerConfig`). Each computer keeps its own; nothing
// copies them between computers but you. Writes take `run/.config.lock`, as the Mac's do here.

// The box's own settings and keys, in a folder of their own (`box`), which no older Kuvo Code
// writes: the engine reads the file (`OPENCODE_CONFIG`, over the global one) and reloads it when it
// changes. Before a Mac made them the machine's own (`adoptBox`), its Mac's.
const BOX = path.join(K, "box");
const CONFIG_FILE = path.join(BOX, "opencode.json");
const BOX_KEYS = path.join(BOX, "keys");
const OWN_MARK = CONFIG_FILE;
const CONFIG_LOCK = path.join(RUN, ".config.lock");
// What a Mac's start used to write: its settings in the global file, the rest beside its keys.
const GLOBAL_FILE = path.join(K, "config", "opencode", "opencode.json");
const MAC_SETTINGS = path.join(K, "keys", "settings.json");
const MAC_KEYS = path.join(K, "keys");
const LAUNCH_LOCK = path.join(RUN, ".launching");
// Settings › MCP Servers' popular servers, as the Mac lists them, which it puts here as it connects.
const CATALOG_FILE = path.join(K, "bin", "mcp-catalog.json");
const SERVERS = ["mcp", "servers"];

export const ownsSettings = (mark = OWN_MARK) => fs.existsSync(mark);

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys)
  : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;

// The file's settings: {settings}, or {problem} for one that isn't plain JSON (left alone).
export function readSettings(file = CONFIG_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: {} };
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
    if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}` };
    // Keys go through objects only: one through a list or a plain value would replace it whole.
    if (changes.some(change => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    }))) return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    if (changes.some(change => "was" in change && sortedJSON(valueAt(settings, change.path) ?? null) !== sortedJSON(change.was))) {
      return { status: 409, message: "It changed since you read it." };
    }
    let next = settings;
    for (const change of changes) next = settingAt(next, change.path, keysNamedHere(change.value));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(sortedKeys(next), null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      return { status: 500, message: `It couldn't be saved: ${error.message}` };
    }
    return { status: 200, settings: next };
  });
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

// A key named where another computer keeps its keys (`{file:<its folder>/KUVO_KEY_…}`, from Also
// Apply on a phone), named where this box keeps them, as a Mac's AlsoApply.keysNamed does.
export function keysNamedHere(value) {
  if (typeof value === "string") return value.replace(/\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g, (_, name) => `{file:${shownRoot}/box/keys/${name}}`);
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
export function adoptBox(seed) {
  return locked(LAUNCH_LOCK, () => locked(CONFIG_LOCK, () => {
    if (fs.existsSync(CONFIG_FILE)) return { status: "own", settings: readSettings().settings ?? {} };
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
    // The global file came in whole: the next start empties it (one you edited by hand, with
    // comments, it leaves as it is).
    if (!global.problem) writePrivate(path.join(BOX, "global-adopted"), "");
    const launchEnv = path.join(RUN, "launch.env");
    try {
      const lines = fs.readFileSync(launchEnv, "utf8").split("\n").filter(line => !/^KUVO_(PRIVATE_)?SETTINGS=/.test(line));
      writePrivate(launchEnv, lines.join("\n"));
    } catch {}
    return { status: "adopted", seeded, settings };
  }, { stale: 300_000, wait: 120_000 }));
}

// The box's own keys, by name (a bot's own, which its folder keeps, aren't among them).
export function boxKeyNames(folder = BOX_KEYS) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch {}
  return names.filter(name => KEY_NAME.test(name) && !name.includes("__")).sort();
}

// One of them, as it's kept; null for one there isn't.
export function boxKey(name, folder = BOX_KEYS) {
  if (!KEY_NAME.test(String(name)) || String(name).includes("__")) return null;
  try { return fs.readFileSync(path.join(folder, name), "utf8"); } catch { return null; }
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

// The popular servers, as this machine has them: those that use the Mac's own apps left out.
export function mcpCatalog(settings, file = CATALOG_FILE) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(file, "utf8")).servers ?? []; } catch {}
  return {
    servers: servers.filter(server => typeof server?.id === "string" && !server.macOnly).map(server => {
      const added = valueAt(settings, [...SERVERS, server.id]) !== undefined;
      return { id: server.id, title: String(server.title ?? ""), summary: String(server.summary ?? ""), access: String(server.access ?? "open"),
        added, integration: added && Boolean(server.integration), macOnly: false };
    }),
  };
}

// One of them added, as its Add button does on the Mac; one already there stays as it is.
export function addFromCatalog(id, file = CONFIG_FILE, catalog = CATALOG_FILE, lock = CONFIG_LOCK) {
  let servers = [];
  try { servers = JSON.parse(fs.readFileSync(catalog, "utf8")).servers ?? []; } catch {}
  const server = servers.find(each => each?.id === id && !each.macOnly);
  if (!server || !isObject(server.settings)) return { status: 404 };
  const { settings, problem } = readSettings(file);
  if (problem) return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}` };
  if (valueAt(settings, [...SERVERS, id]) !== undefined) return { status: 200, settings };
  return changeSettings([{ path: [...SERVERS, id], value: { codemode: false, ...server.settings } }], file, lock);
}

// ---- State ----

export function readLink() {
  try {
    return JSON.parse(fs.readFileSync(LINK_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeLink(link) {
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  const temporary = `${LINK_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(link, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, LINK_FILE);
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
    const pairing = link?.pairing;
    if (!pairing || Date.now() > pairing.expires) return null;
    const given = Buffer.from(String(hello.pair), "base64url");
    const expected = Buffer.from(pairing.token, "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    pairPhone(link, { key: encoded, name: String(hello.name ?? "").slice(0, 100), added: Math.floor(Date.now() / 1000), from: "pair", address: address?.toString("base64url"), pairing: newPairing() });
    delete link.pairing;
    paired = true;
    return link;
  });
  return paired || Boolean(readLink()?.phones?.some(phone => phone.key === encoded));
}

// ---- Paired phones (PROTOCOL.md, "Paired phones") ----
// A pairing adds a phone; a removal, from a phone on the list or a Mac that set this machine up,
// takes one off for good (`removed`, with the pairing it ended): only a pairing of its own, with a
// new pairing id, lets it back in, and nobody removes a Mac. Each Mac's list adds and removes only
// the phones it listed. The Mac's are the same rules (PairedPhones in KuvoLink), and both are held
// to Vectors/link.json.

const KEY = /^[A-Za-z0-9_-]{43}$/;
const PAIRING = /^[A-Za-z0-9_-]{0,32}$/;
// At most so many in one removal, and so many removals kept (the oldest go first).
const MOST_AT_ONCE = 16;
const MOST_KEPT = 256;

// The Macs that set this machine up (`setup`), whose lists and mail it takes.
export const macsOf = link => [...new Set([...(Array.isArray(link?.macs) ? link.macs : []), ...(typeof link?.mac === "string" ? [link.mac] : [])])];

// When a Mac's last list came (its own clock, milliseconds).
const lastFrom = (link, mac) => link.macAts?.[mac] ?? (mac === link.mac ? link.macAt ?? 0 : 0);

// A Mac this machine hasn't heard from in 30 days, by its own clock (gone, or its key made anew):
// it no longer sets the list, and the phones it listed are as ones from before Macs were named,
// which another Mac's list takes off, not for good. One back sets the machine up again. `keep`,
// heard from now.
const MAC_GONE_AFTER = 30 * 24 * 3600 * 1000;
export function forgetOldMacs(link, keep, now = Date.now()) {
  link.macSeen ??= {};
  for (const mac of macsOf(link)) link.macSeen[mac] ??= now;
  if (keep) link.macSeen[keep] = now;
  const gone = macsOf(link).filter(mac => mac !== keep && now - link.macSeen[mac] > MAC_GONE_AFTER);
  if (!gone.length) return;
  link.macs = macsOf(link).filter(mac => !gone.includes(mac));
  if (gone.includes(link.mac)) link.mac = keep;
  for (const mac of gone) {
    delete link.macSeen[mac];
    if (link.macAts) delete link.macAts[mac];
    if (link.peersFrom) delete link.peersFrom[mac];
  }
  for (const phone of link.phones ?? []) if (gone.includes(phone.mac)) delete phone.mac;
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

// The phones the Mac `by` has paired as it lists them now (from: "mac"), and the removals it heard
// of, beside the ones paired with this machine itself (from: "pair") and other Macs', keeping when
// each was added and where it is. One of its own it no longer lists is removed; one removed here
// stays out, unless the Mac paired it again (another pairing). One from before Macs were named goes
// off the list, not for good: another Mac may list it.
export function takeMacList(link, given, removed, by = link.mac) {
  const macs = macsOf(link);
  const known = new Map((link.phones ?? []).map(phone => [phone.key, phone]));
  const ADDRESS = /^[A-Za-z0-9_-]{22}$/;
  const listed = [];
  for (const phone of Array.isArray(given) ? given : []) {
    if (!fits(phone, macs) || listed.some(each => each.key === phone.key)) continue;
    const pairing = phone.pairing ?? "";
    if (removedAlready(link, phone.key, pairing)) continue;
    listed.push({
      key: phone.key,
      name: String(phone.name ?? "").slice(0, 100),
      added: known.get(phone.key)?.added ?? Math.floor(Date.now() / 1000),
      from: "mac",
      mac: by,
      address: ADDRESS.test(phone.address ?? "") ? phone.address : known.get(phone.key)?.address,
      pairing,
    });
  }
  const keys = new Set(listed.map(phone => phone.key));
  const kept = [];
  for (const phone of link.phones ?? []) {
    if (keys.has(phone.key)) continue;
    if (phone.from === "pair" || (phone.mac != null && phone.mac !== by)) kept.push(phone);
    else if (by != null && phone.mac === by) noteRemoved(link, phone.key, phone.pairing ?? "");
  }
  link.phones = [...listed, ...kept];
  for (const entry of Array.isArray(removed) ? removed : []) {
    if (fits(entry, macs)) takeOff(link, entry.key, entry.pairing ?? "");
  }
}

// A Mac's phone list, mailed through the relay (sealed with its key, which its setup gave): one
// you removed there loses its way in here at once, though the Mac can't reach this machine
// itself. Only a newer list from that Mac than its last one counts.
export function phonesFromMac(body, host) {
  const found = readLink();
  if (!found?.key) return;
  const opened = openMail(body, found);
  if (opened?.sender.kind === "mac" && macsOf(found).includes(opened.sender.key)) takeFromMac(opened.payload, opened.sender.key, host);
}

// What a Mac that set this box up mails it: the phones you've paired, and its peers (PROTOCOL.md,
// "Peers"), each list taken only if it's newer than that Mac's last.
export function takeFromMac(given, by, host) {
  if (typeof given?.at !== "number") return;
  const changed = updateLink(link => {
    if (!link) return null;
    let took = false;
    if (Array.isArray(given.phones) && given.at > lastFrom(link, by)) {
      takeMacList(link, given.phones, given.removed, by);
      link.macAts = { ...(link.macAts ?? {}), [by]: given.at };
      took = true;
    }
    if (Array.isArray(given.peers)) took = takePeers(link, by, given.peers, given.at, given.moved) || took;
    if (!took) return null;
    forgetOldMacs(link, by);
    return link;
  });
  if (changed) host?.keepOnly(new Set(changed.phones.map(phone => phone.key)));
}

// ---- Peers (PROTOCOL.md, "Peers") ----
// The other boxes a Mac set this one up with: itself and its other machines, each kept as that Mac
// last listed them (a newer list replaces its last), so one a Mac removed leaves every list it gives.
// Only a Mac that set this box up lists them; mail is taken from them, and goes to them.

const MOST_PEERS = 64;
const fitsPeer = peer => isObject(peer) && typeof peer.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(peer.key)
  && typeof peer.address === "string" && /^[A-Za-z0-9_-]{22}$/.test(peer.address) && (peer.kind === "mac" || peer.kind === "machine");

export function takePeers(link, by, peers, at, moved = []) {
  if (!Array.isArray(peers) || typeof at !== "number") return false;
  link.peersFrom ??= {};
  if (at <= (link.peersFrom[by]?.at ?? 0)) return false;
  link.peersFrom[by] = { at, peers: peers.filter(fitsPeer).slice(0, MOST_PEERS).map(({ key, address, name, kind, id }) => ({ key, address, kind, name: plainName(name).slice(0, 100), ...(typeof id === "string" ? { id: id.slice(0, 200) } : {}) })),
    moved: (Array.isArray(moved) ? moved : []).filter(each => isObject(each) && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(each.key))
      .slice(0, 500).map(({ session, key }) => ({ session, key })) };
  return true;
}

// Conversations a Mac moved from one box to another, by where each lives now (its box's key): the
// box it left may still list it, until it's back to let it go.
export function movedOf(link) {
  const macs = new Set(macsOf(link));
  const moved = new Map();
  for (const [mac, given] of Object.entries(link?.peersFrom ?? {})) {
    if (!macs.has(mac)) continue;
    for (const { session, key } of given?.moved ?? []) moved.set(session, key);
  }
  return moved;
}

// This box's peers now: from each of its Macs' lists, itself left out.
export function peersOf(link) {
  if (!link?.peersFrom || !Object.keys(link.peersFrom).length) return [];
  // Each of this box's Macs' lists as that Mac last gave it: its own copy, or a newer one a
  // machine that Mac named passed on (`vouched`), when this box missed the Mac's mail. (A machine
  // a newer list dropped has nothing newer to pass on: that Mac stopped telling it.)
  return composedPeers(link, peersFromMacs(link).filter(peer => peer.kind === "machine"));
}

// This box's Macs' lists, each the newest of its own copy and those `vouchers` passed on; a copy
// one passed on counts that machine too (a Mac's list to a machine leaves that machine out).
function composedPeers(link, vouchers) {
  const own = ownKey(link);
  const byKey = new Map();
  for (const mac of macsOf(link)) {
    let newest = link.peersFrom[mac], from = null;
    // Only a machine that Mac itself named carries its word.
    for (const voucher of vouchers.filter(each => (link.peersFrom[mac]?.peers ?? []).some(peer => peer.key === each.key))) {
      const passed = link.vouched?.[voucher.key]?.[mac];
      if (passed && passed.at > (newest?.at ?? 0)) {
        newest = passed;
        from = voucher;
      }
    }
    const listed = [...(newest?.peers ?? []), ...(from ? [from] : [])];
    for (const peer of listed) if (fitsPeer(peer) && peer.key !== own && !byKey.has(peer.key)) byKey.set(peer.key, peer);
  }
  return [...byKey.values()];
}

// This box's own public key, as peers name it.
function ownKey(link) {
  try { return publicOf(Buffer.from(link.key, "base64url")).toString("base64url"); } catch { return null; }
}

// The peers this box's own Macs told it of (`peersFrom`), itself left out.
export function peersFromMacs(link) {
  if (!link?.peersFrom || !Object.keys(link.peersFrom).length) return [];
  const own = ownKey(link);
  const macs = new Set(macsOf(link));
  const byKey = new Map();
  for (const [mac, given] of Object.entries(link.peersFrom ?? {})) {
    if (!macs.has(mac)) continue;
    for (const peer of given?.peers ?? []) if (fitsPeer(peer) && peer.key !== own) byKey.set(peer.key, peer);
  }
  return [...byKey.values()];
}

// The lists a machine this box's Macs named passes on, each as one of its Macs gave it
// (`[{mac, at, peers}]`): kept for the Macs that are this box's own too, a newer copy replacing
// that machine's last. Only a Mac says who a box's peers are; a machine only carries its word, to
// a box that missed it. False when nothing's kept.
export function takeVouched(link, by, lists) {
  if (!Array.isArray(lists)) return false;
  if (!peersFromMacs(link).some(peer => peer.key === by && peer.kind === "machine")) return false;
  const macs = new Set(macsOf(link));
  let changed = false;
  for (const list of lists.slice(0, 16)) {
    // Never one dated ahead of this box's clock by more than a day, which would win over every
    // list its Mac gives after.
    if (!isObject(list) || !macs.has(list.mac) || typeof list.at !== "number" || list.at > Date.now() + 86_400_000 || !Array.isArray(list.peers)) continue;
    link.vouched ??= {};
    link.vouched[by] ??= {};
    if (list.at <= (link.vouched[by][list.mac]?.at ?? 0)) continue;
    link.vouched[by][list.mac] = { at: list.at, peers: list.peers.filter(fitsPeer).slice(0, MOST_PEERS).map(({ key, address, name, kind, id }) => ({ key, address, kind, name: plainName(name).slice(0, 100), ...(typeof id === "string" ? { id: id.slice(0, 200) } : {}) })) };
    changed = true;
  }
  return changed;
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
const LETTER_BYTES = 24_000;
const MOST_AGENTS = 120;
const LETTER_ID = /^[A-Za-z0-9_-]{6,80}$/;
// Without the relay this long, this box's letters go to the Mac instead, which collects them
// over SSH.
const RELAY_GONE_AFTER = 5 * 60_000;

const fitsAgent = agent => isObject(agent) && typeof agent.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(agent.session)
  && typeof agent.name === "string" && (agent.kind === "bot" || agent.kind === "session");
const keptAgent = ({ session, name, kind, project, about, machine }) => ({ session, name: plainName(name).slice(0, 200), kind,
  ...(typeof project === "string" && project ? { project: project.slice(0, 200) } : {}), ...(typeof about === "string" && about ? { about: about.slice(0, 500) } : {}),
  ...(typeof machine === "string" && machine ? { machine: machine.slice(0, 200) } : {}) });

// What a peer said its agents are, the newest it said: false for an older list.
export function takeAgents(sender, given, file = PEER_AGENTS_FILE, lock = PEER_LOCK) {
  if (!isObject(given) || typeof given.at !== "number" || !Array.isArray(given.list)) return false;
  return locked(lock, () => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (given.at <= (all[sender.key]?.at ?? 0)) return false;
    all[sender.key] = { at: given.at, kind: sender.kind, ...(sender.id ? { id: sender.id } : {}), list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent) };
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
  const bots = listBots(machine).map(bot => ({ session: bot.session, name: bot.name, kind: "bot", ...(bot.job ? { about: bot.job } : {}) }));
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
  const projects = kit?.projects ?? [];
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
// that tool. `send(peer, payload)` mails the peer; `answer(letter)` sends this box's answer back.
export async function takeLetter(sender, letter, { send, targets, answer = () => {}, told = readPeerAgents(), peers = peersOf(readLink()), moved = movedOf(readLink()), now = Date.now(), wait } = {}) {
  if (!isObject(letter) || typeof letter.id !== "string" || !LETTER_ID.test(letter.id)) return;
  const { id } = letter;
  const no = (why, again = false) => send(sender, { delivered: { id, ok: false, why, ...(again ? { retry: true } : {}) } });
  if (typeof letter.at !== "number" || Math.abs(now - letter.at) > LETTER_LIFE) return no("It's too old to deliver.");
  if (typeof letter.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.to) || typeof letter.text !== "string" || !letter.text.trim()) return no("That isn't a letter.");
  if (delivering.has(id)) return;
  if (seenAlready(id, now)) return send(sender, { delivered: { id, ok: true } });
  // An answer a tool here waits for (from the box its letter went to): to it.
  if (typeof letter.answers === "string" && LETTER_ID.test(letter.answers) && answered(sender, letter.answers, letter.text, now)) {
    noteSeen(id, now);
    return send(sender, { delivered: { id, ok: true } });
  }
  if (tooMany(sender.key, now)) return no("It's sent a lot of messages in the last few minutes.", true);
  delivering.add(id);
  let place, prompt, fromAgent = null;
  try {
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
    await asked(place.target, "POST", `api/session/${encodeURIComponent(letter.to)}/prompt`, { id: prompt, text: composeLetter(name, fromAgent ? letter.from : "unknown", letter.text.slice(0, LETTER_TEXT), waits), delivery: "steer" });
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
  // Your personalities only from a machine this box's own Macs named (all its peers are).
  if (isObject(payload.personalities) && sender.kind === "machine") {
    takePersonalities(payload.personalities).catch(() => {});
  }
  if (isObject(payload.vouched) && sender.kind === "machine") {
    const changed = updateLink(link => link && takeVouched(link, sender.key, payload.vouched.lists) ? link : null);
    if (changed) writeAgents(changed);
  }
  // It's just connected, and may have missed what this box told it (the relay keeps nothing):
  // told again at the next round.
  if (payload.ask === "agents") {
    toldPeers.delete(sender.key);
    toldPersonalities.delete(sender.key);
  }
  if (isObject(payload.letter)) takeLetter(sender, payload.letter, { send, targets: targets(), answer: leaveAnswer }).catch(() => {});
  if (isObject(payload.delivered) && typeof payload.delivered.id === "string") letterWent(sender, payload.delivered);
}

// This box's own agents, as last worked out (`refreshOwn`), for `run/agents.json`.
let ownList = null;
let ownMachine = null;

// Writes `run/agents.json`: this box's agents and its peers'.
export function writeAgents(link = readLink()) {
  const composed = composeAgents(ownList ?? [], ownMachine ?? link?.id ?? null, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link));
  try {
    const text = JSON.stringify(composed);
    if (textOf(AGENTS_FILE) !== text) writePrivate(AGENTS_FILE, text);
  } catch {}
}

// This box's own agents, worked out again, and `run/agents.json` with them, relay or not.
export async function refreshOwn(readEngine, link = readLink()) {
  if (!link?.key) return ownList;
  ownMachine = link.id ?? null;
  const list = await ownAgents(readEngine, link.id);
  if (list) ownList = list;
  writeAgents(link);
  return ownList;
}

// Tells each peer this box's agents: when they change, and every ten minutes. `told` remembers
// what went to whom, and when. `ask`: just connected, so each is told, and asked for theirs.
const toldPeers = new Map();
// What each machine was last told of your personalities, and when.
const toldPersonalities = new Map();
export async function announce(host, readEngine, link = readLink(), now = Date.now(), ask = false) {
  if (!link?.key) return;
  await refreshOwn(readEngine, link);
  if (!ownList) return;
  // With them, to a machine this box's Macs named, their lists as they gave them (`vouched`), for
  // one that missed a Mac's mail.
  const lists = macsOf(link).filter(mac => link.peersFrom?.[mac]).map(mac => ({ mac, at: link.peersFrom[mac].at, peers: link.peersFrom[mac].peers }));
  const json = JSON.stringify([ownList, lists]);
  for (const peer of peersOf(link)) {
    const last = toldPeers.get(peer.key);
    if (!ask && last && last.json === json && now - last.at < 600_000) continue;
    const others = peer.kind === "machine" && lists.length ? { vouched: { lists } } : {};
    // As many as fit in one mail: the first (bots, then the latest sessions) first.
    let bytes = null, sent = [];
    for (const count of [ownList.length, Math.floor(ownList.length / 2), Math.floor(ownList.length / 4)]) {
      sent = ownList.slice(0, count);
      bytes = mailFor(peer, { agents: { at: now, list: sent }, ...others, at: now, ...(ask ? { ask: "agents" } : {}) }, link);
      if (bytes) break;
    }
    if (!bytes) continue;
    try {
      host.send(bytes);
      toldPeers.set(peer.key, { json, at: now, sessions: new Set(sent.map(agent => agent.session)) });
    } catch {}
  }
  // Your personalities, to your other machines (a Mac meets a box's copy as it connects): when
  // this copy changes, and every ten minutes, so one that was away catches up.
  const library = readPersonalities();
  const words = JSON.stringify(library);
  if (!library.personalities.length && !library.removed.length) return;
  for (const peer of peersOf(link).filter(peer => peer.kind === "machine")) {
    const last = toldPersonalities.get(peer.key);
    if (!ask && last && last.words === words && now - last.at < 600_000) continue;
    // In as many mails as it takes (each personality is met on its own), the newest first.
    const entries = [...library.personalities, ...library.removed].sort((a, b) => changedAt(b) - changedAt(a));
    const parts = [[]];
    let size = 0;
    for (const entry of entries) {
      // Well within a mail (`mailFor`'s limit), as JSON.
      const length = Buffer.byteLength(JSON.stringify(entry));
      if (size + length > 40_000 && parts.at(-1).length) {
        parts.push([]);
        size = 0;
      }
      parts.at(-1).push(entry);
      size += length;
    }
    const mails = parts.map(list => mailFor(peer, { personalities: { personalities: list.filter(entry => !isRemoval(entry)), removed: list.filter(isRemoval) }, at: now }, link)).filter(Boolean);
    try {
      for (const mail of mails) host.send(mail);
      toldPersonalities.set(peer.key, { words, at: now });
    } catch {}
  }
}

// ---- The outbox: letters this box's agents leave for agents elsewhere ----
// Each goes by mail to the box its agent is on, again each minute until that box says it has it
// (or why not), for two days. A waiting tool reads its answer from `run/replies/<id>.json`.

const letterTries = new Map();
// Senders being told of to their letters' boxes first (one made a moment ago, which those boxes
// don't know yet): its letter goes the round after.
const introducing = new Map();

function reply(id, value) {
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
  if (!ok && retry === true && Date.now() - (letter.at ?? 0) < LETTER_MEMORY) return;
  letterTries.delete(id);
  const words = typeof why === "string" ? why.slice(0, 500) : null;
  if (ok && letter.wait === true && answer !== false) {
    try {
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

// The answer to letter `id`, from the box it went to, for the tool waiting for it here: true when
// one still waits (it notes it does, `<id>.alive`, every two seconds as it looks); else it comes
// as a message.
function answered(sender, id, text, now = Date.now()) {
  const waiting = path.join(REPLIES, `${id}.wait`);
  let letter = null;
  try { letter = JSON.parse(fs.readFileSync(waiting, "utf8")); } catch { return false; }
  if (letter?.sentTo !== sender.key) return false;
  fs.rmSync(waiting, { force: true });
  let alive = 0;
  try { alive = fs.statSync(path.join(REPLIES, `${id}.alive`)).mtimeMs; } catch {}
  if (now - alive > 10_000) return false;
  reply(id, { text: String(text).slice(0, 8000) });
  return true;
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
// not yet sent go to the Mac instead.
export function sendOutbox(host, link = readLink(), now = Date.now(), offline = 0) {
  if (!link?.key) return;
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
  for (const name of listOf(SENDING)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const file = path.join(SENDING, name);
    let letter;
    try { letter = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    listed.add(id);
    const made = typeof letter.at === "number" ? letter.at : now;
    const peer = typeof letter.peer === "string" ? peers.find(each => each.key === letter.peer) ?? null : peerOf(letter.to, peers, told, moved);
    if (now - made > LETTER_MEMORY) {
      fs.rmSync(file, { force: true });
      if (letter.wait === true) reply(id, { failed: "Its agent couldn't be reached." });
      continue;
    }
    // No box lists its agent now (lists change as boxes come and go): it waits.
    if (!peer) continue;
    // No relay for a while: one never sent goes to the Mac, which takes it on over SSH.
    if (offline > RELAY_GONE_AFTER && !letter.sentTo && !letter.answers) {
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
    const bytes = letterMail(peer, { id, from: letter.from, to: letter.to, text: String(letter.text ?? "").slice(0, LETTER_TEXT), wait: letter.wait === true, at: made,
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
  for (const id of introducing.keys()) if (!listed.has(id)) introducing.delete(id);
  // Answers no tool came for (it gave up waiting), and ones never answered, after a day.
  for (const name of listOf(REPLIES)) {
    try {
      if (now - fs.statSync(path.join(REPLIES, name)).mtimeMs > LETTER_LIFE) fs.rmSync(path.join(REPLIES, name), { force: true });
    } catch {}
  }
}

// What came by mail, from a Mac or a peer: a Mac's lists, or what peers tell each other
// (`peerMail`, its agents and their letters); `attended(mac, given, at)`: a Mac in use, or not any
// more, as of its mail's `at` (PROTOCOL.md, "kuvo/attention").
export function receiveMail(body, host, peerMail = () => {}, attended = () => {}) {
  const link = readLink();
  const opened = openMail(body, link);
  if (!opened) return;
  const { sender, payload } = opened;
  if (macsOf(link).includes(sender.key) && (Array.isArray(payload.phones) || Array.isArray(payload.peers))) takeFromMac(payload, sender.key, host);
  const attention = macsOf(link).includes(sender.key) ? attentionGiven(payload.attention) : null;
  if (attention && typeof payload.at === "number") attended(sender.key, attention, payload.at);
  peerMail(sender, payload);
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
// Where an earlier bridge kept its update switch (`{auto}`), which there isn't any more.
const UPDATE_SETTINGS = path.join(BOX, "update.json");
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

/** Why a machine's updates can't be turned off: it keeps up with the Macs and phones that use it. */
const ALWAYS_UPDATES = "A machine always keeps itself up to date.";

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

// An older Mac (Kuvo Code 0.7 and before) to hold updates back for, from now: it would put back
// its own files.
function noteOlderMac(at) {
  let launchers = {};
  try { launchers = JSON.parse(fs.readFileSync(LAUNCHERS, "utf8")) ?? {}; } catch {}
  if ((launchers["an older Mac"] ?? 0) >= at) return;
  launchers["an older Mac"] = at;
  try { writePrivate(LAUNCHERS, JSON.stringify(launchers)); } catch {}
}

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

// What `kuvo/update` says: whether updates are set up, the switch, this version and the newest
// heard of, how the last went, whether one runs now, and why not, when it can't.
export function updateStatus() {
  const state = updateState();
  let engine = null;
  try { engine = readEngineFile()?.version ?? null; } catch {}
  return {
    setUp: UPDATE_KEYS.length > 0,
    auto: true,
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

// ---- The relay connection ----

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Connects once, serves until the connection ends. Resolves whether it got as far as welcome.
export function connectOnce(relay, secret, host) {
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
    socket.onopen = () => socket.send(relayHello(secret));
    socket.onmessage = event => {
      lastHeard = Date.now();
      const message = readRelay(Buffer.from(event.data));
      if (!message) return;
      if (!welcomed) {
        if (message.kind !== "welcome" || !message.address.equals(self)) return socket.close();
        welcomed = true;
        host.send = bytes => { if (socket.readyState === 1) socket.send(bytes); };
        host.welcomed = true;
        // Your other computers hear who's here at once, and tell who's there.
        announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
        // A new bridge an update put here: it reached the relay, so it's well.
        try { confirmUpdate(); } catch {}
        return;
      }
      if (message.kind === "deliver" && !message.address.equals(self)) host.receive(message.address, message.payload);
      if (message.kind === "unreachable" && !message.address.equals(self)) host.forget(message.address);
    };
    socket.onerror = finish;
    socket.onclose = finish;
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Whether `pid` runs `name`, not whatever took its number after a crash: on Linux its command
// line says so (elsewhere, where there's no /proc, that it's alive).
function runs(pid, name) {
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(name);
  } catch {
    return !fs.existsSync("/proc");
  }
}

// Another bridge.
const isBridge = pid => pid !== process.pid && runs(pid, "kuvo-link.js");

// The box's keeper (`bin/kuvo-start`), started again if it went: it keeps the engine and this
// bridge running.
export function keepKeeper() {
  let start = path.join(K, "bin", "kuvo-start");
  if (!fs.existsSync(start)) return;
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
  // The notes an earlier Kuvo Code on a Mac left that it was connected (it did some of the box's
  // work then): nothing reads them now.
  for (const folder of ["present", "connected"]) fs.rmSync(path.join(RUN, folder), { recursive: true, force: true });
  // Its bots' folders' settings, as its integrations are now (after an update, say).
  try { refreshBotsKeys(); } catch {}
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
  watchEvents(readEngineFile, tell, undefined, answered);
  // The coding agents here (their sessions, and group chats that live here), through their bridge.
  watchEvents(readBridgeFile, tell, undefined, answered);
  watchAsks(tell, { answered });
  // Your other computers: this box's agents told to them while the relay connection is up (and
  // listed here, relay or not), and its agents' letters sent; without the relay a while, those
  // not sent yet go to the Mac.
  let lastWelcomed = Date.now();
  refreshOwn(readEngineFile).catch(() => {});
  // Updates: the new bridge, once one put it here, says it's well (after the relay's welcome, or
  // three minutes); each night's window, one, when it's on and nothing runs (PROTOCOL.md, "Updates").
  setTimeout(() => { try { confirmUpdate(); } catch {} }, 180_000);
  const nightly = () => {
    noteLauncher();
    noteOlderMacs();
    try { checkDrift(); } catch {}
    const night = updateNight();
    if (!night || updateState().night === night || !UPDATE_KEYS.length) return;
    startUpdate({})?.then(outcome => { if (outcome && outcome.result !== "busy") noteUpdate({ night }); });
  };
  try { fs.rmSync(UPDATE_SETTINGS, { force: true }); } catch {}
  setTimeout(nightly, 60_000);
  setInterval(nightly, 600_000);
  setInterval(() => {
    if (current?.welcomed) announce(current, readEngineFile).catch(() => {});
    else refreshOwn(readEngineFile).catch(() => {});
  }, 60_000);
  setInterval(() => {
    if (current?.welcomed) lastWelcomed = Date.now();
    try { sendOutbox(current ?? { send() {} }, undefined, Date.now(), current?.welcomed ? 0 : Date.now() - lastWelcomed); } catch {}
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
    case "adopt": {
      let seed = null;
      try { seed = JSON.parse((await input()) || "null"); } catch {}
      return say(adoptBox(seed));
    }
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
    case "update-auto":
      // (An older Mac's switch.)
      return say({ status: 400, message: ALWAYS_UPDATES });
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
    case "bot-keys-refresh":
      // Its bots' folders' settings as their keys and this machine's integrations are now.
      refreshBotsKeys();
      return say({ status: 200 });
    case "personalities": {
      // A Mac's copy met with this one's: both end up as one.
      let given = null;
      try { given = JSON.parse((await input()) || "null"); } catch {}
      return say({ status: 200, ...changePersonalities(library => mergePersonalities(library, timelyPersonalities(given))) });
    }
    default:
      console.error("Usage: kuvo-link.js box adopt | read | change | key <name> | route | bot-keys-refresh | personalities | update-status | update-auto | update-now");
      process.exit(2);
  }
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
    console.error("setup takes JSON on stdin: {relay, name, phones: [{key, name, address}]}");
    process.exit(2);
  }
  const phones = Array.isArray(input.phones) ? input.phones : [];
  const mac = typeof input.mac === "string" ? input.mac : undefined;
  const running = runningBridge();
  const old = readLink();
  let link = null;
  updateLink(current => {
    const next = current ?? { secret: crypto.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), phones: [] };
    // The Mac's key, which a phone list it mails later must come from, and its list, unless one it
    // sent later came first (by mail, as this was on its way).
    const at = typeof input.at === "number" ? input.at : 0;
    const by = mac ?? next.mac;
    // Its phones, when it gives them (with the phone link off it gives none, and changes none).
    if (Array.isArray(input.phones) && (!by || at > lastFrom(next, by))) {
      takeMacList(next, phones, input.removed, by);
      if (by) next.macAts = { ...(next.macAts ?? {}), [by]: at };
    }
    if (mac) {
      next.mac = mac;
      next.macs = [...new Set([...macsOf(next), mac])];
      forgetOldMacs(next, mac);
      // Its peers: itself and its other machines.
      if (Array.isArray(input.peers)) takePeers(next, mac, input.peers, typeof input.peersAt === "number" ? input.peersAt : at, input.moved);
    }
    if (typeof input.id === "string") next.id = input.id.slice(0, 200);
    // Whether this Mac leaves a newer box as it is, by its ID (as its engine launches name it): the
    // box updates itself only while every Mac that started its engine lately does (PROTOCOL.md, "Updates").
    if (typeof input.macID === "string" && /^[A-Za-z0-9-]{1,100}$/.test(input.macID)) next.tolerantIDs = { ...(next.tolerantIDs ?? {}), [input.macID]: input.tolerates === 1 };
    if (!next.phones.length && !peersOf(next).length) return current ? next : null;
    next.relay = String(input.relay);
    next.name = String(input.name || next.name || os.hostname()).slice(0, 100);
    link = next;
    return next;
  });
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
  }));
}

// `leave <mac>`: Mac `mac` removed this machine. It's no longer one of its Macs: its lists of
// peers and phones no longer count here, and what peers only it named told goes. Another Mac's
// stay; with no peers or phones left, the bridge stops.
export function leave(mac) {
  if (typeof mac !== "string" || !KEY.test(mac)) return false;
  const link = updateLink(link => {
    if (!link || !macsOf(link).includes(mac)) return null;
    link.macs = macsOf(link).filter(each => each !== mac);
    if (link.mac === mac) {
      if (link.macs.length) link.mac = link.macs[0];
      else delete link.mac;
    }
    for (const field of ["macSeen", "macAts", "peersFrom"]) if (link[field]) delete link[field][mac];
    for (const phone of link.phones ?? []) if (phone.mac === mac) delete phone.mac;
    return link;
  });
  if (!link) return false;
  const keep = new Set(peersOf(link).map(peer => peer.key));
  locked(PEER_LOCK, () => {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(PEER_AGENTS_FILE, "utf8")); } catch { return; }
    for (const key of Object.keys(all)) if (!keep.has(key)) delete all[key];
    writePrivate(PEER_AGENTS_FILE, JSON.stringify(all));
  });
  try { if (JSON.parse(fs.readFileSync(MAC_AGENTS_FILE, "utf8"))?.key === mac) fs.rmSync(MAC_AGENTS_FILE, { force: true }); } catch {}
  writeAgents(link);
  return true;
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
    console.error("Usage: kuvo-link.js run | setup | pair [relay] | box <command> | leave <mac> | update [--now] | selftest");
    process.exit(2);
  }
}
