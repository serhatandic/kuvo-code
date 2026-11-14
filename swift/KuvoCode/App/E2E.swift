#if DEBUG
import Foundation
import OpenCodeKit

/// For the end-to-end tests (Tests/E2E): with `KUVO_E2E` set, where this copy's engine answers,
/// so a test can read what happened the way the app does. In the app's own folder, readable by
/// you only, and removed when the engine stops. Debug builds only.
enum E2E {
    static var isOn: Bool { ProcessInfo.processInfo.environment["KUVO_E2E"] != nil }

    private static var file: URL { AppInfo.supportDirectory.appending(path: "e2e-engine.json") }

    static func note(_ endpoint: ServerEndpoint) {
        guard isOn else { return }
        let record = ["url": endpoint.url.absoluteString, "username": endpoint.username, "password": endpoint.password ?? ""]
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        FileManager.default.createFile(atPath: file.path, contents: data, attributes: [.posixPermissions: 0o600])
    }

    static func forget() {
        guard isOn else { return }
        try? FileManager.default.removeItem(at: file)
    }
}
#endif
