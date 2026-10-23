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
      { path: "skills/c++/SKILL.md", type: "blob" }, { path: "skills/c++/a.cpp", type: "blob" }, { path: "skills/c++/b.cpp", type: "blob" },
    ], truncated: false },
    // The engine beside it: the skills it lists, from other tools' folders too.
    "/api/skill": { data: [{ id: "pdf-forms", name: "pdf-forms" }] },
  };
  const files = {
    "/acme/skills/main/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Fills PDF forms\n---\nFill them.\n",
    "/acme/skills/main/skills/pdf/fill.py": "print('hi')\n",
    "/acme/skills/main/skills/c%2B%2B/SKILL.md": "---\nname: c++\ndescription: Writes C++\n---\nBe careful.\n",
    "/acme/skills/main/skills/c%2B%2B/a.cpp": "int a;\n",
    "/acme/skills/main/skills/c%2B%2B/b.cpp": "int b;\n",
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
const engine = { port: github.address().port, password: "test" };
const ask = (method, route, body) => link.answerSkills(method, route, body, engine);

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
  // A name the engine lists already (another tool's skill) isn't taken either.
  assert.equal((await ask("PUT", "kuvo/skills/pdf-forms", { text, new: true })).status, 409);
});

test("one written long ago is kept in the trash 30 days from when it's put away", async () => {
  const text = "---\nname: old-one\ndescription: Old\n---\nOld.\n";
  assert.equal((await ask("PUT", "kuvo/skills/old-one", { text, new: true })).status, 200);
  const long = new Date(Date.now() - 40 * 86_400_000);
  fs.utimesSync(path.join(skills, "old-one"), long, long);
  assert.equal((await ask("DELETE", "kuvo/skills/old-one")).status, 200);
  assert.equal(fs.readdirSync(path.join(home, "trash", "skills")).filter(name => name.startsWith("old-one-")).length, 1);
});

test("GitHub's collections, listed, described and installed from by the machine itself", async () => {
  const library = await ask("GET", "kuvo/skill-library");
  assert.ok(library.value.repositories.some(each => each.id === "anthropics/skills"));
  const listing = await ask("GET", "kuvo/skill-library/acme/skills");
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.value.skills, [
    { name: "c++", path: "skills/c++", files: ["skills/c++/SKILL.md", "skills/c++/a.cpp", "skills/c++/b.cpp"] },
    { name: "pdf", path: "skills/pdf", files: ["skills/pdf/SKILL.md", "skills/pdf/fill.py"] },
  ]);
  assert.equal(listing.value.partial, false);
  assert.deepEqual((await ask("GET", "kuvo/skill-library/acme/skills/about?path=skills%2Fpdf")).value, { name: "pdf", description: "Fills PDF forms" });
  // A "+" as written, as the Mac reads it.
  assert.deepEqual((await ask("GET", "kuvo/skill-library/acme/skills/about?path=skills/c++")).value, { name: "c++", description: "Writes C++" });

  assert.deepEqual(await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/pdf" }), { status: 200, value: { name: "pdf" } });
  assert.equal(fs.readFileSync(path.join(skills, "pdf", "fill.py"), "utf8"), "print('hi')\n");
  assert.deepEqual((await ask("GET", "kuvo/skills")).value.github, { pdf: { repository: "acme/skills", path: "skills/pdf" } });
  assert.equal((await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/pdf" })).status, 409);
  assert.equal((await ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/none" })).status, 404);
  assert.equal((await ask("GET", "kuvo/skill-library/acme/missing")).status, 404);
  // As it came, not edited.
  assert.equal((await ask("PUT", "kuvo/skills/pdf", { text: "---\nname: pdf\n---\nMine now.\n" })).status, 409);
  // Looked up on GitHub once, however many of its skills are described.
  assert.equal(asked.filter(url => url === "/repos/acme/skills").length, 1);

  // Two installs of one at once (a double tap): one installs it whole, the other is told it's there.
  const both = await Promise.all([1, 2].map(() => ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/c++" })));
  assert.deepEqual(both.map(each => each.status).sort(), [200, 409]);
  assert.deepEqual(fs.readdirSync(path.join(skills, "c++")).sort(), [".kuvo-source.json", "SKILL.md", "a.cpp", "b.cpp"]);
  // Nothing half-made is left beside it.
  assert.deepEqual(fs.readdirSync(skills).filter(name => name.startsWith(".")), []);
});
