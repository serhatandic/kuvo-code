// The browser's keeper on a machine (KuvoCode/Resources/kuvo-browser.js) stops Chrome after a while
// with nobody using it, and opens the pages that were open again as it next starts: each is still
// the conversation's that worked in it last, so its agent goes on there rather than in a new tab.
// Chrome is a stand-in.

import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { browserHost } from "./browser-host-stand-in.js";

// What Chrome makes each page as, by its address.
const made = { "https://example.com/report": "P-report", "https://example.com/yours": "P-yours", "https://example.com/older": "P-older" };
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
  },
});

test("a page opened again after the browser stopped is still its conversation's", async () => {
  const tools = await client();
  await tools.heard.until((message) => message.method === "Kuvo.hello");
  await chrome.until((message) => message.method === "Target.createTarget" && message.params.url === "https://example.com/older");
  // As Chrome says each page it made.
  for (const [url, targetId] of Object.entries(made)) event("Target.targetCreated", { targetInfo: { targetId, type: "page", url } });
  // (A round trip after the pages were made: the keeper has taken their answers by then.)
  tools.send({ id: 1, method: "Kuvo.getActive" });
  await tools.heard.until((message) => message.id === 1);
  tools.send({ id: 2, method: "Kuvo.mine", params: { session: "ses_report" } });
  const mine = await tools.heard.until((message) => message.id === 2);
  assert.equal(mine.result.targetId, "P-report");
  tools.send({ id: 3, method: "Kuvo.mine", params: { session: "ses_other" } });
  const none = await tools.heard.until((message) => message.id === 3);
  assert.equal(none.result.targetId, undefined);
});
