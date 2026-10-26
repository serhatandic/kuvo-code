// What a box's programs write in its `run` folder for each other, as each reads it.

/** `run/engine.json`: the engine running here, as its launch wrote it (this Mac's app, or a machine's keeper). */
export interface EngineRecord {
  pid?: number;
  port: number;
  password: string;
  version?: string;
  notes?: Record<string, unknown>;
}

/** `run/bridge.json`: the coding agents' bridge beside the engine, when it runs. */
export interface BridgeRecord {
  pid?: number;
  port: number;
  password: string;
}

/** Where a box's program answers, with its password: the engine, or the agents bridge. */
export type Target = Pick<EngineRecord, "port" | "password">;
