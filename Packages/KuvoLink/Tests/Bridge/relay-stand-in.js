// A relay for the bridge's tests, on 127.0.0.1: the relay's messages (PROTOCOL.md, "The relay") over
// a WebSocket, as the real one speaks them, for a bridge connecting with `connectOnce`; and devices
// in this process (a phone, a machine) on it too, without a socket. It delivers, says who's
// unreachable, keeps what was pushed and, when a test says so, answers each push as the relay does.
// Nothing else of the real relay (Apple, limits) is here.
import crypto from "node:crypto";
import http from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// What goes to a WebSocket client: one binary frame, unmasked.
function wsFrame(payload, opcode = 0x2) {
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([head, payload]);
}

// Whole frames from what a client sent (masked, as clients send them), and what's left over.
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length < at + 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length < at + 8) break;
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    const mask = masked ? buffer.subarray(at, at + 4) : null;
    if (masked) at += 4;
    if (buffer.length < at + length) break;
    const payload = Buffer.from(buffer.subarray(at, at + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    offset = at + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// `changed`: called each time what it keeps changes (a device on it or gone, a push), for a test waiting on it.
export async function relayStandIn({ addressOf }, { changed: told = () => {} } = {}) {
  // What waits for devices to say their close back (`closing`).
  const waitingForClose = [];
  const changed = () => {
    for (const wake of waitingForClose.splice(0)) wake();
    told();
  };
  // Who's on it, by address (hex): how to give each what comes for it.
  const devices = new Map();
  const pushed = [];
  const delivered = [];
  // What it answers a push with (`answers.push`: 0 sent, 1 no phone, 2 not allowed, 3 refused);
  // nothing until a test sets it.
  const answers = { push: null };
  // Each connection, and what it knows of its device.
  const sockets = new Map();
  const deliver = (from, to, payload) => {
    const device = devices.get(to.toString("hex"));
    if (!device) return devices.get(from.toString("hex"))?.(Buffer.concat([Buffer.from([3]), to]));
    device(Buffer.concat([Buffer.from([2]), from, payload]));
    delivered.push({ from: Buffer.from(from), to: Buffer.from(to), payload: Buffer.from(payload) });
    changed();
  };
  // A device's message to the relay, from `from` (null before its hello).
  const take = (message, state, give) => {
    const kind = message[0];
    if (kind === 1 && message.length === 33 && !state.address) {
      state.address = addressOf(message.subarray(1));
      devices.set(state.address.toString("hex"), give);
      give(Buffer.concat([Buffer.from([1]), state.address]));
      changed();
      return;
    }
    if (!state.address) return;
    if (kind === 2 && message.length >= 17) return deliver(state.address, message.subarray(1, 17), message.subarray(17));
    if (kind === 5 && message.length >= 17) {
      pushed.push({ from: state.address, to: Buffer.from(message.subarray(1, 17)), payload: Buffer.from(message.subarray(17)) });
      // How it went, as the real relay answers (`0x06`), once a test says what to answer.
      if (typeof answers.push === "number") give(Buffer.concat([Buffer.from([6]), message.subarray(1, 17), Buffer.from([answers.push])]));
      changed();
    }
  };
  const server = http.createServer((_request, response) => response.writeHead(426).end());
  server.on("upgrade", (request, socket) => {
    const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const state = { address: null };
    sockets.set(socket, state);
    const give = bytes => { if (!socket.destroyed) socket.write(wsFrame(bytes)); };
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          // Closing half way (`closing`): the device's close is heard, and the connection kept.
          if (state.closing) {
            state.closeHeard = true;
            changed();
            return;
          }
          return socket.end(wsFrame(Buffer.alloc(0), 0x8));
        }
        if (opcode === 0x9) { socket.write(wsFrame(payload, 0xa)); continue; }
        if (opcode === 0x2) take(payload, state, give);
      }
    });
    const gone = () => {
      sockets.delete(socket);
      if (state.address && devices.get(state.address.toString("hex")) === give) devices.delete(state.address.toString("hex"));
      changed();
    };
    // (A device's process ending, with no word first: as the real relay sees it, it's gone.)
    socket.on("end", () => socket.destroy());
    socket.on("close", gone);
    socket.on("error", gone);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    pushed,
    answers,
    // What it gave a device on it, from another (in order).
    delivered,
    // Whether a device is on it at `address`.
    has: address => devices.has(address.toString("hex")),
    // A device in this process: what comes for it, in order (`next`), and what it sends.
    device(secret = crypto.randomBytes(32)) {
      const inbox = [];
      const waiting = [];
      const state = { address: null };
      const give = bytes => {
        const resolve = waiting.shift();
        if (resolve) resolve(bytes); else inbox.push(bytes);
      };
      take(Buffer.concat([Buffer.from([1]), secret]), state, give);
      inbox.shift();
      return {
        address: state.address,
        send: (to, payload) => take(Buffer.concat([Buffer.from([2]), to, payload]), state, give),
        next: (ms = 5000) => new Promise((resolve, reject) => {
          if (inbox.length) return resolve(inbox.shift());
          waiting.push(resolve);
          setTimeout(() => reject(new Error("nothing arrived")), ms).unref();
        }),
        leave: () => devices.delete(state.address.toString("hex")),
      };
    },
    // Every connection dropped (the relay restarting).
    drop() {
      for (const socket of sockets.keys()) socket.destroy();
    },
    // Every connection starts closing (the relay says so) and isn't let go: each device, once it
    // hears it, is left with a connection that's closing, until `drop`. Resolves once each device
    // said its close back.
    async closing() {
      const all = [...sockets.entries()];
      for (const [socket, state] of all) {
        state.closing = true;
        socket.write(wsFrame(Buffer.alloc(0), 0x8));
      }
      while (!all.every(([, state]) => state.closeHeard)) await new Promise(resolve => waitingForClose.push(resolve));
    },
    close: () => new Promise(resolve => {
      for (const socket of sockets.keys()) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
