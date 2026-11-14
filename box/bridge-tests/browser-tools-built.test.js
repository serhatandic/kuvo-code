// What an agent on a machine is given by the browser's tools (box/dist/kuvo-browser.js
// `mcp`, as the engine starts them), now that the box builds that file from its sources
// (box/src/browser, scripts/build-browser.sh): the same tools, schemas and instructions,
// byte for byte, as when the app filled them in (browser-tools-before.json), with the vault closed
// and open; and the same scripts run in pages.
//
// A change to the tools, their words or the page scripts on purpose replaces what's kept: run this
// with KUVO_TEST_BROWSER_TOOLS=write, and say why in the commit.
//
// Run with `node --test box/bridge-tests/browser-tools-built.test.js`.

import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../dist/kuvo-browser.js", import.meta.url));
const keptFile = fileURLToPath(new URL("./browser-tools-before.json", import.meta.url));
let kept = JSON.parse(fs.readFileSync(keptFile, "utf8"));

// The box's route, as `kuvo-link.js box route` answers it: the vault's tools (one, so the vault is
// open to agents), and nothing else.
const BOX_ROUTE = `const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
  if (process.argv.slice(2).join(" ") !== "box route") process.exit(1);
  const asked = JSON.parse(Buffer.concat(chunks).toString());
  const answer = asked.path === "kuvo/vault/tools"
    ? { status: 200, body: JSON.stringify({ tools: [{ name: "vault_items", description: "Lists them.", inputSchema: { type: "object", properties: {} } }] }) }
    : { status: 404, body: "{}" };
  process.stdout.write(JSON.stringify(answer) + "\\n");
});
`;

/** What the tools say as the engine starts them (`initialize`, then `tools/list`), on a box of
 * Kuvo Code 0.7.2's files, with the vault `open` to agents or not (no box to ask). */
async function given(open) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-browser-tools-"));
  atEnd(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "box-version"), "0.7.2\n");
  if (open) fs.writeFileSync(path.join(home, "bin", "kuvo-link.js"), BOX_ROUTE);
  const env = { ...process.env, KUVO_HOME: home };
  delete env.KUVO_SESSION;
  const tools = spawn(process.execPath, [script, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
  atEnd(() => tools.kill());
  const replies = new Map();
  let buffer = "";
  tools.stdout.setEncoding("utf8");
  tools.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      replies.get(message.id)?.(message.result);
    }
  });
  const ask = (id, method) => new Promise((resolve) => {
    replies.set(id, resolve);
    tools.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { protocolVersion: "2025-06-18" } }) + "\n");
  });
  const started = await ask(1, "initialize");
  const listed = await ask(2, "tools/list");
  tools.kill();
  return { serverInfo: started.serverInfo, instructions: started.instructions, tools: listed.tools };
}

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** What's kept of `given(false)`: its tools only as the SHA-256 of them as sent, as they're
 * `given(true)`'s but for the vault's (kept whole). */
const keptClosed = (closed) => ({ ...closed, tools: sha256(JSON.stringify(closed.tools)) });

/** The scripts the built file runs in pages, by name, as the SHA-256 of each. */
function pageScripts() {
  const line = fs.readFileSync(script, "utf8").split("\n").find((each) => each.startsWith("const CONFIG = "));
  const { scripts } = JSON.parse(line.slice("const CONFIG = ".length, -1));
  return Object.fromEntries(Object.keys(scripts).sort().map((name) => [name, sha256(scripts[name])]));
}

if (process.env.KUVO_TEST_BROWSER_TOOLS === "write") {
  kept = { about: kept.about, closed: keptClosed(await given(false)), open: await given(true), scripts: pageScripts() };
  fs.writeFileSync(keptFile, JSON.stringify(kept, null, 1) + "\n");
}

test("an agent on a machine is given the same tools, schemas and instructions, byte for byte, with the vault closed", async () => {
  const now = await given(false);
  assert.equal(sha256(JSON.stringify(now.tools)), kept.closed.tools);
  assert.equal(now.instructions, kept.closed.instructions);
  assert.deepEqual(now.serverInfo, kept.closed.serverInfo);
  // (Never the vault's: browser_fill, and browser_sign_in's item, only where it's open.)
  assert.ok(!now.tools.some((tool) => tool.name === "browser_fill"));
});

test("and with the vault open to agents: its fills, and what it's told of them", async () => {
  const now = await given(true);
  assert.equal(JSON.stringify(now.tools), JSON.stringify(kept.open.tools));
  assert.equal(now.instructions, kept.open.instructions);
  assert.ok(now.tools.some((tool) => tool.name === "browser_fill"));
});

test("the scripts it runs in pages are the same", () => {
  assert.deepEqual(pageScripts(), kept.scripts);
});
