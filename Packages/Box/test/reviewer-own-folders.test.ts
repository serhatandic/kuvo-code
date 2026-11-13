import "./safety"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canFence } from "./agents/support/fence"

// A conversation in Auto works in what's its own wherever Kuvo Code keeps it: its commands'
// temporary folder ($TMPDIR, which the box keeps in Kuvo Code's own temporary folder) and its
// folder there (a worktree in the engine's data, a bot's). As a bot's session building an app did
// overnight: its commands saved screenshots in $TMPDIR, its own Read tool looked at them, and
// Auto's reviewer refused each as "Kuvo Code's own folders", then paused it. What's really Kuvo
// Code's own (its keys, another conversation's temporary folder) stays refused, by code.
//
// In a box of its own, with the sandbox set up for real, so $TMPDIR is the one its commands get;
// the engine is a stand-in (its HTTP API, the small model's reply among it).

const link = join(import.meta.dir, "..", "src", "link")

/** Runs `steps` in a box of its own, its engine a stand-in where conversations are `sessions`
 * (`run(command, folder)`: a command through the sandbox's launcher, as the engine runs one;
 * `read`/`write`: the agent's own file tool asking for a file outside its folder; `ask`: the
 * agent asking to run a command outside the sandbox; `said`: what they found), and gives back
 * what they said, with the prompts the small model was asked. */
