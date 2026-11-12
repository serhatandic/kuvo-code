import "./safety"
import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence, realFence } from "./agents/support/fence"

// What git runs, or is led by, in the repository a conversation's commands write (its settings, its
// hooks, where its common folder is, a worktree's links back to it, its submodules' repositories)
// runs outside the sandbox the next time git works there: in your terminal, or as Changes commits.
// So no command plants it, on either system (#422 on macOS, by the sandbox's rules; #429 on Linux,
// in each command's namespace). Each way in is tried in a repository of its own, from a conversation
// at work in it (its main folder, or a worktree of it), then git runs there outside the sandbox.

// (Each way in starts a sandbox, and git runs after: longer than a test is given unless it says.)
setDefaultTimeout(180_000)

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }

function git(cwd: string, ...args: string[]) {
  const ran = Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], { cwd, env: { ...ENV, HOME: cwd } })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`)
}

const sh = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

interface Way {
  /** In the repository's worktree (`wt`) rather than its main folder. */
  worktree?: boolean
  /** With a submodule (`lib`). */
  submodule?: boolean
  /** The repository as it's set up first, outside the sandbox (in `app`). */
  before?: string
  /** What the command tries, in the conversation's folder; `$MARK` is what the code it plants
   * makes, `$FSMONITOR` a setting that makes it, `$HOOK` a hook that does, `$LIB` a repository to
   * take a submodule from. */
  tries: string
  /** And then, in a command of its own after it. */
  then?: string
  /** What you do in the repository yourself afterwards, outside the sandbox, before git there. */
  after?: string
  /** With the folder its folder is in Also Allowed. */
  above?: boolean
}

// (Each a shell script; the conversation's folder is the current one, its repository `$G`.)
const WAYS: Record<string, Way> = {
  "its git settings": { tries: `git config core.fsmonitor "$FSMONITOR"` },
  "its git settings, by a path from its folder": { tries: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> .git/config` },
  "its git settings, written over": { tries: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> "$G/config"` },
  "its git settings, swapped in": { tries: `cp "$G/config" c && printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> c && mv -f c "$G/config"` },
  "a hook": { tries: `printf '%s\\n' "$HOOK" > "$G/hooks/pre-commit" && chmod +x "$G/hooks/pre-commit"` },
  "a hook, its folder moved away": { tries: `mv "$G/hooks" "$G/hooks-old"; mkdir "$G/hooks"; printf '%s\\n' "$HOOK" > "$G/hooks/pre-commit" && chmod +x "$G/hooks/pre-commit"` },
  "a hook, its folder missing": { before: "rm -rf .git/hooks", tries: `mkdir -p "$G/hooks" && printf '%s\\n' "$HOOK" > "$G/hooks/pre-commit" && chmod +x "$G/hooks/pre-commit"` },
  "its repository traded": { tries: `cp -R "$G" evil && git config --file evil/config core.fsmonitor "$FSMONITOR" && mv "$G" old && mv evil "$G"` },
  "a common folder of its own": { tries: `cp -R "$G" evil && git --git-dir=evil config core.fsmonitor "$FSMONITOR" && printf '%s\\n' "$PWD/evil" > "$G/commondir"` },
  "a worktree's common folder": { worktree: true, tries: `cp -R "$G" evil && git --git-dir=evil config core.fsmonitor "$FSMONITOR" && printf '%s\\n' "$PWD/evil" > "$G/worktrees/wt/commondir"` },
  "a worktree's common folder, its folder moved and back": { worktree: true, tries: `cp -R "$G" evil && git --git-dir=evil config core.fsmonitor "$FSMONITOR"; mv "$G/worktrees" "$G/wt-moved"; printf '%s\\n' "$PWD/evil" > "$G/wt-moved/wt/commondir"; mv "$G/wt-moved" "$G/worktrees"` },
  "a worktree's own git folder": { worktree: true, tries: `cp -R "$G/worktrees/wt" own && printf '%s\\n' "$PWD/evil" > own/commondir && cp -R "$G" evil && git --git-dir=evil config core.fsmonitor "$FSMONITOR" && printf 'gitdir: %s\\n' "$PWD/own" > .git` },
  "a worktree's own settings": { worktree: true, before: "git config extensions.worktreeConfig true", tries: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" > "$G/worktrees/wt/config.worktree"` },
  "a submodule's settings": { submodule: true, tries: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> "$G/modules/lib/config"` },
  "a submodule's hook": { submodule: true, tries: `printf '%s\\n' "$HOOK" > "$G/modules/lib/hooks/post-checkout" && chmod +x "$G/modules/lib/hooks/post-checkout"` },
  "a submodule's common folder": { submodule: true, tries: `cp -R "$G/modules/lib" evil && git config --file evil/config --unset core.worktree; git config --file evil/config core.fsmonitor "$FSMONITOR" && printf '%s\\n' "$PWD/evil" > "$G/modules/lib/commondir"` },
  "its repository's HEAD taken away first": { tries: `rm -f "$G/HEAD"`, then: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> "$G/config"; echo 'ref: refs/heads/main' > "$G/HEAD"` },
  "a submodule's repository made where it has none": { tries: `mkdir -p "$G/modules" && git clone -q --bare "$LIB" "$G/modules/lib" && git config --file "$G/modules/lib/config" core.bare false && printf '%s\\n' "$HOOK" > "$G/modules/lib/hooks/post-checkout" && chmod +x "$G/modules/lib/hooks/post-checkout" && printf '[submodule "lib"]\\n\\tpath = lib\\n\\turl = %s\\n' "$LIB" > .gitmodules && git update-index --add --cacheinfo "160000,$(git -C "$LIB" rev-parse HEAD),lib" && git add .gitmodules && git commit -q -m lib`, after: "git -c protocol.file.allow=always submodule update --init" },
  "its own settings for worktrees, before they're on": { tries: `printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" > "$G/config.worktree"`, after: "git config extensions.worktreeConfig true" },
  "its folder traded, from the folder above it": { above: true, tries: `W=$PWD; cd / && mv "$W" "$W-old" && mkdir "$W" && cp -R "$W-old/.git" "$W/.git" && git config --file "$W/.git/config" core.fsmonitor "$FSMONITOR"` },
  "a submodule's repository traded": { submodule: true, tries: `cp -R "$G/modules/lib" evil && git config --file evil/config core.fsmonitor "$FSMONITOR" && mv "$G/modules/lib" "$G/modules/lib-old" && mv evil "$G/modules/lib"` },
}

