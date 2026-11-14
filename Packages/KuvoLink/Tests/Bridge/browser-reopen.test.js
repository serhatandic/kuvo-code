// The browser's keeper on a machine (KuvoCode/Resources/kuvo-browser.js) stops Chrome after a while
// with nobody using it, and as it next starts: opens the pages that were open again, each still the
// conversation's that worked in it last, so its agent goes on there rather than in a new tab; and
// clears what the box left for it of a site whose data was removed while Chrome was stopped. Chrome
// is a stand-in.

import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { browserHost } from "./browser-host-stand-in.js";

// What Chrome makes each page as, by its address.
const made = { "https://example.com/report": "P-report", "https://example.com/yours": "P-yours", "https://example.com/older": "P-older" };
let browserFolder = "";
const { chrome, event, client } = await browserHost({
  before(home, answer) {
    answer("Target.createTarget", (params) => ({ targetId: made[params.url] }));
    // What the keeper before left as it stopped: one page an agent worked in, and one of yours (and
    // one from a keeper before this one, which kept addresses alone).
    fs.mkdirSync(path.join(home, "run"), { recursive: true });
    fs.writeFileSync(path.join(home, "run", "pages.json"), JSON.stringify([
      { url: "https://example.com/report", session: "ses_report" },
      { url: "https://example.com/yours", session: null },
      "https://example.com/older",
    ]));
    // A site's data the box removed with Chrome stopped: what its pages stored, left to clear. And
    // the box's lock on the profile, left by a box cut off a minute ago.
    browserFolder = path.join(home, "browser");
    fs.writeFileSync(path.join(browserFolder, "clear-sites.json"), JSON.stringify(["x.com"]));
    fs.mkdirSync(path.join(browserFolder, ".profile-editing"));
    const minuteAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(browserFolder, ".profile-editing"), minuteAgo, minuteAgo);
  },
});

/** Until the keeper has taken in all Chrome said before and done what follows from it: a worker
 * announced now, which the keeper answers on its pipe (read in order) once it gets there, twice, so
 * the second is in a later turn than what the first came with. */
let syncs = 0;
async function settled() {
  for (let turn = 0; turn < 2; turn++) {
    const sessionId = `SYNC${++syncs}`;
    event("Target.attachedToTarget", { sessionId, targetInfo: { targetId: `W${syncs}`, type: "service_worker", url: "" }, waitingForDebugger: false });
    await chrome.until((message) => message.method === "Network.setUserAgentOverride" && message.sessionId === sessionId);
  }
}

test("a page opened again after the browser stopped is still its conversation's", async () => {
  const tools = await client();
  await tools.heard.until((message) => message.method === "Kuvo.hello");
  await chrome.until((message) => message.method === "Target.createTarget" && message.params.url === "https://example.com/older");
  // As Chrome says each page it made.
  for (const [url, targetId] of Object.entries(made)) event("Target.targetCreated", { targetInfo: { targetId, type: "page", url } });
  await settled();
  tools.send({ id: 2, method: "Kuvo.mine", params: { session: "ses_report" } });
  const mine = await tools.heard.until((message) => message.id === 2);
  assert.equal(mine.result.targetId, "P-report");
  tools.send({ id: 3, method: "Kuvo.mine", params: { session: "ses_other" } });
  const none = await tools.heard.until((message) => message.id === 3);
  assert.equal(none.result.targetId, undefined);
});

test("what's left of a site's removed data is cleared in the first page Chrome has, and then forgotten", async () => {
  // Chrome started, so the box's lock left a minute ago didn't hold it back.
  assert.equal(fs.existsSync(path.join(browserFolder, ".profile-editing")), false);
  const tools = await client();
  await tools.heard.until((message) => message.method === "Kuvo.hello");
  event("Target.attachedToTarget", { sessionId: "K1", targetInfo: { targetId: "P1", type: "page", url: "about:blank" }, waitingForDebugger: false });
  const cleared = await chrome.until((message) => message.method === "Storage.clearDataForOrigin" && message.params.origin === "http://x.com");
  assert.equal(cleared.sessionId, "K1");
  assert.ok(chrome.all.some((message) => message.method === "Storage.clearDataForOrigin" && message.params.origin === "https://x.com" && message.sessionId === "K1"));
  await settled();
  assert.equal(fs.existsSync(path.join(browserFolder, "clear-sites.json")), false);
});
