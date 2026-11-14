// Edits to a bot whose computer is away, held by the box that was asked (PROTOCOL.md, `kuvo/bots`,
// "Held for another computer"): a client changes or deletes a bot on another of your computers
// through any box it reaches; that box takes it at once, keeps it (each field the last given, a
// delete over all of it), says so in its bots' list, and hands it on when that computer answers,
// which does it once and answers. What it refuses is let go, and said in plain words.
//
// One box (a machine, here, by the real link in this process), its Mac and another machine as keys
// whose mail is sealed and opened as the relay carries it; only the engine is a stand-in.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/bots-held.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-bots-held-")));
removeAtEnd(home);
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const run = path.join(home, "run");
const bots = path.join(home, "bots");
const held = path.join(run, "bots-held");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

// What this box makes bots with (as bots.test.js has it, shortened).
write(path.join(home, "bin", "bot-words.json"), {
  kuvo: 1,
  templates: [],
  personalities: [{ id: "preset.straight", name: "Straight Shooter", description: "Direct.", symbol: "bolt" }],
  personalityWords: "Your personality: ⟦name⟧. ⟦description⟧",
  looks: { colors: ["mint", "sky"], shapes: ["round"], faces: ["calm", "happy"] },
  instructions: ["You are ⟦name⟧, one of the user's bots⟦jobLine⟧.", "⟦personality⟧", "⟦jobPart⟧"],
  here: { mac: { place: "this Mac" }, machine: { place: "the machine \"⟦machine⟧\"" } },
  job: { none: "", line: ": ⟦job⟧", details: "Your job:\n⟦jobDetails⟧" },
  projectNote: "",
  identityNote: "",
  memory: "# ⟦name⟧'s memory\n",
  greeting: "Write first.",
});
const kit = { kuvo: 1, personalities: [], startingModel: { id: "big-pickle", providerID: "opencode" }, projects: [], timeZone: "Europe/Istanbul" };

// The engine: what it was asked.
const asked = [];
const engine = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    asked.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : undefined });
    const reply = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.url === "/api/provider") return reply({ data: [{ id: "opencode" }] });
    reply({});
  });
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
const target = { port: engine.address().port, password: "p" };

// This box (a machine, "devbox"), the Mac that set it up, and another machine ("lab").
const k = key => key.toString("base64url");
const box = (kind, name, id) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), address, peer: { key: k(link.publicOf(key)), address, name, kind, ...(id ? { id } : {}) } };
};
const here = box("machine", "devbox", "devbox"), mac = box("mac", "Studio"), lab = box("machine", "lab", "lab");
const secret = crypto.randomBytes(32).toString("base64url");
const fresh = () => link.writeLink({
  secret, key: k(here.key), relay: "wss://relay.test", name: "devbox", id: "devbox", mac: mac.pub, macs: [mac.pub], phones: [],
  legacy: { [mac.pub]: { at: 1, peers: [mac.peer, lab.peer, here.peer] } },
});
// What each peer's agents' mail said: lab keeps Wren, and takes held edits.
const agentsTold = ({ labFeatures = ["bots.held"], labBots = [{ session: "ses_wren", name: "Wren", kind: "bot", id: "bot_wren0000001" }], macBots = [] } = {}) => write(path.join(run, "peer-agents.json"), {
  [lab.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "lab", list: labBots, features: labFeatures },
  [mac.pub]: { at: 1, heard: Date.now(), kind: "mac", list: macBots, features: ["bots.held"] },
});

