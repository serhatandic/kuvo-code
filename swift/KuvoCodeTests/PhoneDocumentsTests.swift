import CryptoKit
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents"),
/// as the app hands them to this Mac's box, which keeps the rules (the bridge's tests' mac-docs and
/// two-boxes): your machines as Kuvo Code set them up, one you remove named so it lets this Mac go;
/// and a phone removed on a machine leaving this Mac too. The box is the real one, its relay one
/// nobody answers; only the machines are stand-ins: documents signed with keys of their own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PhoneDocumentsTests {
    let folder: URL
    var file: URL { folder.appending(path: "phone-link.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneDocuments/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        UserDefaults.standard.set(true, forKey: "phoneLink")
        UserDefaults.standard.set("ws://127.0.0.1:9", forKey: "phoneLink.relay")
    }

    /// A machine as this Mac keeps it, with the key it signs with.
    private struct Machine {
        let id: String
        let key = Documents.SigningKey()
        let x25519 = LinkKey()
        var sign: String { Documents.origin(of: key) }
        var host: [String: Any] {
            ["name": id, "address": Data(repeating: 7, count: 16).base64URL, "key": x25519.publicBytes.base64URL, "peers": true, "sign": sign]
        }
        func sign(_ kind: String, _ n: Int, _ body: [String: Any]) throws -> [String: Any] {
            Documents.sign(key, kind: kind, n: n, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys)).json
        }
    }

    /// As the app keeps them (phone-link.json): your `machines` as it set them up (`also`: more
    /// names for them).
    private func kept(machines: [Machine], also: [String: [String: Any]] = [:]) throws {
        let saved: [String: Any] = ["phones": [], "removed": [], "machines": Dictionary(uniqueKeysWithValues: machines.map { ($0.id, $0.host) }).merging(also) { $1 }]
        try JSONSerialization.data(withJSONObject: saved).write(to: file)
    }

    /// This Mac's link, as the app starts it, on a box of the test's own: once the box has its
    /// machines, and tries the relay.
    private func started(on box: SettingsBox) async throws -> PhoneLink {
        let link = PhoneLink(file: file, identity: (LinkKey(), RelaySecret()), signing: signing)
        let client = box.client
        link.box = { client }
        // It has machines, as the app says: this Mac meets them at the relay.
        link.hasMachines = { true }
        box.box.host.phoneLink = link
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
        return link
    }

    let signing = Documents.SigningKey()

    private func done(_ box: SettingsBox, _ link: PhoneLink) {
        link.stop()
        box.stop()
        try? FileManager.default.removeItem(at: folder)
        for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// This Mac's own documents as setting a machine up gives them, read.
    private func own(_ box: SettingsBox) async throws -> [String: Documents.Document] {
        struct Given: Decodable { var macSign: String; var docs: [Documents.Envelope] }
        let given = try await box.client.value(Given.self, "GET", "kuvo/link/setup")
        #expect(given.macSign == Documents.origin(of: signing), "signed with this Mac's key, from your Keychain")
        return Dictionary(given.docs.compactMap(Documents.read).filter { $0.origin == given.macSign }.map { ($0.kind, $0) }) { first, _ in first }
    }

    @Test func yourMachinesAreTheBoxsAndOneYouRemoveIsToldThisMacLetItGo() async throws {
        let lab = Machine(id: "lab.invalid"), shed = Machine(id: "shed.invalid")
        try kept(machines: [lab, shed])
        let box = try await SettingsBox(port: 47_962)
        let link = try await started(on: box)
        defer { done(box, link) }
        let peers = { try await own(box)["peers"]?.object ?? [:] }
        let boxes = try #require(try await peers()["boxes"] as? [[String: Any]])
        #expect(boxes.compactMap { $0["id"] as? String }.sorted() == ["lab.invalid", "shed.invalid"])
        #expect(boxes.first { $0["id"] as? String == "lab.invalid" }?["sign"] as? String == lab.sign)
        link.forget(machine: shed.id)
        await link.saidToBox()
        let after = try await peers()
        #expect((after["boxes"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["lab.invalid"])
        #expect(after["left"] as? [String] == [shed.x25519.publicBytes.base64URL])
    }

    @Test func oneComputerUnderTwoNamesStaysWhenOneNameIsForgotten() async throws {
        let lab = Machine(id: "lab.invalid")
        try kept(machines: [lab], also: ["lab-alias.invalid": lab.host])
        let box = try await SettingsBox(port: 47_963)
        let link = try await started(on: box)
        defer { done(box, link) }
        // Folded into the other (Settings › Machines: two names for one computer).
        link.forget(machine: "lab-alias.invalid")
        await link.saidToBox()
        let peers = try await own(box)["peers"]?.object ?? [:]
        #expect((peers["boxes"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["lab.invalid"])
        #expect(peers["left"] as? [String] == [], "still one of this Mac's, so not told to let it go")
    }

    /// Removed on a machine (its phones document, as setting it up brings it, or its mail): gone
    /// from this Mac's box, and here, after a restart too.
    @Test func aPhoneRemovedOnAMachineLeavesThisMacToo() async throws {
        let lab = Machine(id: "lab.invalid")
        let lost = Data(repeating: 1, count: 32).base64URL, keep = Data(repeating: 2, count: 32).base64URL
        try kept(machines: [lab])
        let box = try await SettingsBox(port: 47_965)
        try box.box.paired([(lost, "iPhone", "p1"), (keep, "iPhone", "p2")])
        let link = try await started(on: box)
        defer { done(box, link) }
        let from = lab.x25519.publicBytes.base64URL
        let given = { (doc: [String: Any]) throws -> Data in try JSONSerialization.data(withJSONObject: ["from": from, "docs": ["give": [doc]]]) }
        // Signed by another key, as if by the machine, removing the one that stays: nothing.
        let forged = try given(Documents.sign(Documents.SigningKey(), kind: "phones", n: 1, body: Data(#"{"phones":[],"removed":[{"key":"\#(keep)","pairing":"p2"}]}"#.utf8)).json)
        _ = try await box.client.send("POST", "kuvo/link/docs", body: forged)
        // The machine's own: the lost phone removed itself there.
        let own = try given(try lab.sign("phones", 1, ["phones": [], "removed": [["key": lost, "pairing": "p1"]]]))
        _ = try await box.client.send("POST", "kuvo/link/docs", body: own)
        try await until { link.phones.map(\.key) == [keep] }
        #expect(link.paired.removed.contains(.init(key: lost, pairing: "p1")))
        #expect(!link.paired.removed.contains(.init(key: keep, pairing: "p2")), "the forged one changed nothing")
        #expect(PhoneLink(file: file).phones.map(\.key) == [keep], "kept so after a restart")
    }

    /// The letters an earlier Kuvo Code delivered itself go to this Mac's box as the app starts,
    /// before its link meets your other computers (a letter sent again isn't delivered twice), and
    /// so do the messages it kept for a machine that was away, once that machine is set up for
    /// them: wired as the app wires them, before its machines start.
    @Test func lettersAnEarlierVersionDeliveredGoToTheBoxBeforeItsLinkMeetsAnyone() async throws {
        let seen = AgentMail.seenFile
        try FileManager.default.createDirectory(at: seen.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["ltr_before1": (Date.now.timeIntervalSince1970 * 1000).rounded()]).write(to: seen)
        let waiting = AgentMail.waitingFile
        try JSONEncoder().encode([AgentMail.Waiting(from: "ses_here", name: "Here", to: "ses_there", machine: "gone.invalid", text: "Hi")]).write(to: waiting)
        let box = try await SettingsBox(port: 47_976)
        let app = AppModel()
        app.wirePhoneLink()
        let link = app.phoneLink
        let client = box.client
        link.box = { client }
        link.hasMachines = { true }
        box.box.host.phoneLink = link
        defer {
            link.stop()
            box.stop()
            try? FileManager.default.removeItem(at: seen)
            try? FileManager.default.removeItem(at: waiting)
            try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "phone-link.json"))
            _ = Keychain.delete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: PhoneLink.keychainService])
            for key in ["phoneLink", "phoneLink.relay"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        link.start(endpoint: ServerEndpoint(url: URL(string: box.engine.url)!, password: "test"))
        // Its link up, trying the relay: what was kept went first.
        try await until { if case .failed(let reason) = link.status { reason.contains("relay") } else { false } }
        #expect(!FileManager.default.fileExists(atPath: seen.path), "handed to the box")
        // Its machine isn't set up for your other computers (yet): it stays, for a later start.
        #expect(JSONFile.read([AgentMail.Waiting].self, from: waiting) == [AgentMail.Waiting(from: "ses_here", name: "Here", to: "ses_there", machine: "gone.invalid", text: "Hi")])
    }
}
