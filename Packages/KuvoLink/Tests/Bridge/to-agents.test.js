// A conversation on a machine carried on with its coding agents, as picking one of their models
// in it does, by the machine itself with the Mac closed (PROTOCOL.md, `kuvo/sessions/<id>/agents`):
// the whole conversation and what was waiting go to a session of theirs, the engine's is archived,
// and a bot's conversation becomes the new one. The engine and the agents' bridge are stand-ins.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runningAs } from "./running-as.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-to-agents-"));
process.env.KUVO_HOME = home;
removeAtEnd(home);
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// A stand-in on a free port: `answer(method, path, body)` gives `[status, value]`; what was asked is kept.
async function standIn(answer) {
  const asked = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const given = body ? JSON.parse(body) : undefined;
      asked.push({ method: request.method, url: request.url, body: given });
      const [status, value] = answer(request.method, request.url, given) ?? [404, { message: "No." }];
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  atEnd(() => { server.closeAllConnections(); server.close(); });
  return { asked, at: { port: server.address().port, password: "p" } };
}

// 250 messages, two pages, the newest first as the engine pages them; a message waiting with a file.
const conversation = Array.from({ length: 250 }, (_, at) => ({ id: `msg_${String(at).padStart(4, "0")}`, type: at % 2 ? "assistant" : "user", text: `${at}` }));
function engineFor(session, { running = false } = {}) {
  return standIn((method, url, body) => {
    const base = `/api/session/${session.id}`;
    if (method === "PATCH" && url === base) session.metadata = { ...(session.metadata ?? {}), ...(body?.metadata ?? {}) };
    if (method === "GET" && url === base) return [200, { data: session }];
    if (method === "GET" && url === "/api/session/active") return [200, { data: running ? { [session.id]: {} } : {} }];
    if (method === "GET" && url === `${base}/message?limit=200&order=desc`) return [200, { data: conversation.slice(50).reverse(), cursor: { next: "older" } }];
    if (method === "GET" && url === `${base}/message?limit=200&cursor=older`) return [200, { data: conversation.slice(0, 50).reverse(), cursor: {} }];
    if (method === "GET" && url === `${base}/inbox`) return [200, { data: [{ id: "inb_1", type: "user", text: "And the tests too", payload: { files: [{ name: "log.txt", mime: "text/plain", data: "aGk=" }] } }, { id: "inb_2", type: "system" }] }];
    if (["POST", "DELETE", "PATCH"].includes(method)) return [200, {}];
  });
}
const agentsBridge = ({ signedIn = true, id = "ses_theirs" } = {}) => standIn((method, url, body) => {
  if (method === "GET" && url === "/api/integration/claude-code") return [200, { data: { id: "claude-code", name: "Claude Code", metadata: { installed: true }, connections: signedIn ? [{ type: "agent" }] : [] } }];
  if (method === "POST" && url === "/api/session/import") return [200, { data: { id, title: body.title } }];
  if (["PUT", "PATCH"].includes(method)) return [200, {}];
});
const sonnet = { id: "sonnet", providerID: "claude-code" };

