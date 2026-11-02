import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The model a new session or bot starts on: the one you picked if you can still use it, else
/// the engine's default, else the first you can use; never one whose account you signed out of
/// (it would only fail). Before the models are known, what you picked, as it is. The engine's
/// answers are stubbed (StubWeb), in the shape it sends them.
@MainActor
@Suite(.serialized) struct StartingModelTests {
    static let engine = "http://127.0.0.1:47999"
    let catalog = Catalog()

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
    }

    private static func model(_ provider: String, _ id: String, released: Int = 1, free: Bool = false, status: String = "active") -> [String: Any] {
        ["id": id, "modelID": id, "providerID": provider, "name": id,
         "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
         "time": ["released": released], "cost": [["input": free ? 0 : 1, "output": free ? 0 : 1]],
         "status": status, "enabled": true, "limit": ["context": 100_000, "output": 8_000]]
    }

    private static func account(_ id: String, signedIn: Bool) -> [String: Any] {
        ["id": id, "name": id.capitalized, "methods": [["type": "key"]],
         "connections": signedIn ? [["type": "credential", "credentialID": "cred_\(id)", "method": "key"]] : []]
    }

    /// The engine as it answers: these accounts, their models, its default.
    private func engine(accounts: [[String: Any]], models: [[String: Any]], defaultModel: [String: Any]?) async throws {
        let location = ["directory": "/"]
        try StubWeb.answer(Self.engine + "/api/integration", json: ["location": location, "data": accounts])
        try StubWeb.answer(Self.engine + "/api/model", json: ["location": location, "data": models])
        try StubWeb.answer(Self.engine + "/api/model/default", json: ["location": location, "data": (defaultModel as Any?) ?? NSNull()])
        try StubWeb.answer(Self.engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(Self.engine + "/api/command", json: ["location": location, "data": []])
        await catalog.refresh()
    }

    private let sonnet = ModelRef(id: "sonnet", providerID: "anthropic")
    private let luna = ModelRef(id: "luna", providerID: "openai")

    @Test func theModelYouPickedIfYouCanUseIt() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        #expect(catalog.startingModel(sonnet) == sonnet)
    }

    /// Signed out of its account: the engine's default instead.
    @Test func signedOutOfItsAccountTheDefault() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: false), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        #expect(catalog.startingModel(sonnet) == luna)
        #expect(catalog.isUnavailable(sonnet))
    }

    /// Gone from its account (retired, or turned off in the engine's settings), though the account
    /// is signed in: unavailable, so it asks for another, and a new session starts on the default.
    @Test(arguments: [false, true])
    func aModelThatsGoneAsksForAnother(turnedOff: Bool) async throws {
        defer { StubWeb.stop() }
        var models = [Self.model("anthropic", "sonnet-next"), Self.model("openai", "luna")]
        if turnedOff {
            var sonnet = Self.model("anthropic", "sonnet")
            sonnet["enabled"] = false
            models.append(sonnet)
        }
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("openai", signedIn: true)],
                         models: models, defaultModel: Self.model("openai", "luna"))
        #expect(catalog.isUnavailable(sonnet))
        #expect(catalog.startingModel(sonnet) == luna)
        #expect(!catalog.isUnavailable(ModelRef(id: "sonnet-next", providerID: "anthropic")))
    }

    /// Neither it nor the default can run: the first model you can use, of the newest first.
    @Test func neitherThenTheFirstYouCanUse() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: false), Self.account("openai", signedIn: false), Self.account("deepseek", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna"),
                                  Self.model("deepseek", "chat-old", released: 1), Self.model("deepseek", "chat-new", released: 2)],
                         defaultModel: Self.model("anthropic", "sonnet"))
        #expect(catalog.startingModel(sonnet, luna) == ModelRef(id: "chat-new", providerID: "deepseek"))
    }

    /// Of the ones you picked, the first you can use (the one picked here, then the last used).
    @Test func theFirstOfTheWantedYouCanUse() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: false), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: nil)
        #expect(catalog.startingModel(nil, sonnet, luna) == luna)
    }

    /// OpenCode Zen's free models need no account.
    @Test func freeModelsNeedNoAccount() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("opencode", signedIn: false)],
                         models: [Self.model("opencode", "glm-free", free: true)],
                         defaultModel: nil)
        let free = ModelRef(id: "glm-free", providerID: "opencode")
        #expect(catalog.startingModel(free) == free)
    }

    /// Just after launch, before the engine has said what there is: what you picked, as it is.
    @Test func beforeTheModelsAreKnownWhatYouPicked() {
        defer { StubWeb.stop() }
        #expect(catalog.startingModel(sonnet) == sonnet)
    }

    /// A coding agent's model, before the agents have said what they have (they come after the
    /// engine): kept, not swapped for another just because it isn't listed yet.
    @Test func aCodingAgentsModelBeforeTheAgentsAnswer() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("openai", signedIn: true)], models: [Self.model("openai", "luna")], defaultModel: Self.model("openai", "luna"))
        let claude = ModelRef(id: "opus", providerID: "claude-code")
        #expect(catalog.startingModel(claude) == claude)
        // The chip shows it, not the default as if that were the one in use.
        #expect(catalog.shownModel(claude)?.ref.sameModel(as: claude) == true)
        #expect(catalog.shownModel(Catalog.autoRef)?.name == "Custom Auto")
        #expect(catalog.shownModel(nil)?.ref.sameModel(as: luna) == true, "nothing picked: the default")
        // The agents can't run (their bridge stopped): the default instead.
        catalog.forgetAgents()
        #expect(catalog.startingModel(claude) == luna)
    }

    /// The same on a machine, whose coding agents run beside its engine and answer after it: a
    /// Claude Code model is kept while they load, and while the machine is away and back; one
    /// whose engine came without them can't run there.
    @Test func onAMachineToo() async throws {
        defer { StubWeb.stop() }
        let machine = Catalog()
        machine.machine = "box"
        machine.api = catalog.api
        try await engine(accounts: [Self.account("openai", signedIn: true)], models: [Self.model("openai", "luna")], defaultModel: Self.model("openai", "luna"))
        await machine.refresh()
        let claude = ModelRef(id: "opus", providerID: "claude-code")
        #expect(machine.startingModel(claude) == claude, "its agents still loading")
        #expect(!machine.isUnavailable(claude))
        machine.forgetAgents(untilBack: true)
        #expect(!machine.isUnavailable(claude), "away, not gone")
        machine.forgetAgents()
        #expect(machine.startingModel(claude) == luna)
        #expect(machine.isUnavailable(claude))
    }

    /// A model its provider has deprecated (it's retired soon): not offered for new conversations,
    /// as the engine's own picker leaves it out, and a new one starts on the default; one already
    /// on it carries on.
    @Test func aDeprecatedModelIsntOfferedButCarriesOn() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet", status: "deprecated"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        #expect(!catalog.modelsByProvider.flatMap(\.models).contains { $0.ref.sameModel(as: sonnet) }, "not in the picker")
        #expect(catalog.startingModel(sonnet) == luna)
        #expect(!catalog.isUnavailable(sonnet), "a conversation on it isn't turned down")
        #expect(catalog.refusal(sonnet) == nil)
    }

    /// Sending on a model that's gone from its signed-in account is turned down before it's sent,
    /// saying to choose another (the engine would only fail it, and Try Again fail the same way);
    /// signed out, it says to sign in. A coding agent's model missing while the agents start goes.
    @Test func sendingOnAModelThatCantRunSaysWhy() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("deepseek", signedIn: false)],
                         models: [Self.model("anthropic", "sonnet-next"), Self.model("deepseek", "chat")],
                         defaultModel: Self.model("anthropic", "sonnet-next"))
        #expect(catalog.refusal(sonnet, on: "lokum") == "sonnet isn’t available on lokum now: choose another model.")
        #expect(catalog.refusal(ModelRef(id: "chat", providerID: "deepseek")) == "chat needs a sign-in: sign in to Deepseek in Settings › Accounts, or choose another model.")
        #expect(catalog.refusal(ModelRef(id: "sonnet-next", providerID: "anthropic")) == nil)
        #expect(catalog.refusal(ModelRef(id: "opus", providerID: "claude-code")) == nil, "its agents still loading")
        // A provider the project's own settings add, which the engine lists only in that project: it goes.
        #expect(catalog.refusal(ModelRef(id: "qwen", providerID: "lmstudio")) == nil)
    }
}
