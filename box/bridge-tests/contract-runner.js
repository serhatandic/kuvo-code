// The route scenarios both boxes answer alike (`protocol/vectors/routes/*.json`), run against the bridge's
// real handler (`engineHandler` in kuvo-link.js) as one box: a machine's (contract.test.js), on a
// box folder of its own with the files a Mac leaves on a machine (`protocol/vectors/routes/box`, written
// from the Mac's code by `scripts/route-vectors.sh`); or this Mac's (contract-mac.test.js), with
// the app's own folders beside its box's (KUVO_BOTS, KUVO_WAKES), for the areas that have moved
// onto it. The real kuvo-wake either way. Only the engine is a stand-in, here and in the Mac's
// runner alike (swift/KuvoCodeTests/RouteContractTests.swift, which runs the same scenarios against the
// Mac's PhoneLink). How a scenario is written: CONTRIBUTING.md, "Route scenarios".
//
// The caller sets the box's folders in the environment first (the bridge reads them as it loads),
// then `contract({ box, root, files? })`.
import "./test-safety.js";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NO_BUN, testBun } from "./bun-for-tests.js";
import { atEnd } from "./at-end.js";
import { keepsIdle } from "./keeps-idle.js";

const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
// The box's folder, and the app's folders for its bots and sessions' wake-ups beside it on a Mac
// (in its own folder on a machine).
const home = process.env.KUVO_HOME;
const botsRoot = process.env.KUVO_BOTS || path.join(home, "bots");
const wakesRoot = process.env.KUVO_WAKES || path.join(home, "wakes");
const wakeCommand = process.env.KUVO_WAKE_COMMAND || path.join(home, "bin", "kuvo-wake");
// Which box this runs as ("machine" or "mac"), and the test's own folder, set by `contract`.
let box = "machine";
let root = "";

// The machine's name, as its Mac knows it: never a host that resolves.
const MACHINE = "lab.invalid";
const vectors = new URL("../../protocol/vectors/routes/", import.meta.url);
const read = (url, name) => fs.readFileSync(new URL(name, url), "utf8");
// What a client puts beside every box's bridge: the integrations, the popular MCP servers, and
// what the box makes bots with and tells them (Kuvo Code's own words, as they ship).
const boxFiles = { "integrations.json": read(vectors, "box/integrations.json"), "mcp-catalog.json": read(vectors, "box/mcp-catalog.json"),
  "bot-words.json": fs.readFileSync(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8") };
// What's this Mac's own that its app gives its box to make bots with (its kit, in the bots' folder).
const macKit = () => read(vectors, "box/mac-bot-kit.json");

// kuvo-wake, as Wakes.swift has it and BoxFiles puts it in every box's bin.
const swift = fs.readFileSync(new URL("../../swift/OpenCodeKit/Sources/OpenCodeKit/Engine/Wakes.swift", import.meta.url), "utf8");
const opening = 'public static let script = #"""\n';
const from = swift.indexOf(opening) + opening.length;
const kuvoWake = swift.slice(from, swift.indexOf('\n    """#', from)).split("\n").map(line => line.replace(/^ {4}/, "")).join("\n") + "\n";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// ---- The engine, a stand-in: the same small engine the Mac's runner stands in with ----

// Its sessions (`given.session`), which run, its sign-ins, and every request it got.
const engine = { sessions: [], running: new Set(), credentials: [], asked: [], made: 0, worktrees: 0, projects: new Map() };
const folderOf = request => {
  try { return decodeURIComponent(request.headers["x-opencode-directory"] ?? ""); } catch { return ""; }
};
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const url = new URL(request.url, "http://engine");
    let given = {};
    try { given = body ? JSON.parse(body) : {}; } catch {}
    engine.asked.push({ method: request.method, path: url.pathname, json: given });
    const send = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /api/session") {
      const parent = url.searchParams.get("parentID");
      return send({ data: engine.sessions.filter(each => parent === null || (parent === "null" ? !each.parentID : each.parentID === parent)) });
    }
    if (route === "GET /api/session/active") return send({ data: Object.fromEntries([...engine.running].map(id => [id, { type: "busy" }])) });
    if (route === "POST /api/session") {
      const made = sessionOf({ id: `ses_made${++engine.made}`, title: given.title ?? "", directory: given.location?.directory ?? "" });
      engine.sessions.push(made);
      return send({ data: made });
    }
    const one = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (one && request.method === "GET") {
      const found = engine.sessions.find(each => each.id === decodeURIComponent(one[1]));
      return found ? send({ data: found }) : send({ message: "No such session." }, 404);
    }
    // What's changed, kept, as the engine keeps it (each field given in place of its own).
    if (one && request.method === "PATCH") {
      const found = engine.sessions.find(each => each.id === decodeURIComponent(one[1]));
      if (!found) return send({ message: "No such session." }, 404);
      Object.assign(found, given);
      return send({ data: found });
    }
    if (route === "GET /api/credential") return send({ data: engine.credentials });
    // Its tools connected (Kuvo Code's own browser's, no integration's), so nothing waits for them.
    if (route === "GET /api/mcp") return send({ data: [{ name: "kuvo-browser", status: { status: "connected" } }] });
    if (["GET /api/skill", "GET /api/provider"].includes(route) || /^GET \/api\/session\/[^/]+\/(message|inbox)$/.test(route)) return send({ data: [] });
    // Worktrees, made and removed with git as the engine does, beside the scenario's repositories:
    // a folder's project is its repository's, by an id of its own, and a worktree is made of the
    // project its id names.
    if (route === "GET /api/location") {
      const folder = folderOf(request);
      let top = null;
      try { top = git(folder, "rev-parse", "--show-toplevel"); } catch {}
      const id = "prj_" + crypto.createHash("sha256").update(top ?? folder).digest("hex").slice(0, 12);
      if (top) engine.projects.set(id, top);
      return send({ directory: folder, project: { id, directory: top ?? folder, canonical: top ?? folder } });
    }
    if (route === "POST /api/worktree") {
      const folder = path.join(root, "worktrees", `brave-otter-${++engine.worktrees}`);
      try { git(engine.projects.get(given.projectID), "worktree", "add", "--quiet", "--detach", folder); } catch { return send({ message: "Not a git project." }, 400); }
      return send({ directory: folder });
    }
    if (route === "DELETE /api/worktree") {
      try { git(engine.projects.get(given.projectID), "worktree", "remove", ...(given.force ? ["--force"] : []), given.directory); } catch { return send({ message: "git refused." }, 400); }
      return send({});
    }
    // What it doesn't have to read, as an engine without it; what's sent, taken.
    send({}, request.method === "GET" ? 404 : 200);
  });
});
keepsIdle(server);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
atEnd(() => { server.closeAllConnections(); server.close(); });
const readEngine = () => ({ port: server.address().port, password: "engine", version: "0.0.0" });

