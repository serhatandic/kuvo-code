// A box updating itself (PROTOCOL.md, "Updates"): only what a pinned key signed, only newer, and
// back to what it had when the new version doesn't come up. Run here, in a folder of the test's
// own, against a release served on localhost, with a stand-in engine and keeper (the real ones
// need Linux); the new link's self-test is the real one.
// Run with `node --test Packages/KuvoLink/Tests/Bridge/*.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runningAs } from "./running-as.js";
import { atEnd, removeAtEnd } from "./at-end.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-updates-"));
process.env.KUVO_HOME = home;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const script = fileURLToPath(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-release-"));
const engines = new Set();
removeAtEnd(home);
removeAtEnd(scratch);
atEnd(() => {
  for (const pid of engines) try { process.kill(pid); } catch {}
  stopEngine();
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
// Noted whole or not at all: a reader never finds it half written.
const noted = path.join(root, "run", "engine.json");
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(noted + ".new", JSON.stringify({ pid: process.pid, port: server.address().port, password: "pw", version, notes: { mac: "mac-1" } }));
  fs.renameSync(noted + ".new", noted);
});
// Gone with the test's folder, however late an update in the background started it.
setInterval(() => { if (!fs.existsSync(root)) process.exit(0); }, 300);
`);
process.env.FAKE_ENGINE = fakeEngine;
// This node itself, not a version manager's shim that might start it as a child: the engine is the
// keeper's own process (its pid, $!), as the keeper's start waits to see it noted.
process.env.FAKE_NODE = process.execPath;
const engineBinary = version => `#!/bin/sh
[ "$1" = --config=/dev/null ] && shift
[ "$1" = --no-env-file ] && shift
case "$1" in --version) echo ${version}; exit 0 ;; *.js) exec "$FAKE_NODE" "$@" ;; esac
exec "$FAKE_NODE" "$FAKE_ENGINE" ${version} "$KUVO_HOME"
`;
// The keeper: stops the engine (waiting until it's gone, as the real one does), or starts this
// version's. As the real one's (RemoteEngine.swift's bootScript), a start leaves an engine that
// runs as it is, and returns once the one it started is noted in run/engine.json: never a second
// engine, nor a note written after it returned. One that `breaks` starts none, and leaves the
// journal a new engine would (WAL) beside the database.
const keeper = (version, breaks = false) => `#!/bin/sh
K="$KUVO_HOME"; R="$K/run"
noted() { sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$R/engine.json" 2>/dev/null; }
case "$1" in
stop) touch "$R/stopped"; pid=$(noted); if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done; fi; rm -f "$R/engine.json" ;;
start) rm -f "$R/stopped"; old=$(noted); if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then exit 0; fi; ${breaks ? `mkdir -p "$K/data/opencode"; echo "the new engine's journal" > "$K/data/opencode/opencode.db-wal"` : `"$K/engine/${version}/opencode" serve >/dev/null 2>&1 & pid=$!; until [ "$(noted)" = "$pid" ]; do kill -0 "$pid" 2>/dev/null || exit 3; sleep 0.1; done`} ;;
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
function machine() {
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
  // A start that never sees its engine noted fails here (status null) rather than holding up the
  // file for good; one takes a second or two under load.
  assert.equal(spawnSync("sh", [path.join(home, "bin", "kuvo-start"), "start"], { env: process.env, timeout: 60_000 }).status, 0, "the old engine runs");
  engines.add(read(engineFile).pid);
}

