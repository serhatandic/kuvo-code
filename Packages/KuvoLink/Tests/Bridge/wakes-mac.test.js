// A Mac's box answers for the Mac's wake-ups (PROTOCOL.md, "Wake-ups"): it finds them where the app
// keeps them (KUVO_BOTS, KUVO_WAKES, the app's own kuvo-wake), not in its own folder, and a client
// follows them as they change, from the box or from kuvo-wake firing beside it. Watches are made as
// an agent makes them, and kuvo-wake's own refusals come back as they're said. The engine is a
// stand-in, and so is the system's word that a folder changed (below); kuvo-wake is the real one.
// Each test has conversations of its own, gone when it ends, so each runs alone too.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { atEnd, removeAtEnd } from "./at-end.js";

const support = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-wakes-"));
removeAtEnd(support);
// As the app starts its box: KUVO_HOME is the box's folder, and the app's own are beside it.
process.env.KUVO_HOME = path.join(support, "box");
process.env.KUVO_BOTS = path.join(support, "bots");
process.env.KUVO_WAKES = path.join(support, "wakes");
process.env.KUVO_WAKE_COMMAND = path.join(support, "bin", "kuvo-wake");

// The system tells the box's folder watches of a change when it gets to it: on a busy Mac, FSEvents
// tells them late or not at all (the box looks again for those, each half minute and each minute).
// So the watches here hear of each change as a test makes it, as the system tells them: a change
// in a folder a watch has, or in one inside it only when it watches what's in them too.
const watches = new Set();
fs.watch = (folder, options, listener) => {
  const watch = { folder, recursive: Boolean(options?.recursive), listener, on: () => watch, close: () => watches.delete(watch) };
  watches.add(watch);
  return watch;
};
const changedOnDisk = file => {
  for (const { folder, recursive, listener } of [...watches]) {
    if (path.dirname(file) === folder || (recursive && file.startsWith(folder + path.sep))) listener("rename", path.relative(folder, file));
  }
};
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const swift = fs.readFileSync(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8");
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
const script = swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n");
fs.mkdirSync(path.join(support, "bin"), { recursive: true });
fs.writeFileSync(process.env.KUVO_WAKE_COMMAND, script + "\n", { mode: 0o755 });

// The engine: the conversations it has (each test's), its tools all connected, and the prompts
// it's sent. Each answer closes its connection. The box's fetch (in this process) gives one it keeps
// open a timer, on the clock of whichever test is going then (a test's own, below); when the engine
// closes it seconds later, in another test, Node's mocked clock (22.15) takes it off that test's
// clock by its old place there, and that test's next timer never goes. Now and then, on a busy Mac.
const conversations = new Set();
const prompted = [];
const engine = http.createServer((request, response) => {
  const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json", connection: "close" }); response.end(JSON.stringify(value)); };
  const asked = /^\/api\/session\/(ses_[A-Za-z0-9_]+)(\/prompt)?$/.exec(request.url);
  if (asked && !conversations.has(asked[1])) return reply(404, {});
  if (asked && asked[2]) {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const { text, metadata } = JSON.parse(Buffer.concat(chunks).toString());
      prompted.push({ session: asked[1], text, metadata });
      reply(200, {});
    });
    return;
  }
  if (asked) return reply(200, { data: { id: asked[1], location: { directory: support } } });
  if (request.url.startsWith("/api/mcp")) return reply(200, {});
  reply(404, {});
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const handle = link.engineHandler(() => ({ port: engine.address().port, password: "p" }), { name: "Mac" }, () => null);
async function ask(method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  return { status: parts[0].head.status, json: text ? JSON.parse(text) : undefined };
}

/** A conversation the engine has, for this test only: its wake-ups' folder beside the box goes when
 * the test ends. With `folder`, the folder is there already, as kuvo-wake leaves it, and the app has
 * told its box where its engine is. */
function conversation(t, session, { folder: made = false } = {}) {
  conversations.add(session);
  const folder = path.join(support, "wakes", session);
  t.after(() => {
    conversations.delete(session);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  if (made) {
    fs.mkdirSync(path.join(support, "box", "run"), { recursive: true });
    fs.writeFileSync(path.join(support, "box", "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p" }));
    fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
    fs.writeFileSync(path.join(folder, "session"), session);
    fs.writeFileSync(path.join(folder, "directory"), support);
  }
  return folder;
}

/** A bot of the Mac's, for this test only, its wake-ups in its folder there. */
function bot(t, id, session) {
  conversations.add(session);
  const folder = path.join(support, "bots", id);
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  fs.writeFileSync(path.join(folder, "session"), session);
  t.after(() => {
    conversations.delete(session);
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return folder;
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
const now = () => Math.floor(Date.now() / 1000);

test("the Mac's wake-ups are kept where the app keeps them, and nothing lands in the box's folder", async t => {
  const folder = conversation(t, "ses_mac");
  const added = await ask("POST", "kuvo/wakes/ses_mac", { due: inAnHour(), note: "Ship the notes\nand tell Ada" });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(fs.readdirSync(path.join(folder, "wakes")).length, 1);
  assert.equal(fs.existsSync(path.join(support, "box", "wakes")), false);
  assert.deepEqual((await ask("GET", "kuvo/wakes")).json.sessions.map(each => each.session), ["ses_mac"]);
  const ada = bot(t, "bot_ada", "ses_ada");
  fs.writeFileSync(path.join(ada, "wakes", `${inAnHour()}-abcdef`), "Morning round");
  assert.equal((await ask("GET", "kuvo/wakes/ses_ada")).json.wakes[0].note, "Morning round");
});

test("a client follows them: whole notes, each change from the box at once, and kuvo-wake's from beside it", async t => {
  conversation(t, "ses_follow");
  assert.equal((await ask("POST", "kuvo/wakes/ses_follow", { due: inAnHour(), note: "Ship the notes\nand tell Ada" })).status, 200);
  const ada = bot(t, "bot_ada", "ses_ada");
  fs.writeFileSync(path.join(ada, "wakes", `${inAnHour()}-abcdef`), "Morning round");
  const followed = follow();
  try {
    const first = await followed.until(line => line.sessions.some(each => each.session === "ses_follow"));
    assert.equal(first.sessions.find(each => each.session === "ses_follow").wakes[0].note, "Ship the notes\nand tell Ada", "the note whole, on two lines");
    assert.ok(first.sessions.some(each => each.session === "ses_ada"), "bots' too");

    await ask("POST", "kuvo/wakes/ses_follow/pause", { paused: true });
    await followed.until(line => line.sessions.find(each => each.session === "ses_follow")?.paused === true);

    // kuvo-wake firing one: the file goes, outside the box.
    const folder = path.join(ada, "wakes");
    for (const name of fs.readdirSync(folder)) {
      fs.rmSync(path.join(folder, name));
      changedOnDisk(path.join(folder, name));
    }
    await followed.until(line => !line.sessions.some(each => each.session === "ses_ada"));
  } finally {
    followed.stop();
  }
});

test("a watch is made as its agent makes one, and kuvo-wake's refusal comes back in its words", async t => {
  conversation(t, "ses_watch");
  const made = await ask("POST", "kuvo/wakes/ses_watch/watch", { every: "1h", check: "curl -s https://example.com/status", note: "Tell me what changed" });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.deepEqual(made.json.watches.map(({ every, note }) => ({ every, note })), [{ every: "1h", note: "Tell me what changed" }]);

  const refused = await ask("POST", "kuvo/wakes/ses_watch/watch", { every: "1s", check: "date", note: "Too often" });
  assert.equal(refused.status, 400);
  assert.match(refused.json.message, /Use 5m or more/);
  assert.equal((await ask("GET", "kuvo/wakes/ses_watch")).json.watches.length, 1, "nothing made");

  assert.equal((await ask("POST", "kuvo/wakes/ses_watch/watch", { every: "1h" })).status, 400, "a check and a note are needed");
  assert.equal((await ask("POST", "kuvo/wakes/ses_gone/watch", { every: "1h", check: "date", note: "x" })).status, 404, "not a conversation here");
});

// The box's timers in these run on a clock of the test's: the minute can't pass unless the test
// moves it. Each waits for the run its box started to be over, then looks at what was sent.

test("this computer's box sends a wake-up when it's due, with kuvo-wake fire, as a machine's keeper does", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = conversation(t, "ses_due", { folder: true });
  fs.writeFileSync(path.join(folder, "wakes", `${now() - 5}-ghijkl`), "Send the weekly summary");
  const stop = link.sendWakes();
  try {
    // Due already: it goes in half a second.
    t.mock.timers.tick(500);
  } finally {
    await stop();
  }
  assert.deepEqual(prompted.filter(each => each.session === "ses_due").map(each => each.text), ["[Wake-up] Send the weekly summary"]);
  assert.equal(prompted.find(each => each.session === "ses_due").metadata, undefined, "one without a summary goes as it always did");
  assert.deepEqual(fs.readdirSync(path.join(folder, "wakes")), [], "sent, so it's gone and never goes twice");
});

// The wake-up's own kuvo-wake, as its agent's tool runs it (`letters/own-tools.ts`): `add` with a summary.
const kuvoWake = (folder, ...args) => new Promise((resolve, reject) => execFile(process.env.KUVO_WAKE_COMMAND, [folder, ...args], { encoding: "utf8" },
  (error, out, said) => error ? reject(new Error(said || error.message)) : resolve(out)));

test("a wake-up with a summary reaches its agent whole, marked with the summary its card shows", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = conversation(t, "ses_summed", { folder: true });
  const note = "Look at the last CI run. If it failed, read the log, fix what broke and tell the user.\n\nThen check the deploy.";
  await kuvoWake(folder, "add", "+2h", "--summary", "Check CI and the deploy", note);
  // Due now, as its time comes.
  const [name] = fs.readdirSync(path.join(folder, "wakes"));
  fs.renameSync(path.join(folder, "wakes", name), path.join(folder, "wakes", `${now() - 5}-${name.slice(name.indexOf("-") + 1)}`));
  const stop = link.sendWakes();
  try {
    t.mock.timers.tick(500);
  } finally {
    await stop();
  }
  const sent = prompted.filter(each => each.session === "ses_summed");
  assert.deepEqual(sent.map(each => each.text), [`[Wake-up] ${note}`], "the agent reads the note whole");
  assert.deepEqual(sent[0].metadata, { kuvo: { wake: { summary: "Check CI and the deploy" } } });
  assert.deepEqual(fs.readdirSync(path.join(folder, "summaries")), [], "its summary goes with it");
});

test("one woken now keeps its summary", async t => {
  const folder = conversation(t, "ses_summed_now", { folder: true });
  await kuvoWake(folder, "add", "+2h", "--summary", "Water the plants", "Water the plants on the balcony, then the ones inside.");
  const [wake] = (await ask("GET", "kuvo/wakes/ses_summed_now")).json.wakes;
  assert.equal((await ask("POST", "kuvo/wakes/ses_summed_now/now", { wake: wake.id })).status, 200);
  const sent = prompted.filter(each => each.session === "ses_summed_now");
  assert.deepEqual(sent.map(each => each.text), ["[Wake-up] Water the plants on the balcony, then the ones inside."]);
  assert.deepEqual(sent[0].metadata, { kuvo: { wake: { summary: "Water the plants" } } });
});

test("one kept waiting while you stopped its conversation keeps its summary", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stopped = conversation(t, "ses_summed_stopped", { folder: true });
  const queues = path.join(support, "box", "run", "queues.json");
  t.after(() => fs.rmSync(queues, { force: true }));
  fs.writeFileSync(queues, JSON.stringify({ ses_summed_stopped: { paused: true, held: [] } }));
  await kuvoWake(stopped, "add", "+2h", "--summary", "Send the digest", "Send the weekly digest to the team.");
  const [name] = fs.readdirSync(path.join(stopped, "wakes"));
  fs.renameSync(path.join(stopped, "wakes", name), path.join(stopped, "wakes", `${now() - 5}-${name.slice(name.indexOf("-") + 1)}`));
  const stop = link.sendWakes();
  try {
    t.mock.timers.tick(500);
  } finally {
    await stop();
  }
  assert.deepEqual(prompted.filter(each => each.session === "ses_summed_stopped"), []);
  const [waiting] = link.queueOf("ses_summed_stopped").waiting;
  assert.deepEqual([waiting.from, waiting.text], ["Wake-up", "Send the weekly digest to the team."]);
  // As it goes to the engine once you resume it.
  const kept = JSON.parse(fs.readFileSync(path.join(support, "box", "run", "waiting", `${waiting.id}.json`), "utf8"));
  assert.equal(kept.text, "[Wake-up] Send the weekly digest to the team.");
  assert.deepEqual(kept.metadata, { kuvo: { wake: { summary: "Send the digest" } } });
});

test("a wake-up due in a conversation you stopped waits on the box, shown as a wake-up, and one that repeats isn't kept twice", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = conversation(t, "ses_stopped", { folder: true });
  const queues = path.join(support, "box", "run", "queues.json");
  t.after(() => fs.rmSync(queues, { force: true }));
  // Stopped, as the box keeps it.
  fs.writeFileSync(queues, JSON.stringify({ ses_stopped: { paused: true, held: [] } }));
  fs.writeFileSync(path.join(folder, "wakes", `${now() - 5}-abcdef`), "Send the weekly summary");
  fs.writeFileSync(path.join(folder, "wakes", `${now() - 5}-ghijkl-1d`), "Check the build");
  const fire = async () => {
    const stop = link.sendWakes();
    try {
      t.mock.timers.tick(500);
    } finally {
      await stop();
    }
  };
  await fire();
  assert.deepEqual(prompted.filter(each => each.session === "ses_stopped"), [], "nothing reaches the conversation while it's stopped");
  const waiting = () => (link.queueOf("ses_stopped").waiting ?? []).map(each => [each.from, each.text]);
  assert.deepEqual(waiting(), [["Wake-up", "Send the weekly summary"], ["Wake-up", "Check the build"]]);
  const left = fs.readdirSync(path.join(folder, "wakes"));
  assert.equal(left.length, 1, "the one that's done is gone");
  assert.match(left[0], /^\d+-ghijkl-1d/);
  assert.ok(Number(left[0].split("-")[0]) > now(), "the repeating one comes back at its next time");

  // Its next time comes while it's still stopped: what waits isn't kept again.
  fs.renameSync(path.join(folder, "wakes", left[0]), path.join(folder, "wakes", `${now() - 5}-${left[0].slice(left[0].indexOf("-") + 1)}`));
  await fire();
  assert.deepEqual(waiting(), [["Wake-up", "Send the weekly summary"], ["Wake-up", "Check the build"]]);
  assert.deepEqual(prompted.filter(each => each.session === "ses_stopped"), []);
});

test("two conversations you stopped, with the same wake-up (bots made from one template), each keep theirs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = conversation(t, "ses_inbox1", { folder: true });
  const second = conversation(t, "ses_inbox2", { folder: true });
  const queues = path.join(support, "box", "run", "queues.json");
  t.after(() => fs.rmSync(queues, { force: true }));
  fs.writeFileSync(queues, JSON.stringify({ ses_inbox1: { paused: true, held: [] }, ses_inbox2: { paused: true, held: [] } }));
  fs.writeFileSync(path.join(first, "wakes", `${now() - 5}-abcdef-1d`), "Check the inbox");
  const fire = async () => {
    const stop = link.sendWakes();
    try {
      t.mock.timers.tick(500);
    } finally {
      await stop();
    }
  };
  await fire();
  // The second's comes due once the first's waits on the box.
  fs.writeFileSync(path.join(second, "wakes", `${now() - 5}-ghijkl-1d`), "Check the inbox");
  await fire();
  const waiting = session => (link.queueOf(session).waiting ?? []).map(each => [each.from, each.text]);
  assert.deepEqual(waiting("ses_inbox1"), [["Wake-up", "Check the inbox"]]);
  assert.deepEqual(waiting("ses_inbox2"), [["Wake-up", "Check the inbox"]], "the other's waiting isn't this one's");
  assert.deepEqual(prompted.filter(each => each.session.startsWith("ses_inbox")), []);
});

