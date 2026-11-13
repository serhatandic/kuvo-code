# #679 The update gate

Goal: someone coming from 0.5 to 0.7 or a beta keeps their data and work, and no client runs old
paths against an old box. The app brings each box up to date first, says "Updating…" meanwhile,
and only then uses it. The client-side COMPAT code for older boxes then goes.

## The version rule

A client checks names, never versions (PROTOCOL.md, "Features"). `BoxGate.required` in
KuvoClient (ClientSessions) lists the features this client uses with no fallback. A box whose
`kuvo/info` `features` lack any of them (or that has no `kuvo/info`) is **older than the app
needs**. Today the list is `agent-tools.own`, `folders.tree`, `git.branches`, `git.merge`,
`git.pull-request`, `git.status`, `models.offered`, `sessions.list`, `sessions.models` and
`sessions.start.empty`. `sessions.list` (#668) came last, so a box that has it also has what came
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
    it carries, `POST kuvo/box/update {from: Contents/Resources/box-release}` (#333 piece 7). It
    then reads `kuvo/info` again every 10 s while the connection is wanted. The box takes the
    release at its next quiet moment.
  - **Newer by version but missing a name** (a dev build): it can't be updated from here, so the
    connection fails.
- **Mac, its own box** (`mac`). Most of the time it is the app's own, of this version. While an
  older app's keeper still runs it (`keeperMakesWay`, which lasts until the work under way ends),
  the app reads its `kuvo/info`. If that's missing a name, `BoxClient` refuses every route to
  `mac` except `kuvo/info` and `kuvo/update`. The refusal is local, a 503 with the gate's words,
  until the new keeper's box answers.
- **The guard**: `BoxClient.send` asks `BoxGates` (one store, behind a lock) whether a box is held.
  A machine is only held while it's connecting, which the connect step covers. The guard is what
  holds this Mac's box.
- **Phone**: `ComputerSettings.features`, read at each connect, feeds `BoxGate`. A computer that's
  held gets no request on the link except `kuvo/info`, and HostView shows the gate's state.

## States and wording (both apps, from `BoxGate.Words` in KuvoClient)

Only existing places are used: the machine's connection status (dot, row, waiting view) and the
sidebar or HostView slot where #668's "Sessions Need a Newer Kuvo Code" was. That state is folded
in here, so there is one way of saying it.

| State | Where | Words |
| --- | --- | --- |
| Updating (Mac, machine) | status row / waiting view | "Updating Kuvo Code…" / "Updating Kuvo Code on X…" |
| Updating (Mac, this Mac's box) | sidebar slot | "Updating…" + "Kuvo Code on this Mac finishes updating once the work running now ends." |
| Can't update (Mac) | existing failed state + Try Again | "Couldn't connect to X" + "Kuvo Code on X couldn't be updated: …. Try again, or update it from the Mac that set it up." (reason given) |
| Waiting (phone, a Mac) | HostView slot, HostRow | "Updating…" + "Update Kuvo Code on X to use it from this phone. Until then, nothing changes there." |
| Waiting (phone, machine) | same | "Updating…" + "X updates when a Mac with Kuvo Code connects to it, or by itself overnight." |

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
| 0.7 limits-merge | it also covers a computer the first box doesn't hear from now (relay down); PROTOCOL.md says that needs an answer first |
| 0.7 box-notices | it also covers a machine whose bridge isn't running (`telling: false`) |
| 0.7 model-rule (for now) | the gate makes its older-box half unreachable, but a catalog with no box (34 test files) still takes it; goes once those tests give theirs a box |
