// The host: answers paired phones' sessions (PROTOCOL.md, "Sessions"; the Mac app's LinkServer, in
// JavaScript): their handshakes, requests, streams and sockets.

import { EMPTY } from "../crypto/keys";
import { IKResponder, PROLOGUE } from "../crypto/noise";
import type { Transport } from "../crypto/noise";
import type { Answer, AnyPiece, Asker, LinkRequest } from "../server/context";
import { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, relaySend } from "./frames";
import type { Head } from "./frames";

/** What a phone says as its session opens (PROTOCOL.md, "Sessions"): `pair` only while pairing. */
export interface PhoneHello {
  v: 1;
  name?: string;
  app?: string;
  pair?: string;
}

/** What this box says back: what it is (`machine` or `mac`), its name, and its bridge's and engine's versions. */
export interface BoxHello {
  v: 1;
  kind: "machine" | "mac";
  name: string;
  app: string;
  engine: string | null;
}

/** A phone with a session here: its static key, the name it gave, and where it is on the relay. */
export type SessionPhone = Required<Asker>;

/** A socket opened for a phone, as the box's side gives it: what the phone sends, and its end. */
export interface SocketHandle {
  send: (data: Buffer) => void;
  close: () => void;
}

/** What the box's side of a socket tells the phone: it's open, a message either way, its end. */
export interface SocketEvents {
  open: () => void;
  text: (data: Buffer) => void;
  binary: (data: Buffer) => void;
  end: (error?: Error) => void;
}

/** What a LinkHost is made with (each said in the constructor's comment). */
export interface LinkHostOptions {
  key: Buffer;
  hello: BoxHello;
  authorize: (key: Buffer, hello: PhoneHello, address: Buffer) => boolean | Promise<boolean>;
  handle: (request: LinkRequest, phone: SessionPhone, signal: AbortSignal) => Answer;
  connect?: (request: LinkRequest, phone: SessionPhone, events: SocketEvents) => SocketHandle;
  send: (bytes: Buffer) => boolean | void;
  confirmed?: (phone: SessionPhone) => void;
  mail?: (from: Buffer, body: Buffer, frame: Buffer) => void;
}

/** A message's head from a phone, as this host reads it (PROTOCOL.md, "Messages in a session"). */
interface PhoneHead {
  t?: "req" | "data" | "cancel" | "ping";
  id: number;
  /** As the phone sent them: each read only for what it is (`requestOf`). */
  m?: unknown;
  p?: unknown;
  h?: unknown;
  end?: boolean;
}

// A request as a phone's head says it: its method and path only when they're text, its headers
// only when they're an object (a path that isn't text is then refused, as one that isn't what it
// seems).
const requestOf = (head: PhoneHead, body: Buffer): LinkRequest => ({
  method: typeof head.m === "string" ? head.m : "GET",
  path: typeof head.p === "string" ? head.p : "",
  headers: head.h !== null && typeof head.h === "object" && !Array.isArray(head.h) ? (head.h as LinkRequest["headers"]) : {},
  body,
});

/** One of a session's sockets: the box's side once it's made, and whether it's opened yet. */
interface SessionSocket {
  handle: SocketHandle | null;
  opened: boolean;
}

/** One phone's session: where it is, its number on the relay, its keys, and what it has under way by id. */
interface PhoneSession {
  id: string;
  from: Buffer;
  number: number;
  phone: SessionPhone;
  transport: Transport;
  /** Requests whose body is still coming. */
  incoming: Map<number, LinkRequest>;
  running: Map<number, AbortController>;
  sockets: Map<number, SessionSocket>;
  confirmed?: boolean;
}

export class LinkHost {
  declare key: Buffer;
  declare hello: BoxHello;
  declare authorize: LinkHostOptions["authorize"];
  declare handle: LinkHostOptions["handle"];
  declare connect: LinkHostOptions["connect"];
  declare send: LinkHostOptions["send"];
  declare confirmed: LinkHostOptions["confirmed"];
  declare mail: LinkHostOptions["mail"];
  declare sessions: Map<string, PhoneSession>;
  /** While the relay has welcomed this host's connection (relay/connection.ts sets these three). */
  declare welcomed?: boolean;
  /** Ends its relay connection. */
  declare disconnect?: () => void;
  /** What's queued for the relay and not sent yet, in bytes. */
  declare unsent?: () => number;

  // authorize(key, hello, address) → whether to let the phone in; handle(request, phone, signal) → an
  // async iterable of { head: { status, headers } } and { body }; connect(request, phone,
  // { open, text, binary, end }) → a socket's { send, close } (PROTOCOL.md, "Sockets");
  // send(bytes) → to the relay; confirmed(phone) → its session proved its own: its first message
  // opened with the handshake's keys, which a replayed first handshake message can't do.
  // mail(from, body, frame) → a mail frame sent to this machine (its Mac's phone list).
  constructor({ key, hello, authorize, handle, connect, send, confirmed, mail }: LinkHostOptions) {
    Object.assign(this, { key, hello, authorize, handle, connect, send, confirmed, mail });
    this.sessions = new Map();
  }