let agentsProcess, browserProcess;
atEnd(() => { agentsProcess?.kill(); browserProcess?.kill(); realBridge?.process.kill(); });

// The coding agents' bridge as the app ships it (`kuvo-agents.js`), run by Bun (bun-for-tests.js), with its group chats in this box's folders: for what it alone decides (a group chat's
// shapes and rules). One a scenario, as the box's folders are.
let realBridge;
const bundled = fileURLToPath(new URL("../../swift/KuvoCode/Resources/kuvo-agents.js", import.meta.url));
async function startRealBridge() {
  const password = crypto.randomBytes(12).toString("hex");
  const bun = testBun();
  assert.ok(bun, NO_BUN);
  const child = spawn(bun, ["run", bundled], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, HOME: root, TMPDIR: path.join(root, "tmp") + "/", BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      KUVO_AGENTS_HOME: path.join(root, "agents"), OPENCODE_PASSWORD: password,
      KUVO_GROUPS: path.join(home, "groups"), KUVO_BOTS: botsRoot, KUVO_TRASH: path.join(home, "trash"),
      KUVO_ARTIFACTS: path.join(home, "artifacts"),
    },
  });
  fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
  const port = await new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk;
      const line = out.split("\n").find(each => each.startsWith("{"));
      if (line) resolve(Number(new URL(JSON.parse(line).url).port));
    });
    child.on("exit", status => reject(new Error(`the agents bridge stopped (${status})`)));
  });
  realBridge = { process: child, port, password, pid: child.pid };
}
async function stopRealBridge() {
  if (!realBridge) return;
  const { process: child } = realBridge;
  realBridge = undefined;
  const gone = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end();
  await gone;
}

// A session as the engine lists it.
function sessionOf({ id, title = "", directory = "", parent, archived, updated = 1 }) {
  return {
    id, title, projectID: "p", cost: 0, ...(parent ? { parentID: parent } : {}),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: updated, updated }, location: { directory },
    ...(archived ? { metadata: { "kuvo.archived": true } } : {}),
  };
}

