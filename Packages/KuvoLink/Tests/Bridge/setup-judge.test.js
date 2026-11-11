// Already in a setup? (PROTOCOL.md, "Your setup", "Already in a setup?"): what's on a computer,
// judged by the box. A Mac adding a computer over SSH sends what its probe found there
// (`POST kuvo/setup/judge`), and this Mac's box says one verdict: this very Mac, nothing anyone's,
// one of ours, an older box another Mac set up, a member of another setup (however long its main
// computer's been unheard of), the main computer of another, or boxes of two setups on one computer.
// And Kuvo Code, opening on a Mac (`kuvo-link.js here`), uses its own box, or the one already on
// that Mac, in place: never a second one.
//
// This Mac's box is the link in this process (`KUVO_BOX=mac`), leading a setup with its machine lab;
// what's on other computers is cards and link.json fields as their boxes write them. `here` runs as
// the app runs it, a process of its own, in a home folder of the test's own.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/setup-judge.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const vector = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../Vectors/setup/probe.json", import.meta.url)), "utf8"));
const support = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-setup-judge-")));
removeAtEnd(support);
const home = path.join(support, "box");
Object.assign(process.env, {
  KUVO_HOME: home,
  KUVO_BOX: "mac",
  KUVO_ENGINE_CONFIG: path.join(support, "opencode"),
  KUVO_BOTS: path.join(support, "bots"),
  KUVO_WAKES: path.join(support, "wakes"),
});
const link = await import(script);
const run = path.join(home, "run");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

const k = key => key.toString("base64url");
const box = (kind, name) => {
  const key = link.newKey();
  const address = k(link.addressOf(crypto.randomBytes(32)));
  return { key, pub: k(link.publicOf(key)), peer: { key: k(link.publicOf(key)), address, name, kind, sign: link.signingKeyOf(link.newSigningSeed()), id: name } };
};
const self = box("mac", "Studio"), lab = box("machine", "lab"), imac = box("mac", "iMac"), mini = box("machine", "Mini");
link.macLink.overlay = { key: k(self.key), secret: k(crypto.randomBytes(32)), sign: link.newSigningSeed(), relay: "wss://relay.test", name: "Studio" };
link.macLink.config = { phones: false, machines: true, relay: "wss://relay.test", name: "Studio", app: "0.9.0" };

const handle = link.engineHandler(() => ({ port: 1, password: "p" }));
async function judge(probe) {
  const pieces = [];
  for await (const piece of handle({ method: "POST", path: "kuvo/setup/judge", headers: {}, body: Buffer.from(JSON.stringify({ probe })), fromApp: true }, undefined)) pieces.push(piece);
  return { status: pieces.find(each => each.head).head.status, json: JSON.parse(Buffer.concat(pieces.filter(each => each.body).map(each => each.body)).toString() || "null") };
}
// A card as a box writes it (setup/card.ts).
const card = (fields = {}) => ({ setup: null, epoch: null, role: null, primary: null, self: { key: mini.pub, name: "Mini", kind: "machine" }, app: false, computers: 0, items: 0, heldBy: [], macs: [], ...fields });
const otherSetup = "set_" + "o".repeat(22);
const DAY = 86_400_000;

let ours;
before(() => {
  // This Mac leads a setup with lab, as it would once lab said it isn't shared.
  write(path.join(run, "work-queue", "numbers.json"), { primary: "self", next: 12, leases: [], since: 1_000 });
  link.writeLink({ phones: [], macPeers: [lab.peer], macMoved: [] });
  write(path.join(run, "work-queue", "peers", `${lab.pub}.json`), { id: "wqt_labtoldlabtold", at: 1, heard: 1, kind: "machine", since: 50, items: [], owners: [], categories: [], primary: { key: self.pub, kind: "mac", since: 1_000 }, shared: false });
  link.noteSetupNow(Date.now(), { soon: 0 });
  ours = link.readLink().setup.id;
  assert.ok(ours);
});