  // The relay connection dropped: what was under way is gone.
  reset() {
    for (const session of this.sessions.values()) this.end(session, false);
  }

  get active(): number { return this.sessions.size; }

  // A phone the relay can't reach any more (asleep, gone), or whose relay connection the relay says
  // went or was replaced (it ended its sessions with it): what it asked for has nobody to go to.
  // While this host's own relay connection stays up, a session ends only with the phone told, or
  // by the phone's own doing: phones count on that rather than checking before each request
  // (PROTOCOL.md, "The relay").
  forget(address: Buffer) {
    for (const session of this.sessions.values()) if (session.from.equals(address)) this.end(session, false);
  }

  // Phones no longer paired (removed on the Mac) lose the sessions they have open.
  keepOnly(keys: Set<string>) {
    for (const session of this.sessions.values()) if (!keys.has(session.phone.key.toString("base64url"))) this.end(session, true);
  }

  async receive(from: Buffer, payload: Buffer) {
    try {
      await this.receiveFrame(from, payload);
    } catch {
      // Nothing a phone sends gets to stop the bridge.
    }
  }

  async receiveFrame(from: Buffer, payload: Buffer) {
    const parsed = readFrame(payload);
    if (!parsed) return;
    const id = `${from.toString("base64url")}:${parsed.session}`;
    const session = this.sessions.get(id);
    switch (parsed.kind) {
      case Frame.handshake1:
        return this.handshake(from, parsed.session, id, parsed.body);
      case Frame.transport: {
        if (!session) return this.send(relaySend(from, frame(Frame.close, parsed.session)));
        let message: { head: unknown; body: Buffer } | null;
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
        return this.message(session, message as { head: PhoneHead; body: Buffer });
      }
      case Frame.close:
        if (session) this.end(session, false);
        return;
      case Frame.mail:
        // (And the frame whole, for this Mac's box to hand its app.)
        return this.mail?.(from, parsed.body, payload);
    }
  }

  async handshake(from: Buffer, number: number, id: string, body: Buffer) {
    const refuse = () => this.send(relaySend(from, frame(Frame.close, number)));
    const responder = new IKResponder(this.key, PROLOGUE);
    let hello: PhoneHello | null;
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

  message(session: PhoneSession, { head, body }: { head: PhoneHead; body: Buffer }) {
    switch (head.t) {
      case "req": {
        const request = requestOf(head, body);
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
        request.body = Buffer.concat([request.body!, body]);
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

  run(session: PhoneSession, id: number, request: LinkRequest) {
    const controller = new AbortController();
    session.running.set(id, controller);
    const live = () => !controller.signal.aborted && this.sessions.get(session.id) === session;
    const reply = (head: Head, body: Buffer, end: boolean) => {
      if (!live()) return;
      for (const piece of pieces(head, body, end)) this.seal(session, piece);
    };
    (async () => {
      let head: Head | null = null;
      let started = false;
      try {
        for await (const part of this.handle(request, session.phone, controller.signal) as AsyncIterable<AnyPiece> | Iterable<AnyPiece>) {
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
        if (!started) reply({ t: "res", id, s: 502, h: { "content-type": "text/plain" } }, Buffer.from(String((error as Error | undefined)?.message ?? error)), true);
        else this.seal(session, encodeMessage({ t: "cancel", id }));
      } finally {
        if (session.running.get(id) === controller) session.running.delete(id);
      }
    })();
  }

  // A socket: open once the engine's is, then messages both ways until either side ends it.
  open(session: PhoneSession, id: number, request: LinkRequest) {
    const socket: SessionSocket = { handle: null, opened: false };
    session.sockets.set(id, socket);
    const live = () => this.sessions.get(session.id) === session && session.sockets.get(id) === socket;
    const reply = (head: Head, body: Buffer, end: boolean) => {
      if (!live()) return;
      for (const piece of pieces(head, body, end)) this.seal(session, piece);
    };
    const end = (error?: Error) => {
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

  seal(session: PhoneSession, plaintext: Buffer) {
    this.send(relaySend(session.from, frame(Frame.transport, session.number, session.transport.seal(plaintext))));
  }

  end(session: PhoneSession, notify: boolean) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    for (const controller of session.running.values()) controller.abort();
    session.running.clear();
    for (const socket of session.sockets.values()) socket.handle?.close();
    session.sockets.clear();
    if (notify) this.send(relaySend(session.from, frame(Frame.close, session.number)));
  }
}
