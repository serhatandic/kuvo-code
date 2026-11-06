// The browser on a machine, when a page asks for a passkey (which it can't use yet): its keeper
// (KuvoCode/Resources/kuvo-browser.js) hears it from a world of its own, names the page's site,
// tells the Mac and the agent's tools once, marks the asks for that site, and says so again to a
// client that connects later, until the page leaves the site. Chrome here is a stand-in that
// speaks its DevTools protocol over the keeper's pipe, as Chrome does.

import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { browserHost } from "./browser-host-stand-in.js";

const { home, chrome, event, client } = await browserHost();

test("a page asking for a passkey is told once, by its site, to every client and to one that connects later, until it leaves the site", async () => {
  const mac = await client();
  await mac.heard.until((message) => message.method === "Kuvo.hello");

  // A page on github.com, as Chrome attaches the keeper to it.
  event("Target.targetCreated", { targetInfo: { targetId: "P1", type: "page", url: "https://github.com/login" } });
  event("Target.attachedToTarget", { sessionId: "S1", targetInfo: { targetId: "P1", type: "page", url: "https://github.com/login" }, waitingForDebugger: false });
  // Its listener and binding in a world of the keeper's, and the page's script with this keeper's
  // event in it: nothing of them in the page's own world.
  const binding = await chrome.until((message) => message.method === "Runtime.addBinding" && message.sessionId === "S1");
  assert.equal(binding.params.executionContextName, "kuvo-passkeys");
  const script = (inWorld) => chrome.until((message) => message.method === "Page.addScriptToEvaluateOnNewDocument" && message.sessionId === "S1" && Boolean(message.params.worldName) === inWorld);
  const listener = await script(true);
  const pageScript = await script(false);
  assert.equal(listener.params.worldName, "kuvo-passkeys");
  const name = listener.params.source.match(/addEventListener\("([^"]+)"/)[1];
  assert.match(name, /^kuvo-[0-9a-f-]{36}$/);
  assert.ok(pageScript.params.source.includes(`"${name}"`) && !pageScript.params.source.includes("KUVO_PASSKEY_EVENT"));
  assert.ok(!pageScript.params.source.includes("kuvoPasskeyAsked"), "the binding's name isn't in the page's world");

  // Chrome gives a new document the binding only with its Runtime domain on: it's added again
  // as the page navigates.
  const before = chrome.all.filter((message) => message.method === "Runtime.addBinding" && message.sessionId === "S1").length;
  event("Page.frameNavigated", { frame: { id: "P1", url: "https://github.com/login" } }, "S1");
  await chrome.until((message) => message.method === "Runtime.addBinding" && message.sessionId === "S1" && chrome.all.filter((each) => each.method === "Runtime.addBinding" && each.sessionId === "S1").length > before);

  // A frame of another site in it (a sign-in button) asks: told for the page's site.
  event("Target.attachedToTarget", { sessionId: "F1", targetInfo: { targetId: "T-frame", type: "iframe", url: "https://accounts.example.com/button" }, waitingForDebugger: false }, "S1");
  await chrome.until((message) => message.method === "Runtime.addBinding" && message.sessionId === "F1");
  event("Runtime.bindingCalled", { name: "kuvoPasskeyAsked", payload: "", executionContextId: 7 }, "F1");
  const asked = await mac.heard.until((message) => message.method === "Kuvo.passkeyAsked");
  assert.deepEqual(asked.params, { host: "github.com", targetId: "P1" });

  // Asked again (a page asking in a loop): nothing more is said.
  event("Runtime.bindingCalled", { name: "kuvoPasskeyAsked", payload: "", executionContextId: 7 }, "S1");
  // An ask made now for that site says so; one for another site doesn't.
  mac.send({ method: "Kuvo.ask", params: { id: "ask-1", kind: "action", host: "github.com", instruction: "Sign in" } });
  mac.send({ method: "Kuvo.ask", params: { id: "ask-2", kind: "action", host: "gitlab.com", instruction: "Sign in" } });
  const second = await mac.heard.until((message) => message.method === "Kuvo.asked" && message.params.id === "ask-2");
  assert.equal(second.params.passkey, undefined);
  assert.equal(mac.heard.all.find((message) => message.method === "Kuvo.asked" && message.params.id === "ask-1").params.passkey, true);
  assert.equal(mac.heard.all.filter((message) => message.method === "Kuvo.passkeyAsked").length, 1);
  // The asks the phone link reads say so too.
  const kept = JSON.parse(fs.readFileSync(path.join(home, "run", "browser-asks.json"), "utf8")).asks;
  assert.deepEqual(kept.map((ask) => [ask.id, ask.passkey === true]), [["ask-1", true], ["ask-2", false]]);

  // The agent's tools, connecting later, hear it in their hello.
  const tools = await client();
  const hello = await tools.heard.until((message) => message.method === "Kuvo.hello");
  assert.deepEqual(hello.params.passkeys, { P1: "github.com" });

  // The page goes to another site: nobody says it any more.
  event("Target.targetInfoChanged", { targetInfo: { targetId: "P1", type: "page", url: "https://example.org/" } });
  const cleared = await mac.heard.until((message) => message.method === "Kuvo.passkeyCleared");
  assert.deepEqual(cleared.params, { targetId: "P1" });
  const later = await client();
  assert.deepEqual((await later.heard.until((message) => message.method === "Kuvo.hello")).params.passkeys, {});
});
