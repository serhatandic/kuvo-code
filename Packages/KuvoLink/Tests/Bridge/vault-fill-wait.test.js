// A sign-in from a machine's vault that asks you first (`kuvo/vault/fill` on an item its grant says
// to ask about): while it waits for your answer, other conversations' browser steps go on, and
// once you allow it, it fills the page only if the page is still where it was. The real tool
// (`kuvo-browser.js mcp`), the real box script and box, on a folder of the test's own; the engine
// and the browser's keeper (Chromium behind it) are stand-ins.
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/vault-fill-wait.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sshAgentsOf } from "./bot-keys-scenarios.js";
import { atEnd, removeAtEnd } from "./at-end.js";
// (Each test fails at its own time limit when what it waits for never comes, rather than holding up the run.)
import { asked, before, test } from "./vault-waits.js";

// (Short: the vault's and the browser's sockets are in it.)
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kvf-")));
// (Once the box and the tool have stopped: they write in its folder until they have.)
removeAtEnd(home);
removeAtEnd(sshAgentsOf(home));
atEnd(async () => {
  await Promise.all([box, mcp].map(child => child && child.exitCode === null && child.signalCode === null ? new Promise(done => { child.once("exit", done); child.kill(); }) : null));
});
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const tool = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-browser.js", import.meta.url));
const script = path.join(home, "bin", "kuvo-link.js");
write(script, fs.readFileSync(new URL("../../Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url)));
const env = { ...process.env, KUVO_HOME: home, HOME: home, KUVO_VAULT_AGENTS: "1" };
for (const name of ["KUVO_HOST_URL", "KUVO_HOST_PASSWORD", "KUVO_KEYS", "KUVO_KEYS_ON_HOST", "KUVO_BOX", "KUVO_SESSION"]) delete env[name];

const SECRET = "hunter2-correct-horse";

// The Mac that set this machine up, which keeps its vault's key and answers its asks.
const macKey = crypto.randomBytes(32).toString("base64url");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const macSign = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
const proof = () => {
  const at = Date.now();
  const nonce = crypto.randomBytes(18).toString("base64url");
  return { mac: macKey, at, nonce, proof: crypto.sign(null, Buffer.from(`kuvo-vault-key\0devbox\0${at}\0${nonce}`), privateKey).toString("base64url") };
};
write(path.join(home, "run", "link.json"), JSON.stringify({ id: "devbox", macs: [macKey], mac: macKey, macSigns: { [macKey]: macSign } }));

// The engine: a bot's conversation and another one, in the test's folder, and the tool calls
// running in each (the box checks a fill comes from one).
const sessions = { ses_pilot: { id: "ses_pilot", title: "Pilot", location: { directory: home }, metadata: { kuvo: { autopilot: true } } }, ses_helper: { id: "ses_helper", title: "Helper", parentID: "ses_pilot", location: { directory: home } }, ses_auto: { id: "ses_auto", title: "Kuvo Code: Pilot", location: { directory: home }, metadata: { kuvo: { engineFor: "ses_pilot" } } }, ses_late: { id: "ses_late", title: "Later on Autopilot", location: { directory: home } }, ses_ship: { id: "ses_ship", title: "Ship", location: { directory: home } }, ses_shop: { id: "ses_shop", title: "Fix checkout", location: { directory: home } } };
const running = new Map();
const engine = http.createServer((request, response) => {
  const [, id, messages] = request.url.match(/^\/api\/session\/([^/?]+)(\/message)?(\?.*)?$/) ?? [];
  const session = sessions[decodeURIComponent(id ?? "")];
  response.writeHead(session ? 200 : 404, { "content-type": "application/json" });
  const content = [...running.entries()].filter(([, each]) => each.session === session?.id).map(([id, each]) => ({ type: "tool", id: `call_${id}`, name: each.name, state: { status: "running", input: each.args } }));
  response.end(JSON.stringify(!session ? { message: "No such session." } : messages ? { data: [{ content }] } : { data: session }));
});
await new Promise(resolve => engine.listen(0, "127.0.0.1", resolve));
atEnd(() => { engine.closeAllConnections(); engine.close(); });
write(path.join(home, "run", "engine.json"), JSON.stringify({ port: engine.address().port, password: "p" }));
write(path.join(home, "bots", "bot_ship", "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_ship", name: "Ship" }));
write(path.join(home, "bots", "bot_ship", "session"), "ses_ship");

// The browser: two pages, each a conversation's own, and what was typed into their fields.
const pages = {
  login: { url: "https://github.com/login", title: "Sign in to GitHub", fields: { 1: "text", 2: "password" }, filled: [], owner: "ses_ship" },
  docs: { url: "https://example.com/docs", title: "Example docs", fields: {}, filled: [], owner: "ses_shop" },
};
const pageOf = sessionId => Object.keys(pages).find(target => `s-${target}` === sessionId);
// What a step's script asked of the page: its named arguments.
const argsOf = expression => {
  try {
    return JSON.parse(expression.slice(expression.lastIndexOf("})(") + 3, -1));
  } catch {
    return {};
  }
};
function answer(message) {
  const params = message.params ?? {};
  const target = pageOf(message.sessionId);
  switch (message.method) {
    case "Kuvo.getActive":
      return { targetId: "login" };
    case "Target.getTargets":
      return { targetInfos: Object.entries(pages).map(([targetId, page]) => ({ targetId, type: "page", url: page.url })) };
    case "Kuvo.mine": {
      const own = Object.keys(pages).find(each => pages[each].owner === params.session);
      return own ? { targetId: own, at: 1, picked: 0 } : { picked: 0 };
    }
    case "Kuvo.claim":
      return { ok: true };
    case "Target.attachToTarget":
      return { sessionId: `s-${params.targetId}` };
    case "Target.getTargetInfo":
      return { targetInfo: { targetId: params.targetId, type: "page", url: pages[params.targetId].url } };
    case "Page.getFrameTree":
      return { frameTree: { frame: { id: `f-${target}`, url: pages[target].url, securityOrigin: new URL(pages[target].url).origin } } };
    case "Page.createIsolatedWorld":
      return { executionContextId: 1 };
    case "Runtime.evaluate": {
      const page = pages[target];
      if (params.expression === "document.readyState") return { result: { value: "complete" } };
      if (!params.contextId) return { result: { value: [] } };
      const args = argsOf(params.expression);
      if (args.kuvoHandlers) return { result: { value: { title: page.title, url: page.url, text: `[1] ${page.title}` } } };
      if ("value" in args) {
        page.filled.push({ index: args.index, value: args.value });
        return { result: {} };
      }
      return { result: { value: page.fields[args.index] ?? "missing" } };
    }
    default:
      return {};
  }
}
const keeper = net.createServer(socket => {
  socket.on("error", () => {});
  socket.write(JSON.stringify({ method: "Kuvo.hello", params: { keeper: Number.MAX_SAFE_INTEGER, targetId: "login", viewers: 1, held: [] } }) + "\n");
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined) socket.write(JSON.stringify({ id: message.id, result: answer(message) }) + "\n");
    }
  });
});
await new Promise(resolve => keeper.listen(path.join(home, "run", "browser.sock"), resolve));
atEnd(() => keeper.close());

