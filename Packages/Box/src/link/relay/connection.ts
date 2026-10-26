// @ts-nocheck
// The relay connection

import { addressOf, EMPTY } from "../crypto/keys";
import { docsChanged } from "../documents/exchange";
import { readEngineFile } from "../engine/client";
import { announce } from "../peers/agents";
import { confirmUpdate } from "../updates/update";
import { readRelay, relayHello, relaySend } from "./frames";

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