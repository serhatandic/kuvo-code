// Moves on your other computers (PROTOCOL.md, "Peers", `moving`, and `kuvo/moves`' `elsewhere`): a
// move between two machines (one a phone asked for, say) is seen on every box, so a client that
// follows one box (the Mac follows its own) sees it too. Each box tells its peers what it moves as
// that changes, again each minute while it moves, and once that it's over; each lists what its
// peers said, until they say it's over or go quiet a few minutes. One box, real (this Mac's), with
// two other computers, lab and pi: the mail it sends them goes by a stand-in relay connection, and
// theirs comes in as the relay would hand it on (`peerMail`). Its looks every few seconds are
// taken by the test, at the times it gives (`keepMoving`).
//
// Run with `node --test box/bridge-tests/moves-elsewhere.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { atEnd, removeAtEnd } from "./at-end.js";

// What's under way, as `kuvo/moves` says it (not what moved away lately, `moved`, which stays two days).
const underWay = ({ moved: _moved, ...rest } = {}) => rest;

// Each fails, rather than hangs, when what it waits for never comes.
const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);

const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-moves-elsewhere-")));
const home = path.join(support, "mac");
fs.mkdirSync(path.join(home, "run"), { recursive: true });
Object.assign(process.env, {
  KUVO_HOME: home, KUVO_BOTS: path.join(support, "bots"), KUVO_WAKES: path.join(support, "wakes"), KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"), KUVO_KEYS: path.join(support, "keys"),
});
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(support);

// This Mac's box, and its other computers, lab and pi (both machines), with their keys.
const computer = name => {
  const secret = link.newKey();
  return { secret, peer: { key: link.publicOf(secret).toString("base64url"), address: link.addressOf(crypto.randomBytes(32)).toString("base64url"), kind: "machine", name, id: name } };
};
const machines = [computer("lab"), computer("pi")];
const [lab, pi] = machines.map(each => each.peer);
link.writeLink({ macPeers: [lab, pi] });
const key = link.newKey();
link.macLink.overlay = { key: key.toString("base64url"), secret: crypto.randomBytes(32).toString("base64url"), relay: "wss://relay.test", name: "Studio Mac" };
const own = link.publicOf(key).toString("base64url");

// Its relay connection: what it takes, opened as each computer would open it (`told`, `{peer,
// moving}`). Down (`up` false), it takes nothing and says so (false), as one that's closing does.
const told = [];
let up = true;
const relay = {
  send(bytes) {
    if (!up) return false;
    const to = machines.find(each => bytes.subarray(1, 17).equals(Buffer.from(each.peer.address, "base64url")));
    const payload = JSON.parse(link.openOneWay(link.readFrame(bytes.subarray(17)).body, to.secret, link.publicOf(key)).payload.toString());
    if (payload.moving) told.push({ peer: to.peer.key, moving: payload.moving });
    return true;
  },
};
const stop = new AbortController();
link.watchMoves(() => relay, stop.signal);
atEnd(() => stop.abort());

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
  assert.deepEqual(underWay(await events.next()), { moves: [], away: [] });
  const leaving = move("mov_lp1", lab.key, pi.key, "from", "copying", { sent: 30_000, size: 90_000 });
  mail(lab, { moving: { moves: [leaving] } });
  assert.deepEqual(underWay(await ask("kuvo/moves")), { moves: [], away: [], elsewhere: [{ box: lab.key, moves: [leaving] }] });
  assert.deepEqual(underWay(await events.next()), { moves: [], away: [], elsewhere: [{ box: lab.key, moves: [leaving] }] }, "a client following this box hears it");
  const arriving = move("mov_lp1", lab.key, pi.key, "to", "copying");
  mail(pi, { moving: { moves: [arriving] } });
  const both = await ask("kuvo/moves");
  assert.deepEqual(both.elsewhere.sort((one, other) => one.box.localeCompare(other.box)), [{ box: lab.key, moves: [leaving] }, { box: pi.key, moves: [arriving] }].sort((one, other) => one.box.localeCompare(other.box)));
  // Lab switched to pi's copy and let its own go; then pi's done too.
  mail(lab, { moving: { moves: [] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: pi.key, moves: [arriving] }]);
  mail(pi, { moving: { moves: [] } });
  assert.deepEqual(underWay(await ask("kuvo/moves")), { moves: [], away: [] });
  events.stop();
});

