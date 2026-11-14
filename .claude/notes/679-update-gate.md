# #679 The update gate

Goal: someone coming from 0.5 to 0.7 or a beta keeps their data and work, and no client runs old
paths against an old box. The app brings each box up to date first, says "Updating…" meanwhile,
and only then uses it. The client-side COMPAT code for older boxes then goes.

## The version rule

A client checks names, never versions (PROTOCOL.md, "Features"). `BoxGate.required` in
KuvoClient (ClientSessions) lists the features this client uses with no fallback. A box whose
`kuvo/info` `features` lack any of them (or that has no `kuvo/info`) is **older than the app
needs**. Today the list is `agent-tools.own`, `folders.tree`, `git.branches`, `git.merge`,
`git.pull-request`, `git.status`, `models.offered`, `sessions.list`, `sessions.models`,
`sessions.start.empty` and `typed` (#668 item 2, whose "needs a newer Kuvo Code for / and !" is
folded in). `sessions.list` (#668) came last, so a box that has it also has what came
before: plan limits' `rows`, `kuvo/updates` and Cursor's limits. A client adds a name here when it
drops the fallback for that name. PROTOCOL.md describes the rule so another client can do the
same.

## Where the gate sits

- **Mac, machines** (always over SSH, through `box route`). The gate is the last step of
  `MachineEngine.connect`. Connecting already installs this app's files on an older box. Then it
  reads `kuvo/info` through `box route`, which runs the files now there. If anything is missing,
  the machine doesn't become ready, so no store sends it anything:
  - **Updated over SSH**: the box version is older, so the files go in. The new link answers at
    once, so this only shows the step.
  - **Attached in place** (this Mac's box, set up by another Mac): the app offers it the release
    it carries, `POST kuvo/box/update {from: Contents/Resources/box-release}` (#333 piece 7). The
    connection then goes on, so its engine stays usable: a session waiting on you can be answered,
    and the box needs that quiet moment to take the release. Its box routes are held, and the app
    reads `kuvo/info` again every 10 s until it's current.
  - **Newer by version but missing a name** (a dev build): it can't be updated from here, so the
    connection fails.
- **Mac, its own box** (`mac`). Most of the time it is the app's own, of this version. While an
  older app's keeper still runs it (`keeperMakesWay`, which lasts until the work under way ends),
  the box is held at once. The app reads its `kuvo/info` every 10 s and lets it go once it has
  every name. Meanwhile `BoxClient` refuses every route to `mac`, locally, with a 503 in the gate's
  words. Two exceptions: the update routes, and `kuvo/agent-tools`, so the agents at work there
  keep their tools. A tool the old box lacks is told to the agent as "finishing an update".
- **The guard**: `BoxClient.send` asks `BoxGates` (one store, behind a lock) whether a box is held.
  A machine is only held while it's connecting, which the connect step covers. The guard is what
  holds this Mac's box.
- **Phone**: every `kuvo/info` read (and a 404 or 405 answer) feeds `LinkStore.noteGate`, and it's
  read at each connect. A held computer gets no request except the allowed routes. HostView and its
  row say **Waiting for an Update**: the phone can't update a computer, so it doesn't say
  "Updating…".
- **Let go**: when a `kuvo/info` read says the box has every name, including the session-list
  checks. **Try Again** on a machine reconnects it, which updates it.

## States and wording (both apps, from `BoxGate.Words` in KuvoClient)

Only existing places are used: the machine's connection status (dot, row, waiting view) and the
sidebar or HostView slot where #668's "Sessions Need a Newer Kuvo Code" was. That state is folded
in here, so there is one way of saying it.

| State | Where | Words |
| --- | --- | --- |
| Updating (Mac, machine) | status row / waiting view | "Updating Kuvo Code…" / "Updating Kuvo Code on X…" |
| Updating (Mac, this Mac's box) | sidebar slot | "Updating…" + "Kuvo Code on this Mac finishes updating once the work running now ends." |
| Can't update (Mac) | existing failed state + Try Again | "Couldn't connect to X" + "Kuvo Code on X couldn't be updated: …. Try again, or update it from the Mac that set it up." (reason given) |
| Waiting (phone, a Mac) | HostView slot, HostRow ("Waiting for update") | "Waiting for an Update" + "Kuvo Code on X is older than this iPhone's. Update it there, or let it finish an update under way. Nothing changes there meanwhile." |
| Waiting (phone, machine) | same | "Waiting for an Update" + "Kuvo Code on X is older than this iPhone's. It updates when a Mac with Kuvo Code connects to it, or by itself overnight. Nothing changes there meanwhile." |

The phone can't update a box (no SSH, and the box takes releases only from Kuvo Code on its own
computer), so it waits and says who updates it. It asks `kuvo/info` again each time it connects.
In no state does any client fall back to an old path.

## Update paths per kind of computer

| Computer | Path | Fails when |
| --- | --- | --- |
| This Mac's own box | the app's keeper takes over once the work under way ends (exists) | (doesn't: it waits) |
| A machine over SSH | the connect installs this app's files on an older box (exists) | SSH or install errors (existing failure) |
| This Mac's box attached in place | `kuvo/box/update {from}` with the app's `box-release` | no `box.update`, no release in a dev build, 409/422 refusal: the box's message |
| Any box (fallback) | it updates itself nightly from the latest release (exists) | n/a |

## COMPAT markers (scripts/compat.sh)

**Go** (a client talking to an older box; the gate covers them):

| Item | Where | Reason |
| --- | --- | --- |
| beta.1 git-older-box | BoxClient, GitBranches, ProjectChanges, ProjectFiles, ChangesPanel | git over SSH / "finishing an update" for boxes without `git.*`/`folders.tree`: gated |
| beta.1 merge-older-box | GitBranches | Merge into… on an older box: gated |
| beta.1 agent-tools-own | AgentMail, OwnToolsOnce | own tools run by the app for an older keeper box: gated |
| 0.7 cursor-box | UsageAccounts | Cursor read by the Mac for a box from before: older than `sessions.list` |
| 0.7 update-answer (client half) | OutsideAgents, ProgramUpdates | per-program updates for a box without `kuvo/updates`: older than `sessions.list` |
| phone: sessions.start.empty, sessions/read, update-answer | HostModel, InboxView | the same, on the phone |

**Stay**: data carried across the update, or the box's handling of older apps.

| Item | Reason |
| --- | --- |
| 0.7 mac-group-chats, machine-group-cache, mac-personalities, bot-keys-keychain, mac-moves-under-way, provider-compatibility, mac-git-settings, worktrees; beta.1 mac-letters | an older app's files or preferences on this Mac, taken in once |
| 0.7 settings, box-branch-prefix, agents-runtime; beta.1 outbox, mac-agents | an older Mac's files on a machine, adopted or cleaned once |
| 0.7 files, keeper, visits, engine-stop, leave-running, bot-json-job, limits-own-numbers, update-answer (box half), no-boxes-json | the box meeting an older Mac, which may still connect (and the Mac's side of the same files: `bin/.own`, `tolerates`, Start) |
| beta.1 peers-list, connected, deleted-bots, box-read-change, mac-moves, worktree-prefix | the box meeting a beta.1 Mac |
| limits merge (not compat since #702: plain comments; a client's own merge, left to move to the box) | it also covers a computer the first box doesn't hear from now, and a held box's older bridge without `rows` |
| 0.7 box-notices | it also covers a machine whose bridge isn't running (`telling: false`) |

## After the separate review
- A held box still gets its engine (`api/…`), its coding agents' bridge (`kuvo/agents/…`), its agents'
  tool calls, and what answers a waiting session: its asks and Auto's decisions. This is the same on
  both apps, so a session waiting on you can be answered.
- The attached box's follow reads `kuvo/update` on every pass.
  - When it's blocked, its engine is stopped on purpose, or taking the update failed, it fails with
    the box's own reason.
  - When the offer is gone and nothing is under way, it offers the release again.
  - When `kuvo/info` doesn't answer, it's held and asked again, never let through.
- This Mac's own box is held whenever another version's keeper runs it, and looked at again as soon
  as its box answers at a new address.
- A machine updates itself overnight only when its `kuvo/info` lists `update`; a 0.7 machine can't.
- A phone release must not ship before a Mac release whose box has every required name.
- The phone dropped its checks for names the gate implies. Queued phone removals stay, as data carried
  across the update (COMPAT).
