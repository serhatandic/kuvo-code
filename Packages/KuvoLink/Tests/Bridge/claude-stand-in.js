// Claude Code, as far as the agents bridge asks it in these tests: signed in (`claude auth status`),
// and the models it has, which Claude's SDK asks over its pipe as it starts it. Never a turn. Its
// `default` is the model it recommends on that account (`stands`: Opus on one plan, Sonnet on
// another). The bridge is given the SDK as the box's own tests have it (`bun install` in
// Packages/Box, before these tests, as CI does), so nothing is downloaded, and the stand-in comes
// first on its PATH, so your own Claude Code is never run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const boxModules = fileURLToPath(new URL("../../../Box/node_modules", import.meta.url));

/** The stand-in in `root`'s `.local/bin`, and the SDK in the bridge's `agents` folder: the folder to
 * put first on the bridge's PATH. */
export function standInClaude({ root, agents, stands = "opus" }) {
  const bin = path.join(root, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const named = { opus: "Opus 5.5", sonnet: "Sonnet 5.5" };
  const models = [
    { value: "default", resolvedModel: `claude-${stands}-5-5`, displayName: "Default (recommended)", description: `${named[stands]} · Recommended` },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "Opus 5.5 · Most capable" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Sonnet 5.5 · Everyday" },
  ];
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log('{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
if (!args.includes("stream-json")) process.exit(1);
const models = ${JSON.stringify(models)};
const answer = (request_id, said) => process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id, ...said } }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.type !== "control_request") return;
  if (message.request?.subtype === "initialize") answer(message.request_id, { subtype: "success", response: { models, commands: [], agents: [], output_style: "default", available_output_styles: ["default"], account: {} } });
  else answer(message.request_id, { subtype: "error", error: "Not in this stand-in." });
}).on("close", () => process.exit(0));
`, { mode: 0o755 });
  const runtime = path.join(agents, "runtime", "claude");
  fs.mkdirSync(runtime, { recursive: true });
  if (!fs.existsSync(path.join(runtime, "node_modules"))) fs.symlinkSync(boxModules, path.join(runtime, "node_modules"));
  return bin;
}
