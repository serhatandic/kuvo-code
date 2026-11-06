// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents"), as
// its box keeps them: what it says your computers are (a machine you remove named so it lets this
// Mac go), what it takes of its machines' (their views of your personalities, a forged one never),
// counts that never go back (from before the move too), and the copy its app keeps for an older
// Kuvo Code. Only this Mac's app is a stand-in; the machines are documents signed with keys of
// their own.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/mac-docs.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-docs-")));
removeAtEnd(support);

// This Mac's app: its keys, as your Keychain keeps them.
const appHost = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const given = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (request.url === "/hello") {
      const proof = crypto.createHmac("sha256", "host-password").update(`kuvo-host-hello\u0000${given.nonce}\u0000127.0.0.1:${appHost.address().port}`).digest("hex");
      return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    }
    if (request.headers.authorization !== "Bearer host-password") return response.writeHead(401).end();
    if (request.url === "/link/identity") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(keys));
    response.writeHead(404).end();
  });
});
await new Promise(resolve => appHost.listen(0, "127.0.0.1", resolve));
atEnd(() => appHost.close());

Object.assign(process.env, {
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
  KUVO_HOST_URL: `http://127.0.0.1:${appHost.address().port}`,
  KUVO_HOST_PASSWORD: "host-password",
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const macSeed = link.newSigningSeed();
const macSign = link.signingKeyOf(macSeed);
const keys = { key: link.newKey().toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), sign: macSeed };

const handle = link.engineHandler(link.readEngineFile, { name: "Mac" });
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

// A machine as this Mac set it up: its link key, its address, and the key it signs with.
function machine(id) {
  const seed = link.newSigningSeed();
  return {
    id,
    seed,
    peer: { key: link.publicOf(link.newKey()).toString("base64url"), sign: link.signingKeyOf(seed), address: crypto.randomBytes(16).toString("base64url"), name: id, id },
    sign: (kind, n, body) => link.signDoc(seed, kind, n, body),
  };
}

// This Mac's own documents as setting up a machine gives them, read.
async function own() {
  const setup = await ask("GET", "kuvo/link/setup");
  assert.equal(setup.status, 200);
  assert.equal(setup.json.macSign, macSign);
  return Object.fromEntries(setup.json.docs.map(link.readDoc).filter(doc => doc?.origin === macSign).map(doc => [doc.kind, doc]));
}

// A box of its own for each test: no link file, the app's config on, these machines its peers.
async function fresh(...machines) {
  fs.rmSync(path.join(support, "box"), { recursive: true, force: true });
  link.macLink.overlay = null;
  assert.equal((await ask("PUT", "kuvo/link/config", { phones: true, machines: true, relay: "ws://127.0.0.1:9", name: "Studio Mac", app: "0.9.0" })).status, 200);
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: machines.map(each => each.peer), moved: [] })).status, 200);
}

test("who this Mac's computers are: itself and its machines, each with the key it signs with; a machine you remove is named so it lets this Mac go, one set up again isn't", async () => {
  const lab = machine("lab.invalid"), shed = machine("shed.invalid");
  await fresh(lab, shed);
  let peers = (await own()).peers.body;
  assert.deepEqual(peers.boxes.map(box => box.id ?? box.kind).sort(), ["lab.invalid", "mac", "shed.invalid"]);
  assert.equal(peers.boxes.find(box => box.id === "lab.invalid").sign, lab.peer.sign);
  assert.deepEqual(peers.left, []);
  // Just missing (it couldn't be set up just now): not one now, and not removed either.
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [lab.peer], moved: [] })).status, 200);
  peers = (await own()).peers.body;
  assert.deepEqual(peers.boxes.filter(box => box.kind === "machine").map(box => box.id), ["lab.invalid"]);
  assert.deepEqual(peers.left, []);
  // Removed: named as left.
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [lab.peer], moved: [], removed: [shed.peer.key] })).status, 200);
  assert.deepEqual((await own()).peers.body.left, [shed.peer.key]);
  // Set up again: no longer, as setting it up asks (`?key=`), and once it's back among them.
  const setup = await ask("GET", `kuvo/link/setup?key=${shed.peer.key}`);
  assert.deepEqual(setup.json.docs.map(link.readDoc).find(doc => doc?.origin === macSign && doc.kind === "peers").body.left, []);
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [lab.peer, shed.peer], moved: [] })).status, 200);
  assert.deepEqual((await own()).peers.body.left, []);
});

