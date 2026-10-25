// A Mac's box answers for the Mac's wake-ups (PROTOCOL.md, "Wake-ups"): it finds them where the app
// keeps them (KUVO_BOTS, KUVO_WAKES, the app's own kuvo-wake), not in its own folder, and a client
// follows them as they change, from the box or from kuvo-wake firing beside it. Watches are made as
// an agent makes them, and kuvo-wake's own refusals come back as they're said. The engine is a
// stand-in; kuvo-wake is the real one.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const support = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-wakes-"));
after(() => fs.rmSync(support, { recursive: true, force: true }));
// As the app starts its box: KUVO_HOME is the box's folder, and the app's own are beside it.
process.env.KUVO_HOME = path.join(support, "box");
process.env.KUVO_BOTS = path.join(support, "bots");
process.env.KUVO_WAKES = path.join(support, "wakes");
process.env.KUVO_WAKE_COMMAND = path.join(support, "bin", "kuvo-wake");
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const swift = fs.readFileSync(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8");
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
const script = swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n");
fs.mkdirSync(path.join(support, "bin"), { recursive: true });
fs.writeFileSync(process.env.KUVO_WAKE_COMMAND, script + "\n", { mode: 0o755 });

// The engine: the conversations here, its tools all connected, and the prompts it's sent.
const prompted = [];
let heard = null;
const engine = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  const asked = /^\/api\/session\/(ses_mac|ses_due)(\/prompt)?$/.exec(request.url);
  if (asked && asked[2]) {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      prompted.push({ session: asked[1], text: JSON.parse(Buffer.concat(chunks).toString()).text });
      heard?.();
      reply(200, {});
    });
    return;
  }
  if (asked) return reply(200, { data: { id: asked[1], location: { directory: support } } });
  if (request.url.startsWith("/api/mcp")) return reply(200, {});
  reply(404, {});
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
after(() => { engine.closeAllConnections(); engine.close(); });
const handle = link.engineHandler(() => ({ port: engine.address().port, password: "p" }), { name: "Mac" }, () => null);
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

