import "../safety"
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Limits, LimitsProblem, limitsRoutes, type LimitedAccount } from "../../src/agents/limits"
import { LimitsPeers, type LimitsMail } from "../../src/agents/limits-peers"
import { UsageSettings } from "../../src/agents/usage/settings"
import { initialState, meter, transitions, type Meter, type NoticeState, takeNotices, currentNotice, noticeWindowName, noticeAccountName } from "../../src/agents/usage/notices"

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
  return { limits, settings, account, pass: (ms: number) => { now += ms }, advance: (u: number, fail = false) => { now += 1000; used = u; failure = fail } }
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
  const directory = { told: true, setup: "set_test", own: () => ({key:"own",name:"own"}), peerBoxes: () => [{key:"peer",name:"peer"},{key:"vouched",name:"vouched"}], listen: () => {}, isPeer: (key: string) => key === "peer" }
  new LimitsPeers(f.limits, { followed: true, send: (to, mail) => { sent.push({to,mail}) } }, directory, undefined, () => reset - 599000).tell(true)
  expect(sent.find(s => s.to === "peer")?.mail.accounts[0].notices).toHaveLength(2)
  expect(sent.find(s => s.to === "vouched")?.mail.accounts[0].notices).toBeUndefined()
  const g = fixture(); const peers = new LimitsPeers(g.limits, {followed:true,send:()=>{}}, directory, undefined, () => reset - 599000)
  peers.take("peer", sent[0].mail); expect(peers.notices()).toEqual(f.limits.notices())
  peers.take("vouched", sent[0].mail); expect(peers.notices()).toEqual(f.limits.notices())
})
test("large notice history cannot evict the current limits account from peer mail", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  const account = f.limits.list(false)[0]
  account.notices = Array.from({length:100}, (_,i) => ({ ...f.limits.notices()[0], id:`usage_${i}`, row:"a".repeat(300),window:"w".repeat(200) }))
  const sent: LimitsMail[] = []
  const limits = { list: () => [account] } as unknown as Limits
  new LimitsPeers(limits, {followed:true,send:(_,mail)=>{sent.push(mail)}}, {told:true,setup:"set_test",own:()=>({key:"own",name:"own"}),peerBoxes:()=>[{key:"peer",name:"peer"}],listen:()=>{},isPeer:()=>true}).tell(true)
  expect(sent[0].accounts).toHaveLength(1)
  expect(sent[0].accounts[0].windows).toEqual(account.windows)
  expect(Buffer.byteLength(JSON.stringify(sent[0]))).toBeLessThan(40000)
})
test("turn-only Mac Claude inherits peer window dedup without checked timestamps", async () => {
  const f = fixture(), g = fixture()
  f.account.limits.read = undefined; g.account.limits.read = undefined
  await f.limits.tick(); await g.limits.tick()
  const heard = (f: ReturnType<typeof fixture>, used: number) => f.account.limits.heard!({id:"seven_day",used,minutes:100,resetsAt:reset})
  heard(f,0.5); heard(g,0.5)
  f.advance(0.95); heard(f,0.95)
  expect(f.limits.list(false)[0].checked).toBeUndefined()
  const peers = new LimitsPeers(g.limits,{followed:true,send:()=>{}},{told:true,setup:"set_test",own:()=>({key:"own",name:"own"}),peerBoxes:()=>[{key:"peer",name:"peer"}],listen:()=>{},isPeer:()=>true},undefined,()=>reset-599000)
  peers.take("peer",{kind:"limits",noticeSetup:"set_test",at:reset-599000,accounts:f.limits.list(false)})
  g.advance(0.95); heard(g,0.95)
  expect(g.limits.list(false)[0].notices ?? []).toEqual([])
  expect(g.limits.notices()).toEqual(f.limits.notices())
})
test("visibility mappings cover model-specific Codex and Antigravity windows", async () => {
  const { metricID } = await import("../../src/agents/usage/notices")
  const window = { id:"spark.secondary",model:"Spark",used:0.5,read:reset,source:"usage" as const }
  expect(metricID("codex",window)).toBe("codex.sparkWeekly")
  for (const [id,metric] of [["gemini-5h","geminiPro"],["gemini-weekly","geminiWeekly"],["argon-weekly","argonWeekly"],["3p-5h","claude"],["3p-weekly","claudeWeekly"]]) expect(metricID("antigravity",{...window,id,model:undefined})).toBe(`antigravity.${metric}`)
})
test("exact ten percent remaining does not trigger Almost Out", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.9); await f.limits.tick()
  expect(f.limits.notices().some(n=>n.milestone==="underTenPercent")).toBe(false)
  f.advance(0.91); await f.limits.tick()
  expect(f.limits.notices().some(n=>n.milestone==="underTenPercent")).toBe(true)
})
test("parallel readers use the same occurrence IDs and recovery receives a new one", async () => {
  const f = fixture(), g = fixture(); await f.limits.tick(); await g.limits.tick()
  f.advance(0.95); g.advance(0.95); await f.limits.tick(); await g.limits.tick()
  expect(f.limits.notices().map(n=>n.id)).toEqual(g.limits.notices().map(n=>n.id))
  const first = f.limits.notices().map(n=>n.id)
  f.advance(0.5); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  expect(f.limits.notices().slice(2).every(n=>!first.includes(n.id))).toBe(true)
})
test("peer handoff timestamps are normalized to the receiver clock", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  const accounts = structuredClone(f.limits.list(false))
  for (const state of Object.values(accounts[0].noticeState!)) state.read! += 3600000
  for (const notice of accounts[0].notices!) notice.at += 3600000
  const g = fixture()
  const peers = new LimitsPeers(g.limits,{followed:true,send:()=>{}},{told:true,setup:"set_test",own:()=>({key:"own",name:"own"}),peerBoxes:()=>[{key:"peer",name:"peer"}],listen:()=>{},isPeer:()=>true},undefined,()=>reset-599000)
  peers.take("peer",{kind:"limits",noticeSetup:"set_test",at:reset-599000+3600000,accounts})
  expect(peers.noticeStates("claude",accounts[0].identity!)[0].seven_day.read).toBe(reset-599000)
  expect(peers.notices()).toHaveLength(2)
  expect(peers.notices().every(n=>n.at===reset-599000)).toBe(true)
})
test("one direct account holder forwards even a received peer decision", async () => {
  const a = fixture(), z = fixture(); await a.limits.tick(); await z.limits.tick()
  const directory = (own: string, other: string) => ({told:true,setup:"set_test",own:()=>({key:own,name:own}),peerBoxes:()=>[{key:other,name:other},{key:"vouched",name:"vouched"}],listen:()=>{},isPeer:(key:string)=>key!=="vouched"})
  const ap = new LimitsPeers(a.limits,{followed:true,send:()=>{}},directory("a","z"),undefined,()=>reset-599000)
  const zp = new LimitsPeers(z.limits,{followed:true,send:()=>{}},directory("z","a"),undefined,()=>reset-599000)
  ap.take("z",{kind:"limits",noticeSetup:"set_test",at:reset-600000,accounts:z.limits.list(false)})
  zp.take("a",{kind:"limits",noticeSetup:"set_test",at:reset-600000,accounts:a.limits.list(false)})
  z.advance(0.95); await z.limits.tick()
  expect(z.limits.pushableNotices()).toEqual([])
  a.pass(1000)
  ap.take("z",{kind:"limits",noticeSetup:"set_test",at:reset-599000,accounts:z.limits.list(false)})
  expect(a.limits.pushableNotices()).toEqual(z.limits.notices())
  expect(a.limits.list(false)[0].notices??[]).toEqual([])
})
test("provider hide and re-enable resets baseline but preserves occurrence counters", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  const first = f.limits.notices().map(n=>n.id)
  f.settings.change({providers:{known:["claude"],enabled:[]}}); f.advance(0.5); await f.limits.tick()
  f.settings.change({providers:{known:["claude"],enabled:["claude"]}}); f.advance(0.5); await f.limits.tick()
  f.advance(0.95); await f.limits.tick()
  expect(f.limits.notices()).toHaveLength(4)
  expect(f.limits.notices().slice(2).every(n=>!first.includes(n.id))).toBe(true)
})

