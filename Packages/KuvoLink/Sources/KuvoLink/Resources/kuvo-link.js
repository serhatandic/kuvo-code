// Built from Packages/Box/src by scripts/build-box.sh: change those, then run it. Never edit this file.

// Packages/Box/src/link/main.ts
import { spawn as spawn6 } from "node:child_process";
import crypto24 from "node:crypto";
import fs54 from "node:fs";
import os10 from "node:os";
import path55 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// Packages/Box/src/shared/wait.ts
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var pause = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted)
    return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});
var soon = (run, ms) => setTimeout(run, ms).unref?.();

// Packages/Box/src/link/areas/asks.ts
import fs3 from "node:fs";
import net from "node:net";
import os2 from "node:os";
import path2 from "node:path";

// Packages/Box/src/shared/json.ts
function sortedJSON(value) {
  if (Array.isArray(value))
    return `[${value.map(sortedJSON).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value;
    return `{${Object.keys(object).sort().filter((k) => object[k] !== undefined).map((k) => `${JSON.stringify(k)}:${sortedJSON(object[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
var isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
var parsed = (body) => {
  try {
    return JSON.parse(Buffer.from(body ?? "").toString() || "{}");
  } catch {
    return;
  }
};
var sameJSON = (a, b) => sortedJSON(a ?? null) === sortedJSON(b ?? null);

// Packages/Box/src/shared/platform.ts
import fs from "node:fs";
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processRuns(pid, name, proc = "/proc") {
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid))
    return false;
  try {
    return fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8").includes(name);
  } catch {
    return !fs.existsSync(proc);
  }
}
function promptedFolders(platform = process.platform) {
  return platform === "darwin" ? new Set(["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"]) : new Set;
}

// Packages/Box/src/link/engine/client.ts
import fs2 from "node:fs";

// Packages/Box/src/link/home.ts
import os from "node:os";
import path from "node:path";
function homeFolder() {
  return process.env.HOME || os.homedir();
}
var K = process.env.KUVO_HOME || path.join(homeFolder(), ".kuvo-code");
var RUN = path.join(K, "run");
var LINK_FILE = path.join(RUN, "link.json");
var ENGINE_FILE = path.join(RUN, "engine.json");
var BRIDGE_FILE = path.join(RUN, "bridge.json");
var PID_FILE = path.join(RUN, "link.pid");
var NEEDED_FILE = path.join(RUN, "link.needed");
var VERSION_FILE = path.join(RUN, "link.version");
var BOX = path.join(K, "box");
var home = homeFolder();
var shownRoot = K.startsWith(home + "/") ? "~" + K.slice(home.length) : K;
var BOX_KEYS = path.join(BOX, "keys");
var BOT_KEYS = path.join(K, "box", "bot-keys");
var UPDATES = path.join(K, "updates");
var SEARCH = path.join(K, "search");
var INTEGRATION_DATA = process.env.KUVO_INTEGRATIONS || path.join(K, "integrations");
var ENGINE_DATA = process.env.KUVO_ENGINE_DATA || path.join(K, "data", "opencode");
var SESSION_WAKES = process.env.KUVO_WAKES || path.join(K, "wakes");
var WAKE_COMMAND = process.env.KUVO_WAKE_COMMAND || path.join(K, "bin", "kuvo-wake");
var APP_KEY_FILES = process.env.KUVO_KEYS ? process.env.KUVO_KEYS.replace(/\/+$/, "") : null;
var IN_TEST_FOLDER = path.resolve(K) !== path.join(homeFolder(), ".kuvo-code");
var CONFIG_LOCK = path.join(RUN, ".config.lock");
var BOTS = process.env.KUVO_BOTS || path.join(K, "bots");
var IS_MAC = process.env.KUVO_BOX === "mac";
var HERE = IS_MAC ? "this Mac" : "this machine";
var ENGINE_CONFIG = process.env.KUVO_ENGINE_CONFIG;
if (IS_MAC && !ENGINE_CONFIG)
  throw new Error("This Mac's box was started without KUVO_ENGINE_CONFIG, the folder its engine's settings are in.");
var LAUNCH_HOST = process.env.KUVO_HOST_URL && process.env.KUVO_HOST_PASSWORD ? { url: process.env.KUVO_HOST_URL.replace(/\/+$/, ""), password: process.env.KUVO_HOST_PASSWORD } : null;
var KEYS_ON_HOST = process.env.KUVO_KEYS_ON_HOST === "1" || Boolean(process.env.KUVO_HOST_URL);
delete process.env.KUVO_HOST_PASSWORD;
var HOST_VAULT_SECRET = process.env.KUVO_HOST_VAULT_SECRET || null;
var MAC_VAULT_FILE_KEY = process.env.KUVO_VAULT_FILE_KEY ? Buffer.from(process.env.KUVO_VAULT_FILE_KEY, "base64url") : null;
delete process.env.KUVO_HOST_VAULT_SECRET;
delete process.env.KUVO_VAULT_FILE_KEY;
function takeVaultSecrets(given) {
  if (typeof given.hostVaultSecret === "string" && given.hostVaultSecret)
    HOST_VAULT_SECRET = given.hostVaultSecret;
  if (typeof given.vaultFileKey === "string" && given.vaultFileKey)
    MAC_VAULT_FILE_KEY = Buffer.from(given.vaultFileKey, "base64url");
}
var SCRIPT = "";
var scriptIs = (file) => {
  SCRIPT = file;
};

// Packages/Box/src/link/engine/client.ts
var readEngineFile = () => JSON.parse(fs2.readFileSync(ENGINE_FILE, "utf8"));
var readBridgeFile = () => JSON.parse(fs2.readFileSync(BRIDGE_FILE, "utf8"));
function peerTargets() {
  const targets = [];
  try {
    targets.push(readEngineFile());
  } catch {}
  try {
    const bridge = readBridgeFile();
    if (bridge?.port && bridge?.password && processRuns(bridge.pid, "kuvo-agents"))
      targets.push(bridge);
  } catch {}
  return targets;
}
function engineGet(engine, route) {
  return fetch(`http://127.0.0.1:${engine.port}/${route}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` }, signal: AbortSignal.timeout(1e4) }).then((response) => response.ok ? response.json() : Promise.reject(new Error(`${response.status}`)));
}
async function asked(target, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${target.port}/${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok)
    throw new Error(`It answered ${response.status}.`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
async function call(target, method, route, body, signal, folder) {
  const response = await fetch(`http://127.0.0.1:${target.port}${route}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`,
      ...body ? { "content-type": "application/json" } : {},
      ...folder ? { "x-opencode-directory": encodeURIComponent(folder) } : {}
    },
    body: body ? JSON.stringify(body) : undefined,
    signal
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(typeof value?.message === "string" && value.message || `It answered ${response.status}.`);
  return value?.data ?? value;
}
async function fetched(url, most, timeout) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: "follow" });
  if (!response.ok)
    throw new Error(`It answered ${response.status}.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > most)
    throw new Error("It's larger than a release can be.");
  return data;
}

// Packages/Box/src/link/areas/asks.ts
var ASKS_FILE = path2.join(RUN, "browser-asks.json");
var BROWSER_SOCKET = path2.join(RUN, "browser.sock");
var BROWSER_PID = path2.join(RUN, "browser.pid");
function readAsks(browserRuns = () => processRuns(Number(fs3.readFileSync(BROWSER_PID, "utf8")), "kuvo-browser")) {
  try {
    if (!browserRuns())
      return [];
    const asks = JSON.parse(fs3.readFileSync(ASKS_FILE, "utf8")).asks;
    return Array.isArray(asks) ? asks.filter((ask) => typeof ask?.id === "string" && ["signIn", "code", "action"].includes(ask.kind)) : [];
  } catch {
    return [];
  }
}
function listedAsk(ask, machine, asker) {
  const listed = { id: ask.id, kind: ask.kind, host: String(ask.host ?? ""), machine };
  if (typeof ask.session === "string")
    listed.session = ask.session;
  if (asker)
    listed.asker = asker;
  if (ask.kind === "signIn")
    Object.assign(listed, { username: Boolean(ask.username), password: Boolean(ask.password), saved: [], offersToSave: false });
  if (ask.kind === "code")
    listed.prompt = String(ask.prompt ?? "");
  if (ask.kind === "action")
    listed.instruction = String(ask.instruction ?? "");
  return listed;
}
function askAnswer(ask, given) {
  const text = (value) => typeof value === "string" && value !== "" ? value : undefined;
  switch (given?.answer) {
    case "signIn": {
      if (ask.kind !== "signIn" || given.saved != null)
        return null;
      const username = text(given.username), password = text(given.password);
      return username || password ? { type: "signIn", username, password } : null;
    }
    case "code": {
      const code = typeof given.code === "string" ? given.code.trim() : "";
      return ask.kind === "code" && code ? { type: "code", code } : null;
    }
    case "done":
      return ask.kind === "action" ? { type: "done" } : null;
    case "declined":
      return { type: "declined" };
    default:
      return null;
  }
}
function answerAsk(id, answer, socketPath = BROWSER_SOCKET) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const done = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 5000);
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(JSON.stringify({ id: 1, method: "Kuvo.answer", params: { id, answer } }) + `
`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf(`
`)) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          if (JSON.parse(line).id === 1)
            return done(true);
        } catch {}
      }
    });
  });
}
function askNotice(ask, asker) {
  const host = String(ask.host ?? "");
  const title = { signIn: `Sign in to ${host}`, code: `Code for ${host}`, action: `Your turn on ${host}` }[ask.kind];
  const body = ask.kind === "signIn" ? "The agent needs your sign-in to go on." : ask.kind === "code" ? ask.prompt || "The agent needs a code to go on." : String(ask.instruction ?? "");
  const session = typeof ask.session === "string" ? ask.session : undefined;
  return { title, subtitle: asker || undefined, body, category: "ask", thread: session ?? ask.id, data: { ...session ? { session } : {}, ask: ask.id } };
}
var conversations = new Map;
async function conversationOf(session, readEngine = readEngineFile) {
  if (!session)
    return null;
  if (conversations.has(session))
    return conversations.get(session);
  try {
    const engine = readEngine();
    let current = (await engineGet(engine, `api/session/${encodeURIComponent(session)}`)).data;
    for (let step = 0;step < 5 && current?.parentID; step++)
      current = (await engineGet(engine, `api/session/${encodeURIComponent(current.parentID)}`)).data;
    const found = { id: current?.id ?? session, name: current?.title || null };
    if (conversations.size > 200)
      conversations.clear();
    conversations.set(session, found);
    return found;
  } catch {
    return { id: session, name: null };
  }
}
async function inConversation(ask, readEngine) {
  const conversation = await conversationOf(ask.session, readEngine);
  return { ask: conversation ? { ...ask, session: conversation.id } : ask, asker: conversation?.name ?? null };
}
async function watchAsks(tell, { signal, every = 2000, read = readAsks, answered = () => {} } = {}) {
  const told = new Set;
  let seen = new Set;
  while (!signal?.aborted) {
    try {
      const asks = read();
      const open = new Set(asks.map((ask) => ask.id));
      for (const id of told) {
        if (open.has(id))
          continue;
        told.delete(id);
        answered(id);
      }
      for (const ask of asks) {
        if (told.has(ask.id) || !seen.has(ask.id))
          continue;
        const { ask: shown, asker } = await inConversation(ask);
        if (tell(askNotice(shown, asker)))
          told.add(ask.id);
      }
      seen = open;
    } catch {}
    await pause(every, signal);
  }
}
async function* asksRoute(context) {
  const { request, signal, route, readEngine, info, json } = context;
  const method = request.method.toUpperCase();
  if (method !== "GET" && !(method === "HEAD" && route === "kuvo/asks"))
    return yield* json(405, {});
  const read = async () => ({
    asks: await Promise.all(readAsks().map(async (ask) => {
      const { ask: shown, asker } = await inConversation(ask, readEngine);
      return listedAsk(shown, info.name ?? os2.hostname(), asker);
    }))
  });
  if (route === "kuvo/asks")
    return yield* json(200, await read());
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  let last = "";
  while (!signal?.aborted) {
    const line = JSON.stringify(await read());
    if (line !== last) {
      yield { body: Buffer.from(line + `
`) };
      last = line;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  return;
}
async function* askAnswerRoute(context, answering) {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  const ask = readAsks().find((each) => each.id === decodeURIComponent(answering[1]));
  if (!ask)
    return yield* json(404, {});
  const given = parsed(request.body);
  const answer = askAnswer(ask, given);
  if (!answer)
    return yield* json(400, given?.saved != null ? { message: "Saved passwords are on your Mac: type this one." } : {});
  return yield* json(await answerAsk(ask.id, answer) ? 200 : 503, {});
}

// Packages/Box/src/link/areas/bot-keys.ts
import fs9 from "node:fs";
import path9 from "node:path";

// Packages/Box/src/link/bots/here.ts
import path4 from "node:path";

// Packages/Box/src/link/files.ts
import fs4 from "node:fs";
import path3 from "node:path";
var textOf = (file) => {
  try {
    return fs4.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
var listOf = (folder) => {
  try {
    return fs4.readdirSync(folder);
  } catch {
    return [];
  }
};
function writePrivate(file, text) {
  fs4.mkdirSync(path3.dirname(file), { recursive: true, mode: 448 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs4.writeFileSync(temporary, text, { mode: 384 });
  fs4.renameSync(temporary, file);
}
function locked(lock, work, { stale = 1e4, wait = 3000 } = {}) {
  fs4.mkdirSync(path3.dirname(lock), { recursive: true, mode: 448 });
  const nap = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let i = 0;i < wait / 10 && !held; i++) {
    try {
      fs4.mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - fs4.statSync(lock).mtimeMs > stale)
          fs4.rmdirSync(lock);
      } catch {}
      Atomics.wait(nap, 0, 0, 10);
    }
  }
  try {
    return work();
  } finally {
    if (held)
      try {
        fs4.rmdirSync(lock);
      } catch {}
  }
}

// Packages/Box/src/link/bots/here.ts
var DESCRIPTION = 1;
function botHere(id) {
  if (typeof id !== "string" || !/^bot_[A-Za-z0-9]+$/.test(id))
    return null;
  const folder = path4.join(BOTS, id);
  let described;
  try {
    described = JSON.parse(textOf(path4.join(folder, "bot.json")) ?? "");
  } catch {
    return null;
  }
  const session = (textOf(path4.join(folder, "session")) ?? "").trim();
  if (described?.kuvo !== DESCRIPTION || described.id !== id || typeof described.name !== "string" || !session)
    return null;
  return { folder, described, session, agents: (textOf(path4.join(folder, "via")) ?? "").trim() === "bridge" };
}
var isMoving = (folder) => (textOf(path4.join(folder, "paused")) ?? "").trim() === "moving";
var MOVING = "It’s moving to another computer. Try again once it’s there.";
var isModel = (model) => Boolean(model) && typeof model.id === "string" && typeof model.providerID === "string";
var botLook = (look) => ({ color: look.color, shape: look.shape, face: look.face });
var botModel = (model) => ({ id: model.id, providerID: model.providerID, ...typeof model.variant === "string" ? { variant: model.variant } : {} });
var sameModel = (a, b) => (a?.id ?? null) === (b?.id ?? null) && (a?.providerID ?? null) === (b?.providerID ?? null) && (a?.variant ?? null) === (b?.variant ?? null);
var botFollowers = new Set;
var noteBotsChanged = () => {
  for (const tell of botFollowers)
    tell();
};

// Packages/Box/src/link/host-interface.ts
import crypto2 from "node:crypto";
import fs5 from "node:fs";
import path5 from "node:path";

// Packages/Box/src/shared/text.ts
import crypto from "node:crypto";
var oneLine = (text, limit) => Array.from(String(text).replace(/[\t\r\n]/g, " ")).slice(0, limit).join("");
var stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
var newID = (prefix) => prefix + Array.from(crypto.randomBytes(10), (byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36]).join("");
var plainName = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").split(/\s+/).filter(Boolean).join(" ");
function prefixBytes(text, bytes) {
  let out = "", count = 0;
  for (const character of text) {
    count += Buffer.byteLength(character);
    if (count > bytes)
      break;
    out += character;
  }
  return out;
}
var cut = (text, count) => text.length <= count ? text : text.slice(0, count - 1) + "…";
var quote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

// Packages/Box/src/link/host-interface.ts
class KeysUnavailable extends Error {
}
var HOST_FILE = path5.join(RUN, "host.json");
var NOT_ANSWERING = "Kuvo Code isn't answering for this Mac's keys. Try again in a moment.";
function appHost() {
  if (!KEYS_ON_HOST)
    return null;
  try {
    const text = fs5.readFileSync(HOST_FILE, "utf8");
    const said = JSON.parse(text);
    if (typeof said?.url === "string" && said.url && typeof said?.password === "string" && said.password) {
      return { url: said.url.replace(/\/+$/, ""), password: said.password, said: text };
    }
  } catch {}
  return LAUNCH_HOST && { ...LAUNCH_HOST, said: "launch" };
}
function helloProof(password, nonce, url) {
  const reached = new URL(url);
  return crypto2.createHmac("sha256", password).update(`kuvo-host-hello\x00${nonce}\x00${reached.hostname}:${reached.port || 80}`).digest("hex");
}
var provenBy = null;
var vaultProvenBy = null;
function forgetHostProof() {
  provenBy = null;
  vaultProvenBy = null;
}
async function proveHost(host) {
  if (provenBy === host.said)
    return;
  const nonce = crypto2.randomBytes(32).toString("hex");
  let proof = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(15000)
    });
    const answer = await response.json().catch(() => null);
    if (response.ok && typeof answer?.proof === "string")
      proof = Buffer.from(answer.proof);
  } catch {}
  const expected = Buffer.from(helloProof(host.password, nonce, host.url));
  if (!proof || proof.length !== expected.length || !crypto2.timingSafeEqual(proof, expected))
    throw new KeysUnavailable(NOT_ANSWERING);
  provenBy = host.said;
}
async function proveVaultHost(host) {
  if (!HOST_VAULT_SECRET)
    throw new KeysUnavailable("Kuvo Code on this Mac didn't give its vault its secret. Quit Kuvo Code and open it again.");
  if (vaultProvenBy === host.said)
    return;
  const nonce = crypto2.randomBytes(32).toString("hex");
  let proof = null;
  try {
    const response = await fetch(`${host.url}/hello`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce, vault: true }),
      signal: AbortSignal.timeout(15000)
    });
    const answer = await response.json().catch(() => null);
    if (response.ok && typeof answer?.vaultProof === "string")
      proof = Buffer.from(answer.vaultProof);
  } catch {}
  const reached = new URL(host.url);
  const expected = Buffer.from(crypto2.createHmac("sha256", HOST_VAULT_SECRET).update(`kuvo-host-vault\x00${nonce}\x00${reached.hostname}:${reached.port || 80}`).digest("hex"));
  if (!proof || proof.length !== expected.length || !crypto2.timingSafeEqual(proof, expected))
    throw new KeysUnavailable(NOT_ANSWERING);
  vaultProvenBy = host.said;
}
var vaultAuth = (call, body, at) => crypto2.createHmac("sha256", HOST_VAULT_SECRET ?? "").update(`kuvo-host-vault-call\x00${call}\x00${crypto2.createHash("sha256").update(body).digest("hex")}\x00${at}`).digest("hex");
async function hostTrash(folder) {
  const host = appHost();
  if (!host)
    return;
  await proveHost(host);
  const response = await fetch(`${host.url}/trash`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
    body: JSON.stringify({ path: folder }),
    signal: AbortSignal.timeout(15000)
  });
  await response.body?.cancel().catch(() => {});
}
async function askHost(host, call, body, missing = false) {
  await proveHost(host);
  const sent = JSON.stringify(body);
  const vault = call.startsWith("vault/");
  if (vault)
    await proveVaultHost(host);
  const at = Date.now();
  let response;
  try {
    response = await fetch(`${host.url}/${call}`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json", ...vault ? { "x-kuvo-vault-auth": vaultAuth(call, sent, at), "x-kuvo-vault-at": String(at) } : {} },
      body: sent,
      signal: AbortSignal.timeout(["keys/get", "keys/set", "link/identity", "vault/get", "vault/set"].includes(call) ? 120000 : 15000)
    });
  } catch {
    provenBy = null;
    vaultProvenBy = null;
    throw new KeysUnavailable(NOT_ANSWERING);
  }
  if (missing && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  let answer = null;
  try {
    answer = await response.json();
  } catch {}
  if (response.status < 200 || response.status > 299) {
    const said = typeof answer?.message === "string" && answer.message.trim() ? ` ${oneLine(answer.message, 300)}` : "";
    throw new KeysUnavailable(`This Mac's keys couldn't be reached (${response.status}).${said}`);
  }
  return answer ?? {};
}
async function siteSignIns() {
  const host = appHost();
  if (!host)
    return null;
  try {
    const answer = await askHost(host, "sites/signed-in", {});
    return isObject(answer?.sites) ? answer.sites : null;
  } catch {
    return null;
  }
}
async function linkHost(call, body) {
  const host = appHost();
  if (!host)
    return null;
  try {
    return await askHost(host, call, body ?? {});
  } catch {
    return null;
  }
}
async function macMoving(session) {
  return (await linkHost("link/moving", { session }))?.moving === true;
}

// Packages/Box/src/link/keys.ts
import fs6 from "node:fs";
import path6 from "node:path";
var STORED_KEY = /^KUVO_KEY_[A-Z0-9_]+$/;
function keyHost() {
  const host = appHost();
  if (KEYS_ON_HOST && !host)
    throw new KeysUnavailable(NOT_ANSWERING);
  return host;
}
var keyQueue = Promise.resolve();
function keyWork(work) {
  const run = keyQueue.then(work, work);
  keyQueue = run.catch(() => {});
  return run;
}
var checkedKeyName = (name) => {
  if (typeof name !== "string" || !STORED_KEY.test(name))
    throw new KeysUnavailable("That isn't a key's name.");
  return name;
};
var keyFile = (name) => path6.join(checkedKeyName(name).includes("__") ? BOT_KEYS : BOX_KEYS, name);
async function keyNames({ prefix = "", suffix = "" } = {}) {
  if (typeof prefix !== "string" || typeof suffix !== "string" || prefix && !/^KUVO_KEY_[A-Z0-9_]*$/.test(prefix) || suffix && !/^[A-Z0-9_]+$/.test(suffix)) {
    throw new KeysUnavailable("That isn't a part of a key's name.");
  }
  const host = keyHost();
  let names;
  if (host) {
    const answer = await askHost(host, "keys/names", { ...prefix ? { prefix } : {}, ...suffix ? { suffix } : {} });
    if (!Array.isArray(answer.names))
      throw new KeysUnavailable("This Mac's keys couldn't be read.");
    names = answer.names;
  } else {
    names = [...listOf(BOX_KEYS).filter((name) => !name.includes("__")), ...listOf(BOT_KEYS).filter((name) => name.includes("__"))];
  }
  return [...new Set(names.filter((name) => typeof name === "string" && STORED_KEY.test(name) && name.startsWith(prefix) && name.endsWith(suffix)))].sort();
}
async function readKey(name) {
  checkedKeyName(name);
  const host = keyHost();
  if (!host)
    return textOf(keyFile(name));
  const answer = await askHost(host, "keys/get", { name }, true);
  return typeof answer?.value === "string" ? answer.value : null;
}
async function writeKey(name, value) {
  checkedKeyName(name);
  if (typeof value !== "string")
    throw new KeysUnavailable("A key is text.");
  const host = keyHost();
  if (host)
    return void await askHost(host, "keys/set", { name, value });
  if (name.includes("__"))
    writePrivate(keyFile(name), value);
  else
    locked(CONFIG_LOCK, () => writePrivate(keyFile(name), value));
}
async function deleteKey(name) {
  checkedKeyName(name);
  const host = keyHost();
  if (host)
    return void await askHost(host, "keys/delete", { name });
  if (name.includes("__"))
    fs6.rmSync(keyFile(name), { force: true });
  else
    locked(CONFIG_LOCK, () => fs6.rmSync(keyFile(name), { force: true }));
}
var botVariable = (variable, bot) => `${variable}__${String(bot).toUpperCase().replace(/[^\p{L}\p{N}]/gu, "_")}`;

// Packages/Box/src/link/areas/integrations.ts
import { spawn } from "node:child_process";
import fs8 from "node:fs";
import path8 from "node:path";

// Packages/Box/src/link/areas/config.ts
import fs7 from "node:fs";
import path7 from "node:path";
var CONFIG_FILE = IS_MAC ? path7.join(ENGINE_CONFIG, "opencode", "opencode.json") : path7.join(BOX, "opencode.json");
var OWN_MARK = IS_MAC ? null : CONFIG_FILE;
var SERVERS = ["mcp", "servers"];
var ownsSettings = (mark = OWN_MARK) => mark === null || fs7.existsSync(mark);
var sortedKeys = (value) => Array.isArray(value) ? value.map(sortedKeys) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])])) : value;
function readSettings(file = CONFIG_FILE) {
  let text;
  try {
    text = fs7.readFileSync(file, "utf8");
  } catch (error) {
    let link = false;
    try {
      link = fs7.lstatSync(file).isSymbolicLink();
    } catch {}
    if (error?.code === "ENOENT" && !link)
      return { settings: {} };
    return { problem: link && error?.code === "ENOENT" ? "It's a link to a file that isn't there, so Kuvo Code leaves it alone." : `It couldn't be read, so Kuvo Code leaves it alone (${error?.code ?? error?.message}).` };
  }
  try {
    const parsed = text.trim() ? JSON.parse(text) : {};
    if (!isObject(parsed))
      throw new Error("not an object");
    return { settings: parsed };
  } catch {
    return { problem: "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)" };
  }
}
var valueAt = (object, keys) => keys.reduce((current, key) => isObject(current) ? current[key] : undefined, object);
function settingAt(object, keys, value) {
  const [key, ...rest] = keys;
  const next = { ...object };
  if (!rest.length) {
    if (value === null || value === undefined)
      delete next[key];
    else
      next[key] = value;
    return next;
  }
  const inner = settingAt(isObject(next[key]) ? next[key] : {}, rest, value);
  if (Object.keys(inner).length)
    next[key] = inner;
  else
    delete next[key];
  return next;
}
function changeSettings(changes, file = CONFIG_FILE, lock = CONFIG_LOCK) {
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every((change) => Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16 && change.path.every((key) => typeof key === "string" && key.length >= 1 && key.length <= 200) && ("value" in change));
  if (!fits)
    return { status: 400, message: 'Send {"changes": [{"path": [keys…], "value": …}]}.' };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem)
      return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    if (changes.some((change) => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    })))
      return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    if (changes.some((change) => ("was" in change) && sortedJSON(valueAt(settings, change.path) ?? null) !== sortedJSON(change.was))) {
      return { status: 409, message: "It changed since you read it." };
    }
    return writeSettings(settings, changes, file);
  });
}
function writeSettings(settings, changes, file) {
  let next = settings;
  for (const change of changes)
    next = settingAt(next, change.path, keysNamedHere(change.value));
  const target = linkTarget(file);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs7.mkdirSync(path7.dirname(target), { recursive: true, mode: 448 });
    fs7.writeFileSync(temporary, JSON.stringify(sortedKeys(next), null, 2) + `
`, { mode: 384 });
    fs7.renameSync(temporary, target);
  } catch (error) {
    fs7.rmSync(temporary, { force: true });
    return { status: 500, message: `It couldn't be saved: ${error.message}` };
  }
  return { status: 200, settings: next };
}
function linkTarget(file) {
  let target = file;
  for (let i = 0;i < 8; i++) {
    let destination;
    try {
      destination = fs7.readlinkSync(target);
    } catch {
      break;
    }
    target = path7.resolve(path7.dirname(target), destination);
  }
  return target;
}
function deepMerged(under, over) {
  if (!isObject(under) || !isObject(over))
    return over === undefined ? under : over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over))
    merged[key] = key in under ? deepMerged(under[key], value) : value;
  return merged;
}
var KEY_NAME = /^KUVO_KEY_[A-Za-z0-9_]+$/;
var KEYS_NAMED = IS_MAC && APP_KEY_FILES ? APP_KEY_FILES : `${shownRoot}/box/keys`;
function keysNamedHere(value) {
  if (typeof value === "string")
    return value.replace(/\{file:[^{}]*?(KUVO_KEY_[A-Za-z0-9_]+)\}/g, (_, name) => `{file:${KEYS_NAMED}/${name}}`);
  if (Array.isArray(value))
    return value.map(keysNamedHere);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, keysNamedHere(inner)]));
  return value;
}
var BOT_MEMORY_RULE = { action: "edit", resource: "*/bots/bot_*/MEMORY.md", effect: "allow" };
var DEFAULTS_ADDED = path7.join(BOX, "defaults-added");
function addDefaultRules(mac = IS_MAC, file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  let done = [];
  try {
    done = fs7.readFileSync(marks, "utf8").split(`
`).filter(Boolean);
  } catch {}
  const wanted = mac ? ["bot-memory", "websearch", "search-exa"] : ["bot-memory"];
  if (wanted.every((mark) => done.includes(mark)))
    return;
  const { settings, problem } = readSettings(file);
  if (problem)
    return;
  const changes = [];
  const exa = { provider: "exa" };
  if (mac && (!Object.keys(settings).length || !done.includes("websearch"))) {
    if (settings.websearch === undefined)
      changes.push({ path: ["websearch"], value: exa });
    done.push("websearch", "search-exa");
  } else if (mac && !done.includes("search-exa")) {
    if (sameJSON(settings.websearch, { provider: "random" }))
      changes.push({ path: ["websearch"], value: exa });
    done.push("search-exa");
  }
  if (!done.includes("bot-memory")) {
    const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
    if (!rules.some((rule) => sameJSON(rule, BOT_MEMORY_RULE)))
      changes.push({ path: ["permissions"], value: [...rules, BOT_MEMORY_RULE] });
    done.push("bot-memory");
  }
  if (changes.length && writeSettings(settings, changes, file).status !== 200)
    return;
  writePrivate(marks, [...new Set(done)].join(`
`) + `
`);
}
function addMacDefaults(file = CONFIG_FILE, marks = DEFAULTS_ADDED) {
  locked(CONFIG_LOCK, () => addDefaultRules(true, file, marks));
}

// Packages/Box/src/link/areas/integrations.ts
var INTEGRATIONS_FILE = path8.join(K, "bin", "integrations.json");
function integrationCatalog(file = INTEGRATIONS_FILE) {
  try {
    return (JSON.parse(fs8.readFileSync(file, "utf8")).integrations ?? []).filter((each) => typeof each?.id === "string" && (IS_MAC || !each.macOnly));
  } catch {
    return [];
  }
}
function integrationHealth(entry, server, off, signedIn) {
  if (off)
    return "disabled";
  let health = { connected: "connected", needs_auth: "needsSignIn", failed: "failed" }[server?.status?.status] ?? "starting";
  if (health === "connected" && server?.integrationID && !signedIn.has(server.integrationID) && ["official", "app"].includes(entry.way))
    health = "needsSignIn";
  if (health === "connected" && typeof entry.signInFile === "string" && !fs8.existsSync(path8.join(INTEGRATION_DATA, entry.id, path8.basename(entry.signInFile))))
    health = "waitsForCode";
  return health;
}
async function integrationEntries(catalog, engine, signal) {
  const { settings } = readSettings();
  let servers = null;
  let signedIn = new Set;
  let hadSignIn = new Set;
  if (engine) {
    servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => null);
    const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
    const oauth = (Array.isArray(credentials) ? credentials : []).filter((each) => each?.value?.type === "oauth");
    signedIn = new Set(oauth.filter((each) => each.active).map((each) => each.integrationID));
    hadSignIn = new Set(oauth.map((each) => each.integrationID));
  }
  const engineDown = !Array.isArray(servers);
  let names = null;
  try {
    names = await keyNames();
  } catch (error) {
    if (!(error instanceof KeysUnavailable))
      throw error;
  }
  const sites = catalog.some((entry) => entry.way === "browser") ? await siteSignIns() : null;
  const entries = catalog.map(({ settings: _, variables, signInFile, ...entry }) => {
    const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
    const shown = { ...entry, added };
    if (variables && names)
      shown.keysSaved = Object.values(variables).every((name) => names.includes(name));
    if (entry.way === "browser" && typeof sites?.[entry.id] === "boolean")
      shown.siteSignedIn = sites[entry.id];
    if (added) {
      const off = valueAt(settings ?? {}, [...SERVERS, entry.id, "disabled"]) === true;
      const server = (servers ?? []).find((each) => each?.name === entry.id);
      if (!engineDown || off)
        shown.health = integrationHealth({ ...entry, signInFile }, server, off, signedIn);
      if (server?.integrationID)
        shown.signIn = server.integrationID;
      if (shown.health === "needsSignIn" && server?.integrationID && hadSignIn.has(server.integrationID))
        shown.signInEnded = true;
    }
    return shown;
  });
  return { entries, engineDown };
}
function dropBotsIntegration(entry) {
  return keyWork(() => droppingBotsIntegration(entry));
}
async function droppingBotsIntegration(entry) {
  const own = Object.values(entry.variables ?? {}).filter((variable) => STORED_KEY.test(variable));
  const named = [];
  for (const variable of own)
    named.push(...await keyNames({ prefix: `${variable}__` }));
  for (const bot of listOf(BOTS)) {
    const folder = path8.join(BOTS, bot, "workspace", ".opencode");
    const file = path8.join(folder, "opencode.json");
    let settings;
    try {
      settings = JSON.parse(fs8.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const server = settings?.mcp?.servers?.[entry.id];
    if (!server || !own.some((variable) => JSON.stringify(server).includes(`${variable}__`)))
      continue;
    delete settings.mcp.servers[entry.id];
    if (!Object.keys(settings.mcp.servers).length)
      delete settings.mcp.servers;
    if (!Object.keys(settings.mcp).length)
      delete settings.mcp;
    if (Object.keys(settings).length)
      writePrivate(file, JSON.stringify(settings));
    else {
      fs8.rmSync(file, { force: true });
      try {
        fs8.rmdirSync(folder);
      } catch {}
    }
  }
  for (const name of named)
    await deleteKey(name);
}
async function keepsAll(variables) {
  const kept = await keyNames();
  return variables.every((variable) => kept.includes(variable));
}
var answersOnce = false;
function answerOnce() {
  answersOnce = true;
}
function reconnectLater(engine, id, later) {
  if (!engine)
    return;
  if (answersOnce && later === soon) {
    spawn(process.execPath, [SCRIPT, "box", "reconnect", id], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
    return;
  }
  later(() => reconnectEverywhere(engine, id), 2000);
}
async function reconnectEverywhere(engine, id) {
  const connect = `/api/experimental/mcp/${encodeURIComponent(id)}/connect`;
  await call(engine, "POST", connect).catch(() => {});
  const open = await call(engine, "GET", "/api/debug/location").catch(() => []);
  const folders = new Set((Array.isArray(open) ? open : []).map((each) => each?.directory).filter((folder) => typeof folder === "string" && folder));
  for (const folder of folders)
    await call(engine, "POST", connect, undefined, undefined, folder).catch(() => {});
}
async function answerIntegrations(method, requestPath, body, engine, signal, file = INTEGRATIONS_FILE, later = soon) {
  try {
    return await integrationsAnswer(method, requestPath, body, engine, signal, file, later);
  } catch (error) {
    if (error instanceof KeysUnavailable)
      return { status: 503, value: { message: error.message } };
    throw error;
  }
}
async function integrationsAnswer(method, requestPath, body, engine, signal, file, later) {
  const parts = requestPath.split("?")[0].split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const catalog = integrationCatalog(file);
  if (parts.length === 2) {
    if (method !== "GET")
      return { status: 405, value: {} };
    const { problem } = readSettings();
    const { entries, engineDown } = await integrationEntries(catalog, engine, signal);
    return { status: 200, value: { integrations: entries, ...engineDown ? { engineDown } : {}, ...problem ? { problem } : {} } };
  }
  const entry = parts.length === 3 ? catalog.find((each) => each.id === parts[2]) : null;
  if (!entry)
    return { status: 404, value: {} };
  const { settings, problem } = readSettings();
  if (problem)
    return { status: 409, value: { message: `The engine's settings file can't be changed from here: ${problem}` } };
  const added = valueAt(settings ?? {}, [...SERVERS, entry.id]) !== undefined;
  if (method === "POST") {
    if (entry.way === "browser" || !entry.settings)
      return { status: 409, value: { message: `The agent uses ${entry.title} on its site: sign in to it in the browser on ${IS_MAC ? "this Mac" : "this machine"}.` } };
    const variables = entry.variables ?? {};
    const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
    const names = Object.keys(variables);
    if (!Object.values(variables).every((variable) => typeof variable === "string" && STORED_KEY.test(variable))) {
      return { status: 409, value: { message: `${entry.title} can't be added here: its keys aren't named as Kuvo Code names them.` } };
    }
    let newKeys = false;
    if (names.length) {
      if (names.every((name) => typeof given[name] === "string" && given[name].trim())) {
        await keyWork(async () => {
          for (const name of names)
            await writeKey(variables[name], given[name].trim());
        });
        newKeys = true;
      } else if (!await keepsAll(names.map((name) => variables[name]))) {
        const labels = (entry.keys ?? []).map((key) => key.label).join(" and ");
        return { status: 400, value: { message: `${entry.title} needs ${labels}: send them as {"keys": {"${names[0]}": …}}.` } };
      }
    }
    const value = added ? valueAt(settings, [...SERVERS, entry.id]) : entry.settings;
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value }]);
    if (changed.status !== 200)
      return { status: changed.status, value: { message: changed.message } };
    if (newKeys)
      reconnectLater(engine, entry.id, later);
    const { entries: [listed] } = await integrationEntries([entry], engine, signal);
    return { status: 200, value: { integration: listed } };
  }
  if (method === "DELETE") {
    if (!added) {
      const own = Object.values(entry.variables ?? {}).filter((variable) => STORED_KEY.test(variable));
      const kept = own.length ? (await keyNames()).filter((name) => own.includes(name)) : [];
      if (!kept.length)
        return { status: 404, value: {} };
      await keyWork(async () => {
        for (const name of kept)
          await deleteKey(name);
      });
      return { status: 200, value: {} };
    }
    try {
      await dropBotsIntegration(entry);
    } catch (error) {
      if (!(error instanceof KeysUnavailable))
        throw error;
      return { status: 503, value: { message: `${entry.title} wasn't removed: its bots' own keys for it couldn't be taken away. ${error.message}` } };
    }
    let signIn;
    if (engine) {
      const servers = await call(engine, "GET", "/api/mcp", undefined, signal).catch(() => []);
      signIn = (Array.isArray(servers) ? servers : []).find((each) => each?.name === entry.id)?.integrationID;
    }
    const changed = changeSettings([{ path: [...SERVERS, entry.id], value: null }]);
    if (changed.status !== 200)
      return { status: changed.status, value: { message: changed.message } };
    if (engine && signIn) {
      const credentials = await call(engine, "GET", "/api/credential", undefined, signal).catch(() => []);
      for (const each of Array.isArray(credentials) ? credentials : []) {
        if (each?.integrationID === signIn)
          await call(engine, "DELETE", `/api/credential/${encodeURIComponent(each.id)}`, undefined, signal).catch(() => {});
      }
    }
    for (const name of [entry.id, `${entry.id}.json`])
      fs8.rmSync(path8.join(INTEGRATION_DATA, name), { recursive: true, force: true });
    try {
      await keyWork(async () => {
        for (const variable of Object.values(entry.variables ?? {}))
          if (STORED_KEY.test(variable))
            await deleteKey(variable);
      });
    } catch (error) {
      if (!(error instanceof KeysUnavailable))
        throw error;
      return { status: 503, value: { message: `${entry.title} is removed, but its key is still kept. ${error.message}` } };
    }
    return { status: 200, value: {} };
  }
  return { status: 405, value: {} };
}
async function* integrationsRoute(context) {
  const { request, signal, readEngine, json } = context;
  if (!ownsSettings())
    return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  const { status, value } = await answerIntegrations(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/bot-keys.ts
var BOT_KEY_FOLDER = APP_KEY_FILES;
var botKeyFolder = () => BOT_KEY_FOLDER ?? `${shownRoot}/box/bot-keys`;
var botKeyed = (catalog) => catalog.filter((entry) => ["token", "package"].includes(entry.way) && entry.settings && Object.keys(entry.variables ?? {}).length && Object.values(entry.variables).every((variable) => typeof variable === "string" && STORED_KEY.test(variable)));
var hasOwnKeys = (bot, entry, names) => Object.values(entry.variables).every((variable) => names.includes(botVariable(variable, bot)));
function botServer(entry, bot) {
  const folder = botKeyFolder();
  const swapped = (value) => {
    if (typeof value === "string") {
      return Object.values(entry.variables).reduce((text, variable) => text.replace(new RegExp(`\\{file:[^{}]*/${variable}\\}`, "g"), () => `{file:${folder}/${botVariable(variable, bot)}}`), value);
    }
    if (Array.isArray(value))
      return value.map(swapped);
    if (isObject(value))
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swapped(inner)]));
    return value;
  };
  return swapped(entry.settings);
}
function botSettings(bot) {
  const folder = path9.join(BOTS, bot, "workspace", ".opencode");
  const file = path9.join(folder, "opencode.json");
  const text = textOf(file);
  if (text === null || !text.trim())
    return { folder, file, settings: {} };
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {}
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(settings) || settings.mcp !== undefined && !isObject(settings.mcp) || settings.mcp?.servers !== undefined && !isObject(settings.mcp.servers)) {
    return { folder, file, problem: "Its folder's settings aren't plain JSON, so its own keys can't be named there." };
  }
  return { folder, file, settings };
}
function writeBotSettings(bot, catalog, names) {
  const { folder, file, settings: old, problem } = botSettings(bot);
  if (problem)
    return { status: 409, message: problem };
  const suffix = botVariable("", bot);
  const usesOwn = (server) => (JSON.stringify(server).match(/KUVO_KEY_[A-Z0-9_]+/g) ?? []).some((name) => name.endsWith(suffix));
  const servers = Object.fromEntries(Object.entries(old.mcp?.servers ?? {}).filter(([, server]) => !usesOwn(server)));
  for (const entry of botKeyed(catalog))
    if (hasOwnKeys(bot, entry, names))
      servers[entry.id] = botServer(entry, bot);
  const mcp = { ...old.mcp ?? {} };
  if (Object.keys(servers).length)
    mcp.servers = servers;
  else
    delete mcp.servers;
  const next = { ...old };
  if (Object.keys(mcp).length)
    next.mcp = mcp;
  else
    delete next.mcp;
  if (JSON.stringify(next) === JSON.stringify(old))
    return { status: 200 };
  if (Object.keys(next).length) {
    writePrivate(file, JSON.stringify(next, null, 2) + `
`);
  } else {
    fs9.rmSync(file, { force: true });
    try {
      fs9.rmdirSync(folder);
    } catch {}
  }
  return { status: 200 };
}
function refreshBotsKeys(file = INTEGRATIONS_FILE) {
  return keyWork(() => refreshingBotsKeys(file));
}
async function refreshingBotsKeys(file) {
  const bots = listOf(BOTS).filter((bot) => {
    const here = botHere(bot);
    return here && !here.described.project;
  });
  if (!bots.length)
    return;
  const catalog = integrationCatalog(file);
  const names = await keyNames();
  for (const bot of bots)
    writeBotSettings(bot, catalog, names);
}
function reconnectForBot(engine, id, bot, later) {
  if (!engine?.port)
    return;
  const folder = path9.join(BOTS, bot, "workspace");
  later(() => fetch(`http://127.0.0.1:${engine.port}/api/experimental/mcp/${encodeURIComponent(id)}/connect`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) }
  }).catch(() => {}), 2000);
}
async function answerBotKeys(method, requestPath, body, engine, file = INTEGRATIONS_FILE, later = soon) {
  try {
    return await keyWork(() => botKeysAnswer(method, requestPath, body, engine, file, later));
  } catch (error) {
    if (error instanceof KeysUnavailable)
      return { status: 503, value: { message: error.message } };
    throw error;
  }
}
async function botKeysAnswer(method, requestPath, body, engine, file, later) {
  const parts = requestPath.split("?")[0].split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return null;
    }
  });
  const message = (text) => ({ message: text });
  const bot = parts[2];
  const here = botHere(bot);
  if (!here)
    return { status: 404, value: message("That bot isn’t on this computer.") };
  if (here.described.project)
    return { status: 409, value: message(`${here.described.name} works in a project, so it uses the keys that project's sessions use.`) };
  const catalog = integrationCatalog(file);
  const keyed = botKeyed(catalog);
  const names = await keyNames();
  const shared = (entry) => Object.values(entry.variables).every((variable) => names.includes(variable));
  const without = (gone) => names.filter((name) => !gone.includes(name));
  if (parts.length === 4) {
    if (method === "GET")
      return { status: 200, value: { keys: keyed.map((entry) => ({
        integration: entry.id,
        own: hasOwnKeys(bot, entry, names),
        shared: shared(entry),
        title: entry.title,
        symbol: entry.symbol,
        keys: (entry.keys ?? []).map(({ name, label, prompt }) => ({ name, label, prompt })),
        ...entry.help ? { help: entry.help } : {}
      })) } };
    if (method !== "DELETE")
      return { status: 405, value: {} };
    const had = keyed.filter((entry) => hasOwnKeys(bot, entry, names));
    const own = names.filter((name) => name.endsWith(botVariable("", bot)));
    const written = writeBotSettings(bot, catalog, without(own));
    for (const name of own)
      await deleteKey(name);
    for (const entry of had)
      reconnectForBot(engine, entry.id, bot, later);
    return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
  }
  if (parts.length !== 5)
    return { status: 404, value: {} };
  const entry = keyed.find((each) => each.id === parts[4]);
  if (!entry)
    return { status: 404, value: message("A bot can't have a key of its own for that here.") };
  const fields = Object.keys(entry.variables);
  const variableOf = (name) => botVariable(entry.variables[name], bot);
  switch (method) {
    case "GET": {
      if (!hasOwnKeys(bot, entry, names))
        return { status: 404, value: {} };
      const keys = {};
      for (const name of fields)
        keys[name] = await readKey(variableOf(name)) ?? "";
      return { status: 200, value: { keys } };
    }
    case "PUT": {
      const given = body?.keys && typeof body.keys === "object" ? body.keys : {};
      if (!fields.every((name) => typeof given[name] === "string" && given[name].trim())) {
        const labels = (entry.keys ?? []).map((key) => key.label).join(" and ") || fields.join(" and ");
        return { status: 400, value: message(`${entry.title} needs ${labels}: send them as {"keys": {"${fields[0]}": …}}.`) };
      }
      const { problem } = botSettings(bot);
      if (problem)
        return { status: 409, value: message(problem) };
      for (const name of fields)
        await writeKey(variableOf(name), given[name].trim());
      writeBotSettings(bot, catalog, [...names, ...fields.map(variableOf)]);
      reconnectForBot(engine, entry.id, bot, later);
      return { status: 200, value: { integration: entry.id, own: true, shared: shared(entry) } };
    }
    case "DELETE": {
      if (!hasOwnKeys(bot, entry, names))
        return { status: 404, value: {} };
      const { problem } = botSettings(bot);
      if (problem)
        return { status: 409, value: message(problem) };
      const own = fields.map(variableOf);
      const written = writeBotSettings(bot, catalog, without(own));
      for (const name of own)
        await deleteKey(name);
      reconnectForBot(engine, entry.id, bot, later);
      return written.status === 200 ? { status: 200, value: {} } : { status: written.status, value: message(written.message) };
    }
    default:
      return { status: 405, value: {} };
  }
}
async function* botKeysRefreshRoute(context) {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  try {
    await refreshBotsKeys();
  } catch (error) {
    if (!(error instanceof KeysUnavailable))
      throw error;
    return yield* json(503, { message: error.message });
  }
  return yield* json(200, {});
}
async function* botKeysRoute(context) {
  const { request, readEngine, json } = context;
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  const { status, value } = await answerBotKeys(request.method.toUpperCase(), request.path, parsed(request.body), engine);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/box-keys.ts
import fs10 from "node:fs";
import path10 from "node:path";
async function answerKeys(method, route, body) {
  try {
    if (route === "kuvo/keys")
      return method === "GET" ? { status: 200, value: { keys: (await keyNames()).filter((name) => !name.includes("__")) } } : { status: 405, value: {} };
    const parts = route.split("/");
    let name = "";
    try {
      name = parts.length === 3 ? decodeURIComponent(parts[2]) : "";
    } catch {}
    if (!STORED_KEY.test(name) || name.includes("__"))
      return { status: 400, value: { message: "That isn't a key's name." } };
    switch (method) {
      case "GET": {
        const value = await readKey(name);
        return value == null ? { status: 404, value: {} } : { status: 200, value: { value } };
      }
      case "PUT": {
        const value = body?.value;
        if (typeof value !== "string" || !value)
          return { status: 400, value: { message: 'Send {"value": "…"}.' } };
        await keyWork(() => writeKey(name, value));
        return { status: 200, value: {} };
      }
      case "DELETE":
        await keyWork(() => deleteKey(name));
        return { status: 200, value: {} };
      default:
        return { status: 405, value: {} };
    }
  } catch (error) {
    if (error instanceof KeysUnavailable)
      return { status: 503, value: { message: error.message } };
    throw error;
  }
}
function setBoxKey(name, value) {
  if (!KEY_NAME.test(String(name)) || String(name).includes("__"))
    return { status: 400, message: "That isn't a key's name." };
  return locked(CONFIG_LOCK, () => {
    if (value == null)
      fs10.rmSync(path10.join(BOX_KEYS, name), { force: true });
    else
      writePrivate(path10.join(BOX_KEYS, name), String(value));
    return { status: 200 };
  });
}

// Packages/Box/src/link/areas/engine.ts
import { spawn as spawn2 } from "node:child_process";
import fs12 from "node:fs";
import path12 from "node:path";

// Packages/Box/src/link/server/paths.ts
var SOCKETS = [/^api\/pty\/[^/?]+\/connect(\?|$)/];
var REQUEST_HEADERS = ["content-type", "accept", "x-opencode-directory", "last-event-id"];
var RESPONSE_HEADERS = ["content-type", "cache-control"];
var canonicalPath = (path) => {
  try {
    if (path.includes("#") || path.startsWith(" ") || path.endsWith(" "))
      return null;
    const at = path.indexOf("?");
    const parts = [];
    for (const raw of (at < 0 ? path : path.slice(0, at)).split("/").filter(Boolean)) {
      const part = decodedPart(raw);
      if (part === null || part.includes("/") || [".", ".."].includes(ascii(part)))
        return null;
      parts.push(encodeURIComponent(part).replace(/%(24|26|2B|2C|3B|3D|3A|40)/g, plainly));
    }
    const fields = [];
    for (const raw of at < 0 ? [] : path.slice(at + 1).split("&").filter(Boolean)) {
      const spaced = raw.replaceAll("+", " "), equals = spaced.indexOf("=");
      const halves = (equals < 0 ? [spaced] : [spaced.slice(0, equals), spaced.slice(equals + 1)]).map(decodedPart);
      if (halves.some((half) => half === null || half.split("/").some((piece) => ascii(piece) === "..")))
        return null;
      fields.push(halves.map((half) => encodeURIComponent(half).replace(/%(24|2C|3B|3A|40|2F|3F)/g, plainly).replaceAll("'", "%27")).join("="));
    }
    return parts.join("/") + (fields.length ? `?${fields.join("&")}` : "");
  } catch {
    return null;
  }
};
var decodedPart = (raw) => {
  let text;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return /[\u0000-\u001f\u007f\\]/.test(text) ? null : text;
};
var ascii = (text) => text.replace(/[^\u0000-\u007f]/g, "");
var plainly = (_, hex) => String.fromCharCode(parseInt(hex, 16));
var allowed = (path, method = "GET") => /^api(\/|\?|$)/.test(canonicalPath(path) ?? "");
var socketAllowed = (path) => SOCKETS.some((pattern) => pattern.test(canonicalPath(path) ?? ""));
var agentsAllowed = (path, method = "GET") => {
  const sent = canonicalPath(path) ?? "";
  return /^api(\/|\?|$)/.test(sent) && !/^api\/kuvo\/(engine|groups|artifacts)(\/|\?|$)/.test(sent);
};
var RETURN = /^(http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})(?:\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*)?\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})+)(?:#.*)?$/;
var signInReturn = (url) => {
  if (typeof url !== "string" || Buffer.byteLength(url) > 8192 || !/^[!-~]*$/.test(url) || url.includes("\\"))
    return null;
  const match = url.match(RETURN);
  return match && Number(match[2]) <= 65535 ? match[1] : null;
};

// Packages/Box/src/link/compat/leave-running.ts
import fs11 from "node:fs";
import path11 from "node:path";
var SEEN_FILE = path11.join(RUN, "link.seen");
var KEEP_FOR = 7 * 24 * 60 * 60000;
var seen = 0;
function phoneHere() {
  if (Date.now() - seen < 5 * 60000)
    return;
  seen = Date.now();
  try {
    const now = new Date;
    if (fs11.existsSync(SEEN_FILE)) {
      fs11.utimesSync(SEEN_FILE, now, now);
    } else {
      fs11.mkdirSync(RUN, { recursive: true, mode: 448 });
      fs11.writeFileSync(SEEN_FILE, "", { mode: 384 });
    }
  } catch {}
}
function forgetPhones() {
  seen = 0;
  try {
    fs11.rmSync(SEEN_FILE, { force: true });
  } catch {}
}
function phoneSeenLately(file = SEEN_FILE, now = Date.now()) {
  try {
    return now - fs11.statSync(file).mtimeMs < KEEP_FOR;
  } catch {
    return false;
  }
}

// Packages/Box/src/link/areas/engine.ts
var engineDown = () => {
  if (fs12.existsSync(path12.join(RUN, "stopped")))
    return "The engine isn't running.";
  if (IS_MAC) {
    let why = "";
    try {
      why = fs12.readFileSync(path12.join(RUN, "engine-stopped"), "utf8").trim();
    } catch {}
    if (why)
      return `This Mac's engine isn't running. ${why} Try Again in Kuvo Code on the Mac starts it.`;
    return "This Mac's engine is starting. Try again in a moment.";
  }
  const retry = Number(fs12.existsSync(path12.join(RUN, "engine.retry")) ? fs12.readFileSync(path12.join(RUN, "engine.retry"), "utf8").trim() : NaN);
  const minutes = Math.ceil((retry - Date.now() / 1000) / 60);
  if (Number.isFinite(retry) && retry - Date.now() / 1000 > 30) {
    return `This machine's engine keeps stopping. It's started again in ${minutes === 1 ? "about a minute" : `about ${minutes} minutes`}.`;
  }
  return "This machine's engine is starting. Try again in a moment.";
};
async function engineControl(command) {
  const start = path12.join(K, "bin", "kuvo-start");
  if (!fs12.existsSync(start))
    return { status: 409, message: "Kuvo Code hasn't set this machine up yet." };
  if (![path12.join(K, "bin", "kuvo-launch"), path12.join(RUN, "launch.env")].every((file) => fs12.existsSync(file))) {
    return { status: 409, message: "Start it once from Kuvo Code on your Mac." };
  }
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  const workspace = path12.join(K, "workspace");
  const options = { cwd: fs12.existsSync(workspace) ? workspace : K, env: environment };
  try {
    const child = spawn2("sh", [start, command], { ...options, detached: true, stdio: "ignore" });
    lastToolRun = { child, ended: new Promise((resolve) => {
      child.on("exit", resolve);
      child.on("error", resolve);
    }) };
    child.unref();
  } catch {
    return { status: 503, message: "It couldn't be started." };
  }
  return { status: 202 };
}
var lastToolRun = null;
var toolRun = () => {
  lastToolRun?.child.ref();
  return lastToolRun?.ended ?? Promise.resolve();
};
async function* loadSignInReturn(body, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let given = {};
  try {
    given = JSON.parse(Buffer.from(body ?? []).toString("utf8") || "{}");
  } catch {}
  const url = signInReturn(given?.url);
  if (!url)
    return yield* json(400, { message: "That isn't an address a sign-in returns to on this computer." });
  const stop = new AbortController;
  const timer = setTimeout(() => stop.abort(), 15000);
  const cancel = () => stop.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const response = await fetch(url, { redirect: "manual", signal: stop.signal });
    await response.arrayBuffer().catch(() => {});
    return yield* json(200, { status: response.status });
  } catch {
    return yield* json(502, { message: "Nothing on this computer took it. Start the sign-in again." });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
async function* stopShell(id, runners, headers, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  let job, url;
  for (const runner of runners) {
    url = `http://127.0.0.1:${runner.port}/api/shell/${encodeURIComponent(id)}`;
    const asking = { ...headers, authorization: `Basic ${Buffer.from(`opencode:${runner.password}`).toString("base64")}` };
    try {
      const response = await fetch(url, { headers: asking, signal });
      if (response.ok)
        job = (await response.json()).data;
    } catch {}
    if (job) {
      headers = asking;
      break;
    }
  }
  if (!job || job.status !== "running")
    return yield* json(404, {});
  if (Number.isInteger(job.pid) && job.pid > 1) {
    try {
      process.kill(-job.pid, "SIGTERM");
      return yield* json(200, { stopped: "signal" });
    } catch {}
  }
  try {
    const response = await fetch(url, { method: "DELETE", headers, signal });
    if (response.ok)
      return yield* json(200, { stopped: "removed" });
  } catch {}
  return yield* json(404, {});
}
function engineConnect(readEngine = readEngineFile) {
  return (request, phone, events) => {
    let ended = false;
    const end = (error) => {
      if (ended)
        return;
      ended = true;
      events.end(error);
    };
    const refuse = (words) => {
      queueMicrotask(() => end(new Error(words)));
      return { send() {}, close() {} };
    };
    if (!socketAllowed(request.path))
      return refuse("That isn't available over the link.");
    let engine;
    try {
      engine = readEngine();
    } catch {
      return refuse("The engine isn't running.");
    }
    phoneHere();
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
    const directory = Object.entries(request.headers ?? {}).find(([name]) => name.toLowerCase() === "x-opencode-directory")?.[1];
    if (directory)
      headers["x-opencode-directory"] = directory;
    const socket = new WebSocket(`ws://127.0.0.1:${engine.port}/${canonicalPath(request.path)}`, { headers });
    socket.binaryType = "arraybuffer";
    socket.onopen = () => events.open();
    socket.onmessage = (event) => typeof event.data === "string" ? events.text(Buffer.from(event.data)) : events.binary(Buffer.from(event.data));
    socket.onerror = () => end(new Error("The engine closed it."));
    socket.onclose = () => end();
    return {
      send: (data) => {
        if (socket.readyState === 1)
          socket.send(data.toString("utf8"));
      },
      close: () => {
        ended = true;
        try {
          socket.close();
        } catch {}
      }
    };
  };
}
async function* engineControlRoute(context, control) {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  const { status, message } = await engineControl(control[1]);
  return yield* json(status, message ? { message } : {});
}
async function* signInReturnRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  return yield* loadSignInReturn(request.body, signal);
}

// Packages/Box/src/link/areas/skills.ts
import crypto3 from "node:crypto";
import fs13 from "node:fs";
import path13 from "node:path";
var SKILLS = path13.join(ENGINE_CONFIG || path13.join(K, "config"), "opencode", "skills");
var SKILL_SOURCE = ".kuvo-source.json";
var testGitHub = IN_TEST_FOLDER ? process.env.KUVO_TEST_GITHUB : undefined;
var GITHUB = { api: testGitHub ?? "https://api.github.com", raw: testGitHub ?? "https://raw.githubusercontent.com" };
var SKILL_REPOSITORIES = [
  ["anthropics", "skills", "Anthropic", "The reference set: documents, spreadsheets, slides, PDFs, design and more."],
  ["openai", "skills", "OpenAI", "Codex's catalog of curated skills."],
  ["obra", "superpowers", "Superpowers", "Ways of working: test-driven development, debugging, planning, code review."],
  ["mattpocock", "skills", "Matt Pocock", "Engineering and productivity skills, TypeScript-minded."],
  ["addyosmani", "agent-skills", "Addy Osmani", "Production engineering practices: performance, accessibility, testing."],
  ["vercel-labs", "agent-skills", "Vercel", "React, Next.js and deploying to Vercel."],
  ["github", "awesome-copilot", "GitHub Awesome Copilot", "Hundreds of community skills; quality varies."],
  ["huggingface", "skills", "Hugging Face", "Models, datasets and training with Hugging Face."],
  ["cloudflare", "skills", "Cloudflare", "Workers, Pages and the rest of Cloudflare's platform."],
  ["trailofbits", "skills", "Trail of Bits", "Security auditing and code review."],
  ["K-Dense-AI", "scientific-agent-skills", "Scientific Skills", "A large library for science: biology, chemistry, data analysis."],
  ["wshobson", "agents", "wshobson/agents", "A big set of plugins with skills for many languages and tools."]
].map(([owner, name, title, summary]) => ({ id: `${owner}/${name}`, owner, name, title, summary, branch: "main" }));

class SkillFailure extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var limited = () => new SkillFailure(503, "GitHub is limiting requests for now. Try again in a while.");
var isSkillFolder = (name) => typeof name === "string" && name.length > 0 && name.length <= 128 && !name.startsWith(".") && !/[\/\\\0]/.test(name);
function skillName(text) {
  const words = String(text).normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).map((word) => [...word].filter((c) => c.charCodeAt(0) < 128).join("")).filter(Boolean);
  return words.join("-").slice(0, 64).replace(/-+$/, "");
}
function skillFolders() {
  return listOf(SKILLS).filter((name) => !name.startsWith(".") && (() => {
    try {
      return fs13.statSync(path13.join(SKILLS, name)).isDirectory();
    } catch {
      return false;
    }
  })()).sort();
}
var SKILL_TRASH = path13.join(K, "trash", "skills");
var SKILL_TRASH_DAYS = 30;
var DAY = 86400000;
var isDirectory = (file) => {
  try {
    return fs13.statSync(file).isDirectory();
  } catch {
    return false;
  }
};
function skillTrashEntry(entry) {
  const found = typeof entry === "string" && entry.length <= 141 ? /^(.+)-(\d{1,12})$/.exec(entry) : null;
  return found && isSkillFolder(found[1]) && isSkillFolder(entry) ? { folder: found[1], deleted: Number(found[2]) } : null;
}
function clearSkillTrash(now = Date.now()) {
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    if (entry && entry.deleted * 1000 <= now - SKILL_TRASH_DAYS * DAY)
      try {
        fs13.rmSync(path13.join(SKILL_TRASH, id), { recursive: true, force: true });
      } catch {}
  }
}
function keepSkillTrashClear() {
  clearSkillTrash();
  const timer = setInterval(() => clearSkillTrash(), DAY);
  timer.unref?.();
  return timer;
}
function skillTrashEntries() {
  const entries = [];
  for (const id of listOf(SKILL_TRASH)) {
    const entry = skillTrashEntry(id);
    const away = path13.join(SKILL_TRASH, id);
    if (!entry || !isDirectory(away))
      continue;
    const about = skillAbout(textOf(path13.join(away, "SKILL.md")) ?? "");
    entries.push({
      id,
      folder: entry.folder,
      name: about.name || entry.folder,
      ...about.description ? { description: about.description } : {},
      deleted: entry.deleted,
      goes: entry.deleted + SKILL_TRASH_DAYS * 86400
    });
  }
  return entries.sort((a, b) => b.deleted - a.deleted || a.id.localeCompare(b.id));
}
function skillSources() {
  const sources = {};
  for (const name of listOf(SKILLS)) {
    try {
      const source = JSON.parse(fs13.readFileSync(path13.join(SKILLS, name, SKILL_SOURCE), "utf8"));
      if (typeof source?.repository === "string")
        sources[name] = { repository: source.repository, path: typeof source.path === "string" ? source.path : "" };
    } catch {}
  }
  return sources;
}
async function github(url, json = true) {
  const response = await fetch(url, { headers: json ? { accept: "application/vnd.github+json", "user-agent": "Kuvo Code" } : { "user-agent": "Kuvo Code" }, signal: AbortSignal.timeout(30000) });
  if (response.status === 403 || response.status === 429)
    throw limited();
  return response;
}
var lookedUp = new Map;
async function skillRepository(owner, name) {
  const known = SKILL_REPOSITORIES.find((each) => each.owner.toLowerCase() === owner.toLowerCase() && each.name.toLowerCase() === name.toLowerCase());
  if (known)
    return known;
  const key = `${owner}/${name}`.toLowerCase();
  const kept = lookedUp.get(key);
  if (kept && Date.now() - kept.at < 15 * 60000)
    return kept.repository;
  const response = await github(`${GITHUB.api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const info = response.status === 200 ? await response.json().catch(() => null) : null;
  if (typeof info?.default_branch !== "string")
    throw new SkillFailure(404, `${owner}/${name} wasn’t found on GitHub.`);
  const repository = { id: `${owner}/${name}`, owner, name, title: `${owner}/${name}`, summary: info.description ?? "", branch: info.default_branch };
  if (lookedUp.size > 50)
    lookedUp.clear();
  lookedUp.set(key, { repository, at: Date.now() });
  return repository;
}
async function engineSkills(engine) {
  if (!engine?.port)
    return [];
  try {
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/skill`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(5000)
    });
    const listed = response.ok ? (await response.json())?.data : null;
    return Array.isArray(listed) ? listed.filter((skill) => typeof skill?.id === "string").map((skill) => ({ id: skill.id, ...typeof skill.path === "string" ? { path: skill.path } : {} })) : [];
  } catch {
    return [];
  }
}
var engineSkillNames = async (engine) => (await engineSkills(engine)).map((skill) => skill.id);
function skillPlace(file) {
  if (typeof file !== "string" || !file)
    return "elsewhere";
  if (file.startsWith("/builtin/"))
    return "built in";
  const folder = path13.dirname(path13.dirname(file));
  const home = homeFolder();
  return `in ${folder === home || folder.startsWith(home + path13.sep) ? "~" + folder.slice(home.length) : folder}`;
}
async function skillsIn(repository) {
  const response = await github(`${GITHUB.api}/repos/${repository.owner}/${repository.name}/git/trees/${repository.branch}?recursive=1`);
  if (response.status !== 200)
    throw new SkillFailure(404, `${repository.id} wasn’t found on GitHub.`);
  const tree = await response.json();
  const files = (tree.tree ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
  const dirname = (file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const folders = new Set(files.filter((file) => file.split("/").at(-1) === "SKILL.md").map(dirname).filter(Boolean));
  const isSkill = files.includes("SKILL.md");
  const byFolder = new Map;
  for (const file of files) {
    let folder = dirname(file);
    while (folder && !folders.has(folder))
      folder = dirname(folder);
    if (folder)
      byFolder.set(folder, [...byFolder.get(folder) ?? [], file]);
    else if (isSkill && !file.startsWith("."))
      byFolder.set("", [...byFolder.get("") ?? [], file]);
  }
  const nameOf = (folder) => folder ? folder.split("/").at(-1) : repository.name;
  let skills = [...isSkill ? [""] : [], ...[...folders].sort()].map((folder) => ({ name: nameOf(folder), path: folder, files: byFolder.get(folder) ?? [] }));
  const hidden = (skill) => skill.path.split("/").some((part) => part.startsWith("."));
  const shown = new Set(skills.filter((skill) => !hidden(skill)).map((skill) => skill.name));
  skills = skills.filter((skill) => !(hidden(skill) && shown.has(skill.name)));
  return { skills, partial: tree.truncated === true };
}
var skillAbouts = new Map;
var ABOUT_READS = 16;
var aboutReading = 0;
var aboutWaiting = [];
async function aboutSkill(repository, folder) {
  const key = `${repository.id.toLowerCase()}@${repository.branch}:${folder}`;
  if (skillAbouts.has(key))
    return skillAbouts.get(key);
  if (aboutReading >= ABOUT_READS)
    await new Promise((resolve) => aboutWaiting.push(resolve));
  aboutReading++;
  try {
    if (skillAbouts.has(key))
      return skillAbouts.get(key);
    const response = await github(rawURL(repository, folder ? `${folder}/SKILL.md` : "SKILL.md"), false).catch(() => null);
    if (response?.status !== 200)
      return {};
    const about = skillAbout(await response.text());
    if (skillAbouts.size > 5000)
      skillAbouts.clear();
    skillAbouts.set(key, about);
    return about;
  } finally {
    aboutReading--;
    aboutWaiting.shift()?.();
  }
}
var rawURL = (repository, file) => `${GITHUB.raw}/${repository.owner}/${repository.name}/${repository.branch}/${file.split("/").map(encodeURIComponent).join("/")}`;
function skillAbout(markdown) {
  const lines = String(markdown).split(/\r\n|\r|\n/);
  const about = {};
  if (lines[0]?.trim() !== "---")
    return about;
  for (let index = 1;index < lines.length && lines[index].trim() !== "---"; index++) {
    const line = lines[index];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" "))
      continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ([">", "|", ">-", "|-"].includes(value)) {
      const parts = [];
      while (index + 1 < lines.length && lines[index + 1].startsWith(" "))
        parts.push(lines[++index].trim());
      value = parts.join(" ");
    }
    value = value.replace(/^["']+|["']+$/g, "");
    if (key === "name")
      about.name = value;
    if (key === "description")
      about.description = value;
  }
  return about;
}
async function installSkill(repository, skill) {
  const target = path13.join(SKILLS, skill.name);
  if (fs13.existsSync(target))
    throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
  const staging = path13.join(SKILLS, `.${skill.name}.kuvo-new-${crypto3.randomUUID()}`);
  try {
    for (const file of skill.files) {
      const response = await github(rawURL(repository, file), false);
      if (response.status !== 200)
        throw new SkillFailure(404, `${file} wasn’t found on GitHub.`);
      const relative = skill.path ? file.slice(skill.path.length + 1) : file;
      const into = path13.join(staging, relative);
      if (!into.startsWith(staging + path13.sep))
        continue;
      fs13.mkdirSync(path13.dirname(into), { recursive: true });
      fs13.writeFileSync(into, Buffer.from(await response.arrayBuffer()));
    }
    fs13.mkdirSync(staging, { recursive: true });
    fs13.writeFileSync(path13.join(staging, SKILL_SOURCE), JSON.stringify({ branch: repository.branch, path: skill.path, repository: repository.id }, null, 2));
    if (fs13.existsSync(target))
      throw new SkillFailure(409, `A skill named ${skill.name} is already installed.`);
    fs13.renameSync(staging, target);
  } finally {
    fs13.rmSync(staging, { recursive: true, force: true });
  }
}
async function answerSkills(method, requestPath, body, engine = null) {
  const [route, query = ""] = requestPath.split("?");
  const parts = route.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return null;
    }
  });
  if (parts.includes(null))
    return { status: 400, value: { message: "That isn’t a path." } };
  const message = (text) => ({ message: text });
  try {
    if (parts[1] === "skills" && parts.length === 2) {
      if (method !== "GET")
        return { status: 405, value: {} };
      return { status: 200, value: { folder: SKILLS, folders: skillFolders(), github: skillSources() } };
    }
    if (parts[1] === "skills" && parts.length === 3) {
      const name = parts[2];
      if (!isSkillFolder(name))
        return { status: 400, value: message("That isn’t a skill’s name.") };
      const folder = path13.join(SKILLS, name);
      const file = path13.join(folder, "SKILL.md");
      if (method === "GET") {
        const text = textOf(file);
        return text === null ? { status: 404, value: {} } : { status: 200, value: { text } };
      }
      if (method === "PUT") {
        const text = body?.text;
        if (typeof text !== "string" || !text.trim())
          return { status: 400, value: message(`Send the skill's SKILL.md as {"text": …}.`) };
        if (body?.new === true) {
          if (skillName(name) !== name)
            return { status: 400, value: message("Names use lowercase letters a to z, digits and hyphens.") };
          if (fs13.existsSync(folder) || (await engineSkillNames(engine)).includes(name))
            return { status: 409, value: message(`There’s a skill called ${name} already.`) };
        } else if (!fs13.existsSync(folder)) {
          return { status: 404, value: {} };
        } else if (skillSources()[name]) {
          return { status: 409, value: message(`${name} came from GitHub, so it isn’t edited here.`) };
        }
        fs13.mkdirSync(folder, { recursive: true });
        fs13.writeFileSync(`${file}.new`, text);
        fs13.renameSync(`${file}.new`, file);
        return { status: 200, value: {} };
      }
      if (method === "DELETE") {
        if (!fs13.existsSync(folder))
          return { status: 404, value: {} };
        fs13.mkdirSync(SKILL_TRASH, { recursive: true });
        let when = Math.floor(Date.now() / 1000);
        while (fs13.existsSync(path13.join(SKILL_TRASH, `${name}-${when}`)))
          when++;
        fs13.renameSync(folder, path13.join(SKILL_TRASH, `${name}-${when}`));
        clearSkillTrash();
        return { status: 200, value: {} };
      }
      return { status: 405, value: {} };
    }
    if (parts[1] === "skill-trash") {
      clearSkillTrash();
      if (parts.length === 2) {
        if (method !== "GET")
          return { status: 405, value: {} };
        return { status: 200, value: { entries: skillTrashEntries() } };
      }
      if (parts.length === 4 && parts[3] === "restore") {
        if (method !== "POST")
          return { status: 405, value: {} };
        const entry = parts[2];
        const name = skillTrashEntry(entry)?.folder;
        if (!name)
          return { status: 400, value: message("That isn’t an entry in Recently Deleted.") };
        const away = path13.join(SKILL_TRASH, entry);
        if (!isDirectory(away))
          return { status: 404, value: {} };
        const back = path13.join(SKILLS, name);
        if (fs13.existsSync(back))
          return { status: 409, value: message(`There’s a skill called ${name} now. Delete it first to restore this one.`) };
        const elsewhere = (await engineSkills(engine)).find((skill) => skill.id === name && !skill.path?.startsWith(SKILLS + path13.sep));
        if (elsewhere)
          return { status: 409, value: message(`There’s a skill called ${name} ${skillPlace(elsewhere.path)}, so this one can’t be restored under that name.`) };
        fs13.mkdirSync(SKILLS, { recursive: true });
        fs13.renameSync(away, back);
        return { status: 200, value: { name } };
      }
      return { status: 404, value: {} };
    }
    if (parts[1] === "skill-library") {
      if (parts.length === 2 && method === "GET")
        return { status: 200, value: { repositories: SKILL_REPOSITORIES.map(({ branch, ...shown }) => shown) } };
      if (parts.length === 3 && parts[2] === "install" && method === "POST") {
        const [owner, name] = String(body?.repository ?? "").split("/");
        if (!owner || !name || typeof body?.path !== "string")
          return { status: 400, value: message('Send {"repository": "owner/name", "path": …}.') };
        const repository = await skillRepository(owner, name);
        const skill = (await skillsIn(repository)).skills.find((each) => each.path === body.path);
        if (!skill)
          return { status: 404, value: message(`There’s no skill at ${body.path} in ${repository.id}.`) };
        await installSkill(repository, skill);
        return { status: 200, value: { name: skill.name } };
      }
      if (parts.length === 4 && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        const { skills, partial } = await skillsIn(repository);
        const { branch, ...shown } = repository;
        const described = await Promise.all(skills.map(async (skill) => ({ ...skill, about: await aboutSkill(repository, skill.path) })));
        return { status: 200, value: { repository: shown, skills: described, partial } };
      }
      if (parts.length === 5 && parts[4] === "about" && method === "GET") {
        const repository = await skillRepository(parts[2], parts[3]);
        const pair = query.split("&").find((each) => each.startsWith("path="));
        let at = "";
        try {
          at = pair ? decodeURIComponent(pair.slice(5)) : "";
        } catch {
          return { status: 400, value: message("That isn’t a path.") };
        }
        return { status: 200, value: await aboutSkill(repository, at) };
      }
    }
    return { status: 404, value: {} };
  } catch (error) {
    return { status: error instanceof SkillFailure ? error.status : 502, value: message(error?.message ?? String(error)) };
  }
}
async function* skillsRoute(context) {
  const { request, readEngine, json } = context;
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  const { status, value } = await answerSkills(request.method.toUpperCase(), request.path, parsed(request.body), engine);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/wakes.ts
import { execFile } from "node:child_process";
import fs15 from "node:fs";
import path14 from "node:path";

// Packages/Box/src/link/engine/sessions.ts
import crypto4 from "node:crypto";
var isHiddenRun = (session) => Boolean(session?.metadata?.kuvo?.engineFor || session?.metadata?.kuvo?.seat);
var lastMessage = { time: 0, counter: 0 };
function messageID(now = Date.now()) {
  lastMessage = lastMessage.time === now ? { time: now, counter: lastMessage.counter + 1 } : { time: now, counter: 1 };
  const time = (BigInt(now) * 0x1000n + BigInt(lastMessage.counter) & 0xFFFFFFFFFFFFn).toString(16).padStart(12, "0");
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `msg_${time}${Array.from(crypto4.randomBytes(14), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

// Packages/Box/src/link/follow.ts
import fs14 from "node:fs";
function watchFolders(folders, changed, { recursive = true } = {}) {
  let whole = folders.length > 0;
  const watchers = [];
  for (const folder of folders) {
    try {
      fs14.mkdirSync(folder, { recursive: true });
      const watcher = fs14.watch(folder, { recursive }, changed);
      watcher.on("error", () => {
        whole = false;
        watcher.close();
      });
      watchers.push(watcher);
    } catch {
      whole = false;
    }
  }
  return { get whole() {
    return whole;
  }, close: () => {
    for (const watcher of watchers)
      watcher.close();
  } };
}
async function* followed(read, followers, signal, { folders = [], recursive = true, watch = watchFolders } = {}) {
  let wake = null;
  const queue = [];
  const told = () => {
    queue.push(JSON.stringify(read()));
    wake?.();
  };
  followers.add(told);
  const watching = watch(folders, told, { recursive });
  queue.push(JSON.stringify(read()));
  const settled = WATCH_SETTLES.map((ms) => setTimeout(told, ms));
  signal?.addEventListener("abort", () => wake?.(), { once: true });
  try {
    let last = "";
    while (!signal?.aborted) {
      while (queue.length) {
        const line = queue.shift();
        if (line !== last) {
          yield { body: Buffer.from(line + `
`) };
          last = line;
        }
      }
      if (signal?.aborted)
        break;
      await new Promise((done) => {
        const timer = setTimeout(done, watching.whole ? 30000 : 1000);
        wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      wake = null;
      queue.push(JSON.stringify(read()));
    }
  } finally {
    for (const timer of settled)
      clearTimeout(timer);
    followers.delete(told);
    watching.close();
  }
}
var WATCH_SETTLES = [250, 1000, 5000];

// Packages/Box/src/link/areas/wakes.ts
var WAKE_MARKER = "[Wake-up] ";
function repeatText(text) {
  if (text === "weekdays")
    return text;
  const match = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text ?? "");
  if (!match)
    return null;
  const count = Number(match[1]);
  const fits = { m: count >= 5 && count <= 525600, h: count <= 8760, d: count <= 366, w: count <= 52 }[match[2]];
  return fits ? text : null;
}
function wakeOf(name, note = "") {
  const [due, letters = "", ...more] = name.split("-");
  if (!/^[0-9]+(\.[0-9]+)?$/.test(due ?? ""))
    return null;
  const repeating = more.join("-");
  return { id: name, due: Number(due), note, every: repeating ? repeatText(repeating.split("@")[0]) : null, letters };
}
function holdArchived(session, archived) {
  if (!/^ses_[A-Za-z0-9]+$/.test(session))
    return;
  const folder = path14.join(SESSION_WAKES, session);
  const file = path14.join(folder, "paused");
  const held = textOf(file);
  if (archived) {
    if (!fs15.existsSync(folder) || held !== null && held !== "moving")
      return;
    fs15.writeFileSync(file, "archived");
  } else if (held === "archived" || held === "") {
    fs15.rmSync(file, { force: true });
  }
}
function wakeFolder(session) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(session))
    return null;
  for (const id of listOf(BOTS)) {
    if ((textOf(path14.join(BOTS, id, "session")) ?? "").trim() === session)
      return path14.join(BOTS, id);
  }
  const own = path14.join(SESSION_WAKES, session);
  return textOf(path14.join(own, "session")) === null ? null : own;
}
function listWakes() {
  const sessions = [];
  for (const name of listOf(SESSION_WAKES)) {
    const folder = path14.join(SESSION_WAKES, name);
    const session = (textOf(path14.join(folder, "session")) ?? "").trim();
    if (!session)
      continue;
    const { wakes, watches } = readWakes(folder);
    if (!wakes.length && !watches.length)
      continue;
    sessions.push({ session, ...wakes.length ? { next: wakes[0].due } : {}, watching: watches.length > 0 });
  }
  return sessions;
}
function readWakes(folder, { whole = false } = {}) {
  const line = (text, limit) => whole ? text : oneLine(text, limit);
  const wakes = listOf(path14.join(folder, "wakes")).map((name) => wakeOf(name, line(textOf(path14.join(folder, "wakes", name)) ?? "", 400))).filter(Boolean).sort((a, b) => a.due - b.due);
  const watches = listOf(path14.join(folder, "watches")).sort().map((letters) => {
    const at = path14.join(folder, "watches", letters);
    const check = textOf(path14.join(at, "check")) ?? "";
    if (!check)
      return null;
    return { letters, every: (textOf(path14.join(at, "every")) ?? "").trim(), check: line(check, 300), note: line(textOf(path14.join(at, "note")) ?? "", 400) };
  }).filter(Boolean);
  return { wakes, watches, paused: fs15.existsSync(path14.join(folder, "paused")) };
}
var listedWake = ({ id, due, note, every }) => ({ id, due, note, every: every ?? undefined });
function allWakes() {
  const sessions = [];
  const add = (folder) => {
    const session = (textOf(path14.join(folder, "session")) ?? "").trim();
    if (!session)
      return;
    const { wakes, watches, paused } = readWakes(folder, { whole: true });
    if (wakes.length || watches.length || paused)
      sessions.push({ session, wakes: wakes.map(listedWake), watches, paused });
  };
  for (const id of listOf(BOTS))
    add(path14.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES))
    add(path14.join(SESSION_WAKES, name));
  return sessions;
}
function nextWake() {
  let soonest = null;
  const look = (folder) => {
    if (fs15.existsSync(path14.join(folder, "paused")) || textOf(path14.join(folder, "session")) === null)
      return;
    const [retry = 0] = (textOf(path14.join(folder, ".retry")) ?? "").trim().split(/\s+/).map(Number);
    for (const name of listOf(path14.join(folder, "wakes"))) {
      const due = wakeOf(name)?.due;
      if (due === undefined)
        continue;
      const at = Math.max(due, Number.isFinite(retry) ? retry : 0);
      if (soonest === null || at < soonest)
        soonest = at;
    }
  };
  for (const id of listOf(BOTS))
    look(path14.join(BOTS, id));
  for (const name of listOf(SESSION_WAKES))
    look(path14.join(SESSION_WAKES, name));
  return soonest;
}
function sendWakes() {
  let timer = null, settling = null, running = false, again = false, stopped = false, started = 0, said = false, over = null, ending = null;
  const schedule = (afterFire = false) => {
    if (stopped)
      return;
    clearTimeout(timer);
    const due = nextWake(), now = Date.now() / 1000;
    const missed = afterFire && due !== null && due <= now && due < started;
    const wait = due === null || missed ? 60000 : Math.min(60000, Math.max(500, (due + 1 - now) * 1000));
    timer = setTimeout(fire, wait);
  };
  const fire = () => {
    if (stopped)
      return;
    if (running)
      return void (again = true);
    running = true;
    started = Date.now() / 1000;
    execFile(WAKE_COMMAND, ["fire", BOTS, path14.join(RUN, "engine.json")], (error) => {
      running = false;
      if (error?.code === "ENOENT" && !said) {
        said = true;
        console.error(`Wake-ups can't be sent: there's no kuvo-wake at ${WAKE_COMMAND}.`);
      }
      if (stopped) {
        over?.();
      } else if (again) {
        again = false;
        fire();
      } else {
        schedule(true);
      }
    });
  };
  const changed = () => {
    clearTimeout(settling);
    settling = setTimeout(() => schedule(), 200);
  };
  wakeFollowers.add(changed);
  const watching = watchFolders([BOTS, SESSION_WAKES], changed);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(settling);
    wakeFollowers.delete(changed);
    watching.close();
    if (!running)
      return Promise.resolve();
    return ending ??= new Promise((resolve) => {
      over = resolve;
    });
  };
}
var wakeFollowers = new Set;
var wakesChanged = () => {
  for (const tell of wakeFollowers)
    tell();
};
var LETTERS = /^[A-Za-z0-9]+$/;
var WAKE_LIMIT = 50;
async function wakeFolderFor(session, readEngine, bridge) {
  if (!/^ses_[A-Za-z0-9]+$/.test(session))
    return null;
  const ask = async (target) => target ? (await engineGet(target, `api/session/${encodeURIComponent(session)}`).catch(() => null))?.data ?? null : null;
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  let found = await ask(engine), agents = false;
  if (!found) {
    found = await ask(bridge());
    agents = Boolean(found);
  }
  if (!found)
    return null;
  const folder = path14.join(SESSION_WAKES, session);
  fs15.mkdirSync(folder, { recursive: true, mode: 448 });
  fs15.writeFileSync(path14.join(folder, "session"), session);
  fs15.writeFileSync(path14.join(folder, "directory"), found.location?.directory ?? found.directory ?? "");
  if (agents)
    fs15.writeFileSync(path14.join(folder, "via"), "bridge");
  if (found.metadata?.["kuvo.archived"] === true)
    fs15.writeFileSync(path14.join(folder, "paused"), "archived");
  return folder;
}
function cancelWake(folder, letters) {
  if (!LETTERS.test(letters))
    return;
  for (const name of listOf(path14.join(folder, "wakes"))) {
    if (wakeOf(name)?.letters === letters)
      fs15.rmSync(path14.join(folder, "wakes", name), { force: true });
  }
}
async function waitForTools(port, authorization, directory, signal) {
  const started = Date.now();
  let waited = false;
  while (Date.now() - started < 20000) {
    let listed;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { headers: { authorization, "x-opencode-directory": encodeURIComponent(directory) }, signal });
      if (!response.ok)
        return;
      listed = await response.text();
    } catch {
      return;
    }
    const none = !listed.includes('"status"');
    if (!listed.includes('"pending"') && !(none && Date.now() - started < 3000)) {
      if (waited && !none)
        await sleep(1500);
      return;
    }
    waited = true;
    await sleep(none ? 100 : 250);
  }
}
var wakingNow = new Set;
async function* answerWakes(session, action, request, readEngine, bridge, signal) {
  const changed = function* (status, value) {
    wakesChanged();
    yield* json(status, value);
  };
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  let folder = wakeFolder(session);
  const listed = () => {
    if (!folder)
      return { wakes: [], watches: [], paused: false };
    const { wakes, watches, paused } = readWakes(folder);
    return { wakes: wakes.map(listedWake), watches, paused };
  };
  if (!action && (method === "GET" || method === "HEAD"))
    return yield* json(200, listed());
  if (method !== "POST")
    return yield* json(405, {});
  let given = {};
  try {
    given = JSON.parse(Buffer.from(request.body ?? []).toString("utf8") || "{}") ?? {};
  } catch {}
  const kuvoWake = (args) => new Promise((resolve) => execFile(WAKE_COMMAND, [folder, ...args], { encoding: "utf8", timeout: 30000 }, (error, _out, said) => resolve(error ? { missing: error.code === "ENOENT", refused: error.code === 2, said: String(said ?? "").trim() } : null)));
  const unavailable = (failed, what) => failed.missing ? json(503, { message: "Wake-ups aren’t set up on this computer." }) : json(failed.refused && failed.said ? 400 : 503, { message: failed.refused && failed.said ? failed.said : `${what} couldn’t be saved. Try again.` });
  if (action === "watch") {
    const every = typeof given.every === "string" ? given.every.trim() : "";
    const check = typeof given.check === "string" ? given.check.trim() : "";
    const note = typeof given.note === "string" ? given.note.trim() : "";
    if (!every || !check || !note)
      return yield* json(400, { message: "Send how often (`every`, like 5m, 2h or 1d), the check to run (`check`) and what to do when it changes (`note`)." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made)
        return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder))
      return yield* json(409, { message: MOVING });
    const failed = await kuvoWake(["watch", every, check, note]);
    if (failed)
      return yield* unavailable(failed, "The watch");
    return yield* changed(200, listed());
  }
  if (!action) {
    const due = Number(given.due), note = typeof given.note === "string" ? given.note.trim() : "";
    const every = given.every == null ? null : String(given.every);
    if (!Number.isFinite(due) || !note)
      return yield* json(400, { message: "Send when it comes (`due`, seconds since 1970) and what it says (`note`)." });
    if (every !== null && !/^(weekdays|[1-9][0-9]{0,5}[mhdw])$/.test(every))
      return yield* json(400, { message: "That isn’t a repeat: 30m, 2h, 1d, 1w or weekdays." });
    if (due < Date.now() / 1000 + 60)
      return yield* json(400, { message: "Pick a time at least a minute from now." });
    if (!folder) {
      const made = await wakeFolderFor(session, readEngine, bridge);
      if (!made)
        return yield* json(404, {});
      folder = made;
    }
    if (isMoving(folder))
      return yield* json(409, { message: MOVING });
    if (readWakes(folder).wakes.length >= WAKE_LIMIT)
      return yield* json(409, { message: `There are ${WAKE_LIMIT} wake-ups waiting already. Cancel some first.` });
    const failed = await kuvoWake(["add", String(Math.floor(due)), ...every ? ["--every", every] : [], note]);
    if (failed)
      return yield* unavailable(failed, "The wake-up");
    return yield* changed(200, listed());
  }
  if (action === "pause" && typeof given.archived === "boolean") {
    if (folder && isMoving(folder))
      return yield* json(409, { message: MOVING });
    holdArchived(session, given.archived);
    return yield* changed(200, listed());
  }
  if (action === "pause" && typeof given.paused !== "boolean")
    return yield* json(400, { message: 'Send {"paused": true} or false.' });
  if (!folder)
    return yield* json(action === "pause" ? 200 : 404, action === "pause" ? listed() : {});
  if (isMoving(folder))
    return yield* json(409, { message: MOVING });
  if (action === "pause") {
    if (given.paused)
      fs15.writeFileSync(path14.join(folder, "paused"), "paused");
    else
      fs15.rmSync(path14.join(folder, "paused"), { force: true });
    return yield* changed(200, listed());
  }
  const { wakes, watches } = readWakes(folder);
  const chosen = typeof given.wake === "string" ? wakes.find((each) => each.id === given.wake || each.letters === given.wake) : undefined;
  if (action === "cancel") {
    if (chosen && LETTERS.test(chosen.letters)) {
      cancelWake(folder, chosen.letters);
      return yield* changed(200, {});
    }
    const watch = typeof given.watch === "string" ? watches.find((each) => each.letters === given.watch) : undefined;
    if (watch && LETTERS.test(watch.letters)) {
      fs15.rmSync(path14.join(folder, "watches", watch.letters), { recursive: true, force: true });
      return yield* changed(200, {});
    }
    return yield* json(404, {});
  }
  if (!chosen)
    return yield* json(404, {});
  const key = `${folder}/${chosen.id}`;
  if (wakingNow.has(key))
    return yield* json(200, {});
  wakingNow.add(key);
  try {
    const note = textOf(path14.join(folder, "wakes", chosen.id));
    if (note === null)
      return yield* json(404, {});
    const agents = (textOf(path14.join(folder, "via")) ?? "").trim() === "bridge";
    let target = null;
    try {
      target = agents ? bridge() : readEngine();
    } catch {}
    if (!target)
      return yield* json(503, { message: agents ? "The coding agents aren’t running on this computer." : "The engine isn’t running." });
    const authorization = `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`;
    const directory = textOf(path14.join(folder, "directory"));
    if (!agents && directory)
      await waitForTools(target.port, authorization, directory, signal);
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}/prompt`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ id: messageID(), text: WAKE_MARKER + note, delivery: "queue" }),
        signal
      });
    } catch {
      return yield* json(503, { message: "The wake-up couldn’t be sent." });
    }
    if (!response.ok)
      return yield* json(503, { message: `The wake-up couldn’t be sent (${response.status}).` });
    if (!chosen.every)
      cancelWake(folder, chosen.letters);
    return yield* changed(200, {});
  } finally {
    wakingNow.delete(key);
  }
}
async function* wakesRoute(context) {
  const { request, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase()))
    return yield* text(405, "Read them with GET.");
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ sessions: listWakes() })) };
  return;
}
async function* wakeEventsRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ sessions: allWakes() }), wakeFollowers, signal, { folders: [BOTS, SESSION_WAKES] });
}
async function* sessionWakesRoute(context, wakes) {
  const { request, signal, readEngine, bridge, text } = context;
  let session;
  try {
    session = decodeURIComponent(wakes[1]);
  } catch {
    return yield* text(404, "No such session.");
  }
  return yield* answerWakes(session, wakes[2], request, readEngine, bridge, signal);
}

// Packages/Box/src/link/bots/edit.ts
import fs31 from "node:fs";
import path30 from "node:path";

// Packages/Box/src/link/areas/carry.ts
import fs24 from "node:fs";
import path23 from "node:path";

// Packages/Box/src/link/bots/kit.ts
import fs20 from "node:fs";
import os3 from "node:os";
import path19 from "node:path";

// Packages/Box/src/link/areas/projects.ts
import fs17 from "node:fs";
import path16 from "node:path";

// Packages/Box/src/link/areas/worktree-records.ts
import fs16 from "node:fs";
import path15 from "node:path";
var WORKTREES_FILE = path15.join(K, "box", "worktrees.json");
var BRANCH_PREFIX_FILE = path15.join(K, "box", "git.json");
var branchPrefix = () => {
  try {
    const kept = JSON.parse(fs16.readFileSync(BRANCH_PREFIX_FILE, "utf8")).branchPrefix;
    return typeof kept === "string" ? kept : "kuvo/";
  } catch {
    return "kuvo/";
  }
};
function readWorktrees() {
  try {
    const list = JSON.parse(fs16.readFileSync(WORKTREES_FILE, "utf8")).worktrees;
    return Array.isArray(list) ? list.filter((each) => typeof each?.root === "string" && typeof each?.project === "string" && typeof each?.branch === "string") : [];
  } catch {
    return [];
  }
}
function readRemovedWorktrees() {
  try {
    const removed = JSON.parse(fs16.readFileSync(WORKTREES_FILE, "utf8")).removed;
    return isObject(removed) ? Object.fromEntries(Object.entries(removed).filter(([, project]) => typeof project === "string")) : {};
  } catch {
    return {};
  }
}
function updateWorktrees(change, gone) {
  let removed = readRemovedWorktrees();
  if (gone)
    removed = Object.fromEntries([...Object.entries(removed).filter(([folder]) => folder !== (gone.folder ?? gone.root)), [gone.folder ?? gone.root, gone.project]].slice(-200));
  writePrivate(WORKTREES_FILE, JSON.stringify({ worktrees: change(readWorktrees()), removed }, null, 2));
  for (const tell of worktreeFollowers)
    tell();
}
var worktreeFollowers = new Set;

// Packages/Box/src/link/areas/projects.ts
var PROJECTS_FILE = path16.join(K, "box", "projects.json");
var PROJECTS_LOCK = PROJECTS_FILE + ".lock";
function readProjects(file = PROJECTS_FILE) {
  try {
    const list = JSON.parse(fs17.readFileSync(file, "utf8")).projects;
    return Array.isArray(list) ? list.filter((each) => typeof each?.directory === "string" && path16.isAbsolute(each.directory)).map((each) => ({ ...each, folders: Array.isArray(each.folders) ? each.folders.filter((folder) => typeof folder === "string") : [] })) : [];
  } catch {
    return [];
  }
}
function boxProjects(kit, file = PROJECTS_FILE) {
  if (!fs17.existsSync(file))
    return kit?.projects ?? [];
  return readProjects(file).filter((each) => !each.removed).map((each) => ({ directory: each.directory, name: each.name ?? path16.basename(each.directory) }));
}
function changeProjects(change, file = PROJECTS_FILE, lock = PROJECTS_LOCK) {
  const projects = locked(lock, () => {
    const projects = change(readProjects(file));
    writePrivate(file, JSON.stringify({ version: 1, projects }, null, 2));
    return projects;
  });
  for (const tell of projectFollowers)
    tell();
  return projects;
}
function keptProject(directory, given, before = {}) {
  const project = { ...before, directory, folders: before.folders ?? [] };
  if (given.removed === true)
    project.removed = true;
  else
    delete project.removed;
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  if ("name" in given)
    project.name = text(given.name) === path16.basename(directory) ? undefined : text(given.name);
  if ("folders" in given)
    project.folders = [...new Set((Array.isArray(given.folders) ? given.folders : []).filter((folder) => typeof folder === "string" && path16.isAbsolute(folder) && folder !== directory))];
  if ("run" in given)
    project.run = text(given.run);
  if ("terminal" in given)
    project.terminal = text(given.terminal);
  for (const key of ["name", "run", "terminal"])
    if (project[key] === undefined)
      delete project[key];
  return project;
}
async function archiveProject(directory, readEngine, readBridge, signal) {
  const folders = [directory, ...readWorktrees().filter((tree) => tree.project === directory && typeof tree.folder === "string").map((tree) => tree.folder)];
  const targets = [];
  try {
    targets.push(readEngine());
  } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && processRuns(bridge.pid, "kuvo-agents"))
      targets.push(bridge);
  } catch {}
  if (!targets.length)
    return { archived: 0, kept: null };
  let archived = 0, kept = 0;
  for (const target of targets) {
    for (const folder of folders) {
      let query = `limit=100&order=desc&parentID=null&directory=${encodeURIComponent(folder)}`;
      for (let page = 0;page < 1000 && query; page++) {
        let listed;
        try {
          const response = await fetch(`http://127.0.0.1:${target.port}/api/session?${query}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal });
          if (!response.ok)
            throw new Error;
          listed = await response.json();
        } catch {
          kept += 1;
          break;
        }
        const sessions = Array.isArray(listed?.data) ? listed.data : [];
        for (const session of sessions) {
          if (session?.location?.directory !== folder || session.time?.archived || session.metadata?.["kuvo.archived"] === true)
            continue;
          try {
            await call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { ...session.metadata ?? {}, "kuvo.archived": true } }, signal);
            holdArchived(session.id, true);
            archived += 1;
          } catch {
            kept += 1;
          }
        }
        const next = listed?.cursor?.next;
        query = sessions.length === 100 && next ? `limit=100&cursor=${encodeURIComponent(next)}` : null;
      }
    }
  }
  return { archived, kept };
}
async function* answerProjects(request, readEngine = readEngineFile, readBridge = readBridgeFile, signal, file = PROJECTS_FILE, lock = PROJECTS_LOCK) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const [route, query = ""] = request.path.split("?");
  const method = request.method.toUpperCase();
  const listed = () => ({ projects: readProjects(file) });
  if (route === "kuvo/projects/events") {
    if (method !== "GET")
      return yield* json(405, {});
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    return yield* followed(listed, projectFollowers, signal);
  }
  if (route !== "kuvo/projects")
    return yield* json(404, {});
  if (method === "GET")
    return yield* json(200, listed());
  const given = new URLSearchParams(query).get("directory");
  if (!given || !path16.isAbsolute(given))
    return yield* json(400, { message: "Say which folder (directory)." });
  if (method === "PUT") {
    const body = parsed(request.body) ?? {};
    if (!isObject(body))
      return yield* json(400, { message: "That isn’t a project." });
    let project;
    changeProjects((projects) => {
      const before = projects.find((each) => each.directory === given);
      project = keptProject(given, body, before);
      return before ? projects.map((each) => each === before ? project : each) : [project, ...projects];
    }, file, lock);
    return yield* json(200, { project });
  }
  if (method === "DELETE") {
    const { archived, kept } = await archiveProject(given, readEngine, readBridge, signal);
    if (kept === null)
      return yield* json(503, { message: "Its sessions can’t be reached: the engine isn’t running." });
    if (kept > 0)
      return yield* json(409, { message: `${kept === 1 ? "One of its sessions" : `${kept} of its sessions`} couldn’t be archived, so it stays with them. Try again in a moment.`, archived, kept });
    changeProjects((projects) => {
      const before = projects.find((each) => each.directory === given);
      return before ? projects.map((each) => each === before ? { ...each, removed: true } : each) : projects;
    }, file, lock);
    return yield* json(200, { archived });
  }
  return yield* json(405, {});
}
var projectFollowers = new Set;

// Packages/Box/src/link/personalities/library.ts
import fs18 from "node:fs";
import path17 from "node:path";

// Packages/Box/src/link/documents/format.ts
import crypto5 from "node:crypto";

// Packages/Box/src/shared/documents.ts
var DOC_KINDS = ["peers", "phones", "personalities"];

// Packages/Box/src/link/documents/format.ts
var DOC_SIGNED = Buffer.from("kuvo-link doc v1\x00");
var MOST_DOC = 512 * 1024;
var DOC_PART = 40000;
var MOST_PARTS = Math.ceil(MOST_DOC * 4 / 3 / DOC_PART) + 1;
var SIGN = /^[A-Za-z0-9_-]{43}$/;
var ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
var ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
var newSigningSeed = () => crypto5.randomBytes(32).toString("base64url");
var edPrivate = (seed) => crypto5.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(seed, "base64url")]), format: "der", type: "pkcs8" });
var edPublic = (key) => crypto5.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(key, "base64url")]), format: "der", type: "spki" });
var signingKeys = new Map;
function signingKeyOf(seed) {
  let key = signingKeys.get(seed);
  if (!key) {
    key = crypto5.createPublicKey(edPrivate(seed)).export({ format: "der", type: "spki" }).subarray(ED_SPKI.length).toString("base64url");
    signingKeys.set(seed, key);
  }
  return key;
}
var ownSign = (link) => {
  try {
    return typeof link?.sign === "string" ? signingKeyOf(link.sign) : null;
  } catch {
    return null;
  }
};
var shortHash = (bytes) => crypto5.createHash("sha256").update(bytes).digest().subarray(0, 8).toString("base64url");
var bodyHash = (body) => shortHash(Buffer.from(JSON.stringify(body)));
var docBytes = (origin, kind, n, body) => Buffer.from(JSON.stringify({ v: 1, kind, origin, n, body }));
function signDoc(seed, kind, n, body) {
  const bytes = docBytes(signingKeyOf(seed), kind, n, body);
  return { d: bytes.toString("base64url"), s: crypto5.sign(null, Buffer.concat([DOC_SIGNED, bytes]), edPrivate(seed)).toString("base64url") };
}
function readDoc(envelope) {
  if (!isObject(envelope) || typeof envelope.d !== "string" || typeof envelope.s !== "string" || envelope.d.length > Math.ceil(MOST_DOC * 4 / 3) + 4)
    return null;
  let bytes, doc;
  try {
    bytes = Buffer.from(envelope.d, "base64url");
    if (bytes.length > MOST_DOC || bytes.toString("base64url") !== envelope.d)
      return null;
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(doc) || doc.v !== 1 || !DOC_KINDS.includes(doc.kind) || typeof doc.origin !== "string" || !SIGN.test(doc.origin) || !Number.isSafeInteger(doc.n) || doc.n < 1 || !isObject(doc.body))
    return null;
  try {
    const signature = Buffer.from(envelope.s, "base64url");
    if (signature.length !== 64 || !crypto5.verify(null, Buffer.concat([DOC_SIGNED, bytes]), edPublic(doc.origin), signature))
      return null;
  } catch {
    return null;
  }
  return { origin: doc.origin, kind: doc.kind, n: doc.n, body: doc.body, h: shortHash(bytes), envelope: { d: envelope.d, s: envelope.s } };
}
var heldDocs = new Map;
function held(envelope) {
  if (typeof envelope?.d !== "string")
    return null;
  let doc = heldDocs.get(envelope.d);
  if (!doc) {
    try {
      const bytes = Buffer.from(envelope.d, "base64url");
      const parsed = JSON.parse(bytes.toString("utf8"));
      doc = { origin: parsed.origin, kind: parsed.kind, n: parsed.n, body: isObject(parsed.body) ? parsed.body : {}, h: shortHash(bytes), envelope };
    } catch {
      return null;
    }
    if (heldDocs.size >= 256)
      heldDocs.delete(heldDocs.keys().next().value);
    heldDocs.set(envelope.d, doc);
  }
  return doc;
}
var docKey = (origin, kind) => `${origin} ${kind}`;

// Packages/Box/src/link/personalities/library.ts
var PERSONALITIES_FILE = path17.join(BOTS, "personalities.json");
var PERSONALITIES_LOCK = path17.join(RUN, ".personalities.lock");
var personalityFollowers = new Set;
var PERSONALITY_ID = /^custom\.[A-Za-z0-9._-]{1,80}$/;
var MOST_REMOVALS = 500;
var MOST_COUNT = 2 ** 52;
var changedAt = (entry) => Number(entry?.removed ?? entry?.updated ?? 0) || 0;
var isRemoval = (entry) => entry?.removed !== undefined;
function keptPersonality(entry) {
  if (!isObject(entry) || typeof entry.id !== "string" || !PERSONALITY_ID.test(entry.id) || changedAt(entry) > MOST_COUNT)
    return null;
  if (isRemoval(entry))
    return Number.isFinite(Number(entry.removed)) ? { id: entry.id, removed: Number(entry.removed) } : null;
  const name = plainName(entry.name).slice(0, 80);
  const description = String(entry.description ?? "").trim().slice(0, 2000);
  if (!name || !description)
    return null;
  return { id: entry.id, name, description, symbol: typeof entry.symbol === "string" && entry.symbol ? entry.symbol.slice(0, 80) : "person.crop.circle", updated: Number(entry.updated) || 0 };
}
function newerTake(a, b) {
  if (isRemoval(a) !== isRemoval(b))
    return isRemoval(a) ? a : b;
  const at = changedAt(a), bt = changedAt(b);
  if (at !== bt)
    return at > bt ? a : b;
  return `${a.name ?? ""}
${a.description ?? ""}` >= `${b.name ?? ""}
${b.description ?? ""}` ? a : b;
}
function mergePersonalities(...libraries) {
  const byID = new Map;
  for (const library of libraries) {
    for (const entry of [...Array.isArray(library?.personalities) ? library.personalities : [], ...Array.isArray(library?.removed) ? library.removed : []]) {
      const kept = keptPersonality(entry);
      if (!kept)
        continue;
      const had = byID.get(kept.id);
      byID.set(kept.id, had ? newerTake(had, kept) : kept);
    }
  }
  const all = [...byID.values()];
  return {
    personalities: all.filter((entry) => !isRemoval(entry)),
    removed: all.filter(isRemoval).sort((a, b) => b.removed - a.removed).slice(0, MOST_REMOVALS)
  };
}
function readPersonalities(file = PERSONALITIES_FILE) {
  try {
    return mergePersonalities(JSON.parse(fs18.readFileSync(file, "utf8")));
  } catch {
    return { personalities: [], removed: [] };
  }
}
function changePersonalities(change, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  return locked(lock, () => {
    const library = mergePersonalities(change(readPersonalities(file)));
    const text = JSON.stringify({ kuvo: 1, ...library }, null, 2) + `
`;
    if (textOf(file) !== text) {
      writePrivate(file, text);
      for (const tell of personalityFollowers)
        tell();
    }
    return library;
  });
}
function meetPersonalities(given, file, lock) {
  let changed = [];
  changePersonalities((library) => {
    const was = new Map([...library.personalities, ...library.removed].map((entry) => [entry.id, JSON.stringify(entry)]));
    const met = mergePersonalities(library, given);
    changed = [...met.personalities, ...met.removed].filter((entry) => was.get(entry.id) !== JSON.stringify(entry)).map((entry) => entry.id);
    return met;
  }, file, lock);
  return changed;
}
function personalitiesDocument(file = PERSONALITIES_FILE) {
  return { kuvo: 1, ...readPersonalities(file) };
}
var FULL_LIBRARY = "There’s no room for more in your personalities. Shorten or remove one, then try again.";
var fitsLibrary = (library) => Buffer.byteLength(JSON.stringify(mergePersonalities(library))) <= MOST_DOC - 4096;
function botPersonalities(kit, library = readPersonalities()) {
  const told = (each) => kit.personalityWords.replaceAll("⟦name⟧", each.name).replaceAll("⟦description⟧", each.description);
  const presets = kit.personalities.filter((each) => !each.custom);
  const fromKit = kit.personalities.filter((each) => each.custom && !library.personalities.some((mine) => mine.id === each.id) && !library.removed.some((gone) => gone.id === each.id));
  return [...presets, ...fromKit, ...library.personalities.map((each) => ({ id: each.id, name: each.name, description: each.description, custom: true, instruction: told(each) }))];
}

// Packages/Box/src/link/state.ts
import fs19 from "node:fs";
import path18 from "node:path";
var MAC_OVERLAY = ["key", "secret", "sign", "relay", "name"];
var macLink = { config: null, overlay: null, status: { state: "off" }, host: null, wake: null, statusFollowers: new Set, phoneFollowers: new Set };
var written = [];
var onLinkWritten = (then) => {
  written.push(then);
};
var macSign = (link, mac) => typeof link?.macSigns?.[mac] === "string" && SIGN.test(link.macSigns[mac]) ? link.macSigns[mac] : null;
function migratedLink(link) {
  if (!isObject(link) || !(link.peersFrom || link.vouched || link.macAts))
    return link;
  for (const [mac, given] of Object.entries(link.peersFrom ?? {})) {
    if (!macSign(link, mac) && isObject(given)) {
      link.legacy ??= {};
      link.legacy[mac] ??= { at: given.at ?? 0, peers: Array.isArray(given.peers) ? given.peers : [], moved: given.moved ?? [] };
    }
  }
  delete link.peersFrom;
  delete link.vouched;
  delete link.macAts;
  return link;
}
function readLink() {
  let link = null;
  try {
    link = migratedLink(JSON.parse(fs19.readFileSync(LINK_FILE, "utf8")));
  } catch {}
  if (IS_MAC && macLink.overlay)
    return { phones: [], ...link ?? {}, ...macLink.overlay };
  return link;
}
function writeLink(link) {
  fs19.mkdirSync(RUN, { recursive: true, mode: 448 });
  const temporary = `${LINK_FILE}.${process.pid}.tmp`;
  const kept = IS_MAC ? Object.fromEntries(Object.entries(link).filter(([key]) => !MAC_OVERLAY.includes(key))) : link;
  fs19.writeFileSync(temporary, JSON.stringify(kept, null, 2), { mode: 384 });
  fs19.renameSync(temporary, LINK_FILE);
  for (const then of written)
    then(link);
}
var LOCK = path18.join(RUN, ".link.lock");
function updateLink(change) {
  return locked(LOCK, () => {
    const changed = change(readLink());
    if (changed)
      writeLink(changed);
    return changed ?? null;
  });
}

// Packages/Box/src/link/bots/kit.ts
var NO_KIT = IS_MAC ? "Kuvo Code is still setting up bots on this Mac. Try again in a moment." : "Connect to this machine from your Mac once, then try again.";
var KIT_FILE = path19.join(BOTS, "kit.json");
var AGENT_PROVIDERS = ["claude-code", "codex-cli", "cursor", "grok-cli", "antigravity"];
var runsWithAgents = (model) => model?.providerID === "auto" || AGENT_PROVIDERS.includes(String(model?.providerID ?? "").split("@")[0]);
var WORDS_FILE = path19.join(K, "bin", "bot-words.json");
function readWords(file = WORDS_FILE) {
  try {
    const words = JSON.parse(textOf(file) ?? "");
    return words?.kuvo === 1 && Array.isArray(words.templates) && Array.isArray(words.personalities) && Array.isArray(words.instructions) && isObject(words.looks) && isObject(words.here?.mac) && isObject(words.here?.machine) && isObject(words.job) && ["personalityWords", "projectNote", "identityNote", "memory", "greeting"].every((key) => typeof words[key] === "string") ? words : null;
  } catch {
    return null;
  }
}
function readKit() {
  const words = readWords();
  const mac = readMacKit();
  if (!words || IS_MAC && !mac)
    return null;
  const timeZone = zoneOf(mac);
  const machine = typeof mac?.machine === "string" && mac.machine || readLink()?.id || os3.hostname();
  const here = IS_MAC ? words.here.mac : words.here.machine;
  const fill = (text) => text.replace(/⟦(place|clock|browser)⟧/g, (_, key) => String(here[key] ?? "")).replaceAll("⟦machine⟧", () => machine).replaceAll("⟦timeZone⟧", () => timeZone || "UTC");
  const told = (each) => words.personalityWords.replaceAll("⟦name⟧", () => each.name).replaceAll("⟦description⟧", () => each.description);
  return {
    kuvo: 1,
    templates: words.templates,
    personalities: [
      ...words.personalities.map((each) => ({ id: each.id, name: each.name, description: each.description, custom: false, instruction: told(each) })),
      ...Array.isArray(mac?.personalities) ? mac.personalities.filter((each) => each?.custom) : []
    ],
    personalityWords: words.personalityWords,
    looks: words.looks,
    instructions: fill(words.instructions.join(`

`)),
    job: { none: String(words.job.none ?? ""), line: String(words.job.line ?? ""), details: String(words.job.details ?? "") },
    projectNote: words.projectNote,
    identityNote: words.identityNote,
    memory: words.memory,
    greeting: words.greeting,
    startingModel: mac?.startingModel ?? null,
    projects: Array.isArray(mac?.projects) ? mac.projects : [],
    rules: Array.isArray(mac?.rules) ? mac.rules : [],
    timeZone: timeZone || "UTC",
    ...typeof mac?.zoneinfo === "string" ? { zoneinfo: mac.zoneinfo } : {}
  };
}
function readMacKit() {
  try {
    const kit = JSON.parse(textOf(KIT_FILE) ?? "");
    return kit?.kuvo === 1 ? kit : null;
  } catch {
    return null;
  }
}
function zoneOf(mac) {
  if (IS_MAC)
    return "";
  if (typeof mac?.timeZone === "string" && mac.timeZone)
    return mac.timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}
function forgetOldKit() {
  const file = path19.join(K, "bin", "bot-kit.json");
  try {
    const installed = JSON.parse(textOf(path19.join(UPDATES, "installed.json")) ?? "{}");
    if (isObject(installed?.files) && "bin/bot-kit.json" in installed.files)
      return;
  } catch {}
  fs20.rmSync(file, { force: true });
}
function botTemplates(kit, machine) {
  return {
    templates: kit.templates.map(({ firstMessage: _, ...template }) => template),
    personalities: botPersonalities(kit).map(({ instruction: _, ...personality }) => personality),
    looks: kit.looks,
    startingModel: { [IS_MAC ? "mac" : machine || "machine"]: kit.startingModel ?? null },
    projects: boxProjects(kit).map((project) => ({ ...project, machine: IS_MAC ? undefined : machine || undefined }))
  };
}
function botInstructions(kit, name, folder, personality, project, job) {
  const working = Boolean(job?.section || job?.line);
  let text = kit.instructions.replaceAll("⟦name⟧", () => name).replaceAll("⟦folder⟧", () => folder);
  text = personality ? text.replace("⟦personality⟧", () => personality) : text.replace(`
⟦personality⟧
`, "");
  if (project)
    text = text.replace(`

${kit.identityNote}`, () => `

${kit.projectNote}

${kit.identityNote}`);
  text = text.replace("⟦jobLine⟧", () => job?.line ? kit.job.line.replace("⟦job⟧", () => job.line) : "");
  const part = working ? kit.job.details.replace("⟦jobDetails⟧", () => job.section || job.line) : kit.job.none;
  return part ? text.replace("⟦jobPart⟧", () => part) : text.replace(/(\n\n)?⟦jobPart⟧/, "");
}

// Packages/Box/src/link/bots/tell.ts
import crypto6 from "node:crypto";
import fs22 from "node:fs";
import path21 from "node:path";

// Packages/Box/src/link/bots/jobs.ts
import fs21 from "node:fs";
import path20 from "node:path";
var JOB_FILE = "job.json";
var MOST_JOB_LINE = 200;
var MOST_JOB_DETAILS = 8000;
function readJob(folder) {
  try {
    const kept = JSON.parse(textOf(path20.join(folder, JOB_FILE)) ?? "");
    return isObject(kept) ? { line: typeof kept.line === "string" ? kept.line : "", details: typeof kept.details === "string" ? kept.details : "" } : null;
  } catch {
    return null;
  }
}
function writeJob(here, job) {
  const file = path20.join(here.folder, JOB_FILE);
  fs21.writeFileSync(`${file}.new`, JSON.stringify({ line: job.line, details: job.details, updated: stamp() }, null, 2));
  fs21.renameSync(`${file}.new`, file);
  if ((here.described.job ?? "") !== job.line) {
    const described = path20.join(here.folder, "bot.json");
    fs21.writeFileSync(`${described}.new`, JSON.stringify({ ...here.described, job: job.line }, null, 2));
    fs21.renameSync(`${described}.new`, described);
    here.described = { ...here.described, job: job.line };
  }
}
function jobOf(here) {
  const kept = readJob(here.folder);
  if (kept)
    return kept;
  const memory = jobInMemory(textOf(path20.join(here.folder, "MEMORY.md")) ?? "");
  let job = memory ? { line: memory.line, details: detailsBeyond(memory.line, memory.section) } : { line: plainName(here.described.job ?? ""), details: "" };
  if (IS_MAC && !memory) {
    const listed = macListed().find((each) => each?.id === here.described.id);
    if (listed && listed.jobInMemory !== true)
      job = { line: plainName(listed.job ?? ""), details: detailsBeyond(plainName(listed.job ?? ""), listed.instructions) };
  }
  if (!isMoving(here.folder))
    try {
      writeJob(here, job);
    } catch {}
  return job;
}
function macListed() {
  try {
    const listed = JSON.parse(textOf(path20.join(path20.dirname(BOTS), "bots.json")) ?? "[]");
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}
function keepJobs() {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (here)
      jobOf(here);
  }
}
function givenJob(given) {
  if (!isObject(given) || given.line !== undefined && typeof given.line !== "string" || given.details !== undefined && typeof given.details !== "string") {
    return { error: "A job is {line, details}: what it does in a few words, and the details." };
  }
  const line = jobLine(plainName(given.line ?? ""));
  const details = trimmed(given.details ?? "");
  if ([...line].length > MOST_JOB_LINE)
    return { error: "Say what it does in a few words: that line is too long." };
  if ([...details].length > MOST_JOB_DETAILS)
    return { error: "That job is too long to keep: shorten its details." };
  return { job: { line, details } };
}
var spaces = (text) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
var trimmed = (text) => text.replace(/^[\p{Z}\t\n\v\f\r\u0085]+|[\p{Z}\t\n\v\f\r\u0085]+$/gu, "");
function headingLevel(line) {
  const text = spaces(line);
  let marks = 0;
  while (marks < text.length && text[marks] === "#")
    marks++;
  if (marks < 1 || marks > 6)
    return;
  const after = text.slice(marks);
  return after.length === 0 || after[0] === " " ? marks : undefined;
}
function isJobHeading(line) {
  const text = spaces(line);
  if (!text.startsWith("#"))
    return false;
  const title = spaces(text.replace(/^#+/, "")).toLowerCase();
  if (title === "job" || title === "my job" || title === "the job" || title.startsWith("job:"))
    return true;
  if (!title.startsWith("job "))
    return false;
  const first = spaces(title.slice(4))[0];
  return first !== undefined && "-–—:(".includes(first);
}
function jobInHeading(line) {
  const title = spaces(spaces(line).replace(/^#+/, ""));
  if (!title.toLowerCase().startsWith("job"))
    return;
  let rest = spaces(title.slice(3));
  const mark = rest[0];
  if (mark === undefined || !":-–—(".includes(mark))
    return;
  rest = spaces(rest.slice(1));
  if (mark === "(" && rest.endsWith(")"))
    rest = spaces(rest.slice(0, -1));
  return rest.length === 0 ? undefined : { text: rest, isColon: mark === ":" };
}
function jobInMemory(text) {
  const all = text.split(`
`);
  const start = all.findIndex(isJobHeading);
  if (start < 0)
    return null;
  const level = headingLevel(all[start]) ?? 1;
  let end = all.length;
  let inCode = false;
  for (let index = start + 1;index < all.length; index++) {
    const line = spaces(all[index]);
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inCode = !inCode;
      continue;
    }
    const other = inCode ? undefined : headingLevel(all[index]);
    if (other !== undefined && other <= level) {
      end = index;
      break;
    }
  }
  let section = trimmed(all.slice(start + 1, end).join(`
`));
  const inline = jobInHeading(all[start]);
  if (inline && (inline.isColon || section.length === 0))
    section = [inline.text, section].filter((part) => part.length > 0).join(`
`);
  return { line: jobLine(section.split(`
`).map(spaces).find((part) => part.length > 0) ?? ""), section };
}
function jobLine(text) {
  let line = spaces(text);
  for (const mark of ["- ", "* ", "> "])
    if (line.startsWith(mark))
      line = line.slice(mark.length);
  line = line.replaceAll("**", "").replaceAll("__", "");
  if (line.toLowerCase().startsWith("job:"))
    line = line.slice(4);
  line = spaces(line);
  if ([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line)].length > 48 && line.includes(". "))
    line = line.slice(0, line.indexOf(". "));
  if (line.endsWith(".") && !line.endsWith(".."))
    line = line.slice(0, -1);
  return line;
}
function firstMessageOf(line, details) {
  const job = trimmed(String(line ?? ""));
  const rest = detailsBeyond(job, details);
  if (!job && !rest)
    return "";
  return [
    job ? `Your job, in a few words: ${job}.` : "",
    rest,
    "Start now: ask me for anything you need first, do the first round, and if it repeats or keeps an eye on something, set that up."
  ].filter((part) => part.length > 0).join(`

`);
}
function detailsBeyond(job, details) {
  const lines = trimmed(String(details ?? "")).split(`
`);
  if (!job || !lines.length || jobLine(lines[0]) !== job)
    return lines.join(`
`);
  const first = lines[0];
  const end = first.indexOf(". ");
  if (end >= 0 && spaces(first.slice(end + 2)) && jobLine(first.slice(0, end)) === job)
    lines[0] = spaces(first.slice(end + 2));
  else
    lines.shift();
  return trimmed(lines.join(`
`));
}

// Packages/Box/src/link/bots/list.ts
function listBots(machine) {
  const bots = [];
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (!here)
      continue;
    const { folder, described, session, agents } = here;
    const { wakes, watches, paused } = readWakes(folder);
    const job = jobOf(here);
    bots.push({
      created: String(described.created ?? ""),
      bot: {
        id,
        session,
        name: described.name,
        look: described.look,
        machine: IS_MAC ? undefined : machine || undefined,
        job: job.line,
        jobDetails: job.details,
        paused,
        wakes: wakes.length ? Math.min(...wakes.map((wake) => wake.due)) : undefined,
        watching: watches.length,
        agents,
        personality: typeof described.personality === "string" ? described.personality : undefined,
        model: isModel(described.model) ? described.model : undefined,
        folder,
        project: typeof described.project === "string" ? described.project : undefined,
        created: typeof described.created === "string" ? described.created : undefined
      }
    });
  }
  return bots.sort((a, b) => a.created.localeCompare(b.created)).map((entry) => entry.bot);
}

// Packages/Box/src/link/bots/tell.ts
var TOLD_FILE = "told.json";
var toldDigest = (text) => crypto6.createHash("sha256").update(text).digest("hex");
function toldOf(folder) {
  try {
    const told = JSON.parse(textOf(path21.join(folder, TOLD_FILE)) ?? "");
    return isObject(told) ? told : {};
  } catch {
    return {};
  }
}
function noteTold(folder, changes) {
  try {
    const file = path21.join(folder, TOLD_FILE);
    fs22.writeFileSync(`${file}.new`, JSON.stringify({ ...toldOf(folder), ...changes }));
    fs22.renameSync(`${file}.new`, file);
  } catch {}
}
function toldNow(kit, here, described = here.described) {
  const personality = botPersonalities(kit).find((each) => each.id === described.personality)?.instruction;
  const job = jobOf(here);
  return botInstructions(kit, described.name, here.folder, personality, described.project, { line: job.line, section: job.details });
}
async function tellBot(target, here, session, text, signal) {
  const told = await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session)}/instructions/entries/kuvo.bot`, { value: text }, signal).then(() => true, () => false);
  if (told)
    noteTold(here.folder, { session, instructions: toldDigest(text) });
  return told;
}
var freshening = new Map;
function oneAtATime(sessionID, work) {
  const now = (freshening.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(work);
  freshening.set(sessionID, now);
  const done = () => {
    if (freshening.get(sessionID) === now)
      freshening.delete(sessionID);
  };
  now.then(done, done);
  return now;
}
function freshenBot(target, sessionID) {
  return oneAtATime(sessionID, () => freshenOne(target, sessionID));
}
async function freshenOne(target, sessionID) {
  const here = listOf(BOTS).map(botHere).find((bot) => bot?.session === sessionID);
  if (!here || isMoving(here.folder))
    return;
  const kit = readKit();
  settleFolder(here, kit);
  if (!kit)
    return;
  const told = toldOf(here.folder);
  const text = toldNow(kit, here);
  const there = await toldThere(target, sessionID);
  const stale = there === undefined ? told.session !== sessionID || told.instructions !== toldDigest(text) : there !== text;
  if (stale)
    await tellBot(target, here, sessionID, text);
  if (told.rules !== here.folder && await repairRules(target, here, sessionID))
    noteTold(here.folder, { rules: here.folder });
}
function settleFolder(here, kit) {
  const write = (name, data) => {
    const file = path21.join(here.folder, name);
    let now = null;
    try {
      now = fs22.readFileSync(file);
    } catch {}
    if (!now || !now.equals(Buffer.from(data)))
      fs22.writeFileSync(file, data);
  };
  try {
    write("directory", typeof here.described.project === "string" ? here.described.project : path21.join(here.folder, "workspace"));
    if (IS_MAC) {
      for (const name of ["timezone", "zoneinfo"])
        fs22.rmSync(path21.join(here.folder, name), { force: true });
    } else {
      const mac = readMacKit(), zone = zoneOf(mac);
      if (zone)
        write("timezone", zone);
      if (typeof mac?.zoneinfo === "string" && mac.zoneinfo)
        write("zoneinfo", Buffer.from(mac.zoneinfo, "base64"));
    }
    if (kit && !fs22.existsSync(path21.join(here.folder, "MEMORY.md")))
      write("MEMORY.md", kit.memory.replaceAll("⟦name⟧", () => here.described.name));
  } catch {}
}
async function settleBot(id, readEngine, readBridge, machine) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here)
    return no(404, "That bot isn’t there any more.");
  return oneAtATime(here.session, async () => {
    const kit = readKit();
    settleFolder(here, kit);
    noteBotsChanged();
    if (!kit)
      return no(409, NO_KIT);
    let target;
    try {
      target = here.agents ? readBridge() : readEngine();
    } catch {}
    if (!target)
      return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
    const text = toldNow(kit, here);
    const there = await toldThere(target, here.session);
    if (there === text)
      noteTold(here.folder, { session: here.session, instructions: toldDigest(text) });
    const told = there === text || await tellBot(target, here, here.session, text);
    const ruled = await repairRules(target, here, here.session);
    if (ruled)
      noteTold(here.folder, { rules: here.folder });
    if (!told || !ruled)
      return no(503, "Its conversation here didn’t take what it is now. It’s tried again as its next run starts.");
    return { status: 200, value: { bot: listBots(machine).find((each) => each.id === id) ?? null } };
  });
}
async function toldThere(target, sessionID) {
  try {
    const entries = await call(target, "GET", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries`);
    if (!Array.isArray(entries))
      return;
    const entry = entries.find((each) => each?.key === "kuvo.bot");
    return typeof entry?.value === "string" ? entry.value : null;
  } catch {
    return;
  }
}
async function freshenBots(target) {
  for (const id of listOf(BOTS)) {
    const here = botHere(id);
    if (!here || isMoving(here.folder))
      continue;
    if (await toldThere(target, here.session) === undefined && !await call(target, "GET", `/api/session/${encodeURIComponent(here.session)}`).then(() => true, () => false))
      continue;
    await freshenBot(target, here.session).catch(() => {});
  }
}
var ASK_FIRST = ["edit", "write", "patch", "shell", "webfetch", "external_directory", "kuvo-browser_browser_save_pdf", "kuvo-browser_browser_upload", "kuvo-browser_watch_for_change"];
var isRule = (rule) => isObject(rule) && typeof rule.action === "string" && typeof rule.resource === "string" && ["allow", "deny", "ask"].includes(rule.effect);
var isParticular = (rule) => rule.action === "external_directory" && rule.effect === "allow" && rule.resource !== "*";
function permissionsHere() {
  if (!ownsSettings())
    return null;
  const { settings } = readSettings();
  if (!settings)
    return null;
  const rules = Array.isArray(settings.permissions) ? settings.permissions : [];
  return rules.every(isRule) ? rules : [];
}
function refreshedRules(current, settings) {
  const asks = current.some((rule) => rule.action === "shell" && rule.effect === "ask");
  const denied = settings.filter((rule) => rule.effect === "deny");
  let made;
  if (asks) {
    const everywhere = settings.findLast((rule) => rule.action === "external_directory" && rule.resource === "*")?.effect === "allow";
    made = [
      ...ASK_FIRST.filter((action) => everywhere || action !== "external_directory").map((action) => ({ action, resource: "*", effect: "ask" })),
      ...settings.filter((rule) => rule.effect !== "deny" && rule.resource !== "*" && rule.action !== "external_directory"),
      ...denied
    ];
  } else {
    made = [...settings.filter((rule) => rule.effect === "ask").map((rule) => ({ action: rule.action, resource: rule.resource, effect: "allow" })), ...denied];
  }
  return [...made, ...current.filter(isParticular)];
}
async function repairRules(target, here, sessionID) {
  const id = here.described.id;
  let rules;
  try {
    rules = (await call(target, "GET", `/api/session/${encodeURIComponent(sessionID)}`))?.permissions;
  } catch {
    return false;
  }
  if (!Array.isArray(rules))
    return false;
  const own = { action: "external_directory", resource: path21.join(here.folder, "*"), effect: "allow" };
  const commands = [`kuvo-wake ${id} `, `"${WAKE_COMMAND}" ${id} `, `"$HOME/.kuvo-code/bin/kuvo-wake" ${id} `];
  const old = (rule) => rule?.action === "shell" && commands.some((command) => String(rule.resource ?? "").startsWith(command)) || rule?.action === "external_directory" && String(rule.resource ?? "").endsWith(`/bots/${id}/*`);
  const kept = rules.filter((rule) => !old(rule));
  const settings = kept.every(isRule) ? permissionsHere() : null;
  const repaired = [...settings ? refreshedRules(kept, settings) : kept, own];
  if (JSON.stringify(repaired) === JSON.stringify(rules))
    return true;
  return call(target, "PATCH", `/api/session/${encodeURIComponent(sessionID)}`, { permissions: repaired }).then(() => true, () => false);
}

// Packages/Box/src/link/engine/conversations.ts
async function everySession(target) {
  const all = [];
  let page = await engineGet(target, "api/session?limit=100&order=desc");
  for (let pages = 0;pages < 1000 && page?.data?.length; pages++) {
    all.push(...page.data);
    const cursor = page.cursor?.next;
    if (page.data.length < 100 || !cursor)
      break;
    page = await engineGet(target, `api/session?limit=100&cursor=${encodeURIComponent(cursor)}`);
  }
  return all;
}
async function conversationOf2(target, id) {
  const route = `api/session/${encodeURIComponent(id)}`;
  let page = await engineGet(target, `${route}/message?limit=200&order=desc`);
  let messages = [...page?.data ?? []].reverse();
  while ((page?.data?.length ?? 0) >= 200 && messages.length < 20000) {
    const cursor = page.cursor?.next ?? page.cursor?.previous;
    if (!cursor)
      break;
    page = await engineGet(target, `${route}/message?limit=200&cursor=${encodeURIComponent(cursor)}`);
    if (!page?.data?.length)
      break;
    messages = [...page.data].reverse().concat(messages);
  }
  return messages;
}

// Packages/Box/src/link/areas/worktrees.ts
import fs23 from "node:fs";
import path22 from "node:path";

// Packages/Box/src/link/git.ts
import { execFile as execFile2, spawnSync } from "node:child_process";
var GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
function gitIn(folder, args) {
  const ran = spawnSync("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60000 });
  return ran.status === 0 ? String(ran.stdout ?? "").trim() : null;
}
function gitLater(folder, args) {
  return new Promise((resolve) => {
    execFile2("git", args, { cwd: folder, encoding: "utf8", env: GIT_ENV, timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout ?? "").trim()));
  });
}
function sizeLater(folder) {
  return new Promise((resolve) => {
    execFile2("du", ["-sk", folder], { encoding: "utf8", timeout: 60000 }, (error, stdout) => {
      const kilobytes = Number(String(stdout ?? "").split(/\s/)[0]);
      resolve(!error && Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined);
    });
  });
}

// Packages/Box/src/link/areas/worktrees.ts
function freeBranch(folder, name) {
  for (let suffix = 1;suffix <= 20; suffix++) {
    const candidate = suffix === 1 ? name : `${name}-${suffix}`;
    if (gitIn(folder, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]) === null)
      return candidate;
  }
  return null;
}
var LATIN = Object.fromEntries([
  ...[..."абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґ"].map((letter, at) => [letter, ["a", "b", "v", "g", "d", "e", "e", "z", "z", "i", "j", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "h", "c", "c", "s", "s", "", "y", "", "e", "u", "a", "i", "i", "e", "g"][at]]),
  ...[..."αβγδεζηθικλμνξοπρσςτυφχψω"].map((letter, at) => [letter, ["a", "b", "g", "d", "e", "z", "e", "th", "i", "k", "l", "m", "n", "x", "o", "p", "r", "s", "s", "t", "y", "ph", "ch", "ps", "o"][at]])
]);
var inLatin = (text) => [...text].map((letter) => LATIN[letter] ?? letter).join("");
function branchSlug(title, limit = 40) {
  const latin = inLatin(inLatin(String(title).toLowerCase()).normalize("NFKD")).replace(/\p{M}/gu, "").replace(/ı/g, "i");
  let name = "";
  for (const word of latin.split(/[^\p{L}\p{N}]+/u)) {
    const ascii = [...word].filter((character) => character.charCodeAt(0) < 128).join("");
    if (!ascii)
      continue;
    const next = name ? `${name}-${ascii}` : ascii;
    if (next.length > limit)
      break;
    name = next;
  }
  return name;
}
async function projectOf(engine, folder, signal) {
  const located = await call(engine, "GET", "/api/location", undefined, signal, folder);
  const id = located?.project?.id;
  if (typeof id !== "string")
    throw new Error("The engine didn't say which project that is.");
  return id;
}
async function sessionsHere(engine, signal) {
  if (!engine?.port)
    return { sessions: [], active: new Set };
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` };
  try {
    const listed = await fetch(`http://127.0.0.1:${engine.port}/api/session?parentID=null&limit=200&order=desc`, { headers, signal: AbortSignal.timeout(1e4) });
    const sessions = listed.ok ? (await listed.json())?.data ?? [] : [];
    const busy = await fetch(`http://127.0.0.1:${engine.port}/api/session/active`, { headers, signal: AbortSignal.timeout(1e4) });
    const active = new Set(Object.keys(busy.ok ? (await busy.json())?.data ?? {} : {}));
    return { sessions, active };
  } catch {
    return { sessions: [], active: new Set };
  }
}
var inside = (folder, root) => folder === root || folder?.startsWith(root + "/");
function renameWorktree(tree, to) {
  if (gitIn(tree.root, ["rev-parse", "--abbrev-ref", `${tree.branch}@{upstream}`]) !== null)
    return false;
  const name = freeBranch(tree.root, to);
  if (!name || gitIn(tree.root, ["branch", "-m", tree.branch, name]) === null) {
    const now = gitIn(tree.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (now && now !== tree.branch)
      updateWorktrees((list) => list.map((each) => each.root === tree.root ? { ...each, branch: now } : each));
    return false;
  }
  updateWorktrees((list) => list.map((each) => each.root === tree.root ? { ...each, branch: name } : each));
  return true;
}
async function nameWorktreeBranch(engine, sessionID) {
  if (typeof sessionID !== "string")
    return;
  const session = (await engineGet(engine, `api/session/${encodeURIComponent(sessionID)}`))?.data;
  if (!session || session.parentID || isHiddenRun(session))
    return;
  const folder = session.location?.directory ?? session.directory;
  const tree = readWorktrees().find((each) => (each.folder ?? each.root) === folder);
  const slug = branchSlug(session.title ?? "");
  if (!tree?.made || tree.branch !== tree.made || !slug)
    return;
  if (renameWorktree(tree, (tree.prefix ?? "") + slug))
    await tellWorktree(engine, sessionID);
}
async function nameDueWorktrees(engine, signal) {
  const due = readWorktrees().filter((tree) => tree.made && tree.branch === tree.made);
  if (!due.length || !engine?.port)
    return;
  const { sessions } = await sessionsHere(engine, signal);
  for (const tree of due) {
    const titled = sessions.find((session) => (session.location?.directory ?? session.directory) === (tree.folder ?? tree.root) && !isHiddenRun(session) && branchSlug(session.title ?? ""));
    if (titled)
      await nameWorktreeBranch(engine, titled.id).catch(() => {});
  }
}
async function tellWorktree(target, sessionID) {
  if (typeof sessionID !== "string")
    return;
  const session = (await engineGet(target, `api/session/${encodeURIComponent(sessionID)}`))?.data;
  const folder = session?.location?.directory ?? session?.directory;
  const tree = readWorktrees().find((each) => (each.folder ?? each.root) === folder);
  if (!tree)
    return;
  const told = `You work in a git worktree of this project, on the branch ${tree.branch}, so your changes stay apart from the user's own checkout at ${tree.project} until they merge them. Make your changes here, not there.`;
  await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/kuvo.worktree`, { value: told });
}
async function answerWorktrees(method, requestPath, body, engine, signal) {
  const route = requestPath.split("?")[0];
  const message = (text) => ({ message: text });
  const list = readWorktrees();
  if (route === "kuvo/worktrees" && method === "GET") {
    if (/(^|[?&])records=1(&|$)/.test(requestPath.split("?")[1] ?? "")) {
      await nameDueWorktrees(engine, signal);
      return { status: 200, value: { worktrees: readWorktrees() } };
    }
    const { sessions, active } = await sessionsHere(engine, signal);
    const worktrees = [];
    for (const tree of list) {
      const here = sessions.filter((session) => inside(session.location?.directory ?? session.directory, tree.root));
      const entry = { path: tree.root, folder: tree.folder ?? tree.root, project: tree.project, projectName: path22.basename(tree.project), branch: tree.branch, sessions: here.length, working: here.some((session) => active.has(session.id)) };
      if (tree.base)
        entry.base = tree.base;
      if (fs23.existsSync(tree.root)) {
        const status = await gitLater(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]);
        if (status !== null) {
          entry.uncommitted = status.length > 0;
          const ahead = tree.base ? await gitLater(tree.root, ["rev-list", "--count", `${tree.base}..HEAD`]) : null;
          if (ahead !== null && /^\d+$/.test(ahead))
            entry.ahead = Number(ahead);
        }
        const size = await sizeLater(tree.root);
        if (size !== undefined)
          entry.size = size;
      }
      worktrees.push(entry);
    }
    return { status: 200, value: { worktrees } };
  }
  if (method !== "POST")
    return { status: route.startsWith("kuvo/worktrees") ? 405 : 404, value: {} };
  if (route === "kuvo/worktrees") {
    const project = body?.project;
    if (typeof project !== "string" || !path22.isAbsolute(project) || !fs23.existsSync(project))
      return { status: 400, value: message(`Send the project's folder on this machine as {"project"}.`) };
    if (!engine?.port)
      return { status: 503, value: message("The engine isn't running.") };
    const kept = branchPrefix();
    const prefix = typeof body?.branchPrefix === "string" ? body.branchPrefix : kept;
    const subpath = gitIn(project, ["rev-parse", "--show-prefix"]);
    if (subpath === null)
      return { status: 409, value: message("That folder isn't in a git repository.") };
    const base = gitIn(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let id, root;
    try {
      id = await projectOf(engine, project, signal);
      root = (await call(engine, "POST", "/api/worktree", { projectID: id }, signal, project))?.directory;
    } catch (error) {
      return { status: 502, value: message(error?.message ?? String(error)) };
    }
    if (typeof root !== "string")
      return { status: 502, value: message("The engine didn't make it.") };
    const branch = freeBranch(root, prefix + path22.basename(root));
    if (!branch || gitIn(root, ["switch", "--quiet", "-c", branch]) === null && gitIn(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) !== branch) {
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: root, force: true }, signal, project).catch(() => {});
      return { status: 502, value: message("Its branch couldn't be made.") };
    }
    if (prefix !== kept)
      writePrivate(BRANCH_PREFIX_FILE, JSON.stringify({ branchPrefix: prefix }));
    const tree = { project, root, folder: subpath ? path22.join(root, subpath.replace(/\/$/, "")) : root, branch, ...base ? { base } : {}, made: branch, prefix };
    updateWorktrees((list) => [...list.filter((each) => each.root !== root), tree]);
    return { status: 200, value: tree };
  }
  if (route === "kuvo/worktrees/record") {
    const given = { project: body?.project, root: body?.root, folder: typeof body?.folder === "string" ? body.folder : body?.root, branch: body?.branch, ...typeof body?.base === "string" ? { base: body.base } : {} };
    const absolute = (folder) => typeof folder === "string" && path22.isAbsolute(folder);
    if (!absolute(given.project) || !absolute(given.root) || !absolute(given.folder) || typeof given.branch !== "string" || !given.branch)
      return { status: 400, value: message("Send {project, root, folder?, branch, base?}.") };
    if (!fs23.existsSync(given.root))
      return { status: 404, value: message("That worktree isn't on this machine any more.") };
    updateWorktrees((list) => list.some((each) => each.root === given.root) ? list : [...list, given]);
    return { status: 200, value: {} };
  }
  const tree = list.find((each) => each.root === body?.path);
  if (!tree)
    return { status: 404, value: message("That worktree isn't on this machine any more.") };
  if (route === "kuvo/worktrees/remove") {
    const { sessions, active } = await sessionsHere(engine, signal);
    if (sessions.some((session) => inside(session.location?.directory ?? session.directory, tree.root) && active.has(session.id))) {
      return { status: 409, value: message(`An agent is still working in the worktree of ${tree.branch}, so it stays. Stop it first, then remove the worktree.`) };
    }
    if (body?.forget === true && sessions.some((session) => inside(session.location?.directory ?? session.directory, tree.root))) {
      return { status: 409, value: message(`A session works in the worktree of ${tree.branch}, so it stays. Remove it with the session, or in Settings › Worktrees.`) };
    }
    const discard = body?.discard !== false;
    if (!discard && fs23.existsSync(tree.root) && gitIn(tree.root, ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"]) !== "") {
      return { status: 409, value: message(`The worktree of ${tree.branch} has changes that aren’t committed, so it stays. Commit them, or remove it in Settings › Worktrees, which throws them away.`) };
    }
    if (!engine?.port)
      return { status: 503, value: message("The engine isn't running.") };
    try {
      const id = await projectOf(engine, tree.project, signal);
      await call(engine, "DELETE", "/api/worktree", { projectID: id, directory: tree.root, force: discard }, signal, tree.project);
    } catch (error) {
      return { status: 502, value: message(error?.message ?? String(error)) };
    }
    gitIn(tree.project, ["branch", body?.forget === true ? "-D" : "-d", tree.branch]);
    updateWorktrees((list) => list.filter((each) => each.root !== tree.root), tree);
    return { status: 200, value: {} };
  }
  return { status: 404, value: {} };
}
async function worktreesWhere(directory, engine, signal, projects = readProjects().filter((each) => !each.removed).map((each) => each.directory)) {
  const value = typeof directory === "string" && directory !== "" ? directory : null;
  const answer = { directory: value, default: path22.join(ENGINE_DATA, "worktree"), home: homeFolder(), projects: [] };
  const ids = new Map;
  if (engine?.port) {
    try {
      for (const known of await call(engine, "GET", "/api/project", undefined, signal)) {
        if (typeof known?.id === "string" && typeof known?.canonical === "string")
          ids.set(realOr(known.canonical), known.vcs === "git" && known.id !== "global" ? known.id : null);
      }
    } catch {}
  }
  for (const project of projects) {
    if (!fs23.existsSync(project))
      continue;
    const common = await gitLater(project, ["rev-parse", "--git-common-dir"]);
    if (!common)
      continue;
    const gitFolder = path22.resolve(project, common);
    if (path22.basename(gitFolder) !== ".git")
      continue;
    const checkout = realOr(path22.dirname(gitFolder));
    const id = ids.get(checkout);
    if (id === null || id === undefined && !await gitLater(project, ["rev-list", "-n", "1", "--all"]))
      continue;
    const folder = value === null ? id ? path22.join(answer.default, id.slice(0, 6)) : null : value.startsWith("~/") ? path22.join(answer.home, value.slice(2)) : path22.resolve(checkout, value);
    const entry = { project, name: path22.basename(project), folder };
    if (folder) {
      entry.exists = (() => {
        try {
          return fs23.statSync(folder).isDirectory();
        } catch {
          return false;
        }
      })();
      if (!entry.exists)
        entry.canMake = canMake(folder);
      if (inside(folder, checkout)) {
        entry.inside = true;
        entry.ignored = await gitLater(checkout, ["check-ignore", "-q", path22.join(folder, "worktree")]) !== null;
      }
    }
    answer.projects.push(entry);
  }
  apart(answer.projects, answer.home);
  return answer;
}
function apart(projects, home) {
  const parents = (project) => {
    const folder = path22.dirname(project);
    const inHome = folder === home || folder.startsWith(home + path22.sep);
    const names = (inHome ? folder.slice(home.length) : folder).split(path22.sep).filter(Boolean);
    return (inHome ? ["~", ...names] : names).reverse();
  };
  for (const name of new Set(projects.map((each) => each.name))) {
    const same = projects.filter((each) => each.name === name);
    if (same.length < 2)
      continue;
    const longest = Math.max(...same.map((each) => parents(each.project).length));
    for (let depth = 1;depth <= longest; depth++) {
      const labels = same.map((each) => parents(each.project).slice(0, depth).reverse().join("/"));
      if (new Set(labels).size === same.length || depth === longest) {
        same.forEach((each, at) => {
          if (labels[at])
            each.name = `${name} — ${labels[at]}`;
        });
        break;
      }
    }
  }
}
function realOr(folder) {
  try {
    return fs23.realpathSync(folder);
  } catch {
    return folder;
  }
}
function canMake(folder) {
  for (let at = path22.dirname(folder);; at = path22.dirname(at)) {
    try {
      if (!fs23.statSync(at).isDirectory())
        return false;
      fs23.accessSync(at, fs23.constants.W_OK);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT" || at === path22.dirname(at))
        return false;
    }
  }
}
async function* worktreeEventsRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ worktrees: readWorktrees() }), worktreeFollowers, signal);
}
async function* worktreesRoute(context) {
  const { request, signal, route, readEngine, json } = context;
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  if (route === "kuvo/worktrees/where") {
    if (request.method.toUpperCase() !== "GET")
      return yield* json(405, {});
    return yield* json(200, await worktreesWhere(new URLSearchParams(request.path.split("?")[1] ?? "").get("directory"), engine, signal));
  }
  const { status, value } = await answerWorktrees(request.method.toUpperCase(), request.path, parsed(request.body), engine, signal);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/carry.ts
var carrying = new Set;
var promptFiles = (payload) => (Array.isArray(payload?.files) ? payload.files : []).map((file) => {
  const name = typeof file?.name === "string" ? { name: file.name } : {};
  const uri = file?.source?.uri ?? file?.uri;
  if (typeof uri === "string")
    return { uri, ...name };
  return typeof file?.data === "string" ? { uri: `data:${file.mime ?? "application/octet-stream"};base64,${file.data}`, ...name } : null;
}).filter(Boolean);
async function carryToAgents(id, model, readEngine, agents, signal) {
  const no = (status, message) => ({ status, value: { message } });
  if (!isModel(model) || !runsWithAgents(model))
    return no(400, "That isn’t a coding agent’s model.");
  let engine;
  try {
    engine = readEngine();
  } catch {}
  if (!engine)
    return no(503, "The engine isn’t running.");
  if (!agents)
    return no(503, `The coding agents aren’t running on ${HERE}.`);
  const route = `api/session/${encodeURIComponent(id)}`;
  let session;
  try {
    session = (await engineGet(engine, route))?.data;
  } catch {}
  if (!session) {
    const theirs = await engineGet(agents, route).catch(() => null);
    return theirs?.data ? no(409, "It’s with the coding agents already.") : no(404, "That conversation isn’t there any more.");
  }
  if (session.metadata?.kuvoAgent || session.metadata?.["kuvo.carriedTo"])
    return no(409, "It’s with the coding agents already.");
  const bot = listOf(BOTS).map(botHere).find((here) => here?.session === id) ?? null;
  if (isMoving(bot?.folder ?? path23.join(SESSION_WAKES, id)))
    return no(409, MOVING);
  if (model.providerID !== "auto") {
    const integration = (await engineGet(agents, `api/integration/${encodeURIComponent(model.providerID)}`).catch(() => null))?.data;
    const name = integration?.name ?? model.providerID;
    if (integration?.metadata?.installed === false)
      return no(422, `${name} isn’t installed on ${HERE}: install it in Settings › Accounts, or choose another model.`);
    if (!integration?.connections?.length)
      return no(422, `${name} needs a sign-in on ${HERE}: sign in in Settings › Accounts, or choose another model.`);
  }
  if (carrying.has(id))
    return no(409, "It’s being carried on with the coding agents already.");
  carrying.add(id);
  try {
    const directory = session.location?.directory ?? session.directory;
    let messages = [], waiting = [];
    for (let round = 0;round < 3; round++) {
      const active = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (id in active) {
        await call(engine, "POST", `/${route}/interrupt`).catch(() => {});
        await call(engine, "POST", `/api/experimental/session/${encodeURIComponent(id)}/wait`).catch(() => {});
      }
      messages = await conversationOf2(engine, id);
      const cut = session.revert?.messageID ? messages.findIndex((message) => message.id === session.revert.messageID) : -1;
      if (cut >= 0)
        messages = messages.slice(0, cut);
      waiting = ((await engineGet(engine, `${route}/inbox`).catch(() => null))?.data ?? []).filter((item) => item?.type === "user" && typeof item.text === "string");
      const still = (await engineGet(engine, "api/session/active").catch(() => null))?.data ?? {};
      if (!(id in still))
        break;
    }
    const moved = await call(agents, "POST", "/api/session/import", {
      title: session.title,
      agent: session.agent,
      model,
      location: { directory },
      permissions: session.permissions,
      messages,
      waiting: waiting.map((item) => ({ id: messageID(), text: item.text, files: promptFiles(item.payload) }))
    });
    if (typeof moved?.id !== "string")
      return no(502, "The coding agents didn’t take it.");
    for (const item of waiting)
      await call(engine, "DELETE", `/${route}/inbox/${encodeURIComponent(item.id)}`).catch(() => {});
    const entries = `/api/experimental/session/${encodeURIComponent(moved.id)}/instructions/entries`;
    await tellWorktree(agents, moved.id).catch(() => {});
    if (bot) {
      await call(agents, "PATCH", `/api/session/${encodeURIComponent(moved.id)}`, { metadata: { kuvo: session.metadata?.kuvo ?? { bot: bot.described.id } } }).catch(() => {});
      const kit = readKit();
      if (kit)
        await tellBot(agents, bot, moved.id, toldNow(kit, bot));
      fs24.writeFileSync(path23.join(bot.folder, "session"), moved.id);
      fs24.writeFileSync(path23.join(bot.folder, "via"), "bridge");
      await call(engine, "DELETE", `/${route}`).catch(() => {});
    } else {
      const from = path23.join(SESSION_WAKES, id), to = path23.join(SESSION_WAKES, moved.id);
      if (fs24.existsSync(path23.join(from, "session")) && !fs24.existsSync(to)) {
        try {
          fs24.renameSync(from, to);
          fs24.writeFileSync(path23.join(to, "session"), moved.id);
          fs24.writeFileSync(path23.join(to, "directory"), directory ?? "");
          fs24.writeFileSync(path23.join(to, "via"), "bridge");
        } catch {}
      }
      await call(engine, "PATCH", `/${route}`, { metadata: { ...session.metadata ?? {}, "kuvo.archived": true, "kuvo.carriedTo": moved.id } }).catch(() => {});
      try {
        holdArchived(id, true);
      } catch {}
    }
    return { status: 200, value: { session: moved.id } };
  } catch (error) {
    return no(502, error?.message ?? String(error));
  } finally {
    carrying.delete(id);
  }
}
async function* carryRoute(context, toAgents) {
  const { request, signal, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  let id;
  try {
    id = decodeURIComponent(toAgents[1]);
  } catch {
    return yield* json(404, { message: "That conversation isn’t there any more." });
  }
  const { status, value } = await carryToAgents(id, parsed(request.body)?.model, readEngine, bridge(), signal);
  return yield* json(status, value);
}

// Packages/Box/src/link/server/naming.ts
import fs29 from "node:fs";

// Packages/Box/src/link/peers/agents.ts
import fs28 from "node:fs";
import path28 from "node:path";

// Packages/Box/src/shared/features.ts
var FEATURES = [
  "accounts.credentials",
  "accounts.ended",
  "accounts.found",
  "agents",
  "artifacts",
  "asks",
  "attention",
  "bots",
  "bots.edit",
  "bots.keys",
  "bots.make",
  "branch",
  "btw",
  "btw.threads",
  "config",
  "config.apply",
  "engine.restart",
  "engine.start",
  "file",
  "folders",
  "git",
  "goals",
  "groups",
  "groups.delete",
  "groups.edit",
  "groups.joinable",
  "groups.make",
  "groups.seats",
  "handoff",
  "integrations",
  "keys",
  "mcp.catalog",
  "named",
  "personalities",
  "plugins.search",
  "programs",
  "providers.models",
  "personalities.events",
  "phones",
  "phones.pair",
  "projects",
  "reviews",
  "reviews.scopes",
  "search",
  "sessions.agents",
  "shell.stop",
  "sign-in.return",
  "skills",
  "skills.trash",
  "update",
  "wakes",
  "wakes.edit",
  "wakes.events",
  "worktrees",
  "worktrees.events",
  "worktrees.where",
  "bots.events",
  "bots.job",
  "vault"
];

// Packages/Box/src/link/documents/work.ts
import crypto11 from "node:crypto";

// Packages/Box/src/link/crypto/keys.ts
import crypto7 from "node:crypto";
var PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
var SPKI = Buffer.from("302a300506032b656e032100", "hex");
var EMPTY = Buffer.alloc(0);
var privateKey = (raw) => crypto7.createPrivateKey({ key: Buffer.concat([PKCS8, raw]), format: "der", type: "pkcs8" });
var publicKey = (raw) => crypto7.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
var newKey = () => crypto7.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8.length);
var publicOf = (raw) => crypto7.createPublicKey(privateKey(raw)).export({ format: "der", type: "spki" }).subarray(SPKI.length);
var dh = (raw, remote) => crypto7.diffieHellman({ privateKey: privateKey(raw), publicKey: publicKey(remote) });
var addressOf = (secret) => crypto7.createHash("sha256").update("kuvo-link address v1").update(secret).digest().subarray(0, 16);

// Packages/Box/src/link/crypto/noise.ts
import crypto8 from "node:crypto";
var sha256 = (data) => crypto8.createHash("sha256").update(data).digest();
var hmac = (key, data) => crypto8.createHmac("sha256", key).update(data).digest();
function hkdf(chainingKey, input) {
  const temp = hmac(chainingKey, input);
  const first = hmac(temp, Buffer.from([1]));
  return [first, hmac(temp, Buffer.concat([first, Buffer.from([2])]))];
}

class CipherState {
  constructor(key) {
    this.key = key;
    this.n = 0n;
  }
  nonce() {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(this.n, 4);
    return nonce;
  }
  encrypt(ad, plaintext) {
    if (!this.key)
      return plaintext;
    const cipher = crypto8.createCipheriv("aes-256-gcm", this.key, this.nonce());
    cipher.setAAD(ad);
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    this.n += 1n;
    return sealed;
  }
  decrypt(ad, ciphertext) {
    if (!this.key)
      return ciphertext;
    if (ciphertext.length < 16)
      throw new Error("decrypt");
    const decipher = crypto8.createDecipheriv("aes-256-gcm", this.key, this.nonce());
    decipher.setAAD(ad);
    decipher.setAuthTag(ciphertext.subarray(-16));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
    } catch {
      throw new Error("decrypt");
    }
    this.n += 1n;
    return plaintext;
  }
}

class SymmetricState {
  constructor(name, prologue) {
    const bytes = Buffer.from(name);
    this.h = bytes.length <= 32 ? Buffer.concat([bytes, Buffer.alloc(32 - bytes.length)]) : sha256(bytes);
    this.ck = this.h;
    this.cipher = new CipherState;
    this.mixHash(prologue);
  }
  mixKey(input) {
    const [chainingKey, key] = hkdf(this.ck, input);
    this.ck = chainingKey;
    this.cipher = new CipherState(key);
  }
  mixHash(data) {
    this.h = sha256(Buffer.concat([this.h, data]));
  }
  encryptAndHash(plaintext) {
    const ciphertext = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }
  decryptAndHash(ciphertext) {
    const plaintext = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }
  split() {
    const [first, second] = hkdf(this.ck, EMPTY);
    return [new CipherState(first), new CipherState(second)];
  }
}
var IK = "Noise_IK_25519_AESGCM_SHA256";
var ONE_WAY = "Noise_K_25519_AESGCM_SHA256";
var PROLOGUE = Buffer.from("kuvo-link v1");
var MAIL_PROLOGUE = Buffer.from("kuvo-link mail v1");
var transport = (sending, receiving, hash) => ({
  hash,
  seal: (plaintext) => sending.encrypt(EMPTY, plaintext),
  open: (ciphertext) => receiving.decrypt(EMPTY, ciphertext)
});

class IKInitiator {
  constructor(s, rs, prologue, e = newKey()) {
    Object.assign(this, { s, rs, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(rs);
  }
  writeMessage1(payload) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.rs));
    const s = state.encryptAndHash(publicOf(this.s));
    state.mixKey(dh(this.s, this.rs));
    return Buffer.concat([ephemeral, s, state.encryptAndHash(payload)]);
  }
  readMessage2(message) {
    if (message.length < 48)
      throw new Error("malformed");
    const state = this.state;
    const re = message.subarray(0, 32);
    state.mixHash(re);
    state.mixKey(dh(this.e, re));
    state.mixKey(dh(this.s, re));
    const payload = state.decryptAndHash(message.subarray(32));
    const [first, second] = state.split();
    return { payload, transport: transport(first, second, state.h) };
  }
}

class IKResponder {
  constructor(s, prologue, e = newKey()) {
    Object.assign(this, { s, e, state: new SymmetricState(IK, prologue) });
    this.state.mixHash(publicOf(s));
  }
  readMessage1(message) {
    if (message.length < 96)
      throw new Error("malformed");
    const state = this.state;
    this.re = message.subarray(0, 32);
    state.mixHash(this.re);
    state.mixKey(dh(this.s, this.re));
    this.rs = state.decryptAndHash(message.subarray(32, 80));
    state.mixKey(dh(this.s, this.rs));
    return state.decryptAndHash(message.subarray(80));
  }
  writeMessage2(payload) {
    const state = this.state;
    const ephemeral = publicOf(this.e);
    state.mixHash(ephemeral);
    state.mixKey(dh(this.e, this.re));
    state.mixKey(dh(this.e, this.rs));
    const message = Buffer.concat([ephemeral, state.encryptAndHash(payload)]);
    const [first, second] = state.split();
    return { message, transport: transport(second, first, state.h) };
  }
}
function sealOneWay(payload, s, rs, prologue = MAIL_PROLOGUE, e = newKey()) {
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(publicOf(s));
  state.mixHash(rs);
  const ephemeral = publicOf(e);
  state.mixHash(ephemeral);
  state.mixKey(dh(e, rs));
  state.mixKey(dh(s, rs));
  return { message: Buffer.concat([ephemeral, state.encryptAndHash(payload)]), following: state.split()[0] };
}
function openOneWay(message, s, rs, prologue = MAIL_PROLOGUE) {
  if (message.length < 48)
    throw new Error("malformed");
  const state = new SymmetricState(ONE_WAY, prologue);
  state.mixHash(rs);
  state.mixHash(publicOf(s));
  const re = message.subarray(0, 32);
  state.mixHash(re);
  state.mixKey(dh(s, re));
  state.mixKey(dh(s, rs));
  return { payload: state.decryptAndHash(message.subarray(32)), following: state.split()[0] };
}

// Packages/Box/src/link/relay/frames.ts
var Frame = { handshake1: 1, handshake2: 2, transport: 3, close: 4, mail: 5 };
var MAX_MESSAGE = 65535 - 16;
var relayHello = (secret) => Buffer.concat([Buffer.from([1]), secret]);
var relaySend = (to, payload) => Buffer.concat([Buffer.from([2]), to, payload]);
var relayPush = (to, payload) => Buffer.concat([Buffer.from([5]), to, payload]);
function readRelay(bytes) {
  const kind = bytes[0];
  const address = bytes.subarray(1, 17);
  if (kind === 1 && bytes.length === 17)
    return { kind: "welcome", address };
  if (kind === 2 && bytes.length >= 17)
    return { kind: "deliver", address, payload: bytes.subarray(17) };
  if (kind === 3 && bytes.length === 17)
    return { kind: "unreachable", address };
  if (kind === 6 && bytes.length === 18)
    return { kind: "pushed", address, status: bytes[17] };
  if (kind === 7 && bytes.length === 18)
    return { kind: "gone", address, reason: bytes[17] === 0 ? "replaced" : "left" };
  return null;
}
function frame(kind, session, body = EMPTY) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(session, 1);
  return Buffer.concat([header, body]);
}
function readFrame(bytes) {
  if (bytes.length < 5 || bytes[0] < 1 || bytes[0] > 5)
    return null;
  return { kind: bytes[0], session: bytes.readUInt32BE(1), body: bytes.subarray(5) };
}
function encodeMessage(head, body = EMPTY) {
  const json = Buffer.from(sortedJSON(head));
  const length = Buffer.alloc(2);
  length.writeUInt16BE(json.length);
  return Buffer.concat([length, json, body]);
}
function decodeMessage(bytes) {
  if (bytes.length < 2)
    return null;
  const length = bytes.readUInt16BE(0);
  if (bytes.length < 2 + length)
    return null;
  try {
    return { head: JSON.parse(bytes.subarray(2, 2 + length).toString("utf8")), body: bytes.subarray(2 + length) };
  } catch {
    return null;
  }
}
function pieces(head, body, end) {
  if (Buffer.byteLength(sortedJSON(head)) > 60000)
    throw new Error("head too long");
  const out = [];
  let current = { ...head, end: false };
  let offset = 0;
  do {
    const room = MAX_MESSAGE - 2 - Buffer.byteLength(sortedJSON(current)) - 8;
    out.push([current, body.subarray(offset, offset + room)]);
    offset += room;
    current = { t: "data", id: head.id, end: false };
  } while (offset < body.length);
  out[out.length - 1][0].end = end;
  return out.map(([h, b]) => encodeMessage(h, b));
}

// Packages/Box/src/link/peers/known.ts
var KEY = /^[A-Za-z0-9_-]{43}$/;
var ADDRESS = /^[A-Za-z0-9_-]{22}$/;
var macsOf = (link) => [...new Set([...Array.isArray(link?.macs) ? link.macs : [], ...typeof link?.mac === "string" ? [link.mac] : []])];
var MAC_GONE_AFTER = 30 * 24 * 3600 * 1000;
function forgetOldMacs(link, keep, now = Date.now()) {
  link.macSeen ??= {};
  for (const mac of macsOf(link))
    link.macSeen[mac] ??= now;
  if (keep)
    link.macSeen[keep] = now;
  const gone = macsOf(link).filter((mac) => mac !== keep && now - link.macSeen[mac] > MAC_GONE_AFTER);
  if (!gone.length)
    return;
  for (const mac of gone)
    leaveMac(link, mac);
  if (gone.includes(link.mac))
    link.mac = keep;
}
function macDoc(link, mac, kind) {
  const sign = macSign(link, mac);
  return sign ? held(link.docs?.[docKey(sign, kind)]) : null;
}
function leaveMac(link, mac) {
  link.macs = macsOf(link).filter((each) => each !== mac);
  if (link.mac === mac) {
    if (link.macs.length)
      link.mac = link.macs[0];
    else
      delete link.mac;
  }
  for (const field of ["macSeen", "macSigns", "legacy"])
    if (link[field])
      delete link[field][mac];
  link.phones = (link.phones ?? []).filter((phone) => !(phone.from === "mac" && phone.mac === mac));
}
var MOST_PEERS = 64;
var fitsPeer = (peer) => isObject(peer) && typeof peer.key === "string" && KEY.test(peer.key) && typeof peer.address === "string" && ADDRESS.test(peer.address) && (peer.kind === "mac" || peer.kind === "machine");
var cleanPeer = ({ key, address, name, kind, id, sign }) => ({ key, address, kind, name: plainName(name).slice(0, 100), ...typeof id === "string" ? { id: id.slice(0, 200) } : {}, ...typeof sign === "string" && SIGN.test(sign) ? { sign } : {} });
var cleanMoved = (moved) => (Array.isArray(moved) ? moved : []).filter((each) => isObject(each) && typeof each.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(each.session) && typeof each.key === "string" && KEY.test(each.key)).slice(0, 500).map(({ session, key }) => ({ session, key }));
function takeLegacyPeers(link, mac, peers, at, moved = []) {
  if (macSign(link, mac) || !Array.isArray(peers) || typeof at !== "number")
    return false;
  link.legacy ??= {};
  if (at <= (link.legacy[mac]?.at ?? 0))
    return false;
  link.legacy[mac] = { at, peers: peers.filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer), moved: cleanMoved(moved) };
  return true;
}
function macWords(link) {
  return macsOf(link).map((mac) => {
    const doc = macDoc(link, mac, "peers");
    if (doc)
      return { boxes: Array.isArray(doc.body.boxes) ? doc.body.boxes.slice(0, MOST_PEERS) : [], moved: doc.body.moved };
    return link?.legacy?.[mac] ? { boxes: link.legacy[mac].peers ?? [], moved: link.legacy[mac].moved } : null;
  }).filter(Boolean);
}
function movedOf(link) {
  const moved = new Map;
  if (IS_MAC) {
    for (const { session, key } of cleanMoved(link?.macMoved))
      moved.set(session, key);
    return moved;
  }
  for (const word of macWords(link))
    for (const { session, key } of cleanMoved(word.moved))
      moved.set(session, key);
  return moved;
}
function peersOf(link) {
  if (!link)
    return [];
  if (IS_MAC)
    return (Array.isArray(link.macPeers) ? link.macPeers : []).filter(fitsPeer).slice(0, MOST_PEERS).map(cleanPeer);
  const own = ownKey(link);
  const byKey = new Map;
  for (const word of macWords(link)) {
    for (const peer of word.boxes)
      if (fitsPeer(peer) && peer.key !== own && !byKey.has(peer.key))
        byKey.set(peer.key, cleanPeer(peer));
  }
  return [...byKey.values()];
}
function ownKey(link) {
  try {
    return publicOf(Buffer.from(link.key, "base64url")).toString("base64url");
  } catch {
    return null;
  }
}
function openMail(body, link) {
  if (!link?.key)
    return null;
  const key = Buffer.from(link.key, "base64url");
  const senders = [...macsOf(link).map((mac) => ({ key: mac, kind: "mac" })), ...peersOf(link).filter((peer) => !macsOf(link).includes(peer.key))];
  for (const sender of senders) {
    try {
      const payload = JSON.parse(openOneWay(body, key, Buffer.from(sender.key, "base64url")).payload.toString("utf8"));
      return isObject(payload) ? { sender: peersOf(link).find((peer) => peer.key === sender.key) ?? sender, payload } : null;
    } catch {}
  }
  return null;
}
function mailFor(peer, payload, link) {
  if (!peer.address)
    return null;
  const sealed = frame(Frame.mail, 0, sealOneWay(Buffer.from(JSON.stringify(payload)), Buffer.from(link.key, "base64url"), Buffer.from(peer.key, "base64url")).message);
  if (sealed.length > MAX_MAIL)
    return null;
  return relaySend(Buffer.from(peer.address, "base64url"), sealed);
}
var MAX_MAIL = 65600 - 17;

// Packages/Box/src/link/phones.ts
import crypto9 from "node:crypto";

// Packages/Box/src/link/documents/changed.ts
import fs25 from "node:fs";
import path24 from "node:path";
var DOCS_CHANGED = path24.join(RUN, "docs.changed");
var changedHere = () => {};
var onDocsChanged = (then) => {
  changedHere = then;
};
function noteDocsChanged() {
  if (IS_MAC)
    return changedHere();
  try {
    fs25.mkdirSync(RUN, { recursive: true, mode: 448 });
    fs25.writeFileSync(DOCS_CHANGED, "", { mode: 384 });
  } catch {}
}
function docsNoted() {
  try {
    fs25.rmSync(DOCS_CHANGED);
    return true;
  } catch {
    return false;
  }
}

// Packages/Box/src/link/phones.ts
function authorizePhone(key, hello, address) {
  const encoded = key.toString("base64url");
  if (!hello?.pair)
    return Boolean(readLink()?.phones?.some((phone) => phone.key === encoded));
  let paired = false;
  updateLink((link) => {
    const given = Buffer.from(String(hello.pair), "base64url");
    const slot = ["pairing", "appPairing"].find((name) => {
      const pairing = link?.[name];
      if (!pairing || Date.now() > pairing.expires)
        return false;
      const expected = Buffer.from(pairing.token, "base64url");
      return given.length === expected.length && crypto9.timingSafeEqual(given, expected);
    });
    if (!slot)
      return null;
    pairPhone(link, { key: encoded, name: String(hello.name ?? "").slice(0, 100), added: Math.floor(Date.now() / 1000), from: "pair", address: address?.toString("base64url"), pairing: newPairing() });
    delete link[slot];
    paired = true;
    return link;
  });
  if (paired)
    noteDocsChanged();
  return paired || Boolean(readLink()?.phones?.some((phone) => phone.key === encoded));
}
var PAIRING = /^[A-Za-z0-9_-]{0,32}$/;
var MOST_AT_ONCE = 16;
var MOST_KEPT = 256;
var removedAlready = (link, key, pairing) => (link.removed ?? []).some((r) => r.key === key && r.pairing === pairing);
function noteRemoved(link, key, pairing) {
  link.removed ??= [];
  if (!removedAlready(link, key, pairing))
    link.removed = [...link.removed, { key, pairing }].slice(-MOST_KEPT);
}
var fits = (entry, macs) => typeof entry?.key === "string" && KEY.test(entry.key) && !macs.includes(entry.key) && (entry.pairing == null || typeof entry.pairing === "string" && PAIRING.test(entry.pairing));
function takeOff(link, key, pairing) {
  const current = (link.phones ?? []).find((phone) => phone.key === key);
  const which = pairing == null ? current?.pairing ?? "" : String(pairing);
  noteRemoved(link, key, which);
  if (current && (current.pairing ?? "") === which)
    link.phones = link.phones.filter((phone) => phone.key !== key);
}
var newPairing = () => crypto9.randomBytes(12).toString("base64url");
function pairPhone(link, phone) {
  link.phones = [...(link.phones ?? []).filter((each) => each.key !== phone.key), phone];
}
function removeAsMac(link, entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MOST_KEPT || !entries.every((entry) => fits(entry, [])))
    return false;
  for (const entry of entries)
    takeOff(link, entry.key, entry.pairing);
  return true;
}
function removePhones(link, by, entries) {
  const macs = macsOf(link);
  const allowed = new Set([...(link.phones ?? []).map((phone) => phone.key), ...macs]);
  if (!allowed.has(by) || !Array.isArray(entries) || !entries.length || entries.length > MOST_AT_ONCE)
    return false;
  if (!entries.every((entry) => fits(entry, macs)))
    return false;
  for (const entry of entries)
    takeOff(link, entry.key, entry.pairing);
  return true;
}
function foldPhones(link, now = Date.now()) {
  const macs = macsOf(link);
  for (const doc of phoneDocs(link)) {
    for (const entry of Array.isArray(doc.body.removed) ? doc.body.removed.slice(0, MOST_KEPT) : []) {
      if (fits(entry, macs) && typeof entry.pairing === "string")
        noteRemoved(link, entry.key, entry.pairing);
    }
  }
  const known = new Map((link.phones ?? []).map((phone) => [phone.key, phone]));
  const signed = macs.filter((mac) => macDoc(link, mac, "phones"));
  const listed = [];
  const add = (phone) => {
    if (!fits(phone, macs) || removedAlready(link, phone.key, phone.pairing ?? "") || listed.some((each) => each.key === phone.key))
      return;
    listed.push(phone);
  };
  for (const mac of macs) {
    const doc = macDoc(link, mac, "phones");
    if (!doc) {
      for (const phone of link.phones ?? [])
        if (phone.from === "mac" && phone.mac === mac)
          add(phone);
      continue;
    }
    for (const phone of Array.isArray(doc.body.phones) ? doc.body.phones.slice(0, 64) : []) {
      if (!isObject(phone))
        continue;
      add({
        key: phone.key,
        name: String(phone.name ?? "").slice(0, 100),
        added: known.get(phone.key)?.added ?? Math.floor(now / 1000),
        from: "mac",
        mac,
        address: typeof phone.address === "string" && ADDRESS.test(phone.address) ? phone.address : known.get(phone.key)?.address,
        pairing: typeof phone.pairing === "string" ? phone.pairing : ""
      });
    }
  }
  if (!signed.length) {
    for (const phone of link.phones ?? [])
      if (phone.from === "mac" && phone.mac == null)
        add(phone);
  }
  for (const phone of link.phones ?? [])
    if (phone.from === "pair")
      add(phone);
  link.phones = listed;
}
var ownPhones = (link) => ({
  phones: (link.phones ?? []).filter((phone) => phone.from === "pair").map((phone) => ({ key: phone.key, name: phone.name ?? "", ...phone.address ? { address: phone.address } : {}, pairing: phone.pairing ?? "" })),
  removed: (link.removed ?? []).map(({ key, pairing }) => ({ key, pairing }))
});
function confirmPhone(phone) {
  const where = phone.address?.toString("base64url");
  const known = readLink()?.phones?.find((each) => each.key === phone.key.toString("base64url"));
  if (!known || !where || known.address === where)
    return;
  updateLink((link) => {
    const known = link?.phones?.find((each) => each.key === phone.key.toString("base64url"));
    if (!known || !where || known.address === where)
      return null;
    known.address = where;
    return link;
  });
}
var PAIRING_MINUTES = 10;
var newPairingToken = () => ({ token: crypto9.randomBytes(16).toString("base64url"), expires: Date.now() + PAIRING_MINUTES * 60000 });
function pairingLink(link) {
  const query = new URLSearchParams({
    v: "1",
    relay: link.relay,
    host: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    token: link.pairing.token,
    name: link.name
  });
  return `kuvo-link://pair?${query}`;
}
var phoneDocs = (link) => Object.values(link?.docs ?? {}).map(held).filter((doc) => doc?.kind === "phones");

// Packages/Box/src/link/documents/parts.ts
import crypto10 from "node:crypto";
var fitsPart = (part) => isObject(part) && typeof part.whole === "string" && Number.isInteger(part.i) && Number.isInteger(part.of) && part.of >= 2 && part.of <= MOST_PARTS && part.i >= 0 && part.i < part.of && typeof part.d === "string" && part.d.length <= DOC_PART && typeof part.s === "string";
function assemble(parts, from, part) {
  if (!fitsPart(part))
    return null;
  const key = `${from} ${part.whole}`;
  let pending = parts.get(key);
  if (!pending || pending.of !== part.of) {
    const theirs = [...parts.keys()].filter((each) => each.startsWith(`${from} `));
    if (theirs.length >= 4)
      parts.delete(theirs[0]);
    pending = { of: part.of, s: part.s, pieces: new Map };
    parts.set(key, pending);
  }
  pending.pieces.set(part.i, part.d);
  if (pending.pieces.size < part.of)
    return null;
  parts.delete(key);
  const d = Array.from({ length: part.of }, (_, i) => pending.pieces.get(i)).join("");
  if (crypto10.createHash("sha256").update(d).digest("base64url") !== part.whole)
    return null;
  return { d, s: pending.s };
}

// Packages/Box/src/link/documents/work.ts
function takesFrom(link, origin, kind) {
  const macs = macsOf(link).map((mac) => macSign(link, mac)).filter(Boolean);
  if (kind === "peers")
    return macs.includes(origin) || IS_MAC && origin === ownSign(link);
  return macs.includes(origin) || origin === ownSign(link) || peersOf(link).some((peer) => peer.sign === origin);
}
function takenBy(link, to, origin, kind) {
  if (IS_MAC) {
    const peers = peersOf(link);
    return peers.some((peer) => peer.key === to) && (origin === ownSign(link) || kind !== "peers" && peers.some((peer) => peer.sign === origin));
  }
  for (const mac of macsOf(link)) {
    const doc = macDoc(link, mac, "peers");
    const boxes = Array.isArray(doc?.body.boxes) ? doc.body.boxes : [];
    if (!boxes.some((box) => box?.key === to))
      continue;
    if (origin === doc.origin || kind !== "peers" && boxes.some((box) => box?.sign === origin))
      return true;
  }
  return false;
}
var docPeers = (link) => peersOf(link).filter((peer) => typeof peer.sign === "string");
function takeDoc(link, envelope) {
  const doc = readDoc(envelope);
  if (!doc || !takesFrom(link, doc.origin, doc.kind))
    return null;
  if (doc.origin === ownSign(link)) {
    if (doc.kind === "peers" && !IS_MAC || doc.n > MOST_COUNT)
      return null;
    const had = link.own?.[doc.kind];
    if (had && (doc.n < had.n || doc.n === had.n && doc.h === had.h))
      return null;
    link.own = { ...link.own ?? {}, [doc.kind]: { n: Math.max(doc.n, had?.n ?? 0), h: doc.h, b: bodyHash(doc.body) } };
    return { ...doc, mine: true };
  }
  const newer = (had) => !had || doc.n > had.n || doc.n === had.n && doc.h < had.h;
  if (doc.kind === "personalities") {
    if (!newer(link.views?.[doc.origin]))
      return null;
    link.views = { ...link.views ?? {}, [doc.origin]: { n: doc.n, h: doc.h } };
    return doc;
  }
  const key = docKey(doc.origin, doc.kind);
  if (!newer(held(link.docs?.[key])))
    return null;
  link.docs = { ...link.docs ?? {}, [key]: doc.envelope };
  return doc;
}
function pruneDocs(link) {
  for (const kind of DOC_KINDS) {
    for (const [key, envelope] of Object.entries(link.docs ?? {})) {
      const doc = held(envelope);
      if (!doc)
        delete link.docs[key];
      else if (doc.kind === kind && !takesFrom(link, doc.origin, doc.kind))
        delete link.docs[key];
    }
  }
  for (const origin of Object.keys(link.views ?? {}))
    if (!takesFrom(link, origin, "personalities"))
      delete link.views[origin];
}
function ownDoc(link, kind, body) {
  if (!ownSign(link))
    return null;
  const b = bodyHash(body);
  const had = link.own?.[kind];
  const changed = !had || had.b !== b;
  const n = changed ? (had?.n ?? 0) + 1 : had.n;
  const envelope = signDoc(link.sign, kind, n, body);
  if (changed)
    link.own = { ...link.own ?? {}, [kind]: { n, h: shortHash(Buffer.from(envelope.d, "base64url")), b } };
  return { envelope, changed };
}
function ownDocs(state) {
  const docs = {};
  if (IS_MAC) {
    const peers = ownDoc(state.link, "peers", macPeersBody(state.link));
    if (peers)
      docs.peers = peers;
  }
  const phones = IS_MAC && !macLink.config?.phones ? null : ownDoc(state.link, "phones", ownPhones(state.link));
  if (phones)
    docs.phones = phones;
  const library = mergePersonalities(state.library);
  if (Buffer.byteLength(JSON.stringify(library)) <= MOST_DOC - 4096) {
    const personalities = ownDoc(state.link, "personalities", library);
    if (personalities)
      docs.personalities = personalities;
  }
  return docs;
}
var ownKinds = () => IS_MAC ? DOC_KINDS : ["phones", "personalities"];
function macPeersBody(link) {
  const peers = peersOf(link).filter((peer) => typeof peer.sign === "string");
  let address = null;
  try {
    address = addressOf(Buffer.from(link.secret, "base64url")).toString("base64url");
  } catch {}
  const me = { key: ownKey(link), sign: ownSign(link), address, name: String(link.name ?? "Mac").slice(0, 100), kind: "mac" };
  const current = new Set(peers.map((peer) => peer.key));
  return { boxes: [me, ...peers.map((peer) => ({ ...peer, kind: "machine" }))], moved: cleanMoved(link.macMoved), left: (Array.isArray(link.left) ? link.left : []).filter((key) => !current.has(key)) };
}
function digestOf(link) {
  const have = [];
  for (const envelope of Object.values(link?.docs ?? {})) {
    const doc = held(envelope);
    if (doc)
      have.push([doc.origin, doc.kind, doc.n, doc.h]);
  }
  for (const [origin, seen] of Object.entries(link?.views ?? {}))
    have.push([origin, "personalities", seen.n, seen.h]);
  const own = ownSign(link);
  if (own) {
    for (const kind of ownKinds())
      if (link.own?.[kind])
        have.push([own, kind, link.own[kind].n, link.own[kind].h]);
  }
  return have;
}
function docMails(docs) {
  const mails = [];
  let give = [], size = 0;
  for (const envelope of docs.give ?? []) {
    const length = envelope.d.length + envelope.s.length + 16;
    if (length > 48000) {
      const whole = crypto11.createHash("sha256").update(envelope.d).digest("base64url");
      const of = Math.ceil(envelope.d.length / DOC_PART);
      for (let i = 0;i < of; i++)
        mails.push({ part: { whole, i, of, d: envelope.d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: envelope.s } });
      continue;
    }
    if (size + length > 48000 && give.length) {
      mails.push({ give });
      give = [];
      size = 0;
    }
    give.push(envelope);
    size += length;
  }
  if (give.length)
    mails.push({ give });
  if (docs.have)
    mails.push({ have: docs.have, ...docs.reply ? { reply: true } : {} });
  return mails;
}
function docsWork(state, sender, docs, { stay = null } = {}) {
  const { link } = state;
  const sends = new Map;
  const to = (peer, change) => {
    const docs = sends.get(peer.key) ?? { peer, give: [] };
    change(docs);
    sends.set(peer.key, docs);
  };
  const given = Array.isArray(docs?.give) ? docs.give.slice(0, 64) : [];
  if (isObject(docs?.part)) {
    state.parts ??= new Map;
    const whole = assemble(state.parts, sender.key, docs.part);
    if (whole)
      given.push(whole);
  }
  const took = [];
  for (const kind of DOC_KINDS) {
    for (const envelope of given) {
      const peeked = held(envelope);
      if (peeked?.kind !== kind)
        continue;
      const doc = takeDoc(link, envelope);
      if (doc)
        took.push(doc);
    }
  }
  const left = [];
  const own = ownKey(link);
  for (const doc of took) {
    if (doc.kind !== "peers")
      continue;
    const mac = macsOf(link).find((each) => macSign(link, each) === doc.origin);
    const named = Array.isArray(doc.body.boxes) && doc.body.boxes.some((box) => box?.key === own);
    if (mac && !named && Array.isArray(doc.body.left) && doc.body.left.includes(own))
      left.push(mac);
  }
  for (const mac of left.filter((each) => each !== stay))
    leaveMac(link, mac);
  pruneDocs(link);
  foldPhones(link);
  const personalities = took.filter((doc) => doc.kind === "personalities").map((doc) => doc.body);
  if (personalities.length)
    state.library = mergePersonalities(state.library, ...personalities);
  let ask = false;
  if (Array.isArray(docs?.have)) {
    const theirs = new Map;
    for (const entry of docs.have.slice(0, 512)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && DOC_KINDS.includes(entry[1]) && Number.isSafeInteger(entry[2]))
        theirs.set(docKey(entry[0], entry[1]), { n: entry[2], h: String(entry[3] ?? "") });
    }
    const self = ownSign(link);
    for (const kind of ownKinds()) {
      const there = self && theirs.get(docKey(self, kind));
      if (there && there.n <= MOST_COUNT && there.n > (link.own?.[kind]?.n ?? 0))
        link.own = { ...link.own ?? {}, [kind]: { n: there.n, h: there.h, b: "" } };
    }
    const senderSign = sender.sign ?? macSign(link, sender.key);
    const behind = (key, n, h) => {
      const there = theirs.get(key);
      return !there || there.n < n || there.n === n && there.h > h;
    };
    for (const envelope of Object.values(link.docs ?? {})) {
      const doc = held(envelope);
      if (doc && behind(docKey(doc.origin, doc.kind), doc.n, doc.h) && takenBy(link, sender.key, doc.origin, doc.kind))
        to(sender, (docs) => docs.give.push(envelope));
    }
    if (!docs.reply) {
      for (const [key, there] of theirs) {
        const [origin, kind] = key.split(" ");
        if (origin === self || kind === "personalities" && origin !== senderSign || !takesFrom(link, origin, kind))
          continue;
        const have = kind === "personalities" ? link.views?.[origin] : held(link.docs?.[key]);
        if (!have || have.n < there.n || have.n === there.n && have.h > there.h)
          ask = true;
      }
    }
    state.theirs = theirs;
  }
  const ownNow = ownDocs(state);
  const peers = docPeers(link);
  const mine = ownSign(link);
  for (const doc of took.filter((doc) => doc.kind !== "personalities" && !doc.mine)) {
    for (const peer of peers) {
      if (peer.key !== sender.key && peer.sign !== doc.origin && takenBy(link, peer.key, doc.origin, doc.kind))
        to(peer, (docs) => docs.give.push(doc.envelope));
    }
  }
  for (const made of Object.values(ownNow)) {
    if (made.changed) {
      for (const peer of peers)
        if (takenBy(link, peer.key, mine, "phones"))
          to(peer, (docs) => docs.give.push(made.envelope));
    }
  }
  if (state.theirs) {
    const senderPeer = peers.find((peer) => peer.key === sender.key);
    for (const [kind, made] of Object.entries(ownNow)) {
      const record = link.own[kind];
      const there = state.theirs.get(docKey(mine, kind));
      if (senderPeer && !made.changed && (!there || there.n < record.n || there.n === record.n && there.h > record.h))
        to(senderPeer, (docs) => docs.give.push(made.envelope));
    }
    delete state.theirs;
  }
  if (ask) {
    const senderPeer = peers.find((peer) => peer.key === sender.key) ?? sender;
    to(senderPeer, (docs) => {
      docs.have = digestOf(link);
      docs.reply = true;
    });
  }
  return {
    took,
    left: left.filter((each) => each !== stay),
    send: [...sends.values()].filter((docs) => docs.give.length || docs.have).map(({ peer, ...docs }) => ({ to: peer, docs: { ...docs, give: dedupe(docs.give) } }))
  };
}
var dedupe = (envelopes) => [...new Map(envelopes.map((envelope) => [envelope.d, envelope])).values()];
function greetWork(state) {
  ownDocs(state);
  const have = digestOf(state.link);
  return { send: docPeers(state.link).map((peer) => ({ to: peer, docs: { have } })) };
}
function changedWork(state, tell = false) {
  const made = Object.values(ownDocs(state)).filter((each) => each.changed).map((each) => each.envelope);
  const mine = ownSign(state.link);
  const have = tell ? digestOf(state.link) : null;
  return {
    send: docPeers(state.link).filter((peer) => takenBy(state.link, peer.key, mine, "phones")).map((peer) => ({ to: peer, docs: { give: made, ...have ? { have } : {} } })).filter((each) => each.docs.give.length || each.docs.have)
  };
}
function currentDigest() {
  const library = readPersonalities();
  let have = null;
  updateLink((link) => {
    if (!link?.sign)
      return null;
    const before = JSON.stringify(link.own ?? {});
    greetWork({ link, library });
    have = digestOf(link);
    return JSON.stringify(link.own ?? {}) === before ? null : link;
  });
  return have;
}

// Packages/Box/src/link/peers/directory.ts
import fs26 from "node:fs";
import path25 from "node:path";

// Packages/Box/src/shared/shape.ts
var string = "string";
var number = "number";
var bool = "bool";
var any = "any";
var list = (of) => ({ list: of });
var map = (of) => ({ map: of });
var object = (fields) => ({ object: fields });
var oneOf = (...of) => ({ oneOf: of });
var words = (...each) => ({ oneOf: each.map((word) => ({ literal: word })) });
var nullable = (shape) => oneOf(shape, "null");
var NOTHING = object({});

// Packages/Box/src/shared/routes/bots.ts
var LOOKS = {
  colors: ["mint", "sky", "indigo", "violet", "pink", "coral", "orange", "amber", "lime", "graphite"],
  shapes: ["round", "squircle", "pebble", "gem", "bloom"],
  faces: ["calm", "happy", "sleepy", "wink", "curious", "bright"]
};
var LOOK = object({ color: words(...LOOKS.colors), shape: words(...LOOKS.shapes), face: words(...LOOKS.faces) });
var MODEL = object({ id: string, providerID: string, "variant?": string });
var BOT = object({
  id: string,
  session: string,
  name: string,
  look: LOOK,
  "machine?": string,
  job: string,
  jobDetails: string,
  paused: bool,
  "wakes?": number,
  watching: number,
  agents: bool,
  "personality?": string,
  "model?": MODEL,
  folder: string,
  "project?": string,
  "created?": string
});
var BOTS2 = object({ bots: list(BOT) });
var TEMPLATES = object({
  templates: list(object({ id: string, name: string, job: string, instructions: string, look: LOOK, "personality?": string, wantsProject: bool })),
  personalities: list(object({ id: string, name: string, description: string, "custom?": bool })),
  looks: object({ colors: list(string), shapes: list(string), faces: list(string) }),
  startingModel: map(nullable(MODEL)),
  projects: list(object({ directory: string, name: string, "machine?": string }))
});
var MADE = object({ bot: BOT, firstMessage: nullable(string) });
var CHANGED = object({ bot: nullable(BOT) });
var BOT_KEYS2 = object({
  keys: list(object({
    integration: string,
    own: bool,
    shared: bool,
    title: string,
    symbol: string,
    keys: list(object({ name: string, label: string, prompt: string })),
    "help?": string
  }))
});
var BOT_KEY_VALUES = object({ keys: map(string) });
var BOT_KEY_KEPT = object({ integration: string, own: bool, shared: bool });

// Packages/Box/src/link/peers/directory.ts
var PEER_AGENTS_FILE = path25.join(RUN, "peer-agents.json");
var MAC_AGENTS_FILE = path25.join(RUN, "mac-agents.json");
var AGENTS_FILE = path25.join(RUN, "agents.json");
var PEER_LOCK = path25.join(RUN, ".peers.lock");
var MOST_AGENTS = 120;
var fitsAgent = (agent) => isObject(agent) && typeof agent.session === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(agent.session) && typeof agent.name === "string" && (agent.kind === "bot" || agent.kind === "session");
var LOOKS2 = { color: LOOKS.colors, shape: LOOKS.shapes, face: LOOKS.faces };
var PLAIN_LOOK = { color: "graphite", shape: "round", face: "calm" };
var keptLook = (look) => isObject(look) ? Object.fromEntries(Object.keys(LOOKS2).map((key) => [key, LOOKS2[key].includes(look[key]) ? look[key] : PLAIN_LOOK[key]])) : undefined;
var keptAgent = ({ session, name, kind, project, about, machine, id, look }) => ({
  session,
  name: plainName(name).slice(0, 200),
  kind,
  ...kind === "bot" && typeof id === "string" && /^bot_[A-Za-z0-9]{1,60}$/.test(id) ? { id } : {},
  ...kind === "bot" && keptLook(look) ? { look: keptLook(look) } : {},
  ...typeof project === "string" && project ? { project: project.slice(0, 200) } : {},
  ...typeof about === "string" && about ? { about: about.slice(0, 500) } : {},
  ...typeof machine === "string" && machine ? { machine: machine.slice(0, 200) } : {}
});
var keptFeatures = (features) => Array.isArray(features) ? features.filter((each) => typeof each === "string" && each.length <= 60).slice(0, 80) : [];
function takeAgents(sender, given, file = PEER_AGENTS_FILE, lock = PEER_LOCK) {
  if (!isObject(given) || typeof given.at !== "number" || !Array.isArray(given.list))
    return false;
  return locked(lock, () => {
    let all = {};
    try {
      all = JSON.parse(fs26.readFileSync(file, "utf8"));
    } catch {}
    if (given.at <= (all[sender.key]?.at ?? 0))
      return false;
    all[sender.key] = {
      at: given.at,
      kind: sender.kind,
      ...sender.id ? { id: sender.id } : {},
      list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent),
      ...Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}
    };
    writePrivate(file, JSON.stringify(all));
    return true;
  });
}
function readPeerAgents(file = PEER_AGENTS_FILE, macFile = MAC_AGENTS_FILE, link = null) {
  let all = {};
  try {
    all = JSON.parse(fs26.readFileSync(file, "utf8")) ?? {};
  } catch {}
  try {
    const given = JSON.parse(fs26.readFileSync(macFile, "utf8"));
    const macs = macsOf(link ?? readLink() ?? {});
    if (macs.includes(given?.key) && typeof given.at === "number" && Array.isArray(given.list) && given.at > (all[given.key]?.at ?? 0)) {
      all[given.key] = { at: given.at, kind: "mac", list: given.list.filter(fitsAgent).slice(0, MOST_AGENTS).map(keptAgent) };
    }
  } catch {}
  return all;
}
function peerOf(session, peers, told, moved = new Map) {
  if (moved.has(session))
    return peers.find((peer) => peer.key === moved.get(session)) ?? null;
  const listing = peers.filter((peer) => (told[peer.key]?.list ?? []).some((agent) => agent.session === session));
  if (listing.length <= 1)
    return listing[0] ?? null;
  const macs = listing.filter((peer) => peer.kind === "mac");
  return macs.length === 1 ? macs[0] : null;
}
var isPutAway = (session) => session?.metadata?.["kuvo.archived"] === true || Boolean(session?.metadata?.kuvo?.archived) || Boolean(session?.time?.archived);
function composeAgents(own, ownID, peers, told, moved = new Map) {
  const agents = own.map((agent) => ({ ...keptAgent({ ...agent, machine: undefined }), ...ownID ? { machine: ownID } : {} }));
  const seen = new Set(agents.map((agent) => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key)
        continue;
      seen.add(agent.session);
      const { machine, ...rest } = agent;
      agents.push(peer.kind === "machine" ? { ...rest, ...peer.id ? { machine: peer.id } : {} } : { ...rest, ...machine ? { machine } : {} });
    }
  }
  return { machine: ownID ?? null, agents };
}

// Packages/Box/src/link/peers/seats.ts
import crypto12 from "node:crypto";
import fs27 from "node:fs";
import path27 from "node:path";

// Packages/Box/src/link/letters/letter.ts
import path26 from "node:path";
var OUTBOX = path26.join(RUN, "outbox");
var SENDING = path26.join(OUTBOX, "sending");
var LETTERS_SEEN = path26.join(RUN, "letters-seen.json");
var LETTER_LIFE = 86400000;
var LETTER_MEMORY = 2 * 86400000;
var LETTER_TEXT = 32000;
var cutText = (text, most = LETTER_TEXT) => {
  const words = String(text ?? "");
  if (words.length <= most)
    return words;
  return words.slice(0, /[\uDC00-\uDFFF]/.test(words[most]) ? most - 1 : most);
};
var LETTER_ID = /^[A-Za-z0-9_-]{6,80}$/;
var composeLetter = (name, session, words, waits) => `[Message from ${name} · ${session}] (${waits ? "They're waiting for your reply: just answer, in your words." : session === "unknown" ? "It can't be answered: who sent it isn't known." : `To answer, use send_message to ${session}.`})

${words}`;
async function placeOfSession(session, targets) {
  if (!targets.length)
    throw new Error("Its engine isn't running.");
  let unsure = null;
  for (const target of targets) {
    try {
      const response = await fetch(`http://127.0.0.1:${target.port}/api/session/${encodeURIComponent(session)}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(1e4) });
      if (response.ok)
        return { target, data: (await response.json().catch(() => null))?.data ?? {} };
      if (response.status !== 404)
        unsure = new Error(`It answered ${response.status}.`);
    } catch (error) {
      unsure = error;
    }
  }
  if (unsure)
    throw unsure;
  return null;
}
var letterTries = new Map;

// Packages/Box/src/link/peers/seats.ts
var SEAT_WHOLE = 48000;
var seatParts = new Map;
var bridgeAsk = async (method, route, body, signal) => {
  const target = readBridgeFile();
  if (!target?.port || !target?.password)
    throw new Error("The coding agents' bridge isn't running.");
  const response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/peers${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(1e4)
  });
  if (!response.ok)
    throw Object.assign(new Error(`The coding agents' bridge answered ${response.status}.`), { status: response.status });
  return response;
};
var SEAT_LETTER_LIFE = LETTER_MEMORY;
var ONLINE_STEP = 5 * 60000;
var seatRounds = new Map;
var seatAge = (letter) => typeof letter?.aged === "number" && Number.isFinite(letter.aged) ? letter.aged : 0;
function seatPayloads(mail, id) {
  const json = JSON.stringify(mail);
  if (Buffer.byteLength(json) <= SEAT_WHOLE)
    return [{ seat: mail, ...id ? { seatID: id } : {} }];
  const d = Buffer.from(json).toString("base64url");
  const of = Math.ceil(d.length / DOC_PART);
  if (of > MOST_PARTS)
    return null;
  const whole = crypto12.createHash("sha256").update(d).digest("base64url");
  return Array.from({ length: of }, (_, i) => ({ seatPart: { whole, i, of, d: d.slice(i * DOC_PART, (i + 1) * DOC_PART), s: id ?? "" } }));
}
function sendSeat(host, to, mail, id, link = readLink()) {
  const peer = peersOf(link).find((each) => each.key === to);
  if (!peer || !host)
    return false;
  const payloads = seatPayloads(mail, id);
  if (!payloads) {
    console.error(`kuvo-link: a group chat's ${String(mail?.kind ?? "mail")} for ${plainName(peer.name) || "another computer"} is too big to send, so it wasn't.`);
    return "too big";
  }
  for (const payload of payloads) {
    const bytes = mailFor(peer, { ...payload, at: Date.now() }, link);
    if (!bytes)
      return false;
    try {
      host.send(bytes);
    } catch {
      return false;
    }
  }
  return true;
}
async function takeSeat(sender, payload, send, ask = bridgeAsk) {
  let mail = null, id = null;
  if (isObject(payload.seat)) {
    mail = payload.seat;
    id = typeof payload.seatID === "string" ? payload.seatID : null;
  } else if (isObject(payload.seatPart)) {
    const whole = assemble(seatParts, sender.key, payload.seatPart);
    if (!whole)
      return;
    try {
      mail = JSON.parse(Buffer.from(whole.d, "base64url").toString("utf8"));
    } catch {
      return;
    }
    id = whole.s || null;
  }
  if (!isObject(mail) || id !== null && !LETTER_ID.test(id))
    return;
  try {
    await ask("POST", "/mail", { from: sender.key, mail });
  } catch {
    if (id)
      send(sender, { delivered: { id, ok: false, why: "Not now.", retry: true } });
    return;
  }
  if (id)
    send(sender, { delivered: { id, ok: true } });
}
function seatPeers(link = readLink(), told = readPeerAgents(undefined, undefined, link)) {
  const peers = peersOf(link);
  return {
    boxes: peers.map((peer) => ({ key: peer.key, name: plainName(peer.name) || "another computer", seats: (told[peer.key]?.features ?? []).includes("groups.seats") })),
    bots: peers.flatMap((peer) => (told[peer.key]?.list ?? []).filter((agent) => agent.kind === "bot" && agent.id).map((agent) => ({ id: agent.id, name: agent.name, job: agent.about ?? "", box: peer.key, session: agent.session, ...agent.look ? { look: agent.look } : {} })))
  };
}
var toldSeatPeers = "";
async function tellSeatPeers(link = readLink(), force = false, ask = bridgeAsk) {
  const peers = seatPeers(link);
  const text = JSON.stringify(peers);
  if (!force && text === toldSeatPeers)
    return;
  await ask("PUT", "", peers);
  toldSeatPeers = text;
}
function carrySeat(host, given, link = readLink(), now = Date.now()) {
  if (!isObject(given) || typeof given.to !== "string" || !isObject(given.mail) || typeof given.id !== "string")
    return false;
  if (given.durable !== true) {
    sendSeat(host, given.to, given.mail, undefined, link);
    return true;
  }
  const id = given.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60);
  if (!LETTER_ID.test(id))
    return false;
  const letter = { peer: given.to, seat: given.mail, at: now };
  try {
    fs27.mkdirSync(SENDING, { recursive: true, mode: 448 });
    if (given.mail.kind === "memory") {
      for (const name of listOf(SENDING)) {
        if (!name.endsWith(".json"))
          continue;
        let other;
        try {
          other = JSON.parse(fs27.readFileSync(path27.join(SENDING, name), "utf8"));
        } catch {
          continue;
        }
        if (other?.peer !== given.to || other?.seat?.kind !== "memory" || other.seat.memory?.bot !== given.mail.memory?.bot || other.seat.memory?.chat !== given.mail.memory?.chat)
          continue;
        fs27.rmSync(path27.join(SENDING, name), { force: true });
        letterTries.delete(name.slice(0, -5));
      }
    }
    writePrivate(path27.join(SENDING, `${id}.json`), JSON.stringify(letter));
  } catch {
    return false;
  }
  const to = peersOf(link).find((each) => each.key === given.to);
  if (to && host)
    sendSeatLetter(host, to, id, letter, link, now);
  return true;
}
function sendSeatLetter(host, to, id, letter, link, now, ask = bridgeAsk) {
  const file = path27.join(SENDING, `${id}.json`);
  if (letter.sentTo !== to.key)
    try {
      writePrivate(file, JSON.stringify({ ...letter, sentTo: to.key }));
    } catch {}
  const went = sendSeat(host, to.key, letter.seat, id, link);
  if (went === "too big")
    return giveUpSeat(id, letter, ask);
  if (went)
    letterTries.set(id, now);
  return null;
}
var tellingGaveUp = new Set;
function giveUpSeat(id, letter, ask = bridgeAsk) {
  const file = path27.join(SENDING, `${id}.json`);
  letterTries.delete(id);
  if (letter.gaveUp !== true)
    try {
      writePrivate(file, JSON.stringify({ ...letter, gaveUp: true }));
    } catch {}
  if (tellingGaveUp.has(id))
    return null;
  tellingGaveUp.add(id);
  const heard = () => fs27.rmSync(file, { force: true });
  return ask("POST", "/gaveup", { to: letter.peer, mail: letter.seat, at: letter.at }).then(heard, (error) => {
    if (error?.status >= 400 && error.status < 500)
      heard();
  }).finally(() => tellingGaveUp.delete(id));
}
async function watchSeats(host, signal) {
  let attempt = 0;
  while (!signal?.aborted) {
    try {
      const response = await bridgeAsk("GET", "/mail", undefined, signal);
      attempt = 0;
      await tellSeatPeers(readLink(), true).catch(() => {});
      let buffer = "";
      const decoder = new TextDecoder;
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf(`
`)) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let given;
          try {
            given = JSON.parse(line);
          } catch {
            continue;
          }
          if (carrySeat(host(), given) && given.durable === true)
            bridgeAsk("POST", "/sent", { ids: [given.id] }).catch(() => {});
        }
      }
    } catch {}
    attempt += 1;
    await pause(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}

// Packages/Box/src/link/peers/agents.ts
function forgetMacsAgents(mac, link) {
  const keep = new Set(peersOf(link).map((peer) => peer.key));
  locked(PEER_LOCK, () => {
    let all = {};
    try {
      all = JSON.parse(fs28.readFileSync(PEER_AGENTS_FILE, "utf8"));
    } catch {
      return;
    }
    for (const key of Object.keys(all))
      if (!keep.has(key))
        delete all[key];
    writePrivate(PEER_AGENTS_FILE, JSON.stringify(all));
  });
  try {
    if (JSON.parse(fs28.readFileSync(MAC_AGENTS_FILE, "utf8"))?.key === mac)
      fs28.rmSync(MAC_AGENTS_FILE, { force: true });
  } catch {}
  writeAgents(link);
}
async function ownAgents(readEngine, machine, kit = readKit(), readBridge = readBridgeFile) {
  const bots = listBots(machine).map((bot) => ({ session: bot.session, name: bot.name, kind: "bot", id: bot.id, ...bot.job ? { about: bot.job } : {}, ...bot.look ? { look: bot.look } : {} }));
  const botSessions = new Set(bots.map((bot) => bot.session));
  const sessionsOf = async (target) => {
    const response = await fetch(`http://127.0.0.1:${target.port}/api/session?parentID=null&limit=100&order=desc`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` }, signal: AbortSignal.timeout(1e4) });
    if (!response.ok)
      throw new Error(`It answered ${response.status}.`);
    return (await response.json())?.data ?? [];
  };
  let sessions;
  try {
    sessions = await sessionsOf(readEngine());
  } catch {
    return null;
  }
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && processRuns(bridge.pid, "kuvo-agents"))
      sessions = sessions.concat(await sessionsOf(bridge));
  } catch {}
  const projects = boxProjects(kit);
  const named = (directory) => projects.find((project) => project.directory === directory)?.name ?? (directory === path28.join(K, "chats") ? "Chats" : directory ? path28.basename(directory) : undefined);
  const recent = sessions.filter((session) => !session.parentID && !botSessions.has(session.id) && !session.metadata?.kuvo?.seat && !isPutAway(session)).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)).slice(0, 40).map((session) => ({ session: session.id, name: session.title || "New session", kind: "session", ...named(session.location?.directory ?? session.directory) ? { project: named(session.location?.directory ?? session.directory) } : {} }));
  return [...bots, ...recent].map(keptAgent);
}
var ownList = null;
var ownMachine = null;
function keepOwn(list, machine) {
  ownList = list;
  ownMachine = machine;
}
function ownAsLast(ownID) {
  if (ownList)
    return ownList;
  try {
    return (JSON.parse(fs28.readFileSync(AGENTS_FILE, "utf8"))?.agents ?? []).filter((agent) => fitsAgent(agent) && (agent.machine ?? null) === ownID);
  } catch {
    return [];
  }
}
function writeAgents(link = readLink()) {
  const ownID = ownMachine ?? link?.id ?? null;
  const own = ownAsLast(ownID);
  const composed = composeAgents(own, ownID, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link));
  try {
    const text = JSON.stringify(composed);
    if (textOf(AGENTS_FILE) !== text)
      writePrivate(AGENTS_FILE, text);
  } catch {}
  tellSeatPeers(link).catch(() => {});
}
async function refreshOwn(readEngine, link = readLink()) {
  if (!link?.key && !IS_MAC)
    return ownList;
  ownMachine = link?.id ?? null;
  const list = await ownAgents(readEngine, link?.id);
  if (list)
    ownList = list;
  writeAgents(link);
  return ownList;
}
var ownFeatures = () => IS_MAC && Array.isArray(macLink.config?.features) ? macLink.config.features : FEATURES;
var toldPeers = new Map;
async function announce(host, readEngine, link = readLink(), now = Date.now(), ask = false) {
  if (!link?.key)
    return;
  await refreshOwn(readEngine, link);
  if (!ownList)
    return;
  const json = JSON.stringify(ownList);
  let have = null;
  for (const peer of peersOf(link)) {
    const last = toldPeers.get(peer.key);
    if (!ask && last && last.json === json && now - last.at < 600000)
      continue;
    if (have === null)
      have = ask ? false : currentDigest();
    const docs = peer.sign && have ? { docs: { have } } : {};
    let bytes = null, sent = [];
    for (const count of [ownList.length, Math.floor(ownList.length / 2), Math.floor(ownList.length / 4)]) {
      sent = ownList.slice(0, count);
      bytes = mailFor(peer, { agents: { at: now, list: sent, features: ownFeatures() }, ...docs, at: now, ...ask ? { ask: "agents" } : {} }, link);
      if (bytes)
        break;
    }
    if (!bytes)
      continue;
    try {
      host.send(bytes);
      toldPeers.set(peer.key, { json, at: now, sessions: new Set(sent.map((agent) => agent.session)) });
    } catch {}
  }
}

// Packages/Box/src/link/peers/naming.ts
function messageBlock(start, end, headings) {
  const find = (text) => {
    const body = text.replace(/\s+$/u, "");
    if (!body.endsWith(`
${end}`))
      return null;
    const close = body.length - end.length;
    const opening = `${start}
`;
    let before = close;
    for (;; ) {
      const open = before - opening.length < 0 ? -1 : text.lastIndexOf(opening, before - opening.length);
      if (open < 0)
        return null;
      before = open;
      if (open !== 0 && text[open - 1] !== `
`)
        continue;
      const lines = text.slice(open + opening.length, close).split(`
`).slice(0, -1);
      if (lines.length && headings.includes(lines[0]))
        return { open, lines };
    }
  };
  return {
    start,
    split: (text) => {
      const found = find(text);
      return found ? { before: text.slice(0, found.open).trim(), lines: found.lines } : null;
    },
    escaping: (text) => {
      let found;
      while (found = find(text))
        text = text.slice(0, found.open + start.length) + " " + text.slice(found.open + start.length);
      return text;
    }
  };
}
var FROM_PHONE_BLOCK = messageBlock("<from-phone>", "</from-phone>", ["The user sent this from Kuvo Code on their iPhone."]);
var ATTACHED_HEADINGS = [
  "The attached files are on disk here (what's in them is in this message already):",
  "Open these attached files with your tools if you need them:",
  "These attached files stayed on the user's Mac (they couldn't be read, or copied to this machine):"
];
var ATTACHED_BLOCK = messageBlock("<attached-files>", "</attached-files>", [...ATTACHED_HEADINGS]);
function withAttachedNote(text, included, paths, joins = false) {
  const lines = [...included.length ? [ATTACHED_HEADINGS[0], ...included] : [], ...paths.length ? [ATTACHED_HEADINGS[1], ...paths] : []];
  if (!lines.length)
    return text;
  const found = joins ? ATTACHED_BLOCK.split(text) : null;
  const words = found ? found.before : ATTACHED_BLOCK.escaping(text);
  return (words ? `${words}

` : "") + ["<attached-files>", ...found?.lines ?? [], ...lines, "</attached-files>"].join(`
`);
}
var REVIEW_BLOCK = messageBlock("<review-comments>", "</review-comments>", ["Comments on lines of the current changes:"]);
var NAMING_HEADING = "Agents the user named with & in this message, by their address. Read one's conversation with read_conversation only when what the user asks needs what it knows or did, and write to it with send_message only to ask it something or hand it work; when the user only mentions one, do neither:";
var NAMED_BLOCK = messageBlock("<named-agents>", "</named-agents>", [
  NAMING_HEADING,
  "Agents the user named with & in this message. Read one's conversation with read_conversation, or write to it with send_message, by its address:"
]);
var foldName = (text) => text.replace(/[\uFB00-\uFB06]/g, (ligature) => ligature.normalize("NFKD")).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/ß/g, "ss");
var wordCharacter = /^[\p{L}\p{N}]/u;
var graphemes = (text) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)];
function namesIn(text, references) {
  if (!text.includes("&"))
    return [];
  let folded = "";
  const from = [];
  const at = new Map, ending = new Map;
  for (const { segment, index } of graphemes(text)) {
    at.set(index, segment);
    ending.set(index + segment.length, segment);
    const each = foldName(segment);
    for (let i = 0;i < each.length; i++)
      from.push(index);
    folded += each;
  }
  from.push(text.length);
  const found = [];
  const length = (name) => graphemes(foldName(name)).length;
  for (const reference of [...references].sort((a, b) => length(b.name) - length(a.name))) {
    if (!reference.name)
      continue;
    const wanted = `&${foldName(reference.name)}`;
    for (let start = folded.indexOf(wanted);start >= 0; start = folded.indexOf(wanted, start + 1)) {
      const end = start + wanted.length;
      if (start > 0 && from[start - 1] === from[start] || end < folded.length && from[end - 1] === from[end])
        continue;
      const lower = from[start], upper = from[end];
      if (wordCharacter.test(ending.get(lower) ?? "") || wordCharacter.test(at.get(upper) ?? ""))
        continue;
      if (found.some((each) => lower < each.upper && each.lower < upper))
        continue;
      found.push({ lower, upper, reference });
    }
  }
  return found.sort((a, b) => b.lower - a.lower);
}
var agentIs = (agent, here) => {
  const machine = agent.machine ?? null;
  const place = machine === (here ?? null) ? here == null ? "on the Mac" : "here" : machine == null ? "on the Mac" : `on ${machine}`;
  return `${agent.kind}, ${place}${typeof agent.project === "string" ? `, in ${agent.project}` : ""}`;
};
function agentsNamed(texts, excluding, agents) {
  if (!texts.some((text) => text.includes("&")))
    return [];
  const byName = new Map;
  for (const agent of agents) {
    if (excluding.has(agent.session))
      continue;
    const name = foldName(agent.name);
    if (!byName.has(name))
      byName.set(name, agent);
  }
  const references = [...byName.values()].map((agent) => ({ name: agent.name, session: agent.session }));
  const named = [];
  for (const text of texts) {
    for (const { reference } of namesIn(text, references).reverse()) {
      if (named.some((agent) => agent.session === reference.session))
        continue;
      const agent = byName.get(foldName(reference.name));
      if (agent)
        named.push(agent);
    }
  }
  return named;
}
function nameAgents(message, { excluding = null, here = null, agents = [] } = {}) {
  message = FROM_PHONE_BLOCK.split(message)?.before ?? message;
  const withComments = ATTACHED_BLOCK.split(message)?.before ?? message;
  const words = REVIEW_BLOCK.split(withComments)?.before ?? withComments;
  const bare = NAMED_BLOCK.split(words)?.before ?? words;
  if (!bare.includes("&") && bare === words)
    return message;
  const text = NAMED_BLOCK.escaping(bare);
  const agentsHere = agentsNamed([text], new Set(excluding ? [excluding] : []), agents);
  const lines = agentsHere.map((agent) => `- &${agent.name} (${agent.session}): ${agentIs(agent, here)}${typeof agent.about === "string" && agent.about ? `: ${agent.about}` : ""}`);
  const named = lines.length ? `${text ? `${text}

` : ""}${["<named-agents>", NAMING_HEADING, ...lines, "</named-agents>"].join(`
`)}` : text;
  if (named === words)
    return message;
  const at = message.indexOf(words);
  return at < 0 ? message : message.slice(0, at) + named + message.slice(at + words.length);
}
function namedAgents(own, peers, told, moved = new Map) {
  const entry = (agent, machine) => ({ session: agent.session, name: agent.name, kind: agent.kind, machine, project: agent.project ?? null, about: agent.about ?? null });
  const titled = (agent) => agent.kind === "bot" || Boolean(agent.name) && agent.name !== "New session";
  const agents = own.filter(titled).map((agent) => entry(agent, null));
  const seen = new Set(agents.map((agent) => agent.session));
  for (const peer of peers) {
    for (const agent of told[peer.key]?.list ?? []) {
      if (!titled(agent) || seen.has(agent.session) || peerOf(agent.session, peers, told, moved)?.key !== peer.key)
        continue;
      seen.add(agent.session);
      agents.push(entry(agent, peer.kind === "machine" ? peer.id ?? peer.name ?? null : agent.machine ?? peer.name ?? null));
    }
  }
  return agents;
}

// Packages/Box/src/link/server/naming.ts
async function namedIn(body, session, naming) {
  if (!naming)
    return body;
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || !prompt.text.includes("&"))
    return body;
  const text = await naming(prompt.text, session).catch(() => prompt.text);
  return text === prompt.text ? body : Buffer.from(JSON.stringify({ ...prompt, text }));
}
var refreshingOwn = null;
var refreshOwnShared = (readEngine) => refreshingOwn ??= refreshOwn(readEngine).catch(() => {}).finally(() => {
  refreshingOwn = null;
});
var ownRefreshed = () => refreshingOwn ?? Promise.resolve();
function listedAgents() {
  try {
    const read = JSON.parse(fs29.readFileSync(AGENTS_FILE, "utf8"));
    return { machine: read?.machine ?? null, agents: Array.isArray(read?.agents) ? read.agents : [] };
  } catch {
    return { machine: null, agents: [] };
  }
}
function namingHere(readEngine) {
  return async (text, session) => {
    let everyone = listedAgents();
    const working = refreshOwnShared(readEngine);
    if (nameMissing(text, everyone.agents)) {
      await Promise.race([working, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
      everyone = listedAgents();
    }
    return nameAgents(text, { excluding: session, here: everyone.machine, agents: everyone.agents });
  };
}
function nameMissing(text, agents) {
  if (!text.includes("&"))
    return false;
  const references = agents.map((agent) => ({ name: String(agent.name ?? ""), session: agent.session }));
  const named = new Set(namesIn(text, references).map((each) => each.lower));
  const characters = graphemes(text);
  for (let i = 0;i < characters.length; i++) {
    const { segment, index } = characters[i];
    if (segment !== "&" || named.has(index))
      continue;
    if (wordCharacter.test(characters[i - 1]?.segment ?? ""))
      continue;
    const next = characters[i + 1]?.segment;
    if (next && !/^\s/u.test(next))
      return true;
  }
  return false;
}

// Packages/Box/src/link/areas/groups.ts
var GROUP_ROUTE = /^kuvo\/groups(?:\/(events|joinable|grp_[a-z0-9]+(?:\/(?:events|stop|keep-going|viewed|undo|start))?))?$/;
async function askGroups(target, method, route, body, signal) {
  const response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/groups${route}`, {
    method,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...body ? { "content-type": "application/json" } : {} },
    body: body ? JSON.stringify(body) : undefined,
    signal
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value };
}
async function* forwardGroups(target, route, request, signal) {
  const method = request.method.toUpperCase();
  const sends = !["GET", "HEAD", "DELETE"].includes(method);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/link/groups${route.slice("kuvo/groups".length)}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...sends ? { "content-type": "application/json" } : {} },
      body: sends ? Buffer.from(request.body ?? []) : undefined,
      signal
    });
  } catch {
    if (signal?.aborted)
      return;
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return yield* groupJSON(503, { message: groupsNotAnswering() });
  }
  yield { head: { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } } };
  try {
    for await (const chunk of response.body ?? [])
      yield { body: Buffer.from(chunk) };
  } catch {}
}
var groupsNotAnswering = () => IS_MAC ? "Group chats on this Mac aren’t answering. Try again in a moment." : "The coding agents’ bridge here isn’t answering. Try again in a moment.";
function* groupJSON(status, value) {
  yield { head: { status, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify(value)) };
}
async function* groupsRoute(context) {
  const { request, signal, route, readEngine, bridge } = context;
  const target = bridge();
  if (!target)
    return yield* groupJSON(503, { message: IS_MAC ? "Group chats on this Mac are starting. Try again in a moment." : "Group chats run with the coding agents' bridge, which isn't running on this machine." });
  if (request.method.toUpperCase() === "POST" && route.split("/").length === 3 && Buffer.from(request.body ?? []).includes("&")) {
    let text = "";
    try {
      text = JSON.parse(Buffer.from(request.body).toString())?.text;
    } catch {}
    const working = refreshOwnShared(readEngine);
    if (typeof text === "string" && nameMissing(text, listedAgents().agents)) {
      await Promise.race([working, new Promise((resolve) => setTimeout(resolve, 2000).unref?.())]);
    }
  }
  return yield* forwardGroups(target, route, request, signal);
}

// Packages/Box/src/link/bots/make.ts
import crypto13 from "node:crypto";
import fs30 from "node:fs";
import path29 from "node:path";
var fitsLook = (looks, look) => Boolean(look) && looks.colors.includes(look.color) && looks.shapes.includes(look.shape) && looks.faces.includes(look.face);
async function signInRefusal(model, engine, signal) {
  const ready = await call(engine, "GET", "/api/provider", undefined, signal).catch(() => {
    return;
  });
  const ids = Array.isArray(ready) ? ready.map((each) => each?.id) : [];
  return ids.length && !ids.includes(model.providerID) ? `${model.id} needs a sign-in on ${HERE}: sign in to it in Settings › Accounts, or choose another model.` : null;
}
async function makeBot(given, readEngine, readBridge, machine, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const kit = readKit();
  if (!kit)
    return no(409, NO_KIT);
  if (!given || typeof given !== "object")
    return no(400, "That isn’t a bot to make.");
  const name = plainName(given.name);
  if (!name)
    return no(400, "A bot needs a name.");
  if (IS_MAC && given.machine !== undefined && given.machine !== null && given.machine !== "mac") {
    return no(400, `This Mac makes only bots that live on it: make one for “${plainName(given.machine)}” there.`);
  }
  let template;
  if (given.template !== undefined && given.template !== null) {
    template = kit.templates.find((each) => each.id === given.template);
    if (!template)
      return no(400, `There’s no template “${given.template}”.`);
  }
  const shared = isObject(given.job) && (typeof given.job.line === "string" || typeof given.job.details === "string") ? firstMessageOf(given.job.line, given.job.details) || null : null;
  const personalityID = given.personality ?? template?.personality;
  const personality = personalityID ? botPersonalities(kit).find((each) => each.id === personalityID) : undefined;
  if (personalityID && !personality)
    return no(400, `There’s no personality “${personalityID}”.`);
  const project = given.project ?? undefined;
  if (project !== undefined && !boxProjects(kit).some((each) => each.directory === project))
    return no(400, "That project isn’t in Kuvo Code.");
  const looks = kit.looks;
  const pick = (list) => list[crypto13.randomInt(list.length)];
  const look = fitsLook(looks, given.look) ? botLook(given.look) : template?.look ?? { color: pick(looks.colors), shape: pick(looks.shapes), face: pick(looks.faces) };
  const model = isModel(given.model) ? botModel(given.model) : kit.startingModel;
  if (!model)
    return no(422, `There’s no model to start it on here: sign in to an account on ${HERE} first.`);
  const agents = runsWithAgents(model);
  let target;
  try {
    target = agents ? readBridge() : readEngine();
  } catch {}
  if (!target)
    return no(503, agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  if (!agents) {
    const refused = await signInRefusal(model, target, signal);
    if (refused)
      return no(422, refused);
  }
  const id = newID("bot_");
  const folder = path29.join(BOTS, id);
  const directory = project ?? path29.join(folder, "workspace");
  const discard = () => fs30.rmSync(folder, { recursive: true, force: true });
  let session;
  try {
    fs30.mkdirSync(path29.join(folder, "workspace"), { recursive: true });
    fs30.mkdirSync(path29.join(folder, "wakes"), { recursive: true });
    fs30.writeFileSync(path29.join(folder, "MEMORY.md"), kit.memory.replaceAll("⟦name⟧", name));
    const rules = [...kit.rules ?? [], { action: "external_directory", resource: path29.join(folder, "*"), effect: "allow" }];
    const made = await call(target, "POST", "/api/session", { title: name, location: { directory }, model, permissions: rules }, signal);
    if (typeof made?.id !== "string" || !made.id)
      throw new Error("No conversation was made.");
    session = { id: made.id };
    await call(target, "PATCH", `/api/session/${encodeURIComponent(session.id)}`, { metadata: { kuvo: { bot: id } } }, signal).catch(() => {});
    const told = botInstructions(kit, name, folder, personality?.instruction, project);
    await call(target, "PUT", `/api/experimental/session/${encodeURIComponent(session.id)}/instructions/entries/kuvo.bot`, { value: told }, signal);
    fs30.writeFileSync(path29.join(folder, "session"), session.id);
    noteTold(folder, { session: session.id, instructions: toldDigest(told), rules: folder });
    fs30.writeFileSync(path29.join(folder, "directory"), directory);
    if (kit.timeZone && !IS_MAC)
      fs30.writeFileSync(path29.join(folder, "timezone"), kit.timeZone);
    if (kit.zoneinfo && !IS_MAC)
      fs30.writeFileSync(path29.join(folder, "zoneinfo"), Buffer.from(kit.zoneinfo, "base64"));
    if (agents)
      fs30.writeFileSync(path29.join(folder, "via"), "bridge");
    const now = stamp();
    const described = { created: now, id, job: "", kuvo: DESCRIPTION, look, model, name, ...personality ? { personality: personality.id } : {}, ...project ? { project } : {}, updated: now };
    fs30.writeFileSync(path29.join(folder, "bot.json"), JSON.stringify(described, null, 2));
  } catch (error) {
    if (session?.id)
      await call(target, "DELETE", `/api/session/${encodeURIComponent(session.id)}`, undefined, signal).catch(() => {});
    discard();
    return no(503, `The bot couldn’t be made: ${error?.message ?? error}`);
  }
  const firstMessage = (template ? firstMessageOf(template.job, template.instructions) || null : null) ?? shared;
  if (!firstMessage)
    await call(target, "POST", `/api/session/${encodeURIComponent(session.id)}/synthetic`, { text: kit.greeting, description: "A new bot's first message" }, signal).catch(() => {});
  noteBotsChanged();
  const bot = listBots(machine).find((each) => each.id === id);
  return { status: 201, value: { bot, firstMessage: firstMessage ?? null } };
}

// Packages/Box/src/link/bots/edit.ts
async function changeBot(id, given, readEngine, readBridge, machine, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here)
    return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder))
    return no(409, MOVING);
  const kit = readKit();
  if (!kit)
    return no(409, NO_KIT);
  if (!isObject(given))
    return no(400, "That isn’t a change to a bot.");
  const { described } = here;
  const changed = { ...described };
  if ("name" in given) {
    changed.name = plainName(given.name);
    if (!changed.name)
      return no(400, "A bot needs a name.");
  }
  if ("look" in given) {
    if (!fitsLook(kit.looks, given.look))
      return no(400, "That isn’t a look a bot can have.");
    changed.look = botLook(given.look);
  }
  const personalities = botPersonalities(kit);
  if ("personality" in given) {
    if (given.personality === null)
      delete changed.personality;
    else if (personalities.some((each) => each.id === given.personality))
      changed.personality = given.personality;
    else
      return no(400, `There’s no personality “${given.personality}”.`);
  }
  let job;
  if ("job" in given) {
    const checked = givenJob(given.job);
    if (checked.error)
      return no(400, checked.error);
    job = checked.job;
  }
  if ("model" in given) {
    if (!isModel(given.model))
      return no(400, "That isn’t a model.");
    const model = botModel(given.model);
    if (!sameModel(model, described.model)) {
      if (runsWithAgents(model)) {
        if (!here.agents) {
          let agents = null;
          try {
            agents = readBridge();
          } catch {}
          const carried = await carryToAgents(here.session, model, readEngine, agents, signal);
          if (carried.status !== 200)
            return carried;
          Object.assign(here, botHere(id) ?? {});
        }
      } else {
        let engine;
        try {
          engine = readEngine();
        } catch {}
        if (!engine)
          return no(503, "The engine isn’t running.");
        const refused = await signInRefusal(model, engine, signal);
        if (refused)
          return no(422, refused);
      }
    }
    changed.model = model;
  }
  let target;
  try {
    target = here.agents ? readBridge() : readEngine();
  } catch {}
  if (!target)
    return no(503, here.agents ? `The coding agents aren’t running on ${HERE}.` : "The engine isn’t running.");
  const renamed = changed.name !== described.name;
  const was = jobOf(here);
  const newJob = job !== undefined && (job.line !== was.line || job.details !== was.details);
  const retold = renamed || changed.personality !== described.personality || newJob;
  const switched = !sameModel(changed.model, described.model);
  const looks = ["color", "shape", "face"].some((part) => changed.look?.[part] !== described.look?.[part]);
  if (retold || switched || looks) {
    if (renamed || switched || looks || changed.personality !== described.personality)
      changed.updated = stamp();
    try {
      if (newJob) {
        writeJob(here, job);
        changed.job = job.line;
      }
      const file = path30.join(here.folder, "bot.json");
      fs31.writeFileSync(`${file}.new`, JSON.stringify(changed, null, 2));
      fs31.renameSync(`${file}.new`, file);
      here.described = changed;
    } catch (error) {
      return no(503, `The bot couldn’t be changed: ${error?.message ?? error}`);
    }
    const session = encodeURIComponent(here.session);
    if (renamed)
      await call(target, "PATCH", `/api/session/${session}`, { title: changed.name }, signal).catch(() => {});
    if (switched && changed.model)
      await call(target, "POST", `/api/session/${session}/model`, { model: changed.model }, signal).catch(() => {});
    if (retold)
      await tellBot(target, here, here.session, toldNow(kit, here, changed), signal);
    noteBotsChanged();
  }
  return { status: 200, value: { bot: listBots(machine).find((each) => each.id === id) ?? null } };
}
var KEYS_LEFT_FILE = path30.join(RUN, "bot-keys-left.json");
function keysLeft() {
  try {
    const listed = JSON.parse(textOf(KEYS_LEFT_FILE) ?? "");
    return Array.isArray(listed?.bots) ? listed.bots.filter((each) => typeof each === "string" && /^bot_[A-Za-z0-9]+$/.test(each)) : [];
  } catch {
    return [];
  }
}
function noteKeysLeft(id, left) {
  const bots = keysLeft().filter((each) => each !== id);
  if (left)
    bots.push(id);
  try {
    fs31.mkdirSync(RUN, { recursive: true });
    if (!bots.length)
      return fs31.rmSync(KEYS_LEFT_FILE, { force: true });
    fs31.writeFileSync(`${KEYS_LEFT_FILE}.new`, JSON.stringify({ bots }));
    fs31.renameSync(`${KEYS_LEFT_FILE}.new`, KEYS_LEFT_FILE);
  } catch {}
}
async function forgetLeftKeys() {
  for (const id of keysLeft()) {
    if (botHere(id)) {
      noteKeysLeft(id, false);
      continue;
    }
    try {
      for (const name of await keyNames({ suffix: botVariable("", id) }))
        await deleteKey(name);
      noteKeysLeft(id, false);
    } catch {}
  }
}
var DELETED_FILE = path30.join(BOTS, "deleted.json");
function noteDeleted(id) {
  let kept = [];
  try {
    const listed = JSON.parse(textOf(DELETED_FILE) ?? "");
    if (Array.isArray(listed?.deleted))
      kept = listed.deleted.filter((each) => typeof each === "string" && each !== id);
  } catch {}
  fs31.mkdirSync(BOTS, { recursive: true });
  fs31.writeFileSync(`${DELETED_FILE}.new`, JSON.stringify({ deleted: [id, ...kept].slice(0, 500) }));
  fs31.renameSync(`${DELETED_FILE}.new`, DELETED_FILE);
}
async function deleteBot(id, readEngine, readBridge, signal) {
  const no = (status, message) => ({ status, value: { message } });
  const here = botHere(id);
  if (!here)
    return no(404, "That bot isn’t there any more.");
  if (isMoving(here.folder))
    return no(409, MOVING);
  let trashed;
  try {
    if (!IS_MAC)
      noteDeleted(id);
    const now = new Date;
    const two = (number) => String(number).padStart(2, "0");
    const when = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    const trash = path30.join(K, "trash", `${when}-${process.pid}`);
    fs31.mkdirSync(trash, { recursive: true });
    trashed = path30.join(trash, id);
    fs31.renameSync(here.folder, trashed);
  } catch (error) {
    return no(503, `The bot couldn’t be deleted: ${error?.message ?? error}`);
  }
  if (IS_MAC) {
    await hostTrash(trashed).catch(() => {});
    if (!fs31.existsSync(trashed))
      try {
        fs31.rmdirSync(path30.dirname(trashed));
      } catch {}
  }
  noteKeysLeft(id, true);
  await forgetLeftKeys();
  let agents;
  try {
    agents = readBridge();
  } catch {}
  if (agents) {
    const listed = await askGroups(agents, "GET", "", undefined, signal).catch(() => null);
    for (const chat of listed?.status === 200 && Array.isArray(listed.value?.data) ? listed.value.data : []) {
      const members = chat?.group?.members;
      if (!Array.isArray(members) || !members.includes(id))
        continue;
      await askGroups(agents, "PATCH", `/${encodeURIComponent(chat.group.id)}`, { members: members.filter((member) => member !== id) }, signal).catch(() => {});
    }
  }
  let target;
  try {
    target = here.agents ? agents : readEngine();
  } catch {}
  if (target)
    await call(target, "DELETE", `/api/session/${encodeURIComponent(here.session)}`, undefined, signal).catch(() => {});
  noteBotsChanged();
  return { status: 200, value: {} };
}

// Packages/Box/src/link/compat/adopt-settings.ts
import fs32 from "node:fs";
import path31 from "node:path";
var GLOBAL_FILE = path31.join(K, "config", "opencode", "opencode.json");
var MAC_SETTINGS = path31.join(K, "keys", "settings.json");
var MAC_KEYS = path31.join(K, "keys");
var LAUNCH_LOCK = path31.join(RUN, ".launching");
function boxKeyPaths(value) {
  if (typeof value === "string") {
    return value.split(`{file:${shownRoot}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`).split(`{file:${K}/keys/KUVO_KEY_`).join(`{file:${shownRoot}/box/keys/KUVO_KEY_`);
  }
  if (Array.isArray(value))
    return value.map(boxKeyPaths);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, boxKeyPaths(inner)]));
  return value;
}
function adoptBox(seed) {
  return locked(LAUNCH_LOCK, () => locked(CONFIG_LOCK, () => {
    if (fs32.existsSync(CONFIG_FILE)) {
      addDefaultRules();
      return { status: "own", settings: readSettings().settings ?? {} };
    }
    const global = readSettings(GLOBAL_FILE);
    const mac = readSettings(MAC_SETTINGS);
    const before = deepMerged(global.settings ?? {}, mac.settings ?? {});
    const seeded = !Object.keys(before).length && isObject(seed?.settings);
    const settings = boxKeyPaths(seeded ? seed.settings : before);
    fs32.mkdirSync(BOX_KEYS, { recursive: true, mode: 448 });
    fs32.chmodSync(BOX, 448);
    if (seeded) {
      for (const [name, value] of Object.entries(isObject(seed.keys) ? seed.keys : {})) {
        if (KEY_NAME.test(name) && typeof value === "string")
          writePrivate(path31.join(BOX_KEYS, name), value);
      }
    } else {
      let names = [];
      try {
        names = fs32.readdirSync(MAC_KEYS);
      } catch {}
      for (const name of names) {
        if (!KEY_NAME.test(name) || name.includes("__"))
          continue;
        try {
          writePrivate(path31.join(BOX_KEYS, name), fs32.readFileSync(path31.join(MAC_KEYS, name), "utf8"));
        } catch {}
      }
    }
    const kept = path31.join(BOX, "adopted-from");
    fs32.mkdirSync(kept, { recursive: true, mode: 448 });
    for (const [file, name] of [[GLOBAL_FILE, "opencode.json"], [MAC_SETTINGS, "settings.json"]]) {
      try {
        writePrivate(path31.join(kept, name), fs32.readFileSync(file, "utf8"));
      } catch {}
    }
    writePrivate(CONFIG_FILE, JSON.stringify(sortedKeys(settings), null, 2) + `
`);
    addDefaultRules();
    if (!global.problem)
      writePrivate(path31.join(BOX, "global-adopted"), "");
    const launchEnv = path31.join(RUN, "launch.env");
    try {
      const lines = fs32.readFileSync(launchEnv, "utf8").split(`
`).filter((line) => !/^KUVO_(PRIVATE_)?SETTINGS=/.test(line));
      writePrivate(launchEnv, lines.join(`
`));
    } catch {}
    return { status: "adopted", seeded, settings: readSettings().settings ?? settings };
  }, { stale: 300000, wait: 120000 }));
}

// Packages/Box/src/link/personalities/take.ts
import crypto14 from "node:crypto";
async function takePersonalities(given, readEngine = readEngineFile, readBridge = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const changed = meetPersonalities(given, file, lock);
  if (changed.length)
    await retellBots(changed, readEngine, readBridge).catch(() => {});
  return changed;
}
function takePersonalitiesDocument(body, readEngine = readEngineFile, readBridge = readBridgeFile, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const given = body?.document;
  if (!isObject(given) || !Array.isArray(given.personalities) || given.removed !== undefined && !Array.isArray(given.removed)) {
    return [400, { message: "Send a library of personalities: {document: {personalities, removed}}." }];
  }
  const changed = meetPersonalities(given, file, lock);
  if (changed.length) {
    noteDocsChanged();
    retellBots(changed, readEngine, readBridge).catch(() => {});
  }
  return [200, { changed }];
}
async function retellBots(ids, readEngine = readEngineFile, readBridge = readBridgeFile) {
  const kit = readKit();
  if (!kit)
    return;
  for (const here of listOf(BOTS).map(botHere)) {
    if (!here || !ids.includes(here.described.personality) || isMoving(here.folder))
      continue;
    let target = null;
    try {
      target = here.agents ? readBridge() : readEngine();
    } catch {}
    if (!target?.port)
      continue;
    await tellBot(target, here, here.session, toldNow(kit, here));
  }
}
function answerPersonalities(method, id, body, file = PERSONALITIES_FILE, lock = PERSONALITIES_LOCK) {
  const now = Date.now();
  const incomplete = [400, { message: "A personality needs a name and a description." }];
  const full = [400, { message: FULL_LIBRARY }];
  if (id === undefined) {
    if (method === "GET")
      return [200, { personalities: readPersonalities(file).personalities }];
    if (method !== "POST")
      return [405, {}];
    const made = keptPersonality({ id: `custom.${crypto14.randomUUID().toLowerCase()}`, name: body?.name, description: body?.description, updated: now });
    if (!made)
      return incomplete;
    let refused = false;
    changePersonalities((library) => {
      const after = { ...library, personalities: [...library.personalities, made] };
      if (fitsLibrary(after))
        return after;
      refused = true;
      return library;
    }, file, lock);
    if (refused)
      return full;
    noteDocsChanged();
    return [200, made];
  }
  if (!PERSONALITY_ID.test(id))
    return [404, {}];
  let found = null;
  if (method === "PATCH") {
    let refused = null;
    changePersonalities((library) => {
      const kept = library.personalities.find((each) => each.id === id);
      if (!kept)
        return library;
      const changed = keptPersonality({ ...kept, name: body?.name ?? kept.name, description: body?.description ?? kept.description, updated: kept.updated + 1 });
      if (!changed) {
        refused = incomplete;
        return library;
      }
      const after = { ...library, personalities: library.personalities.map((each) => each.id === id ? changed : each) };
      if (!fitsLibrary(after)) {
        refused = full;
        return library;
      }
      found = changed;
      return after;
    }, file, lock);
    if (refused)
      return refused;
    if (found)
      noteDocsChanged();
    return found ? [200, found] : [404, {}];
  }
  if (method === "DELETE") {
    changePersonalities((library) => {
      const kept = library.personalities.find((each) => each.id === id);
      if (!kept)
        return library;
      found = kept;
      return { personalities: library.personalities.filter((each) => each.id !== id), removed: [...library.removed, { id, removed: Math.max(now, kept.updated + 1) }] };
    }, file, lock);
    if (found)
      noteDocsChanged();
    return found ? [200, {}] : [404, {}];
  }
  return [405, {}];
}

// Packages/Box/src/link/documents/exchange.ts
var docParts = new Map;
function sendDocs(host, link, sends) {
  if (!host || !link?.key)
    return;
  for (const { to, docs } of sends ?? []) {
    for (const payload of docMails(docs)) {
      const bytes = mailFor(to, { docs: payload, at: Date.now() }, link);
      if (bytes)
        try {
          host.send(bytes);
        } catch {}
    }
  }
}
async function receiveDocs(sender, docs, host) {
  const before = readPersonalities();
  let work = null, library = before;
  const link = updateLink((link) => {
    if (!link)
      return null;
    const state = { link, library: before, parts: docParts };
    work = docsWork(state, sender, docs);
    library = state.library;
    return link;
  });
  if (!work || !link)
    return;
  await afterDocs(work, before, library, link, host);
}
async function afterDocs(work, before, library, link, host) {
  if (library !== before)
    await takePersonalities(library).catch(() => {});
  for (const mac of work.left)
    forgetMacsAgents(mac, link);
  host?.keepOnly?.(new Set((link.phones ?? []).map((phone) => phone.key)));
  writeAgents(link);
  sendDocs(host, link, work.send);
}
function docsChanged(host, { greet = false, tell = false } = {}) {
  const library = readPersonalities();
  let work = null;
  const link = updateLink((link) => {
    if (!link?.sign)
      return null;
    work = greet ? greetWork({ link, library }) : changedWork({ link, library }, tell);
    return link;
  });
  if (work && link) {
    if (!IS_MAC)
      host?.keepOnly?.(new Set((link.phones ?? []).map((phone) => phone.key)));
    sendDocs(host, link, work.send);
  }
}
function macDocsChanged() {
  const host = macLink.host;
  if (host?.welcomed)
    try {
      docsChanged(host);
    } catch {}
}

// Packages/Box/src/link/areas/accounts.ts
import fs33 from "node:fs";
import path32 from "node:path";
var ENDED_SIGN_INS_FILE = path32.join(RUN, "ended-sign-ins.json");
function readEndedSignIns() {
  try {
    const kept = JSON.parse(fs33.readFileSync(ENDED_SIGN_INS_FILE, "utf8"));
    return new Map(Object.entries(isObject(kept) ? kept : {}).filter(([, credential]) => typeof credential === "string"));
  } catch {
    return new Map;
  }
}
function changeEndedSignIns(change) {
  const ended = readEndedSignIns();
  change(ended);
  try {
    if (ended.size)
      writePrivate(ENDED_SIGN_INS_FILE, JSON.stringify(Object.fromEntries(ended)));
    else
      fs33.rmSync(ENDED_SIGN_INS_FILE, { force: true });
  } catch {}
}
async function noteSignIn(event, source) {
  const ended = event.type === "session.execution.failed";
  if (!ended && (event.type !== "session.step.ended" || !readEndedSignIns().size))
    return;
  if (ended && (event.data?.error?.type !== "provider.auth" || !String(event.data?.error?.message ?? "").startsWith("Request failed")))
    return;
  const id = event.data?.sessionID;
  if (typeof id !== "string")
    return;
  const provider = (await engineGet(source, `api/session/${encodeURIComponent(id)}`))?.data?.model?.providerID;
  if (typeof provider !== "string")
    return;
  if (!ended)
    return void changeEndedSignIns((each) => each.delete(provider));
  const active = await activeCredential(source, provider);
  if (active?.method === "oauth" && active.credentialID)
    changeEndedSignIns((each) => each.set(provider, active.credentialID));
}
async function activeCredential(engine, provider) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  return (Array.isArray(integrations) ? integrations : []).find((each) => each?.id === provider)?.connections?.find((each) => each?.type === "credential") ?? null;
}
async function endedProviders(engine) {
  const providers = [];
  for (const [provider, credential] of readEndedSignIns()) {
    if ((await activeCredential(engine, provider).catch(() => null))?.credentialID === credential)
      providers.push(provider);
  }
  return providers.sort();
}
async function forgetPlan(engine, id) {
  const integrations = (await engineGet(engine, "api/integration"))?.data;
  const plan = (Array.isArray(integrations) ? integrations : []).find((each) => each?.id === id);
  if (!plan || plan.metadata?.source === "mcp")
    return false;
  const entries = (await engineGet(engine, "api/credential"))?.data;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.integrationID !== id || typeof entry.id !== "string")
      continue;
    await fetch(`http://127.0.0.1:${engine.port}/api/credential/${encodeURIComponent(entry.id)}`, {
      method: "DELETE",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal: AbortSignal.timeout(1e4)
    }).then((response) => response.body?.cancel()).catch(() => {});
  }
  changeEndedSignIns((each) => each.delete(id));
  return true;
}
async function* accountsRoute(context) {
  const { request, route, readEngine, json } = context;
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  if (!engine?.port)
    return yield* json(503, { message: "The engine isn't running." });
  if (route === "kuvo/accounts/ended") {
    if (!["GET", "HEAD"].includes(request.method.toUpperCase()))
      return yield* json(405, {});
    return yield* json(200, { providers: await endedProviders(engine).catch(() => []) });
  }
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  let id = null;
  try {
    id = decodeURIComponent(route.slice("kuvo/accounts/".length, -"/forget".length));
  } catch {}
  if (!id || id.includes("/"))
    return yield* json(404, {});
  return yield* await forgetPlan(engine, id).catch(() => false) ? json(200, {}) : json(404, {});
}
async function* credentialsRoute(context) {
  const { request, signal, readEngine, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase()))
    return yield* text(405, "Read them with GET.");
  let engine;
  try {
    engine = readEngine();
  } catch {
    return yield* text(503, "The engine isn't running.");
  }
  let listed;
  try {
    const response = await fetch(`http://127.0.0.1:${engine.port}/api/credential`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
      signal
    });
    if (!response.ok)
      return yield* text(502, "The engine didn't answer.");
    listed = ((await response.json())?.data ?? []).map((credential) => ({
      id: String(credential.id),
      integrationID: String(credential.integrationID),
      label: String(credential.label ?? ""),
      active: Boolean(credential.active)
    }));
  } catch {
    return yield* text(502, "The engine didn't answer.");
  }
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ credentials: listed })) };
  return;
}

// Packages/Box/src/link/notices/news.ts
import path33 from "node:path";

// Packages/Box/src/link/notices/mask.ts
var SHOWN_LENGTH = 4000;
var HASH_NAMES = "commit|sha|sha1|sha256|sha512|md5|rev|revision|hash|ref|head|onto|checksum|digest|etag|integrity|fingerprint|cache[ _.-]?key|public[ _.-]?key|object|oid|tree|parent|blob|base|id|uuid|tag|build|version|release";
var eitherCase = (word) => [...word].map((letter) => /[a-z]/i.test(letter) ? `[${letter.toLowerCase()}${letter.toUpperCase()}]` : letter).join("");
var trimmedName = (prefix) => prefix.replace(/[\s:=>"'\]\\_-]+$/, "");
function isSecretName(prefix) {
  const name = trimmedName(prefix);
  const word = name.split(/[\s([{,;"'=/]+/).filter(Boolean).at(-1) ?? "";
  if (/secret|private|pass|pwd|token|credential/i.test(word))
    return true;
  return /key$/i.test(name) && !/(cache|public)[ _.-]?key$/i.test(name);
}
function namesHash(prefix) {
  if (prefix.endsWith(":")) {
    const before = prefix.slice(0, -1);
    const token = before.split(/\s+/).filter(Boolean).at(-1);
    if (token && /[/.]/.test(token) && before.length && !/\s/.test(before.at(-1)))
      return true;
  }
  return !isSecretName(prefix) && new RegExp(`(?:${HASH_NAMES})s?$`, "i").test(trimmedName(prefix));
}
var HEX_AFTER_NAME = /(?<=[A-Za-z0-9_])(?:\\?["'])?\]?[ \t]*(?::=|=>|[:=])[ \t]*(?:\\?["'])?([0-9a-fA-F]{32,})(?![0-9A-Za-z])/dg;
function maskedHexValues(text) {
  let result = text;
  for (const match of [...text.matchAll(HEX_AFTER_NAME)].reverse()) {
    const [start, end] = match.indices[1];
    const prefix = text.slice(Math.max(0, start - 32), start);
    if (namesHash(prefix))
      continue;
    result = result.slice(0, start) + "•••" + result.slice(end);
  }
  return result;
}
var HEX_PART = /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])/g;
function markingHashes(run, before) {
  let result = run;
  for (const hit of [...run.matchAll(HEX_PART)].reverse()) {
    const prefix = (before + run.slice(0, hit.index)).slice(-32);
    const isCommit = hit[0].length === 40 || hit[0].length === 64;
    let isHash;
    if (isCommit && (!prefix.length || /[\s/+"'([]/.test(prefix.at(-1))))
      isHash = true;
    else if (isCommit && prefix.endsWith("-"))
      isHash = !isSecretName(prefix);
    else
      isHash = namesHash(prefix);
    if (isHash)
      result = result.slice(0, hit.index) + "h" + result.slice(hit.index + hit[0].length);
  }
  return result;
}
var WORDS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g;
function cutShown(text) {
  const start = [...text].slice(0, SHOWN_LENGTH);
  let end = start.length;
  for (let index = start.length - 1;index >= Math.max(0, start.length - 100); index--) {
    if (!/[\p{L}\p{N}_\-+/=]/u.test(start[index])) {
      end = index;
      break;
    }
  }
  return start.slice(0, end).join("") + "…";
}
function maskedNamed(text) {
  const named = /((?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|authorization)["']?\s*[:=]\s*["']?(?=((?:bearer\s+|basic\s+|token\s+(?:token=)?["']?)?))\2|bearer\s+|(?<![\w-])--(?=\w)[\w-]{0,60}?(?:password|passwd|secret)[=\s]+(?!-))[^\s"'&;]{3,}/gi;
  text = text.replace(named, "$1•••");
  const flag = /((?<![\w-])--(?=\w)[\w-]{0,60}?(?<!(?:sort|foreign|partition|group|cache|order|index|range|lookup|hash)[-_])(?<!hot|turn|mon)(?:token|key)[=\s]+(?!-))(?![0-9][^\s"'&;]{0,7}(?:[\s"'&;]|$))[^\s"'&;]{3,}/gi;
  text = text.replace(flag, "$1•••");
  text = maskedHexValues(text);
  const token = /(token["']?\s*[:=]\s*["']?(?=((?:bearer\s+|basic\s+)?))\2)(?![0-9]+(?:[\s"'&;,}]|$))[^\s"'&;]{3,}/gi;
  text = text.replace(token, "$1•••");
  text = text.replace(/(:\/\/[^\s/:@]+:)[^\s/@]+@/g, "$1•••@");
  text = text.replace(/(:\/\/)[^\s/:@]{20,}@/g, "$1•••@");
  text = text.replace(/(\bcurl\b[^\n]*?\s(?:-u|--user)\s+[^\s:]+:)\S+/g, "$1•••");
  text = text.replace(/(secret[_-]?access[_-]?key\s+)\S+/gi, "$1•••");
  text = text.replace(/(hooks\.slack\.com\/services\/)[^\s"'<>]+/g, "$1•••");
  const mysql = new RegExp(`(\\b(?:${["mysql", "mariadb", "mysqldump", "mysqladmin"].map(eitherCase).join("|")})\\b[^\\n]*?\\s-p)\\S+`, "g");
  text = text.replace(mysql, "$1•••");
  return text;
}
var KEY_STARTS = /^(sk-|sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghs_|github_pat_|xox[abpe]-|AKIA|AIza|glpat-|dop_v1_|sbp_|pul-|npm_|hf_|gsk_|xai-|pplx-|r8_|lin_api_|ntn_|shp(at|ss|ca)_)/;
var IS_HASH = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
function masked(text) {
  text = maskedNamed([...text].length > SHOWN_LENGTH ? cutShown(text) : text);
  let result = "";
  let at = 0;
  for (const match of text.matchAll(/[A-Za-z0-9_\-+/=]{20,}/g)) {
    const run = match[0];
    const location = match.index;
    if (run.length < 24) {
      if (!/^(AKIA|ASIA)[0-9A-Z]{16}$/.test(run))
        continue;
      result += text.slice(at, location) + "•••";
      at = location + run.length;
      continue;
    }
    const prefixed = run.split("/").some((part) => KEY_STARTS.test(part));
    const isHash = IS_HASH.test(run);
    const before = text.slice(Math.max(0, location - 32), Math.max(0, location - 32) + Math.min(32, location));
    const plain = markingHashes(run, before).replace(/(?<![0-9A-Fa-f])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Fa-f])/g, "u").replace(/\/var\/folders\/[^/]+\/[^/]+/g, "/var/folders/t/t");
    const wordy = plain.split(/[/\-_.]/).filter((part) => part.length).every((part) => {
      if (part.length < 12)
        return true;
      if (/^[0-9]*[a-fA-F][0-9a-fA-F]*$/.test(part))
        return part.length < 20;
      return part.length / Math.max(1, (part.match(WORDS) ?? []).length) >= 3.5;
    });
    const mixed = /[A-Za-z]/.test(run) && /\d/.test(run);
    if (!(prefixed && mixed || mixed && !isHash && !wordy))
      continue;
    result += text.slice(at, location) + "•••";
    at = location + run.length;
  }
  return result + text.slice(at);
}
var showsAll = (text) => [...text].length <= SHOWN_LENGTH && masked(text) === text;

// Packages/Box/src/link/notices/news.ts
var plain = (text) => String(text ?? "").replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]+/gm, "").replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/(?<![\w*_])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\w*_])/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
function describePermission(request) {
  const what = { edit: "edit files", write: "edit files", patch: "edit files", shell: "run a command", bash: "run a command", read: "read a file", external_directory: "work outside the project", webfetch: "open a web page" }[request.action] ?? request.action;
  const shown = (Array.isArray(request.resources) ? request.resources : []).filter((each) => each !== "*");
  if (!shown.length)
    return `Wants to ${what}.`;
  const more = shown.length > 4 ? ` · and ${shown.length - 4} more` : "";
  return `Wants to ${what}: ${shown.slice(0, 4).join(" · ")}${more}`;
}
var showsAllCovered = (request) => (Array.isArray(request.resources) ? request.resources : []).filter((each) => each !== "*").length <= 4;
var singleQuestion = (form) => {
  if (form.metadata?.kind !== "question")
    return null;
  const fields = (form.fields ?? []).filter((field) => !field.hidden && !field.when?.length);
  return fields.length === 1 && fields[0].type === "string" ? fields[0] : null;
};
function describeForm(form) {
  const kind = form.metadata?.kind;
  if (kind === "mcp-elicitation")
    return form.metadata?.message || "Needs your answer.";
  if (kind !== "question")
    return "Needs your answer.";
  const fields = (form.fields ?? []).filter((field) => !field.hidden && !field.when?.length);
  if (fields.length === 1 && fields[0].type === "string")
    return fields[0].description || fields[0].title || form.title || "Has a question for you.";
  return "Has a question for you.";
}
var isBot = (session) => Boolean(session.metadata?.kuvo?.bot) || /\/bots\/bot_[^/]+\//.test(`${session.location?.directory ?? ""}/`);
var chatsFolder = () => IS_MAC ? path33.join(path33.dirname(K), "Chats") : path33.join(K, "chats");
function projectNameOf(directory) {
  if (!directory)
    return;
  if (directory === chatsFolder())
    return "Chats";
  const project = readWorktrees().find((each) => (each.folder ?? each.root) === directory || each.root === directory)?.project ?? readRemovedWorktrees()[directory] ?? directory;
  return readProjects().find((each) => each.directory === project)?.name || path33.basename(project) || undefined;
}
async function noticeFor(event, get) {
  const data = event.data ?? {};
  const session = async (id) => (await get(`api/session/${encodeURIComponent(id)}`)).data;
  const shown = async (id) => {
    let current = await session(id);
    for (let step = 0;step < 5 && current.parentID; step++)
      current = await session(current.parentID);
    return current;
  };
  const waitingOn = async (server, folder) => {
    if (!server)
      return null;
    const active = (await get("api/session/active").catch(() => null))?.data ?? {};
    const name = String(server).replace(/[^\p{L}\p{N}_-]/gu, "_");
    for (const id of Array.isArray(active) ? active : Object.keys(active)) {
      const candidate = await session(id).catch(() => null);
      if (!candidate || folder && candidate.location?.directory !== folder)
        continue;
      const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=8&order=desc`).catch(() => null);
      const steps = (page?.data ?? []).filter((message) => message.type === "assistant").flatMap((message) => message.content ?? []);
      if (steps.some((block) => block.type === "tool" && block.state?.status === "running" && (block.name?.startsWith(name + "_") || block.name === "execute" && String(block.state.input?.code ?? "").includes(server))))
        return id;
    }
    return null;
  };
  const about = (shown, category, body, extra = {}, { answerable = true, untitled = "New Session" } = {}) => {
    const bot = isBot(shown);
    return {
      title: shown.title || untitled,
      subtitle: bot ? undefined : projectNameOf(shown.location?.directory ?? ""),
      body,
      category,
      thread: shown.id,
      data: { session: shown.id, ...extra, ...answerable ? {} : { answerable: "0" } }
    };
  };
  switch (event.type) {
    case "permission.asked": {
      const where = await shown(data.sessionID);
      if (isHiddenRun(where))
        return null;
      const body = describePermission(data);
      return about(where, "permission", body, { request: data.id, ...where.id !== data.sessionID ? { requestSession: data.sessionID } : {} }, { answerable: showsAllCovered(data) && showsAll(body), untitled: "Kuvo Code" });
    }
    case "form.created": {
      const form = data.form ?? data;
      const asker = form.sessionID === "global" ? await waitingOn(form.metadata?.server, event.location?.directory) : form.sessionID;
      if (!asker)
        return null;
      const where = await shown(asker);
      if (isHiddenRun(where))
        return null;
      const body = describeForm(form);
      const choices = (singleQuestion(form)?.options ?? []).map((option) => String(option?.label ?? ""));
      return about(where, "question", body, { request: form.id, ...where.id !== form.sessionID ? { requestSession: form.sessionID } : {} }, { answerable: showsAll(body) && choices.every(showsAll), untitled: "Kuvo Code" });
    }
    case "session.execution.succeeded":
    case "session.execution.failed": {
      const id = data.sessionID;
      const ended = await session(id);
      if (ended.parentID || isHiddenRun(ended))
        return null;
      if (event.type === "session.execution.failed")
        return about(ended, "failed", "Stopped with an error.");
      let reply = "";
      try {
        const page = await get(`api/session/${encodeURIComponent(id)}/message?limit=6&order=desc`);
        for (const message of page.data ?? []) {
          if (message.type !== "assistant")
            continue;
          reply = plain((message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(" "));
          if (reply)
            break;
        }
      } catch {}
      return about(ended, isBot(ended) ? "report" : "finished", reply ? cut(reply, 220) : "Finished.");
    }
    default:
      return null;
  }
}
async function settleHeld(engine, hold) {
  for (const entry of [...hold.held]) {
    const { request, requestSession, session } = entry.notice?.data ?? {};
    const kind = { permission: "permission", question: "form" }[entry.notice?.category];
    if (!kind || typeof request !== "string" || typeof (requestSession ?? session) !== "string" || (requestSession ?? session) === "global")
      continue;
    const asked = (await engineGet(engine, `api/session/${encodeURIComponent(requestSession ?? session)}/${kind}`).catch(() => null))?.data;
    if (Array.isArray(asked) && !asked.some((each) => each?.id === request))
      hold.resolve(request);
  }
}
var NEWS = new Set(["permission.asked", "form.created", "session.execution.succeeded", "session.execution.failed"]);
var GROUP_NEWS = new Set(["kuvo.group.met", "kuvo.group.done"]);
var ANSWERED = new Set(["permission.replied", "form.replied", "form.cancelled"]);
function groupNotice(event) {
  const data = event.data ?? {};
  if (typeof data.id !== "string")
    return null;
  const about = { title: String(data.name ?? ""), category: "message", thread: data.id, data: { group: data.id } };
  if (event.type === "kuvo.group.met") {
    if (!data.last)
      return { ...about, body: "The meeting came, but no one could take part." };
    const who = data.who ? data.last.kind === "wrapUp" ? `${data.who}’s wrap-up` : String(data.who) : undefined;
    return { ...about, subtitle: who, body: cut(plain(data.last.text), 220) };
  }
  if (event.type === "kuvo.group.done")
    return { ...about, subtitle: `${data.who} finished its part`, body: cut(plain(data.text), 220) };
  return null;
}

// Packages/Box/src/link/engine/watch.ts
async function* serverEvents(body) {
  const decoder = new TextDecoder;
  let buffer = "";
  let data = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf(`
`)) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, "");
      buffer = buffer.slice(end + 1);
      if (line === "") {
        if (data.length) {
          try {
            yield JSON.parse(data.join(`
`));
          } catch {}
        }
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}
var STEER_AFTER = 3000;
function steering(background, { after = STEER_AFTER, now = Date.now, schedule = setTimeout, cancel = clearTimeout, signal } = {}) {
  const sessions = new Map;
  const users = new Set;
  const timers = new Map;
  const of = (session) => {
    if (!sessions.has(session))
      sessions.set(session, { names: new Map, blocking: new Map, steers: new Set });
    return sessions.get(session);
  };
  const forget = (session) => {
    sessions.delete(session);
    cancel(timers.get(session));
    timers.delete(session);
  };
  signal?.addEventListener("abort", () => {
    for (const session of [...timers.keys()])
      forget(session);
  }, { once: true });
  const consider = (session) => {
    const { blocking, steers } = of(session);
    if (!blocking.size || !steers.size || timers.has(session) || signal?.aborted)
      return;
    const due = Math.min(...blocking.values()) + after;
    timers.set(session, schedule(() => {
      timers.delete(session);
      const { blocking, steers } = of(session);
      if (!blocking.size || !steers.size)
        return;
      if (Math.min(...blocking.values()) + after > now())
        return consider(session);
      background(session);
      timers.set(session, schedule(() => {
        timers.delete(session);
        consider(session);
      }, after));
    }, Math.max(0, due - now())));
  };
  const steer = (session, inbox) => {
    of(session).steers.add(inbox);
    consider(session);
  };
  return (event) => {
    const data = event?.data ?? {};
    const session = data.sessionID;
    if (typeof session !== "string")
      return;
    switch (event.type) {
      case "session.tool.input.started":
        if (typeof data.id === "string")
          of(session).names.set(data.id, data.name);
        break;
      case "session.tool.called": {
        const kept = of(session);
        const name = data.name ?? kept.names.get(data.id);
        kept.names.delete(data.id);
        if (!["shell", "subagent"].includes(name) || data.input?.background === true)
          break;
        kept.blocking.set(data.id, now());
        consider(session);
        break;
      }
      case "session.tool.success":
      case "session.tool.failed":
        sessions.get(session)?.names.delete(data.id);
        sessions.get(session)?.blocking.delete(data.id);
        break;
      case "session.inbox.enqueued":
        if (data.item?.type !== "user")
          break;
        users.add(data.inboxID);
        if (data.item.delivery === "steer")
          steer(session, data.inboxID);
        break;
      case "session.inbox.delivery.changed":
        if (data.delivery === "steer" && users.has(data.inboxID))
          steer(session, data.inboxID);
        else
          sessions.get(session)?.steers.delete(data.inboxID);
        break;
      case "session.inbox.delivered":
      case "session.inbox.cancelled":
        users.delete(data.inboxID);
        sessions.get(session)?.steers.delete(data.inboxID);
        break;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        forget(session);
        break;
    }
  };
}
function backgroundTools(engine, session) {
  return fetch(`http://127.0.0.1:${engine.port}/api/session/${encodeURIComponent(session)}/background`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`opencode:${engine.password}`).toString("base64")}` },
    signal: AbortSignal.timeout(1e4)
  });
}
function watchBox({ tell = () => true, hold = null, bots = false, notices = !bots, signal, signedIn } = {}) {
  const answered = (id) => hold?.resolve(id);
  watchEvents(readEngineFile, tell, signal, answered, { bots, notices, signIns: true, hold, signedIn, steers: true });
  watchEvents(readBridgeFile, tell, signal, answered, { bots, notices });
}
async function watchEvents(read, tell, signal, answered = () => {}, { bots = false, notices = !bots, signIns = false, hold = null, signedIn = () => {}, steers = false, steerAfter } = {}) {
  let attempt = 0;
  while (!signal?.aborted) {
    const connection = new AbortController;
    const stop = () => connection.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const source = read();
      const steer = steers ? steering((session) => backgroundTools(source, session).catch(() => {}), { after: steerAfter, signal: connection.signal }) : null;
      const response = await fetch(`http://127.0.0.1:${source.port}/api/event`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${source.password}`).toString("base64")}`, accept: "text/event-stream" },
        signal
      });
      if (!response.ok || !response.body)
        throw new Error(`${response.status}`);
      attempt = 0;
      if (notices && hold)
        settleHeld(source, hold).catch(() => {});
      freshenBots(source).catch(() => {});
      for await (const event of serverEvents(response.body)) {
        if (event.type === "session.execution.started")
          freshenBot(source, event.data?.sessionID).catch(() => {});
        steer?.(event);
        if (signIns)
          noteSignIn(event, source).catch(() => {}).finally(() => signedIn(event));
        if (!bots) {
          if (event.type === "session.created")
            tellWorktree(source, event.data?.sessionID ?? event.data?.info?.id).catch(() => {});
          if (event.type === "session.renamed")
            nameWorktreeBranch(source, event.data?.sessionID).catch(() => {});
        }
        if (!notices)
          continue;
        if (ANSWERED.has(event.type))
          answered(event.data?.requestID ?? event.data?.id);
        if (!NEWS.has(event.type) && !GROUP_NEWS.has(event.type))
          continue;
        if (GROUP_NEWS.has(event.type)) {
          const notice = groupNotice(event);
          if (notice)
            tell(notice);
          continue;
        }
        noticeFor(event, (route) => engineGet(source, route)).then((notice) => notice && tell(notice)).catch(() => {});
      }
    } catch {}
    stop();
    signal?.removeEventListener("abort", stop);
    attempt += 1;
    await pause(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)), signal);
  }
}

// Packages/Box/src/link/keeper.ts
import { spawn as spawn3 } from "node:child_process";
import fs35 from "node:fs";
import path35 from "node:path";

// Packages/Box/src/link/vault/store.ts
import crypto15 from "node:crypto";
import fs34 from "node:fs";
import path34 from "node:path";

// Packages/Box/src/shared/routes/vault.ts
var ITEM_KINDS = ["login", "key", "file", "note"];
var GRANT_HOWS = ["own", "ask"];
var VAULT_ITEM = object({
  id: string,
  kind: words(...ITEM_KINDS),
  name: string,
  sites: list(string),
  "username?": string,
  fields: list(string),
  "fileName?": string,
  "readable?": bool,
  "signInOnly?": bool,
  created: number,
  changed: number,
  "used?": number
});
var VAULT_WHO = object({ "bot?": string, "project?": string, "everyone?": bool });
var VAULT_GRANT = object({ item: string, who: VAULT_WHO, how: words(...GRANT_HOWS), at: number });
var VAULT_STATE = object({
  made: bool,
  locked: bool,
  paused: bool,
  pausedBots: map(string),
  store: words("keychain", "encrypted"),
  keptDays: number,
  "tampered?": bool
});
var VAULT = object({ state: VAULT_STATE, items: list(VAULT_ITEM), grants: list(VAULT_GRANT) });
var VAULT_ITEM_ANSWER = object({ item: VAULT_ITEM, "key?": string });
var VAULT_VALUES = object({ values: map(string) });
var VAULT_GRANTS = object({ grants: list(VAULT_GRANT) });
var VAULT_ACTIVITY = object({
  id: string,
  at: number,
  what: words("used", "asked", "allowed", "declined", "refused", "added", "changed", "removed", "granted", "ungranted", "paused", "resumed", "shown"),
  "item?": string,
  "itemName?": string,
  "kind?": words(...ITEM_KINDS),
  "bot?": string,
  "botName?": string,
  "session?": string,
  "sessionName?": string,
  "client?": string,
  "site?": string,
  "program?": string,
  "how?": string,
  "why?": string
});
var VAULT_ACTIVITIES = object({ entries: list(VAULT_ACTIVITY) });
var VAULT_ASK = object({
  id: string,
  kind: words("use", "item"),
  at: number,
  "session?": string,
  "sessionName?": string,
  "bot?": string,
  "botName?": string,
  "item?": string,
  "itemName?": string,
  "need?": string,
  "why?": string,
  "site?": string,
  "machine?": string
});
var VAULT_ASKS = object({ asks: list(VAULT_ASK) });
var VAULT_KEY = object({ key: string });
var VAULT_TOOL_LIST = object({ tools: list(any) });
var VAULT_TOOL = object({ text: string, isError: bool });
var VAULT_FILL = object({ item: object({ id: string, name: string }), "username?": string, values: map(string) });

// Packages/Box/src/link/vault/store.ts
var VAULT_FOLDER = path34.join(BOX, "vault");
var ITEMS = path34.join(VAULT_FOLDER, "items.json");
var GRANTS = path34.join(VAULT_FOLDER, "grants.json");
var PAUSED = path34.join(VAULT_FOLDER, "paused.json");
var KEY_FILE = path34.join(VAULT_FOLDER, "key.json");
var VALUES = path34.join(VAULT_FOLDER, "values");
var LOCK2 = path34.join(RUN, ".vault.lock");
var KEPT_DAYS = 365;

class VaultRefusal extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
var LOCKED = "This computer's vault is locked since it started again. Open Kuvo Code on your Mac or iPhone to unlock it.";
var storeKey = null;
var unlockKey = null;
var readJSON = (file, fallback) => {
  try {
    return JSON.parse(fs34.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
var TAMPERED = "The vault's files were changed outside Kuvo Code, so it uses none of them. Add its items again.";
var fileKey = () => {
  if (onHost())
    return MAC_VAULT_FILE_KEY;
  return storeKey ? crypto15.createHmac("sha256", storeKey).update("kuvo-vault-files").digest() : null;
};
var signatureOf = (key, file, data) => crypto15.createHmac("sha256", key).update(`${path34.basename(file)}\x00${JSON.stringify(data)}`).digest("base64url");
var tampered = new Set;
function readSigned(file, fallback) {
  const kept = readJSON(file, null);
  if (!kept)
    return fallback;
  const key = fileKey();
  if (!key)
    return fallback;
  const given = Buffer.from(typeof kept.sig === "string" ? kept.sig : "");
  const expected = Buffer.from(signatureOf(key, file, kept.data));
  if (kept.data === undefined || given.length !== expected.length || !crypto15.timingSafeEqual(given, expected)) {
    tampered.add(file);
    return fallback;
  }
  return kept.data;
}
function keepSigned(file, data) {
  const key = fileKey();
  if (!key)
    throw onHost() ? new VaultRefusal(503, "Kuvo Code on this Mac didn't give its vault its key. Quit Kuvo Code and open it again.") : new VaultRefusal(423, LOCKED);
  keepJSON(file, { v: 2, data, sig: signatureOf(key, file, data) });
  tampered.delete(file);
}
var keepJSON = (file, value) => {
  fs34.mkdirSync(path34.dirname(file), { recursive: true, mode: 448 });
  writePrivate(file, JSON.stringify(value, null, 1) + `
`);
};
var vaultWork = (work) => {
  fs34.mkdirSync(RUN, { recursive: true, mode: 448 });
  return locked(LOCK2, work);
};
var onHost = () => KEYS_ON_HOST;
var isMade = () => onHost() || fs34.existsSync(KEY_FILE);
var isLocked = () => !onHost() && isMade() && !storeKey;
var sealed = (key, plain, aad) => {
  const iv = crypto15.randomBytes(12);
  const cipher = crypto15.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
};
var opened = (key, text, aad) => {
  const all = Buffer.from(text, "base64");
  const decipher = crypto15.createDecipheriv("aes-256-gcm", key, all.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(all.subarray(12, 28));
  return Buffer.concat([decipher.update(all.subarray(28)), decipher.final()]);
};
var checkOf = (key) => crypto15.createHmac("sha256", key).update("kuvo-vault-check").digest("base64");
function makeVault() {
  if (onHost())
    throw new VaultRefusal(409, "This Mac's vault is its Keychain: there's nothing to make.");
  return vaultWork(() => {
    if (fs34.existsSync(KEY_FILE))
      throw new VaultRefusal(409, "This computer has a vault already.");
    const store = crypto15.randomBytes(32);
    const unlock = crypto15.randomBytes(32);
    keepJSON(KEY_FILE, { v: 1, wrapped: sealed(unlock, store, "kuvo-vault-key"), check: checkOf(unlock) });
    storeKey = store;
    unlockKey = unlock;
    return unlock.toString("base64url");
  });
}
function unlockWith(given) {
  if (onHost() || typeof given !== "string" || !given)
    return false;
  const key = Buffer.from(given, "base64url");
  if (key.length !== 32)
    return false;
  if (unlockKey)
    return crypto15.timingSafeEqual(key, unlockKey);
  const kept = readJSON(KEY_FILE, null);
  if (typeof kept?.wrapped !== "string" || typeof kept?.check !== "string")
    return false;
  const check = Buffer.from(checkOf(key));
  const expected = Buffer.from(kept.check);
  if (check.length !== expected.length || !crypto15.timingSafeEqual(check, expected))
    return false;
  try {
    storeKey = opened(key, kept.wrapped, "kuvo-vault-key");
    unlockKey = key;
    return true;
  } catch {
    return false;
  }
}
var unlockProof = (tag, nonce, key = unlockKey) => key ? crypto15.createHmac("sha256", key).update(`kuvo-vault-${tag}\x00${nonce}`).digest("base64url") : null;
function provesUnlock(tag, nonce, given) {
  const expected = unlockProof(tag, nonce);
  if (!expected || typeof given !== "string" || given.length !== expected.length)
    return false;
  return crypto15.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
var currentUnlockKey = () => unlockKey ? unlockKey.toString("base64url") : null;
var host = () => {
  const found = appHost();
  if (!found)
    throw new VaultRefusal(503, NOT_ANSWERING);
  return found;
};
var asHost = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof KeysUnavailable)
      throw new VaultRefusal(503, error.message);
    throw error;
  }
};
var checkedID = (id) => {
  if (!/^v_[a-z0-9]{10}$/.test(id))
    throw new VaultRefusal(400, "That isn't an item.");
  return id;
};
async function valuesOf(id) {
  checkedID(id);
  if (onHost()) {
    const answer = await asHost(() => askHost(host(), "vault/get", { id }, true));
    const values = answer?.values;
    if (!isObject(values))
      return {};
    return Object.fromEntries(Object.entries(values).filter((entry) => typeof entry[1] === "string"));
  }
  if (!storeKey)
    throw new VaultRefusal(423, LOCKED);
  const text = textOf(path34.join(VALUES, id));
  if (!text)
    return {};
  try {
    return JSON.parse(opened(storeKey, text, id).toString("utf8"));
  } catch {
    throw new VaultRefusal(409, "This item's values can't be read: they were changed outside Kuvo Code.");
  }
}
async function keepValues(id, values) {
  if (onHost())
    return void await asHost(() => askHost(host(), "vault/set", { id, values }));
  if (!storeKey)
    throw new VaultRefusal(423, LOCKED);
  fs34.mkdirSync(VALUES, { recursive: true, mode: 448 });
  writePrivate(path34.join(VALUES, id), sealed(storeKey, Buffer.from(JSON.stringify(values)), id));
}
async function dropValues(id) {
  if (onHost())
    return void await asHost(() => askHost(host(), "vault/delete", { id }));
  fs34.rmSync(path34.join(VALUES, id), { force: true });
}
var readItems = () => readSigned(ITEMS, []);
var keepItems = (items) => keepSigned(ITEMS, items);
var itemByID = (id) => readItems().find((item) => item.id === id);
function itemNamed(named) {
  if (typeof named !== "string" || !named.trim())
    return null;
  const items = readItems();
  const wanted = named.trim().toLowerCase();
  return items.find((item) => item.id === named.trim()) ?? items.find((item) => item.name.toLowerCase() === wanted) ?? null;
}
function siteOf(given) {
  if (typeof given !== "string")
    return null;
  let text = given.trim().toLowerCase();
  if (!text)
    return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text))
    text = "https://" + text;
  try {
    const host = new URL(text).hostname.replace(/\.$/, "");
    return /^[a-z0-9.-]+$/.test(host) && /[a-z0-9]/.test(host) ? host : null;
  } catch {
    return null;
  }
}
var usableOn = (item, host) => item.sites.some((site) => host === site || site.includes(".") && host.endsWith("." + site));
var FIELD = /^[a-z][a-z0-9_]{0,39}$/;
var SHORTEST_VALUE = 4;
function givenValues(given, change) {
  if (given == null)
    return {};
  if (!isObject(given))
    throw new VaultRefusal(400, 'Send the values as {"field": "value"}.');
  const values = {};
  for (const [field, value] of Object.entries(given)) {
    if (!FIELD.test(field))
      throw new VaultRefusal(400, `“${oneLine(field, 40)}” isn't a field's name: use lowercase letters, digits and _.`);
    if (value === null && change)
      values[field] = null;
    else if (typeof value === "string" && value.length < SHORTEST_VALUE)
      throw new VaultRefusal(400, `A value needs at least ${SHORTEST_VALUE} characters, so it can be hidden from agents.`);
    else if (typeof value === "string" && value.length <= 1e6)
      values[field] = value;
    else
      throw new VaultRefusal(400, "A value is text, at most a megabyte.");
  }
  return values;
}
function givenSites(given) {
  if (given == null)
    return [];
  if (!Array.isArray(given))
    throw new VaultRefusal(400, "Send its sites as a list.");
  const sites = [];
  for (const each of given) {
    const site = siteOf(each);
    if (!site)
      throw new VaultRefusal(400, `“${oneLine(each, 80)}” isn't a site.`);
    if (!sites.includes(site))
      sites.push(site);
  }
  return sites;
}
var cleanName = (given) => {
  const name = oneLine(typeof given === "string" ? given : "", 120).trim();
  if (!name)
    throw new VaultRefusal(400, "Give it a name.");
  return name;
};
var itemQueue = Promise.resolve();
var oneAtATime2 = (work) => {
  const run = itemQueue.then(work, work);
  itemQueue = run.catch(() => {});
  return run;
};
var addItem = (given) => oneAtATime2(() => addOne(given));
var changeItem = (id, given) => oneAtATime2(() => changeOne(id, given));
var removeItem = (id) => oneAtATime2(() => removeOne(id));
async function addOne(given) {
  if (!ITEM_KINDS.includes(given.kind))
    throw new VaultRefusal(400, `An item is one of: ${ITEM_KINDS.join(", ")}.`);
  const kind = given.kind;
  const name = cleanName(given.name);
  if (readItems().some((item) => item.name.toLowerCase() === name.toLowerCase()))
    throw new VaultRefusal(409, `There's an item called “${name}” already.`);
  const sites = givenSites(given.sites);
  if (kind === "login" && !sites.length)
    throw new VaultRefusal(400, "A sign-in needs the site it's for.");
  const values = Object.fromEntries(Object.entries(givenValues(given.values, false)).filter((entry) => entry[1] !== null));
  const now = Date.now();
  const item = {
    id: newID("v_"),
    kind,
    name,
    sites,
    ...typeof given.username === "string" && given.username.trim() ? { username: oneLine(given.username, 200).trim() } : {},
    fields: Object.keys(values).sort(),
    ...kind === "file" && typeof given.fileName === "string" && given.fileName.trim() ? { fileName: path34.basename(oneLine(given.fileName, 200).trim()) } : {},
    ...kind === "note" && given.readable === true ? { readable: true } : {},
    ...kind === "login" && given.signInOnly === true ? { signInOnly: true } : {},
    created: now,
    changed: now
  };
  await keepValues(item.id, values);
  vaultWork(() => keepItems([...readItems(), item]));
  return item;
}
async function changeOne(id, given) {
  checkedID(id);
  const before = itemByID(id);
  if (!before)
    throw new VaultRefusal(404, "That item isn't in this vault.");
  const item = { ...before, changed: Date.now() };
  if (given.name !== undefined) {
    item.name = cleanName(given.name);
    if (readItems().some((other) => other.id !== id && other.name.toLowerCase() === item.name.toLowerCase()))
      throw new VaultRefusal(409, `There's an item called “${item.name}” already.`);
  }
  if (given.sites !== undefined) {
    item.sites = givenSites(given.sites);
    if (item.kind === "login" && !item.sites.length)
      throw new VaultRefusal(400, "A sign-in needs the site it's for.");
  }
  if (given.username !== undefined) {
    if (typeof given.username === "string" && given.username.trim())
      item.username = oneLine(given.username, 200).trim();
    else
      delete item.username;
  }
  if (given.fileName !== undefined && item.kind === "file") {
    if (typeof given.fileName === "string" && given.fileName.trim())
      item.fileName = path34.basename(oneLine(given.fileName, 200).trim());
    else
      delete item.fileName;
  }
  if (given.readable !== undefined && item.kind === "note") {
    if (given.readable === true)
      item.readable = true;
    else
      delete item.readable;
  }
  if (given.signInOnly !== undefined && item.kind === "login") {
    if (given.signInOnly === true)
      item.signInOnly = true;
    else
      delete item.signInOnly;
  }
  const changes = givenValues(given.values, true);
  if (Object.keys(changes).length) {
    const values = { ...await valuesOf(id) };
    for (const [field, value] of Object.entries(changes)) {
      if (value === null)
        delete values[field];
      else
        values[field] = value;
    }
    await keepValues(id, values);
    item.fields = Object.keys(values).sort();
  }
  vaultWork(() => keepItems(readItems().map((each) => each.id === id ? { ...item, ...each.used ? { used: each.used } : {} } : each)));
  return item;
}
async function removeOne(id) {
  checkedID(id);
  const item = itemByID(id);
  if (!item)
    throw new VaultRefusal(404, "That item isn't in this vault.");
  await dropValues(id);
  vaultWork(() => {
    keepItems(readItems().filter((each) => each.id !== id));
    keepSigned(GRANTS, readGrants().filter((grant) => grant.item !== id));
  });
  return item;
}
var noteUsed = (id) => vaultWork(() => keepItems(readItems().map((item) => item.id === id ? { ...item, used: Date.now() } : item)));
var readGrants = () => readSigned(GRANTS, []);
function givenWho(given) {
  if (!isObject(given))
    return null;
  if (typeof given.bot === "string" && /^bot_[A-Za-z0-9]+$/.test(given.bot))
    return { bot: given.bot };
  if (typeof given.project === "string" && given.project.startsWith("/"))
    return { project: path34.resolve(given.project) };
  if (given.everyone === true)
    return { everyone: true };
  return null;
}
var sameWho = (a, b) => a.bot === b.bot && a.project === b.project && Boolean(a.everyone) === Boolean(b.everyone);
function setGrant(itemID, who, how) {
  checkedID(itemID);
  if (!itemByID(itemID))
    throw new VaultRefusal(404, "That item isn't in this vault.");
  if (how !== null && !GRANT_HOWS.includes(how))
    throw new VaultRefusal(400, "A grant is “own” (on its own) or “ask” (asks each time), or null to take it away.");
  return vaultWork(() => {
    const grants = readGrants().filter((grant) => !(grant.item === itemID && sameWho(grant.who, who)));
    if (how !== null)
      grants.push({ item: itemID, who, how, at: Date.now() });
    keepSigned(GRANTS, grants);
    return grants;
  });
}
var readPaused = () => {
  if (!fs34.existsSync(PAUSED))
    return {};
  return readSigned(PAUSED, { all: true });
};
function setPaused(paused, who, why = "Paused by you.") {
  vaultWork(() => {
    const now = fs34.existsSync(PAUSED) ? readSigned(PAUSED, {}) : {};
    if (who) {
      const bots = { ...now.bots ?? {} };
      if (paused)
        bots[who] = oneLine(why, 300);
      else
        delete bots[who];
      keepSigned(PAUSED, { ...now, bots });
    } else {
      keepSigned(PAUSED, { ...now, all: paused });
    }
  });
}
function pausedFor(bot, root) {
  const now = readPaused();
  if (now.all)
    return tampered.has(PAUSED) ? TAMPERED : "The user paused the vault on this computer.";
  if (bot && now.bots?.[bot])
    return `The user paused this bot's use of the vault: ${now.bots[bot]}`;
  if (root && now.bots?.[root])
    return `The user paused this conversation's use of the vault: ${now.bots[root]}`;
  return null;
}
function vaultState() {
  const paused = readPaused();
  return {
    made: isMade(),
    locked: isLocked(),
    paused: Boolean(paused.all),
    pausedBots: { ...paused.bots ?? {} },
    store: onHost() ? "keychain" : "encrypted",
    keptDays: KEPT_DAYS,
    ...tampered.size ? { tampered: true } : {}
  };
}

// Packages/Box/src/link/keeper.ts
var isBridge = (pid) => pid !== process.pid && processRuns(pid, "kuvo-link.js");
var needed = (link) => Boolean(link && ((link.phones ?? []).length || link.pairing && Date.now() < link.pairing.expires || peersOf(link).length)) || isMade();
function noLongerNeeded() {
  try {
    fs35.rmSync(NEEDED_FILE, { force: true });
  } catch {}
  if (needed(readLink()))
    try {
      fs35.writeFileSync(NEEDED_FILE, "", { mode: 384 });
    } catch {}
}
function keepKeeper() {
  let start = path35.join(K, "bin", "kuvo-start");
  if (!fs35.existsSync(start))
    return;
  const copy = path35.join(K, "bin", ".kuvo-start-keeper");
  if (!/\nkeep\)/.test(textOf(start) ?? "") && fs35.existsSync(copy))
    start = copy;
  let keeper = null;
  try {
    keeper = Number(fs35.readFileSync(path35.join(RUN, "box.pid"), "utf8"));
  } catch {}
  if (keeper && processRuns(keeper, "kuvo-start"))
    return;
  const environment = { ...process.env };
  delete environment.BUN_BE_BUN;
  delete environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  try {
    spawn3("sh", [start], { cwd: K, env: environment, detached: true, stdio: "ignore" }).unref();
  } catch {}
}
function runningBridge() {
  try {
    const pid = Number(fs35.readFileSync(PID_FILE, "utf8"));
    return isBridge(pid) ? pid : null;
  } catch {
    return null;
  }
}
function startBridge() {
  const workspace = path35.join(K, "workspace");
  const child = spawn3(process.execPath, [SCRIPT, "run"], {
    detached: true,
    stdio: "ignore",
    cwd: fs35.existsSync(workspace) ? workspace : K,
    env: process.env
  });
  child.unref();
}

// Packages/Box/src/link/letters/outbox.ts
import crypto16 from "node:crypto";
import fs36 from "node:fs";
import path36 from "node:path";
var introducing = new Map;
var REPLIES = path36.join(RUN, "replies");
var LETTER_BYTES = 24000;
var RELAY_GONE_AFTER = 5 * 60000;
var macWaiting = new Map;
function reply(id, value) {
  if (IS_MAC)
    return void macWaiting.get(id)?.done(value);
  try {
    fs36.mkdirSync(REPLIES, { recursive: true, mode: 448 });
    writePrivate(path36.join(REPLIES, `${id}.json`), JSON.stringify(value));
  } catch {}
}
function leaveLetter(letter, now = Date.now()) {
  try {
    fs36.mkdirSync(SENDING, { recursive: true, mode: 448 });
    const id = "ltr_" + crypto16.randomBytes(16).toString("base64url");
    writePrivate(path36.join(SENDING, `${id}.json`), JSON.stringify({ ...letter, wait: false, at: now }));
  } catch {}
}
var leaveAnswer = (letter) => leaveLetter(letter);
function letterWent(sender, { id, ok, why, retry, answer }) {
  if (!LETTER_ID.test(id))
    return;
  const file = path36.join(SENDING, `${id}.json`);
  let letter = null;
  try {
    letter = JSON.parse(fs36.readFileSync(file, "utf8"));
  } catch {
    return;
  }
  if (letter?.sentTo !== sender.key)
    return;
  if (!ok && retry === true && (isObject(letter.seat) || Date.now() - (letter.at ?? 0) < LETTER_MEMORY))
    return;
  if (!ok && isObject(letter.seat))
    return void giveUpSeat(id, letter);
  letterTries.delete(id);
  const words = typeof why === "string" ? why.slice(0, 500) : null;
  if (ok && letter.wait === true && answer !== false) {
    const waiter = IS_MAC ? macWaiting.get(id) : null;
    if (waiter) {
      waiter.sentTo = sender.key;
      fs36.rmSync(file, { force: true });
      return;
    }
    if (!IS_MAC)
      try {
        fs36.mkdirSync(REPLIES, { recursive: true, mode: 448 });
        fs36.renameSync(file, path36.join(REPLIES, `${id}.wait`));
        return;
      } catch {}
  }
  fs36.rmSync(file, { force: true });
  if (letter.wait !== true)
    return;
  if (!ok)
    reply(id, { failed: words ?? "It wasn't delivered." });
  else if (answer === false)
    reply(id, { note: words ?? "It got your message, but its answer can't come back to you here." });
}
function answered(sender, { answers: id, text, from }, now = Date.now()) {
  if (IS_MAC) {
    const waiter = macWaiting.get(id);
    if (!waiter || waiter.sentTo !== sender.key || waiter.gone())
      return false;
    waiter.done({ text: cutText(text, 8000) });
    return true;
  }
  const waiting = path36.join(REPLIES, `${id}.wait`);
  let letter = null;
  try {
    letter = JSON.parse(fs36.readFileSync(waiting, "utf8"));
  } catch {
    return false;
  }
  if (letter?.sentTo !== sender.key)
    return false;
  fs36.rmSync(waiting, { force: true });
  let alive = 0;
  try {
    alive = fs36.statSync(path36.join(REPLIES, `${id}.alive`)).mtimeMs;
  } catch {}
  if (now - alive > 1e4)
    return false;
  const told = readPeerAgents();
  const agent = peerOf(from, peersOf(readLink()), told)?.key === sender.key ? (told[sender.key]?.list ?? []).find((each) => each.session === from) : null;
  reply(id, { text: cutText(text, 8000), to: letter.from, from: agent ? from : "unknown", name: agent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}` });
  return true;
}
async function deliverLeftAnswers(now = Date.now(), targets = peerTargets()) {
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".json"))
      continue;
    const id = name.slice(0, -5);
    const file = path36.join(REPLIES, name);
    let answer;
    try {
      answer = JSON.parse(fs36.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (typeof answer?.text !== "string" || typeof answer.to !== "string")
      continue;
    let alive = 0;
    try {
      alive = fs36.statSync(path36.join(REPLIES, `${id}.alive`)).mtimeMs;
    } catch {}
    if (!fs36.existsSync(path36.join(REPLIES, `${id}.gaveup`)) && now - alive <= 1e4)
      continue;
    const taken = `${file}.delivering`;
    try {
      fs36.renameSync(file, taken);
    } catch {
      continue;
    }
    try {
      const place = await placeOfSession(answer.to, targets);
      const kuvo = place?.data?.metadata?.kuvo ?? {};
      if (place && !place.data?.parentID && !kuvo.seat && !isPutAway(place.data)) {
        await asked(place.target, "POST", `api/session/${encodeURIComponent(answer.to)}/prompt`, { id: messageID(), text: composeLetter(String(answer.name ?? "another agent"), String(answer.from ?? "unknown"), answer.text, false), delivery: "steer" });
      }
      fs36.rmSync(taken, { force: true });
      fs36.rmSync(path36.join(REPLIES, `${id}.gaveup`), { force: true });
    } catch {
      try {
        fs36.renameSync(taken, file);
      } catch {}
    }
  }
}
function letterMail(peer, letter, link, now = Date.now()) {
  const words = String(letter.text ?? "");
  for (const most of [LETTER_BYTES, LETTER_BYTES / 4, 2000]) {
    const bytes = mailFor(peer, { letter: { ...letter, text: prefixBytes(words, most) }, at: now }, link);
    if (bytes)
      return bytes;
  }
  return null;
}
function sendOutbox(host, link = readLink(), now = Date.now(), offline = 0, ask = bridgeAsk) {
  const telling = [];
  if (!link?.key)
    return Promise.all(telling);
  const peers = peersOf(link);
  const told = readPeerAgents(undefined, undefined, link);
  const moved = movedOf(link);
  if (!offline) {
    for (const name of listOf(OUTBOX)) {
      if (!name.endsWith(".json") || name.startsWith("."))
        continue;
      try {
        const letter = JSON.parse(fs36.readFileSync(path36.join(OUTBOX, name), "utf8"));
        if (typeof letter?.handed !== "number")
          continue;
        fs36.mkdirSync(SENDING, { recursive: true, mode: 448 });
        fs36.renameSync(path36.join(OUTBOX, name), path36.join(SENDING, name));
      } catch {}
    }
  }
  for (const name of listOf(REPLIES)) {
    if (!name.endsWith(".gaveup"))
      continue;
    const id = name.slice(0, -7);
    fs36.rmSync(path36.join(REPLIES, name), { force: true });
    fs36.rmSync(path36.join(REPLIES, `${id}.wait`), { force: true });
    const file = path36.join(SENDING, `${id}.json`);
    try {
      writePrivate(file, JSON.stringify({ ...JSON.parse(fs36.readFileSync(file, "utf8")), wait: false }));
    } catch {}
  }
  const listed = new Set;
  const waiting = [];
  for (const name of listOf(SENDING)) {
    if (!name.endsWith(".json"))
      continue;
    try {
      waiting.push({ name, letter: JSON.parse(fs36.readFileSync(path36.join(SENDING, name), "utf8")) });
    } catch {}
  }
  waiting.sort((a, b) => (typeof a.letter?.at === "number" ? a.letter.at : now) - (typeof b.letter?.at === "number" ? b.letter.at : now));
  for (const { name, letter: kept } of waiting) {
    const id = name.slice(0, -5);
    const file = path36.join(SENDING, name);
    let letter = kept;
    if (!isObject(letter))
      continue;
    listed.add(id);
    const made = typeof letter.at === "number" ? letter.at : now;
    if (isObject(letter.seat)) {
      const last = seatRounds.get(id);
      seatRounds.set(id, now);
      if (!offline && last !== undefined && now > last) {
        const before = seatAge(letter);
        letter = { ...letter, aged: before + Math.min(now - last, ONLINE_STEP) };
        if (Math.floor(letter.aged / 60000) !== Math.floor(before / 60000))
          try {
            writePrivate(file, JSON.stringify(letter));
          } catch {}
      }
      if (letter.gaveUp === true || seatAge(letter) > SEAT_LETTER_LIFE) {
        const told = giveUpSeat(id, letter, ask);
        if (told)
          telling.push(told);
        continue;
      }
      const to = peers.find((each) => each.key === letter.peer);
      if (!to || offline || now - (letterTries.get(id) ?? 0) < 60000)
        continue;
      letterTries.set(id, now);
      const told = sendSeatLetter(host, to, id, letter, link, now, ask);
      if (told)
        telling.push(told);
      continue;
    }
    const lives = moved.get(letter.to);
    const peer = lives ? peers.find((each) => each.key === lives) ?? null : typeof letter.peer === "string" ? peers.find((each) => each.key === letter.peer) ?? null : peerOf(letter.to, peers, told, moved);
    if (now - made > LETTER_MEMORY) {
      fs36.rmSync(file, { force: true });
      if (letter.wait === true)
        reply(id, { failed: "Its agent couldn't be reached." });
      continue;
    }
    if (!peer)
      continue;
    if (!IS_MAC && offline > RELAY_GONE_AFTER && !letter.sentTo && !letter.answers) {
      try {
        const { via, sentTo, peer: _, ...rest } = letter;
        writePrivate(path36.join(OUTBOX, `${id}.json`), JSON.stringify({ ...rest, wait: false, handed: now }));
        fs36.rmSync(file, { force: true });
        if (letter.wait === true)
          reply(id, { note: "Your other computers can't be reached through the relay now: it goes through your Mac instead, and its answer comes to you as a message." });
      } catch {}
      continue;
    }
    if (offline || now - (letterTries.get(id) ?? 0) < 60000)
      continue;
    if (letter.from && !toldPeers.get(peer.key)?.sessions?.has(letter.from) && !introducing.has(id)) {
      introducing.set(id, now);
      announce(host, readEngineFile, link).catch(() => {});
      continue;
    }
    letterTries.set(id, now);
    const bytes = letterMail(peer, {
      id,
      from: letter.from,
      to: letter.to,
      text: cutText(letter.text),
      wait: letter.wait === true,
      at: made,
      ...letter.answers ? { answers: letter.answers } : {}
    }, link, now);
    if (!bytes) {
      fs36.rmSync(file, { force: true });
      if (letter.wait === true)
        reply(id, { failed: "It's too long to send." });
      continue;
    }
    if (letter.sentTo !== peer.key)
      try {
        writePrivate(file, JSON.stringify({ ...letter, sentTo: peer.key }));
      } catch {}
    try {
      host.send(bytes);
    } catch {}
  }
  for (const id of letterTries.keys())
    if (!listed.has(id))
      letterTries.delete(id);
  for (const id of seatRounds.keys())
    if (!listed.has(id))
      seatRounds.delete(id);
  for (const id of introducing.keys())
    if (!listed.has(id))
      introducing.delete(id);
  for (const name of listOf(REPLIES)) {
    try {
      if (now - fs36.statSync(path36.join(REPLIES, name)).mtimeMs > LETTER_LIFE)
        fs36.rmSync(path36.join(REPLIES, name), { force: true });
    } catch {}
  }
  return Promise.all(telling);
}

// Packages/Box/src/link/mac/link.ts
function macNeeded(link, now = Date.now()) {
  const config = macLink.config;
  if (!config)
    return false;
  if (config.machines)
    return true;
  const pairing = ["pairing", "appPairing"].some((slot) => link?.[slot] && now < link[slot].expires);
  return Boolean(config.phones && ((link?.phones ?? []).length || pairing));
}
function macLinkCheck() {
  if (macLink.host && !macNeeded(readLink()))
    macLink.host.disconnect?.();
}
function setLinkStatus(state, reason) {
  const next = reason ? { state, reason } : { state };
  if (JSON.stringify(next) === JSON.stringify(macLink.status))
    return;
  macLink.status = next;
  for (const tell of macLink.statusFollowers)
    tell();
}
function macLinkWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (macLink.wake === done)
        macLink.wake = null;
      resolve();
    }
    macLink.wake = done;
  });
}
var KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
async function macKeys() {
  const config = macLink.config;
  if (macLink.overlay || !config || !(config.phones || config.machines))
    return true;
  const given = await linkHost("link/identity", {});
  if (!given || !["key", "secret", "sign"].every((name) => KEY_TEXT.test(given[name] ?? ""))) {
    setLinkStatus("failed", "Kuvo Code couldn't give this Mac's link its keys from your Keychain. It tries again in a moment.");
    return false;
  }
  macLink.overlay = { key: given.key, secret: given.secret, sign: given.sign, relay: macLink.config.relay, name: macLink.config.name };
  if (macLink.status.state === "failed")
    setLinkStatus(macNeeded(readLink()) ? "connecting" : "off");
  return true;
}
function tellGone(gone) {
  if (!gone.length)
    return;
  const went = sendGone(gone);
  const left = gone.filter((peer) => !went.includes(peer.key));
  updateLink((link) => {
    if (!link)
      return null;
    const untold = (Array.isArray(link.untold) ? link.untold : []).filter((peer) => !gone.some((each) => each.key === peer.key));
    if (!left.length && untold.length === (link.untold?.length ?? 0))
      return null;
    link.untold = [...untold, ...left].slice(-64);
    if (!link.untold.length)
      delete link.untold;
    return link;
  });
}
function sendGone(gone) {
  const host = macLink.host;
  if (!host?.welcomed)
    return [];
  let envelope = null;
  const link = updateLink((link) => {
    const made = link?.sign ? ownDoc(link, "peers", macPeersBody(link)) : null;
    envelope = made?.envelope ?? null;
    return made?.changed ? link : null;
  }) ?? readLink();
  if (!envelope || !link?.key)
    return [];
  const went = [];
  for (const peer of gone) {
    if (!peer.sign) {
      went.push(peer.key);
      continue;
    }
    const bytes = mailFor(peer, { docs: { give: [envelope] }, at: Date.now() }, link);
    try {
      if (bytes && host.send(bytes))
        went.push(peer.key);
    } catch {}
  }
  return went;
}
function tellUntold() {
  const link = readLink();
  const untold = (Array.isArray(link?.untold) ? link.untold : []).filter(fitsPeer);
  const again = untold.filter((peer) => peersOf(link).some((each) => each.key === peer.key));
  if (again.length) {
    updateLink((link) => {
      if (!link?.untold)
        return null;
      link.untold = link.untold.filter((peer) => !again.some((each) => each.key === peer.key));
      return link;
    });
  }
  tellGone(untold.filter((peer) => !again.includes(peer)).map(cleanPeer));
}
function stopMacLink() {
  macLink.stopped = true;
  macLink.host?.disconnect?.();
  macLink.wake?.();
}

// Packages/Box/src/link/mac/notices.ts
import fs37 from "node:fs";

// Packages/Box/src/link/notices/hold.ts
import path37 from "node:path";
var ASK_HOLD = 30000;
var NEWS_HOLD = 60000;
var LONGEST_LEASE = 60000;
var SHOWN_WITHIN = 1e4;
var HELD_FILE = path37.join(RUN, "held-notices.json");
var RESTORED_WAIT = 20000;
var RETRY_EVERY = 5000;
var TRY_FOR = 10 * 60000;
var MOST_ANSWERED = 200;
var ASKED = new Set(["permission", "question", "ask"]);
var holdFor = (category) => ASKED.has(category) ? ASK_HOLD : NEWS_HOLD;
var shownIn = (notice) => notice?.data?.session ?? notice?.data?.group ?? notice?.thread;
var answeredBy = (notice) => notice?.data?.request ?? notice?.data?.ask;
var showsNotice = (shown, notice) => shown.request !== undefined ? shown.request === answeredBy(notice) : shown.session === shownIn(notice) && shown.ask === ASKED.has(notice.category);
function attentionGiven(given) {
  if (!isObject(given) || typeof given.for !== "number" || !Number.isFinite(given.for) || given.for < 0)
    return null;
  if (given.sessions !== undefined && (!Array.isArray(given.sessions) || !given.sessions.every((each) => typeof each === "string")))
    return null;
  if (given.shown !== undefined && (!Array.isArray(given.shown) || !given.shown.every((each) => isObject(each) && typeof each.session === "string" && (each.ask === undefined || typeof each.ask === "boolean") && (each.request === undefined || typeof each.request === "string"))))
    return null;
  return {
    seconds: Math.min(given.for, LONGEST_LEASE / 1000),
    sessions: (given.sessions ?? []).slice(0, 50),
    shown: (given.shown ?? []).slice(0, 50).map((each) => ({ session: each.session, ask: each.ask === true, ...each.request !== undefined ? { request: each.request } : {} }))
  };
}
var monotonic = () => performance.now();

class NoticeHold {
  constructor({ send, now = monotonic, wall = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, save = () => {}, held = [] }) {
    Object.assign(this, { send, now, wall, setTimer, clearTimer, save });
    this.leases = new Map;
    this.heard = new Map;
    this.shown = [];
    this.answered = [];
    this.timer = null;
    const start = this.now(), today = this.wall();
    const restored = (Array.isArray(held) ? held : []).filter((entry) => isObject(entry?.notice) && typeof entry.at === "number");
    this.held = restored.map((entry) => {
      const age = Math.min(Math.max(today - entry.at, 0), TRY_FOR);
      const due = entry.attended !== false ? start - age + holdFor(entry.notice.category) : start - age;
      return { notice: entry.notice, wall: entry.at, at: start - age, due: Math.max(due, start - age), seen: entry.seen === true };
    });
    if (restored.some((entry) => entry.attended !== false))
      this.leases.set("restored", start + RESTORED_WAIT);
    this.saved = NoticeHold.kept(this.held);
    this.settle();
  }
  static kept(entries) {
    return JSON.stringify(entries.map(({ notice, wall, seen, at, due }) => ({ notice, at: wall, seen, attended: due > at })));
  }
  get inUse() {
    const now = this.now();
    return [...this.leases.values()].some((until) => until > now);
  }
  get count() {
    return this.held.length;
  }
  attend(client, { seconds, sessions = [], shown = [] }, at) {
    if (typeof at === "number") {
      if (at < (this.heard.get(client) ?? -Infinity))
        return;
      this.heard.set(client, at);
    }
    if (seconds > 0) {
      const now = this.now();
      this.leases.set(client, now + seconds * 1000);
      const onScreen = new Set(sessions);
      for (const entry of this.held)
        if (onScreen.has(shownIn(entry.notice)))
          entry.seen = true;
      this.shown = this.shown.filter((each) => now - each.at < SHOWN_WITHIN);
      for (const each of shown) {
        const entry = this.held.find((entry) => !entry.seen && showsNotice(each, entry.notice));
        if (entry)
          entry.seen = true;
        else
          this.shown.push({ ...each, at: now });
      }
      this.shown = this.shown.slice(-200);
    } else {
      this.leases.delete(client);
    }
    this.settle();
  }
  tell(notice) {
    const answer = answeredBy(notice);
    if (answer !== undefined && this.answered.includes(answer))
      return true;
    const now = this.now();
    const inUse = this.inUse;
    const mark = inUse ? this.shown.findIndex((each) => now - each.at < SHOWN_WITHIN && showsNotice(each, notice)) : -1;
    const seen = mark >= 0;
    if (seen)
      this.shown.splice(mark, 1);
    this.held.push({ notice, at: now, wall: this.wall(), due: inUse ? now + holdFor(notice.category) : now, seen });
    this.settle();
    return true;
  }
  resolve(id) {
    if (typeof id !== "string" || !id)
      return;
    this.answered.push(id);
    if (this.answered.length > MOST_ANSWERED)
      this.answered.shift();
    this.held = this.held.filter((entry) => answeredBy(entry.notice) !== id);
    this.settle();
  }
  settle() {
    const now = this.now();
    for (const [client, until] of this.leases)
      if (until <= now)
        this.leases.delete(client);
    const waiting = this.leases.size > 0;
    const when = (entry) => Math.max(waiting ? entry.due : -Infinity, entry.retry ?? -Infinity);
    const kept = [];
    for (const entry of this.held) {
      if (when(entry) > now) {
        kept.push(entry);
        continue;
      }
      if (entry.seen && !ASKED.has(entry.notice.category))
        continue;
      if (entry.seen && waiting) {
        kept.push({ ...entry, due: Infinity });
        continue;
      }
      if (this.send(entry.notice))
        continue;
      if (now - entry.at < TRY_FOR)
        kept.push({ ...entry, retry: now + RETRY_EVERY });
    }
    this.held = kept;
    const text = NoticeHold.kept(kept);
    if (text !== this.saved) {
      this.saved = text;
      this.save(JSON.parse(text));
    }
    if (this.timer !== null)
      this.clearTimer(this.timer);
    this.timer = null;
    const next = Math.min(...kept.map(when), ...kept.length ? this.leases.values() : []);
    if (Number.isFinite(next))
      this.timer = this.setTimer(() => this.settle(), Math.max(0, next - now));
  }
}

// Packages/Box/src/link/notices/notice.ts
var NOTICE_LIMIT = 2500;
function noticeJSON(notice) {
  const value = { t: "notify", title: cut(masked(String(notice.title ?? "")), 200), category: notice.category, thread: String(notice.thread ?? ""), data: notice.data ?? {} };
  if (notice.subtitle)
    value.subtitle = cut(masked(String(notice.subtitle)), 200);
  let body = masked(String(notice.body ?? ""));
  while (true) {
    const json = Buffer.from(sortedJSON({ ...value, body }));
    if (json.length <= NOTICE_LIMIT || !body)
      return json;
    const room = Buffer.byteLength(body) - (json.length - NOTICE_LIMIT) - Buffer.byteLength("…");
    body = room <= 0 ? "" : prefixBytes(body, room).trimEnd() + "…";
  }
}
function pushTo(phone, json, hostKey) {
  const mail = frame(Frame.mail, 0, sealOneWay(json, hostKey, Buffer.from(phone.key, "base64url")).message);
  return relayPush(Buffer.from(phone.address, "base64url"), mail);
}

// Packages/Box/src/link/mac/notices.ts
function macNoticeHold(clock = {}) {
  let held = [];
  try {
    held = JSON.parse(fs37.readFileSync(HELD_FILE, "utf8"));
  } catch {}
  return new NoticeHold({
    ...clock,
    send: (notice) => {
      const link = readLink();
      const phones = (link?.phones ?? []).filter((phone) => phone.address);
      if (!macLink.config)
        return false;
      if (!phones.length || !macLink.config.phones)
        return true;
      const host = macLink.host;
      if (!host?.welcomed || !link?.key)
        return false;
      const json = noticeJSON(notice);
      const key = Buffer.from(link.key, "base64url");
      let sent = 0;
      for (const phone of phones) {
        try {
          if (host.send(pushTo(phone, json, key)))
            sent += 1;
        } catch {}
      }
      return sent > 0;
    },
    held,
    save: (entries) => {
      try {
        if (entries.length)
          writePrivate(HELD_FILE, JSON.stringify(entries));
        else
          fs37.rmSync(HELD_FILE, { force: true });
      } catch {}
    }
  });
}
function macTell(notice) {
  if (!macLink.hold || macLink.config && !macLink.config.phones)
    return true;
  return macLink.hold.tell(notice);
}

// Packages/Box/src/link/mac/peers.ts
import fs38 from "node:fs";
import path38 from "node:path";
function macAttendPeers(body, given) {
  const host = macLink.host;
  const link = readLink();
  if (!host?.welcomed || !link?.key)
    return;
  const at = Date.now();
  for (const peer of peersOf(link)) {
    const shown = isObject(body?.elsewhere) && Array.isArray(body.elsewhere[peer.id]) ? body.elsewhere[peer.id] : [];
    const theirs = attentionGiven({ for: 0, shown })?.shown ?? [];
    const bytes = mailFor(peer, { attention: { for: given.seconds, sessions: given.sessions, ...theirs.length ? { shown: theirs } : {} }, at }, link);
    if (bytes)
      try {
        host.send(bytes);
      } catch {}
  }
}
function runMacPeers() {
  const stop = new AbortController;
  watchSeats(() => macLink.host, stop.signal);
  refreshOwn(readEngineFile).catch(() => {});
  const rounds = [
    setInterval(() => {
      const host = macLink.host;
      if (host?.welcomed)
        announce(host, readEngineFile).catch(() => {});
      else
        refreshOwn(readEngineFile).catch(() => {});
    }, 60000),
    setInterval(macSendOutbox, 3000)
  ];
  macLink.stopPeers = () => {
    stop.abort();
    for (const round of rounds)
      clearInterval(round);
  };
}
function stopMacPeers() {
  macLink.stopPeers?.();
  macLink.stopPeers = null;
}
function macSendOutbox() {
  const host = macLink.host;
  try {
    sendOutbox(host?.welcomed ? host : { send() {} }, undefined, Date.now(), host?.welcomed ? 0 : 1);
  } catch {}
}
var LETTER_WAIT = 660000;
var OFFLINE_LETTER = "Your other computers can't be reached through the relay now: it goes once this Mac's back on it, and its answer comes to you as a message.";
function macLetterAnswer(id, signal, most = LETTER_WAIT) {
  return new Promise((resolve) => {
    const waiter = { sentTo: null, gone: () => Boolean(signal?.aborted), done: (value) => finish(value) };
    const timer = setTimeout(() => finish(null), most);
    const abort = () => finish(null);
    signal?.addEventListener("abort", abort, { once: true });
    function finish(value) {
      if (macWaiting.get(id) !== waiter)
        return;
      macWaiting.delete(id);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!value) {
        const file = path38.join(SENDING, `${id}.json`);
        try {
          writePrivate(file, JSON.stringify({ ...JSON.parse(fs38.readFileSync(file, "utf8")), wait: false }));
        } catch {}
      }
      resolve(value ?? { text: null });
    }
    macWaiting.set(id, waiter);
  });
}

// Packages/Box/src/link/mac/relay.ts
import os8 from "node:os";

// Packages/Box/src/link/letters/take.ts
import fs39 from "node:fs";
function lettersSeen(now) {
  let seen = {};
  try {
    seen = JSON.parse(fs39.readFileSync(LETTERS_SEEN, "utf8"));
  } catch {}
  for (const [key, at] of Object.entries(seen))
    if (now - at > LETTER_MEMORY)
      delete seen[key];
  return seen;
}
var seenAlready = (id, now = Date.now()) => (id in lettersSeen(now));
function noteSeen(id, now = Date.now()) {
  locked(PEER_LOCK, () => {
    const seen = lettersSeen(now);
    seen[id] = now;
    writePrivate(LETTERS_SEEN, JSON.stringify(seen));
  });
}
var delivering = new Set;
var lettersFrom = new Map;
function tooMany(key, now = Date.now()) {
  const lately = (lettersFrom.get(key) ?? []).filter((at) => now - at < 600000);
  if (lately.length >= 20)
    return true;
  lettersFrom.set(key, [...lately, now]);
  return false;
}
async function answerTo(target, session, id, wait = 2000) {
  const began = Date.now();
  let started = false;
  while (Date.now() - began < 600000) {
    await sleep(wait);
    const active = (await asked(target, "GET", "api/session/active").catch(() => null))?.data ?? {};
    if (Array.isArray(active) ? active.includes(session) : active[session]) {
      started = true;
      continue;
    }
    if (!started && Date.now() - began < 3 * wait)
      continue;
    const page = await asked(target, "GET", `api/session/${encodeURIComponent(session)}/message?limit=20&order=desc`).catch(() => null);
    const replies = (page?.data ?? []).filter((message) => message.type === "assistant" && message.id > id).reverse().map((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(`
`)).filter(Boolean);
    if (replies.length)
      return replies.join(`

`).slice(0, 8000);
    if (started)
      break;
  }
  return null;
}
async function takeLetter(sender, letter, { send, targets, answer = () => {}, told = readPeerAgents(), peers = peersOf(readLink()), moved = movedOf(readLink()), now = Date.now(), wait, moving = async () => false } = {}) {
  if (!isObject(letter) || typeof letter.id !== "string" || !LETTER_ID.test(letter.id))
    return;
  const { id } = letter;
  const no = (why, again = false) => send(sender, { delivered: { id, ok: false, why, ...again ? { retry: true } : {} } });
  if (typeof letter.at !== "number" || Math.abs(now - letter.at) > LETTER_LIFE)
    return no("It's too old to deliver.");
  if (typeof letter.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(letter.to) || typeof letter.text !== "string" || !letter.text.trim())
    return no("That isn't a letter.");
  if (delivering.has(id))
    return;
  if (seenAlready(id, now))
    return send(sender, { delivered: { id, ok: true } });
  if (typeof letter.answers === "string" && LETTER_ID.test(letter.answers) && answered(sender, letter, now)) {
    noteSeen(id, now);
    return send(sender, { delivered: { id, ok: true } });
  }
  if (tooMany(sender.key, now))
    return no("It's sent a lot of messages in the last few minutes.", true);
  delivering.add(id);
  let place, prompt, fromAgent = null;
  try {
    const lives = moved.get(letter.to);
    if (lives && lives !== ownKey(readLink() ?? {}) || await moving(letter.to))
      return no("It's moving to another computer: it comes again once it's there.", true);
    place = await placeOfSession(letter.to, targets);
    if (!place)
      return no("There's no such conversation here.");
    const kuvo = place.data?.metadata?.kuvo ?? {};
    if (place.data?.parentID || kuvo.seat || isPutAway(place.data))
      return no("That conversation doesn't take messages.");
    const listed = peerOf(letter.from, peers, told, moved)?.key === sender.key ? (told[sender.key]?.list ?? []).find((agent) => agent.session === letter.from) : null;
    if (listed && !await placeOfSession(letter.from, targets).catch(() => ({})))
      fromAgent = listed;
    const name = fromAgent?.name ?? `an agent on ${plainName(sender.name) || "another computer"}`;
    prompt = messageID();
    const waits = letter.wait === true && Boolean(fromAgent);
    await asked(place.target, "POST", `api/session/${encodeURIComponent(letter.to)}/prompt`, { id: prompt, text: composeLetter(name, fromAgent ? letter.from : "unknown", cutText(letter.text), waits), delivery: "steer" });
  } catch (error) {
    return no(`It didn't reach it: ${String(error?.message ?? error)}`, true);
  } finally {
    delivering.delete(id);
  }
  noteSeen(id, now);
  if (letter.wait === true && !fromAgent)
    return send(sender, { delivered: { id, ok: true, answer: false, why: "Its answer can't come back to you: it doesn't know who you are." } });
  send(sender, { delivered: { id, ok: true } });
  if (letter.wait !== true)
    return;
  const text = await answerTo(place.target, letter.to, prompt, wait);
  if (text)
    answer({ from: letter.to, to: letter.from, text, answers: id, peer: sender.key });
}

// Packages/Box/src/link/peers/mail.ts
var answeringAsk = null;
var asksFrom = new Map;
function peerMail(sender, payload, host, targets = () => []) {
  const send = (peer, message) => {
    const link = readLink();
    const bytes = link && mailFor(peer, { ...message, at: Date.now() }, link);
    if (bytes)
      try {
        host?.send(bytes);
      } catch {}
  };
  if (isObject(payload.agents)) {
    if (takeAgents(sender, payload.agents))
      writeAgents();
  }
  if (isObject(payload.docs))
    receiveDocs(sender, payload.docs, host).catch(() => {});
  if (payload.ask === "agents") {
    toldPeers.delete(sender.key);
    const now = Date.now();
    if (host?.welcomed && !answeringAsk && now - (asksFrom.get(sender.key) ?? 0) > 1e4) {
      asksFrom.set(sender.key, now);
      answeringAsk = announce(host, readEngineFile).catch(() => {}).finally(() => {
        answeringAsk = null;
      });
    }
  }
  if (isObject(payload.letter))
    takeLetter(sender, payload.letter, { send, targets: targets(), answer: leaveAnswer, ...IS_MAC ? { moving: macMoving } : {} }).catch(() => {});
  if (isObject(payload.seat) || isObject(payload.seatPart))
    takeSeat(sender, payload, send).catch(() => {});
  if (isObject(payload.delivered) && typeof payload.delivered.id === "string")
    letterWent(sender, payload.delivered);
}
function receiveMail(body, host, peerMail = () => {}, attended = () => {}) {
  const link = readLink();
  const opened = openMail(body, link);
  if (!opened)
    return;
  const { sender, payload } = opened;
  if (macsOf(link).includes(sender.key))
    heardFromMac(sender.key, payload);
  const attention = macsOf(link).includes(sender.key) ? attentionGiven(payload.attention) : null;
  if (attention && typeof payload.at === "number")
    attended(sender.key, attention, payload.at);
  peerMail(sender, payload);
}
function heardFromMac(mac, payload, now = Date.now()) {
  const link = readLink();
  const legacy = !macSign(link, mac) && Array.isArray(payload.peers) && typeof payload.at === "number" && payload.at > (link?.legacy?.[mac]?.at ?? 0);
  if (!legacy && now - (link?.macSeen?.[mac] ?? 0) < 3600000)
    return;
  const changed = updateLink((link) => {
    if (!link || !macsOf(link).includes(mac))
      return null;
    if (legacy)
      takeLegacyPeers(link, mac, payload.peers, payload.at, payload.moved);
    forgetOldMacs(link, mac, now);
    return link;
  });
  if (changed && legacy)
    writeAgents(changed);
}

// Packages/Box/src/link/relay/connection.ts
function fromRelay(host, message, self) {
  if (message.address.equals(self))
    return;
  if (message.kind === "deliver")
    host.receive(message.address, message.payload);
  if (message.kind === "unreachable" || message.kind === "gone")
    host.forget(message.address);
}
function connectOnce(relay, secret, host, onWelcome = () => {}) {
  return new Promise((resolve) => {
    const self = addressOf(secret);
    let welcomed = false;
    let lastHeard = Date.now();
    const socket = new WebSocket(relay);
    socket.binaryType = "arraybuffer";
    const check = setInterval(() => {
      if (Date.now() - lastHeard > 90000)
        return finish();
      if (welcomed)
        socket.send(relaySend(self, EMPTY));
    }, 30000);
    let finished = false;
    const finish = () => {
      if (finished)
        return;
      finished = true;
      clearInterval(check);
      clearTimeout(opening);
      try {
        socket.close();
      } catch {}
      host.reset();
      host.send = () => {};
      host.welcomed = false;
      resolve(welcomed);
    };
    const opening = setTimeout(() => {
      if (!welcomed)
        finish();
    }, 15000);
    host.disconnect = finish;
    host.unsent = () => finished ? 0 : socket.bufferedAmount ?? 0;
    socket.onopen = () => socket.send(relayHello(secret));
    socket.onmessage = (event) => {
      lastHeard = Date.now();
      const message = readRelay(Buffer.from(event.data));
      if (!message)
        return;
      if (!welcomed) {
        if (message.kind !== "welcome" || !message.address.equals(self))
          return socket.close();
        welcomed = true;
        host.send = (bytes) => {
          if (socket.readyState !== 1)
            return false;
          socket.send(bytes);
          return true;
        };
        host.welcomed = true;
        try {
          onWelcome(host);
        } catch {}
        return;
      }
      fromRelay(host, message, self);
    };
    socket.onerror = finish;
    socket.onclose = finish;
  });
}

// Packages/Box/src/link/relay/host.ts
var requestOf = (head, body) => ({
  method: typeof head.m === "string" ? head.m : "GET",
  path: typeof head.p === "string" ? head.p : "",
  headers: head.h !== null && typeof head.h === "object" && !Array.isArray(head.h) ? head.h : {},
  body
});

class LinkHost {
  constructor({ key, hello, authorize, handle, connect, send, confirmed, mail }) {
    Object.assign(this, { key, hello, authorize, handle, connect, send, confirmed, mail });
    this.sessions = new Map;
  }
  reset() {
    for (const session of this.sessions.values())
      this.end(session, false);
  }
  get active() {
    return this.sessions.size;
  }
  forget(address) {
    for (const session of this.sessions.values())
      if (session.from.equals(address))
        this.end(session, false);
  }
  keepOnly(keys) {
    for (const session of this.sessions.values())
      if (!keys.has(session.phone.key.toString("base64url")))
        this.end(session, true);
  }
  async receive(from, payload) {
    try {
      await this.receiveFrame(from, payload);
    } catch {}
  }
  async receiveFrame(from, payload) {
    const parsed = readFrame(payload);
    if (!parsed)
      return;
    const id = `${from.toString("base64url")}:${parsed.session}`;
    const session = this.sessions.get(id);
    switch (parsed.kind) {
      case Frame.handshake1:
        return this.handshake(from, parsed.session, id, parsed.body);
      case Frame.transport: {
        if (!session)
          return this.send(relaySend(from, frame(Frame.close, parsed.session)));
        let message;
        try {
          message = decodeMessage(session.transport.open(parsed.body));
        } catch {
          message = null;
        }
        if (!message || typeof message.head !== "object" || message.head === null)
          return this.end(session, true);
        if (!session.confirmed) {
          session.confirmed = true;
          this.confirmed?.(session.phone);
        }
        return this.message(session, message);
      }
      case Frame.close:
        if (session)
          this.end(session, false);
        return;
      case Frame.mail:
        return this.mail?.(from, parsed.body, payload);
    }
  }
  async handshake(from, number, id, body) {
    const refuse = () => this.send(relaySend(from, frame(Frame.close, number)));
    const responder = new IKResponder(this.key, PROLOGUE);
    let hello;
    try {
      hello = JSON.parse(responder.readMessage1(body).toString("utf8"));
    } catch {
      return refuse();
    }
    if (hello?.v !== 1 || !await this.authorize(responder.rs, hello, from))
      return refuse();
    const { message, transport } = responder.writeMessage2(Buffer.from(JSON.stringify(this.hello)));
    for (const old of this.sessions.values())
      if (old.from.equals(from))
        this.end(old, false);
    const phone = { key: responder.rs, name: String(hello.name ?? ""), address: from };
    this.sessions.set(id, { id, from, number, phone, transport, incoming: new Map, running: new Map, sockets: new Map });
    this.send(relaySend(from, frame(Frame.handshake2, number, message)));
  }
  message(session, { head, body }) {
    switch (head.t) {
      case "req": {
        const request = requestOf(head, body);
        if (String(request.headers.upgrade ?? "").toLowerCase() === "websocket")
          this.open(session, head.id, request);
        else if (head.end === false)
          session.incoming.set(head.id, request);
        else
          this.run(session, head.id, request);
        return;
      }
      case "data": {
        const socket = session.sockets.get(head.id);
        if (socket) {
          if (body.length)
            socket.handle?.send(body);
          if (head.end === true) {
            session.sockets.delete(head.id);
            socket.handle?.close();
          }
          return;
        }
        const request = session.incoming.get(head.id);
        if (!request)
          return;
        request.body = Buffer.concat([request.body, body]);
        if (head.end === true) {
          session.incoming.delete(head.id);
          this.run(session, head.id, request);
        }
        return;
      }
      case "cancel":
        session.running.get(head.id)?.abort();
        session.running.delete(head.id);
        session.incoming.delete(head.id);
        session.sockets.get(head.id)?.handle?.close();
        session.sockets.delete(head.id);
        return;
      case "ping":
        return this.seal(session, encodeMessage({ t: "pong" }));
    }
  }
  run(session, id, request) {
    const controller = new AbortController;
    session.running.set(id, controller);
    const live = () => !controller.signal.aborted && this.sessions.get(session.id) === session;
    const reply = (head, body, end) => {
      if (!live())
        return;
      for (const piece of pieces(head, body, end))
        this.seal(session, piece);
    };
    (async () => {
      let head = null;
      let started = false;
      try {
        for await (const part of this.handle(request, session.phone, controller.signal)) {
          if (!live())
            return;
          if (part.head) {
            head = { t: "res", id, s: part.head.status, h: part.head.headers };
          } else if (part.body?.length) {
            reply(started ? { t: "data", id } : head ?? { t: "data", id }, part.body, false);
            started = true;
          }
        }
        reply(started ? { t: "data", id } : head ?? { t: "data", id }, EMPTY, true);
      } catch (error) {
        if (!live())
          return;
        if (!started)
          reply({ t: "res", id, s: 502, h: { "content-type": "text/plain" } }, Buffer.from(String(error?.message ?? error)), true);
        else
          this.seal(session, encodeMessage({ t: "cancel", id }));
      } finally {
        if (session.running.get(id) === controller)
          session.running.delete(id);
      }
    })();
  }
  open(session, id, request) {
    const socket = { handle: null, opened: false };
    session.sockets.set(id, socket);
    const live = () => this.sessions.get(session.id) === session && session.sockets.get(id) === socket;
    const reply = (head, body, end) => {
      if (!live())
        return;
      for (const piece of pieces(head, body, end))
        this.seal(session, piece);
    };
    const end = (error) => {
      if (!live())
        return;
      if (socket.opened)
        reply({ t: "data", id }, EMPTY, true);
      else
        reply({ t: "res", id, s: 502, h: { "content-type": "text/plain" } }, Buffer.from(String(error?.message ?? "It closed.")), true);
      session.sockets.delete(id);
    };
    if (!this.connect)
      return end(new Error("Sockets aren't available here."));
    socket.handle = this.connect(request, session.phone, {
      open: () => {
        socket.opened = true;
        reply({ t: "res", id, s: 101 }, EMPTY, false);
      },
      text: (data) => reply({ t: "data", id }, data, false),
      binary: (data) => {
        if (data.length <= 60000)
          reply({ t: "data", id, h: { type: "binary" } }, data, false);
      },
      end
    });
  }
  seal(session, plaintext) {
    this.send(relaySend(session.from, frame(Frame.transport, session.number, session.transport.seal(plaintext))));
  }
  end(session, notify) {
    if (this.sessions.get(session.id) !== session)
      return;
    this.sessions.delete(session.id);
    for (const controller of session.running.values())
      controller.abort();
    session.running.clear();
    for (const socket of session.sockets.values())
      socket.handle?.close();
    session.sockets.clear();
    if (notify)
      this.send(relaySend(session.from, frame(Frame.close, session.number)));
  }
}

// Packages/Box/src/link/server/attached.ts
import crypto17 from "node:crypto";
import fs40 from "node:fs";
import path39 from "node:path";
async function attachedIn(body, session, modelInput, joinsNote = false, guesses = true) {
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (!prompt || !Array.isArray(prompt.files))
    return body;
  const files = prompt.files;
  if (!files.some((file) => inline(file) !== null))
    return body;
  const input = await modelInput(session).catch(() => null);
  const attachments = path39.join(K, "attachments");
  letOldGo(attachments);
  const sent = [], included = [], paths = [];
  for (const file of files) {
    const data = inline(file);
    if (!data) {
      sent.push(file);
      continue;
    }
    const saved = save(attachments, data.bytes, typeof file.name === "string" ? file.name : "");
    if (reads(data.mime, data.bytes.length, input, guesses)) {
      sent.push(isText(data.mime) && data.mime !== "text/plain" ? { ...file, uri: `data:text/plain;base64,${data.bytes.toString("base64")}` } : file);
      if (saved)
        included.push(saved);
    } else if (saved) {
      paths.push(saved);
    } else {
      sent.push(file);
    }
  }
  const text = typeof prompt.text === "string" ? prompt.text : "";
  return Buffer.from(JSON.stringify({ ...prompt, text: withAttachedNote(text, included, paths, joinsNote), files: sent.length ? sent : undefined }));
}
function inline(file) {
  const match = typeof file?.uri === "string" ? /^data:([^;,]*)((?:;[^;,]*)*);base64,/.exec(file.uri) : null;
  if (!match)
    return null;
  return { mime: (match[1] || "application/octet-stream").toLowerCase(), bytes: Buffer.from(file.uri.slice(match[0].length), "base64") };
}
var MODEL_BYTES = 20 * 1024 * 1024;
var TEXT_TYPES = new Set(["application/json", "application/javascript", "application/xml", "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/sql"]);
var isText = (mime) => mime.startsWith("text/") || TEXT_TYPES.has(mime);
function reads(mime, size, input, guess) {
  if (size > MODEL_BYTES)
    return false;
  if (isText(mime))
    return true;
  if (mime === "application/pdf")
    return input?.includes("pdf") ?? guess;
  if (mime.startsWith("image/"))
    return input?.includes("image") ?? guess;
  return false;
}
var KEPT_DAYS2 = 14;
function save(attachments, bytes, name) {
  const given = path39.basename(name.replace(/\\/g, "/")).trim();
  const base = ["", ".", ".."].includes(given) ? "attachment" : given;
  try {
    fs40.mkdirSync(attachments, { recursive: true });
    let folder = "";
    for (let tries = 0;!folder; tries++) {
      const drawn = path39.join(attachments, crypto17.randomBytes(4).toString("hex"));
      try {
        fs40.mkdirSync(drawn);
        folder = drawn;
      } catch (error) {
        if (error.code !== "EEXIST" || tries > 8)
          throw error;
      }
    }
    const file = path39.join(folder, base);
    fs40.writeFileSync(file, bytes);
    return file;
  } catch {
    return null;
  }
}
function letOldGo(attachments) {
  const before = Date.now() - KEPT_DAYS2 * 24 * 60 * 60 * 1000;
  let folders;
  try {
    folders = fs40.readdirSync(attachments);
  } catch {
    return;
  }
  for (const name of folders) {
    const folder = path39.join(attachments, name);
    try {
      if (fs40.statSync(folder).mtimeMs < before)
        fs40.rmSync(folder, { recursive: true, force: true });
    } catch {}
  }
}

// Packages/Box/src/link/server/forward.ts
var AGENTS = "kuvo/agents/";
var FROM_PHONE = ["<from-phone>", "The user sent this from Kuvo Code on their iPhone.", "They read your reply on a small screen, and can't open file paths, links to files on the computer or Kuvo Code's side panel there. Keep your reply short and easy to read on a phone. To show them a file (a picture, a chart, a PDF, a document you made or found), use show_file: it puts the file in this conversation, where they see it. A widget (show_widget) shows there too: keep it narrow, and make it work with taps rather than hovering.", "</from-phone>"].join(`
`);
function fromPhone(body) {
  let prompt;
  try {
    prompt = JSON.parse(Buffer.from(body ?? "").toString());
  } catch {
    return body;
  }
  if (typeof prompt?.text !== "string" || prompt.text.trimEnd().endsWith("</from-phone>"))
    return body;
  return Buffer.from(JSON.stringify({ ...prompt, text: `${prompt.text}

${FROM_PHONE}` }));
}
function modelInput(base, headers, signal) {
  const read = async (at) => {
    const response = await fetch(new URL(at, base), { headers, signal });
    return response.ok ? (await response.json())?.data ?? null : null;
  };
  return async (session) => {
    const own = (await read(`/api/session/${encodeURIComponent(session)}`))?.model;
    const ref = own ?? await read("/api/model/default");
    if (!ref)
      return null;
    const model = Array.isArray(ref.capabilities?.input) ? ref : (await read("/api/model") ?? []).find((listed) => listed?.id === ref.id && listed?.providerID === ref.providerID);
    const input = model?.capabilities?.input;
    return Array.isArray(input) ? input.filter((kind) => typeof kind === "string") : null;
  };
}
async function* forward(target, path, request, signal, allows, naming = null, down = engineDown, toAgents = false) {
  const method = request.method.toUpperCase();
  const sent = canonicalPath(path);
  if (sent === null || !allows(sent, method)) {
    yield { head: { status: 403, headers: { "content-type": "text/plain" } } };
    yield { body: Buffer.from("That isn't available over the link.") };
    return;
  }
  const url = new URL(`http://127.0.0.1:${target.port}/${sent}`);
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}` };
  const given = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const name of REQUEST_HEADERS)
    if (given[name])
      headers[name] = given[name];
  const sending = method === "POST" && /^\/api\/session\/([^/]+)\/(prompt|command)$/.exec(url.pathname);
  const prompt = sending && sending[2] === "prompt" && !request.fromMac ? sending : null;
  const changed = method === "PATCH" && /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  let wasArchived = null;
  if (changed) {
    try {
      const before = await fetch(url, { headers, signal });
      if (before.ok)
        wasArchived = (await before.json())?.data?.metadata?.["kuvo.archived"] === true;
    } catch {}
  }
  const outgoing = async () => {
    if (!sending)
      return request.body;
    const session = decodeURIComponent(sending[1]);
    const body = await attachedIn(request.body, session, modelInput(url, headers, signal), request.fromMac === true, !toAgents);
    return prompt ? fromPhone(await namedIn(body, session, naming)) : body;
  };
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : await outgoing(),
      signal
    });
  } catch (error) {
    if (signal?.aborted)
      throw error;
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: down() })) };
    return;
  }
  const out = {};
  for (const name of RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value)
      out[name] = value;
  }
  if (changed && response.ok) {
    let archived;
    try {
      archived = JSON.parse(Buffer.from(request.body ?? []).toString("utf8"))?.metadata?.["kuvo.archived"];
    } catch {}
    if (typeof archived === "boolean" && archived !== wasArchived)
      try {
        holdArchived(decodeURIComponent(changed[1]), archived);
      } catch {}
  }
  yield { head: { status: response.status, headers: out } };
  if (!response.body)
    return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        return;
      yield { body: Buffer.from(value) };
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
async function* agentsRoute(context) {
  const { request, signal, readEngine, bridge, text } = context;
  const path = request.path.slice(AGENTS.length);
  if (!agentsAllowed(path, request.method))
    return yield* text(403, "That isn't available over the link.");
  const target = bridge();
  if (!target) {
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: "The coding agents aren't running on this machine." })) };
    return;
  }
  return yield* forward(target, path, request, signal, agentsAllowed, namingHere(readEngine), () => "The coding agents aren't answering on this computer. Try again in a moment.", true);
}
async function* engineRoute(context) {
  const { request, signal, route, readEngine, bridge, json, text } = context;
  const stop = route.match(/^kuvo\/shell\/([^/]+)\/stop$/);
  if (!stop && route.startsWith("kuvo/") && canonicalPath(request.path) === request.path)
    return yield* json(404, {});
  if (!stop && !allowed(request.path, request.method))
    return yield* text(403, "That isn't available over the link.");
  let engine = null;
  try {
    engine = readEngine();
  } catch {
    if (!stop || !bridge())
      return yield* json(503, { message: engineDown() });
  }
  if (stop) {
    if (request.method.toUpperCase() !== "POST")
      return yield* text(405, "Stop it with POST.");
    const headers = {};
    const given = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const name of REQUEST_HEADERS)
      if (given[name])
        headers[name] = given[name];
    const runners = [engine, bridge()].filter(Boolean);
    return yield* stopShell(decodeURIComponent(stop[1]), runners, headers, signal);
  }
  return yield* forward(engine, request.path, request, signal, allowed, namingHere(readEngine));
}

// Packages/Box/src/link/areas/found.ts
import { readFileSync } from "node:fs";
import path40 from "node:path";
function opencodeAuthFile(home = homeFolder(), env = process.env) {
  const own = "KUVO_OWN_XDG_DATA_HOME" in env ? env.KUVO_OWN_XDG_DATA_HOME : env.XDG_DATA_HOME && !path40.resolve(env.XDG_DATA_HOME).startsWith(path40.resolve(K)) ? env.XDG_DATA_HOME : undefined;
  return path40.join(own || path40.join(home, ".local", "share"), "opencode", "auth.json");
}
var readFrom = () => process.env.KUVO_DEMO_OPENCODE_AUTH || opencodeAuthFile();
function readOpencode(file) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isObject(entries))
    return [];
  const found = [];
  for (const [name, entry] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
    const integrationID = name.replace(/\/+$/, "");
    if (!integrationID || !isObject(entry))
      continue;
    if (entry.type === "api" && typeof entry.key === "string" && entry.key) {
      found.push({ integrationID, kind: "key", value: { type: "key", key: entry.key, ...isObject(entry.metadata) ? { metadata: entry.metadata } : {} } });
    } else if (entry.type === "oauth" && typeof entry.refresh === "string") {
      found.push({ integrationID, kind: "signIn" });
    }
  }
  return found;
}
async function integrations(target, signal, fresh = false) {
  if (!target?.port)
    return [];
  const data = await call(target, "GET", `/api/integration${fresh ? "?fresh=1" : ""}`, undefined, signal ?? AbortSignal.timeout(20000)).catch(() => null);
  if (!Array.isArray(data))
    return [];
  return data.filter(isObject).filter((each) => typeof each.id === "string").map((each) => ({
    id: each.id,
    name: typeof each.name === "string" ? each.name : each.id,
    metadata: isObject(each.metadata) ? each.metadata : {},
    connections: Array.isArray(each.connections) ? each.connections.filter(isObject) : []
  }));
}
async function found({ engine, bridge, authFile = readFrom() }, signal) {
  const [engineList, agentList] = await Promise.all([integrations(engine, signal), integrations(bridge, signal, true)]);
  const byID = new Map(engineList.map((integration) => [integration.id, integration]));
  const agents = agentList.filter((integration) => integration.metadata.source === "agent").map((integration) => {
    const signedIn = integration.connections.length > 0;
    const label = integration.metadata.account;
    return { id: integration.id, name: integration.name, installed: integration.metadata.installed !== false, signedIn, ...signedIn && typeof label === "string" && label ? { label } : {} };
  });
  const working = (connection) => {
    const status = isObject(connection.status) ? connection.status.status : undefined;
    return connection.type !== "env" && (status === undefined || status === "connected");
  };
  const opencode = readOpencode(authFile).map((entry) => {
    const known = byID.get(entry.integrationID);
    return { id: `opencode:${entry.integrationID}`, integrationID: entry.integrationID, name: known?.name ?? entry.integrationID, kind: entry.kind, connected: known?.connections.some(working) ?? false };
  });
  const shell = engineList.flatMap((integration) => integration.connections.filter((connection) => connection.type === "env" && typeof connection.name === "string" && connection.name).map((connection) => ({ integrationID: integration.id, name: integration.name, variable: connection.name })));
  const connected = engineList.filter((integration) => integration.connections.some(working)).map((integration) => integration.id);
  return { agents, opencode, shell, connected };
}
async function useFound(id, { engine, authFile = readFrom() }, signal) {
  const entry = id.startsWith("opencode:") ? readOpencode(authFile).find((each) => `opencode:${each.integrationID}` === id) : undefined;
  if (!entry)
    return { status: 404, message: "That key isn’t in opencode’s sign-ins any more." };
  if (entry.kind !== "key" || !entry.value)
    return { status: 409, message: "This is a sign-in, not a key: sign in to it here instead." };
  if (!engine?.port)
    return { status: 503, message: "The engine isn’t running." };
  try {
    const known = (await integrations(engine, signal)).find((each) => each.id === entry.integrationID);
    if (known?.connections.some((connection) => connection.type === "credential"))
      return { status: 200 };
    await call(engine, "POST", "/api/credential", { integrationID: entry.integrationID, label: "API key", value: entry.value, activate: true }, signal);
    return { status: 200 };
  } catch {
    return { status: 502, message: "The engine didn’t take the key. Try again in a moment." };
  }
}
async function* foundRoute(context) {
  const { request, route, signal, readEngine, bridge, json } = context;
  const method = request.method.toUpperCase();
  let engine = null;
  try {
    engine = readEngine();
  } catch {}
  if (route === "kuvo/accounts/found") {
    if (!["GET", "HEAD"].includes(method))
      return yield* json(405, {});
    return yield* json(200, await found({ engine, bridge: bridge() }, signal));
  }
  if (method !== "POST")
    return yield* json(405, {});
  const id = parsed(request.body)?.id;
  if (typeof id !== "string" || !id)
    return yield* json(400, { message: "Say which one to use." });
  const used = await useFound(id, { engine }, signal);
  return yield* json(used.status, used.status === 200 ? {} : { message: used.message });
}

// Packages/Box/src/link/areas/search.ts
import fs41 from "node:fs";
import path41 from "node:path";
var MOST = 50;
var MOST_TEXT = 400000;
var MOST_OUTPUT = 2000;
var texts = new Map;
var reading = new Map;
async function* searchRoute(context) {
  const { request, readEngine, bridge, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  const query = new URLSearchParams(request.path.split("?")[1] ?? "");
  const words = (query.get("q") ?? "").trim();
  if (!words)
    return yield* json(400, { message: "Say what to search for (q)." });
  const limit = Math.min(MOST, Math.max(1, Number(query.get("limit")) || 20));
  let places;
  try {
    places = [{ name: "engine", target: readEngine() }];
  } catch {
    return yield* json(503, { message: "This computer's engine isn't running yet. Search again in a moment." });
  }
  const agents = (() => {
    try {
      return bridge();
    } catch {
      return null;
    }
  })();
  if (agents)
    places.push({ name: "agents", target: agents });
  const lists = await Promise.all(places.map((place) => everySession(place.target).then((sessions) => ({ place, sessions }), () => ({ place, sessions: null }))));
  if (!lists[0].sessions)
    return yield* json(503, { message: "This computer's engine didn't answer. Search again in a moment." });
  const conversations = lists.flatMap(({ place, sessions }) => byConversation(sessions ?? []).map((conversation) => ({ ...conversation, place }))).sort((one, other) => other.top.time.updated - one.top.time.updated);
  const wanted = fold(words);
  const results = [];
  const findIn = async ({ top, subagents, place }) => {
    const sessions = [top, ...subagents];
    for (let start = 0;start < sessions.length; start += start === 0 ? 1 : 4) {
      const some = sessions.slice(start, start === 0 ? 1 : start + 4);
      const kept = await Promise.all(some.map((session) => textOf2(place.name, place.target, session)));
      const which = kept.findIndex((found) => found !== null && found.folded.includes(wanted));
      if (which < 0)
        continue;
      const found = kept[which];
      const session = some[which];
      const text = "text" in found ? found.text : fromDisk(key(place.name, session.id))?.text;
      if (text === undefined)
        continue;
      return { session: top.id, snippet: snippet(text, found.folded.indexOf(wanted), wanted.length), info: top, ...session === top ? {} : { subagent: session } };
    }
    return null;
  };
  for (let start = 0;start < conversations.length && results.length < limit; start += 4) {
    for (const found of await Promise.all(conversations.slice(start, start + 4).map(findIn))) {
      if (found && results.length < limit)
        results.push(found);
    }
  }
  const known = conversations.flatMap(({ top, subagents, place }) => [top, ...subagents].map((session) => key(place.name, session.id)));
  forgetGone(new Set(known), lists.filter((list) => list.sessions).map((list) => list.place.name));
  return yield* json(200, { results });
}
function byConversation(sessions) {
  const byID = new Map(sessions.map((session) => [session.id, session]));
  const topOf = (session) => {
    let at = session;
    for (let depth = 0;at.parentID && depth < 100; depth++) {
      const above = byID.get(at.parentID);
      if (!above || isHiddenRun(above))
        return null;
      at = above;
    }
    return at.parentID ? null : at;
  };
  const conversations = new Map;
  for (const session of sessions)
    if (!session.parentID && !isHiddenRun(session))
      conversations.set(session.id, { top: session, subagents: [] });
  for (const session of sessions) {
    if (!session.parentID || isHiddenRun(session))
      continue;
    const top = topOf(session);
    if (top)
      conversations.get(top.id)?.subagents.push(session);
  }
  for (const conversation of conversations.values())
    conversation.subagents.sort((one, other) => other.time.updated - one.time.updated);
  return [...conversations.values()];
}
var key = (place, id) => `${place}.${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
function textOf2(place, target, session) {
  const name = key(place, session.id);
  const updated = session.time.updated;
  const known = texts.get(name) ?? fromDisk(name);
  if (known?.updated === updated)
    return Promise.resolve(known);
  const already = reading.get(name);
  if (already)
    return already;
  const read = conversationOf2(target, session.id).then((messages) => {
    const cut = session.revert?.messageID ? messages.findIndex((message) => message.id === session.revert.messageID) : -1;
    const text = searchText(cut >= 0 ? messages.slice(0, cut) : messages, session.location?.directory ?? session.directory ?? "").slice(-MOST_TEXT);
    const kept = { updated, text, folded: fold(text) };
    texts.set(name, { updated, folded: kept.folded });
    toDisk(name, kept);
    return kept;
  }, () => null).finally(() => reading.delete(name));
  reading.set(name, read);
  return read;
}
function fromDisk(name) {
  try {
    const kept = JSON.parse(fs41.readFileSync(path41.join(SEARCH, name + ".json"), "utf8"));
    if (typeof kept.updated !== "number" || typeof kept.text !== "string" || typeof kept.folded !== "string")
      return null;
    texts.set(name, { updated: kept.updated, folded: kept.folded });
    return kept;
  } catch {
    return null;
  }
}
function toDisk(name, kept) {
  const file = path41.join(SEARCH, name + ".json");
  const writing = `${file}.${process.pid}.writing`;
  try {
    fs41.mkdirSync(SEARCH, { recursive: true });
    fs41.writeFileSync(writing, JSON.stringify(kept));
    fs41.renameSync(writing, file);
  } catch {
    fs41.rmSync(writing, { force: true });
  }
}
function forgetGone(known, places) {
  const listed = (name) => places.some((place) => name.startsWith(place + "."));
  for (const name of texts.keys())
    if (listed(name) && !known.has(name))
      texts.delete(name);
  try {
    for (const file of fs41.readdirSync(SEARCH)) {
      const name = file.slice(0, -5);
      const gone = file.endsWith(".json") ? listed(name) && !known.has(name) : file.endsWith(".writing") && Date.now() - fs41.statSync(path41.join(SEARCH, file)).mtimeMs > 60000;
      if (gone)
        fs41.rmSync(path41.join(SEARCH, file), { force: true });
    }
  } catch {}
}
function searchText(messages, directory) {
  const relative = (value) => directory && value.startsWith(directory + "/") ? value.slice(directory.length + 1) : value;
  const blocks = [];
  for (const message of messages) {
    if (message.type === "user") {
      const written = String(message.text ?? "");
      const mail = /^\[Message from (.*) · (ses_\S+|unknown)\] \([^\n]*\)\n\n([\s\S]*)$/.exec(written);
      const work = /^\[Work from (.*) · [^\]\n]+\]\n\n([\s\S]*?)(\n\n---\n[\s\S]*)?$/.exec(written);
      if (mail)
        blocks.push(mail[3]);
      else if (written.startsWith("[Wake-up] "))
        blocks.push(written.slice("[Wake-up] ".length));
      else if (work)
        blocks.push(work[2].trim());
      else {
        const files = (Array.isArray(message.files) ? message.files : []).map((file) => file.name).filter((name) => typeof name === "string" && !!name);
        blocks.push([ownWords(written), files.join(", ")].filter(Boolean).join(`

`));
      }
    } else if (message.type === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type === "text" && typeof part.text === "string" && part.text.trim())
          blocks.push(part.text.trim());
        else if (part.type === "tool") {
          const input = part.state?.input ?? {};
          const named = [input.filePath, input.path].filter((value) => typeof value === "string").map(relative).concat([input.command, input.pattern, input.query, input.url, input.description].filter((value) => typeof value === "string"));
          if (named.length)
            blocks.push(named.map((value) => value.split(`
`)[0]).join(" "));
        }
      }
    } else if (message.type === "shell") {
      const output = String(message.output?.output ?? "").trim().slice(0, MOST_OUTPUT);
      blocks.push([String(message.command ?? ""), output].filter(Boolean).join(`

`));
    }
  }
  return blocks.filter(Boolean).join(`

`);
}
function ownWords(written) {
  let words = written.trim();
  const kept = [];
  for (;; ) {
    const block = [["<attached-files>", "</attached-files>"], ["<review-comments>", "</review-comments>"], ["<named-agents>", "</named-agents>"], ["<sent-with>", "</sent-with>"], ["<from-widget>", "</from-widget>"], ["<from-phone>", "</from-phone>"]].find(([, end]) => words.endsWith(`
` + end));
    const open = block ? words.lastIndexOf(block[0] + `
`) : -1;
    if (!block || open < 0 || open > 0 && words[open - 1] !== `
`)
      break;
    const inside = words.slice(open + block[0].length + 1, words.length - block[1].length - 1).trim();
    if (block[0] === "<review-comments>")
      kept.unshift(inside);
    if (block[0] === "<attached-files>")
      kept.unshift(inside.split(`
`).map((line) => path41.basename(line.trim())).filter(Boolean).join(", "));
    words = words.slice(0, open).trim();
  }
  return [words, ...kept].filter(Boolean).join(`

`);
}
function fold(text) {
  return Array.from(text, (letter) => {
    const plain = Array.from(letter.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC"));
    const point = (plain.length === 1 ? plain[0] : letter).codePointAt(0) ?? 0;
    return point <= 65535 ? String.fromCharCode(point) : String.fromCharCode(57344 + point % 6400);
  }).join("");
}
function snippet(text, at, length) {
  const letters = Array.from(text);
  const start = Math.max(0, at - 16);
  const end = Math.min(letters.length, at + length + 80);
  const words = letters.slice(start, end).join("").replace(/[*`#>]/g, "").split(/\s+/).filter(Boolean).join(" ");
  return (start > 0 ? "…" : "") + words + (end < letters.length ? "…" : "");
}

// Packages/Box/src/link/areas/changes.ts
import { execFile as execFile3, execFileSync, spawn as spawn4 } from "node:child_process";
import fs43 from "node:fs";
import os4 from "node:os";
import path43 from "node:path";

// Packages/Box/src/link/areas/file.ts
import fs42 from "node:fs";
import path42 from "node:path";
import { fileURLToPath } from "node:url";
var FILE_LIMIT = 25 * 1024 * 1024;
var TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  css: "text/css",
  js: "text/javascript"
};
async function* fileAt(requestPath, json) {
  const query = requestPath.includes("?") ? requestPath.slice(requestPath.indexOf("?") + 1) : "";
  const asked = new URLSearchParams(query);
  const uri = asked.get("uri");
  const max = Number(asked.get("max") ?? FILE_LIMIT);
  let file;
  try {
    file = uri ? fileURLToPath(uri) : undefined;
  } catch {}
  if (!file)
    return yield* json(400, { message: "That isn’t a file:// address." });
  let stat;
  try {
    stat = fs42.statSync(file);
  } catch {}
  if (!stat?.isFile())
    return yield* json(404, { message: "That file isn’t there anymore." });
  if (stat.size > FILE_LIMIT)
    return yield* json(413, { message: "That file is too big to open here." });
  if (Number.isFinite(max) && stat.size > max)
    return yield* json(413, { message: "That file is too big to show here." });
  const type = TYPES[path42.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
  let handle;
  try {
    handle = await fs42.promises.open(file, "r");
  } catch (error) {
    const refused = ["EACCES", "EPERM"].includes(error?.code);
    return yield* json(refused ? 403 : 404, { message: refused ? "That file can’t be opened here." : "That file isn’t there anymore." });
  }
  yield { head: { status: 200, headers: { "content-type": type, "content-length": String(stat.size) } } };
  try {
    for await (const piece of handle.createReadStream({ highWaterMark: 32 * 1024 }))
      yield { body: piece };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Packages/Box/src/link/areas/changes.ts
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var HASHED = 500;
var AUTHOR = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
var SCOPES = ["uncommitted", "unstaged", "staged", "branch"];
var STATUSES = ["added", "deleted", "modified", "renamed"];
function git(folder, args, changing = false, more = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...changing ? {} : { GIT_OPTIONAL_LOCKS: "0" }, ...more };
  if (!changing) {
    return new Promise((resolve) => {
      execFile3("git", args, { cwd: folder, env, encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, timeout: 600000 }, (error, stdout, stderr) => resolve({ ok: !error, out: stdout ?? Buffer.alloc(0), said: String(stderr ?? "").trim() }));
    });
  }
  return new Promise((resolve) => {
    const out = [];
    const said = [];
    const child = spawn4("git", args, { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (piece) => out.push(piece));
    child.stderr.on("data", (piece) => said.push(piece));
    child.on("error", () => resolve({ ok: false, out: Buffer.alloc(0), said: "git isn’t there." }));
    child.on("exit", (code) => setImmediate(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok: code === 0, out: Buffer.concat(out), said: Buffer.concat(said).toString("utf8").trim() });
    }));
  });
}
var text = async (folder, args) => {
  const ran = await git(folder, args);
  return ran.ok ? ran.out.toString("utf8") : null;
};
function folderAt(value) {
  if (typeof value !== "string" || !path43.isAbsolute(value))
    return null;
  try {
    return fs43.statSync(value).isDirectory() ? value : null;
  } catch {
    return null;
  }
}
function inRepository(value) {
  if (typeof value !== "string" || path43.isAbsolute(value))
    return null;
  const name = value.endsWith("/") ? value.slice(0, -1) : value;
  return name && name.split("/").every((part) => part && part !== "." && part !== "..") ? name : null;
}
var realOr2 = (folder) => {
  try {
    return fs43.realpathSync(folder);
  } catch {
    return folder;
  }
};
async function changesIn(directory, scope, base) {
  const top = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!top)
    return { repository: false };
  const root = top;
  let against = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).ok ? "HEAD" : EMPTY_TREE;
  if (scope === "branch" && base) {
    const fork = (await text(root, ["merge-base", "HEAD", base]))?.trim();
    if (fork)
      against = fork;
  }
  const relative = path43.relative(realOr2(root), realOr2(directory));
  const limit = relative && !relative.startsWith("..") ? relative.split(path43.sep).join("/") : ".";
  const args = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U100000"];
  if (scope === "uncommitted" || scope === "branch")
    args.push(against);
  if (scope === "staged")
    args.push("--cached", against);
  const patch = await text(root, [...args, "--", limit]);
  if (patch === null)
    return null;
  let untracked = [];
  const hashes = {};
  if (scope !== "staged") {
    untracked = (await text(root, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z", "--", limit]) ?? "").split("\x00").filter(Boolean);
    const files = untracked.filter((name) => !name.endsWith("/")).slice(0, HASHED);
    const all = files.length ? (await text(root, ["hash-object", "--no-filters", "--", ...files]))?.trim().split(`
`) : [];
    if (all && all.length === files.length)
      files.forEach((name, at) => hashes[name] = all[at]);
    else
      for (const name of files) {
        const one = (await text(root, ["hash-object", "--no-filters", "--", name]))?.trim();
        if (one)
          hashes[name] = one;
      }
  }
  const status = scope === "branch" ? await text(root, ["status", "--porcelain", "--untracked-files=normal"]) : "x";
  return { repository: true, root, against, patch, untracked, hashes, uncommitted: status === null || status.length > 0 };
}
function trash(file) {
  const name = path43.basename(file);
  let into;
  if (process.platform === "darwin" && !process.env.KUVO_CHANGES_TRASH) {
    if (fs43.existsSync("/usr/bin/trash"))
      return void execFileSync("/usr/bin/trash", [file], { stdio: "ignore" });
    const bin = path43.join(os4.homedir(), ".Trash");
    into = path43.join(bin, name);
    for (let n = 2;fs43.existsSync(into); n++)
      into = path43.join(bin, `${name} ${n}`);
  } else {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "");
    into = path43.join(process.env.KUVO_CHANGES_TRASH || path43.join(K, "trash"), `${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`, name);
  }
  fs43.mkdirSync(path43.dirname(into), { recursive: true });
  try {
    fs43.renameSync(file, into);
  } catch (error) {
    if (error.code !== "EXDEV")
      throw error;
    fs43.cpSync(file, into, { recursive: true, verbatimSymlinks: true });
    fs43.rmSync(file, { recursive: true, force: true });
  }
}
var kind = (file) => {
  try {
    return fs43.lstatSync(file);
  } catch {
    return null;
  }
};
function inTheWay(root, name) {
  const folders = name.split("/").slice(0, -1);
  let at = root;
  for (const folder of folders) {
    at = path43.join(at, folder);
    const found = kind(at);
    if (!found)
      return null;
    if (!found.isDirectory())
      return at;
  }
  return null;
}
async function perform(action, root, file, scope) {
  const paths = [file.path, ...file.oldPath ? [file.oldPath] : []];
  const on = async (args) => (await git(root, ["--literal-pathspecs", ...args], true)).ok;
  const run = async (args) => await on(args) ? null : `git couldn’t ${args[0] ?? "do that"} ${file.path}.`;
  const away = (target) => {
    try {
      trash(target);
      return null;
    } catch {
      return `Couldn’t move ${path43.basename(target)} out of the way.`;
    }
  };
  if (action === "stage") {
    const old = file.oldPath && await on(["ls-files", "--error-unmatch", "--", file.oldPath]) ? [file.oldPath] : [];
    return run(["add", "-A", "--", file.path, ...old]);
  }
  if (action === "unstage") {
    if (await on(["restore", "--staged", "--", ...paths]))
      return null;
    if (!await on(["rev-parse", "--git-dir"]) || await on(["rev-parse", "--verify", "-q", "HEAD"]))
      return `git couldn’t restore ${file.path}.`;
    return run(["rm", "--cached", "-f", "-q", "--", ...paths]);
  }
  const untrack = async (name) => await on(["ls-files", "--error-unmatch", "--", name]) ? run(["rm", "--cached", "-f", "-q", "--", name]) : null;
  const clear = async (names) => {
    for (const name of names) {
      const blocking = inTheWay(root, name);
      if (blocking) {
        const failed = away(blocking);
        if (failed)
          return failed;
        continue;
      }
      const target = path43.join(root, name);
      if (!kind(target)?.isDirectory())
        continue;
      const kept = await text(root, ["--literal-pathspecs", ...scope === "unstaged" ? ["ls-files", "-s"] : ["ls-tree", "HEAD"], "--", name]);
      const entry = kept?.split(`
`).find((line) => line.slice(line.indexOf("\t") + 1) === name);
      if (!entry || !/^(100|120)/.test(entry))
        continue;
      const failed = away(target);
      if (failed)
        return failed;
    }
    return null;
  };
  const gone = (name) => kind(path43.join(root, name)) ? away(path43.join(root, name)) : null;
  if (file.status === "added")
    return await untrack(file.path) ?? gone(file.path);
  if (file.status === "renamed" && file.oldPath) {
    const failed = await untrack(file.path) ?? await clear([file.oldPath]) ?? await run(scope === "unstaged" ? ["restore", "--worktree", "--", file.oldPath] : ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.oldPath]);
    return failed ?? gone(file.path);
  }
  const failed = await clear(scope === "unstaged" ? paths : [file.path]);
  if (failed)
    return failed;
  return scope === "unstaged" ? run(["restore", "--worktree", "--", ...paths]) : run(["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
}
async function commit(directory, message, push, author) {
  const root = (await text(directory, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!root)
    return "Not a git repository.";
  const said = async (args) => {
    const ran = await git(root, args, true, author);
    if (ran.ok)
      return null;
    const words = (ran.out.toString("utf8") + `
` + ran.said).trim();
    return words || `git ${args[0]} failed.`;
  };
  if (!await hasStaged(root)) {
    const relative = path43.relative(realOr2(root), realOr2(directory));
    const failed = await said(["add", "-A", "--", relative && !relative.startsWith("..") ? relative : "."]);
    if (failed)
      return failed;
  }
  const failed = await said(["commit", "-m", message]);
  if (failed || !push)
    return failed;
  let pushed = await said(["push"]);
  if (pushed?.includes("no upstream branch"))
    pushed = await said(["push", "-u", "origin", "HEAD"]);
  return pushed && `Committed, but the push didn’t go through:
${pushed}`;
}
var hasStaged = async (directory) => !(await git(directory, ["diff", "--cached", "--quiet"])).ok;
async function commitDiff(directory, limit = 40000) {
  const staged = await hasStaged(directory);
  let diff;
  if (staged)
    diff = await text(directory, ["diff", "--cached", "--no-color", "--no-ext-diff"]) ?? "";
  else {
    diff = await text(directory, ["diff", "HEAD", "--no-color", "--no-ext-diff", "--", "."]) ?? "";
    const untracked = (await text(directory, ["ls-files", "--others", "--exclude-standard"]) ?? "").trim();
    if (untracked)
      diff += `
New files:
` + untracked;
  }
  return { diff: diff.length > limit ? diff.slice(0, limit) + `
…` : diff, staged };
}
async function* changesRoute(context) {
  const { request, route, json } = context;
  const method = request.method.toUpperCase();
  if (route === "kuvo/git/show") {
    if (method !== "GET")
      return yield* json(405, {});
    const asked = new URLSearchParams(request.path.split("?")[1] ?? "");
    const root = folderAt(asked.get("root"));
    const object = asked.get("object") ?? "";
    if (!root || !/^[0-9A-Za-z_.\-~^/]*:[^\0]+$/.test(object) || object.startsWith("-"))
      return yield* json(400, { message: "Name a repository and a file in it." });
    const ran = await git(root, ["cat-file", "-s", object]);
    if (!ran.ok)
      return yield* json(404, { message: "git has no such file." });
    if (Number(ran.out.toString().trim()) > FILE_LIMIT)
      return yield* json(413, { message: "That file is too big to open here." });
    const shown = await git(root, ["cat-file", "blob", object]);
    if (!shown.ok)
      return yield* json(404, { message: "git has no such file." });
    return yield* [{ head: { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(shown.out.length) } } }, { body: shown.out }];
  }
  if (method !== "POST")
    return yield* json(405, {});
  const body = parsed(request.body) ?? {};
  const scope = body.scope ?? "uncommitted";
  if (!SCOPES.includes(scope))
    return yield* json(400, { message: "That isn’t a scope." });
  if (route === "kuvo/git/changes") {
    const directory = folderAt(body.directory);
    if (!directory)
      return yield* json(404, { message: "That folder isn’t there." });
    const found = await changesIn(directory, scope, typeof body.base === "string" && body.base && !body.base.startsWith("-") ? body.base : undefined);
    return yield* found ? json(200, found) : json(500, { message: "git couldn’t read the changes." });
  }
  if (route === "kuvo/git/stage" || route === "kuvo/git/unstage" || route === "kuvo/git/discard") {
    const root = folderAt(body.root);
    const name = inRepository(body.path);
    const old = body.oldPath === undefined || body.oldPath === null ? undefined : inRepository(body.oldPath);
    const status = body.status ?? "modified";
    if (!root || !name || old === null || !STATUSES.includes(status))
      return yield* json(400, { message: "Name a repository and a file in it." });
    const failed = await perform(route.slice("kuvo/git/".length), root, { path: name, oldPath: old, status }, scope);
    return yield* failed ? json(422, { message: failed }) : json(200, {});
  }
  if (route === "kuvo/git/commit" || route === "kuvo/git/commit-diff") {
    const directory = folderAt(body.directory);
    if (!directory)
      return yield* json(404, { message: "That folder isn’t there." });
    if (route === "kuvo/git/commit-diff")
      return yield* json(200, await commitDiff(directory));
    const message = typeof body.message === "string" ? body.message : "";
    if (!message.trim())
      return yield* json(400, { message: "Write a commit message." });
    const given = body.author ?? {};
    const author = Object.fromEntries(AUTHOR.flatMap((key) => typeof given[key] === "string" ? [[key, given[key]]] : []));
    const failed = await commit(directory, message, body.push === true, author);
    return yield* failed ? json(422, { message: failed }) : json(200, {});
  }
  return yield* json(404, {});
}

// Packages/Box/src/link/areas/attention.ts
async function* appNoticeRoute(context) {
  const { request, route, hold, json } = context;
  if (!IS_MAC || !request.fromApp || !hold)
    return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  const given = parsed(request.body);
  if (route === "kuvo/attention/answered") {
    if (typeof given?.id !== "string")
      return yield* json(400, { message: "Send {id}." });
    hold.resolve(given.id);
    return yield* json(200, {});
  }
  if (!isObject(given?.notice) || typeof given.notice.title !== "string")
    return yield* json(400, { message: "Send {notice}." });
  macTell(given.notice);
  return yield* json(200, {});
}
async function* attentionRoute(context) {
  const { request, phone, hold, json } = context;
  const method = request.method.toUpperCase();
  if (!hold)
    return yield* json(503, { message: "Only this machine's bridge holds its notices." });
  if (method === "GET" || method === "HEAD")
    return yield* json(200, { inUse: hold.inUse, held: hold.count });
  if (method !== "POST")
    return yield* json(405, {});
  const given = attentionGiven(parsed(request.body));
  if (!given)
    return yield* json(400, { message: "Say for how many seconds you're in use (for: 0 for not), and which conversations are on your screen (sessions)." });
  hold.attend(IS_MAC && request.fromApp ? "mac" : `phone:${phone?.key?.toString("base64url") ?? ""}`, given);
  if (IS_MAC && request.fromApp)
    macAttendPeers(parsed(request.body), given);
  return yield* json(200, { for: given.seconds });
}

// Packages/Box/src/link/areas/bots.ts
async function* botTemplatesRoute(context) {
  const { request, info, json } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase()))
    return yield* json(405, {});
  const kit = readKit();
  if (!kit)
    return yield* json(409, { message: NO_KIT });
  return yield* json(200, botTemplates(kit, info.name));
}
async function* newBotRoute(context) {
  const { request, signal, readEngine, bridge, info, json } = context;
  const { status, value } = await makeBot(parsed(request.body), readEngine, bridge, info.name, signal);
  return yield* json(status, value);
}
async function* botRoute(context, oneBot) {
  const { request, signal, readEngine, bridge, info, json } = context;
  let id;
  try {
    id = decodeURIComponent(oneBot[1]);
  } catch {
    return yield* json(404, { message: "That bot isn’t there any more." });
  }
  const { status, value } = request.method.toUpperCase() === "PATCH" ? await changeBot(id, parsed(request.body), readEngine, bridge, info.name, signal) : await deleteBot(id, readEngine, bridge, signal);
  return yield* json(status, value);
}
async function* arrivedRoute(context, arrived) {
  const { request, readEngine, bridge, info, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  let id;
  try {
    id = decodeURIComponent(arrived[1]);
  } catch {
    return yield* json(404, { message: "That bot isn’t there any more." });
  }
  const { status, value } = await settleBot(id, readEngine, bridge, info.name);
  return yield* json(status, value);
}
async function* retellRoute(context) {
  const { request, readEngine, readBridge, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  for (const read of [readEngine, readBridge]) {
    let target = null;
    try {
      target = read();
    } catch {}
    if (target?.port)
      await freshenBots(target);
  }
  return yield* json(200, {});
}
async function* botEventsRoute(context) {
  const { request, signal, info, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ bots: listBots(info.name) }), botFollowers, signal, { folders: [BOTS] });
}
async function* botsRoute(context) {
  const { request, info, text } = context;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase()))
    return yield* text(405, "Read them with GET.");
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ bots: listBots(info.name) })) };
  return;
}

// Packages/Box/src/link/areas/folders.ts
import fs44 from "node:fs";
import path44 from "node:path";
function listFolders(requestPath) {
  const query = new URLSearchParams(requestPath.split("?")[1] ?? "");
  const home = homeFolder();
  const given = (query.get("path") ?? "").trim();
  const folder = !given || given === "~" ? home : given.startsWith("~/") ? path44.join(home, given.slice(2)) : given;
  if (!path44.isAbsolute(folder))
    return { status: 400, value: { message: "Send a folder's full path, or one that starts with ~/." } };
  const at = path44.resolve(folder);
  let entries;
  try {
    entries = fs44.readdirSync(at, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR")
      return { status: 404, value: { message: `There's no folder ${at} here.` } };
    return { status: 403, value: { message: `${at} can't be read here.` } };
  }
  const hidden = query.get("hidden") === "1";
  const asks = at === home ? promptedFolders() : new Set;
  const isFolder = (entry) => entry.isDirectory() || entry.isSymbolicLink() && (() => {
    try {
      return fs44.statSync(path44.join(at, entry.name)).isDirectory();
    } catch {
      return false;
    }
  })();
  const folders = entries.filter((entry) => (hidden || !entry.name.startsWith(".")) && isFolder(entry)).map((entry) => !asks.has(entry.name) && fs44.existsSync(path44.join(at, entry.name, ".git")) ? { name: entry.name, repository: true } : { name: entry.name }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { status: 200, value: { path: at, home, parent: at === path44.dirname(at) ? null : path44.dirname(at), folders } };
}
function makeFolder(body) {
  const given = typeof body?.path === "string" ? body.path.trim() : "";
  const home = homeFolder();
  const folder = given.startsWith("~/") ? path44.join(home, given.slice(2)) : given;
  if (!path44.isAbsolute(folder))
    return { status: 400, value: { message: "Send the new folder's full path, or one that starts with ~/." } };
  const at = path44.resolve(folder);
  if (fs44.existsSync(at))
    return { status: 409, value: { message: `There's already something called ${path44.basename(at)} there.` } };
  try {
    fs44.mkdirSync(at);
  } catch (error) {
    if (error?.code === "ENOENT")
      return { status: 404, value: { message: `There's no folder ${path44.dirname(at)} here.` } };
    return { status: 403, value: { message: `A folder can't be made in ${path44.dirname(at)} here.` } };
  }
  return { status: 200, value: { path: at } };
}
async function* foldersRoute(context) {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST")
    return yield* json(405, {});
  const { status, value } = method === "GET" ? listFolders(request.path) : makeFolder(parsed(request.body));
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/artifacts.ts
var ARTIFACT_ROUTE = /^kuvo\/artifacts(?:\/(?:events|timeline(?:\/events)?|storage(?:\/clear)?|art_[0-9a-f]{24}(?:\/(?:pin|restore|versions\/\d+(?:\/changes)?))?))?$/;
async function* forwardArtifacts(target, route, request, signal) {
  const method = request.method.toUpperCase();
  const sends = method === "POST";
  const query = request.path.includes("?") ? request.path.slice(request.path.indexOf("?")) : "";
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${target.port}/api/kuvo/link/artifacts${route.slice("kuvo/artifacts".length)}${query}`, {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${target.password}`).toString("base64")}`, ...sends ? { "content-type": "application/json" } : {} },
      body: sends ? Buffer.from(request.body ?? []) : undefined,
      signal
    });
  } catch {
    if (signal?.aborted)
      return;
    return yield* groupJSON(503, { message: notAnswering() });
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return yield* groupJSON(503, { message: notAnswering() });
  }
  const headers = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const length = response.headers.get("content-length");
  if (length)
    headers["content-length"] = length;
  yield { head: { status: response.status, headers } };
  try {
    for await (const chunk of response.body ?? [])
      yield { body: Buffer.from(chunk) };
  } catch {}
}
var notAnswering = () => IS_MAC ? "What your agents made on this Mac can’t be read right now. Try again in a moment." : "The coding agents’ bridge here isn’t answering. Try again in a moment.";
async function* artifactsRoute(context) {
  const { request, signal, route, bridge } = context;
  const target = bridge();
  if (!target)
    return yield* groupJSON(503, { message: IS_MAC ? "What your agents made on this Mac is still loading. Try again in a moment." : "What agents made here is kept by the coding agents' bridge, which isn't running on this machine." });
  return yield* forwardArtifacts(target, route, request, signal);
}

// Packages/Box/src/link/areas/info.ts
import fs45 from "node:fs";
import path45 from "node:path";

// Packages/Box/src/link/version.ts
var BRIDGE_VERSION = "0.9.100";

// Packages/Box/src/link/areas/info.ts
async function* infoRoute(context) {
  const { readEngine, bridge, info } = context;
  let engine = {};
  try {
    engine = readEngine();
  } catch {}
  let started = null;
  if (engine.pid)
    try {
      started = fs45.statSync(ENGINE_FILE).mtimeMs / 1000;
    } catch {}
  const running = Boolean(engine.pid && processRuns(engine.pid, `${K}/engine/`));
  const stopped = fs45.existsSync(path45.join(RUN, "stopped"));
  const chats = path45.join(K, "chats");
  try {
    fs45.mkdirSync(chats, { recursive: true });
  } catch {}
  const notes = engine.notes ?? {};
  const home = typeof notes.mac === "string" ? { mac: notes.mac, ...typeof notes.macName === "string" ? { name: notes.macName } : {} } : undefined;
  yield { head: { status: 200, headers: { "content-type": "application/json" } } };
  yield { body: Buffer.from(JSON.stringify({ kind: "machine", bridge: BRIDGE_VERSION, engine: engine.version ?? null, started, running, stopped, agents: Boolean(bridge()), chats, features: FEATURES, ...home ? { home } : {}, ...info })) };
  return;
}

// Packages/Box/src/link/areas/named.ts
async function* namedRoute(context) {
  const { request, readEngine, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  const link = readLink();
  const fresh = await ownAgents(readEngine, link?.id).catch(() => null);
  if (fresh)
    keepOwn(fresh, link?.id ?? null);
  const own = fresh ?? ownAsLast(link?.id ?? null);
  return yield* json(200, { agents: namedAgents(own, peersOf(link), readPeerAgents(undefined, undefined, link), movedOf(link)) });
}

// Packages/Box/src/link/areas/personalities.ts
import path46 from "node:path";
async function* personalityEventsRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
  return yield* followed(() => ({ personalities: readPersonalities().personalities }), personalityFollowers, signal, { folders: [path46.dirname(PERSONALITIES_FILE)], recursive: false });
}
async function* personalitiesDocumentRoute(context) {
  const { request, route, readEngine, readBridge, json } = context;
  if (!request.fromApp)
    return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  const method = request.method.toUpperCase();
  if (route === "kuvo/personalities/document")
    return yield* method === "GET" ? json(200, personalitiesDocument()) : json(405, {});
  if (method !== "POST")
    return yield* json(405, {});
  const [status, value] = takePersonalitiesDocument(parsed(request.body), readEngine, readBridge);
  return yield* json(status, value);
}
async function* personalityRoute(context, personality) {
  const { request, readEngine, readBridge, json } = context;
  let id;
  try {
    id = personality[1] === undefined ? undefined : decodeURIComponent(personality[1]);
  } catch {
    return yield* json(404, {});
  }
  const [status, value] = answerPersonalities(request.method.toUpperCase(), id, parsed(request.body));
  if (status === 200 && id !== undefined)
    retellBots([id], readEngine, readBridge).catch(() => {});
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/phones.ts
async function* phonesRoute(context) {
  const { phone, json } = context;
  const link = readLink();
  const asking = phone?.key?.toString("base64url");
  return yield* json(200, {
    phones: (link?.phones ?? []).map((each) => ({ key: each.key, name: each.name, added: each.added ?? null, pairing: each.pairing ?? "", you: each.key === asking }))
  });
}
async function* phonesRemoveRoute(context) {
  const { request, phone, phonesChanged, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  const given = parsed(request.body);
  const asMac = IS_MAC && request.fromApp;
  const changed = updateLink((kept) => {
    const link = kept ?? (asMac ? { phones: [], removed: [] } : null);
    return link && (asMac ? removeAsMac(link, given?.phones) : removePhones(link, phone?.key?.toString("base64url"), given?.phones)) ? link : null;
  });
  if (!changed)
    return yield* json(400, { message: "Only phones paired here can be removed, and never your Mac." });
  noteDocsChanged();
  setTimeout(() => phonesChanged(readLink() ?? changed), 200);
  return yield* json(200, {});
}
async function* pairingRoute(context) {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  const slot = IS_MAC && request.fromApp ? "appPairing" : "pairing";
  if (method === "DELETE") {
    const token = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("token");
    updateLink((link) => {
      if (!link?.[slot] || token && link[slot].token !== token)
        return null;
      delete link[slot];
      return link;
    });
    macLink.wake?.();
    return yield* json(200, {});
  }
  if (method !== "POST")
    return yield* json(405, {});
  if (IS_MAC && !macLink.config?.phones)
    return yield* json(409, { message: "The phone link is off on this Mac." });
  const link = updateLink((current) => current?.relay && current?.secret ? { ...current, [slot]: newPairingToken() } : null);
  if (!link)
    return yield* json(409, { message: IS_MAC ? "The phone link isn't ready yet. Try again in a moment." : "This machine has no relay to pair through." });
  macLink.wake?.();
  return yield* json(200, { link: pairingLink({ ...link, pairing: link[slot] }), ends: Math.floor(link[slot].expires / 1000) });
}

// Packages/Box/src/link/areas/plugins.ts
var testNpm = IN_TEST_FOLDER ? process.env.KUVO_TEST_NPM : undefined;
var NPM = testNpm ?? "https://registry.npmjs.org";
var NPM_SPEC = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@([^\s@/]+))?$/;
async function searchPlugins(query, signal) {
  const text = String(query ?? "").trim().toLowerCase();
  const ask = async (address, headers = {}) => {
    const answered = await fetch(address, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (answered.status === 404)
      return null;
    if (!answered.ok)
      throw new Error(`npm answered ${answered.status}.`);
    return answered.json();
  };
  const spec = text.match(NPM_SPEC);
  const [found, named] = await Promise.all([
    ask(`${NPM}/-/v1/search?size=20&text=${encodeURIComponent(text ? `${text} keywords:opencode` : "keywords:opencode-plugin")}`),
    spec ? ask(`${NPM}/${spec[1].replace("/", "%2F")}`, { accept: "application/vnd.npm.install-v1+json" }).catch(() => {
      return;
    }) : undefined
  ]);
  const packages = (found?.objects ?? []).map((each) => ({
    name: each.package?.name,
    version: each.package?.version,
    description: each.package?.description || undefined,
    weekly: each.downloads?.weekly
  })).filter((each) => typeof each.name === "string");
  const answer = { packages };
  if (spec && named?.name) {
    const listed = packages.find((each) => each.name === named.name);
    const version = spec[2] && named.versions?.[spec[2]] ? spec[2] : named["dist-tags"]?.[spec[2]] ?? named["dist-tags"]?.latest;
    answer.packages = [{ name: named.name, version, description: listed?.description, weekly: listed?.weekly }, ...packages.filter((each) => each !== listed)];
    const exact = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(spec[2] ?? "") || /^[a-z][\w-]*$/i.test(spec[2] ?? "");
    if (spec[2] && exact && !named.versions?.[spec[2]] && !named["dist-tags"]?.[spec[2]])
      answer.missing = `${named.name}@${spec[2]}`;
  } else if (named === null) {
    answer.missing = spec[1];
  }
  return answer;
}
async function* pluginSearchRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  try {
    return yield* json(200, await searchPlugins(new URLSearchParams(request.path.split("?")[1] ?? "").get("q"), signal));
  } catch (error) {
    return yield* json(502, { message: "npm couldn't be reached from here. Check this computer's internet connection, then try again." });
  }
}

// Packages/Box/src/link/areas/programs.ts
import fs46 from "node:fs";
import path47 from "node:path";
function findProgram(requestPath, PATH = process.env.PATH ?? "") {
  const name = (new URLSearchParams(requestPath.split("?")[1] ?? "").get("name") ?? "").trim();
  if (!name)
    return { status: 400, value: { message: "Name the program (name)." } };
  const runnable = (file) => {
    try {
      fs46.accessSync(file, fs46.constants.X_OK);
      return fs46.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (/^\.\.?\//.test(name) || name.includes("$") || /^~[^/]/.test(name))
    return { status: 200, value: { name, path: null, unknown: true } };
  if (name.includes("/")) {
    const file = name.startsWith("~/") ? path47.join(homeFolder(), name.slice(2)) : name;
    return { status: 200, value: { name, path: path47.isAbsolute(file) && runnable(file) ? file : null } };
  }
  const found = PATH.split(path47.delimiter).filter(Boolean).map((folder) => path47.join(folder, name)).find(runnable);
  return { status: 200, value: { name, path: found ?? null } };
}
async function* programsRoute(context) {
  const { request, json } = context;
  if (request.method.toUpperCase() !== "GET")
    return yield* json(405, {});
  const { status, value } = findProgram(request.path);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/providers.ts
async function providerModels(body, signal) {
  const given = typeof body?.url === "string" ? body.url.trim() : "";
  let base;
  try {
    base = new URL(given);
    if (!["http:", "https:"].includes(base.protocol))
      throw new Error;
  } catch {
    return { status: 400, value: { message: "Send the provider's address, starting with http:// or https://." } };
  }
  const written = body?.headers && typeof body.headers === "object" ? body.headers : {};
  const headers = {};
  for (const [name, value] of Object.entries(written)) {
    if (typeof value === "string" && !value.includes("{env:") && !value.includes("{file:") && /^[!-~]+$/.test(name))
      headers[name] = value;
  }
  if (body?.api === "anthropic")
    headers["anthropic-version"] ??= "2023-06-01";
  const address = new URL(base.href);
  address.pathname = `${address.pathname.replace(/\/+$/, "")}/models`;
  if (body?.api === "anthropic" && !address.searchParams.has("limit"))
    address.searchParams.set("limit", "1000");
  const deadline = AbortSignal.timeout(1e4);
  let answered;
  try {
    answered = await fetch(address, { headers, redirect: "manual", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError";
    return { status: 200, value: { reached: false, message: timedOut ? "It didn't answer in time." : "Nothing answers at this address." } };
  }
  if (answered.status >= 300 && answered.status < 400) {
    const to = answered.headers.get("location");
    return { status: 200, value: { reached: false, message: to ? `It sends its list of models to ${new URL(to, address).host}. Use that address instead.` : `It answered ${answered.status} for its list of models.` } };
  }
  if (answered.status === 401 || answered.status === 403)
    return { status: 200, value: { reached: true, needsKey: true } };
  if (!answered.ok)
    return { status: 200, value: { reached: false, message: `It answered ${answered.status} for its list of models. Check the address, often ending in /v1.` } };
  const listed = await answered.json().catch(() => null);
  const entries = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : Array.isArray(listed?.models) ? listed.models : null;
  if (!entries)
    return { status: 200, value: { reached: false, message: "It answered, but not with a list of models. Check the address, often ending in /v1." } };
  const ids = entries.map((each) => typeof each === "string" ? each : each?.id ?? each?.name);
  const models = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))].sort();
  return { status: 200, value: { reached: true, models } };
}
async function* providerModelsRoute(context) {
  const { request, signal, json } = context;
  if (request.method.toUpperCase() !== "POST")
    return yield* json(405, {});
  const { status, value } = await providerModels(parsed(request.body), signal);
  return yield* json(status, value);
}

// Packages/Box/src/link/areas/apply.ts
import fs48 from "node:fs";

// Packages/Box/src/link/areas/mcp-catalog.ts
import fs47 from "node:fs";
import path48 from "node:path";

// Packages/Box/src/shared/routes/settings.ts
var CONFIG = map(any);
var CONFIG_APPLIED = object({
  made: list(object({ path: list(string), value: any })),
  leftOut: list(list(string)),
  kept: list(list(string)),
  macOnly: list(string),
  keys: list(string),
  applied: bool,
  settings: CONFIG
});
var MCP_ACCESS = ["signIn", "open", "local"];
var MCP_CATALOG_SERVER = object({
  id: string,
  title: string,
  summary: string,
  access: words(...MCP_ACCESS),
  added: bool,
  integration: bool,
  macOnly: bool
});
var MCP_CATALOG = object({ servers: list(MCP_CATALOG_SERVER) });
var KEYS = object({ keys: list(string) });
var KEY2 = object({ value: string });

// Packages/Box/src/link/areas/mcp-catalog.ts
var accessOf = (server) => {
  const access = server.access ?? "open";
  return MCP_ACCESS.includes(access) ? access : null;
};
var offered = (server, mac) => typeof server?.id === "string" && (mac || !server.macOnly) && accessOf(server) !== null;
var CATALOG_FILE = path48.join(K, "bin", "mcp-catalog.json");
function mcpCatalog(settings, file = CATALOG_FILE, mac = IS_MAC) {
  let servers = [];
  try {
    servers = JSON.parse(fs47.readFileSync(file, "utf8")).servers ?? [];
  } catch {}
  return {
    servers: servers.filter((server) => offered(server, mac)).map((server) => {
      const added = valueAt(settings, [...SERVERS, server.id]) !== undefined;
      return {
        id: server.id,
        title: String(server.title ?? ""),
        summary: String(server.summary ?? ""),
        access: accessOf(server),
        added,
        integration: added && Boolean(server.integration),
        macOnly: mac && Boolean(server.macOnly)
      };
    })
  };
}
function addFromCatalog(id, file = CONFIG_FILE, catalog = CATALOG_FILE, lock = CONFIG_LOCK, mac = IS_MAC) {
  let servers = [];
  try {
    servers = JSON.parse(fs47.readFileSync(catalog, "utf8")).servers ?? [];
  } catch {}
  const server = servers.find((each) => each?.id === id && offered(each, mac));
  if (!server || !isObject(server.settings))
    return { status: 404 };
  const { settings, problem } = readSettings(file);
  if (problem)
    return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
  if (valueAt(settings, [...SERVERS, id]) !== undefined)
    return { status: 200, settings };
  return changeSettings([{ path: [...SERVERS, id], value: { codemode: false, ...server.settings } }], file, lock);
}

// Packages/Box/src/link/areas/apply.ts
var BUILT_IN_AGENTS = ["build", "plan", "general", "explore", "compaction", "title", "summary"];
var isRules = (keys) => ["permissions", "policies"].includes(keys[keys.length - 1]);
function keptOwn(change) {
  if (sameJSON(change.path, ["shell"]))
    return true;
  if (!sameJSON(change.path, ["worktree", "directory"]))
    return false;
  const folder = typeof change.after === "string" ? change.after : typeof change.before === "string" ? change.before : null;
  return folder !== null && (folder.startsWith("/") || folder.startsWith("~"));
}
function entryOf(keys) {
  if (keys[0] === "mcp" && keys.length >= 4 && keys[1] === "servers")
    return keys.slice(0, 3);
  if (keys[0] === "agents" && keys.length >= 3 && BUILT_IN_AGENTS.includes(keys[1]))
    return null;
  if (["agents", "commands", "providers"].includes(keys[0]) && keys.length >= 3)
    return keys.slice(0, 2);
  return null;
}
function neededFor(change) {
  if (sameJSON(change.path, ["default_agent"]) && typeof change.after === "string" && !BUILT_IN_AGENTS.includes(change.after))
    return ["agents", change.after];
  return entryOf(change.path);
}
function macOnlyServers(file = CATALOG_FILE) {
  try {
    const catalog = JSON.parse(fs48.readFileSync(file, "utf8"));
    const named = [...Array.isArray(catalog.macOnly) ? catalog.macOnly : [], ...(catalog.servers ?? []).filter((server) => server?.macOnly).map((server) => server.id)];
    return new Set(named.filter((id) => typeof id === "string"));
  } catch {
    return new Set;
  }
}
function keyNamesIn(value, names = new Set) {
  if (typeof value === "string")
    for (const [name] of value.matchAll(/KUVO_KEY_[A-Z0-9_]+/g)) {
      if (!name.includes("__"))
        names.add(name);
    }
  else if (Array.isArray(value))
    value.forEach((each) => keyNamesIn(each, names));
  else if (isObject(value))
    Object.values(value).forEach((each) => keyNamesIn(each, names));
  return names;
}
function translateSettings(changes, settings, { mac = IS_MAC, macOnly = macOnlyServers() } = {}) {
  let here = settings;
  const made = [], leftOut = [], kept = [], stayed = [];
  const has = (list, item) => list.some((each) => sameJSON(each, item));
  for (const change of changes) {
    const keys = change.path;
    if (!mac && keys.length >= 3 && keys[0] === "mcp" && keys[1] === "servers" && macOnly.has(keys[2])) {
      if (!stayed.includes(keys[2]))
        stayed.push(keys[2]);
      continue;
    }
    if (keptOwn(change)) {
      if (!has(kept, keys))
        kept.push(keys);
      continue;
    }
    const entry = neededFor(change);
    if (entry && valueAt(here, entry) === undefined) {
      if (!has(leftOut, entry))
        leftOut.push(entry);
      continue;
    }
    const before = change.before ?? null, after = change.after ?? null;
    let value = keysNamedHere(after);
    if (isRules(keys) && (Array.isArray(before) || Array.isArray(after)) && (before === null || Array.isArray(before)) && (after === null || Array.isArray(after))) {
      const was = (before ?? []).map(keysNamedHere), now = (after ?? []).map(keysNamedHere);
      const current = Array.isArray(valueAt(here, keys)) ? valueAt(here, keys) : [];
      const removed = was.filter((item) => !has(now, item));
      const added = now.filter((item) => !has(was, item));
      const staying = current.filter((item) => !has(removed, item));
      const merged = [...staying, ...added.filter((item) => !has(staying, item))];
      value = merged.length ? merged : null;
    }
    made.push({ path: keys, value });
    here = settingAt(here, keys, value);
  }
  return { made, leftOut, kept, macOnly: stayed };
}
function applySettings(body, file = CONFIG_FILE, lock = CONFIG_LOCK, options = {}) {
  const changes = body?.changes;
  const fits = Array.isArray(changes) && changes.length >= 1 && changes.length <= 100 && changes.every((change) => Array.isArray(change?.path) && change.path.length >= 1 && change.path.length <= 16 && change.path.every((key) => typeof key === "string" && key.length >= 1 && key.length <= 200));
  if (!fits)
    return { status: 400, message: 'Send {"changes": [{"path": [keys…], "before": …, "after": …}]}.' };
  return locked(lock, () => {
    const { settings, problem } = readSettings(file);
    if (problem)
      return { status: 409, message: `The engine's settings file can't be changed from here: ${problem}`, problem };
    const result = translateSettings(changes, settings, options);
    if (result.made.some((change) => change.path.slice(0, -1).some((_, at) => {
      const above = valueAt(settings, change.path.slice(0, at + 1));
      return above !== undefined && !isObject(above);
    })))
      return { status: 400, message: "A path goes through objects only; send a list whole, at its own path." };
    const keys = [...keyNamesIn(result.made.map((change) => change.value))].sort();
    const applied = result.made.length > 0 || !result.leftOut.length && !result.kept.length && !result.macOnly.length;
    if (body.dry === true || !result.made.length)
      return { status: 200, ...result, keys, applied, settings };
    const written = writeSettings(settings, result.made, file);
    if (written.status !== 200)
      return written;
    return { status: 200, ...result, keys, applied, settings: written.settings };
  });
}

// Packages/Box/src/link/areas/settings.ts
async function* settingsRoute(context) {
  const { request, route, json } = context;
  if (!ownsSettings())
    return yield* json(409, { message: "This machine's settings still come from your Mac. Connect it from Kuvo Code on your Mac once." });
  const method = request.method.toUpperCase();
  const answered = ({ status, settings, message, problem }) => json(status, message ? problem ? { message, problem } : { message } : settings ?? {});
  if (route === "kuvo/config") {
    if (method === "GET") {
      const { settings, problem } = readSettings();
      return yield* problem ? json(409, { message: `The engine's settings file can't be changed from here: ${problem}`, problem }) : json(200, settings);
    }
    if (method === "PATCH")
      return yield* answered(changeSettings(parsed(request.body)?.changes));
    return yield* json(405, {});
  }
  if (route === "kuvo/config/apply") {
    if (method !== "POST")
      return yield* json(405, {});
    const { status, ...answer } = applySettings(parsed(request.body));
    return yield* json(status, answer);
  }
  if (route === "kuvo/mcp/catalog") {
    if (method !== "GET")
      return yield* json(405, {});
    return yield* json(200, mcpCatalog(readSettings().settings ?? {}));
  }
  const adding = route.match(/^kuvo\/mcp\/catalog\/([^/]+)$/);
  if (adding && method === "POST")
    return yield* answered(addFromCatalog(decodeURIComponent(adding[1])));
  if (route === "kuvo/keys" || route.startsWith("kuvo/keys/")) {
    const { status, value } = await answerKeys(method, route, parsed(request.body));
    return yield* json(status, value);
  }
  return yield* json(404, {});
}

// Packages/Box/src/link/mac/routes.ts
import crypto18 from "node:crypto";
import fs49 from "node:fs";
import path49 from "node:path";
var macPhones = () => {
  const link = readLink();
  return {
    phones: link?.phones ?? [],
    removed: link?.removed ?? [],
    pairing: Boolean(link?.appPairing && Date.now() < link.appPairing.expires)
  };
};
function setMacPeers(link, given) {
  if (!isObject(given) || !Array.isArray(given.peers))
    return { link: null, gone: [] };
  const now = given.peers.slice(0, MOST_PEERS).map((peer) => ({ ...peer, kind: "machine" })).filter((peer) => fitsPeer(peer) && typeof peer.sign === "string" && SIGN.test(peer.sign)).map(cleanPeer);
  const skipped = Math.min(given.peers.length, MOST_PEERS) - now.length;
  if (skipped)
    console.error(`${skipped} of this Mac's machines weren't records the box could take, and were left out.`);
  const removed = (Array.isArray(given.removed) ? given.removed : []).filter((key) => typeof key === "string" && KEY.test(key) && !now.some((peer) => peer.key === key));
  const gone = peersOf(link).filter((peer) => removed.includes(peer.key));
  const kept = (Array.isArray(link.left) ? link.left : []).filter((key) => !now.some((peer) => peer.key === key) && !removed.includes(key));
  link.left = [...kept, ...removed].slice(-64);
  link.macPeers = now;
  link.macMoved = cleanMoved(given.moved);
  pruneDocs(link);
  return { link, gone };
}
async function* macLinkRoute(route, request, signal) {
  const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
  const method = request.method.toUpperCase();
  switch (route) {
    case "kuvo/link/config": {
      if (method !== "PUT")
        return yield* json(405, {});
      const given = parsed(request.body);
      let relay = null;
      try {
        relay = given?.relay ? new URL(String(given.relay)) : null;
      } catch {}
      if (!isObject(given) || typeof given.phones !== "boolean" || typeof given.machines !== "boolean" || !relay || !["ws:", "wss:"].includes(relay.protocol)) {
        return yield* json(400, { message: "Say whether the phone link is on (phones) and there are machines (machines), and the relay." });
      }
      const config = {
        phones: given.phones,
        machines: given.machines,
        relay: relay.toString().replace(/\/$/, ""),
        name: String(given.name ?? "Mac").slice(0, 100),
        app: String(given.app ?? ""),
        ...Array.isArray(given.features) ? { features: keptFeatures(given.features) } : {}
      };
      const before = macLink.config;
      macLink.config = config;
      if (macLink.overlay)
        macLink.overlay = { ...macLink.overlay, relay: config.relay, name: config.name };
      if (!config.phones)
        macLink.host?.keepOnly(new Set);
      if (before && (before.relay !== config.relay || before.name !== config.name))
        macLink.host?.disconnect?.();
      await macKeys();
      macLinkCheck();
      macLink.wake?.();
      if (before?.phones !== config.phones)
        macDocsChanged();
      return yield* json(200, macLink.status);
    }
    case "kuvo/link/status":
      if (method !== "GET")
        return yield* json(405, {});
      return yield* json(200, macLink.status);
    case "kuvo/link/status/events":
      if (method !== "GET")
        return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(() => macLink.status, macLink.statusFollowers, signal);
    case "kuvo/link/phones":
      if (method !== "GET")
        return yield* json(405, {});
      return yield* json(200, macPhones());
    case "kuvo/link/phones/events":
      if (method !== "GET")
        return yield* json(405, {});
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      return yield* followed(macPhones, macLink.phoneFollowers, signal);
    case "kuvo/link/peers": {
      if (method !== "PUT")
        return yield* json(405, {});
      let gone = [];
      const changed = updateLink((link) => {
        const made = setMacPeers(link ?? { phones: [] }, parsed(request.body));
        gone = made.gone;
        return made.link;
      });
      if (!changed)
        return yield* json(400, { message: "Send {peers: [{key, sign, address, name, id}], moved}." });
      macDocsChanged();
      tellGone(gone);
      return yield* json(200, {});
    }
    case "kuvo/link/setup": {
      if (method !== "GET")
        return yield* json(405, {});
      await macKeys();
      const again = new URLSearchParams(String(request.path ?? "").split("?")[1] ?? "").get("key");
      const library = readPersonalities();
      let docs = [];
      const link = updateLink((link) => {
        if (!link?.sign)
          return null;
        if (again && Array.isArray(link.left))
          link.left = link.left.filter((key) => key !== again);
        const own = ownDocs({ link, library });
        docs = [...Object.values(own).map((made) => made.envelope), ...Object.values(link.docs ?? {}).sort((a, b) => a.d < b.d ? -1 : 1)];
        return link;
      });
      if (!link)
        return yield* json(503, { message: "This Mac's link has no keys yet." });
      return yield* json(200, { mac: ownKey(link), macSign: ownSign(link), docs });
    }
    case "kuvo/link/docs": {
      if (method !== "POST")
        return yield* json(405, {});
      const given = parsed(request.body);
      const sender = peersOf(readLink()).find((peer) => peer.key === given?.from);
      if (!sender || !isObject(given.docs))
        return yield* json(404, { message: "That isn't one of this Mac's machines." });
      await receiveDocs(sender, given.docs, macLink.host);
      return yield* json(200, {});
    }
    case "kuvo/link/documents": {
      if (method !== "GET")
        return yield* json(405, {});
      const library = readPersonalities();
      updateLink((link) => {
        if (!link?.sign)
          return null;
        const before = JSON.stringify(link.own ?? {});
        ownDocs({ link, library });
        return JSON.stringify(link.own ?? {}) === before ? null : link;
      });
      const link = readLink();
      return yield* json(200, { own: link?.own ?? {}, held: link?.docs ?? {}, views: link?.views ?? {}, left: link?.left ?? [], have: link?.sign ? digestOf(link) : [] });
    }
    case "kuvo/link/letters": {
      if (method !== "POST")
        return yield* json(405, {});
      const given = parsed(request.body);
      const link = readLink();
      const peer = peersOf(link).find((each) => each.key === given?.peer);
      const from = typeof given?.from === "string" && /^ses_[A-Za-z0-9]{1,60}$/.test(given.from) ? given.from : null;
      if (!isObject(given) || typeof given.to !== "string" || !/^ses_[A-Za-z0-9]{1,60}$/.test(given.to) || typeof given.text !== "string" || !given.text.trim()) {
        return yield* json(400, { message: "Send {peer, to, text}, and from, wait." });
      }
      if (!peer)
        return yield* json(404, { message: "That isn't one of this Mac's computers." });
      const id = "ltr_" + crypto18.randomBytes(16).toString("base64url");
      const online = Boolean(macLink.host?.welcomed);
      const wait = given.wait === true && Boolean(from) && online;
      try {
        fs49.mkdirSync(SENDING, { recursive: true, mode: 448 });
        writePrivate(path49.join(SENDING, `${id}.json`), JSON.stringify({ from, to: given.to, text: cutText(given.text), wait, at: Date.now(), peer: peer.key }));
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep it." });
      }
      if (!wait) {
        macSendOutbox();
        return yield* json(200, given.wait === true && from && !online ? { id, note: OFFLINE_LETTER } : { id });
      }
      const answer = macLetterAnswer(id, signal);
      macSendOutbox();
      yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
      yield { body: Buffer.from(JSON.stringify({ id }) + `
`) };
      yield { body: Buffer.from(JSON.stringify(await answer) + `
`) };
      return;
    }
    case "kuvo/link/letters/take": {
      if (method !== "POST")
        return yield* json(405, {});
      const given = parsed(request.body);
      if (!isObject(given))
        return yield* json(400, { message: "Send {letters, seen}." });
      const now = Date.now();
      try {
        fs49.mkdirSync(SENDING, { recursive: true, mode: 448 });
        for (const letter of Array.isArray(given.letters) ? given.letters.slice(0, 500) : []) {
          if (!isObject(letter) || !LETTER_ID.test(letter.id ?? "") || typeof letter.to !== "string" || typeof letter.text !== "string" || typeof letter.peer !== "string")
            continue;
          const kept = {
            from: typeof letter.from === "string" ? letter.from : null,
            to: letter.to,
            text: cutText(letter.text),
            wait: false,
            at: typeof letter.at === "number" ? letter.at : now,
            peer: letter.peer,
            ...typeof letter.answers === "string" ? { answers: letter.answers } : {}
          };
          writePrivate(path49.join(SENDING, `${letter.id}.json`), JSON.stringify(kept));
        }
        if (isObject(given.seen)) {
          locked(PEER_LOCK, () => {
            const seen = lettersSeen(now);
            for (const [id, at] of Object.entries(given.seen))
              if (LETTER_ID.test(id) && typeof at === "number" && now - at < LETTER_MEMORY)
                seen[id] = Math.max(seen[id] ?? 0, at);
            writePrivate(LETTERS_SEEN, JSON.stringify(seen));
          });
        }
      } catch {
        return yield* json(500, { message: "This Mac's box couldn't keep them." });
      }
      macSendOutbox();
      return yield* json(200, {});
    }
    case "kuvo/link/agents/refresh": {
      if (method !== "POST")
        return yield* json(405, {});
      await refreshOwn(readEngineFile).catch(() => {});
      return yield* json(200, {});
    }
    case "kuvo/link/agents": {
      if (method !== "GET")
        return yield* json(405, {});
      const link = readLink();
      const told = readPeerAgents(undefined, undefined, link);
      return yield* json(200, { peers: peersOf(link).map((peer) => ({
        key: peer.key,
        id: peer.id ?? null,
        at: told[peer.key]?.at ?? 0,
        list: told[peer.key]?.list ?? [],
        features: told[peer.key]?.features ?? []
      })) });
    }
    default:
      return yield* json(404, {});
  }
}
async function* linkRoute(context) {
  const { request, signal, route, json } = context;
  if (!IS_MAC || !request.fromApp)
    return yield* json(403, { message: "Only Kuvo Code on this computer can do that." });
  return yield* macLinkRoute(route, request, signal);
}

// Packages/Box/src/link/updates/update.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import crypto19 from "node:crypto";
import fs50 from "node:fs";
import os5 from "node:os";
import path50 from "node:path";
var UPDATE_KEYS = ["iLSFoygG8wg+r2yj+/qnoMHpZIhPKRNLlf9vpEKmx0A="];
var UPDATE_URL = "https://github.com/serhatandic/kuvo-code/releases/latest/download/boxes.json";
var UPDATE_STATE = path50.join(RUN, "update.json");
var UPDATE_TRIAL = path50.join(RUN, "update-trial");
var UPDATE_LOCK = path50.join(RUN, ".updating");
var ROLLBACK = path50.join(UPDATES, "rollback");
var LAUNCHERS = path50.join(RUN, "launchers.json");
var ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
var RELEASE_AGE = 3 * 86400000;
var MAC_MEMORY = 30 * 86400000;
var BOX_FILE = /^(bin\/[A-Za-z0-9._-]+|bin\/runtime\/[A-Za-z0-9._-]+|config\/opencode\/plugins\/[A-Za-z0-9._-]+)$/;
var RELEASE_VERSION = /^\d+\.\d+\.\d+(-beta\.\d+)?$/;
function versionOrder(version) {
  const found = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version ?? "");
  return found ? [+found[1], +found[2], +found[3], found[4] == null ? Infinity : +found[4]] : null;
}
function newerVersion(version, than) {
  const a = versionOrder(version), b = versionOrder(than);
  if (!a)
    return false;
  if (!b)
    return true;
  for (let i = 0;i < 4; i++)
    if (a[i] !== b[i])
      return a[i] > b[i];
  return false;
}
function verifyBoxes(text, keys = UPDATE_KEYS) {
  let given;
  try {
    given = JSON.parse(text);
  } catch {
    throw new Error("That isn't a release.");
  }
  if (typeof given?.manifest !== "string" || typeof given.signature !== "string" || typeof given.key !== "string")
    throw new Error("That isn't a release.");
  const key = keys.map((each) => Buffer.from(each, "base64")).find((each) => each.length === 32 && each.equals(Buffer.from(given.key, "base64")));
  if (!key)
    throw new Error("It isn't signed with a key this machine trusts.");
  const bytes = Buffer.from(given.manifest, "base64");
  const publicKey = crypto19.createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: "der", type: "spki" });
  if (!crypto19.verify(null, Buffer.concat([Buffer.from(`kuvo-box v1
`), bytes]), publicKey, Buffer.from(given.signature, "base64")))
    throw new Error("Its signature doesn't match.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest?.kuvo !== "box/1" || !RELEASE_VERSION.test(manifest.version ?? "") || typeof manifest.engine !== "string" || !/^[0-9][0-9A-Za-z.-]*$/.test(manifest.engine) || !isObject(manifest.pack) || typeof manifest.pack.url !== "string" || !/^[0-9a-f]{64}$/.test(manifest.pack.sha256 ?? ""))
    throw new Error("That isn't a release.");
  return manifest;
}
var boxVersion = () => {
  const version = textOf(path50.join(K, "bin", "box-version"))?.trim();
  return versionOrder(version) ? version : null;
};
var updateState = () => {
  try {
    return JSON.parse(fs50.readFileSync(UPDATE_STATE, "utf8")) ?? {};
  } catch {
    return {};
  }
};
function noteUpdate(change) {
  const state = { ...updateState(), ...change };
  for (const [key, value] of Object.entries(change))
    if (value == null)
      delete state[key];
  try {
    writePrivate(UPDATE_STATE, JSON.stringify(state));
  } catch {}
  return state;
}
function noteLauncher(readEngine = readEngineFile, now = Date.now()) {
  let mac = null;
  try {
    mac = readEngine()?.notes?.mac;
  } catch {}
  if (typeof mac !== "string" || !mac || mac.length > 100)
    return;
  let all = {};
  try {
    all = JSON.parse(fs50.readFileSync(LAUNCHERS, "utf8")) ?? {};
  } catch {}
  if (now - (all[mac] ?? 0) < 3600000)
    return;
  all[mac] = now;
  for (const [key, at] of Object.entries(all))
    if (now - at > MAC_MEMORY)
      delete all[key];
  try {
    writePrivate(LAUNCHERS, JSON.stringify(all));
  } catch {}
}
function updatesBlocked(link = readLink(), now = Date.now(), root = K) {
  if (path50.resolve(root) !== path50.join(homeFolder(), ".kuvo-code"))
    return "Only a machine's own Kuvo Code folder updates itself.";
  let launchers = {};
  try {
    launchers = JSON.parse(fs50.readFileSync(LAUNCHERS, "utf8")) ?? {};
  } catch {}
  const behind = Object.entries(launchers).filter(([mac, at]) => now - at < MAC_MEMORY && link?.tolerantIDs?.[mac] !== true);
  if (behind.length)
    return "A Mac that connects to this machine has an older Kuvo Code, which would put back older versions: update Kuvo Code there first.";
  return null;
}
async function boxBusy(readEngine = readEngineFile, readBridge = readBridgeFile) {
  for (const read of [readEngine, readBridge]) {
    let target = null;
    try {
      target = read();
    } catch {}
    if (!target?.port || !target?.password)
      continue;
    const active = (await asked(target, "GET", "api/session/active").catch(() => null))?.data;
    if (Array.isArray(active) ? active.length : isObject(active) && Object.keys(active).length)
      return true;
  }
  try {
    if ((JSON.parse(fs50.readFileSync(ASKS_FILE, "utf8")) ?? []).length)
      return true;
  } catch {}
  return false;
}
var hexSHA256 = (data) => crypto19.createHash("sha256").update(data).digest("hex");
function ran(command, args, env = {}, timeout = 120000) {
  const result = spawnSync2(command, args, { cwd: K, env: { ...process.env, ...env }, encoding: "utf8", timeout });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
function isUpdating() {
  if (!fs50.existsSync(UPDATE_LOCK))
    return false;
  let pid = null;
  try {
    pid = Number(fs50.readFileSync(path50.join(UPDATE_LOCK, "pid"), "utf8"));
  } catch {}
  if (pid)
    return processRuns(pid, "kuvo-link");
  try {
    return Date.now() - fs50.statSync(UPDATE_LOCK).mtimeMs < 60000;
  } catch {
    return false;
  }
}
function takeUpdateLock() {
  try {
    fs50.mkdirSync(UPDATE_LOCK);
  } catch {
    if (isUpdating())
      return false;
    fs50.rmSync(UPDATE_LOCK, { recursive: true, force: true });
    try {
      fs50.mkdirSync(UPDATE_LOCK);
    } catch {
      return false;
    }
  }
  fs50.writeFileSync(path50.join(UPDATE_LOCK, "pid"), String(process.pid), { mode: 384 });
  return true;
}
function keepForRollback(files, withData) {
  fs50.rmSync(ROLLBACK, { recursive: true, force: true });
  fs50.mkdirSync(path50.join(ROLLBACK, "files"), { recursive: true, mode: 448 });
  const lines = [
    "#!/bin/sh",
    `K=${quote(K)}; B=${quote(ROLLBACK)}`,
    `p=$(cat "$K/run/.updating/pid" 2>/dev/null)`,
    `if [ -n "$p" ] && [ "$p" != "\${KUVO_UPDATER:-}" ] && kill -0 "$p" 2>/dev/null && { [ ! -d /proc ] || grep -q kuvo-link "/proc/$p/cmdline" 2>/dev/null; }; then exit 0; fi`,
    `sh "$K/bin/kuvo-start" stop >/dev/null 2>&1 || exit 1`
  ];
  for (const file of files) {
    const from = path50.join(K, file);
    if (fs50.existsSync(from)) {
      fs50.mkdirSync(path50.dirname(path50.join(ROLLBACK, "files", file)), { recursive: true, mode: 448 });
      fs50.copyFileSync(from, path50.join(ROLLBACK, "files", file));
      fs50.chmodSync(path50.join(ROLLBACK, "files", file), fs50.statSync(from).mode & 511);
      lines.push(`cp -p "$B/files/"${quote(file)} "$K/"${quote(file)}.new && mv -f "$K/"${quote(file)}.new "$K/"${quote(file)} || exit 1`);
    } else {
      lines.push(`rm -f "$K/"${quote(file)} || exit 1`);
    }
  }
  if (withData) {
    lines.push(`D="$K/data/opencode"`, `if [ -f "$B/data/opencode.db" ]; then`, `  rm -f "$D/opencode.db-wal" "$D/opencode.db-shm" || exit 1`, `  for n in opencode.db opencode.db-wal opencode.db-shm; do if [ -f "$B/data/$n" ]; then mv -f "$B/data/$n" "$D/$n" || exit 1; fi; done`, `fi`);
  }
  lines.push(`sh "$K/bin/kuvo-start" start >/dev/null 2>&1`, `rm -f "$K/run/update-trial" "$K/run/update-restore"`, `rm -rf "$B"`);
  writePrivate(path50.join(ROLLBACK, "restore.sh"), lines.join(`
`) + `
`);
}
function keepData() {
  const folder = path50.join(K, "data", "opencode"), partial = path50.join(ROLLBACK, "data.partial");
  fs50.rmSync(partial, { recursive: true, force: true });
  fs50.mkdirSync(partial, { recursive: true, mode: 448 });
  for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
    if (fs50.existsSync(path50.join(folder, name)))
      fs50.copyFileSync(path50.join(folder, name), path50.join(partial, name));
  }
  fs50.renameSync(partial, path50.join(ROLLBACK, "data"));
}
function roomForData() {
  let size = 0;
  for (const name of ["opencode.db", "opencode.db-wal"])
    try {
      size += fs50.statSync(path50.join(K, "data", "opencode", name)).size;
    } catch {}
  const free = ran("df", ["-Pk", K]).output.split(`
`).pop()?.trim().split(/\s+/)[3];
  return !free || Number(free) * 1024 > size * 1.1 + 200000000;
}
async function cameUp(version, withAgents, timeout = 120000, readEngine = readEngineFile, readBridge = readBridgeFile) {
  const began = Date.now();
  while (Date.now() - began < timeout) {
    await sleep(Math.min(2000, timeout / 10));
    let engine = null;
    try {
      engine = readEngine();
    } catch {}
    if (engine?.version !== version)
      continue;
    if (!await asked(engine, "GET", "api/session?limit=1").then(() => true, () => false))
      continue;
    if (!withAgents)
      return true;
    let bridge = null;
    try {
      bridge = readBridge();
    } catch {}
    if (bridge?.port && await asked(bridge, "GET", "api/session/active").then(() => true, () => false))
      return true;
  }
  return false;
}
var OWN_TOOLS = ["kuvo-agents.js", "kuvo-browser.js", "kuvo-wake", "kuvo-npx"];
var installOrder = (files) => [...files].sort((a, b) => a === "bin/box-version" ? -1 : b === "bin/box-version" ? 1 : a === "bin/.kuvo-boot" ? 1 : b === "bin/.kuvo-boot" ? -1 : a < b ? -1 : 1);
async function update({ now = false, keys = UPDATE_KEYS, url = UPDATE_URL, blocked = updatesBlocked(), clock = Date.now, step = () => {}, upWithin = 120000 } = {}) {
  if (!keys.length)
    return { result: "off", message: "Updates aren't set up for this machine yet." };
  if (blocked)
    return { result: "blocked", message: blocked };
  if (fs50.existsSync(path50.join(RUN, "stopped")))
    return { result: "blocked", message: "Its engine is stopped: start it to update it." };
  const before = boxVersion();
  if (!before)
    return { result: "blocked", message: "This machine's version isn't known: connect to it from Kuvo Code on your Mac once." };
  if (!takeUpdateLock())
    return { result: "busy", message: "It's updating already." };
  let trial = false, stopped = false, swapped = false, stage = null;
  try {
    step("checking");
    let released;
    try {
      released = await fetched(url, 1e6, 30000);
    } catch (error) {
      if (/answered 404/.test(String(error?.message)))
        return { result: "current", version: before };
      throw error;
    }
    const manifest = verifyBoxes(released.toString("utf8"), keys);
    noteUpdate({ latest: manifest.version, checked: clock() });
    if (!newerVersion(manifest.version, before))
      return { result: "current", version: before };
    if (!now && clock() - (Date.parse(manifest.released) || clock()) < RELEASE_AGE)
      return { result: "waiting", version: manifest.version, message: "It takes a release a few days after it's out." };
    if (await boxBusy())
      return { result: "busy", message: "Something is running there now." };
    step("downloading");
    stage = path50.join(UPDATES, manifest.version);
    fs50.rmSync(stage, { recursive: true, force: true });
    fs50.mkdirSync(path50.join(stage, "files"), { recursive: true, mode: 448 });
    const pack = await fetched(manifest.pack.url, 1e8, 300000);
    if (hexSHA256(pack) !== manifest.pack.sha256)
      throw new Error("The release's files aren't what it says.");
    fs50.writeFileSync(path50.join(stage, "pack.tgz"), pack, { mode: 384 });
    if (ran("tar", ["xzf", path50.join(stage, "pack.tgz"), "-C", path50.join(stage, "files")]).status !== 0)
      throw new Error("The release's files couldn't be unpacked.");
    const box = JSON.parse(fs50.readFileSync(path50.join(stage, "files", "box.json"), "utf8"));
    if (box?.version !== manifest.version || box.engine !== manifest.engine || !isObject(box.files))
      throw new Error("The release's files aren't what it says.");
    const files = installOrder(Object.keys(box.files));
    for (const file of files) {
      if (!BOX_FILE.test(file) || file.split("/").includes(".."))
        throw new Error("The release names a file outside the box.");
      if (hexSHA256(fs50.readFileSync(path50.join(stage, "files", file))) !== box.files[file])
        throw new Error("The release's files aren't what it says.");
    }
    if (!files.includes("bin/box-version") || fs50.readFileSync(path50.join(stage, "files", "bin", "box-version"), "utf8").trim() !== manifest.version)
      throw new Error("The release's files aren't what it says.");
    for (const tool of OWN_TOOLS) {
      if (!files.includes(`bin/${tool}`))
        continue;
      const from = path50.join(stage, "files", "bin", tool), own = path50.join(stage, "files", "bin", ".own", tool);
      fs50.mkdirSync(path50.dirname(own), { recursive: true, mode: 448 });
      fs50.copyFileSync(from, own);
      fs50.chmodSync(own, fs50.statSync(from).mode & 511);
      files.push(`bin/.own/${tool}`);
    }
    files.splice(0, files.length, ...installOrder(files));
    const engineFolder = path50.join(K, "engine", manifest.engine);
    let staged = null;
    if (!fs50.existsSync(path50.join(engineFolder, "opencode"))) {
      const kind = { x64: "x86_64", arm64: "aarch64" }[os5.arch()];
      const build = manifest.linux?.[kind];
      if (!build?.url || !/^sha512-/.test(build.integrity ?? ""))
        throw new Error("The release has no engine for this machine.");
      step("downloading the engine");
      const tarball = await fetched(build.url, 400000000, 900000);
      if (crypto19.createHash("sha512").update(tarball).digest("base64") !== build.integrity.slice(7))
        throw new Error("The engine isn't what the release says.");
      fs50.writeFileSync(path50.join(stage, "engine.tgz"), tarball, { mode: 384 });
      fs50.mkdirSync(path50.join(stage, "engine"), { mode: 448 });
      if (ran("tar", ["xzf", path50.join(stage, "engine.tgz"), "-C", path50.join(stage, "engine"), "package/bin/opencode"]).status !== 0)
        throw new Error("The engine couldn't be unpacked.");
      staged = path50.join(stage, "engine", "package", "bin", "opencode");
      fs50.chmodSync(staged, 493);
    }
    step("checking it");
    const engine = staged ?? path50.join(engineFolder, "opencode");
    if (ran(engine, ["--version"]).status !== 0)
      throw new Error("The new engine doesn't run here.");
    const tried = ran(engine, [path50.join(stage, "files", "bin", "kuvo-link.js"), "selftest"], { BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", KUVO_HOME: K });
    if (tried.status !== 0 || !tried.output.includes("ok"))
      throw new Error("The new link doesn't work with it here.");
    if (ran("sh", ["-n", path50.join(stage, "files", "bin", "kuvo-start")]).status !== 0)
      throw new Error("The new keeper doesn't read.");
    if (!now && await boxBusy())
      return { result: "busy", message: "Something is running there now." };
    step("installing");
    let previous = {};
    try {
      previous = readEngineFile();
    } catch {}
    const withAgents = Boolean(previous?.agentsPort) && fs50.existsSync(path50.join(stage, "files", "bin", "kuvo-agents.js"));
    const otherEngine = previous?.version !== manifest.engine;
    if (otherEngine && !roomForData())
      throw new Error("There isn't room on it to keep its data while it updates.");
    keepForRollback(files, otherEngine);
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock() }, running: null });
    fs50.writeFileSync(UPDATE_TRIAL, manifest.version, { mode: 384 });
    trial = true;
    stopped = true;
    const stop = ran("sh", [path50.join(K, "bin", "kuvo-start"), "stop"], {}, 300000);
    if (stop.status !== 0 || previous?.pid && alive(previous.pid))
      throw new Error("Its engine couldn't be stopped to update it.");
    if (otherEngine)
      keepData();
    swapped = true;
    if (staged) {
      fs50.mkdirSync(engineFolder, { recursive: true, mode: 448 });
      fs50.renameSync(staged, path50.join(engineFolder, "opencode"));
    }
    for (const file of files) {
      const from = path50.join(stage, "files", file), to = path50.join(K, file);
      fs50.mkdirSync(path50.dirname(to), { recursive: true, mode: 448 });
      fs50.copyFileSync(from, `${to}.new`);
      fs50.chmodSync(`${to}.new`, fs50.statSync(from).mode & 511);
      fs50.renameSync(`${to}.new`, to);
    }
    ran("sh", [path50.join(K, "bin", "kuvo-start"), "start"]);
    step("starting");
    if (!await cameUp(manifest.engine, withAgents, upWithin))
      throw new Error("The new version didn't come up.");
    writePrivate(path50.join(UPDATES, "installed.json"), JSON.stringify({ version: box.version, files: box.files }));
    noteUpdate({ trial: { from: before, to: manifest.version, at: clock(), healthy: true } });
    return { result: "updated", version: manifest.version };
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    if (stage)
      fs50.rmSync(stage, { recursive: true, force: true });
    if (swapped) {
      ran("sh", [path50.join(ROLLBACK, "restore.sh")], { KUVO_UPDATER: String(process.pid) }, 600000);
    } else {
      if (trial) {
        fs50.rmSync(UPDATE_TRIAL, { force: true });
        fs50.rmSync(ROLLBACK, { recursive: true, force: true });
      }
      if (stopped)
        ran("sh", [path50.join(K, "bin", "kuvo-start"), "start"]);
    }
    if (trial)
      noteUpdate({ trial: null });
    noteUpdate({ last: { at: clock(), result: "failed", message, from: before } });
    return { result: "failed", message };
  } finally {
    for (const name of listOf(UPDATES))
      if (name !== "rollback" && name !== "installed.json")
        fs50.rmSync(path50.join(UPDATES, name), { recursive: true, force: true });
    fs50.rmSync(UPDATE_LOCK, { recursive: true, force: true });
  }
}
function confirmUpdate(clock = Date.now) {
  const state = updateState();
  if (!state.trial?.healthy || boxVersion() !== state.trial.to || isUpdating())
    return false;
  let engine = null;
  try {
    engine = readEngineFile()?.version;
  } catch {}
  fs50.rmSync(UPDATE_TRIAL, { force: true });
  fs50.rmSync(ROLLBACK, { recursive: true, force: true });
  if (engine) {
    for (const name of listOf(path50.join(K, "engine")))
      if (name !== engine && !name.startsWith("."))
        fs50.rmSync(path50.join(K, "engine", name), { recursive: true, force: true });
  }
  noteUpdate({ trial: null, last: { at: clock(), result: "updated", from: state.trial.from, to: state.trial.to } });
  return true;
}
function noteOlderMac(at) {
  let launchers = {};
  try {
    launchers = JSON.parse(fs50.readFileSync(LAUNCHERS, "utf8")) ?? {};
  } catch {}
  if ((launchers["an older Mac"] ?? 0) >= at)
    return;
  launchers["an older Mac"] = at;
  try {
    writePrivate(LAUNCHERS, JSON.stringify(launchers));
  } catch {}
}
function noteOlderMacs() {
  let at = 0, marked = 0;
  try {
    at = fs50.statSync(path50.join(RUN, "attached")).mtimeMs;
    marked = fs50.statSync(path50.join(K, "bin", "box-version")).mtimeMs;
  } catch {}
  if (at <= marked)
    at = 0;
  try {
    at = Math.max(at, fs50.statSync(path50.join(RUN, "older-mac")).mtimeMs);
  } catch {}
  if (!at || Date.now() - at > MAC_MEMORY)
    return false;
  noteOlderMac(at);
  return true;
}
function checkDrift(now = Date.now()) {
  const record = path50.join(UPDATES, "installed.json"), pending = path50.join(RUN, "update-drift");
  if (isUpdating() || fs50.existsSync(UPDATE_TRIAL))
    return false;
  let installed = null;
  try {
    installed = JSON.parse(fs50.readFileSync(record, "utf8"));
  } catch {
    return false;
  }
  if (installed?.version !== boxVersion() || !isObject(installed.files)) {
    fs50.rmSync(record, { force: true });
    fs50.rmSync(pending, { force: true });
    return false;
  }
  const changed = Object.entries(installed.files).some(([file, sha]) => {
    try {
      return hexSHA256(fs50.readFileSync(path50.join(K, file))) !== sha;
    } catch {
      return true;
    }
  });
  let installing = 0;
  try {
    installing = fs50.statSync(path50.join(RUN, "mac-installing")).mtimeMs;
  } catch {}
  if (!changed || isUpdating() || now - installing < 3600000) {
    fs50.rmSync(pending, { force: true });
    return false;
  }
  if (textOf(pending)?.trim() !== installed.version) {
    try {
      writePrivate(pending, installed.version);
    } catch {}
    return false;
  }
  noteOlderMac(now);
  noteUpdate({ last: { at: now, result: "failed", message: "An older Kuvo Code on a Mac put its own files back here: update Kuvo Code on your Macs." } });
  return true;
}
function updateNight(date = new Date, zone = process.env.KUVO_TZ) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone || undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));
  } catch {
    return null;
  }
  const hour = Number(parts.hour);
  return hour >= 2 && hour < 5 ? `${parts.year}-${parts.month}-${parts.day}` : null;
}
function updateStatus() {
  const state = updateState();
  let engine = null;
  try {
    engine = readEngineFile()?.version ?? null;
  } catch {}
  return {
    setUp: UPDATE_KEYS.length > 0,
    version: boxVersion(),
    engine,
    latest: state.latest ?? null,
    last: state.last ?? null,
    updating: isUpdating() ? state.running ?? "checking" : null,
    blocked: updatesBlocked()
  };
}
var updating = null;
function startUpdate(options = {}) {
  if (updating || isUpdating())
    return null;
  updating = update({ ...options, step: (running) => noteUpdate({ running }) }).then((outcome) => {
    noteUpdate({ running: null, ...outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } } });
    if (outcome.result === "updated")
      setTimeout(() => process.exit(0), 1000);
    return outcome;
  }, () => null).finally(() => {
    updating = null;
  });
  return updating;
}
async function* updateRoute(context) {
  const { request, json } = context;
  const method = request.method.toUpperCase();
  if (method === "GET")
    return yield* json(200, updateStatus());
  if (method === "POST") {
    if (parsed(request.body)?.now !== true)
      return yield* json(400, { message: "Say to update now (now)." });
    if (!UPDATE_KEYS.length)
      return yield* json(409, { message: "Updates aren't set up for this machine yet." });
    const blocked = updatesBlocked();
    if (blocked)
      return yield* json(409, { message: blocked });
    return yield* startUpdate({ now: true }) ? json(202, updateStatus()) : json(409, { message: "It's updating already." });
  }
  return yield* json(405, {});
}

// Packages/Box/src/link/areas/vault.ts
import crypto22 from "node:crypto";

// Packages/Box/src/link/vault/activity.ts
import fs51 from "node:fs";
import path51 from "node:path";
var ACTIVITY = path51.join(VAULT_FOLDER, "activity.jsonl");
var DAY2 = 86400000;
var prunedAt = 0;
function note(what, now = Date.now()) {
  const entry = { id: newID("a_"), at: now, ...what };
  if (entry.why)
    entry.why = oneLine(entry.why, 300);
  vaultWork(() => {
    fs51.mkdirSync(VAULT_FOLDER, { recursive: true, mode: 448 });
    fs51.appendFileSync(ACTIVITY, JSON.stringify(entry) + `
`, { mode: 384 });
    if (now - prunedAt > DAY2) {
      prunedAt = now;
      prune(now);
    }
  });
  return entry;
}
function prune(now) {
  const lines = readLines();
  const kept = lines.filter((entry) => now - entry.at < KEPT_DAYS * DAY2);
  if (kept.length === lines.length)
    return;
  const temporary = ACTIVITY + ".new";
  fs51.writeFileSync(temporary, kept.map((entry) => JSON.stringify(entry) + `
`).join(""), { mode: 384 });
  fs51.renameSync(temporary, ACTIVITY);
}
function readLines() {
  let text = "";
  try {
    text = fs51.readFileSync(ACTIVITY, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(`
`)) {
    if (!line)
      continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}
function readActivity({ item, bot, session, before, limit = 100 } = {}, now = Date.now()) {
  return readLines().filter((entry) => now - entry.at < KEPT_DAYS * DAY2).filter((entry) => (!item || entry.item === item) && (!bot || entry.bot === bot) && (!session || entry.session === session) && (!before || entry.at < before)).sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.min(500, limit)));
}

// Packages/Box/src/link/vault/asks.ts
var PATIENCE = 15 * 60000;
var open = new Map;
var listeners = new Set;
var changed = () => {
  for (const listener of listeners)
    try {
      listener();
    } catch {}
};
function onAsksChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
var listAsks = () => [...open.values()].map((each) => each.ask).sort((a, b) => a.at - b.at);
function ask(what, signal, patience = PATIENCE) {
  const asked = { id: newID("q_"), at: Date.now(), ...what };
  if (asked.why)
    asked.why = oneLine(asked.why, 300);
  if (asked.need)
    asked.need = oneLine(asked.need, 300);
  return new Promise((resolve) => {
    const finish = (answer) => {
      const was = open.get(asked.id);
      if (!was)
        return;
      clearTimeout(was.timer);
      open.delete(asked.id);
      signal?.removeEventListener("abort", stopped);
      changed();
      resolve(answer);
    };
    const stopped = () => finish({ answer: "no" });
    if (signal?.aborted)
      return resolve({ answer: "no" });
    signal?.addEventListener("abort", stopped, { once: true });
    open.set(asked.id, { ask: asked, done: finish, timer: setTimeout(() => finish({ answer: "no" }), patience) });
    changed();
  });
}
function answer(id, given) {
  const found = open.get(id);
  if (!found)
    return false;
  found.done(given);
  return true;
}
function vaultAskNotice(asked) {
  const who = asked.botName ?? asked.sessionName ?? "An agent";
  const title = asked.kind === "use" ? `${who} wants to use ${asked.itemName ?? "an item"}` : `${who} needs ${asked.need ?? "something from your vault"}`;
  return {
    title,
    subtitle: asked.machine,
    body: asked.why || (asked.kind === "use" ? "Allow it once, always, or say no." : "Give it an item from your vault, or say no."),
    category: "ask",
    thread: asked.session ?? asked.id,
    data: { ...asked.session ? { session: asked.session } : {}, vaultAsk: asked.id }
  };
}
function watchVaultAsks(tell, answered = () => {}, after = 2000) {
  const told = new Set;
  const timers = new Map;
  const look = () => {
    const now = new Set(listAsks().map((each) => each.id));
    for (const id of [...told])
      if (!now.has(id)) {
        told.delete(id);
        answered(id);
      }
    for (const [id, timer] of timers)
      if (!now.has(id)) {
        clearTimeout(timer);
        timers.delete(id);
      }
    for (const asked of listAsks()) {
      if (told.has(asked.id) || timers.has(asked.id))
        continue;
      timers.set(asked.id, setTimeout(() => {
        timers.delete(asked.id);
        if (!open.has(asked.id))
          return;
        if (tell(vaultAskNotice(asked)))
          told.add(asked.id);
      }, after));
    }
  };
  return onAsksChanged(look);
}

// Packages/Box/src/link/vault/who.ts
import path52 from "node:path";
async function sessionAt(targets, id) {
  for (const target of targets) {
    try {
      const found = (await engineGet(target, `api/session/${encodeURIComponent(id)}`))?.data;
      if (found?.id)
        return found;
    } catch {}
  }
  return null;
}
async function callerOf(session, readEngine, readBridge) {
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(session))
    return {};
  const targets = [];
  try {
    targets.push(readEngine());
  } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && processRuns(bridge.pid, "kuvo-agents"))
      targets.push(bridge);
  } catch {}
  let current = await sessionAt(targets, session);
  for (let step = 0;step < 5 && current?.parentID; step++)
    current = await sessionAt(targets, current.parentID) ?? current;
  const root = current?.id ?? session;
  const bot = listBots().find((each) => each.session === root);
  const folder = current?.location?.directory ?? current?.directory;
  return {
    session,
    root,
    ...current?.title ? { sessionName: current.title } : {},
    ...folder ? { folder: path52.resolve(folder) } : {},
    ...bot ? { bot: bot.id, botName: bot.name } : {}
  };
}
var ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
async function isCalling(session, tools, args, readEngine, readBridge) {
  if (!session || !/^[A-Za-z0-9_-]{1,100}$/.test(session))
    return false;
  const targets = [];
  try {
    targets.push(readEngine());
  } catch {}
  try {
    const bridge = readBridge();
    if (bridge?.port && bridge?.password && processRuns(bridge.pid, "kuvo-agents"))
      targets.push(bridge);
  } catch {}
  const named = (name) => typeof name === "string" && tools.some((tool) => name === tool || name.endsWith("_" + tool));
  const wanted = args ? JSON.stringify(ordered(args)) : null;
  for (const target of targets) {
    try {
      const page = await engineGet(target, `api/session/${encodeURIComponent(session)}/message?limit=6&order=desc`);
      for (const message of page?.data ?? []) {
        for (const block of message.content ?? []) {
          if (block.type !== "tool" || !named(block.name) || !["running", "pending"].includes(block.state?.status ?? ""))
            continue;
          if (wanted === null || JSON.stringify(ordered(block.state?.input ?? {})) === wanted)
            return true;
        }
      }
    } catch {}
  }
  return false;
}
function grantFor(item, caller, grants = readGrants()) {
  let how = null;
  for (const grant of grants) {
    if (grant.item !== item.id)
      continue;
    const fits = grant.who.everyone || grant.who.bot && grant.who.bot === caller.bot || grant.who.project && caller.folder && (caller.folder === grant.who.project || caller.folder.startsWith(grant.who.project + path52.sep));
    if (!fits)
      continue;
    if (grant.how === "own")
      return "own";
    how = "ask";
  }
  return how;
}

// Packages/Box/src/link/vault/use.ts
import os6 from "node:os";
var tell = () => false;
var setVaultTell = (to) => {
  tell = to;
};
var machineName = () => IS_MAC ? undefined : os6.hostname();
var whoOf = (caller) => ({
  ...caller.bot ? { bot: caller.bot } : {},
  ...caller.botName ? { botName: caller.botName } : {},
  ...caller.root ? { session: caller.root } : {},
  ...caller.sessionName ? { sessionName: caller.sessionName } : {}
});
var itemOf = (item) => ({ item: item.id, itemName: item.name, kind: item.kind });
var ONCE_FOR = 30 * 60000;
var once = new Map;
var onceKey = (caller, item) => `${caller.root ?? caller.session ?? ""}\x00${item}`;
function allowOnce(caller, item) {
  once.set(onceKey(caller, item), Date.now() + ONCE_FOR);
}
function hasOnce(caller, item, take = false) {
  const key = onceKey(caller, item);
  const until = once.get(key);
  if (!until || until < Date.now()) {
    once.delete(key);
    return false;
  }
  if (take)
    once.delete(key);
  return true;
}
function alwaysFor(caller) {
  if (caller.bot)
    return { bot: caller.bot };
  if (caller.folder && caller.folder !== "/" && caller.folder !== homeFolder())
    return { project: caller.folder };
  return null;
}
async function mayUse(item, caller, use) {
  const where = { ...use.site ? { site: use.site } : {}, ...use.program ? { program: use.program } : {}, ...use.why ? { why: use.why } : {} };
  const paused = pausedFor(caller.bot, caller.root ?? caller.session);
  if (paused) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "paused" });
    return { ok: false, message: paused };
  }
  const how = grantFor(item, caller);
  if (how === "own")
    return { ok: true, how: "own" };
  if (hasOnce(caller, item.id, true))
    return { ok: true, how: "once" };
  if (how === null && !use.askWithout) {
    note({ what: "refused", ...itemOf(item), ...whoOf(caller), ...where, how: "no grant" });
    return { ok: false, message: `You may not use “${item.name}”. Ask the user for it with vault_ask.` };
  }
  note({ what: "asked", ...itemOf(item), ...whoOf(caller), ...where });
  const answered = await ask({ kind: "use", ...whoOf(caller), item: item.id, itemName: item.name, ...use.site ? { site: use.site } : {}, ...use.why ? { why: use.why } : {}, ...machineName() ? { machine: machineName() } : {} }, use.signal);
  if (answered.answer === "no") {
    note({ what: "declined", ...itemOf(item), ...whoOf(caller), ...where, ...answered.client ? { client: answered.client } : {} });
    return { ok: false, message: `The user didn't let you use “${item.name}”.` };
  }
  const always = answered.answer === "always" ? alwaysFor(caller) : null;
  if (always) {
    setGrant(item.id, always, "own");
    note({ what: "granted", ...itemOf(item), ...whoOf(caller), how: "own", ...answered.client ? { client: answered.client } : {} });
  }
  const allowed = always ? "always" : "once";
  note({ what: "allowed", ...itemOf(item), ...whoOf(caller), ...where, how: allowed, ...answered.client ? { client: answered.client } : {} });
  return { ok: true, how: allowed };
}
function tripwire(item, caller, site) {
  const why = `It tried to use “${item.name}” on ${site}, which isn't one of its sites.`;
  const who = caller.bot ?? caller.root ?? caller.session;
  if (who)
    setPaused(true, who, why);
  note({ what: "refused", ...itemOf(item), ...whoOf(caller), site, how: "wrong site" });
  try {
    tell({ title: caller.botName ? `${caller.botName} paused` : "A fill was refused", subtitle: machineName(), body: why, category: "message", thread: caller.root ?? "vault", data: caller.root ? { session: caller.root } : {} });
  } catch {}
  return `${why} Kuvo Code only fills it on ${item.sites.join(", ")}.${who ? ` The user has been told, and this ${caller.bot ? "bot" : "conversation"}'s use of the vault is paused until they look.` : ""}`;
}
var noteUse = (item, caller, use, how) => note({ what: "used", ...itemOf(item), ...whoOf(caller), ...use.site ? { site: use.site } : {}, ...use.program ? { program: use.program } : {}, ...use.why ? { why: use.why } : {}, how });

// Packages/Box/src/link/vault/fill.ts
var refused = (status, message) => ({ status, value: { message } });
function pageSite(origin) {
  if (typeof origin !== "string")
    return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost"))
      return null;
    return siteOf(url.hostname);
  } catch {
    return null;
  }
}
async function fill(given, caller, signal) {
  const body = isObject(given) ? given : {};
  const site = pageSite(body.origin);
  if (!site)
    return refused(400, "Kuvo Code fills only on a secure page (https).");
  const purpose = body.purpose === "field" ? "field" : "sign-in";
  const why = typeof body.why === "string" ? oneLine(body.why, 300) : undefined;
  let item;
  if (body.item !== undefined && body.item !== null && body.item !== "") {
    item = itemNamed(body.item);
    if (!item)
      return refused(404, `There's no item “${oneLine(body.item, 80)}” in the vault.`);
    if (!usableOn(item, site))
      return refused(403, tripwire(item, caller, site));
  } else {
    if (purpose === "field")
      return refused(400, "Name the item to fill from.");
    const own = readItems().filter((each) => each.kind === "login" && usableOn(each, site) && (grantFor(each, caller) === "own" || hasOnce(caller, each.id)));
    if (own.length !== 1)
      return refused(404, own.length ? "More than one sign-in fits this site." : "No sign-in in the vault is yours to use on this site.");
    item = own[0];
  }
  if (purpose === "field" && item.signInOnly)
    return refused(403, `“${item.name}” is only for signing in: use browser_sign_in.`);
  const may = await mayUse(item, caller, { site, ...why ? { why } : {}, askWithout: true, signal });
  if (!may.ok)
    return refused(403, may.message);
  const values = await valuesOf(item.id);
  let filled;
  if (purpose === "sign-in") {
    if (item.kind !== "login")
      return refused(400, `“${item.name}” isn't a sign-in: fill one of its fields with browser_fill.`);
    filled = values.password !== undefined ? { password: values.password } : {};
  } else {
    const field = typeof body.field === "string" && body.field ? body.field.trim().toLowerCase() : item.kind === "login" ? "password" : item.fields.length === 1 ? item.fields[0] : "";
    if (field === "username" && item.username)
      filled = { username: item.username };
    else if (!field || values[field] === undefined)
      return refused(400, `Say which of “${item.name}”'s fields to fill: ${["username", ...item.fields].filter((each) => each !== "username" || item.username).join(", ")}.`);
    else
      filled = { [field]: values[field] };
  }
  noteUsed(item.id);
  noteUse(item, caller, { site, ...why ? { why } : {} }, may.how);
  return { status: 200, value: { item: { id: item.id, name: item.name }, ...item.username ? { username: item.username } : {}, values: filled } };
}

// Packages/Box/src/link/vault/holder.ts
import crypto20 from "node:crypto";
import fs52 from "node:fs";
import net2 from "node:net";
import path53 from "node:path";
var VAULT_SOCKET = path53.join(RUN, "vault.sock");
var holding = false;
var holdsVault = () => holding;
var MOST2 = 8 * 1024 * 1024;
var KEY3 = "x-kuvo-vault-key";
var AUTH = "x-kuvo-vault-auth";
var nonce = () => crypto20.randomBytes(18).toString("base64url");
var covered = (theirs, method, route, body) => `${theirs}\x00${method.toUpperCase()}\x00${route}\x00${crypto20.createHash("sha256").update(body).digest("base64url")}`;
function holdVault(handle) {
  holding = true;
  fs52.mkdirSync(RUN, { recursive: true, mode: 448 });
  try {
    fs52.rmSync(path53.join(RUN, "vault-run"), { recursive: true, force: true });
  } catch {}
  try {
    fs52.rmSync(VAULT_SOCKET, { force: true });
  } catch {}
  const server = net2.createServer((socket) => {
    let given = "";
    let hello = null;
    const mine = nonce();
    const stop = new AbortController;
    socket.on("close", () => stop.abort());
    socket.on("error", () => stop.abort());
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      given += chunk;
      if (given.length > MOST2)
        return void socket.destroy();
      if (hello === null) {
        const end = given.indexOf(`
`);
        if (end < 0)
          return;
        let said = null;
        try {
          said = JSON.parse(given.slice(0, end));
        } catch {}
        given = given.slice(end + 1);
        hello = typeof said?.hello === "string" ? said.hello.slice(0, 100) : "";
        const proof = hello ? unlockProof("holder", hello) : null;
        socket.write(JSON.stringify({ nonce: mine, ...proof ? { proof } : {} }) + `
`);
      }
      const end = given.indexOf(`
`);
      if (end < 0)
        return;
      socket.removeAllListeners("data");
      let sent = null;
      try {
        sent = JSON.parse(given.slice(0, end));
      } catch {}
      const headers = typeof sent?.headers === "object" && sent.headers ? { ...sent.headers } : {};
      const proved = provesUnlock("client", covered(mine, String(sent?.method ?? "GET"), String(sent?.path ?? ""), String(sent?.body ?? "")), headers[AUTH]);
      delete headers[AUTH];
      const request = {
        method: String(sent?.method ?? "GET"),
        path: String(sent?.path ?? ""),
        headers,
        body: Buffer.from(String(sent?.body ?? ""), "base64"),
        fromMac: true,
        ...proved ? { vaultClient: true } : {}
      };
      if (!/^kuvo\/vault(\/|\?|$)/.test(request.path))
        return void socket.end(JSON.stringify({ status: 404, type: "application/json", body: Buffer.from("{}").toString("base64") }) + `
`);
      let status = 502;
      let type = "";
      const chunks = [];
      try {
        for await (const part of handle(request, undefined, stop.signal)) {
          if (part.head) {
            status = part.head.status;
            type = String(part.head.headers?.["content-type"] ?? "");
          }
          if (part.body)
            chunks.push(Buffer.from(part.body));
          if (type.startsWith("application/x-ndjson") && Buffer.concat(chunks).includes(10)) {
            stop.abort();
            break;
          }
        }
      } catch (error) {
        status = 500;
        type = "application/json";
        chunks.splice(0, chunks.length, Buffer.from(JSON.stringify({ message: String(error?.message ?? error) })));
      }
      let body = Buffer.concat(chunks);
      if (type.startsWith("application/x-ndjson") && body.includes(10))
        body = body.subarray(0, body.indexOf(10) + 1);
      if (!socket.destroyed)
        socket.end(JSON.stringify({ status, type, body: body.toString("base64") }) + `
`);
    });
  });
  const old = process.umask(127);
  try {
    server.listen(VAULT_SOCKET);
  } finally {
    process.umask(old);
  }
  server.on("error", (error) => console.error(`The vault's socket (${VAULT_SOCKET}) couldn't listen: ${error.message}`));
  server.unref();
  return server;
}
function socketLooksHeld() {
  try {
    const stat = fs52.lstatSync(VAULT_SOCKET);
    return stat.isSocket() && (process.getuid ? stat.uid === process.getuid() : true) && (stat.mode & 63) === 0;
  } catch {
    return false;
  }
}
var NOT_THE_HOLDER = "That isn't this vault's key, or what answers for it couldn't prove it's Kuvo Code's own: nothing was sent to it.";
function askHolder(request, signal) {
  return new Promise((resolve) => {
    if (!socketLooksHeld())
      return resolve(null);
    const socket = net2.createConnection(VAULT_SOCKET);
    const ours = nonce();
    let theirs = null;
    let answer = "";
    let done = false;
    const finish = (value) => {
      if (done)
        return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    signal?.addEventListener("abort", () => finish(null), { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ hello: ours }) + `
`));
    const body = Buffer.from(request.body ?? Buffer.alloc(0)).toString("base64");
    const send = () => {
      const headers = {};
      for (const [name, value] of Object.entries(request.headers ?? {}))
        if (typeof value === "string" && name !== AUTH)
          headers[name] = value;
      const key = headers[KEY3];
      if (key && typeof theirs?.proof !== "string" && !/^kuvo\/vault\/unlock(\?|$)/.test(request.path)) {
        finish({ status: 423, type: "application/json", body: Buffer.from(JSON.stringify({ message: LOCKED })).toString("base64") });
        return;
      }
      if (key) {
        const unlock = Buffer.from(key, "base64url");
        if (typeof theirs?.proof === "string") {
          if (theirs.proof !== unlockProof("holder", ours, unlock)) {
            finish({ status: 403, type: "application/json", body: Buffer.from(JSON.stringify({ message: NOT_THE_HOLDER })).toString("base64") });
            return;
          }
          delete headers[KEY3];
          headers[AUTH] = unlockProof("client", covered(String(theirs.nonce ?? ""), request.method, request.path, body), unlock);
        }
      }
      socket.write(JSON.stringify({ method: request.method, path: request.path, headers, body }) + `
`);
    };
    socket.on("data", (chunk) => {
      answer += chunk;
      if (answer.length > MOST2 * 2)
        return finish(null);
      let end = answer.indexOf(`
`);
      if (end < 0)
        return;
      if (!theirs) {
        try {
          theirs = JSON.parse(answer.slice(0, end));
        } catch {
          return finish(null);
        }
        answer = answer.slice(end + 1);
        send();
        end = answer.indexOf(`
`);
        if (end < 0)
          return;
      }
      try {
        finish(JSON.parse(answer.slice(0, end)));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

// Packages/Box/src/link/vault/tools.ts
import { spawn as spawn5 } from "node:child_process";
import crypto21 from "node:crypto";
import fs53 from "node:fs";
import os7 from "node:os";
import path54 from "node:path";

// Packages/Box/src/link/vault/mask.ts
var SHORTEST = 4;
var SHORTEST_PART = 8;
var escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function encodings(value) {
  const bytes = Buffer.from(value, "utf8");
  return [value, bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), bytes.toString("hex"), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
}
function stringsIn(value, found = []) {
  if (typeof value === "string")
    found.push(value);
  else if (Array.isArray(value))
    for (const each of value)
      stringsIn(each, found);
  else if (value && typeof value === "object")
    for (const each of Object.values(value))
      stringsIn(each, found);
  return found;
}
function formsOf(value) {
  const forms = new Set(encodings(value).filter((form) => form.length >= SHORTEST));
  const parts = [];
  if (/[\r\n]/.test(value))
    parts.push(...value.split(/\r?\n/).map((line) => line.trim()));
  try {
    parts.push(...stringsIn(JSON.parse(value)));
  } catch {}
  for (const part of parts) {
    if (part.length < SHORTEST_PART)
      continue;
    forms.add(part);
    forms.add(JSON.stringify(part).slice(1, -1));
  }
  return [...forms];
}
function maskValues(text, hidden) {
  const forms = [];
  for (const { item, value } of hidden) {
    if (!value || value.length < SHORTEST)
      continue;
    for (const form of formsOf(value))
      forms.push({ form, label: `[vault: ${item}]` });
  }
  forms.sort((a, b) => b.form.length - a.form.length);
  let masked = text;
  for (const { form, label } of forms)
    masked = masked.replace(new RegExp(escapeRegExp(form), "g"), () => label);
  return masked;
}

// Packages/Box/src/link/vault/tools.ts
var failed = (text) => ({ text, isError: true });
var VAULT_TOOLS = [
  {
    name: "vault_items",
    description: "List the items in the user's vault that you may use: sign-ins, keys, files and notes, by name, with where each may be used and whether you use it on your own or the user is asked each time. You never see a value: you name an item, and Kuvo Code fills it in (browser_sign_in, browser_fill) or hands it to a command (vault_run).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "vault_ask",
    description: "Ask the user for something you need from their vault that vault_items doesn't list, such as a sign-in for a site or an API key. They pick an item (or say no); you get its name, never its value. Waits for their answer.",
    inputSchema: {
      type: "object",
      properties: {
        need: { type: "string", description: "What you need, in a few words: “a sign-in for play.google.com”, “an App Store Connect API key”." },
        why: { type: "string", description: "Why you need it, in one sentence the user reads." },
        site: { type: "string", description: "The site or host it's for, if any." }
      },
      required: ["need", "why"],
      additionalProperties: false
    }
  },
  {
    name: "vault_run",
    description: 'Run a shell command in your project\'s folder with values from the vault in its environment, never on its command line: each variable you name gets an item\'s value (`"GITHUB_TOKEN": "GitHub token"`, or `"Item.field"` for one field), and a file item\'s variable gets the path of a temporary copy of the file (removed when the command ends). Its output comes back with every vault value hidden. Use the variables in the command (`curl -H "Authorization: Bearer $GITHUB_TOKEN" …`); never print them.',
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command, run with the user's shell." },
        variables: { type: "object", additionalProperties: { type: "string" }, description: "Each environment variable, and the item (or `Item.field`) whose value it gets." },
        why: { type: "string", description: "Why you need these, in one sentence the user reads." },
        timeout: { type: "number", description: "How long it may run, in seconds (300 unless you say; at most 600)." }
      },
      required: ["command", "variables", "why"],
      additionalProperties: false
    }
  }
];
var VAULT_TOOL_NAMES = VAULT_TOOLS.map((tool) => tool.name);
var KIND_WORDS = { login: "sign-in", key: "key", file: "file", note: "note" };
async function listItems(caller) {
  const items = readItems();
  const usable = items.map((item) => ({ item, how: grantFor(item, caller) })).filter((each) => each.how);
  const lines = [];
  for (const { item, how } of usable) {
    const where = item.sites.length ? ` on ${item.sites.join(", ")}` : "";
    const fields = item.kind === "key" && item.fields.length > 1 ? ` (fields: ${item.fields.join(", ")})` : "";
    const user = item.kind === "login" && item.username ? `, username ${item.username}` : "";
    const only = item.signInOnly ? ", only for signing in with browser_sign_in" : "";
    lines.push(`- “${item.name}”: a ${KIND_WORDS[item.kind]}${where}${user}${fields}${only}; ${how === "own" ? "yours to use" : "the user is asked each time"}.`);
    if (item.kind === "note" && item.readable && how === "own") {
      try {
        const text = (await valuesOf(item.id)).text;
        if (text)
          lines.push(`  It reads: ${cut(text, 4000)}`);
      } catch {}
    }
  }
  const others = items.length - usable.length;
  const more = others ? `

The vault has ${others === 1 ? "one more item" : `${others} more items`} you may not use. If you need one, ask with vault_ask.` : "";
  if (!lines.length)
    return { text: `You may use nothing in the vault yet.${others ? " " : ""}${more.trim()}${others ? "" : " If you need a sign-in or a key, ask with vault_ask."}`, isError: false };
  return { text: `What you may use, by name:
${lines.join(`
`)}${more}

Sign in with browser_sign_in (it fills a sign-in on its own site), fill one field with browser_fill, or hand values to a command with vault_run.`, isError: false };
}
async function askForItem(caller, args, signal) {
  const need = oneLine(typeof args.need === "string" ? args.need : "", 200).trim();
  const why = oneLine(typeof args.why === "string" ? args.why : "", 300).trim();
  if (!need || !why)
    return failed("Say what you need and why.");
  const site = siteOf(args.site) ?? undefined;
  note({ what: "asked", ...caller.bot ? { bot: caller.bot, botName: caller.botName } : {}, ...caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}, why: `${need}: ${why}`, ...site ? { site } : {} });
  const answered = await ask({
    kind: "item",
    need,
    why,
    ...site ? { site } : {},
    ...caller.bot ? { bot: caller.bot, botName: caller.botName } : {},
    ...caller.root ? { session: caller.root, sessionName: caller.sessionName } : {},
    ...IS_MAC ? {} : { machine: os7.hostname() }
  }, signal);
  const item = answered.item ? readItems().find((each) => each.id === answered.item) : undefined;
  if (answered.answer === "no" || !item)
    return { text: "The user didn't give you anything for this. Go on without it, or say what's missing in your report.", isError: false };
  const always = answered.answer === "always" ? alwaysFor(caller) : null;
  if (always)
    setGrant(item.id, always, "own");
  else
    allowOnce(caller, item.id);
  note({ what: always ? "granted" : "allowed", item: item.id, itemName: item.name, kind: item.kind, ...caller.bot ? { bot: caller.bot, botName: caller.botName } : {}, ...caller.root ? { session: caller.root, sessionName: caller.sessionName } : {}, how: always ? "own" : "once", ...answered.client ? { client: answered.client } : {} });
  const once = !always;
  return { text: `The user gave you “${item.name}” (a ${KIND_WORDS[item.kind]}${item.sites.length ? ` for ${item.sites.join(", ")}` : ""})${once ? ", for this once" : ""}. Use it by that name${item.kind === "login" ? " with browser_sign_in" : " with vault_run or browser_fill"}.`, isError: false };
}
var MOST_OUTPUT2 = 64 * 1024;
var MOST_KEPT2 = 4 * 1024 * 1024;
var CALL_BUDGET = 15.5 * 60000;
var VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
var PRIVATE = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_HOST_VAULT_SECRET", "KUVO_VAULT_FILE_KEY", "BUN_BE_BUN"];
var RUN_FOLDER = path54.join(RUN, "vault-run");
var running = new Map;
process.once("exit", () => {
  for (const [scratch, pid] of running) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      fs53.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }
});
function namedValue(named) {
  const whole = itemNamed(named);
  if (whole)
    return { item: whole, field: null };
  const dot = named.lastIndexOf(".");
  if (dot <= 0)
    return null;
  const item = itemNamed(named.slice(0, dot));
  return item ? { item, field: named.slice(dot + 1).trim().toLowerCase() } : null;
}
function fieldOf(item, field) {
  if (field)
    return item.fields.includes(field) ? field : new VaultRefusal(400, `“${item.name}” has no field “${field}”${item.fields.length ? `: it has ${item.fields.join(", ")}` : ""}.`);
  const fallback = { login: "password", file: "file", note: "text", key: item.fields.length === 1 ? item.fields[0] : "value" }[item.kind];
  if (item.fields.includes(fallback))
    return fallback;
  return new VaultRefusal(400, `Say which of “${item.name}”'s fields: ${item.fields.join(", ") || "it has none"} (\`${item.name}.<field>\`).`);
}
async function runWith(caller, args, signal) {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const why = oneLine(typeof args.why === "string" ? args.why : "", 300).trim();
  if (!command)
    return failed("Give the command to run.");
  if (!why)
    return failed("Say why you need these values.");
  if (!isObject(args.variables) || !Object.keys(args.variables).length)
    return failed("Name at least one variable and the item it gets.");
  const started = Date.now();
  const program = path54.basename(command.split(/\s+/)[0] ?? "");
  const folder = caller.folder && fs53.existsSync(caller.folder) ? caller.folder : homeFolder();
  const wanted = [];
  for (const [variable, named] of Object.entries(args.variables)) {
    if (!VARIABLE.test(variable))
      return failed(`“${oneLine(variable, 40)}” isn't a variable's name.`);
    if (typeof named !== "string")
      return failed(`Name the item ${variable} gets.`);
    const found = namedValue(named);
    if (!found)
      return failed(`There's no item “${oneLine(named, 80)}” in the vault. See what you may use with vault_items.`);
    if (found.item.signInOnly)
      return failed(`“${found.item.name}” is only for signing in, in the browser: use browser_sign_in. It's never handed to a command.`);
    const field = fieldOf(found.item, found.field);
    if (field instanceof VaultRefusal)
      return failed(field.message);
    wanted.push({ variable, item: found.item, field });
  }
  const allowed = new Map;
  for (const { item } of wanted) {
    if (allowed.has(item.id))
      continue;
    const may = await mayUse(item, caller, { program, why, askWithout: true, signal });
    if (!may.ok)
      return failed(may.message);
    allowed.set(item.id, may.how);
  }
  const scratch = path54.join(RUN_FOLDER, crypto21.randomBytes(8).toString("hex"));
  const env = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !PRIVATE.includes(name))
      env[name] = value;
  const hidden = [];
  try {
    fs53.mkdirSync(scratch, { recursive: true, mode: 448 });
    for (const { variable, item, field } of wanted) {
      const value = (await valuesOf(item.id))[field];
      if (value === undefined)
        return failed(`“${item.name}” has no ${field} kept.`);
      if (item.kind === "file" && field === "file") {
        const name = path54.basename(item.fileName ?? "");
        const file = path54.join(scratch, variable, name && name !== "." && name !== ".." ? name : variable.toLowerCase());
        fs53.mkdirSync(path54.dirname(file), { recursive: true, mode: 448 });
        const bytes = Buffer.from(value, "base64");
        fs53.writeFileSync(file, bytes, { mode: 384 });
        env[variable] = file;
        const base64 = bytes.toString("base64");
        const wrapped = (width) => base64.match(new RegExp(`.{1,${width}}`, "g")).join(`
`);
        hidden.push({ item: item.name, value: bytes.toString("utf8") }, { item: item.name, value: base64 }, { item: item.name, value: wrapped(76) }, { item: item.name, value: wrapped(64) }, { item: item.name, value: bytes.toString("hex") });
      } else {
        env[variable] = value;
        hidden.push({ item: item.name, value });
      }
    }
    for (const [id, how] of allowed) {
      noteUsed(id);
      noteUse(wanted.find((each) => each.item.id === id).item, caller, { program, why }, how);
    }
    const left = Math.floor((CALL_BUDGET - (Date.now() - started)) / 1000);
    const seconds = Math.max(1, Math.min(600, left, Number(args.timeout) || 300));
    const { output, code, timedOut } = await run(command, folder, env, seconds * 1000, scratch, signal);
    let shown = maskValues(output, hidden);
    if (shown.length > MOST_OUTPUT2)
      shown = "…" + shown.slice(-MOST_OUTPUT2).replace(/^[^\n]*\n/, "");
    const ended = timedOut ? `It was stopped after ${seconds} seconds.` : `It ended with ${code}.`;
    return { text: `${shown.trim() ? shown.trimEnd() + `

` : `It printed nothing.

`}${ended} (Values from the vault are shown as [vault: <item>].)`, isError: timedOut || code !== 0 };
  } finally {
    fs53.rmSync(scratch, { recursive: true, force: true });
  }
}
function run(command, folder, env, timeout, scratch, signal) {
  return new Promise((resolve) => {
    const shell = env.SHELL && fs53.existsSync(env.SHELL) ? env.SHELL : "/bin/sh";
    const child = spawn5(shell, ["-lc", command], { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    if (child.pid)
      running.set(scratch, child.pid);
    let output = Buffer.alloc(0);
    const take = (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > MOST_KEPT2)
        output = output.subarray(output.length - MOST_KEPT2);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timedOut = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 3000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => take(Buffer.from(String(error.message))));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      running.delete(scratch);
      resolve({ output: output.toString("utf8"), code, timedOut });
    });
  });
}
async function callTool(name, args, caller, signal) {
  const given = isObject(args) ? args : {};
  try {
    switch (name) {
      case "vault_items":
        return await listItems(caller);
      case "vault_ask":
        return await askForItem(caller, given, signal);
      case "vault_run":
        return await runWith(caller, given, signal);
      default:
        return failed(`There's no vault tool “${oneLine(name, 40)}”.`);
    }
  } catch (error) {
    if (error instanceof VaultRefusal)
      return failed(error.message);
    throw error;
  }
}

// Packages/Box/src/link/areas/vault.ts
var NOT_OPEN = "This computer's vault isn't open: Kuvo Code's link here isn't running. Try again in a moment.";
var CLIENTS_ONLY = "Only Kuvo Code on your Mac or iPhone can do this.";
var NOT_CALLING = "Only a conversation's own tool call can use the vault, and this one isn't running in it.";
var stringOf = (value) => typeof value === "string" ? value : undefined;
var ED_SPKI2 = Buffer.from("302a300506032b6570032100", "hex");
function clientOf({ request, phone }) {
  if (phone?.key) {
    const key = phone.key.toString("base64url");
    return readLink()?.phones?.find((each) => each.key === key)?.name || "iPhone";
  }
  if (request.fromApp)
    return "Mac";
  if (request.vaultClient)
    return "Mac";
  const key = request.headers["x-kuvo-vault-key"];
  if (typeof key === "string" && unlockWith(key))
    return "Mac";
  return null;
}
var PROOF_FOR = 300000;
var usedProofs = new Map;
function provedMac(given) {
  const link = readLink();
  const mac = typeof given.mac === "string" ? given.mac : "";
  const at = Number(given.at);
  const nonce = typeof given.nonce === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(given.nonce) ? given.nonce : "";
  const sign = mac ? macSign(link, mac) : null;
  if (!sign || !nonce || !(link?.macs ?? []).includes(mac) || !Number.isFinite(at) || Math.abs(Date.now() - at) > PROOF_FOR || typeof given.proof !== "string")
    return false;
  const now = Date.now();
  for (const [used, until] of usedProofs)
    if (until < now)
      usedProofs.delete(used);
  if (usedProofs.has(nonce))
    return false;
  try {
    const key = crypto22.createPublicKey({ key: Buffer.concat([ED_SPKI2, Buffer.from(sign, "base64url")]), format: "der", type: "spki" });
    const signature = Buffer.from(given.proof, "base64url");
    const good = signature.length === 64 && typeof link?.id === "string" && crypto22.verify(null, Buffer.from(`kuvo-vault-key\x00${link.id}\x00${at}\x00${nonce}`), key, signature);
    if (good)
      usedProofs.set(nonce, now + 2 * PROOF_FOR);
    return good;
  } catch {
    return false;
  }
}
var idOf = (part) => {
  try {
    return decodeURIComponent(part ?? "");
  } catch {
    return "";
  }
};
async function* vaultRoute(context) {
  if (!holdsVault()) {
    const answer = await askHolder(context.request, context.signal);
    if (!answer)
      return yield* context.json(503, { message: NOT_OPEN });
    return yield* [{ head: { status: answer.status, headers: { "content-type": answer.type || "application/json" } } }, { body: Buffer.from(answer.body, "base64") }];
  }
  try {
    yield* answerVault(context);
  } catch (error) {
    if (error instanceof VaultRefusal)
      return yield* context.json(error.status, { message: error.message });
    throw error;
  }
}
async function* answerVault(context) {
  const { request, route, json, signal, readEngine, readBridge } = context;
  const method = request.method.toUpperCase();
  const body = parsed(request.body);
  const given = isObject(body) ? body : {};
  const parts = route.split("/");
  if (route === "kuvo/vault/tools") {
    if (method === "GET")
      return yield* json(200, { tools: VAULT_TOOLS });
    if (method !== "POST")
      return yield* json(405, {});
    const args = isObject(given.arguments) ? given.arguments : {};
    if (typeof given.name !== "string" || !await isCalling(stringOf(given.session), [given.name], args, readEngine, readBridge)) {
      return yield* json(200, { text: NOT_CALLING, isError: true });
    }
    const caller = await callerOf(given.session, readEngine, readBridge);
    return yield* json(200, await callTool(given.name, args, caller, signal));
  }
  if (route === "kuvo/vault/fill") {
    if (method !== "POST")
      return yield* json(405, {});
    if (onHost() && !request.fromApp)
      return yield* json(403, { message: CLIENTS_ONLY });
    if (isLocked())
      return yield* json(423, { message: LOCKED });
    if (!await isCalling(stringOf(given.session), ["browser_sign_in", "browser_fill"], null, readEngine, readBridge))
      return yield* json(403, { message: NOT_CALLING });
    const caller = await callerOf(given.session, readEngine, readBridge);
    const outcome = await fill(given, caller, signal);
    return yield* json(outcome.status, outcome.value);
  }
  if (route === "kuvo/vault/unlock") {
    if (method !== "POST")
      return yield* json(405, {});
    if (!isMade() || onHost())
      return yield* json(200, vaultState());
    if (!unlockWith(given.key))
      return yield* json(403, { message: "That isn't this vault's key." });
    return yield* json(200, vaultState());
  }
  if (route === "kuvo/vault/key") {
    if (method !== "POST")
      return yield* json(405, {});
    if (onHost())
      return yield* json(409, { message: "This Mac's vault is its Keychain: it has no key to give." });
    if (!clientOf(context) && !provedMac(given))
      return yield* json(403, { message: CLIENTS_ONLY });
    if (!isMade())
      return yield* json(200, { key: makeVault() });
    const key = currentUnlockKey();
    if (!key)
      return yield* json(423, { message: LOCKED });
    return yield* json(200, { key });
  }
  const client = clientOf(context);
  if (!client)
    return yield* json(403, { message: CLIENTS_ONLY });
  if (route === "kuvo/vault") {
    if (method !== "GET")
      return yield* json(405, {});
    return yield* json(200, { state: vaultState(), items: isLocked() ? [] : readItems(), grants: readGrants() });
  }
  if (route === "kuvo/vault/pause") {
    if (method !== "POST")
      return yield* json(405, {});
    const bot = typeof given.bot === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(given.bot) ? given.bot : undefined;
    const paused = given.paused === true;
    setPaused(paused, bot);
    note({ what: paused ? "paused" : "resumed", client, ...bot ? { bot } : {} });
    return yield* json(200, vaultState());
  }
  if (route === "kuvo/vault/activity") {
    if (method !== "GET")
      return yield* json(405, {});
    const query = new URLSearchParams(request.path.split("?")[1] ?? "");
    return yield* json(200, { entries: readActivity({
      item: query.get("item") ?? undefined,
      bot: query.get("bot") ?? undefined,
      session: query.get("session") ?? undefined,
      before: Number(query.get("before")) || undefined,
      limit: Number(query.get("limit")) || undefined
    }) });
  }
  if (route === "kuvo/vault/grants") {
    if (method === "GET")
      return yield* json(200, { grants: readGrants() });
    if (method !== "POST")
      return yield* json(405, {});
    const who = givenWho(given.who);
    if (typeof given.item !== "string" || !who)
      return yield* json(400, { message: 'Send {"item", "who": {"bot"} or {"project"} or {"everyone": true}, "how": "own" | "ask" | null}.' });
    const grants = setGrant(given.item, who, given.how ?? null);
    const item = itemByID(given.item);
    note({ what: given.how ? "granted" : "ungranted", client, ...item ? { item: item.id, itemName: item.name, kind: item.kind } : {}, ...who.bot ? { bot: who.bot } : {}, ...typeof given.how === "string" ? { how: given.how } : {} });
    return yield* json(200, { grants });
  }
  if (route === "kuvo/vault/asks" || route === "kuvo/vault/asks/events") {
    if (method !== "GET")
      return yield* json(405, {});
    if (route === "kuvo/vault/asks")
      return yield* json(200, { asks: listAsks() });
    yield { head: { status: 200, headers: { "content-type": "application/x-ndjson" } } };
    let wake = () => {};
    const stop = onAsksChanged(() => wake());
    try {
      while (!signal?.aborted) {
        yield { body: Buffer.from(JSON.stringify({ asks: listAsks() }) + `
`) };
        await new Promise((done) => {
          wake = done;
          signal?.addEventListener("abort", () => done(), { once: true });
        });
      }
    } finally {
      stop();
    }
    return;
  }
  if (parts.length === 4 && parts[2] === "asks") {
    if (method !== "POST")
      return yield* json(405, {});
    const answer2 = given.answer;
    if (answer2 !== "once" && answer2 !== "always" && answer2 !== "no")
      return yield* json(400, { message: "Answer “once”, “always” or “no”." });
    const item = typeof given.item === "string" ? given.item : undefined;
    if (item && !itemByID(item))
      return yield* json(404, { message: "That item isn't in this vault." });
    return yield* json(answer(idOf(parts[3]), { answer: answer2, ...item ? { item } : {}, client }) ? 200 : 404, {});
  }
  if (route === "kuvo/vault/items") {
    if (method !== "POST")
      return yield* json(405, {});
    let key;
    if (!isMade())
      key = makeVault();
    if (isLocked())
      return yield* json(423, { message: LOCKED });
    const item = await addItem(given);
    note({ what: "added", client, item: item.id, itemName: item.name, kind: item.kind });
    return yield* json(200, { item, ...key ? { key } : {} });
  }
  if (parts[2] === "items" && parts.length >= 4) {
    if (isLocked())
      return yield* json(423, { message: LOCKED });
    const id = idOf(parts[3]);
    if (parts.length === 5 && parts[4] === "values") {
      if (method !== "GET")
        return yield* json(405, {});
      const item = itemByID(id);
      if (!item)
        return yield* json(404, { message: "That item isn't in this vault." });
      const values = await valuesOf(id);
      note({ what: "shown", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { values });
    }
    if (parts.length !== 4)
      return yield* json(404, {});
    if (method === "PATCH") {
      const item = await changeItem(id, given);
      note({ what: "changed", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, { item });
    }
    if (method === "DELETE") {
      const item = await removeItem(id);
      note({ what: "removed", client, item: item.id, itemName: item.name, kind: item.kind });
      return yield* json(200, {});
    }
    return yield* json(405, {});
  }
  return yield* json(404, { message: `There's no ${oneLine(route, 80)}.` });
}

// Packages/Box/src/link/server/router.ts
var ROUTES = [
  { when: (route) => route === "kuvo/info", answer: infoRoute },
  { when: (route) => route === "kuvo/vault" || route.startsWith("kuvo/vault/"), answer: vaultRoute },
  { when: (route) => route === "kuvo/file", answer: ({ request, json }) => fileAt(request.path, json) },
  { when: (route) => route === "kuvo/update", answer: updateRoute },
  { when: (route, request) => /^kuvo\/integrations(\/|\?|$)/.test(request.path), answer: integrationsRoute },
  { when: (route) => route === "kuvo/folders", answer: foldersRoute },
  { when: (route) => route === "kuvo/plugins/search", answer: pluginSearchRoute },
  { when: (route) => route === "kuvo/programs", answer: programsRoute },
  { when: (route) => route === "kuvo/providers/models", answer: providerModelsRoute },
  { when: (route, request) => /^kuvo\/(skills|skill-library|skill-trash)(\/|\?|$)/.test(request.path), answer: skillsRoute },
  { when: (route, request) => /^kuvo\/(config|mcp\/catalog|keys)(\/|\?|$)/.test(request.path), answer: settingsRoute },
  { when: (route) => route === "kuvo/phones", answer: phonesRoute },
  { when: (route) => route === "kuvo/phones/remove", answer: phonesRemoveRoute },
  { when: (route) => route === "kuvo/phones/pair", answer: pairingRoute },
  { when: (route) => route === "kuvo/link" || route.startsWith("kuvo/link/"), answer: linkRoute },
  { when: (route) => route === "kuvo/attention/notice" || route === "kuvo/attention/answered", answer: appNoticeRoute },
  { when: (route) => route === "kuvo/attention", answer: attentionRoute },
  { when: (route) => route === "kuvo/named", answer: namedRoute },
  { when: (route) => route === "kuvo/search", answer: searchRoute },
  { when: (route) => route.startsWith("kuvo/git/"), answer: changesRoute },
  { when: (route) => route === "kuvo/asks" || route === "kuvo/asks/events", answer: asksRoute },
  { when: (route) => route.match(/^kuvo\/asks\/([^/]+)$/), answer: askAnswerRoute },
  { when: (route) => route.match(/^kuvo\/engine\/(start|restart)$/), answer: engineControlRoute },
  { when: (route) => route === "kuvo/sign-in/return", answer: signInReturnRoute },
  { when: (route, request) => request.path.startsWith(AGENTS), answer: agentsRoute },
  { when: (route) => route === "kuvo/accounts/ended" || /^kuvo\/accounts\/[^/]+\/forget$/.test(route), answer: accountsRoute },
  { when: (route) => route === "kuvo/accounts/credentials", answer: credentialsRoute },
  { when: (route) => route === "kuvo/accounts/found" || route === "kuvo/accounts/found/use", answer: foundRoute },
  { when: (route) => route === "kuvo/personalities/events", answer: personalityEventsRoute },
  { when: (route) => route === "kuvo/personalities/document" || route === "kuvo/personalities/take", answer: personalitiesDocumentRoute },
  { when: (route) => route.match(/^kuvo\/personalities(?:\/([^/]+))?$/), answer: personalityRoute },
  { when: (route) => route === "kuvo/bots/templates", answer: botTemplatesRoute },
  { when: (route, request) => request.method.toUpperCase() === "POST" && route === "kuvo/bots", answer: newBotRoute },
  { when: (route) => route === "kuvo/projects" || route === "kuvo/projects/events", answer: ({ request, readEngine, readBridge, signal }) => answerProjects(request, readEngine, readBridge, signal) },
  { when: (route) => route === "kuvo/worktrees/events", answer: worktreeEventsRoute },
  { when: (route) => /^kuvo\/worktrees(\/(remove|record|where))?$/.test(route), answer: worktreesRoute },
  { when: (route) => route === "kuvo/bots/keys/refresh", answer: botKeysRefreshRoute },
  { when: (route) => /^kuvo\/bots\/[^/]+\/keys(\/[^/]+)?$/.test(route), answer: botKeysRoute },
  { when: (route) => route.match(/^kuvo\/sessions\/([^/]+)\/agents$/), answer: carryRoute },
  { when: (route, request) => ["PATCH", "DELETE"].includes(request.method.toUpperCase()) && route.match(/^kuvo\/bots\/([^/]+)$/), answer: botRoute },
  { when: (route) => GROUP_ROUTE.test(route), answer: groupsRoute },
  { when: (route) => ARTIFACT_ROUTE.test(route), answer: artifactsRoute },
  { when: (route) => route.match(/^kuvo\/bots\/([^/]+)\/arrived$/), answer: arrivedRoute },
  { when: (route) => route === "kuvo/bots/retell", answer: retellRoute },
  { when: (route) => route === "kuvo/bots/events", answer: botEventsRoute },
  { when: (route) => route === "kuvo/bots", answer: botsRoute },
  { when: (route) => route === "kuvo/wakes", answer: wakesRoute },
  { when: (route) => route === "kuvo/wakes/events", answer: wakeEventsRoute },
  { when: (route) => route.match(/^kuvo\/wakes\/([^/]+)(?:\/(cancel|now|pause|watch))?$/), answer: sessionWakesRoute }
];
function engineHandler(readEngine = readEngineFile, info = {}, readBridge = readBridgeFile, phonesChanged = () => {}, hold = null) {
  const bridge = () => {
    try {
      const found = readBridge();
      return found?.port && found?.password && processRuns(found.pid, "kuvo-agents") ? found : null;
    } catch {
      return null;
    }
  };
  return async function* (request, phone, signal) {
    const text = (status, words) => [{ head: { status, headers: { "content-type": "text/plain" } } }, { body: Buffer.from(words) }];
    const json = (status, value) => [{ head: { status, headers: { "content-type": "application/json" } } }, { body: Buffer.from(JSON.stringify(value)) }];
    if (!request.fromApp)
      phoneHere();
    const route = request.path.split("?")[0];
    const context = { request, phone, signal, route, readEngine, readBridge, bridge, info, phonesChanged, hold, json, text };
    for (const { when, answer } of ROUTES) {
      const match = when(route, request);
      if (match)
        return yield* answer(context, match);
    }
    return yield* engineRoute(context);
  };
}

// Packages/Box/src/link/mac/relay.ts
var MAC_BOX_ROUTES = [
  "kuvo/artifacts",
  "kuvo/projects",
  "kuvo/worktrees",
  "kuvo/plugins",
  "kuvo/folders",
  "kuvo/programs",
  "kuvo/providers",
  "kuvo/wakes",
  "kuvo/config",
  "kuvo/mcp/catalog",
  "kuvo/skills",
  "kuvo/skill-library",
  "kuvo/skill-trash",
  "kuvo/integrations",
  "kuvo/keys",
  "kuvo/bots",
  "kuvo/personalities",
  "kuvo/phones",
  "kuvo/attention",
  "kuvo/accounts/ended",
  "kuvo/accounts/credentials",
  "kuvo/accounts/found",
  "kuvo/file",
  "kuvo/sign-in/return",
  "kuvo/named",
  "kuvo/groups",
  "kuvo/vault"
];
var macAnswersAlso = (route) => /^kuvo\/accounts\/[^/]+\/forget$/.test(route) || /^kuvo\/shell\/[^/]+\/stop$/.test(route);
var macAnswers = (route) => MAC_BOX_ROUTES.some((area) => route === area || route.startsWith(`${area}/`)) || macAnswersAlso(route);
var APP_NOT_ANSWERING = "Kuvo Code on this Mac isn't answering. Try again in a moment.";
async function* toApp(request, phone, signal) {
  let response = null;
  const host = appHost();
  if (host) {
    try {
      await proveHost(host);
      response = await fetch(`${host.url}/link/route`, {
        method: "POST",
        headers: { authorization: `Bearer ${host.password}`, "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          path: request.path,
          headers: request.headers ?? {},
          body: Buffer.from(request.body ?? EMPTY).toString("base64"),
          phone: phone?.key?.toString("base64url") ?? null
        }),
        signal
      });
    } catch {
      if (!signal?.aborted)
        forgetHostProof();
      response = null;
    }
  }
  if (!response || response.headers.get("x-kuvo-answer") !== "1") {
    await response?.body?.cancel().catch(() => {});
    yield { head: { status: 503, headers: { "content-type": "application/json" } } };
    yield { body: Buffer.from(JSON.stringify({ message: APP_NOT_ANSWERING })) };
    return;
  }
  const headers = { "content-type": response.headers.get("content-type") ?? "application/json" };
  const cache = response.headers.get("cache-control");
  if (cache)
    headers["cache-control"] = cache;
  yield { head: { status: response.status, headers } };
  if (!response.body)
    return;
  for await (const chunk of response.body) {
    if (signal?.aborted)
      break;
    yield { body: Buffer.from(chunk) };
  }
}
function macFront(handle = engineHandler(readEngineFile, { name: os8.hostname() })) {
  return async function* (request, phone, signal) {
    const route = String(request.path ?? "").split("?")[0];
    if (macAnswers(route) || /^api(\/|$)/.test(route) || route.startsWith(AGENTS))
      return yield* handle(request, phone, signal);
    yield* toApp(request, phone, signal);
  };
}
async function runMacLink() {
  let attempt = 0;
  macLink.stopped = false;
  while (!macLink.stopped) {
    try {
      const config = macLink.config;
      if (!await macKeys()) {
        await macLinkWait(30000);
        continue;
      }
      if (macLink.stopped)
        break;
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        await macLinkWait(60000);
        continue;
      }
      const link = readLink();
      setLinkStatus("connecting");
      let engine = {};
      try {
        engine = readEngineFile();
      } catch {}
      const host = new LinkHost({
        key: Buffer.from(link.key, "base64url"),
        hello: { v: 1, kind: "mac", name: config.name, app: config.app, engine: engine.version ?? null },
        authorize: (key, hello, address) => Boolean(macLink.config?.phones) && authorizePhone(key, hello, address),
        confirmed: confirmPhone,
        mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets)),
        handle: macFront(engineHandler(readEngineFile, { name: config.name }, readBridgeFile, (changed) => host.keepOnly(new Set((changed.phones ?? []).map((phone) => phone.key))), macLink.hold)),
        connect: engineConnect(readEngineFile),
        send: () => {}
      });
      macLink.host = host;
      const looking = setInterval(macLinkCheck, 30000);
      const started = Date.now();
      const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host, () => {
        setLinkStatus("connected");
        announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
        try {
          docsChanged(host, { greet: true });
        } catch {}
        try {
          tellUntold();
        } catch {}
      });
      clearInterval(looking);
      if (macLink.host === host)
        macLink.host = null;
      if (macLink.stopped)
        break;
      if (!macNeeded(readLink())) {
        setLinkStatus("off");
        attempt = 0;
        continue;
      }
      attempt = welcomed && Date.now() - started >= 60000 ? 0 : attempt + 1;
      if (!welcomed)
        setLinkStatus("failed", `Can't reach the relay at ${new URL(link.relay).host}.`);
      else
        setLinkStatus("connecting");
      await macLinkWait(Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)));
    } catch (error) {
      macLink.host = null;
      setLinkStatus("failed", String(error?.message ?? error));
      await macLinkWait(5000);
    }
  }
  setLinkStatus("off");
}

// Packages/Box/src/link/server/serve.ts
import crypto23 from "node:crypto";
import http from "node:http";
import os9 from "node:os";
function serveBox(password, handle = engineHandler(readEngineFile, { name: os9.hostname() })) {
  const expected = Buffer.from("Basic " + Buffer.from(`opencode:${password}`).toString("base64"));
  return http.createServer(async (request, response) => {
    const given = Buffer.from(request.headers.authorization ?? "");
    if (given.length !== expected.length || !crypto23.timingSafeEqual(given, expected)) {
      response.writeHead(401);
      return response.end();
    }
    const sent = canonicalPath((request.url ?? "").replace(/^\/+/, ""));
    if (sent === null) {
      response.writeHead(403);
      return response.end();
    }
    const chunks = [];
    for await (const chunk of request)
      chunks.push(chunk);
    const abort = new AbortController;
    response.on("close", () => abort.abort());
    let headed = false;
    try {
      const fromApp = request.headers["x-kuvo-from"] === "app";
      for await (const part of handle({ method: request.method ?? "GET", path: sent, headers: request.headers, body: Buffer.concat(chunks), fromApp }, {}, abort.signal)) {
        if (abort.signal.aborted)
          break;
        if (part.head && !headed) {
          response.writeHead(part.head.status, part.head.headers ?? {});
          response.flushHeaders();
          headed = true;
        }
        if (part.body)
          response.write(part.body);
      }
    } catch (error) {
      if (!headed) {
        response.writeHead(500, { "content-type": "application/json" });
        response.write(JSON.stringify({ message: String(error?.message ?? error) }));
        headed = true;
      }
    }
    if (!headed)
      response.writeHead(502);
    response.end();
  });
}

// Packages/Box/src/link/main.ts
scriptIs(fileURLToPath2(import.meta.url));
onDocsChanged(macDocsChanged);
onLinkWritten((link) => {
  if (IS_MAC) {
    for (const tell of macLink.phoneFollowers)
      tell();
    setTimeout(() => {
      macLink.host?.keepOnly(new Set((readLink()?.phones ?? []).map((phone) => phone.key)));
      macLinkCheck();
    }, 200);
    return;
  }
  if (needed(link))
    fs54.writeFileSync(NEEDED_FILE, "", { mode: 384 });
  else
    fs54.rmSync(NEEDED_FILE, { force: true });
});
function machineWelcomed(host) {
  announce(host, readEngineFile, undefined, undefined, true).catch(() => {});
  try {
    docsChanged(host, { greet: true });
  } catch {}
  try {
    confirmUpdate();
  } catch {}
}
async function run2() {
  let old = null;
  try {
    old = Number(fs54.readFileSync(PID_FILE, "utf8"));
    if (isBridge(old))
      process.kill(old, "SIGTERM");
  } catch {}
  fs54.mkdirSync(RUN, { recursive: true, mode: 448 });
  fs54.writeFileSync(PID_FILE, String(process.pid), { mode: 384 });
  fs54.writeFileSync(VERSION_FILE, BRIDGE_VERSION, { mode: 384 });
  for (const folder of ["present", "connected"])
    fs54.rmSync(path55.join(RUN, folder), { recursive: true, force: true });
  try {
    keepJobs();
  } catch {}
  forgetOldKit();
  await refreshBotsKeys().catch(() => {});
  updateLink((link) => {
    if (!link)
      return null;
    link.sign ??= newSigningSeed();
    foldPhones(link);
    return link;
  });
  const cleanUp = () => {
    try {
      if (fs54.readFileSync(PID_FILE, "utf8") === String(process.pid))
        fs54.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", cleanUp);
  process.on("SIGINT", cleanUp);
  let current = null;
  setInterval(() => {
    let owner = null;
    try {
      owner = Number(fs54.readFileSync(PID_FILE, "utf8"));
    } catch {}
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
    }
    if (!needed(link) || owner !== process.pid)
      return cleanUp();
    current?.keepOnly(new Set((link.phones ?? []).map((phone) => phone.key)));
    keepKeeper();
  }, 30000);
  const tellPhones = (notice) => {
    const link = readLink();
    const phones = (link?.phones ?? []).filter((phone) => phone.address);
    if (!phones.length)
      return true;
    if (!current?.welcomed || !link?.key)
      return false;
    const json = noticeJSON(notice);
    const key = Buffer.from(link.key, "base64url");
    let sent = false;
    for (const phone of phones) {
      try {
        current.send(pushTo(phone, json, key));
        sent = true;
      } catch {}
    }
    return sent;
  };
  for (let tries = 0;tries < 60 && old && isBridge(old); tries++)
    await sleep(50);
  let held = [];
  try {
    held = JSON.parse(fs54.readFileSync(HELD_FILE, "utf8"));
  } catch {}
  const hold = new NoticeHold({
    send: tellPhones,
    held,
    save: (entries) => {
      try {
        if (entries.length)
          writePrivate(HELD_FILE, JSON.stringify(entries));
        else
          fs54.rmSync(HELD_FILE, { force: true });
      } catch {}
    }
  });
  const tell = (notice) => hold.tell(notice);
  const answered = (id) => hold.resolve(id);
  watchBox({ tell, hold });
  watchSeats(() => current);
  watchAsks(tell, { answered });
  holdVault(engineHandler(readEngineFile, { name: os10.hostname() }));
  setVaultTell(tell);
  watchVaultAsks(tell, answered);
  let lastWelcomed = Date.now();
  refreshOwn(readEngineFile).catch(() => {});
  setTimeout(() => {
    try {
      confirmUpdate();
    } catch {}
  }, 180000);
  const nightly = () => {
    noteLauncher();
    noteOlderMacs();
    try {
      checkDrift();
    } catch {}
    const night = updateNight();
    if (!night || updateState().night === night || !UPDATE_KEYS.length)
      return;
    startUpdate({})?.then((outcome) => {
      if (outcome && outcome.result !== "busy")
        noteUpdate({ night });
    });
  };
  setTimeout(nightly, 60000);
  setInterval(nightly, 600000);
  keepSkillTrashClear();
  setInterval(() => {
    if (current?.welcomed)
      announce(current, readEngineFile).catch(() => {});
    else
      refreshOwn(readEngineFile).catch(() => {});
  }, 60000);
  setInterval(() => {
    if (current?.welcomed && docsNoted())
      try {
        docsChanged(current, { tell: true });
      } catch {}
    if (current?.welcomed)
      lastWelcomed = Date.now();
    try {
      sendOutbox(current ?? { send() {} }, undefined, Date.now(), current?.welcomed ? 0 : Date.now() - lastWelcomed);
    } catch {}
    deliverLeftAnswers().catch(() => {});
  }, 3000);
  let attempt = 0;
  while (true) {
    const link = readLink();
    if (!needed(link)) {
      forgetPhones();
      noLongerNeeded();
      return cleanUp();
    }
    let engine = {};
    try {
      engine = readEngineFile();
    } catch {}
    const host = new LinkHost({
      key: Buffer.from(link.key, "base64url"),
      hello: { v: 1, kind: "machine", name: link.name || os10.hostname(), app: BRIDGE_VERSION, engine: engine.version ?? null },
      authorize: authorizePhone,
      confirmed: confirmPhone,
      mail: (_from, body) => receiveMail(body, host, (sender, payload) => peerMail(sender, payload, host, peerTargets), (mac, given, at) => hold.attend(`mac:${mac}`, given, at)),
      handle: engineHandler(readEngineFile, { name: link.name || os10.hostname() }, readBridgeFile, (changed) => host.keepOnly(new Set((changed.phones ?? []).map((phone) => phone.key))), hold),
      connect: engineConnect(readEngineFile),
      send: () => {}
    });
    current = host;
    const welcomed = await connectOnce(link.relay, Buffer.from(link.secret, "base64url"), host, machineWelcomed);
    attempt = welcomed ? 0 : attempt + 1;
    await sleep(Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)));
  }
}
async function box(command) {
  const input = async () => {
    const chunks = [];
    for await (const chunk of process.stdin)
      chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  const say = (value) => console.log(JSON.stringify(value));
  switch (command) {
    case "adopt": {
      let seed = null;
      try {
        seed = JSON.parse(await input() || "null");
      } catch {}
      return say(adoptBox(seed));
    }
    case "read": {
      const { settings, problem } = readSettings();
      return say(problem ? { status: 409, message: problem } : { status: 200, settings, own: ownsSettings() });
    }
    case "change": {
      let given = {};
      try {
        given = JSON.parse(await input());
      } catch {}
      return say(ownsSettings() ? changeSettings(given?.changes) : { status: 409, message: "This machine's settings aren't its own yet." });
    }
    case "key": {
      const name = process.argv[4];
      const value = await input();
      return say(setBoxKey(name, value.length ? value : null));
    }
    case "update-status":
      return say({ status: 200, ...updateStatus() });
    case "update-now": {
      if (!UPDATE_KEYS.length)
        return say({ status: 409, message: "Updates aren't set up for this machine yet." });
      const blocked = updatesBlocked();
      if (blocked)
        return say({ status: 409, message: blocked });
      if (isUpdating())
        return say({ status: 409, message: "It's updating already." });
      spawn6(process.execPath, [fileURLToPath2(import.meta.url), "update", "--now"], { detached: true, stdio: "ignore", cwd: K, env: process.env }).unref();
      return say({ status: 202, ...updateStatus(), updating: "checking" });
    }
    case "route": {
      answerOnce();
      let given = {};
      try {
        given = JSON.parse(await input());
      } catch {}
      const handle = engineHandler(readEngineFile, { name: os10.hostname() });
      const folder = given?.headers?.["x-opencode-directory"];
      const vaultKey = given?.headers?.["x-kuvo-vault-key"];
      const request = { method: String(given?.method ?? "GET"), path: String(given?.path ?? ""), headers: { "content-type": "application/json", ...typeof folder === "string" ? { "x-opencode-directory": folder } : {}, ...typeof vaultKey === "string" ? { "x-kuvo-vault-key": vaultKey } : {} }, body: Buffer.from(given?.body === undefined ? "" : JSON.stringify(given.body)), fromMac: true };
      let status = 502;
      let type = "";
      const chunks = [];
      const stop = new AbortController;
      for await (const part of handle(request, {}, stop.signal)) {
        if (part.head) {
          status = part.head.status;
          type = String(part.head.headers?.["content-type"] ?? "");
        }
        if (part.body)
          chunks.push(Buffer.from(part.body));
        if (type.startsWith("application/x-ndjson") && Buffer.concat(chunks).includes(10)) {
          stop.abort();
          const all = Buffer.concat(chunks);
          return say({ status, body: all.subarray(0, all.indexOf(10) + 1).toString("utf8") });
        }
      }
      const body = Buffer.concat(chunks);
      const text = (!type || type.startsWith("text/") || type.includes("json")) && isUTF8(body);
      return say(text ? { status, body: body.toString("utf8") } : { status, bodyBase64: body.toString("base64"), type });
    }
    case "reconnect": {
      const id = process.argv[4];
      await new Promise((done) => setTimeout(done, 2000));
      let engine;
      try {
        engine = readEngineFile();
      } catch {
        return;
      }
      if (id)
        await reconnectEverywhere(engine, id);
      return;
    }
    case "bot-keys-refresh":
      await refreshBotsKeys();
      return say({ status: 200 });
    case "personalities": {
      let given = null;
      try {
        given = JSON.parse(await input() || "null");
      } catch {}
      const before = JSON.stringify(readPersonalities());
      const met = changePersonalities((library) => mergePersonalities(library, given));
      if (JSON.stringify(met) !== before)
        noteDocsChanged();
      return say({ status: 200, ...met });
    }
    default:
      console.error("Usage: kuvo-link.js box adopt | read | change | key <name> | route | reconnect <server> | bot-keys-refresh | personalities | update-status | update-now");
      process.exit(2);
  }
}
function firstLine() {
  return new Promise((resolve) => {
    let given = "";
    const take = (chunk) => {
      given += chunk.toString();
      const end = given.indexOf(`
`);
      if (end < 0)
        return;
      process.stdin.off("data", take);
      process.stdin.off("end", done);
      process.stdin.pause();
      try {
        resolve(JSON.parse(given.slice(0, end)));
      } catch {
        resolve({});
      }
    };
    const done = () => resolve({});
    process.stdin.on("data", take);
    process.stdin.once("end", done);
  });
}
async function serve() {
  let password = process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_PASSWORD;
  if (!password) {
    const given = await firstLine();
    if (typeof given.password === "string")
      password = given.password;
    takeVaultSecrets(given);
  }
  if (!password) {
    console.error('serve answers only with a password: on its stdin, {"password"}, or in OPENCODE_PASSWORD.');
    process.exit(2);
  }
  fs54.mkdirSync(RUN, { recursive: true, mode: 448 });
  if (IS_MAC)
    addMacDefaults();
  if (IS_MAC)
    macLink.hold = macNoticeHold();
  const server = serveBox(password, engineHandler(readEngineFile, { name: os10.hostname() }, readBridgeFile, () => {}, macLink.hold));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
  holdVault(engineHandler(readEngineFile, { name: os10.hostname() }, readBridgeFile));
  if (IS_MAC) {
    setVaultTell(macTell);
    watchVaultAsks(macTell, (id) => macLink.hold?.resolve(id));
  }
  refreshBotsKeys().catch(() => {});
  forgetLeftKeys().catch(() => {});
  sendWakes();
  if (IS_MAC)
    runMacLink().catch(() => {});
  const testsAlone = process.env.KUVO_TEST_NO_PEERS && path55.basename(path55.dirname(path55.resolve(K))) !== "run.kuvo.code";
  if (IS_MAC && !testsAlone)
    runMacPeers();
  keepSkillTrashClear();
  if (readKit())
    try {
      keepJobs();
    } catch {}
  watchBox({ tell: macTell, hold: macLink.hold, bots: true, notices: IS_MAC });
  const leave = async () => {
    for (let tries = 0;tries < 30 && (macLink.host?.unsent?.() ?? 0) > 0; tries++)
      await sleep(50);
    if ((macLink.host?.unsent?.() ?? 0) > 0)
      console.error("Kuvo Code quit before what its link had for your phones and machines went out.");
    process.exit(0);
  };
  process.stdin.on("end", leave);
  process.stdin.on("close", leave);
  process.stdin.resume();
}
async function setup() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin)
      chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    console.error("setup takes JSON on stdin: {relay, name, mac, macSign, docs: [{d, s}], id, …}");
    process.exit(2);
  }
  const mac = typeof input.mac === "string" ? input.mac : undefined;
  const running = runningBridge();
  const old = readLink();
  const before = readPersonalities();
  let link = null, work = null, library = before;
  updateLink((current) => {
    const next = current ?? { secret: crypto24.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), phones: [] };
    next.sign ??= newSigningSeed();
    if (mac) {
      next.mac = mac;
      next.macs = [...new Set([...macsOf(next), mac])];
      forgetOldMacs(next, mac);
      if (typeof input.macSign === "string" && SIGN.test(input.macSign)) {
        next.macSigns = { ...next.macSigns ?? {}, [mac]: input.macSign };
        if (next.legacy)
          delete next.legacy[mac];
      } else if (Array.isArray(input.peers)) {
        takeLegacyPeers(next, mac, input.peers, typeof input.peersAt === "number" ? input.peersAt : typeof input.at === "number" ? input.at : 0, input.moved);
      }
    }
    if (typeof input.id === "string")
      next.id = input.id.slice(0, 200);
    if (typeof input.macID === "string" && /^[A-Za-z0-9-]{1,100}$/.test(input.macID))
      next.tolerantIDs = { ...next.tolerantIDs ?? {}, [input.macID]: input.tolerates === 1 };
    const state = { link: next, library: before };
    work = docsWork(state, { key: mac ?? "", sign: mac ? macSign(next, mac) : undefined }, { give: Array.isArray(input.docs) ? input.docs : [] }, { stay: mac ?? null });
    library = state.library;
    if (!next.phones.length && !peersOf(next).length)
      return current ? next : null;
    next.relay = String(input.relay);
    next.name = String(input.name || next.name || os10.hostname()).slice(0, 100);
    link = next;
    return next;
  });
  if (work && library !== before)
    await takePersonalities(library).catch(() => {});
  noteDocsChanged();
  if (!link) {
    if (running)
      process.kill(running, "SIGTERM");
    forgetPhones();
    console.log("{}");
    return;
  }
  let runningVersion = null;
  try {
    runningVersion = fs54.readFileSync(VERSION_FILE, "utf8").trim();
  } catch {}
  const restart = old?.relay !== link.relay || old?.name !== link.name || runningVersion !== BRIDGE_VERSION;
  if (!isUpdating()) {
    if (running && restart)
      process.kill(running, "SIGTERM");
    if (!running || restart)
      startBridge();
  }
  console.log(JSON.stringify({
    address: addressOf(Buffer.from(link.secret, "base64url")).toString("base64url"),
    key: publicOf(Buffer.from(link.key, "base64url")).toString("base64url"),
    peers: true,
    sign: ownSign(link),
    docs: setupDocs(link)
  }));
}
function isUTF8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
function setupDocs(link) {
  const state = { link, library: readPersonalities() };
  const own = ownDocs(state);
  return [...Object.values(link.docs ?? {}), ...Object.values(own).map((each) => each.envelope)];
}
function leave(mac) {
  if (typeof mac !== "string" || !KEY.test(mac))
    return false;
  const link = updateLink((link) => {
    if (!link || !macsOf(link).includes(mac))
      return null;
    leaveMac(link, mac);
    pruneDocs(link);
    foldPhones(link);
    return link;
  });
  if (!link)
    return false;
  forgetMacsAgents(mac, link);
  noteDocsChanged();
  return true;
}
function pair(relay) {
  const link = updateLink((current) => {
    const next = current ?? { secret: crypto24.randomBytes(32).toString("base64url"), key: newKey().toString("base64url"), name: os10.hostname(), phones: [] };
    next.sign ??= newSigningSeed();
    if (relay)
      next.relay = relay;
    if (!next.relay)
      return null;
    next.pairing = newPairingToken();
    return next;
  });
  if (!link) {
    console.error("Give the relay's address: kuvo-link.js pair wss://…");
    process.exit(1);
  }
  console.log(pairingLink(link));
  console.error(`Open this link on your phone within ${PAIRING_MINUTES} minutes. It works once.`);
  if (!runningBridge())
    startBridge();
}
function selftest() {
  const phone = newKey(), host = newKey();
  const initiator = new IKInitiator(phone, publicOf(host), PROLOGUE);
  const responder = new IKResponder(host, PROLOGUE);
  const said = responder.readMessage1(initiator.writeMessage1(Buffer.from("hello")));
  const { message, transport: hostSide } = responder.writeMessage2(Buffer.from("welcome"));
  const { payload, transport: phoneSide } = initiator.readMessage2(message);
  const echoed = hostSide.open(phoneSide.seal(Buffer.from("ping")));
  const mail = openOneWay(sealOneWay(Buffer.from("mail"), host, publicOf(phone)).message, phone, publicOf(host)).payload;
  const ok = said.toString() === "hello" && payload.toString() === "welcome" && echoed.toString() === "ping" && mail.toString() === "mail" && responder.rs.equals(publicOf(phone)) && typeof WebSocket === "function" && typeof fetch === "function";
  return ok;
}
var main = process.argv[1] && fs54.realpathSync(process.argv[1]) === fs54.realpathSync(fileURLToPath2(import.meta.url));
if (main) {
  const [mode, argument] = process.argv.slice(2);
  if (mode === "run")
    await run2();
  else if (mode === "setup")
    await setup();
  else if (mode === "pair")
    pair(argument);
  else if (mode === "box")
    await box(argument);
  else if (mode === "serve")
    await serve();
  else if (mode === "leave")
    leave(argument);
  else if (mode === "update") {
    const args = process.argv.slice(3);
    const option = (name) => args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined;
    const test = option("--url") && option("--key") && path55.resolve(K) !== path55.join(homeFolder(), ".kuvo-code");
    const outcome = await update({ now: args.includes("--now"), step: (running) => noteUpdate({ running }), ...test ? { url: option("--url"), keys: [option("--key")], blocked: null } : {} });
    noteUpdate({ running: null, ...outcome.result === "updated" ? {} : { last: { at: Date.now(), ...outcome } } });
    if (outcome.result === "updated") {
      const pid = runningBridge();
      if (pid)
        process.kill(pid, "SIGTERM");
      if (!needed(readLink()))
        confirmUpdate();
    }
    console.log(JSON.stringify(outcome));
  } else if (mode === "selftest") {
    const ok = selftest();
    console.log(ok ? "ok" : "failed");
    process.exit(ok ? 0 : 1);
  } else {
    console.error("Usage: kuvo-link.js run | serve | setup | pair [relay] | box <command> | leave <mac> | update [--now] | selftest");
    process.exit(2);
  }
}
export {
  ASK_HOLD,
  BOT_MEMORY_RULE,
  BRIDGE_VERSION,
  CipherState,
  FEATURES,
  FILE_LIMIT,
  FROM_PHONE,
  Frame,
  IKInitiator,
  IKResponder,
  IS_MAC,
  KEEP_FOR,
  LETTER_WAIT,
  LINK_FILE,
  LONGEST_LEASE,
  LinkHost,
  MAC_BOX_ROUTES,
  MAIL_PROLOGUE,
  MOST_DOC,
  NEWS_HOLD,
  NOTICE_LIMIT,
  NoticeHold,
  PROLOGUE,
  RESTORED_WAIT,
  SEEN_FILE,
  SHOWN_WITHIN,
  SKILL_REPOSITORIES,
  STEER_AFTER,
  UPDATE_KEYS,
  addFromCatalog,
  addMacDefaults,
  addressOf,
  adoptBox,
  agentsAllowed,
  allWakes,
  allowed,
  announce,
  answerAsk,
  answerBotKeys,
  answerIntegrations,
  answerPersonalities,
  answerProjects,
  answerSkills,
  answerWorktrees,
  applySettings,
  askAnswer,
  askNotice,
  attentionGiven,
  authorizePhone,
  botInstructions,
  botPersonalities,
  botTemplates,
  botVariable,
  boxProjects,
  boxVersion,
  branchSlug,
  canonicalPath,
  carrySeat,
  carryToAgents,
  changeBot,
  changePersonalities,
  changeProjects,
  changeSettings,
  changedWork,
  checkDrift,
  composeAgents,
  composeLetter,
  confirmPhone,
  confirmUpdate,
  connectOnce,
  decodeMessage,
  deepMerged,
  deleteBot,
  deliverLeftAnswers,
  describeForm,
  describePermission,
  digestOf,
  docBytes,
  docMails,
  docsChanged,
  docsWork,
  encodeMessage,
  endedProviders,
  engineConnect,
  engineControl,
  engineHandler,
  findProgram,
  firstMessageOf,
  foldPhones,
  followed,
  forgetLeftKeys,
  forgetOldMacs,
  forgetPhones,
  forgetPlan,
  frame,
  freshenBot,
  freshenBots,
  fromPhone,
  fromRelay,
  greetWork,
  groupNotice,
  holdArchived,
  holdFor,
  isSecretName,
  isUpdating,
  jobInMemory,
  jobLine,
  keepJobs,
  keepKeeper,
  keepSkillTrashClear,
  keysNamedHere,
  leave,
  leaveMac,
  letterMail,
  letterWent,
  listBots,
  listFolders,
  listWakes,
  listedAsk,
  macAnswers,
  macDocsChanged,
  macFront,
  macLink,
  macNoticeHold,
  macTell,
  macsOf,
  mailFor,
  makeBot,
  makeFolder,
  markingHashes,
  masked,
  maskedHexValues,
  maskedNamed,
  mcpCatalog,
  mergePersonalities,
  messageID,
  movedOf,
  nameAgents,
  nameWorktreeBranch,
  namedAgents,
  namesHash,
  namesIn,
  newKey,
  newPairing,
  newSigningSeed,
  newerVersion,
  nextWake,
  noLongerNeeded,
  noteDocsChanged,
  noteLauncher,
  noteOlderMacs,
  noteSignIn,
  noticeFor,
  noticeJSON,
  openMail,
  openOneWay,
  ownAgents,
  ownDoc,
  ownRefreshed,
  ownSign,
  ownsSettings,
  pairPhone,
  pairingLink,
  peerMail,
  peerOf,
  peersOf,
  personalitiesDocument,
  phoneSeenLately,
  pieces,
  projectNameOf,
  providerModels,
  publicOf,
  pushTo,
  readAsks,
  readDoc,
  readFrame,
  readKit,
  readLink,
  readPeerAgents,
  readPersonalities,
  readProjects,
  readRelay,
  readRemovedWorktrees,
  readSettings,
  readWakes,
  readWords,
  readWorktrees,
  receiveDocs,
  receiveMail,
  reconnectEverywhere,
  refreshBotsKeys,
  refreshOwn,
  refreshedRules,
  relayHello,
  relayPush,
  relaySend,
  removeAsMac,
  removePhones,
  repeatText,
  retellBots,
  runMacLink,
  runMacPeers,
  sealOneWay,
  searchPlugins,
  seatPayloads,
  seatPeers,
  selftest,
  sendOutbox,
  sendWakes,
  serveBox,
  setBoxKey,
  setMacPeers,
  settleBot,
  settleHeld,
  showsAll,
  signDoc,
  signInReturn,
  signingKeyOf,
  skillAbout,
  skillName,
  skillTrashEntry,
  skillsIn,
  socketAllowed,
  startUpdate,
  steering,
  stopMacLink,
  stopMacPeers,
  takeAgents,
  takeDoc,
  takeLegacyPeers,
  takeLetter,
  takePersonalities,
  takePersonalitiesDocument,
  takeSeat,
  tellSeatPeers,
  tellWorktree,
  toolRun,
  translateSettings,
  update,
  updateLink,
  updateNight,
  updateStatus,
  updatesBlocked,
  verifyBoxes,
  versionOrder,
  wakeFolder,
  wakeOf,
  watchAsks,
  watchBox,
  watchEvents,
  watchSeats,
  worktreesWhere,
  writeAgents,
  writeLink
};