test("each verdict, as a Mac adding a computer hears it: nothing there, one of ours, this very Mac, a member of another setup (its main computer unheard of for weeks: still not free), another setup's main computer, a machine other Macs share, a lone box", async () => {
  const one = (fields, folder = ".kuvo-code", kind = "machine") => `box ${kind} ${folder}\ncard ${JSON.stringify(card(fields))}`;
  const verdict = async probe => {
    const judged = await judge(probe);
    assert.equal(judged.status, 200);
    return judged.json;
  };
  assert.deepEqual(await verdict(""), { verdict: "free", boxes: [] }, "nothing there: added as ever");
  assert.equal((await verdict("Linux x86_64\nglibc\nsomething else\n")).verdict, "free", "the probe's other lines are left alone");

  assert.equal((await verdict(one({ setup: ours, role: "member", self: { key: lab.pub, name: "lab", kind: "machine" } }))).verdict, "ours", "lab, in this setup");
  assert.equal((await verdict(one({ self: { key: lab.pub, name: "lab", kind: "machine" } }))).verdict, "ours", "lab, set aside: still one this Mac set up");
  assert.equal((await verdict(one({ setup: ours, role: "primary", self: { key: self.pub, name: "Studio", kind: "mac" }, app: true }, "Library/Application Support/run.kuvo.code/box", "app"))).verdict, "self", "this very Mac's own box");

  const member = await verdict(one({ setup: otherSetup, epoch: 1, role: "member", primary: { key: imac.pub, name: "iMac", heard: Date.now() - 40 * DAY }, computers: 3, items: 12, macs: [{ key: imac.pub, name: "iMac" }] }));
  assert.equal(member.verdict, "elsewhere", "a member of iMac's setup, though iMac's been unheard of for 40 days: never free");
  assert.deepEqual({ ...member.boxes[0], primary: { ...member.boxes[0].primary, heard: "…" } }, {
    folder: ".kuvo-code", app: false, verdict: "elsewhere", key: mini.pub, name: "Mini", kind: "machine", setup: otherSetup, role: "member",
    primary: { key: imac.pub, name: "iMac", heard: "…" }, macs: [{ key: imac.pub, name: "iMac" }], computers: 3, items: 12,
  });

  const main = await verdict(one({ setup: otherSetup, epoch: 1, role: "primary", primary: { key: imac.pub, name: "iMac", heard: null }, self: { key: imac.pub, name: "iMac", kind: "mac" }, app: true, computers: 3, items: 37 }, "Library/Application Support/run.kuvo.code/box", "app"));
  assert.equal(main.verdict, "main", "iMac runs Kuvo Code for 2 more computers");
  assert.deepEqual([main.boxes[0].computers, main.boxes[0].items, main.boxes[0].name], [3, 37, "iMac"]);
  assert.equal((await verdict(one({ setup: otherSetup, epoch: 1, role: "primary", primary: { key: mini.pub, name: "vps", heard: null }, computers: 1, items: 4 }))).verdict, "main", "a lone box leading a setup of its own");
  assert.equal((await verdict(one({ self: { key: imac.pub, name: "iMac", kind: "mac" }, app: true }, "Library/Application Support/run.kuvo.code/box", "app"))).verdict, "main", "a Mac whose app runs it, in no setup yet");

  assert.equal((await verdict(one({ macs: [{ key: imac.pub, name: "iMac" }, { key: box("mac", "Air").pub, name: "Air" }] }))).verdict, "elsewhere", "a machine other Macs share, in no setup: theirs");
  assert.equal((await verdict(one({ macs: [{ key: imac.pub, name: "iMac" }, { key: self.pub, name: "Studio" }] }))).verdict, "ours", "one this Mac shares with iMac: ours already");
  assert.equal((await verdict(one({}))).verdict, "free", "a box no Mac set up, leading nothing (its Mac let it go)");
  assert.equal((await verdict(one({ setup: otherSetup, role: "member", primary: { key: imac.pub, name: "iMac", heard: 1 }, self: { key: lab.pub, name: "lab", kind: "machine" } }))).verdict, "elsewhere",
    "lab, still among this Mac's machines, but a member of iMac's setup now: not one to set up again as ours");

  assert.equal((await judge(undefined)).status, 400);
});

