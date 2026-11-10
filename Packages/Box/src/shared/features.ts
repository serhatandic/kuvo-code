// What this box answers, one name per route or group of routes a client might check, as
// `kuvo/info` says (PROTOCOL.md, "Features"). A name comes with what it names and never changes
// meaning. This Mac's box answers them all but `MACHINE_FEATURES`, and the Mac's own besides
// (`MAC_FEATURES`); scripts/route-shapes.sh writes the Mac app's copy (KuvoCode/Stores/BoxFeatures.swift)
// and the scenario both boxes are held to (Vectors/routes/features.json) from these.
//
// One name a line, in order (as `LC_ALL=C sort` has them), so branches that each add one merge
// without a conflict: git merges this file by union (.gitattributes), keeping the lines both added.
// So change nothing here but the names: an edit two branches both made to any other line is kept
// twice. test/features.test.ts fails on a list out of order or a name twice.

export const FEATURES = [
  "accounts.credentials",
  "accounts.ended",
  "accounts.found",
  "accounts.refresh",
  "agent-tools",
  "agents",
  "approval",
  "approval.default",
  "approval.fullAccess",
  "approval.held",
  "approval.reviewer",
  "approval.seen",
  "approval.stopped",
  "artifacts",
  "asks",
  "attention",
  "autopilot",
  "bots",
  "bots.edit",
  "bots.events",
  "bots.job",
  "bots.keys",
  "bots.make",
  "branch",
  "btw",
  "btw.threads",
  "config",
  "config.apply",
  "engine.restart",
  "engine.start",
  "file",
  "folders",
  "folders.files",
  "git",
  "git.backups",
  "git.changes.count",
  "git.merge",
  "git.pull-request",
  "git.pull-request.draft",
  "git.push",
  "goals",
  "groups",
  "groups.delete",
  "groups.edit",
  "groups.joinable",
  "groups.make",
  "groups.seats",
  "handoff",
  "integrations",
  "keys",
  "letters-read",
  "limits",
  "mcp.catalog",
  "moves",
  "moves.agents",
  "moves.check",
  "named",
  "personalities",
  "personalities.events",
  "phones",
  "phones.pair",
  "plugins.search",
  "programs",
  "projects",
  "providers.models",
  "queue",
  "queue.waits",
  "reviews",
  "reviews.parts",
  "reviews.scopes",
  "sandbox",
  "sandbox.asks",
  "sandbox.check",
  "search",
  "sessions.agents",
  "sessions.start",
  "shell.stop",
  "sign-in.return",
  "skills",
  "skills.trash",
  "update",
  "vault",
  "wakes",
  "wakes.edit",
  "wakes.events",
  "work",
  "work-queue",
  "work.elsewhere",
  "work.goals",
  "work.goals.apps",
  "work.goals.projects",
  "work.projects",
  "work.unanswering",
  "worktrees",
  "worktrees.events",
  "worktrees.where",
] as const;

/** One of them. */
export type Feature = (typeof FEATURES)[number];

/** Those only a machine's box answers: it updates itself, and starts an engine an older Mac's Stop
 * left down. Every other name, this Mac claims too (`BoxFeatures.swift`): a name for a route this
 * Mac's box doesn't answer (link/mac/relay.ts's `MAC_BOX_ROUTES`, or the app's) goes here. */
export const MACHINE_FEATURES = [
  "engine.start",
  "update",
] as const satisfies readonly Feature[];

/** What this Mac's box answers of them: all but a machine's own. */
export const MAC_BOX_FEATURES: readonly Feature[] = FEATURES.filter(name => !(MACHINE_FEATURES as readonly string[]).includes(name));
