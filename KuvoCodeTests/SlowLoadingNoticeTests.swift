import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// "Still loading your accounts and models…" shows while the first load waits on the engine (a
/// macOS prompt it's waiting on, say), and goes once the models are read; a later refresh, after
/// a sign-in or on coming back to the app, runs in the background without it. The engine's
/// answers are stubbed and held (StubWeb).
@MainActor
@Suite(.serialized) struct SlowLoadingNoticeTests {
    static let engine = "http://127.0.0.1:47982"
    let catalog = Catalog()

    init() {
        TestEnvironment.prepare()
        StubWeb.start(hosts: ["127.0.0.1", "models.opencode.ai"])
        catalog.api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.engine)!, password: "test"))
        Catalog.slowAfter = .zero
    }

    nonisolated final class Held: @unchecked Sendable {
        private let lock = NSLock()
        private var replies: [@Sendable (StubWeb.Answer) -> Void] = []
        var count: Int { lock.withLock { replies.count } }
        func add(_ reply: @escaping @Sendable (StubWeb.Answer) -> Void) { lock.withLock { replies.append(reply) } }
        func release(_ answer: StubWeb.Answer) {
            let all = lock.withLock { defer { replies = [] }; return replies }
            for reply in all { reply(answer) }
        }
    }

    @Test func onlyWhileTheFirstLoadWaitsOnTheEngine() async throws {
        defer {
            StubWeb.stop()
            Catalog.slowAfter = .seconds(3)
        }
        let location = ["directory": "/"]
        try StubWeb.answer(Self.engine + "/api/model/default", json: ["location": location, "data": NSNull()])
        for path in ["/api/agent", "/api/command"] {
            try StubWeb.answer(Self.engine + path, json: ["location": location, "data": []])
        }
        try StubWeb.answer(Self.engine + "/api/model", json: ["location": location, "data": []])
        // The engine's accounts, held until the test answers (the engine waiting on a prompt).
        let held = Held()
        StubWeb.hold(Self.engine + "/api/integration") { _, _, reply in held.add(reply) }
        let answer = StubWeb.json(["location": location, "data": []])

        let first = Task { await catalog.refresh() }
        try await until { catalog.isSlow }
        held.release(answer)
        await first.value
        #expect(catalog.isLoaded)
        #expect(!catalog.isSlow)

        // Later, just as slow (a sign-in, coming back to the app): no notice over what's shown.
        let later = Task { await catalog.refresh() }
        try await until { held.count == 1 }
        for _ in 0..<20 { await Task.yield() }
        #expect(!catalog.isSlow)
        held.release(answer)
        await later.value
        #expect(!catalog.isSlow)
    }
}
