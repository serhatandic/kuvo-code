// What scripts/build-browser.sh writes: box/dist/kuvo-browser.js, the browser's keeper and
// the agents' browser tools every box runs, from box/src/browser. Its source with the
// scripts it runs in pages (page.ts), the tools (tools.ts) and what agents are told of them
// (instructions.ts) filled in, with the search engines a box offers (shared/routes/browser.ts), as JSON with its keys in order, and its keeper's version (KEEPER):
// the first 12 hex digits of the SHA-256 of that source as it is. Its first line names the rest
// (`// kuvo-browser <16 hex digits of its SHA-256>`), which a box and a Mac tell copies apart by.
// Run as `bun scripts/build-browser.ts <checkout> [--check]`.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const check = process.argv[3] === "--check";
const folder = path.join(root, "box/src/browser");
const { pageScripts } = await import(path.join(folder, "page.ts"));
const { TOOLS } = await import(path.join(folder, "tools.ts"));
const { INSTRUCTIONS, VAULT_INSTRUCTIONS } = await import(path.join(folder, "instructions.ts"));
const { SEARCH_ENGINES } = await import(path.join(root, "box/src/shared/routes/browser.ts"));

const OUT = "box/dist/kuvo-browser.js";
const CONFIG = `/*KUVO_CONFIG*/ { scripts: {}, tools: [], instructions: "", vaultInstructions: "", searchEngines: [] }`;
const KEEPER = `const KEEPER = "0.0.0-keeper-from-its-sources";`;
const BANNER = "// Built from box/src/browser by scripts/build-browser.sh: change those, then run it. Never edit this file.\n";

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** `value` with every object's keys in order (by UTF-16 code unit), as models have been given them. */
function inOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inOrder);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, inOrder((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** `text` with `part` in it once, replaced by `by`. */
function fill(text: string, part: string, by: string): string {
  const pieces = text.split(part);
  if (pieces.length !== 2) {
    console.error(`scripts/build-browser.sh: box/src/browser/kuvo-browser.js should have \`${part}\` once, to fill in.`);
    process.exit(1);
  }
  return pieces.join(by);
}

const source = fs.readFileSync(path.join(folder, "kuvo-browser.js"), "utf8");
const config = JSON.stringify(inOrder({ scripts: pageScripts(), tools: TOOLS, instructions: INSTRUCTIONS, vaultInstructions: VAULT_INSTRUCTIONS, searchEngines: SEARCH_ENGINES }));
const body = BANNER + fill(fill(source, KEEPER, `const KEEPER = "${sha256(source).slice(0, 12)}";`), CONFIG, config);
const built = `// kuvo-browser ${sha256(body).slice(0, 16)}\n` + body;

const where = path.join(root, OUT);
if (check) {
  let kept: string | null = null;
  try { kept = fs.readFileSync(where, "utf8"); } catch {}
  if (kept === built) process.exit(0);
  console.error(`${OUT} isn't what box/src/browser builds: change the sources, not it, then run ./scripts/build-browser.sh and commit it.`);
  process.exit(1);
}
fs.writeFileSync(where, built);
console.log(`Built ${OUT}`);
