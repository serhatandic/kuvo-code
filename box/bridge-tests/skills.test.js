// Settings › Skills on a machine, from a phone with the Mac closed: the machine's own skills
// folder, a skill written and put away, and GitHub's collections, which the machine reaches
// itself (a local stand-in here), installed from whole.
import "./test-safety.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { atEnd, removeAtEnd } from "./at-end.js";

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
    // The engine beside it: its providers, which it answers once its plugins are set up, and the
    // skills it lists, from other tools' folders too.
    "/api/provider": { data: [] },
    "/api/skill": { data: [
      { id: "pdf-forms", name: "pdf-forms" },
      { id: "claude-one", name: "claude-one", path: path.join(os.homedir(), ".claude", "skills", "claude-one", "SKILL.md") },
      { id: "stale-one", name: "stale-one", path: path.join(home, "config", "opencode", "skills", "stale-one", "SKILL.md") },
    ] },
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
const link = await import("../../swift/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js");
removeAtEnd(home);
atEnd(() => {
  github.close();
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
  const vector = JSON.parse(fs.readFileSync(new URL("../../protocol/vectors/routes/names/skill-names.json", import.meta.url), "utf8"));
  assert.ok(vector.cases.length > 8);
  for (const { typed, name } of vector.cases) assert.equal(link.skillName(typed), name, JSON.stringify(typed));
});

const trash = path.join(home, "trash", "skills");
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
/** Recently Deleted's entries, as a client lists them. */
const deleted = async () => {
  const answer = await ask("GET", "kuvo/skill-trash");
  assert.equal(answer.status, 200);
  return answer.value.entries;
};
/** One put away `days` ago, as the box names it (its name says when). */
const trashed = (name, days, text = `---\nname: ${name}\n---\n`) => {
  const id = `${name}-${now() - Math.round(days * DAY)}`;
  fs.mkdirSync(path.join(trash, id), { recursive: true });
  fs.writeFileSync(path.join(trash, id, "SKILL.md"), text);
  return id;
};
/** The entry the box made for a skill it put away. */
const entryOf = name => fs.readdirSync(trash).find(each => each.startsWith(`${name}-`) && /^\d+$/.test(each.slice(name.length + 1)));

test("one written long ago is kept in the trash 30 days from when it's put away", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  const text = "---\nname: old-one\ndescription: Old\n---\nOld.\n";
  assert.equal((await ask("PUT", "kuvo/skills/old-one", { text, new: true })).status, 200);
  const long = new Date(Date.now() - 40 * 86_400_000);
  fs.utimesSync(path.join(skills, "old-one"), long, long);
  assert.equal((await ask("DELETE", "kuvo/skills/old-one")).status, 200);
  const [entry] = await deleted();
  assert.equal(entry.folder, "old-one");
  assert.ok(Math.abs(entry.deleted - now()) <= 2, "dated when it was put away");
  fs.rmSync(trash, { recursive: true, force: true });
});

test("Recently Deleted: a skill put away is listed, newest first, with what its SKILL.md says and when it goes, and restored whole", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  assert.deepEqual(await deleted(), [], "nothing put away yet, and no trash folder");
  const text = "---\nname: Release Notes\ndescription: \"Writes the release notes: short\"\n---\nKeep them short.\n";
  trashed("release-notes", 3, text);
  fs.writeFileSync(path.join(trash, entryOf("release-notes"), "template.md"), "# Notes\n");
  assert.equal((await ask("PUT", "kuvo/skills/no-header", { text: "Just instructions.\n", new: true })).status, 200);
  assert.equal((await ask("DELETE", "kuvo/skills/no-header")).status, 200);

  const entries = await deleted();
  assert.deepEqual(entries.map(entry => entry.folder), ["no-header", "release-notes"], "newest first");
  const [plain, old] = entries;
  // One without a header goes by its folder's name, without a description.
  assert.equal(plain.name, "no-header");
  assert.equal("description" in plain, false);
  assert.match(plain.id, /^no-header-\d+$/);
  assert.ok(Math.abs(plain.deleted - now()) <= 2);
  assert.equal(plain.goes - plain.deleted, 30 * DAY);
  assert.deepEqual({ name: old.name, folder: old.folder, description: old.description }, { name: "Release Notes", folder: "release-notes", description: "Writes the release notes: short" });
  assert.ok(Math.abs(now() - old.deleted - 3 * DAY) <= 2, "put away three days ago");
  assert.equal(old.goes - old.deleted, 30 * DAY);

  // Restored whole, under its folder's name, and out of the list.
  assert.deepEqual(await ask("POST", `kuvo/skill-trash/${encodeURIComponent(old.id)}/restore`), { status: 200, value: { name: "release-notes" } });
  assert.equal(fs.readFileSync(path.join(skills, "release-notes", "SKILL.md"), "utf8"), text);
  assert.equal(fs.readFileSync(path.join(skills, "release-notes", "template.md"), "utf8"), "# Notes\n");
  assert.deepEqual((await deleted()).map(entry => entry.folder), ["no-header"]);
  assert.equal((await ask("POST", `kuvo/skill-trash/${old.id}/restore`)).status, 404, "restored once");
  // Methods each route takes.
  assert.equal((await ask("POST", "kuvo/skill-trash")).status, 405);
  assert.equal((await ask("GET", `kuvo/skill-trash/${plain.id}/restore`)).status, 405);
  assert.equal((await ask("GET", `kuvo/skill-trash/${plain.id}`)).status, 404);
  fs.rmSync(path.join(skills, "release-notes"), { recursive: true });
  fs.rmSync(trash, { recursive: true, force: true });
});

