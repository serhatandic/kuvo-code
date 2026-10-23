// A box updating itself (PROTOCOL.md, "Updates"): only what a pinned key signed, only newer, and
// back to what it had when the new version doesn't come up. Run here, in a folder of the test's
// own, against a release served on localhost, with a stand-in engine and keeper (the real ones
// need Linux); the new link's self-test is the real one.
// Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-updates-"));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-release-"));
const engines = new Set();
after(() => {
  for (const pid of engines) try { process.kill(pid); } catch {}
  stopEngine();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

// The engine: answers as one does, notes itself as the keeper's start does, runs until stopped.
const fakeEngine = path.join(scratch, "engine.mjs");
fs.writeFileSync(fakeEngine, `
import fs from "node:fs"; import http from "node:http"; import path from "node:path";
const [version, root] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: request.url.startsWith("/api/session/active") ? {} : [] }));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(root, "run", "engine.json"),
  JSON.stringify({ pid: process.pid, port: server.address().port, password: "pw", version, notes: { mac: "mac-1" } })));
// Gone with the test's folder, however late an update in the background started it.
setInterval(() => { if (!fs.existsSync(root)) process.exit(0); }, 300);
`);
process.env.FAKE_ENGINE = fakeEngine;
const engineBinary = version => `#!/bin/sh
case "$1" in --version) echo ${version}; exit 0 ;; *.js) exec node "$@" ;; esac
exec node "$FAKE_ENGINE" ${version} "$KUVO_HOME"
`;
// The keeper: stops the engine (waiting until it's gone, as the real one does), or starts this
// version's. One that `breaks` starts none, and leaves the journal a new engine would (WAL) beside
// the database.
const keeper = (version, breaks = false) => `#!/bin/sh
K="$KUVO_HOME"; R="$K/run"
case "$1" in
stop) touch "$R/stopped"; pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$R/engine.json" 2>/dev/null); if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; fi; rm -f "$R/engine.json" ;;
start) rm -f "$R/stopped"; ${breaks ? `mkdir -p "$K/data/opencode"; echo "the new engine's journal" > "$K/data/opencode/opencode.db-wal"` : `"$K/engine/${version}/opencode" serve >/dev/null 2>&1 &`} ;;
esac
`;

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}
const sha256 = data => crypto.createHash("sha256").update(data).digest("hex");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const engineFile = path.join(home, "run", "engine.json");

function stopEngine() {
  try { process.kill(read(engineFile).pid); } catch {}
  fs.rmSync(engineFile, { force: true });
}

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`never: ${what}`);
}

// A machine on 0.9.0, its engine 1.0.0 running.
async function machine() {
  stopEngine();
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  write(path.join(home, "bin", "box-version"), "0.9.0");
  write(path.join(home, "bin", "kuvo-start"), keeper("1.0.0"), 0o700);
  write(path.join(home, "bin", "kuvo-link.js"), "// the old link\n", 0o600);
  write(path.join(home, "bin", "kuvo-wake"), "# the old wake-ups\n", 0o755);
  write(path.join(home, "bin", ".own", "kuvo-wake"), "# the old wake-ups\n", 0o755);
  write(path.join(home, "engine", "1.0.0", "opencode"), engineBinary("1.0.0"), 0o755);
  write(path.join(home, "data", "opencode", "opencode.db"), "the old engine's data");
  spawnSync("sh", [path.join(home, "bin", "kuvo-start"), "start"], { env: process.env });
  await waitFor(() => fs.existsSync(engineFile), "the old engine runs");
  engines.add(read(engineFile).pid);
}

