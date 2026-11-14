// Which keeper of the browser runs on a machine, now that its version is a hash the box's build
// writes (KEEPER in box/src/browser/kuvo-browser.js): one from before, or of another build,
// gives way to the file in place; the same build is left running; and a process started before its
// file was replaced (an update) leaves the running keeper be. The live view (`kuvo-browser.js
// connect`, as the Mac runs it over SSH) meets a stand-in keeper on the keeper's socket.
//
// Run with `node --test box/bridge-tests/browser-keeper-version.test.js`.

import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const built = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const KEEPER = /^const KEEPER = "([0-9a-f]{12})";$/m.exec(fs.readFileSync(built, "utf8"))?.[1];

/** A box's folder (short: the keeper's socket is in it), with a keeper on its socket that says
 * `hello` to whoever gives the key, and stops when asked; `keyed` is told of each one first. */
async function machine(hello, keyed = () => {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvv-")));
  removeAtEnd(home);
  fs.mkdirSync(path.join(home, "run"), { mode: 0o700 });
  const sockets = new Set();
  let stopped;
  const stop = new Promise((resolve) => (stopped = resolve));
  const keeper = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.method === "Kuvo.key") {
          keyed();
          socket.write(JSON.stringify({ method: "Kuvo.hello", params: { targetId: null, viewers: 1, held: [], ...hello } }) + "\n");
        } else if (message.method === "Kuvo.stop") {
          keeper.close();
          for (const each of sockets) each.destroy();
          stopped(true);
        }
      }
    });
  });
  await new Promise((resolve) => keeper.listen(path.join(home, "run", "browser.sock"), resolve));
  atEnd(() => {
    keeper.close();
    for (const each of sockets) each.destroy();
  });
  return { home, stop };
}

/** The live view, from `script` (the built file by default): what it says first. */
function liveView(home, script = built) {
  const view = spawn(process.execPath, [script, "connect"], { env: { ...process.env, KUVO_HOME: home, HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  atEnd(() => view.kill());
  return new Promise((resolve) => {
    let out = "";
    view.stdout.setEncoding("utf8");
    view.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
    });
  });
}

test("the built file has its keeper's version written in", () => {
  assert.match(KEEPER ?? "", /^[0-9a-f]{12}$/);
});

test("a keeper from before its version was a hash gives way", async () => {
  const { home, stop } = await machine({ keeper: 50 });
  liveView(home);
  assert.equal(await stop, true);
});

test("a keeper of another build gives way to the file in place", async () => {
  const { home, stop } = await machine({ keeper: 51, build: "000000000000" });
  liveView(home);
  assert.equal(await stop, true);
});

test("the same build is left running", async () => {
  let asked = false;
  const { home, stop } = await machine({ keeper: 51, build: KEEPER });
  stop.then(() => (asked = true));
  const first = await liveView(home);
  assert.equal(first.method, "Kuvo.hello");
  assert.equal(first.params.build, KEEPER);
  assert.equal(asked, false);
});

test("a process whose file was replaced since it started leaves another build running", async () => {
  // Its file, replaced by an update's (another KEEPER) once it's running, as it asks the keeper.
  let asked = false, replaced = false;
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvv-bin-")));
  removeAtEnd(holder);
  const script = path.join(holder, "kuvo-browser.js");
  fs.copyFileSync(built, script);
  const { home, stop } = await machine({ keeper: 51, build: "eeeeeeeeeeee" }, () => {
    if (replaced) return;
    replaced = true;
    fs.writeFileSync(script, fs.readFileSync(built, "utf8").replace(`const KEEPER = "${KEEPER}";`, 'const KEEPER = "ffffffffffff";'));
  });
  stop.then(() => (asked = true));
  const first = await liveView(home, script);
  assert.equal(replaced, true);
  assert.equal(first.method, "Kuvo.hello");
  assert.equal(first.params.build, "eeeeeeeeeeee");
  assert.equal(asked, false);
});
