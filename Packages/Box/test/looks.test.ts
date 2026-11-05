// The looks a bot can have, as the route shapes hold answers to them, are the ones the apps draw:
// bot-words.json's, which every box reads.
import "./safety"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LOOKS } from "../src/shared/routes/bots";

test("a bot's look in an answer is one the apps draw", () => {
  const words = JSON.parse(readFileSync(new URL("../../KuvoLink/Sources/KuvoLink/Resources/bot-words.json", import.meta.url), "utf8"));
  expect({ colors: [...LOOKS.colors], shapes: [...LOOKS.shapes], faces: [...LOOKS.faces] }).toEqual({ colors: words.looks.colors, shapes: words.looks.shapes, faces: words.looks.faces });
});
