import "./safety"
import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HIDE, readOnlyHere, triedNamespace, UNSHARE } from "../src/link/fence/landlock"
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
  /** A way in Linux's sandbox doesn't close yet (PROTOCOL.md, "Sandbox"), which a Mac's does. */
  openOnLinux?: boolean
  /** One a Mac's doesn't (#422: its rules keep git's own files by their names, not where a link there
   * leads, nor what a repository's `commondir` already names), which Linux's does. */
  openOnMac?: boolean
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
  "a submodule's folder led to another repository": { submodule: true, tries: `cp -R "$G/modules/lib" evil && git config --file evil/config --unset core.worktree; git config --file evil/config core.fsmonitor "$FSMONITOR" && printf 'gitdir: %s\\n' "$PWD/evil" > lib/.git` },
  "a hook, its linked folder traded for one of its own": { before: "mv .git/hooks ../hooks-kept && ln -s ../../hooks-kept .git/hooks", tries: `rm "$G/hooks" && mkdir "$G/hooks" && printf '%s\\n' "$HOOK" > "$G/hooks/pre-commit" && chmod +x "$G/hooks/pre-commit"` },
  "its git settings, their link traded for a file of its own": { before: "mv .git/config ../config-kept && ln -s ../../config-kept .git/config", tries: `rm "$G/config" && cp "$G/../../config-kept" "$G/config" && printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> "$G/config"` },
  "its git settings, its folder made read-only first": { before: "rm -rf .git/hooks && chmod a-w .git", tries: `chmod u+w "$G"; printf '[core]\\n\\tfsmonitor = %s\\n' "$FSMONITOR" >> "$G/config"`, after: "chmod u+w .git" },
  "a submodule's folder led elsewhere, its hooks a link": { submodule: true, before: "mv .git/hooks ../hooks-kept && ln -s ../../hooks-kept .git/hooks", tries: `cp -R "$G/modules/lib" evil && git config --file evil/config --unset core.worktree; git config --file evil/config core.fsmonitor "$FSMONITOR" && printf 'gitdir: %s\\n' "$PWD/evil" > lib/.git` },
  "a submodule's folder traded for another": { submodule: true, openOnLinux: true, tries: `cp -R "$G/modules/lib" evil && git config --file evil/config --unset core.worktree; git config --file evil/config core.fsmonitor "$FSMONITOR" && mv lib lib-old && mkdir lib && printf 'gitdir: %s\\n' "$PWD/evil" > lib/.git` },
  // (A repository the launcher can't give what it lacks, which commands only read: every check
  // still runs there. A Mac's rules don't look where a link or a commondir already leads, #422.)
  "a submodule's hooks a link to its folder, its repository read-only whole": { submodule: true, openOnMac: true, before: "mv .git/modules/lib/hooks lib-hooks && ln -s ../../../lib-hooks .git/modules/lib/hooks && rm -rf .git/hooks && chmod a-w .git", tries: `printf '%s\\n' "$HOOK" > lib-hooks/post-checkout && chmod +x lib-hooks/post-checkout`, after: "chmod u+w .git" },
  "a common folder led into its folder, its repository read-only whole": { openOnMac: true, before: "rm -rf .git/hooks && cp -R .git evil && printf '../evil\\n' > .git/commondir && chmod a-w .git", tries: `git config core.fsmonitor "$FSMONITOR"`, after: "chmod u+w .git" },
  "a worktree's common folder led into its folder, its repository read-only whole": { worktree: true, openOnMac: true, before: "rm -rf .git/hooks && cp -R .git ../wt/evil && printf '%s\\n' \"$(cd ../wt && pwd -P)/evil\" > .git/worktrees/wt/commondir && chmod a-w .git", tries: `git config core.fsmonitor "$FSMONITOR"`, after: "chmod u+w .git" },
  "a worktree's submodule's folder led elsewhere, its repository read-only whole": { worktree: true, submodule: true, before: "git -c protocol.file.allow=always -C ../wt submodule update -q --init && rm -rf .git/hooks && chmod a-w .git", tries: `cp -R "$G/worktrees/wt/modules/lib" evil && git config --file evil/config --unset core.worktree; git config --file evil/config core.fsmonitor "$FSMONITOR" && printf 'gitdir: %s\\n' "$PWD/evil" > lib/.git`, after: "chmod u+w .git" },
  "a submodule's repository traded": { submodule: true, tries: `cp -R "$G/modules/lib" evil && git config --file evil/config core.fsmonitor "$FSMONITOR" && mv "$G/modules/lib" "$G/modules/lib-old" && mv evil "$G/modules/lib"` },
}

