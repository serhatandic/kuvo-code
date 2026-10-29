// Kuvo Code's tools for an agent run whole in the box's sandbox, through the bridge's relay: each
// call is its own session's, whatever it says, and reaches the tools where the sandbox can't.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setToolProgram, setToolServer } from "../../src/agents/kuvotools"
import { dropRelayed, relayedTools } from "../../src/agents/toolrelay"

const base = mkdtempSync(join(process.env.KUVO_TEST_ROOT ?? tmpdir(), "kuvo-relay-test-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))

afterEach(() => {
  setToolServer(undefined)
  setToolProgram(undefined)
  for (const session of ["ses_one", "ses_two"]) dropRelayed(session)
})

/** Calls a tool through the relay, as the agent would, with `key`'s session and saying it's `claims`'s. */
async function call(tools: { url: string; headers: Record<string, string> }, id: number, claims?: string) {
  const response = await fetch(tools.url, {
    method: "POST",
    headers: { ...tools.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "show_in_panel", arguments: {}, ...(claims ? { _meta: { "ai.opencode/sessionID": claims } } : {}) } }),
  })
  return { status: response.status, body: response.status === 200 ? await response.json() : undefined }
}

describe("on a machine: the program, run outside the sandbox", () => {
  test("each call reaches the program as its own session's, even one that names another, and answers its own request", async () => {
    // The program, as the machine's engine has it: says which session each call was for.
    const program = join(base, "tools.js")
    writeFileSync(program, `let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at))
    buffer = buffer.slice(at + 1)
    if (message.id === undefined) continue
    const session = message.params?._meta?.["ai.opencode/sessionID"] ?? process.env.KUVO_SESSION
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: session }] } }) + "\\n")
  }
})
`)
    setToolProgram(JSON.stringify({ mcp: { servers: { "kuvo-browser": { command: [process.execPath, program], environment: {} } } } }))
    const one = relayedTools("ses_one")!
    const two = relayedTools("ses_two")!
    expect(one.url).toStartWith("http://127.0.0.1:")
    const [mine, claimed, theirs] = await Promise.all([call(one, 7), call(one, 7, "ses_two"), call(two, 7)])
    expect(mine.body).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ses_one" }] } })
    expect(claimed.body.result.content[0].text).toBe("ses_one")
    expect(theirs.body.result.content[0].text).toBe("ses_two")
  })

  test("a key it didn't give, or one whose session is done, reaches nothing", async () => {
    setToolProgram(JSON.stringify({ mcp: { servers: { "kuvo-browser": { command: [process.execPath, "-e", ""], environment: {} } } } }))
    const one = relayedTools("ses_one")!
    expect((await call({ url: one.url, headers: { Authorization: "Bearer nope" } }, 1)).status).toBe(401)
    dropRelayed("ses_one")
    expect((await call(one, 1)).status).toBe(401)
  })
})

describe("on this Mac: the app's server", () => {
  test("each call goes to the app's server with the app's password and its own session, whatever it says", async () => {
    const seen: { authorization: string | null; session: string | null; claims: unknown }[] = []
    const app = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body: any = await request.json()
        seen.push({ authorization: request.headers.get("authorization"), session: request.headers.get("x-kuvo-session"), claims: body.params?._meta?.["ai.opencode/sessionID"] })
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [] } })
      },
    })
    try {
      setToolServer({ url: `http://127.0.0.1:${app.port}/mcp`, token: "app-password", timeout: 10_000 })
      const one = relayedTools("ses_one")!
      expect(one.headers.Authorization).not.toContain("app-password")
      const answer = await call({ ...one, headers: { ...one.headers, "X-Kuvo-Session": "ses_two" } }, 3, "ses_two")
      expect(answer.body).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [] } })
      expect(seen).toEqual([{ authorization: "Bearer app-password", session: "ses_one", claims: "ses_one" }])
    } finally {
      app.stop(true)
    }
  })
})
