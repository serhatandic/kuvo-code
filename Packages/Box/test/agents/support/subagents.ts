// Your subagents as the engine lists them for a folder (Settings › Agents), and this box's settings
// file with the model they use: the engine faked, the file a real one. `serve()` points the agents'
// bridge at both; `stop()` lets go.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EngineLink } from "../../../src/agents/engine"
import { setSubagentSource } from "../../../src/agents/subagents"

export const REVIEWER = {
  id: "reviewer",
  name: "reviewer",
  mode: "subagent",
  description: "Reviews a finished change.",
  system: "You review. You never edit.",
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "shell", resource: "git diff *", effect: "allow" },
  ],
}

/** The engine's agents for every folder, as it lists them (`agents`), and the model subagents use (`model`). */
export function subagentEngine(folder: string) {
  let engine: ReturnType<typeof Bun.serve> | undefined
  const link = new EngineLink()
  const settings = join(folder, "settings", "opencode.json")
  const fake = {
    agents: [
      { id: "build", name: "Build", mode: "primary", permissions: [] },
      { id: "general", name: "General", mode: "subagent", permissions: [] },
      { id: "explore", name: "Explore", mode: "subagent", permissions: [] },
      REVIEWER,
      { id: "Keyword Research", name: "Keyword Research", mode: "all", description: "Finds keywords.", system: "You research keywords.", model: { providerID: "openai", id: "gpt-5" }, permissions: [] },
      { id: "Research", name: "Research", mode: "primary", system: "A mode, not a subagent.", permissions: [] },
    ] as any[],
    /** The model subagents use, as Settings › Agents writes it (undefined: the conversation's). */
    set model(value: string | undefined) {
      mkdirSync(join(folder, "settings"), { recursive: true })
      writeFileSync(settings, JSON.stringify(value === undefined ? {} : { subagent_model: value }))
    },
    async serve() {
      engine = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const at = new URL(request.url).pathname
          if (at === "/api/event") return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } })
          if (at === "/api/agent") return Response.json({ data: fake.agents })
          return new Response("Not found.", { status: 404 })
        },
      })
      link.configure(`http://127.0.0.1:${engine.port}`, "engine-password")
      setSubagentSource(link, folder, settings)
    },
    stop() {
      link.configure(undefined, undefined)
      engine?.stop(true)
      setSubagentSource(new EngineLink(), folder, undefined)
    },
  }
  return fake
}
