// The bridge, checked against the shared vectors and against a phone and an engine in this
// process. Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The bridge keeps its state in KUVO_HOME, so give it a folder of its own before loading it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-test-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// A phone's key as a phone has one (32 bytes, base64url), named for a test.
const shaped = name => crypto.createHash("sha256").update(name).digest("base64url");
const vectors = name => JSON.parse(fs.readFileSync(new URL(`../../Vectors/${name}`, import.meta.url), "utf8"));
const hex = s => Buffer.from(s, "hex");

test("Noise IK matches the vectors", () => {
  for (const v of vectors("noise.json").vectors.filter(v => v.protocol_name === "Noise_IK_25519_AESGCM_SHA256")) {
    const initiator = new link.IKInitiator(hex(v.init_static), hex(v.init_remote_static), hex(v.init_prologue), hex(v.init_ephemeral));
    const responder = new link.IKResponder(hex(v.resp_static), hex(v.resp_prologue), hex(v.resp_ephemeral));
    const [m0, m1, ...rest] = v.messages;
    const first = initiator.writeMessage1(hex(m0.payload));
    assert.equal(first.toString("hex"), m0.ciphertext);
    assert.equal(responder.readMessage1(first).toString("hex"), m0.payload);
    const { message, transport: responderSide } = responder.writeMessage2(hex(m1.payload));
    assert.equal(message.toString("hex"), m1.ciphertext);
    const { payload, transport: initiatorSide } = initiator.readMessage2(message);
    assert.equal(payload.toString("hex"), m1.payload);
    assert.equal(initiatorSide.hash.toString("hex"), v.handshake_hash);
    rest.forEach((m, i) => {
      const [from, to] = i % 2 === 0 ? [initiatorSide, responderSide] : [responderSide, initiatorSide];
      assert.equal(from.seal(hex(m.payload)).toString("hex"), m.ciphertext);
      assert.equal(to.open(hex(m.ciphertext)).toString("hex"), m.payload);
    });
  }
});

test("Noise K matches the vectors", () => {
  for (const v of vectors("noise.json").vectors.filter(v => v.protocol_name === "Noise_K_25519_AESGCM_SHA256")) {
    const [m0, ...rest] = v.messages;
    const sealed = link.sealOneWay(hex(m0.payload), hex(v.init_static), hex(v.init_remote_static), hex(v.init_prologue), hex(v.init_ephemeral));
    assert.equal(sealed.message.toString("hex"), m0.ciphertext);
    const opened = link.openOneWay(sealed.message, hex(v.resp_static), link.publicOf(hex(v.init_static)), hex(v.resp_prologue));
    assert.equal(opened.payload.toString("hex"), m0.payload);
    for (const m of rest) {
      assert.equal(sealed.following.encrypt(Buffer.alloc(0), hex(m.payload)).toString("hex"), m.ciphertext);
      assert.equal(opened.following.decrypt(Buffer.alloc(0), hex(m.ciphertext)).toString("hex"), m.payload);
    }
  }
});

test("addresses, relay messages, frames and messages match the vectors", () => {
  const v = vectors("link.json");
  for (const { secret, address } of v.addresses) assert.equal(link.addressOf(hex(secret)).toString("hex"), address);
  for (const r of v.relay) {
    const bytes = hex(r.bytes);
    if (r.name === "hello") assert.deepEqual(link.relayHello(bytes.subarray(1)), bytes);
    if (r.name === "send") assert.deepEqual(link.relaySend(hex(r.to), hex(r.payload)), bytes);
    if (r.name === "welcome") assert.equal(link.readRelay(bytes).address.toString("hex"), r.address);
    if (r.name === "deliver") assert.deepEqual(link.readRelay(bytes), { kind: "deliver", address: hex(r.address), payload: hex(r.payload) });
    if (r.name === "unreachable") assert.equal(link.readRelay(bytes).kind, "unreachable");
    if (r.name === "pushed") assert.equal(link.readRelay(bytes).status, r.status);
    if (r.name === "gone") assert.deepEqual(link.readRelay(bytes), { kind: "gone", address: hex(r.address), reason: r.reads });
  }
  // A gone of another length isn't one.
  const gone = hex(v.relay.find(r => r.name === "gone").bytes);
  assert.equal(link.readRelay(Buffer.concat([gone, Buffer.from([0])])), null);
  assert.equal(link.readRelay(gone.subarray(0, 17)), null);
  for (const f of v.frames) {
    assert.equal(link.frame(f.kind, f.session, hex(f.body)).toString("hex"), f.bytes);
    assert.deepEqual(link.readFrame(hex(f.bytes)), { kind: f.kind, session: f.session, body: hex(f.body) });
  }
  for (const r of v.routes) assert.equal(link.allowed(r.path, r.method ?? "GET"), r.allowed, `${r.path} ${r.method ?? "GET"}`);
  for (const r of v.sockets) assert.equal(link.socketAllowed(r.path), r.allowed, r.path);
  for (const r of v.agentRoutes) assert.equal(link.agentsAllowed(r.path, r.method ?? "GET"), r.allowed, `agents: ${r.path} ${r.method ?? "GET"}`);
  // What's sent for each: the path written one way only.
  for (const r of [...v.routes, ...v.sockets, ...v.agentRoutes].filter(r => r.forwarded)) assert.equal(link.canonicalPath(r.path), r.forwarded, r.path);
  for (const r of v.signInReturns) assert.equal(link.signInReturn(r.url), r.loads ?? null, r.url);
  for (const m of v.messages) {
    assert.equal(link.encodeMessage(m.head, hex(m.body)).toString("hex"), m.bytes);
    assert.deepEqual(link.decodeMessage(hex(m.bytes)), { head: m.head, body: hex(m.body) });
  }
});

test("long bodies split into messages that fit", () => {
  const body = crypto.randomBytes(200_000);
  const parts = link.pieces({ t: "res", id: 3, s: 200, h: { "content-type": "x" } }, body, true).map(link.decodeMessage);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(p => p.head.t), ["res", "data", "data", "data"]);
  assert.deepEqual(parts.map(p => p.head.end), [false, false, false, true]);
  assert.deepEqual(Buffer.concat(parts.map(p => p.body)), body);
});

// ---- A phone talking to a LinkHost in this process ----

function phoneFor(host, hostKey) {
  const key = link.newKey();
  const address = crypto.randomBytes(16);
  const session = crypto.randomInt(1, 2 ** 32);
  const inbox = [];
  const waiting = [];
  // What the host sends goes straight to the phone it's for.
  host.phones ??= new Map();
  host.phones.set(address.toString("hex"), bytes => {
    const message = link.readRelay(Buffer.concat([Buffer.from([2]), bytes.subarray(1, 17), bytes.subarray(17)]));
    const frame = link.readFrame(message.payload);
    const resolve = waiting.shift();
    if (resolve) resolve(frame); else inbox.push(frame);
  });
  host.send = bytes => host.phones.get(bytes.subarray(1, 17).toString("hex"))?.(bytes);
  const next = () => new Promise((resolve, reject) => {
    if (inbox.length) return resolve(inbox.shift());
    waiting.push(resolve);
    setTimeout(() => reject(new Error("nothing arrived")), 2000).unref();
  });
  let transport;
  return {
    key,
    address,
    async open(hello) {
      const initiator = new link.IKInitiator(key, link.publicOf(hostKey), link.PROLOGUE);
      await host.receive(address, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "Test iPhone", app: "0", ...hello })))));
      const answer = await next();
      if (answer.kind !== link.Frame.handshake2) return { refused: true };
      const opened = initiator.readMessage2(answer.body);
      transport = opened.transport;
      return JSON.parse(opened.payload);
    },
    send(head, body = Buffer.alloc(0)) {
      for (const piece of link.pieces(head, body, head.end ?? true)) host.receive(address, link.frame(link.Frame.transport, session, transport.seal(piece)));
    },
    async receive() {
      const frame = await next();
      if (frame.kind !== link.Frame.transport) return { closed: true };
      return link.decodeMessage(transport.open(frame.body));
    },
    // A whole response: its head, and its body up to the message marked end.
    async response() {
      const first = await this.receive();
      const body = [first.body];
      for (let last = first; last.head.end !== true;) {
        last = await this.receive();
        body.push(last.body);
      }
      return { head: first.head, body: Buffer.concat(body) };
    },
  };
}

test("the host lets in a phone with the pairing token once, then by its key", async () => {
  const hostKey = link.newKey();
  link.writeLink({ relay: "wss://relay.test", secret: "", key: hostKey.toString("base64url"), phones: [], pairing: { token: Buffer.alloc(16, 7).toString("base64url"), expires: Date.now() + 60_000 } });
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "my-server", app: "0", engine: "2.0.30" }, authorize: link.authorizePhone, confirmed: link.confirmPhone, handle: async function* () {} });

  const stranger = phoneFor(host, hostKey);
  assert.deepEqual(await stranger.open({ pair: Buffer.alloc(16, 8).toString("base64url") }), { refused: true });

  const phone = phoneFor(host, hostKey);
  const hello = await phone.open({ pair: Buffer.alloc(16, 7).toString("base64url") });
  assert.equal(hello.kind, "machine");
  assert.equal(hello.name, "my-server");
  const saved = link.readLink();
  assert.equal(saved.pairing, undefined);
  assert.deepEqual(saved.phones.map(p => [p.key, p.name]), [[link.publicOf(phone.key).toString("base64url"), "Test iPhone"]]);
  // Where its notifications go.
  assert.equal(saved.phones[0].address, phone.address.toString("base64url"));
  assert.equal((fs.statSync(link.LINK_FILE).mode & 0o777).toString(8), "600");

  // The token is used up; the paired phone comes back without it.
  const late = phoneFor(host, hostKey);
  assert.deepEqual(await late.open({ pair: Buffer.alloc(16, 7).toString("base64url") }), { refused: true });
  const returning = phoneFor(host, hostKey);
  returning.key.set(phone.key);
  assert.equal((await returning.open({})).name, "my-server");
  // Somewhere else now: its notifications go there once its session proves its own (a replayed
  // first handshake message can't), not on the handshake.
  assert.equal(link.readLink().phones[0].address, phone.address.toString("base64url"));
  returning.send({ t: "ping" });
  assert.equal((await returning.receive()).head.t, "pong");
  assert.equal(link.readLink().phones[0].address, returning.address.toString("base64url"));
});

