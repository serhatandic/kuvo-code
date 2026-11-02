// What the vault's tests wait on, as it happens: a file the box makes, what the vault asks you.
// Never a count of tries or a pause: a busy machine is slow, never wrong, and a wait whose thing
// never comes fails at the test's own time limit.

import fs from "node:fs";
import path from "node:path";
import { atEnd } from "./at-end.js";

/** What `found()` gives, once it gives something: looked at again as anything changes in `folder`
 * (or, while there's no such folder yet, under the nearest one there is). */
export function appears(folder, found) {
  return new Promise((resolve, reject) => {
    let top = folder;
    while (!fs.existsSync(top)) top = path.dirname(top);
    let done = false;
    const watcher = fs.watch(top, { recursive: top !== folder }, () => look());
    // (Closed once the file's tests are done, if a test failed before this was seen: never what
    // keeps its process going.)
    atEnd(() => finish(() => resolve(undefined)));
    watcher.on("error", error => finish(() => reject(error)));
    function finish(then) {
      if (done) return;
      done = true;
      watcher.close();
      then();
    }
    function look() {
      if (done) return;
      let value;
      try { value = found(); } catch (error) { return finish(() => reject(error)); }
      if (value) finish(() => resolve(value));
    }
    // (Once it watches, so nothing made in between is missed.)
    look();
  });
}

/** What the vault asks you that isn't in `seen` (ids), once it does: from its asks' stream at
 * `url` (`…/kuvo/vault/asks/events` on the box's own process), as this Mac's app follows them. */
export async function asked(url, password, seen = new Set()) {
  const stop = new AbortController();
  const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-kuvo-from": "app" }, signal: stop.signal });
  let buffer = "";
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const { asks } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (asks?.some(each => !seen.has(each.id))) {
        stop.abort();
        return asks.filter(each => !seen.has(each.id));
      }
    }
  }
  throw new Error("The box stopped telling its asks.");
}
