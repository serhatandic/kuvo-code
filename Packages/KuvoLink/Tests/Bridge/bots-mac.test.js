// This Mac's box answers for this Mac's bots as a machine's does for its own (PROTOCOL.md,
// `kuvo/bots`, "This Mac's box"): it finds them where the app keeps them (KUVO_BOTS), makes them
// with the kit the app gives it, and keeps them told what they are, at their next run, the way a
// machine does with the Mac closed. Only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-mac.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { removeAtEnd } from "./at-end.js";

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-mac-bots-")));
removeAtEnd(support);
// As BoxProcess starts it: its folder, and the app's own beside it.
Object.assign(process.env, {
  KUVO_BOX: "mac",
  KUVO_HOME: path.join(support, "box"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
  KUVO_WAKE_COMMAND: path.join(support, "bin", "kuvo-wake"),
  // The engine's settings folder, where this Mac's settings are (Settings › Permissions among them).
  KUVO_ENGINE_CONFIG: path.join(support, "engine"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");

const bots = process.env.KUVO_BOTS;
const home = process.env.KUVO_HOME;
const settingsFile = path.join(process.env.KUVO_ENGINE_CONFIG, "opencode", "opencode.json");

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// What a box makes bots with and tells them (`bin/bot-words.json`, which the app puts beside this
// Mac's box), shortened.
const words = {
  kuvo: 1,
  templates: [{ id: "news", name: "Herald", job: "Sends you a morning news digest", instructions: "Every morning…", look: { color: "sky", shape: "round", face: "happy" }, personality: "preset.straight", wantsProject: false }],
  personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", symbol: "bolt" }],
  personalityWords: "Your personality: ⟦name⟧. ⟦description⟧",
  looks: { colors: ["mint", "sky"], shapes: ["round"], faces: ["calm", "happy"] },
  instructions: ["You are ⟦name⟧, one of the user's bots⟦jobLine⟧. You run on ⟦place⟧.", "⟦personality⟧", "⟦jobPart⟧", "Memory: the file \"⟦folder⟧/MEMORY.md\" is yours.", "Who sets what."],
  here: { mac: { place: "this Mac" }, machine: { place: "the machine \"⟦machine⟧\"" } },
  job: { none: "", line: ": ⟦job⟧", details: "Your job:\n⟦jobDetails⟧" },
  projectNote: "You work in one of the user's projects.",
  identityNote: "Who sets what.",
  memory: "# ⟦name⟧'s memory\n",
  greeting: "<system-reminder>Write first.</system-reminder>",
};
const wordsFile = path.join(home, "bin", "bot-words.json");

// What's this Mac's own that the app gives its box (its kit): the model a bot starts on, the rules
// a new conversation gets.
const kit = {
  kuvo: 1,
  personalities: [],
  startingModel: { id: "big-pickle", providerID: "opencode" },
  projects: [],
  rules: [{ action: "edit", resource: "*", effect: "ask" }],
  timeZone: "Europe/Istanbul",
};

// A bot's folder as the app keeps it on this Mac.
function bot(id, { name = "Scout", session = `ses_${id}`, personality } = {}) {
  const folder = path.join(bots, id);
  fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
  fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
  write(path.join(folder, "MEMORY.md"), `# ${name}'s memory\n`);
  write(path.join(folder, "session"), session);
  write(path.join(folder, "directory"), path.join(folder, "workspace"));
  write(path.join(folder, "bot.json"), JSON.stringify({
    kuvo: 1, id, name, job: "", look: { color: "sky", shape: "round", face: "calm" },
    model: { id: "big-pickle", providerID: "opencode" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z",
    ...(personality ? { personality } : {}),
  }));
  return folder;
}

beforeEach(() => {
  for (const folder of [bots, home, process.env.KUVO_ENGINE_CONFIG]) fs.rmSync(folder, { recursive: true, force: true });
  write(path.join(bots, "kit.json"), JSON.stringify(kit));
  write(wordsFile, JSON.stringify(words));
});

// The engine: conversations made and read (each with the rules it was given), what each was told,
// its providers ready, and its events sent (`send`) to whoever follows them.
async function engine({ rules = {} } = {}) {
  const asked = [];
  // What each conversation is told, by its entries' keys, as the engine keeps them.
  const entries = {};
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
      const instruction = request.url.match(/^\/api\/experimental\/session\/([^/]+)\/instructions\/entries(?:\/([^/]+))?$/);
      if (instruction && request.method === "PUT") { (entries[instruction[1]] ??= {})[instruction[2]] = given.value; reply({}); }
      else if (instruction && request.method === "GET" && !instruction[2]) reply({ data: Object.entries(entries[instruction[1]] ?? {}).map(([key, value]) => ({ key, value })) });
      else if (request.method === "GET" && request.url === "/api/provider") reply({ data: [{ id: "opencode" }] });
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
    asked, rules, entries, following, read: () => ({ port: server.address().port, password: "p" }),
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
  const listed = await ask(handle, "GET", "kuvo/bots");
  assert.equal(listed.json.bots[0].id, "bot_scout00001");
  assert.equal("machine" in listed.json.bots[0], false, "a Mac leaves machine out for its own");

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

test("a bot on this Mac is told, in Kuvo Code's own words, that it runs on this Mac, by its clock, with tabs of its own in your browser", () => {
  fs.copyFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), wordsFile);
  const told = link.botInstructions(link.readKit(), "Scout", path.join(bots, "bot_scout00001"), undefined, undefined);
  assert.match(told, /^You are Scout, one of the user's bots in Kuvo Code\. .* You run on this Mac\.\n\nYour job is what the user gives you/);
  assert.match(told, /a time like 2026-10-16T09:00 on this Mac's clock,/);
  assert.match(told, /tabs of your own in the user's browser on this Mac, signed in where they are/);
  // Its wake-ups come back as Kuvo Code sends them (Wakes.swift).
  const marker = fs.readFileSync(new URL("../../../OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8").match(/static let marker = "([^"]*)"/)[1];
  assert.ok(told.includes(`a new message starting with "${marker.trim()}"`));
  assert.doesNotMatch(told, /⟦|Linux machine|time zone,/, "nothing left to fill in, nothing of a machine's");
});

test("a bot asked to be told twice at once (its run starting as the box finds its engine) is told once", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  fake.entries.ses_bot_scout00001 = { "kuvo.bot": "You are Scout. Keep your job under ## Job in your memory." };
  await Promise.all([link.freshenBot(fake.read(), "ses_bot_scout00001"), link.freshenBot(fake.read(), "ses_bot_scout00001")]);
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 1);
});

test("a bot made this box's as it arrives while its run starts (one that was paused, so its move didn't hold it) is told once", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  fake.entries.ses_bot_scout00001 = { "kuvo.bot": "You are Scout. You run on the Linux machine \"lab\"." };
  // Its run's telling has read what its conversation has, and is about to tell it.
  const freshening = link.freshenBot(fake.read(), "ses_bot_scout00001");
  await fake.request(each => each.method === "GET" && each.url === "/api/experimental/session/ses_bot_scout00001/instructions/entries");
  await Promise.all([freshening, link.settleBot("bot_scout00001", fake.read, () => null)]);
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 1);
});

test("a bot that came here already told what it is here is noted as told, so it isn't told again where its conversation can't be read", async t => {
  const fake = await engine();
  t.after(fake.close);
  const folder = bot("bot_scout00001");
  assert.equal((await link.settleBot("bot_scout00001", fake.read, () => null)).status, 200);
  const toldHere = JSON.parse(fs.readFileSync(path.join(folder, "told.json"), "utf8"));
  // As it came back from another computer that had told it the same (a move there and back).
  write(path.join(folder, "told.json"), JSON.stringify({ ...toldHere, instructions: "elsewhere" }));
  assert.equal((await link.settleBot("bot_scout00001", fake.read, () => null)).status, 200);
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 1, "told already");
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "told.json"), "utf8")).instructions, toldHere.instructions);
});

