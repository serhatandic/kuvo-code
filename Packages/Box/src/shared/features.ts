// What this box answers, one name per route or group of routes a client might check, as
// `kuvo/info` says (PROTOCOL.md, "Features"). A name comes with what it names and never changes
// meaning. A Mac's list (PhoneLink's `features`) has the same but `engine.start`, `update` and `browser`,
// and the Mac's own routes besides.

export const FEATURES = [
  "accounts.credentials", "accounts.ended", "accounts.found", "accounts.refresh", "agents", "artifacts", "asks", "attention", "bots", "bots.edit", "bots.keys", "bots.make", "branch", "btw", "btw.threads", "config", "config.apply",
  "engine.restart", "engine.start", "file", "folders", "folders.files", "git", "git.changes.count", "git.merge", "git.pull-request", "git.pull-request.draft", "git.push", "goals", "groups", "groups.delete", "groups.edit", "groups.joinable", "groups.make", "groups.seats", "handoff", "integrations", "keys",
  "mcp.catalog", "moves", "moves.agents", "moves.check", "named", "personalities", "plugins.search", "programs", "providers.models", "personalities.events", "phones", "phones.pair", "projects", "reviews", "reviews.parts", "reviews.scopes", "search", "sessions.agents", "shell.stop", "sign-in.return",
  "skills", "skills.trash", "update", "wakes", "wakes.edit", "wakes.events", "worktrees", "worktrees.events", "worktrees.where", "bots.events", "bots.job",
  "agent-tools", "sessions.start", "letters-read", "work.elsewhere", "queue", "queue.waits", "work", "work.projects", "work.goals", "work.goals.apps", "work.goals.projects", "work.unanswering", "autopilot", "vault", "sandbox", "sandbox.check", "sandbox.asks", "sandbox.reviews.whole", "approval", "approval.reviewer", "git.backups", "approval.fullAccess", "approval.held", "approval.default", "approval.seen", "approval.stopped", "limits", "work-queue", "work-queue.elsewhere", "browser",
] as const;

/** One of them. */
export type Feature = (typeof FEATURES)[number];