// A release of 0.10.0 (engine 1.1.0), signed with `key`, served here, and kept in a folder as Kuvo
// Code carries it (`folder`: boxes.json and the pack beside it). `tamper` changes what's packed;
// `bundle` adds a Mac bundle by its files (`{name: text}`, in `bin/Kuvo Code Box.app`); `extra`
// adds files to the pack that box.json doesn't name, `link` a link in the bundle.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const pinned = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
let served = {};
// Each answer on a connection of its own. An update holds this process's event loop through its
// self-test, stop and start (each a spawnSync; 3 to 5 seconds in all at a load of 120, more at
// times), and past the server's five-second keep-alive, the next update's request went out on the
// connection kept from the last one as the server closed it ("fetch failed").
const server = http.createServer((request, response) => {
  const body = served[request.url];
  response.writeHead(body ? 200 : 404, { connection: "close" });
  response.end(body ?? "");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
atEnd(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

function release({ version = "0.10.0", released = new Date(Date.now() - 10 * 86_400_000), breaks = false, tamper = false, key = privateKey, bundle = null, extra = null, link = false } = {}) {
  const files = path.join(scratch, `files-${crypto.randomUUID()}`);
  write(path.join(files, "bin", "box-version"), version);
  write(path.join(files, "bin", "kuvo-start"), keeper("1.1.0", breaks), 0o700);
  write(path.join(files, "bin", "kuvo-link.js"), fs.readFileSync(script, "utf8"), 0o600);
  write(path.join(files, "bin", "kuvo-wake"), "# the new wake-ups\n", 0o755);
  const box = { version, engine: "1.1.0", files: {} };
  const named = ["bin/box-version", "bin/kuvo-start", "bin/kuvo-link.js", "bin/kuvo-wake"];
  for (const [name, text] of Object.entries(bundle ?? {})) {
    write(path.join(files, "bin", "Kuvo Code Box.app", name), text, name.includes("MacOS/") ? 0o755 : 0o644);
    named.push(`bin/Kuvo Code Box.app/${name}`);
  }
  for (const [name, text] of Object.entries(extra ?? {})) write(path.join(files, name), text);
  if (link) fs.symlinkSync("/etc/hosts", path.join(files, "bin", "Kuvo Code Box.app", "Contents", "hosts"));
  for (const file of named) box.files[file] = sha256(fs.readFileSync(path.join(files, file)));
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
    // Each system's own build, and the other's isn't there: a box takes the one for its system.
    ...Object.fromEntries(["linux", "darwin"].map(system => {
      const url = (system === "darwin") === (process.platform === "darwin") ? `${base}/engine.tgz` : `${base}/another-systems-engine.tgz`;
      return [system, { x86_64: { url, integrity }, aarch64: { url, integrity } }];
    })),
    pack: { url: `${base}/pack.tgz`, sha256: sha256(packData), size: packData.length },
  }));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from("kuvo-box v1\n"), manifest]), key);
  served = {
    "/boxes.json": JSON.stringify({ manifest: manifest.toString("base64"), signature: signature.toString("base64"), key: crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32).toString("base64") }),
    "/pack.tgz": tamper ? Buffer.concat([packData, Buffer.from("x")]) : packData,
    "/engine.tgz": engineData,
  };
  const folder = path.join(scratch, `release-${crypto.randomUUID()}`);
  write(path.join(folder, "boxes.json"), served["/boxes.json"]);
  write(path.join(folder, "pack.tgz"), served["/pack.tgz"]);
  return { folder };
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
  machine();
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

test("an agent's browser waiting on you (a sign-in) holds the update: nothing is stopped or swapped", async t => {
  machine();
  release();
  write(path.join(home, "run", "browser.pid"), String(await runningAs("kuvo-browser", t)));
  write(path.join(home, "run", "browser-asks.json"), JSON.stringify({ asks: [{ id: "ask_1", kind: "signIn", host: "github.com", session: "ses_1", username: true, password: true }] }));
  assert.deepEqual(await update(), { result: "busy", message: "Something is running there now." });
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.9.0");
  assert.equal(read(engineFile).version, "1.0.0", "its engine still runs");
});

test("a new version that doesn't come up is taken back: the files, the box's version and the engine it had", async () => {
  machine();
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
  machine();
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
  machine();
  release();
  const running = read(engineFile).pid;
  const keeperFile = path.join(home, "bin", "kuvo-start");
  write(keeperFile, keeper("1.0.0").replace(/^stop\) .*$/m, "stop) exit 4 ;;"), 0o700);
  const outcome = await update();
  assert.match(outcome.message, /couldn't be stopped/);
  assert.equal(fs.readFileSync(path.join(home, "bin", "box-version"), "utf8"), "0.9.0");
  assert.equal(fs.existsSync(path.join(home, "updates", "rollback")), false);
  assert.equal(fs.existsSync(path.join(home, "run", "update-trial")), false);
  assert.equal(read(engineFile).version, "1.0.0");
  assert.equal(read(engineFile).pid, running, "the engine it had, still running");
  served = {};
  assert.deepEqual(await update(), { result: "current", version: "0.9.0" });
});