// ---- A fresh box for each scenario ----

const look = { color: "mint", shape: "round", face: "calm" };
const botFolder = id => path.join(botsRoot, id);

function freshBox() {
  for (const folder of [home, botsRoot, wakesRoot, path.join(root, "work"), path.join(root, "worktrees")]) fs.rmSync(folder, { recursive: true, force: true });
  // A machine's release brings what it makes bots with; this Mac's box has its app's kit.
  for (const [name, text] of Object.entries(boxFiles)) write(path.join(home, "bin", name), text);
  if (box === "mac") write(path.join(botsRoot, "kit.json"), macKit());
  write(wakeCommand, kuvoWake);
  fs.chmodSync(wakeCommand, 0o755);
  // Its settings its own, as a Mac makes them as it first connects (`adoptBox`).
  write(path.join(home, "box", "opencode.json"), "{}\n");
  fs.mkdirSync(path.join(root, "work"), { recursive: true });
  Object.assign(engine, { sessions: [], running: new Set(), credentials: [], asked: [], made: 0, bridgeUp: false, projects: new Map() });
}

// What each box calls its own places, for `{{…}}` in a scenario.
const places = () => ({ chats: path.join(home, "chats"), skills: path.join(home, "config", "opencode", "skills"), work: path.join(root, "work"), keys: path.join(home, "box", "keys") });

// `given`: box state, as this box keeps it.
const fixtures = {
  session(given) {
    engine.sessions.push(sessionOf(given));
    if (given.running) engine.running.add(given.id);
  },
  bot(given) {
    const folder = botFolder(given.id);
    const created = given.created ?? "2026-10-01T09:00:00Z";
    write(path.join(folder, "bot.json"), JSON.stringify({
      kuvo: 1, id: given.id, name: given.name, job: given.job ?? "", look: given.look ?? look,
      ...(given.personality ? { personality: given.personality } : {}), ...(given.model ? { model: given.model } : {}),
      ...(given.project ? { project: given.project } : {}), created, updated: created,
    }));
    write(path.join(folder, "session"), given.session);
    write(path.join(folder, "MEMORY.md"), `# ${given.name}'s memory\n`);
    fs.mkdirSync(path.join(folder, "wakes"), { recursive: true });
    const directory = given.project ?? path.join(folder, "workspace");
    fs.mkdirSync(path.join(folder, "workspace"), { recursive: true });
    write(path.join(folder, "directory"), directory);
    engine.sessions.push(sessionOf({ id: given.session, title: given.name, directory }));
  },
  wake(given) {
    const due = Math.floor(Date.now() / 1000) + given.in;
    write(path.join(ownerFolder(given.session), "wakes", `${due}-${given.letters}${given.every ? `-${given.every}` : ""}`), given.note);
  },
  watch(given) {
    const folder = path.join(ownerFolder(given.session), "watches", given.letters);
    write(path.join(folder, "check"), given.check);
    write(path.join(folder, "every"), given.every);
    write(path.join(folder, "note"), given.note ?? "");
  },
  pause(given) {
    write(path.join(ownerFolder(given.session), "paused"), "paused");
  },
  skill(given) {
    const folder = path.join(places().skills, given.name);
    write(path.join(folder, "SKILL.md"), given.text);
    if (given.github) write(path.join(folder, ".kuvo-source.json"), JSON.stringify({ branch: "main", path: given.github.path, repository: given.github.repository }));
  },
  // One in Recently Deleted, put away `daysAgo` days ago, named by when, as the box keeps them.
  trashedSkill(given) {
    const when = Date.now() - given.daysAgo * 86_400_000;
    const folder = path.join(home, "trash", "skills", `${given.name}-${Math.floor(when / 1000)}`);
    write(path.join(folder, "SKILL.md"), given.text);
  },
  settings(given) {
    write(path.join(home, "box", "opencode.json"), given.text ?? JSON.stringify(given.value));
  },
  key(given) {
    write(path.join(home, "box", "keys", given.name), given.value);
  },
  credential(given) {
    engine.credentials.push({ id: given.id, integrationID: given.integrationID, label: given.label ?? "", active: given.active ?? false, value: { type: "api" } });
  },
  file(given, vars) {
    const file = path.join(root, "work", given.name);
    write(file, given.text);
    vars[`${given.as}.path`] = file;
    vars[`${given.as}.uri`] = pathToFileURL(file).href;
  },
  repository(given, vars) {
    const folder = path.join(root, "work", given.as);
    fs.mkdirSync(folder, { recursive: true });
    git(folder, "init", "-q", "-b", "main");
    for (const [name, text] of Object.entries(given.files ?? { "README.md": "# Project\n" })) write(path.join(folder, name), text);
    git(folder, "add", "-A");
    git(folder, "commit", "-q", "-m", "First");
    vars[given.as] = folder;
  },
  write(given) {
    write(given.path, given.text);
  },
  // What an agent browsing here asks you for, as the browser's keeper leaves it for the bridge
  // (`run/browser-asks.json`, while the keeper runs: a process named as it is stands in for it).
  ask(given) {
    browserProcess ??= spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-browser"], { stdio: "ignore" });
    write(path.join(home, "run", "browser.pid"), String(browserProcess.pid));
    const file = path.join(home, "run", "browser-asks.json");
    const asks = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).asks : [];
    const { id, kind, host } = given;
    const details = kind === "code" ? { prompt: given.prompt ?? "" } : kind === "action" ? { instruction: given.instruction ?? "" } : { username: given.username ?? true, password: given.password ?? true };
    write(file, JSON.stringify({ asks: [...asks, { id, kind, host, ...details }] }));
  },
  // The coding agents' bridge running beside the engine: a process named as it is stands in for
  // its process (the bridge checks it's still that), and the engine's stand-in for what it answers.
  // `groups`: the real one instead, for its group chats.
  async agentsBridge(given) {
    if (given?.groups) return await startRealBridge();
    agentsProcess ??= spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "kuvo-agents"], { stdio: "ignore" });
    engine.bridgeUp = true;
  },
  // Your other computers and their bots, as this box's link tells its coding agents' bridge
  // (`tellSeatPeers`: `{boxes, bots}`), once that runs for real (`agentsBridge.groups`).
  async peers(given) {
    assert.ok(realBridge, "peers are told to the real coding agents' bridge: give agentsBridge.groups first");
    const response = await fetch(`http://127.0.0.1:${realBridge.port}/api/kuvo/peers`, {
      method: "PUT", body: JSON.stringify(given),
      headers: { authorization: `Basic ${Buffer.from(`opencode:${realBridge.password}`).toString("base64")}`, "content-type": "application/json" },
    });
    assert.ok(response.ok, `the agents bridge answered ${response.status}`);
  },
};

