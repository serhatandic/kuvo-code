// A machine's bots and wake-ups, answered by its bridge from their folders as the Mac answers for
// them (PROTOCOL.md, `kuvo/bots` and `kuvo/wakes`). Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { runningAs } from "./running-as.js";
import { removeAtEnd } from "./at-end.js";

// The bridge reads Kuvo Code's folder from KUVO_HOME: one of this test's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-bots-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");


const bots = path.join(home, "bots");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// A bot's folder as the app leaves it on a machine: its description, session and memory.
function bot(id, { name = "Scout", session = `ses_${id}`, created = "2026-10-01T09:00:00Z", kuvo = 1, described = true } = {}) {
  const folder = path.join(bots, id);
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  write(path.join(folder, "MEMORY.md"), `# ${name}'s memory\n`);
  if (session) write(path.join(folder, "session"), session);
  if (described) {
    write(path.join(folder, "bot.json"), JSON.stringify({
      kuvo, id, name, job: "Watches the build", look: { color: "sky", shape: "round", face: "calm" },
      model: { id: "big-pickle", providerID: "opencode" }, created, updated: created,
    }));
  }
  return folder;
}

beforeEach(() => {
  fs.rmSync(bots, { recursive: true, force: true });
  fs.rmSync(path.join(home, "wakes"), { recursive: true, force: true });
  fs.rmSync(path.join(home, "run"), { recursive: true, force: true });
});

// What the handler answers a phone's request, whole.
async function ask(handle, method, p, body, signal) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, signal)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json, text };
}

// An engine (or the agents' bridge) on a free port: its tools connected, prompts taken, its
// events sent (`send`) to whoever follows them; `request(match)`, the first request that matches.
async function fakeEngine() {
  const asked = [];
  const followers = [];
  const awaited = [];
  let followed;
  const following = new Promise(resolve => { followed = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": hello\n\n");
      followers.push(response);
      return followed();
    }
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const entry = { method: request.method, url: request.url, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"], body };
      asked.push(entry);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/api/mcp" ? JSON.stringify({ browser: { status: { status: "connected" } } }) : "{}");
      for (const waiting of awaited.filter(each => each.match(entry))) {
        awaited.splice(awaited.indexOf(waiting), 1);
        waiting.resolve(entry);
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    asked, port: server.address().port, following,
    send: event => { for (const follower of followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); },
    request: match => asked.find(match) ? Promise.resolve(asked.find(match)) : new Promise(resolve => awaited.push({ match, resolve })),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

test("wake-ups read from their names as the app reads them", () => {
  assert.deepEqual(link.wakeOf("1792000000-AbC123", "note"), { id: "1792000000-AbC123", due: 1792000000, note: "note", every: null, letters: "AbC123" });
  assert.equal(link.wakeOf("1792000000-AbC123-1d@0900").every, "1d");
  assert.equal(link.wakeOf("1792000000-AbC123-1w@Mon0900").every, "1w");
  assert.equal(link.wakeOf("1792000000-AbC123-weekdays@0900").every, "weekdays");
  assert.equal(link.wakeOf("1792000000-AbC123-30m").every, "30m");
  // Not a repeat kuvo-wake makes: no repeat at all, as the app reads it.
  for (const text of ["4m", "08h", "0d", "53w", "1y", "1234567m"]) assert.equal(link.repeatText(text), null, text);
  for (const name of [".firing", "notes.txt", "-AbC", ""]) assert.equal(link.wakeOf(name), null, name);
});

test("kuvo/bots lists the machine's described bots, each as its folder is now", async () => {
  const scout = bot("bot_scout00001", { created: "2026-10-02T09:00:00Z" });
  bot("bot_first00001", { name: "First", created: "2026-10-01T09:00:00Z" });
  bot("bot_noword0001", { described: false });
  bot("bot_newer00001", { kuvo: 2 });
  bot("bot_nosession1", { session: "" });
  write(path.join(bots, "notabot", "bot.json"), "{}");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "later");
  write(path.join(scout, "wakes", "1792000100-XyZ789-1d@0900"), "every morning");
  write(path.join(scout, "watches", "Qq1", "check"), "curl -s example.com");
  write(path.join(scout, "watches", "Qq2", "every"), "30m");
  write(path.join(scout, "paused"), "paused");
  write(path.join(scout, "via"), "bridge");

  const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" });
  const answer = await ask(handle, "GET", "kuvo/bots");
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.bots.map(each => each.name), ["First", "Scout"], "described ones, in the order they were made");
  assert.deepEqual(answer.json.bots[1], {
    id: "bot_scout00001", session: "ses_bot_scout00001", name: "Scout", look: { color: "sky", shape: "round", face: "calm" }, machine: "my-server",
    job: "Watches the build", jobDetails: "", paused: true, wakes: 1792000100, watching: 1, agents: true, model: { id: "big-pickle", providerID: "opencode" },
    folder: scout, created: "2026-10-02T09:00:00Z",
  });
  assert.equal("personality" in answer.json.bots[1], false, "none: left out, as the Mac leaves it out");
  assert.equal("wakes" in answer.json.bots[0], false, "none waiting: left out, as the Mac leaves it out");
  assert.equal((await ask(handle, "PUT", "kuvo/bots")).status, 405);
});

test("a bot's job is its record: taken once from its memory, and never again from its memory", async () => {
  const scout = bot("bot_scout00001");
  const memory = "# Scout's memory\n\n## Job\nWatches the nightly build.\nPosts when it breaks.\n\n## Notes\nx\n";
  write(path.join(scout, "MEMORY.md"), memory);
  bot("bot_first00001", { name: "First" });
  const unread = bot("bot_unread0001", { name: "Unread" });
  fs.rmSync(path.join(unread, "MEMORY.md"));
  const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" });
  const read = await ask(handle, "GET", "kuvo/bots");
  const byName = Object.fromEntries(read.json.bots.map(each => [each.name, each]));
  // (Its details without its line, which shows on its own.)
  assert.deepEqual([byName.Scout.job, byName.Scout.jobDetails], ["Watches the nightly build", "Posts when it breaks."]);
  // Without one in its memory: the job its description had (Edit Bot's, from before), kept.
  assert.deepEqual([byName.First.job, byName.Unread.job], ["Watches the build", "Watches the build"]);
  // Its memory stays as it was, and its description says the job in a few words.
  assert.equal(fs.readFileSync(path.join(scout, "MEMORY.md"), "utf8"), memory);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scout, "bot.json"), "utf8")).job, "Watches the nightly build");
  // From now on its memory is its own: what it writes there isn't its job.
  write(path.join(scout, "MEMORY.md"), "# Scout's memory\n\n## Job\nSomething else entirely.\n");
  assert.equal((await ask(handle, "GET", "kuvo/bots")).json.bots.find(each => each.name === "Scout").job, "Watches the nightly build");
});

