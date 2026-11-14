// The names of the agent's own tools that letters/tools.ts lists among all of them (AGENT_TOOLS) as
// it loads. Their own module, with nothing imported: own-tools.ts, where they run, is in a ring of
// imports that comes back to tools.ts, so tools.ts entered from there found them not there yet
// (test/load-order.test.ts).

/** The wake-up tools, by name. */
export const WAKE_TOOLS = ["schedule_wake_up", "watch_for_change", "list_wake_ups", "cancel_wake_up"] as const;
export type WakeToolName = (typeof WAKE_TOOLS)[number];

/** The tools that show something in the conversation or beside it, by name. */
export const SHOW_TOOLS = ["show_in_panel", "show_file", "mark_final", "show_widget"] as const;
export type ShowToolName = (typeof SHOW_TOOLS)[number];
