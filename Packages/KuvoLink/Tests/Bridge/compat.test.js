// What's there only for released Macs (PROTOCOL.md, "For released Macs") is marked where it is,
// on every side: the box's link and its agents bridge, the Mac app, OpenCodeKit and KuvoClient. Each item the
// list names has its markers, and each marker names an item on the list, so a version's paths go
// together when it goes (scripts/compat.sh lists them).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/compat.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./at-end.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const protocol = fs.readFileSync(path.join(repo, "Packages/KuvoLink/PROTOCOL.md"), "utf8");
const from = protocol.indexOf("\n## For released Macs");
const to = protocol.indexOf("\n## ", from + 1);
const section = protocol.slice(from, to === -1 ? undefined : to);
const listed = [...section.matchAll(/<!-- compat: (0\.7|beta\.1) ([a-z0-9-]+) -->/g)].map(match => `${match[1]} ${match[2]}`);

// The code of every side, as written: not what's built from it (a bundle leaves comments out),
// nor the tests.
const ROOTS = ["Packages/Box/src", "KuvoCode", "Packages/OpenCodeKit/Sources", "Packages/KuvoClient/Sources", "Packages/KuvoLink/Sources", "scripts"];
const BUILT = new Set(["KuvoCode/Resources/kuvo-agents.js", "scripts/compat.sh"]);
const CODE = /\.(swift|ts|js|mjs|sh|py)$/;
function* files(folder) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(repo, folder), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) yield* files(file);
    else if (entry.isFile() && CODE.test(entry.name) && !BUILT.has(file)) yield file;
  }
}
const markers = [];
for (const root of ROOTS) {
  for (const file of files(root)) {
    fs.readFileSync(path.join(repo, file), "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/COMPAT\(([^)]*)\)(.*)/g)) markers.push({ where: `${file}:${index + 1}`, tag: match[1], rest: match[2] });
    });
  }
}

test("PROTOCOL.md names the items that are there only for released Macs", () => {
  assert.ok(listed.length >= 10, `only ${listed.length} items in "For released Macs"`);
  assert.equal(new Set(listed).size, listed.length, "an item is named twice");
});

test("every item for released Macs is marked in the code", () => {
  const marked = new Set(markers.map(marker => marker.tag));
  assert.deepEqual(listed.filter(item => !marked.has(item)), []);
});

// When each version's paths go: beta.1's when 0.8.0 ships (a Mac's own data from it, which it
// takes in as it starts, three months after), 0.7's three months after.
const GOES = {
  "0.7": ["Goes 3 months after 0.8.0.", "Goes once a release with one is the newest.", "Goes once a box tells its news without its bridge."],
  "beta.1": ["Goes when 0.8.0 ships.", "Goes 3 months after 0.8.0."],
};

test("every marker names an item on the list, and says what it does and when it goes", () => {
  const known = new Set(listed);
  assert.deepEqual(markers.filter(marker => !known.has(marker.tag)).map(marker => `${marker.where} COMPAT(${marker.tag})`), []);
  assert.deepEqual(markers.filter(marker => !/^: \S.* Goes /.test(marker.rest)).map(marker => marker.where), []);
  const goes = marker => GOES[marker.tag.split(" ")[0]]?.some(words => marker.rest.trimEnd().endsWith(words));
  assert.deepEqual(markers.filter(marker => !goes(marker)).map(marker => `${marker.where} COMPAT(${marker.tag})${marker.rest}`), []);
});