test("kuvo/wakes reads a bot's or a session's wake-ups, watches and pause", async () => {
  const scout = bot("bot_scout00001");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "check the\nbuild");
  write(path.join(scout, "wakes", "1792000100-XyZ789-1d@0900"), "every morning");
  write(path.join(scout, "watches", "Qq1", "check"), "curl -s example.com");
  write(path.join(scout, "watches", "Qq1", "every"), "30m\n");
  write(path.join(scout, "watches", "Qq1", "note"), "Tell me when it's up");
  const session = path.join(home, "wakes", "ses_plain");
  write(path.join(session, "session"), "ses_plain");
  write(path.join(session, "wakes", "1792000900-Plain1"), "a session's own");
  write(path.join(session, "paused"), "archived");

  const handle = link.engineHandler(() => ({}), { name: "my-server" });
  const theBot = await ask(handle, "GET", "kuvo/wakes/ses_bot_scout00001");
  assert.equal(theBot.status, 200);
  assert.deepEqual(theBot.json, {
    wakes: [
      { id: "1792000100-XyZ789-1d@0900", due: 1792000100, note: "every morning", every: "1d" },
      { id: "1792000500-AbC123", due: 1792000500, note: "check the build" },
    ],
    watches: [{ letters: "Qq1", every: "30m", check: "curl -s example.com", note: "Tell me when it's up" }],
    paused: false,
  });
  const own = await ask(handle, "GET", "kuvo/wakes/ses_plain");
  assert.deepEqual(own.json, { wakes: [{ id: "1792000900-Plain1", due: 1792000900, note: "a session's own" }], watches: [], paused: true });
  // One that keeps none, and one that can't name a folder: nothing waiting.
  assert.deepEqual((await ask(handle, "GET", "kuvo/wakes/ses_other")).json, { wakes: [], watches: [], paused: false });
  assert.deepEqual((await ask(handle, "GET", "kuvo/wakes/..%2F..%2Fetc")).json, { wakes: [], watches: [], paused: false });

  // All at once, for the marks beside them: each session's soonest and whether it watches, and
  // its wake-ups, watches and pause as its own route says them (one read for a client); bots'
  // come with kuvo/bots.
  const watching = path.join(home, "wakes", "ses_watch");
  write(path.join(watching, "session"), "ses_watch");
  write(path.join(watching, "watches", "Ww2", "check"), "test -f done");
  write(path.join(path.join(home, "wakes", "ses_none"), "session"), "ses_none");
  const all = await ask(handle, "GET", "kuvo/wakes");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.sessions.sort((a, b) => a.session.localeCompare(b.session)), [
    { session: "ses_plain", next: 1792000900, watching: false, ...own.json },
    { session: "ses_watch", watching: true, wakes: [], watches: [{ letters: "Ww2", every: "", check: "test -f done", note: "" }], paused: false },
  ]);
  assert.equal((await ask(handle, "POST", "kuvo/wakes")).status, 405);
});

test("a wake-up or watch is cancelled by its letters; nothing else goes", async () => {
  const scout = bot("bot_scout00001");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "once");
  write(path.join(scout, "wakes", "1792000100-XyZ789-1d@0900"), "every morning");
  write(path.join(scout, "watches", "Qq1", "check"), "true");
  const handle = link.engineHandler(() => ({}), {});

  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/cancel", { wake: "XyZ789" })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), ["1792000500-AbC123"]);
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/cancel", { wake: "1792000500-AbC123" })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), []);
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/cancel", { watch: "Qq1" })).status, 200);
  assert.equal(fs.existsSync(path.join(scout, "watches", "Qq1")), false);
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/cancel", { wake: "gone00" })).status, 404);
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/cancel", { watch: "../../.." })).status, 404);
  assert.equal((await ask(handle, "GET", "kuvo/wakes/ses_bot_scout00001/cancel")).status, 405);
  assert.ok(fs.existsSync(path.join(scout, "MEMORY.md")), "its folder stays");
});

test("Wake Up Now for a conversation the user stopped: the wake-up waits there with its queue, rather than starting it", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const scout = bot("bot_scout00001");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "check the\nbuild");
  const queues = path.join(home, "run", "queues.json");
  write(queues, JSON.stringify({ ses_bot_scout00001: { paused: true, held: [] } }));
  t.after(() => fs.rmSync(queues, { force: true }));
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret" }), {});
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" })).status, 200);
  assert.ok(!engine.asked.some(each => each.url.endsWith("/prompt")), "the engine would run everything waiting with it");
  const [waiting] = link.queueOf("ses_bot_scout00001").waiting;
  assert.deepEqual([waiting.from, waiting.text], ["Wake-up", "check the\nbuild"]);
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), [], "a one-off is done: it waits with the queue now");
});

test("Wake Up Now sends the whole note to its session, then a one-off is done and a repeating one stays", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const scout = bot("bot_scout00001");
  write(path.join(scout, "directory"), "/home/me/project one");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "check the\nbuild");
  write(path.join(scout, "wakes", "1792000100-XyZ789-1d@0900"), "every morning");
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret" }), {});

  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" })).status, 200);
  const sent = engine.asked.find(each => each.url === "/api/session/ses_bot_scout00001/prompt");
  assert.ok(sent);
  assert.equal(sent.auth, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  const body = JSON.parse(sent.body);
  assert.equal(body.text, "[Wake-up] check the\nbuild", "the whole note, not the line it's listed by");
  assert.equal(body.delivery, "queue");
  assert.match(body.id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  // Its folder's tools first.
  const tools = engine.asked.find(each => each.url === "/api/mcp");
  assert.equal(decodeURIComponent(tools.directory), "/home/me/project one");
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), ["1792000100-XyZ789-1d@0900"]);

  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "XyZ789" })).status, 200);
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), ["1792000100-XyZ789-1d@0900"], "a repeating one comes back at its time");
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" })).status, 404, "a one-off is done");
});

test("Wake Up Now for one that runs with the coding agents goes to their bridge; with nothing running, it says so", async t => {
  const bridge = await fakeEngine();
  t.after(bridge.close);
  const scout = bot("bot_scout00001");
  write(path.join(scout, "via"), "bridge");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "once");
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, {});

  const down = await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" });
  assert.equal(down.status, 503);
  assert.match(down.json.message, /coding agents/);
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), ["1792000500-AbC123"], "still waiting");

  write(path.join(home, "run", "bridge.json"), JSON.stringify({ pid: await runningAs("kuvo-agents", t), port: bridge.port, password: "agents" }));
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" })).status, 200);
  assert.ok(bridge.asked.some(each => each.url === "/api/session/ses_bot_scout00001/prompt" && each.auth === `Basic ${Buffer.from("opencode:agents").toString("base64")}`));
  assert.equal(bridge.asked.some(each => each.url === "/api/mcp"), false, "their tools aren't the engine's to wait for");
});

test("a bot on its way to another computer isn't woken or changed from a phone until it's there", async t => {
  const engine = await fakeEngine();
  t.after(engine.close);
  const scout = bot("bot_scout00001");
  write(path.join(scout, "wakes", "1792000500-AbC123"), "check the build");
  // What a move writes while it holds the bot's wake-ups.
  write(path.join(scout, "paused"), "moving");
  const handle = link.engineHandler(() => ({ pid: process.pid, port: engine.port, password: "s3cret" }), {});

  for (const action of ["now", "cancel"]) {
    const answered = await ask(handle, "POST", `kuvo/wakes/ses_bot_scout00001/${action}`, { wake: "AbC123" });
    assert.equal(answered.status, 409, action);
    assert.match(answered.json.message, /moving/i, action);
  }
  assert.equal(engine.asked.some(each => each.url.endsWith("/prompt")), false, "nothing sent to a conversation on its way");
  assert.deepEqual(fs.readdirSync(path.join(scout, "wakes")), ["1792000500-AbC123"], "nothing taken away");

  // Paused by you instead: Wake Up Now still sends it, as on the Mac.
  write(path.join(scout, "paused"), "");
  assert.equal((await ask(handle, "POST", "kuvo/wakes/ses_bot_scout00001/now", { wake: "AbC123" })).status, 200);
});

// What a box makes bots with and tells them (`bin/bot-words.json`, as a client puts it beside the
// bridge), shortened: what a bot is told, with its job and personality in their places.
const words = {
  kuvo: 1,
  templates: [{ id: "news", name: "Herald", job: "Sends you a morning news digest", instructions: "Every morning…", look: { color: "sky", shape: "round", face: "happy" }, personality: "preset.straight", wantsProject: false }],
  personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", symbol: "bolt" }],
  personalityWords: "Your personality: ⟦name⟧. ⟦description⟧",
  looks: { colors: ["mint", "sky"], shapes: ["round"], faces: ["calm", "happy"] },
  instructions: ["You are ⟦name⟧, one of the user's bots⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧", "Memory: the file \"⟦folder⟧/MEMORY.md\" is yours.", "Who sets what."],
  here: { mac: { place: "this Mac" }, machine: { place: "the machine \"⟦machine⟧\"" } },
  // A bot with no job yet is told nothing of one here.
  job: { none: "", line: ": ⟦job⟧", details: "Your job, as your memory has it:\n⟦jobDetails⟧" },
  projectNote: "You work in one of the user's projects.",
  identityNote: "Who sets what.",
  memory: "# ⟦name⟧'s memory\n",
  greeting: "<system-reminder>Write first.</system-reminder>",
};
write(path.join(home, "bin", "bot-words.json"), JSON.stringify(words));

