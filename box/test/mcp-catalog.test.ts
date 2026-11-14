// Settings › MCP Servers' popular servers as a box offers them from the catalog its Mac left: only
// what it can say about each, as its route's shape says, whatever a newer Mac's catalog has.
import "./safety"
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCatalog } from "../src/link/areas/mcp-catalog";

const folder = mkdtempSync(join(tmpdir(), "kuvo-mcp-catalog-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

test("a server whose access this box doesn't know isn't offered; one that doesn't say is open", () => {
  const file = join(folder, "mcp-catalog.json");
  writeFileSync(file, JSON.stringify({ servers: [
    { id: "context7", title: "Context7", summary: "Docs", access: "open" },
    { id: "linear", title: "Linear", summary: "Issues", access: "signIn" },
    { id: "plain", title: "Plain", summary: "Says nothing of its access" },
    { id: "later", title: "Later", summary: "A newer Mac's", access: "pairing" },
  ] }));
  expect(mcpCatalog({}, file, false).servers.map(each => [each.id, each.access])).toEqual([["context7", "open"], ["linear", "signIn"], ["plain", "open"]]);
});