// An engine on a free port that answers like opencode does, and records what it was asked.
async function fakeEngine() {
  const asked = [];
  // Says when a stream the bridge opened closes.
  const closes = new EventEmitter();
  const server = http.createServer((request, response) => {
    asked.push({ method: request.method, url: request.url, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"] });
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"type":"server.connected"}\n\n');
      const timer = setInterval(() => response.write('data: {"type":"server.heartbeat"}\n\n'), 10);
      request.on("close", () => { clearInterval(timer); asked.push({ closed: request.url }); closes.emit("closed", request.url); });
      return;
    }
    if (request.url === "/api/credential" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [
        { id: "cred_1", integrationID: "anthropic", label: "Work", active: true, value: { type: "api", key: "sk-ant-secret" } },
        { id: "cred_2", integrationID: "github-copilot", label: "me", active: false, value: { type: "oauth", refresh: "ghr_secret" } },
      ] }));
      return;
    }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "nope" });
      response.end(JSON.stringify({ path: request.url, body }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, closes, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

test("a conversation archived from a phone holds its wake-ups, with the Mac closed too, and brought back lets them go; a pause of your own stays", async t => {
  // An engine that keeps each session's metadata, as a phone changes it.
  const metadata = {};
  const server = http.createServer((request, response) => {
    const id = request.url.split("/").at(-1);
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "PATCH") metadata[id] = { ...metadata[id], ...JSON.parse(body).metadata };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id, metadata: metadata[id] ?? {} } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const engine = { port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
  t.after(engine.close);
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "pw", version: "2.0.30" }));
  const wakes = path.join(home, "wakes", "ses_archived1");
  fs.mkdirSync(wakes, { recursive: true });
  t.after(() => fs.rmSync(path.join(home, "wakes"), { recursive: true, force: true }));
  const archive = async (session, archived) => answer(handle, "PATCH", `api/session/${session}`, JSON.stringify({ metadata: { "kuvo.archived": archived } }));
  assert.equal((await archive("ses_archived1", true)).status, 200);
  assert.equal(fs.readFileSync(path.join(wakes, "paused"), "utf8"), "archived");
  assert.equal((await archive("ses_archived1", false)).status, 200);
  assert.equal(fs.existsSync(path.join(wakes, "paused")), false);
  // Yours stays through archiving and back.
  fs.writeFileSync(path.join(wakes, "paused"), "paused");
  await archive("ses_archived1", true);
  await archive("ses_archived1", false);
  assert.equal(fs.readFileSync(path.join(wakes, "paused"), "utf8"), "paused");
  fs.rmSync(path.join(wakes, "paused"));
  // Archived, its wake-ups let go by hand, then pinned (all its metadata sent again, archived as
  // it was): they stay going.
  await archive("ses_archived1", true);
  fs.rmSync(path.join(wakes, "paused"));
  const pin = await answer(handle, "PATCH", "api/session/ses_archived1", JSON.stringify({ metadata: { "kuvo.archived": true, "kuvo.pinned": true } }));
  assert.equal(pin.status, 200);
  assert.equal(fs.existsSync(path.join(wakes, "paused")), false);
  // A session with no wake-ups has nothing to hold; nor does a name that isn't a session's.
  await archive("ses_nowakes1", true);
  assert.equal(fs.existsSync(path.join(home, "wakes", "ses_nowakes1")), false);
});

test("requests go to the engine with its password, all of its API; paths that aren't what they seem don't", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const hostKey = link.newKey();
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret", version: "2.0.30" }));
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => true, handle });
  const phone = phoneFor(host, hostKey);
  await phone.open({});

  phone.send({ t: "req", id: 1, m: "POST", p: "api/session/ses_1/prompt?x=1", h: { "Content-Type": "application/json", "X-Opencode-Directory": "/home/me/p", Authorization: "Basic forged" } }, Buffer.from('{"text":"hi"}'));
  const answer = await phone.response();
  assert.equal(answer.head.t, "res");
  assert.equal(answer.head.s, 200);
  assert.equal(answer.head.h["content-type"], "application/json");
  assert.equal(answer.head.h["set-cookie"], undefined);
  // A message from the phone says so, at its end.
  assert.deepEqual(JSON.parse(answer.body), { path: "/api/session/ses_1/prompt?x=1", body: JSON.stringify({ text: `hi\n\n${link.FROM_PHONE}` }) });
  const call = engine.asked.at(-1);
  assert.equal(call.auth, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  assert.equal(call.directory, "/home/me/p");

  // The phone is yours: the engine's settings and sign-ins too.
  for (const [id, p] of [[2, "api/credential"], [3, "api/config"]]) {
    phone.send({ t: "req", id, m: "GET", p, h: {} });
    assert.equal((await phone.response()).head.s, 200, p);
  }
  for (const [id, p] of [[4, "api/session/../credential"], [5, "kuvo/nothing"], [6, "api/session#x"]]) {
    phone.send({ t: "req", id, m: "GET", p, h: {} });
    assert.equal((await phone.response()).head.s, 403, p);
  }
  assert.ok(!engine.asked.some(a => a.url?.includes("..") || a.url?.includes("nothing")));

  // An event stream runs until the phone cancels it, and then the engine sees it close.
  phone.send({ t: "req", id: 9, m: "GET", p: "api/event", h: { Accept: "text/event-stream" } });
  const head = await phone.receive();
  assert.equal(head.head.h["content-type"], "text/event-stream");
  assert.match(head.body.toString(), /server.connected/);
  await phone.receive();
  phone.send({ t: "cancel", id: 9 });
  for (let i = 0; i < 50 && !engine.asked.some(a => a.closed === "/api/event"); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(engine.asked.some(a => a.closed === "/api/event"));
});

test("what reaches the engine and the agents' bridge is the path as it was checked, however the phone wrote it (Vectors/link.json)", async t => {
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  // The agents' bridge is this same server, under a process the bridge takes for it.
  const named = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
  t.after(() => named.kill());
  const handle = link.engineHandler(() => ({ pid: process.pid, port, password: "s", version: "2.0.30" }), {}, () => ({ pid: named.pid, port, password: "a" }));
  const v = vectors("link.json");
  for (const [list, prefix] of [[v.routes, ""], [v.agentRoutes, "kuvo/agents/"]]) {
    for (const r of list.filter(r => r.forwarded)) {
      asked.length = 0;
      const { status } = await answer(handle, r.method ?? "GET", prefix + r.path);
      assert.equal(status, 200, r.path);
      assert.deepEqual(asked, [`/${r.forwarded}`], r.path);
    }
  }
});

// What a phone's request gets from the handler, read whole.
async function answer(handle, method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: Buffer.from(body ?? "") }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

