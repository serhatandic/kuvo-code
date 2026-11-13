// Stopping a command an agent left running (PROTOCOL.md, `kuvo/shell/<id>/stop`), on every box: one
// the engine runs, and one a coding agent runs, through their bridge. The engine and the bridge are
// stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/shells.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";
import { runningAs } from "./running-as.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-shells-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A server that runs commands, `running` by id: what it was asked to remove.
async function runner(running, removes = true) {
  const removed = [];
  const server = http.createServer((request, response) => {
    const id = decodeURIComponent(request.url.split("?")[0].split("/").pop());
    const json = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (!request.url.startsWith("/api/shell/")) return json(404, {});
    if (!running.includes(id)) return json(404, { message: "No such command." });
    if (request.method === "DELETE") {
      if (!removes) return json(500, { message: "Couldn't remove it." });
      removed.push(id);
      return json(200, {});
    }
    return json(200, { data: { id, status: "running" } });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => server.close());
  return { removed, server, target: { port: server.address().port, password: "pw" } };
}

test("a command a coding agent left running stops, as one the engine runs does; one nobody runs is a 404", async t => {
  const engine = await runner(["sh_engine1"]);
  const bridge = await runner(["shl_agent1"]);
  // The coding agents' bridge, as it runs (its process says what it is, and its command line is
  // its own before its pid is handed over).
  const agents = await runningAs("kuvo-agents", t);
  const handle = link.engineHandler(() => engine.target, {}, () => ({ ...bridge.target, pid: agents }));
  const stop = async id => {
    const parts = [];
    for await (const part of handle({ method: "POST", path: `kuvo/shell/${id}/stop`, headers: {}, body: Buffer.from("{}") }, {}, undefined)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString() || "{}") };
  };
  assert.deepEqual(await stop("sh_engine1"), { status: 200, json: { stopped: "removed" } });
  assert.deepEqual(engine.removed, ["sh_engine1"]);
  assert.deepEqual(await stop("shl_agent1"), { status: 200, json: { stopped: "removed" } });
  assert.deepEqual(bridge.removed, ["shl_agent1"]);
  assert.equal((await stop("sh_nobody")).status, 404);
});

test("a command that runs on, and one no runner could be asked about, say so rather than read as gone", async t => {
  const engine = await runner(["sh_stuck"], false);
  const agents = await runningAs("kuvo-agents", t);
  // Nothing listens where the coding agents' bridge was: neither could say.
  const gone = await runner([]);
  const handle = link.engineHandler(() => engine.target, {}, () => ({ ...gone.target, pid: agents }));
  const stop = async (id, using = handle) => {
    const parts = [];
    for await (const part of using({ method: "POST", path: `kuvo/shell/${id}/stop`, headers: {}, body: Buffer.from("{}") }, {}, undefined)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString() || "{}") };
  };
  assert.deepEqual(await stop("sh_stuck"), { status: 422, json: { message: "It runs on, and couldn’t be stopped." } });
  const closed = { port: gone.target.port, password: "pw" };
  await new Promise(resolve => gone.server.close(resolve));
  const silent = link.engineHandler(() => closed, {}, () => ({ ...closed, pid: agents }));
  assert.deepEqual(await stop("sh_any", silent), { status: 503, json: { message: "Its engine didn’t answer. Try again in a moment." } });
});

test("a coding agent's command stops while the engine is down; with neither there, the engine's said to be starting", async t => {
  const bridge = await runner(["shl_agent2"]);
  const agents = await runningAs("kuvo-agents", t);
  let running = true;
  const handle = link.engineHandler(() => { throw new Error("no record"); }, {}, () => (running ? { ...bridge.target, pid: agents } : null));
  const stop = async id => {
    const parts = [];
    for await (const part of handle({ method: "POST", path: `kuvo/shell/${id}/stop`, headers: {}, body: Buffer.from("{}") }, {}, undefined)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString() || "{}") };
  };
  assert.deepEqual(await stop("shl_agent2"), { status: 200, json: { stopped: "removed" } });
  assert.deepEqual(bridge.removed, ["shl_agent2"]);
  running = false;
  assert.deepEqual(await stop("shl_agent2"), { status: 503, json: { message: "This machine's engine is starting. Try again in a moment." } });
});
