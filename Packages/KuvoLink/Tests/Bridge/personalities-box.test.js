// Your personalities on a box (PROTOCOL.md, "Personalities"), as a Mac's box keeps them: in the
// app's bots folder (KUVO_BOTS), never its own. The app beside the box reads the library whole and
// gives it another computer's copy to meet with it, which a phone can't; and any client follows the
// library as it changes, from a route, a copy met, or another process writing it. The engine is a
// stand-in; the bridge is the real one, in this process and run as a command beside it.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-personalities-"));
removeAtEnd(support);
// As the app starts its box: KUVO_HOME is the box's folder, and the bots' is the app's own beside it.
process.env.KUVO_HOME = path.join(support, "box");
process.env.KUVO_BOTS = path.join(support, "bots");
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const library = path.join(support, "bots", "personalities.json");

// The engine: the instructions each bot is told, as they come.
const told = [];
let heard = null;
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => body += chunk);
  request.on("end", () => {
    if (request.method === "PUT") {
      told.push({ url: request.url, value: JSON.parse(body).value });
      heard?.();
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const handle = link.engineHandler(() => ({ port: engine.address().port, password: "p" }), { name: "Mac" }, () => null);

/** A request as the box gets it: from the app beside it (`x-kuvo-from: app`), or a phone's. */
async function ask(method, route, body, { app = false } = {}) {
  const parts = [];
  const sent = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  for await (const part of handle({ method, path: route, headers: {}, body: sent, fromApp: app }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}
const fromApp = (method, route, body) => ask(method, route, body, { app: true });
const take = document => fromApp("POST", "kuvo/personalities/take", { document });
const entry = (id, name, updated, description = `${name}.`) => ({ id, name, description, symbol: "person.crop.circle", updated });

/** `kuvo/personalities/events` followed: each line as it comes. */
function follow() {
  const controller = new AbortController();
  const lines = [];
  let waiting = null;
  (async () => {
    try {
      for await (const part of handle({ method: "GET", path: "kuvo/personalities/events", headers: {}, body: Buffer.alloc(0) }, {}, controller.signal)) {
        if (!part.body) continue;
        for (const line of part.body.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line));
        waiting?.();
      }
    } catch {}
  })();
  return {
    lines,
    stop: () => controller.abort(),
    async until(matches) {
      for (;;) {
        const found = lines.find(matches);
        if (found) return found;
        await new Promise(resolve => { waiting = resolve; });
      }
    },
  };
}
const names = line => line.personalities.map(each => each.name).sort();
// Each test starts from an empty library.
const fresh = () => fs.rmSync(library, { force: true });

test("the Mac's library is kept where the app keeps its bots, and nothing lands in the box's folder", async () => {
  fresh();
  const made = await ask("POST", "kuvo/personalities", { name: "Night Owl", description: "Works late." });
  assert.equal(made.status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(library, "utf8")).personalities.map(each => each.id), [made.json.id]);
  assert.equal(fs.existsSync(path.join(support, "box", "bots")), false);
  assert.equal((await ask("DELETE", `kuvo/personalities/${made.json.id}`)).status, 200);
});

test("the app reads the library whole, with what was removed; a phone can't", async () => {
  fresh();
  const owl = (await ask("POST", "kuvo/personalities", { name: "Night Owl", description: "Works late." })).json;
  await ask("DELETE", `kuvo/personalities/${owl.id}`);
  const refused = await ask("GET", "kuvo/personalities/document");
  assert.equal(refused.status, 403);
  assert.equal(refused.json.message, "Only Kuvo Code on this computer can do that.");
  const made = (await ask("POST", "kuvo/personalities", { name: "Calm", description: "Calm and brief." })).json;
  const document = await fromApp("GET", "kuvo/personalities/document");
  assert.equal(document.status, 200);
  assert.equal(document.json.kuvo, 1);
  assert.deepEqual(document.json.personalities, [made]);
  // The night owl, removed, noted.
  assert.deepEqual(document.json.removed.map(each => each.id), [owl.id]);
  assert.deepEqual(Object.keys(document.json.removed[0]).sort(), ["id", "removed"]);
  // Exactly what the file keeps, and what the box signs for your other computers.
  assert.deepEqual(document.json, JSON.parse(fs.readFileSync(library, "utf8")));
  assert.equal((await fromApp("POST", "kuvo/personalities/document", {})).status, 405);
  assert.equal((await ask("DELETE", `kuvo/personalities/${made.id}`)).status, 200);
});

test("the app gives the box another computer's copy: what changed here comes back, a removal beats an edit, and a phone can't", async () => {
  fresh();
  const before = (await fromApp("GET", "kuvo/personalities/document")).json;
  // A phone can't feed it a copy, and the library is as it was.
  const phone = await ask("POST", "kuvo/personalities/take", { document: { personalities: [entry("custom.sly", "Sly", 1)], removed: [] } });
  assert.equal(phone.status, 403);
  assert.equal(phone.json.message, "Only Kuvo Code on this computer can do that.");
  assert.deepEqual((await fromApp("GET", "kuvo/personalities/document")).json, before);

  // Two new ones from the other computer.
  const first = await take({ personalities: [entry("custom.bold", "Bold", 5), entry("custom.kind", "Kind", 5)], removed: [] });
  assert.deepEqual(first, { status: 200, json: { changed: ["custom.bold", "custom.kind"] } });
  assert.deepEqual(names((await ask("GET", "kuvo/personalities")).json), ["Bold", "Kind"]);
  // The same again changes nothing.
  assert.deepEqual((await take({ personalities: [entry("custom.bold", "Bold", 5)] })).json, { changed: [] });
  // Bold removed there, though it was changed here later (counted higher): the removal wins.
  await ask("PATCH", "kuvo/personalities/custom.bold", { description: "Bolder." });
  assert.deepEqual((await take({ personalities: [], removed: [{ id: "custom.bold", removed: 2 }] })).json, { changed: ["custom.bold"] });
  // An edit of it from another computer, counted far higher, doesn't bring it back.
  assert.deepEqual((await take({ personalities: [entry("custom.bold", "Bold", 1_000_000_000_000_000)], removed: [] })).json, { changed: [] });
  const after = (await fromApp("GET", "kuvo/personalities/document")).json;
  assert.deepEqual(after.personalities.map(each => each.id), ["custom.kind"]);
  assert.ok(after.removed.some(each => each.id === "custom.bold"));
  // An older edit of Kind there: kept here as it is.
  assert.deepEqual((await take({ personalities: [entry("custom.kind", "Kind", 1, "Old words.")] })).json, { changed: [] });
  // A newer one: taken.
  assert.deepEqual((await take({ personalities: [entry("custom.kind", "Kind", 9, "Kind and patient.")] })).json, { changed: ["custom.kind"] });
  assert.equal((await ask("GET", "kuvo/personalities")).json.personalities[0].description, "Kind and patient.");
});

test("a copy that isn't a library is refused", async () => {
  fresh();
  await take({ personalities: [entry("custom.kind", "Kind", 5)] });
  for (const body of ["not json", {}, { document: [] }, { document: "x" }, { document: { removed: [] } }, { document: { personalities: "x" } }, { document: { personalities: [], removed: {} } }]) {
    const answer = await fromApp("POST", "kuvo/personalities/take", body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.equal(typeof answer.json.message, "string");
  }
  assert.equal((await fromApp("GET", "kuvo/personalities/take")).status, 405);
});

test("a personality whose id isn't one, a list holding one say, isn't taken from a copy", async () => {
  await take({ personalities: [entry(["custom.listed"], "Listed", 1), entry("custom.plain", "Plain", 1)], removed: [{ id: ["custom.gone"], removed: 2 }] });
  const { json } = await fromApp("GET", "kuvo/personalities/document");
  assert.ok(!JSON.stringify(json).includes("custom.listed") && !JSON.stringify(json).includes("custom.gone"), "neither is in the library");
  assert.ok(JSON.stringify(json).includes("custom.plain"));
});

test("a copy is met even when the two together are past what a document holds, as a peer's is, and removals still reach it", async () => {
  fresh();
  await take({ personalities: [entry("custom.kind", "Kind", 5)] });
  // Two computers that each filled theirs while apart: every box takes the whole of both.
  const big = Array.from({ length: 300 }, (_, i) => entry(`custom.big${i}`, `Big ${i}`, 1, "Words. ".repeat(285)));
  const met = await take({ personalities: big, removed: [] });
  assert.equal(met.status, 200);
  assert.equal(met.json.changed.length, 300);
  // Past the limit, a removal from another computer still comes in.
  const gone = await take({ personalities: [], removed: [{ id: "custom.kind", removed: 9 }] });
  assert.deepEqual(gone.json, { changed: ["custom.kind"] });
  assert.ok(!(await fromApp("GET", "kuvo/personalities/document")).json.personalities.some(each => each.id === "custom.kind"));
});

test("removals are kept to the 500 newest when a copy brings more", async () => {
  fresh();
  // One removed here, now: newer than any of the copy's.
  const owl = (await ask("POST", "kuvo/personalities", { name: "Night Owl", description: "Works late." })).json;
  await ask("DELETE", `kuvo/personalities/${owl.id}`);
  const kept = (await fromApp("GET", "kuvo/personalities/document")).json.removed;
  const removed = Array.from({ length: 510 }, (_, i) => ({ id: `custom.gone${i}`, removed: i + 1 }));
  const answer = await take({ personalities: [], removed });
  assert.equal(answer.status, 200);
  const after = (await fromApp("GET", "kuvo/personalities/document")).json.removed;
  assert.equal(after.length, 500);
  // This box's own removals, newer, stay; of the copy's, the newest that fit beside them.
  assert.deepEqual(kept.map(each => each.id), [owl.id]);
  assert.ok(after.some(one => one.id === owl.id));
  const fit = 499;
  assert.deepEqual(answer.json.changed.sort(), removed.slice(-fit).map(each => each.id).sort());
  assert.ok(!after.some(each => each.id === "custom.gone0"));
});

test("a bot here with a personality another computer changed is told what it is now", async () => {
  fresh();
  await take({ personalities: [entry("custom.kind", "Kind", 5)] });
  const bots = path.join(support, "bots");
  const words = path.join(support, "box", "bin", "bot-words.json");
  fs.mkdirSync(path.dirname(words), { recursive: true });
  fs.writeFileSync(words, JSON.stringify({ kuvo: 1, templates: [], personalities: [], looks: {}, here: { mac: {}, machine: {} },
    instructions: ["You are ⟦name⟧⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧", "Memory: ⟦folder⟧."], job: { none: "", line: ": ⟦job⟧", details: "⟦jobDetails⟧" },
    personalityWords: "Your personality: ⟦name⟧. ⟦description⟧", projectNote: "", identityNote: "", memory: "", greeting: "" }));
  fs.writeFileSync(path.join(bots, "kit.json"), JSON.stringify({ kuvo: 1, personalities: [], projects: [], rules: [], timeZone: "UTC" }));
  const folder = path.join(bots, "bot_scout00001");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: {}, personality: "custom.kind", created: "2026-10-01T09:00:00Z" }));
  fs.writeFileSync(path.join(folder, "session"), "ses_scout");
  try {
    told.length = 0;
    const answer = await take({ personalities: [entry("custom.kind", "Kind", 20, "Kind, and quick to help.")] });
    assert.deepEqual(answer.json, { changed: ["custom.kind"] });
    while (!told.length) await new Promise(resolve => { heard = resolve; });
    assert.equal(told[0].url, "/api/experimental/session/ses_scout/instructions/entries/kuvo.bot");
    assert.match(told[0].value, /Your personality: Kind\. Kind, and quick to help\./);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(path.join(bots, "kit.json"), { force: true });
    fs.rmSync(words, { force: true });
  }
});

test("a client follows the library: a line now, then each change from a route, a copy taken, or another process", async () => {
  fresh();
  await take({ personalities: [entry("custom.kind", "Kind", 5)] });
  const followed = follow();
  try {
    const first = await followed.until(() => true);
    assert.deepEqual(first, { personalities: (await ask("GET", "kuvo/personalities")).json.personalities });
    assert.deepEqual(first.personalities.map(each => Object.keys(each).sort()), [["description", "id", "name", "symbol", "updated"]]);

    const made = (await ask("POST", "kuvo/personalities", { name: "Owl", description: "Works late." })).json;
    await followed.until(line => line.personalities.some(each => each.id === made.id));
    await ask("PATCH", `kuvo/personalities/${made.id}`, { name: "Early Bird" });
    await followed.until(line => line.personalities.some(each => each.name === "Early Bird"));
    const before = followed.lines.length;
    await ask("DELETE", `kuvo/personalities/${made.id}`);
    await followed.until(line => followed.lines.indexOf(line) >= before && !line.personalities.some(each => each.id === made.id));

    await take({ personalities: [entry("custom.taken", "Taken", 3)] });
    await followed.until(line => line.personalities.some(each => each.id === "custom.taken"));

    // Another process writes it: a Mac's `box personalities` over SSH, run here as its own command.
    const child = spawn(process.execPath, [script, "box", "personalities"], { env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.end(JSON.stringify({ personalities: [entry("custom.ssh", "From SSH", 4)], removed: [] }));
    const [code] = await new Promise(resolve => child.on("exit", (...exit) => resolve(exit)));
    assert.equal(code, 0);
    const line = await followed.until(each => each.personalities.some(one => one.id === "custom.ssh"));
    assert.ok(line.personalities.some(each => each.id === "custom.taken"));
    // A line only when something changed.
    const seen = followed.lines.length;
    await take({ personalities: [entry("custom.ssh", "From SSH", 4)] });
    await ask("POST", "kuvo/personalities", { name: "Last", description: "The last one." });
    const last = await followed.until(each => each.personalities.some(one => one.name === "Last"));
    assert.equal(followed.lines.indexOf(last), seen);
  } finally {
    followed.stop();
  }
  assert.equal((await ask("POST", "kuvo/personalities/events")).status, 405);
});