// Mail as the relay hands it on, from `from` to this box; and what this box sent, opened as `to` would.
const mailFrom = (from, payload) => link.sealOneWay(Buffer.from(JSON.stringify({ ...payload, at: Date.now() })), from.key, link.publicOf(here.key)).message;
const opened = (bytes, to) => JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, to.key, link.publicOf(here.key)).payload.toString("utf8"));
const sent = [];
const host = { welcomed: true, send: bytes => sent.push(bytes) };
const receive = (from, payload) => link.receiveMail(mailFrom(from, payload), host, (sender, given) => link.peerMail(sender, given, host, () => ({ targets: [target], bridge: false })));
const mailTo = to => {
  const theirs = sent.filter(bytes => k(bytes.subarray(1, 17)) === to.address);
  for (const bytes of theirs) sent.splice(sent.indexOf(bytes), 1);
  return theirs.map(bytes => opened(bytes, to));
};

// A client's request to this box.
const handle = link.engineHandler(() => target, { name: "devbox" }, () => null);
async function route(method, pathname, body) {
  const pieces = [];
  for await (const piece of handle({ method, path: pathname, headers: {}, body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)), fromApp: true }, undefined)) pieces.push(piece);
  const text = Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: pieces.find(each => each.head).head.status, body: parsed };
}
const listed = async () => (await route("GET", "kuvo/bots")).body;
const wren = "bot_wren0000001";

beforeEach(() => {
  fs.rmSync(run, { recursive: true, force: true });
  fs.rmSync(bots, { recursive: true, force: true });
  write(path.join(run, "engine.json"), { ...target, version: "0.0.0" });
  sent.length = 0;
  asked.length = 0;
  link.forgetHeldSends();
  link.heldSoon.send = () => link.sendHeld(host);
  fresh();
  agentsTold();
});

test("an edit to a bot whose computer is away is held by the box asked, merged a field at a time, and handed on when that computer is back", async () => {
  // Lab doesn't answer (the relay found nothing there).
  write(path.join(run, "peer-reach.json"), { [lab.pub]: Date.now() - 60_000 });
  const first = await route("PATCH", `kuvo/bots/${wren}`, { name: "  Wren\nthe Second ", look: { color: "mint", shape: "round", face: "calm" } });
  assert.equal(first.status, 202);
  assert.deepEqual({ ...first.body.held, since: 0 }, { bot: wren, box: lab.pub, computer: "lab", change: { name: "Wren the Second", look: { color: "mint", shape: "round", face: "calm" } }, since: 0 });
  // A later one on top: each field the last given.
  const second = await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren III", personality: null });
  assert.equal(second.status, 202);
  assert.equal(second.body.held.since, first.body.held.since, "held since the first");
  assert.deepEqual(second.body.held.change, { name: "Wren III", look: { color: "mint", shape: "round", face: "calm" }, personality: null });
  // Its work settings change only where it lives, while that computer answers.
  const work = await route("PATCH", `kuvo/bots/${wren}`, { work: { limits: null } });
  assert.equal(work.status, 409);
  assert.match(work.body.message, /lab isn’t connected: change its work settings once it’s back/);
  // What every client following this box's bots sees: the edit held, for lab.
  const list = await listed();
  assert.deepEqual(list.held.map(each => [each.bot, each.computer, each.change.name]), [[wren, "lab", "Wren III"]]);
  assert.deepEqual(list.refused, []);

  // It went to lab as it was held (the relay keeps nothing), and isn't sent again within the minute.
  const tries = mailTo(lab);
  assert.ok(tries.length >= 1);
  const edit = tries.at(-1).botEdit;
  assert.deepEqual({ bot: edit.bot, change: edit.change }, { bot: wren, change: second.body.held.change });
  assert.deepEqual(Object.keys(edit.ages).sort(), ["look", "name", "personality"], "how long ago each field was given");
  assert.ok(Object.values(edit.ages).every(age => age >= 0));
  link.sendHeld(host);
  assert.deepEqual(mailTo(lab), [], "not again at once");
  // Lab is back (any mail from it): it goes now, not at its next minute.
  receive(lab, {});
  const [again] = mailTo(lab);
  assert.equal(again.botEdit.id, edit.id);
  // Only lab's answer is taken; then it's let go.
  receive(mac, { botEdited: { id: edit.id, bot: wren, status: 200 } });
  assert.equal((await listed()).held.length, 1, "the Mac's word for lab's isn't taken");
  receive(lab, { botEdited: { id: edit.id, bot: wren, status: 200 } });
  assert.deepEqual((await listed()).held, []);
  assert.deepEqual(fs.readdirSync(held), [], "nothing left behind");
});