test("an older box, with no card, is judged by its link.json: set up from iMac, it needs an update first; set up from this Mac, it's ours; one ~/.kuvo-code and an app's box of another setup on one computer are two", async () => {
  // The probe's lines for an older ~/.kuvo-code (iMac and another Mac set it up) and Kuvo Code's own
  // box beside it, the main computer of another setup (the same lines OpenCodeKit's probe prints).
  const two = (await judge(vector.lines.join("\n"))).json;
  assert.equal(two.verdict, "two");
  const [older, app] = two.boxes;
  assert.equal(older.verdict, "older");
  assert.deepEqual([older.folder, older.app, older.key, older.primary?.name, older.primary?.heard], [".kuvo-code", false, null, "iMac", 1762800000000], "set up from iMac, last heard then");
  assert.deepEqual(older.macs.map(each => each.name), ["iMac", 'Studio "Office"']);
  assert.deepEqual([app.verdict, app.folder, app.app, app.items], ["main", "Library/Application Support/run.kuvo.code/box", true, 37]);

  const lines = [`box machine .kuvo-code`, `link mac ${imac.pub}`, `link macs ${imac.pub}`, "link phones none"];
  assert.equal((await judge(lines.join("\n"))).json.verdict, "older");
  assert.equal((await judge([...lines, `link macs ${self.pub}`].join("\n"))).json.verdict, "ours", "this Mac set it up too");
  assert.equal((await judge("box machine .kuvo-code\nlink phones some")).json.verdict, "older", "a lone box paired with a phone: it can't say its setup yet");
  assert.equal((await judge("box machine .kuvo-code\nlink phones none")).json.verdict, "free", "one no Mac counts any more");
  // Kuvo Code's own box on a Mac, from before cards: it runs Kuvo Code, never free.
  assert.equal((await judge("box app Library/Application Support/run.kuvo.code/box")).json.verdict, "older");
  assert.equal((await judge("box app Library/Application Support/run.kuvo.code/box\nlink phones none")).json.verdict, "older");
  // The last Mac to set it up is the one named, wherever its line comes.
  const newest = box("mac", "Newest");
  const last = (await judge(["box machine .kuvo-code", `link macs ${imac.pub}`, `link macs ${newest.pub}`, `link mac ${newest.pub}`, `link name ${newest.pub} "Newest"`].join("\n"))).json.boxes[0];
  assert.equal(last.primary.key, newest.pub);
});

test("the probe's lines are what a box's link.json says: a box writes it as the probe reads it", () => {
  const folder = path.join(support, "older");
  const written = spawnSync(process.execPath, ["--input-type=module", "-e", `const link = await import(${JSON.stringify(script)}); link.writeLink(JSON.parse(process.env.LINK));`],
    { env: { PATH: process.env.PATH, HOME: support, TMPDIR: support, KUVO_HOME: folder, LINK: JSON.stringify(vector.link) }, encoding: "utf8" });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(fs.readFileSync(path.join(folder, "run", "link.json"), "utf8"), vector.files[".kuvo-code/run/link.json"]);
});

// Kuvo Code opening on a Mac, in a home of the test's own: its own box in its app folder, and the
// one in ~/.kuvo-code.
function here(setUp, { root = ".kuvo-code", own = true } = {}) {
  const mac = fs.mkdtempSync(path.join(support, "mac-"));
  const appBox = path.join(mac, "Library", "Application Support", "run.kuvo.code", "box");
  setUp({ machine: path.join(mac, ".kuvo-code", "run"), app: path.join(appBox, "run"), appBox });
  const result = spawnSync(process.execPath, [script, "here", ...(root ? [root] : [])], { env: { PATH: process.env.PATH, HOME: mac, TMPDIR: support, ...(own ? { KUVO_HOME: appBox } : {}) }, encoding: "utf8" });
  if (result.status === 2) return { refused: result.stderr };
  assert.equal(result.status, 0, result.stderr);
  return { said: JSON.parse(result.stdout), appBox };
}

