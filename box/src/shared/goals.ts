// What the agents' bridge (which keeps a conversation's goal) and the link (which holds its
// conversation while it's paused) both read of a goal.

/** The note of a goal you paused with its Pause (the agents' bridge's), which holds its
 * conversation as Stop does (the link's `goalHolds`): not one paused as you stopped a turn. */
export const PAUSED_BY_YOU = "You paused it.";