test("one an agent's kuvo-wake writes beside the box goes at its time, not at the next minute", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = conversation(t, "ses_soon", { folder: true });
  const stop = link.sendWakes();
  try {
    // The box has nothing due (its timer is a minute out) when the agent adds one for now.
    const file = path.join(folder, "wakes", `${now()}-mnopqr`);
    fs.writeFileSync(file, "Read the release notes");
    changedOnDisk(file);
    // The folders settle, then it goes at its time (a second at most from now), well short of the minute.
    t.mock.timers.tick(200);
    t.mock.timers.tick(1_000);
  } finally {
    await stop();
  }
  assert.deepEqual(prompted.filter(each => each.session === "ses_soon").map(each => each.text), ["[Wake-up] Read the release notes"]);
});

test("one written beside the box that the system never tells it of still goes within the minute", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const folder = conversation(t, "ses_unheard", { folder: true });
  const stop = link.sendWakes();
  try {
    fs.writeFileSync(path.join(folder, "wakes", `${now()}-stuvwx`), "Water the plants");
    // No word of it from the system: the box's look each minute finds it.
    t.mock.timers.tick(60_000);
  } finally {
    await stop();
  }
  assert.deepEqual(prompted.filter(each => each.session === "ses_unheard").map(each => each.text), ["[Wake-up] Water the plants"]);
});