test("a shared machine never relays one person's notices or dedup to another setup", async () => {
  const a = fixture(); await a.limits.tick(); a.advance(0.95); await a.limits.tick()
  const shared = fixture(), b = fixture()
  const mail: LimitsMail = {kind:"limits",at:reset-599000,noticeSetup:"set_a",accounts:a.limits.list(false)}
  const sent: LimitsMail[] = []
  const sharedDirectory = {told:true,inNoSetup:true,own:()=>({key:"shared",name:"shared"}),peerBoxes:()=>[{key:"a",name:"a"},{key:"b",name:"b"}],listen:()=>{},isPeer:()=>true}
  const sharedPeers = new LimitsPeers(shared.limits,{followed:true,send:(_,m)=>{sent.push(m)}},sharedDirectory,undefined,()=>reset-599000)
  sharedPeers.take("a",mail)
  expect(sharedPeers.notices()).toEqual([])
  expect(sharedPeers.noticeStates("claude",a.limits.list(false)[0].identity!)).toEqual([])
  // Even malformed cached/local fields cannot escape an unscoped machine in any outbound path.
  await shared.limits.tick(); shared.advance(0.95); await shared.limits.tick()
  sharedPeers.tell(true)
  expect(sent.every(m=>m.accounts.every(account=>!account.notices && !account.noticeState))).toBe(true)
  expect(sent.every(m=>m.noticeSetup===undefined)).toBe(true)
  const bp = new LimitsPeers(b.limits,{followed:true,send:()=>{}},{told:true,setup:"set_b",own:()=>({key:"b",name:"b"}),peerBoxes:()=>[{key:"shared",name:"shared"}],listen:()=>{},isPeer:()=>true},undefined,()=>reset-599000)
  bp.take("shared",mail)
  expect(bp.notices()).toEqual([])
  expect(bp.rows([]).every(row=>!(row as any).notices?.length)).toBe(true)
})

