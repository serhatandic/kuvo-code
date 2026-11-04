import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A failed turn's card signs in to the account of the model the turn ran on: one that failed
/// before any reply (a signed-out coding agent turns it away at once) still knows it, from the
/// session or a later switch's model before it, never from a model picked after it. Its Try Again
/// goes with the model the conversation is on now: once you switch away from the signed-out one
/// it's back, and Switch Model goes. The engine is stubbed.
@MainActor
@Suite(.serialized) struct FailedTurnModelTests {
    let engine = StubEngine(port: 47909)
    let workspace = Workspace()
    let id = "ses_failedmodel"

    init() {
        workspace.api = engine.api
    }

    private static let signedOut: [String: Any] = ["type": "ProviderAuthError", "message": "Claude Code isn't signed in."]

    private func ends(_ conversation: [[String: Any]], session model: [String: Any]) async throws -> [ModelRef?] {
        engine.list([StubEngine.session(id, title: "Checklist", directory: "/tmp/kuvo-tests-failedmodel", extra: ["model": model])])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let session = try #require(workspace.model(for: id))
        await session.load()
        #expect(session.transcript.messages.count == conversation.count, "the whole conversation read")
        return TranscriptView.rows(of: session, catalog: Catalog(), detail: .summary).compactMap {
            if case .turnEnd(_, let stats, _, _) = $0 { stats.model } else { nil }
        }
    }

    @Test func aTurnThatFailedBeforeAnyReplyKnowsItsModel() async throws {
        defer { engine.stop() }
        let ends = try await ends([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Write a short SEO checklist"],
            ["id": "msg_02", "type": "idle", "time": ["created": 2_000], "outcome": "failed", "error": Self.signedOut],
        ], session: ["id": "default", "providerID": "claude-code"])
        #expect(ends == [ModelRef(id: "default", providerID: "claude-code")])
    }

    @Test func aModelPickedAfterAFailedTurnIsntTheOneItFailedOn() async throws {
        defer { engine.stop() }
        let ends = try await ends([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Write a short SEO checklist"],
            ["id": "msg_02", "type": "idle", "time": ["created": 2_000], "outcome": "failed", "error": Self.signedOut],
            ["id": "msg_03", "type": "model-switched", "time": ["created": 3_000],
             "model": ["id": "big-pickle", "providerID": "opencode"], "previous": ["id": "default", "providerID": "claude-code"]],
            ["id": "msg_04", "type": "user", "time": ["created": 4_000], "text": "Again, please"],
            ["id": "msg_05", "type": "idle", "time": ["created": 5_000], "outcome": "failed", "error": ["type": "APIError", "message": "Overloaded"]],
        ], session: ["id": "big-pickle", "providerID": "opencode"])
        #expect(ends == [ModelRef(id: "default", providerID: "claude-code"), ModelRef(id: "big-pickle", providerID: "opencode")])
    }

    @Test func switchingAwayFromASignedOutModelBringsBackTryAgain() async throws {
        defer { engine.stop() }
        let location = ["directory": "/"]
        let model: [String: Any] = ["id": "luna", "modelID": "luna", "providerID": "openai", "name": "Luna",
                                    "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
                                    "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true,
                                    "limit": ["context": 100_000, "output": 8_000]]
        engine.on("GET", "/api/integration", json: ["location": location, "data": [["id": "openai", "name": "OpenAI", "methods": [["type": "key"]], "connections": []]]])
        engine.on("GET", "/api/model", json: ["location": location, "data": [model]])
        engine.on("GET", "/api/model/default", json: ["location": location, "data": NSNull()])
        engine.on("GET", "/api/agent", json: ["location": location, "data": []])
        engine.on("GET", "/api/command", json: ["location": location, "data": []])
        let catalog = Catalog()
        catalog.api = engine.api
        await catalog.refresh()
        let luna = ModelRef(id: "luna", providerID: "openai")
        let other = ModelRef(id: "big-pickle", providerID: "opencode")
        // Still on the signed-out model: sign in or pick another; sending again would fail the same way.
        #expect(SignInCard.actions(failed: luna, current: luna, catalog: catalog) == .init(signIn: luna, switchModel: true, tryAgain: false))
        // Another model picked from the card: Try Again sends with it; signing in to Luna's stays.
        #expect(SignInCard.actions(failed: luna, current: other, catalog: catalog) == .init(signIn: luna, switchModel: false, tryAgain: true))
        // Auto's, or a provider with no sign-in: Accounts, and Try Again.
        #expect(SignInCard.actions(failed: ModelRef(id: "auto", providerID: OutsideAgents.autoProvider), current: nil, catalog: catalog) == .init(signIn: nil, tryAgain: true))
        #expect(SignInCard.actions(failed: other, current: other, catalog: catalog) == .init(signIn: nil, tryAgain: true))
    }
}
