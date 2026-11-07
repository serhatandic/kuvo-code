// /compact on the real coding agents, through the real agents' bridge (KuvoCode/Resources/
// kuvo-agents.js, on Bun): asked at rest, the conversation shows the summary's row and stays whole,
// the agent still knows what it was told; asked during a turn, the turn goes through and the summary
// follows it; asked with nothing to summarize, it says so. For Claude Code, a project's
// `SessionStart:compact` hook starts.
//
// One test per lane, each with its own folders, skipped unless asked for and there:
//   KUVO_TEST_COMPACT_CLAUDE=<model>  Claude Code on the PATH, as you're signed in, on that model
//   KUVO_TEST_COMPACT_GROK=<model>    Grok on the PATH, as you're signed in, on that model
//   KUVO_TEST_CODEX_AUTH=<file> KUVO_TEST_CODEX_MODEL=<model>
//                                     Codex with a COPY of that sign-in, in a CODEX_HOME of its own,
//                                     deleted afterwards; refused if the copy could refresh it
// Claude Code and Grok keep their conversations in the real home's folders, which no test may delete
// in: each says what it left there, in kuvo-compact-* folders, for you to remove.
import "./test-safety.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atEnd, removeAtEnd } from "./at-end.js";
import { NO_BUN, testBun } from "./bun-for-tests.js";

const bun = testBun();
const agentsJS = fileURLToPath(new URL("../../../../KuvoCode/Resources/kuvo-agents.js", import.meta.url));
const agentsSources = fileURLToPath(new URL("../../../Box/src/agents", import.meta.url));
const program = name => spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
const WORDS = "TANGERINE-42 and HARBOUR";
// The run has a home of its own: Claude Code's and Grok's sign-ins are in the real one.
const realHome = process.env.KUVO_TEST_REAL_HOME;

/** The bridge, in folders of the test's own, and a client's calls to it. */
async function bridge(prefix, env = {}, useRealHome = true, ownClaudeSignIn = false) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  removeAtEnd(home);
  for (const folder of ["tmp", "work", "agents", "run"]) fs.mkdirSync(path.join(home, folder), { recursive: true });
  const workspace = path.join(home, "work");
  // On a Mac the bridge's Claude lane signs in with Kuvo Code's own token, which a test's folders don't
  // have and never get a copy of. So from its sources, as on a machine: with your own sign-in, as is.
  const preload = path.join(home, "own-claude-sign-in.ts");
  if (ownClaudeSignIn) fs.writeFileSync(preload, `import { ClaudeAgent } from ${JSON.stringify(path.join(agentsSources, "agents", "claude.ts"))}\nClaudeAgent.keychain = false\n`);
  const child = spawn(bun, ownClaudeSignIn ? ["--preload", preload, path.join(agentsSources, "main.ts")] : [agentsJS], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: useRealHome ? realHome : home, USER: process.env.USER, TMPDIR: `${home}/tmp`, KUVO_HOME: home, KUVO_AGENTS_HOME: path.join(home, "agents"), OPENCODE_PASSWORD: "pw", BUN_BE_BUN: "1", ...env },
  });
  atEnd(() => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.on("exit", resolve); child.stdin.end(); child.kill(); }));
  const port = await new Promise((resolve, reject) => {
    let said = "";
    const look = chunk => { said += chunk; const found = said.match(/127\.0\.0\.1:(\d+)/); if (found) resolve(Number(found[1])); };
    child.stdout.on("data", look);
    child.stderr.on("data", look);
    child.on("exit", code => reject(new Error(`The agents' bridge ended (${code}).`)));
  });
  const auth = { authorization: "Basic " + Buffer.from("opencode:pw").toString("base64"), "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) };
  const api = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { home, workspace, api };
}

