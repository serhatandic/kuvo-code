// Moves on your other computers (PROTOCOL.md, "Peers", `moving`, and `kuvo/moves`' `elsewhere`): a
// move between two machines (one a phone asked for, say) is seen on every box, so a client that
// follows one box (the Mac follows its own) sees it too. Each box tells its peers what it moves as
// that changes, again each minute while it moves, and once that it's over; each lists what its
// peers said, until they say it's over or go quiet a few minutes. One box, real (this Mac's), with
// two other computers, lab and pi, whose mail it sends goes to the test instead
// (`sendMovingWith`), and whose mail comes in as the relay would hand it on (`peerMail`).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/moves-elsewhere.test.js`.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// Each fails, rather than hangs, when what it waits for never comes.
const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-moves-elsewhere-")));
const home = path.join(support, "mac");
fs.mkdirSync(path.join(home, "run"), { recursive: true });
Object.assign(process.env, {
  KUVO_HOME: home, KUVO_BOTS: path.join(support, "bots"), KUVO_WAKES: path.join(support, "wakes"), KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(support);

// This Mac's box, and its other computers, lab and pi (both machines).
const computer = name => ({ key: link.publicOf(link.newKey()).toString("base64url"), address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name, id: name });
const lab = computer("lab"), pi = computer("pi");
link.writeLink({ macPeers: [lab, pi] });
const key = link.newKey();
link.macLink.overlay = { key: key.toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "Studio Mac" };
const own = link.publicOf(key).toString("base64url");

// What this box told each computer of its moves.
const told = [];
link.sendMovingWith((peer, moving) => {
  told.push({ peer, moving });
  return true;
});
atEnd(() => link.sendMovingWith(null));

const handle = link.engineHandler(link.readEngineFile, { name: "Mac" }, link.readBridgeFile, () => {}, null);
async function ask(p) {
  const parts = [];
  for await (const part of handle({ method: "GET", path: p, headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, undefined)) parts.push(part);
  return JSON.parse(Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString());
}

// `kuvo/moves/events`, followed as a client follows it: its next line, as it comes.
function follow() {
  const stop = new AbortController();
  const lines = handle({ method: "GET", path: "kuvo/moves/events", headers: {}, body: Buffer.alloc(0), fromApp: true }, {}, stop.signal)[Symbol.asyncIterator]();
  atEnd(() => stop.abort());
  return {
    async next() {
      for (;;) {
        const { value, done } = await lines.next();
        assert.ok(!done, "it stopped following");
        if (value.body) return JSON.parse(value.body.toString());
        assert.equal(value.head?.status, 200);
      }
    },
    stop: () => stop.abort(),
  };
}

// A move as a box shows it.
const move = (id, from, to, role, stage, extra = {}) => ({ id, kind: "chat", thing: `ses_${id.slice(4)}`, name: "Trip plans", from, to, role, stage, sessions: [`ses_${id.slice(4)}`], ...extra });
let clock = Date.now();
// Mail from `sender`, as the relay hands it on (each later than the last).
const mail = (sender, payload) => link.peerMail(sender, { ...payload, at: ++clock }, null);

const movesFolder = path.join(home, "run", "moves");
function writeRecord(record) {
  fs.mkdirSync(movesFolder, { recursive: true });
  fs.writeFileSync(path.join(movesFolder, `${record.id}.json`), JSON.stringify(record));
}

test("a move between two other computers shows here as they say it, and goes once each says it's over", async () => {
  const events = follow();
  assert.deepEqual(await events.next(), { moves: [], away: [] });
  const leaving = move("mov_lp1", lab.key, pi.key, "from", "copying", { sent: 30_000, size: 90_000 });
  mail(lab, { moving: { moves: [leaving] } });
  assert.deepEqual(await ask("kuvo/moves"), { moves: [], away: [], elsewhere: [{ box: lab.key, moves: [leaving] }] });
  assert.deepEqual(await events.next(), { moves: [], away: [], elsewhere: [{ box: lab.key, moves: [leaving] }] }, "a client following this box hears it");
  const arriving = move("mov_lp1", lab.key, pi.key, "to", "copying");
  mail(pi, { moving: { moves: [arriving] } });
  const both = await ask("kuvo/moves");
  assert.deepEqual(both.elsewhere.sort((one, other) => one.box.localeCompare(other.box)), [{ box: lab.key, moves: [leaving] }, { box: pi.key, moves: [arriving] }].sort((one, other) => one.box.localeCompare(other.box)));
  // Lab switched to pi's copy and let its own go; then pi's done too.
  mail(lab, { moving: { moves: [] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: pi.key, moves: [arriving] }]);
  mail(pi, { moving: { moves: [] } });
  assert.deepEqual(await ask("kuvo/moves"), { moves: [], away: [] });
  events.stop();
});

test("what a computer said goes once it's been quiet a few minutes; late mail and what isn't a move are left out", async () => {
  const one = move("mov_q1", lab.key, pi.key, "from", "holding");
  mail(lab, { moving: { moves: [one] } });
  assert.deepEqual(link.movesElsewhere(undefined, Date.now() + 60_000), [{ box: lab.key, moves: [one] }], "said a minute ago: still moving");
  assert.deepEqual(link.movesElsewhere(undefined, Date.now() + 4 * 60_000), [], "nothing said for four minutes: gone (lab went away mid-move)");
  // Mail that came late (older than what lab last said) changes nothing.
  link.peerMail(lab, { moving: { moves: [] }, at: clock - 10 }, null);
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [one] }]);
  // What isn't a move, or isn't a list of them, isn't taken; the moves that are, are.
  mail(lab, { moving: { moves: "all of them" } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [one] }]);
  const other = move("mov_q2", lab.key, own, "from", "switching");
  mail(lab, { moving: { moves: [{ ...one, stage: "flying" }, { ...one, id: 7 }, { ...one, sessions: "ses_x" }, other] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }]);
  // Mail from a computer that isn't one of yours isn't kept.
  const stranger = computer("stranger");
  mail(stranger, { moving: { moves: [one] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }]);
  mail(lab, { moving: { moves: [] } });
  assert.equal((await ask("kuvo/moves")).elsewhere, undefined);
});

