// A download in the browser on a machine: its keeper (KuvoCode/Resources/kuvo-browser.js) says
// whose it is, the conversation at work in the page it started in, so only that conversation's
// agent hears of it. One from a page no agent is in (yours) is nobody's. Chrome is a stand-in.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { browserHost } from "./browser-host-stand-in.js";

const { home, event, client } = await browserHost();

test("a download is told as the conversation's whose agent was at work in its page, and one in your page as nobody's", async () => {
  const mac = await client();
  await mac.heard.until((message) => message.method === "Kuvo.hello");
  // An agent's tools at work in page P1, for one conversation.
  const tools = await client();
  await tools.heard.until((message) => message.method === "Kuvo.hello");
  tools.send({ method: "Kuvo.setStatus", params: { working: true, tool: "browser_click", targetId: "P1", session: "ses_report" } });
  await mac.heard.until((message) => message.method === "Kuvo.status" && message.params.workers?.some((each) => each.session === "ses_report"));

  // P1 downloads a report, and it finishes.
  event("Browser.downloadWillBegin", { guid: "g-report", frameId: "P1", url: "https://example.com/report.pdf", suggestedFilename: "report.pdf" });
  const started = await tools.heard.until((message) => message.method === "Kuvo.downloading");
  assert.deepEqual(started.params, { name: "report.pdf", session: "ses_report" });
  fs.mkdirSync(path.join(home, "browser", "downloads"), { recursive: true });
  fs.writeFileSync(path.join(home, "browser", "downloads", "g-report"), "%PDF");
  event("Browser.downloadProgress", { guid: "g-report", state: "completed", totalBytes: 4, receivedBytes: 4 });
  const done = await tools.heard.until((message) => message.method === "Kuvo.downloaded");
  assert.equal(done.params.name, "report.pdf");
  assert.equal(done.params.session, "ses_report");

  // Your own page (no agent at work in it) downloads something, which fails: nobody's.
  event("Browser.downloadWillBegin", { guid: "g-yours", frameId: "P2", url: "https://example.com/photo.jpg", suggestedFilename: "photo.jpg" });
  const yours = await tools.heard.until((message) => message.method === "Kuvo.downloading" && message.params.name === "photo.jpg");
  assert.equal(yours.params.session, undefined);
  event("Browser.downloadProgress", { guid: "g-yours", state: "canceled" });
  const failed = await tools.heard.until((message) => message.method === "Kuvo.downloadFailed");
  assert.deepEqual(failed.params, { name: "photo.jpg" });
});
