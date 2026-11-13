import "../safety"
import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AntigravityPlan } from "../../src/agents/usage/antigravity-plan"

test("own loopback language server accepts its self-signed HTTPS certificate and CSRF", async () => {
  const root = mkdtempSync(join(tmpdir(), "antigravity-tls-"))
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const key = join(root, "key.pem"), cert = join(root, "cert.pem")
    const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=fixture.local", "-days", "1", "-keyout", key, "-out", cert])
    expect(generated.status).toBe(0)
    mkdirSync(join(root, "antigravity-acp"))
    writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "fixture-only" }))
    const methods: string[] = []
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) }, fetch(req) {
      expect(req.headers.get("x-codeium-csrf-token")).toBe("fixture-csrf")
      expect(req.headers.get("authorization")).toBeNull()
      const method = new URL(req.url).pathname.split("/").at(-1)!
      methods.push(method)
      return Response.json(method === "GetUserStatus" ? { userStatus: { userTier: { name: "Pro" } } } : { groups: [{ buckets: ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"].map(bucketId => ({ bucketId, remainingFraction: 0.75 })) }] })
    } })
    const plan = new AntigravityPlan(() => root, undefined, async () => [{ scheme: "https", port: server!.port!, csrf: "fixture-csrf" }], ["http://127.0.0.1:1"])
    const result = await plan.limits.read!(1000)
    expect(result?.windows).toHaveLength(4)
    expect(result?.plan).toBe("Pro")
    expect(methods).toEqual(["RetrieveUserQuotaSummary", "GetUserStatus"])
  } finally { server?.stop(true); rmSync(root, { recursive: true, force: true }) }
})