/** A sandbox of the box's own in `root`, with what the planted code makes where no command can write
 * (Kuvo Code's folder), so only code run outside the sandbox makes it. */
function fenced(root: string) {
  const kuvo = join(root, "kuvo")
  const home = join(root, "home")
  const marks = join(kuvo, "marks")
  mkdirSync(marks, { recursive: true })
  mkdirSync(home, { recursive: true })
  realFence(kuvo)
  const library = join(root, "library")
  mkdirSync(library)
  writeFileSync(join(library, "lib.txt"), "lib\n")
  git(library, "init", "-q", "-b", "main")
  git(library, "add", ".")
  git(library, "commit", "-q", "-m", "lib")
  /** A repository of its own in `root/<slug>/app`, with what `way` names; `work`, where the
   * conversation works in it. */
  const repository = (slug: string, way: { worktree?: boolean; submodule?: boolean; before?: string }) => {
    const app = join(root, slug, "app")
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, "README.md"), "# app\n")
    git(app, "init", "-q", "-b", "main")
    git(app, "add", ".")
    git(app, "commit", "-q", "-m", "first")
    if (way.submodule) {
      git(app, "submodule", "add", "-q", library, "lib")
      git(app, "commit", "-q", "-m", "lib")
    }
    if (way.worktree) git(app, "worktree", "add", "-q", "-b", "try", join(root, slug, "wt"))
    if (way.before) {
      const ran = Bun.spawnSync(["/bin/sh", "-c", way.before], { cwd: app, env: { ...ENV, HOME: home } })
      expect(ran.exitCode, ran.stderr.toString()).toBe(0)
    }
    return { app, git: join(app, ".git"), work: way.worktree ? join(root, slug, "wt") : app }
  }
  /** `folder` Also Allowed for the conversation at work in `work`, as the box keeps it (fence/allowed.ts). */
  const allow = (work: string, folder: string) => {
    const at = join(kuvo, "run", "fence", "allowed")
    mkdirSync(at, { recursive: true })
    writeFileSync(join(at, createHash("sha256").update(work).digest("hex").slice(0, 32)), folder + "\n")
  }
  /** `script` run in the sandbox, from a conversation at work in `work`, its repository `gitDir`. */
  const run = (work: string, gitDir: string, script: string) => {
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: work, env: { ...ENV, HOME: home, KUVO_FENCE_WORK: work, KUVO_FENCE_GIT: gitDir } })
    return { code: ran.exitCode, out: ran.stdout.toString().trim(), said: (ran.stdout.toString() + ran.stderr.toString()).trim() }
  }
  /** git outside the sandbox, as you'd run it. */
  const outside = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], { cwd, env: { ...ENV, HOME: home } })
  return { kuvo, home, marks, library, repository, allow, run, outside }
}

