/** The coding agents a move carries the own conversation of (their agent's `conversationFiles` on
 * the agents bridge), by their models' provider: the rest start a new one where it goes, handed what
 * was said so far. Their names, as the bridge gives them. */
export const CARRIED_AGENTS = new Set(["claude-code", "codex-cli"]);
export const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex",
  cursor: "Cursor",
  "grok-cli": "Grok",
  antigravity: "Antigravity",
};
