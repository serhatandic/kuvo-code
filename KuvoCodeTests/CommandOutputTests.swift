import ClientSessions
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A command that prints a lot (J4), as its output shows in the bar of background commands: the
/// end of it, from a whole line, however much it printed; all of it while there's little; and one
/// that has ended, which stops being read. The engine, which keeps the output, is stubbed.
@MainActor
@Suite(.serialized) struct CommandOutputTests {
    let engine = StubEngine(port: 47982)

    /// The engine keeping `printed` for command sh_build: its size, or the bytes from a cursor.
    private func keeps(_ printed: String) {
        let bytes = Array(printed.utf8)
        engine.on("GET", "/api/shell/sh_build/output") { request in
            let limit = Int(request.query["limit"] ?? "") ?? bytes.count
            let from = min(Int(request.query["cursor"] ?? "") ?? 0, bytes.count)
            let slice = bytes[from..<min(from + limit, bytes.count)]
            return StubWeb.json(["location": ["directory": "/tmp/kuvo-tests-build"],
                                 "data": ["output": String(decoding: slice, as: UTF8.self), "cursor": from + slice.count, "size": bytes.count]])
        }
    }

    @Test func theEndOfALongOutputFromAWholeLine() async throws {
        defer { engine.stop() }
        let lines = (1...4_000).map { String(format: "[%04d/4000] Compiling module %04d of the app", $0, $0) }
        keeps(lines.joined(separator: "\n") + "\n")
        let end = try #require(await engine.api.shellOutputEnd(of: "sh_build", directory: "/tmp/kuvo-tests-build").printed)
        #expect(end.utf8.count <= OpenCodeAPI.shownShellOutput)
        #expect(end.hasSuffix("[4000/4000] Compiling module 4000 of the app"), "up to what it printed last")
        let first = try #require(end.split(separator: "\n").first)
        #expect(lines.contains(String(first)), "from a whole line, not the middle of one: \(first)")
    }

    /// One long line (minified JSON, say), ended: its end, not nothing.
    @Test func oneLongLineShowsItsEnd() async throws {
        defer { engine.stop() }
        let line = String(repeating: "{\"k\":1},", count: 5_000) + "{\"last\":true}"
        keeps(line + "\n")
        let end = try #require(await engine.api.shellOutputEnd(of: "sh_build", directory: "/tmp/kuvo-tests-build").printed)
        #expect(end.hasSuffix("{\"last\":true}"), "the line's end: \(end.suffix(40))")
    }

    /// With no line end, a read that starts partway into a character starts at the next whole one.
    @Test func noHalfACharacter() async throws {
        defer { engine.stop() }
        // 30,001 bytes: the last 24,000 start on the second byte of an é.
        keeps(String(repeating: "é", count: 15_000) + "x")
        #expect(await engine.api.shellOutputEnd(of: "sh_build", directory: "/tmp/kuvo-tests-build").printed == String(repeating: "é", count: 11_999) + "x")
    }

    @Test func allOfItWhileTheresLittle() async throws {
        defer { engine.stop() }
        keeps("Starting the server\nListening on :3000\n")
        #expect(await engine.api.shellOutputEnd(of: "sh_build", directory: "/tmp/kuvo-tests-build").printed == "Starting the server\nListening on :3000")
    }

    /// A command its engine no longer has has ended: Output says so and stops reading it, rather
    /// than blaming its computer and reading it every moment. One that can't be read for a moment
    /// (its computer busy, or a 404 on the way that isn't its engine's word) is read again.
    @Test(.timeLimit(.minutes(1))) func oneThatEndedStopsBeingReadAndOneUnreadIsTriedAgain() async throws {
        defer { engine.stop() }
        let answers = InTurn([
            StubWeb.json(["message": "Busy"], status: 500),
            StubWeb.json(["message": "Not Found"], status: 404),
            StubWeb.json(["name": "ShellNotFoundError", "data": ["message": "Shell command not found: sh_build"]], status: 404),
        ])
        engine.on("GET", "/api/shell/sh_build/output") { _ in answers.next() }
        var shown: [ShellRead] = []
        await ShellOutputView.follow("sh_build", api: engine.api, directory: "/tmp/kuvo-tests-build", every: .zero) { shown.append($0) }
        #expect(shown == [.unread, .unread, .ended])
        #expect(engine.requests("GET", "/api/shell/sh_build/output").count == 3, "nothing read once it ended")
    }
}

/// Answers given in turn, the last again once they run out.
private nonisolated final class InTurn: @unchecked Sendable {
    private let answers: [StubWeb.Answer]
    private var given = 0
    private let lock = NSLock()

    init(_ answers: [StubWeb.Answer]) { self.answers = answers }

    func next() -> StubWeb.Answer {
        lock.withLock {
            defer { given += 1 }
            return answers[min(given, answers.count - 1)]
        }
    }
}