test("a sign-in that returns to the machine is loaded there, at its own address only, without following it further", async t => {
  const asked = [];
  const server = http.createServer((request, response) => {
    asked.push(request.url);
    response.writeHead(302, { location: "http://example.com/done" });
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const handle = link.engineHandler(() => ({ port: 1, password: "p" }));
  const port = server.address().port;
  const loaded = await answer(handle, "POST", "kuvo/sign-in/return", JSON.stringify({ url: `http://127.0.0.1:${port}/mcp/oauth/callback?code=c&state=s#_=_` }));
  assert.deepEqual([loaded.status, loaded.json], [200, { status: 302 }]);
  assert.deepEqual(asked, ["/mcp/oauth/callback?code=c&state=s"]);
  for (const url of ["http://example.com:80/cb?code=c", `http://127.0.0.1:${port}/cb`, `https://127.0.0.1:${port}/cb?code=c`]) {
    assert.equal((await answer(handle, "POST", "kuvo/sign-in/return", JSON.stringify({ url }))).status, 400, url);
  }
  assert.equal(asked.length, 1);
  // Nothing there to take it.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, "127.0.0.1", resolve));
  const gone = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  assert.equal((await answer(handle, "POST", "kuvo/sign-in/return", JSON.stringify({ url: `http://127.0.0.1:${gone}/cb?code=c` }))).status, 502);
  assert.equal((await answer(handle, "GET", "kuvo/sign-in/return")).status, 405);
});

test("a machine whose settings still come from its Mac says so; its engine restarts as it was started", async () => {
  const handle = link.engineHandler(() => ({ pid: 999999, port: 1, password: "p" }));
  for (const p of ["kuvo/config", "kuvo/mcp/catalog", "kuvo/mcp/catalog/linear"]) {
    const answered = await answer(handle, p.endsWith("linear") ? "POST" : "GET", p);
    assert.equal(answered.status, 409, p);
    assert.match(answered.json.message, /Mac/);
  }
  // Never started from a Mac here (no record of how): it says to.
  assert.equal((await answer(handle, "POST", "kuvo/engine/restart")).status, 409);
  assert.equal((await answer(link.engineHandler(() => { throw new Error("none"); }), "POST", "kuvo/engine/restart")).status, 409);
  // Started from a Mac: `kuvo-start` starts it again, once the answer's out.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "launch.env"), "PATH=/usr/bin\n");
  const started = path.join(home, "run", "started-again");
  fs.writeFileSync(path.join(bin, "kuvo-start"), `#!/bin/sh\necho "bun=\${BUN_BE_BUN-}" >"${started}"\n`);
  // Without what starts the engine (`kuvo-launch`), nothing is stopped.
  assert.equal((await answer(handle, "POST", "kuvo/engine/restart")).status, 409);
  fs.writeFileSync(path.join(bin, "kuvo-launch"), "#!/bin/sh\n");
  // The bridge runs as Bun; the engine it starts again mustn't.
  process.env.BUN_BE_BUN = "1";
  try {
    assert.equal((await answer(handle, "POST", "kuvo/engine/restart")).status, 202);
    for (let i = 0; i < 100 && !fs.existsSync(started); i++) await new Promise(r => setTimeout(r, 50));
  } finally {
    delete process.env.BUN_BE_BUN;
  }
  assert.equal(fs.readFileSync(started, "utf8").trim(), "bun=");
  assert.equal((await answer(handle, "GET", "kuvo/engine/restart")).status, 405);
  for (const name of ["bin/kuvo-start", "bin/kuvo-launch", "run/launch.env", "run/started-again"]) fs.rmSync(path.join(home, name));
});

test("kuvo/file sends a file on the machine by its file:// address, with its type", async () => {
  const handle = link.engineHandler(() => ({}));
  const folder = fs.mkdtempSync(path.join(home, "files-"));
  const picture = path.join(folder, "a chart #1.png");
  const bytes = crypto.randomBytes(100 * 1024);
  fs.writeFileSync(picture, bytes);
  const ask = async uri => {
    const parts = [];
    for await (const part of handle({ method: "GET", path: `kuvo/file?uri=${encodeURIComponent(uri)}`, headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
    return { head: parts[0].head, body: Buffer.concat(parts.filter(part => part.body).map(part => part.body)) };
  };
  const sent = await ask(pathToFileURL(picture).href);
  assert.equal(sent.head.status, 200);
  assert.equal(sent.head.headers["content-type"], "image/png");
  assert.ok(sent.body.equals(bytes));
  const gone = await ask(pathToFileURL(path.join(folder, "gone.png")).href);
  assert.equal(gone.head.status, 404);
  assert.ok(JSON.parse(gone.body).message);
  assert.equal((await ask(pathToFileURL(folder).href)).head.status, 404, "a folder isn't a file");
  assert.equal((await ask("https://example.com/a.png")).head.status, 400);
  const big = path.join(folder, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, link.FILE_LIMIT + 1);
  assert.equal((await ask(pathToFileURL(big).href)).head.status, 413);
  fs.rmSync(folder, { recursive: true });
});

test("kuvo/info says when the engine running now came up, which a restart changes", async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const record = path.join(home, "run", "engine.json");
  fs.writeFileSync(record, JSON.stringify({ pid: 4242, port: 1, password: "p", version: "2.0.32" }));
  const then = new Date("2026-10-22T10:00:00Z");
  fs.utimesSync(record, then, then);
  const handle = link.engineHandler(() => JSON.parse(fs.readFileSync(record, "utf8")));
  const info = await answer(handle, "GET", "kuvo/info");
  assert.equal(info.json.started, then.getTime() / 1000);
  assert.equal(info.json.engine, "2.0.32");
  // None running: none started.
  assert.equal((await answer(link.engineHandler(() => { throw new Error("none"); }), "GET", "kuvo/info")).json.started, null);
  fs.rmSync(record);
});

test("plan accounts: listed, signed in to and switched from a phone", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const hostKey = link.newKey();
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret", version: "2.0.30" }));
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => true, handle });
  const phone = phoneFor(host, hostKey);
  await phone.open({});

  // Its sign-ins, by name and which is in use; never what they're signed in with.
  phone.send({ t: "req", id: 1, m: "GET", p: "kuvo/accounts/credentials", h: {} });
  const listed = await phone.response();
  assert.equal(listed.head.s, 200);
  assert.deepEqual(JSON.parse(listed.body), { credentials: [
    { id: "cred_1", integrationID: "anthropic", label: "Work", active: true },
    { id: "cred_2", integrationID: "github-copilot", label: "me", active: false },
  ] });
  assert.ok(!listed.body.toString().includes("secret"));

  // A key goes in; another sign-in is switched to; the list itself never goes out.
  phone.send({ t: "req", id: 2, m: "POST", p: "api/integration/anthropic/connect/key", h: { "Content-Type": "application/json" } }, Buffer.from('{"key":"sk-new"}'));
  assert.equal((await phone.response()).head.s, 200);
  phone.send({ t: "req", id: 3, m: "POST", p: "api/credential/cred_2/activate", h: {} });
  assert.equal((await phone.response()).head.s, 200);
  // A sign-in page, started with its method's hidden answers (OpenCode's server), as the Mac sends them.
  const start = '{"methodID":"console","answer":{"server":"https://opencode.ai"}}';
  phone.send({ t: "req", id: 7, m: "POST", p: "api/integration/opencode/connect/oauth", h: { "Content-Type": "application/json" } }, Buffer.from(start));
  const started = await phone.response();
  assert.equal(started.head.s, 200);
  assert.equal(JSON.parse(started.body).body, start);
  assert.deepEqual(engine.asked.filter(a => a.url?.startsWith("/api/")).map(a => `${a.method} ${a.url}`),
    ["GET /api/credential", "POST /api/integration/anthropic/connect/key", "POST /api/credential/cred_2/activate", "POST /api/integration/opencode/connect/oauth"]);
});

// A terminal on a free port as the engine serves one: a WebSocket that first says where its
// output starts, then answers each line. Short frames only, which is all this needs.
async function fakeTerminal() {
  const asked = [];
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    asked.push({ url: request.url, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"] });
    const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (opcode, payload) => socket.write(Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]));
    send(2, Buffer.concat([Buffer.from([0]), Buffer.from('{"cursor":0}')]));
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 6) {
        const opcode = buffered[0] & 0x0f;
        const length = buffered[1] & 0x7f;
        if (buffered.length < 6 + length) return;
        const mask = buffered.subarray(2, 6);
        const payload = Buffer.from(buffered.subarray(6, 6 + length).map((byte, i) => byte ^ mask[i % 4]));
        buffered = buffered.subarray(6 + length);
        if (opcode === 1) send(1, Buffer.concat([Buffer.from("echo:"), payload]));
        if (opcode === 8) socket.end();
      }
    });
    socket.on("close", () => asked.push({ closed: request.url }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
}

test("a socket reaches the engine's terminal with its password, both ways, until the phone closes it", async t => {
  const terminal = await fakeTerminal();
  t.after(terminal.close);
  const hostKey = link.newKey();
  const engine = () => ({ pid: process.pid, port: terminal.port, password: "s3cret", version: "2.0.30" });
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => true, handle: link.engineHandler(engine), connect: link.engineConnect(engine) });
  const phone = phoneFor(host, hostKey);
  await phone.open({});

  phone.send({ t: "req", id: 1, m: "GET", p: "api/pty/pty_1/connect?cursor=0", h: { upgrade: "websocket", "x-opencode-directory": "/home/me/p" } });
  const opened = await phone.receive();
  assert.deepEqual([opened.head.t, opened.head.s, opened.head.end], ["res", 101, false]);
  const note = await phone.receive();
  assert.equal(note.head.h.type, "binary");
  assert.deepEqual(note.body, Buffer.concat([Buffer.from([0]), Buffer.from('{"cursor":0}')]));
  const call = terminal.asked[0];
  assert.equal(call.url, "/api/pty/pty_1/connect?cursor=0");
  assert.equal(call.auth, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  assert.equal(call.directory, "/home/me/p");

  phone.send({ t: "data", id: 1, end: false }, Buffer.from("ls\r"));
  const answer = await phone.receive();
  assert.equal(answer.head.t, "data");
  assert.equal(answer.head.h, undefined);
  assert.equal(answer.body.toString(), "echo:ls\r");

  phone.send({ t: "cancel", id: 1 });
  for (let i = 0; i < 50 && !terminal.asked.some(a => a.closed); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(terminal.asked.some(a => a.closed));

  // Anything but a terminal's socket is turned away, without reaching the engine.
  phone.send({ t: "req", id: 2, m: "GET", p: "api/event", h: { upgrade: "websocket" } });
  const refused = await phone.response();
  assert.equal(refused.head.s, 502);
  assert.equal(terminal.asked.length, 2);
});

test("a relay that isn't there ends the attempt, so the bridge tries again", async () => {
  const host = { reset() {}, send() {} };
  const started = Date.now();
  assert.equal(await link.connectOnce("ws://127.0.0.1:9", crypto.randomBytes(32), host), false);
  assert.ok(Date.now() - started < 5000);
});

test("a session the host doesn't know is closed, and tampering ends one", async () => {
  const hostKey = link.newKey();
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => true, handle: async function* () {} });
  const sent = [];
  host.send = bytes => sent.push(link.readFrame(bytes.subarray(17)));
  await host.receive(crypto.randomBytes(16), link.frame(link.Frame.transport, 99, Buffer.from("junk")));
  assert.equal(sent.at(-1).kind, link.Frame.close);
  assert.equal(sent.at(-1).session, 99);
});

// A phone's event stream through the host, past its first event.
async function listening(phone, id) {
  phone.send({ t: "req", id, m: "GET", p: "api/event", h: { Accept: "text/event-stream" } });
  const head = await phone.receive();
  assert.equal(head.head.h["content-type"], "text/event-stream");
}

// The rule phones count on now that they don't check before each request (PROTOCOL.md, "The
// relay"): while its relay connection stays up, the host keeps a phone's session through whatever
// else happens, and ends it only with the phone told.
test("a host keeps a phone's session while its relay connection stays up, and ends it only with the phone told", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const hostKey = link.newKey();
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret", version: "2.0.30" }));
  let handshakes = 0;
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => { handshakes += 1; return true; }, handle });
  const phone = phoneFor(host, hostKey);
  await phone.open({});
  await listening(phone, 1);

  // Another phone comes, asks, goes without a word (the relay can't reach it, or says it's gone),
  // comes again and is removed; mail comes for the machine.
  const other = phoneFor(host, hostKey);
  await other.open({});
  other.send({ t: "req", id: 1, m: "GET", p: "api/config", h: {} });
  assert.equal((await other.response()).head.s, 200);
  host.forget(other.address);
  link.fromRelay(host, link.readRelay(Buffer.concat([Buffer.from([7]), other.address, Buffer.from([1])])), crypto.randomBytes(16));
  const again = phoneFor(host, hostKey);
  await again.open({});
  host.keepOnly(new Set([link.publicOf(phone.key).toString("base64url")]));
  assert.deepEqual(await again.receive(), { closed: true });
  await host.receive(other.address, link.frame(link.Frame.mail, 0, Buffer.from("not for this test")));

  // The first phone's session is the one it had: its stream goes on, and it asks on it.
  const before = handshakes;
  assert.equal((await phone.receive()).head.t, "data");
  phone.send({ t: "ping" });
  for (let message = await phone.receive(); message.head.t !== "pong"; message = await phone.receive());
  phone.send({ t: "req", id: 2, m: "GET", p: "api/config", h: {} });
  let answer = await phone.receive();
  while (answer.head.id !== 2) answer = await phone.receive();
  assert.equal(answer.head.s, 200);
  assert.equal(handshakes, before);

  // Ending it, the host says so.
  host.keepOnly(new Set());
  let closed;
  do closed = await phone.receive(); while (!closed.closed);
  assert.ok(closed.closed);
});

