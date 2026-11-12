import ClientSessions
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

    /// A coding agent's sign-in Claude ended: its bridge lists none of its models then, and the
    /// chip still names the one the conversation is on, not "Choose a Model".
    @Test func aCodingAgentsChipKeepsItsModelOnceSignedOut() async throws {
        defer { StubWeb.stop() }
        nonisolated final class Account: @unchecked Sendable {
            let lock = NSLock()
            var signedIn = true
        }
        let account = Account()
        let bridge = "http://127.0.0.1:47981"
        StubWeb.handle(bridge + "/api/integration") { _, _ in
            let signedIn = account.lock.withLock { account.signedIn }
            return StubWeb.json(["data": [[
                "id": "claude-code", "name": "Claude Code", "methods": [["type": "oauth", "id": "claudeai", "label": "Claude"]],
                "connections": signedIn ? [["type": "credential", "credentialID": "cred_claude", "method": "oauth"]] : [],
                "metadata": ["source": "agent", "agent": "claude-code", "accountID": "default", "installed": true],
            ]]])
        }
        var opus = Self.model("claude-code", "opus")
        opus["name"] = "Claude Opus"
        let listed = StubWeb.json(["data": [opus]]), none = StubWeb.json(["data": []])
        StubWeb.handle(bridge + "/api/model") { _, _ in
            account.lock.withLock { account.signedIn } ? listed : none
        }
        try await engine(accounts: [Self.account("openai", signedIn: true)], models: [Self.model("openai", "luna")], defaultModel: Self.model("openai", "luna"))
        let agents = OutsideAgents()
        catalog.outsideAgents = agents
        agents.connect(ServerEndpoint(url: URL(string: bridge)!, password: "test"), folderPrefix: "")
        defer { agents.disconnect() }
        await catalog.refreshAgents(fresh: true)
        let claude = ModelRef(id: "opus", providerID: "claude-code")
        #expect(catalog.chipModel(claude)?.name == "Claude Opus")
        // One its program no longer lists, its account signed in: on a box from before
        // `sessions.models` (the old-box path), named and sent, as before (the agent says whether it
        // can run it), not "Choose a Model".
        let dropped = ModelRef(id: "opus-4", providerID: "claude-code")
        #expect(catalog.chipModel(dropped)?.name == "opus-4")
        #expect(catalog.refusal(dropped) == nil)
        // Its box says it's gone (#572): "Choose a Model", and a message on it isn't sent to fail.
        let gone = try said(#"{"model":{"providerID":"claude-code","id":"opus-4"},"runs":false,"missing":"gone","account":{"id":"claude-code","name":"Claude Code"}}"#)
        #expect(catalog.chipModel(dropped, in: .all, said: gone) == nil)
        #expect(catalog.refusal(dropped, said: gone) == "opus-4 is no longer among Claude Code’s models: choose another model.")

        account.lock.withLock { account.signedIn = false }
        await catalog.refreshAgents(fresh: true)
        #expect(catalog.needsSignIn(claude))
        #expect(catalog.chipModel(claude)?.name == "Claude Opus", "the model it's on, while its account needs a sign-in")
    }

    /// A conversation on a model whose account was signed out of: its chip still names that model
    /// (the card under its last turn says to sign in, and how), rather than "Choose a Model" as if
    /// none were picked. One that's gone from its account asks for another.
    @Test func aConversationsChipNamesItsModelWhileItsAccountNeedsASignIn() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: false), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        #expect(catalog.chipModel(sonnet)?.id == "sonnet")
        #expect(catalog.chipModel(ModelRef(id: "gone", providerID: "openai")) == nil)
        #expect(catalog.chipModel(nil)?.id == "luna", "nothing picked: the default")
    }

    /// Sending on a model that's gone from its signed-in account is turned down before it's sent,
    /// saying to choose another (the engine would only fail it, and Try Again fail the same way);
    /// signed out, it says to sign in. A coding agent's model missing while the agents start goes.
    @Test func sendingOnAModelThatCantRunSaysWhy() async throws {
        defer { StubWeb.stop() }
        // xAI and OpenAI as the engine lists them: their plans' sign-ins (which Accounts offers only
        // to one made with them before), and a key. OpenAI's made with its ChatGPT plan before.
        let xai: [String: Any] = ["id": "xai", "name": "xAI", "methods": [["type": "oauth", "id": "device", "label": "SuperGrok"], ["type": "key"]], "connections": [Any]()]
        let openai: [String: Any] = ["id": "openai", "name": "OpenAI", "methods": [["type": "oauth", "id": "chatgpt-browser", "label": "ChatGPT Pro/Plus"], ["type": "key"]],
                                     "connections": [["type": "credential", "credentialID": "cred_openai", "method": "oauth"]]]
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("deepseek", signedIn: false), xai, openai],
                         models: [Self.model("anthropic", "sonnet-next"), Self.model("deepseek", "chat"), Self.model("xai", "grok-4.7")],
                         defaultModel: Self.model("anthropic", "sonnet-next"))
        #expect(catalog.refusal(sonnet, on: "devbox") == "sonnet isn’t available on devbox now: choose another model.")
        #expect(catalog.refusal(ModelRef(id: "chat", providerID: "deepseek")) == "chat needs a sign-in: sign in to Deepseek in Settings › Accounts, or choose another model.")
        // An old conversation on the engine's xAI model (#338): a SuperGrok plan signed in to as
        // Grok never runs it, so it says a key, or a model under Grok, not to sign in to the plan.
        #expect(catalog.refusal(ModelRef(id: "grok-4.7", providerID: "xai")) == "grok-4.7 needs an xAI key: add one in Settings › Accounts, or choose another model (with a SuperGrok plan, one under Grok).")
        // Its card's Sign In opens a sheet with only a key: its help says that.
        #expect(catalog.signInHelp("xai") == "Add an xAI key (with a SuperGrok plan, choose a model under Grok instead)")
        #expect(catalog.signInHelp("openai") == "Sign in to Codex (your ChatGPT plan, under Subscriptions)", "a plan's sign-in made before: signed in to again")
        #expect(catalog.signInHelp("deepseek", on: "devbox") == "Sign in to Deepseek on devbox: its sign-ins are its own")
        #expect(catalog.refusal(ModelRef(id: "sonnet-next", providerID: "anthropic")) == nil)
        #expect(catalog.refusal(ModelRef(id: "opus", providerID: "claude-code")) == nil, "its agents still loading")
        // A provider the project's own settings add, which the engine lists only in that project: it goes.
        #expect(catalog.refusal(ModelRef(id: "qwen", providerID: "lmstudio")) == nil)
    }

    private func said(_ json: String) throws -> SessionModelState {
        try JSONDecoder().decode(SessionModelState.self, from: Data(json.utf8))
    }

    /// What the conversation's box says of its model decides its chip, a message refused on it and
    /// its card's Sign In, over what this Mac's lists would say (#572: the Mac and the phone each
    /// decided for themselves, and disagreed on the same conversation).
    @Test func theBoxSaysWhatAConversationsModelNeeds() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        // Signed out on its box, though this Mac's lists have it: named, and a message on it says
        // where to sign in, on the machine it's on.
        let out = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":false,"missing":"signIn","account":{"id":"anthropic","name":"Anthropic"}}"#)
        #expect(catalog.chipModel(sonnet, in: .all, said: out)?.id == "sonnet")
        #expect(catalog.refusal(sonnet, on: "devbox", said: out) == "Sonnet needs a sign-in on devbox: sign in to Anthropic in Settings › Accounts, or choose another model.")
        #expect(catalog.chipHelp(sonnet, in: .all, on: "devbox", said: out) == "Sonnet needs a sign-in on devbox: sign in to Anthropic in Settings › Accounts, or choose another model.")
        #expect(catalog.needsAccount(sonnet, said: out))
        // The engine's xAI, its SuperGrok plan Grok's: its card's Sign In opens the key sheet, and
        // says so, here and on a machine whose accounts this Mac doesn't list (#338's leftover).
        let grok = ModelRef(id: "grok-4.7", providerID: "xai")
        let xai = try said(#"{"model":{"providerID":"xai","id":"grok-4.7"},"name":"Grok 4.7","runs":false,"missing":"key","account":{"id":"xai","name":"xAI"},"plan":{"name":"SuperGrok","agent":"Grok","provider":"grok-cli"}}"#)
        #expect(catalog.signInHelp("xai", on: "devbox", said: xai) == "Add an xAI key on devbox (with a SuperGrok plan, choose a model under Grok instead)")
        #expect(catalog.refusal(grok, said: xai) == "Grok 4.7 needs an xAI key: add one in Settings › Accounts, or choose another model (with a SuperGrok plan, one under Grok).")
        #expect(catalog.chipModel(grok, in: .all, said: xai)?.name == "Grok 4.7", "named as its box lists it, though this Mac doesn't")
        // It runs: named, nothing refused, its help the chip's own.
        let fine = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":true}"#)
        #expect(catalog.refusal(sonnet, said: fine) == nil)
        #expect(catalog.chipHelp(sonnet, in: .all, said: fine) == "Model and effort")
        // Another model just picked: what the box said is of the one before, so this one is as this
        // Mac has it until the box is asked again.
        #expect(catalog.chipModel(luna, in: .all, said: try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"runs":false,"missing":"gone"}"#))?.id == "luna")
        // A conversation with no model of its own: the one its box says it runs on.
        // A conversation with no model of its own: the composer is given the one its box says it
        // runs on, as the conversation's view picks it (`composerModel`).
        let onDefault = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":true}"#)
        let given = catalog.composerModel(nil, said: onDefault, lastModel: luna)
        #expect(given == sonnet)
        #expect(catalog.chipModel(given, in: .all, said: onDefault)?.id == "sonnet")
        // None at all, as its box says: nothing given, so it asks for one and Send waits, as on the
        // phone, rather than the one picked last here.
        let none = try said(#"{"model":null,"runs":false,"missing":"model"}"#)
        let nothing = catalog.composerModel(nil, said: none, lastModel: luna)
        #expect(nothing == nil)
        #expect(catalog.chipModel(nothing, in: .all, said: none) == nil, "the chip says Choose a Model")
        // A box from before it: the one picked last, as before.
        #expect(catalog.composerModel(nil, said: nil, lastModel: luna) == luna)
    }
}
