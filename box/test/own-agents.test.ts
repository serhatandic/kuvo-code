// This box's own agents worked out for one asking here (list_agents, `kuvo/named`) while the list
// is worked out again: the one begun last is kept, so a chat that came meanwhile isn't dropped.

import "./safety"
import { expect, test } from "bun:test"
import { writeLink } from "../src/link/state"
import { newKey } from "../src/link/crypto/keys"
import { ownAgentsNow, ownAsLast, refreshOwn } from "../src/link/peers/agents"

test("an older working out for list_agents, answered last, doesn't replace the newer list", async () => {
  writeLink({ key: newKey().toString("base64url"), id: "here" } as any)
  let asked = 0, firstAsked!: () => void, letGo!: () => void
  const first = new Promise<void>(resolve => { firstAsked = resolve })
  const released = new Promise<void>(resolve => { letGo = resolve })
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async request => {
    if (!new URL(request.url).pathname.startsWith("/api/session")) return Response.json({})
    // The older reads before the chat lands here, and is answered last.
    if (++asked === 1) {
      firstAsked()
      await released
      return Response.json({ data: [] })
    }
    return Response.json({ data: [{ id: "ses_landed", title: "Trip plans", time: { updated: 2 } }] })
  } })
  try {
    const readEngine = () => ({ port: server.port!, password: "pw" })
    const older = ownAgentsNow(readEngine, "here")
    await first
    await refreshOwn(readEngine)
    letGo()
    // (It answers with the newer list too.)
    expect((await older)?.map(agent => agent.session)).toEqual(["ses_landed"])
    expect(ownAsLast("here").map(agent => agent.session)).toEqual(["ses_landed"])
  } finally {
    server.stop(true)
  }
})