test("setup changes invalidate notice caches while preserving ordinary limit readings", async () => {
  const a = fixture(); await a.limits.tick(); a.advance(0.95); await a.limits.tick()
  const b = fixture(); let changed = () => {}
  const directory = {told:true,setup:"set_a",own:()=>({key:"b",name:"b"}),peerBoxes:()=>[{key:"a",name:"a"}],listen:(f:()=>void)=>{changed=f},isPeer:()=>true}
  const peers = new LimitsPeers(b.limits,{followed:true,send:()=>{}},directory,undefined,()=>reset-599000)
  peers.take("a",{kind:"limits",at:reset-599000,noticeSetup:"set_a",accounts:a.limits.list(false)})
  expect(peers.notices()).toHaveLength(2)
  directory.setup="set_b"; changed()
  expect(peers.notices()).toEqual([])
  expect(peers.rows([])[0].windows).toHaveLength(1)
})

test("catch-up is short and warnings disappear when their reset passes", async () => {
  const f = fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  const fact = f.limits.notices()[0]
  expect(currentNotice(fact,fact.at+599999)).toBe(false) // its reset arrives before ten minutes
  expect(currentNotice({...fact,resetsAt:undefined},fact.at+599999)).toBe(true)
  expect(currentNotice({...fact,resetsAt:undefined},fact.at+600000)).toBe(false)
  expect(currentNotice(fact,fact.resetsAt!)).toBe(false)
  f.pass(600000)
  expect(f.limits.notices()).toEqual([])
  expect(f.limits.list(false)[0].notices).toEqual([])
  expect(f.limits.pushableNotices()).toEqual([])
})

test("without layout settings only default meters can decide notices", async () => {
  const f = fixture(); f.account.limits.read = undefined
  await f.limits.tick()
  const heard = (id:string,used:number) => f.account.limits.heard!({id,used,minutes:100,resetsAt:reset})
  heard("seven_day_sonnet",0.5); f.advance(0.95); heard("seven_day_sonnet",0.95)
  expect(f.limits.notices()).toEqual([])
  heard("seven_day",0.5); f.advance(0.95); heard("seven_day",0.95)
  expect(f.limits.notices()).toHaveLength(2)
})