/** `kuvo/wakes/events` followed: each line as it comes. */
function follow() {
  const controller = new AbortController();
  const lines = [];
  let waiting = null;
  (async () => {
    try {
      for await (const part of handle({ method: "GET", path: "kuvo/wakes/events", headers: {}, body: Buffer.alloc(0) }, {}, controller.signal)) {
        if (!part.body) continue;
        for (const line of part.body.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line));
        waiting?.();
      }
    } catch {}
  })();
  return {
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
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

test("the Mac's wake-ups are kept where the app keeps them, and nothing lands in the box's folder", async () => {
  const added = await ask("POST", "kuvo/wakes/ses_mac", { due: inAnHour(), note: "Ship the notes\nand tell Ada" });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const folder = path.join(support, "wakes", "ses_mac");
  assert.equal(fs.readdirSync(path.join(folder, "wakes")).length, 1);
  assert.equal(fs.existsSync(path.join(support, "box", "wakes")), false);
  assert.deepEqual((await ask("GET", "kuvo/wakes")).json.sessions.map(each => each.session), ["ses_mac"]);
  // A bot of the Mac's, its wake-ups in its folder there.
  const bot = path.join(support, "bots", "bot_ada");
  fs.mkdirSync(path.join(bot, "wakes"), { recursive: true });
  fs.writeFileSync(path.join(bot, "session"), "ses_ada");
  fs.writeFileSync(path.join(bot, "wakes", `${inAnHour()}-abcdef`), "Morning round");
  assert.equal((await ask("GET", "kuvo/wakes/ses_ada")).json.wakes[0].note, "Morning round");
});

test("a client follows them: whole notes, each change from the box at once, and kuvo-wake's from beside it", async () => {
  const followed = follow();
  try {
    const first = await followed.until(line => line.sessions.some(each => each.session === "ses_mac"));
    assert.equal(first.sessions.find(each => each.session === "ses_mac").wakes[0].note, "Ship the notes\nand tell Ada", "the note whole, on two lines");
    assert.ok(first.sessions.some(each => each.session === "ses_ada"), "bots' too");

    await ask("POST", "kuvo/wakes/ses_mac/pause", { paused: true });
    await followed.until(line => line.sessions.find(each => each.session === "ses_mac")?.paused === true);

    // kuvo-wake firing one: the file goes, outside the box.
    const folder = path.join(support, "bots", "bot_ada", "wakes");
    for (const name of fs.readdirSync(folder)) fs.rmSync(path.join(folder, name));
    await followed.until(line => !line.sessions.some(each => each.session === "ses_ada"));
  } finally {
    followed.stop();
  }
});

test("a watch is made as its agent makes one, and kuvo-wake's refusal comes back in its words", async () => {
  const made = await ask("POST", "kuvo/wakes/ses_mac/watch", { every: "1h", check: "curl -s https://example.com/status", note: "Tell me what changed" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.watches.map(({ every, note }) => ({ every, note })), [{ every: "1h", note: "Tell me what changed" }]);

  const refused = await ask("POST", "kuvo/wakes/ses_mac/watch", { every: "1s", check: "date", note: "Too often" });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Use 5m or more/);
  assert.equal((await ask("GET", "kuvo/wakes/ses_mac")).json.watches.length, 1, "nothing made");

  assert.equal((await ask("POST", "kuvo/wakes/ses_mac/watch", { every: "1h" })).status, 400, "a check and a note are needed");
  assert.equal((await ask("POST", "kuvo/wakes/ses_gone/watch", { every: "1h", check: "date", note: "x" })).status, 404, "not a conversation here");
});

test("this computer's box sends a wake-up when it's due, with kuvo-wake fire, as a machine's keeper does", async () => {
  // Where the app tells its box its engine is.
  fs.mkdirSync(path.join(support, "box", "run"), { recursive: true });
  fs.writeFileSync(path.join(support, "box", "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p" }));
  const folder = path.join(support, "wakes", "ses_due");
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  fs.writeFileSync(path.join(folder, "session"), "ses_due");
  fs.writeFileSync(path.join(folder, "directory"), support);
  fs.writeFileSync(path.join(folder, "wakes", `${Math.floor(Date.now() / 1000) - 5}-ghijkl`), "Send the weekly summary");
  const sent = new Promise(resolve => { heard = () => prompted.some(each => each.session === "ses_due") && resolve(); });
  const stop = link.sendWakes();
  try {
    await sent;
    assert.deepEqual(prompted.filter(each => each.session === "ses_due").map(each => each.text), ["[Wake-up] Send the weekly summary"]);
  } finally {
    stop();
  }
});

test("a client that archived a conversation holds its wake-ups through the box, and a pause of your own outlasts it", async () => {
  const folder = path.join(support, "wakes", "ses_mac");
  fs.rmSync(path.join(folder, "paused"), { force: true });
  assert.equal((await ask("POST", "kuvo/wakes/ses_mac/pause", { archived: true })).json.paused, true);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "archived");
  assert.equal((await ask("POST", "kuvo/wakes/ses_mac/pause", { archived: false })).json.paused, false);
  // Yours stays when it comes back.
  await ask("POST", "kuvo/wakes/ses_mac/pause", { paused: true });
  await ask("POST", "kuvo/wakes/ses_mac/pause", { archived: true });
  assert.equal((await ask("POST", "kuvo/wakes/ses_mac/pause", { archived: false })).json.paused, true);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "paused");
});

test("one an agent's kuvo-wake writes beside the box goes at its time, not at the next minute", { timeout: 20_000 }, async () => {
  const folder = path.join(support, "wakes", "ses_due");
  const stop = link.sendWakes();
  try {
    // The box has nothing due (its timer is a minute out) when the agent adds one for now.
    const before = prompted.length;
    const sent = new Promise(resolve => { heard = () => prompted.length > before && resolve(); });
    fs.writeFileSync(path.join(folder, "wakes", `${Math.floor(Date.now() / 1000)}-mnopqr`), "Read the release notes");
    await sent;
    assert.equal(prompted.at(-1).text, "[Wake-up] Read the release notes");
  } finally {
    stop();
  }
});

test("archiving a conversation that's moving to another computer waits for the move", async () => {
  const folder = path.join(support, "wakes", "ses_mac");
  fs.writeFileSync(path.join(folder, "paused"), "moving");
  try {
    assert.equal((await ask("POST", "kuvo/wakes/ses_mac/pause", { archived: true })).status, 409);
    assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "moving", "the move's hold stays its own");
  } finally {
    fs.rmSync(path.join(folder, "paused"), { force: true });
  }
});
