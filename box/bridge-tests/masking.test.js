// What a box's notice for your phones shows of an agent's words: secrets as dots, everything else
// as written, by the same rules as KuvoLink's SecretMask (protocol/vectors/masking.json, which its tests
// write from those rules).
//
// Run with `node --test box/bridge-tests/masking.test.js`.
import "./test-safety.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { masked, showsAll } from "../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js";
import "./at-end.js";

const { cases } = JSON.parse(fs.readFileSync(new URL("../../protocol/vectors/masking.json", import.meta.url), "utf8"));

test("a notice shows of each line what KuvoLink's SecretMask shows, and says when that isn't all", () => {
  assert.ok(cases.length > 30);
  for (const { text, masked: expected, showsAll: whole } of cases) {
    assert.equal(masked(text), expected, text.slice(0, 80));
    assert.equal(showsAll(text), whole, text.slice(0, 80));
  }
});

test("a long reply is masked quickly, whatever it holds", () => {
  const started = performance.now();
  masked("-".repeat(4000) + " --token abc123def456");
  masked("a".repeat(20) + "-".repeat(8000));
  assert.ok(performance.now() - started < 1000);
});