test("a client that archived a conversation holds its wake-ups through the box, and a pause of your own outlasts it", async t => {
  const folder = conversation(t, "ses_archive");
  assert.equal((await ask("POST", "kuvo/wakes/ses_archive", { due: inAnHour(), note: "Check in" })).status, 200);
  assert.equal((await ask("POST", "kuvo/wakes/ses_archive/pause", { archived: true })).json.paused, true);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "archived");
  assert.equal((await ask("POST", "kuvo/wakes/ses_archive/pause", { archived: false })).json.paused, false);
  // Yours stays when it comes back.
  await ask("POST", "kuvo/wakes/ses_archive/pause", { paused: true });
  await ask("POST", "kuvo/wakes/ses_archive/pause", { archived: true });
  assert.equal((await ask("POST", "kuvo/wakes/ses_archive/pause", { archived: false })).json.paused, true);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "paused");
});

test("archiving a conversation that's moving to another computer waits for the move", async t => {
  const folder = conversation(t, "ses_moving");
  assert.equal((await ask("POST", "kuvo/wakes/ses_moving", { due: inAnHour(), note: "Check in" })).status, 200);
  fs.writeFileSync(path.join(folder, "paused"), "moving");
  assert.equal((await ask("POST", "kuvo/wakes/ses_moving/pause", { archived: true })).status, 409);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "moving", "the move's hold stays its own");
});