// Where a session's wake-ups are kept: its bot's folder, or its own (made as kuvo-wake makes one).
function ownerFolder(session) {
  for (const id of fs.existsSync(botsRoot) ? fs.readdirSync(botsRoot) : []) {
    if (fs.existsSync(path.join(botFolder(id), "session")) && fs.readFileSync(path.join(botFolder(id), "session"), "utf8").trim() === session) return botFolder(id);
  }
  const folder = path.join(wakesRoot, session);
  if (!fs.existsSync(path.join(folder, "session"))) {
    write(path.join(folder, "session"), session);
    write(path.join(folder, "directory"), engine.sessions.find(each => each.id === session)?.location.directory ?? "");
  }
  return folder;
}

// ---- Matching what a box answers with what a scenario expects ----

// `{{name}}` in a string, from the scenario's own (`save`, `as`) and the box's places;
// `{{now+3600}}` is the time then, in seconds. A string that's only one of them takes its value.
function filled(value, vars) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{([^{}]+)\}\}$/);
    if (whole) return lookup(whole[1], vars);
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, name) => String(lookup(name, vars)));
  }
  if (Array.isArray(value)) return value.map(each => filled(each, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, filled(inner, vars)]));
  return value;
}
function lookup(name, vars) {
  const time = name.match(/^now([+-]\d+)?$/);
  if (time) return Math.floor(Date.now() / 1000) + Number(time[1] ?? 0);
  if (!(name in vars)) throw new Error(`{{${name}}} isn't set`);
  return vars[name];
}

