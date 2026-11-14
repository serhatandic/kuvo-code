import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The model a new session or bot starts on: the one you picked if you can still use it, else
/// the engine's default, else the first you can use; never one whose account you signed out of
/// (it would only fail), as its box decides (`models.offered`, `sessions.models`; the rule itself is
/// the box's, tested there). Before its box says, what you picked, as it is. The engine's answers
/// and the box's are stubbed (StubWeb, a box transport of the test's own), in the shape they send.
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

    /// A catalog that has no box to ask works nothing out itself (the app gives each catalog its
    /// box as it's made; this pins that the old client rule is gone): no model is offered, none
    /// turned down, and a new conversation starts on the one you picked, as it is, though this
    /// Mac's lists say its account is signed out. Its box decides once it's asked
    /// (`itsBoxDecidesWhatsOfferedAndWhatANewOneStartsOn`, whose first look is the app's real
    /// "box not answered yet").
    @Test func beforeItsBoxSaysNothingIsWorkedOutHere() async throws {
        defer { StubWeb.stop() }
        try await engine(accounts: [Self.account("anthropic", signedIn: false), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("openai", "luna"))
        #expect(catalog.startingModel(sonnet) == sonnet)
        #expect(catalog.offered.isEmpty && catalog.modelsByProvider.isEmpty, "the picker waits for its box")
        #expect(!catalog.isUnavailable(sonnet))
        #expect(catalog.refusal(sonnet, said: nil) == nil)
        #expect(!catalog.needsAccount(sonnet, said: nil))
        #expect(catalog.chipModel(sonnet)?.id == "sonnet")
        #expect(catalog.chipModel(nil)?.id == "luna", "nothing picked: the default")
        #expect(!catalog.isAutoAvailable)
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
        #expect(machine.startingModel(claude) == claude, "away, not gone")
        machine.forgetAgents()
        #expect(machine.startingModel(claude) == luna)
    }

    /// A sign-in card for an account that isn't the conversation's model's (its box says nothing of
    /// it): its Sign In's help says what it does, by the ways in its account offers. xAI and OpenAI
    /// as the engine lists them: their plans' sign-ins (which Accounts offers only to one made with
    /// them before), and a key; OpenAI's made with its ChatGPT plan before.
    @Test func aSignInCardSaysWhatItsSignInDoes() async throws {
        defer { StubWeb.stop() }
        let xai: [String: Any] = ["id": "xai", "name": "xAI", "methods": [["type": "oauth", "id": "device", "label": "SuperGrok"], ["type": "key"]], "connections": [Any]()]
        let openai: [String: Any] = ["id": "openai", "name": "OpenAI", "methods": [["type": "oauth", "id": "chatgpt-browser", "label": "ChatGPT Pro/Plus"], ["type": "key"]],
                                     "connections": [["type": "credential", "credentialID": "cred_openai", "method": "oauth"]]]
        try await engine(accounts: [Self.account("deepseek", signedIn: false), xai, openai],
                         models: [Self.model("deepseek", "chat"), Self.model("xai", "grok-4.7")], defaultModel: nil)
        // Its card's Sign In opens a sheet with only a key: its help says that.
        #expect(catalog.signInHelp("xai", said: nil) == "Add an xAI key (with a SuperGrok plan, choose a model under Grok instead)")
        #expect(catalog.signInHelp("openai", said: nil) == "Sign in to Codex (your ChatGPT plan, under Subscriptions)", "a plan's sign-in made before: signed in to again")
        #expect(catalog.signInHelp("deepseek", on: "devbox", said: nil) == "Sign in to Deepseek on devbox: its sign-ins are its own")
    }

    /// A box that decides (`models.offered`, #341 item 13): the picker offers what it says runs, and
    /// a new conversation starts on the model it says, not what this Mac's own lists would have it
    /// on. Here the engine lists Anthropic signed in, while its box says only Luna runs (Anthropic's
    /// sign-in ended there) and a new one starts on Luna.
    @Test func itsBoxDecidesWhatsOfferedAndWhatANewOneStartsOn() async throws {
        defer { StubWeb.stop() }
        let offered = #"{"models":[{"providerID":"openai","id":"luna","name":"Luna"}],"known":{"engine":true,"agents":true},"starting":{"providerID":"openai","id":"luna"}}"#
        catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { continuation in
                let answered = request.path.hasPrefix("kuvo/models/offered")
                continuation.yield(.head(status: answered ? 200 : 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data((answered ? offered : #"{"message":"No such route."}"#).utf8)))
                continuation.finish()
            }
        })
        try await engine(accounts: [Self.account("anthropic", signedIn: true), Self.account("openai", signedIn: true)],
                         models: [Self.model("anthropic", "sonnet"), Self.model("openai", "luna")],
                         defaultModel: Self.model("anthropic", "sonnet"))
        #expect(catalog.startingModel(sonnet) == sonnet, "until its box says: as it is")
        try await until { catalog.startingModel(sonnet) == luna }
        #expect(catalog.modelsByProvider.flatMap(\.models).map(\.id) == ["luna"])
        #expect(catalog.isUnavailable(sonnet))
        // What a conversation's own box hasn't said of yet goes by that alone: no reckoning of its
        // own account here, no refusal worded here.
        #expect(catalog.chipModel(sonnet, in: .all, said: nil) == nil, "Choose a Model")
        #expect(catalog.refusal(sonnet, said: nil) == nil)
        #expect(!catalog.needsAccount(sonnet, said: nil))
    }

    /// The model picked last is one Codex has since kept out of its picker: its box says a new
    /// conversation starts on it, and the chip names it (by the name its box gives) with Send on,
    /// though it isn't offered in the picker and this Mac's own lists of Codex's (loaded) don't
    /// have it. (Before, it was unavailable: "Choose a Model", and Send waited.)
    @Test func aModelCodexHidesRunsWhereItsBoxSaysSo() async throws {
        defer { StubWeb.stop() }
        let mini = ModelRef(id: "gpt-5.1-codex-mini", providerID: "codex-cli")
        let offered = #"{"models":[{"providerID":"openai","id":"luna","name":"Luna"},{"providerID":"codex-cli","id":"gpt-5.1-codex-mini","name":"GPT-5.1 Codex Mini","hidden":true}],"known":{"engine":true,"agents":true},"starting":{"providerID":"codex-cli","id":"gpt-5.1-codex-mini"}}"#
        catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { continuation in
                let answered = request.path.hasPrefix("kuvo/models/offered")
                continuation.yield(.head(status: answered ? 200 : 404, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data((answered ? offered : #"{"message":"No such route."}"#).utf8)))
                continuation.finish()
            }
        })
        try await engine(accounts: [Self.account("openai", signedIn: true)], models: [Self.model("openai", "luna")], defaultModel: Self.model("openai", "luna"))
        // Codex signed in, its picker's list (as this Mac reads it) without the one it hides.
        let bridge = "http://127.0.0.1:47981"
        StubWeb.handle(bridge + "/api/integration") { _, _ in
            StubWeb.json(["data": [[
                "id": "codex-cli", "name": "Codex", "methods": [["type": "oauth", "id": "chatgpt", "label": "ChatGPT"]],
                "connections": [["type": "credential", "credentialID": "cred_codex", "method": "oauth"]],
                "metadata": ["source": "agent", "agent": "codex-cli", "accountID": "default", "installed": true],
            ]]])
        }
        let listed = StubWeb.json(["data": [Self.model("codex-cli", "gpt-5.5")]])
        StubWeb.handle(bridge + "/api/model") { _, _ in listed }
        let agents = OutsideAgents()
        catalog.outsideAgents = agents
        agents.connect(ServerEndpoint(url: URL(string: bridge)!, password: "test"), folderPrefix: "")
        defer { agents.disconnect() }
        await catalog.refreshAgents(fresh: true)
        _ = catalog.startingModel(mini)
        try await until { catalog.offeredSaid != nil }
        #expect(catalog.startingModel(mini) == mini)
        #expect(!catalog.isUnavailable(mini))
        #expect(catalog.chipModel(mini, in: .all, said: nil)?.name == "GPT-5.1 Codex Mini")
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: catalog.chipModel(mini, in: .all, said: nil) != nil) == .send)
        #expect(!catalog.offered.contains { $0.id == mini.id }, "not in the picker")
    }

    /// Its box's first answer fails (a machine's connection drops a moment): it's asked again, and
    /// the picker fills, rather than staying empty until an account or model changes.
    @Test func aFailedAskIsAskedAgain() async throws {
        defer { StubWeb.stop() }
        nonisolated final class Asks: @unchecked Sendable {
            let lock = NSLock()
            var count = 0
        }
        let asks = Asks()
        let offered = #"{"models":[{"providerID":"openai","id":"luna","name":"Luna"}],"known":{"engine":true,"agents":true},"starting":{"providerID":"openai","id":"luna"}}"#
        catalog.offeredRetryAfter = .milliseconds(1)
        catalog.box = BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            AsyncThrowingStream { continuation in
                let first = request.path.hasPrefix("kuvo/models/offered") && asks.lock.withLock { asks.count += 1; return asks.count == 1 }
                let answered = request.path.hasPrefix("kuvo/models/offered") && !first
                continuation.yield(.head(status: answered ? 200 : 503, headers: ["content-type": "application/json"]))
                continuation.yield(.body(Data((answered ? offered : #"{"message":"Not now."}"#).utf8)))
                continuation.finish()
            }
        })
        try await engine(accounts: [Self.account("openai", signedIn: true)], models: [Self.model("openai", "luna")], defaultModel: Self.model("openai", "luna"))
        _ = catalog.offered
        try await until { catalog.offered.map(\.id) == ["luna"] }
        #expect(asks.lock.withLock { asks.count } >= 2)
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
        // what to do, in its box's words.
        let out = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":false,"missing":"signIn","account":{"id":"anthropic","name":"Anthropic"},"refusal":"Sonnet needs a sign-in to Anthropic: sign in, or choose another model.","action":{"do":"signIn","label":"Sign In","help":"Sign in to Anthropic"}}"#)
        #expect(catalog.chipModel(sonnet, in: .all, said: out)?.id == "sonnet")
        #expect(catalog.refusal(sonnet, said: out) == "Sonnet needs a sign-in to Anthropic: sign in, or choose another model.")
        #expect(catalog.chipHelp(sonnet, in: .all, said: out) == "Sonnet needs a sign-in to Anthropic: sign in, or choose another model.")
        #expect(catalog.needsAccount(sonnet, said: out))
        // The engine's xAI, its SuperGrok plan Grok's: its card's Sign In opens the key sheet, and
        // says so, here and on a machine whose accounts this Mac doesn't list (#338's leftover).
        let grok = ModelRef(id: "grok-4.7", providerID: "xai")
        let xai = try said(#"{"model":{"providerID":"xai","id":"grok-4.7"},"name":"Grok 4.7","runs":false,"missing":"key","account":{"id":"xai","name":"xAI"},"plan":{"name":"SuperGrok","agent":"Grok","provider":"grok-cli"},"refusal":"Grok 4.7 needs an xAI key: add one, or choose another model (with a SuperGrok plan, one under Grok).","action":{"do":"addKey","label":"Add Key","help":"Add an xAI key (with a SuperGrok plan, choose a model under Grok instead)"}}"#)
        #expect(catalog.signInHelp("xai", on: "devbox", said: xai) == "Add an xAI key (with a SuperGrok plan, choose a model under Grok instead)")
        #expect(catalog.refusal(grok, said: xai) == "Grok 4.7 needs an xAI key: add one, or choose another model (with a SuperGrok plan, one under Grok).")
        #expect(catalog.chipModel(grok, in: .all, said: xai)?.name == "Grok 4.7", "named as its box lists it, though this Mac doesn't")
        // A coding agent's model it no longer lists (#572): "Choose a Model", and a message on it
        // isn't sent to fail.
        let dropped = ModelRef(id: "opus-4", providerID: "claude-code")
        let gone = try said(#"{"model":{"providerID":"claude-code","id":"opus-4"},"runs":false,"missing":"gone","account":{"id":"claude-code","name":"Claude Code"},"refusal":"opus-4 is no longer among Claude Code’s models: choose another model.","choose":true,"action":{"do":"choose","label":"Choose a Model","help":"Choose another model"}}"#)
        #expect(catalog.chipModel(dropped, in: .all, said: gone) == nil)
        #expect(catalog.refusal(dropped, said: gone) == "opus-4 is no longer among Claude Code’s models: choose another model.")
        // It runs: named, nothing refused, its help the chip's own.
        let fine = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":true}"#)
        #expect(catalog.refusal(sonnet, said: fine) == nil)
        #expect(catalog.chipHelp(sonnet, in: .all, said: fine) == "Model and effort")
        // Another model just picked: what the box said is of the one before, so this one is as this
        // Mac has it until the box is asked again.
        #expect(catalog.chipModel(luna, in: .all, said: try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"runs":false,"missing":"gone","choose":true}"#))?.id == "luna")
        // A conversation with no model of its own: the one its box says it runs on.
        // A conversation with no model of its own: the composer is given the one its box says it
        // runs on, as the conversation's view picks it (`composerModel`).
        let onDefault = try said(#"{"model":{"providerID":"anthropic","id":"sonnet"},"name":"Sonnet","runs":true}"#)
        let given = catalog.composerModel(nil, said: onDefault, lastModel: luna)
        #expect(given == sonnet)
        #expect(catalog.chipModel(given, in: .all, said: onDefault)?.id == "sonnet")
        // None at all, as its box says: nothing given, so it asks for one and Send waits, as on the
        // phone, rather than the one picked last here.
        let none = try said(#"{"model":null,"runs":false,"missing":"model","refusal":"Choose a model to send it.","choose":true,"action":{"do":"choose","label":"Choose a Model","help":"Choose a model"}}"#)
        let nothing = catalog.composerModel(nil, said: none, lastModel: luna)
        #expect(nothing == nil)
        #expect(catalog.chipModel(nothing, in: .all, said: none) == nil, "the chip says Choose a Model")
        // A box from before it: the one picked last, as before.
        #expect(catalog.composerModel(nil, said: nil, lastModel: luna) == luna)
    }
}