// What's the machine's own that its Mac gives it as it connects (Bots.MachineKit): the model a
// bot starts on there, its projects and your time zone (and, from an older Mac, the rules a new
// conversation gets, which the machine makes itself now).
const kit = {
  kuvo: 1,
  personalities: [],
  startingModel: { id: "big-pickle", providerID: "opencode" },
  projects: [{ directory: "/home/me/app", name: "app" }],
  rules: [{ action: "edit", resource: "*", effect: "ask" }],
  timeZone: "Europe/Istanbul",
};

// An engine and the agents' bridge as a new bot needs them: conversations made, what each was told,
// its greeting; the providers ready; group chats there (`chats`), listed and changed.
// `heard`: told of each request as it comes, before it's answered. `listed`: its models and its
// default, as it lists them (none listed when not given).
async function makingEngine(ready = ["opencode"], rules = {}, heard = () => {}, listed = null) {
  const asked = [];
  const chats = new Map();
  let next = 1;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const given = body ? JSON.parse(body) : undefined;
      asked.push({ method: request.method, url: request.url, body: given });
      heard(asked.at(-1));
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (made.refuse(asked.at(-1))) return reply({ message: "Not now." }, 500);
      if (made.hold(asked.at(-1))) return made.held.push(() => reply({}));
      if (request.method === "GET" && request.url === "/api/provider") return reply({ data: ready.map(id => ({ id })) });
      if (listed && request.method === "GET" && request.url === "/api/model") return reply({ data: listed.models });
      if (listed && request.method === "GET" && request.url === "/api/model/default") return reply({ data: listed.defaultModel });
      // Each provider's account, as the engine lists them: signed in where it's ready (so a new
      // bot's model goes by the box's one rule, work/model-rule.ts).
      if (listed && request.method === "GET" && request.url === "/api/integration") {
        const providers = [...new Set(listed.models.map(each => each.providerID))];
        return reply({ data: providers.map(id => ({ id, name: id, methods: [{ type: "key" }], connections: ready.includes(id) ? [{ type: "credential", method: "key" }] : [] })) });
      }
      if (request.method === "POST" && request.url === "/api/session") return reply({ data: { id: `ses_made${next++}` } });
      const one = request.url.match(/^\/api\/session\/([^/]+)$/);
      if (one && request.method === "GET") return reply({ data: { id: one[1], permissions: rules[one[1]] ?? [] } });
      if (one && request.method === "PATCH" && given?.permissions) rules[one[1]] = given.permissions;
      if (request.method === "GET" && request.url === "/api/kuvo/groups") return reply({ data: [...chats.values()].map(chat => ({ group: chat.group, status: chat.status, state: {} })) });
      if (request.method === "PATCH" && request.url.startsWith("/api/kuvo/groups/")) {
        const chat = chats.get(request.url.split("/").pop());
        if (!chat) return reply({ message: "No such chat." }, 404);
        Object.assign(chat.group, given);
        return reply({ data: chat });
      }
      if (request.method === "DELETE" && request.url.startsWith("/api/kuvo/groups/")) {
        chats.delete(request.url.split("/").pop());
        return reply({});
      }
      reply({});
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // (`refuse`: which requests it fails, set by a test; `hold`: which it answers only once the test
  // lets them go, `held`.)
  const made = { asked, chats, port: server.address().port, password: "p", refuse: () => false, hold: () => false, held: [], close: () => { server.closeAllConnections(); server.close(); } };
  return made;
}

