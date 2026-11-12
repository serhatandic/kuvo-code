// The computer's MCP servers, as the engine has them for a folder, faked where they're outside the
// box: the engine's settings and sign-ins, and a URL's server. A command's server is a real program,
// found by its name on the PATH as a package's is, which says what it was started with and what it
// can reach.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EngineLink } from "../../../src/agents/engine"
import { forgetServers, setServerSource } from "../../../src/agents/servers"

/** The keys in the settings: none of them may reach an agent. */
export const KEYS = { shared: "shared-key-1111", bot: "bot-key-2222", notes: "notes-key-3333", tracker: "tracker-access-4444", renewed: "tracker-renewed-5555", again: "tracker-again-6666" }

/** The command server's name on the PATH. */
export const SERVER_COMMAND = "kuvo-test-files"

/**
 * The engine's settings for every folder (in its order: this computer's, then a bot's folder's),
 * the URL's servers they name, and a command's server written into `folder`. `serve()` starts them
 * and points the agents' bridge at the engine.
 */
export function computerServers(folder: string) {
  // A command's server (MCP over its pipes). Its tools: `reveal` says the key it was given; `read`
  // and `write` whether it can, at `path`; `env` a variable's value; `asks` asks the agent for its
  // folders, and says what it heard.
  const bin = join(folder, "server-bin")
  mkdirSync(bin, { recursive: true })
  const script = join(bin, "server.js")
  writeFileSync(
    script,
    `let buffer = ""
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
const fs = require("node:fs")
let asked
const tools = {
  reveal: () => "key:" + (process.env.SERVICE_KEY ?? "none"),
  read: ({ path }) => { try { fs.readFileSync(path); return "yes" } catch { return "no" } },
  write: ({ path }) => { try { fs.writeFileSync(path, "x"); return "yes" } catch { return "no" } },
  env: ({ name }) => process.env[name] ?? "none",
}
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (message.id === "ask-1" && !message.method) { asked(message.error ? "error:" + message.error.code : "answered"); continue }
    if (message.id === undefined || message.method === undefined) continue
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "files", version: "1" } } })
    else if (message.method === "tools/call" && message.params.name === "asks") {
      // Its own requests to the agent, one numbered as the call it's in is (the relay numbers a
      // connection's 1, 2…), which isn't that call's answer.
      new Promise((resolve) => (asked = resolve)).then((text) => send({ id: message.id, result: { content: [{ type: "text", text } ] } }))
      send({ id: "ask-1", method: "roots/list", params: {} })
      send({ id: 2, method: "elicitation/create", params: { message: "Which one?", requestedSchema: { type: "object", properties: {} } } })
    } else if (message.method === "tools/call") send({ id: message.id, result: { content: [{ type: "text", text: tools[message.params.name](message.params.arguments ?? {}) } ] } })
    else send({ id: message.id, result: {} })
  }
})
`,
  )
  writeFileSync(join(bin, SERVER_COMMAND), `#!/bin/sh\nexport BUN_BE_BUN=1\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(join(bin, SERVER_COMMAND), 0o755)

  let remote: ReturnType<typeof Bun.serve> | undefined
  let engine: ReturnType<typeof Bun.serve> | undefined
  const link = new EngineLink()
  const path = process.env.PATH
  const remoteURL = () => `http://127.0.0.1:${remote!.port}`

  /** This computer's settings: Settings › MCP Servers' and the integrations'. */
  const computer = () => ({
    files: { type: "local", command: [fake.filesCommand], environment: { SERVICE_KEY: KEYS.shared, ...fake.filesEnvironment } },
    notes: { type: "remote", url: `${remoteURL()}/notes`, headers: { "X-Api-Key": KEYS.notes }, oauth: false },
    // One you signed in to (its maker's sign-in, which the engine keeps).
    tracker: { type: "remote", url: `${remoteURL()}/tracker` },
    off: { type: "local", command: [SERVER_COMMAND], environment: { SERVICE_KEY: KEYS.shared }, disabled: true },
  })
  const fake = {
    /** A bot's folder's own settings (Edit Bot › Keys), read after this computer's, or none. */
    botLayer: undefined as Record<string, unknown> | undefined,
    /** More of the command server's environment, as its settings give it. */
    filesEnvironment: {} as Record<string, string>,
    /** Your sign-in to the tracker ran out (the tracker turns it down; the engine has it as about
     * to): the engine renews it as it connects it again. */
    expiring: false,
    /** How many times the engine was asked to connect the tracker again. */
    connects: 0,
    /** The tracker turns down your sign-in, whatever it is (it was taken back): from the start
     * (`start`), or only its tools' calls (`calls`: it ended partway). The engine, connecting it
     * again, finds it needs signing in. */
    refusing: false as false | "start" | "calls",
    /** You signed in to the tracker again (Settings › Integrations): the engine has another sign-in. */
    signedInAgain: false,
    /** The command server's command, as its settings name it. */
    filesCommand: SERVER_COMMAND,
    async serve() {
      // A URL's server: its tool says the sign-in and key it was sent.
      remote = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          const message: any = await request.json().catch(() => ({}))
          // Your sign-in, once it ran out, it turns down.
          if (fake.expiring && request.headers.get("authorization") === `Bearer ${KEYS.tracker}`) return new Response("Expired.", { status: 401 })
          // One taken back, every sign-in but the one you made again.
          const turnedDown = fake.refusing === "start" || (fake.refusing === "calls" && message.method === "tools/call")
          if (turnedDown && new URL(request.url).pathname === "/tracker" && request.headers.get("authorization") !== `Bearer ${KEYS.again}`) {
            return new Response("Unauthorized.", { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } })
          }
          if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } } }, { headers: { "mcp-session-id": "remote-1" } })
          const said = `auth:${request.headers.get("authorization") ?? "none"},key:${request.headers.get("x-api-key") ?? "none"},at:${new URL(request.url).pathname}`
          return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: said }] } })
        },
      })
      engine = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const at = new URL(request.url).pathname
          if (at === "/api/event") return new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } })
          if (at === "/api/config") return Response.json([{ type: "document", path: "opencode.json", info: { mcp: { servers: computer() } } }, ...(fake.botLayer ? [{ type: "document", path: ".opencode/opencode.json", info: { mcp: { servers: fake.botLayer } } }] : [])])
          if (at === "/api/mcp") return Response.json([{ name: "tracker", status: fake.refusing && fake.connects && !fake.signedInAgain ? "needs_auth" : "connected", integrationID: "int_tracker" }])
          if (at === "/api/experimental/mcp/tracker/connect" && request.method === "POST") {
            fake.connects += 1
            fake.expiring = false
            return Response.json(true)
          }
          if (at === "/api/credential") {
            // (About to run out: within the minute it's renewed before.)
            const value = fake.expiring ? { access: KEYS.tracker, expires: Date.now() + 1_000 } : { access: fake.signedInAgain ? KEYS.again : fake.connects ? KEYS.renewed : KEYS.tracker, expires: Date.now() + 3_600_000 }
            return Response.json({ data: [{ integrationID: "int_tracker", active: true, value: { type: "oauth", refresh: "r", ...value } }] })
          }
          return new Response("Not found.", { status: 404 })
        },
      })
      process.env.PATH = `${bin}:${path}`
      forgetServers()
      link.configure(`http://127.0.0.1:${engine.port}`, "engine-password")
      setServerSource(link)
    },
    /** The command server, as a bot's settings name it with its own key. */
    botFiles: () => ({ files: { ...computer().files, environment: { SERVICE_KEY: KEYS.bot } } }),
    stop() {
      process.env.PATH = path
      link.configure(undefined, undefined)
      engine?.stop(true)
      remote?.stop(true)
      forgetServers()
    },
  }
  return fake
}

/** A server's tool called through what an agent was given for it, as an MCP client does. */
export async function callServer(server: { url: string; headers: Record<string, string> }, tool = "reveal", args: Record<string, unknown> = {}) {
  const headers = { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }
  const started = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } }) })
  if (!started.ok) return String(started.status)
  const session = started.headers.get("mcp-session-id")
  const response = await fetch(server.url, { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) })
  return ((await response.json()) as any).result?.content?.[0]?.text as string | undefined
}
