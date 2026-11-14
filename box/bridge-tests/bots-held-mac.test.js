// This Mac's box holding an edit for a machine that's away (PROTOCOL.md, `kuvo/bots`, "Held for
// another computer"), with its keys as its app gives them: in memory only, never in a file. What it
// holds is sealed with them, so a secret written in its folder by anything else seals nothing; and
// before the app gives them (the box just started), it holds nothing new and lists nothing, so a
// client keeps what it last heard.
//
// Run with `node --test box/bridge-tests/bots-held-mac.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-held-mac-")));
removeAtEnd(support);
Object.assign(process.env, {
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
const run = path.join(support, "box", "run");

const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "Studio Mac" }, () => null);
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json };
}

test("this Mac's box seals what it holds with the keys its app gives it, never a secret in a file, and lists nothing before it has them", async () => {
  const lab = { key: link.publicOf(link.newKey()).toString("base64url"), address: crypto.randomBytes(16).toString("base64url"), kind: "machine", name: "Lab", id: "me@lab.local" };
  fs.mkdirSync(run, { recursive: true });
  // Its machines, as its app told it; and a secret written in its folder by something else.
  const planted = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(run, "link.json"), JSON.stringify({ macPeers: [lab], secret: planted }));
  const keys = { key: link.newKey().toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), sign: link.newSigningSeed() };
  link.macLink.overlay = keys;
  try {
    const held = await ask("PATCH", `kuvo/bots/bot_away0000001?on=${encodeURIComponent(lab.id)}`, { name: "Wren" });
    assert.equal(held.status, 202);
    assert.equal(held.json.held.computer, "Lab", "a machine by its name, not how SSH reaches it");
    assert.equal(JSON.parse(fs.readFileSync(path.join(run, "link.json"), "utf8")).secret, planted, "no key of the app's written");
    assert.equal((await ask("GET", "kuvo/bots")).json.held.length, 1);

    // Something else on this Mac seals one with the secret in the folder: not shown, not sent.
    const fake = { id: `bte_${"b".repeat(22)}`, bot: "bot_fake0000001", to: lab.key, change: { name: "X" }, times: { name: 1 }, since: 1, at: 1 };
    const key = crypto.createHmac("sha256", Buffer.from(planted, "base64url")).update("kuvo bot edits held").digest();
    const seal = crypto.createHmac("sha256", key).update(JSON.stringify([fake.id, fake.bot, fake.to, null, fake.change, fake.times, false, 1, 1])).digest("base64url");
    fs.writeFileSync(path.join(run, "bots-held", "bot_fake0000001.json"), JSON.stringify({ ...fake, seal }));
    assert.deepEqual((await ask("GET", "kuvo/bots")).json.held.map(each => each.bot), ["bot_away0000001"]);

    // Started again, before its app gives it its keys: nothing new held, and no list of what is, so a
    // client keeps showing what it last heard.
    link.macLink.overlay = null;
    const early = await ask("PATCH", `kuvo/bots/bot_away0000001?on=${encodeURIComponent(lab.id)}`, { name: "Wren II" });
    assert.equal(early.status, 503);
    const listed = (await ask("GET", "kuvo/bots")).json;
    assert.equal(listed.held, undefined);
    assert.equal(listed.refused, undefined);
    // The keys again: what it held is there, as it was.
    link.macLink.overlay = keys;
    assert.deepEqual((await ask("GET", "kuvo/bots")).json.held.map(each => [each.bot, each.change.name]), [["bot_away0000001", "Wren"]]);
  } finally {
    link.macLink.overlay = null;
  }
});