test("New Bot offers the box's own projects once it keeps them, not those a Mac once named", async t => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const app = path.join(home, "work", "app"), shop = path.join(home, "work", "shop");
  for (const folder of [app, shop]) fs.mkdirSync(folder, { recursive: true });
  t.after(() => fs.rmSync(path.join(home, "box", "projects.json"), { force: true }));
  const handle = link.engineHandler(() => { throw new Error("no engine"); }, { name: "my-server" }, () => null);
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(fs.realpathSync(app))}`, { name: "App" });
  await ask(handle, "PUT", `kuvo/projects?directory=${encodeURIComponent(fs.realpathSync(shop))}`, {});
  link.changeProjects(projects => projects.map(each => (each.directory === fs.realpathSync(shop) ? { ...each, removed: true } : each)));
  const offered = await ask(handle, "GET", "kuvo/bots/templates");
  assert.deepEqual(offered.json.projects, [{ directory: fs.realpathSync(app), name: "App", machine: "my-server" }]);
});

test("New Bot here offers, and starts a bot on, a model this box can use: not the one its Mac last named once its account is signed out here, or once its provider is retiring it", async () => {
  // The engine lists Flint first, and its default is Big Pickle.
  const flint = { id: "flint", providerID: "opencode", name: "Flint", enabled: true };
  const pickle = { id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true };
  const sonnet = { id: "sonnet", providerID: "anthropic", name: "Sonnet", enabled: true };
  const retiring = { id: "opus-old", providerID: "anthropic", name: "Opus Old", enabled: true, status: "deprecated" };
  const offeredWith = async (named, ready, defaultModel) => {
    write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, startingModel: named }));
    const engine = await makingEngine(ready, {}, () => {}, { models: [flint, pickle, sonnet, retiring], defaultModel });
    try {
      const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
      const offered = await ask(handle, "GET", "kuvo/bots/templates");
      const made = await ask(handle, "POST", "kuvo/bots", { name: "Scout" });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      assert.deepEqual(made.json.bot.model, offered.json.startingModel["my-server"], "it starts on the model it offers");
      return offered.json.startingModel["my-server"];
    } finally {
      engine.close();
    }
  };
  // The Mac named a model of an account this box isn't signed in to (signed out since, or never here): the engine's default.
  assert.deepEqual(await offeredWith({ id: "sonnet", providerID: "anthropic" }, ["opencode"], pickle), { id: "big-pickle", providerID: "opencode" });
  // One its provider is retiring, though its account is signed in here.
  assert.deepEqual(await offeredWith({ id: "opus-old", providerID: "anthropic" }, ["opencode", "anthropic"], pickle), { id: "big-pickle", providerID: "opencode" });
  // The engine's default can't run here either: the first model that can.
  assert.deepEqual(await offeredWith({ id: "sonnet", providerID: "anthropic" }, ["opencode"], sonnet), { id: "flint", providerID: "opencode" });
  // One it can: as the Mac named it.
  assert.deepEqual(await offeredWith({ id: "sonnet", providerID: "anthropic" }, ["opencode", "anthropic"], pickle), { id: "sonnet", providerID: "anthropic" });
});

test("New Bot here starts on the model a new conversation here would, by the box's one rule: with none named and a default being retired, the first that runs in the picker's order, not the engine's", async () => {
  // The engine lists Flint (OpenCode Zen) first; Anthropic, featured before OpenCode Zen, comes first in the picker.
  const flint = { id: "flint", providerID: "opencode", name: "Flint", enabled: true };
  const sonnet = { id: "sonnet", providerID: "anthropic", name: "Sonnet", enabled: true };
  const retiring = { id: "opus-old", providerID: "anthropic", name: "Opus Old", enabled: true, status: "deprecated" };
  write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, startingModel: null }));
  const engine = await makingEngine(["opencode", "anthropic"], {}, () => {}, { models: [flint, sonnet, retiring], defaultModel: retiring });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const offered = await ask(handle, "GET", "kuvo/bots/templates");
    assert.deepEqual(offered.json.startingModel["my-server"], { id: "sonnet", providerID: "anthropic" });
  } finally {
    engine.close();
  }
});

test("with the Mac closed, a bot is made here as New Bot makes it: its folder, conversation and instructions, and it writes first", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const engine = await makingEngine();
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const offered = await ask(handle, "GET", "kuvo/bots/templates");
    assert.equal(offered.status, 200);
    assert.deepEqual(offered.json.startingModel, { "my-server": { id: "big-pickle", providerID: "opencode" } });
    assert.deepEqual(offered.json.projects, [{ directory: "/home/me/app", name: "app", machine: "my-server" }]);
    assert.equal("firstMessage" in offered.json.templates[0], false);
    assert.deepEqual(offered.json.personalities, [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", custom: false }]);

    const made = await ask(handle, "POST", "kuvo/bots", { name: "  Inbox\nHelper ", personality: "preset.straight", project: "/home/me/app" });
    assert.equal(made.status, 201);
    const { bot: listed, firstMessage } = made.json;
    assert.equal(firstMessage, null);
    assert.match(listed.id, /^bot_[a-z0-9]{10}$/);
    assert.equal(listed.name, "Inbox Helper");
    assert.equal(listed.machine, "my-server");
    assert.equal(listed.session, "ses_made1");
    const folder = path.join(bots, listed.id);
    assert.equal(fs.readFileSync(path.join(folder, "MEMORY.md"), "utf8"), "# Inbox Helper's memory\n");
    assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), "/home/me/app");
    assert.equal(fs.readFileSync(path.join(folder, "timezone"), "utf8"), "Europe/Istanbul");
    const described = JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8"));
    assert.match(described.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "a date the Mac reads");
    assert.deepEqual({ ...described, created: undefined, updated: undefined, look: undefined }, { created: undefined, updated: undefined, look: undefined, id: listed.id, job: "", kuvo: 1, model: kit.startingModel, name: "Inbox Helper", personality: "preset.straight", project: "/home/me/app" });
    const session = engine.asked.find(each => each.method === "POST" && each.url === "/api/session");
    assert.equal(session.body.location.directory, "/home/me/app");
    // Its own folder; the rest made for this machine's default and its Settings › Permissions (below),
    // never from a Mac's last pick.
    assert.deepEqual(session.body.permissions, [{ action: "external_directory", resource: path.join(folder, "*"), effect: "allow" }]);
    const told = engine.asked.find(each => each.url === "/api/experimental/session/ses_made1/instructions/entries/kuvo.bot").body.value;
    assert.equal(told, `You are Inbox Helper, one of the user's bots.\n\nYour personality: Straight Shooter. Direct.\n\nMemory: the file "${folder}/MEMORY.md" is yours.\n\nYou work in one of the user's projects.\n\nWho sets what.`);
    // Marked as a bot's, and kept with Auto, which asks first here: the sandbox doesn't run.
    const marked = engine.asked.find(each => each.method === "PATCH").body;
    assert.deepEqual(marked.metadata, { kuvo: { bot: listed.id, approval: "auto", applied: "askFirst" } });
    assert.ok(marked.permissions.some(rule => rule.action === "shell" && rule.resource === "*" && rule.effect === "ask"), "it asks before commands");
    assert.equal(engine.asked.find(each => each.url === "/api/session/ses_made1/synthetic").body.text, words.greeting, "it writes first");
    assert.ok((await ask(handle, "GET", "kuvo/bots")).json.bots.some(each => each.id === listed.id), "listed at once");

    // From a template: its look and personality, and its job for your composer; it waits for you.
    const herald = await ask(handle, "POST", "kuvo/bots", { name: "Herald", template: "news" });
    assert.equal(herald.status, 201);
    assert.equal(herald.json.firstMessage, "Your job, in a few words: Sends you a morning news digest.\n\nEvery morning…\n\nStart now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up.");
    assert.equal(engine.asked.some(each => each.url === `/api/session/${herald.json.bot.session}/synthetic`), false);
    assert.deepEqual(herald.json.bot.look, words.templates[0].look);
    const plain = engine.asked.find(each => each.url === `/api/experimental/session/${herald.json.bot.session}/instructions/entries/kuvo.bot`).body.value;
    assert.ok(plain.includes("Straight Shooter") && !plain.includes("⟦") && !plain.includes("projects"));
    // What Claude Code remembers for one with a folder of its own is kept in it, so it moves with it;
    // in a project, it's the project's.
    assert.ok(fs.statSync(path.join(bots, herald.json.bot.id, "memory")).isDirectory());
    assert.ok(!fs.existsSync(path.join(folder, "memory")));
  } finally {
    engine.close();
  }
});

test("New Bot sent again with the same request (the phone tried again after its connection dropped) makes one bot, answered alike both times", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const engine = await makingEngine();
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    // The second while the first is still being made, and once more after.
    const [first, again] = await Promise.all([1, 2].map(() => ask(handle, "POST", "kuvo/bots", { name: "Scout", request: "req_newbot0001" })));
    const later = await ask(handle, "POST", "kuvo/bots", { name: "Scout", request: "req_newbot0001" });
    for (const answer of [first, again, later]) assert.equal(answer.status, 201);
    assert.equal(again.json.bot.id, first.json.bot.id);
    assert.equal(later.json.bot.id, first.json.bot.id);
    assert.deepEqual(link.listBots().map(each => each.name), ["Scout"]);
    assert.equal(engine.asked.filter(each => each.method === "POST" && each.url === "/api/session").length, 1);
    // Another New Bot, though its name is the same: another bot.
    assert.notEqual((await ask(handle, "POST", "kuvo/bots", { name: "Scout", request: "req_newbot0002" })).json.bot.id, first.json.bot.id);
    assert.equal(link.listBots().length, 2);
  } finally {
    engine.close();
  }
});

test("what's missing or unknown is said, and nothing is made", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const engine = await makingEngine(["opencode"]);
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    for (const [body, status, words] of [
      [{ look: { color: "sky" } }, 400, "A bot needs a name."],
      [{ name: "X", template: "nope" }, 400, "There’s no template “nope”."],
      [{ name: "X", personality: "custom.gone" }, 400, "There’s no personality “custom.gone”."],
      [{ name: "X", project: "/nowhere" }, 400, "That project isn’t in Kuvo Code."],
      [{ name: "X", model: { id: "luna", providerID: "openai" } }, 422, "luna needs a sign-in on this machine: sign in to it in Settings › Accounts, or choose another model."],
      [{ name: "X", model: { id: "sonnet", providerID: "claude-code" } }, 503, "The coding agents aren’t running on this machine."],
    ]) {
      const answer = await ask(handle, "POST", "kuvo/bots", body);
      assert.equal(answer.status, status, JSON.stringify(body));
      assert.equal(answer.json.message, words);
    }
    assert.deepEqual(link.listBots(), []);
    assert.equal(engine.asked.some(each => each.url === "/api/session"), false);
  } finally {
    engine.close();
  }
});

test("a bot whose making the phone leaves mid-way (it cancels, or its connection drops) is made whole, not left as a conversation without its bot", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const gone = new AbortController();
  // The phone goes once its conversation is made.
  const engine = await makingEngine(["opencode"], {}, request => { if (request.method === "PATCH") gone.abort(); });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    await ask(handle, "POST", "kuvo/bots", { name: "Scout" }, gone.signal);
    const [made] = link.listBots();
    assert.equal(made?.session, "ses_made1", "listed, with its conversation");
    assert.ok(engine.asked.some(each => each.method === "PUT" && each.url === "/api/experimental/session/ses_made1/instructions/entries/kuvo.bot"), "its conversation told what it is");
    assert.equal(engine.asked.some(each => each.method === "DELETE"), false);
  } finally {
    engine.close();
  }
});

test("a phone that leaves while a bot's conversation is being made leaves no conversation without its bot, and its New Bot sent again meanwhile is answered with the bot", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const gone = new AbortController();
  // The phone goes as its conversation is asked for; the engine makes it all the same.
  const engine = await makingEngine(["opencode"], {}, request => { if (request.method === "POST" && request.url === "/api/session") gone.abort(); });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    // Sent again from its new connection while the first is still being made.
    const [, again] = await Promise.all([
      ask(handle, "POST", "kuvo/bots", { name: "Scout", request: "req_leaving001" }, gone.signal),
      ask(handle, "POST", "kuvo/bots", { name: "Scout", request: "req_leaving001" }),
    ]);
    assert.equal(again.status, 201, again.json?.message);
    assert.equal(again.json.bot.session, "ses_made1");
    assert.deepEqual(link.listBots().map(each => each.session), ["ses_made1"], "the conversation made has its bot");
    assert.equal(engine.asked.filter(each => each.method === "POST" && each.url === "/api/session").length, 1);
    assert.equal(engine.asked.some(each => each.method === "DELETE"), false);
  } finally {
    engine.close();
  }
});

test("a bot whose conversation can't be marked as its own isn't made: its conversation goes, and New Bot says why", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const engine = await makingEngine();
  try {
    // An engine that makes the conversation but doesn't take what marks it as a bot's.
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    engine.refuse = request => request.method === "PATCH" && request.body?.metadata;
    const made = await ask(handle, "POST", "kuvo/bots", { name: "Scout" });
    assert.equal(made.status, 503);
    assert.match(made.json.message, /^The bot couldn’t be made/);
    assert.deepEqual(link.listBots(), []);
    assert.ok(engine.asked.some(each => each.method === "DELETE" && each.url === "/api/session/ses_made1"), "its conversation goes");
  } finally {
    engine.close();
  }
});

test("a bot's job is set as a whole (its set_job tool, Edit Bot): shown under its name, told to its conversation at once", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  const engine = await makingEngine();
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const set = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { job: { line: "  **Keeps CI green.** ", details: "Watch main.\nFix flaky tests; never skip them.\n" } });
    assert.equal(set.status, 200);
    assert.deepEqual([set.json.bot.job, set.json.bot.jobDetails], ["Keeps CI green", "Watch main.\nFix flaky tests; never skip them."]);
    const told = engine.asked.filter(each => each.method === "PUT" && each.url === "/api/experimental/session/ses_bot_scout00001/instructions/entries/kuvo.bot");
    assert.equal(told.length, 1);
    assert.match(told[0].body.value, /one of the user's bots: Keeps CI green\./);
    assert.match(told[0].body.value, /Watch main\.\nFix flaky tests; never skip them\./);
    const kept = JSON.parse(fs.readFileSync(path.join(folder, "job.json"), "utf8"));
    assert.deepEqual([kept.line, kept.details], ["Keeps CI green", "Watch main.\nFix flaky tests; never skip them."]);
    assert.equal(fs.readFileSync(path.join(folder, "MEMORY.md"), "utf8"), "# Scout's memory\n", "its memory isn't touched");
    // The same again: nothing to tell.
    await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { job: { line: "Keeps CI green", details: "Watch main.\nFix flaky tests; never skip them." } });
    assert.equal(engine.asked.filter(each => each.method === "PUT").length, 1);
    // What can't be: said, and nothing changes.
    for (const job of ["Keeps CI green", { line: 3 }, { line: "x".repeat(201) }, { line: "Ok", details: "x".repeat(8001) }]) {
      const refused = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { job });
      assert.equal(refused.status, 400, JSON.stringify(job).slice(0, 40));
      assert.equal(typeof refused.json.message, "string");
    }
    assert.equal((await ask(handle, "GET", "kuvo/bots")).json.bots[0].job, "Keeps CI green");
    // None: an empty job, and its words go back to those of a bot without one.
    await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { job: { line: "", details: "" } });
    assert.equal((await ask(handle, "GET", "kuvo/bots")).json.bots[0].job, "");
    assert.doesNotMatch(engine.asked.filter(each => each.method === "PUT").at(-1).body.value, /Keeps CI green/);
  } finally {
    engine.close();
  }
});


// How bots kept their job in their memory before (frozen as the Mac read it), which the box takes a
// job from once (jobOf).
const groupVectors = JSON.parse(fs.readFileSync(new URL("../../Vectors/memory-jobs.json", import.meta.url), "utf8"));

test("a bot's job is read from its memory as the Mac reads it", () => {
  assert.ok(groupVectors.job.length > 5);
  for (const vector of groupVectors.job) {
    const job = link.jobInMemory(vector.memory);
    assert.deepEqual([job?.line ?? null, job?.section ?? null], [vector.line, vector.section], vector.memory);
  }
});

// What a phone's change asked of the conversation, by what it did there.
const told = (asked, session) => ({
  title: asked.find(each => each.method === "PATCH" && each.url === `/api/session/${session}`)?.body?.title,
  model: asked.find(each => each.method === "POST" && each.url === `/api/session/${session}/model`)?.body?.model,
  instructions: asked.find(each => each.method === "PUT" && each.url === `/api/experimental/session/${session}/instructions/entries/kuvo.bot`)?.body?.value,
});

test("with the Mac closed, a bot here is changed from a phone as Edit Bot changes it, and its conversation told", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  write(path.join(folder, "MEMORY.md"), "# Scout's memory\n\n## Job\nWatches the build.\nTells you when it breaks.\n\n## Notes\nnone\n");
  const engine = await makingEngine(["opencode", "anthropic"]);
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const before = JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8"));
    const changed = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", {
      name: " Scout\nPrime ", look: { color: "mint", shape: "round", face: "happy" }, personality: "preset.straight", model: { id: "opus", providerID: "anthropic", variant: "high" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.deepEqual({ ...changed.json.bot, wakes: undefined }, {
      id: "bot_scout00001", session: "ses_bot_scout00001", name: "Scout Prime", look: { color: "mint", shape: "round", face: "happy" }, machine: "my-server",
      job: "Watches the build", jobDetails: "Tells you when it breaks.", paused: false, wakes: undefined, watching: 0, agents: false, personality: "preset.straight", model: { id: "opus", providerID: "anthropic", variant: "high" },
      folder, created: before.created,
    });
    // Its description, for what runs here and for the Mac as it next connects: newer than before.
    const described = JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8"));
    assert.equal(described.name, "Scout Prime");
    assert.equal(described.personality, "preset.straight");
    assert.equal(described.created, before.created);
    assert.match(described.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(described.updated > before.updated);
    // Its conversation: its title, its model, and what it's told, with its job (taken from its memory, once).
    assert.deepEqual(told(engine.asked, "ses_bot_scout00001"), {
      title: "Scout Prime", model: { id: "opus", providerID: "anthropic", variant: "high" },
      instructions: `You are Scout Prime, one of the user's bots: Watches the build.\n\nYour personality: Straight Shooter. Direct.\n\nYour job, as your memory has it:\nTells you when it breaks.\n\nMemory: the file "${folder}/MEMORY.md" is yours.\n\nWho sets what.`,
    });

    // Its own way again: told without a personality; nothing else is touched.
    engine.asked.length = 0;
    const plain = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { personality: null });
    assert.equal(plain.status, 200);
    assert.equal("personality" in plain.json.bot, false);
    assert.deepEqual(told(engine.asked, "ses_bot_scout00001").title, undefined, "the same name isn't sent again");
    assert.ok(!told(engine.asked, "ses_bot_scout00001").instructions.includes("Straight Shooter"));
    // Nothing changed: nothing written, nothing told.
    engine.asked.length = 0;
    const kept = fs.readFileSync(path.join(folder, "bot.json"), "utf8");
    assert.equal((await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Scout Prime" })).status, 200);
    assert.equal(fs.readFileSync(path.join(folder, "bot.json"), "utf8"), kept);
    assert.deepEqual(engine.asked, []);
  } finally {
    engine.close();
  }
});

