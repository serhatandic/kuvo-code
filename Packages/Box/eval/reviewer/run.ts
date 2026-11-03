// Auto's reviewer against its eval set (`actions.jsonl`): everyday actions, planted
// injections and over-eager ones, each with what it should come to. Runs the box's own review
// (code's hard lines, then the model) on a real model through its
// maker's command-line tool, and prints what it got wrong: the ones it let through that it
// shouldn't (the misses that matter), then the ones it held back that it could have let go.
//
//   bun eval/reviewer/run.ts claude haiku           Claude Code's Haiku (`claude -p`)
//   bun eval/reviewer/run.ts codex <model id>       Codex's small model (`codex exec`)
//   bun eval/reviewer/run.ts claude haiku <id>…     only those cases
//
// It spends that account's usage: one short answer per case not settled by code. Nothing it runs
// is carried out, nor fetched: a script from the web is the case's own (`fetched`), and scripts
// are written into a temporary folder of its own, deleted at the end.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface Case {
  id: string;
  kind: "command" | "file" | "tool";
  command?: string;
  path?: string;
  access?: "read" | "write";
  tool?: string;
  args?: Record<string, unknown>;
  said?: string[];
  bot?: string;
  script?: string;
  /** What the web answers for a script the command fetches. */
  fetched?: string;
  expect: "allow" | "refuse";
  by?: "code";
  note?: string;
  /** Only on this system: a case about its own places. */
  on?: NodeJS.Platform;
}

const [maker, model, ...only] = process.argv.slice(2);
if (!maker || !model || !["claude", "codex"].includes(maker)) {
  console.error("Say whose model: `claude haiku`, or `codex <model id>`.");
  process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-reviewer-eval-"));
process.env.KUVO_HOME = path.join(scratch, "kuvo");
const project = path.join(scratch, "project");
fs.mkdirSync(project, { recursive: true });
const { review } = await import("../../src/link/work/reviewer");

// One answer from the maker's own tool, with nothing but the prompt.
function ask(prompt: string): Promise<string> {
  const run = maker === "claude"
    ? spawnSync("claude", ["-p", "--model", model, "--max-turns", "1", "--tools", ""], { input: prompt, encoding: "utf8", cwd: scratch, timeout: 120_000 })
    : spawnSync("codex", ["exec", "-m", model, "--sandbox", "read-only", "--skip-git-repo-check", "-"], { input: prompt, encoding: "utf8", cwd: scratch, timeout: 120_000 });
  if (run.status !== 0) return Promise.reject(new Error((run.stderr || run.stdout || `exited ${run.status}`).trim().slice(0, 200)));
  return Promise.resolve(run.stdout);
}

const home = os.homedir();
const cases = fs.readFileSync(new URL("./actions.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Case)
  .filter(each => (!each.on || each.on === process.platform) && (!only.length || only.includes(each.id)));
const results: { case: Case; got: string; by: string; reason: string }[] = [];
try {
  for (const each of cases) {
    // A local script it runs, where the command names it.
    if (each.script && each.command && !/\|\s*(ba|z)?sh\b/.test(each.command)) {
      for (const word of each.command.split(/\s+/).filter(word => /\.(sh|py|js|rb)$/.test(word))) {
        const file = path.resolve(project, word);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, each.script);
      }
    }
    const folder = project;
    const action = each.kind === "command"
      ? { kind: "command" as const, command: each.command!, folder }
      : each.kind === "file"
        ? { kind: "file" as const, path: each.path!.replace(/^~(?=\/)/, home), access: each.access ?? "read", folder }
        : { kind: "tool" as const, tool: each.tool!, args: each.args ?? {}, folder };
    const context = each.bot
      ? { session: `eval_${each.id}`, said: [], bot: { id: "bot_eval", name: "Eval", goal: each.bot } }
      : { session: `eval_${each.id}`, said: each.said ?? [] };
    const verdict = await review(action, context, { model: ask, folder: path.join(scratch, "reviews"), fetch: async () => each.fetched ?? Promise.reject(new Error("not in the eval set")) });
    results.push({ case: each, got: verdict.decision, by: verdict.by, reason: verdict.reason });
    process.stdout.write(verdict.decision === each.expect ? "." : verdict.decision === "allow" ? "!" : "x");
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const wrong = results.filter(each => each.got !== each.case.expect);
const letThrough = wrong.filter(each => each.got === "allow");
const heldBack = wrong.filter(each => each.got !== "allow");
console.log(`\n\n${maker} ${model}: ${results.length - wrong.length} of ${results.length} as expected; ${letThrough.length} let through that shouldn't be, ${heldBack.length} held back.`);
for (const [title, list] of [["Let through", letThrough], ["Held back that could have gone ahead", heldBack]] as const) {
  if (!list.length) continue;
  console.log(`\n${title}:`);
  for (const each of list) console.log(`  ${each.case.id}: expected ${each.case.expect}, got ${each.got} (${each.by}): ${each.reason}`);
}
process.exit(letThrough.length ? 1 : 0);
