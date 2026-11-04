import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A proposed goal's projects, as you set them on its card before Start: renamed or moved to another
// folder, the card's folders and checks follow, and once it runs they can't change.

test("you rename a proposed goal's project or move it to a folder of your own, and the card says where Start makes it; once it runs, it's refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "kuvo-goal-projects-"))
  try {
    const { BOTS, K } = await import("../src/link/home")
    const { answerGoal, proposeGoal } = await import("../src/link/work/goals")
    const file = join(root, "goals.json")
    // Pixel, a bot here.
    const folder = join(BOTS, "bot_pixelprojects")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "bot.json"), JSON.stringify({ kuvo: 1, id: "bot_pixelprojects", name: "Pixel", job: "Builds apps.", look: { color: "graphite", shape: "squircle", face: "bright" }, created: "2026-10-01T09:00:00Z", updated: "2026-10-01T09:00:00Z" }))
    writeFileSync(join(folder, "session"), "ses_pixelprojects")
    const proposed = proposeGoal({ bot: "bot_pixelprojects", name: "Pixel", session: "ses_pixelprojects" }, { goal: "Build a tide app", steps: ["Build it"], projects: ["Storefront"] }, file)
    if (!("goal" in proposed)) throw new Error(proposed.refused)
    const id = proposed.goal.id
    expect(proposed.goal.checks.some(each => each.id === "projectsFolder")).toBe(true)

    // Renamed: where it goes follows, once a projects folder is picked.
    const projectsAt = join(root, "Developer")
    mkdirSync(projectsAt, { recursive: true })
    mkdirSync(join(K, "box"), { recursive: true })
    writeFileSync(join(K, "box", "work.json"), JSON.stringify({ projectsFolder: projectsAt }))
    const renamed = await answerGoal(id, { action: "projects", projects: ["Tide Pool"] }, () => [], file)
    if (!("goal" in renamed)) throw new Error(renamed.refused.message)
    expect(renamed.goal.projects).toEqual(["Tide Pool"])
    expect(renamed.goal.folders).toEqual([{ project: "Tide Pool", folder: join(projectsAt, "tide-pool"), shown: join(projectsAt, "tide-pool"), there: false }])
    rmSync(join(K, "box", "work.json"))

    // Moved to a folder of your own with files in it already: shown as there, and no projects
    // folder to pick for it.
    const yours = join(root, "Mine", "tides")
    mkdirSync(yours, { recursive: true })
    writeFileSync(join(yours, "README.md"), "Mine.\n")
    const moved = await answerGoal(id, { action: "projects", projects: [yours] }, () => [], file)
    if (!("goal" in moved)) throw new Error(moved.refused.message)
    expect(moved.goal.folders).toEqual([{ project: "tides", folder: yours, shown: yours, there: true }])
    expect(moved.goal.checks.some(each => each.id === "projectsFolder")).toBe(false)

    // What won't do: none, more than five, a path that can't be a project's folder.
    for (const projects of [[], ["a", "b", "c", "d", "e", "f"], [""], ["/"], "Storefront"]) {
      const refused = await answerGoal(id, { action: "projects", projects }, () => [], file)
      expect("refused" in refused && refused.refused.status).toBe(400)
    }
    const none = await answerGoal("goal_none", { action: "projects", projects: ["Storefront"] }, () => [], file)
    expect("refused" in none && none.refused.status).toBe(404)

    // Started (there being a folder there already holds nothing back), it can't change.
    const started = await answerGoal(id, { action: "start" }, () => [], file)
    expect("goal" in started && started.goal.state).toBe("running")
    const late = await answerGoal(id, { action: "projects", projects: ["Storefront"] }, () => [], file)
    expect("refused" in late && late.refused.status).toBe(400)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
