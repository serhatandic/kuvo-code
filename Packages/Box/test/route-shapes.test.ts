// What each route answers (Packages/KuvoLink/Vectors/routes/shapes/answers.json) is what
// src/shared/routes writes, as scripts/route-shapes.sh --check says: a shape changed without the
// file written again fails here, wherever the box's suite runs, not only in CI's.
import "./safety"
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("answers.json is what the route shapes write (scripts/route-shapes.sh --check)", () => {
  const script = fileURLToPath(new URL("../../../scripts/route-shapes.sh", import.meta.url));
  const ran = spawnSync("sh", [script, "--check"], { env: { ...process.env, BUN: process.execPath }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(ran.stderr.trim()).toBe("");
  expect(ran.status).toBe(0);
});