async function inBox(sessions: Record<string, string>, steps: string): Promise<{ said: Record<string, unknown>; prompts: string[] }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-reviewer-own-")))
  const prompts: string[] = []
  // (Each conversation's approval: Auto, unless it's named another.)
  const approvals: Record<string, string> = {}
  const calling: Record<string, unknown[]> = {}
  const asking: Record<string, unknown[]> = {}
  const engine = Bun.serve({
    port: 0,
    async fetch(request) {
      const route = new URL(request.url).pathname
      const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : null
      if (route === "/test/asking") {
        const { session, call, ask } = body as { session: string; call: unknown; ask: unknown }
        calling[session] = [call]
        asking[session] = [ask]
        return Response.json({ data: true })
      }
      if (route === "/test/session") {
        const { id, folder, approval } = body as { id: string; folder: string; approval?: string }
        sessions[id] = folder
        if (approval) approvals[id] = approval
        return Response.json({ data: true })
      }
      if (route === "/api/provider") return Response.json({ data: [{ id: "openai" }] })
      if (route === "/api/model") return Response.json({ data: [{ id: "gpt-6", providerID: "openai", name: "GPT-6" }, { id: "gpt-6-luna", providerID: "openai", name: "GPT-6 Luna" }] })
      if (route === "/api/experimental/generate") {
        prompts.push(String(body?.prompt))
        return Response.json({ data: { text: '{"decision": "allow", "reason": "Builds the app, as asked."}' } })
      }
      if (route === "/api/session") return Response.json({ data: [] })
      const [, id, rest] = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(route) ?? []
      if (!id || !sessions[id]) return Response.json({ message: "No such session." }, { status: 404 })
      if (rest === "/message") return Response.json({ data: [{ id: "msg_1", type: "assistant", content: calling[id] ?? [] }, { type: "user", text: "Build the LeafCheck app and check its screens" }] })
      if (rest === "/permission") return Response.json({ data: asking[id] ?? [] })
      if (rest === "/form") return Response.json({ data: [] })
      if (rest?.startsWith("/permission/")) return Response.json({ data: true })
      if (request.method === "POST") return Response.json({ data: true })
      const approval = approvals[id] ?? "auto"
      return Response.json({ data: {
        id, title: "LeafCheck", location: { directory: sessions[id] }, model: { providerID: "openai", id: "gpt-6" },
        permissions: approval === "auto" ? [] : [{ action: "shell", resource: "*", effect: "ask" }], metadata: { kuvo: { approval, applied: approval } },
        time: { created: Date.now(), updated: Date.now() },
      } })
    },
  })
  try {
    // (Laid out as a Mac's: the box's folder in the app's, beside your home.)
    for (const folder of ["app/box", "home"]) mkdirSync(join(root, folder), { recursive: true })
    const script = `
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const home = await import(${JSON.stringify(join(link, "home.ts"))});
      const fence = await import(${JSON.stringify(join(link, "fence", "state.ts"))});
      const reviewing = await import(${JSON.stringify(join(link, "work", "reviewing.ts"))});
      const outside = await import(${JSON.stringify(join(link, "fence", "outside.ts"))});
      const starting = await import(${JSON.stringify(join(link, "letters", "start.ts"))});
      const engine = { port: ${engine.port}, password: "pw" };
      fs.mkdirSync(path.dirname(home.ENGINE_FILE), { recursive: true });
      fs.writeFileSync(home.ENGINE_FILE, JSON.stringify({ pid: process.pid, port: engine.port, password: "pw", version: "test" }));
      const state = fence.setUpFence();
      if (!state.on && !fs.existsSync(path.join(fence.fenceFiles.folder, "ready"))) throw new Error("The sandbox didn't set up: " + JSON.stringify(state));
      const run = (command, folder) => spawnSync(fence.fenceFiles.launcher, ["-c", command], { cwd: folder, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, KUVO_FENCE_WORK: folder } });
      let asked = 0;
      const fileAsk = async (session, tool, file) => {
        const id = "per_" + ++asked;
        const call = { type: "tool", id: "call_" + id, name: tool, state: { input: { filePath: file } } };
        const ask = { id, action: "external_directory", resources: [path.join(path.dirname(file), "*")], source: { id: "call_" + id, messageID: "msg_1" } };
        await fetch("http://127.0.0.1:" + engine.port + "/test/asking", { method: "POST", body: JSON.stringify({ session, call, ask }) });
        const verdict = await reviewing.reviewPermission(engine, { type: "permission.asked", data: { id, sessionID: session, action: "external_directory" } });
        return verdict ? verdict.decision + (verdict.decision === "refuse" ? ": " + verdict.reason : "") : null;
      };
      const read = (session, file) => fileAsk(session, "read", file);
      const write = (session, file) => fileAsk(session, "write", file);
      const ask = async (session, folder, command) => (await outside.callSandboxTool("sandbox_ask", { command, why: "To build the app." }, { session, root: session, sessionName: "LeafCheck", folder })).text.split("\\n")[0];
      // An agent in Auto starting a session there: why it can't, if it can't.
      const start = async folder => (await starting.startSession({ task: "Build it.", folder }, starting.OUTSIDE, { readEngine: () => engine })).refused?.message ?? null;
      const conversation = (id, folder, approval) => fetch("http://127.0.0.1:" + engine.port + "/test/session", { method: "POST", body: JSON.stringify({ id, folder, approval }) });
      fs.mkdirSync(home.BOX_KEYS, { recursive: true });
      fs.writeFileSync(path.join(home.BOX_KEYS, "box.key"), "secret");
      const said = {};
      ${steps}
      console.log(JSON.stringify(said));
      // (The link's watchers would keep it going.)
      process.exit(0);`
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(root, "home"), KUVO_HOME: join(root, "app", "box"), KUVO_TEST_SANDBOX_ON: "1", BUN_BE_BUN: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, err).toBe(0)
    return { said: JSON.parse(out.trim().split("\n").at(-1) ?? "{}"), prompts }
  } finally {
    engine.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}