test("a bot changed from a phone that leaves mid-way has its conversation told all of it: its new name, model and words, not only its details", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  const gone = new AbortController();
  // The phone goes once its details are saved, as its conversation is renamed.
  const engine = await makingEngine(["opencode", "anthropic"], {}, request => { if (request.method === "PATCH" && request.body?.title) gone.abort(); });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Scout Prime", model: { id: "opus", providerID: "anthropic" } }, gone.signal);
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout Prime");
    const heard = told(engine.asked, "ses_bot_scout00001");
    assert.deepEqual(heard.model, { id: "opus", providerID: "anthropic" }, "its conversation runs on the new model");
    assert.match(heard.instructions ?? "", /^You are Scout Prime/, "and is told its new name");
  } finally {
    engine.close();
  }
});

test("a change that waits on the engine (a new model's sign-in) keeps what another change saved meanwhile", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  const file = path.join(folder, "bot.json");
  // As the engine is asked whether the new model is signed in, another client's change is saved.
  const engine = await makingEngine(["opencode", "anthropic"], {}, request => {
    if (request.method === "GET" && request.url === "/api/provider") write(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), look: { color: "mint", shape: "round", face: "happy" }, personality: "preset.straight" }));
  });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const changed = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Scout Prime", model: { id: "opus", providerID: "anthropic" } });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    const described = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(described.name, "Scout Prime");
    assert.deepEqual(described.model, { id: "opus", providerID: "anthropic" });
    assert.deepEqual(described.look, { color: "mint", shape: "round", face: "happy" }, "the other change's look is kept");
    assert.equal(described.personality, "preset.straight");
  } finally {
    engine.close();
  }
});

