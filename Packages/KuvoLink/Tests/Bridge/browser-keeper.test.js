// The browser's keeper on a machine (`kuvo-browser.js host`) answers only Kuvo Code's own
// processes: an agent's command in the sandbox can connect to its socket (Linux's sandbox doesn't
// hide a socket from connecting) but can't read the box's socket key, so it can't drive the browser,
// stop it, answer what it asks you, or hear what it asks. The real keeper, started by the live view
// (`kuvo-browser.js connect`, as the Mac runs it over SSH); Chromium is a stand-in that answers
// each request with nothing.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/browser-keeper.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

// (Short: the keeper's socket is in it.)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvk-")));
const script = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const env = { ...process.env, KUVO_HOME: home, HOME: home, KUVO_BROWSER_IDLE: "600" };
const socketFile = path.join(home, "run", "browser.sock");

// Chromium: the pipe it's driven over (fd 3 in, fd 4 out), each request answered with nothing.
const build = path.join(home, "browser", "build-1");
fs.mkdirSync(build, { recursive: true });
fs.symlinkSync(build, path.join(home, "browser", "current"));
// (Through a shell: the keeper starts it without BUN_BE_BUN, which the engine's Bun needs to be one.)
fs.writeFileSync(path.join(build, "chrome.js"), `const fs = require("node:fs");
const output = fs.createWriteStream(null, { fd: 4 });
let buffer = "";
fs.createReadStream(null, { fd: 3, encoding: "utf8" }).on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }) + "\\0");
  }
});
`);
fs.writeFileSync(path.join(build, "chrome"), `#!/bin/sh\nBUN_BE_BUN=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(build, "chrome.js"))}\n`, { mode: 0o755 });

removeAtEnd(home);
atEnd(() => {
  // The keeper the live view started, in a session of its own.
  try { process.kill(Number(fs.readFileSync(path.join(home, "run", "browser.pid"), "utf8")), "SIGKILL"); } catch {}
});

const reachable = () => new Promise(resolve => {
  const socket = net.createConnection(socketFile);
  socket.on("connect", () => { socket.destroy(); resolve(true); });
  socket.on("error", () => resolve(false));
});

// The live view, as the Mac runs it over SSH (Kuvo Code's own, which reads the key): it starts the
// keeper when none runs. What it hears first.
async function liveView() {
  const view = spawn(process.execPath, [script, "connect"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const first = await new Promise(resolve => {
    let out = "";
    view.stdout.setEncoding("utf8");
    view.stdout.on("data", chunk => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
    });
  });
  view.kill();
  return first;
}

// Everything a process that isn't Kuvo Code's own hears, sending `text`, until the keeper hangs up.
const fromOutside = (text) => new Promise(resolve => {
  const socket = net.createConnection(socketFile);
  let heard = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(text));
  socket.on("data", chunk => { heard += chunk; });
  socket.on("error", () => {});
  socket.on("close", () => resolve(heard.split("\n").filter(Boolean).map(line => JSON.parse(line))));
});
const sending = (...messages) => fromOutside(messages.map(message => JSON.stringify(message) + "\n").join(""));

// Only that it can't, as an older Kuvo Code's live view shows it: nothing of the browser.
const refused = (heard, why) => {
  assert.equal(heard.length, 1, `${why}: ${JSON.stringify(heard)}`);
  assert.equal(heard[0].method, "Kuvo.error", why);
  assert.match(heard[0].params.message, /Update Kuvo Code/, why);
};

test("a process without the box's socket key hears nothing from the machine's browser and can't drive or stop it", { timeout: 60_000 }, async () => {
  const hello = await liveView();
  assert.equal(hello.method, "Kuvo.hello", JSON.stringify(hello));
  assert.equal(typeof hello.params.keeper, "number");

  refused(await sending({ id: 1, method: "Target.getTargets" }), "no answer, not even the keeper's hello");
  refused(await sending({ method: "Kuvo.key", params: { key: "guessed" } }, { id: 1, method: "Target.getTargets" }), "a wrong key is none");
  refused(await sending({ method: "Kuvo.stop" }), "can't stop it");
  refused(await fromOutside("x".repeat(8192)), "a first line too long to be a key");
  refused(await fromOutside("\n" + "x".repeat(8192)), "nor after an empty line");
  // One that goes on sending after it's refused still hears why (the keeper reads and drops the
  // rest, rather than hanging up on it unread).
  refused(await fromOutside("x".repeat(1 << 20)), "while it goes on sending");
  assert.ok(await reachable(), "it's still running");
  assert.equal((await liveView()).method, "Kuvo.hello", "and Kuvo Code's own still reach it");
});