const kinds = { "<string>": "string", "<number>": "number", "<bool>": "boolean" };
// Why `actual` isn't what `expected` says, or null when it is (CONTRIBUTING.md, "Route scenarios").
function mismatch(expected, actual, at = "body") {
  if (typeof expected === "string") {
    if (expected === "<any>") return actual === undefined ? `${at} is missing` : null;
    if (expected === "<absent>") return actual === undefined ? null : `${at} should be left out, but is ${JSON.stringify(actual)}`;
    if (kinds[expected]) return typeof actual === kinds[expected] ? null : `${at} should be a ${kinds[expected]}, but is ${JSON.stringify(actual)}`;
    if (expected === "<object>") return actual && typeof actual === "object" && !Array.isArray(actual) ? null : `${at} should be an object, but is ${JSON.stringify(actual)}`;
    if (expected === "<array>") return Array.isArray(actual) ? null : `${at} should be a list, but is ${JSON.stringify(actual)}`;
    return actual === expected ? null : `${at} should be ${JSON.stringify(expected)}, but is ${JSON.stringify(actual)}`;
  }
  // Null and left out are the same to a client (its optionals).
  if (expected === null) return actual === null || actual === undefined ? null : `${at} should be null, but is ${JSON.stringify(actual)}`;
  if (typeof expected !== "object") return actual === expected ? null : `${at} should be ${JSON.stringify(expected)}, but is ${JSON.stringify(actual)}`;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at} should be a list, but is ${JSON.stringify(actual)}`;
    if (actual.length !== expected.length) return `${at} should have ${expected.length}, but has ${actual.length}: ${JSON.stringify(actual)}`;
    for (const [index, each] of expected.entries()) {
      const why = mismatch(each, actual[index], `${at}[${index}]`);
      if (why) return why;
    }
    return null;
  }
  if ("<includes>" in expected || "<excludes>" in expected || "<length>" in expected) {
    if (!Array.isArray(actual)) return `${at} should be a list, but is ${JSON.stringify(actual)}`;
    if ("<length>" in expected && actual.length !== expected["<length>"]) return `${at} should have ${expected["<length>"]}, but has ${actual.length}`;
    for (const each of expected["<includes>"] ?? []) if (!actual.some(item => !mismatch(each, item))) return `${at} has none like ${JSON.stringify(each)}: ${JSON.stringify(actual)}`;
    for (const each of expected["<excludes>"] ?? []) if (actual.some(item => !mismatch(each, item))) return `${at} has one like ${JSON.stringify(each)}: ${JSON.stringify(actual)}`;
    return null;
  }
  if ("<contains>" in expected) return typeof actual === "string" && actual.includes(expected["<contains>"]) ? null : `${at} should contain ${JSON.stringify(expected["<contains>"])}, but is ${JSON.stringify(actual)}`;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return `${at} should be an object, but is ${JSON.stringify(actual)}`;
  for (const [key, each] of Object.entries(expected)) {
    const why = mismatch(each, actual[key], `${at}.${key}`);
    if (why) return why;
  }
  return null;
}

// A value in an answer, by its path (`bot.id`, `worktrees.0.path`).
const pathIn = (value, dotted) => dotted.split(".").reduce((inner, key) => inner?.[key], value);

// ---- Running them ----

// What the box answers a phone's request, whole: as a paired phone's request reaches its handler.
async function ask(handle, method, requestPath, body) {
  const parts = [];
  const raw = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
  for await (const part of handle({ method, path: requestPath, headers: { "content-type": "application/json" }, body: Buffer.from(raw) }, {}, undefined)) parts.push(part);
  const text = Buffer.concat(parts.filter(part => part.body).map(part => part.body)).toString();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: parts[0].head.status, type: parts[0].head.headers?.["content-type"] ?? "", text, json };
}

// ---- What each route answers (protocol/vectors/routes/shapes/answers.json): every answer, whole ----

const shapes = JSON.parse(read(vectors, "shapes/answers.json"));
const show = value => (value === undefined ? "missing" : JSON.stringify(value)?.slice(0, 200));
const isPlain = value => value !== null && typeof value === "object" && !Array.isArray(value);
// Why `value` isn't of `shape`, at its first difference, or null when it is.
function unshaped(shape, value, at = "body") {
  if (value === undefined) return `${at} is missing`;
  if (shape === "any") return null;
  if (shape === "string" || shape === "number") return typeof value === shape ? null : `${at} should be a ${shape}, but is ${show(value)}`;
  if (shape === "bool") return typeof value === "boolean" ? null : `${at} should be true or false, but is ${show(value)}`;
  if (shape === "null") return value === null ? null : `${at} should be null, but is ${show(value)}`;
  if (!isPlain(shape)) return `${at}: ${show(shape)} isn't a shape`;
  if ("literal" in shape) return value === shape.literal ? null : `${at} should be ${show(shape.literal)}, but is ${show(value)}`;
  if ("list" in shape) {
    if (!Array.isArray(value)) return `${at} should be a list, but is ${show(value)}`;
    for (const [index, each] of value.entries()) {
      const why = unshaped(shape.list, each, `${at}[${index}]`);
      if (why) return why;
    }
    return null;
  }
  if ("map" in shape) {
    if (!isPlain(value)) return `${at} should be an object, but is ${show(value)}`;
    for (const [key, each] of Object.entries(value)) {
      const why = unshaped(shape.map, each, `${at}.${key}`);
      if (why) return why;
    }
    return null;
  }
  if ("object" in shape) {
    if (!isPlain(value)) return `${at} should be an object, but is ${show(value)}`;
    const fields = new Map(Object.entries(shape.object).map(([name, each]) => [name.replace(/\?$/, ""), { shape: each, optional: name.endsWith("?") }]));
    for (const key of Object.keys(value)) if (!fields.has(key)) return `${at}.${key} isn't a field it has`;
    for (const [name, field] of fields) {
      if (!(name in value)) {
        if (field.optional) continue;
        return `${at}.${name} is missing`;
      }
      const why = unshaped(field.shape, value[name], `${at}.${name}`);
      if (why) return why;
    }
    return null;
  }
  if ("oneOf" in shape) {
    const whys = shape.oneOf.map(each => unshaped(each, value, at));
    return whys.includes(null) ? null : `${at} is none of what it can be: ${whys.join("; ")}`;
  }
  return `${at}: ${show(shape)} isn't a shape`;
}

