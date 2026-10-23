// Settings › Skills on a machine, from a phone with the Mac closed: the machine's own skills
// folder, a skill written and put away, and GitHub's collections, which the machine reaches
// itself (a local stand-in here), installed from whole.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kuvo-link-skills-"));
process.env.KUVO_HOME = home;
const asked = [];
const github = http.createServer((request, response) => {
  asked.push(request.url);
  const answers = {
    "/repos/acme/skills": { default_branch: "main", description: "Acme's skills" },
    "/repos/acme/skills/git/trees/main?recursive=1": { tree: [
      { path: "skills/pdf/SKILL.md", type: "blob" }, { path: "skills/pdf/fill.py", type: "blob" },
      { path: ".claude/skills/pdf/SKILL.md", type: "blob" },
    ], truncated: false },
  };
  const files = {
    "/acme/skills/main/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Fills PDF forms\n---\nFill them.\n",
    "/acme/skills/main/skills/pdf/fill.py": "print('hi')\n",
  };
  if (answers[request.url]) {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(answers[request.url]));
  }
  if (files[request.url]) {
    response.writeHead(200);
    return response.end(files[request.url]);
  }
  response.writeHead(404);
  response.end();
});
await new Promise(resolve => github.listen(0, "127.0.0.1", resolve));
process.env.KUVO_TEST_GITHUB = `http://127.0.0.1:${github.address().port}`;
const link = await import("../../Sources/KuvoLink/Resources/kuvo-link.js");
after(() => {
  github.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const skills = path.join(home, "config", "opencode", "skills");
const ask = (method, route, body) => link.answerSkills(method, route, body);

test("a skill written, read, changed and put away in the machine's trash; a new one never over another, and named as Settings names one", async () => {
  const text = "---\nname: release-notes\ndescription: Writes the release notes\n---\nKeep them short.\n";
  assert.deepEqual(await ask("GET", "kuvo/skills"), { status: 200, value: { folder: skills, github: {} } });
  assert.equal((await ask("PUT", "kuvo/skills/release-notes", { text, new: true })).status, 200);
  assert.equal(fs.readFileSync(path.join(skills, "release-notes", "SKILL.md"), "utf8"), text);
  assert.deepEqual(await ask("GET", "kuvo/skills/release-notes"), { status: 200, value: { text } });
  assert.equal((await ask("PUT", "kuvo/skills/release-notes", { text, new: true })).status, 409);
  assert.equal((await ask("PUT", "kuvo/skills/Release%20Notes", { text, new: true })).status, 400);
  assert.equal((await ask("PUT", "kuvo/skills/..%2Fescape", { text })).status, 400);
  assert.equal((await ask("PUT", "kuvo/skills/release-notes", { text: text + "And kind.\n" })).status, 200);
  assert.equal((await ask("PUT", "kuvo/skills/nowhere", { text })).status, 404);
  assert.equal((await ask("DELETE", "kuvo/skills/release-notes")).status, 200);
  assert.equal(fs.existsSync(path.join(skills, "release-notes")), false);
  assert.equal(fs.readdirSync(path.join(home, "trash", "skills")).filter(name => name.startsWith("release-notes-")).length, 1);
  assert.equal((await ask("GET", "kuvo/skills/release-notes")).status, 404);
});

test("GitHub's collections, listed, described and installed from by the machine itself", async () => {
  const library = await ask("GET", "kuvo/skill-library");
  assert.ok(library.value.repositories.some(each => each.id === "anthropics/skills"));
  const listing = await ask("GET", "kuvo/skill-library/acme/skills");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.value.skills, [{ name: "pdf", path: "skills/pdf", files: ["skills/pdf/SKILL.md", "skills/pdf/fill.py"] }]);
  assert.equal(listing.value.partial, false);
  assert.deepEqual((await ask("GET", "kuvo/skill-library/acme/skills/about?path=skills%2Fpdf")).value, { name: "pdf", description: "Fills PDF forms" });

  assert.deepEqual(await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/pdf" }), { status: 200, value: { name: "pdf" } });
  assert.equal(fs.readFileSync(path.join(skills, "pdf", "fill.py"), "utf8"), "print('hi')\n");
  assert.deepEqual((await ask("GET", "kuvo/skills")).value.github, { pdf: { repository: "acme/skills", path: "skills/pdf" } });
  assert.equal((await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/pdf" })).status, 409);
  assert.equal((await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/none" })).status, 404);
  assert.equal((await ask("GET", "kuvo/skill-library/acme/missing")).status, 404);
  // Nothing half-made is left beside it.
  assert.deepEqual(fs.readdirSync(skills).filter(name => name.startsWith(".")), []);
});
