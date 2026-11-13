import "./safety"
import { afterAll, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { changeProjects, readProjects } from "../src/link/areas/projects"

const home = mkdtempSync(join(process.env.KUVO_HOME!, "retired-project-setting-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

const project = {
  directory: join(home, "shop"), name: "Shop", folders: [join(home, "docs")],
  run: "bun dev", removed: true, madeBy: { bot: "bot_shop", name: "Builder", at: 123 },
}

test("reading projects ignores the retired setting without changing the saved file", () => {
  const file = join(home, "projects.json")
  const plain = { directory: join(home, "plain"), folders: [] }
  writeFileSync(file, JSON.stringify({ version: 1, projects: [{ ...project, terminal: "claude --continue" }, plain] }))
  expect(readProjects(file)).toEqual([project, plain])
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, projects: [{ ...project, terminal: "claude --continue" }, plain] })
  expect(readProjects(file)).toEqual([project, plain])
})

test("editing a legacy project under its lock preserves its settings without the retired command", () => {
  const file = join(home, "edit-projects.json")
  writeFileSync(file, JSON.stringify({ version: 1, projects: [{ ...project, terminal: "opencode" }] }))
  const edited = { ...project, name: "Shop renamed" }
  expect(changeProjects(projects => projects.map(each => ({ ...each, name: edited.name })), file, file + ".lock")).toEqual([edited])
  expect(JSON.parse(readFileSync(file, "utf8")).projects).toEqual([edited])
})

test("reading a project in a read-only folder neither locks nor rewrites it", () => {
  const folder = join(home, "read-only")
  mkdirSync(folder)
  const file = join(folder, "projects.json")
  const saved = JSON.stringify({ version: 1, projects: [{ ...project, terminal: "codex" }] })
  writeFileSync(file, saved)
  chmodSync(folder, 0o500)
  const lockAttempt = spyOn(fs, "mkdirSync")
  try {
    expect(readProjects(file)).toEqual([project])
    expect(lockAttempt).not.toHaveBeenCalled()
    expect(readFileSync(file, "utf8")).toBe(saved)
  } finally {
    lockAttempt.mockRestore()
    chmodSync(folder, 0o700)
  }
})
