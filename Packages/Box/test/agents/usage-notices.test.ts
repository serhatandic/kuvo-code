import "../safety"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Limits, LimitsProblem, limitsRoutes, type LimitedAccount } from "../../src/agents/limits"
import { LimitsPeers, type LimitsMail } from "../../src/agents/limits-peers"
import { UsageSettings } from "../../src/agents/usage/settings"
import { initialState, meter, transitions, type Meter, type NoticeState } from "../../src/agents/usage/notices"

const all = { underTenPercent: true, healthyToClose: true, closeToRunningOut: true }
const off = { underTenPercent: false, healthyToClose: false, closeToRunningOut: false }
const reset = 1_700_000_000_000
const step = (m: Meter, previous = initialState(), fraction = 0.5, resetsAt = reset, toggles = all) => transitions(m, fraction, resetsAt, previous, toggles)

test("healthy to close fires once", () => { const a = step("healthy"); const b = step("close", a.state); expect(b.fire).toEqual(["healthyToClose"]); expect(step("close", b.state).fire).toEqual([]) })
test("close to running out", () => expect(step("runningOut", step("close", step("healthy").state).state).fire).toEqual(["closeToRunningOut"]))
test("healthy straight to red fires only critical", () => expect(step("runningOut", step("healthy").state).fire).toEqual(["closeToRunningOut"]))
test("under ten once per window", () => { const a = step("close", step("close").state, 0.08); expect(a.fire).toContain("underTenPercent"); expect(step("close", a.state, 0.05).fire).not.toContain("underTenPercent") })
test("cold start records bad baseline", () => { for (const m of ["runningOut", "level"] as Meter[]) expect(step(m, initialState(), 0.01).fire).toEqual([]); const a = step("healthy", step("runningOut", initialState(), 0.02).state); expect(step("runningOut", a.state, 0.02).fire).toEqual(["closeToRunningOut", "underTenPercent"]) })
test("reset rollover re-arms", () => { const a = step("close", step("healthy").state); const b = step("healthy", a.state, 0.5, reset + 3600000); expect(step("close", b.state, 0.5, reset + 3600000).fire).toEqual(["healthyToClose"]) })
test("reset jitter does not re-arm", () => { for (const m of ["close", "runningOut"] as Meter[]) { const a = step(m, step("healthy").state); expect(step(m, a.state, 0.5, reset + 90).fire).toEqual([]) } })
test("recovery then worsening re-fires", () => { const a = step("runningOut", step("close", step("healthy").state).state); const b = step("healthy", a.state); const c = step("close", b.state); expect(c.fire).toEqual(["healthyToClose"]); expect(step("runningOut", c.state).fire).toEqual(["closeToRunningOut"]) })
test("under ten recovery re-arms", () => { const a = step("close", step("close").state, 0.05); const b = step("close", a.state, 0.5); expect(step("close", b.state, 0.05).fire).toContain("underTenPercent") })
test("no data never fires", () => expect(step("noData", initialState(), 0.01).fire).toEqual([]))
test("level fires almost out only", () => expect(step("level", step("level", initialState(), 0.2).state, 0.08).fire).toEqual(["underTenPercent"]))
test("no data preserves previous signals", () => expect(step("close", step("noData", step("healthy").state).state).fire).toEqual(["healthyToClose"]))
test("disabled toggles never fire", () => expect(step("close", step("healthy", initialState(), 0.5, reset, off).state, 0.05, reset, off).fire).toEqual([]))
test("per trigger off suppresses only it", () => { const t = { ...all, underTenPercent: false, closeToRunningOut: false }; const a = step("close", step("healthy").state, 0.05, reset, t); expect(a.fire).toEqual(["healthyToClose"]); expect(step("runningOut", a.state, 0.02, reset, t).fire).toEqual([]) })
test("off toggle does not consume edge", () => { const a = step("close", step("healthy").state, 0.2, reset, off); expect(step("close", a.state, 0.2).fire).toEqual(["healthyToClose"]) })

