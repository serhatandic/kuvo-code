import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Your accounts on your machines: each computer's own. A new machine starts with this Mac's API
/// keys and GitHub Copilot's sign-in, once, and from then on keeps its own: what changes here
/// stays here. A sign-in that renews itself with a new token each time (ChatGPT's, GitLab's) is
/// never copied, as two copies end it everywhere. Copies made before of those are taken back (a
/// newer one the machine renewed comes here first), and signing out here never takes a machine's
/// sign-in. Two engines' accounts, faked (FakeEngine).
@MainActor
@Suite(.serialized) struct SignInSyncTests {
    let app: AppModel
    let mac: FakeEngine
    let machine: FakeEngine
    let server = "my-server"

    init() {
        TestEnvironment.prepare()
        for key in ["machineCopies", "machineSignOuts"] { UserDefaults.standard.removeObject(forKey: key) }
        StubWeb.start(hosts: ["127.0.0.1"])
        let accounts = ["openai", "github-copilot", "deepseek", "gitlab"]
        mac = FakeEngine(port: 47901, accounts: accounts)
        machine = FakeEngine(port: 47902, accounts: accounts)
        app = AppModel()
    }

    private func sync(accounts: Bool = false) async {
        await app.copySignIns(mac: mac.api, remote: machine.api, machine: server, accounts: accounts)
    }

    private func done() {
        StubWeb.stop()
        for key in ["machineCopies", "machineSignOuts"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    private func chatGPT(_ refresh: String, expires: Double = 1) -> [String: Any] {
        ["type": "oauth", "methodID": "chatgpt-browser", "access": "a", "refresh": refresh, "expires": expires, "metadata": ["accountID": "acct_1"]]
    }

    @Test func aNewMachineStartsWithTheKeysAndCopilotThenKeepsItsOwn() async {
        defer { done() }
        mac.store("deepseek", value: ["type": "key", "key": "sk-mac"])
        mac.store("github-copilot", value: ["type": "oauth", "access": "a", "refresh": "gho_mac", "expires": 1])
        mac.store("openai", value: chatGPT("rt_mac"))
        // New: it starts with them, but not one that renews itself.
        await sync(accounts: true)
        #expect(machine.stored("deepseek").map(\.secret) == ["sk-mac"])
        #expect(machine.stored("github-copilot").map(\.secret) == ["gho_mac"])
        #expect(machine.stored("openai").isEmpty)
        // From then on its own: a key added or changed here stays here.
        mac.store("gitlab", value: ["type": "key", "key": "glpat-mac"])
        await sync()
        #expect(machine.stored("gitlab").isEmpty)
        #expect(machine.stored("deepseek").count == 1 && machine.stored("github-copilot").count == 1)
    }

    /// A copy an earlier version made, with this Mac's very token: taken off the machine.
    @Test func anOldCopyIsTakenBack() async {
        defer { done() }
        mac.store("openai", value: chatGPT("rt_shared"))
        machine.store("openai", value: chatGPT("rt_shared"))
        await sync()
        #expect(machine.stored("openai").isEmpty)
        #expect(mac.stored("openai").map(\.secret) == ["rt_shared"])
    }

    /// The machine renewed its copy while apart, so this Mac's token is refused now: the machine's
    /// comes here before it goes.
    @Test func aCopyTheMachineRenewedComesBackFirst() async {
        defer { done() }
        let here = mac.store("openai", value: chatGPT("rt_old", expires: 1))
        let there = machine.store("openai", value: chatGPT("rt_new", expires: 2))
        UserDefaults.standard.set([server: ["openai": "\(here)|\(there)"]], forKey: "machineCopies")
        await sync()
        #expect(mac.stored("openai").map(\.secret) == ["rt_new"])
        #expect(mac.stored("openai").first?.active == true)
        #expect(machine.stored("openai").isEmpty)
    }

    /// One the machine signed in to itself stays: not replaced by this Mac's key, nor copied here.
    @Test func theMachinesOwnSignInStays() async {
        defer { done() }
        mac.store("openai", value: ["type": "key", "key": "sk-mac"])
        machine.store("openai", value: chatGPT("rt_machine"))
        await sync()
        #expect(machine.stored("openai").map(\.secret) == ["rt_machine"])
        #expect(mac.stored("openai").map(\.secret) == ["sk-mac"])
    }

    /// A sign-out left from before computers kept their own takes the copies from the machine, not
    /// a sign-in it made itself.
    @Test func anOldSignOutLeavesTheMachinesOwn() async {
        defer { done() }
        let key = mac.store("gitlab", value: ["type": "key", "key": "glpat-mac"])
        await sync(accounts: true)
        #expect(machine.stored("gitlab").map(\.secret) == ["glpat-mac"])
        machine.store("gitlab", value: ["type": "oauth", "access": "a", "refresh": "glrt_machine", "expires": 5])
        // Signed out here, while the machine was away (as forgetSignIn leaves it for an account).
        try? await mac.api.removeCredential(key)
        UserDefaults.standard.set([server: ["keys:gitlab"]], forKey: "machineSignOuts")
        await sync()
        #expect(machine.stored("gitlab").map(\.secret) == ["glrt_machine"])
        #expect(UserDefaults.standard.dictionary(forKey: "machineSignOuts") == nil)
    }

    private func linear(_ account: String, refresh: String, expires: Double = 1) -> [String: Any] {
        ["type": "oauth", "access": "a", "refresh": refresh, "expires": expires, "metadata": ["accountID": account]]
    }

    /// An integration's sign-in is each computer's own: one the machine signed in to as another
    /// account stays, and a machine without one signs in there (a new machine starts with this
    /// Mac's, once). A copy of the same account on both stays one sign-in, the newer winning.
    @Test func anIntegrationsSignInIsEachComputersOwn() async {
        defer { done() }
        mac.serve("linear", integration: "mcp_linear")
        machine.serve("linear", integration: "mcp_linear")
        mac.store("mcp_linear", value: linear("personal", refresh: "rt_mac"))
        // None there: it isn't given this Mac's.
        await sync()
        #expect(machine.stored("mcp_linear").isEmpty)
        // Its own, as another account: that stays.
        machine.store("mcp_linear", value: linear("work", refresh: "rt_work", expires: 5))
        await sync()
        #expect(machine.stored("mcp_linear").map(\.secret) == ["rt_work"])
        #expect(mac.stored("mcp_linear").map(\.secret) == ["rt_mac"])
    }

    /// A new machine signs in to an integration itself, rather than starting with a copy of this
    /// Mac's: two computers renewing one sign-in end it on the other. A copy an earlier version
    /// made stays one sign-in, the newer winning.
    @Test func aNewMachineSignsInToIntegrationsItself() async {
        defer { done() }
        mac.serve("linear", integration: "mcp_linear")
        machine.serve("linear", integration: "mcp_linear")
        mac.store("mcp_linear", value: linear("personal", refresh: "rt_mac"))
        await sync(accounts: true)
        #expect(machine.stored("mcp_linear").isEmpty)
        // A copy made before: renewed there later (a new refresh token), it comes back here.
        machine.store("mcp_linear", value: linear("personal", refresh: "rt_mac"))
        await sync()
        machine.store("mcp_linear", value: linear("personal", refresh: "rt_renewed", expires: 9))
        await sync()
        #expect(mac.stored("mcp_linear").contains { $0.active && $0.secret == "rt_renewed" })
    }
}
