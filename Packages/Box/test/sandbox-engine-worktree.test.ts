import "./safety"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fenceAgent } from "../src/agents/fence"
import { canFence, realFence } from "./agents/support/fence"

// A session started in a worktree (a bot's start_session with worktree: true, or New Session in a
// worktree) works in a folder the engine made in Kuvo Code's own data, which the sandbox hides. Its
// coding agent, run whole in the sandbox there, works in that folder all the same; the rest of Kuvo
// Code's folders, other sessions' worktrees among them, stay hidden. (Claude Code quit as it started
// there, "Can't read the current directory (EPERM)", while the launcher hid it: 0.8.0-beta.5.)

test.skipIf(!canFence)("a coding agent run whole in a worktree the engine made works in its folder and its repository, and nothing else of Kuvo Code's", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-worktree-")))
  const fenceBefore = process.env.KUVO_FENCE
  try {
    const kuvo = join(root, "kuvo")
    const home = join(root, "home")
    const project = join(root, "project")
    const trees = join(kuvo, "data", "opencode", "worktree", "1388a8")
    const tree = join(trees, "eager-river")
    const neighbour = join(trees, "quiet-lake")
    mkdirSync(join(home, ".claude"), { recursive: true })
    mkdirSync(project, { recursive: true })
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
    const git = (cwd: string, ...args: string[]) => {
      const ran = Bun.spawnSync(["git", ...args], { cwd, env })
      if (ran.exitCode !== 0) throw new Error(ran.stderr.toString())
    }
    writeFileSync(join(project, "README.md"), "# project\n")
    git(project, "init", "-q", "-b", "main")
    git(project, "add", ".")
    git(project, "commit", "-q", "-m", "first")
    git(project, "worktree", "add", "-q", "-b", "kuvo/eager-river", tree)
    mkdirSync(neighbour, { recursive: true })
    writeFileSync(join(neighbour, "notes.md"), "another session's\n")
    writeFileSync(join(kuvo, "secret"), "Kuvo Code's own\n")

    process.env.KUVO_FENCE = realFence(kuvo)
    // As claude.ts starts Claude Code there (its homes, its state, its tools' port).
    const fence = fenceAgent("/bin/sh", tree, { homes: [join(home, ".claude")], state: ["projects"], kept: ["settings*.json"], read: [], port: 1, session: "ses_worktree" })
    expect(fence).toBeDefined()
    const tries = (what: string, command: string) => `if ( ${command} ) >/dev/null 2>&1; then echo "${what}: allowed"; else echo "${what}: refused"; fi`
    const script = [
      // What an agent does as it starts and works: its folder listed and read, files written, a commit.
      tries("list its folder", "ls ."),
      tries("read its files", "cat README.md"),
      tries("write its files", "echo changed > README.md && echo new > added.md"),
      tries("commit", "git add -A && git commit -q -m change"),
      // Never the rest.
      tries("list the worktrees beside it", `ls ${trees}`),
      tries("read another session's worktree", `cat ${join(neighbour, "notes.md")}`),
      tries("write another session's worktree", `echo x > ${join(neighbour, "notes.md")}`),
      tries("read Kuvo Code's own", `cat ${join(kuvo, "secret")}`),
    ].join("\n")
    const ran = Bun.spawnSync([fence!.command, "-c", script], { cwd: tree, env: { ...env, ...fence!.env } })
    const out = ran.stdout.toString() + ran.stderr.toString()
    expect(Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))).toEqual({
      "list its folder": "allowed",
      "read its files": "allowed",
      "write its files": "allowed",
      "commit": "allowed",
      // (Landlock keeps what's in a file, not that it's there: on Linux, names can be listed.)
      "list the worktrees beside it": process.platform === "darwin" ? "refused" : "allowed",
      "read another session's worktree": "refused",
      "write another session's worktree": "refused",
      "read Kuvo Code's own": "refused",
    })
    expect(readFileSync(join(tree, "README.md"), "utf8")).toBe("changed\n")
    expect(existsSync(join(tree, "added.md"))).toBe(true)
    expect(readFileSync(join(neighbour, "notes.md"), "utf8")).toBe("another session's\n")
  } finally {
    if (fenceBefore === undefined) delete process.env.KUVO_FENCE
    else process.env.KUVO_FENCE = fenceBefore
    rmSync(root, { recursive: true, force: true })
  }
})
