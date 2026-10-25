// This Mac's box answers for this Mac's bots as a machine's does for its own (PROTOCOL.md,
// `kuvo/bots`, "This Mac's box"): it finds them where the app keeps them (KUVO_BOTS), makes them
// with the kit the app gives it, and keeps them told what they are, at their next run, the way a
// machine does with the Mac closed. Only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-mac.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-bots-")));
after(() => fs.rmSync(support, { recursive: true, force: true }));
// As BoxProcess starts it: its folder, and the app's own beside it.
Object.assign(process.env, {
  KUVO_BOX: "mac",
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_WAKE_COMMAND: path.join(support, "bin", "kuvo-wake"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const bots = process.env.KUVO_BOTS;
const home = process.env.KUVO_HOME;

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// What the app gives its own box to make bots with: the words for a bot on this Mac.
const kit = {
  kuvo: 1,
  version: "0.8.0",
  templates: [{ id: "news", name: "Herald", job: "Sends you a morning news digest", instructions: "Every morning…", look: { color: "sky", shape: "round", face: "happy" }, personality: "preset.straight", wantsProject: false, firstMessage: "Your job, in a few words: Sends you a morning news digest." }],
  personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", custom: false, instruction: "Your personality: Straight Shooter. Direct." }],
  looks: { colors: ["mint", "sky"], shapes: ["round"], faces: ["calm", "happy"] },
  startingModel: { id: "big-pickle", providerID: "opencode" },
  projects: [],
  instructions: "You are ⟦name⟧, one of the user's bots. You run on this Mac.\n\n⟦personality⟧\n\nMemory: the file \"⟦folder⟧/MEMORY.md\" is yours.\n\nWho sets what.",
  jobInstructions: "You are ⟦name⟧, one of the user's bots: ⟦job⟧. You run on this Mac.\n\n⟦personality⟧\n\nYour job:\n⟦jobDetails⟧\n\nMemory: the file \"⟦folder⟧/MEMORY.md\" is yours.\n\nWho sets what.",
  personalityWords: "Your personality: ⟦name⟧. ⟦description⟧",
  projectNote: "You work in one of the user's projects.",
  identityNote: "Who sets what.",
  memory: "# ⟦name⟧'s memory\n",
  greeting: "<system-reminder>Write first.</system-reminder>",
  rules: [{ action: "edit", resource: "*", effect: "ask" }],
  timeZone: "Europe/Istanbul",
};

// A bot's folder as the app keeps it on this Mac.
function bot(id, { name = "Scout", session = `ses_${id}` } = {}) {
  const folder = path.join(bots, id);
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  write(path.join(folder, "MEMORY.md"), `# ${name}'s memory\n`);
  write(path.join(folder, "session"), session);
  write(path.join(folder, "directory"), path.join(folder, "workspace"));
  write(path.join(folder, "bot.json"), JSON.stringify({
    kuvo: 1, id, name, job: "", look: { color: "sky", shape: "round", face: "calm" },
    model: { id: "big-pickle", providerID: "opencode" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z",
  }));
  return folder;
}

beforeEach(() => {
  for (const folder of [bots, home]) fs.rmSync(folder, { recursive: true, force: true });
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
});

// The engine: conversations made and read (each with the rules it was given), what each was told,
// its providers ready, and its events sent (`send`) to whoever follows them.
async function engine({ rules = {} } = {}) {
  const asked = [];
  const followers = [];
  const awaited = [];
  let next = 1;
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
      const given = body ? JSON.parse(body) : undefined;
      const entry = { method: request.method, url: request.url, body: given };
      asked.push(entry);
      const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      const one = request.url.match(/^\/api\/session\/([^/]+)$/);
      if (request.method === "GET" && request.url === "/api/provider") reply({ data: [{ id: "opencode" }] });
      else if (request.method === "POST" && request.url === "/api/session") reply({ data: { id: `ses_made${next++}` } });
      else if (one && request.method === "GET") reply({ data: { id: one[1], permissions: rules[one[1]] ?? [] } });
      else if (one && request.method === "PATCH" && given?.permissions) { rules[one[1]] = given.permissions; reply({ data: {} }); }
      else reply({});
      for (const waiting of awaited.filter(each => each.match(entry))) {
        awaited.splice(awaited.indexOf(waiting), 1);
        waiting.resolve(entry);
      }
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    asked, rules, following, read: () => ({ port: server.address().port, password: "p" }),
    send: event => { for (const follower of followers) follower.write(`data: ${JSON.stringify(event)}\n\n`); },
    request: match => asked.find(match) ? Promise.resolve(asked.find(match)) : new Promise(resolve => awaited.push({ match, resolve })),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

async function ask(handle, method, p, body) {
  const parts = [];
  for await (const part of handle({ method, path: p, headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, json, text };
}

const told = (asked, session) => asked.filter(each => each.method === "PUT" && each.url === `/api/experimental/session/${session}/instructions/entries/kuvo.bot`);

test("this Mac's bots are its own: listed without a machine, made here with this Mac's words, and only here", async t => {
  const fake = await engine();
  t.after(fake.close);
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  bot("bot_scout00001");
  const listed = await ask(handle, "GET", "kuvo/bots?memory=1");
  assert.equal(listed.json.bots[0].id, "bot_scout00001");
  assert.equal("machine" in listed.json.bots[0], false, "a Mac leaves machine out for its own");
  assert.equal("memoryJob" in listed.json.bots[0], false, "a Mac reads no machine's memories");

  // What New Bot offers here: this Mac's starting model, by the name a Mac's has.
  const offered = await ask(handle, "GET", "kuvo/bots/templates");
  assert.deepEqual(offered.json.startingModel, { mac: kit.startingModel });

  const made = await ask(handle, "POST", "kuvo/bots", { name: "Inbox Helper" });
  assert.equal(made.status, 201);
  const folder = path.join(bots, made.json.bot.id);
  assert.equal("machine" in made.json.bot, false);
  assert.match(told(fake.asked, made.json.bot.session)[0].body.value, /You run on this Mac\./);
  // Its wake-ups go by this Mac's clock, as you change it: no time zone of its own.
  assert.equal(fs.existsSync(path.join(folder, "timezone")), false);
  assert.equal(fs.existsSync(path.join(folder, "zoneinfo")), false);

  // One for another computer is made there, never here.
  const elsewhere = await ask(handle, "POST", "kuvo/bots", { name: "Far", machine: "lab" });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.json.message, /lab/);
  assert.equal((await ask(handle, "GET", "kuvo/bots")).json.bots.length, 2, "nothing more made");

  // Deleted here: nothing noted for a Mac to let go of, as on a machine (this is the Mac).
  assert.equal((await ask(handle, "DELETE", `kuvo/bots/${made.json.bot.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(bots, "deleted.json")), false);
});

test("this Mac's box makes bots with its app's kit, never a release's words", async () => {
  write(path.join(home, "bin", "bot-kit.json"), JSON.stringify({ ...kit, version: "9.9.9", instructions: "On ⟦machine⟧, in ⟦timeZone⟧." }));
  assert.equal(link.readKit().instructions, kit.instructions);
});

test("a bot is told what it is now at its next run, once, not all at once as the box starts", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  bot("bot_quiet00001", { name: "Quiet" });
  const stop = new AbortController();
  t.after(() => stop.abort());
  link.watchEvents(fake.read, () => true, stop.signal, () => {}, { bots: true });
  await fake.following;
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 0, "nothing told before it runs");

  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_scout00001" } });
  const first = await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_scout00001/instructions"));
  assert.match(first.body.value, /You are Scout, one of the user's bots\. You run on this Mac\./);
  // Its next run: told already, so not again (the engine opens a bot's folder each time it is).
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_scout00001" } });
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_quiet00001" } });
  await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_quiet00001/instructions"));
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 1);

  // New words (an update, a personality's): told at its next run.
  write(path.join(bots, "kit.json"), JSON.stringify({ ...kit, instructions: kit.instructions.replace("You run on this Mac.", "You run on this Mac, now.") }));
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_scout00001" } });
  const again = await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_scout00001/instructions") && each.body.value.includes("now."));
  assert.ok(again);
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 2);
});

test("a bot's own rules are put right at its next run: its folder its own, an old version's kuvo-wake rules gone", async t => {
  const folder = bot("bot_scout00001");
  const wake = process.env.KUVO_WAKE_COMMAND;
  const fake = await engine({ rules: { ses_bot_scout00001: [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "shell", resource: `"${wake}" bot_scout00001 add *`, effect: "allow" },
    { action: "shell", resource: "kuvo-wake bot_scout00001 list", effect: "allow" },
  ] } });
  t.after(fake.close);
  fs.rmSync(path.join(folder, "MEMORY.md"));
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  assert.deepEqual(fake.rules.ses_bot_scout00001, [
    { action: "shell", resource: "*", effect: "allow" },
    { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" },
  ]);
  // Its memory, for one made before it was made with it.
  assert.equal(fs.readFileSync(path.join(folder, "MEMORY.md"), "utf8"), "# Scout's memory\n");
  // Once: its next run asks nothing more of its rules.
  const patches = () => fake.asked.filter(each => each.method === "PATCH" && each.body?.permissions).length;
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  assert.equal(patches(), 1);
});

test("a client follows this Mac's bots as they change (kuvo/bots/events)", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const lines = [];
  let heard = null;
  (async () => {
    try {
      for await (const part of handle({ method: "GET", path: "kuvo/bots/events", headers: {}, body: Buffer.alloc(0) }, {}, controller.signal)) {
        if (!part.body) continue;
        for (const line of part.body.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line));
        heard?.();
      }
    } catch {}
  })();
  const until = async matches => {
    for (;;) {
      const found = lines.find(matches);
      if (found) return found;
      await new Promise(resolve => { heard = resolve; });
    }
  };
  assert.equal((await until(line => line.bots?.length === 1)).bots[0].name, "Scout");
  assert.equal((await ask(handle, "PATCH", "kuvo/bots/bot_scout00001", { name: "Scout Two" })).status, 200);
  assert.ok(await until(line => line.bots?.[0]?.name === "Scout Two"));
});

test("a bot made from a shared one's job waits with it for your composer; one with none writes first", async t => {
  const fake = await engine();
  t.after(fake.close);
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  const shared = await ask(handle, "POST", "kuvo/bots", { name: "Herald", job: { line: "Sends a morning digest", details: "Sends a morning digest.\nEvery day at 8.\nKeep it short." } });
  assert.equal(shared.status, 201);
  assert.equal(shared.json.firstMessage, "Your job, in a few words: Sends a morning digest.\n\nEvery day at 8.\nKeep it short.\n\nStart now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up.");
  assert.equal(fake.asked.some(each => each.url === `/api/session/${shared.json.bot.session}/synthetic`), false, "it waits for you");

  const plain = await ask(handle, "POST", "kuvo/bots", { name: "Blank", job: { line: "", details: "  " } });
  assert.equal(plain.json.firstMessage, null);
  assert.ok(fake.asked.some(each => each.url === `/api/session/${plain.json.bot.session}/synthetic`), "it writes first");
});