const folder = mkdtempSync(join(tmpdir(), "usage-notices-"))
afterAll(() => rmSync(folder, { recursive: true, force: true }))
function fixture(file?: string) {
  let now = reset - 600000, used = 0.5, failure = false
  const settings = new UsageSettings()
  settings.change({ notifications: all })
  const account: LimitedAccount = { provider: "claude-code", service: "claude", limits: { every: 1, identity: () => "account", read: async () => { if (failure) throw new LimitsProblem("failed", "fixture"); return { windows: [{ id: "seven_day", used, minutes: 100, resetsAt: reset }] } } } }
  const limits = new Limits(() => [account], file, () => now)
  limits.settings = settings
  return { limits, settings, account, advance: (u: number, fail = false) => { now += 1000; used = u; failure = fail } }
}
test("evaluator healthy to close once, facts and route", async () => { const f = fixture(); await f.limits.tick(); f.advance(0.86); await f.limits.tick(); expect(f.limits.notices().map(n => n.milestone)).toEqual(["healthyToClose"]); f.advance(0.86); await f.limits.tick(); expect(f.limits.notices()).toHaveLength(1); const response = await limitsRoutes(f.limits, "GET", []); expect((await response.json()).data.notices[0].row).toMatch(/^claude#/); })
test("evaluator close to red", async () => { const f = fixture(); await f.limits.tick(); f.advance(0.86); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices().map(n => n.milestone)).toEqual(["healthyToClose", "closeToRunningOut", "underTenPercent"]) })
test("evaluator jitter and restart do not duplicate", async () => { const file = join(folder, "restart.json"); const f = fixture(file); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); const before = f.limits.notices(); const g = fixture(file); g.advance(0.95); await g.limits.tick(); expect(g.limits.notices()).toEqual(before) })
test("evaluator all toggles off", async () => { const f = fixture(); f.settings.change({ notifications: off }); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices()).toEqual([]) })
test("evaluator per trigger off", async () => { const f = fixture(); f.settings.change({ notifications: { ...all, closeToRunningOut: false } }); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices().map(n => n.milestone)).toEqual(["underTenPercent"]) })
test("evaluator disabled provider prunes baseline", async () => { const f = fixture(); await f.limits.tick(); f.settings.change({ providers: { enabled: [], known: ["claude"] } }); f.advance(0.86); await f.limits.tick(); f.settings.change({ providers: { enabled: ["claude"], known: ["claude"] } }); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices()).toEqual([]) })
test("evaluator remaining threshold uses remaining regardless display mode", async () => { const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices().find(n => n.milestone === "underTenPercent")?.remaining).toBeCloseTo(0.05) })
test("client delivery failure leaves fact available for retry", async () => { const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick(); const fact = f.limits.notices()[0]; expect(f.limits.notices()[0]).toEqual(fact); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices()[0]).toEqual(fact) })
test("failed read cannot create notices or cache zero", async () => { const f = fixture(); await f.limits.tick(); f.advance(0.95, true); await f.limits.tick(); expect(f.limits.notices()).toEqual([]); expect(f.limits.list()[0].windows[0].used).toBe(0.5) })
test("hidden metric prunes baseline", async () => { const f = fixture(); await f.limits.tick(); f.settings.change({ layout: { placed: [], providerOrder: [], metricOrder: {}, pinned: [], expanded: [], expandOnEnable: [], seeded: [] } }); f.advance(0.95); await f.limits.tick(); expect(f.limits.notices()).toEqual([]) })
test("pace near empty and projection gate", () => { const w = { id: "weekly", used: 0.01, minutes: 100, resetsAt: reset, read: reset - 600000, source: "usage" as const }; expect(meter(w, reset - 5999000)).toBe("level"); expect(meter({ ...w, used: 0.86 }, reset - 600000)).toBe("close"); expect(meter({ ...w, used: 0.95 }, reset - 600000)).toBe("runningOut") })
test("notice peers preserve facts, strip from vouched boxes", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  const sent: {to: string; mail: LimitsMail}[] = []
  const directory = { told: true, own: () => ({key:"own",name:"own"}), peerBoxes: () => [{key:"peer",name:"peer"},{key:"vouched",name:"vouched"}], listen: () => {}, isPeer: (key: string) => key === "peer" }
  new LimitsPeers(f.limits, { followed: true, send: (to, mail) => { sent.push({to,mail}) } }, directory, undefined, () => reset - 599000).tell(true)
  expect(sent.find(s => s.to === "peer")?.mail.accounts[0].notices).toHaveLength(2)
  expect(sent.find(s => s.to === "vouched")?.mail.accounts[0].notices).toBeUndefined()
  const g = fixture(); const peers = new LimitsPeers(g.limits, {followed:true,send:()=>{}}, directory, undefined, () => reset - 599000)
  peers.take("peer", sent[0].mail); expect(peers.notices()).toEqual(f.limits.notices())
  peers.take("vouched", sent[0].mail); expect(peers.notices()).toEqual(f.limits.notices())
})