test("a change that can't be is said, and nothing changes", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  const engine = await makingEngine(["opencode"]);
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    const kept = fs.readFileSync(path.join(folder, "bot.json"), "utf8");
    for (const [body, status, words] of [
      [{ name: "  " }, 400, "A bot needs a name."],
      [{ name: null }, 400, "A bot needs a name."],
      [{ look: { color: "plaid", shape: "round", face: "calm" } }, 400, "That isn’t a look a bot can have."],
      [{ personality: "custom.gone" }, 400, "There’s no personality “custom.gone”."],
      [{ model: { id: "x" } }, 400, "That isn’t a model."],
      [{ model: { id: "luna", providerID: "openai" } }, 422, "luna needs a sign-in on this machine: sign in to it in Settings › Accounts, or choose another model."],
      [{ model: { id: "sonnet", providerID: "claude-code" } }, 503, "The coding agents aren’t running on this machine."],
    ]) {
      const answer = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Renamed", ...body });
      assert.equal(answer.status, status, JSON.stringify(body));
      assert.equal(answer.json.message, words);
    }
    assert.equal(fs.readFileSync(path.join(folder, "bot.json"), "utf8"), kept);
    assert.equal(engine.asked.some(each => each.url.startsWith("/api/session/ses_bot_scout00001") || each.url.includes("/instructions/")), false);

    // The model it has stays, signed in here or not.
    write(path.join(folder, "bot.json"), JSON.stringify({ ...JSON.parse(kept), model: { id: "luna", providerID: "openai" } }));
    assert.equal((await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Renamed", model: { id: "luna", providerID: "openai" } })).status, 200);

    const gone = await ask(handle, "PATCH", "kuvo/bots/bot_gone000001", { name: "X" });
    assert.equal(gone.status, 404);
    assert.equal(gone.json.message, "That bot isn’t there any more.");
    assert.equal((await ask(handle, "PATCH", "kuvo/bots/..%2Fkit.json", { name: "X" })).status, 404);
    write(path.join(folder, "paused"), "moving");
    const moving = await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "X" });
    assert.equal(moving.status, 409);
    assert.match(moving.json.message, /moving/);
  } finally {
    engine.close();
  }
});

test("with the Mac closed, a bot here is deleted from a phone as Delete Bot… deletes it, and noted for the Mac", async t => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const scout = bot("bot_scout00001", { name: "Scout" });
  bot("bot_ada0000001", { name: "Ada" });
  bot("bot_ben0000001", { name: "Ben" });
  const keys = path.join(home, "box", "bot-keys");
  write(path.join(keys, "KUVO_KEY_GITHUB_TOKEN__BOT_SCOUT00001"), "its own");
  write(path.join(keys, "KUVO_KEY_GITHUB_TOKEN__BOT_ADA0000001"), "another's");
  write(path.join(home, "box", "keys", "KUVO_KEY_GITHUB_TOKEN"), "shared");
  fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
  const engine = await makingEngine();
  const agents = await runningAs("kuvo-agents", t);
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => ({ port: engine.port, password: "p", pid: agents }));
    // A group chat of theirs here, as the coding agents' bridge runs it.
    const chat = { json: { group: { id: "grp_release001" } } };
    engine.chats.set("grp_release001", { group: { id: "grp_release001", name: "Release", members: ["bot_scout00001", "bot_ada0000001", "bot_ben0000001"] }, status: "active" });

    const deleted = await ask(handle, "DELETE", "kuvo/bots/bot_scout00001");
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
    assert.deepEqual(deleted.json, {});
    // Its folder, with its memory, to the trash here; no longer listed.
    assert.equal(fs.existsSync(scout), false);
    const [trashed] = fs.readdirSync(path.join(home, "trash"));
    assert.match(trashed, /^\d{8}-\d{6}-\d+$/);
    assert.ok(fs.existsSync(path.join(home, "trash", trashed, "bot_scout00001", "MEMORY.md")));
    assert.deepEqual(link.listBots().map(each => each.id), ["bot_ada0000001", "bot_ben0000001"]);
    // Noted for the Mac, which lets it go as it next connects.
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bots, "deleted.json"), "utf8")), { deleted: ["bot_scout00001"] });
    // Its keys of its own go; others' and the shared one stay.
    assert.deepEqual(fs.readdirSync(keys).sort(), ["KUVO_KEY_GITHUB_TOKEN__BOT_ADA0000001"]);
    assert.equal(fs.readFileSync(path.join(home, "box", "keys", "KUVO_KEY_GITHUB_TOKEN"), "utf8"), "shared");
    // Its group chat goes on without it, and its conversation is deleted.
    const left = engine.asked.filter(each => each.method === "PATCH" && each.url === `/api/kuvo/groups/${chat.json.group.id}`).at(-1);
    assert.deepEqual(left.body, { members: ["bot_ada0000001", "bot_ben0000001"] });
    assert.ok(engine.asked.some(each => each.method === "DELETE" && each.url === "/api/session/ses_bot_scout00001"));

    assert.equal((await ask(handle, "DELETE", "kuvo/bots/bot_scout00001")).status, 404);
    // On its way to another computer: it stays.
    write(path.join(bots, "bot_ada0000001", "paused"), "moving");
    assert.equal((await ask(handle, "DELETE", "kuvo/bots/bot_ada0000001")).status, 409);
    assert.ok(fs.existsSync(path.join(bots, "bot_ada0000001")));
    assert.equal((await ask(handle, "DELETE", "kuvo/bots/bot_ben0000001")).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bots, "deleted.json"), "utf8")).deleted, ["bot_ben0000001", "bot_scout00001"], "the latest first");
  } finally {
    engine.close();
    fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
    fs.rmSync(keys, { recursive: true, force: true });
  }
});

test("a bot deleted from a phone that leaves mid-way is deleted whole: its group chats go on without it, and its conversation goes", async t => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  bot("bot_scout00001", { name: "Scout" });
  bot("bot_ada0000001", { name: "Ada" });
  fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
  const gone = new AbortController();
  // The phone goes once its folder is in the trash, as the bot's group chats are looked up.
  const engine = await makingEngine(["opencode"], {}, request => { if (request.url === "/api/kuvo/groups") gone.abort(); });
  const agents = await runningAs("kuvo-agents", t);
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => ({ port: engine.port, password: "p", pid: agents }));
    engine.chats.set("grp_release001", { group: { id: "grp_release001", name: "Release", members: ["bot_scout00001", "bot_ada0000001"] }, status: "active" });
    await ask(handle, "DELETE", "kuvo/bots/bot_scout00001", undefined, gone.signal);
    assert.deepEqual(link.listBots().map(each => each.id), ["bot_ada0000001"]);
    assert.deepEqual(engine.chats.get("grp_release001").group.members, ["bot_ada0000001"], "its group chat goes on without it");
    assert.ok(engine.asked.some(each => each.method === "DELETE" && each.url === "/api/session/ses_bot_scout00001"), "its conversation goes");
  } finally {
    engine.close();
    fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
  }
});

