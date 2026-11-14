// A machine's notices on their way to your phones (PROTOCOL.md, "Notifications"): sealed for each
// phone that's said where it is and pushed on the bridge's relay connection, the same as this Mac's
// box; only a connection that takes one counts it as gone, so one closing as it's handed over is
// tried again. And how the relay answered each push (Apple took it, no phone registered there, this
// machine not one the phone takes pushes from, Apple refused it) is kept, by phone, so a phone that
// hears nothing can be told from one that was sent nothing.
//
// Run with `node --test box/bridge-tests/pushes.test.js`.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kpush-"));
const home = path.join(root, ".kuvo-code");
removeAtEnd(root);
// This test's own sendToPhones and its kept answers read this folder too.
process.env.KUVO_HOME = home;
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

// Each change on the relay (a device on it or gone) wakes whoever waits for one.
let poke = () => {};
const relay = await relayStandIn(link, { changed: () => poke() });
atEnd(() => relay.close());
const changed = () => new Promise(resolve => { poke = resolve; });

// The machine's own keys, and a phone paired with it that's said where it is.
const machineKey = link.newKey();
const secret = crypto.randomBytes(32);
const machineAddress = link.addressOf(secret);
const phoneKey = link.newKey();
const phonePublic = link.publicOf(phoneKey).toString("base64url");
const phone = relay.device();

let bridge;
before(async () => {
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "link.json"), JSON.stringify({
    id: "lab", name: "lab", relay: relay.url,
    secret: secret.toString("base64url"),
    key: machineKey.toString("base64url"),
    phones: [{ key: phonePublic, name: "iPhone", added: Math.floor(Date.now() / 1000), from: "pair", address: phone.address.toString("base64url"), pairing: crypto.randomBytes(16).toString("base64url") }],
  }), { mode: 0o600 });
  bridge = spawn(process.execPath, [script, "run"], { env: { PATH: process.env.PATH, HOME: root, KUVO_HOME: home, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), ...(process.env.BUN_BE_BUN ? { BUN_BE_BUN: "1" } : {}) }, stdio: ["ignore", "ignore", "pipe"] });
  let said = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", chunk => { said += chunk; });
  const ended = new Promise((_, reject) => bridge.once("exit", code => reject(new Error(`the bridge ended (${code}): ${said}`))));
  while (!relay.has(machineAddress)) await Promise.race([changed(), ended]);
  ended.catch(() => {});
});
atEnd(async () => {
  if (!bridge || bridge.exitCode !== null) return;
  const exited = new Promise(resolve => bridge.once("exit", resolve));
  bridge.kill("SIGTERM");
  await exited;
});

