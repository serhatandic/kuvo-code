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
        private var changes = 0
        /// Parts a change of which it turns away (another computer's came meanwhile).
        var stale: [String] = []
        /// The answer to the first change, held back until `release` (nil: none held).
        private var held: (@Sendable (StubWeb.Answer) -> Void)?
        var holdsFirstChange = false
        /// The first change taken, but answered with this status, as a gateway that lost its answer.
        var losesFirstAnswer: Int?
        /// Every change answered 400, as a part it can't take.
        var refuses = false
        var puts: [[String: Any]] { lock.withLock { _puts } }

        /// Answers a request, but the first change while `holdsFirstChange`, whose answer waits.
        func answer(_ request: URLRequest, _ body: Data, reply: @escaping @Sendable (StubWeb.Answer) -> Void) {
            let answer = self.answer(request, body)
            let holds = lock.withLock {
                guard holdsFirstChange, request.httpMethod == "PUT", held == nil, _puts.count == 1 else { return false }
                held = reply
                return true
            }
            if !holds { reply(answer) }
            else { lock.withLock { heldAnswer = answer } }
        }
        private var heldAnswer: StubWeb.Answer?

        func release() {
            let (reply, answer) = lock.withLock { (held, heldAnswer) }
            if let reply, let answer { reply(answer) }
        }

        func answer(_ request: URLRequest, _ body: Data) -> StubWeb.Answer {
            lock.withLock {
                var extra: [String: Any] = [:]
                if request.httpMethod == "PUT" {
                    let given = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
                    _puts.append(given)
                    // As a box does: a change made from a version it has moved on from is turned away.
                    let based = (given["based"] as? [String: Any])?["notifications"] as? String
                    if refuses { return StubWeb.json(["message": "That isn't a notifications setting."], status: 400) }
                    if !stale.isEmpty || (based != nil && based != version) {
                        extra["stale"] = stale.isEmpty ? ["notifications"] : stale
                    } else if let changed = given["notifications"] as? [String: Bool] {
                        notifications = changed
                        changes += 1
                        version = "\(changes + 1)/mac-key"
                        if let status = losesFirstAnswer, changes == 1 { return StubWeb.json(["message": "Bad gateway"], status: status) }
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

    @Test func aSecondChangeMadeWhileTheFirstIsOnItsWayIsntTurnedAway() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        box.holdsFirstChange = true
        StubWeb.hold(Self.box + "/api/kuvo/usage/settings") { request, body, reply in box.answer(request, body, reply: reply) }
        let host = HostSettings(defaults: defaults)
        let store = UsageSettingsOnBox(host: host, defaults: defaults)
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 1 }

        // One notification turned on; its answer is slow. Another turned on meanwhile.
        defaults.set(true, forKey: Self.underTen)
        host.flush()
        try await until { box.puts.count == 1 }
        defaults.set(true, forKey: "openusage.notifications.healthyToClose")
        host.flush()
        box.release()
        try await until { store.answered == 3 }

        #expect(box.puts.count == 2)
        #expect(box.notifications == ["underTenPercent": true, "healthyToClose": true, "closeToRunningOut": false], "the box ends with the second")
        #expect(defaults.bool(forKey: "openusage.notifications.healthyToClose"), "and the panel keeps it")
    }

    @Test func aChangeWhoseAnswerWasLostDoesntTurnAwayTheNext() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        // (A gateway's 502: the engine's client asks again by itself only after a 503.)
        box.losesFirstAnswer = 502
        StubWeb.handle(Self.box + "/api/kuvo/usage/settings") { request, body in box.answer(request, body) }
        let host = HostSettings(defaults: defaults)
        let store = UsageSettingsOnBox(host: host, defaults: defaults)
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 1 }

        // The box takes the first change, but its answer is lost on the way; another change follows.
        defaults.set(true, forKey: Self.underTen)
        host.flush()
        try await until { box.puts.count == 1 }
        defaults.set(true, forKey: "openusage.notifications.healthyToClose")
        host.flush()
        // Turned away against this Mac's own first: it goes again from the box's version.
        let both = ["underTenPercent": true, "healthyToClose": true, "closeToRunningOut": false]
        try await until { store.answered == 3 }
        #expect(box.puts.count == 3)
        #expect(box.notifications == both)
        #expect(defaults.bool(forKey: "openusage.notifications.healthyToClose"))
    }

    @Test func aChangeTheBoxCantTakeGivesWayToTheBoxs() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        box.refuses = true
        StubWeb.handle(Self.box + "/api/kuvo/usage/settings") { request, body in box.answer(request, body) }
        let host = HostSettings(defaults: defaults)
        let store = UsageSettingsOnBox(host: host, defaults: defaults)
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 1 }
        defaults.set(true, forKey: Self.underTen)
        host.flush()
        // Refused: read again, the box's shown, nothing left to go.
        try await until { store.answered == 2 }
        #expect(box.puts.count == 1)
        #expect(!defaults.bool(forKey: Self.underTen))
        #expect(defaults.data(forKey: "usage.settingsUnsent").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }.map { ($0["parts"] as? [String: Any])?.isEmpty ?? true } == true)
    }

    @Test func aValueThisMacSentLongAgoDoesntMakeAnotherComputersNewerOneItsOwn() async throws {
        let (defaults, folder) = try suite()
        defer { StubWeb.stop(); try? FileManager.default.removeItem(at: folder) }
        let box = Box()
        StubWeb.handle(Self.box + "/api/kuvo/usage/settings") { request, body in box.answer(request, body) }
        let host = HostSettings(defaults: defaults)
        let store = UsageSettingsOnBox(host: host, defaults: defaults)
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 1 }
        let a = ["underTenPercent": true, "healthyToClose": false, "closeToRunningOut": false]

        // This Mac turns on "under ten percent" (A).
        defaults.set(true, forKey: Self.underTen)
        host.flush()
        try await until { store.answered == 2 }
        #expect(box.notifications == a)
        // Another computer changes it (B), and this Mac shows it.
        box.notifications = ["underTenPercent": false, "healthyToClose": true, "closeToRunningOut": false]
        box.version = "3/dev-key"
        store.connected(api: api(), box: BoxClient.mac)
        try await until { store.answered == 3 }
        // This Mac is away; the other computer puts A back, newer than all of it.
        store.stopped()
        box.notifications = a
        box.version = "4/dev-key"
        // A change made here meanwhile (C), from B.
        defaults.set(true, forKey: "openusage.notifications.closeToRunningOut")
        host.flush()
        store.connected(api: api(), box: BoxClient.mac)
        // C is turned away (the other computer's A is newer), and the box's A shows: not taken for this Mac's own.
        try await until { store.answered == 5 }
        #expect(box.puts.count == 2)
        #expect(box.notifications == a)
        #expect(defaults.bool(forKey: Self.underTen))
        #expect(!defaults.bool(forKey: "openusage.notifications.closeToRunningOut"))
    }
}