// The box's own process, which holds the vault, and where it tells what the vault asks you.
let box;
let asksURL;

// The Mac over SSH: `box route`, with the vault's key when it has one.
async function fromMac(method, route, body, key) {
  const child = spawn(process.execPath, [script, "box", "route"], { env, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.end(JSON.stringify({ method, path: route, body, headers: key ? { "x-kuvo-vault-key": key } : {} }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { status: answer.status, value: JSON.parse(answer.body || "{}") };
}
// What the vault asks you now, once it does.
async function askedNow() {
  const asks = await asked(asksURL, "box-pw");
  assert.equal(asks.length, 1, "the vault asks you");
  return asks[0];
}

// The tool, as the engine starts it, and its calls, as the engine makes them for each conversation.
const mcp = spawn(process.execPath, [tool, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
const answers = new Map();
let buffer = "";
mcp.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    answers.get(message.id)?.(message.result);
  }
});
let next = 1;
const call = (session, name, args) => {
  const id = next++;
  running.set(id, { session, name, args });
  return new Promise(resolve => {
    answers.set(id, result => { running.delete(id); resolve(result); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
};
// A call, and whether it has answered yet.
const started = promise => {
  const watched = { done: false };
  watched.result = promise.then(result => ((watched.done = true), result));
  return watched;
};

let key;
before(async () => {
  box = spawn(process.execPath, [script, "serve"], { env: { ...env, OPENCODE_PASSWORD: "box-pw" }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  box.stdout.setEncoding("utf8");
  box.stderr.setEncoding("utf8");
  box.stderr.on("data", chunk => { err += chunk; });
  const url = await new Promise((resolve, reject) => {
    box.stdout.on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]).url); });
    box.once("exit", code => reject(new Error(`serve exited ${code}: ${err}`)));
  });
  asksURL = `${url}/kuvo/vault/asks/events`;
  // (Its vault listens before the box says where it is.)
  const made = await fromMac("POST", "kuvo/vault/key", proof());
  assert.equal(made.status, 200, JSON.stringify(made.value));
  key = made.value.key;
  const added = await fromMac("POST", "kuvo/vault/items", { name: "GitHub", kind: "login", sites: ["github.com"], username: "ship-bot", values: { password: SECRET } }, key);
  assert.equal(added.status, 200, JSON.stringify(added.value));
  assert.equal((await fromMac("POST", "kuvo/vault/grants", { item: added.value.item.id, who: { bot: "bot_ship" }, how: "ask" }, key)).status, 200);
});

test("while the vault asks you about a sign-in, other conversations keep browsing, and the sign-in goes in once you allow it", async () => {
  const signIn = started(call("ses_ship", "browser_sign_in", { username: 1, password: 2, item: "GitHub" }));
  const asked = await askedNow();
  assert.equal(asked.itemName, "GitHub");
  // Another conversation's step, meanwhile: it isn't held up by the one waiting for you.
  const other = await call("ses_shop", "browser_snapshot", {});
  assert.equal(other.isError, false, other.content[0].text);
  assert.match(other.content[0].text, /Page: Example docs/);
  assert.equal(signIn.done, false, "the sign-in still waits for you");
  assert.deepEqual(pages.login.filled, []);
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asked.id}`, { answer: "once" }, key)).status, 200);
  const signedIn = await signIn.result;
  assert.equal(signedIn.isError, false, signedIn.content[0].text);
  assert.match(signedIn.content[0].text, /Filled the username and the password for github\.com from the vault's “GitHub”/);
  assert.ok(!JSON.stringify(signedIn).includes(SECRET), "the agent never sees the password");
  assert.deepEqual(pages.login.filled, [{ index: 1, value: "ship-bot" }, { index: 2, value: SECRET }]);
});

test("on Autopilot nothing asks you while it browses: a sign-in, a code, a step or an item from the vault come back at once, left undone, a subagent's too", async () => {
  pages.login.filled = [];
  const leftUndone = answer => {
    assert.equal(answer.isError, false, answer.content[0].text);
    assert.match(answer.content[0].text, /This is on Autopilot: nothing was put to the user/);
  };
  leftUndone(await call("ses_pilot", "browser_ask_user", { instruction: "Solve the CAPTCHA." }));
  leftUndone(await call("ses_helper", "browser_ask_user", { instruction: "Solve the CAPTCHA." }));
  leftUndone(await call("ses_pilot", "browser_sign_in", { username: 1, password: 2 }));
  leftUndone(await call("ses_pilot", "browser_ask_code", { index: 1, prompt: "The code texted to you." }));
  leftUndone(await call("ses_pilot", "vault_ask", { need: "The deploy key", why: "To deploy." }));
  assert.deepEqual(pages.login.filled, []);
  assert.deepEqual((await fromMac("GET", "kuvo/vault/asks")).value.asks ?? [], []);
});

test("Auto's run on an engine model is its conversation's: on Autopilot, nothing it does waits either", async () => {
  const leftUndone = answer => {
    assert.equal(answer.isError, false, answer.content[0].text);
    assert.match(answer.content[0].text, /This is on Autopilot: nothing was put to the user/);
  };
  leftUndone(await call("ses_auto", "browser_ask_user", { instruction: "Solve the CAPTCHA." }));
  leftUndone(await call("ses_auto", "vault_ask", { need: "The deploy key", why: "To deploy." }));
  assert.deepEqual((await fromMac("GET", "kuvo/vault/asks")).value.asks ?? [], []);
});

test("an item it's only allowed by asking is left undone on Autopilot, with nothing filled, and its line in the vault's activity says so", async () => {
  pages.login.filled = [];
  const signIn = await call("ses_pilot", "browser_sign_in", { username: 1, password: 2, item: "GitHub" });
  assert.match(signIn.content[0].text, /This is on Autopilot: nothing was put to the user/);
  assert.deepEqual(pages.login.filled, []);
  assert.deepEqual((await fromMac("GET", "kuvo/vault/asks")).value.asks ?? [], []);
  const activity = (await fromMac("GET", "kuvo/vault/activity", undefined, key)).value.entries;
  assert.ok(activity.some(each => each.what === "refused" && each.itemName === "GitHub" && each.how === "autopilot"), JSON.stringify(activity.slice(-3)));
});

test("turned on Autopilot while it waits on you, an ask stops waiting, its card goes, and the agent hears it's left undone", async () => {
  try {
    pages.login.filled = [];
    const leftUndone = answer => assert.match(answer.content[0].text, /This is on Autopilot: nothing was put to the user/);
    const signIn = started(call("ses_late", "browser_sign_in", { username: 1, password: 2, item: "GitHub" }));
    const item = started(call("ses_late", "vault_ask", { need: "The deploy key", why: "To deploy." }));
    const shown = await asked(asksURL, "box-pw");
    assert.ok(shown.length >= 1, "the vault asks you");
    const step = started(call("ses_late", "browser_ask_user", { instruction: "Solve the CAPTCHA." }));
    assert.equal(signIn.done || item.done || step.done, false);
    sessions.ses_late.metadata = { kuvo: { autopilot: true } };
    leftUndone(await signIn.result);
    leftUndone(await item.result);
    leftUndone(await step.result);
    assert.deepEqual(pages.login.filled, []);
    assert.deepEqual((await fromMac("GET", "kuvo/vault/asks")).value.asks ?? [], []);
  } finally {
    delete sessions.ses_late.metadata;
  }
});

test("a page that left its site while the vault asked you gets nothing", async () => {
  pages.login.filled = [];
  const signIn = started(call("ses_ship", "browser_sign_in", { username: 1, password: 2, item: "GitHub" }));
  const asked = await askedNow();
  // Meanwhile the page went elsewhere (a redirect, another step in it).
  pages.login.url = "https://github.com.evil.example/login";
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asked.id}`, { answer: "once" }, key)).status, 200);
  const outcome = await signIn.result;
  assert.match(outcome.content[0].text, /The page left github\.com meanwhile\. Nothing was filled/);
  assert.deepEqual(pages.login.filled, [], "nothing typed into the page");
});

