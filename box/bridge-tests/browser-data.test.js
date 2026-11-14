// The browser's data on a machine (PROTOCOL.md, "The browser's data"): the real keeper
// (box/dist/kuvo-browser.js) with Chrome as a stand-in, and the box's own routes asked as
// a Mac asks them over SSH (`kuvo-link.js box route`). A page that loads is kept in the history,
// with its site's icon as Chrome fetched it; removing a site's data while Chrome runs signs the
// browser out of it, through Chrome, as `kuvo/integrations` then says.

import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserHost } from "./browser-host-stand-in.js";

const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const { home, chrome, event, client, answer } = await browserHost();

/** A route of the machine's box, as a Mac asks it: its status, type and body. */
async function route(method, routePath) {
  const child = spawn(process.execPath, [script, "box", "route"], { env: { ...process.env, KUVO_HOME: home, HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(JSON.stringify({ method, path: routePath }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  return JSON.parse(out.trim().split("\n").at(-1));
}

// A tiny PNG, as a site's icon.
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

test("a page that loads is kept in the machine's history, with its site's icon as Chrome fetched it; taken out, it's gone", async () => {
  const mac = await client();
  await mac.heard.until((message) => message.method === "Kuvo.hello");
  // Chrome's answers for the icon: the page names one, and Chrome loads it as the page's own.
  answer("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
  answer("Runtime.evaluate", () => ({ result: { type: "object", value: [{ rel: "icon", href: "https://www.example.com/static/icon.png", sizes: "", type: "image/png" }] } }));
  answer("Network.loadNetworkResource", () => ({ resource: { success: true, httpStatusCode: 200, stream: "icon-stream" } }));
  answer("IO.read", () => ({ base64Encoded: true, data: PNG.toString("base64"), eof: true }));

  // A page of the browser, which the keeper holds a session with, loads example.com.
  event("Target.attachedToTarget", { sessionId: "K1", targetInfo: { targetId: "P1", type: "page", url: "" }, waitingForDebugger: false });
  event("Target.targetCreated", { targetInfo: { targetId: "P1", type: "page", url: "about:blank", title: "" } });
  event("Target.targetInfoChanged", { targetInfo: { targetId: "P1", type: "page", url: "https://www.example.com/", title: "Example Domain" } });
  event("Page.loadEventFired", { timestamp: 1 }, "K1");
  const loading = await chrome.until((message) => message.method === "Network.loadNetworkResource");
  assert.deepEqual([loading.sessionId, loading.params.frameId, loading.params.url], ["K1", "P1", "https://www.example.com/static/icon.png"]);
  await chrome.until((message) => message.method === "IO.close");
  // (A round trip after it: the keeper has noted the icon by then.)
  mac.send({ id: 1, method: "Kuvo.getActive" });
  await mac.heard.until((message) => message.id === 1);

  const history = await route("GET", "kuvo/browser/history");
  assert.equal(history.status, 200);
  const sites = JSON.parse(history.body).sites;
  assert.equal(sites.length, 1);
  assert.equal(sites[0].host, "example.com");
  assert.equal(sites[0].title, "Example Domain");
  assert.equal(sites[0].visits, 1);
  assert.equal(sites[0].icon, true);
  const icon = await route("GET", "kuvo/browser/icons/example.com");
  assert.equal(icon.status, 200);
  assert.equal(icon.type, "image/png");

  const taken = await route("DELETE", "kuvo/browser/history/example.com");
  assert.deepEqual(JSON.parse(taken.body), { sites: [] });
  assert.equal((await route("GET", "kuvo/browser/icons/example.com")).status, 404);
});

test("removing a site's data while Chrome runs signs the machine's browser out of it, and leaves the other sites", async () => {
  // Chrome's cookies: signed in to X (a whole domain's cookie, and one host's), and a site's own.
  const later = Date.now() / 1000 + 30 * 86_400;
  let jar = [
    { name: "auth_token", value: "", domain: ".x.com", path: "/", expires: later, session: false },
    { name: "ct0", value: "", domain: "api.x.com", path: "/", expires: later, session: false },
    { name: "theme", value: "", domain: "www.example.org", path: "/", expires: later, session: false },
  ];
  answer("Storage.getCookies", () => ({ cookies: jar }));
  answer("Network.deleteCookies", (params) => {
    jar = jar.filter((cookie) => !(cookie.name === params.name && cookie.domain === params.domain && cookie.path === params.path));
    return {};
  });
  answer("Target.getTargets", () => ({ targetInfos: [{ targetId: "P1", type: "page", url: "https://www.example.com/" }] }));
  answer("Target.attachToTarget", () => ({ sessionId: "BOX1" }));
  // The integrations' catalog, as a Mac leaves it: X is used on its site, signed in with this cookie.
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "integrations.json"), JSON.stringify({ integrations: [
    { id: "x", title: "X", summary: "Posts, replies and messages", kind: "Social", symbol: "at", site: "https://x.com", how: "In the browser", way: "browser", signInCookie: { domain: "x.com", name: "auth_token" } },
  ] }));
  // (Its own settings, as a machine's once a Mac connected it.)
  fs.mkdirSync(path.join(home, "box"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "opencode.json"), "{}");
  const signedIn = async () => JSON.parse((await route("GET", "kuvo/integrations")).body).integrations.find((each) => each.id === "x").siteSignedIn;
  assert.equal(await signedIn(), true);
  assert.deepEqual(JSON.parse((await route("GET", "kuvo/browser/sites")).body).sites.map((each) => each.site), ["example.org", "x.com"]);

  // Never a part of a site's name: that would be every site under it.
  assert.equal((await route("DELETE", "kuvo/browser/sites/com")).status, 400);
  const removed = await route("DELETE", "kuvo/browser/sites/x.com");
  assert.equal(removed.status, 200);
  assert.deepEqual(JSON.parse(removed.body).sites.map((each) => each.site), ["example.org"]);
  // Through Chrome, in a page's session: each of the site's cookies exactly as Chrome said it, then
  // what each of its hosts stored.
  const deleted = chrome.all.filter((message) => message.method === "Network.deleteCookies");
  assert.deepEqual(deleted.map((message) => [message.sessionId, message.params.name, message.params.domain]), [["BOX1", "auth_token", ".x.com"], ["BOX1", "ct0", "api.x.com"]]);
  const cleared = chrome.all.filter((message) => message.method === "Storage.clearDataForOrigin").map((message) => message.params.origin);
  assert.ok(cleared.includes("https://x.com") && cleared.includes("https://api.x.com"));
  assert.ok(!cleared.some((origin) => origin.includes("example.org")));
  assert.equal(await signedIn(), false);
});
