// A machine's bots and wake-ups, answered by its bridge from their folders as the Mac answers for
// them (PROTOCOL.md, `kuvo/bots` and `kuvo/wakes`). Run with
// `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

// The bridge reads Kuvo Code's folder from KUVO_HOME: one of this test's own.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-bots-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
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
async function ask(handle, method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json, text };
}

// An engine (or the agents' bridge) on a free port: its tools connected, prompts taken.
async function fakeEngine() {
  const asked = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      asked.push({ method: request.method, url: request.url, auth: request.headers.authorization, directory: request.headers["x-opencode-directory"], body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url === "/api/mcp" ? JSON.stringify({ browser: { status: { status: "connected" } } }) : "{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { asked, port: server.address().port, close: () => { server.closeAllConnections(); server.close(); } };
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
    job: "Watches the build", paused: true, wakes: 1792000100, watching: 1, agents: true, model: { id: "big-pickle", providerID: "opencode" },
  });
  assert.equal("personality" in answer.json.bots[1], false, "none: left out, as the Mac leaves it out");
  assert.equal("wakes" in answer.json.bots[0], false, "none waiting: left out, as the Mac leaves it out");
  // Before the Mac ever gave it what New Bot needs, it says so.
  for (const [method, route] of [["POST", "kuvo/bots"], ["GET", "kuvo/bots/templates"]]) {
    const refused = await ask(handle, method, route);
    assert.equal(refused.status, 409, route);
    assert.equal(refused.json.message, "Connect to this machine from your Mac once, then try again.");
  }
  assert.equal((await ask(handle, "PUT", "kuvo/bots")).status, 405);
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

  // All at once, for the marks beside them: each session's soonest and whether it watches; bots' come with kuvo/bots.
  const watching = path.join(home, "wakes", "ses_watch");
  write(path.join(watching, "session"), "ses_watch");
  write(path.join(watching, "watches", "Ww2", "check"), "test -f done");
  write(path.join(path.join(home, "wakes", "ses_none"), "session"), "ses_none");
  const all = await ask(handle, "GET", "kuvo/wakes");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.sessions.sort((a, b) => a.session.localeCompare(b.session)), [
    { session: "ses_plain", next: 1792000900, watching: false },
    { session: "ses_watch", watching: true },
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

  write(path.join(home, "run", "bridge.json"), JSON.stringify({ pid: process.pid, port: bridge.port, password: "agents" }));
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

// What New Bot needs, as the Mac leaves it on the machine as it connects (Bots.MachineKit).
const kit = {
  kuvo: 1,
  templates: [{ id: "news", name: "Herald", job: "Sends you a morning news digest", instructions: "Every morning…", look: { color: "sky", shape: "round", face: "happy" }, personality: "preset.straight", wantsProject: false, firstMessage: "Your job, in a few words: Sends you a morning news digest." }],
  personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", custom: false, instruction: "Your personality: Straight Shooter. Direct." }],
  looks: { colors: ["mint", "sky"], shapes: ["round"], faces: ["calm", "happy"] },
  startingModel: { id: "big-pickle", providerID: "opencode" },
  projects: [{ directory: "/home/me/app", name: "app" }],
  instructions: "You are ⟦name⟧, one of the user's bots.\n\n⟦personality⟧\n\nMemory: the file \"⟦folder⟧/MEMORY.md\" is yours.\n\nWho sets what.",
  projectNote: "You work in one of the user's projects.",
  identityNote: "Who sets what.",
  memory: "# ⟦name⟧'s memory\n",
  greeting: "<system-reminder>Write first.</system-reminder>",
  rules: [{ action: "edit", resource: "*", effect: "ask" }],
  timeZone: "Europe/Istanbul",
};

// An engine and the agents' bridge as a new bot and a new chat need them: conversations made,
// what each was told, its greeting; the providers ready; group chats put and listed.
async function makingEngine(ready = ["opencode"]) {
  const asked = [];
  const chats = new Map();
  let next = 1;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const given = body ? JSON.parse(body) : undefined;
      asked.push({ method: request.method, url: request.url, body: given });
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && request.url === "/api/provider") return reply({ data: ready.map(id => ({ id })) });
      if (request.method === "POST" && request.url === "/api/session") return reply({ data: { id: `ses_made${next++}` } });
      if (request.method === "PUT" && request.url.startsWith("/api/kuvo/groups/")) {
        chats.set(given.group.id, given);
        return reply({ data: given });
      }
      if (request.method === "GET" && request.url === "/api/kuvo/groups") return reply({ data: [...chats.values()].map(chat => ({ group: chat.group, status: chat.status, state: {} })) });
      // As the agents bridge plans a meeting: here, one at a time to come, kept as given.
      if (request.method === "PATCH" && request.url.startsWith("/api/kuvo/groups/")) {
        const chat = chats.get(request.url.split("/").pop());
        if (!chat) return reply({ message: "No such chat." }, 404);
        const { meetingPlan, ...edits } = given;
        if (meetingPlan !== undefined) {
          if (meetingPlan !== null && meetingPlan.next * 1000 <= Date.now()) return reply({ message: "That time has passed. Pick one to come." }, 400);
          edits.meeting = meetingPlan === null ? undefined : { next: new Date(meetingPlan.next * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), topic: meetingPlan.topic || "Our regular meeting", ...(meetingPlan.every ? { every: meetingPlan.every } : {}) };
        }
        Object.assign(chat.group, edits);
        if (edits.purpose === null) delete chat.group.purpose;
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
  return { asked, port: server.address().port, password: "p", close: () => { server.closeAllConnections(); server.close(); } };
}

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
    assert.deepEqual(session.body.permissions, [...kit.rules, { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" }]);
    const told = engine.asked.find(each => each.url === "/api/experimental/session/ses_made1/instructions/entries/kuvo.bot").body.value;
    assert.equal(told, `You are Inbox Helper, one of the user's bots.\n\nYour personality: Straight Shooter. Direct.\n\nMemory: the file "${folder}/MEMORY.md" is yours.\n\nYou work in one of the user's projects.\n\nWho sets what.`);
    assert.deepEqual(engine.asked.find(each => each.method === "PATCH").body, { metadata: { kuvo: { bot: listed.id } } });
    assert.equal(engine.asked.find(each => each.url === "/api/session/ses_made1/synthetic").body.text, kit.greeting, "it writes first");
    assert.ok((await ask(handle, "GET", "kuvo/bots")).json.bots.some(each => each.id === listed.id), "listed at once");

    // From a template: its look and personality, and its job for your composer; it waits for you.
    const herald = await ask(handle, "POST", "kuvo/bots", { name: "Herald", template: "news" });
    assert.equal(herald.status, 201);
    assert.equal(herald.json.firstMessage, kit.templates[0].firstMessage);
    assert.equal(engine.asked.some(each => each.url === `/api/session/${herald.json.bot.session}/synthetic`), false);
    assert.deepEqual(herald.json.bot.look, kit.templates[0].look);
    const plain = engine.asked.find(each => each.url === `/api/experimental/session/${herald.json.bot.session}/instructions/entries/kuvo.bot`).body.value;
    assert.ok(plain.includes("Straight Shooter") && !plain.includes("⟦") && !plain.includes("projects"));
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

test("with the Mac closed, a group chat of this machine's bots is made here and listed", async () => {
  bot("bot_ada0000001", { name: "Ada" });
  bot("bot_ben0000001", { name: "Ben" });
  const agents = await makingEngine();
  try {
    const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" }, () => ({ port: agents.port, password: "p", pid: process.pid }));
    const made = await ask(handle, "POST", "kuvo/groups", { name: "Release", members: ["bot_ada0000001", "bot_ben0000001", "bot_ada0000001"], purpose: "  Ship it  " });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.match(made.json.group.id, /^grp_[a-z0-9]{10}$/);
    assert.equal(made.json.group.name, "Release");
    assert.equal(made.json.group.purpose, "Ship it");
    assert.deepEqual(made.json.group.members.map(member => member.id), ["bot_ada0000001", "bot_ben0000001"]);
    const put = agents.asked.find(each => each.method === "PUT");
    assert.equal(put.body.status, "active");
    assert.deepEqual(put.body.messages, []);
    assert.equal((await ask(handle, "POST", "kuvo/groups", { name: "Solo", members: ["bot_ada0000001"] })).status, 400);
    const unknown = await ask(handle, "POST", "kuvo/groups", { name: "Who", members: ["bot_ada0000001", "bot_gone000001"] });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.message, "There’s no bot “bot_gone000001”.");
  } finally {
    agents.close();
  }
});

test("with the Mac closed, a group chat's meeting is set up here, by the bridge that runs it, and the chat changed from a phone", async () => {
  bot("bot_ada0000001", { name: "Ada" });
  bot("bot_ben0000001", { name: "Ben" });
  const agents = await makingEngine();
  try {
    const handle = link.engineHandler(() => { throw new Error("not needed"); }, { name: "my-server" }, () => ({ port: agents.port, password: "p", pid: process.pid }));
    const nextWeek = Math.round(Date.now() / 1000) + 86_400 * 7;
    const made = await ask(handle, "POST", "kuvo/groups", { name: "Standup", members: ["bot_ada0000001", "bot_ben0000001"], meeting: { next: nextWeek, every: "1w", topic: "Weekly" } });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.group.id;
    assert.deepEqual(agents.asked.find(each => each.method === "PATCH").body, { meetingPlan: { next: nextWeek, every: "1w", topic: "Weekly" } });
    // One the bridge says can't be: the chat doesn't stay either.
    const late = await ask(handle, "POST", "kuvo/groups", { name: "Late", members: ["bot_ada0000001", "bot_ben0000001"], meeting: { next: 1000 } });
    assert.equal(late.status, 400);
    assert.equal(late.json.message, "That time has passed. Pick one to come.");
    assert.ok(agents.asked.some(each => each.method === "DELETE"));

    const changed = await ask(handle, "PATCH", `kuvo/groups/${id}`, { name: " Daily ", purpose: "", meeting: null });
    assert.equal(changed.status, 200, JSON.stringify(changed.json));
    assert.equal(changed.json.group.name, "Daily");
    assert.deepEqual(agents.asked.filter(each => each.method === "PATCH").at(-1).body, { name: "Daily", purpose: null, meetingPlan: null });
    assert.equal((await ask(handle, "PATCH", `kuvo/groups/${id}`, { members: ["bot_ada0000001"] })).status, 400);
    assert.equal((await ask(handle, "PATCH", `kuvo/groups/${id}`, { members: ["bot_ada0000001", "bot_gone000001"] })).status, 404);
    assert.equal((await ask(handle, "PATCH", `kuvo/groups/${id}`, { name: "  " })).status, 400);
    assert.equal((await ask(handle, "PATCH", "kuvo/groups/grp_none000001", { name: "X" })).status, 404);
  } finally {
    agents.close();
  }
});

// The Mac's and the coding agents' bridge's job readers are held to these (Bots.job(inMemory:)).
const groupVectors = JSON.parse(fs.readFileSync(new URL("../../../../Agents/test/groups-vectors.json", import.meta.url), "utf8"));

test("a bot's job is read from its memory as the Mac reads it", () => {
  assert.ok(groupVectors.job.length > 5);
  for (const vector of groupVectors.job) {
    const job = link.jobInMemory(vector.memory);
    assert.deepEqual([job?.line ?? null, job?.section ?? null], [vector.line, vector.section], vector.memory);
  }
});

// The kit as a Mac with words for a bot that has a job gives it (Bots.MachineKit.jobInstructions).
const jobKit = {
  ...kit,
  jobInstructions: "You are ⟦name⟧, one of the user's bots: ⟦job⟧.\n\n⟦personality⟧\n\nYour job, as your memory has it:\n⟦jobDetails⟧\n\nMemory: the file \"⟦folder⟧/MEMORY.md\" is yours.\n\nWho sets what.",
};

// What a phone's change asked of the conversation, by what it did there.
const told = (asked, session) => ({
  title: asked.find(each => each.method === "PATCH" && each.url === `/api/session/${session}`)?.body?.title,
  model: asked.find(each => each.method === "POST" && each.url === `/api/session/${session}/model`)?.body?.model,
  instructions: asked.find(each => each.method === "PUT" && each.url === `/api/experimental/session/${session}/instructions/entries/kuvo.bot`)?.body?.value,
});

test("with the Mac closed, a bot here is changed from a phone as Edit Bot changes it, and its conversation told", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(jobKit));
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
      job: "Watches the build", paused: false, wakes: undefined, watching: 0, agents: false, personality: "preset.straight", model: { id: "opus", providerID: "anthropic", variant: "high" },
    });
    // Its description, for what runs here and for the Mac as it next connects: newer than before.
    const described = JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8"));
    assert.equal(described.name, "Scout Prime");
    assert.equal(described.personality, "preset.straight");
    assert.equal(described.created, before.created);
    assert.match(described.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(described.updated > before.updated);
    // Its conversation: its title, its model, and what it's told, with its job as its memory has it.
    assert.deepEqual(told(engine.asked, "ses_bot_scout00001"), {
      title: "Scout Prime", model: { id: "opus", providerID: "anthropic", variant: "high" },
      instructions: `You are Scout Prime, one of the user's bots: Watches the build.\n\nYour personality: Straight Shooter. Direct.\n\nYour job, as your memory has it:\nWatches the build.\nTells you when it breaks.\n\nMemory: the file "${folder}/MEMORY.md" is yours.\n\nWho sets what.`,
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

test("a change that can't be is said, and nothing changes", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(jobKit));
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
      [{ model: { id: "sonnet", providerID: "claude-code" } }, 422, "Its conversation runs on this machine’s engine, and only your Mac can carry it on with the coding agents: choose another model, or change it on your Mac."],
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

test("a bot with a job, changed where the Mac's kit has no words for one, is told its name later", async () => {
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  const folder = bot("bot_scout00001");
  write(path.join(folder, "MEMORY.md"), "## Job\nWatches the build\n");
  const engine = await makingEngine();
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => null);
    assert.equal((await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Scout Prime" })).status, 200);
    const asked = told(engine.asked, "ses_bot_scout00001");
    assert.equal(asked.title, "Scout Prime");
    assert.equal(asked.instructions, undefined, "not told it has no job: the Mac tells it as it next connects");
  } finally {
    engine.close();
  }
});

test("with the Mac closed, a bot here is deleted from a phone as Delete Bot… deletes it, and noted for the Mac", async () => {
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
  try {
    const handle = link.engineHandler(() => ({ port: engine.port, password: "p" }), { name: "my-server" }, () => ({ port: engine.port, password: "p", pid: process.pid }));
    const chat = await ask(handle, "POST", "kuvo/groups", { name: "Release", members: ["bot_scout00001", "bot_ada0000001", "bot_ben0000001"] });
    assert.equal(chat.status, 201);

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