test("a release that isn't what it says, an older one, or one too new for the night changes nothing", async () => {
  machine();
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

test("kuvo/update says how the box stands, and only reads and starts one", async () => {
  machine();
  const handler = link.engineHandler(() => read(engineFile), {}, () => ({}));
  const ask = async (method, body) => {
    const parts = [];
    for await (const part of handler({ method, path: "kuvo/update", headers: {}, body: Buffer.from(body ? JSON.stringify(body) : "") }, null, null)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.slice(1).map(part => part.body)).toString("utf8")) };
  };
  const status = await ask("GET");
  assert.equal(status.status, 200);
  assert.deepEqual([status.json.setUp, status.json.version, status.json.engine], [true, "0.9.0", "1.0.0"]);
  assert.equal((await ask("PATCH", { auto: false })).status, 405, "there's nothing to change: a machine always updates by itself");
  const now = await ask("POST", { now: true });
  assert.equal(now.status, 409, "a test's folder, not a machine's own");
  assert.match(now.json.message, /own Kuvo Code folder/);
});

test("a machine with no bridge, updated by its `update` command: confirmed, and its integrations brought up to date", async () => {
  machine();
  release();
  const key = "KUVO_KEY_FIGMA_FIGMA_API_KEY";
  const catalog = fileURLToPath(new URL("../../Vectors/routes/box/integrations.json", import.meta.url));
  write(path.join(home, "bin", "integrations.json"), fs.readFileSync(catalog));
  write(path.join(home, "box", "keys", key), "tok");
  write(path.join(home, "box", "opencode.json"), JSON.stringify({ mcp: { servers: {
    figma: { type: "local", command: ["kuvo-npx", "figma-developer-mcp@0.6.0", "--stdio"], environment: { FIGMA_API_KEY: `{file:${home}/box/keys/${key}}` } },
  } } }));
  const updating = spawn(process.execPath, [script, "update", "--now", "--url", `${base}/boxes.json`, "--key", pinned], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  let said = "";
  updating.stdout.setEncoding("utf8");
  updating.stdout.on("data", chunk => { said += chunk; });
  // (Once its output has all come.)
  await new Promise(resolve => updating.once("close", resolve));
  assert.equal(JSON.parse(said).result, "updated", said);
  engines.add(read(engineFile).pid);
  assert.equal(fs.existsSync(path.join(home, "run", "update-trial")), false, "confirmed");
  const figma = read(catalog).integrations.find(entry => entry.id === "figma").settings;
  assert.deepEqual(read(path.join(home, "box", "opencode.json")).mcp.servers.figma, figma);
  assert.equal(fs.existsSync(path.join(home, "box", "keys", key)), false);
});

// A release from a folder here (`kuvo/box/update {from}`): what Kuvo Code carries, offered as it
// updates, checked as a downloaded one is, and taken at a quiet moment.
const offer = (folder, options = {}) => link.offerUpdate(folder, { keys: [pinned], blocked: null, ...options });
const take = (options = {}) => link.takeOffer({ run: given => link.update(given), keys: [pinned], blocked: null, upWithin: 5000, ...options });
const offered = path.join(home, "updates", "offered");
const boxVersion = () => fs.readFileSync(path.join(home, "bin", "box-version"), "utf8");

test("a release offered from a folder here is checked, kept, and taken at the next quiet moment, whatever its age", async () => {
  machine();
  // Out today: a downloaded one would wait three days for the night; one Kuvo Code here carries
  // came with the version it runs.
  const { folder } = release({ released: new Date() });
  assert.deepEqual(offer(folder), { status: 202, version: "0.10.0" });
  assert.equal(link.offeredVersion(), "0.10.0");
  assert.equal(link.updateStatus().offered, "0.10.0", "kuvo/update says it waits");
  // Kept: the app it came in may be gone (updated again, moved to the Trash) by the time it's taken.
  fs.rmSync(folder, { recursive: true });
  assert.equal(boxVersion(), "0.9.0", "nothing taken yet");

  assert.deepEqual(await take(), { result: "updated", version: "0.10.0" });
  assert.equal(boxVersion(), "0.10.0");
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.1.0", "the new engine runs");
  engines.add(read(engineFile).pid);
  assert.equal(fs.existsSync(offered), false, "taken, it goes");
  assert.equal(link.updateStatus().offered, undefined);
  assert.equal(link.confirmUpdate(), true);
  assert.equal(read(path.join(home, "run", "update.json")).latest, undefined, "only GitHub's says what the newest release is");
  assert.equal(await take(), null, "nothing more to take");
});

test("an offered release is refused, with nothing kept or changed, when it isn't signed by a trusted key, isn't newer, or can't be read", async t => {
  machine();
  const refused = (given, status, words) => {
    const answer = offer(given);
    assert.equal(answer.status, status, JSON.stringify(answer));
    assert.match(answer.message, words);
    assert.equal(fs.existsSync(offered), false);
  };
  refused(release({ key: crypto.generateKeyPairSync("ed25519").privateKey }).folder, 422, /isn't signed with a key/);
  // A manifest changed after it was signed.
  const { folder: changed } = release();
  const given = read(path.join(changed, "boxes.json"));
  const manifest = Buffer.from(given.manifest, "base64").toString("utf8").replace("0.10.0", "0.99.0");
  write(path.join(changed, "boxes.json"), JSON.stringify({ ...given, manifest: Buffer.from(manifest).toString("base64") }));
  refused(changed, 422, /signature doesn't match/);
  refused(release({ version: "0.8.0" }).folder, 409, /has 0\.9\.0 already, and takes only a newer version/);
  refused(release({ version: "0.9.0" }).folder, 409, /takes only a newer version/);
  // Its pack not what the signed manifest says, missing, or no release there at all.
  refused(release({ tamper: true }).folder, 422, /aren't what it says/);
  const { folder: packless } = release();
  fs.rmSync(path.join(packless, "pack.tgz"));
  refused(packless, 422, /can't be read/);
  refused(path.join(scratch, "nothing-here"), 422, /can't be read/);
  const { folder: notAFile } = release();
  fs.rmSync(path.join(notAFile, "boxes.json"));
  fs.mkdirSync(path.join(notAFile, "boxes.json"));
  refused(notAFile, 422, /can't be read/);
  write(path.join(scratch, "junk", "boxes.json"), "not a release");
  refused(path.join(scratch, "junk"), 422, /isn't a release/);
  refused("relative/folder", 400, /full path/);
  refused(undefined, 400, /full path/);
  // A box that doesn't update itself (not its own folder), or isn't set up to, takes none either.
  const { folder } = release();
  assert.equal(offer(folder, { blocked: "Only a machine's own Kuvo Code folder updates itself." }).status, 409);
  assert.equal(offer(folder, { keys: [] }).status, 409);
  // Nor while it updates: what's offered is what an update would be reading.
  fs.mkdirSync(path.join(home, "run", ".updating"));
  fs.writeFileSync(path.join(home, "run", ".updating", "pid"), String(await runningAs("kuvo-link", t)));
  refused(folder, 409, /updating already/);
  fs.rmSync(path.join(home, "run", ".updating"), { recursive: true });
  // An older one than what's offered already doesn't replace it.
  assert.equal(offer(release({ version: "0.11.0" }).folder).status, 202);
  const older = offer(folder);
  assert.equal(older.status, 409);
  assert.match(older.message, /newer release \(0\.11\.0\) waits/);
  assert.equal(link.offeredVersion(), "0.11.0");
  fs.rmSync(offered, { recursive: true });
  assert.equal(boxVersion(), "0.9.0");
  assert.equal(read(engineFile).version, "1.0.0", "its engine still runs");
});

test("an offered release waits while something runs, and is taken once nothing does", async t => {
  machine();
  const { folder } = release();
  assert.equal(offer(folder).status, 202);
  write(path.join(home, "run", "browser.pid"), String(await runningAs("kuvo-browser", t)));
  write(path.join(home, "run", "browser-asks.json"), JSON.stringify({ asks: [{ id: "ask_1", kind: "signIn", host: "github.com", session: "ses_1", username: true, password: true }] }));
  assert.equal(await take(), null, "not now");
  assert.equal(link.offeredVersion(), "0.10.0", "still offered");
  assert.equal(boxVersion(), "0.9.0");
  assert.equal(read(engineFile).version, "1.0.0", "its engine still runs");
  fs.rmSync(path.join(home, "run", "browser-asks.json"));
  assert.equal((await take()).result, "updated");
  engines.add(read(engineFile).pid);
  assert.equal(link.confirmUpdate(), true);
});

test("an offered release that doesn't come up is taken back and goes; one the box has caught up with goes untaken", async () => {
  machine();
  assert.equal(offer(release({ breaks: true }).folder).status, 202);
  const outcome = await take();
  assert.equal(outcome.result, "failed");
  assert.equal(boxVersion(), "0.9.0");
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.0.0", "the old engine runs again");
  engines.add(read(engineFile).pid);
  assert.equal(fs.existsSync(offered), false, "not tried again and again: Kuvo Code offers it again as it next opens");

  // Offered, then the box got there another way (the night's update): nothing to take.
  assert.equal(offer(release().folder).status, 202);
  fs.writeFileSync(path.join(home, "bin", "box-version"), "0.10.0");
  assert.equal(await take(), null);
  assert.equal(fs.existsSync(offered), false);
});

const helper = { "Contents/Info.plist": "<plist>the new helper</plist>\n", "Contents/MacOS/Kuvo Code Box": "#!/bin/sh\necho the new helper\n", "Contents/_CodeSignature/CodeResources": "the new seal\n" };
function oldHelper() {
  const bundle = path.join(home, "bin", "Kuvo Code Box.app");
  write(path.join(bundle, "Contents", "Info.plist"), "<plist>the old helper</plist>\n");
  write(path.join(bundle, "Contents", "MacOS", "Kuvo Code Box"), "#!/bin/sh\necho the old helper\n", 0o755);
  write(path.join(bundle, "Contents", "Resources", "only-the-old-one-had.txt"), "old\n");
  return bundle;
}

test("a release's bundle (the box's helper) is swapped whole on a Mac, and left out on Linux", async () => {
  machine();
  const bundle = oldHelper();
  assert.equal(offer(release({ bundle: helper }).folder).status, 202);
  assert.equal((await take()).result, "updated");
  engines.add(read(engineFile).pid);
  const installed = read(path.join(home, "updates", "installed.json")).files;
  if (process.platform === "darwin") {
    assert.equal(fs.readFileSync(path.join(bundle, "Contents", "MacOS", "Kuvo Code Box"), "utf8"), helper["Contents/MacOS/Kuvo Code Box"]);
    assert.equal(fs.statSync(path.join(bundle, "Contents", "MacOS", "Kuvo Code Box")).mode & 0o777, 0o755, "with its own mode");
    assert.equal(fs.readFileSync(path.join(bundle, "Contents", "_CodeSignature", "CodeResources"), "utf8"), "the new seal\n");
    assert.equal(fs.existsSync(path.join(bundle, "Contents", "Resources")), false, "whole: nothing of the old one left in it");
    assert.ok(installed["bin/Kuvo Code Box.app/Contents/Info.plist"], "noted as installed");
  } else {
    assert.equal(fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8"), "<plist>the old helper</plist>\n", "a Mac's alone");
    assert.equal(Object.keys(installed).some(file => file.includes(".app/")), false, "nor noted as installed, so it's never drift");
  }
  assert.deepEqual(fs.readdirSync(path.join(home, "bin")).filter(name => name.includes(".app")), ["Kuvo Code Box.app"], "no copy left beside it");
  assert.equal(link.confirmUpdate(), true);
  assert.equal(link.checkDrift(), false, "what's there is what it installed");
});

test("a release whose bundle doesn't come up puts the bundle back as it was; one with a file box.json doesn't name, or a link, isn't taken", async () => {
  machine();
  const bundle = oldHelper();
  assert.equal(offer(release({ breaks: true, bundle: helper }).folder).status, 202);
  assert.equal((await take()).result, "failed");
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.0.0", "the old engine runs again");
  engines.add(read(engineFile).pid);
  assert.equal(fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8"), "<plist>the old helper</plist>\n");
  assert.equal(fs.readFileSync(path.join(bundle, "Contents", "Resources", "only-the-old-one-had.txt"), "utf8"), "old\n");
  assert.equal(fs.statSync(path.join(bundle, "Contents", "MacOS", "Kuvo Code Box")).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(path.join(home, "bin")).filter(name => name.includes(".app")), ["Kuvo Code Box.app"]);

  // A new bundle where there was none goes again, as it came.
  fs.rmSync(bundle, { recursive: true });
  assert.equal(offer(release({ breaks: true, bundle: helper }).folder).status, 202);
  assert.equal((await take()).result, "failed");
  await waitFor(() => fs.existsSync(engineFile) && read(engineFile).version === "1.0.0", "the old engine runs again");
  engines.add(read(engineFile).pid);
  assert.equal(fs.existsSync(bundle), false);

  for (const odd of [{ extra: { "bin/Kuvo Code Box.app/Contents/MacOS/unnamed": "not in box.json" } }, { link: true }, { bundle: { ".hidden/x": "y" } }]) {
    assert.equal(offer(release({ bundle: helper, ...odd }).folder).status, 202, "the pack is as its signed manifest says");
    const outcome = await take();
    assert.equal(outcome.result, "failed", JSON.stringify(odd));
    assert.match(outcome.message, /aren't what it says|outside the box/);
    assert.equal(boxVersion(), "0.9.0");
    assert.equal(fs.existsSync(bundle), false);
    assert.equal(read(engineFile).version, "1.0.0", "its engine never stopped");
  }
});

test("kuvo/box/update takes an offer from Kuvo Code only, as a POST with a full path", async () => {
  machine();
  const handler = link.engineHandler(() => read(engineFile), {}, () => ({}));
  const ask = async (method, body, from = {}) => {
    const parts = [];
    for await (const part of handler({ method, path: "kuvo/box/update", headers: {}, body: Buffer.from(body ? JSON.stringify(body) : ""), ...from }, null, null)) parts.push(part);
    return { status: parts[0].head.status, json: JSON.parse(Buffer.concat(parts.slice(1).map(part => part.body)).toString("utf8") || "{}") };
  };
  const { folder } = release();
  assert.equal((await ask("GET")).status, 405);
  assert.equal((await ask("POST", { from: folder })).status, 403, "never a phone");
  assert.equal((await ask("POST", {}, { fromApp: true })).status, 400);
  // Kuvo Code here, or on another computer (`box route`), as far as the box's own rules let it.
  for (const from of [{ fromApp: true }, { fromMac: true }]) {
    const answer = await ask("POST", { from: folder }, from);
    assert.equal(answer.status, 409, "a test's folder, not a machine's own");
    assert.match(answer.json.message, /own Kuvo Code folder/);
  }
  assert.equal(fs.existsSync(offered), false);
});

test("`kuvo-link.js update --from` takes a release from a folder there", async () => {
  machine();
  const { folder } = release({ released: new Date(), bundle: helper });
  const updating = spawn(process.execPath, [script, "update", "--from", folder, "--key", pinned], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  let said = "";
  updating.stdout.setEncoding("utf8");
  updating.stdout.on("data", chunk => { said += chunk; });
  await new Promise(resolve => updating.once("close", resolve));
  assert.equal(JSON.parse(said).result, "updated", said);
  engines.add(read(engineFile).pid);
  assert.equal(boxVersion(), "0.10.0");
  assert.equal(fs.existsSync(path.join(home, "bin", "Kuvo Code Box.app")), process.platform === "darwin");
});

test("scripts/pack-box.sh packs a built app's box release with its helper, signed, and a box takes it from the app's folder", async () => {
  machine();
  release();
  const app = path.join(scratch, `app-${crypto.randomUUID()}`, "Kuvo Code.app");
  // What the app's `--write-box-files` writes (BoxRelease.swift), laid out by a stand-in app.
  const files = path.join(scratch, `written-${crypto.randomUUID()}`);
  write(path.join(files, "bin", "box-version"), "0.10.0");
  write(path.join(files, "bin", "kuvo-start"), keeper("1.1.0"), 0o700);
  write(path.join(files, "bin", "kuvo-link.js"), fs.readFileSync(script, "utf8"), 0o600);
  for (const tool of ["kuvo-browser.js", "kuvo-agents.js", "kuvo-launch"]) write(path.join(files, "bin", tool), `// ${tool}\n`, 0o600);
  const integrity = "sha512-" + crypto.createHash("sha512").update(served["/engine.tgz"]).digest("base64");
  const engines_ = { x86_64: { url: `${base}/engine.tgz`, integrity }, aarch64: { url: `${base}/engine.tgz`, integrity } };
  const box = { version: "0.10.0", engine: "1.1.0", linux: engines_, darwin: engines_, files: {} };
  for (const file of fs.readdirSync(path.join(files, "bin"))) box.files[`bin/${file}`] = sha256(fs.readFileSync(path.join(files, "bin", file)));
  write(path.join(files, "box.json"), JSON.stringify(box));
  write(path.join(app, "Contents", "MacOS", "Kuvo Code"), `#!/bin/sh\n[ "$1" = --write-box-files ] || exit 64\nmkdir -p "$2" && cp -Rp ${JSON.stringify(files)}/. "$2"/\n`, 0o755);
  for (const [name, text] of Object.entries(helper)) write(path.join(app, "Contents", "Helpers", "Kuvo Code Box.app", name), text, name.includes("MacOS/") ? 0o755 : 0o644);

  const out = path.join(app, "Contents", "Resources", "box-release");
  const pack = (...args) => spawnSync("sh", [fileURLToPath(new URL("../../../../scripts/pack-box.sh", import.meta.url)), ...args], {
    env: { ...process.env, KUVO_BOX_SIGNING_KEY: privateKey.export({ type: "pkcs8", format: "pem" }), NODE: process.execPath }, encoding: "utf8",
  });
  const wrongURL = pack(app, "0.10.0", "https://example.invalid/pack.tgz", out);
  assert.equal(wrongURL.status, 2, "a box finds the pack by the name its URL ends in");
  assert.equal(pack(app, "0.11.0", "https://example.invalid/box-0.11.0.tar.gz", out).status, 1, "the app's own version, or none");
  const packed = pack(app, "0.10.0", "https://example.invalid/releases/download/v0.10.0/box-0.10.0.tar.gz", out);
  assert.equal(packed.status, 0, packed.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ["box-0.10.0.tar.gz", "boxes.json"]);
  const manifest = link.verifyBoxes(fs.readFileSync(path.join(out, "boxes.json"), "utf8"), [pinned]);
  assert.equal(manifest.version, "0.10.0");
  assert.equal(manifest.pack.url, "https://example.invalid/releases/download/v0.10.0/box-0.10.0.tar.gz");

  assert.deepEqual(offer(out), { status: 202, version: "0.10.0" });
  assert.equal((await take()).result, "updated");
  engines.add(read(engineFile).pid);
  assert.equal(boxVersion(), "0.10.0");
  assert.equal(fs.readFileSync(path.join(home, "bin", "kuvo-browser.js"), "utf8"), "// kuvo-browser.js\n");
  if (process.platform === "darwin") assert.equal(fs.readFileSync(path.join(home, "bin", "Kuvo Code Box.app", "Contents", "MacOS", "Kuvo Code Box"), "utf8"), helper["Contents/MacOS/Kuvo Code Box"]);
  assert.equal(link.confirmUpdate(), true);

  // A bundle a box couldn't take (a link in it) isn't packed.
  fs.symlinkSync("/etc/hosts", path.join(app, "Contents", "Helpers", "Kuvo Code Box.app", "Contents", "hosts"));
  const linked = pack(app, "0.10.0", "https://example.invalid/box-0.10.0.tar.gz", path.join(scratch, "never"));
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /can't take .*hosts/);
});
