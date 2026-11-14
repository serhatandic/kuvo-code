import "../safety"
import { describe, expect, test } from "bun:test"
import fixtures from "../fixtures/usage/antigravity-plan-cases.json"
import legacyFixtures from "../fixtures/usage/antigravity-legacy-plan-cases.json"
import oauthFixture from "../fixtures/usage/antigravity-acp-oauth.json"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AntigravityPlan, antigravitySummary, antigravityLegacy, antigravityProcPorts, discoverAntigravity, antigravityMacOwns, antigravityPlanName, antigravityOAuthDefaults } from "../../src/agents/usage/antigravity-plan"
import { Limits, LimitsProblem } from "../../src/agents/limits"

const summary = (fraction = 0.75) => ({ groups: [{ buckets: ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"].map(bucketId => ({ bucketId, remainingFraction: fraction })) }] })
const temp = () => mkdtempSync(join(tmpdir(), "kuvo-agy-plan-"))
function credential(profile: string, access = "fixture-token") { mkdirSync(join(profile, "antigravity-acp"), { recursive: true }); writeFileSync(join(profile, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: access })) }

describe("Antigravity quota mapper", () => {
  test("shared legacy and plan-name parity fixtures", () => {
    for (const fixture of legacyFixtures.legacy) expect(antigravityLegacy(fixture.configs).map(w => ({ label: w.name, used: Math.round(w.used * 100), periodMs: w.minutes! * 60_000 }))).toEqual(fixture.expected)
    for (const fixture of legacyFixtures.plans) expect(antigravityPlanName(fixture.input) ?? null).toEqual(fixture.expected)
    expect(antigravityOAuthDefaults).toEqual(oauthFixture.defaults)
  })
  test("shared Swift parity fixtures", () => {
    for (const fixture of fixtures) expect(antigravitySummary(fixture.bodies)?.map(w => ({ label: w.name, used: Math.round(w.used * 100), periodMs: w.minutes! * 60_000 })) ?? null, fixture.name).toEqual(fixture.expected)
  })
  test("exact pools, first usable wins, clamp and Swift rounding", () => {
    const result = antigravitySummary([{ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: "bad" }, { bucketId: "gemini-image-5h", remainingFraction: 0 }, { bucketId: "gemini-weekly", remainingFraction: -1 }] }] }, summary(0.754)])!
    expect(result.map(w => [w.id, w.used])).toEqual([["gemini-5h", 0.25], ["gemini-weekly", 1], ["3p-5h", 0.25], ["3p-weekly", 0.25]])
    expect(antigravitySummary([{}])).toBeUndefined()
    expect(antigravitySummary([{ groups: [] }])).toEqual([])
  })
  test("Argon is separate and unambiguous", () => {
    const b = { bucketId: "argon", window: "weekly", remainingFraction: 0.5 }
    const group = (buckets: any[]) => ({ groups: [{ displayName: "Gemini 4 Argon", buckets }] })
    expect(antigravitySummary([group([b])])?.[0]?.id).toBe("argon-weekly")
    for (const buckets of [[b, b], [{ ...b, disabled: true }], [{ ...b, disabled: "false" }], [{ ...b, bucketId: "gemini-weekly" }]]) expect(antigravitySummary([group(buckets)])).toEqual([])
  })
  test("legacy worst pool, blacklist, missing fraction and Argon exclusions", () => {
    expect(antigravityLegacy([{ label: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.8 } }, { label: "Gemini 3 Flash" }, { label: "Claude", quotaInfo: { remainingFraction: 0.5 } }, { label: "Gemini 4 Argon" }, { label: "Hidden", model: "MODEL_CHAT_20706" }]).map(w => [w.name, w.used])).toEqual([["Session", 1], ["Claude", 0.5]])
  })
})

