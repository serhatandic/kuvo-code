// An integration that turns down its sign-in, through the bridge's relay, on the real engine: an
// agent connecting to it is given a stand-in that starts (no tools, saying to sign in again), so no
// agent gives up its session over it, and the engine finds it needs signing in; signed in again,
// the agent is given it afresh, and reaches its tools.
//
// The real engine and the real bridge code, in folders of the test's own: the integration (Notion,
// as Integrations adds it) is a stand-in MCP server that turns down every sign-in but the one made
// again. Skipped unless OPENCODE_TEST_BINARY names the engine.
//
// A live check, run by hand on an engine update, outside the deterministic suites: it waits on the
// real engine as it connects (polling, with a deadline), as the other live tests do.
//
// Run with `OPENCODE_TEST_BINARY=<opencode> bun test test/agents/relay-live.test.ts`.

import "../safety"
import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineLink } from "../../src/agents/engine"
import { computerServers, forgetServers, setServerSource } from "../../src/agents/servers"
import { dropRelayed, relayedServers, serversKey } from "../../src/agents/toolrelay"

const binary = process.env.OPENCODE_TEST_BINARY

describe.skipIf(!binary)("an integration that turns down its sign-in, through the relay, on the real engine", () => {
  const root = realpathSync(mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-relay-live-")))
  const work = join(root, "work")
  const stops: (() => void)[] = []
  afterAll(() => {
    for (const stop of stops.reverse()) stop()
    rmSync(root, { recursive: true, force: true })
  })

  test("the agent starts with a stand-in saying to sign in again, the engine finds it needs signing in, and signed in again the agent reaches it", async () => {
    // Notion's server: every sign-in turned down but `accepted`.
    const accepted = "access-again"
    const notion = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const message: any = await request.json().catch(() => null)
        if (request.headers.get("authorization") !== `Bearer ${accepted}`) return new Response(JSON.stringify({ error: "invalid_token" }), { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"', "Content-Type": "application/json" } })
        if (request.method !== "POST") return new Response(null, { status: 405 })
        if (message?.id === undefined) return new Response(null, { status: 202 })
        const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": "notion-1" } })
        if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notion", version: "1" } })
        if (message.method === "tools/list") return reply({ tools: [{ name: "search", description: "Search pages", inputSchema: { type: "object", properties: {} } }] })
        return reply({ content: [{ type: "text", text: "Found it." }] })
      },
    })
    stops.push(() => notion.stop(true))

    // The engine, with Notion added as Integrations adds it.
    for (const folder of ["home", "tmp", "work", "config/opencode", "xdg/data", "xdg/state", "xdg/cache"]) mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(join(root, "config", "opencode", "opencode.json"), JSON.stringify({ mcp: { servers: { notion: { type: "remote", url: `http://127.0.0.1:${notion.port}/mcp`, codemode: false } } } }))
    const env = {
      PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: join(root, "tmp") + "/", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "xdg", "data"),
      XDG_STATE_HOME: join(root, "xdg", "state"), XDG_CACHE_HOME: join(root, "xdg", "cache"), OPENCODE_PASSWORD: "pw",
    }
    const child = spawn(binary!, ["serve", "--stdio", "--port", "0"], { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] })
    stops.push(() => {
      child.stdin.end()
      child.kill()
    })
    const port = await new Promise<number>((resolve, reject) => {
      let said = ""
      const look = (chunk: Buffer) => {
        said += chunk
        const found = said.match(/127\.0\.0\.1:(\d+)/)
        if (found) resolve(Number(found[1]))
      }
      child.stdout.on("data", look)
      child.stderr.on("data", look)
      child.on("exit", (code) => reject(new Error(`The engine ended (${code}): ${said}`)))
    })
    const link = new EngineLink()
    link.configure(`http://127.0.0.1:${port}`, "pw")
    setServerSource(link)
    stops.push(() => {
      link.configure(undefined, undefined)
      forgetServers()
    })
    const waitFor = async <T>(wanted: () => Promise<T | false | undefined>, what: string): Promise<T> => {
      const end = Date.now() + 60_000
      for (;;) {
        const found = await wanted().catch(() => undefined)
        if (found) return found
        if (Date.now() > end) throw new Error(`Waited too long for ${what}`)
        await Bun.sleep(300)
      }
    }
    await waitFor(async () => (await link.request("GET", "/api/model/default").then(() => true)), "the engine to start")
    const notionNow = async () => ((await link.request("GET", "/api/mcp", undefined, 10_000, work)) as any).data?.find((each: any) => each.name === "notion")
    await waitFor(async () => (await notionNow())?.status?.status !== "pending" && true, "Notion to connect or not")

    // You signed in once (the engine keeps it): a sign-in Notion has since taken back.
    const integrationID = (await notionNow()).integrationID as string
    const credential = (await link.request("POST", "/api/credential", { integrationID, value: { type: "oauth", methodID: "oauth", refresh: "refresh-1", access: "access-taken-back", expires: Date.now() + 3_600_000 } })) as any

    // An agent connects to it through the relay, as it starts its session.
    const session = "ses_relay_live"
    const thread = {}
    stops.push(() => dropRelayed(session, thread))
    const connect = async (server: { url: string; headers: Record<string, string> }) => {
      const headers = { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }
      const started = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } }) })
      const start = (await started.json()) as any
      const asked = { ...headers, "mcp-session-id": started.headers.get("mcp-session-id") ?? "" }
      const listed = (await (await fetch(server.url, { method: "POST", headers: asked, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) })).json()) as any
      return { status: started.status, start, tools: (listed.result?.tools ?? []).map((tool: any) => tool.name) }
    }
    forgetServers()
    let found = await computerServers(work, true)
    const key = await serversKey(session, found)
    const [first] = relayedServers(session, thread, work, found).filter((server) => server.name === "notion")
    const refused = await connect(first!)
    expect(refused.status).toBe(200)
    expect(refused.start.result.instructions).toMatch(/turned down its sign-in.*sign in to it again in Kuvo Code \(Settings › Integrations/)
    expect(refused.tools).toEqual([])
    // The engine was told: it has Notion as needing a sign-in, as Settings › Integrations shows.
    await waitFor(async () => (await notionNow())?.status?.status === "needs_auth", "the engine to have Notion needing a sign-in")

    // Signed in again: the agent's next turn gives it Notion afresh, and it reaches its tools.
    await link.request("DELETE", `/api/credential/${encodeURIComponent(credential.data.id)}`)
    await link.request("POST", "/api/credential", { integrationID, value: { type: "oauth", methodID: "oauth", refresh: "refresh-2", access: accepted, expires: Date.now() + 3_600_000 } })
    forgetServers()
    found = await computerServers(work, true)
    expect(await serversKey(session, found)).not.toBe(key)
    const [again] = relayedServers(session, thread, work, found).filter((server) => server.name === "notion")
    expect(again!.url).not.toBe(first!.url)
    const reached = await connect(again!)
    expect(reached.start.result.serverInfo.name).toBe("notion")
    expect(reached.tools).toEqual(["search"])
  }, 180_000)
})
