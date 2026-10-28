// What this box answers, one name per route or group of routes a client might check, as
// `kuvo/info` says (PROTOCOL.md, "Features"). A name comes with what it names and never changes
// meaning. A Mac's list (PhoneLink's `features`) has the same but `engine.start` and `update`,
// and the Mac's own routes besides.

export const FEATURES = [
  "accounts.credentials", "accounts.ended", "accounts.found", "agents", "artifacts", "asks", "attention", "bots", "bots.edit", "bots.keys", "bots.make", "branch", "btw", "btw.threads", "config", "config.apply",
  "engine.restart", "engine.start", "file", "folders", "git", "goals", "groups", "groups.delete", "groups.edit", "groups.joinable", "groups.make", "groups.seats", "handoff", "integrations", "keys",
  "mcp.catalog", "named", "personalities", "plugins.search", "programs", "providers.models", "personalities.events", "phones", "phones.pair", "projects", "reviews", "reviews.scopes", "search", "sessions.agents", "shell.stop", "sign-in.return",
  "skills", "skills.trash", "update", "wakes", "wakes.edit", "wakes.events", "worktrees", "worktrees.events", "worktrees.where", "bots.events", "bots.job",
  "agent-tools", "sessions.start", "letters-read", "queue",
] as const;

/** One of them. */
export type Feature = (typeof FEATURES)[number];