const routeOf = (pattern, method, route) => {
  const [wantedMethod, wantedPath] = pattern.split(" ");
  const wanted = wantedPath.split("/"), parts = route.split("/");
  return wantedMethod === method && wanted.length === parts.length && wanted.every((part, i) => part.startsWith(":") ? parts[i] !== "" : part === parts[i]);
};
// Why an answer isn't what its route answers (null when it is): every answer of every route, the
// box's own, not only what a scenario names.
function offShape(method, requestPath, answer) {
  const route = requestPath.split("?")[0];
  if (shapes.passedOn.some(prefix => route.startsWith(prefix))) return null;
  const isJSON = answer.type.startsWith("application/json");
  const verb = method.toUpperCase();
  // A HEAD is held to its GET's shape, or has no body.
  const known = shapes.routes.find(each => routeOf(each.route, verb, route)) ?? (verb === "HEAD" ? shapes.routes.find(each => routeOf(each.route, "GET", route)) : undefined);
  // A refusal says why in the one way all do, or in its route's own where it has one. A HEAD's
  // answer has no body.
  if (answer.status >= 400) return isJSON ? unshaped(known?.answers[answer.status] ?? shapes.error, answer.json, "the refusal") : null;
  if (verb === "HEAD" && answer.text === "") return known ? null : `HEAD ${route} has no shape in box/src/shared/routes`;
  if (!known) return `${verb} ${route} has no shape in box/src/shared/routes`;
  const shape = known.answers[answer.status];
  if (shape === undefined) return `${known.route} has no shape for ${answer.status}`;
  if (shape === "bytes") return null;
  return isJSON ? unshaped(shape, answer.json, "the answer") : `${known.route} answered ${answer.type || "no type"}, not JSON`;
}

// The first field an answer has that `expected` doesn't name, for a step that names it whole
// (`"whole": true`), so both boxes are held to the very same answer; null when there's none.
function unnamed(expected, actual, at = "body") {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (const [index, each] of expected.entries()) {
      const why = unnamed(each, actual[index], `${at}[${index}]`);
      if (why) return why;
    }
    return null;
  }
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(expected) || !isObject(actual) || ["<includes>", "<excludes>", "<length>", "<contains>"].some(key => key in expected)) return null;
  for (const key of Object.keys(actual)) {
    if (!(key in expected)) return `${at}.${key} is there, but the whole answer doesn't name it`;
    const why = unnamed(expected[key], actual[key], `${at}.${key}`);
    if (why) return why;
  }
  return null;
}

// What a step expects of this box: its own, where the boxes differ on purpose.
const forBox = expect => (expect && ("mac" in expect || "machine" in expect) ? expect[box] : expect);
const isOurs = only => only === undefined || only === box;

