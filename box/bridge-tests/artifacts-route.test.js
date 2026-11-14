// What a Mac asks a machine's box over SSH (`box route`) for what its agents made: a route that
// follows something answers with what it says now (its first line) and ends, rather than never
// answering; and a picture's bytes come back whole, not mangled as text, as do bytes that
// aren't text, whatever kind they were sent as.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-artifacts-")));
const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28]);

// The coding agents' bridge, which keeps the record: a list it follows without end, and a picture.
const bridge = http.createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  if (url.pathname === "/api/kuvo/link/artifacts/events") {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(JSON.stringify({ artifacts: [], next: null }) + "\n");
    return; // Never ends, as a followed route doesn't.
  }
  if (url.pathname === "/api/kuvo/link/artifacts/art_0123456789abcdef01234567/versions/1") {
    response.writeHead(200, { "content-type": "image/png", "content-length": String(picture.length) });
    return response.end(picture);
  }
  // A kept file whose kind the bridge doesn't know (a .deb, say) goes as text, whatever its bytes.
  if (url.pathname === "/api/kuvo/link/artifacts/art_0123456789abcdef01234567/versions/2") {
    response.writeHead(200, { "content-type": "text/plain", "content-length": String(picture.length) });
    return response.end(picture);
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end("{}");
});
await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
// A process named as the bridge is, as the box checks it's still that one.
const stand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.writeFileSync(path.join(home, "run", "bridge.json"), JSON.stringify({ pid: stand.pid, port: bridge.address().port, password: "x" }));
removeAtEnd(home);
atEnd(() => {
  stand.kill();
  bridge.closeAllConnections();
  bridge.close();
});

async function route(request) {
  const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(JSON.stringify(request));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("a followed list, asked over SSH, answers with what it says now and ends", async () => {
  const answer = await route({ method: "GET", path: "kuvo/artifacts/events?bot=bot_ada" });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.body), { artifacts: [], next: null });
});

test("a picture's bytes come back whole", async () => {
  const answer = await route({ method: "GET", path: "kuvo/artifacts/art_0123456789abcdef01234567/versions/1" });
  assert.equal(answer.status, 200);
  assert.equal(answer.type, "image/png");
  assert.deepEqual(Buffer.from(answer.bodyBase64, "base64"), picture);
});

test("bytes sent as text that aren't text come back whole too", async () => {
  const answer = await route({ method: "GET", path: "kuvo/artifacts/art_0123456789abcdef01234567/versions/2" });
  assert.equal(answer.status, 200);
  assert.deepEqual(Buffer.from(answer.bodyBase64 ?? "", "base64"), picture);
});