test("a phone the relay says is gone loses its sessions on the host, which stops what it asked for, with nothing sent", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const hostKey = link.newKey();
  const self = crypto.randomBytes(16);
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret", version: "2.0.30" }));
  const host = new link.LinkHost({ key: hostKey, hello: { v: 1, kind: "machine", name: "m", app: "0" }, authorize: () => true, handle });
  for (const reason of [0, 1]) {
    const phone = phoneFor(host, hostKey);
    await phone.open({});
    await listening(phone, 1);
    // What this host sent itself coming back gone means nothing for its phones.
    link.fromRelay(host, link.readRelay(Buffer.concat([Buffer.from([7]), self, Buffer.from([reason])])), self);
    assert.equal(host.active, 1);

    const closed = once(engine.closes, "closed");
    const sent = [];
    host.phones.set(phone.address.toString("hex"), bytes => sent.push(link.readFrame(bytes.subarray(17))));
    link.fromRelay(host, link.readRelay(Buffer.concat([Buffer.from([7]), phone.address, Buffer.from([reason])])), self);
    assert.equal(host.active, 0);
    assert.deepEqual(await closed, ["/api/event"]);
    assert.ok(!sent.some(frame => frame?.kind === link.Frame.close));
  }
});

test("the self-test passes here", () => {
  assert.ok(link.selftest());
});

test("setup keeps the machine's keys and its own phones, takes the Mac's documents and gives back its own, starts the bridge, and stops it with no phones left", async () => {
  const { spawnSync } = await import("node:child_process");
  const [A, B, C, MAC] = ["A", "B", "C", "Mac"].map(shaped);
  const seed = link.newSigningSeed();
  let count = 0;
  const phones = list => link.signDoc(seed, "phones", ++count, { phones: list.map(key => ({ key, name: key.slice(0, 4), pairing: "" })), removed: [] });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-setup-"));
  fs.mkdirSync(path.join(folder, "workspace"));
  const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
  const setup = input => {
    const result = spawnSync(process.execPath, [script, "setup"], { input: JSON.stringify({ relay: "ws://127.0.0.1:9", name: "test", mac: MAC, macSign: link.signingKeyOf(seed), ...input }), env: { ...process.env, KUVO_HOME: folder }, encoding: "utf8" });
    return JSON.parse(result.stdout);
  };
  const pidFile = path.join(folder, "run", "link.pid");
  const linkFile = path.join(folder, "run", "link.json");
  try {
    // A relay nobody listens on: the bridge keeps trying, which is all this needs.
    const first = setup({ docs: [phones([A])] });
    assert.match(first.address, /^[A-Za-z0-9_-]{22}$/);
    assert.match(first.sign, /^[A-Za-z0-9_-]{43}$/, "its signing key, for the Mac to name it by");
    // Its own documents, signed with that key: its phones, and its view of your personalities.
    const own = first.docs.map(link.readDoc).filter(doc => doc?.origin === first.sign);
    assert.deepEqual(own.map(doc => doc.kind).sort(), ["personalities", "phones"]);
    // The file exists briefly before its PID is written; setup also needs its version file.
    let pid = 0;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        pid = Number(fs.readFileSync(pidFile, "utf8"));
        ready = Number.isInteger(pid) && pid > 0 && fs.readFileSync(path.join(folder, "run", "link.version"), "utf8").trim() === link.BRIDGE_VERSION;
        if (ready) break;
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready, "the bridge writes its PID and version before setup runs again");
    process.kill(pid, 0);

    // Its keys stay; the phones are what the Mac's newest document says; the same bridge carries on.
    const second = setup({ docs: [phones([A, B])] });
    assert.deepEqual([second.address, second.key, second.sign], [first.address, first.key, first.sign]);
    assert.deepEqual(JSON.parse(fs.readFileSync(linkFile, "utf8")).phones.map(p => p.key), [A, B]);
    assert.equal(Number(fs.readFileSync(pidFile, "utf8")), pid);
    // An older document of the Mac's, given again, changes nothing.
    setup({ docs: [link.signDoc(seed, "phones", 1, { phones: [{ key: A, name: "A", pairing: "" }], removed: [] })] });
    assert.deepEqual(JSON.parse(fs.readFileSync(linkFile, "utf8")).phones.map(p => p.key), [A, B]);

    // A phone paired with the machine itself stays when the Mac's phones change.
    const saved = JSON.parse(fs.readFileSync(linkFile, "utf8"));
    fs.writeFileSync(linkFile, JSON.stringify({ ...saved, phones: [...saved.phones, { key: C, name: "C", added: 1, from: "pair", pairing: "" }] }));
    setup({ docs: [phones([B])] });
    assert.deepEqual(JSON.parse(fs.readFileSync(linkFile, "utf8")).phones.map(p => p.key), [B, C]);

    // Nothing left to answer: the bridge stops, and the machine keeps its keys; no phone keeps
    // the engine up any more.
    const seen = path.join(folder, "run", "link.seen");
    fs.writeFileSync(seen, "");
    const now = JSON.parse(fs.readFileSync(linkFile, "utf8"));
    fs.writeFileSync(linkFile, JSON.stringify({ ...now, phones: now.phones.filter(p => p.from !== "pair") }));
    assert.deepEqual(setup({ docs: [phones([])] }), {});
    const kept = JSON.parse(fs.readFileSync(linkFile, "utf8"));
    assert.equal(kept.secret, saved.secret);
    assert.equal(kept.sign, saved.sign);
    assert.deepEqual(kept.phones, []);
    assert.equal(fs.existsSync(seen), false);
    let stopped = false;
    for (let i = 0; i < 50 && !stopped; i++) {
      try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 50)); } catch { stopped = true; }
    }
    assert.ok(stopped);
  } finally {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
    } catch {}
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// ---- Notifications ----

test("a notification fits a push, its body cut", () => {
  const long = "Wörds and more words. ".repeat(400);
  const json = link.noticeJSON({ title: "Fixer", subtitle: "kuvo-ai", body: long, category: "finished", thread: "ses_1", data: { session: "ses_1" } });
  assert.ok(json.length <= link.NOTICE_LIMIT);
  const notice = JSON.parse(json);
  assert.equal(notice.t, "notify");
  assert.ok(notice.body.endsWith("…"));
  assert.ok(long.startsWith(notice.body.slice(0, -1)));
  assert.ok(notice.body.length > 2000);
  // Short ones go as they are, keys sorted as the Mac writes them.
  assert.equal(link.noticeJSON({ title: "Fixer", body: "Done.", category: "report", thread: "ses_1", data: { session: "ses_1" } }).toString(),
    '{"body":"Done.","category":"report","data":{"session":"ses_1"},"t":"notify","thread":"ses_1","title":"Fixer"}');
});

test("a push is sealed for the phone it goes to", () => {
  const hostKey = link.newKey(), phoneKey = link.newKey();
  const address = crypto.randomBytes(16);
  const json = link.noticeJSON({ title: "Fixer", body: "Done.", category: "report", thread: "ses_1", data: {} });
  const bytes = link.pushTo({ key: link.publicOf(phoneKey).toString("base64url"), address: address.toString("base64url") }, json, hostKey);
  assert.equal(bytes[0], 5);
  assert.deepEqual(bytes.subarray(1, 17), address);
  const mail = link.readFrame(bytes.subarray(17));
  assert.equal(mail.kind, link.Frame.mail);
  assert.equal(mail.session, 0);
  assert.deepEqual(link.openOneWay(mail.body, phoneKey, link.publicOf(hostKey)).payload, json);
  assert.throws(() => link.openOneWay(mail.body, link.newKey(), link.publicOf(hostKey)));
});