async function run(scenario) {
  await stopRealBridge();
  freshBox();
  const vars = { ...places() };
  // The running bridge's notices held while you're at a computer: none to send here, on a clock
  // that never wakes it.
  const hold = new link.NoticeHold({ send: () => true, setTimer: () => 0, clearTimer: () => {} });
  const handle = link.engineHandler(readEngine, { name: box === "mac" ? "Mac" : MACHINE }, () => realBridge ?? (engine.bridgeUp ? { ...readEngine(), pid: agentsProcess.pid } : null), undefined, hold);
  for (const [index, step] of scenario.steps.entries()) {
    if (!isOurs(step.only)) continue;
    const where = `step ${index + 1}${step.send ? ` (${step.send})` : ""}`;
    if (step.given) {
      for (const [kind, given] of Object.entries(step.given)) {
        assert.ok(fixtures[kind], `${where}: no fixture “${kind}”`);
        await fixtures[kind](filled(given, vars), vars);
      }
      continue;
    }
    if (step.send) {
      const [method, ...rest] = step.send.split(" ");
      const answer = await ask(handle, method, filled(rest.join(" "), vars), step.body === undefined ? undefined : filled(step.body, vars));
      const expect = filled(forBox(step.expect), vars);
      const offShaped = offShape(method, filled(rest.join(" "), vars), answer);
      assert.equal(offShaped, null, `${where}: ${offShaped}`);
      if (expect) {
        assert.equal(answer.status, expect.status, `${where}: status ${answer.status}, not ${expect.status}: ${answer.text.slice(0, 400)}`);
        if (expect.type) assert.ok(answer.type.startsWith(expect.type), `${where}: content-type ${answer.type}, not ${expect.type}`);
        if (expect.text !== undefined) assert.equal(answer.text, expect.text, `${where}: body`);
        if (expect.json !== undefined) {
          const why = mismatch(expect.json, answer.json) ?? (expect.whole ? unnamed(expect.json, answer.json) : null);
          assert.equal(why, null, `${where}: ${why}`);
        }
      }
      for (const [name, dotted] of Object.entries(step.save ?? {})) {
        const value = pathIn(answer.json, dotted);
        assert.notEqual(value, undefined, `${where}: nothing at ${dotted} to save as ${name}`);
        vars[name] = value;
      }
      continue;
    }
    if (step.engineGot) {
      const wanted = filled(step.engineGot, vars);
      const got = engine.asked.filter(each => each.method === wanted.method && each.path === wanted.path).at(-1);
      assert.ok(got, `${where}: the engine got no ${wanted.method} ${wanted.path}: ${JSON.stringify(engine.asked.map(each => `${each.method} ${each.path}`))}`);
      const why = mismatch(wanted.json ?? {}, got.json, "sent");
      assert.equal(why, null, `${where}: ${why}`);
      continue;
    }
    assert.fail(`${where}: a step gives, sends or checks what the engine got`);
  }
}

/** Runs the scenarios (of `files`, or all) as `as`'s box ("machine" or "mac"), with `folder` the
 * test's own for what a scenario makes outside the box. */