// A process of yours that isn't Kuvo Code's own, like an agent's command in the sandbox, can reach
// the vault's socket (Linux's sandbox doesn't hide a socket from connecting) but not the box's
// socket key in `run`: while a sign-in is calling, it tries to take the fill for itself.
test("a process without the box's socket key gets nothing from the vault's socket, even while a sign-in calls", async () => {
  pages.login.url = "https://github.com/login";
  pages.login.filled = [];
  const signIn = started(call("ses_ship", "browser_sign_in", { username: 1, password: 2, item: "GitHub" }));
  const asked = await askedNow();
  const said = await new Promise(resolve => {
    const socket = net.createConnection(path.join(home, "run", "vault.sock"));
    let heard = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ hello: "mine" }) + "\n" + JSON.stringify({ method: "POST", path: "kuvo/vault/fill", headers: {}, body: Buffer.from(JSON.stringify({ session: "ses_ship", item: "GitHub" })).toString("base64") }) + "\n"));
    socket.on("data", chunk => (heard += chunk));
    socket.on("error", () => {});
    socket.on("close", () => resolve(heard));
  });
  assert.equal(said, "", "nothing answers it: not even the holder's hello");
  // The sign-in it raced goes on as before, once you allow it.
  assert.equal((await fromMac("POST", `kuvo/vault/asks/${asked.id}`, { answer: "once" }, key)).status, 200);
  const signedIn = await signIn.result;
  assert.equal(signedIn.isError, false, signedIn.content[0].text);
  assert.deepEqual(pages.login.filled, [{ index: 1, value: "ship-bot" }, { index: 2, value: SECRET }]);
});