test("a bot deleted while its engine and coding agents restart is gone at once, and its conversation and place in its group chats go once they're back", async t => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  bot("bot_scout00001", { name: "Scout" });
  bot("bot_ada0000001", { name: "Ada" });
  fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
  t.after(() => fs.rmSync(path.join(home, "trash"), { recursive: true, force: true }));
  const engine = await makingEngine();
  const agents = await runningAs("kuvo-agents", t);
  try {
    engine.chats.set("grp_release001", { group: { id: "grp_release001", name: "Release", members: ["bot_scout00001", "bot_ada0000001"] }, status: "active" });
    // Neither answering now.
    engine.refuse = () => true;
    const readEngine = () => ({ port: engine.port, password: "p" });
    const readBridge = () => ({ port: engine.port, password: "p", pid: agents });
    const handle = link.engineHandler(readEngine, { name: "my-server" }, readBridge);
    assert.equal((await ask(handle, "DELETE", "kuvo/bots/bot_scout00001")).status, 200);
    assert.deepEqual(link.listBots().map(each => each.id), ["bot_ada0000001"], "gone at once");
    // Back (as the box finds them again).
    engine.refuse = () => false;
    const before = engine.asked.length;
    await link.finishDeletes(readEngine, readBridge);
    assert.ok(engine.asked.slice(before).some(each => each.method === "DELETE" && each.url === "/api/session/ses_bot_scout00001"), "its conversation goes");
    assert.deepEqual(engine.chats.get("grp_release001").group.members, ["bot_ada0000001"], "its group chat goes on without it");
    // Once, and nothing's left to do.
    const asked = engine.asked.length;
    await link.finishDeletes(readEngine, readBridge);
    assert.equal(engine.asked.length, asked);
  } finally {
    engine.close();
  }
});

test("a bot being deleted as its box stops (an update, a crash) still loses its conversation once the box starts again", async t => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  bot("bot_quill00001", { name: "Quill" });
  fs.rmSync(path.join(home, "trash"), { recursive: true, force: true });
  t.after(() => fs.rmSync(path.join(home, "trash"), { recursive: true, force: true }));
  const engine = await makingEngine();
  const agents = await runningAs("kuvo-agents", t);
  try {
    // Its engine slow to let its conversation go, and the box stops meanwhile.
    let reached;
    const deleting = new Promise(resolve => { reached = resolve; });
    engine.hold = each => each.method === "DELETE" && each.url === "/api/session/ses_bot_quill00001" && (reached(), true);
    const readEngine = () => ({ port: engine.port, password: "p" });
    const readBridge = () => ({ port: engine.port, password: "p", pid: agents });
    const handle = link.engineHandler(readEngine, { name: "my-server" }, readBridge);
    const deleted = ask(handle, "DELETE", "kuvo/bots/bot_quill00001");
    await deleting;
    // As the box starts again, its engine answering: what that delete hadn't done yet goes.
    engine.hold = () => false;
    const before = engine.asked.length;
    await link.finishDeletes(readEngine, readBridge);
    assert.ok(engine.asked.slice(before).some(each => each.method === "DELETE" && each.url === "/api/session/ses_bot_quill00001"), "its conversation goes");
    for (const release of engine.held) release();
    assert.equal((await deleted).status, 200);
    // And nothing's left to do.
    const asked = engine.asked.length;
    await link.finishDeletes(readEngine, readBridge);
    assert.equal(engine.asked.length, asked);
  } finally {
    engine.close();
  }
});

test("a machine makes bots with its own words, whatever a Mac's kit says, filled in for where it runs, with what's its own from its Mac", async () => {
  // Its own name and clock, with no Mac's kit.
  const own = await makingEngine();
  try {
    const handle = link.engineHandler(() => ({ port: own.port, password: "p" }), { name: "my-server" }, () => null);
    assert.equal((await ask(handle, "GET", "kuvo/bots/templates")).status, 200, "New Bot works there");
    const made = await ask(handle, "POST", "kuvo/bots", { name: "Scout", model: { id: "big-pickle", providerID: "opencode" } });
    assert.equal(made.status, 201, made.text);
    const told = own.asked.find(each => each.method === "PUT" && each.url.endsWith("/instructions/entries/kuvo.bot")).body.value;
    assert.match(told, new RegExp(`^You are Scout, one of the user's bots\\.`));
    assert.equal(fs.readFileSync(path.join(bots, made.json.bot.id, "timezone"), "utf8"), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally {
    own.close();
  }

  // An older Mac's kit, with its own words: the machine's words still, filled in with the name the
  // Mac calls it, and the Mac's time zone, projects and the personalities you made; not its rules,
  // which the machine makes from its own default.
  const custom = { id: "custom.calm", name: "Calm", description: "Calm.", custom: true, instruction: "Your personality: Calm." };
  write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, version: "0.8.0", machine: "lab", personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", custom: false, instruction: "Older." }, custom],
    instructions: "Older words.", jobInstructions: "Older words: ⟦job⟧.", personalityWords: "Older." }));
  const kitNow = link.readKit();
  assert.equal(link.botInstructions(kitNow, "Scout", "/f", undefined, undefined), "You are Scout, one of the user's bots.\n\nMemory: the file \"/f/MEMORY.md\" is yours.\n\nWho sets what.");
  assert.equal(kitNow.timeZone, "Europe/Istanbul");
  assert.deepEqual(kitNow.projects, kit.projects);
  assert.equal("rules" in kitNow, false);
  assert.deepEqual(link.botPersonalities(kitNow).map(each => [each.id, each.instruction]), [["preset.straight", "Your personality: Straight Shooter. Direct."], ["custom.calm", "Your personality: Calm."]]);

  // Without its words (a box that's lost them), New Bot says what to do.
  const file = path.join(home, "bin", "bot-words.json");
  fs.renameSync(file, file + ".kept");
  try {
    const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" });
    for (const [method, route] of [["POST", "kuvo/bots"], ["GET", "kuvo/bots/templates"]]) {
      const refused = await ask(handle, method, route);
      assert.equal(refused.status, 409, route);
      assert.equal(refused.json.message, "Connect to this machine from your Mac once, then try again.");
    }
  } finally {
    fs.renameSync(file + ".kept", file);
  }
});