export function contract({ box: as, root: folder, files }) {
  box = as;
  root = folder;
  // Every scenario starts by emptying these: they're the test's own, whatever the environment says.
  for (const [name, given] of Object.entries({ KUVO_HOME: home, KUVO_BOTS: botsRoot, KUVO_WAKES: wakesRoot, KUVO_WAKE_COMMAND: wakeCommand })) {
    if (!path.resolve(given).startsWith(path.resolve(root) + path.sep)) throw new Error(`${name} is ${given}, outside this test's own folder ${root}: not running the scenarios.`);
  }
  for (const file of fs.readdirSync(vectors).filter(name => name.endsWith(".json") && (!files || files.includes(name))).sort()) {
    const { scenarios } = JSON.parse(read(vectors, file));
    for (const scenario of scenarios) {
      // One that's the other box's alone is listed, said to be so, and not run.
      test(`${file}: ${scenario.name}`, { skip: isOurs(scenario.only) ? false : `the ${scenario.only === "mac" ? "Mac" : "machine"}'s alone: ${scenario.why}` }, () => run(scenario));
    }
  }


  // Once, with the machine's runner: what holds both runners to the same scenarios.
  if (box !== "machine") return;

  // Both runners hold answers to shapes alike.
  test("both runners hold an answer to its shape alike (protocol/vectors/routes/shapes/cases.json)", () => {
    const { cases } = JSON.parse(read(vectors, "shapes/cases.json"));
    assert.ok(cases.length > 20);
    for (const each of cases) assert.equal(unshaped(each.shape, "value" in each ? each.value : undefined) === null, each.matches, JSON.stringify(each));
  });

  // And judge an answer by its route alike: which route it is, its status, a refusal, a HEAD.
  test("both runners judge an answer by its route alike (protocol/vectors/routes/shapes/routes.json)", () => {
    const { cases } = JSON.parse(read(vectors, "shapes/routes.json"));
    assert.ok(cases.length > 15);
    for (const each of cases) {
      const [method, requestPath] = each.send.split(" ");
      let json;
      try { json = JSON.parse(each.body); } catch {}
      const why = offShape(method, requestPath, { status: each.status, type: each.type, text: each.body, json });
      assert.equal(why === null, each.matches, `${JSON.stringify(each)}: ${why}`);
    }
  });

  // The Mac's runner holds its matching to the same cases.
  test("both runners match an answer and fill in a scenario alike (protocol/vectors/routes/match/cases.json)", () => {
    const { cases, filled: fills } = JSON.parse(read(vectors, "match/cases.json"));
    assert.ok(cases.length > 40 && fills.length > 5);
    for (const each of cases) {
      const actual = "actual" in each ? each.actual : undefined;
      assert.equal((mismatch(each.expected, actual) ?? (each.whole ? unnamed(each.expected, actual) : null)) === null, each.matches, JSON.stringify(each));
    }
    for (const each of fills) assert.deepEqual(filled(each.template, each.vars), each.filled, JSON.stringify(each));
  });

  // So a scenario can't pass by checking nothing: each has a name of its own, each step does one
  // thing, each request says what it expects of both boxes, and each difference says why.
  test("every scenario is written so both runners check it, and says why where the boxes differ on purpose", () => {
    const names = new Set();
    const boxes = ["mac", "machine"];
    const only = (keys, allowed, where) => keys.forEach(key => assert.ok(allowed.includes(key), `${where}: “${key}” isn't something a runner reads`));
    for (const file of fs.readdirSync(vectors).filter(name => name.endsWith(".json"))) {
      for (const scenario of JSON.parse(read(vectors, file)).scenarios) {
        const named = `${file}: ${scenario.name}`;
        assert.ok(scenario.name && !names.has(named), `${named}: a scenario needs a name of its own`);
        names.add(named);
        only(Object.keys(scenario), ["name", "only", "why", "steps"], named);
        if (scenario.only) assert.ok(boxes.includes(scenario.only) && scenario.why, `${named} is one box's only, without why`);
        assert.ok(scenario.steps?.length, `${named} has no steps`);
        for (const [index, step] of scenario.steps.entries()) {
          const where = `${named}, step ${index + 1}`;
          assert.equal(["given", "send", "engineGot"].filter(key => key in step).length, 1, `${where}: a step gives, sends or checks what the engine got`);
          if (step.only) assert.ok(boxes.includes(step.only) && step.why, `${where} is one box's only, without why`);
          if (step.given) {
            only(Object.keys(step), ["given", "only", "why"], where);
            assert.equal(Object.keys(step.given).length, 1, `${where}: one fixture a step, so both runners give them in the same order`);
            assert.ok(fixtures[Object.keys(step.given)[0]], `${where}: no fixture “${Object.keys(step.given)[0]}”`);
          }
          if (step.engineGot) only(Object.keys(step), ["engineGot", "only", "why"], where);
          if (step.send) {
            only(Object.keys(step), ["send", "body", "expect", "save", "only", "why"], where);
            assert.match(step.send, /^[A-Za-z]+ \S+$/, `${where}: send is "METHOD path"`);
            const perBox = step.expect && boxes.some(box => box in step.expect);
            if (perBox) {
              only(Object.keys(step.expect), boxes, where);
              assert.ok(step.why, `${where} differs by box without why`);
            }
            for (const expect of perBox ? boxes.map(box => step.expect[box]) : [step.expect]) {
              assert.ok(Number.isInteger(expect?.status), `${where}: says what status it expects${perBox ? " of each box" : ""}`);
              only(Object.keys(expect), ["status", "json", "type", "text", "whole"], where);
              if (expect.whole) assert.ok(expect.json !== undefined, `${where}: a whole answer names its json`);
            }
          }
        }
      }
    }
  });
}
