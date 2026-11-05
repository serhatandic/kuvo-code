// What an agent on a machine hears of a download: the browser's tools (KuvoCode/Resources/
// kuvo-browser.js `mcp`, as the engine starts them) tell it to the conversation it's for, with
// one of its calls that says how the page is, and to no other conversation. The real keeper and
// tools; Chrome is a stand-in, with one page.

import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { atEnd } from "./at-end.js";
import { browserHost } from "./browser-host-stand-in.js";

const { home, event, client, answer } = await browserHost();

// The page: a shop, read as the snapshot reads a page.
const shop = { targetId: "P1", type: "page", url: "https://shop.example/orders", title: "Orders", attached: false };
answer("Target.getTargets", () => ({ targetInfos: [shop] }));
answer("Target.getTargetInfo", () => ({ targetInfo: shop }));
answer("Target.attachToTarget", () => ({ sessionId: "S1" }));
answer("Page.getFrameTree", () => ({ frameTree: { frame: { id: "P1", url: shop.url, securityOrigin: "https://shop.example" } } }));
answer("Page.createIsolatedWorld", () => ({ executionContextId: 7 }));
answer("Runtime.evaluate", ({ expression }) => ({ result: { value: expression === "window.devicePixelRatio" ? 1 : { text: "Your orders", title: shop.title, url: shop.url } } }));
answer("Page.getLayoutMetrics", () => ({ cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } }));
answer("Page.captureScreenshot", () => ({ data: "iVBORw0KGgo=" }));

// The tools, as the engine starts them on the machine.
const env = { ...process.env, KUVO_HOME: home };
delete env.KUVO_SESSION;
const tools = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../../../KuvoCode/Resources/kuvo-browser.js"), "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
atEnd(() => tools.kill());
const replies = new Map();
let buffer = "";
tools.stdout.setEncoding("utf8");
tools.stdout.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    replies.get(message.id)?.(message.result);
  }
});
let next = 1;
/** A conversation's call of a browser tool, as the engine makes it. */
function call(session, name, args = {}) {
  const id = next++;
  return new Promise((resolve) => {
    replies.set(id, resolve);
    tools.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: { "ai.opencode/sessionID": session } } }) + "\n");
  });
}
const words = (result) => result.content.filter((each) => each.type === "text").map((each) => each.text).join("\n");

test("a download's news goes to its own conversation, with its next call that says how the page is, and to no other", async () => {
  const mac = await client();
  await mac.heard.until((message) => message.method === "Kuvo.hello");
  // Both conversations have used the browser (its tools are connected to the keeper).
  assert.match(words(await call("ses_shop", "browser_snapshot")), /Your orders/);

  // The shop conversation's agent was at work in a page that downloads an invoice.
  const other = await client();
  await other.heard.until((message) => message.method === "Kuvo.hello");
  other.send({ method: "Kuvo.setStatus", params: { working: true, tool: "browser_click", targetId: "P9", session: "ses_shop" } });
  await mac.heard.until((message) => message.method === "Kuvo.status" && message.params.workers?.some((each) => each.targetId === "P9"));
  event("Browser.downloadWillBegin", { guid: "g-invoice", frameId: "P9", url: "https://shop.example/invoice.pdf", suggestedFilename: "invoice.pdf" });
  await mac.heard.until((message) => message.method === "Kuvo.downloading" && message.params.name === "invoice.pdf");

  // Another conversation's call hears nothing of it.
  const elsewhere = await call("ses_notes", "browser_snapshot");
  assert.match(words(elsewhere), /Your orders/);
  assert.doesNotMatch(words(elsewhere), /invoice/);
  // The shop's screenshot says nothing of the page: the news waits for a call that does.
  const shot = await call("ses_shop", "browser_screenshot");
  assert.equal(shot.content[0].type, "image");
  assert.doesNotMatch(words(shot), /invoice/);
  assert.match(words(await call("ses_shop", "browser_snapshot")), /The page started downloading invoice\.pdf\.[\s\S]*Your orders/);
  // Said once.
  assert.doesNotMatch(words(await call("ses_shop", "browser_snapshot")), /invoice/);
});