test("an entry's date is in its name: a folder's own date changing (Finder, a backup put back) never moves it", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  const kept = trashed("kept", 2);
  // Its folder's date, long ago, and a file Finder leaves in the trash folder.
  const long = new Date(Date.now() - 90 * 86_400_000);
  fs.utimesSync(path.join(trash, kept), long, long);
  fs.writeFileSync(path.join(trash, ".DS_Store"), "");
  const [entry] = await deleted();
  assert.equal(entry.id, kept);
  assert.ok(Math.abs(now() - entry.deleted - 2 * DAY) <= 2);
  fs.rmSync(trash, { recursive: true, force: true });
});

test("Recently Deleted never restores over a skill by that name: it says so, and both stay", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  const old = trashed("pdf", 1, "---\nname: pdf\n---\nOld.\n");
  assert.equal((await ask("PUT", "kuvo/skills/pdf", { text: "---\nname: pdf\n---\nNew.\n", new: true })).status, 200);
  assert.deepEqual(await ask("POST", `kuvo/skill-trash/${old}/restore`),
    { status: 409, value: { message: "There’s a skill called pdf now. Delete it first to restore this one." } });
  assert.equal(fs.readFileSync(path.join(skills, "pdf", "SKILL.md"), "utf8"), "---\nname: pdf\n---\nNew.\n");
  assert.deepEqual((await deleted()).map(each => each.id), [old]);
  fs.rmSync(path.join(skills, "pdf"), { recursive: true });
  fs.rmSync(trash, { recursive: true, force: true });
});

test("nor beside one the engine finds elsewhere by that name, though the one put away may still be listed a moment", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  // The engine lists pdf-forms with no folder, claude-one in ~/.claude/skills, and still lists
  // stale-one where it was before it was put away.
  for (const name of ["pdf-forms", "claude-one", "stale-one"]) trashed(name, 1);
  const id = name => entryOf(name);
  assert.deepEqual(await ask("POST", `kuvo/skill-trash/${id("pdf-forms")}/restore`),
    { status: 409, value: { message: "There’s a skill called pdf-forms elsewhere, so this one can’t be restored under that name." } });
  assert.deepEqual(await ask("POST", `kuvo/skill-trash/${id("claude-one")}/restore`),
    { status: 409, value: { message: "There’s a skill called claude-one in ~/.claude/skills, so this one can’t be restored under that name." } });
  assert.deepEqual(await ask("POST", `kuvo/skill-trash/${id("stale-one")}/restore`), { status: 200, value: { name: "stale-one" } });
  assert.deepEqual((await deleted()).map(each => each.folder).sort(), ["claude-one", "pdf-forms"], "the refused ones stay");
  fs.rmSync(path.join(skills, "stale-one"), { recursive: true });
  fs.rmSync(trash, { recursive: true, force: true });
});

