import Foundation
import OpenCodeKit
import Testing
import UsageKit
@testable import KuvoCode

/// The usage panel's settings as this Mac's box keeps them (#631 piece F, PROTOCOL.md "Usage
/// settings"): a change made while the box isn't answering, kept through a restart, goes once it's
/// back, saying which version it was made from; one the box turns away (another computer's came
/// meanwhile) gives way to the box's. The box is a stand-in; the panel's settings are a suite of
/// the test's own.
@MainActor @Suite(.serialized, .timeLimit(.minutes(1))) struct UsageSettingsOnBoxTests {
    private static let box = "http://127.0.0.1:47981"
    private static let underTen = "openusage.notifications.underTenPercent"

    /// What the stand-in box was sent, and answers.
    private nonisolated final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var _puts: [[String: Any]] = []
        var notifications: [String: Bool] = ["underTenPercent": false, "healthyToClose": false, "closeToRunningOut": false]
        var version = "1/dev-key"
        /// Parts a change of which it turns away (another computer's came meanwhile).
        var stale: [String] = []
        var puts: [[String: Any]] { lock.withLock { _puts } }

        func answer(_ request: URLRequest, _ body: Data) -> StubWeb.Answer {
            lock.withLock {
                var extra: [String: Any] = [:]
                if request.httpMethod == "PUT" {
                    let given = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
                    _puts.append(given)
                    if !stale.isEmpty {
                        extra["stale"] = stale
                    } else if let changed = given["notifications"] as? [String: Bool] {
                        notifications = changed
                        version = "2/mac-key"
                    }
                }
                return StubWeb.json(["data": ["settings": ["notifications": notifications], "versions": ["notifications": version], "imported": true].merging(extra) { first, _ in first }])
            }
        }
    }

    init() {
        StubWeb.start(hosts: ["127.0.0.1"])
    }

    private func api() -> OpenCodeAPI {
        OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: Self.box)!, password: "test"))
    }

    /// A settings suite of the test's own, in a folder it removes.
    private func suite() throws -> (UserDefaults, URL) {
        let folder = FileManager.default.temporaryDirectory.appending(path: "UsageSettingsOnBox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return (UserDefaults(suiteName: folder.appending(path: "settings").path)!, folder)
    }

    @Test func aChangeMadeWhileTheBoxWasntAnsweringGoesOnceItIsBackAfterARestartToo() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        StubWeb.handle(Self.box + "/api/kuvo/usage/settings") { request, body in box.answer(request, body) }

        // The box says its settings once.
        var host: HostSettings? = HostSettings(defaults: defaults)
        var first: UsageSettingsOnBox? = UsageSettingsOnBox(host: host!, defaults: defaults)
        first?.connected(api: api(), box: BoxClient.mac)
        try await until { first?.answered == 1 }

        // It stops answering; a notification is turned on, and the app quits.
        first?.stopped()
        defaults.set(true, forKey: Self.underTen)
        host?.flush()
        #expect(box.puts.isEmpty)
        first = nil
        host = nil

        // The app starts again, the box answering: the change goes first, made from the version it last said.
        let again = HostSettings(defaults: defaults)
        let second = UsageSettingsOnBox(host: again, defaults: defaults)
        second.connected(api: api(), box: BoxClient.mac)
        try await until { second.answered == 1 }
        #expect(box.puts.count == 1)
        let sent = box.puts[0]
        #expect((sent["notifications"] as? [String: Bool])?["underTenPercent"] == true)
        #expect((sent["based"] as? [String: String])?["notifications"] == "1/dev-key")
        #expect(defaults.bool(forKey: Self.underTen))
    }

    @Test func aChangeTheBoxTurnsAwayGivesWayToTheBoxs() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        StubWeb.handle(Self.box + "/api/kuvo/usage/settings") { request, body in box.answer(request, body) }
        let host = HostSettings(defaults: defaults)
        let store = UsageSettingsOnBox(host: host, defaults: defaults)
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 1 }

        // Another computer turned on "close to running out" meanwhile; this Mac's change is from before it.
        box.notifications = ["underTenPercent": false, "healthyToClose": false, "closeToRunningOut": true]
        box.version = "3/dev-key"
        box.stale = ["notifications"]
        defaults.set(true, forKey: Self.underTen)
        host.flush()
        try await until { store.answered == 2 }
        #expect(box.puts.count == 1)
        #expect(defaults.bool(forKey: "openusage.notifications.closeToRunningOut"))
        #expect(!defaults.bool(forKey: Self.underTen), "the box's, as the other computer left it")
    }
}
