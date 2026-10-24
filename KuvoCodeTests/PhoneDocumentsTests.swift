import CryptoKit
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// This Mac's side of the documents your computers copy between them (PROTOCOL.md, "Documents"),
/// as its real PhoneLink keeps them: a phone removed on a machine leaves this Mac too; a machine's
/// view of your personalities comes in, an older or forged one changes nothing; a machine you
/// remove is named in what this Mac gives the others, so it lets this Mac go; a Mac that lost count
/// of its own moves past what a machine has; and your personalities refuse a change past what a
/// document holds. Only the machine is a stand-in: documents signed with a key of its own.
@MainActor
@Suite(.serialized) struct PhoneDocumentsTests {
    init() { TestEnvironment.prepare() }

    /// A machine as this Mac keeps it, with the key it signs with.
    private struct Machine {
        let id: String
        let key = Documents.SigningKey()
        let x25519 = LinkKey()
        var host: [String: Any] {
            ["name": id, "address": Data(repeating: 7, count: 16).base64URL, "key": x25519.publicBytes.base64URL, "peers": true, "sign": Documents.origin(of: key)]
        }
        func sign(_ kind: String, _ n: Int, _ body: [String: Any]) throws -> [String: Any] {
            Documents.sign(key, kind: kind, n: n, body: try JSONSerialization.data(withJSONObject: body, options: .sortedKeys)).json
        }
    }