test("what a computer said goes once it's been quiet a few minutes; what isn't a move is left out; a clock set back changes nothing", async () => {
  const one = move("mov_q1", lab.key, pi.key, "from", "holding");
  mail(lab, { moving: { moves: [one] } });
  assert.deepEqual(link.movesElsewhere(undefined, Date.now() + 60_000), [{ box: lab.key, moves: [one] }], "said a minute ago: still moving");
  assert.deepEqual(link.movesElsewhere(undefined, Date.now() + 4 * 60_000), [], "nothing said for four minutes: gone (lab went away mid-move)");
  // What isn't a move, or isn't a list of them, isn't taken; the moves that are, are.
  mail(lab, { moving: { moves: "all of them" } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [one] }]);
  const other = move("mov_q2", lab.key, pi.key, "from", "switching");
  mail(lab, { moving: { moves: [{ ...one, stage: "flying" }, { ...one, id: 7 }, { ...one, sessions: "ses_x" }, other] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }]);
  // A move to or from this box is this box's own to show (in `moves`, as it hears of it): what lab
  // says of one isn't listed, so one that ended here never shows as moving while lab's word that
  // it's over is on its way.
  mail(lab, { moving: { moves: [other, move("mov_q3", lab.key, own, "from", "holding"), move("mov_q4", own, lab.key, "to", "copying")] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }]);
  mail(pi, { moving: { moves: [move("mov_q5", own, pi.key, "to", "copying")] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }], "pi, with only a move from here, isn't listed");
  mail(pi, { moving: { moves: [] } });
  // Mail from a computer that isn't one of yours isn't kept.
  const stranger = computer("stranger").peer;
  mail(stranger, { moving: { moves: [one] } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [other] }]);
  // Lab's clock is set back an hour mid-move: what it says after is still taken, and its word that
  // it's over ends it.
  const finishing = { ...other, stage: "finishing" };
  link.peerMail(lab, { moving: { moves: [finishing] }, at: clock - 3_600_000 }, null);
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: lab.key, moves: [finishing] }]);
  link.peerMail(lab, { moving: { moves: [] }, at: clock - 3_599_000 }, null);
  assert.equal((await ask("kuvo/moves")).elsewhere, undefined);
});

test("a computer gone quiet mid-move: a client following this box hears its move go, at the look after the few minutes", async () => {
  const events = follow();
  assert.deepEqual(underWay(await events.next()), { moves: [], away: [] });
  const one = move("mov_g1", lab.key, pi.key, "from", "copying");
  mail(lab, { moving: { moves: [one] } });
  assert.deepEqual(underWay(await events.next()), { moves: [], away: [], elsewhere: [{ box: lab.key, moves: [one] }] });
  // A look within the few minutes changes nothing; the one after them tells it's gone (a client
  // reading lab meanwhile reads it until then, and no longer).
  link.keepMoving(Date.now() + 60_000);
  link.keepMoving(Date.now() + 4 * 60_000);
  assert.deepEqual(underWay(await events.next()), { moves: [], away: [] });
  assert.deepEqual(underWay(await ask("kuvo/moves")), { moves: [], away: [] });
  events.stop();
});

// A move under way here, as this box keeps it: a copy coming from lab (which nothing here touches
// while the test looks).
const coming = (stage, extra = {}) => writeRecord({ id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: lab.key, to: own, role: "to", stage,
  sessions: ["ses_here1"], peer: lab.key, wasPaused: false, tries: 0, started: Date.now(), ...extra });