test("two put away in the same second are two entries", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  // Entries for this name for the next ten seconds there already: the next one put away is
  // always given another name, and none of them is touched.
  const taken = Array.from({ length: 10 }, (_, index) => `pdf-${now() + index}`);
  for (const each of taken) {
    fs.mkdirSync(path.join(trash, each), { recursive: true });
    fs.writeFileSync(path.join(trash, each, "SKILL.md"), each);
  }
  assert.equal((await ask("PUT", "kuvo/skills/pdf", { text: "---\nname: pdf\n---\nThis one.\n", new: true })).status, 200);
  assert.equal((await ask("DELETE", "kuvo/skills/pdf")).status, 200);
  const made = fs.readdirSync(trash).filter(each => !taken.includes(each));
  assert.equal(made.length, 1);
  assert.equal(fs.readFileSync(path.join(trash, made[0], "SKILL.md"), "utf8"), "---\nname: pdf\n---\nThis one.\n");
  for (const each of taken) assert.equal(fs.readFileSync(path.join(trash, each, "SKILL.md"), "utf8"), each);
  fs.rmSync(trash, { recursive: true, force: true });
});

test("Recently Deleted keeps an entry 30 days: one past it goes as the list is read, and can't be restored", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  const kept = trashed("kept", 29.9);
  trashed("gone", 30.1);
  trashed("also-gone", 31);
  assert.deepEqual((await deleted()).map(entry => entry.id), [kept]);
  assert.deepEqual(fs.readdirSync(trash), [kept], "gone for good");
  // One that passed its 30 days since the list was read isn't restored.
  const late = trashed("late", 30.5);
  assert.equal((await ask("POST", `kuvo/skill-trash/${late}/restore`)).status, 404);
  assert.equal(fs.existsSync(path.join(skills, "late")), false);
  fs.rmSync(trash, { recursive: true, force: true });
});

test("past its 30 days, an entry goes as the box starts and once a day, with no client asking", async t => {
  fs.rmSync(trash, { recursive: true, force: true });
  const kept = trashed("kept", 1);
  trashed("old", 31);
  // Something else there that isn't an entry stays.
  fs.writeFileSync(path.join(trash, ".DS_Store"), "");
  t.mock.timers.enable({ apis: ["setInterval"] });
  const timer = link.keepSkillTrashClear();
  assert.deepEqual(fs.readdirSync(trash).sort(), [".DS_Store", kept], "as it starts");
  const later = trashed("later", 31);
  t.mock.timers.tick(86_400_000 - 1);
  assert.ok(fs.existsSync(path.join(trash, later)), "not before the day's out");
  t.mock.timers.tick(1);
  assert.deepEqual(fs.readdirSync(trash).sort(), [".DS_Store", kept], "a day on");
  clearInterval(timer);
  fs.rmSync(trash, { recursive: true, force: true });
});

test("Recently Deleted's entries are named strictly: no paths, hidden names or other folders", async () => {
  fs.rmSync(trash, { recursive: true, force: true });
  fs.mkdirSync(path.join(trash, "not-an-entry"), { recursive: true });
  fs.mkdirSync(path.join(trash, ".hidden-1761400000"), { recursive: true });
  fs.writeFileSync(path.join(trash, `a-file-${now()}`), "");
  fs.mkdirSync(path.join(home, "outside-1761400000"), { recursive: true });
  assert.deepEqual(await deleted(), [], "only entries are listed");
  for (const entry of ["..%2Foutside-1761400000", "..", ".hidden-1761400000", "not-an-entry", "-1761400000", "a%00b-1761400000", "a-12345678901234", `${"x".repeat(129)}-1761400000`]) {
    const answer = await ask("POST", `kuvo/skill-trash/${entry}/restore`);
    assert.equal(answer.status, 400, entry);
    assert.equal(answer.value.message, "That isn’t an entry in Recently Deleted.");
  }
  assert.equal((await ask("POST", "kuvo/skill-trash/%E0%A4%A/restore")).status, 400);
  assert.equal((await ask("POST", `kuvo/skill-trash/nowhere-${now()}/restore`)).status, 404);
  assert.equal((await ask("POST", `kuvo/skill-trash/a-file-${now()}/restore`)).status, 404, "a file isn't an entry");
  assert.equal(fs.existsSync(path.join(home, "outside-1761400000")), true);
  assert.equal(fs.existsSync(path.join(skills, "outside")), false);
  fs.rmSync(path.join(home, "outside-1761400000"), { recursive: true });
  fs.rmSync(trash, { recursive: true, force: true });
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