// What an agent sends you on purpose (notify_user), as any process of the box keeps it: the
// bridge tells your phones.
let told = 0;
function agentSends(body) {
  told += 1;
  const file = path.join(home, "run", "notices", "told.json");
  let kept = [];
  try { kept = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  kept.push({ id: `ntc_${told}`, at: Date.now(), by: "agent", notice: { title: "Ada", body, category: "report", thread: "ses_ada", data: { session: "ses_ada" } } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Whole, as the box writes it: the bridge never reads half of it.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept));
  fs.renameSync(`${file}.tmp`, file);
}

// What another process does, looked at again as the relay records something and every few
// milliseconds (what the bridge writes), until the test runs out of time (`signal`).
function eventually(found, signal) {
  return new Promise((resolve, reject) => {
    const look = () => {
      const value = found();
      if (!value) return;
      clearInterval(timer);
      resolve(value);
    };
    const timer = setInterval(look, 20);
    signal.addEventListener("abort", () => {
      clearInterval(timer);
      reject(new Error(`it never got there: ${found}`));
    }, { once: true });
    look();
  });
}

// What the phone would open of a push to it, once the relay has it.
const pushedSaying = (body, signal) => eventually(() => relay.pushed.filter(each => each.to.equals(phone.address))
  .map(each => JSON.parse(link.openOneWay(link.readFrame(each.payload).body, phoneKey, link.publicOf(machineKey)).payload.toString()))
  .find(each => each.body === body), signal);

// What the bridge kept of the relay's answer for the phone, once it's `outcome`.
const PUSHED = path.join(home, "run", "notices", "pushed.json");
const answerFor = (outcome, signal) => eventually(() => {
  let kept = {};
  try { kept = JSON.parse(fs.readFileSync(PUSHED, "utf8")); } catch {}
  return kept[phonePublic]?.outcome === outcome ? kept[phonePublic] : null;
}, signal);

test("how the relay answered a machine's push to your phone is kept: one it may not send, then one that went", { timeout: 60_000 }, async t => {
  // The phone hasn't said this machine may push to it (its registration names other senders).
  relay.answers.push = 2;
  agentSends("Please sign in to Perplexity.");
  const notice = await pushedSaying("Please sign in to Perplexity.", t.signal);
  assert.equal(notice.title, "Ada");
  const refused = await answerFor("notAllowed", t.signal);
  assert.equal(refused.sent, undefined, "nothing has reached it yet");

  // The phone registers this machine too: the next one goes, and says when.
  relay.answers.push = 0;
  agentSends("The tests pass.");
  await pushedSaying("The tests pass.", t.signal);
  const went = await answerFor("sent", t.signal);
  assert.equal(went.sent, went.at);

  // Apple refusing the next keeps when one last went through.
  relay.answers.push = 3;
  agentSends("One more thing.");
  await pushedSaying("One more thing.", t.signal);
  const after = await answerFor("refused", t.signal);
  assert.equal(after.sent, went.at);
});

test("a machine's notice told as its relay connection is closing is held, and reaches the phone once it's connected again", { timeout: 60_000 }, async t => {
  relay.answers.push = 0;
  // The relay closes the connection, and the bridge's side is left closing.
  await relay.closing();
  agentSends("Closing time.");
  // Held to try again, not counted as sent, while the connection is still there, closing.
  const held = path.join(home, "run", "held-notices.json");
  await eventually(() => {
    try { return JSON.parse(fs.readFileSync(held, "utf8")).some(entry => entry.notice.body === "Closing time."); } catch { return false; }
  }, t.signal);
  assert.ok(relay.has(machineAddress), "still on its closing connection as it held it");
  assert.equal(relay.pushed.length, 3, "nothing went out on the closing connection");
  // The connection ends; the bridge connects again, and the notice goes, once.
  relay.drop();
  const notice = await pushedSaying("Closing time.", t.signal);
  assert.equal(notice.title, "Ada");
  await eventually(() => !fs.existsSync(held), t.signal);
  assert.equal(relay.pushed.length, 4);
});

test("sendToPhones: a connection that's closing takes nothing, and the hold tries again", () => {
  const readLink = () => JSON.parse(fs.readFileSync(path.join(home, "run", "link.json"), "utf8"));
  const notice = { title: "Ada", body: "Done.", category: "report", thread: "ses_ada", data: { session: "ses_ada" } };
  const sent = [];
  // Welcomed, but its socket closing as the push is handed over: it takes nothing.
  const closing = { welcomed: true, send: () => false };
  assert.equal(link.sendToPhones(closing, readLink(), notice), false);
  // One that takes it.
  const open = { welcomed: true, send: bytes => Boolean(sent.push(bytes)) };
  assert.equal(link.sendToPhones(open, readLink(), notice), true);
  assert.equal(sent.length, 1);
  // Through the hold, as the bridge does: kept while the connection is closing, then sent once.
  let host = closing;
  let now = 0;
  const timers = [];
  const hold = new link.NoticeHold({
    send: each => link.sendToPhones(host, readLink(), each),
    now: () => now, wall: () => 1_800_000_000_000,
    setTimer: (fire, ms) => { timers.push({ at: now + ms, fire }); return timers.length; },
    clearTimer: id => { if (timers[id - 1]) timers[id - 1].fire = () => {}; },
  });
  hold.tell(notice);
  assert.equal(hold.count, 1, "held to try again");
  host = open;
  now += 5_000;
  for (const timer of timers.splice(0)) if (timer.at <= now) timer.fire();
  assert.equal(hold.count, 0);
  assert.equal(sent.length, 2);
  // No phone that's said where it is: nothing to send, so nothing waits.
  assert.equal(link.sendToPhones(closing, { ...readLink(), phones: [{ key: phonePublic, name: "iPhone" }] }, notice), true);
  // No connection at all: tried again.
  assert.equal(link.sendToPhones(null, readLink(), notice), false);
});