test("a conversation goes on with the coding agents whole, with what was waiting, and the engine's is archived", async () => {
  const project = path.join(home, "shop");
  const engine = await engineFor({ id: "ses_fix", title: "Fix the total", agent: "build", location: { directory: project }, permissions: [{ action: "edit", resource: "*", effect: "allow" }], metadata: { pinned: true } }, { running: true });
  const agents = await agentsBridge();
  const handle = link.engineHandler(() => engine.at, { name: "lab" }, () => null);
  // A daily wake-up it has goes with it.
  const wakes = path.join(home, "wakes");
  write(path.join(wakes, "ses_fix", "session"), "ses_fix");
  write(path.join(wakes, "ses_fix", "wakes", "1900000000-abc-1d"), "Check the build");
  const moved = await link.carryToAgents("ses_fix", sonnet, () => engine.at, agents.at, undefined);
  assert.deepEqual(moved, { status: 200, value: { session: "ses_theirs" } });
  assert.equal(fs.existsSync(path.join(wakes, "ses_fix")), false);
  assert.equal(fs.readFileSync(path.join(wakes, "ses_theirs", "session"), "utf8"), "ses_theirs");
  assert.equal(fs.readFileSync(path.join(wakes, "ses_theirs", "via"), "utf8"), "bridge");
  assert.equal(link.readWakes(path.join(wakes, "ses_theirs")).wakes[0].note, "Check the build");
  // Carried on already: not again.
  assert.equal((await link.carryToAgents("ses_fix", sonnet, () => engine.at, agents.at, undefined)).status, 409);
  const imported = agents.asked.find(each => each.url === "/api/session/import").body;
  assert.equal(imported.title, "Fix the total");
  assert.deepEqual(imported.model, sonnet);
  assert.deepEqual(imported.location, { directory: project });
  assert.deepEqual(imported.permissions, [{ action: "edit", resource: "*", effect: "allow" }]);
  assert.deepEqual(imported.messages.map(message => message.id), conversation.map(message => message.id), "all of it, oldest first");
  assert.equal(imported.waiting.length, 1);
  assert.equal(imported.waiting[0].text, "And the tests too");
  assert.deepEqual(imported.waiting[0].files, [{ uri: "data:text/plain;base64,aGk=", name: "log.txt" }]);
  // Stopped first; what waited taken from the engine; the engine's archived, the rest of its metadata kept.
  const urls = engine.asked.map(each => `${each.method} ${each.url}`);
  assert.ok(urls.indexOf("POST /api/session/ses_fix/interrupt") < urls.indexOf("GET /api/session/ses_fix/message?limit=200&order=desc"));
  assert.ok(urls.includes("DELETE /api/session/ses_fix/inbox/inb_1"));
  assert.deepEqual(engine.asked.find(each => each.method === "PATCH").body, { metadata: { pinned: true, "kuvo.archived": true, "kuvo.carriedTo": "ses_theirs" } });
  // The new one says where it came from, so the files its words show stay as that one's deleted.
  assert.deepEqual(agents.asked.find(each => each.method === "PATCH" && each.url === "/api/session/ses_theirs").body, { metadata: { kuvo: { carriedFrom: "ses_fix" } } });
  // From a phone, the same.
  assert.equal((await (async () => {
    const parts = [];
    for await (const part of handle({ method: "GET", path: "kuvo/sessions/ses_fix/agents", headers: {}, body: Buffer.alloc(0) }, {}, undefined)) parts.push(part);
    return parts[0].head.status;
  })()), 405);
});

test("a conversation you stopped stays stopped as it goes on with the coding agents: what waited on the box waits there for Resume", async () => {
  const engine = await engineFor({ id: "ses_stopped", title: "Ship it", agent: "build", location: { directory: home } });
  const agents = await agentsBridge({ id: "ses_carried" });
  const handle = link.engineHandler(() => engine.at, { name: "lab" }, () => agents.at);
  const ask = async (method, route, body) => {
    let text = "";
    for await (const part of handle({ method, path: route, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), fromApp: true }, {}, undefined)) if (part.body) text += part.body.toString();
    return JSON.parse(text);
  };
  assert.equal((await ask("POST", "kuvo/sessions/ses_stopped/stop")).paused, true);
  // Another agent's letter, waiting on the box.
  const letter = link.messageID();
  assert.equal((await ask("POST", "kuvo/sessions/ses_stopped/queue/add", { id: letter, text: "[Letter] The build is green.", from: "Ada", words: "The build is green.", kept: true })).waits, true);

  assert.equal((await link.carryToAgents("ses_stopped", sonnet, () => engine.at, agents.at, undefined)).status, 200);
  const carried = link.queueOf("ses_carried");
  assert.equal(carried.paused, true, "still stopped");
  assert.deepEqual(carried.waiting?.map(each => [each.from, each.text]), [["Ada", "The build is green."]], "what waited goes with it");
  assert.equal(link.queueOf("ses_stopped").waiting, undefined, "nothing left for the conversation it was");
  assert.equal(agents.asked.filter(each => each.url.endsWith("/prompt")).length, 0, "nothing sent to the agents yet");
  assert.equal(engine.asked.filter(each => each.url.endsWith("/prompt")).length, 0);
});