    /// A PhoneLink with a file of its own: `phones` paired here, `machines` set up.
    private func link(phones: [[String: Any]] = [], machines: [Machine]) throws -> (PhoneLink, URL) {
        let file = AppInfo.testRoot.appending(path: "PhoneDocuments/\(UUID().uuidString).json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let saved: [String: Any] = ["phones": phones, "removed": [], "machines": Dictionary(uniqueKeysWithValues: machines.map { ($0.id, $0.host) })]
        try JSONSerialization.data(withJSONObject: saved).write(to: file)
        return (PhoneLink(file: file, identity: (LinkKey(), RelaySecret())), file)
    }

    private func body(_ envelope: Documents.Envelope) -> [String: Any] { Documents.read(envelope)?.object ?? [:] }

    @Test func aPhoneRemovedOnAMachineLeavesThisMacToo() throws {
        let lab = Machine(id: "lab.invalid")
        let lost = Data(repeating: 1, count: 32).base64URL, kept = Data(repeating: 2, count: 32).base64URL
        let phone = { (key: String, pairing: String) -> [String: Any] in ["key": key, "name": "iPhone", "added": 0, "pairing": pairing] }
        let (link, file) = try link(phones: [phone(lost, "p1"), phone(kept, "p2")], machines: [lab])
        defer { try? FileManager.default.removeItem(at: file) }
        // Signed by another key, as if by the machine: nothing.
        let forged = Documents.sign(Documents.SigningKey(), kind: "phones", n: 1, body: Data(#"{"phones":[],"removed":[{"key":"\#(lost)","pairing":"p1"}]}"#.utf8))
        link.takeDocuments(["give": [forged.json]], from: lab.id)
        #expect(link.phones.map(\.key).sorted() == [lost, kept].sorted())
        // The machine's own: the lost phone removed itself there.
        link.takeDocuments(["give": [try lab.sign("phones", 1, ["phones": [], "removed": [["key": lost, "pairing": "p1"]]])]], from: lab.id)
        #expect(link.phones.map(\.key) == [kept])
        #expect(link.paired.removed.contains(.init(key: lost, pairing: "p1")))
        // Kept so after a restart.
        #expect(PhoneLink(file: file).phones.map(\.key) == [kept])
    }

    @Test func aMachinesViewOfYourPersonalitiesComesInAndAnOlderOneDoesnt() throws {
        let lab = Machine(id: "lab.invalid")
        let (link, file) = try link(machines: [lab])
        defer { try? FileManager.default.removeItem(at: file) }
        var told: Set<String> = []
        link.tookPersonalities = { told.formUnion($0) }
        let id = "custom.lab-\(UUID().uuidString.lowercased())"
        defer { if let kept = Personalities.shared.personality(id) { Personalities.shared.delete(kept) } }
        let made = ["id": id, "name": "Calm", "description": "Made on the machine.", "symbol": "person.crop.circle", "updated": 1_760_000_000_000] as [String: Any]
        link.takeDocuments(["give": [try lab.sign("personalities", 5, ["personalities": [made], "removed": []])]], from: lab.id)
        #expect(Personalities.shared.personality(id)?.description == "Made on the machine.")
        #expect(told == [id])
        // An older view of the machine's, though it counts the change higher: nothing.
        var older = made
        older["description"] = "Older."
        older["updated"] = 1_760_000_000_900
        link.takeDocuments(["give": [try lab.sign("personalities", 4, ["personalities": [older], "removed": []])]], from: lab.id)
        #expect(Personalities.shared.personality(id)?.description == "Made on the machine.")
        // Removed there: removed here, whatever this Mac changed meanwhile.
        try Personalities.shared.update(Personality(id: id, name: "Calm", description: "Changed here.", symbol: "person.crop.circle"))
        link.takeDocuments(["give": [try lab.sign("personalities", 6, ["personalities": [], "removed": [["id": id, "removed": 1_760_000_000_001]]])]], from: lab.id)
        #expect(Personalities.shared.personality(id) == nil)
    }

    @Test func aMachineYouRemoveIsToldThisMacLetItGo() throws {
        let lab = Machine(id: "lab.invalid"), shed = Machine(id: "shed.invalid")
        let (link, file) = try link(machines: [lab, shed])
        defer { try? FileManager.default.removeItem(at: file) }
        let peers = { () throws -> [String: Any] in
            self.body(try #require(link.allDocuments().first { Documents.read($0)?.kind == "peers" }))
        }
        let boxes = try #require(try peers()["boxes"] as? [[String: Any]])
        #expect(boxes.compactMap { $0["id"] as? String }.sorted() == ["lab.invalid", "shed.invalid"])
        #expect(boxes.first { $0["id"] as? String == "lab.invalid" }?["sign"] as? String == Documents.origin(of: lab.key))
        link.forget(machine: shed.id)
        let after = try peers()
        #expect((after["boxes"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["lab.invalid"])
        #expect(after["left"] as? [String] == [shed.x25519.publicBytes.base64URL])
    }

    @Test func aMacThatLostCountMovesPastWhatAMachineHas() throws {
        let lab = Machine(id: "lab.invalid")
        let (link, file) = try link(machines: [lab])
        defer { try? FileManager.default.removeItem(at: file) }
        let first = try #require(link.allDocuments().compactMap(Documents.read).first { $0.kind == "peers" })
        // The machine has this Mac's peers document at version 7 (from before this Mac's file was
        // put back from an older copy, say).
        link.takeDocuments(["have": [[first.origin, "peers", 7, "x"]]], from: lab.id)
        let now = try #require(link.allDocuments().compactMap(Documents.read).first { $0.kind == "peers" })
        #expect(now.n == 8)
    }

    @Test func yourPersonalitiesRefuseAChangePastWhatADocumentHolds() throws {
        let folder = AppInfo.testRoot.appending(path: "Personalities/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = Personalities(folder: folder)
        let words = String(repeating: "Words. ", count: 285)
        var refused: Error?
        for i in 0..<400 where refused == nil {
            do { _ = try store.add(name: "P\(i)", description: words) } catch { refused = error }
        }
        #expect(refused?.localizedDescription == "There’s no room for more in your personalities. Shorten or remove one, then try again.")
        let count = store.custom.count
        #expect(count > 100)
        #expect(Personalities(folder: folder).custom.count == count, "nothing kept of the one refused")
    }
}