test("Kuvo Code opening on your Mac mini, which MacBook set up: it attaches to the box that's there, in place, and makes none of its own; its main computer long unheard of changes nothing", () => {
  const macbook = box("mac", "MacBook");
  const { said, appBox } = here(({ machine }) => {
    write(path.join(machine, "setup-card.json"), card({ setup: otherSetup, epoch: 1, role: "member", primary: { key: macbook.pub, name: "MacBook", heard: Date.now() - 60 * DAY }, computers: 2, items: 9, macs: [{ key: macbook.pub, name: "MacBook" }] }));
    write(path.join(machine, "link.json"), JSON.stringify({ mac: macbook.pub, macs: [macbook.pub] }, null, 2));
  });
  assert.deepEqual([said.verdict, said.use, said.own], ["elsewhere", "attach", null]);
  assert.deepEqual([said.box.folder, said.box.primary.name, said.box.role, said.box.setup], [".kuvo-code", "MacBook", "member", otherSetup]);
  assert.equal(fs.existsSync(appBox), false, "no box of its own made, not even its folder");
  assert.equal(fs.existsSync(path.dirname(appBox)), false);

  // An older box there, with no card: still the box it uses.
  const older = here(({ machine }) => write(path.join(machine, "link.json"), JSON.stringify({ mac: macbook.pub, macs: [macbook.pub], macNames: { [macbook.pub]: "MacBook" }, phones: [] }, null, 2))).said;
  assert.deepEqual([older.verdict, older.use, older.box.primary.name], ["older", "attach", "MacBook"]);
  // One no one's member (its Mac let it go): used in place all the same.
  const lone = here(({ machine }) => write(path.join(machine, "setup-card.json"), card({}))).said;
  assert.deepEqual([lone.verdict, lone.use], ["free", "attach"]);
  // Attached, the app wrote its own files in its folder (its machines' list, the integrations'
  // catalog), with no box of its own run there: still the one box here.
  const after = here(({ appBox, machine }) => {
    write(path.join(machine, "setup-card.json"), card({ setup: otherSetup, role: "member", primary: { key: macbook.pub, name: "MacBook", heard: 1 } }));
    write(path.join(appBox, "machines.json"), "[]");
    write(path.join(appBox, "bin", "integrations.json"), "{}");
    fs.mkdirSync(path.join(appBox, "run"), { recursive: true });
  }).said;
  assert.deepEqual([after.verdict, after.use], ["elsewhere", "attach"]);
});

test("Kuvo Code opening where it has its own box: it goes on using it, with nothing else here, beside a ~/.kuvo-code of its own setup, or beside another's (two boxes, settled later), and an app from before cards keeps its own too", () => {
  const ownCard = card({ setup: ours, epoch: 1, role: "primary", primary: { key: self.pub, name: "Studio", heard: null }, self: { key: self.pub, name: "Studio", kind: "mac" }, app: true, computers: 2 });
  const alone = here(({ app }) => write(path.join(app, "setup-card.json"), ownCard)).said;
  assert.deepEqual([alone.verdict, alone.use, alone.box, alone.own.folder], ["free", "own", null, "Library/Application Support/run.kuvo.code/box"]);

  const withOurs = here(({ app, machine }) => {
    write(path.join(app, "setup-card.json"), ownCard);
    write(path.join(machine, "setup-card.json"), card({ setup: ours, role: "member" }));
  }).said;
  assert.deepEqual([withOurs.verdict, withOurs.use], ["ours", "own"]);

  const two = here(({ app, machine }) => {
    write(path.join(app, "setup-card.json"), ownCard);
    write(path.join(machine, "setup-card.json"), card({ setup: otherSetup, role: "member", primary: { key: imac.pub, name: "iMac", heard: 1 } }));
  }).said;
  assert.deepEqual([two.verdict, two.use, two.box.primary.name], ["two", "own", "iMac"]);

  // The app ran its box before, as a version from before cards: no card, its start's record there.
  const before = here(({ appBox, machine }) => {
    write(path.join(appBox, "run", "serve.json"), { port: 1 });
    write(path.join(machine, "setup-card.json"), card({ setup: otherSetup, role: "member", primary: { key: imac.pub, name: "iMac", heard: 1 } }));
  }).said;
  assert.deepEqual([before.verdict, before.use], ["two", "own"], "never taken from an app that works now");
});

test("here is told where the app's own box is and which folder is the machines', never guesses: without either it says so and stops", () => {
  const noRoot = here(() => {}, { root: "" });
  assert.match(noRoot.refused ?? "", /KUVO_HOME/);
  const noHome = here(({ machine }) => write(path.join(machine, "setup-card.json"), card({})), { own: false });
  assert.match(noHome.refused ?? "", /KUVO_HOME/, "never taken for an app with no box of its own");
});
