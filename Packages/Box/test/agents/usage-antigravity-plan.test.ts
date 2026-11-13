import { describe, expect, test } from "bun:test"
import fixtures from "../fixtures/usage/antigravity-plan-cases.json"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AntigravityPlan, antigravitySummary, antigravityLegacy, antigravityProcPorts, discoverAntigravity, antigravityMacOwns } from "../../src/agents/usage/antigravity-plan"
import { Limits, LimitsProblem } from "../../src/agents/limits"

const summary = (fraction = 0.75) => ({ groups: [{ buckets: ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"].map(bucketId => ({ bucketId, remainingFraction: fraction })) }] })
const temp = () => mkdtempSync(join(tmpdir(), "kuvo-agy-plan-"))
function credential(profile: string, access = "fixture-token") { mkdirSync(join(profile, "antigravity-acp"), { recursive: true }); writeFileSync(join(profile, "antigravity-acp/acp_token.json"), JSON.stringify({ access_token: access })) }

describe("Antigravity quota mapper", () => {
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
      const runner: any = async (program: string) => ({ code: 0, stdout: program.endsWith("ps") ? `10 /fixture/${executable} GEMINI_HOME=/fixture/profile` : "agy 10 TCP 127.0.0.1:12345 (LISTEN)\n", stderr: "" })
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
    const runner: any = async (program: string) => { calls.push(program); return { code: 0, stdout: program.endsWith("ps") ? "10 /fixture/language_server --csrf_token fixture GEMINI_HOME=/fixture/profile\n" : "agy 10 TCP 127.0.0.1:12345 (LISTEN)\n", stderr: "" } }
    expect((await discoverAntigravity("/fixture/profile", "darwin", "/unused", runner))[0]?.port).toBe(12345)
    expect(calls).toEqual(["/bin/ps", "/usr/sbin/lsof"])
    expect(await discoverAntigravity("/outside", "darwin", "/unused", runner)).toEqual([])
  })
})

describe("Antigravity own-account stand-in service", () => {
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
      const plan = new AntigravityPlan(() => root, undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
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
      const plan = new AntigravityPlan(() => root, undefined, async () => [], [server.url.origin])
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
  test("persisted refusal survives restart and metadata-only credential rewrites", async () => {
    const root = temp(); credential(root)
    let at = 10_000_000, calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { calls++; return new Response("{}", { status: 401 }) } })
    const saved = join(root, "limits.json")
    const start = () => {
      const plan = new AntigravityPlan(() => root, undefined, async () => [], [server.url.origin])
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
      const plan = new AntigravityPlan(() => root, undefined, async () => [], [server.url.origin], server.url.origin + "/oauth")
      await expect(plan.limits.read!(1000)).rejects.toMatchObject({ kind: "rate-limited", until: 3601000 })
      expect(calls).toBe(1)
      status = 401
      await expect(plan.limits.read!(2000)).rejects.toMatchObject({ kind: "expired" })
      await expect(plan.limits.read!(3000)).rejects.toMatchObject({ kind: "expired", sent: false })
      expect(calls).toBe(2)
      credential(root, "new-fixture")
      status = 200
      await expect(plan.limits.read!(4000)).rejects.toBeInstanceOf(LimitsProblem)
      expect(calls).toBeGreaterThan(2)
    } finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  })
  test("complete read, partial and unreadable reads keep prior known windows", async () => {
    const root = temp(); credential(root)
    let at = 10_000_000, mode = "complete", calls = 0
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { calls++; const path = new URL(req.url).pathname; return Response.json(path.includes("loadCodeAssist") ? { paidTier: { id: "g1-ultra-lite-tier" } } : mode === "complete" ? summary() : mode === "partial" ? { groups: [{ buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.1 }] }] } : { groups: [] }) } })
    try {
      const plan = new AntigravityPlan(() => root, undefined, async () => [], [server.url.origin])
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
})
