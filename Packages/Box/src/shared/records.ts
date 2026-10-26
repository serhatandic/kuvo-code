// What a box's programs write in its `run` folder for each other, as each reads it.

import type { BotLook } from "./routes/bots";

/** `run/engine.json`: the engine running here, as its launch wrote it (this Mac's app, or a machine's keeper). */
export interface EngineRecord {
  pid?: number;
  port: number;
  password: string;
  version?: string;
  notes?: Record<string, unknown>;
  /** On a machine, where its coding agents' bridge is too (RemoteEngine.swift writes them). */
  agentsPort?: number;
  agentsPassword?: string;
}

/** `run/bridge.json`: the coding agents' bridge beside the engine, when it runs. */
export interface BridgeRecord {
  pid?: number;
  port: number;
  password: string;
}

/** Where a box's program answers, with its password: the engine, or the agents bridge. */
export type Target = Pick<EngineRecord, "port" | "password">;

/** An agent as boxes list them for each other (a peer's mail, `run/agents.json`): a conversation,
 * by its session, a bot (with its id and look) or a session; its project, what it does (`about`),
 * and the box it's on (`machine`, that box's name on its Macs). */
export interface ListedAgent {
  session: string;
  name: string;
  kind: "bot" | "session";
  id?: string;
  look?: BotLook;
  project?: string;
  about?: string;
  machine?: string;
}

/** What one peer told this box of its agents (`run/peer-agents.json`, by its key): when it said
 * so, what it is, its id on its Macs, its agents, and what it answers (`features`). */
export interface ToldAgents {
  at: number;
  kind: "mac" | "machine";
  id?: string;
  list: ListedAgent[];
  features?: string[];
}

/** `run/agents.json`: everyone, for list_agents here (kuvo-browser.js reads it), and this box's
 * name among them. */
export interface AgentsFile {
  machine: string | null;
  agents: ListedAgent[];
}
