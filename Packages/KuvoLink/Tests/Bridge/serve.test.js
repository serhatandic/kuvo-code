// A Mac's own box (`kuvo-link.js serve`): its routes over HTTP on 127.0.0.1, as the app starts it
// beside the engine (PROTOCOL.md, "This Mac's box"). Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-serve-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const script = new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url);
const link = await import(script);

const auth = password => `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

// Started as the app starts it: it says where it listens, then answers.
async function started(password = "s3cret") {
  const child = spawn(process.execPath, [script.pathname, "serve"], { env: { ...process.env, KUVO_HOME: home, OPENCODE_PASSWORD: password }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes("\n")) break;
  }
  return { child, url: JSON.parse(out.split("\n")[0]).url };
}

test("the box answers its routes to the app, with its password only", async t => {
  const { child, url } = await started();
  t.after(() => child.kill());
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  assert.equal((await fetch(`${url}/kuvo/info`)).status, 401);
  assert.equal((await fetch(`${url}/kuvo/info`, { headers: { authorization: auth("wrong") } })).status, 401);

  const info = await fetch(`${url}/kuvo/info`, { headers: { authorization: auth("s3cret") } });
  assert.equal(info.status, 200);
  const said = await info.json();
  assert.equal(said.bridge, link.BRIDGE_VERSION);
  assert.equal(said.chats, path.join(home, "chats"), "its folders are where the app put it");

  // A path that isn't what it seems, as through the relay.
  const sneaky = await new Promise(resolve => http.get(`${url}/kuvo/groups/%2e%2e/x`, { headers: { authorization: auth("s3cret") } }, resolve));
  assert.equal(sneaky.statusCode, 403);
  sneaky.resume();
});

test("it goes when the app does (its stdin closes)", async () => {
  const { child } = await started();
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
});

test("without a password it doesn't start", async () => {
  const child = spawn(process.execPath, [script.pathname, "serve"], { env: { ...process.env, KUVO_HOME: home, OPENCODE_PASSWORD: "" }, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 2);
});

test("a stream goes as it comes, and stops when the client goes", async t => {
  let stopped = false;
  // A route that follows something, a line each time it changes, as `kuvo/…/events` do.
  const handle = async function* (request, phone, signal) {
    assert.equal(request.path, "kuvo/projects/events");
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    for (let line = 1; !signal.aborted; line++) {
      yield { body: Buffer.from(JSON.stringify({ line }) + "\n") };
      await new Promise(resolve => setImmediate(resolve));
    }
    stopped = true;
  };
  const server = link.serveBox("pw", handle);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/kuvo/projects/events`, { headers: { authorization: auth("pw") } });
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.deepEqual(JSON.parse(Buffer.from(value).toString().split("\n")[0]), { line: 1 });
  await reader.cancel();
  while (!stopped) await new Promise(resolve => setImmediate(resolve));
});

test("the app's own requests aren't a phone using the box; a phone's, through the Mac, are", async t => {
  const server = link.serveBox("pw");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/kuvo/projects`;
  fs.rmSync(link.SEEN_FILE, { force: true });
  assert.equal((await fetch(url, { headers: { authorization: auth("pw"), "x-kuvo-from": "app" } })).status, 200);
  assert.equal(fs.existsSync(link.SEEN_FILE), false, "the app asking");
  assert.equal((await fetch(url, { headers: { authorization: auth("pw") } })).status, 200);
  assert.equal(fs.existsSync(link.SEEN_FILE), true, "a phone asking");
});
