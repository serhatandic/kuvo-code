import "./safety"
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAt } from "../src/link/areas/file";
import type { AnswerPiece } from "../src/link/server/context";

// A file on this box named as a client names it for `kuvo/file` (KuvoClient's FileAddresses): each
// name in the shared vectors, written into a folder of the test's own, is read back by its route,
// "ş" and all.

type Vectors = { addresses: { name: string; encoded: string }[] };
const vectors: Vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../protocol/vectors/file-addresses/addresses.json"), "utf8"));

let root = "";
beforeEach(() => {
  // Its real path, with no link in it, and nothing in it a route would encode.
  root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-box-file-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const json = (status: number, value: unknown): AnswerPiece[] => [
  { head: { status, headers: { "content-type": "application/json" } } },
  { body: Buffer.from(JSON.stringify(value)) },
];

async function read(route: string): Promise<{ status: number; body: string }> {
  let status = 0;
  const parts: Buffer[] = [];
  for await (const piece of fileAt(route, json)) {
    if ("head" in piece) status = piece.head.status;
    else parts.push(piece.body);
  }
  return { status, body: Buffer.concat(parts).toString("utf8") };
}

test("each name comes back as the file it names", async () => {
  expect(vectors.addresses.length).toBeGreaterThan(0);
  expect(root).toMatch(/^[A-Za-z0-9/._-]+$/);
  for (const { name, encoded } of vectors.addresses) {
    writeFileSync(join(root, name), `the file ${name}`);
    const answer = await read(`kuvo/file?uri=file://${root}/${encoded}`);
    expect({ name, ...answer }).toEqual({ name, status: 200, body: `the file ${name}` });
  }
});
