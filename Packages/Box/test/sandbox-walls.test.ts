import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FencePolicy } from "../src/link/fence/policy"
import { canFence, realFence } from "./agents/support/fence"

// Walls only for catastrophes: a command adds and changes files anywhere in your home, but never
// deletes or moves one there (only in its project, temporary folders and caches); never writes
// what runs later outside the sandbox; and your personal folders only take new files on a Mac
// (only read on Linux), but for a project inside one.

const mac = process.platform === "darwin"

/** The box's policy as it'd be for a home folder of the test's own, its own folder in it, run as the
 * box runs it (in a process of its own, with HOME there). */
function policyIn(home: string): FencePolicy {
  const asStarted = Bun.spawnSync([process.execPath, "-e", `import { fencePolicy } from ${JSON.stringify(join(import.meta.dir, "..", "src", "link", "fence", "policy"))}; console.log(JSON.stringify(fencePolicy()))`],
    { env: { ...process.env as Record<string, string>, HOME: home, BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", XDG_CACHE_HOME: "", KUVO_OWN_XDG_CACHE_HOME: "" } })
  expect(asStarted.exitCode, asStarted.stderr.toString()).toBe(0)
  return JSON.parse(asStarted.stdout.toString())
}

function walled(root: string) {
  const kuvo = join(root, "kuvo")
  const home = join(root, "home")
  mkdirSync(kuvo, { recursive: true })
  mkdirSync(home, { recursive: true })
  const policy = policyIn(home)
  expect(policy.homeWrites).toContain(home)
  // (The box's rules for your account's home, and the one HOME names: here, as the test's own.)
  const escape = (text: string) => text.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")
  const mine = (paths: string[] | undefined) => [...new Set((paths ?? []).map(each => each === policy.home || each.startsWith(policy.home + "/") ? home + each.slice(policy.home.length) : each)
    .filter(each => each === home || each.startsWith(home + "/")))]
  const patterns = [...new Set((policy.readOnlyPatterns ?? []).map(each => each.replace(`^${escape(policy.home)}/`, `^${escape(home)}/`)).filter(each => each.startsWith(`^${escape(home)}/`)))]
  // (Only what's in the test's home: the rest of this computer's temporary folders, which the test's
  // folder is in, aren't written.)
  realFence(kuvo, [], {
    writable: ["/dev", ...mine(policy.writable)], readOnly: mine(policy.readOnly), readOnlyPatterns: patterns,
    homeWrites: mine(policy.homeWrites), homeKept: mine(policy.homeKept), homeOpen: mine(policy.homeOpen), personal: mine(policy.personal), secrets: mine(policy.secrets),
  })
  const run = (project: string, script: string) => {
    const ran = Bun.spawnSync([join(kuvo, "bin", "kuvo-fence"), "-c", script], { cwd: project, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, KUVO_FENCE_WORK: project } })
    return ran.stdout.toString() + ran.stderr.toString()
  }
  return { kuvo, home, run }
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
