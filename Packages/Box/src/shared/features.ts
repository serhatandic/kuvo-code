// What this box answers, one name per route or group of routes a client might check, as
// `kuvo/info` says (PROTOCOL.md, "Features"). A name comes with what it names and never changes
// meaning. A Mac's list (PhoneLink's `features`) has the same but `engine.start` and `update`,
// and the Mac's own routes besides.

export const FEATURES = [
  "accounts.credentials", "accounts.ended", "agents", "artifacts", "asks", "attention", "bots", "bots.edit", "bots.keys", "bots.make", "btw", "config", "config.apply",
  "engine.restart", "engine.start", "file", "folders", "goals", "groups", "groups.delete", "groups.edit", "groups.joinable", "groups.make", "groups.seats", "handoff", "integrations", "keys",
  "mcp.catalog", "named", "personalities", "plugins.search", "personalities.events", "phones", "phones.pair", "projects", "reviews", "sessions.agents", "shell.stop", "sign-in.return",
  "skills", "skills.trash", "update", "wakes", "wakes.edit", "wakes.events", "worktrees", "worktrees.events", "worktrees.where", "bots.events", "bots.job",
] as const;

/** One of them. */
export type Feature = (typeof FEATURES)[number];