test("engine events become notifications, as the Mac words them", async () => {
  const sessions = {
    ses_main: { id: "ses_main", title: "Fix the tests", location: { directory: "/home/me/kuvo-ai" } },
    ses_sub: { id: "ses_sub", parentID: "ses_main", title: "Explore", location: { directory: "/home/me/kuvo-ai" } },
    ses_bot: { id: "ses_bot", title: "Fixer", metadata: { kuvo: { bot: "bot_1" } }, location: { directory: "/home/me/.kuvo-code/bots/bot_1/workspace" } },
    ses_run: { id: "ses_run", title: "Auto", metadata: { kuvo: { engineFor: "ses_agent" } }, location: { directory: "/home/me/kuvo-ai" } },
  };
  const messages = { data: [{ type: "assistant", content: [{ type: "text", text: "**All** green:\n 42 tests pass." }] }, { type: "user", content: [] }] };
  // ses_main is at work, with a tool of the "linear" server running.
  const working = { data: [{ type: "assistant", content: [{ type: "tool", name: "linear_create_issue", state: { status: "running", input: {} } }] }] };
  const get = async route => {
    if (route === "api/session/active") return { data: ["ses_main"] };
    if (route.endsWith("/message?limit=8&order=desc")) return route.includes("ses_main") ? working : { data: [] };
    if (route.endsWith("/message?limit=6&order=desc")) return messages;
    const id = decodeURIComponent(route.split("/").pop());
    if (!sessions[id]) throw new Error("404");
    return { data: sessions[id] };
  };

  // A subagent's permission shows in the session that started it.
  assert.deepEqual(await link.noticeFor({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_sub", action: "shell", resources: ["npm test"] } }, get), {
    title: "Fix the tests", subtitle: "kuvo-ai", body: "Wants to run a command: npm test", category: "permission", thread: "ses_main",
    data: { session: "ses_main", request: "per_1", requestSession: "ses_sub" },
  });
  const question = { id: "frm_1", sessionID: "ses_main", title: "Pick", metadata: { kind: "question" }, fields: [{ key: "a", type: "string", description: "Which database?" }] };
  // As the engine sends it: the form under `form`.
  const asked = await link.noticeFor({ type: "form.created", data: { form: question } }, get);
  assert.equal(asked.category, "question");
  assert.equal(asked.body, "Which database?");
  assert.deepEqual(asked.data, { session: "ses_main", request: "frm_1" });
  // An MCP server's form is filed under no session: it's the one of its folder using that server.
  const elicitation = { id: "frm_2", sessionID: "global", metadata: { kind: "mcp-elicitation", server: "linear", message: "Which team?" }, fields: [] };
  const fromServer = await link.noticeFor({ type: "form.created", location: { directory: "/home/me/kuvo-ai" }, data: { form: elicitation } }, get);
  assert.equal(fromServer.body, "Which team?");
  assert.deepEqual(fromServer.data, { session: "ses_main", request: "frm_2", requestSession: "global" });
  // In a folder where nothing uses it: no notice.
  assert.equal(await link.noticeFor({ type: "form.created", location: { directory: "/home/me/other" }, data: { form: elicitation } }, get), null);

  // A bot's run: its news, with what it said last, without its folder.
  const report = await link.noticeFor({ type: "session.execution.succeeded", data: { sessionID: "ses_bot" } }, get);
  assert.deepEqual(report, { title: "Fixer", subtitle: undefined, body: "All green: 42 tests pass.", category: "report", thread: "ses_bot", data: { session: "ses_bot" } });
  assert.equal((await link.noticeFor({ type: "session.execution.succeeded", data: { sessionID: "ses_main" } }, get)).category, "finished");
  const failed = await link.noticeFor({ type: "session.execution.failed", data: { sessionID: "ses_main" } }, get);
  assert.equal(failed.category, "failed");
  assert.equal(failed.body, "Stopped with an error.");

  // An engine run a coding agent's session started: the agents' bridge tells its news, as that
  // session's, not the engine.
  assert.equal(await link.noticeFor({ type: "permission.asked", data: { id: "per_2", sessionID: "ses_run", action: "shell", resources: ["ls"] } }, get), null);
  assert.equal(await link.noticeFor({ type: "session.execution.succeeded", data: { sessionID: "ses_run" } }, get), null);

  // A subagent's run is its parent's business; a stopped run and the rest aren't news.
  assert.equal(await link.noticeFor({ type: "session.execution.succeeded", data: { sessionID: "ses_sub" } }, get), null);
  assert.equal(await link.noticeFor({ type: "session.execution.interrupted", data: { sessionID: "ses_main" } }, get), null);
  assert.equal(await link.noticeFor({ type: "session.text.delta", data: { sessionID: "ses_main" } }, get), null);
});

test("a Mac's phones document, by mail, counts from the Macs that set the machine up alone, a newer one only: a phone removed there loses its way in", async () => {
  const machine = link.newKey(), mac = link.newKey(), other = link.newKey(), stranger = link.newKey();
  const seeds = { mac: link.newSigningSeed(), other: link.newSigningSeed(), stranger: link.newSigningSeed() };
  const [lost, fresh, own, others] = [0, 1, 2, 3].map(() => crypto.randomBytes(32));
  const k = key => key.toString("base64url");
  const macKey = k(link.publicOf(mac)), otherKey = k(link.publicOf(other));
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const first = link.signDoc(seeds.mac, "phones", 1, { phones: [{ key: k(lost), name: "Lost iPhone", pairing: "" }], removed: [] });
  link.writeLink({
    secret: crypto.randomBytes(32).toString("base64url"), key: machine.toString("base64url"), sign: link.newSigningSeed(), relay: "wss://relay.test", name: "m",
    mac: macKey, macs: [macKey, otherKey], macSigns: { [macKey]: link.signingKeyOf(seeds.mac), [otherKey]: link.signingKeyOf(seeds.other) },
    docs: { [`${link.signingKeyOf(seeds.mac)} phones`]: first },
    phones: [{ key: k(lost), name: "Lost iPhone", added: 1, from: "mac", mac: macKey, pairing: "" }, { key: k(own), name: "Paired here", added: 2, from: "pair", pairing: "" }],
  });
  const ended = [];
  const host = { keepOnly: keys => ended.push(keys.size), send() {} };
  const names = () => link.readLink().phones.map(phone => `${phone.from}:${phone.name}`);
  const give = (from, envelope) => link.receiveDocs({ key: k(link.publicOf(from)) }, { give: [envelope] }, host);

  // From a stranger, or signed by a stranger as if by the Mac, or older: nothing changes.
  await give(stranger, link.signDoc(seeds.stranger, "phones", 5, { phones: [{ key: k(fresh), name: "New iPhone", pairing: "" }], removed: [] }));
  await give(mac, link.signDoc(seeds.stranger, "phones", 5, { phones: [{ key: k(fresh), name: "New iPhone", pairing: "" }], removed: [] }));
  await give(mac, first);
  assert.deepEqual(names(), ["mac:Lost iPhone", "pair:Paired here"]);

  await give(mac, link.signDoc(seeds.mac, "phones", 2, { phones: [{ key: k(fresh), name: "New iPhone", pairing: "" }], removed: [{ key: k(lost), pairing: "" }] }));
  assert.deepEqual(names(), ["mac:New iPhone", "pair:Paired here"], "the Mac's phones now, and the machine's own pairing kept");
  assert.equal(ended.at(-1), 2, "the removed phone's sessions end");
  assert.equal(link.authorizePhone(lost, {}, undefined), false);
  // The other Mac's: its phones beside the first Mac's, which it leaves.
  await give(other, link.signDoc(seeds.other, "phones", 1, { phones: [{ key: k(others), name: "Other iPhone", pairing: "" }], removed: [] }));
  assert.deepEqual(names(), ["mac:New iPhone", "mac:Other iPhone", "pair:Paired here"]);

  // A Mac not heard from in 30 days no longer counts: its phones go, not for good.
  const later = link.readLink();
  link.forgetOldMacs(later, otherKey);
  link.forgetOldMacs(later, macKey, Date.now() + 31 * 24 * 3600 * 1000);
  link.foldPhones(later);
  assert.deepEqual(later.phones.map(phone => phone.name), ["New iPhone", "Paired here"]);
  assert.deepEqual(link.macsOf(later), [macKey]);
  assert.equal(later.removed.some(entry => entry.key === k(others)), false);
  fs.rmSync(path.join(home, "run", "link.json"));
});
test("Start goes through the box's tool, for an engine an older Mac stopped, the bridge staying up; there's no Stop; kuvo/info says whether it runs and whether it's stopped, and names its chats folder", async () => {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const said = path.join(home, "run", "box-said");
  fs.writeFileSync(path.join(bin, "kuvo-start"), `#!/bin/sh\necho "\${1:-box} bun=\${BUN_BE_BUN-}" >>"${said}"\n[ "$1" = stop ] && touch "${path.join(home, "run", "stopped")}"\nexit 0\n`);
  const handle = link.engineHandler(() => { throw new Error("none"); });
  // Never started from a Mac: there's nothing to start it as.
  assert.equal((await answer(handle, "POST", "kuvo/engine/start")).status, 409);
  fs.writeFileSync(path.join(bin, "kuvo-launch"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(home, "run", "launch.env"), "PATH=/usr/bin\n");
  const stop = [];
  for await (const part of handle({ method: "POST", path: "kuvo/engine/stop", headers: {}, body: Buffer.from("") }, {}, undefined)) stop.push(part);
  assert.notEqual(stop[0].head.status, 200);
  assert.equal(fs.existsSync(said), false, "nothing stopped");
  // An older Mac's Stop.
  fs.writeFileSync(path.join(home, "run", "stopped"), "");
  let info = await answer(handle, "GET", "kuvo/info");
  assert.equal(info.json.running, false);
  assert.equal(info.json.stopped, true);
  assert.equal(info.json.chats, path.join(home, "chats"));
  assert.equal(fs.statSync(path.join(home, "chats")).isDirectory(), true, "made, for a phone's first chat");
  assert.equal((await answer(handle, "POST", "kuvo/engine/start")).status, 202);
  // Started on its own, after the answer: once the tool is done.
  await link.toolRun();
  assert.deepEqual(fs.readFileSync(said, "utf8").trim().split("\n"), ["start bun="]);
  assert.equal((await answer(handle, "GET", "kuvo/engine/start")).status, 405);
  for (const name of ["bin/kuvo-start", "bin/kuvo-launch", "run/launch.env", "run/box-said", "run/stopped"]) fs.rmSync(path.join(home, name), { force: true });
});

test("each feature kuvo/info names is a route the machine answers, and one it doesn't name isn't", async () => {
  const handle = link.engineHandler(() => { throw new Error("none"); }, {}, () => { throw new Error("none"); });
  const status = async (method, route, body = {}) => {
    for await (const part of handle({ method, path: route, headers: {}, body: Buffer.from(JSON.stringify(body)) }, {}, undefined)) if (part.head) return part.head.status;
  };
  // Where each one is reached: a route a client would ask first, answered with whatever this box
  // has now, never as one it doesn't have (403).
  const routes = {
    "accounts.credentials": ["GET", "kuvo/accounts/credentials"], agents: ["GET", "kuvo/agents/api/session"], asks: ["GET", "kuvo/asks"], attention: ["GET", "kuvo/attention"],
    bots: ["GET", "kuvo/bots"], "bots.edit": ["DELETE", "kuvo/bots/bot_none"], "bots.keys": ["GET", "kuvo/bots/bot_none/keys"],
    "bots.make": ["GET", "kuvo/bots/templates"], config: ["GET", "kuvo/config"], "engine.restart": ["GET", "kuvo/engine/restart"],
    "engine.start": ["GET", "kuvo/engine/start"], file: ["GET", "kuvo/file"], groups: ["GET", "kuvo/groups"],
    "groups.delete": ["DELETE", "kuvo/groups/grp_none"], "groups.edit": ["PATCH", "kuvo/groups/grp_none"], "groups.joinable": ["GET", "kuvo/groups/joinable"], "groups.make": ["POST", "kuvo/groups"],
    integrations: ["GET", "kuvo/integrations"], keys: ["GET", "kuvo/keys"], "mcp.catalog": ["GET", "kuvo/mcp/catalog"], named: ["GET", "kuvo/named"],
    personalities: ["GET", "kuvo/personalities"], phones: ["GET", "kuvo/phones"], "phones.pair": ["DELETE", "kuvo/phones/pair"], projects: ["GET", "kuvo/projects"],
    "sessions.agents": ["GET", "kuvo/sessions/ses_none/agents"], "shell.stop": ["POST", "kuvo/shell/sh_none/stop"],
    "sign-in.return": ["GET", "kuvo/sign-in/return"], skills: ["GET", "kuvo/skills"], update: ["GET", "kuvo/update"], wakes: ["GET", "kuvo/wakes"],
    "wakes.edit": ["POST", "kuvo/wakes/ses_none/pause"], worktrees: ["GET", "kuvo/worktrees"], "worktrees.events": ["POST", "kuvo/worktrees/events"],
  };
  const named = (await answer(handle, "GET", "kuvo/info")).json.features;
  assert.deepEqual([...named].sort(), Object.keys(routes).sort(), "every name has a route here, and every route here its name");
  for (const [feature, [method, route]] of Object.entries(routes)) assert.notEqual(await status(method, route), 403, `${feature}: ${method} ${route}`);
  // The Mac's own aren't here.
  for (const route of ["kuvo/hosts", "kuvo/machines", "kuvo/mac", "kuvo/claude-code", "kuvo/accounts/ended", "kuvo/usage"]) assert.equal(await status("GET", route), 403, route);
  fs.rmSync(path.join(home, "chats"), { recursive: true, force: true });
});

test("the box's keeper keeps the phone link up while a phone is paired, and the link starts the keeper again if it went", async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const flag = path.join(home, "run", "link.needed");
  link.writeLink({ secret: "s", key: "k", relay: "wss://relay.test", phones: [{ key: "p", name: "Phone", from: "mac", added: 1 }] });
  assert.equal(fs.existsSync(flag), true);
  link.writeLink({ secret: "s", key: "k", relay: "wss://relay.test", phones: [] });
  assert.equal(fs.existsSync(flag), false);
  // A pairing run out with no phone paired: the bridge ends, and the keeper starts it no more.
  link.writeLink({ secret: "s", key: "k", relay: "wss://relay.test", phones: [], pairing: { token: "t", expires: Date.now() + 60_000 } });
  assert.equal(fs.existsSync(flag), true);
  const ran = link.readLink();
  ran.pairing.expires = Date.now() - 1;
  fs.writeFileSync(link.LINK_FILE, JSON.stringify(ran));
  link.noLongerNeeded();
  assert.equal(fs.existsSync(flag), false);
  fs.rmSync(path.join(home, "run", "link.json"), { force: true });

  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const said = path.join(home, "run", "keeper-started");
  fs.writeFileSync(path.join(bin, "kuvo-start"), `#!/bin/sh\necho "\${1:-box}" >"${said}"\n`);
  fs.writeFileSync(path.join(home, "run", "box.pid"), "999999");
  link.keepKeeper();
  for (let i = 0; i < 100 && !fs.existsSync(said); i++) await new Promise(r => setTimeout(r, 30));
  assert.equal(fs.readFileSync(said, "utf8").trim(), "box");
  fs.rmSync(said);
  // An older Kuvo Code on a Mac put its own kuvo-start there, which only starts the engine after a
  // restart: the keeper starts from the copy it keeps of itself.
  fs.writeFileSync(path.join(bin, "kuvo-start"), `#!/bin/sh\necho older >"${said}"\n`);
  fs.writeFileSync(path.join(bin, ".kuvo-start-keeper"), `#!/bin/sh\ncase "\${1:-box}" in\nbox)\n  echo copy >"${said}"\n  ;;\nkeep)\n  ;;\nesac\n`);
  link.keepKeeper();
  for (let i = 0; i < 100 && !fs.existsSync(said); i++) await new Promise(r => setTimeout(r, 30));
  assert.equal(fs.readFileSync(said, "utf8").trim(), "copy");
  for (const name of ["bin/kuvo-start", "bin/.kuvo-start-keeper", "run/keeper-started", "run/box.pid"]) fs.rmSync(path.join(home, name), { force: true });
});

test("paired phones, as the Mac has them too: removals stick, only a new pairing lets one back, and nobody removes the Mac (Vectors/link.json)", () => {
  const byKey = (a, b) => (a.key + "/" + (a.pairing ?? "")).localeCompare(b.key + "/" + (b.pairing ?? ""));
  const view = book => ({
    phones: (book.phones ?? []).map(phone => ({ key: phone.key, pairing: phone.pairing ?? "", from: phone.from })).sort(byKey),
    removed: (book.removed ?? []).map(entry => ({ key: entry.key, pairing: entry.pairing })).sort(byKey),
  });
  for (const book of vectors("link.json").phoneBooks) {
    const state = { macs: book.macs, phones: book.phones.map(phone => ({ ...phone })), removed: [], macSigns: {}, docs: {} };
    const seeds = new Map(book.macs.map(mac => [mac, link.newSigningSeed()]));
    const counts = new Map();
    for (const step of book.steps) {
      let ok = true;
      if (step.op === "pair") link.pairPhone(state, { key: step.key, pairing: step.pairing, from: "pair" });
      else if (step.op === "remove") ok = link.removePhones(state, step.by, step.phones);
      else {
        // A Mac's newer phones document, as this box takes it.
        const seed = seeds.get(step.by);
        counts.set(step.by, (counts.get(step.by) ?? 0) + 1);
        state.macSigns[step.by] = link.signingKeyOf(seed);
        state.docs[`${link.signingKeyOf(seed)} phones`] = link.signDoc(seed, "phones", counts.get(step.by), { phones: step.phones, removed: step.removed ?? [] });
        link.foldPhones(state);
      }
      assert.equal(ok, step.ok, `${book.name}: ${step.op}`);
      assert.deepEqual(view(state), step.after, `${book.name}: ${step.op}`);
    }
  }
});

test("a phone lists the phones paired with a machine and removes a lost one there, which loses its sessions and its way in, for good", async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const mine = crypto.randomBytes(32), lost = crypto.randomBytes(32);
  link.writeLink({
    secret: "s", key: "k", relay: "wss://relay.test", mac: crypto.randomBytes(32).toString("base64url"),
    phones: [{ key: mine.toString("base64url"), name: "Mine", added: 1, from: "mac", pairing: "a" }, { key: lost.toString("base64url"), name: "Lost", added: 2, from: "mac", pairing: "b" }],
  });
  const ended = [];
  const handle = link.engineHandler(() => { throw new Error("none"); }, {}, () => null, changed => ended.push(changed.phones.map(phone => phone.name)));
  const as = async (key, method, p, body) => {
    const parts = [];
    for await (const part of handle({ method, path: p, headers: {}, body: Buffer.from(body ?? "") }, { key }, undefined)) parts.push(part);
    const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
    return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
  };

  const listed = await as(mine, "GET", "kuvo/phones");
  assert.deepEqual(listed.json.phones.map(phone => [phone.name, phone.pairing, phone.you]), [["Mine", "a", true], ["Lost", "b", false]]);
  assert.equal((await as(mine, "POST", "kuvo/phones/remove", JSON.stringify({ phones: [{ key: link.readLink().mac }] }))).status, 400, "never the Mac");
  assert.equal((await as(mine, "GET", "kuvo/phones/remove")).status, 405);

  assert.equal((await as(mine, "POST", "kuvo/phones/remove", JSON.stringify({ phones: [{ key: lost.toString("base64url"), pairing: "b" }] }))).status, 200);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(ended, [["Mine"]], "the lost one's sessions end, once the answer's on its way");
  assert.equal(link.authorizePhone(lost, {}, undefined), false, "and it can't come in");
  assert.equal((await as(lost, "POST", "kuvo/phones/remove", JSON.stringify({ phones: [{ key: mine.toString("base64url") }] }))).status, 400, "nor remove anyone");

  // The Mac's phones document, signed before it heard of the removal, doesn't bring it back.
  const before = link.readLink(), seed = link.newSigningSeed();
  before.macs = [before.mac];
  before.macSigns = { [before.mac]: link.signingKeyOf(seed) };
  before.docs = { [`${link.signingKeyOf(seed)} phones`]: link.signDoc(seed, "phones", 1, { phones: [{ key: mine.toString("base64url"), name: "Mine", pairing: "a" }, { key: lost.toString("base64url"), name: "Lost", pairing: "b" }], removed: [] }) };
  link.foldPhones(before);
  assert.deepEqual(before.phones.map(phone => phone.name), ["Mine"]);

  // Pairing it again lets it back in, though its key is one the machine has.
  const token = crypto.randomBytes(16).toString("base64url");
  link.updateLink(current => ({ ...current, pairing: { token, expires: Date.now() + 60_000 } }));
  assert.equal(link.authorizePhone(lost, { pair: token, name: "Found" }, undefined), true);
  const found = link.readLink().phones.find(phone => phone.key === lost.toString("base64url"));
  assert.ok(found && found.pairing && found.pairing !== "b", "a pairing of its own");
  assert.deepEqual(link.readLink().removed, [{ key: lost.toString("base64url"), pairing: "b" }], "the old one still out");
  fs.rmSync(path.join(home, "run", "link.json"), { force: true });
});

