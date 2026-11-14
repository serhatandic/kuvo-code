# The box

What runs on each of your computers beside the engine, the same on this Mac and on a Linux machine.
It's programs of ours, built from this one package:

- **the link** (`src/link`), built to `Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js`,
  which the Mac app puts on each machine and runs as this Mac's own box (`kuvo-link.js serve`): the
  relay, phones and peers, signed documents, mail, notices, updates, and the box's own routes;
- **the agents bridge** (`src/agents`), built to `KuvoCode/Resources/kuvo-agents.js`, which the
  app ships and each box runs with the engine's Bun: the coding agents, group chats and goals;
- **the browser's keeper and tools** (`src/browser`), built to `KuvoCode/Resources/kuvo-browser.js`,
  which each box runs with the engine's Bun: the browser agents use there, its live view, and the
  agents' browser tools.

The link and the agents bridge stay two processes. The link has to stay up while the engine or the agents bridge is down. It
runs the box's self-update, which replaces the agents bridge's files. And an older Mac starts the
agents bridge itself. What they say to each other is to be defined once, in `src/shared`.

The protocol is `Packages/KuvoLink/PROTOCOL.md`. Code that's there only for released Macs is marked
`COMPAT(<version> <item>)`: `scripts/compat.sh` lists it.

## Building

After changing anything in `src/link` or `src/shared`, run `scripts/build-box.sh` and commit
`kuvo-link.js` with it. It builds with the Bun CI has (1.4.2), so every computer builds the same
file, and CI fails when the file isn't what the sources build, byte for byte (`build-box.sh
--check`). Never bump the link's version (`src/link/version.ts`): `build-box.sh` writes a hash of
what it built in its place. After changing `src/agents` (or `src/shared`), run `scripts/build-agents.sh` and commit
`kuvo-agents.js`; its last line names what it was built from (those folders and this package's
`package.json` and lockfile, so a change to either needs it rebuilt too), which CI checks
(`build-agents.sh --check`). `bun run build` runs both. After changing `src/browser` (the
browser's keeper and the agents' browser tools), run `scripts/build-browser.sh` and commit
`KuvoCode/Resources/kuvo-browser.js`; CI and the box's suite fail when it isn't what the sources
build, byte for byte (`build-browser.sh --check`). Never bump its keeper's version (`KEEPER`): the
script writes a hash of the source in its place.

`bun install --frozen-lockfile` here, then `bun run check` type-checks the link with Node's types
(it must run on Node too) and the agents bridge with Bun's (`src/agents/tsconfig.json`, and
`test/agents`'s beside its tests: it runs only on Bun), and `bun test` runs the tests of both (`test/agents` for the agents bridge's). The lockfile is Bun 1.4.2's too, which
an older Bun refuses (`lockfile had changes`): install with that Bun, or with the engine of a demo,
perf or e2e copy, which is that Bun (`BUN_BE_BUN=1 <the copy's engine/<version>/opencode> install
--frozen-lockfile`), never the real Kuvo Code's.

In a debug build of the app, `KUVO_BOX_SCRIPT` can name `src/link/main.ts` itself, and
`KUVO_AGENTS_SCRIPT` `src/agents/main.ts`, which the engine's Bun runs as they are.

The bundle targets Node as well as Bun: the bridge's tests (`Packages/KuvoLink/Tests/Bridge`, `node
--test`) import it, and machines run it with the engine's Bun. So it uses Node's modules, never
Bun's own.

## Where things go

`src/link` is `kuvo-link.js`, every file of it type-checked (`bun run check`, and a test that none
says `@ts-nocheck`); `main.ts` is the command line, and each route's answer has a shape in
`src/shared/routes`, which both boxes are held to:

```
src/shared/      what both programs and the contract suite read: run/ records, features, documents,
                 mail between boxes, group chats' seat mail, link ⇄ agents bridge, notices, route shapes;
                 platform.ts, where macOS and Linux differ (processes, the folders a Mac asks about),
                 each side tested
src/link/
  main.ts        the command line (run, serve, setup, pair, leave, update, box …, selftest)
  home.ts state.ts files.ts   the box's folders, link.json, writing files
  crypto/        keys, Noise sessions and mail, signing
  relay/         frames, the host's sessions, the relay connection
  engine/        asking the engine and the agents bridge, its sessions, its events
  peers/         the other boxes: who they are, their agents and this box's, "&" names, mail,
                 group chats' seats
  documents/     what boxes copy between them: their format, the work of taking and giving them,
                 sending them
  letters/       agents' messages to agents on other boxes: the outbox, and those that come here
  phones.ts      paired phones
  bots/ personalities/   bots, and the personalities library (yours, and others' copies taken)
  server/        the route table (a path to its area, nothing else), forwarding to the engine and
                 who a prompt names with "&", the server on a Mac
  mac/           this Mac's box: its link on the relay, what its app asks of it, its notices, its
                 part among your other computers
  areas/         one module per route family: projects, worktrees, skills, integrations, wakes,
                 groups, config, accounts, asks, artifacts, folders, plugins…
  notices/ updates/ host-interface.ts keeper.ts
  compat/        what's only for released Macs, where it's a whole thing
src/agents/
  main.ts server.ts   the bridge: the engine's own API for the app, over HTTP
  sessions.ts store.ts turn.ts …   its sessions, kept, and a turn's run
  agents/        each coding agent: Claude Code, Codex, Cursor, Grok and Antigravity (the last
                 two through acp.ts, the Agent Client Protocol)
  groups/        group chats: their rules, store, runner, and peers on other boxes
  artifacts/     what agents made, for the Artifacts view
```
