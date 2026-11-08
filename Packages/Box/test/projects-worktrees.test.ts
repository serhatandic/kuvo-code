import "./safety"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// A session in a worktree is its project's: the box's projects say which project each worktree
// folder belongs to, so a phone files it under its project as the Mac does, rather than listing the
// worktree as a project of its own (#239). Its worktrees changing changes what the list says, at once.

const home = process.env.KUVO_HOME!
const shop = "/work/shop"
const tree = "/trees/swift-wolf"
const gone = "/trees/brave-otter"
const back = "/trees/calm-heron"

afterEach(() => rmSync(join(home, "box"), { recursive: true, force: true }))

function keep(worktrees: unknown) {
  mkdirSync(join(home, "box"), { recursive: true })
  writeFileSync(join(home, "box", "worktrees.json"), JSON.stringify(worktrees))
  writeFileSync(join(home, "box", "projects.json"), JSON.stringify({ projects: [{ directory: shop, folders: [] }] }))
}

async function* ask(path: string, signal?: AbortSignal) {
  const { answerProjects } = await import("../src/link/areas/projects")
  for await (const piece of answerProjects({ method: "GET", path, headers: {}, body: Buffer.alloc(0) } as never, undefined, undefined, signal)) {
    if ("body" in piece) yield JSON.parse(piece.body.toString().trim())
  }
}

test("the projects list says which project each worktree's sessions belong to: kept, removed and restorable ones", async () => {
  keep({
    worktrees: [{ project: shop, root: tree, folder: tree, branch: "kuvo/235-what-a-bot-s-yes-may-pass" }],
    removed: { [gone]: shop },
    restorable: [{ project: shop, root: back, folder: back, branch: "kuvo/calm-heron", head: "abc" }],
  })
  const [answer] = await Array.fromAsync(ask("kuvo/projects"))
  expect(answer.projects.map((each: { directory: string }) => each.directory)).toEqual([shop])
  expect(answer.worktrees).toEqual({ [tree]: shop, [gone]: shop, [back]: shop })
})

test("a worktree made after a client began following is filed under its project at once", async () => {
  keep({ worktrees: [] })
  const stop = new AbortController()
  const lines = ask("kuvo/projects/events", stop.signal)
  expect((await lines.next()).value.worktrees).toEqual({})
  const { updateWorktrees } = await import("../src/link/areas/worktree-records")
  updateWorktrees(list => [...list, { project: shop, root: tree, folder: tree, branch: "kuvo/swift-wolf" }])
  expect((await lines.next()).value.worktrees).toEqual({ [tree]: shop })
  stop.abort()
  await lines.return(undefined)
})
