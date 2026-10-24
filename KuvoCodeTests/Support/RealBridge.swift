import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The agents bridge as the app ships it (`kuvo-agents.js` in the test copy), run by the Bun that
/// `scripts/test-app.sh` gives (KUVO_TEST_BUN), started the way the app starts it, with a test's
/// stand-in for its engine: what the window shows of what runs there, against the real thing.
/// Everything it keeps is in `folder`. Stop it with the test.
@MainActor
final class RealBridge {
    let agents = OutsideAgents()
    let listener: StubListener

    var api: OpenCodeAPI? { agents.api }

    private init(listener: StubListener) {
        self.listener = listener
    }

    /// `environment`: what the app would add to the bridge's (where group chats live, say).
    static func start(engine: StubEngine, folder: URL, environment: [String: String] = [:]) async throws -> RealBridge {
        let bun = try #require(ProcessInfo.processInfo.environment["KUVO_TEST_BUN"].flatMap { $0.isEmpty ? nil : URL(filePath: $0) },
                               "No Bun for the agents bridge: run the app's tests with scripts/test-app.sh, which gives it")
        // The app's own requests to it go out as they are; the stand-in's keep their answers.
        StubWeb.letUnansweredThrough()
        let bridge = RealBridge(listener: try await engine.listen())
        bridge.agents.home = folder.appending(path: "agents")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        await bridge.agents.start(engine: bun, environment: ["PATH": "/usr/bin:/bin", "HOME": folder.path].merging(environment) { $1 })
        guard bridge.api != nil else {
            bridge.stop()
            Issue.record("The agents bridge didn't start: \(bridge.agents.failure ?? "")")
            throw CancellationError()
        }
        // Where its engine is, as the app tells it once both are up.
        bridge.agents.engineEndpoint = bridge.listener.endpoint
        return bridge
    }

    func stop() {
        agents.stop()
        listener.stop()
    }
}