test("a bot's conversation becomes the new one, marked and told as its own, and the engine's goes", async t => {
  write(path.join(home, "bots", "kit.json"), JSON.stringify({ kuvo: 1, personalities: [], startingModel: sonnet, projects: [], rules: [], timeZone: "UTC" }));
  write(path.join(home, "bin", "bot-words.json"), JSON.stringify({
    kuvo: 1, templates: [], personalities: [], looks: { colors: [], shapes: [], faces: [] }, here: { mac: {}, machine: {} },
    instructions: ["You are ⟦name⟧, one of the user's bots⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧", "Memory: \"⟦folder⟧/MEMORY.md\"."], job: { none: "", line: ": ⟦job⟧", details: "⟦jobDetails⟧" },
    personalityWords: "Your personality: ⟦name⟧. ⟦description⟧", projectNote: "", identityNote: "", memory: "", greeting: "",
  }));
  const folder = path.join(home, "bots", "bot_scout00001");
  write(path.join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: {}, model: { id: "big-pickle", providerID: "opencode" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }));
  write(path.join(folder, "session"), "ses_scout");
  write(path.join(folder, "MEMORY.md"), "# Scout's memory\n");
  const engine = await engineFor({ id: "ses_scout", title: "Scout", agent: "build", location: { directory: path.join(folder, "workspace") }, metadata: { kuvo: { bot: "bot_scout00001" } } });
  const agents = await agentsBridge();
  // As Edit Bot changes its model from a phone: its conversation goes on with the agents.
  // (Its record names a process that runs as it: a stand-in.)
  const pid = await runningAs("kuvo-agents", t);
  const handle = link.engineHandler(() => engine.at, { name: "lab" }, () => ({ ...agents.at, pid }));
  const parts = [];
  for await (const part of handle({ method: "PATCH", path: "kuvo/bots/bot_scout00001", headers: {}, body: Buffer.from(JSON.stringify({ model: sonnet })) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200, Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString());
  assert.equal(fs.readFileSync(path.join(folder, "session"), "utf8"), "ses_theirs");
  assert.equal(fs.readFileSync(path.join(folder, "via"), "utf8"), "bridge");
  assert.deepEqual(agents.asked.find(each => each.method === "PATCH" && each.url === "/api/session/ses_theirs").body, { metadata: { kuvo: { bot: "bot_scout00001", carriedFrom: "ses_scout" } } });
  assert.match(agents.asked.find(each => each.url.endsWith("/instructions/entries/kuvo.bot")).body.value, /^You are Scout, one of the user's bots\./);
  assert.ok(engine.asked.some(each => each.method === "DELETE" && each.url === "/api/session/ses_scout"), "the engine's goes");
  assert.equal(engine.asked.some(each => each.method === "PATCH"), false, "not archived: it's gone");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).model, sonnet);
});

test("a conversation on Autopilot stays on it with the coding agents, its agent told, and a bot's too", async () => {
  const project = path.join(home, "pilot");
  const engine = await engineFor({ id: "ses_pilot", title: "Cafe", agent: "build", location: { directory: project }, metadata: { kuvo: { approval: "auto", autopilot: true } } });
  const agents = await agentsBridge();
  assert.deepEqual(await link.carryToAgents("ses_pilot", sonnet, () => engine.at, agents.at, undefined), { status: 200, value: { session: "ses_theirs" } });
  assert.equal(agents.asked.find(each => each.method === "PATCH" && each.url === "/api/session/ses_theirs").body.metadata.kuvo.autopilot, true);
  assert.match(agents.asked.find(each => each.method === "PUT" && each.url.endsWith("/instructions/entries/kuvo.autopilot")).body.value, /Autopilot/);

  // One that isn't: not told.
  const plain = await engineFor({ id: "ses_plain", title: "Plain", agent: "build", location: { directory: project }, metadata: {} });
  const others = await agentsBridge({ id: "ses_theirs2" });
  await link.carryToAgents("ses_plain", sonnet, () => plain.at, others.at, undefined);
  assert.equal(others.asked.some(each => each.url.endsWith("/instructions/entries/kuvo.autopilot")), false);
});

test("what can't be is said, and nothing moves", async () => {
  const engine = await engineFor({ id: "ses_mine", title: "Mine", location: { directory: home } });
  const signedOut = await agentsBridge({ signedIn: false });
  const tried = async (id, model, agents = signedOut.at) => link.carryToAgents(id, model, () => engine.at, agents, undefined);
  assert.deepEqual(await tried("ses_mine", { id: "gpt", providerID: "openai" }), { status: 400, value: { message: "That isn’t a coding agent’s model." } });
  assert.deepEqual(await tried("ses_mine", sonnet, null), { status: 503, value: { message: "The coding agents aren’t running on this machine." } });
  assert.deepEqual(await tried("ses_mine", sonnet), { status: 422, value: { message: "Claude Code needs a sign-in on this machine: sign in in Settings › Accounts, or choose another model." } });
  assert.equal((await tried("ses_gone", sonnet)).status, 404);
  // On its way to another computer.
  write(path.join(home, "wakes", "ses_mine", "paused"), "moving");
  assert.equal((await link.carryToAgents("ses_mine", sonnet, () => engine.at, (await agentsBridge()).at, undefined)).status, 409);
  assert.equal(signedOut.asked.some(each => each.url === "/api/session/import"), false);
});

