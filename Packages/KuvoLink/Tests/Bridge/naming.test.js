// "&" in a message from a phone, on every box (PROTOCOL.md, "Messages in a session", `kuvo/named`):
// the agents it names, told at its end, as the Mac's AgentReferences words it. Both read the same
// cases (Vectors/routes/names/agent-naming.json).
//
// Run with `node --test Packages/KuvoLink/Tests/Bridge/naming.test.js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-naming-"));
process.env.KUVO_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
const vector = JSON.parse(fs.readFileSync(new URL("../../Vectors/routes/names/agent-naming.json", import.meta.url), "utf8"));

for (const each of vector.cases) {
  test(each.about, () => {
    assert.equal(link.nameAgents(each.message, { excluding: each.excluding ?? null, here: each.here ?? null, agents: vector.agents }), each.expected);
  });
}

test("a box passes a phone's message on with who it names told, as everyone's listed there, and that it's from the phone", async t => {
  // The engine, which takes the message.
  const got = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => body += chunk);
    request.on("end", () => {
      if (request.url.startsWith("/api/session?")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
      got.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  // Everyone, as this box (a machine, "lab") lists them.
  fs.mkdirSync(path.join(home, "run"), { recursive: true });
  fs.writeFileSync(path.join(home, "run", "agents.json"), JSON.stringify({ machine: "lab", agents: [
    { session: "ses_scout", name: "Scout", kind: "bot", machine: "lab", about: "Watches the build" },
    { session: "ses_mac", name: "Release notes", kind: "session" },
  ] }));
  const handle = link.engineHandler(() => ({ port: server.address().port, password: "pw" }));
  const parts = [];
  for await (const part of handle({ method: "POST", path: "api/session/ses_here/prompt", headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ id: "msg_1", text: "Ask &Scout and &release notes" })) }, {}, undefined)) parts.push(part);
  assert.equal(parts[0].head.status, 200);
  const text = JSON.parse(got.at(-1).body).text;
  // The block's heading, as the cases have it.
  const heading = vector.cases[0].expected.split("\n")[3];
  assert.equal(text.split("\n\n<from-phone>")[0], "Ask &Scout and &release notes\n\n<named-agents>\n" + heading
    + "\n- &Scout (ses_scout): bot, here: Watches the build\n- &Release notes (ses_mac): session, on the Mac\n</named-agents>");
  assert.ok(text.endsWith(link.FROM_PHONE));
});
