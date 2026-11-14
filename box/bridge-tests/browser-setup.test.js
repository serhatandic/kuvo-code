// A machine with no Mac gets its browser by itself (PROTOCOL.md, "The browser on a machine"): the
// first time the browser's needed (the Mac's live view here, `kuvo-browser.js connect`, or an
// agent's tool, `mcp`), its box (`kuvo-link.js browser install`, the real one, as built) downloads
// Chrome for Testing and what it needs from stand-ins served here (browser-source-stand-in.js),
// checks it, puts it in place, and the browser starts: Chrome a stand-in that answers each request
// with nothing. With no network, a tool says why, plainly.
//
// Run with `node --test box/bridge-tests/browser-setup.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { makeRpm, makeZip, served, startSource } from "./browser-source-stand-in.js";

const script = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const link = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const kind = os.arch() === "arm64" ? "aarch64" : "x86_64";

/** A machine's folder with nothing in it but the box's script, as a box set up without a Mac has it. */
function freshMachine() {
  // (Short: the keeper's socket is in it.)
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kbs-")));
  removeAtEnd(home);
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.copyFileSync(link, path.join(home, "bin", "kuvo-link.js"));
  atEnd(() => {
    // The keeper, in a session of its own.
    try { process.kill(Number(fs.readFileSync(path.join(home, "run", "browser.pid"), "utf8")), "SIGKILL"); } catch {}
  });
  return home;
}

/** Chrome for Testing as the stand-in serves it: Chrome answers each request on its pipe with nothing. */
function chromeZip(home) {
  const chrome = path.join(home, "chrome-stand-in.js");
  fs.writeFileSync(chrome, `const fs = require("node:fs");
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
  return makeZip([
    { name: "chrome-linux64/chrome", data: `#!/bin/sh\nBUN_BE_BUN=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(chrome)}\n`, mode: 0o755, deflate: true },
    { name: "chrome-linux64/LICENSE", data: "license" },
  ]);
}

async function source(home, answer) {
  const zip = chromeZip(home);
  const { pins, files } = served({ linux: { version: "155.0.0.9", x86_64: zip, aarch64: zip, packages: { [kind]: [{ name: "libfoo", rpm: makeRpm([{ name: "./usr/lib64/libfoo.so.1", data: "foo", mode: 0o755 }]) }] } } });
  fs.writeFileSync(path.join(home, "pins.json"), JSON.stringify(pins));
  const started = await startSource(files, answer);
  atEnd(() => started.close());
  return { ...started, env: { ...process.env, KUVO_HOME: home, HOME: home, KUVO_BROWSER_IDLE: "600", KUVO_BROWSER_SOURCE: started.url, KUVO_BROWSER_PINS: path.join(home, "pins.json"), KUVO_BROWSER_SYSTEM: "linux" } };
}

test("a fresh machine with no Mac gets a checked browser by itself the first time it's needed", { timeout: 120_000 }, async () => {
  const home = freshMachine();
  const { env, asked } = await source(home);
  // The live view, as a Mac runs it: it hears the setup as it goes, then the browser's hello.
  const view = spawn(process.execPath, [script, "connect"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const heard = await new Promise((resolve, reject) => {
    const all = [];
    let out = "";
    view.stdout.setEncoding("utf8");
    view.stdout.on("data", chunk => {
      out += chunk;
      let end;
      while ((end = out.indexOf("\n")) >= 0) {
        const message = JSON.parse(out.slice(0, end));
        out = out.slice(end + 1);
        all.push(message);
        if (message.method === "Kuvo.hello" || message.method === "Kuvo.error") resolve(all);
      }
    });
    view.on("exit", () => reject(new Error(`the live view ended: ${JSON.stringify(all)}`)));
  });
  view.kill();
  const last = heard[heard.length - 1];
  assert.equal(last.method, "Kuvo.hello", JSON.stringify(heard));
  assert.ok(heard.some(message => message.method === "Kuvo.installing"), "it said the browser was being set up");
  // In place, whole, from the stand-ins only, as pinned.
  const build = fs.realpathSync(path.join(home, "browser", "current"));
  assert.equal(fs.readFileSync(path.join(build, "chromium-version"), "utf8").trim(), "155.0.0.9");
  assert.equal(fs.readFileSync(path.join(build, "lib", "libfoo.so.1"), "utf8"), "foo");
  assert.equal(asked.length, 2, JSON.stringify(asked));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "run", "browser-install.json"), "utf8")).state, "ready");
  assert.deepEqual(fs.readdirSync(path.join(home, "browser")).filter(name => name.startsWith(".")), [], "nothing left of its setup");
});

test("with no network, an agent's browser tool says why, and the box tries again later", { timeout: 120_000 }, async () => {
  const home = freshMachine();
  const { env, close } = await source(home);
  await close();
  const tools = spawn(process.execPath, [script, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  atEnd(() => tools.kill("SIGKILL"));
  const answer = await new Promise(resolve => {
    let out = "";
    tools.stdout.setEncoding("utf8");
    tools.stdout.on("data", chunk => {
      out += chunk;
      for (const line of out.split("\n").filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.id === 2) resolve(message);
      }
    });
    tools.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    tools.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "example.com" } } }) + "\n");
  });
  tools.kill();
  const text = answer.result?.content?.[0]?.text ?? "";
  assert.equal(answer.result?.isError, true, JSON.stringify(answer));
  assert.match(text, /Couldn't reach storage\.googleapis\.com/);
  assert.match(text, /tries again/);
  const state = JSON.parse(fs.readFileSync(path.join(home, "run", "browser-install.json"), "utf8"));
  assert.equal(state.state, "failed");
  assert.ok(state.retryAt > Date.now());
  assert.equal(fs.existsSync(path.join(home, "browser", "current")), false);
  assert.deepEqual(fs.readdirSync(path.join(home, "browser")).filter(name => name.startsWith(".box-staging")), []);
});
