// A bot deleted on this Mac while its app isn't answering for its keys (the Keychain, through the
// host interface): the bot goes all the same, and its keys go the next time they can be reached,
// so none is left behind in your Keychain. The app is a stand-in; the box is the real one.
//
// Run with `node --test box/bridge-tests/bot-keys-left.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-keys-left-")));
removeAtEnd(support);

// The app, keeping keys by name, answering or not.
const kept = new Map([["KUVO_KEY_TODOIST_TODOIST_API_KEY__BOT_ADA0000001", "tok"], ["KUVO_KEY_TODOIST_TODOIST_API_KEY", "shared"]]);
let answering = false;
const trashed = [];
const host = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const given = body ? JSON.parse(body) : {};
    // The app proving it's the app, answering or not for its keys.
    if (request.url === "/hello") return reply(200, { proof: crypto.createHmac("sha256", "secret").update(`kuvo-host-hello\0${given.nonce}\u0000127.0.0.1:${host.address().port}`).digest("hex") });
    if (request.url === "/trash") { trashed.push(given.path); return reply(200, {}); }
    if (!answering) return reply(503, { message: "Not now." });
    if (request.url === "/keys/names") return reply(200, { names: [...kept.keys()].filter(name => name.startsWith(given.prefix ?? "") && name.endsWith(given.suffix ?? "")) });
    if (request.url === "/keys/delete") { kept.delete(given.name); return reply(200, {}); }
    reply(404, {});
  });
});
await new Promise(resolve => host.listen(0, "127.0.0.1", resolve));
atEnd(() => { host.closeAllConnections(); host.close(); });

Object.assign(process.env, {
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_HOST_URL: `http://127.0.0.1:${host.address().port}`,
  KUVO_HOST_PASSWORD: "secret",
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");

test("a bot deleted while its app isn't answering for its keys goes at once, and its keys once they can be reached", async () => {
  const folder = path.join(process.env.KUVO_BOTS, "bot_ada0000001");
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ada0000001", name: "Ada", job: "", look: { color: "mint", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  fs.writeFileSync(path.join(folder, "session"), "ses_ada");
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "Mac" }, () => null);
  const parts = [];
  for await (const part of handle({ method: "DELETE", path: "kuvo/bots/bot_ada0000001", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200, "deleted all the same");
  assert.equal(fs.existsSync(folder), false);
  // Its folder handed to the app for the Finder's Trash, from the box's own trash folder.
  assert.equal(trashed.length, 1);
  assert.ok(trashed[0].startsWith(path.join(process.env.KUVO_HOME, "trash") + path.sep) && trashed[0].endsWith("bot_ada0000001"), trashed[0]);
  assert.ok(kept.has("KUVO_KEY_TODOIST_TODOIST_API_KEY__BOT_ADA0000001"), "its key couldn't be reached yet");

  answering = true;
  await link.forgetLeftKeys();
  assert.equal(kept.has("KUVO_KEY_TODOIST_TODOIST_API_KEY__BOT_ADA0000001"), false, "gone once it could be");
  assert.ok(kept.has("KUVO_KEY_TODOIST_TODOIST_API_KEY"), "a shared key stays");
  assert.equal(fs.existsSync(path.join(process.env.KUVO_HOME, "run", "bot-keys-left.json")), false, "nothing left to do");
});