/** A sandbox of the box's own in `root`, with what the planted code makes where no command can write
 * (Kuvo Code's folder), so only code run outside the sandbox makes it. */
function fenced(root: string, sockets: string[] = []) {
  const kuvo = join(root, "kuvo")
  const home = join(root, "home")
  const marks = join(kuvo, "marks")
  mkdirSync(marks, { recursive: true })
  mkdirSync(home, { recursive: true })
  realFence(kuvo, sockets)
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
  /** `script` run in the sandbox, from a conversation at work in `work`, its repository `gitDir`. */
  const run = (work: string, gitDir: string, script: string) => {
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: work, env: { ...ENV, HOME: home, KUVO_FENCE_WORK: work, KUVO_FENCE_GIT: gitDir } })
    return { code: ran.exitCode, out: ran.stdout.toString().trim(), said: (ran.stdout.toString() + ran.stderr.toString()).trim() }
  }
  /** git outside the sandbox, as you'd run it. */
  const outside = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-c", "protocol.file.allow=always", ...args], { cwd, env: { ...ENV, HOME: home } })
  return { kuvo, home, marks, library, repository, run, outside }
}

test.skipIf(!canFence)("a command plants nothing git runs outside the sandbox in its repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-")))
  try {
    const { home, marks, library, repository, run, outside } = fenced(root)
    // (Commands do run in the sandbox: one can't write where the marks go.)
    expect(run(home, "", `touch ${sh(join(marks, "control"))}`).code).not.toBe(0)
    expect(existsSync(join(marks, "control"))).toBe(false)
    const escaped: string[] = []
    const said: Record<string, string> = {}
    for (const [name, way] of Object.entries(WAYS)) {
      const slug = name.replace(/[^a-z]+/g, "-")
      const { app, git: gitDir, work } = repository(slug, way)
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
    expect(escaped).toEqual(Object.entries(WAYS).filter(([, way]) => process.platform === "linux" ? way.openOnLinux : way.openOnMac).map(([name]) => name))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// What keeps those leaves git working in the sandbox as ever: committing, branching, stashing,
// tagging and rebasing in its folder or its worktree, committing and fetching in a submodule, and tidying every
// worktree's reflogs from the main checkout. On Linux the repository gets what keeps names git would
// read from being made (a `commondir` naming itself, empty `hooks`, `modules`, `worktrees` and
// `config.worktree` where it has none), which git outside reads as before.
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
      "git checkout -q -b onto HEAD~1 && echo onto > onto.txt && git add onto.txt && git commit -q -m onto && git rebase -q main && git checkout -q main",
      `git -C lib commit -q --allow-empty -m in-lib && git -c protocol.file.allow=always -C lib fetch -q ${sh(library)} main`,
      "git log --oneline | wc -l | tr -d ' '",
    ].join("\n"))
    // (Only what it printed: macOS's git shim says on its own that it can't keep its cache here.)
    expect(ran.out).toBe("4")
    expect(ran.code).toBe(0)
    const tree = repository("tree", { worktree: true })
    const inTree = run(tree.work, tree.git, "set -e; echo wt >> README.md && git commit -q -am in-tree && git log --oneline -1 --format=%s")
    expect([inTree.code, inTree.out]).toEqual([0, "in-tree"])
    // From the main checkout, with a worktree beside it, git tidies every worktree's reflogs.
    const tidied = run(tree.app, tree.git, "set -e; git reflog expire --all --expire=now && git gc -q --prune=now && echo tidied")
    expect([tidied.code, tidied.out]).toEqual([0, "tidied"])
    expect(existsSync(join(tree.git, "gc.log"))).toBe(false)
    if (process.platform === "linux") {
      for (const gitDir of [main.git, join(main.git, "modules", "lib"), tree.git]) {
        expect(readFileSync(join(gitDir, "commondir"), "utf8")).toBe("./\n")
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
    // (Another app's sockets, which each command's namespace hides: `apps/agent`.)
    const apps = join(root, "apps")
    mkdirSync(join(apps, "agent"), { recursive: true })
    writeFileSync(join(apps, "agent", "socket"), "")
    const { repository, run } = fenced(root, [join(apps, "agent")])
    expect(run(root, "", `ls -A ${sh(join(apps, "agent"))}`)).toEqual({ code: 0, out: "", said: "" })
    // A hooks folder or settings that's a link, which a command could trade for its own: nothing runs
    // there (and so where it leads isn't mounted anew, uncovering what's hidden in it).
    for (const [slug, before, name] of [
      ["above", `rm -rf .git/hooks && ln -s ${sh(apps)} .git/hooks`, "hooks"],
      ["linked", "mv .git/hooks ../hooks && ln -s ../../hooks .git/hooks", "hooks"],
      ["settings", "mv .git/config ../config && ln -s ../../config .git/config", "config"],
    ] as const) {
      const linked = repository(slug, { before })
      expect(run(linked.work, linked.git, `ls -A ${sh(join(apps, "agent"))}; echo ran`)).toEqual({ code: 126, out: "", said: `This command can't run in the sandbox here: ${linked.git}/${name} is a link, which it can't keep as it is. Ask the user.` })
    }
    const led = repository("led", { before: "cp -R .git ../elsewhere && echo ../../elsewhere > .git/commondir" })
    expect(run(led.work, led.git, "echo ran")).toEqual({ code: 126, out: "", said: `This command can't run in the sandbox here: ${led.git}/commondir leads git to another repository. Ask the user.` })
    // (git reads up to a NUL, the shell past it, which leads it home: neither is taken.)
    const nul = repository("nul", { before: "cp -R .git ../evil && printf '../../evil\\000/../app/.git' > .git/commondir" })
    expect(run(nul.work, nul.git, "echo ran").code).toBe(126)
    const tree = repository("tree", { worktree: true, before: "echo ../../../led/app/.git > .git/worktrees/wt/commondir" })
    expect(run(tree.work, tree.git, "echo ran").code).toBe(126)
    const fixed = repository("fixed", { before: "rm -rf .git/hooks && chmod a-w .git" })
    try {
      const note = `Note: git can't change its own files in ${fixed.git} from Kuvo Code's sandbox here (the sandbox couldn't add a hooks folder or commondir there, so commands only read it).`
      const first = run(fixed.work, fixed.git, "echo ran")
      expect(first.code).toBe(0)
      expect(first.said.split("\n").sort()).toEqual([note, "ran"])
      // (Read-only whole, though a command could give itself the right to write it.)
      expect(run(fixed.work, fixed.git, "chmod u+w .git 2>/dev/null; mkdir .git/hooks 2>/dev/null && echo wrote || echo kept")).toEqual({ code: 0, out: "kept", said: "kept" })
    } finally {
      chmodSync(fixed.git, 0o755)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// And where a folder can't be made read-only in a command's namespace (each command in a repository
// then refuses), the box finds so as it checks the sandbox, to say it (\`gaps\`: \`git\`), as it does
// on this machine's own unshare.
test.skipIf(process.platform !== "linux")("on Linux, the box finds whether a folder can be made read-only in a command's namespace", () => {
  const unshare = UNSHARE.find(each => existsSync(each))
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-ro-")))
  try {
    mkdirSync(join(root, "ns"))
    if (!unshare || !triedNamespace(join(root, "ns"))?.startsWith("/")) return
    expect([readOnlyHere(unshare, join(root, "ns")), readOnlyHere(unshare, join(root, "none"))]).toEqual([true, false])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Nor can a command still running steer those mounts: one that keeps swapping its repository's
// \`.git\` for a link (to the folder holding sockets each namespace hides) as later commands start
// never has where the link leads mounted anew (on \`.git\`, or where the swap takes that), nor gets
// them seen. (A race: each start is one try, many at once, of the namespace each command starts in,
// as the launcher starts it.)
test.skipIf(!canFence || process.platform !== "linux")("on Linux, a .git swapped for a link as commands start never has where it leads mounted, nor what's hidden seen", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-git-raced-")))
  let swapper: { kill(signal: NodeJS.Signals): void; exited: Promise<number> } | undefined
  try {
    const apps = join(root, "apps")
    mkdirSync(join(apps, "agent"), { recursive: true })
    writeFileSync(join(apps, "agent", "socket"), "")
    const { kuvo, repository, run } = fenced(root, [join(apps, "agent")])
    const raced = repository("raced", {})
    // (Given what the launcher gives a repository, as a command there first.)
    expect(run(raced.work, raced.git, "true").code).toBe(0)
    const unshare = UNSHARE.find(each => existsSync(each))!
    const fence = join(kuvo, "run", "fence")
    const id = (flag: string) => Bun.spawnSync(["id", flag]).stdout.toString().trim()
    symlinkSync(apps, join(raced.work, ".git-swap"))
    // (What swaps them, as fast as it can: renameat2's RENAME_EXCHANGE, through Bun's own FFI.)
    const swap = join(root, "swap.js")
    writeFileSync(swap, `import { dlopen, FFIType, ptr } from "bun:ffi"
const { symbols } = dlopen("libc.so.6", { renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 } })
const [a, b] = process.argv.slice(2).map(name => Buffer.from(name + "\\0"))
console.log(symbols.renameat2(-100, ptr(a), -100, ptr(b), 2) === 0 ? "swapping" : "can't")
for (;;) symbols.renameat2(-100, ptr(a), -100, ptr(b), 2)
`)
    const swapping = Bun.spawn([process.execPath, swap, join(raced.work, ".git"), join(raced.work, ".git-swap")], { stdout: "pipe", stderr: "ignore", env: { ...ENV, BUN_BE_BUN: "1" } })
    swapper = swapping
    expect(new TextDecoder().decode((await swapping.stdout.getReader().read()).value).trim()).toBe("swapping")
    const once = async () => {
      const ran = Bun.spawn([unshare, "-Urm", "/bin/sh", "-c", HIDE, unshare, id("-u"), id("-g"), id("-un"), join(fence, "ns"), join(fence, "sockets"), "", "", raced.work, raced.git, "", "/bin/sh", "-c", `ls -A ${sh(join(apps, "agent"))} .git/agent .git-swap/agent 2>/dev/null`], { cwd: raced.work, stdout: "pipe", stderr: "ignore", env: ENV })
      const out = await new Response(ran.stdout).text()
      return out.includes("socket") ? "seen" : `${await ran.exited}`
    }
    const ended: Record<string, number> = {}
    for (let round = 0; round < 250; round++) for (const end of await Promise.all(Array.from({ length: 16 }, once))) ended[end] = (ended[end] ?? 0) + 1
    console.log("How the tries ended:", ended)
    expect(ended.seen ?? 0).toBe(0)
  } finally {
    swapper?.kill("SIGKILL")
    await swapper?.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 600_000)
