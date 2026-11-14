import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The model picker marks a model that can't answer now (its account out of funds, at a limit,
/// signed out), as the box holds it back after a turn failed, and says why; it's still offered.
/// The engine (StubWeb) and the box's answer are stubbed; the catalog reading them is real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PickerMarksTests {
    static let engine = "http://127.0.0.1:47996"
    let catalog = Catalog()
    let box = HeldBox()

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        catalog.box = BoxClient(box: BoxClient.mac, transport: box)
    }

    /// A box that answers `kuvo/work/unanswering` with what it holds, and offers every model the
    /// engine lists (`kuvo/models/offered`: both accounts signed in).
    final class HeldBox: BoxTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var held: [[String: Any]] = []

        func hold(_ held: [[String: Any]]) { lock.withLock { self.held = held } }

        private static let offered: [String: Any] = [
            "models": [("opencode", "claude-opus-5-5"), ("opencode", "big-pickle"), ("opencode", "pulse-alpha"), ("openai", "gpt-6.1")].map { ["providerID": $0.0, "id": $0.1, "name": $0.1] },
            "known": ["engine": true, "agents": true],
        ]

        func send(_ request: LinkRequest) -> AsyncThrowingStream<LinkResponsePart, Error> {
            let body = request.path == "kuvo/work/unanswering" ? (try? JSONSerialization.data(withJSONObject: ["held": lock.withLock { held }]))
                : request.path.hasPrefix("kuvo/models/offered") ? (try? JSONSerialization.data(withJSONObject: Self.offered)) : nil
            return AsyncThrowingStream { continuation in
                continuation.yield(.head(status: body == nil ? 404 : 200, headers: [:]))
                continuation.yield(.body(body ?? Data()))
                continuation.finish()
            }
        }
    }

    private func model(_ id: String, _ provider: String, free: Bool) -> [String: Any] {
        ["id": id, "modelID": id, "providerID": provider, "name": id,
         "capabilities": ["tools": true, "input": ["text"], "output": ["text"]], "variants": [],
         "time": ["released": 1], "cost": [["input": free ? 0 : 5, "output": free ? 0 : 25]],
         "status": "active", "enabled": true, "limit": ["context": 200_000, "output": 32_000]]
    }

    private func engine() async throws {
        let location = ["directory": "/"]
        let models = [model("claude-opus-5-5", "opencode", free: false), model("big-pickle", "opencode", free: true),
                      model("pulse-alpha", "opencode", free: true), model("gpt-6.1", "openai", free: false)]
        func account(_ id: String, _ name: String) -> [String: Any] {
            ["id": id, "name": name, "methods": [["type": "key"]], "connections": [["type": "credential", "credentialID": "cred_\(id)", "method": "key"]]]
        }
        try StubWeb.answer(Self.engine + "/api/integration", json: ["location": location, "data": [account("opencode", "OpenCode Zen"), account("openai", "OpenAI")]])
        try StubWeb.answer(Self.engine + "/api/model", json: ["location": location, "data": models])
        try StubWeb.answer(Self.engine + "/api/model/default", json: ["location": location, "data": models[1]])
        try StubWeb.answer(Self.engine + "/api/agent", json: ["location": location, "data": []])
        try StubWeb.answer(Self.engine + "/api/command", json: ["location": location, "data": []])
    }

    private func line(_ id: String, now: Date) -> String? {
        catalog.offered.first { $0.id == id }.flatMap { catalog.unanswering($0, now: now)?.line }
    }

    @Test func heldModelsAreMarkedWithWhyAndStillOffered() async throws {
        defer { StubWeb.stop() }
        try await engine()
        // Noon, so a reset half an hour on is still today: past midnight the line names a weekday (right for users, wrong for these expectations).
        let now = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        let soon = (now.timeIntervalSince1970 + 1800) * 1000
        let time = Date(timeIntervalSince1970: soon / 1000).formatted(date: .omitted, time: .shortened)
        // OpenCode Zen out of funds (its paid models), and one free model at its own limit.
        box.hold([
            ["provider": "opencode", "only": "paid", "models": ["claude-opus-5-5"], "why": "Insufficient account funds", "since": now.timeIntervalSince1970 * 1000, "until": soon],
            ["provider": "opencode", "model": "pulse-alpha", "why": "Rate limit exceeded.", "since": now.timeIntervalSince1970 * 1000, "until": soon],
        ])
        await catalog.refresh()
        // (What its box offers comes once it's asked, as the picker draws.)
        _ = catalog.offered
        try await until { !catalog.offered.isEmpty }

        #expect(line("claude-opus-5-5", now: now) == "Out of funds")
        #expect(line("pulse-alpha", now: now) == "At its limit until \(time)")
        // The free one the funds don't touch, and another account's: unmarked.
        #expect(line("big-pickle", now: now) == nil)
        #expect(line("gpt-6.1", now: now) == nil)
        // Its help says it in the engine's words.
        let opus = try #require(catalog.offered.first { $0.id == "claude-opus-5-5" })
        #expect(catalog.unanswering(opus, now: now)?.why == "Insufficient account funds.")
        // Still offered: held models stay in the picker.
        #expect(Set(catalog.pickerProviders(.engine).flatMap(\.models).map(\.id)) == ["claude-opus-5-5", "big-pickle", "pulse-alpha", "gpt-6.1"])

        // Past its reset, it's unmarked without another read.
        #expect(line("claude-opus-5-5", now: now.addingTimeInterval(3600)) == nil)
        // Lifted on the box (funds added, a session answered): unmarked once read again, as a picker opening does.
        box.hold([])
        await catalog.readUnanswering()
        #expect(line("claude-opus-5-5", now: now) == nil)

        // Signed out, it answers once you sign in, not at a time.
        box.hold([["provider": "openai", "why": "Unauthorized", "since": now.timeIntervalSince1970 * 1000, "until": soon]])
        await catalog.readUnanswering()
        #expect(line("gpt-6.1", now: now) == "Signed out")

        // A reset a week or more off says its date, not a weekday that reads as today's.
        let later = Calendar.current.date(byAdding: .day, value: 7, to: now)!
        box.hold([["provider": "opencode", "model": "pulse-alpha", "why": "Weekly limit reached", "since": now.timeIntervalSince1970 * 1000, "until": later.timeIntervalSince1970 * 1000]])
        await catalog.readUnanswering()
        #expect(line("pulse-alpha", now: now) == "At its limit until \(later.formatted(.dateTime.month(.abbreviated).day().hour().minute()))")

        // Its free usage spent: its free models, saying so without "Free" twice; its paid ones answer.
        box.hold([["provider": "opencode", "only": "free", "why": "Free usage limit reached", "since": now.timeIntervalSince1970 * 1000, "until": soon]])
        await catalog.readUnanswering()
        #expect(line("big-pickle", now: now) == "Free usage spent until \(time)")
        #expect(line("claude-opus-5-5", now: now) == nil)
    }
}
