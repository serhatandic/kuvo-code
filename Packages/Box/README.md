# The box

What runs on each of your computers beside the engine, the same on this Mac and on a Linux machine.
It's two programs of ours, built from this one TypeScript package:

- **the link** (`src/link`), built to `Packages/KuvoLink/Sources/KuvoLink/Resources/kuvo-link.js`,
  which the Mac app puts on each machine and runs as this Mac's own box (`kuvo-link.js serve`): the
  relay, phones and peers, signed documents, mail, notices, updates, and the box's own routes;
- **the agents bridge** (`Agents/src` for now, moving to `src/agents`), built to
  `KuvoCode/Resources/kuvo-agents.js`: the coding agents, group chats and goals.

They stay two processes. The link has to stay up while the engine or the agents bridge is down. It
runs the box's self-update, which replaces the agents bridge's files. And an older Mac starts the
agents bridge itself. What they say to each other is to be defined once, in `src/shared`.

The protocol is `Packages/KuvoLink/PROTOCOL.md`. Code that's there only for released Macs is marked
`COMPAT(<version> <item>)`: `scripts/compat.sh` lists it.

## Building

After changing anything in `src`, run `scripts/build-box.sh` and commit `kuvo-link.js` with it. It
builds with the Bun CI has (1.4.2), so every computer builds the same file, and CI fails when the
file isn't what the sources build, byte for byte (`build-box.sh --check`).

`bun install --frozen-lockfile` here, then `bun run check` type-checks what's typed (Node's types:
it must run on Node too), and `bun test` runs its own tests. The lockfile is Bun 1.4.2's too, which
an older Bun refuses (`lockfile had changes`): install with that Bun, or with a demo copy's engine,
which is that Bun (`BUN_BE_BUN=1 <the copy's engine/<version>/opencode> install --frozen-lockfile`).

In a debug build of the app, `KUVO_BOX_SCRIPT` can name `src/link/main.ts` itself, which the
engine's Bun runs as it is.

The bundle targets Node as well as Bun: the bridge's tests (`Packages/KuvoLink/Tests/Bridge`, `node
--test`) import it, and machines run it with the engine's Bun. So it uses Node's modules, never
Bun's own.

## Where things go

`src/link/main.ts` is today's `kuvo-link.js`, unchecked (`@ts-nocheck`). Its parts move out into
typed modules one at a time, each move passing every suite, until it's only the command line:

```
src/shared/      what both programs and the contract suite read: run/ records, features, documents,
                 mail between boxes, group chats' seat mail, link ⇄ agents bridge, notices, route shapes;
                 platform.ts, where macOS and Linux differ (processes, the folders a Mac asks about),
                 each side tested
src/link/
  main.ts        the command line (run, serve, setup, pair, leave, update, box …, selftest)
  crypto/        keys, Noise sessions and mail, signing
  relay/         frames, the host's sessions, the relay connection
  documents/ peers/ phones.ts state.ts
  server/        the route table (a path to its area, nothing else), forwarding to the engine, serve
  areas/         one module per route family: projects, worktrees, skills, integrations, bots, wakes,
                 groups, config, personalities, accounts, asks, artifacts, folders, plugins…
  notices/ updates/ host.ts mac-link.ts
  compat/        what's only for released Macs, where it's a whole thing
```