test.skipIf(!canFence)("a command plants nothing git runs outside the sandbox in its repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-")))
  try {
    const { home, marks, library, repository, allow, run, outside } = fenced(root)
    // (Commands do run in the sandbox: one can't write where the marks go.)
    expect(run(home, "", `touch ${sh(join(marks, "control"))}`).code).not.toBe(0)
    expect(existsSync(join(marks, "control"))).toBe(false)
    const escaped: string[] = []
    const said: Record<string, string> = {}
    for (const [name, way] of Object.entries(WAYS)) {
      const slug = name.replace(/[^a-z]+/g, "-")
      const { app, git: gitDir, work } = repository(slug, way)
      if (way.above) allow(work, join(root, slug))
      const mark = join(marks, slug)
      const hook = `#!/bin/sh\ntouch ${sh(mark)}`
      const given = `G=${sh(gitDir)}; MARK=${sh(mark)}; FSMONITOR=${sh(`touch ${sh(mark)}; false`)}; HOOK=${sh(hook)}; LIB=${sh(library)}\n`
      said[name] = [way.tries, ...(way.then ? [way.then] : [])].map(script => run(work, gitDir, given + script).said).join("\n")
      if (way.after) Bun.spawnSync(["/bin/sh", "-c", way.after], { cwd: app, env: { ...ENV, HOME: home } })
      // Then git there, outside the sandbox: what it shows, a commit, and a submodule checked out.
      for (const folder of [work, ...(way.submodule ? [join(app, "lib")] : [])]) {
        outside(folder, "status")
        outside(folder, "commit", "-q", "--allow-empty", "-m", "yours")
      }
      if (way.submodule) outside(app, "submodule", "update", "--checkout", "--force")
      if (existsSync(mark)) escaped.push(name)
    }
    if (escaped.length) console.log("What the commands said:\n" + escaped.map(name => `- ${name}: ${said[name]}`).join("\n"))
    expect(escaped).toEqual([])
    expect(readdirSync(marks)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// What keeps those leaves git working in the sandbox as ever: committing, branching, stashing and
// tagging in its folder or its worktree, and committing and fetching in a submodule. On Linux the
// repository gets what keeps names git would read from being made (a `commondir` naming itself, a
// `hooks` folder where it has none), which git outside reads as before.
test.skipIf(!canFence)("git works in the sandbox as ever in a repository kept so", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-works-")))
  try {
    const { library, repository, run, outside } = fenced(root)
    const main = repository("main", { submodule: true, before: "rm -rf .git/hooks" })
    const ran = run(main.work, main.git, [
      "set -e",
      "echo more >> README.md && git add README.md && git commit -q -m more",
      "git checkout -q -b topic && echo topic > topic.txt && git add topic.txt && git commit -q -m topic && git checkout -q main && git merge -q --no-edit topic",
      "echo change >> README.md && git stash -q && git stash pop -q && git checkout -q -- README.md",
      "git tag v1",
      `git -C lib commit -q --allow-empty -m in-lib && git -c protocol.file.allow=always -C lib fetch -q ${sh(library)} main`,
      "git log --oneline | wc -l | tr -d ' '",
    ].join("\n"))
    // (Only what it printed: macOS's git shim says on its own that it can't keep its cache here.)
    expect(ran.out).toBe("4")
    expect(ran.code).toBe(0)
    const tree = repository("tree", { worktree: true })
    const inTree = run(tree.work, tree.git, "set -e; echo wt >> README.md && git commit -q -am in-tree && git log --oneline -1 --format=%s")
    expect([inTree.code, inTree.out]).toEqual([0, "in-tree"])
    if (process.platform === "linux") {
      for (const gitDir of [main.git, join(main.git, "modules", "lib"), tree.git]) {
        expect(readFileSync(join(gitDir, "commondir"), "utf8")).toBe(".\n")
        for (const folder of ["hooks", "modules", "worktrees"]) expect(statSync(join(gitDir, folder)).isDirectory()).toBe(true)
        expect(readFileSync(join(gitDir, "config.worktree"), "utf8")).toBe("")
      }
    }
    // And outside, git reads them as before.
    const common = outside(main.work, "rev-parse", "--path-format=absolute", "--git-common-dir")
    expect(common.stdout.toString().trim()).toBe(main.git)
    expect(outside(tree.work, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.toString().trim()).toBe(tree.git)
    expect(outside(tree.app, "worktree", "list", "--porcelain").stdout.toString().split("\n").filter(line => line.startsWith("worktree ")).length).toBe(2)
    expect(outside(main.work, "status", "--porcelain").exitCode).toBe(0)
    expect(outside(main.work, "fsck", "--no-progress").exitCode).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// On Linux, where these are kept by a command's namespace: what can't be kept runs nothing, and a
// repository whose git files can't be made (a read-only checkout) runs as it is, told so once.
test.skipIf(!canFence || process.platform !== "linux")("on Linux, a repository whose git files can't be kept runs nothing, and one that can't be written is told so", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-unkept-")))
  try {
    const { repository, run } = fenced(root)
    const linked = repository("linked", { before: "mv .git/hooks ../hooks && ln -s ../../hooks .git/hooks" })
    expect(run(linked.work, linked.git, "echo ran")).toEqual({ code: 126, out: "", said: `This command can't run in the sandbox here: ${linked.git}/hooks is a link, which it can't keep as it is. Ask the user.` })
    const led = repository("led", { before: "cp -R .git ../elsewhere && echo ../../elsewhere > .git/commondir" })
    expect(run(led.work, led.git, "echo ran")).toEqual({ code: 126, out: "", said: `This command can't run in the sandbox here: ${led.git}/commondir leads git to another repository. Ask the user.` })
    // (git reads up to a NUL, the shell past it, which leads it home: neither is taken.)
    const nul = repository("nul", { before: "cp -R .git ../evil && printf '../../evil\\000/../app/.git' > .git/commondir" })
    expect(run(nul.work, nul.git, "echo ran").code).toBe(126)
    const tree = repository("tree", { worktree: true, before: "echo ../../../led/app/.git > .git/worktrees/wt/commondir" })
    expect(run(tree.work, tree.git, "echo ran").code).toBe(126)
    const fixed = repository("fixed", { before: "rm -rf .git/hooks && chmod a-w .git" })
    try {
      const note = `Note: git's own files in ${fixed.git} aren't kept from commands by Kuvo Code's sandbox (it can't add a hooks folder or commondir there).`
      const first = run(fixed.work, fixed.git, "echo ran")
      expect(first.code).toBe(0)
      expect(first.said.split("\n").sort()).toEqual([note, "ran"])
      expect(run(fixed.work, fixed.git, "echo ran")).toEqual({ code: 0, out: "ran", said: "ran" })
    } finally {
      chmodSync(fixed.git, 0o755)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
