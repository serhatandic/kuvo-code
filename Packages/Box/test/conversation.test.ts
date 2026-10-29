import { expect, test } from "bun:test";
import { excerpt } from "../src/link/letters/conversation";

// What read_conversation gives of a long conversation, on every box: with a query, each place that
// mentions it with what's around it, the latest kept when there's no room for all; without, how it
// began and its latest part.

test("reading with a query gives each place with what's around it, the latest first as room runs out", () => {
  const conversation = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}` + ((index + 1) % 10 === 0 ? " mentions deploy" : "")).join("\n\n");
  const found = excerpt(conversation, "DEPLOY", 120);
  expect(found.startsWith('3 places mention "DEPLOY"')).toBe(true);
  expect(found).toContain("Paragraph 30 mentions deploy");
  expect(found).toContain("Paragraph 29");
  expect(found).not.toContain("Paragraph 10 mentions");
  expect(excerpt("Café au lait\n\nTea", "cafe", 500)).toContain("Café au lait");
  expect(excerpt(conversation, "nowhere", 500).startsWith("Nothing in it mentions")).toBe(true);
});

test("a long conversation read whole keeps how it began and its latest part", () => {
  const conversation = Array.from({ length: 200 }, (_, index) => `Paragraph ${index + 1} with some words in it`).join("\n\n");
  const read = excerpt(conversation, null, 2000);
  expect(read.length).toBeLessThanOrEqual(2200);
  expect(read.startsWith("Paragraph 1 ")).toBe(true);
  expect(read).toContain("[… the middle is left out; read it with query, to find a part …]");
  expect(read).toContain("Paragraph 200 ");
});
