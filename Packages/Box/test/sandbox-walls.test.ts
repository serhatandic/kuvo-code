import "./safety"
import { ownPath } from "../../KuvoLink/Tests/Bridge/test-safety.js"
import { expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { type FencePolicy, xdgPersonal } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// Walls only for catastrophes: a command adds and changes files anywhere in your home, but never
// deletes or moves one there (only in its project, temporary folders and caches); never writes
// what runs later outside the sandbox; and your personal folders only take new files on a Mac
// (only read on Linux), but for a project inside one.

const mac = process.platform === "darwin"

// Each test starts Bun for the box's policy and runs commands in a real sandbox, waiting on them:
// 2 to 4 s on a quiet machine, and over Bun's 5 s when it is busy, where Bun then stops the process
// being waited on and the test sees nothing. So a busy machine gets as long as the work takes.
setDefaultTimeout(30_000)

/** The box's policy as it'd be for a home folder of the test's own, its own folder in it, run as the
 * box runs it (in a process of its own, with HOME there). */
function policyIn(home: string, path = process.env.PATH ?? ""): FencePolicy {
  const asStarted = Bun.spawnSync([process.execPath, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy"))}; console.log(JSON.stringify(fencePolicy()))`],
    { env: { ...process.env as Record<string, string>, HOME: home, PATH: path, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", XDG_CACHE_HOME: "", KUVO_OWN_XDG_CACHE_HOME: "" } })
  expect(asStarted.exitCode, asStarted.stderr.toString()).toBe(0)
  return JSON.parse(asStarted.stdout.toString())
}

/** `onPath`: folders in the home, made and put on PATH as the box starts. */
function walled(root: string, more: Partial<FencePolicy> = {}, onPath: string[] = []) {
  const kuvo = join(root, "kuvo")
  const home = join(root, "home")
  mkdirSync(kuvo, { recursive: true })
  mkdirSync(home, { recursive: true })
  for (const folder of onPath) mkdirSync(join(home, folder), { recursive: true })
  const policy = policyIn(home, [...onPath.map(folder => join(home, folder)), process.env.PATH ?? ""].join(":"))
  expect(policy.homeWrites).toContain(home)
  // (The box's rules for your account's home, and the one HOME names: here, as the test's own.)
  const escape = (text: string) => text.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")
  // (The test's own home may be inside your account's, as on a machine whose temporary folder is.)
  const within = (each: string, top: string) => each === top || each.startsWith(top + "/")
  const mine = (paths: string[] | undefined) => [...new Set((paths ?? []).map(each => !within(each, home) && within(each, policy.home) ? home + each.slice(policy.home.length) : each)
    .filter(each => each === home || each.startsWith(home + "/")))]
  const patterns = [...new Set((policy.readOnlyPatterns ?? []).map(each => each.replace(`^${escape(policy.home)}/`, `^${escape(home)}/`)).filter(each => each.startsWith(`^${escape(home)}/`)))]
  // (Only what's in the test's home: the rest of this computer's temporary folders, which the test's
  // folder is in, aren't written.)
  realFence(kuvo, [], {
    writable: ["/dev", ...mine(policy.writable)], readOnly: mine(policy.readOnly), readOnlyPatterns: patterns,
    homeWrites: mine(policy.homeWrites), homeKept: mine(policy.homeKept), homeOpen: mine(policy.homeOpen), personal: mine(policy.personal), secrets: mine(policy.secrets),
    ...more,
  })
  const run = (project: string, script: string, env: Record<string, string> = {}) => {
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project, ...env } })
    return ran.stdout.toString() + ran.stderr.toString()
  }
  return { kuvo, home, policy, run }
}

/** A server listening on a socket at `where`, as another app's would. */
async function listening(where: string): Promise<Server> {
  const server = createServer()
  await new Promise<void>((done, failed) => { server.once("error", failed); server.listen(where, done) })
  return server
}

const tries = (label: string, command: string) => `if ( ${command} ) >/dev/null 2>&1; then echo "${label}: allowed"; else echo "${label}: refused"; fi`
const outcomes = (out: string) => Object.fromEntries(out.trim().split("\n").filter(line => /: (allowed|refused)$/.test(line)).map(line => line.split(": ")))

function files(home: string, names: Record<string, string>) {
  for (const [name, text] of Object.entries(names)) {
    mkdirSync(dirname(join(home, name)), { recursive: true })
    writeFileSync(join(home, name), text)
  }
}

test.skipIf(!canFence)("a command adds and changes files in your home, but never deletes or moves them there", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "Projects", "app")
    mkdirSync(project, { recursive: true })
    // (A tool's cache that's there: on Linux, a folder new at the top of your cache folder can't be made.)
    files(home, { ".config/tool/state.json": "{}\n", "Projects/old-site/index.html": "<p>kept</p>\n", "notes.txt": "mine\n", ".cache/tool/old": "x\n" })
    const out = run(project, [
      tries("new file in a tool's settings", `mkdir -p ${home}/.config/tool/more && echo '{"a":1}' > ${home}/.config/tool/more/new.json`),
      tries("changes a tool's settings", `echo '{"b":2}' > ${home}/.config/tool/state.json`),
      tries("deletes another project", `rm -rf ${home}/Projects/old-site`),
      tries("deletes a file in your home", `rm ${home}/notes.txt`),
      tries("moves a file in your home", `mv ${home}/notes.txt ${home}/notes-moved.txt`),
      tries("deletes in its project", `echo x > gone.txt && rm gone.txt`),
      tries("deletes in a cache", `rm ${home}/.cache/tool/old && mkdir ${home}/.cache/tool/new && rm -r ${home}/.cache/tool/new`),
      ...(mac ? [tries("closes off your home", `chmod 000 ${home}`)] : []),
    ].join("\n"))
    expect(outcomes(out)).toEqual({
      "new file in a tool's settings": "allowed",
      "changes a tool's settings": "allowed",
      "deletes another project": "refused",
      "deletes a file in your home": "refused",
      "moves a file in your home": "refused",
      "deletes in its project": "allowed",
      "deletes in a cache": "allowed",
      ...(mac ? { "closes off your home": "refused" } : {}),
    })
    expect(readFileSync(join(home, "Projects/old-site/index.html"), "utf8")).toBe("<p>kept</p>\n")
    expect(readFileSync(join(home, "notes.txt"), "utf8")).toBe("mine\n")
    expect(readFileSync(join(home, ".config/tool/state.json"), "utf8")).toBe('{"b":2}\n')
    if (mac) expect(statSync(home).mode & 0o777).not.toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!canFence)("a command never writes what runs later outside the sandbox, anywhere in your home", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-later-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    mkdirSync(project, { recursive: true })
    const there = [".zshrc", ".bashrc", ".profile", ".gitconfig", ".ssh/config", ".claude/settings.json", ".codex/config.toml",
      ".config/fish/config.fish", ".local/bin/tool", ".config/git/config", ".vscode/extensions/x/main.js",
      ...(mac ? ["Library/LaunchAgents/run.plist", "Library/Python/3.12/lib/python/site-packages/x.pth"]
        : [".config/systemd/user/run.service", ".config/autostart/run.desktop", ".local/lib/python3.12/site-packages/x.pth"])]
    files(home, Object.fromEntries(there.map(name => [name, "kept\n"])))
    const out = run(project, there.map(name => tries(name, `echo planted >> ${join(home, name)}`)).join("\n"))
    expect(outcomes(out)).toEqual(Object.fromEntries(there.map(name => [name, "refused"])))
    for (const name of there) expect(readFileSync(join(home, name), "utf8")).toBe("kept\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// What's under ~/Library on a Mac runs by itself (launchd's agents, plugins), but for its caches,
// logs and Xcode's builds, which tools write all the time.
test.skipIf(!canFence || !mac)("on a Mac, ~/Library is kept but for its caches, logs and Xcode's builds", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-library-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    for (const folder of [project, join(home, "Library", "Caches"), join(home, "Library", "Logs"), join(home, "Library", "Developer"), join(home, "Library", "Application Support")]) mkdirSync(folder, { recursive: true })
    const out = run(project, [
      tries("a launch agent", `mkdir -p ${home}/Library/LaunchAgents && echo x > ${home}/Library/LaunchAgents/evil.plist`),
      tries("an app's support folder", `echo x > ${home}/Library/Application\\ Support/x.txt`),
      tries("a cache", `mkdir -p ${home}/Library/Caches/tool && echo x > ${home}/Library/Caches/tool/f && rm -rf ${home}/Library/Caches/tool`),
      tries("a log", `echo x > ${home}/Library/Logs/tool.log`),
      tries("Xcode's builds", `mkdir -p ${home}/Library/Developer/Xcode/DerivedData/x && rm -rf ${home}/Library/Developer/Xcode/DerivedData/x`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "a launch agent": "refused", "an app's support folder": "refused", "a cache": "allowed", "a log": "allowed", "Xcode's builds": "allowed" })
    expect(existsSync(join(home, "Library", "LaunchAgents", "evil.plist"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!canFence)("your personal folders only take new files on a Mac, and are only read on Linux, but for a project inside one", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-personal-")))
  try {
    const { home, run } = walled(root)
    files(home, { "Documents/budget.txt": "1000\n", "Documents/site/index.html": "old\n", "Downloads/report.pdf": "pdf\n" })
    const project = join(home, "Documents", "site")
    const elsewhere = join(home, "app")
    mkdirSync(elsewhere, { recursive: true })
    const out = run(elsewhere, [
      tries("saves a new file", `echo new > ${home}/Documents/summary.txt`),
      tries("copies a file in", `cp ${home}/Downloads/report.pdf ${home}/Documents/report-copy.pdf`),
      tries("overwrites a document", `echo 0 > ${home}/Documents/budget.txt`),
      tries("appends to a document", `echo 0 >> ${home}/Documents/budget.txt`),
      tries("replaces a document", `echo 0 > ${home}/Documents/.b.tmp; mv -f ${home}/Documents/.b.tmp ${home}/Documents/budget.txt`),
      tries("deletes a document", `rm ${home}/Documents/budget.txt`),
      tries("deletes a download", `rm ${home}/Downloads/report.pdf`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({
      "saves a new file": mac ? "allowed" : "refused",
      "copies a file in": mac ? "allowed" : "refused",
      "overwrites a document": "refused",
      "appends to a document": "refused",
      "replaces a document": "refused",
      "deletes a document": "refused",
      "deletes a download": "refused",
    })
    expect(readFileSync(join(home, "Documents/budget.txt"), "utf8")).toBe("1000\n")
    expect(readFileSync(join(home, "Downloads/report.pdf"), "utf8")).toBe("pdf\n")
    if (mac) expect(readFileSync(join(home, "Documents/report-copy.pdf"), "utf8")).toBe("pdf\n")
    // Its own project, in Documents: its own to change and delete in.
    const inProject = run(project, [
      tries("changes its project", `echo new > index.html`),
      tries("deletes in its project", `echo x > gone.txt && rm gone.txt`),
    ].join("\n"))
    expect(outcomes(inProject)).toEqual({ "changes its project": "allowed", "deletes in its project": "allowed" })
    expect(readFileSync(join(project, "index.html"), "utf8")).toBe("new\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!canFence)("a command sets files' times and unpacks archives in its project, its temporary folder and your home", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-times-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    mkdirSync(project, { recursive: true })
    files(home, { "app/src/a.txt": "a\n", "notes.txt": "mine\n" })
    const out = run(project, [
      tries("touches in its project", `touch src/a.txt`),
      tries("unpacks in its project", `tar -cf pack.tar src && mkdir out && tar -xpf pack.tar -C out && rm -r out pack.tar`),
      tries("unpacks in its temporary folder", `t="\${TMPDIR:-/tmp/}unpack" && mkdir -p "$t" && tar -cf "$t/pack.tar" src && tar -xpf "$t/pack.tar" -C "$t" && rm -r "$t"`),
      tries("touches a file in your home", `touch ${home}/notes.txt`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "touches in its project": "allowed", "unpacks in its project": "allowed", "unpacks in its temporary folder": "allowed", "touches a file in your home": "allowed" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!canFence)("a conversation in your home itself still keeps the walls", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-home-")))
  try {
    const { home, run } = walled(root)
    files(home, { ".zshrc": "kept\n", "Documents/budget.txt": "1000\n", "notes/scratch.txt": "x\n", ...(mac ? { "Library/LaunchAgents/old.plist": "kept\n" } : {}) })
    const out = run(home, [
      tries("deletes in its folder", `rm notes/scratch.txt`),
      tries("a shell's start-up file", `echo planted >> .zshrc`),
      tries("overwrites a document", `echo 0 > Documents/budget.txt`),
      tries("deletes a document", `rm Documents/budget.txt`),
      ...(mac ? [tries("a launch agent", `echo x > Library/LaunchAgents/evil.plist`)] : []),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "deletes in its folder": "allowed", "a shell's start-up file": "refused", "overwrites a document": "refused", "deletes a document": "refused",
      ...(mac ? { "a launch agent": "refused" } : {}) })
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("kept\n")
    expect(readFileSync(join(home, "Documents/budget.txt"), "utf8")).toBe("1000\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!canFence)("a conversation whose folder is inside a wall writes its own folder, and nothing else there", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-inside-")))
  try {
    const { home, run } = walled(root)
    files(home, { ".config/nvim/init.lua": "old\n", ".config/nvim/lua/old.lua": "x\n", ".zshrc": "kept\n", ".config/fish/config.fish": "kept\n" })
    const out = run(join(home, ".config", "nvim"), [
      tries("changes its folder", `echo new > init.lua`),
      tries("deletes in its folder", `rm lua/old.lua`),
      tries("a shell's start-up file", `echo planted >> ${home}/.zshrc`),
      tries("another tool's settings", `echo planted >> ${home}/.config/fish/config.fish`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "changes its folder": "allowed", "deletes in its folder": "allowed", "a shell's start-up file": "refused", "another tool's settings": "refused" })
    expect(readFileSync(join(home, ".config/nvim/init.lua"), "utf8")).toBe("new\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Other apps' sockets in folders commands write (SSH's shared connections named by host in /tmp, an
// editor's server in your temporary folder, an app's own folder of them) are never removed, nor the
// folders that hold them moved, so a command never makes one its own or reaches one by a name the
// rules don't know; the other files there are the command's to change, by any means.
test.skipIf(!canFence || !mac)("on a Mac, other apps' sockets and the folders holding them stay, and the files beside them don't", async () => {
  // (A short folder: a socket's whole path fits in 104 characters.)
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sock-")))
  const servers: Server[] = []
  try {
    const project = join(root, "home", "a")
    const named = join(project, "s")
    const app = join(project, "app")
    const editors = join(project, "t")
    for (const folder of [named, join(app, "run"), join(editors, "nvim.me")]) mkdirSync(folder, { recursive: true })
    const escape = (text: string) => text.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")
    const { run, policy } = walled(root, { sockets: [app], socketPatterns: [`^${escape(named)}/`, `^${escape(editors)}/nvim\\.`], socketFolders: [`^${escape(editors)}/nvim\\.[^/]+$`] })
    // (The box's own: editors' and zellij's folders in your temporary folder are held.)
    const temporary = `/private/var/folders/ab/cd/T`
    for (const folder of ["nvim.me", "zellij-501", "emacs501"]) expect(policy.socketFolders?.some(pattern => new RegExp(pattern).test(`${temporary}/${folder}`))).toBe(true)
    for (const socket of [join(named, "cm"), join(app, "run", "s.sock"), join(editors, "nvim.me", "0")]) servers.push(await listening(socket))
    writeFileSync(join(named, "build.log"), "x\n")
    writeFileSync(join(app, "settings.json"), "{}\n")
    const out = run(project, [
      tries("removes a file beside sockets", `rm s/build.log`),
      tries("removes a socket named by a pattern", `rm s/cm`),
      tries("saves an app's settings by a new name and moves it into place", `echo '{"a":1}' > app/settings.json.new && mv app/settings.json.new app/settings.json`),
      tries("removes a socket in an app's folder", `rm app/run/s.sock`),
      tries("moves the folder holding it", `mv app/run app/elsewhere`),
      tries("moves an editor's server folder", `mv t/nvim.me t/other`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "removes a file beside sockets": "allowed", "removes a socket named by a pattern": "refused",
      "saves an app's settings by a new name and moves it into place": "allowed", "removes a socket in an app's folder": "refused",
      "moves the folder holding it": "refused", "moves an editor's server folder": "refused" })
    for (const socket of [join(named, "cm"), join(app, "run", "s.sock"), join(editors, "nvim.me", "0")]) expect(existsSync(socket)).toBe(true)
  } finally {
    for (const server of servers) server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// SSH's shared connections named by tokens (`ControlPath /tmp/ssh-%r/%h`), in a folder reached
// through a link as `/tmp` is on a Mac, are refused where they really are.
test.skipIf(!canFence || !mac)("on a Mac, SSH's shared connections named by tokens behind a linked folder stay", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sock-")))
  let server: Server | undefined
  try {
    const home = join(root, "home")
    const project = join(home, "a")
    mkdirSync(join(home, ".ssh"), { recursive: true })
    mkdirSync(join(project, "real", "cm-me"), { recursive: true })
    symlinkSync(join(project, "real"), join(root, "l"))
    writeFileSync(join(home, ".ssh", "config"), `Host *\n  ControlPath ${join(root, "l")}/cm-%r/%h\n`)
    const patterns = (policyIn(home).socketPatterns ?? []).filter(each => each.includes("kuvo-sock-"))
    const { run } = walled(root, { socketPatterns: patterns })
    server = await listening(join(project, "real", "cm-me", "host"))
    const out = run(project, [tries("removes it by its real path", `rm real/cm-me/host`), tries("removes it through the link", `rm ${join(root, "l")}/cm-me/host`)].join("\n"))
    expect(outcomes(out)).toEqual({ "removes it by its real path": "refused", "removes it through the link": "refused" })
  } finally {
    server?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

// Preferences go through cfprefsd, outside the files the walls keep: launchd's and login items'
// among them.
test.skipIf(!canFence || !mac)("on a Mac, a command reads preferences but never writes them", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-defaults-")))
  const domain = `run.kuvo.sandbox-test-${process.pid}`
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    mkdirSync(project, { recursive: true })
    const out = run(project, [tries("reads them", `defaults read -g AppleLocale || defaults read -g`), tries("writes them", `defaults write ${domain} planted -bool true`)].join("\n"))
    expect(outcomes(out)).toEqual({ "reads them": "allowed", "writes them": "refused" })
  } finally {
    // (cfprefsd keeps them in your own Library, whatever HOME says, where the old code wrote them.)
    rmSync(ownPath(join(userInfo().homedir, "Library", "Preferences", `${domain}.plist`)), { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

// On Linux, your personal folders are where `~/.config/user-dirs.dirs` says (renamed, translated),
// and one set to the home itself means none: the home is never taken for one.
// What runs from your PATH runs outside the sandbox later, whatever its folder's called; the caches
// tools keep inside one (pnpm's store in its folder on a Mac) are still written.
test.skipIf(!canFence)("a folder on your PATH is kept, whatever its name, but for tools' caches in it", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-path-")))
  try {
    const { home, run } = walled(root, {}, ["tools/bin", ...(mac ? ["Library/pnpm"] : [])])
    const project = join(home, "app")
    mkdirSync(project, { recursive: true })
    const out = run(project, [
      tries("a tool on your PATH", `echo planted > ${home}/tools/bin/git`),
      ...(mac ? [tries("pnpm's store", `mkdir -p ${home}/Library/pnpm/store/v10/b && echo x > ${home}/Library/pnpm/store/v10/b/f && rm -r ${home}/Library/pnpm/store/v10/b`)] : []),
      tries("a new file at the top of your home", `echo x > ${home}/new.txt`),
    ].join("\n"))
    // (Linux can't make a new file right in a folder that holds a wall: only in the folders there.)
    expect(outcomes(out)).toEqual({ "a tool on your PATH": "refused", ...(mac ? { "pnpm's store": "allowed" } : {}), "a new file at the top of your home": mac ? "allowed" : "refused" })
    expect(existsSync(join(home, "tools/bin/git"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A command can make what looks like a git repository anywhere it adds files, then a folder whose
// .git names it: its conversation's repository is only ever a folder named as one (`.git`, `….git`).
test.skipIf(!canFence)("a conversation's repository is never your home, a personal folder or another folder not named as one", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-git-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "Documents", "proj")
    files(home, { "notes.txt": "mine\n", "code/old/a.txt": "a\n", "Documents/budget.txt": "1000\n", "Documents/proj/.git/HEAD": "ref: refs/heads/main\n", "Documents/proj/sub/a.txt": "a\n" })
    mkdirSync(join(project, ".git", "objects"), { recursive: true })
    const at = (git: string, label: string, command: string) => run(join(project, "sub"), tries(label, command), { KUVO_FENCE_GIT: git })
    const out = [
      at(home, "deletes in your home", `rm ${home}/notes.txt`),
      at(join(home, "Documents"), "deletes a document", `rm ${home}/Documents/budget.txt`),
      at(join(home, "code"), "deletes another project", `rm -r ${home}/code/old`),
      at(join(project, ".git"), "writes its own repository", `echo x > ${project}/.git/objects/new && rm ${project}/.git/objects/new`),
    ].join("")
    expect(outcomes(out)).toEqual({ "deletes in your home": "refused", "deletes a document": "refused", "deletes another project": "refused", "writes its own repository": "allowed" })
    expect(readFileSync(join(home, "notes.txt"), "utf8")).toBe("mine\n")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // (Four fenced runs, each starting a sandbox: longer than a test is given unless it says.)
})

// Another project's git hooks and settings, and its coding agents', run outside the sandbox when you
// work there. (Linux's sandbox can't keep these: only the conversation's own.) Tools' caches clone
// and remove repositories of their own (Xcode's packages, cargo's).
test.skipIf(!canFence || !mac)("on a Mac, a command never writes another project's hooks or agents' settings, and tools still clone into their caches", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-others-")))
  try {
    const { home, run } = walled(root)
    files(home, { "other/.git/hooks/pre-commit.sample": "x\n", "other/.git/config": "[core]\n", "other/.claude/settings.json": "{}\n", "other/README.md": "x\n" })
    mkdirSync(join(home, "Library", "Developer"), { recursive: true })
    const project = join(home, "app")
    mkdirSync(project, { recursive: true })
    const out = run(project, [
      tries("another project's hook", `echo planted > ${home}/other/.git/hooks/pre-commit`),
      tries("another project's git settings", `echo planted >> ${home}/other/.git/config`),
      tries("another project's agent settings", `echo planted > ${home}/other/.claude/settings.json`),
      tries("another project's files", `echo more >> ${home}/other/README.md`),
      tries("a package checkout in Xcode's cache", `p=${home}/Library/Developer/Xcode/DerivedData/x/SourcePackages/checkouts/p && git init -q $p && rm -rf $p`),
    ].join("\n"))
    expect(outcomes(out)).toEqual({ "another project's hook": "refused", "another project's git settings": "refused", "another project's agent settings": "refused", "another project's files": "allowed",
      "a package checkout in Xcode's cache": "allowed" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Which worktrees a repository has, and its submodules, are named in `.git/worktrees` and
// `.git/modules`: moved away or traded for a link, another repository's would pass for its own (Auto
// counts a project's worktrees as its own, #422), and a worktree's `commondir` could name a copy
// whose settings run a program as you run git there. On a Mac, neither folder is made, moved or
// removed by a command; what's in them is git's to write as ever.
test.skipIf(!canFence || !mac)("on a Mac, a command never moves or replaces its repository's worktrees and modules folders", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-trees-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    files(home, { "app/.git/HEAD": "ref: refs/heads/main\n", "app/.git/worktrees/try/HEAD": "x\n", "app/.git/modules/lib/HEAD": "x\n", "other/.git/worktrees/theirs/HEAD": "x\n" })
    mkdirSync(join(project, ".git", "objects"), { recursive: true })
    const out = run(project, [
      tries("moves its worktrees folder", `mv ${project}/.git/worktrees ${project}/.git/wt`),
      tries("links another's in its place", `rm -rf ${project}/.git/worktrees; ln -s ${home}/other/.git/worktrees ${project}/.git/worktrees`),
      tries("moves its modules folder", `mv ${project}/.git/modules ${project}/.git/mods`),
      tries("writes in a worktree's own folder", `echo x > ${project}/.git/worktrees/try/HEAD`),
    ].join("\n"), { KUVO_FENCE_GIT: join(project, ".git") })
    expect(outcomes(out)).toEqual({ "moves its worktrees folder": "refused", "links another's in its place": "refused", "moves its modules folder": "refused", "writes in a worktree's own folder": "allowed" })
    expect(existsSync(join(project, ".git", "worktrees", "try", "HEAD"))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A submodule's repository is any folder below `.git/modules` (by a name with slashes, or one's own
// `modules`), and a linked worktree's submodules are below its own folder in `.git/worktrees`: none
// is moved out, nor another moved in with hooks and settings of its own, nor its settings written;
// what git keeps in each as it fetches and tidies up still comes and goes.
test.skipIf(!canFence || !mac)("on a Mac, a command never moves a submodule's repository in or out, however it's named, and git still fetches into one", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-modules-")))
  try {
    const { home, run } = walled(root)
    const project = join(home, "app")
    const git = join(project, ".git")
    files(home, { "app/.git/HEAD": "ref: refs/heads/main\n", "app/.git/modules/vendor/lib/HEAD": "x\n", "app/.git/modules/vendor/lib/objects/info/packs": "\n",
      "app/.git/modules/a/modules/b/HEAD": "x\n", "app/.git/worktrees/wt/modules/x/config": "[core]\n", "app/fake/hooks/post-checkout": "#!/bin/sh\n" })
    mkdirSync(join(git, "objects"), { recursive: true })
    mkdirSync(join(git, "modules", "vendor", "lib", "refs", "heads"), { recursive: true })
    const out = run(project, [
      tries("moves a module named with a slash out", `mv ${git}/modules/vendor/lib ${project}/lib-out`),
      tries("moves a nested module out", `mv ${git}/modules/a/modules/b ${project}/b-out`),
      tries("moves a folder in as a module", `mv ${project}/fake ${git}/modules/vendor/evil`),
      tries("writes a worktree's module settings", `echo '[core] fsmonitor = evil' >> ${git}/worktrees/wt/modules/x/config`),
      tries("fetches objects into a module", `mkdir ${git}/modules/vendor/lib/objects/ab && echo x > ${git}/modules/vendor/lib/objects/ab/cd && rm -r ${git}/modules/vendor/lib/objects/ab`),
      tries("keeps a module's branch", `mkdir -p ${git}/modules/vendor/lib/refs/heads/feature && echo 0 > ${git}/modules/vendor/lib/refs/heads/feature/x && rm -r ${git}/modules/vendor/lib/refs/heads/feature`),
    ].join("\n"), { KUVO_FENCE_GIT: git })
    expect(outcomes(out)).toEqual({ "moves a module named with a slash out": "refused", "moves a nested module out": "refused", "moves a folder in as a module": "refused",
      "writes a worktree's module settings": "refused", "fetches objects into a module": "allowed", "keeps a module's branch": "allowed" })
    expect(existsSync(join(git, "modules", "vendor", "evil"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// HOME names where tools look for what runs later, but never a folder that isn't a home.
test("HOME set to / or a folder above yours adds no home to keep", () => {
  const account = realpathSync(userInfo().homedir)
  for (const given of ["/", dirname(account)]) expect(policyIn(given).homeWrites).toEqual([account])
})

test("Linux's personal folders are the ones your desktop names, never your home", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-sandbox-walls-xdg-")))
  try {
    const home = join(root, "home")
    files(home, { ".config/user-dirs.dirs": ['XDG_DOCUMENTS_DIR="$HOME/Belgeler"', 'XDG_DESKTOP_DIR="$HOME/"', 'XDG_DOWNLOAD_DIR="/srv/downloads"', "# a note"].join("\n") + "\n" })
    const personal = xdgPersonal(home)
    expect(personal).toContain(join(home, "Belgeler"))
    expect(personal).toContain(join(home, "Music"))
    expect(personal).not.toContain(join(home, "Documents"))
    expect(personal.some(folder => folder === home || folder === home + "/")).toBe(false)
    expect(personal).not.toContain("/srv/downloads")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
