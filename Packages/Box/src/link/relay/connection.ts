// The relay connection: one at a time, served until it ends.

import { addressOf, EMPTY } from "../crypto/keys";
import { notePushed } from "../notices/push";
import { noteUnreachable } from "../peers/reach";
import { readRelay, relayHello, relaySend } from "./frames";
import type { RelayMessage } from "./frames";
import type { LinkHost } from "./host";

// What the relay sends once it's welcomed this connection, for `host`: something for it, or a phone
// gone (unreachable, or its connection went or was replaced), whose sessions end with nothing more
// sent; another of your computers unreachable is noted for its tools to say so (`peers/reach.ts`);
// how a push to a phone went, kept (`notices/push.ts`). What this connection sends itself, to check
// it's alive, is only that.
export function fromRelay(host: Pick<LinkHost, "receive" | "forget">, message: RelayMessage, self: Buffer): void {
  if (message.address.equals(self)) return;
  if (message.kind === "deliver") host.receive(message.address, message.payload);
  if (message.kind === "unreachable" || message.kind === "gone") host.forget(message.address);
  if (message.kind === "unreachable") noteUnreachable(message.address);
  if (message.kind === "pushed") notePushed(message.address, message.status);
}

// After a relay connection, how many tries in a row haven't held, and how long to wait before the
// next. Well only once one held a minute: one dropped right after its welcome (another copy on the
// same address, the relay saying far too much too fast) backs off as one that never came up does,
// rather than coming back each second.
export function nextTry(attempt: number, welcomed: boolean, heldFor: number): { attempt: number; wait: number } {
  const next = welcomed && heldFor >= 60_000 ? 0 : attempt + 1;
  return { attempt: next, wait: Math.min(60_000, 1000 * 2 ** Math.min(next, 6)) };
}

// Connects once, serves until the connection ends (or `host.disconnect()`). Resolves whether it got
// as far as welcome. `onWelcome(host)`: what's done then (a machine's `run` says, `machineWelcomed`).
export function connectOnce(relay: string, secret: Buffer, host: LinkHost, onWelcome: (host: LinkHost) => void = () => {}): Promise<boolean> {
  return new Promise<boolean>(resolve => {
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
        host.send = (bytes: Buffer) => {
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