test("a bot is told what it is now as the box finds its engine and as its runs start, once each time it changed", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  bot("bot_quiet00001", { name: "Quiet" });
  // Told by an earlier version, in words that point at its memory.
  fake.entries.ses_bot_quiet00001 = { "kuvo.bot": "You are Quiet. Keep your job under ## Job in your memory." };
  const stop = new AbortController();
  t.after(() => stop.abort());
  link.watchEvents(fake.read, () => true, stop.signal, () => {}, { bots: true });
  // As the box finds its engine (after an update, say): each bot on its words now, before its next turn.
  await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_scout00001/instructions"));
  const quiet = await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_quiet00001/instructions"));
  assert.match(quiet.body.value, /You are Quiet, one of the user's bots\. You run on this Mac\./);
  // Its next run: told already, so not again (the engine opens a bot's folder each time it is).
  // Each looked at (what its conversation has now is read) before the words change.
  const looked = session => {
    const mark = fake.asked.length;
    return fake.request(each => fake.asked.indexOf(each) >= mark && each.method === "GET" && each.url === `/api/experimental/session/${session}/instructions/entries`);
  };
  const lookedAt = [looked("ses_bot_scout00001"), looked("ses_bot_quiet00001")];
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_scout00001" } });
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_quiet00001" } });
  await Promise.all(lookedAt);
  // New words (an update, a personality's): told at its next run, and at once when its app asks.
  write(wordsFile, JSON.stringify({ ...words, here: { ...words.here, mac: { place: "this Mac, now" } } }));
  fake.send({ type: "session.execution.started", data: { sessionID: "ses_bot_scout00001" } });
  await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_scout00001/instructions") && each.body.value.includes("now."));
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 2);
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  assert.equal((await ask(handle, "POST", "kuvo/bots/retell")).status, 200);
  assert.ok(told(fake.asked, "ses_bot_quiet00001").at(-1).body.value.includes("now."), "the other bot, at once");
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 2, "not again: it has them");
});