test("a delete wins over what's held, and nothing more is held for that bot; one lab refuses is let go and said in plain words", async () => {
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II" });
  const deleting = await route("DELETE", `kuvo/bots/${wren}`);
  assert.equal(deleting.status, 202);
  assert.equal(deleting.body.held.delete, true);
  assert.equal(deleting.body.held.change, undefined);
  const after = await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren IV" });
  assert.equal(after.status, 404);
  assert.match(after.body.message, /deleted: it goes from lab once it’s back/);
  const [, sentDelete] = mailTo(lab);
  assert.deepEqual([sentDelete.botEdit.delete, sentDelete.botEdit.change], [true, undefined]);
  // Lab can't now (the bot moving): it waits on, and goes again later.
  receive(lab, { botEdited: { id: sentDelete.botEdit.id, bot: wren, status: 409, message: "It’s moving." } });
  assert.equal((await listed()).held.length, 1);
  // Gone there already: done.
  receive(lab, { botEdited: { id: sentDelete.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
  assert.deepEqual(await listed().then(list => [list.held, list.refused]), [[], []]);

  // A change lab refuses: let go, and every client sees why, until a new edit for that bot.
  const change = await route("PATCH", `kuvo/bots/${wren}`, { personality: "preset.gone" });
  assert.equal(change.status, 202);
  const [went] = mailTo(lab);
  receive(lab, { botEdited: { id: went.botEdit.id, bot: wren, status: 400, message: "There’s no personality “preset.gone”." } });
  const list = await listed();
  assert.deepEqual(list.held, []);
  assert.deepEqual(list.refused.map(each => [each.bot, each.computer, each.message]), [[wren, "lab", "lab didn’t take the changes you made while it was away. There’s no personality “preset.gone”."]]);
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren V" });
  assert.deepEqual((await listed()).refused, [], "a new edit for it takes its place");
});

test("what can't be held: a bot no computer lists (unless the client names its computer), a change that isn't one, and anything planted in the folder", async () => {
  const unknown = await route("PATCH", "kuvo/bots/bot_nobody000001", { name: "X" });
  assert.equal(unknown.status, 404);
  // Named by the client (as a Mac names its machine): held for it.
  const named = await route("PATCH", "kuvo/bots/bot_nobody000001?on=lab", { name: "X" });
  assert.equal(named.status, 202);
  assert.equal(named.body.held.box, lab.pub);
  assert.equal((await route("DELETE", `kuvo/bots/bot_other000001?on=${encodeURIComponent(mac.pub)}`)).body.held.computer, "Studio");
  for (const body of [{ name: "  " }, { look: { color: "plaid", shape: "round", face: "calm" } }, { model: "big" }, { job: "x" }, { colour: "mint" }]) {
    const refused = await route("PATCH", `kuvo/bots/${wren}`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(typeof refused.body.message, "string");
  }
  // Too much for one mail: never held, rather than waiting for ever.
  assert.equal((await route("PATCH", `kuvo/bots/${wren}`, { name: "x".repeat(40_000) })).status, 400);
  // A computer this box doesn't know now (a machine you removed), named by the client: held, and it
  // goes there once it's one of this box's computers again.
  assert.equal((await route("DELETE", "kuvo/bots/bot_gone00000001?on=attic")).status, 404, "one it doesn't know, unless the client says it's one you removed");
  const removed = await route("DELETE", "kuvo/bots/bot_gone00000001?on=attic&removed");
  assert.equal(removed.status, 202);
  assert.deepEqual([removed.body.held.box, removed.body.held.computer, removed.body.held.delete], ["", "attic", true]);
  const attic = box("machine", "attic", "attic");
  link.writeLink({ ...link.readLink(), legacy: { [mac.pub]: { at: 2, peers: [mac.peer, lab.peer, here.peer, attic.peer] } } });
  write(path.join(run, "peer-agents.json"), { ...JSON.parse(fs.readFileSync(path.join(run, "peer-agents.json"), "utf8")), [attic.pub]: { at: 1, heard: Date.now(), kind: "machine", id: "attic", list: [], features: ["bots.held"] } });
  link.sendHeld(host);
  assert.deepEqual(mailTo(attic).map(each => [each.botEdit.bot, each.botEdit.delete]), [["bot_gone00000001", true]]);
  assert.equal((await listed()).held.find(each => each.bot === "bot_gone00000001").box, attic.pub);
  // Left by something else on this computer, not sealed with this box's secret: never sent, never shown.
  sent.length = 0;
  write(path.join(held, "bot_planted00001.json"), { id: `bte_${"a".repeat(22)}`, bot: "bot_planted00001", to: lab.pub, delete: true, since: 1, at: 1, seal: "x".repeat(43) });
  // (And a refusal: not shown.)
  write(path.join(held, "refused.json"), { refused: [{ bot: wren, box: lab.pub, computer: "lab", message: "Planted.", at: Date.now() }], seal: "x".repeat(43) });
  assert.deepEqual((await listed()).refused, []);
  link.forgetHeldSends();
  link.sendHeld(host);
  assert.deepEqual(mailTo(lab).filter(each => each.botEdit.bot === "bot_planted00001"), []);
  assert.equal((await listed()).held.some(each => each.bot === "bot_planted00001"), false);
  // Lab not up to date yet: it waits until it is.
  agentsTold({ labFeatures: [] });
  link.forgetHeldSends();
  link.sendHeld(host);
  assert.deepEqual(mailTo(lab), []);
});

test("a bot that moved meanwhile: what's held for it goes to the computer it's on now", async () => {
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II" });
  const [toLab] = mailTo(lab);
  // Now the Mac lists it, and lab, whose word is older, still does.
  agentsTold({ macBots: [{ session: "ses_wren", name: "Wren", kind: "bot", id: wren }] });
  receive(lab, { botEdited: { id: toLab.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
  assert.equal((await listed()).held[0].computer, "Studio");
  const [toMac] = mailTo(mac);
  assert.deepEqual(toMac.botEdit.change, { name: "Wren II" });
  // And back to lab: the Mac, which says it isn't there, still lists it from before; it goes to lab.
  agentsTold({ macBots: [{ session: "ses_wren", name: "Wren", kind: "bot", id: wren }] });
  receive(mac, { botEdited: { id: toMac.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
  assert.equal((await listed()).held[0].computer, "lab");
});

test("the computer that keeps the bot does a held edit once, as Edit Bot would, and answers; a delete too", async () => {
  write(path.join(bots, "kit.json"), kit);
  const folder = path.join(bots, "bot_scout00001");
  write(path.join(folder, "MEMORY.md"), "# Scout's memory\n");
  write(path.join(folder, "session"), "ses_scout");
  write(path.join(folder, "bot.json"), { kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, model: { id: "big-pickle", providerID: "opencode" }, created: "2026-10-01T09:00:00Z" });
  const id = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id, bot: "bot_scout00001", change: { name: "Scout II" }, at: Date.now() } });
  const answer = async () => {
    for (;;) {
      const [mail] = mailTo(lab);
      if (mail) return mail.botEdited;
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  assert.deepEqual(await answer(), { id, bot: "bot_scout00001", status: 200 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout II");
  assert.equal(asked.filter(each => each.method === "PATCH" && each.url === "/api/session/ses_scout").at(-1)?.body?.title, "Scout II", "its conversation renamed");
  // Changed here since, then sent again (its answer lost): answered as it went, not done again.
  await route("PATCH", "kuvo/bots/bot_scout00001", { name: "Scout III" });
  receive(lab, { botEdit: { id, bot: "bot_scout00001", change: { name: "Scout II" }, at: Date.now() } });
  assert.deepEqual(await answer(), { id, bot: "bot_scout00001", status: 200 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout III");
  // One held elsewhere that you made before the change here (its Mac was offline): it doesn't undo
  // it, though its look, given later, lands; one you made after it does. (The change here, a moment
  // ago, as its folder notes it.)
  const edited = path.join(folder, "edited.json");
  write(edited, { ...JSON.parse(fs.readFileSync(edited, "utf8")), name: Date.now() - 30_000 });
  const older = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: older, bot: "bot_scout00001", change: { name: "Scout Old", look: { color: "mint", shape: "round", face: "happy" } }, ages: { name: 60_000, look: 1_000 }, at: Date.now() } });
  assert.equal((await answer()).status, 200);
  const now = JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8"));
  assert.deepEqual([now.name, now.look.face], ["Scout III", "happy"]);
  const newer = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: newer, bot: "bot_scout00001", change: { name: "Scout IV" }, ages: { name: 1_000 }, at: Date.now() } });
  assert.equal((await answer()).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout IV");
  // One with a bad field: the rest lands, and what didn't is said.
  const mixed = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: mixed, bot: "bot_scout00001", change: { name: "Scout V", personality: "preset.gone" }, ages: { name: 0, personality: 0 }, at: Date.now() } });
  const partly = await answer();
  assert.equal(partly.status, 200);
  assert.match(partly.message, /preset\.gone/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout V");
  // Its work settings never come this way.
  const work = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: work, bot: "bot_scout00001", change: { work: { limits: null, allowed: ["makeProject"] } }, at: Date.now() } });
  assert.equal((await answer()).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).work, undefined);
  // Refused: its words go back.
  const odd = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: odd, bot: "bot_scout00001", change: { personality: "preset.gone" }, at: Date.now() } });
  const refused = await answer();
  assert.equal(refused.status, 400);
  assert.match(refused.message, /preset\.gone/);
  // Deleted, as Delete Bot… deletes it.
  const gone = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id: gone, bot: "bot_scout00001", delete: true, at: Date.now() } });
  assert.equal((await answer()).status, 200);
  assert.equal(fs.existsSync(folder), false);
});