const shown = (stage, extra = {}) => ({ id: "mov_here1", kind: "chat", thing: "ses_here1", name: "Trip plans", from: lab.key, to: own, role: "to", stage, sessions: ["ses_here1"], ...extra });

test("this box tells each of your computers what it moves at its next look: as it changes, each minute while it moves, and once that it's over", async () => {
  const start = Date.now() + 10_000;
  told.length = 0;
  link.keepMoving(start);
  assert.deepEqual(told, [], "nothing moving here: nothing said");
  coming("copying");
  link.keepMoving(start + 1_000);
  assert.deepEqual(told.map(each => each.peer).sort(), [lab.key, pi.key].sort(), "every computer told");
  assert.deepEqual(told.map(each => each.moving), [{ moves: [shown("copying")] }, { moves: [shown("copying")] }]);
  told.length = 0;
  link.keepMoving(start + 2_000);
  assert.deepEqual(told, [], "nothing changed: nothing said");
  // How much of its copy came isn't news; going a stage on is.
  coming("copying", { sent: 50, size: 100 });
  link.keepMoving(start + 3_000);
  assert.deepEqual(told, []);
  coming("switching", { sent: 50, size: 100 });
  link.keepMoving(start + 4_000);
  assert.deepEqual(told.map(each => each.moving.moves[0].stage), ["switching", "switching"]);
  told.length = 0;
  // A minute on, still moving: said again (a computer that started again since, or missed it, learns).
  link.keepMoving(start + 30_000);
  assert.deepEqual(told, []);
  link.keepMoving(start + 65_000);
  assert.deepEqual(told.map(each => each.moving), [{ moves: [shown("switching", { sent: 50, size: 100 })] }, { moves: [shown("switching", { sent: 50, size: 100 })] }]);
  // What it says is what another box takes: said to this box as pi's word (as a move between pi
  // and lab, so it isn't this box's own), it's listed as pi's.
  const asPis = told[0].moving.moves.map(each => ({ ...each, from: lab.key, to: pi.key }));
  mail(pi, { moving: { moves: asPis } });
  assert.deepEqual((await ask("kuvo/moves")).elsewhere, [{ box: pi.key, moves: asPis }]);
  mail(pi, { moving: { moves: [] } });
  // It's over: said once, then nothing more.
  told.length = 0;
  fs.rmSync(path.join(movesFolder, "mov_here1.json"));
  link.keepMoving(start + 66_000);
  assert.deepEqual(told.map(each => each.moving), [{ moves: [] }, { moves: [] }]);
  told.length = 0;
  link.keepMoving(start + 67_000);
  link.keepMoving(start + 300_000);
  assert.deepEqual(told, []);
});

test("what its relay connection didn't take is said again at the next look, and a computer that just connected hears it at once", () => {
  const start = Date.now() + 400_000;
  told.length = 0;
  // The connection's closing (or not welcomed yet): nothing goes, and it's tried again. (Lab quiet
  // all that while, the copy says it's waiting for it.)
  up = false;
  coming("copying");
  const waiting = { moves: [shown("copying", { waiting: true })] };
  link.keepMoving(start);
  link.keepMoving(start + 3_000);
  assert.deepEqual(told, []);
  up = true;
  link.keepMoving(start + 6_000);
  assert.deepEqual(told.map(each => each.moving), [waiting, waiting]);
  told.length = 0;
  // Pi connects (it asks for agents): it's told at the next look, not a minute on.
  link.peerMail(pi, { ask: "agents", at: ++clock }, null);
  link.keepMoving(start + 9_000);
  assert.deepEqual(told.map(each => each.moving), [waiting, waiting]);
  told.length = 0;
  // Its last word lost too (the connection closing): said once it's back.
  fs.rmSync(path.join(movesFolder, "mov_here1.json"));
  up = false;
  link.keepMoving(start + 12_000);
  up = true;
  link.keepMoving(start + 15_000);
  assert.deepEqual(told.map(each => each.moving), [{ moves: [] }, { moves: [] }]);
});