test("a bot with one of your personalities is told it from this Mac's library, and told without it once it's deleted", async t => {
  const fake = await engine();
  t.after(fake.close);
  t.after(() => fs.rmSync(path.join(bots, "personalities.json"), { force: true }));
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  const owl = (await ask(handle, "POST", "kuvo/personalities", { name: "Night Owl", description: "Works late." })).json;
  bot("bot_scout00001", { personality: owl.id });
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  assert.match(told(fake.asked, "ses_bot_scout00001").at(-1).body.value, /Your personality: Night Owl\. Works late\./);
  // Deleted (in Edit Bot, from a phone): the bot is told what it is without it, at once.
  assert.equal((await ask(handle, "DELETE", `kuvo/personalities/${owl.id}`)).status, 200);
  const now = await fake.request(each => each.method === "PUT" && each.url.includes("ses_bot_scout00001/instructions") && !each.body.value.includes("Night Owl"));
  assert.match(now.body.value, /You are Scout, one of the user's bots\./);
});

test("a bot told other words behind the box's back (by a Mac of an earlier version) is put right at its next run", async t => {
  const fake = await engine();
  t.after(fake.close);
  bot("bot_scout00001");
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 1);
  fake.entries.ses_bot_scout00001["kuvo.bot"] = "You are Scout. Keep your job under ## Job in your memory.";
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  assert.equal(told(fake.asked, "ses_bot_scout00001").length, 2);
  assert.match(fake.entries.ses_bot_scout00001["kuvo.bot"], /You run on this Mac\./);
});

