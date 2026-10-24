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
    let clock = HoldClock()
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
        let attention = Attention(mac: mac.mac, onScreen: onScreen) { [link] sessions, shown in link.attend(sessions, shown: shown) }
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

    /// The Mac showed it in a notification while you're here: your phone needn't tell you again.
    /// (With the Mac's notifications off, or the window in front, none is shown, and it goes after
    /// its hold, as in the first test.)
    @Test func aRunFinishedTheMacShowedNeverGoes() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, mac) = atTheMac()
        defer { attention.stop() }
        try await finish("ses_a")
        attention.shown(Notifier.shown(.init(.finished), session: "ses_a"))
        clock.pass(NoticeHold.newsHold)
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(phones.notices.isEmpty)
    }

    /// A permission the Mac showed still waits on you: it goes once you've left it unanswered, and
    /// never once answered.
    @Test func aPermissionTheMacShowedWaitsUntilAnsweredOrYouLeave() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, mac) = atTheMac()
        defer { attention.stop() }
        try await ask("per_1", in: "ses_a")
        attention.shown(Notifier.shown(.init(.permission, request: (session: "ses_a", id: "per_1")), session: "ses_a"))
        clock.pass(NoticeHold.askHold)
        #expect(phones.notices.isEmpty)
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(phones.notices.map(\.category) == [.permission])

        mac.distributed.post(name: Attention.screenUnlocked, object: nil)
        try await ask("per_2", in: "ses_a")
        attention.shown(Notifier.shown(.init(.permission, request: (session: "ses_a", id: "per_2")), session: "ses_a"))
        clock.pass(NoticeHold.askHold)
        workspace.handle(try engine.event("permission.replied", ["sessionID": "ses_a", "requestID": "per_2"]))
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(phones.notices.count == 1)
    }

    /// The Mac's notification and the notice for phones name the same conversation and kind, so a
    /// box (this Mac's, or a machine's of the same news) can tell one is the other.
    @Test func aNotificationShownMatchesItsNoticeForPhones() async throws {
        defer { done() }
        await start(["ses_a"])
        try await finish("ses_a")
        try await ask("per_1", in: "ses_a")
        try await eventually { phones.notices.count == 2 }
        let pushes: [(Notifier.Push, String)] = [(.init(.finished), "ses_a"), (.init(.permission, request: (session: "ses_a", id: "per_1")), "ses_a")]
        #expect(phones.notices.map(NoticeHold.Shown.init(of:)) == pushes.map { Notifier.shown($0.0, session: $0.1) })
        // A group chat's, and a browser's ask of no conversation.
        #expect(Notifier.shown(.init(.message, group: "grp_1"), session: BotGroups.tabKey("grp_1")) == NoticeHold.Shown(session: "grp_1", ask: false))
        #expect(Notifier.shown(.init(.ask, ask: "ask_1"), session: "") == NoticeHold.Shown(session: "ask_1", ask: true, request: "ask_1"))
        // A machine's: for that machine's box alone.
        #expect(Notifier.shown(.init(.finished, machine: "box.invalid"), session: "ses_m").machine == "box.invalid")
    }

    /// A machine's news the Mac showed is the machine's to let go: this Mac's box holds its own
    /// news of the same conversation as before.
    @Test func aMachinesNotificationIsntThisMacsToCount() async throws {
        defer { done() }
        await start(["ses_a"])
        let (attention, _) = atTheMac()
        defer { attention.stop() }
        try await finish("ses_a")
        attention.shown(NoticeHold.Shown(session: "ses_a", ask: false, machine: "box.invalid"))
        for _ in 0..<4 {
            clock.pass(Attention.renewEvery)
            attention.check(renewing: true)
        }
        #expect(phones.notices.map(\.category) == [.finished])
    }

    /// One notification stands for one notice: of two runs finished in a conversation, the one not
    /// shown still goes.
    @Test func aNotificationStandsForOneNotice() {
        defer { done() }
        let (attention, _) = atTheMac()
        defer { attention.stop() }
        let first = Notice(title: "Fix the tests", body: "All green.", category: .finished, thread: "ses_a", data: ["session": "ses_a"])
        var second = first
        second.body = "And the docs."
        link.push(first)
        link.push(second)
        attention.shown(NoticeHold.Shown(of: first))
        for _ in 0..<4 {
            clock.pass(Attention.renewEvery)
            attention.check(renewing: true)
        }
        #expect(phones.notices == [second])
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
        let attention = Attention(mac: mac.mac, onScreen: { ["ses_a"] }) { sessions, _ in told.append(sessions) }
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
        // A notification shown with no one here says nothing: the boxes tell your phones at once.
        let count = told.count
        attention.shown(NoticeHold.Shown(session: "ses_a", ask: false))
        #expect(told.count == count)
    }
}

/// A clock that moves only when the test moves it, and the timers it runs.
@MainActor
final class HoldClock {
    /// Only differences count: where it starts makes no difference.
    var now = ContinuousClock.now
    private var timers: [(id: Int, at: ContinuousClock.Instant, fire: () -> Void)] = []
    private var next = 0

    var clock: NoticeHold.Clock {
        NoticeHold.Clock(now: { self.now }) { delay, fire in
            self.next += 1
            let id = self.next
            self.timers.append((id, self.now + delay, fire))
            return { [weak self] in self?.timers.removeAll { $0.id == id } }
        }
    }

    /// Moves on by `seconds`, running each timer as its time comes.
    func pass(_ seconds: TimeInterval) {
        let end = now + .seconds(seconds)
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
