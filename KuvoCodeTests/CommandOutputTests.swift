import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A command that prints a lot (J4), as its output shows in the bar of background commands: the
/// end of it, from a whole line, however much it printed; all of it while there's little. The
/// engine, which keeps the output, is stubbed.
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
        let end = try #require(await ShellOutputView.end(of: "sh_build", api: engine.api, directory: "/tmp/kuvo-tests-build"))
        #expect(end.utf8.count <= ShellOutputView.tail)
        #expect(end.hasSuffix("[4000/4000] Compiling module 4000 of the app"), "up to what it printed last")
        let first = try #require(end.split(separator: "\n").first)
        #expect(lines.contains(String(first)), "from a whole line, not the middle of one: \(first)")
    }

    @Test func allOfItWhileTheresLittle() async throws {
        defer { engine.stop() }
        keeps("Starting the server\nListening on :3000\n")
        #expect(await ShellOutputView.end(of: "sh_build", api: engine.api, directory: "/tmp/kuvo-tests-build") == "Starting the server\nListening on :3000")
    }
}