// A release of 0.10.0 (engine 1.1.0), signed with `key`, served here; `pack` changes what's packed.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const pinned = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
let served = {};
const server = http.createServer((request, response) => {
  const body = served[request.url];
  response.writeHead(body ? 200 : 404);
  response.end(body ?? "");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

function release({ version = "0.10.0", released = new Date(Date.now() - 10 * 86_400_000), breaks = false, tamper = false, key = privateKey } = {}) {
  const files = path.join(scratch, `files-${crypto.randomUUID()}`);
  write(path.join(files, "bin", "box-version"), version);
  write(path.join(files, "bin", "kuvo-start"), keeper("1.1.0", breaks), 0o700);
  write(path.join(files, "bin", "kuvo-link.js"), fs.readFileSync(script, "utf8"), 0o600);
  write(path.join(files, "bin", "kuvo-wake"), "# the new wake-ups\n", 0o755);
  const box = { version, engine: "1.1.0", files: {} };
  for (const file of ["bin/box-version", "bin/kuvo-start", "bin/kuvo-link.js", "bin/kuvo-wake"]) box.files[file] = sha256(fs.readFileSync(path.join(files, file)));
  write(path.join(files, "box.json"), JSON.stringify(box));
  const pack = path.join(scratch, `pack-${crypto.randomUUID()}.tgz`);
  spawnSync("tar", ["czf", pack, "-C", files, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const engine = path.join(scratch, `engine-${crypto.randomUUID()}`);
  write(path.join(engine, "package", "bin", "opencode"), engineBinary("1.1.0"), 0o755);
  const engineTar = path.join(scratch, `engine-${crypto.randomUUID()}.tgz`);
  spawnSync("tar", ["czf", engineTar, "-C", engine, "package"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const packData = fs.readFileSync(pack), engineData = fs.readFileSync(engineTar);
  const integrity = "sha512-" + crypto.createHash("sha512").update(engineData).digest("base64");
  const manifest = Buffer.from(JSON.stringify({
    kuvo: "box/1", version, released: released.toISOString(), engine: "1.1.0",
    linux: { x86_64: { url: `${base}/engine.tgz`, integrity }, aarch64: { url: `${base}/engine.tgz`, integrity } },
    pack: { url: `${base}/pack.tgz`, sha256: sha256(packData), size: packData.length },
  }));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from("kuvo-box v1\n"), manifest]), key);
  served = {
    "/boxes.json": JSON.stringify({ manifest: manifest.toString("base64"), signature: signature.toString("base64"), key: crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64") }),
    "/pack.tgz": tamper ? Buffer.concat([packData, Buffer.from("x")]) : packData,
    "/engine.tgz": engineData,
  };
}

const update = (options = {}) => link.update({ now: true, keys: [pinned], url: `${base}/boxes.json`, blocked: null, upWithin: 5000, ...options });

test("versions order by number, a beta before its release", () => {
  assert.equal(link.newerVersion("0.10.0", "0.9.3"), true);
  assert.equal(link.newerVersion("0.9.3", "0.9.3"), false);
  assert.equal(link.newerVersion("0.8.0", "0.8.0-beta.2"), true);
  assert.equal(link.newerVersion("0.8.0-beta.3", "0.8.0-beta.2"), true);
  assert.equal(link.newerVersion("0.8.0-beta.1", "0.8.0"), false);
  assert.equal(link.newerVersion("0.8.0", null), true, "a box nothing marked takes any");
  assert.equal(link.newerVersion("not a version", "0.1.0"), false);
});

test("a release counts only signed with a pinned key, over what it says", () => {
  release();
  const manifest = link.verifyBoxes(served["/boxes.json"], [pinned]);
  assert.equal(manifest.version, "0.10.0");
  assert.throws(() => link.verifyBoxes(served["/boxes.json"], []), /isn't signed with a key/);
  assert.throws(() => link.verifyBoxes(served["/boxes.json"], [crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64")]), /isn't signed with a key/);
  const given = JSON.parse(served["/boxes.json"]);
  const changed = Buffer.from(given.manifest, "base64").toString("utf8").replace("0.10.0", "0.99.0");
  assert.throws(() => link.verifyBoxes(JSON.stringify({ ...given, manifest: Buffer.from(changed).toString("base64") }), [pinned]), /signature doesn't match/);
  // The same key's signature on the bytes alone (as for something else it signs) doesn't count.
  const bare = crypto.sign(null, Buffer.from(given.manifest, "base64"), privateKey).toString("base64");
  assert.throws(() => link.verifyBoxes(JSON.stringify({ ...given, signature: bare }), [pinned]), /signature doesn't match/);
});

test("the night's window is 02:00 to 05:00 where you are", () => {
  assert.equal(link.updateNight(new Date("2026-10-23T02:30:00Z"), "UTC"), "2026-10-23");
  assert.equal(link.updateNight(new Date("2026-10-23T05:00:00Z"), "UTC"), null);
  assert.equal(link.updateNight(new Date("2026-10-22T23:30:00Z"), "Europe/Istanbul"), "2026-10-23", "02:30 in Istanbul");
  assert.equal(link.updateNight(new Date("2026-10-23T02:30:00Z"), "Not/AZone"), null);
});

test("a box updates itself only while every Mac that started its engine lately leaves a newer box as it is, and only in its own folder", () => {
  const own = path.join(os.homedir(), ".kuvo-code");
  assert.match(link.updatesBlocked({}, Date.now(), home), /own Kuvo Code folder/);
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  link.noteLauncher(() => ({ notes: { mac: "mac-old" } }));
  assert.match(link.updatesBlocked({ tolerantIDs: { "mac-new": true } }, Date.now(), own), /older Kuvo Code/);
  assert.match(link.updatesBlocked({ tolerantIDs: { "mac-old": false } }, Date.now(), own), /older Kuvo Code/);
  assert.equal(link.updatesBlocked({ tolerantIDs: { "mac-old": true } }, Date.now(), own), null);
  assert.equal(link.updatesBlocked({}, Date.now() + 31 * 86_400_000, own), null, "one not seen in 30 days doesn't count");
  fs.rmSync(path.join(home, "run", "launchers.json"), { force: true });
});

test("a box updates to a newer release: its engine and files swapped, started again, kept until the new link says it's well", async () => {
  await machine();
  release();
  const outcome = await update();
  assert.deepEqual(outcome, { result: "updated", version: "0.10.0" });
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.10.0");
  assert.match(fs.readFileSync(path.join(home, "bin", "kuvo-start"), "utf8"), /engine\/1\.1\.0/);
  assert.equal((fs.statSync(path.join(home, "bin", "kuvo-link.js")).mode & 0o777), 0o600, "with its own mode");
  // Its tools kept as the box's own too, for its keeper to put back after an older Mac's visit.
  assert.equal(fs.readFileSync(path.join(home, "bin", ".own", "kuvo-wake"), "utf8"), "# the new wake-ups\n");
  assert.equal((fs.statSync(path.join(home, "bin", ".own", "kuvo-wake")).mode & 0o777), 0o755);
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.1.0", "the new engine runs");
  engines.add(read(engineFile).pid);
  assert.ok(fs.existsSync(path.join(home, "updates", "rollback", "restore.sh")));
  assert.ok(fs.existsSync(path.join(home, "run", "update-trial")));
  assert.equal(fs.readdirSync(path.join(home, "updates")).sort().join(), "installed.json,rollback", "what was downloaded goes; what it put there is noted");

  // The new link, well: what was kept, and the old engine, go.
  assert.equal(link.confirmUpdate(), true);
  assert.equal(fs.existsSync(path.join(home, "updates", "rollback")), false);
  assert.equal(fs.existsSync(path.join(home, "run", "update-trial")), false);
  assert.deepEqual(fs.readdirSync(path.join(home, "engine")), ["1.1.0"]);
  assert.deepEqual(read(path.join(home, "run", "update.json")).last.to, "0.10.0");
  assert.equal(link.confirmUpdate(), false, "once");

  // The same release again: nothing to do.
  assert.equal((await update()).result, "current");
});

test("a new version that doesn't come up is taken back: the files, the box's version and the engine it had", async () => {
  await machine();
  release({ breaks: true });
  const outcome = await update();
  assert.equal(outcome.result, "failed");
  assert.match(outcome.message, /didn't come up/);
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.9.0");
  assert.equal(fs.readFileSync(path.join(home, "bin", "kuvo-link.js"), "utf8"), "// the old link\n");
  assert.equal(fs.readFileSync(path.join(home, "bin", ".own", "kuvo-wake"), "utf8"), "# the old wake-ups\n", "the box's own tools as they were");
  assert.match(fs.readFileSync(path.join(home, "bin", "kuvo-start"), "utf8"), /engine\/1\.0\.0/);
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.0.0", "the old engine runs again");
  engines.add(read(engineFile).pid);
  assert.equal(fs.existsSync(path.join(home, "updates", "rollback")), false);
  assert.equal(fs.existsSync(path.join(home, "run", "update-trial")), false);
  assert.equal(read(path.join(home, "run", "update.json")).last.result, "failed");
  // The old engine's data as it was, without the new engine's journal beside it.
  assert.equal(fs.readFileSync(path.join(home, "data", "opencode", "opencode.db"), "utf8"), "the old engine's data");
  assert.equal(fs.existsSync(path.join(home, "data", "opencode", "opencode.db-wal")), false);
});

test("a stopped box, or one whose version isn't known, doesn't update; a lock whose process went doesn't hold one", async () => {
  await machine();
  release();
  fs.writeFileSync(path.join(home, "run", "stopped"), "");
  assert.match((await update()).message, /stopped/);
  fs.rmSync(path.join(home, "run", "stopped"));
  fs.rmSync(path.join(home, "bin", "box-version"));
  assert.match((await update()).message, /version isn't known/);
  write(path.join(home, "bin", "box-version"), "0.9.0");
  fs.mkdirSync(path.join(home, "run", ".updating"));
  fs.writeFileSync(path.join(home, "run", ".updating", "pid"), "999999");
  assert.equal(link.isUpdating(), false);
  assert.equal((await update()).result, "updated");
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.1.0", "the new engine runs");
  engines.add(read(engineFile).pid);
  assert.equal(link.confirmUpdate(), true);

  // An older Mac puts its own link back: seen twice (not a Mac's install under way), the box
  // doesn't update itself for a while, and says why; its version mark stays.
  const own = path.join(os.homedir(), ".kuvo-code");
  assert.equal(link.checkDrift(), false);
  // Not while an update tries what it put there (its version changes then).
  fs.writeFileSync(path.join(home, "run", "update-trial"), "0.11.0");
  fs.writeFileSync(path.join(home, "bin", "box-version"), "0.11.0");
  assert.equal(link.checkDrift(), false);
  assert.ok(fs.existsSync(path.join(home, "updates", "installed.json")), "what it installed is still noted");
  fs.writeFileSync(path.join(home, "bin", "box-version"), "0.10.0");
  fs.rmSync(path.join(home, "run", "update-trial"));
  fs.writeFileSync(path.join(home, "bin", "kuvo-link.js"), "// an older Mac's link\n");
  fs.writeFileSync(path.join(home, "run", "mac-installing"), "");
  assert.equal(link.checkDrift(), false, "not while a Mac says it puts its files in place");
  fs.rmSync(path.join(home, "run", "mac-installing"));
  assert.equal(link.checkDrift(), false, "seen once");
  assert.equal(link.checkDrift(), true, "seen again");
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.10.0");
  assert.match(link.updatesBlocked({}, Date.now(), own), /older Kuvo Code/);
  assert.match(read(path.join(home, "run", "update.json")).last.message, /older Kuvo Code/);
  fs.rmSync(path.join(home, "run", "launchers.json"), { force: true });

  // An older Mac connecting (it touches run/attached; this version never does) holds updates back.
  // One from before this version put its files there doesn't: that Mac, before it updated.
  const attached = path.join(home, "run", "attached"), mark = path.join(home, "bin", "box-version");
  assert.equal(link.noteOlderMacs(), false);
  fs.writeFileSync(attached, "");
  fs.utimesSync(mark, new Date(), new Date(Date.now() + 1000));
  assert.equal(link.noteOlderMacs(), false, "touched before the box was marked");
  assert.equal(link.updatesBlocked({}, Date.now(), own), null);
  fs.utimesSync(mark, new Date(), new Date(Date.now() - 60_000));
  assert.equal(link.noteOlderMacs(), true);
  assert.match(link.updatesBlocked({}, Date.now(), own), /older Kuvo Code/);
  fs.rmSync(path.join(home, "run", "attached"));
  // One a Mac's mark saw (and hid, marking the box), noted all the same.
  fs.rmSync(path.join(home, "run", "launchers.json"), { force: true });
  fs.writeFileSync(path.join(home, "run", "older-mac"), "");
  assert.equal(link.noteOlderMacs(), true);
  assert.match(link.updatesBlocked({}, Date.now(), own), /older Kuvo Code/);
  fs.rmSync(path.join(home, "run", "older-mac"));
  fs.rmSync(path.join(home, "run", "launchers.json"), { force: true });
});

test("an engine that won't stop changes nothing; no release for machines yet is nothing newer", async () => {
  await machine();
  release();
  const keeperFile = path.join(home, "bin", "kuvo-start");
  write(keeperFile, keeper("1.0.0").replace(/^stop\) .*$/m, "stop) exit 4 ;;"), 0o700);
  const outcome = await update();
  assert.match(outcome.message, /couldn't be stopped/);
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.9.0");
  assert.equal(fs.existsSync(path.join(home, "updates", "rollback")), false);
  assert.equal(fs.existsSync(path.join(home, "run", "update-trial")), false);
  assert.equal(read(engineFile).version, "1.0.0");
  served = {};
  assert.deepEqual(await update(), { result: "current", version: "0.9.0" });
});

test("a release that isn't what it says, an older one, or one too new for the night changes nothing", async () => {
  await machine();
  release({ tamper: true });
  assert.match((await update()).message, /aren't what it says/);
  release({ key: crypto.generateKeyPairSync("ed25519").privateKey });
  assert.match((await update()).message, /isn't signed with a key/);
  release({ version: "0.8.0" });
  assert.equal((await update()).result, "current");
  release({ released: new Date() });
  assert.equal((await update({ now: false })).result, "waiting");
  assert.equal((await update({ keys: [] })).result, "off");
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.9.0");
  assert.equal(read(engineFile).version, "1.0.0");
  assert.equal(fs.existsSync(path.join(home, "updates", "rollback")), false);
});

test("kuvo/update says how the box stands; updating by itself can't be turned off", async () => {
  await machine();
  const handler = link.engineHandler(() => read(engineFile), {}, () => ({}));
  const ask = async (method, body) => {
    const parts = [];
    for await (const part of handler({ method, path: "kuvo/update", headers: {}, body: Buffer.from(body ? JSON.stringify(body) : "") }, null, null)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.slice(1).map(part => part.body)).toString("utf8")) };
  };
  const status = await ask("GET");
  assert.equal(status.status, 200);
  assert.deepEqual([status.json.setUp, status.json.auto, status.json.version, status.json.engine], [true, true, "0.9.0", "1.0.0"]);
  const off = await ask("PATCH", { auto: false });
  assert.equal(off.status, 400);
  assert.match(off.json.message, /always keeps itself up to date/);
  assert.equal((await ask("GET")).json.auto, true);
  const now = await ask("POST", { now: true });
  assert.equal(now.status, 409, "a test's folder, not a machine's own");
  assert.match(now.json.message, /own Kuvo Code folder/);
});
