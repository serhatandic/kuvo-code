import CryptoKit
import Foundation
import KuvoLink
import os
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's link to your phones is its box's (KuvoLink's PROTOCOL.md, "This Mac's box: the
/// relay"), and the app is a client of it: your phones are the box's, and the app keeps a copy;
/// Settings › Phone's pairing link and removing a phone are the box's; what a phone asks of the
/// Mac's own routes, the box hands the app, a followed one as it comes. The box is the real one
/// (`kuvo-link.js serve`, with its keys from the app); its relay is one nobody listens on, so
/// nothing here reaches the real relay. The rules themselves are the bridge's tests' (mac-link).
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneLinkBoxTests {
    let folder: URL
    let mac = LinkKey(), mine = LinkKey(), lost = LinkKey()
    let secret = RelaySecret()
    var file: URL { folder.appending(path: "phone-link.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneLinkBox/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        UserDefaults.standard.set(true, forKey: "phoneLink")
        UserDefaults.standard.set("ws://127.0.0.1:9", forKey: "phoneLink.relay")
        // The app's copy of your phones (phone-link.json): none yet, until it hears the box's.
        try Data(#"{"phones":[],"removed":[],"machines":{}}"#.utf8).write(to: file)
    }

    /// The phones paired with this Mac, as its box keeps them: two, one paired before pairings had
    /// an id.
    private func paired(_ box: SettingsBox) throws {
        try box.box.paired([(mine.publicBytes.base64URL, "Mine", ""), (lost.publicBytes.base64URL, "Lost", "p-lost")])
    }

    /// The app's copy as it last heard the box's phones, before this launch.
    private func copied() throws {
        let phones = [(mine, "Mine", ""), (lost, "Lost", "p-lost")].map {
            #"{"key":"\#($0.0.publicBytes.base64URL)","name":"\#($0.1)","added":700000000,"pairing":"\#($0.2)"}"#
        }
        try Data(#"{"phones":[\#(phones.joined(separator: ","))],"removed":[],"machines":{}}"#.utf8).write(to: file)
    }

    /// Once the app has the box's phones.
    private func heard(_ link: PhoneLink) async throws {
        try await until { link.phones.map(\.name).sorted() == ["Lost", "Mine"] }
    }

    private func done(_ box: SettingsBox, _ links: PhoneLink...) {
        for link in links { link.stop() }
        box.stop()
        try? FileManager.default.removeItem(at: folder)
        for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// This Mac's link, as the app starts it: reaching its box (which has your phones), which
    /// reaches it back. `refusing`: a route the box doesn't take the first time (it's starting
    /// again just then). `starting`: started now (else the test starts it, after what comes before).
    private func link(on box: SettingsBox, refusing: String? = nil, times: Int = 1, starting: Bool = true) throws -> PhoneLink {
        try paired(box)
        let link = PhoneLink(file: file, identity: (mac, secret))
        let client = refusing.map { Self.flaky(box, refusing: $0, times: times) } ?? box.client
        link.box = { client }
        box.box.host.phoneLink = link
        if starting { start(link, on: box) }
        return link
    }

    private func start(_ link: PhoneLink, on box: SettingsBox) {
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
    }

    struct Kept: Decodable {
        struct Phone: Decodable { var name: String }
        var phones: [Phone]
        var pairing: Bool?
    }

    private func onTheBox(_ box: SettingsBox) async throws -> Kept {
        try await box.client.value(Kept.self, "GET", "kuvo/link/phones")
    }

    /// `box`, as the app reaches it, but `route`'s first `times` requests fail, as while the box
    /// restarts.
    private static func flaky(_ box: SettingsBox, refusing route: String, times: Int) -> BoxClient {
        let refused = OSAllocatedUnfairLock(initialState: 0)
        let base = URL(string: box.engine.url + "/")!
        return BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            guard request.path == route, refused.withLock({ $0 += 1; return $0 <= times }) else {
                return PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil)
            }
            return AsyncThrowingStream { $0.finish(throwing: URLError(.networkConnectionLost)) }
        })
    }

    /// Where a request waits until the test lets it go on.
    nonisolated final class Gate: Sendable {
        private let state = OSAllocatedUnfairLock<(reached: Bool, waiting: [CheckedContinuation<Void, Never>], open: Bool)>(initialState: (false, [], false))
        var reached: Bool { state.withLock { $0.reached } }
        func pass() async {
            await withCheckedContinuation { continuation in
                let now = state.withLock { state -> Bool in
                    state.reached = true
                    if state.open { return true }
                    state.waiting.append(continuation)
                    return false
                }
                TestPulse.beat()
                if now { continuation.resume() }
            }
        }
        func open() {
            for waiting in state.withLock({ state -> [CheckedContinuation<Void, Never>] in
                state.open = true
                defer { state.waiting = [] }
                return state.waiting
            }) { waiting.resume() }
        }
    }

    /// `box`, as the app reaches it, but the first POST to `route` has its answer held at `gate`
    /// once the box has made it (a slow answer).
    private static func gated(_ box: SettingsBox, route: String, gate: Gate) -> BoxClient {
        let base = URL(string: box.engine.url + "/")!
        let held = OSAllocatedUnfairLock(initialState: false)
        return BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            guard request.path == route, request.method == "POST", !held.withLock({ let was = $0; $0 = true; return was }) else {
                return PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil)
            }
            return AsyncThrowingStream { continuation in
                let task = Task {
                    do {
                        var parts: [LinkResponsePart] = []
                        for try await part in PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil) { parts.append(part) }
                        await gate.pass()
                        for part in parts { continuation.yield(part) }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                    }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        })
    }

    /// Once this Mac's box has been told and given its keys: its link tries
    /// the relay, which nobody answers here.
    private func linked(_ link: PhoneLink) async throws {
        // The box's own word on the relay, which the app hears only once it follows the box.
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
    }

    /// The phones the app's copy keeps (phone-link.json), as it reads them as it starts.
    private func keptHere() -> [String] {
        PhoneLink(file: file, identity: (mac, secret)).phones.map(\.name)
    }

    @Test func yourPhonesAreTheBoxsAndOneYouRemoveStaysGone() async throws {
        let box = try await SettingsBox(port: 47_943)
        let link = try link(on: box)
        defer { done(box, link) }
        try await linked(link)
        try await heard(link)
        #expect(link.phones.first { $0.name == "Mine" }?.added == Date(timeIntervalSinceReferenceDate: 700_000_000), "as paired, then")

        // Removed in Settings › Phone: the box takes it off, and the app's copy has it gone too.
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        try await until { link.phones.map(\.name) == ["Mine"] }
        await link.removalsTaken()
        #expect(try await onTheBox(box).phones.map(\.name) == ["Mine"])
        #expect(keptHere() == ["Mine"])
    }

    /// A phone removed while the box doesn't take it (restarting): gone from Settings › Phone at
    /// once, saying it can still reach this Mac for now, and taken off the box once it's back, so
    /// it isn't let in again.
    @Test func aPhoneRemovedWhileTheBoxIsAwayIsRemovedOnceItsBack() async throws {
        let box = try await SettingsBox(port: 47_949)
        // Away long enough for Settings › Phone to say so (it waits a moment first).
        let link = try link(on: box, refusing: "kuvo/phones/remove", times: PhoneLink.graceTries)
        defer { done(box, link) }
        try await linked(link)
        try await heard(link)
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        #expect(link.phones.map(\.name) == ["Mine"])
        try await until { link.removalProblem != nil }
        // Back: it takes it off.
        try await until { link.removalProblem == nil }
        struct Kept: Decodable { struct Phone: Decodable { var name: String }; var phones: [Phone] }
        #expect(try await box.client.value(Kept.self, "GET", "kuvo/link/phones").phones.map(\.name) == ["Mine"])
        #expect(link.phones.map(\.name) == ["Mine"])
        #expect(keptHere() == ["Mine"])
    }

    /// A phone removed as Kuvo Code starts, before this Mac's box has been told anything: that one
    /// stays out, and the others are all still there.
    @Test func aPhoneRemovedBeforeTheBoxIsReachedLeavesTheOthers() async throws {
        try copied()
        let box = try await SettingsBox(port: 47_954)
        let link = try link(on: box, starting: false)
        defer { done(box, link) }
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        await link.removalsTaken()
        start(link, on: box)
        try await linked(link)
        #expect(try await onTheBox(box).phones.map(\.name) == ["Mine"])
        try await until { link.phones.map(\.name) == ["Mine"] }
        #expect(keptHere() == ["Mine"])
    }

    /// A removal an earlier build kept that names no phone (the box refuses it) never holds the
    /// link up: your phones are still the box's, and the app hears them.
    @Test func aRemovalThatNamesNoPhoneDoesntHoldTheLinkUp() async throws {
        var kept = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        kept["toRemove"] = [["key": "not-a-key"]]
        try JSONSerialization.data(withJSONObject: kept).write(to: file)
        let box = try await SettingsBox(port: 47_957)
        let link = try link(on: box)
        defer { done(box, link) }
        try await linked(link)
        #expect(try await onTheBox(box).phones.map(\.name).sorted() == ["Lost", "Mine"])
        try await heard(link)
        #expect(link.removalProblem == nil)
    }

    /// A pairing code closed while the box was still making it is never shown, and ends on the box.
    @Test func aPairingClosedWhileItWasMadeIsntShownAndEnds() async throws {
        let box = try await SettingsBox(port: 47_958)
        let gate = Gate()
        try paired(box)
        let link = PhoneLink(file: file, identity: (mac, secret))
        let client = Self.gated(box, route: "kuvo/phones/pair", gate: gate)
        link.box = { client }
        box.box.host.phoneLink = link
        start(link, on: box)
        defer { done(box, link) }
        try await linked(link)
        let begun = Task { await link.beginPairing() }
        try await until { gate.reached }
        // Closed as the box makes it.
        link.endPairing()
        gate.open()
        await begun.value
        #expect(link.pairing == nil)
        await link.pairingEnded()
        #expect(try await onTheBox(box).pairing == false)
    }

    /// With neither the phone link nor machines, nothing is made for the link in your Keychain:
    /// told it's off, the box asks for no keys, and the app gives none.
    /// Pair (slow), close, Pair again: the first one's answer, come late, ends that one alone, and
    /// the new code stays, here and on the box.
    @Test func aLatePairingNeverEndsTheNextOne() async throws {
        let box = try await SettingsBox(port: 47_960)
        let gate = Gate()
        try paired(box)
        let link = PhoneLink(file: file, identity: (mac, secret))
        let client = Self.gated(box, route: "kuvo/phones/pair", gate: gate)
        link.box = { client }
        box.box.host.phoneLink = link
        start(link, on: box)
        defer { done(box, link) }
        try await linked(link)
        let first = Task { await link.beginPairing() }
        try await until { gate.reached }
        link.endPairing()
        await link.beginPairing()
        let shown = try #require(link.pairing)
        gate.open()
        await first.value
        await link.pairingEnded()
        #expect(link.pairing == shown)
        #expect(try await onTheBox(box).pairing == true)
    }

    @Test func withTheLinkOffNoKeysAreMade() async throws {
        UserDefaults.standard.set(false, forKey: "phoneLink")
        let box = try await SettingsBox(port: 47_959)
        let link = PhoneLink(file: file)
        let client = box.client
        link.box = { client }
        box.box.host.phoneLink = link
        defer { done(box, link) }
        start(link, on: box)
        link.machinesChanged()
        link.attend(["ses_a"])
        #expect(await link.boxIdentity() == nil)
        await link.saidToBox()
        var found: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: PhoneLink.keychainService,
                                    kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        #expect(Keychain.copyMatching(query, &found) == errSecItemNotFound)
    }

    /// The phone link turned off (or on) while the app is open: its box keeps it so (run/mac-link.json),
    /// for after a restart with the app closed.
    @Test func thePhoneLinkTurnedOffWhileTheAppIsOpenIsKeptOffForAfterARestart() async throws {
        let box = try await SettingsBox(port: 47_951)
        let link = try link(on: box)
        defer { done(box, link) }
        let kept = BoxProcess.run.appending(path: "mac-link.json")
        func phones() -> Bool? {
            ((try? JSONSerialization.jsonObject(with: Data(contentsOf: kept))) as? [String: Any])?["phones"] as? Bool
        }
        try await until { phones() == true }
        UserDefaults.standard.set(false, forKey: "phoneLink")
        try await until { phones() == false }
        UserDefaults.standard.set(true, forKey: "phoneLink")
        try await until { phones() == true }
    }

    /// Before this Mac's engine is up, a phone asking it hears it's starting, not a connection
    /// error: from this Mac's box, which passes a phone's engine requests on.
    @Test func beforeTheEngineIsUpAPhoneHearsItsStarting() async throws {
        let box = try await SettingsBox(port: 47_939)
        defer { box.stop() }
        // The app starting, its engine not up yet.
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        let endpoint = try #require(box.box.process.endpoint)
        var request = URLRequest(url: try #require(URL(string: "api/session", relativeTo: endpoint.url)))
        if let password = endpoint.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        let (body, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 503)
        #expect(String(decoding: body, as: UTF8.self).contains("engine is starting"))
    }

    @Test func settingsPhonesPairingLinkIsTheBoxsAsYourPhonesKnowThisMac() async throws {
        let box = try await SettingsBox(port: 47_944)
        let link = try link(on: box)
        defer { done(box, link) }
        try await linked(link)
        await link.beginPairing()
        let pairing = try #require(link.pairing, "\(link.pairingProblem ?? "")")
        #expect(pairing.key == mac.publicBytes, "this Mac's key, from your Keychain")
        #expect(pairing.host == secret.address)
        #expect(pairing.relay.absoluteString == "ws://127.0.0.1:9")
        link.endPairing()
        #expect(link.pairing == nil)

        // With the phone link off: none, and it says why where the link would be.
        UserDefaults.standard.removeObject(forKey: "phoneLink")
        link.machinesChanged()
        try await until { link.pairingProblem == nil && link.status == .off }
        await link.beginPairing()
        #expect(link.pairing == nil)
        #expect(link.pairingProblem == "The phone link is off on this Mac.")
    }

    @Test func whatAPhoneAsksOfTheMacsOwnRoutesComesFromTheAppAFollowedOneAsItComes() async throws {
        let box = try await SettingsBox(port: 47_945)
        let link = try link(on: box)
        defer { done(box, link) }
        // As this Mac's box asks its app (its host interface).
        let environment = try await box.box.host.start()
        let url = try #require(environment["KUVO_HOST_URL"]), password = try #require(environment["KUVO_HOST_PASSWORD"])
        // Reached for real, as the box reaches it (the tests' stand-in web answers the rest).
        StubWeb.letThrough(port: URL(string: url)?.port ?? 0)
        func asked(_ path: String) throws -> URLRequest {
            var request = URLRequest(url: URL(string: url + "/link/route")!)
            request.httpMethod = "POST"
            request.setValue("Bearer \(password)", forHTTPHeaderField: "Authorization")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["method": "GET", "path": path, "headers": [:], "body": "", "phone": mine.publicBytes.base64URL])
            return request
        }
        let (answer, response) = try await URLSession.shared.data(for: try asked("kuvo/mac"))
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect((try JSONSerialization.jsonObject(with: answer) as? [String: Any])?["keepsAwake"] is Bool)
        // Followed: its first line as it comes, without waiting for an end.
        let (lines, followed) = try await URLSession.shared.bytes(for: try asked("kuvo/asks/events"))
        #expect((followed as? HTTPURLResponse)?.statusCode == 200)
        var first: String?
        for try await line in lines.lines {
            first = line
            break
        }
        #expect(try JSONSerialization.jsonObject(with: Data(try #require(first).utf8)) is [String: Any])
        // Not for anyone without the box's password.
        var stranger = try asked("kuvo/mac")
        stranger.setValue("Bearer nope", forHTTPHeaderField: "Authorization")
        #expect((try await URLSession.shared.data(for: stranger).1 as? HTTPURLResponse)?.statusCode == 401)
    }
}