test("a bot on a machine is told, in Kuvo Code's own words, that it runs on that machine, in your time zone, with a browser there that keeps working with Kuvo Code closed", () => {
  const file = path.join(home, "bin", "bot-words.json");
  fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), file);
  try {
    write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, machine: "lab" }));
    const kitNow = link.readKit("linux");
    const told = link.botInstructions(kitNow, "Scout", "/home/me/.kuvo-code/bots/bot_scout00001", "Your personality: Calm.", undefined);
    assert.match(told, /^You are Scout, one of the user's bots in Kuvo Code\. .* You run on the Linux machine "lab"\./);
    // The same box on a Mac (a Mac added as a machine) names itself a Mac, and says nothing of Linux or of "the user's Mac".
    const onMac = link.botInstructions(link.readKit("darwin"), "Scout", "/Users/me/.kuvo-code/bots/bot_scout00001", undefined, undefined);
    assert.match(onMac, /You run on the Mac machine "lab"\./);
    assert.doesNotMatch(onMac, /Linux|user's Mac is off/);
    // A system the words don't name is a machine.
    assert.match(link.botInstructions(link.readKit("win32"), "Scout", "/f", undefined, undefined), /You run on the machine "lab"\./);
    assert.match(told, /a time like 2026-10-16T09:00 in the user's time zone, Europe\/Istanbul,/);
    assert.match(told, /keeps working when Kuvo Code isn't open on the user's own computer/);
    assert.match(told, /\n\nYour personality: Calm\.\n\n/);
    assert.match(told, /You don't have a job yet/);
    assert.match(told, /the file "\/home\/me\/\.kuvo-code\/bots\/bot_scout00001\/MEMORY\.md" is yours/);
    assert.doesNotMatch(told, /⟦|this Mac's clock/, "nothing left to fill in, nothing of a Mac's");
    // With its job: in a few words beside its name, and whole.
    const working = link.botInstructions(kitNow, "Scout", "/f", undefined, undefined, { line: "Keeps CI green", section: "Watch main." });
    assert.match(working, /^You are Scout, one of the user's bots in Kuvo Code: Keeps CI green\. /);
    assert.match(working, /\n\nYour job:\nWatch main\.\n\n/);
    assert.doesNotMatch(working, /You don't have a job yet/);
  } finally {
    write(file, JSON.stringify(words));
  }
});

// How a conversation's rules are made again from its approval and Settings › Permissions, as the Mac
// made them before its box did (written by an earlier Mac's RouteContractTests, kept as they were),
// which a box does the same way for a bot that moves to it.
const approval = JSON.parse(fs.readFileSync(new URL("../../Vectors/routes/box/approval.json", import.meta.url), "utf8"));
// What Ask First asks about, before Settings' own rules, as the Mac has it.
const askFirst = approval.find(each => each.name === "asks first; no settings").current.filter(rule => rule.action !== "external_directory");

test("a bot's rules are made again from its approval and a computer's Settings › Permissions as the Mac makes them", () => {
  assert.ok(approval.length >= 12);
  for (const each of approval) assert.deepEqual(link.refreshedRules(each.current, each.settings), each.refreshed, each.name);
});
const macFolder = "/Users/me/Library/Application Support/run.kuvo.code/bots/bot_moved00001";

test("a bot brought here from your Mac is made this machine's: its folder there, your time zone and its rules, its rules from this machine's Settings › Permissions, and told it runs on the machine", async () => {
  // Your time zone and its rules, as your Mac gave them, for a machine without zone files.
  write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, zoneinfo: Buffer.from("TZif Istanbul").toString("base64") }));
  // This machine asks before a push, and never touches secrets.
  write(path.join(home, "box", "opencode.json"), JSON.stringify({ permissions: [{ action: "shell", resource: "git push *", effect: "ask" }, { action: "edit", resource: "secrets/*", effect: "deny" }] }));
  const folder = bot("bot_moved00001");
  write(path.join(folder, "directory"), `${macFolder}/workspace`);
  // It asked first on your Mac, which let pushes through, with a folder of its own and its folder there.
  const engine = await makingEngine(["opencode"], { ses_bot_moved00001: [
    ...askFirst,
    { action: "shell", resource: "git push *", effect: "allow" },
    { action: "external_directory", resource: "/Users/me/notes/*", effect: "allow" },
    { action: "external_directory", resource: `${macFolder}/*`, effect: "allow" },
  ] });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    // As your Mac says it, which the machine's own kit has anyway.
    const arrived = await ask(handle, "POST", "kuvo/bots/bot_moved00001/arrived", { timeZone: "Europe/Istanbul" });
    assert.equal(arrived.status, 200, arrived.text);
    assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), path.join(folder, "workspace"));
    assert.equal(fs.readFileSync(path.join(folder, "timezone"), "utf8"), "Europe/Istanbul", "your time zone, which its wake-ups go by");
    assert.equal(fs.readFileSync(path.join(folder, "zoneinfo"), "utf8"), "TZif Istanbul", "and its rules, for a machine without zone files");
    assert.deepEqual(engine.asked.filter(each => each.method === "PATCH" && each.body?.permissions).at(-1)?.body.permissions, [
      ...askFirst,
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "edit", resource: "secrets/*", effect: "deny" },
      { action: "external_directory", resource: "/Users/me/notes/*", effect: "allow" },
      { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" },
    ]);
    assert.ok(engine.asked.some(each => each.method === "PUT" && each.url === "/api/experimental/session/ses_bot_moved00001/instructions/entries/kuvo.bot"));
  } finally {
    engine.close();
    fs.rmSync(path.join(home, "box", "opencode.json"), { force: true });
  }
});

test("a rule a newer engine set in this machine's Settings › Permissions (one this box doesn't know) is kept, and keeps every Don't Allow in a bot's rules", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, zoneinfo: Buffer.from("TZif Istanbul").toString("base64") }));
  write(path.join(home, "box", "opencode.json"), JSON.stringify({ permissions: [{ action: "shell", resource: "rm *", effect: "deny-forever" }, { action: "edit", resource: "secrets/*", effect: "deny" }] }));
  const folder = bot("bot_moved00001");
  write(path.join(folder, "directory"), `${macFolder}/workspace`);
  const engine = await makingEngine(["opencode"], { ses_bot_moved00001: [...askFirst, { action: "external_directory", resource: `${macFolder}/*`, effect: "allow" }] });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    assert.equal((await ask(handle, "POST", "kuvo/bots/bot_moved00001/arrived", { timeZone: "Europe/Istanbul" })).status, 200);
    assert.deepEqual(engine.asked.filter(each => each.method === "PATCH" && each.body?.permissions).at(-1)?.body.permissions, [
      ...askFirst,
      { action: "shell", resource: "rm *", effect: "deny-forever" },
      { action: "edit", resource: "secrets/*", effect: "deny" },
      { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" },
    ]);
  } finally {
    engine.close();
    fs.rmSync(path.join(home, "box", "opencode.json"), { force: true });
  }
});

test("a bot brought here before this machine's settings are its own keeps the rules it runs with, its folder made this machine's", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  fs.rmSync(path.join(home, "box", "opencode.json"), { force: true });
  const folder = bot("bot_moved00001");
  write(path.join(folder, "directory"), `${macFolder}/workspace`);
  const engine = await makingEngine(["opencode"], { ses_bot_moved00001: [
    ...askFirst,
    { action: "shell", resource: "rm -rf *", effect: "deny" },
    { action: "external_directory", resource: `${macFolder}/*`, effect: "allow" },
  ] });
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    assert.equal((await ask(handle, "POST", "kuvo/bots/bot_moved00001/arrived")).status, 200);
    assert.deepEqual(engine.asked.filter(each => each.method === "PATCH" && each.body?.permissions).at(-1)?.body.permissions, [
      ...askFirst, { action: "shell", resource: "rm -rf *", effect: "deny" },
      { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" },
    ]);
  } finally {
    engine.close();
  }
});

test("a bot brought here while this machine has no words yet works in its folder here, by your clock, and is told the rest once it can be", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_moved00001");
  write(path.join(folder, "directory"), `${macFolder}/workspace`);
  const file = path.join(home, "bin", "bot-words.json");
  fs.renameSync(file, file + ".kept");
  try {
    const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" }, () => null);
    assert.equal((await ask(handle, "POST", "kuvo/bots/bot_moved00001/arrived")).status, 409);
    assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), path.join(folder, "workspace"), "its wake-ups start in its folder here");
    assert.equal(fs.readFileSync(path.join(folder, "timezone"), "utf8"), "Europe/Istanbul");
  } finally {
    fs.renameSync(file + ".kept", file);
  }
});

test("a bot brought here while the engine isn't running is made this machine's at its next run", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_moved00001");
  write(path.join(folder, "directory"), `${macFolder}/workspace`);
  write(path.join(folder, "told.json"), JSON.stringify({ session: "ses_bot_moved00001", instructions: "on the Mac", rules: macFolder }));
  const down = link.engineHandler(() => { throw new Error("not running"); }, { name: "my-server" }, () => null);
  const arrived = await ask(down, "POST", "kuvo/bots/bot_moved00001/arrived");
  assert.equal(arrived.status, 503);
  assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), path.join(folder, "workspace"));
  const engine = await makingEngine(["opencode"], { ses_bot_moved00001: [{ action: "external_directory", resource: `${macFolder}/*`, effect: "allow" }] });
  try {
    await link.freshenBot({ port: engine.port, password: "p" }, "ses_bot_moved00001");
    assert.match(engine.asked.find(each => each.method === "PUT" && each.url.endsWith("/instructions/entries/kuvo.bot"))?.body.value ?? "", /^You are Scout/);
    assert.deepEqual(engine.asked.filter(each => each.method === "PATCH" && each.body?.permissions).at(-1)?.body.permissions, [{ action: "external_directory", resource: path.join(folder, "*"), effect: "allow" }]);
  } finally {
    engine.close();
  }
});
