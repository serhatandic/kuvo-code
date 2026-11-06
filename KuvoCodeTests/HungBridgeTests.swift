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
        let running = folder.appending(path: "running")
        #expect(mkfifo(running.path(percentEncoded: false), 0o600) == 0)
        let standIn = folder.appending(path: "bun")
        try "#!/bin/sh\ntrap '' TERM\necho $$ > '\(running.path(percentEncoded: false))'\nexec /bin/sleep 600\n".write(to: standIn, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: standIn.path(percentEncoded: false))

        let agents = OutsideAgents()
        agents.home = folder.appending(path: "agents")
        let starting = Task { await agents.start(engine: standIn, environment: ["PATH": "/usr/bin:/bin", "HOME": folder.path(percentEncoded: false)]) }
        let path = running.path(percentEncoded: false)
        let told = await Task.detached { FileHandle(forReadingAtPath: path)?.readDataToEndOfFile() }.value
        let bridge = try #require(Int32(String(decoding: told ?? Data(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
        defer {
            kill(bridge, SIGKILL)
            try? FileManager.default.removeItem(at: folder)
        }

        starting.cancel()
        await starting.value
        #expect(agents.api == nil)
        #expect(agents.failure != nil)
        // As RealBridge goes on, for a start that failed.
        agents.stop()

        var gone = false
        for _ in 0..<300 where !gone {
            gone = kill(bridge, 0) != 0
            if !gone { try await Task.sleep(for: .milliseconds(100)) }
        }
        #expect(gone)
    }
}