test.skipIf(!canFence)("in Auto, a conversation reads and writes its own temporary folder: what its commands saved there is its own, never Kuvo Code's", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-leafcheck-")))
  try {
    const { said, prompts } = await inBox({ ses_shots: project, ses_other: join(project, "other") }, `
      fs.mkdirSync(path.join(${JSON.stringify(project)}, "other"));
      // Its commands save screenshots in their temporary folder, as a simulator's do.
      const shot = run('mkdir -p "$TMPDIR/leafcheck-shots" && echo png > "$TMPDIR/leafcheck-shots/frame-01.png" && printf %s "$TMPDIR"', ${JSON.stringify(project)});
      if (shot.status !== 0) throw new Error(shot.stderr);
      const tmp = shot.stdout.replace(/\\/$/, "");
      said.inKuvo = tmp.startsWith(fs.realpathSync(home.K) + "/");
      // Its Read tool looks at them, and writes beside them, without the model.
      said.read = await read("ses_shots", path.join(tmp, "leafcheck-shots", "frame-01.png"));
      said.written = await write("ses_shots", path.join(tmp, "leafcheck-shots", "notes.md"));
      // A command it asks to run outside the sandbox there is the model's to judge, like any.
      said.ask = await ask("ses_shots", ${JSON.stringify(project)}, "ls " + path.join(tmp, "leafcheck-shots"));
      // Another conversation's temporary folder, and Kuvo Code's keys, are refused by code.
      const other = run('echo theirs > "$TMPDIR/theirs.txt" && printf %s "$TMPDIR"', path.join(${JSON.stringify(project)}, "other")).stdout.replace(/\\/$/, "");
      said.different = other !== tmp;
      said.othersRead = await read("ses_shots", path.join(other, "theirs.txt"));
      said.othersAsk = await ask("ses_shots", ${JSON.stringify(project)}, "cat " + path.join(other, "theirs.txt"));
      said.keys = await write("ses_shots", path.join(home.BOX_KEYS, "box.key"));
      said.keysAsk = await ask("ses_shots", ${JSON.stringify(project)}, "cat " + path.join(home.BOX_KEYS, "box.key"));
      // Nor does a conversation started in them make them its own.
      await conversation("ses_keys", home.BOX_KEYS);
      said.keysSession = await ask("ses_keys", home.BOX_KEYS, "cat ./box.key");
      // Its commands can't trade their temporary folder for a link into Kuvo Code's folders...
      said.swapped = run('t=\${TMPDIR%/}; cd / && rm -rf "$t" 2>/dev/null; [ -e "$t" ] || ln -s ' + home.BOX_KEYS + ' "$t" && [ -L "$t" ] && echo swapped', ${JSON.stringify(project)}).stdout.trim();
      said.movedIn = run('t=\${TMPDIR%/}; cd / && rm -rf "$t"; l=/tmp/kuvo-link-$$; ln -s ' + home.BOX_KEYS + ' "$l" && mv "$l" "$t" 2>/dev/null && [ -L "$t" ] && echo moved; rm -f "$l"', ${JSON.stringify(project)}).stdout.trim();
      said.stillFolder = !fs.lstatSync(tmp, { throwIfNoEntry: false })?.isSymbolicLink();
      // (Though it may take it away, as \`rm -rf $TMPDIR\` does, and make it again as a folder. On
      // Linux it's only emptied: in the command's namespace it's mounted in place, in a folder it can't
      // change (fence/landlock.ts's HIDE, since c923f4f6b), so it stays, as safe.)
      said.removed = run('rm -rf "$TMPDIR"; echo "rm $?"; mkdir "$TMPDIR" 2>/dev/null && echo again; [ -d "$TMPDIR" ] && [ ! -L "\${TMPDIR%/}" ] && [ -O "$TMPDIR" ] && echo "its own, with $(ls -A "$TMPDIR" | wc -l | tr -d " ") in it"', ${JSON.stringify(project)}).stdout.trim();
      // ...and one put there before the sandbox kept them from it isn't theirs: the reviewer doesn't
      // follow it, and the next command gets a folder of its own again.
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.symlinkSync(home.BOX_KEYS, tmp);
      said.linkedRead = await read("ses_shots", path.join(tmp, "box.key"));
      said.next = run('[ -L "\${TMPDIR%/}" ] && echo link; cat "$TMPDIR/box.key" 2>/dev/null || echo unreadable', ${JSON.stringify(project)}).stdout.trim();`)
    const refused = "refuse: It reaches Kuvo Code's own folders, which is never allowed."
    expect(said).toEqual({
      inKuvo: true, read: "allow", written: "allow", ask: "Ran outside the sandbox · Allowed by Auto's reviewer: Builds the app, as asked.",
      different: true, othersRead: refused, othersAsk: expect.stringMatching(/^Auto's reviewer refused: It reaches Kuvo Code's own folders/),
      keys: refused, keysAsk: expect.stringMatching(/^Auto's reviewer refused: It reaches Kuvo Code's own folders/),
      keysSession: expect.stringMatching(/^Auto's reviewer refused: It reaches Kuvo Code's own folders/),
      swapped: "", movedIn: "", stillFolder: true, removed: process.platform === "darwin" ? "rm 0\nagain\nits own, with 0 in it" : "rm 1\nits own, with 0 in it", linkedRead: refused, next: "unreadable",
    })
    // Only the command outside the sandbox went to the model.
    expect(prompts.length).toBe(1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!canFence)("in Auto, a conversation whose folder is in Kuvo Code's (a worktree in the engine's data) works there as anywhere, but none starts in the rest of Kuvo Code's", async () => {
  const { said, prompts } = await inBox({}, `
    // (A worktree where the engine keeps new ones, and its conversation.)
    fs.mkdirSync(path.join(home.ENGINE_DATA, "worktree", "leafcheck", "scripts"), { recursive: true });
    const tree = fs.realpathSync(path.join(home.ENGINE_DATA, "worktree", "leafcheck"));
    fs.writeFileSync(path.join(tree, "scripts", "build.sh"), "echo built\\n");
    await conversation("ses_tree", tree);
    // Its commands in the sandbox have it, and only it.
    const ran = run("sh ./scripts/build.sh; cat " + path.join(home.BOX_KEYS, "box.key") + " 2>/dev/null || echo hidden", tree);
    said.sandboxed = ran.stdout.trim();
    said.build = await ask("ses_tree", tree, "sh ./scripts/build.sh");
    said.named = await ask("ses_tree", tree, "ls " + tree);
    // Out of it, Kuvo Code's own are refused by code.
    said.up = await ask("ses_tree", tree, "cat ../../../../box/keys/box.key");
    // An agent can't start a session in Kuvo Code's keys, whose engine would read them without
    // asking; one in a worktree there, it can.
    said.startKeys = await start(home.BOX_KEYS);
    said.startTree = /can't start a session/.test(await start(tree) ?? "");`)
  const allowed = "Ran outside the sandbox · Allowed by Auto's reviewer: Builds the app, as asked."
  expect(said).toEqual({
    sandboxed: "built\nhidden", build: allowed, named: allowed, up: expect.stringMatching(/^Auto's reviewer refused: It reaches Kuvo Code's own folders/),
    startKeys: expect.stringMatching(/^An agent in Auto can't start a session in .*: its commands would reach Kuvo Code's own folders\. Ask the user to start it there\.$/),
    startTree: false,
  })
  expect(prompts.length).toBe(2)
}, 60_000)

test.skipIf(!canFence)("asks waiting as the box starts again are taken up and listed, and one gone before it's read is listed gone (sandbox.reviews.whole, sandbox.reviews.settled)", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-waiting-")))
  try {
    const { said } = await inBox({ ses_wait: project }, `
      // Asked while the box was starting again: its event went by unheard.
      const file = path.join(${JSON.stringify(project)}, "notes.md");
      const call = { type: "tool", id: "call_w", name: "write", state: { input: { filePath: file } } };
      const waiting = { id: "per_w", action: "external_directory", resources: [${JSON.stringify(project)} + "/*"], source: { id: "call_w", messageID: "msg_1" } };
      await fetch("http://127.0.0.1:" + engine.port + "/test/asking", { method: "POST", body: JSON.stringify({ session: "ses_wait", call, ask: waiting }) });
      said.before = reviewing.listAskReviews().find(each => each.id === "per_w")?.state ?? null;
      await reviewing.takeUpWaitingAsks(engine, ["ses_wait"]);
      said.after = reviewing.listAskReviews().find(each => each.id === "per_w")?.state ?? null;
      // Heard, but answered before the box could read it: its session doesn't ask it, so it's
      // listed gone, never left checked nor left for you.
      await reviewing.reviewPermission(engine, { type: "permission.asked", data: { id: "per_gone", sessionID: "ses_wait", action: "external_directory" } });
      said.gone = reviewing.listAskReviews().find(each => each.id === "per_gone")?.state ?? reviewing.listSettledReviews().find(each => each.id === "per_gone")?.state ?? null;
      // What the reviewer decided stays, for its mark.
      reviewing.settleAskReview("per_gone");
      reviewing.settleAskReview("per_w");
      said.listed = reviewing.listAskReviews().map(each => each.id);
    `)
    expect(said.before).toBeNull()
    expect(said.after).toBe("allowed")
    expect(said.gone).toBe("gone")
    expect(said.listed).toEqual(["per_w"])
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!canFence)("in Ask First and Accept Edits, a conversation's own tools read what its commands left in its temporary folder and the files sent with it, without asking you", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-leafcheck-")))
  try {
    const { said, prompts } = await inBox({}, `
      const project = ${JSON.stringify(project)};
      await conversation("ses_first", project, "askFirst");
      await conversation("ses_edits", project, "acceptEdits");
      const tmp = run('mkdir -p "$TMPDIR/shots" && echo png > "$TMPDIR/shots/frame-01.png" && printf %s "$TMPDIR"', project).stdout.replace(/\\/$/, "");
      said.first = await read("ses_first", path.join(tmp, "shots", "frame-01.png"));
      said.edits = await read("ses_edits", path.join(tmp, "shots", "frame-01.png"));
      // A screenshot, its name's space a narrow one, read by a name typed with a plain one (the
      // engine reads it in that name's place, #434).
      fs.writeFileSync(path.join(tmp, "shots", "Screenshot at 10.00.00\\u202fAM.png"), "png");
      said.screenshot = await read("ses_first", path.join(tmp, "shots", "Screenshot at 10.00.00 AM.png"));
      // A file you attached to it, kept in Kuvo Code's folders.
      const attached = path.join(home.K, "attachments", "ses_first", "a1b2c3d4", "plan.pdf");
      fs.mkdirSync(path.dirname(attached), { recursive: true });
      fs.writeFileSync(attached, "pdf");
      said.attached = await read("ses_first", attached);
      // Anything else still comes to you: writing there, reading elsewhere, another
      // conversation's files, and a link in its temporary folder that leads out of it.
      said.writes = await write("ses_first", path.join(tmp, "shots", "notes.md"));
      said.elsewhere = await read("ses_first", "/etc/hosts");
      const theirs = path.join(home.K, "attachments", "ses_edits", "e5f6a7b8", "theirs.txt");
      fs.mkdirSync(path.dirname(theirs), { recursive: true });
      fs.writeFileSync(theirs, "theirs");
      said.theirs = await read("ses_first", theirs);
      fs.symlinkSync(home.BOX_KEYS, path.join(tmp, "keys"));
      said.linked = await read("ses_first", path.join(tmp, "keys", "box.key"));`)
    expect(said).toEqual({ first: "allow", edits: "allow", screenshot: "allow", attached: "allow", writes: null, elsewhere: null, theirs: null, linked: null })
    expect(prompts.length).toBe(0)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}, 60_000)

test.skipIf(!canFence)("in Auto, the files sent with a conversation are its own: a command outside the sandbox that reads them is the model's to judge, another's are refused by code", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "kuvo-leafcheck-")))
  try {
    const { said, prompts } = await inBox({ ses_shots: project }, `
      const mine = path.join(home.K, "attachments", "ses_shots", "a1b2c3d4", "logo.png");
      const theirs = path.join(home.K, "attachments", "ses_other", "e5f6a7b8", "logo.png");
      for (const file of [mine, theirs]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "png");
      }
      said.mine = await ask("ses_shots", ${JSON.stringify(project)}, "sips -Z 64 " + mine + " --out icon.png");
      said.theirs = await ask("ses_shots", ${JSON.stringify(project)}, "cp " + theirs + " .");`)
    expect(said).toEqual({
      mine: "Ran outside the sandbox · Allowed by Auto's reviewer: Builds the app, as asked.",
      theirs: expect.stringMatching(/^Auto's reviewer refused: It reaches Kuvo Code's own folders/),
    })
    expect(prompts.length).toBe(1)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
}, 60_000)
