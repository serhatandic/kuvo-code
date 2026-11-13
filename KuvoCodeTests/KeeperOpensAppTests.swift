import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// An agent on this Mac uses the browser while Kuvo Code is closed (#211): the keeper opens the app
/// it was installed from, in the background, and the call goes to the app once it has said where
/// its tools answer, rather than the agent being told to ask the user to open Kuvo Code. Calls that
/// come meanwhile share the one opening; one that the app doesn't get ready for, or that macOS
/// refuses, says so. Over real HTTP; the app is a stand-in (a launcher that records, and a loopback
/// server that answers as the app's tools do), and nothing is ever opened.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct KeeperOpensAppTests {
    let session = URLSession(configuration: .ephemeral)

    init() { TestEnvironment.prepare() }

    /// What the stand-ins saw: the apps opened, the calls the app's tools got.
    nonisolated final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var _opened: [URL] = []
        private var _calls: [(authorization: String?, name: String?)] = []
        var opened: [URL] { lock.withLock { _opened } }
        var calls: [(authorization: String?, name: String?)] { lock.withLock { _calls } }
        func open(_ app: URL) { lock.withLock { _opened.append(app) } }
        func call(_ request: URLRequest, _ body: Data) {
            let json = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            lock.withLock { _calls.append((request.value(forHTTPHeaderField: "authorization"), (json["params"] as? [String: Any])?["name"] as? String)) }
        }
    }

    /// A place of its own for the app the keeper runs from (`there`: whether it's still there).
    private func appPlace(there: Bool = true) throws -> (app: URL, remove: () -> Void) {
        let folder = FileManager.default.temporaryDirectory.appending(path: "keeper-opens-\(UUID().uuidString)")
        let app = folder.appending(path: "Kuvo Code.app")
        if there { try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true) }
        return (app, { try? FileManager.default.removeItem(at: folder) })
    }

    /// The app's tools, as the open app answers them: each call said back with what it was.
    private func appTools(_ seen: Seen) async throws -> StubListener {
        try await StubListener { request, body in
            seen.call(request, body)
            let message = (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
            let name = (message["params"] as? [String: Any])?["name"] as? String ?? ""
            return StubWeb.json(["jsonrpc": "2.0", "id": message["id"] ?? NSNull(),
                                 "result": ["content": [["type": "text", "text": "The app did \(name)."]], "isError": false]])
        }
    }

    /// Counts the calls waiting on the opening, one at a time.
    private func waits(_ opener: AppOpener) -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        opener.onWait = { continuation.yield() }
        return stream
    }

    /// A deadline that comes when the test says (`pass`), or never: ended early once the app is ready.
    private func deadline() -> (wait: @MainActor () async -> Void, pass: () -> Void) {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        return ({ for await _ in stream { return } }, { continuation.yield() })
    }

    /// One MCP call to the keeper's tools: its `result`.
    private func call(_ server: OutsideAgents.ToolServer, _ name: String, id: Int = 1) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: server.url)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": "tools/call", "params": [
            "name": name, "arguments": ["url": "https://example.com"], "_meta": ["ai.opencode/sessionID": "ses_bot"],
        ] as [String: Any]])
        let (data, _) = try await session.data(for: request)
        return try #require((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["result"] as? [String: Any])
    }

    /// The client giving up on call `id` (MCP's `notifications/cancelled`).
    private func cancel(_ server: OutsideAgents.ToolServer, id: Int) async throws {
        var request = URLRequest(url: URL(string: server.url)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "method": "notifications/cancelled", "params": ["requestId": id]] as [String: Any])
        _ = try await session.data(for: request)
    }

    /// A call's answer, as the agent reads it.
    struct Answer: Sendable, Equatable {
        let text: String
        let isError: Bool?
    }

    /// One browser call, its answer.
    private func ask(_ server: OutsideAgents.ToolServer, _ name: String, id: Int = 1) async throws -> Answer {
        let result = try await call(server, name, id: id)
        return Answer(text: text(result), isError: result["isError"] as? Bool)
    }

    private func text(_ result: [String: Any]) -> String {
        ((result["content"] as? [[String: Any]])?.first?["text"] as? String) ?? ""
    }

    /// Three browser calls at once with Kuvo Code closed: the app the keeper runs from is opened
    /// once, and when it says where its tools answer, each call goes to it and gets its answer.
    @Test func browserCallsWithTheAppClosedOpenItOnceAndGoToItWhenItsReady() async throws {
        let seen = Seen()
        let place = try appPlace()
        let app = try await appTools(seen)
        let deadline = deadline()
        let opener = AppOpener(app: place.app, launch: { seen.open($0) }, deadline: deadline.wait)
        let waiting = waits(opener)
        let tools = KeeperTools(record: { _ in nil }, opener: opener)
        defer {
            tools.stop()
            app.stop()
            place.remove()
        }
        let server = try await tools.start().agents

        async let first = ask(server, "browser_navigate", id: 1)
        async let second = ask(server, "browser_snapshot", id: 2)
        async let third = ask(server, "browser_click", id: 3)
        // All three wait on the opening; then the app says where its tools answer.
        var count = 0
        for await _ in waiting {
            count += 1
            if count == 3 { break }
        }
        tools.use(["url": "http://127.0.0.1:\(app.port)/mcp", "token": "app-token"])

        let results = try await [first, second, third]
        #expect(results.map(\.text) == ["The app did browser_navigate.", "The app did browser_snapshot.", "The app did browser_click."])
        #expect(results.allSatisfy { $0.isError == false })
        #expect(seen.opened == [place.app], "opened once, from where the keeper runs")
        #expect(seen.calls.compactMap(\.name).sorted() == ["browser_click", "browser_navigate", "browser_snapshot"])
        #expect(seen.calls.allSatisfy { $0.authorization == "Bearer app-token" })

        // Open now: the next call goes straight there.
        #expect(text(try await call(server, "browser_back")) == "The app did browser_back.")
        #expect(seen.opened.count == 1)
    }

    /// The app opened but never said where its tools answer: when the wait runs out, the call says
    /// so, and for a while after, the next call says the same at once rather than opening it again
    /// (an app that crashes as it opens isn't opened over and over).
    @Test func anAppThatIsntReadyInTimeIsSaidSo() async throws {
        let seen = Seen()
        let place = try appPlace()
        let deadline = deadline()
        let opener = AppOpener(app: place.app, launch: { seen.open($0) }, deadline: deadline.wait)
        let waiting = waits(opener)
        let tools = KeeperTools(record: { _ in nil }, opener: opener)
        defer {
            tools.stop()
            place.remove()
        }
        let server = try await tools.start().agents

        async let result = ask(server, "browser_navigate")
        for await _ in waiting { break }
        deadline.pass()
        let answer = try await result
        #expect(answer.text == AppOpener.notReady)
        #expect(answer.text.contains("30 seconds"))
        #expect(answer.isError == true)
        #expect(seen.opened == [place.app])

        #expect(text(try await call(server, "browser_snapshot")) == AppOpener.notReady)
        #expect(seen.opened == [place.app], "not opened again so soon")
    }

    /// The user stops the session while its browser call waits for the app: once the app is
    /// there, the call isn't carried out.
    @Test func aCallStoppedWhileWaitingIsntCarriedOut() async throws {
        let seen = Seen()
        let place = try appPlace()
        let app = try await appTools(seen)
        let deadline = deadline()
        let opener = AppOpener(app: place.app, launch: { seen.open($0) }, deadline: deadline.wait)
        let waiting = waits(opener)
        let tools = KeeperTools(record: { _ in nil }, opener: opener)
        defer {
            tools.stop()
            app.stop()
            place.remove()
        }
        let server = try await tools.start().agents

        async let result = ask(server, "browser_click", id: 7)
        for await _ in waiting { break }
        try await cancel(server, id: 7)
        tools.use(["url": "http://127.0.0.1:\(app.port)/mcp", "token": "app-token"])
        let answer = try await result
        #expect(answer.isError == true)
        #expect(seen.calls.isEmpty, "the app never carried it out")
    }

    /// An update of Kuvo Code is installing (the app noted it as it quit): the keeper doesn't open
    /// the app over it, and the call goes on once Sparkle has opened it again.
    @Test func anUpdateInstallingIsWaitedForNotOpenedOver() async throws {
        let seen = Seen()
        let place = try appPlace()
        let app = try await appTools(seen)
        let deadline = deadline()
        let opener = AppOpener(app: place.app, launch: { seen.open($0) }, deadline: deadline.wait, updating: { true })
        let waiting = waits(opener)
        let tools = KeeperTools(record: { _ in nil }, opener: opener)
        defer {
            tools.stop()
            app.stop()
            place.remove()
        }
        let server = try await tools.start().agents

        async let result = ask(server, "browser_navigate")
        for await _ in waiting { break }
        tools.use(["url": "http://127.0.0.1:\(app.port)/mcp", "token": "app-token"])
        #expect(try await result.text == "The app did browser_navigate.")
        #expect(seen.opened.isEmpty)
    }

    /// macOS refuses to open the app, or it isn't where the keeper was installed from any more:
    /// the agent hears which, and nothing is opened in its place. The side panel never opens it.
    @Test func anAppThatCantBeOpenedIsSaidSo() async throws {
        let seen = Seen()
        let place = try appPlace()
        final class Clock { var now = Date(timeIntervalSince1970: 1_800_000_000) }
        let clock = Clock()
        let deadline = deadline()
        let goneDeadline = self.deadline()
        let opener = AppOpener(app: place.app, launch: { app in
            seen.open(app)
            throw AppOpener.Refused("LSOpenURLsWithRole() failed with error -10810")
        }, deadline: deadline.wait, now: { clock.now })
        let tools = KeeperTools(record: { _ in nil }, opener: opener)
        let gone = try appPlace(there: false)
        let goneOpener = AppOpener(app: gone.app, launch: { seen.open($0) }, deadline: goneDeadline.wait)
        let goneTools = KeeperTools(record: { _ in nil }, opener: goneOpener)
        defer {
            tools.stop()
            goneTools.stop()
            place.remove()
            gone.remove()
        }
        let server = try await tools.start().agents

        let refused = try await call(server, "browser_navigate")
        #expect(text(refused) == AppOpener.couldntOpen("LSOpenURLsWithRole() failed with error -10810"))
        #expect(text(refused).contains("Ask the user to open Kuvo Code"))
        #expect(refused["isError"] as? Bool == true)
        // The next call says the same at once; a while later, it's tried again.
        #expect(text(try await call(server, "browser_navigate")) == text(refused))
        #expect(seen.opened == [place.app])
        clock.now += AppOpener.rest
        _ = try await call(server, "browser_navigate")
        #expect(seen.opened == [place.app, place.app])

        let panel = try await call(server, BrowserTools.showInPanel)
        #expect(text(panel) == KeeperTools.panelNeedsApp)
        #expect(seen.opened.count == 2, "the side panel doesn't open the app")

        let missing = try await call(try await goneTools.start().agents, "browser_navigate")
        #expect(text(missing) == AppOpener.gone)
        #expect(missing["isError"] as? Bool == true)
        #expect(seen.opened.count == 2, "nothing opened when the app isn't there")
    }

    /// Whether Kuvo Code already runs as the app is told by its processes' arguments (the keeper
    /// runs from the same executable with `--box`): read as the kernel keeps them.
    @Test func aProcesssArgumentsAreReadAsItWasStarted() {
        #expect(AppOpener.arguments(of: getpid()) == CommandLine.arguments)
    }
}
