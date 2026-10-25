import CryptoKit
import Foundation
import KuvoLink
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

    /// This Mac's link, as the app starts it: reaching its box, which reaches it back.
    private func link(on box: SettingsBox) -> PhoneLink {
        let link = PhoneLink(file: file, identity: (mac, secret))
        let client = box.client
        link.box = { client }
        box.box.host.phoneLink = link
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        return link
    }

    /// Once this Mac's box has been told, given its keys and taken your phones: its link tries
    /// the relay, which nobody answers here.
    private func linked(_ link: PhoneLink) async throws {
        try await until { if case .failed = link.status { true } else { false } }
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