test("a decision waits for the directory and pins a forwarder only once", async () => {
  const f = fixture(); let changed = () => {}; let known = false
  const directory = {told:false,setup:"set_test",own:()=>known?{key:"z",name:"z"}:undefined,peerBoxes:()=>[{key:"a",name:"a"}],listen:(f:()=>void)=>{changed=f},isPeer:()=>true}
  const peers = new LimitsPeers(f.limits,{followed:true,send:()=>{}},directory,undefined,()=>reset-599000)
  await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  expect(f.limits.notices().every(n=>!n.forwarder)).toBe(true)
  expect(f.limits.pushableNotices()).toEqual([])
  known=true; directory.told=true; changed()
  expect(f.limits.notices().every(n=>n.forwarder==="z")).toBe(true)
  const other = fixture(); await other.limits.tick()
  peers.take("a",{kind:"limits",at:reset-599000,noticeSetup:"set_test",accounts:other.limits.list(false)})
  changed()
  expect(peers.forwarder("claude",f.limits.list(false)[0].identity!)).toBe("a")
  expect(f.limits.notices().every(n=>n.forwarder==="z")).toBe(true)
})

test("ordinary turn readings keep the thirty-second disk throttle while new notices persist immediately", async () => {
  const file=join(folder,"save-throttle.json"), f=fixture(file)
  f.account.limits.read=undefined
  await f.limits.tick()
  const heard = (used:number)=>f.account.limits.heard!({id:"seven_day",used,minutes:100,resetsAt:reset})
  heard(0.5)
  const baseline=readFileSync(file,"utf8")
  f.advance(0.51); heard(0.51)
  expect(readFileSync(file,"utf8")).toBe(baseline)
  f.pass(30000); heard(0.52)
  expect(JSON.parse(readFileSync(file,"utf8")).accounts["claude-code"].windows[0].used).toBe(0.52)
  f.advance(0.95); heard(0.95)
  expect(JSON.parse(readFileSync(file,"utf8")).accounts["claude-code"].notices).toHaveLength(2)
})

test("unsupported Devin notice facts from older peers cannot trigger native alerts", async () => {
  const f=fixture(); await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  expect(takeNotices(f.limits.notices().map(n=>({...n,service:"devin",row:"devin#0123456789abcdef"})))).toEqual([])
})

test("notice wording carries the same named account and window as the panel", async () => {
  const f=fixture(); f.account.agent={kind:"claude",account:"work"}; f.account.label="Work"
  await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  expect(f.limits.notices()[0].accountName).toBe("Claude · Work")
  expect(f.limits.notices()[0].windowName).toBe("1-hour")
  expect(noticeAccountName("codex","codex","Personal")).toBe("Codex · Personal")
  expect(noticeAccountName("codex")).toBe("ChatGPT")
  expect(noticeWindowName({id:"seven_day",used:0.2,minutes:10080})).toBe("Weekly")
  expect(noticeWindowName({id:"seven_day_sonnet",used:0.2,minutes:10080,model:"Sonnet"})).toBe("Sonnet")
  expect(noticeWindowName({id:"primary",used:0.2,minutes:300})).toBe("Session")
})

test("learning the setup immediately shares pending facts despite a recent unscoped limits mail", async () => {
  const f=fixture(); f.limits.ownKey=()=>"own"; await f.limits.tick(); f.advance(0.95); await f.limits.tick()
  let changed=()=>{}
  const directory:{told:boolean;setup?:string;own:()=>{key:string;name:string};peerBoxes:()=>{key:string;name:string}[];listen:(f:()=>void)=>void;isPeer:()=>boolean}={told:true,own:()=>({key:"own",name:"own"}),peerBoxes:()=>[{key:"peer",name:"peer"}],listen:(f)=>{changed=f},isPeer:()=>true}
  const sent:LimitsMail[]=[]
  const peers=new LimitsPeers(f.limits,{followed:true,send:(_,m)=>{sent.push(m)}},directory,undefined,()=>reset-599000)
  peers.tell(true)
  expect(sent).toHaveLength(1)
  expect(sent[0].accounts[0].notices).toBeUndefined()
  directory.setup="set_test"; changed()
  expect(sent).toHaveLength(2)
  expect(sent[1].noticeSetup).toBe("set_test")
  expect(sent[1].accounts[0].notices).toHaveLength(2)
})