test("one computer under two names stays one of this Mac's when one name is forgotten", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab, { peer: { ...lab.peer, id: "lab-alias.invalid", name: "lab-alias.invalid" } });
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [lab.peer], moved: [] })).status, 200);
  const peers = (await own()).peers.body;
  assert.deepEqual(peers.boxes.filter(box => box.kind === "machine").map(box => box.id), ["lab.invalid"]);
  assert.deepEqual(peers.left, [], "still one of this Mac's, so not told to let it go");
});

test("a machine's view of your personalities comes in, an older or forged one changes nothing, and one removed there goes here", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  const id = `custom.lab-${crypto.randomUUID()}`;
  const made = { id, name: "Calm", description: "Made on the machine.", symbol: "person.crop.circle", updated: 1_760_000_000_000 };
  const give = async envelope => assert.equal((await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [envelope] } })).status, 200);
  const personality = async () => (await ask("GET", "kuvo/personalities")).json.personalities.find(each => each.id === id);
  await give(lab.sign("personalities", 5, { personalities: [made], removed: [] }));
  assert.equal((await personality())?.description, "Made on the machine.");
  // An older view, though it counts the change higher: nothing.
  await give(lab.sign("personalities", 4, { personalities: [{ ...made, description: "Older.", updated: 1_760_000_000_900 }], removed: [] }));
  assert.equal((await personality())?.description, "Made on the machine.");
  // Signed by another key, as if by the machine; or the machine's own, with its signature broken: nothing.
  await give(link.signDoc(link.newSigningSeed(), "personalities", 9, { personalities: [{ ...made, description: "Forged.", updated: 1_770_000_000_000 }], removed: [] }));
  const broken = lab.sign("personalities", 9, { personalities: [{ ...made, description: "Broken.", updated: 1_770_000_000_000 }], removed: [] });
  await give({ d: broken.d, s: Buffer.from(Buffer.from(broken.s, "base64url").map((byte, i) => (i === 0 ? byte ^ 1 : byte))).toString("base64url") });
  assert.equal((await personality())?.description, "Made on the machine.");
  // Removed there: removed here.
  await give(lab.sign("personalities", 6, { personalities: [], removed: [{ id, removed: 1_760_000_000_001 }] }));
  assert.equal(await personality(), undefined);
  // Not from one of this Mac's machines at all: refused.
  assert.equal((await ask("POST", "kuvo/link/docs", { from: machine("stranger").peer.key, docs: { give: [] } })).status, 404);
});

test("this Mac's counts go past what a machine says it has, but never past what a box can count on", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  let now = await own();
  const was = now.phones.n;
  // A machine has this Mac's peers document further on (from a copy put back, say): the next goes past it.
  assert.equal((await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { have: [[macSign, "peers", 40, "x"]] } })).status, 200);
  assert.equal((await own()).peers.n, 41);
  // But never to what a box can't count on.
  assert.equal((await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { have: [[macSign, "peers", Number.MAX_SAFE_INTEGER, "x"], [macSign, "phones", 2 ** 60, "x"]] } })).status, 200);
  now = await own();
  assert.equal(now.peers.n, 41);
  assert.equal(now.phones.n, was);
  // What the app reads of them: the counts as they are now.
  const kept = (await ask("GET", "kuvo/link/documents")).json;
  assert.equal(kept.own.peers.n, 41);
  assert.equal(kept.own.phones.n, was);
});

test("the digest this Mac's agents' mail carries names its own documents as they are now, and those it keeps of its machines", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [lab.sign("phones", 2, { phones: [], removed: [] })] } });
  const have = (await ask("GET", "kuvo/link/documents")).json.have;
  const named = have.map(([origin, kind, n]) => `${origin === macSign ? "mac" : origin === lab.peer.sign ? "lab" : origin} ${kind} ${n}`).sort();
  assert.deepEqual(named, ["lab phones 2", "mac peers 1", "mac personalities 1", "mac phones 1"]);
});

