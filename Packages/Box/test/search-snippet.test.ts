import "./safety"
import { expect, test } from "bun:test";
import { searchText, snippet } from "../src/link/areas/search";
import type { EngineMessage } from "../src/link/engine/conversations";

// Search in conversations: what each result shows under its title, in both apps.

test("a snippet starts and ends on whole words", () => {
  const text = "Step 4 of 5. Change src/timer.js so the countdown pauses when the window loses focus, then run the tests again and tell me what failed.";
  const at = text.indexOf("timer");
  const shown = snippet(text, at, "timer".length);
  expect(shown.startsWith("…")).toBe(true);
  expect(shown.endsWith("…")).toBe(true);
  const words = shown.replace(/…/g, "").split(" ");
  for (const word of words) expect(text.split(/\s+/)).toContain(word);
  expect(shown).toContain("src/timer.js");
});

test("words said in the conversation are found there before a step's command or pattern", () => {
  const messages = [
    { type: "assistant", content: [{ type: "tool", state: { input: { pattern: "=|tick\\(\\)", path: "/p/src/timer.js" } } }] },
    { type: "assistant", content: [{ type: "text", text: "The tick() call in the timer was running twice." }] },
  ] as unknown as EngineMessage[];
  const text = searchText(messages, "/p");
  const at = text.toLowerCase().indexOf("tick");
  expect(snippet(text, at, 4)).not.toContain("=|");
  expect(snippet(text, at, 4)).toContain("The tick() call");
});

test("a match near a message's start shows the message from its first word", () => {
  const text = "Earlier reply.\n\nPlease refactor the timer so it pauses";
  const shown = snippet(text, text.indexOf("timer"), "timer".length);
  expect(shown.startsWith("Please refactor the timer")).toBe(true);
});

test("in a long conversation, what was said is kept for search before the steps", () => {
  const messages = [
    { type: "assistant", content: [{ type: "text", text: "The flaky login test was the clock." }] },
    ...Array.from({ length: 50 }, (_, index) => ({ type: "assistant", content: [{ type: "tool", state: { input: { command: `run ${index} ` + "x".repeat(10_000) } } }] })),
  ] as unknown as EngineMessage[];
  const text = searchText(messages, "/p");
  expect(text.length).toBeLessThanOrEqual(400_000);
  expect(text).toContain("The flaky login test was the clock.");
});
