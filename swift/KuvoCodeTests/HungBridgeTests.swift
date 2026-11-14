import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The agents bridge held up as it starts: a stand-in that never says where it listens and takes
/// no notice of being stopped, run as the bridge is. Given up on, it's gone, with nothing else
/// from the test to end it: these stayed for hours after their test run, asking macOS something.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct HungBridgeTests {
    let folder = AppInfo.testRoot.appending(path: "HungBridge-\(UUID().uuidString.prefix(6))")

    @Test func oneHeldUpAsItStartsIsGoneOnceItsStartIsGivenUp() async throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let said = folder.appending(path: "pid")
        let standIn = folder.appending(path: "bun")
        try """
            #!/bin/sh
            trap '' TERM
            echo $$ > '\(said.path(percentEncoded: false)).new'
            mv '\(said.path(percentEncoded: false)).new' '\(said.path(percentEncoded: false))'
            exec /bin/sleep 600
            """.write(to: standIn, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: standIn.path(percentEncoded: false))

        let agents = OutsideAgents()
        agents.home = folder.appending(path: "agents")
        let starting = Task { await agents.start(engine: standIn, environment: ["PATH": "/usr/bin:/bin", "HOME": folder.path(percentEncoded: false)]) }
        var bridge: Int32?
        defer {
            starting.cancel()
            if let bridge { kill(bridge, SIGKILL) }
            try? FileManager.default.removeItem(at: folder)
        }
        for _ in 0..<300 where bridge == nil {
            bridge = (try? String(contentsOf: said, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
            if bridge == nil { try await Task.sleep(for: .milliseconds(100)) }
        }
        let process = try #require(bridge, "It never started.")

        starting.cancel()
        await starting.value
        #expect(agents.api == nil)
        #expect(agents.failure != nil)
        // As RealBridge goes on, for a start that failed.
        agents.stop()

        for _ in 0..<300 where bridge != nil {
            if kill(process, 0) != 0 { bridge = nil } else { try await Task.sleep(for: .milliseconds(100)) }
        }
        #expect(bridge == nil, "It's still running.")
    }
}