describe("Antigravity discovery", () => {
  test("Linux /proc maps only own profile and owned listening socket inodes", async () => {
    const root = temp()
    try {
      const profile = join(root, "profile")
      const proc = join(root, "proc")
      const row = " 0: 0100007F:CAFE 00000000:0000 0A 0 0 0 0 0 123\n 1: 0100007F:BEEF 00000000:0000 0A 0 0 0 0 0 456"
      for (const [pid, home] of [["10", "/outside/editor"], ["20", profile]]) {
        mkdirSync(join(proc, pid!, "fd"), { recursive: true }); mkdirSync(join(proc, pid!, "net"), { recursive: true })
        writeFileSync(join(proc, pid!, "cmdline"), "/fixture/language_server_linux\0--csrf_token=fixture-csrf\0")
        writeFileSync(join(proc, pid!, "environ"), `GEMINI_HOME=${home}\0`)
        symlinkSync("socket:[123]", join(proc, pid!, "fd", "5"))
        writeFileSync(join(proc, pid!, "net", "tcp"), row)
      }
      expect(antigravityProcPorts([row], new Set(["123"]))).toEqual([51966])
      expect(await discoverAntigravity(profile, "linux", proc)).toEqual([{ scheme: "https", port: 51966, csrf: "fixture-csrf" }, { scheme: "http", port: 51966, csrf: "fixture-csrf" }])
      expect(await discoverAntigravity("/missing", "linux", proc)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("Mac own profile can contain spaces and regex punctuation", () => {
    const profile = "/Users/test/Library/Application Support/Kuvo Code/profile[1]"
    expect(antigravityMacOwns(`language_server --csrf_token fixture GEMINI_HOME=${profile} PATH=/fixture`, profile)).toBe(true)
    expect(antigravityMacOwns(`language_server --app_data_dir=${profile} --csrf_token fixture`, profile)).toBe(true)
    expect(antigravityMacOwns(`language_server GEMINI_HOME=${profile}-outside PATH=/fixture`, profile)).toBe(false)
    expect(antigravityMacOwns(`language_server GEMINI_HOME=${profile} outside PATH=/fixture`, profile)).toBe(false)
  })
  test("Mac agy stand-in permits no CSRF and language_server still requires it", async () => {
    for (const executable of ["agy", "language_server"]) {
      const runner: any = async (program: string, args: string[]) => ({ code: 0, stdout: program.endsWith("ps") ? args.includes("comm=") ? `/fixture/Library/Application Support/${executable}` : `10 /fixture/Library/Application Support/${executable} GEMINI_HOME=/fixture/profile` : "agy 10 TCP 127.0.0.1:12345 (LISTEN)\n", stderr: "" })
      const endpoints = await discoverAntigravity("/fixture/profile", "darwin", "/unused", runner)
      expect(endpoints.length).toBe(executable === "agy" ? 2 : 0)
      if (executable === "agy") expect(endpoints[0]?.csrf).toBe("")
    }
  })
  test("Linux agy own-profile stand-in permits no CSRF", async () => {
    const root = temp()
    try {
      const proc = join(root, "proc")
      mkdirSync(join(proc, "10", "fd"), { recursive: true }); mkdirSync(join(proc, "10", "net"), { recursive: true })
      writeFileSync(join(proc, "10", "cmdline"), "/fixture/agy\0--extension_server_port=12345\0")
      writeFileSync(join(proc, "10", "environ"), "GEMINI_HOME=/fixture/profile\0")
      expect(await discoverAntigravity("/fixture/profile", "linux", proc)).toEqual([{ scheme: "http", port: 12345, csrf: "" }])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("Mac ps/lsof stand-ins require own profile", async () => {
    const calls: string[] = []
    const runner: any = async (program: string, args: string[]) => { calls.push(program); return { code: 0, stdout: program.endsWith("ps") ? args.includes("comm=") ? "/fixture/language_server" : "10 /fixture/language_server --csrf_token fixture GEMINI_HOME=/fixture/profile\n" : "agy 10 TCP 127.0.0.1:12345 (LISTEN)\n", stderr: "" } }
    expect((await discoverAntigravity("/fixture/profile", "darwin", "/unused", runner))[0]?.port).toBe(12345)
    expect(calls).toEqual(["/bin/ps", "/bin/ps", "/usr/sbin/lsof"])
    expect(await discoverAntigravity("/outside", "darwin", "/unused", runner)).toEqual([])
  })
})

describe("Antigravity own-account stand-in service", () => {
  test("one host refusing and optional plan refusing cannot poison usable quotas", async () => {
    for (const primaryRefuses of [false, true]) {
      const root = temp(); credential(root)
      let primaryCalls = 0, secondaryCalls = 0
      const primary = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        primaryCalls++
        if (new URL(req.url).pathname.includes("loadCodeAssist") || primaryRefuses) return new Response("{}", { status: 403 })
        return Response.json({ groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.7 }] }] })
      } })
      const secondary = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
        secondaryCalls++
        return primaryRefuses && !new URL(req.url).pathname.includes("loadCodeAssist") ? Response.json(summary()) : new Response("{}", { status: 403 })
      } })
      try {
        const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [primary.url.origin, secondary.url.origin])
        expect((await plan.limits.read!(1000))?.windows.length).toBe(primaryRefuses ? 4 : 1)
        expect((await plan.limits.read!(2000))?.windows.length).toBe(primaryRefuses ? 4 : 1)
        expect(primaryCalls).toBeGreaterThan(2); expect(secondaryCalls).toBeGreaterThanOrEqual(2)
        expect(() => readFileSync(join(root, "box-usage", "refusals.json"))).toThrow()
      } finally { primary.stop(true); secondary.stop(true); rmSync(root, { recursive: true, force: true }) }
    }
  })
  test("legacy project-plan 403 still permits quota retrieval", async () => {
    const root = temp(); credential(root)
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const path = new URL(req.url).pathname
      if (path.includes("loadCodeAssist")) return new Response("{}", { status: 403 })
      if (path.includes("retrieveUserQuotaSummary") || path.includes("fetchAvailableModels")) return new Response("{}", { status: 404 })
      return Response.json({ buckets: [{ modelId: "gemini-3-pro", remainingFraction: 0.8 }] })
    } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin])
      expect((await plan.limits.read!(1000))?.windows[0]?.used).toBe(0.2)
      expect((await plan.limits.read!(2000))?.windows[0]?.used).toBe(0.2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("agent OAuth metadata and verified defaults are used by refresh-only own sign-ins", async () => {
    for (const useMetadata of [true, false]) {
      const root = temp(); credential(root)
      const token: any = { ...oauthFixture.ownToken }
      if (!useMetadata) { delete token.client_id; delete token.client_secret }
      writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify(token))
      let form: URLSearchParams | undefined
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
        if (new URL(req.url).pathname === "/oauth") { form = new URLSearchParams(await req.text()); return Response.json({ access_token: "renewed-fixture", expires_in: 3600 }) }
        return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? {} : summary())
      } })
      try {
        const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
        expect((await plan.limits.read!(1000))?.windows.length).toBe(4)
        expect(form!.get("client_id")).toBe(useMetadata ? oauthFixture.ownToken.client_id : oauthFixture.defaults.clientID)
        expect(form!.get("client_secret")).toBe(useMetadata ? oauthFixture.ownToken.client_secret : oauthFixture.defaults.clientSecret)
        expect(form!.get("refresh_token")).toBe(oauthFixture.ownToken.refresh_token)
      } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
    }
  })
  test("profile and predictable state symlinks cannot redirect refusal writes; signout prunes state", async () => {
    const root = temp(); credential(root)
    const state = join(root, "box-usage")
    mkdirSync(state)
    const target = join(root, "sentinel")
    writeFileSync(target, "fixture sentinel")
    symlinkSync(target, join(root, "kuvo-usage-refusals.json.new"))
    symlinkSync(target, join(state, "refusals.json.new"))
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      symlinkSync(target, join(state, "refusals.json"))
      return new Response("{}", { status: 403 })
    } })
    try {
      const plan = new AntigravityPlan(() => root, () => state, undefined, async () => [], [server.url.origin])
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "expired" })
      expect(readFileSync(target, "utf8")).toBe("fixture sentinel")
      expect(JSON.parse(readFileSync(join(state, "refusals.json"), "utf8")).access.length).toBe(1)
      plan.signOut()
      expect(() => readFileSync(join(state, "refusals.json"))).toThrow()
      expect(readFileSync(target, "utf8")).toBe("fixture sentinel")
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("agy with no CSRF is retried after an authless endpoint 403", async () => {
    const root = temp(); credential(root)
    let localCalls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname.includes("LanguageServerService")) { localCalls++; return new Response("{}", { status: 403 }) }
      return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? {} : summary())
    } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [{ scheme: "http", port: server.port!, csrf: "" }], [server.url.origin])
      await plan.limits.read!(1000); await plan.limits.read!(2000)
      expect(localCalls).toBe(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("missing windows without resets survive only one partial round across restart", async () => {
    const root = temp()
    let at = 10_000_000, partial = false
    const source = { every: 60_000, read: async () => ({ partial, windows: partial ? [{ id: "present", used: 0.2 }] : [{ id: "present", used: 0.1 }, { id: "missing", used: 0.4 }] }) }
    const start = () => new Limits(() => [{ provider: "antigravity", service: "antigravity", limits: source }], join(root, "limits.json"), () => at)
    try {
      const first = start(); await first.tick()
      partial = true; at += 610_000; await first.tick()
      expect(first.list()[0]?.windows.length).toBe(2)
      at += 610_000; const restarted = start(); await restarted.tick()
      expect(restarted.list()[0]?.windows.map(w => w.id)).toEqual(["present"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("refused access refreshes once, valid refresh cache survives expired source expiry", async () => {
    const root = temp()
    credential(root)
    writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "old-fixture", refresh_token: "refresh-fixture" }))
    let refreshes = 0, oldCalls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname === "/oauth") { refreshes++; return Response.json({ access_token: "new-fixture", expires_in: 3600 }) }
      if (req.headers.get("Authorization") === "Bearer old-fixture") { oldCalls++; return new Response("{}", { status: 401 }) }
      return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? { paidTier: { id: "g1-pro-tier" } } : summary())
    } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
      expect((await plan.limits.read!(1000))?.plan).toBe("Pro")
      await plan.limits.read!(2000)
      expect(refreshes).toBe(1); expect(oldCalls).toBe(1)
      writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "old-fixture", refresh_token: "refresh-fixture", expiry: "2000-01-01T00:00:00Z" }))
      await plan.limits.read!(3000)
      expect(refreshes).toBe(1); expect(oldCalls).toBe(1)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("malformed and unreadable sign-in retain known identity and windows", async () => {
    const root = temp()
    const id = `fixture.${Buffer.from(JSON.stringify({ sub: "fixture-google-user" })).toString("base64url")}.signature`
    mkdirSync(join(root, "antigravity-acp"), { recursive: true })
    writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "fixture", id_token: id }))
    let at = 10_000_000
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? {} : summary()) } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin])
      const limits = new Limits(() => [{ provider: "antigravity", service: "antigravity", limits: plan.limits }], undefined, () => at)
      await limits.tick()
      const before = limits.list()[0]!
      writeFileSync(join(root, "antigravity-acp/acp_token.json"), "{broken")
      at += 610_000; await limits.tick()
      expect(limits.list()[0]?.identity).toBe(before.identity)
      expect(limits.list()[0]?.windows).toEqual(before.windows)
      const raw = (plan as any).raw.bind(plan)
      ;(plan as any).raw = () => { throw new Error("EACCES fixture") }
      at += 610_000; await limits.tick()
      expect(limits.list()[0]?.identity).toBe(before.identity)
      expect(limits.list()[0]?.windows).toEqual(before.windows)
      ;(plan as any).raw = raw
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("access refusal persists through failed refresh and restart without resending old bearer", async () => {
    const root = temp()
    credential(root)
    writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "old-fixture", refresh_token: "refresh-fixture" }))
    let oldCalls = 0, refreshes = 0, failRefresh = true
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname === "/oauth") { refreshes++; return failRefresh ? new Response("{}", { status: 503 }) : Response.json({ access_token: "renewed-fixture", expires_in: 3600 }) }
      if (req.headers.get("Authorization") === "Bearer old-fixture") { oldCalls++; return new Response("{}", { status: 401 }) }
      return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? {} : summary())
    } })
    const start = () => new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
    try {
      await expect(start().limits.read!(1000)).rejects.toMatchObject({ kind: "failed" })
      expect(oldCalls).toBe(1); expect(refreshes).toBe(1)
      failRefresh = false
      expect((await start().limits.read!(2000))?.windows.length).toBe(4)
      expect(oldCalls).toBe(1); expect(refreshes).toBe(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("unwritable or unreadable refusal journal stops further sends", async () => {
    const root = temp(); credential(root)
    let calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { calls++; return new Response("{}", { status: 401 }) } })
    const start = () => new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin])
    try {
      const plan = start()
      mkdirSync(join(root, "box-usage", "refusals.json"), { recursive: true })
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "failed", sent: false })
      expect(calls).toBe(0)
      rmSync(join(root, "box-usage", "refusals.json"), { recursive: true })
      // A refused access token with no refresh cannot be sent again.
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "expired" })
      expect(calls).toBe(1)
      expect(readFileSync(join(root, "box-usage", "refusals.json"), "utf8")).not.toContain("fixture-token")
      writeFileSync(join(root, "box-usage", "refusals.json"), "{broken")
      await expect(start().limits.read!(4000)).rejects.toMatchObject({ kind: "failed", sent: false })
      expect(calls).toBe(1)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("restart never sends a refused token returned unchanged by refresh", async () => {
    const root = temp(); credential(root)
    writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "old-fixture", refresh_token: "refresh-fixture" }))
    let oldCalls = 0, refreshCalls = 0, returnOld = false
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname === "/oauth") { refreshCalls++; return returnOld ? Response.json({ access_token: "old-fixture", expires_in: 3600 }) : new Response("{}", { status: 503 }) }
      oldCalls++; return new Response("{}", { status: 401 })
    } })
    const start = () => new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
    try {
      await expect(start().limits.read!(1000)).rejects.toMatchObject({ kind: "failed" })
      returnOld = true
      await expect(start().limits.read!(2000)).rejects.toMatchObject({ kind: "expired", sent: false })
      expect(oldCalls).toBe(1); expect(refreshCalls).toBe(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("refused refresh is not retried after access disappears or changes", async () => {
    const root = temp(); credential(root)
    let refreshCalls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname === "/oauth") { refreshCalls++; return new Response("{}", { status: 400 }) }
      return new Response("{}", { status: 401 })
    } })
    const start = () => new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
    try {
      writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: "old-fixture", refresh_token: "refresh-fixture" }))
      await expect(start().limits.read!(1000)).rejects.toMatchObject({ kind: "expired" })
      for (const access_token of [undefined, "new-fixture"]) {
        writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token, refresh_token: "refresh-fixture" }))
        await expect(start().limits.read!(2000)).rejects.toMatchObject({ kind: "expired" })
      }
      expect(refreshCalls).toBe(1)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("local CSRF refusal survives restart", async () => {
    const root = temp(); credential(root)
    let localCalls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      if (new URL(req.url).pathname.includes("LanguageServerService")) { localCalls++; return new Response("{}", { status: 403 }) }
      return Response.json(new URL(req.url).pathname.includes("loadCodeAssist") ? {} : summary())
    } })
    const start = () => new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [{ scheme: "http", port: server.port!, csrf: "refused-fixture-csrf" }], [server.url.origin])
    try {
      expect((await start().limits.read!(1000))?.windows.length).toBe(4)
      expect((await start().limits.read!(2000))?.windows.length).toBe(4)
      expect(localCalls).toBe(1)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("persisted refusal survives restart and metadata-only credential rewrites", async () => {
    const root = temp(); credential(root)
    let at = 10_000_000, calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { calls++; return new Response("{}", { status: 401 }) } })
    const saved = join(root, "limits.json")
    const start = () => {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin])
      return new Limits(() => [{ provider: "antigravity", service: "antigravity", limits: plan.limits }], saved, () => at)
    }
    try {
      await start().tick(); expect(calls).toBe(1)
      writeFileSync(join(root, "antigravity-acp/acp_token.json"), JSON.stringify({ expiry: "2099-01-01T00:00:00Z", access_token: "fixture-token", unrelated: true }, null, 2))
      at += 610_000; const restarted = start(); await restarted.tick()
      expect(calls).toBe(1)
      credential(root, "new-fixture-token")
      at += 610_000; await restarted.tick()
      expect(calls).toBe(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("holds stop further endpoints; a refusal never resends unchanged credential", async () => {
    const root = temp(); credential(root)
    let status = 429, calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { calls++; return new Response("{}", { status, headers: { "Retry-After": "3600" } }) } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "rate-limited", until: 3601000 })
      expect(calls).toBe(1)
      status = 401
      // The held call isn't sent again before its time, whoever asks.
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "rate-limited", until: 3601000, sent: false })
      expect(calls).toBe(1)
      await expect(plan.limits.read!(3_602_000)).rejects.toMatchObject({ kind: "expired" })
      await expect(plan.limits.read!(3_603_000)).rejects.toMatchObject({ kind: "expired", sent: false })
      expect(calls).toBe(2)
      credential(root, "new-fixture")
      status = 200
      await expect(plan.limits.read!(3_604_000)).rejects.toBeInstanceOf(LimitsProblem)
      expect(calls).toBeGreaterThan(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("complete read, partial and unreadable reads keep prior known windows", async () => {
    const root = temp(); credential(root)
    let at = 10_000_000, mode = "complete", calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { calls++; const path = new URL(req.url).pathname; return Response.json(path.includes("loadCodeAssist") ? { paidTier: { id: "g1-ultra-lite-tier" } } : mode === "complete" ? summary() : mode === "partial" ? { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.1 }] }] } : { groups: [] }) } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], [server.url.origin])
      const limits = new Limits(() => [{ provider: "antigravity", service: "antigravity", limits: plan.limits }], undefined, () => at)
      await limits.tick()
      expect(limits.list()[0]?.windows.length).toBe(4)
      expect(limits.list()[0]?.plan).toBe("Ultra Lite")
      const before = calls; await limits.tick(); expect(calls).toBe(before)
      mode = "partial"; at += 610_000; await limits.tick()
      expect(limits.list()[0]?.windows.map(w => w.used)).toEqual([0.9, 0.25, 0.25, 0.25])
      mode = "empty"; at += 610_000; await limits.tick()
      expect(limits.list()[0]?.windows.length).toBe(4)
      expect(limits.list()[0]?.problem?.kind).toBe("failed")
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })

  /** Two stand-in hosts, main then daily, each answering `answer(path)`; what each was asked. */
  function hosts(main: (path: string) => Response, daily: (path: string) => Response) {
    const asked = { main: [] as string[], daily: [] as string[] }
    const serve = (name: "main" | "daily", answer: (path: string) => Response) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const path = new URL(req.url).pathname; asked[name].push(path.split(":").pop()!); return answer(path) } })
    const servers = [serve("main", main), serve("daily", daily)]
    return { asked, bases: servers.map(server => server.url.origin), stop: () => servers.forEach(server => server.stop(true)) }
  }
  const status = (code: number, headers?: Record<string, string>) => new Response("{}", { status: code, headers })
  const refusals = (root: string) => { try { return readFileSync(join(root, "box-usage", "refusals.json"), "utf8") } catch { return undefined } }

  test("only the main host's own refusal of the token's call can refuse the sign-in", async () => {
    // The main host failing and the daily host refusing: a failure, never a refused sign-in.
    const root = temp(); credential(root)
    const both = hosts(() => status(503), () => status(403))
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], both.bases)
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "failed" })
      expect(refusals(root)).toBeUndefined()
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "failed" })
      expect(both.asked.main).toContain("retrieveUserQuotaSummary")
      expect(both.asked.main.filter(path => path === "retrieveUserQuotaSummary")).toHaveLength(2)
    } finally { both.stop(); rmSync(root, { recursive: true, force: true }) }
    // The main host refusing the summary itself, and no host answering: the sign-in is refused.
    const refused = temp(); credential(refused)
    const main = hosts(() => status(403), () => status(503))
    try {
      const plan = new AntigravityPlan(() => refused, () => join(refused, "box-usage"), undefined, async () => [], main.bases)
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "expired" })
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "expired", sent: false })
      expect(refusals(refused)).toBeDefined()
    } finally { main.stop(); rmSync(refused, { recursive: true, force: true }) }
  })

  test("a token a summary just answered is never refused by a later call, which still tries the daily host", async () => {
    for (const dailyModels of [true, false]) {
      const root = temp(); credential(root)
      const models = { models: { "gemini-3-pro": { label: "Gemini 3 Pro", quotaInfo: { remainingFraction: 0.6 } } } }
      const both = hosts(path => path.includes("retrieveUserQuotaSummary") ? Response.json({}) : status(403),
        path => path.includes("fetchAvailableModels") && dailyModels ? Response.json(models) : status(403))
      try {
        const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], both.bases)
        if (dailyModels) expect((await plan.limits.read!(1000))?.windows.map(w => [w.id, w.used])).toEqual([["gemini-5h", 0.4]])
        else await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "failed" })
        expect(both.asked.daily).toContain("fetchAvailableModels")
        expect(refusals(root)).toBeUndefined()
        // Not refused: the next read asks again with the same token.
        const before = both.asked.main.length
        await plan.limits.read!(2000).catch(() => undefined)
        expect(both.asked.main.length).toBeGreaterThan(before)
      } finally { both.stop(); rmSync(root, { recursive: true, force: true }) }
    }
  })

  test("a daily host's wait keeps the main host's windows, and only that host waits", async () => {
    const root = temp(); credential(root)
    const partial = { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.3 }, { bucketId: "3p-5h", remainingFraction: 0.9 }] }] }
    const both = hosts(path => path.includes("loadCodeAssist") ? Response.json({ paidTier: { id: "g1-pro-tier" } }) : Response.json(partial), () => status(429, { "Retry-After": "3600" }))
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], both.bases)
      const reading = await plan.limits.read!(1000)
      expect(reading?.windows.map(w => [w.id, w.used])).toEqual([["gemini-5h", 0.7], ["3p-5h", 0.1]])
      expect(reading?.partial).toBe(true)
      expect(reading?.plan).toBe("Pro")
      expect(both.asked.daily).toEqual(["retrieveUserQuotaSummary"])
      // Within its Retry-After the daily host isn't asked; the main host still is.
      const again = await plan.limits.read!(1_000_000)
      expect(again?.windows.length).toBe(2)
      expect(both.asked.daily).toEqual(["retrieveUserQuotaSummary"])
      expect(both.asked.main.filter(path => path === "retrieveUserQuotaSummary")).toHaveLength(2)
      // After it, the daily host is asked again.
      await plan.limits.read!(3_602_000)
      expect(both.asked.daily).toEqual(["retrieveUserQuotaSummary", "retrieveUserQuotaSummary"])
    } finally { both.stop(); rmSync(root, { recursive: true, force: true }) }
  })

  test("a plan or project lookup's wait keeps the windows read, partial, and holds only that call", async () => {
    // The plan lookup after a whole summary.
    const root = temp(); credential(root)
    const plan429 = hosts(path => path.includes("loadCodeAssist") ? status(429, { "Retry-After": "3600" }) : Response.json(summary(0.5)), path => path.includes("loadCodeAssist") ? status(429, { "Retry-After": "3600" }) : status(503))
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], plan429.bases)
      let at = 10_000_000
      const limits = new Limits(() => [{ provider: "antigravity", service: "antigravity", limits: plan.limits }], undefined, () => at)
      await limits.tick()
      expect(limits.list()[0]?.windows.map(w => w.used)).toEqual([0.5, 0.5, 0.5, 0.5])
      expect(limits.list()[0]?.problem).toBeUndefined()
      expect(plan429.asked.main.filter(path => path === "loadCodeAssist")).toHaveLength(1)
      at += 610_000; await limits.tick()
      expect(limits.list()[0]?.problem).toBeUndefined()
      expect(plan429.asked.main.filter(path => path === "retrieveUserQuotaSummary")).toHaveLength(2)
      expect(plan429.asked.main.filter(path => path === "loadCodeAssist")).toHaveLength(1)
    } finally { plan429.stop(); rmSync(root, { recursive: true, force: true }) }
    // The project lookup on the legacy path, before the quota it's for.
    const legacy = temp(); credential(legacy)
    const project = hosts(path => path.includes("loadCodeAssist") ? status(429, { "Retry-After": "3600" }) : path.includes("retrieveUserQuota") && !path.includes("Summary") ? Response.json({ buckets: [{ modelId: "gemini-3-pro", remainingFraction: 0.8 }] }) : status(404), () => status(404))
    try {
      const plan = new AntigravityPlan(() => legacy, () => join(legacy, "box-usage"), undefined, async () => [], project.bases)
      const reading = await plan.limits.read!(1000)
      expect(reading?.windows.map(w => w.used)).toEqual([0.2])
      expect(reading?.partial).toBe(true)
      expect(project.asked.main.filter(path => path === "loadCodeAssist")).toHaveLength(1)
      expect((await plan.limits.read!(2000))?.windows.map(w => w.used)).toEqual([0.2])
      expect(project.asked.main.filter(path => path === "loadCodeAssist")).toHaveLength(1)
    } finally { project.stop(); rmSync(legacy, { recursive: true, force: true }) }
  })

  test("the language server's plan status waiting keeps its windows, and only that call waits", async () => {
    const root = temp(); credential(root)
    const asked: string[] = []
    let groups = true
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const method = new URL(req.url).pathname.split("/").pop()!; asked.push(method); return method === "GetUserStatus" ? status(429, { "Retry-After": "3600" }) : Response.json(groups ? summary(0.25) : {}) } })
    const cloud = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json(summary(0.5)) } })
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [{ scheme: "http", port: server.port!, csrf: "fixture-csrf" }], [cloud.url.origin])
      const reading = await plan.limits.read!(1000)
      expect(reading?.windows.map(w => w.used)).toEqual([0.75, 0.75, 0.75, 0.75])
      expect(reading?.partial).toBe(true)
      expect((await plan.limits.read!(2000))?.windows.length).toBe(4)
      expect(asked).toEqual(["RetrieveUserQuotaSummary", "GetUserStatus", "RetrieveUserQuotaSummary"])
      // Its summary without groups: its legacy quotas wait with its status, and the cloud is read.
      groups = false
      expect((await plan.limits.read!(3000))?.windows.map(w => w.used)).toEqual([0.5, 0.5, 0.5, 0.5])
      expect(asked).toEqual(["RetrieveUserQuotaSummary", "GetUserStatus", "RetrieveUserQuotaSummary", "RetrieveUserQuotaSummary"])
    } finally { server.stop(true); cloud.stop(true); rmSync(root, { recursive: true, force: true }) }
  })

  test("with every host waiting, the read waits for the soonest, and says whether a request left", async () => {
    const root = temp(); credential(root)
    const both = hosts(() => status(429, { "Retry-After": "7200" }), () => status(429, { "Retry-After": "300" }))
    try {
      const plan = new AntigravityPlan(() => root, () => join(root, "box-usage"), undefined, async () => [], both.bases)
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "rate-limited", until: 301_000, sent: true })
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "rate-limited", until: 301_000, sent: false })
      // The daily host's wait over, it alone is asked; the main host still waits.
      await expect(plan.limits.read!(302_000)).rejects.toMatchObject({ kind: "rate-limited", until: 602_000, sent: true })
      expect(both.asked.main).toEqual(["retrieveUserQuotaSummary"])
      expect(both.asked.daily).toEqual(["retrieveUserQuotaSummary", "retrieveUserQuotaSummary"])
    } finally { both.stop(); rmSync(root, { recursive: true, force: true }) }
  })
})
