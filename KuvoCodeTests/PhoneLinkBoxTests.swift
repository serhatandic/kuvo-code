import CryptoKit
import Foundation
import KuvoLink
import os
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's link to your phones is its box's (KuvoLink's PROTOCOL.md, "This Mac's box: the
/// relay"), and the app is a client of it: the phones an older Kuvo Code paired come to the box,
/// and stay where that version reads them, so going back to it and forward again loses none;
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
        UserDefaults.standard.removeObject(forKey: "phoneLink.written")
        // As an older Kuvo Code kept them: two phones, one paired before pairings had an id.
        let phones = [(mine, "Mine", ""), (lost, "Lost", "p-lost")].map {
            #"{"key":"\#($0.0.publicBytes.base64URL)","name":"\#($0.1)","added":700000000,"pairing":"\#($0.2)"}"#
        }
        try Data(#"{"phones":[\#(phones.joined(separator: ","))],"removed":[],"machines":{}}"#.utf8).write(to: file)
    }

    private func done(_ box: SettingsBox, _ links: PhoneLink...) {
        for link in links { link.stop() }
        box.stop()
        try? FileManager.default.removeItem(at: folder)
        for key in ["phoneLink", "phoneLink.relay", "phoneLink.written"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// This Mac's link, as the app starts it: reaching its box, which reaches it back. `refusing`:
    /// a route the box doesn't take the first time (it's starting again just then).
    /// `starting`: started now (else the test starts it, after what comes before).
    private func link(on box: SettingsBox, refusing: String? = nil, starting: Bool = true) -> PhoneLink {
        let link = PhoneLink(file: file, identity: (mac, secret))
        let client = refusing.map { Self.flaky(box, refusing: $0) } ?? box.client
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

    /// `box`, as the app reaches it, but `route`'s first request fails, as when the box restarts
    /// as it's asked.
    private static func flaky(_ box: SettingsBox, refusing route: String) -> BoxClient {
        let refused = OSAllocatedUnfairLock(initialState: false)
        let base = URL(string: box.engine.url + "/")!
        return BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            guard request.path == route, !refused.withLock({ let was = $0; $0 = true; return was }) else {
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

    /// `box`, as the app reaches it, but a POST to `route` waits at `gate` first.
    private static func gated(_ box: SettingsBox, route: String, gate: Gate) -> BoxClient {
        let base = URL(string: box.engine.url + "/")!
        return BoxClient(box: BoxClient.mac, transport: LocalBox { request in
            guard request.path == route, request.method == "POST" else {
                return PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil)
            }
            return AsyncThrowingStream { continuation in
                let task = Task {
                    await gate.pass()
                    do {
                        for try await part in PhoneLink.respond(to: request, link: nil, engine: base, password: "test", agents: nil) { continuation.yield(part) }
                        continuation.finish()
                    } catch {
                        continuation.finish(throwing: error)
                    }
                }
                continuation.onTermination = { _ in task.cancel() }
            }
        })
    }

    /// Once this Mac's box has been told, given its keys and taken your phones: its link tries
    /// the relay, which nobody answers here.
    private func linked(_ link: PhoneLink) async throws {
        // The box's own word on the relay, which the app hears only once it follows the box.
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
    }

    /// The phones as an older Kuvo Code reads them from phone-link.json.
    private func olderKeeps() throws -> [String] {
        struct Saved: Decodable { var phones: [PairedPhones.Phone]; var removed: [PairedPhones.Removal]? }
        return try JSONDecoder().decode(Saved.self, from: Data(contentsOf: file)).phones.map(\.name)
    }

    @Test func yourPhonesFromBeforeComeToTheBoxAndStayWhereAnOlderVersionReadsThem() async throws {
        let box = try await SettingsBox(port: 47_943)
        let link = link(on: box)
        defer { done(box, link) }
        try await linked(link)
        struct Kept: Decodable { struct Phone: Decodable { var name: String }; var phones: [Phone] }
        let kept = try await box.client.value(Kept.self, "GET", "kuvo/link/phones")
        #expect(kept.phones.map(\.name).sorted() == ["Lost", "Mine"], "the box lets them in")
        #expect(link.phones.first { $0.name == "Mine" }?.added == Date(timeIntervalSinceReferenceDate: 700_000_000), "as paired, then")

        // Removed in Settings › Phone: the box takes it off, and an older version reads it gone too.
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        try await until { link.phones.map(\.name) == ["Mine"] }
        #expect(try olderKeeps() == ["Mine"])

        // Back on an older version meanwhile, which paired another: it comes too, the one removed
        // stays out.
        link.stop()
        let new = LinkKey()
        var older = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        var phones = older["phones"] as! [[String: Any]]
        phones.append(["key": new.publicBytes.base64URL, "name": "New", "added": 760_000_000, "pairing": "p-new"])
        phones.append(["key": lost.publicBytes.base64URL, "name": "Lost", "added": 700_000_000, "pairing": "p-lost"])
        older["phones"] = phones
        try JSONSerialization.data(withJSONObject: older).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: Date.now.addingTimeInterval(60)], ofItemAtPath: file.path)
        let again = self.link(on: box)
        defer { again.stop() }
        try await until { again.phones.map(\.name).sorted() == ["Mine", "New"] }
    }

    /// The box restarting just as the app first hands it your phones: they're handed again, and
    /// none is lost, here or where an older version reads them.
    @Test func yourPhonesSurviveTheBoxNotTakingThemTheFirstTime() async throws {
        let box = try await SettingsBox(port: 47_948)
        let link = link(on: box, refusing: "kuvo/link/phones/take")
        defer { done(box, link) }
        try await linked(link)
        struct Kept: Decodable { struct Phone: Decodable { var name: String }; var phones: [Phone] }
        #expect(try await box.client.value(Kept.self, "GET", "kuvo/link/phones").phones.map(\.name).sorted() == ["Lost", "Mine"])
        #expect(link.phones.map(\.name).sorted() == ["Lost", "Mine"])
        #expect(try olderKeeps().sorted() == ["Lost", "Mine"])
    }

    /// A phone removed while the box doesn't take it (restarting): gone from Settings › Phone at
    /// once, saying it can still reach this Mac for now, and taken off the box once it's back, so
    /// it isn't let in again.
    @Test func aPhoneRemovedWhileTheBoxIsAwayIsRemovedOnceItsBack() async throws {
        let box = try await SettingsBox(port: 47_949)
        let link = link(on: box, refusing: "kuvo/phones/remove")
        defer { done(box, link) }
        try await linked(link)
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        #expect(link.phones.map(\.name) == ["Mine"])
        try await until { link.removalProblem != nil }
        // Back: it takes it off.
        try await until { link.removalProblem == nil }
        struct Kept: Decodable { struct Phone: Decodable { var name: String }; var phones: [Phone] }
        #expect(try await box.client.value(Kept.self, "GET", "kuvo/link/phones").phones.map(\.name) == ["Mine"])
        #expect(link.phones.map(\.name) == ["Mine"])
        #expect(try olderKeeps() == ["Mine"])
    }

    /// A phone removed as Kuvo Code starts, before this Mac's box has the phones an older version
    /// kept (a machine's document, say): that one stays out, and the others are all still there.
    @Test func aPhoneRemovedBeforeTheBoxHasYourPhonesLeavesTheOthers() async throws {
        let box = try await SettingsBox(port: 47_954)
        let link = link(on: box, starting: false)
        defer { done(box, link) }
        link.remove(try #require(link.phones.first { $0.name == "Lost" }))
        await link.removalsTaken()
        start(link, on: box)
        try await linked(link)
        #expect(try await onTheBox(box).phones.map(\.name) == ["Mine"])
        try await until { link.phones.map(\.name) == ["Mine"] }
        #expect(try olderKeeps() == ["Mine"])
    }

    /// A removal an earlier build kept that names no phone (the box refuses it) never holds the
    /// link up: your phones still come to the box.
    @Test func aRemovalThatNamesNoPhoneDoesntHoldTheLinkUp() async throws {
        var kept = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
        kept["toRemove"] = [["key": "not-a-key"]]
        try JSONSerialization.data(withJSONObject: kept).write(to: file)
        let box = try await SettingsBox(port: 47_957)
        let link = link(on: box)
        defer { done(box, link) }
        try await linked(link)
        #expect(try await onTheBox(box).phones.map(\.name).sorted() == ["Lost", "Mine"])
        #expect(link.removalProblem == nil)
    }

    /// A pairing code closed while the box was still making it is never shown, and ends on the box.
    @Test func aPairingClosedWhileItWasMadeIsntShownAndEnds() async throws {
        let box = try await SettingsBox(port: 47_958)
        let gate = Gate()
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
        #expect(link.boxIdentity() == nil)
        await link.saidToBox()
        var found: CFTypeRef?
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: PhoneLink.keychainService,
                                    kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        #expect(Keychain.copyMatching(query, &found) == errSecItemNotFound)
    }

    /// Before this Mac's engine is up, a phone asking it hears it's starting, not a connection
    /// error.
    @Test func beforeTheEngineIsUpAPhoneHearsItsStarting() async throws {
        let link = PhoneLink(file: file, identity: (mac, secret))
        var status = 0
        var body = Data()
        for try await part in link.answerForBox(LinkRequest(method: "GET", path: "api/session", headers: [:], body: Data()), phone: mine.publicBytes) {
            switch part {
            case .head(let code, _): status = code
            case .body(let data): body += data
            }
        }
        #expect(status == 503)
        #expect(String(decoding: body, as: UTF8.self).contains("starting"))
    }

    @Test func settingsPhonesPairingLinkIsTheBoxsAsYourPhonesKnowThisMac() async throws {
        let box = try await SettingsBox(port: 47_944)
        let link = link(on: box)
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
        let link = link(on: box)
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
