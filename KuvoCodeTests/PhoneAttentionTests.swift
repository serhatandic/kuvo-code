import AppKit
import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// Your phones' notices while you're at this Mac (KuvoLink's PROTOCOL.md, "kuvo/attention"): this
/// Mac's box holds them as a machine's bridge holds its own, and the app tells it, as "mac", that
/// you're here, with the conversations on its screen and the notifications it showed, and that
/// you're not as the Mac sleeps or its screen locks. The box is the real one (`kuvo-link.js serve`);
/// how long it holds each, and what it lets go, are the bridge's tests' (attention-mac). The Mac's
/// sleep and lock are posted to centers of the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneAttentionTests {
    let folder: URL
    /// A phone paired with this Mac, which hasn't said where it is yet.
    let phone = LinkKey()

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneAttention/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        UserDefaults.standard.set(true, forKey: "phoneLink")
        UserDefaults.standard.set("ws://127.0.0.1:9", forKey: "phoneLink.relay")
    }

    private func done(_ box: SettingsBox, _ link: PhoneLink) {
        Notifier.shared.toPhones = nil
        Notifier.shared.answeredForPhones = nil
        link.stop()
        box.stop()
        try? FileManager.default.removeItem(at: folder)
        for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// This Mac's link, as the app starts it, once its box (which has your phone) has been told the
    /// phone link's on (its relay is one nobody answers here).
    private func linked(on box: SettingsBox) async throws -> PhoneLink {
        try box.box.paired([(phone.publicBytes.base64URL, "iPhone", "p-1")])
        let link = PhoneLink(file: folder.appending(path: "phone-link.json"), identity: (LinkKey(), RelaySecret()))
        let client = box.client
        link.box = { client }
        box.box.host.phoneLink = link
        link.listen(to: Notifier.shared)
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        try await until { if case .failed = link.status { true } else { false } }
        return link
    }

    struct Attending: Decodable, Equatable {
        var inUse: Bool
        var held: Int
    }

    /// What this Mac's box holds now, once what the app said is there.
    private func boxHolds(_ box: SettingsBox, _ link: PhoneLink) async throws -> Attending {
        await link.saidToBox()
        return try await box.client.value(Attending.self, "GET", "kuvo/attention")
    }

    /// You at this Mac: what the app tells, from a Mac of the test's own.
    private func atTheMac(_ link: PhoneLink, onScreen: @escaping () -> [String] = { [] }) -> (attention: Attention, mac: TestMac) {
        let mac = TestMac()
        let attention = Attention(mac: mac.mac, onScreen: onScreen) { [link] sessions, shown in link.attend(sessions, shown: shown) }
        attention.start()
        return (attention, mac)
    }

    /// An ask from the panel's browser, which only the app knows: the app hands it to this Mac's box.
    private func asks(_ id: String) {
        Notifier.shared.notify(session: "", title: "github.com", subtitle: "Ada", body: "Wants the code GitHub sent.", push: .init(.ask, ask: id))
    }

    @Test func atTheMacTheBoxHoldsTheAppsAskUntilYouLeave() async throws {
        let box = try await SettingsBox(port: 47_946)
        let link = try await linked(on: box)
        defer { done(box, link) }
        #expect(try await boxHolds(box, link) == Attending(inUse: false, held: 0))

        let (attention, mac) = atTheMac(link)
        defer { attention.stop() }
        asks("ask_1")
        #expect(try await boxHolds(box, link) == Attending(inUse: true, held: 1), "you're here: it waits")
        // The lid closes: you're not, and what's held goes at once.
        mac.workspace.post(name: NSWorkspace.willSleepNotification, object: nil)
        #expect(try await boxHolds(box, link) == Attending(inUse: false, held: 0))

        // Awake, here again; answered at the Mac meanwhile, it never goes.
        mac.workspace.post(name: NSWorkspace.didWakeNotification, object: nil)
        asks("ask_2")
        #expect(try await boxHolds(box, link) == Attending(inUse: true, held: 1))
        Notifier.shared.clear(request: "ask_2")
        #expect(try await boxHolds(box, link) == Attending(inUse: true, held: 0))

        // The screen locks: not here.
        mac.distributed.post(name: Attention.screenLocked, object: nil)
        #expect(try await boxHolds(box, link).inUse == false)
    }

    /// With no one here, the app's ask goes at once; and only what the app alone knows goes from the
    /// app: a run finished or a permission is the box's own news, made from its engine's events.
    @Test func withNoOneHereTheAppsAskGoesAtOnceAndTheBoxsOwnNewsIsntSentTwice() async throws {
        let box = try await SettingsBox(port: 47_947)
        let link = try await linked(on: box)
        defer { done(box, link) }
        var sent: [Notice] = []
        let toBox = Notifier.shared.toPhones
        Notifier.shared.toPhones = { sent.append($0); toBox?($0) }
        asks("ask_1")
        #expect(try await boxHolds(box, link) == Attending(inUse: false, held: 0))
        Notifier.shared.notify(session: "ses_a", title: "Fix the tests", body: "All green.", push: .init(.finished))
        Notifier.shared.notify(session: "ses_a", title: "Fix the tests", body: "Wants to run a command: npm test", permission: (session: "ses_a", request: "per_1"),
                               push: .init(.permission, request: (session: "ses_a", id: "per_1")))
        #expect(sent.map(\.category) == [.ask])
        #expect(sent.first?.data == ["ask": "ask_1"])
        #expect(sent.first?.thread == "ask_1")
    }

    /// A machine's news the Mac showed is the machine's to count: this Mac's box hears only what
    /// it showed of this Mac's own.
    @Test func aMachinesNotificationIsntThisMacsToCount() async throws {
        let said = OSAllocatedUnfairLock<[Data]>(initialState: [])
        let link = PhoneLink(file: folder.appending(path: "phone-link.json"), identity: (LinkKey(), RelaySecret()))
        // This Mac's box, as far as what it's told of you goes.
        link.box = {
            BoxClient(box: BoxClient.mac, transport: LocalBox { request in
                if request.path == "kuvo/attention" { said.withLock { $0.append(request.body) } }
                return AsyncThrowingStream {
                    $0.yield(.head(status: 200, headers: ["content-type": "application/json"]))
                    $0.yield(.body(Data("{}".utf8)))
                    $0.finish()
                }
            })
        }
        defer {
            try? FileManager.default.removeItem(at: folder)
            for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        let (attention, _) = atTheMac(link)
        defer { attention.stop() }
        attention.shown(Attention.Shown(session: "ses_m", ask: false, machine: "box.invalid"))
        attention.shown(Attention.Shown(session: "ses_a", ask: false))
        await link.saidToBox()
        struct Told: Decodable { struct Shown: Decodable, Equatable { var session: String; var ask: Bool }; var shown: [Shown] }
        let told = try said.withLock { $0 }.map { try JSONDecoder().decode(Told.self, from: $0).shown }
        #expect(told.flatMap(\.self) == [.init(session: "ses_a", ask: false)])
    }

    /// A notification this Mac showed, as the boxes match it with their notices (this Mac's, made
    /// from its engine's news, or a machine's): its conversation, whether it asks you something,
    /// and the request or ask it's about. kuvo-link.js's `showsNotice` holds to the same words.
    @Test func aNotificationShownNamesWhatTheBoxesMatch() {
        #expect(Notifier.shown(.init(.finished), session: "ses_a") == Attention.Shown(session: "ses_a", ask: false))
        #expect(Notifier.shown(.init(.permission, request: (session: "ses_sub", id: "per_1")), session: "ses_a")
                == Attention.Shown(session: "ses_a", ask: true, request: "per_1"))
        #expect(Notifier.shown(.init(.question, request: (session: "ses_a", id: "frm_1")), session: "ses_a")
                == Attention.Shown(session: "ses_a", ask: true, request: "frm_1"))
        // A group chat's, and a browser's ask of no conversation.
        #expect(Notifier.shown(.init(.message, group: "grp_1"), session: BotGroups.tabKey("grp_1")) == Attention.Shown(session: "grp_1", ask: false))
        #expect(Notifier.shown(.init(.ask, ask: "ask_1"), session: "") == Attention.Shown(session: "ask_1", ask: true, request: "ask_1"))
        // A machine's: for that machine's box alone.
        #expect(Notifier.shown(.init(.finished, machine: "box.invalid"), session: "ses_m").machine == "box.invalid")
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
        attention.shown(Attention.Shown(session: "ses_a", ask: false))
        #expect(told.count == count)
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