test("this box tells each of your computers what it moves: as it changes, each minute while it moves, and once that it's over", async () => {
  const start = Date.now();
  told.length = 0;
  link.tellMoving(start);
  assert.deepEqual(told, [], "nothing moving here: nothing said");
  writeRecord({ id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: own, to: lab.key, role: "from", stage: "holding", sessions: ["ses_here1"],
    peer: lab.key, wasPaused: false, tries: 0, started: start });
  link.tellMoving(start + 1_000);
  const holding = { id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: own, to: lab.key, role: "from", stage: "holding", sessions: ["ses_here1"] };
  assert.deepEqual(told.map(each => each.peer).sort(), [lab.key, pi.key].sort(), "every computer told");
  assert.deepEqual(told.map(each => each.moving), [{ moves: [holding] }, { moves: [holding] }]);
  told.length = 0;
  link.tellMoving(start + 2_000);
  assert.deepEqual(told, [], "nothing changed: nothing said");
  // Its copy on its way: said once; how much went since isn't said each time.
  writeRecord({ id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: own, to: lab.key, role: "from", stage: "copying", sessions: ["ses_here1"],
    peer: lab.key, wasPaused: false, tries: 0, started: start, sent: 10, size: 100 });
  link.tellMoving(start + 3_000);
  assert.deepEqual(told.map(each => each.moving.moves[0].stage), ["copying", "copying"]);
  told.length = 0;
  writeRecord({ id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: own, to: lab.key, role: "from", stage: "copying", sessions: ["ses_here1"],
    peer: lab.key, wasPaused: false, tries: 0, started: start, sent: 50, size: 100 });
  link.tellMoving(start + 4_000);
  assert.deepEqual(told, []);
  // A minute on, still moving: said again (a computer that started again since, or missed it, learns).
  link.tellMoving(start + 64_000);
  assert.deepEqual(told.map(each => each.moving.moves[0].sent), [50, 50]);
  // What it says is what another box takes: said to this box as pi's word, it's listed as pi's.
  mail(pi, { moving: told[0].moving });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: pi.key, moves: told[0].moving.moves }]);
  mail(pi, { moving: { moves: [] } });
  // It's over: said once, then nothing more.
  told.length = 0;
  fs.rmSync(path.join(movesFolder, "mov_here1.json"));
  link.tellMoving(start + 65_000);
  assert.deepEqual(told.map(each => each.moving), [{ moves: [] }, { moves: [] }]);
  told.length = 0;
  link.tellMoving(start + 66_000);
  link.tellMoving(start + 200_000);
  assert.deepEqual(told, []);
});