test("a move that fails partway leaves no copy with the coding agents, and the conversation as it was, to try again", async () => {
  const project = path.join(home, "atomic");
  const session = { id: "ses_atomic", title: "Atomic", agent: "build", location: { directory: project }, metadata: {} };
  let archiving = false;
  const engine = await standIn((method, url, body) => {
    const base = `/api/session/${session.id}`;
    if (method === "PATCH" && url === base) {
      if (!archiving) return [500, { message: "The database is locked." }];
      session.metadata = { ...(session.metadata ?? {}), ...(body?.metadata ?? {}) };
      return [200, {}];
    }
    if (method === "GET" && url === base) return [200, { data: session }];
    if (method === "GET" && url === "/api/session/active") return [200, { data: {} }];
    if (method === "GET" && url.startsWith(`${base}/message`)) return [200, { data: [{ id: "msg_1", type: "user", text: "Make it atomic" }], cursor: {} }];
    if (method === "GET" && url === `${base}/inbox`) return [200, { data: [{ id: "inb_9", type: "user", text: "And test it" }] }];
    if (["POST", "DELETE"].includes(method)) return [200, {}];
  });
  const made = [];
  const agents = await standIn((method, url, body) => {
    if (method === "GET" && url === "/api/integration/claude-code") return [200, { data: { name: "Claude Code", metadata: { installed: true }, connections: [{ type: "agent" }] } }];
    if (method === "POST" && url === "/api/session/import") {
      const id = `ses_copy${made.length + 1}`;
      made.push(id);
      return [200, { data: { id, title: body.title } }];
    }
    if (["PUT", "PATCH", "DELETE"].includes(method)) return [200, {}];
  });
  const wakes = path.join(home, "wakes", "ses_atomic");
  write(path.join(wakes, "session"), "ses_atomic");

  const failed = await link.carryToAgents("ses_atomic", sonnet, () => engine.at, agents.at);
  assert.deepEqual(failed, { status: 502, value: { message: "The database is locked." } });
  assert.deepEqual(agents.asked.filter(each => each.method === "DELETE").map(each => each.url), ["/api/session/ses_copy1"], "the copy it made goes");
  assert.equal(engine.asked.some(each => each.method === "DELETE"), false, "what waited still waits there");
  assert.equal(session.metadata["kuvo.carriedTo"], undefined, "not marked as carried on");
  assert.equal(fs.readFileSync(path.join(wakes, "session"), "utf8"), "ses_atomic", "its wake-ups stay with it");

  // Tried again once the engine takes it: carried on, once.
  archiving = true;
  assert.deepEqual(await link.carryToAgents("ses_atomic", sonnet, () => engine.at, agents.at), { status: 200, value: { session: "ses_copy2" } });
  assert.equal(session.metadata["kuvo.carriedTo"], "ses_copy2");
  assert.ok(engine.asked.some(each => each.method === "DELETE" && each.url === "/api/session/ses_atomic/inbox/inb_9"));
  assert.equal(agents.asked.filter(each => each.method === "DELETE").length, 1, "the one that's kept stays");
});

test("an import the coding agents fail partway through leaves nothing of it there", async () => {
  const project = path.join(home, "halfway");
  const engine = await engineFor({ id: "ses_half", title: "Half", agent: "build", location: { directory: project }, metadata: {} });
  const there = [{ id: "ses_older", time: { created: 1 }, metadata: { kuvo: { carriedFrom: "ses_half" } } }];
  const agents = await standIn((method, url) => {
    if (method === "GET" && url === "/api/integration/claude-code") return [200, { data: { name: "Claude Code", metadata: { installed: true }, connections: [{ type: "agent" }] } }];
    if (method === "POST" && url === "/api/session/import") {
      // Made, then it failed to say so.
      there.unshift({ id: "ses_half_made", time: { created: Date.now() }, metadata: { kuvo: { carriedFrom: "ses_half" } } }, { id: "ses_other", time: { created: Date.now() }, metadata: {} });
      return [500, { message: "No space left on device." }];
    }
    if (method === "GET" && url.startsWith("/api/session?")) return [200, { data: there }];
    if (method === "DELETE") return [200, {}];
  });
  assert.deepEqual(await link.carryToAgents("ses_half", sonnet, () => engine.at, agents.at), { status: 502, value: { message: "No space left on device." } });
  assert.deepEqual(agents.asked.filter(each => each.method === "DELETE").map(each => each.url), ["/api/session/ses_half_made"], "only what this move made");
  assert.equal(engine.asked.some(each => each.method === "PATCH" || each.method === "DELETE"), false, "the engine's left as it was");
});

test("a conversation in a project of several folders is told of them with the coding agents, as one started there is", async () => {
  const project = path.join(home, "studio");
  write(path.join(home, "box", "projects.json"), JSON.stringify({ version: 1, projects: [{ directory: project, folders: ["/srv/studio-api"] }] }));
  const engine = await engineFor({ id: "ses_studio", title: "Studio", agent: "build", location: { directory: project }, metadata: {} });
  const agents = await agentsBridge({ id: "ses_studio_agent" });
  assert.equal((await link.carryToAgents("ses_studio", sonnet, () => engine.at, agents.at)).status, 200);
  const told = agents.asked.find(each => each.method === "PUT" && each.url === "/api/experimental/session/ses_studio_agent/instructions/entries/kuvo.project-folders");
  assert.match(told?.body?.value ?? "", /primary folder, studio \(.*\/studio\)[\s\S]*- studio-api: \/srv\/studio-api/);
});