test("a machine's view coming in is told to whoever follows your personalities here (the app, which tells its bots), and removed there wins over a change made here", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  const id = `custom.lab-${crypto.randomUUID()}`;
  const made = { id, name: "Calm", description: "Made on the machine.", symbol: "person.crop.circle", updated: 1_760_000_000_000 };
  // Followed, as the app follows it.
  const stop = new AbortController();
  const lines = [];
  let heard;
  const following = (async () => {
    for await (const part of handle({ method: "GET", path: "kuvo/personalities/events", headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)) {
      if (!part.body) continue;
      for (const line of part.body.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
        heard?.();
      }
    }
  })();
  const next = () => new Promise(resolve => { heard = resolve; });
  try {
    await next();
    const told = next();
    await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [lab.sign("personalities", 5, { personalities: [made], removed: [] })] } });
    await told;
    assert.equal(lines.at(-1).personalities.find(each => each.id === id)?.description, "Made on the machine.");
    // Changed here, then removed there: gone.
    assert.equal((await ask("PATCH", `kuvo/personalities/${id}`, { description: "Changed here." })).status, 200);
    await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [lab.sign("personalities", 6, { personalities: [], removed: [{ id, removed: 1_760_000_000_001 }] })] } });
    assert.equal((await ask("GET", "kuvo/personalities")).json.personalities.find(each => each.id === id), undefined);
  } finally {
    stop.abort();
    await following.catch(() => {});
  }
});

test("a machine's record that isn't one is left out, never the rest with it", async () => {
  const lab = machine("lab.invalid"), shed = machine("shed.invalid");
  await fresh();
  const broken = { ...shed.peer, address: "not an address" };
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: [lab.peer, broken], moved: [] })).status, 200);
  assert.deepEqual((await own()).peers.body.boxes.filter(box => box.kind === "machine").map(box => box.id), ["lab.invalid"]);
  // What isn't a list at all is still refused.
  assert.equal((await ask("PUT", "kuvo/link/peers", { peers: "lab" })).status, 400);
});

test("what this Mac takes of its own and its machines': a copy of its own further on (it lost count) moves it past it, an older one never back; a machine's word on who your computers are, never", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  const give = async envelope => assert.equal((await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [envelope] } })).status, 200);
  // Its own peers document at version 50, as a machine kept it: this Mac goes past it.
  await give(link.signDoc(macSeed, "peers", 50, { boxes: [], moved: [], left: [] }));
  assert.equal((await own()).peers.n, 51);
  // An older copy of its own phones: nothing goes back.
  const phones = (await own()).phones.n;
  await give(link.signDoc(macSeed, "phones", 1, { phones: [], removed: [] }));
  assert.equal((await own()).phones.n, phones);
  // A machine saying who your computers are: not this Mac's to take.
  await give(lab.sign("peers", 3, { boxes: [], moved: [], left: [] }));
  const have = (await ask("GET", "kuvo/link/documents")).json.have;
  assert.ok(!have.some(([origin, kind]) => origin === lab.peer.sign && kind === "peers"), JSON.stringify(have));
});

test("with the phone link off, this Mac's documents say nothing of your phones (your machines keep what they had)", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  assert.equal((await ask("PUT", "kuvo/link/config", { phones: false, machines: true, relay: "ws://127.0.0.1:9", name: "Studio Mac", app: "0.9.0" })).status, 200);
  const setup = await ask("GET", "kuvo/link/setup");
  const kinds = setup.json.docs.map(link.readDoc).filter(doc => doc?.origin === macSign).map(doc => doc.kind).sort();
  assert.deepEqual(kinds, ["peers", "personalities"]);
});

test("a machine's documents coming in, before this Mac's box knows its own agents (its engine starting), keep them in the list its group chats name", async () => {
  const lab = machine("lab.invalid");
  await fresh(lab);
  const agents = path.join(support, "box", "run", "agents.json");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, JSON.stringify({ machine: null, agents: [{ session: "ses_mine", name: "Ada", kind: "bot" }] }));
  assert.equal((await ask("POST", "kuvo/link/docs", { from: lab.peer.key, docs: { give: [lab.sign("phones", 2, { phones: [], removed: [] })] } })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(agents, "utf8")).agents.map(agent => agent.session), ["ses_mine"]);
});