test("a bot's own rules are put right at its next run: its folder its own, an old version's kuvo-wake rules and the asks it put in a bot's gone, your own kept", async t => {
  const folder = bot("bot_scout00001");
  const wake = process.env.KUVO_WAKE_COMMAND;
  // Settings › Permissions here: never rm -rf, and Ask for stripe, which a box before also asked of a bot.
  const STRIPE = { action: "shell", resource: "stripe *", effect: "ask" };
  write(settingsFile, JSON.stringify({ permissions: [{ action: "shell", resource: "rm -rf *", effect: "deny" }, STRIPE] }));
  const fake = await engine({ rules: { ses_bot_scout00001: [
    { action: "shell", resource: "rm -rf *", effect: "deny" },
    STRIPE,
    { action: "shell", resource: "gh pr create*", effect: "ask" },
    { action: "shell", resource: "git push *--force*", effect: "ask" },
    { action: "shell", resource: `"${wake}" bot_scout00001 add *`, effect: "allow" },
    { action: "shell", resource: "kuvo-wake bot_scout00001 list", effect: "allow" },
  ] } });
  t.after(fake.close);
  fs.rmSync(path.join(folder, "MEMORY.md"));
  await link.freshenBot(fake.read(), "ses_bot_scout00001");
  // Your own kept as any conversation in Auto has them (its Ask goes to Auto, so it's allowed here),
  // and the asks a box before put in a bot's gone.
  assert.deepEqual(fake.rules.ses_bot_scout00001, [
    { ...STRIPE, effect: "allow" },
    { action: "shell", resource: "rm -rf *", effect: "deny" },
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

test("this Mac's bots' jobs are kept once from where they were: a memory's Job section, or what Edit Bot wrote before memories kept jobs", async t => {
  const fake = await engine();
  t.after(fake.close);
  t.after(() => fs.rmSync(path.join(support, "bots.json"), { force: true }));
  const remembers = bot("bot_remember01", { name: "Remembers" });
  const memory = "# Remembers's memory\n\n## Job\nKeeps CI green.\nFix flaky tests.\n";
  write(path.join(remembers, "MEMORY.md"), memory);
  bot("bot_olderone01", { name: "Older" });
  bot("bot_nothing001", { name: "Nothing" });
  // The app's list, as a version before memories kept jobs left it.
  write(path.join(support, "bots.json"), JSON.stringify([
    { id: "bot_olderone01", name: "Older", job: "Sends the digest", instructions: "Every morning at 8.", jobInMemory: false },
    { id: "bot_nothing001", name: "Nothing", job: "", instructions: "", jobInMemory: true },
  ]));
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  const byName = Object.fromEntries((await ask(handle, "GET", "kuvo/bots")).json.bots.map(each => [each.name, [each.job, each.jobDetails]]));
  assert.deepEqual(byName, { Remembers: ["Keeps CI green", "Fix flaky tests."], Older: ["Sends the digest", "Every morning at 8."], Nothing: ["", ""] });
  assert.equal(fs.readFileSync(path.join(remembers, "MEMORY.md"), "utf8"), memory, "its memory stays as it was");
  // Kept: the app's old list no longer counts.
  fs.rmSync(path.join(support, "bots.json"));
  assert.equal((await ask(handle, "GET", "kuvo/bots")).json.bots.find(each => each.name === "Older").job, "Sends the digest");
});

test("a template's or a shared bot's job as the first message says its job once, then the rest whole, then to start", () => {
  const start = "Start now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up.";
  // Details that begin with the job's line say it once; a line that goes on keeps the rest.
  assert.equal(link.firstMessageOf("Keeps CI green", "Keeps CI green.\n\nWatch main; when it fails, fix it on a branch."), `Your job, in a few words: Keeps CI green.\n\nWatch main; when it fails, fix it on a branch.\n\n${start}`);
  assert.equal(link.firstMessageOf("Keeps CI green", "Keeps CI green. Watch main; when it fails, fix it on a branch.\n\nTell me what broke."), `Your job, in a few words: Keeps CI green.\n\nWatch main; when it fails, fix it on a branch.\n\nTell me what broke.\n\n${start}`);
  assert.equal(link.firstMessageOf("Keeps CI green. Fast", "Keeps CI green. Fast.\n\nWatch main.").split("Keeps CI green").length, 2);
  assert.equal(link.firstMessageOf("", ""), "");
  // Each of New Bot's templates, as Kuvo Code words them.
  const shipped = JSON.parse(fs.readFileSync(new URL("../../Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8"));
  assert.ok(shipped.templates.length > 1);
  for (const template of shipped.templates) {
    const message = link.firstMessageOf(template.job, template.instructions);
    assert.ok(message.startsWith(`Your job, in a few words: ${template.job}.`), template.name);
    assert.equal(message.split(template.job).length, 2, `${template.name}: its job said once`);
    assert.ok(message.endsWith("set that up."), template.name);
  }
});

test("a bot brought here from another computer is made this Mac's: its folder says where it is, its rules are for its folder here, and it's told it runs here", async t => {
  const folder = bot("bot_moved00001", { name: "Mover" });
  // As it came from a machine: its folder there, your time zone there, and what it was told there.
  write(path.join(folder, "directory"), "/home/me/.kuvo-code/bots/bot_moved00001/workspace");
  write(path.join(folder, "timezone"), "Europe/Istanbul");
  write(path.join(folder, "zoneinfo"), "TZif");
  write(path.join(folder, "paused"), "moving");
  write(path.join(folder, "told.json"), JSON.stringify({ session: "ses_bot_moved00001", instructions: "elsewhere", rules: "/home/me/.kuvo-code/bots/bot_moved00001" }));
  // It ran without asking there, where nothing asked first; here, Settings › Permissions asks
  // before a push, which Approve All lets through.
  write(settingsFile, JSON.stringify({ permissions: [{ action: "shell", resource: "git push *", effect: "ask" }] }));
  const fake = await engine({ rules: { ses_bot_moved00001: [
    { action: "external_directory", resource: "/home/me/.kuvo-code/bots/bot_moved00001/*", effect: "allow" },
  ] } });
  t.after(fake.close);
  const handle = link.engineHandler(fake.read, { name: "Mac" }, () => null);
  const arrived = await ask(handle, "POST", "kuvo/bots/bot_moved00001/arrived");
  assert.equal(arrived.status, 200, arrived.text);
  assert.equal(arrived.json.bot.id, "bot_moved00001");
  assert.equal(fs.readFileSync(path.join(folder, "directory"), "utf8"), path.join(folder, "workspace"));
  assert.equal(fs.existsSync(path.join(folder, "timezone")), false, "this Mac's bots go by its own clock");
  assert.equal(fs.existsSync(path.join(folder, "zoneinfo")), false);
  assert.deepEqual(fake.rules.ses_bot_moved00001, [
    { action: "shell", resource: "git push *", effect: "allow" },
    { action: "external_directory", resource: path.join(folder, "*"), effect: "allow" },
  ]);
  assert.match(told(fake.asked, "ses_bot_moved00001").at(-1).body.value, /You run on this Mac\./);
  assert.equal(fs.readFileSync(path.join(folder, "paused"), "utf8"), "moving", "still held: its move lets it go");
  assert.equal((await ask(handle, "POST", "kuvo/bots/bot_nobody01/arrived")).status, 404);
});
