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
@Suite(.serialized, .timeLimit(.minutes(1))) struct FailedTurnModelTests {
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

    /// A turn too long for its model, summarized, can still be tried again; its turn isn't taken
    /// back, which would throw the summary away and fail the same way. A later reply takes it away.
    @Test func aFailedTurnSummarizedAfterCanStillBeTriedAgainWithoutLosingTheSummary() async throws {
        defer { engine.stop() }
        var conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Write a short SEO checklist"],
            ["id": "msg_02", "type": "idle", "time": ["created": 2_000], "outcome": "failed", "error": ["type": "provider", "message": "Prompt is too long."]],
            ["id": "msg_03", "type": "compaction", "time": ["created": 3_000], "status": "completed", "reason": "manual"],
            ["id": "msg_04", "type": "idle", "time": ["created": 4_000], "outcome": "succeeded"],
        ]
        engine.list([StubEngine.session(id, title: "Checklist", directory: "/tmp/kuvo-tests-failedmodel", extra: ["model": ["id": "m", "providerID": "p"]])])
        engine.conversation(id, conversation)
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        await workspace.refresh()
        let session = try #require(workspace.model(for: id))
        await session.load()
        func lastEnds() -> [String] {
            TranscriptView.rows(of: session, catalog: Catalog(), detail: .summary).compactMap {
                if case .turnEnd(let idle, _, true, _) = $0 { idle.id } else { nil }
            }
        }
        #expect(lastEnds() == ["msg_02"])
        // Its time and its buttons stay on the turn's end, not on the summary's.
        func latestEnds() -> [String] {
            TranscriptView.rows(of: session, catalog: Catalog(), detail: .summary).compactMap {
                if case .turnEnd(let idle, _, _, true) = $0 { idle.id } else { nil }
            }
        }
        #expect(latestEnds() == ["msg_02"])

        let message = try #require(session.transcript.messages.compactMap { if case .user(let user) = $0 { user } else { nil } }.first)
        session.retry(message)
        try await until { !engine.requests("POST", "/api/session/\(id)/prompt").isEmpty }
        #expect(engine.requests("POST", "/api/session/\(id)/revert/stage").isEmpty)

        conversation.append(["id": "msg_05", "type": "assistant", "time": ["created": 5_000], "agent": "build", "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "text": "Here."]]])
        engine.conversation(id, conversation)
        await session.load()
        #expect(lastEnds() == [])

        // Taken at a step of a run on the engine, the end after it is that run's own.
        engine.conversation(id, [
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Write a short SEO checklist"],
            ["id": "msg_02", "type": "assistant", "time": ["created": 2_000], "agent": "build", "model": ["id": "m", "providerID": "p"], "content": [["type": "text", "id": "t1", "text": "Done."]]],
            ["id": "msg_03", "type": "compaction", "time": ["created": 3_000], "status": "completed", "reason": "manual"],
            ["id": "msg_04", "type": "idle", "time": ["created": 4_000], "outcome": "succeeded"],
        ])
        await session.load()
        #expect(lastEnds() == ["msg_04"])
        #expect(latestEnds() == ["msg_04"])
        // That summary is part of the turn, so trying the turn again takes it back as any other.
        #expect(!session.transcript.messages.summarized(since: "msg_01"))
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

    @Test func anAutoTurnThatFailedBeforeAnyReplyIsAutos() async throws {
        defer { engine.stop() }
        // Auto's replies carry the model it picked for them: the next turn isn't on that one.
        let ends = try await ends([
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Write a short SEO checklist"],
            ["id": "msg_02", "type": "assistant", "agent": "build", "time": ["created": 2_000, "completed": 3_000], "model": ["id": "default", "providerID": "claude-code"],
             "content": [["type": "text", "text": "Here it is."]]],
            ["id": "msg_03", "type": "idle", "time": ["created": 4_000], "outcome": "succeeded"],
            ["id": "msg_04", "type": "user", "time": ["created": 5_000], "text": "Shorter"],
            ["id": "msg_05", "type": "idle", "time": ["created": 6_000], "outcome": "failed", "error": Self.signedOut],
        ], session: ["id": "auto", "providerID": OutsideAgents.autoProvider])
        #expect(ends == [ModelRef(id: "default", providerID: "claude-code"), ModelRef(id: "auto", providerID: OutsideAgents.autoProvider)])
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
