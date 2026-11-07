import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The context ring over a conversation: how full it is is what the last request sent and got
/// back, not the sum of a reply's steps (each sends the whole conversation again), counted
/// against what the model takes in a request, which the engine summarizes before: a provider's
/// input limit when it has one (GPT-5's 272K of its 400K), else the whole window. The engine is
/// stubbed.
@MainActor
@Suite(.serialized) struct ContextRingTests {
    let engine = StubEngine(port: 47999)
    let workspace = Workspace()
    let catalog = Catalog()
    let id = "ses_ring"

    init() {
        TestEnvironment.prepare()
        workspace.api = engine.api
        catalog.api = engine.api
    }

    private static func model(_ provider: String, _ id: String, context: Int, input: Int? = nil) -> [String: Any] {
        var limit: [String: Any] = ["context": context, "output": 32_000]
        if let input { limit["input"] = input }
        return ["id": id, "modelID": id, "providerID": provider, "name": id,
                "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
                "time": ["released": 1], "cost": [["input": 1, "output": 1]], "status": "active", "enabled": true, "limit": limit]
    }

    /// A session on `provider/model`, with the engine listing GPT-5 and Sonnet.
    private func open(on provider: String, _ model: String) async throws -> SessionModel {
        let location = ["directory": "/"]
        engine.on("GET", "/api/integration", json: ["location": location, "data": []])
        engine.on("GET", "/api/model", json: ["location": location, "data": [
            Self.model("openai", "gpt-5", context: 400_000, input: 272_000),
            Self.model("anthropic", "sonnet", context: 200_000),
        ]])
        engine.on("GET", "/api/model/default", json: ["location": location, "data": NSNull()])
        engine.on("GET", "/api/agent", json: ["location": location, "data": []])
        engine.on("GET", "/api/command", json: ["location": location, "data": []])
        await catalog.refresh()
        engine.list([StubEngine.session(id, title: "Ring", directory: "/tmp/kuvo-tests-ring", extra: ["model": ["id": model, "providerID": provider]])])
        engine.conversation(id, [])
        await workspace.refresh()
        let session = try #require(workspace.model(for: id))
        await session.load()
        return session
    }

    /// One model call of a reply, with what it sent and got back.
    private func step(_ session: SessionModel, input: Int, cached: Int, written: Int = 0, output: Int) throws {
        let reply: [String: Any] = ["assistantMessageID": "msg_02"]
        session.apply(try engine.event("session.step.started", session: id, reply.merging(["agent": "build", "model": ["id": "gpt-5", "providerID": "openai"]]) { $1 }))
        let tokens: [String: Any] = ["input": input, "output": output, "reasoning": 0, "cache": ["read": cached, "write": written]]
        session.apply(try engine.event("session.step.ended", session: id, reply.merging(["finish": "tool-calls", "cost": 0.01, "tokens": tokens]) { $1 }))
    }

    /// Summarized: the number from before it would be wrong, so the gauge waits for the next step.
    @Test func aSummaryClearsTheNumberUntilTheNextStep() async throws {
        defer { engine.stop() }
        let session = try await open(on: "anthropic", "sonnet")
        try step(session, input: 2_000, cached: 150_000, output: 300)
        #expect(session.contextUsed == 152_300)
        session.apply(try engine.event("session.compaction.started", session: id, ["reason": "manual", "inputID": "msg_c"]))
        #expect(session.contextUsed == 152_300, "not until it has")
        session.apply(try engine.event("session.compaction.ended", session: id, [:]))
        #expect(session.contextUsed == nil)
        try step(session, input: 400, cached: 11_000, output: 100)
        #expect(session.contextUsed == 11_500)
    }

    /// One that didn't go through leaves the conversation as full as it was.
    @Test func aFailedSummaryKeepsTheNumber() async throws {
        defer { engine.stop() }
        let session = try await open(on: "anthropic", "sonnet")
        try step(session, input: 2_000, cached: 150_000, output: 300)
        session.apply(try engine.event("session.compaction.started", session: id, ["reason": "manual", "inputID": "msg_c"]))
        session.apply(try engine.event("session.compaction.failed", session: id, [:]))
        #expect(session.contextUsed == 152_300)
    }

    /// A summary you asked for isn't news: it says nothing and did nothing. One the engine did by
    /// itself on the way, or a reply after it, is.
    @Test func aRunThatOnlySummarizedIsNoNews() throws {
        func messages(_ json: [[String: Any]]) throws -> [Message] {
            try JSONDecoder().decode([Message].self, from: JSONSerialization.data(withJSONObject: json))
        }
        let time = ["created": 1]
        let summary: [String: Any] = ["id": "msg_c", "type": "compaction", "time": time, "status": "completed", "reason": "manual"]
        let idle: [String: Any] = ["id": "msg_i", "type": "idle", "time": time, "outcome": "succeeded"]
        #expect(Workspace.endsOnSummary(try messages([summary, idle])))
        #expect(!Workspace.endsOnSummary(try messages([summary.merging(["reason": "auto"]) { $1 }, idle])))
        #expect(!Workspace.endsOnSummary(try messages([summary.merging(["status": "failed"]) { $1 }, idle])))
        #expect(!Workspace.endsOnSummary(try messages([summary, ["id": "msg_u", "type": "user", "time": time, "text": "and then"], idle])))
    }

    @Test func theLastRequestAgainstWhatTheModelTakes() async throws {
        defer { engine.stop() }
        let session = try await open(on: "openai", "gpt-5")
        // A reply of two model calls, a tool's result between: the second sent it all again.
        try step(session, input: 2_000, cached: 28_000, output: 300)
        #expect(session.contextUsed == 30_300)
        try step(session, input: 500, cached: 31_000, written: 200, output: 400)
        #expect(session.contextUsed == 32_100, "the last request, not the steps' sum")
        #expect(ContextGauge.window(of: session, in: catalog) == 272_000, "what GPT-5 takes in a request, not its 400K")
    }

    @Test func theWholeWindowWhenThatsWhatItTakes() async throws {
        defer { engine.stop() }
        let session = try await open(on: "anthropic", "sonnet")
        #expect(ContextGauge.window(of: session, in: catalog) == 200_000)
    }
}