/** What a lane is asked, and what's seen. */
async function scenario({ api, workspace }, provider, model) {
  const made = await api("POST", "api/session", { title: "Compact", location: { directory: workspace }, model: { providerID: provider, id: model } });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.data.id;
  const page = async () => (await api("GET", `api/session/${id}/message?limit=200&order=asc`)).json?.data ?? [];
  const idles = async () => (await page()).filter(each => each.type === "idle");
  const waitFor = async (wanted, what) => {
    const end = Date.now() + 240_000;
    for (;;) {
      const found = await wanted();
      if (found) return found;
      assert.ok(Date.now() < end, `Waited too long for ${what}: ${JSON.stringify((await page()).map(each => [each.type, each.status ?? each.outcome ?? "", each.error?.message ?? each.text ?? ""]))}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };
  const settled = async count => waitFor(async () => (await idles()).length >= count && !Object.keys((await api("GET", "api/session/active")).json?.data ?? {}).includes(id), `${count} ended`);
  const send = async text => assert.equal((await api("POST", `api/session/${id}/prompt`, { delivery: "steer", text })).status, 200);
  const textOf = message => (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");

  // Nothing to summarize yet: a sentence, and nothing runs.
  const early = await api("POST", `api/session/${id}/compact`, {});
  assert.equal(early.status, 400);
  assert.match(early.json.message, /^There's nothing to summarize yet: .+ hasn't started on this conversation\.$/);

  await send(`Remember these words: ${WORDS}. Reply with only OK.`);
  await settled(1);
  const before = await page();
  assert.equal(before.at(-1).outcome, "succeeded", JSON.stringify(before.at(-1)));

  // At rest.
  const asked = await api("POST", `api/session/${id}/compact`, {});
  assert.equal(asked.status, 200, JSON.stringify(asked.json));
  assert.deepEqual(asked.json.data, { state: "compacting" });
  await settled(2);
  const after = await page();
  const row = after.find(each => each.type === "compaction");
  assert.equal(row?.status, "completed", JSON.stringify(after.at(-1)));
  assert.equal(row.reason, "manual");
  assert.equal(after.at(-1).outcome, "succeeded");
  // All that was there is, as it was; only the row and the turn's end are new, no reply and no note.
  assert.deepEqual(after.slice(0, before.length).map(each => each.id), before.map(each => each.id));
  assert.deepEqual(after.slice(before.length).map(each => each.type), ["compaction", "idle"]);

  // It still knows, and a reply after it reads as ever.
  await send("Which words did I ask you to remember? Reply with only them.");
  await settled(3);
  const known = (await page()).filter(each => each.type === "assistant").map(textOf).join("\n");
  assert.match(known, /TANGERINE-42/);
  assert.match(known, /HARBOUR/);

  // During a turn: the turn goes through, then the summary.
  await send("Count from 1 to 150 in words, one per line. Use no tools.");
  await waitFor(async () => (await page()).filter(each => each.type === "assistant").map(textOf).join("\n").toLowerCase().includes("ten"), "the turn under way");
  const during = await api("POST", `api/session/${id}/compact`, {});
  const state = during.json?.data?.state;
  await settled(5);
  const end = await page();
  const stops = end.filter(each => each.type === "idle").map(each => each.outcome);
  const counted = end.filter(each => each.type === "compaction");
  assert.equal(state, "waiting");
  assert.deepEqual(stops, ["succeeded", "succeeded", "succeeded", "succeeded", "succeeded"], "the turn wasn't stopped for it");
  assert.equal(counted.length, 2);
  assert.equal(counted.at(-1).status, "completed");
  assert.match(end.filter(each => each.type === "assistant").map(textOf).join("\n").toLowerCase(), /one hundred fifty|one hundred and fifty/);
  return { id, rows: end.map(each => each.type) };
}

test("Claude Code", { skip: !process.env.KUVO_TEST_COMPACT_CLAUDE ? "KUVO_TEST_COMPACT_CLAUDE isn't set" : !bun ? NO_BUN : !program("claude") ? "Claude Code isn't installed" : false, timeout: 900_000 }, async t => {
  const running = await bridge("kuvo-compact-claude-", {}, true, true);
  t.diagnostic(`Left to remove: ~/.claude/projects/${running.workspace.replace(/[^a-zA-Z0-9]/g, "-")}`);
  // A project's hook for what follows a summary: it starts, and its row isn't a failure.
  const ran = path.join(running.home, "hook-ran.txt");
  fs.mkdirSync(path.join(running.workspace, ".claude"));
  fs.writeFileSync(path.join(running.workspace, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: `echo ran >> ${ran}` }] }] } }));
  const { id } = await scenario(running, "claude-code", process.env.KUVO_TEST_COMPACT_CLAUDE);
  assert.equal(fs.readFileSync(ran, "utf8").trim().split("\n").length, 2, "its hook started each time");
  const notes = ((await running.api("GET", `api/session/${id}/message?limit=200&order=asc`)).json?.data ?? []).filter(each => each.type === "synthetic").map(each => each.text);
  assert.deepEqual(notes.filter(each => !each.startsWith("The conversation will be summarized")), []);
});

test("Grok", { skip: !process.env.KUVO_TEST_COMPACT_GROK ? "KUVO_TEST_COMPACT_GROK isn't set" : !bun ? NO_BUN : !program("grok") ? "Grok isn't installed" : false, timeout: 900_000 }, async t => {
  const running = await bridge("kuvo-compact-grok-");
  t.diagnostic(`Left to remove: the folder in ~/.grok/sessions named after ${running.workspace}`);
  await scenario(running, "grok-cli", process.env.KUVO_TEST_COMPACT_GROK);
});

test("Codex", { skip: !process.env.KUVO_TEST_CODEX_AUTH || !process.env.KUVO_TEST_CODEX_MODEL ? "KUVO_TEST_CODEX_AUTH and KUVO_TEST_CODEX_MODEL aren't set" : !bun ? NO_BUN : !program("codex") ? "Codex isn't installed" : false, timeout: 900_000 }, async () => {
  // A copy must never refresh, which would rotate the token and sign the original out.
  const auth = JSON.parse(fs.readFileSync(process.env.KUVO_TEST_CODEX_AUTH, "utf8"));
  const { exp } = JSON.parse(Buffer.from(auth.tokens.access_token.split(".")[1], "base64url").toString());
  assert.ok(exp * 1000 - Date.now() > 24 * 3600_000, "That sign-in has under a day left: a copy of it could refresh.");
  assert.ok(Date.now() - Date.parse(auth.last_refresh) < 6 * 24 * 3600_000, "That sign-in was last refreshed 6 or more days ago: a copy of it could refresh.");
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-compact-codex-home-")));
  removeAtEnd(scratch);
  fs.writeFileSync(path.join(scratch, "auth.json"), fs.readFileSync(process.env.KUVO_TEST_CODEX_AUTH), { mode: 0o600 });
  fs.writeFileSync(path.join(scratch, "config.toml"), `cli_auth_credentials_store = "file"\n`);
  const running = await bridge("kuvo-compact-codex-", { CODEX_HOME: scratch }, false);
  await scenario(running, "codex-cli", process.env.KUVO_TEST_CODEX_MODEL);
});