test("a computer that says the bot isn't there, with none listing it yet (it's on its way): asked again a few times before it's refused", async () => {
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II" });
  agentsTold({ labBots: [] });
  for (let round = 0; round < 2; round++) {
    const [toLab] = mailTo(lab);
    receive(lab, { botEdited: { id: toLab.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
    assert.equal((await listed()).held.length, 1, `still held after ${round + 1}`);
    assert.deepEqual((await listed()).refused, []);
    link.sendHeld(host, undefined, Date.now() + 61_000);
  }
  const [last] = mailTo(lab);
  receive(lab, { botEdited: { id: last.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
  assert.deepEqual((await listed()).held, []);
  assert.match((await listed()).refused[0].message, /lab didn’t take the changes/);
});

test("some of a held change taken, some not: let go, and what wasn't is said", async () => {
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II", personality: "preset.gone" });
  const [toLab] = mailTo(lab);
  receive(lab, { botEdited: { id: toLab.botEdit.id, bot: wren, status: 200, message: "There’s no personality “preset.gone”." } });
  const list = await listed();
  assert.deepEqual(list.held, []);
  assert.equal(list.refused[0].message, "lab didn’t take all the changes you made while it was away. There’s no personality “preset.gone”.");
});

test("only between your own computers: a machine that isn't only yours neither holds edits for one nor has them done here", async () => {
  // Lab says it's a machine two people's Macs share.
  agentsTold({ labFeatures: ["bots.held"] });
  const told = JSON.parse(fs.readFileSync(path.join(run, "peer-agents.json"), "utf8"));
  told[lab.pub].shared = true;
  write(path.join(run, "peer-agents.json"), told);
  const held = await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II" });
  assert.equal(held.status, 409);
  assert.match(held.body.message, /change it from lab/);
  // Nor does this box take one from it.
  write(path.join(bots, "kit.json"), kit);
  const folder = path.join(bots, "bot_scout00001");
  write(path.join(folder, "session"), "ses_scout");
  write(path.join(folder, "bot.json"), { kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z" });
  const id = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id, bot: "bot_scout00001", change: { name: "Taken" }, ages: { name: 0 }, at: Date.now() } });
  for (;;) {
    const [mail] = mailTo(lab);
    if (mail) {
      assert.equal(mail.botEdited.status, 403);
      break;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout");
});

test("when a bot's fields last changed goes with it to another computer, and the clock of the computer that held an edit doesn't count", async () => {
  write(path.join(bots, "kit.json"), kit);
  // Scout, just moved here: its folder says its name changed ten seconds ago where it was.
  const folder = path.join(bots, "bot_scout00001");
  write(path.join(folder, "session"), "ses_scout");
  write(path.join(folder, "bot.json"), { kuvo: 1, id: "bot_scout00001", name: "Scout Moved", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z" });
  write(path.join(folder, "edited.json"), { name: Date.now() - 10_000 });
  // An edit held for a minute by a computer whose clock is an hour ahead (as it says the time).
  const id = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id, bot: "bot_scout00001", change: { name: "Scout Old" }, ages: { name: 60_000 }, times: { name: Date.now() + 3_600_000 }, at: Date.now() + 3_600_000 } });
  for (;;) {
    const [mail] = mailTo(lab);
    if (mail) {
      assert.equal(mail.botEdited.status, 200);
      break;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout Moved", "the newer name stays");
  assert.ok(JSON.parse(fs.readFileSync(path.join(folder, "edited.json"), "utf8")).name <= Date.now(), "never a time ahead of this clock");
});

test("a computer that isn't only yours is never where a held edit goes, whatever its list says", async () => {
  await route("PATCH", `kuvo/bots/${wren}`, { name: "Wren II" });
  const [toLab] = mailTo(lab);
  // Lab says it isn't there; the Mac lists it, but says it's a machine two people's Macs share.
  agentsTold({ labBots: [], macBots: [{ session: "ses_wren", name: "Wren", kind: "bot", id: wren }] });
  const told = JSON.parse(fs.readFileSync(path.join(run, "peer-agents.json"), "utf8"));
  told[mac.pub].shared = true;
  write(path.join(run, "peer-agents.json"), told);
  receive(lab, { botEdited: { id: toLab.botEdit.id, bot: wren, status: 404, message: "That bot isn’t there any more." } });
  assert.equal((await listed()).held[0].computer, "lab");
  assert.deepEqual(mailTo(mac), []);
});

test("a held change its computer can't do now (its engine starting) waits on, rather than being refused for a field it can't take", async () => {
  write(path.join(bots, "kit.json"), kit);
  const folder = path.join(bots, "bot_scout00001");
  write(path.join(folder, "session"), "ses_scout");
  write(path.join(folder, "bot.json"), { kuvo: 1, id: "bot_scout00001", name: "Scout", job: "", look: { color: "sky", shape: "round", face: "calm" }, created: "2026-10-01T09:00:00Z" });
  // Its engine not started yet.
  fs.rmSync(path.join(run, "engine.json"));
  const id = `bte_${crypto.randomBytes(16).toString("base64url")}`;
  receive(lab, { botEdit: { id, bot: "bot_scout00001", change: { name: "Scout II", personality: "preset.gone" }, ages: { name: 0, personality: 0 }, at: Date.now() } });
  for (;;) {
    const [mail] = mailTo(lab);
    if (mail) {
      assert.equal(mail.botEdited.status, 503);
      break;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "bot.json"), "utf8")).name, "Scout");
});
