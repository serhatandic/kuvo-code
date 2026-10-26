// @ts-nocheck
// The host: answers paired phones' sessions (PROTOCOL.md, "Sessions"; the Mac app's LinkServer, in
// JavaScript): their handshakes, requests, streams and sockets.

import { EMPTY } from "../crypto/keys";
import { IKResponder, PROLOGUE } from "../crypto/noise";
import { decodeMessage, encodeMessage, Frame, frame, pieces, readFrame, relaySend } from "./frames";

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
