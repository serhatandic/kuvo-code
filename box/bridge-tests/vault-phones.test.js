// A machine's vault activity, read by your phones (PROTOCOL.md, "Vault"): each phone hears which
// lines it made itself (`mine`), by the key it paired with, never by its name, which every phone
// may share ("iPhone"). So one phone's look at an item never reads as another's.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault-phones.test.js`.
import "./test-safety.js";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { script } from "./bot-keys-scenarios.js";
import { relayStandIn } from "./relay-stand-in.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

// (A short folder: the vault's socket lives in it.)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kvp-"));
const home = path.join(root, ".kuvo-code");
removeAtEnd(root);
// Each change on the relay (a device on it or gone) wakes whoever waits for one.
let poke = () => {};
const relay = await relayStandIn(link, { changed: () => poke() });
atEnd(() => relay.close());

// The machine's own keys, and two phones paired with it, both named as a phone without the
// device-name entitlement names itself.
const machineKey = link.newKey();
const secret = crypto.randomBytes(32);
const machineAddress = link.addressOf(secret);
const phoneKeys = [link.newKey(), link.newKey()];

let bridge;
before(async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "link.json"), JSON.stringify({
    id: "lab", name: "lab", relay: relay.url,
    secret: secret.toString("base64url"),
    key: machineKey.toString("base64url"),
    phones: phoneKeys.map(key => ({ key: link.publicOf(key).toString("base64url"), name: "iPhone", added: Math.floor(Date.now() / 1000), from: "pair", pairing: crypto.randomBytes(16).toString("base64url") })),
  }), { mode: 0o600 });
  // (On this test's runtime: the engine's Bun is one only with BUN_BE_BUN.)
  bridge = spawn(process.execPath, [script, "run"], { env: { PATH: process.env.PATH, HOME: root, KUVO_HOME: home, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", chunk => { said += chunk; });
  // On the relay once it's there, or the test hears why the bridge ended.
  const ended = new Promise((_, reject) => bridge.once("exit", code => reject(new Error(`the bridge ended (${code}): ${said}`))));
  while (!relay.has(machineAddress)) await Promise.race([new Promise(done => { poke = done; }), ended]);
  // (Its end at the test's own end isn't a failure.)
  ended.catch(() => {});
});
atEnd(async () => {
  if (!bridge || bridge.exitCode !== null) return;
  const exited = new Promise(resolve => bridge.once("exit", resolve));
  bridge.kill("SIGTERM");
  await exited;
});

// A phone on the relay, in a session with the machine: its requests and their whole answers.
async function phone(key) {
  const device = relay.device();
  const session = crypto.randomInt(1, 2 ** 31);
  const frames = async () => {
    const message = link.readRelay(await device.next(10_000));
    if (message?.kind !== "deliver") return { kind: "unreachable" };
    return link.readFrame(message.payload);
  };
  const initiator = new link.IKInitiator(key, link.publicOf(machineKey), link.PROLOGUE);
  device.send(machineAddress, link.frame(link.Frame.handshake1, session, initiator.writeMessage1(Buffer.from(JSON.stringify({ v: 1, name: "iPhone", app: "0" })))));
  const answer = await frames();
  assert.equal(answer.kind, link.Frame.handshake2, "the machine lets the phone in");
  const { transport } = initiator.readMessage2(answer.body);
  let id = 0;
  return async (method, route, body) => {
    id += 1;
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    for (const piece of link.pieces({ t: "req", id, m: method, p: route, h: body === undefined ? {} : { "content-type": "application/json" } }, bytes, true)) {
      device.send(machineAddress, link.frame(link.Frame.transport, session, transport.seal(piece)));
    }
    const pieces = [];
    for (;;) {
      const next = await frames();
      assert.equal(next.kind, link.Frame.transport);
      const message = link.decodeMessage(transport.open(next.body));
      pieces.push(message);
      if (message.head.end === true) break;
    }
    const text = Buffer.concat(pieces.map(each => each.body)).toString("utf8");
    return { status: pieces[0].head.s, value: text ? JSON.parse(text) : {} };
  };
}

test("each phone hears which of the vault's activity it did itself, though both are named “iPhone”", async () => {
  const [first, second] = [await phone(phoneKeys[0]), await phone(phoneKeys[1])];
  // The first phone makes the vault with its first item; the second looks at it.
  const added = await first("POST", "kuvo/vault/items", { kind: "login", name: "Bank login", sites: ["bank.example"], username: "me", values: { password: "hunter2-correct-horse" } });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.equal((await second("GET", `kuvo/vault/items/${added.value.item.id}/values`)).status, 200);

  const read = async ask => Object.fromEntries((await ask("GET", "kuvo/vault/activity")).value.entries.map(entry => [entry.what, entry]));
  const firstSees = await read(first);
  const secondSees = await read(second);
  assert.equal(firstSees.added.mine, true, "the first phone added it");
  assert.equal(firstSees.shown.mine, undefined, "the first phone didn't look at it");
  assert.equal(secondSees.added.mine, undefined, "the second phone didn't add it");
  assert.equal(secondSees.shown.mine, true, "the second phone looked at it");
  // Both still say from what kind of client, by name; neither says which phone's key.
  assert.equal(firstSees.shown.client, "iPhone");
  assert.ok(!JSON.stringify(firstSees).includes(link.publicOf(phoneKeys[1]).toString("base64url")), "no phone's key in what another reads");
});

// A line an older box kept, before it knew whose each was: no client claims it, so none reads it as
// its own, or as yours on some other client.
test("a vault activity line from before the box knew who did it is no one's to claim", async () => {
  const first = await phone(phoneKeys[0]);
  const added = await first("POST", "kuvo/vault/items", { kind: "login", name: "Old login", sites: ["old.example"], username: "me", values: { password: "battery-staple-old" } });
  assert.equal(added.status, 200, JSON.stringify(added.value));
  fs.appendFileSync(path.join(home, "box", "vault", "activity.jsonl"), JSON.stringify({ id: "a_old", at: Date.now(), what: "shown", client: "Mac", item: added.value.item.id, itemName: "Old login", kind: "login" }) + "\n");
  const old = (await first("GET", "kuvo/vault/activity")).value.entries.find(entry => entry.id === "a_old");
  assert.ok(old, "the old line is still shown");
  assert.equal(old.mine, undefined);
  assert.equal(old.client, undefined, "nor said to be from a client, which every Mac and phone would read as theirs");
  assert.equal(old.itemName, "Old login");
});