test("a phone paired with a machine gets a link there for another phone, which pairs with the machine itself, once, with the Mac closed", async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const mine = crypto.randomBytes(32), other = crypto.randomBytes(32);
  link.writeLink({ secret: crypto.randomBytes(32).toString("base64url"), key: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "lab",
    phones: [{ key: mine.toString("base64url"), name: "Mine", added: 1, from: "mac", pairing: "a" }] });
  const handle = link.engineHandler(() => { throw new Error("none"); }, {}, () => null);
  const as = async (method, p) => {
    const parts = [];
    for await (const part of handle({ method, path: p, headers: {}, body: Buffer.alloc(0) }, { key: mine }, undefined)) parts.push(part);
    const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
    return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
  };
  const asked = await as("POST", "kuvo/phones/pair");
  assert.equal(asked.status, 200);
  const given = new URL(asked.json.link);
  assert.equal(given.protocol, "kuvo-link:");
  assert.equal(given.searchParams.get("relay"), "wss://relay.test");
  assert.equal(given.searchParams.get("name"), "lab");
  assert.ok(asked.json.ends > Date.now() / 1000);
  const token = given.searchParams.get("token");
  assert.equal(link.authorizePhone(other, { pair: token, name: "Other" }, undefined), true);
  assert.ok(link.readLink().phones.some(phone => phone.name === "Other" && phone.from === "pair"), "paired with the machine itself");
  assert.equal(link.authorizePhone(crypto.randomBytes(32), { pair: token, name: "Third" }, undefined), false, "once");

  // Ended before it's used: it lets no one in.
  const again = new URL((await as("POST", "kuvo/phones/pair")).json.link).searchParams.get("token");
  assert.equal((await as("DELETE", "kuvo/phones/pair")).status, 200);
  assert.equal(link.authorizePhone(crypto.randomBytes(32), { pair: again, name: "Late" }, undefined), false);
  assert.equal((await as("GET", "kuvo/phones/pair")).status, 405);
  fs.rmSync(path.join(home, "run", "link.json"), { force: true });
});

