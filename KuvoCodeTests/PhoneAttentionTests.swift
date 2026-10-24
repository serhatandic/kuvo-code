import AppKit
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Your phones' notices while you're at this Mac (KuvoLink's PROTOCOL.md, "kuvo/attention"), as a
/// machine's bridge holds its own: while you're using Kuvo Code here, this Mac's own news waits a
/// little, and never goes if you answer it or its conversation is on screen meanwhile; once you're
/// not (asleep, locked, idle, gone), what waits goes at once, and with no one here, at once. The
/// app says you're not here as the Mac sleeps or its screen locks. The clock is the test's own,
/// the engine is stubbed, and the Mac's sleep and lock are posted to centers of the test's own.
@MainActor
@Suite(.serialized) struct PhoneAttentionTests {
    let engine = StubEngine(port: 47974)
    let workspace = Workspace()
    let link = PhoneLink(file: FileManager.default.temporaryDirectory.appending(path: "kuvo-attention-\(UUID().uuidString).json"))
    let clock = TestClock()
    let project = "/tmp/kuvo-tests-attention"
    /// What reached your phones.
    let phones = Sent()

    final class Sent {
        var notices: [Notice] = []
    }

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.set(true, forKey: "phoneLink")
        workspace.api = engine.api
        let phones = phones
        link.hold = NoticeHold(clock: clock.clock) { notice in
            phones.notices.append(notice)
            return true
        }
        link.listen(to: Notifier.shared)
    }

    private func done() {
        engine.stop()
        Notifier.shared.toPhones = nil
        Notifier.shared.answeredForPhones = nil
        UserDefaults.standard.removeObject(forKey: "phoneLink")
    }

    private func start(_ ids: [String]) async {
        engine.list(ids.map { StubEngine.session($0, title: "Fix the tests", directory: project) }, running: Set(ids))
        for id in ids { engine.conversation(id, []) }
        engine.on("POST", "/api/session/*", json: [:])
        await workspace.refresh()
    }

    /// This Mac's own sessions: a run finished, and a permission asked.
    private func finish(_ id: String) async throws {
        workspace.handle(try engine.event("session.execution.succeeded", session: id))
        try await eventually { link.hold.count > 0 || !phones.notices.isEmpty }
    }

    private func ask(_ request: String, in id: String) async throws {
        workspace.handle(try engine.event("permission.asked", ["id": request, "sessionID": id, "action": "shell", "resources": ["npm test"]]))
        try await eventually { link.hold.count > 0 || !phones.notices.isEmpty }
    }

    /// You at this Mac: what the app tells, from a Mac of the test's own.
    private func atTheMac(onScreen: @escaping () -> [String] = { [] }) -> (attention: Attention, mac: TestMac) {
        let mac = TestMac()
        let attention = Attention(mac: mac.mac, onScreen: onScreen) { [link] in link.attend($0) }
        attention.start()
        return (attention, mac)
    }

    @Test func atTheMacARunFinishedWaitsItsHoldThenGoes() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, _) = atTheMac()
        defer { attention.stop() }
        try await finish("ses_a")
        #expect(phones.notices.isEmpty)
        // Still here: renewed as the app does, until the hold ends.
        for _ in 0..<3 {
            clock.pass(Attention.renewEvery)
            attention.check(renewing: true)
        }
        clock.pass(NoticeHold.newsHold - 3 * Attention.renewEvery - 1)
        #expect(phones.notices.isEmpty)
        clock.pass(1)
        #expect(phones.notices.map(\.category) == [.finished])
        #expect(phones.notices.first?.data["session"] == "ses_a")
    }

    @Test func aPermissionAnsweredDuringItsHoldNeverGoes() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, _) = atTheMac()
        defer { attention.stop() }
        try await ask("per_1", in: "ses_a")
        #expect(link.hold.count == 1)
        clock.pass(5)
        // Answered (here, from the notification, or a phone): the engine says so.
        workspace.handle(try engine.event("permission.replied", ["sessionID": "ses_a", "requestID": "per_1"]))
        #expect(link.hold.count == 0)
        clock.pass(120)
        #expect(phones.notices.isEmpty)
    }

    @Test func aConversationOnScreenCountsAsSeen() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, _) = atTheMac(onScreen: { ["ses_a"] })
        defer { attention.stop() }
        try await finish("ses_a")
        clock.pass(Attention.renewEvery)
        attention.check(renewing: true)
        clock.pass(NoticeHold.newsHold)
        #expect(phones.notices.isEmpty)
    }

    /// Seen, a permission still waits on you: it goes once you've left it unanswered.
    @Test func aPermissionSeenButLeftUnansweredGoesWhenYouLeave() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, mac) = atTheMac(onScreen: { ["ses_a"] })
        defer { attention.stop() }
        try await ask("per_1", in: "ses_a")
        clock.pass(Attention.renewEvery)
        attention.check(renewing: true)
        clock.pass(NoticeHold.askHold)
        #expect(phones.notices.isEmpty)
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(phones.notices.map(\.category) == [.permission])
    }

    @Test func aLeaseThatRunsOutSendsWhatsHeldAtOnce() async throws {
        defer { done() }
        await start(["ses_a"])
        // At the Mac, then gone without a word (the app stopped mid-way): its lease runs out first.
        let (attention, _) = atTheMac()
        attention.stop()
        try await finish("ses_a")
        clock.pass(Attention.lease - 1)
        #expect(phones.notices.isEmpty)
        clock.pass(1)
        #expect(phones.notices.map(\.category) == [.finished])
    }

    @Test func theMacSleepingSendsWhatsHeldAtOnce() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, mac) = atTheMac()
        defer { attention.stop() }
        try await ask("per_1", in: "ses_a")
        #expect(phones.notices.isEmpty)
        // The lid closes.
        mac.workspace.post(name: NSWorkspace.willSleepNotification, object: nil)
        #expect(phones.notices.map(\.category) == [.permission])
    }

    @Test func theScreenLockingSendsWhatsHeldAtOnce() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, mac) = atTheMac()
        defer { attention.stop() }
        try await finish("ses_a")
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(phones.notices.map(\.category) == [.finished])
    }

    @Test func withNoOneHereItGoesAtOnce() async throws {
        defer { done() }
        await start(["ses_a"])
        try await finish("ses_a")
        #expect(phones.notices.map(\.category) == [.finished])
        #expect(link.hold.count == 0)
    }

    /// What the app tells as you come and go: renewed while you're here, with the conversations on
    /// screen while its window's in front, and that you're not at once on sleep, the screen
    /// sleeping or locking, and going idle.
    @Test func theAppSaysYoureNotHereOnSleepAndScreenLock() {
        let mac = TestMac()
        var told: [[String]?] = []
        let attention = Attention(mac: mac.mac, onScreen: { ["ses_a"] }) { told.append($0) }
        attention.start()
        defer { attention.stop() }
        #expect(told == [["ses_a"]])
        mac.renew()
        #expect(told == [["ses_a"], ["ses_a"]], "renewed while you're here")

        mac.workspace.post(name: NSWorkspace.willSleepNotification, object: nil)
        #expect(told.last == .some(nil))
        mac.renew()
        #expect(told.count == 3, "asleep, nothing renews")
        mac.workspace.post(name: NSWorkspace.didWakeNotification, object: nil)
        #expect(told.last == ["ses_a"])

        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(told.last == .some(nil))
        mac.distributed.post(name: Attention.screenUnlocked, object: nil)
        #expect(told.last == ["ses_a"])

        mac.workspace.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
        #expect(told.last == .some(nil))
        mac.workspace.post(name: NSWorkspace.screensDidWakeNotification, object: nil)
        #expect(told.last == ["ses_a"])

        // Another account in front.
        mac.workspace.post(name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        #expect(told.last == .some(nil))
        mac.workspace.post(name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
        #expect(told.last == ["ses_a"])

        // No input since the last word: still here, but what's on screen isn't seen by anyone.
        mac.idle = Attention.renewEvery
        mac.renew()
        #expect(told.last == [])
        mac.idle = 1
        mac.renew()
        #expect(told.last == ["ses_a"])

        // The window behind another app's, with notifications on: here, nothing on screen.
        mac.inFront = false
        mac.app.post(name: NSApplication.didResignActiveNotification, object: nil)
        #expect(told.last == [])
        // Gone quiet.
        mac.idle = Attention.idleAfter
        mac.renew()
        #expect(told.last == .some(nil))
    }
}

/// A clock that moves only when the test moves it, and the timers it runs.
@MainActor
final class TestClock {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    private var timers: [(id: Int, at: Date, fire: () -> Void)] = []
    private var next = 0

    var clock: NoticeHold.Clock {
        NoticeHold.Clock(now: { self.now }) { seconds, fire in
            self.next += 1
            let id = self.next
            self.timers.append((id, self.now.addingTimeInterval(seconds), fire))
            return { [weak self] in self?.timers.removeAll { $0.id == id } }
        }
    }

    /// Moves on by `seconds`, running each timer as its time comes.
    func pass(_ seconds: TimeInterval) {
        let end = now.addingTimeInterval(seconds)
        while let due = timers.filter({ $0.at <= end }).min(by: { $0.at < $1.at }) {
            timers.removeAll { $0.id == due.id }
            now = due.at
            due.fire()
        }
        now = end
    }
}

/// A Mac of the test's own for `Attention`: you here, awake and unlocked, until the test says.
@MainActor
final class TestMac {
    var idle: TimeInterval = 5
    var inFront = true
    let workspace = NotificationCenter()
    let distributed = NotificationCenter()
    let app = NotificationCenter()
    private var renewing: (() -> Void)?

    var mac: Attention.Mac {
        Attention.Mac(idle: { self.idle }, isLocked: { false }, windowInFront: { self.inFront }, notificationsOn: { true },
                      workspace: workspace, distributed: distributed, app: app) { _, fire in
            self.renewing = fire
            return { [weak self] in self?.renewing = nil }
        }
    }

    /// The app's timer comes round.
    func renew() { renewing?() }
}
