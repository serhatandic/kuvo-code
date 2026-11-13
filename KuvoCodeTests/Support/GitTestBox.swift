import Foundation
import OpenCodeKit
@testable import KuvoCode

/// This Mac's box for a test of what runs git there (Changes, Merge into…), as the app asks its
/// own: the real box (`MachineTestBox`, run with Node), with git's settings as the tests have them
/// (`TestEnvironment`) and Discard's Trash the tests' own (`AppInfo.testTrash`). Stopped, and its
/// folder removed, once the test that made it lets it go.
nonisolated final class GitTestBox {
    let client: BoxClient
    private let stops: @Sendable () -> Void

    @MainActor init() async throws {
        TestEnvironment.prepare()
        let box = try await MachineTestBox(name: BoxClient.mac, environment: [
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Tests", "GIT_AUTHOR_EMAIL": "tests@example.com",
            "GIT_COMMITTER_NAME": "Tests", "GIT_COMMITTER_EMAIL": "tests@example.com",
            "KUVO_CHANGES_TRASH": AppInfo.testTrash.path(percentEncoded: false),
        ])
        client = box.client
        let server = box.server, folder = box.folder
        stops = {
            server.stop()
            try? FileManager.default.removeItem(at: folder)
        }
    }

    deinit { stops() }

    /// A Changes panel's store for `directory` on this Mac, asking this box.
    @MainActor func changes(_ directory: String) -> ProjectChanges {
        let client = client
        return ProjectChanges(directory: directory) { _ in client }
    }
}
