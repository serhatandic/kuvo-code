// Settings › Git on each box: the words a model is asked to write a commit message and a pull
// request from come from the box, with your instructions on that computer, for a Mac and a phone
// alike; and a Mac's Settings › Git from before moves to a box once, with nothing lost.
import "./test-safety.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeAtEnd } from "./at-end.js";

const script = fileURLToPath(new URL("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js", import.meta.url));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-git-words-")));
removeAtEnd(root);

let home, repo;
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv });
const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);

// A machine's box whose settings are its own, and a project with a commit on a branch of its own.
beforeEach(() => {
  home = fs.mkdtempSync(path.join(root, "box-"));
  fs.mkdirSync(path.join(home, "box"), { recursive: true });
  fs.writeFileSync(path.join(home, "box", "opencode.json"), "{}\n");
  repo = fs.mkdtempSync(path.join(root, "project-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Ada");
  git("config", "user.email", "ada@example.com");
  write("README.md", "Hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "First");
});

async function route(method, routePath, body) {
  const child = spawn(process.execPath, [script, "box", "route"], { env: { ...gitEnv, KUVO_HOME: home }, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(JSON.stringify({ method, path: routePath, ...(body ? { body } : {}) }));
  let out = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) out += chunk;
  const answer = JSON.parse(out.trim().split("\n").at(-1));
  return { ...answer, json: answer.body ? JSON.parse(answer.body) : undefined };
}
const set = (key, value) => route("PATCH", "kuvo/config", { changes: [{ path: [key], value }] });
const settings = async () => (await route("GET", "kuvo/config")).json;

test("a commit message is asked for in the box's words, with your instructions on that computer", async () => {
  write("README.md", "Hello\nWorld\n");
  const plain = await route("POST", "kuvo/git/commit-diff", { directory: repo, prompt: true });
  assert.equal(plain.status, 200);
  assert.match(plain.json.prompt, /^Write a git commit message for the changes below\./);
  assert.ok(plain.json.prompt.includes(plain.json.diff), "with what the commit takes");
  assert.match(plain.json.diff, /\+World/);
  assert.doesNotMatch(plain.json.prompt, /instructions from the user/, "none set: none added");

  assert.equal((await set("commit_instructions", "  Start with the area changed, like “ui: …”.\n")).status, 200);
  const asked = await route("POST", "kuvo/git/commit-diff", { directory: repo, prompt: true });
  assert.match(asked.json.prompt, /\+World[\s\S]*\n\nAlso follow these instructions from the user:\nStart with the area changed, like “ui: …”\.$/);

  // A client that only wants the diff (whether anything is staged, as the sheet opens) gets no prompt.
  assert.equal((await route("POST", "kuvo/git/commit-diff", { directory: repo })).json.prompt, undefined);
});

test("a pull request is asked for in the box's words, from what the branch brings, with your instructions", async () => {
  git("switch", "-q", "-c", "kuvo/feature");
  write("feature.txt", "new\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Add the feature");
  assert.equal((await set("pull_request_instructions", "Add a Testing section.")).status, 200);
  const draft = await route("POST", "kuvo/git/pull-request/draft", { directory: repo, prompt: true });
  assert.equal(draft.status, 200, JSON.stringify(draft.json));
  assert.match(draft.json.prompt, /^Write a pull request for the changes below\. The first line is its title/);
  assert.match(draft.json.prompt, /Commits:\n- Add the feature[\s\S]*feature\.txt/, "with what the branch brings");
  assert.match(draft.json.prompt, /\n\nAlso follow these instructions from the user:\nAdd a Testing section\.$/);
});

test("a Mac's Settings › Git from before moves to a box once, never over the box's own", async () => {
  // This box has its own instructions for commits already.
  await set("commit_instructions", "Mine here.");
  const moved = await route("POST", "kuvo/git/settings/move", { branchPrefix: "ada/", commitInstructions: "From the Mac.", pullRequestInstructions: " Link the issue. " });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.moved, true);
  const after = await settings();
  assert.equal(after.branch_prefix, "ada/");
  assert.equal(after.commit_instructions, "Mine here.", "the box's own stays");
  assert.equal(after.pull_request_instructions, "Link the issue.");

  // Cleared here since: another Mac's (or the same one's again) brings nothing back.
  await set("pull_request_instructions", null);
  const again = await route("POST", "kuvo/git/settings/move", { pullRequestInstructions: "Another Mac's." });
  assert.equal(again.status, 200);
  assert.equal(again.json.moved, false);
  assert.equal((await settings()).pull_request_instructions, undefined);

  // What it moved is what the box asks with.
  git("switch", "-q", "-c", "ada/work");
  write("work.txt", "w\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Work");
  write("README.md", "Changed\n");
  assert.match((await route("POST", "kuvo/git/commit-diff", { directory: repo, prompt: true })).json.prompt, /instructions from the user:\nMine here\.$/);
});

test("a Mac with no branch prefix keeps having none: an empty one moves as it is", async () => {
  const moved = await route("POST", "kuvo/git/settings/move", { branchPrefix: "", commitInstructions: "" });
  assert.equal(moved.status, 200);
  const after = await settings();
  assert.equal(after.branch_prefix, "");
  assert.equal("commit_instructions" in after, false, "no instructions is what a box has already");
});

test("a machine whose settings still come from a Mac takes nothing until they're its own", async () => {
  fs.rmSync(path.join(home, "box", "opencode.json"));
  const moved = await route("POST", "kuvo/git/settings/move", { commitInstructions: "From the Mac." });
  assert.equal(moved.status, 409);
  // And it moves once they are.
  fs.writeFileSync(path.join(home, "box", "opencode.json"), "{}\n");
  assert.equal((await route("POST", "kuvo/git/settings/move", { commitInstructions: "From the Mac." })).json.moved, true);
  assert.equal((await settings()).commit_instructions, "From the Mac.");
});