test("a phone asks a machine who & can name: its own bots and sessions, then its other computers'", async () => {
  // Its own, from its engine.
  const engine = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url.startsWith("/api/session?") ? { data: [{ id: "ses_fix", title: "Fix the login", location: { directory: "/srv/shop" }, time: { updated: 2 } }] } : {}));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  try {
    const handle = link.engineHandler(() => ({ port: engine.address().port, password: "p" }), {}, () => null);
    const parts = [];
    for await (const part of handle({ method: "GET", path: "kuvo/named", headers: {}, body: Buffer.alloc(0) }, { key: crypto.randomBytes(32) }, undefined)) parts.push(part);
    assert.equal(parts[0].head.status, 200);
    assert.deepEqual(JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString()).agents,
      [{ session: "ses_fix", name: "Fix the login", kind: "session", machine: null, project: "shop", about: null }]);
  } finally {
    engine.closeAllConnections();
    engine.close();
  }
  // Its other computers': a machine's by its id, a Mac's own by the Mac's name, a machine the Mac speaks for by its.
  const mac = { key: "m".repeat(43), kind: "mac", name: "Studio" }, box = { key: "b".repeat(43), kind: "machine", id: "pi", name: "pi" };
  // Only sessions with a title, as a Mac's & offers them: a list names one without "New session".
  const told = {
    [mac.key]: { list: [{ session: "ses_notes", name: "Write the notes", kind: "session" }, { session: "ses_old", name: "Old box's", kind: "session", machine: "oldbox" },
      { session: "ses_blank", name: "New session", kind: "session" }] },
    [box.key]: { list: [{ session: "ses_scout", name: "Scout", kind: "bot", about: "Finds things" }, { session: "ses_fresh", name: "New session", kind: "session" }] },
  };
  assert.deepEqual(link.namedAgents([{ session: "ses_own", name: "Own", kind: "bot" }, { session: "ses_new", name: "New session", kind: "session" }], [mac, box], told).map(agent => [agent.session, agent.machine]),
    [["ses_own", null], ["ses_notes", "Studio"], ["ses_old", "oldbox"], ["ses_scout", "pi"]]);
});

test("a phone answers what an agent asks for while it browses on a machine, with the Mac closed: listed and answered as on the Mac, the answer going to the machine's browser", async () => {
  const run = path.join(home, "run");
  fs.mkdirSync(run, { recursive: true });
  const asks = [
    { id: "ask-1", kind: "signIn", host: "github.com", targetId: "T1", username: true, password: true, session: "ses_sub" },
    { id: "ask-2", kind: "code", host: "github.com", targetId: "T1", prompt: "The code GitHub sent", session: "ses_1" },
  ];
  fs.writeFileSync(path.join(run, "browser-asks.json"), JSON.stringify({ asks }));
  // The engine: a subagent's session, and the conversation it works for.
  const sessions = { ses_sub: { id: "ses_sub", parentID: "ses_1", title: "Look it up" }, ses_1: { id: "ses_1", title: "Fixer" } };
  const engine = http.createServer((request, response) => {
    const id = decodeURIComponent(request.url.split("/").pop());
    response.writeHead(sessions[id] ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: sessions[id] }));
  });
  await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
  const readEngine = () => ({ port: engine.address().port, password: "p" });
  // The browser's socket: it says hello first, as the keeper does, then takes answers.
  const taken = [];
  const browser = (await import("node:net")).createServer(socket => {
    socket.write(JSON.stringify({ method: "Kuvo.hello", params: { asks } }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.method === "Kuvo.answer") {
          taken.push(message.params);
          socket.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
        }
      }
    });
  });
  await new Promise(resolve => browser.listen(path.join(run, "browser.sock"), resolve));
  try {
    const handle = link.engineHandler(readEngine, { name: "Lokum" });
    // None while the browser isn't running: what one left behind was asked of no one now.
    assert.deepEqual((await answer(handle, "GET", "kuvo/asks")).json, { asks: [] });
    fs.writeFileSync(path.join(run, "browser.pid"), String(process.pid));
    const listed = await answer(handle, "GET", "kuvo/asks");
    // A subagent's, in the conversation it works for, by that one's name.
    assert.deepEqual(listed.json.asks[0], { id: "ask-1", kind: "signIn", host: "github.com", machine: "Lokum", session: "ses_1", asker: "Fixer", username: true, password: true, saved: [], offersToSave: false });
    assert.equal(listed.json.asks[1].prompt, "The code GitHub sent");

    assert.equal((await answer(handle, "POST", "kuvo/asks/ask-1", JSON.stringify({ answer: "signIn", saved: "me" }))).status, 400, "saved passwords are the Mac's");
    assert.equal((await answer(handle, "POST", "kuvo/asks/ask-1", JSON.stringify({ answer: "code", code: "1" }))).status, 400, "not what it asks");
    assert.equal((await answer(handle, "POST", "kuvo/asks/ask-9", JSON.stringify({ answer: "declined" }))).status, 404);
    assert.equal((await answer(handle, "POST", "kuvo/asks/ask-1", JSON.stringify({ answer: "signIn", username: "me", password: "secret" }))).status, 200);
    assert.equal((await answer(handle, "POST", "kuvo/asks/ask-2", JSON.stringify({ answer: "code", code: " 123456 " }))).status, 200);
    assert.deepEqual(taken, [
      { id: "ask-1", answer: { type: "signIn", username: "me", password: "secret" } },
      { id: "ask-2", answer: { type: "code", code: "123456" } },
    ]);

    // Its notification, as the Mac words it (in the conversation it's filed in).
    assert.deepEqual(link.askNotice({ ...asks[0], session: "ses_1" }, "Fixer"), { title: "Sign in to github.com", subtitle: "Fixer", body: "The agent needs your sign-in to go on.", category: "ask", thread: "ses_1", data: { session: "ses_1", ask: "ask-1" } });
    assert.equal(link.askNotice(asks[1]).body, "The code GitHub sent");
  } finally {
    browser.close();
    engine.close();
    for (const name of ["browser-asks.json", "browser.pid"]) fs.rmSync(path.join(run, name), { force: true });
  }
  // The browser gone: an answer can't reach it.
  assert.equal(await link.answerAsk("ask-1", { type: "declined" }, path.join(run, "browser.sock")), false);
});

test("a group chat that lives on a machine tells your phones its news, as the Mac words it", () => {
  const met = link.groupNotice({ type: "kuvo.group.met", data: { id: "grp_1", name: "Standup", who: "Ada", last: { kind: "wrapUp", text: "**Done**: shipped the fix." } } });
  assert.deepEqual(met, { title: "Standup", subtitle: "Ada\u2019s wrap-up", body: "Done: shipped the fix.", category: "message", thread: "grp_1", data: { group: "grp_1" } });
  assert.equal(link.groupNotice({ type: "kuvo.group.met", data: { id: "grp_1", name: "Standup", who: "Ada", last: { kind: "message", text: "Hi" } } }).subtitle, "Ada");
  assert.equal(link.groupNotice({ type: "kuvo.group.met", data: { id: "grp_1", name: "Standup" } }).body, "The meeting came, but no one could take part.");
  const done = link.groupNotice({ type: "kuvo.group.done", data: { id: "grp_1", name: "Standup", who: "Ada", text: "x".repeat(400) } });
  assert.equal(done.subtitle, "Ada finished its part");
  assert.equal(done.body.length, 220);
  assert.equal(link.groupNotice({ type: "kuvo.group.done", data: {} }), null);
});

