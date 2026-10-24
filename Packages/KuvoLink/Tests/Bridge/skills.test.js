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
    "/repos/acme/mixed": { default_branch: "main" },
    "/repos/acme/mixed/git/trees/main?recursive=1": { tree: [
      { path: "README.md", type: "blob" },
      { path: "skills/docx/SKILL.md", type: "blob" },
      // Copies kept for other tools, in hidden folders; one is only there.
      { path: ".openclaw/skills/docx/SKILL.md", type: "blob" },
      { path: ".claude/skills/only-here/SKILL.md", type: "blob" },
      // A skill inside another's folder.
      { path: "a/SKILL.md", type: "blob" }, { path: "a/notes.md", type: "blob" },
      { path: "a/b/SKILL.md", type: "blob" }, { path: "a/b/c.txt", type: "blob" },
      // One whose second file isn't there.
      { path: "broken/SKILL.md", type: "blob" }, { path: "broken/gone.py", type: "blob" },
    ], truncated: true },
    "/repos/acme/one": { default_branch: "main" },
    "/repos/acme/one/git/trees/main?recursive=1": { tree: [
      { path: "SKILL.md", type: "blob" }, { path: "reference.md", type: "blob" }, { path: ".github/workflows/ci.yml", type: "blob" },
    ] },
    "/repos/acme/busy": { default_branch: "main" },
  };
  if (request.url === "/repos/acme/busy/git/trees/main?recursive=1") {
    response.writeHead(403);
    return response.end();
  }
  const files = {
    "/acme/skills/main/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Fills PDF forms\n---\nFill them.\n",
    "/acme/skills/main/skills/pdf/fill.py": "print('hi')\n",
    "/acme/skills/main/skills/c%2B%2B/SKILL.md": "---\nname: c++\ndescription: Writes C++\n---\nBe careful.\n",
    "/acme/skills/main/skills/c%2B%2B/a.cpp": "int a;\n",
    "/acme/skills/main/skills/c%2B%2B/b.cpp": "int b;\n",
    "/acme/mixed/main/broken/SKILL.md": "---\nname: broken\n---\nBroken.\n",
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
  assert.deepEqual(await ask("GET", "kuvo/skills"), { status: 200, value: { folder: skills, folders: [], github: {} } });
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
  // A folder the engine doesn't list (no SKILL.md yet) is named too, so a client flags its name as
  // it's typed; hidden ones (an install under way) and files aren't.
  fs.mkdirSync(path.join(skills, "half-made"), { recursive: true });
  fs.mkdirSync(path.join(skills, ".pdf.kuvo-new-1"), { recursive: true });
  fs.writeFileSync(path.join(skills, "notes.txt"), "");
  assert.deepEqual((await ask("GET", "kuvo/skills")).value.folders, ["half-made"]);
  assert.equal((await ask("PUT", "kuvo/skills/half-made", { text, new: true })).status, 409);
  fs.rmSync(path.join(skills, "half-made"), { recursive: true });
  fs.rmSync(path.join(skills, ".pdf.kuvo-new-1"), { recursive: true });
  fs.rmSync(path.join(skills, "notes.txt"));
});

test("a skill's name from what's typed, as Settings previews it (the shared vector)", () => {
  const vector = JSON.parse(fs.readFileSync(new URL("../../Vectors/routes/names/skill-names.json", import.meta.url), "utf8"));
  assert.ok(vector.cases.length > 8);
  for (const { typed, name } of vector.cases) assert.equal(link.skillName(typed), name, JSON.stringify(typed));
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
  // Each with what its SKILL.md says it is, read once.
  assert.deepEqual(listing.value.skills, [
    { name: "c++", path: "skills/c++", files: ["skills/c++/SKILL.md", "skills/c++/a.cpp", "skills/c++/b.cpp"], about: { name: "c++", description: "Writes C++" } },
    { name: "pdf", path: "skills/pdf", files: ["skills/pdf/SKILL.md", "skills/pdf/fill.py"], about: { name: "pdf", description: "Fills PDF forms" } },
  ]);
  await ask("GET", "kuvo/skill-library/acme/skills");
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
  // Looked up on GitHub once, however many of its skills are described, and each SKILL.md read once
  // however often it's listed or asked for (the install fetches its files anew).
  assert.equal(asked.filter(url => url === "/repos/acme/skills").length, 1);
  assert.equal(asked.filter(url => url === "/acme/skills/main/skills/c%2B%2B/SKILL.md").length, 1);

  // Two installs of one at once (a double tap): one installs it whole, the other is told it's there.
  const both = await Promise.all([1, 2].map(() => ask("POST", "kuvo/skill-library/install", { repository: "acme/skills", path: "skills/c++" })));
  assert.deepEqual(both.map(each => each.status).sort(), [200, 409]);
  assert.deepEqual(fs.readdirSync(path.join(skills, "c++")).sort(), [".kuvo-source.json", "SKILL.md", "a.cpp", "b.cpp"]);
  // Nothing half-made is left beside it.
  assert.deepEqual(fs.readdirSync(skills).filter(name => name.startsWith(".")), []);
});

test("a collection's skills, each listed once with its own files; a repository that's one skill; GitHub limiting says so", async () => {
  const mixed = await ask("GET", "kuvo/skill-library/acme/mixed");
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.value.skills.map(skill => skill.name).sort(), ["a", "b", "broken", "docx", "only-here"]);
  assert.deepEqual(mixed.value.skills.find(skill => skill.path === "a").files.sort(), ["a/SKILL.md", "a/notes.md"]);
  assert.deepEqual(mixed.value.skills.find(skill => skill.path === "a/b").files.sort(), ["a/b/SKILL.md", "a/b/c.txt"]);
  assert.equal(mixed.value.skills.find(skill => skill.name === "docx").path, "skills/docx");
  assert.equal(mixed.value.partial, true, "GitHub cut a very big one's list short");

  const one = await ask("GET", "kuvo/skill-library/acme/one");
  assert.deepEqual(one.value.skills, [{ name: "one", path: "", files: ["SKILL.md", "reference.md"], about: {} }]);

  const busy = await ask("GET", "kuvo/skill-library/acme/busy");
  assert.equal(busy.status, 503);
  assert.match(busy.value.message, /limiting/);
});

test("a skill whose file can't be fetched leaves nothing half-installed", async () => {
  const failed = await ask("POST", "kuvo/skill-library/install", { repository: "acme/mixed", path: "broken" });
  assert.equal(failed.status, 404);
  assert.equal(fs.existsSync(path.join(skills, "broken")), false);
  assert.deepEqual(fs.readdirSync(skills).filter(name => name.startsWith(".")), []);
  assert.equal((await ask("GET", "kuvo/skills")).value.github.broken, undefined);
});