test("a machine that owns its settings has them read and changed from a phone, as the Mac's are: key by key, a change that read something else turned away", async () => {
  const folder = path.join(home, "box");
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "opencode.json");
  fs.writeFileSync(file, JSON.stringify({ model: "anthropic/sonnet", permissions: [{ action: "shell", resource: "*", effect: "ask" }], mcp: { servers: { linear: { url: "https://mcp.linear.app" } } } }));
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "mcp-catalog.json"), JSON.stringify({ servers: [
    { id: "linear", title: "Linear", summary: "Issues", access: "signIn", integration: true, settings: { url: "https://mcp.linear.app" } },
    { id: "context7", title: "Context7", summary: "Docs", access: "open", settings: { url: "https://mcp.context7.com/mcp" } },
    { id: "chrome-devtools", title: "Chrome DevTools", summary: "Chrome", access: "local", macOnly: true, settings: { command: ["npx"] } },
  ] }));
  try {
    const handle = link.engineHandler(() => { throw new Error("none"); });
    assert.equal((await answer(handle, "GET", "kuvo/config")).json.model, "anthropic/sonnet");

    const patched = await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [
      { path: ["model"], value: "openai/gpt-6", was: "anthropic/sonnet" },
      { path: ["mcp", "servers", "linear", "disabled"], value: true },
    ] }));
    assert.equal(patched.status, 200);
    assert.equal(patched.json.model, "openai/gpt-6");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers.linear.disabled, true, "written to its own file");
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);

    // Read before that change: turned away, nothing changed.
    const stale = await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [{ path: ["model"], value: "x/y", was: "anthropic/sonnet" }] }));
    assert.equal(stale.status, 409);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).model, "openai/gpt-6");
    // Through a list: sent whole instead.
    assert.equal((await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [{ path: ["permissions", "0", "effect"], value: "deny" }] }))).status, 400);
    assert.equal((await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [] }))).status, 400);
    // A server applied from another computer (a phone's Also Apply), its key named where that one
    // keeps its keys: named where this one keeps them.
    await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [{ path: ["mcp", "servers", "todoist"], value: {
      type: "local", command: ["kuvo-npx", "@doist/todoist-mcp"], environment: { API_KEY: "{file:/var/folders/x/T/run.kuvo.code/keys/KUVO_KEY_TODOIST_API_KEY}" } } }] }));
    assert.match(JSON.parse(fs.readFileSync(file, "utf8")).mcp.servers.todoist.environment.API_KEY, /\/box\/keys\/KUVO_KEY_TODOIST_API_KEY\}$/);
    await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [{ path: ["mcp", "servers", "todoist"], value: null }] }));
    // Removing a key, and the object it leaves empty.
    await answer(handle, "PATCH", "kuvo/config", JSON.stringify({ changes: [{ path: ["mcp", "servers", "linear"], value: null }] }));
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcp, undefined);

    // Popular servers: the Mac's own apps' left out; adding one writes it as the Mac's Add does.
    const catalog = await answer(handle, "GET", "kuvo/mcp/catalog");
    assert.deepEqual(catalog.json.servers.map(server => [server.id, server.added]), [["linear", false], ["context7", false]]);
    const added = await answer(handle, "POST", "kuvo/mcp/catalog/context7");
    assert.equal(added.status, 200);
    assert.deepEqual(added.json.mcp.servers.context7, { codemode: false, url: "https://mcp.context7.com/mcp" });
    assert.equal((await answer(handle, "POST", "kuvo/mcp/catalog/chrome-devtools")).status, 404);

    // Its integrations' keys: listed, read, set and removed, in its own keys' folder; a bot's own
    // and anything that isn't a key's name, never.
    assert.deepEqual((await answer(handle, "GET", "kuvo/keys")).json, { keys: [] });
    assert.equal((await answer(handle, "PUT", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN", JSON.stringify({ value: "ghp_1" }))).status, 200);
    assert.equal(fs.readFileSync(path.join(folder, "keys", "KUVO_KEY_GITHUB_TOKEN"), "utf8"), "ghp_1");
    assert.equal((fs.statSync(path.join(folder, "keys", "KUVO_KEY_GITHUB_TOKEN")).mode & 0o777), 0o600);
    fs.writeFileSync(path.join(folder, "keys", "KUVO_KEY_GITHUB_TOKEN__BOT_A"), "ghp_bot");
    assert.deepEqual((await answer(handle, "GET", "kuvo/keys")).json, { keys: ["KUVO_KEY_GITHUB_TOKEN"] });
    assert.deepEqual((await answer(handle, "GET", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN")).json, { value: "ghp_1" });
    assert.equal((await answer(handle, "GET", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN__BOT_A")).status, 400);
    assert.equal((await answer(handle, "GET", "kuvo/keys/%E0%A4%A")).status, 400, "a broken escape");
    assert.equal((await answer(handle, "PUT", "kuvo/keys/..%2Fopencode.json", JSON.stringify({ value: "x" }))).status, 400);
    assert.equal((await answer(handle, "PUT", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN", JSON.stringify({ value: "" }))).status, 400);
    assert.equal((await answer(handle, "DELETE", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN")).status, 200);
    assert.equal((await answer(handle, "GET", "kuvo/keys/KUVO_KEY_GITHUB_TOKEN")).status, 404);

    // A file with comments is left alone.
    fs.writeFileSync(file, "{ // mine\n}");
    assert.equal((await answer(handle, "GET", "kuvo/config")).status, 409);
  } finally {
    fs.rmSync(path.join(home, "box"), { recursive: true, force: true });
    fs.rmSync(path.join(home, "bin", "mcp-catalog.json"), { force: true });
  }
});

test("a machine's settings become its own once: what it runs with now, its Mac's over the global file, with its keys, in a box no older start writes", () => {
  const global = path.join(home, "config", "opencode", "opencode.json");
  const keys = path.join(home, "keys");
  fs.mkdirSync(path.dirname(global), { recursive: true });
  fs.mkdirSync(keys, { recursive: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  const reference = name => `{file:${home}/keys/${name}}`;
  fs.writeFileSync(global, JSON.stringify({ websearch: { provider: "exa" }, mcp: { servers: { linear: { url: "https://mcp.linear.app", headers: { Authorization: reference("KUVO_KEY_LINEAR_TOKEN") } } } } }));
  fs.writeFileSync(path.join(keys, "settings.json"), JSON.stringify({ model: "anthropic/sonnet", websearch: { provider: "tavily" }, permissions: [{ action: "shell", resource: "*", effect: "ask" }], mcp: { servers: { context7: { url: "https://mcp.context7.com/mcp" } } } }));
  fs.writeFileSync(path.join(keys, "KUVO_KEY_LINEAR_TOKEN"), "lin-secret");
  fs.writeFileSync(path.join(keys, "KUVO_KEY_NOTION_TOKEN__bot_1"), "bot-secret");
  fs.writeFileSync(path.join(home, "run", "launch.env"), "PATH=/usr/bin\nKUVO_SETTINGS={\"websearch\":{}}\nKUVO_TZ=Europe/Istanbul\n");
  try {
    const adopted = link.adoptBox(null);
    assert.equal(adopted.status, "adopted");
    assert.equal(adopted.seeded, false);
    const own = JSON.parse(fs.readFileSync(path.join(home, "box", "opencode.json"), "utf8"));
    assert.deepEqual(adopted.settings, own);
    assert.equal(own.model, "anthropic/sonnet");
    assert.equal(own.websearch.provider, "tavily", "the Mac's own settings win, as they did");
    assert.deepEqual(Object.keys(own.mcp.servers).sort(), ["context7", "linear"], "both files' servers");
    assert.equal(own.mcp.servers.linear.headers.Authorization, `{file:${home}/box/keys/KUVO_KEY_LINEAR_TOKEN}`, "its key where the box keeps it");
    assert.deepEqual(own.permissions, [{ action: "shell", resource: "*", effect: "ask" }, link.BOT_MEMORY_RULE], "its rules, and bots' memory theirs to write");
    assert.equal(fs.readFileSync(path.join(home, "box", "keys", "KUVO_KEY_LINEAR_TOKEN"), "utf8"), "lin-secret");
    assert.equal(fs.existsSync(path.join(home, "box", "keys", "KUVO_KEY_NOTION_TOKEN__bot_1")), false, "a bot's own stays with the bot");
    // What runs now reads what it started with, untouched; the next start clears it.
    assert.match(fs.readFileSync(global, "utf8"), /linear/);
    assert.equal(fs.existsSync(path.join(keys, "settings.json")), true);
    assert.equal(fs.existsSync(path.join(home, "box", "global-adopted")), true);
    assert.equal(fs.readFileSync(path.join(home, "run", "launch.env"), "utf8"), "PATH=/usr/bin\nKUVO_TZ=Europe/Istanbul\n", "no start writes them back");
    assert.ok(fs.existsSync(path.join(home, "box", "adopted-from", "settings.json")), "what it was made from, kept");
    assert.equal((fs.statSync(path.join(home, "box")).mode & 0o777), 0o700);
    // Once: again, nothing changes.
    fs.writeFileSync(path.join(keys, "settings.json"), JSON.stringify({ model: "x/y" }));
    assert.equal(link.adoptBox(null).status, "own");
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "box", "opencode.json"), "utf8")).model, "anthropic/sonnet");
  } finally {
    for (const name of ["box", "config", "keys", "run/launch.env"]) fs.rmSync(path.join(home, name), { recursive: true, force: true });
  }

  // A machine with nothing yet: the Mac's, as it would have sent them.
  try {
    const seed = { settings: { model: "openai/gpt-6", mcp: { servers: { linear: { headers: { Authorization: reference("KUVO_KEY_LINEAR_TOKEN") } } } } }, keys: { KUVO_KEY_LINEAR_TOKEN: "seeded", nope: "x" } };
    const seeded = link.adoptBox(seed);
    assert.equal(seeded.status, "adopted");
    assert.equal(seeded.seeded, true);
    const own = JSON.parse(fs.readFileSync(path.join(home, "box", "opencode.json"), "utf8"));
    assert.equal(own.model, "openai/gpt-6");
    assert.equal(own.mcp.servers.linear.headers.Authorization, `{file:${home}/box/keys/KUVO_KEY_LINEAR_TOKEN}`);
    assert.equal(fs.readFileSync(path.join(home, "box", "keys", "KUVO_KEY_LINEAR_TOKEN"), "utf8"), "seeded");
    assert.deepEqual(fs.readdirSync(path.join(home, "box", "keys")), ["KUVO_KEY_LINEAR_TOKEN"]);
    // Its own keys, set and taken away.
    assert.equal(link.setBoxKey("KUVO_KEY_GITHUB_TOKEN", "gh").status, 200);
    assert.equal(fs.readFileSync(path.join(home, "box", "keys", "KUVO_KEY_GITHUB_TOKEN"), "utf8"), "gh");
    assert.equal(link.setBoxKey("KUVO_KEY_GITHUB_TOKEN", null).status, 200);
    assert.equal(fs.existsSync(path.join(home, "box", "keys", "KUVO_KEY_GITHUB_TOKEN")), false);
    assert.equal(link.setBoxKey("../settings", "x").status, 400);
  } finally {
    fs.rmSync(path.join(home, "box"), { recursive: true, force: true });
  }
});

test("personalities' libraries meet as the vectors say", () => {
  for (const each of vectors("personalities.json").cases) {
    assert.deepEqual(link.mergePersonalities(...each.libraries), each.expected, each.name);
  }
});

test("a phone makes, changes and removes personalities in a machine's library; a bot made there can have them, told as the Mac words it", () => {
  const file = path.join(home, "bots", "personalities-test.json");
  const lock = path.join(home, "run", ".personalities-test.lock");
  try {
    assert.deepEqual(link.answerPersonalities("GET", undefined, undefined, file, lock), [200, { personalities: [] }]);
    const [made, personality] = link.answerPersonalities("POST", undefined, { name: " Night  Owl ", description: "Works late, writes short." }, file, lock);
    assert.equal(made, 200);
    assert.match(personality.id, /^custom\./);
    assert.equal(personality.name, "Night Owl");
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
    assert.equal(link.answerPersonalities("POST", undefined, { name: "No words" }, file, lock)[0], 400);
    const [changed, after] = link.answerPersonalities("PATCH", personality.id, { description: "Works late." }, file, lock);
    assert.equal(changed, 200);
    assert.equal(after.description, "Works late.");
    assert.ok(after.updated > personality.updated || after.updated === personality.updated + 1);
    const kit = { personalities: [{ id: "preset.calm", name: "Calm", description: "Calm.", custom: false, instruction: "Be calm." }], personalityWords: "Your personality: ⟦name⟧. ⟦description⟧ Show it." };
    const offered = link.botPersonalities(kit, link.readPersonalities(file));
    assert.deepEqual(offered.map(each => each.id), ["preset.calm", personality.id]);
    assert.equal(offered[1].instruction, "Your personality: Night Owl. Works late. Show it.");
    // Removed: gone from the list, noted, and an older copy met with it doesn't bring it back.
    assert.deepEqual(link.answerPersonalities("DELETE", personality.id, undefined, file, lock), [200, {}]);
    assert.equal(link.answerPersonalities("DELETE", personality.id, undefined, file, lock)[0], 404);
    const met = link.changePersonalities(library => link.mergePersonalities(library, { personalities: [personality] }), file, lock);
    assert.deepEqual(met.personalities, []);
    assert.equal(met.removed[0].id, personality.id);
    assert.equal(link.answerPersonalities("PATCH", "preset.calm", { name: "x" }, file, lock)[0], 404);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("a machine's settings get bots' memory rule once: one you took out stays out", () => {
  fs.mkdirSync(path.join(home, "box"), { recursive: true });
  const file = path.join(home, "box", "opencode.json");
  fs.writeFileSync(file, JSON.stringify({ model: "x/y" }));
  try {
    assert.equal(link.adoptBox(null).status, "own");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, [link.BOT_MEMORY_RULE]);
    fs.writeFileSync(file, JSON.stringify({ model: "x/y", permissions: [] }));
    link.adoptBox(null);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, []);
  } finally {
    fs.rmSync(path.join(home, "box"), { recursive: true, force: true });
  }
});
