import CryptoKit
import Foundation
import KuvoLink
import Testing
@testable import KuvoCode

/// A phone removes another from this Mac, a lost one say, as you would in Settings › Phone: the
/// lost one can't come in again or change anything, the removal is kept (and goes to your
/// machines with the phones you've paired), and nobody removes the Mac. Phones paired before
/// pairings had an id keep none, as your machines have them.
@MainActor
@Suite(.serialized) struct PhoneRemovalTests {
    let folder: URL
    let mac = LinkKey(), mine = LinkKey(), lost = LinkKey()
    var file: URL { folder.appending(path: "phone-link.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneRemoval/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // As an older Kuvo Code kept it: no pairings, no removals.
        let phones = [(mine, "Mine"), (lost, "Lost")].map { #"{"key":"\#($0.0.publicBytes.base64URL)","name":"\#($0.1)","added":0}"# }
        try Data(#"{"phones":[\#(phones.joined(separator: ","))],"machines":{}}"#.utf8).write(to: file)
    }

    private func link() -> PhoneLink { PhoneLink(file: file, identity: (mac, RelaySecret())) }

    private func ask(_ link: PhoneLink, _ path: String, as phone: LinkKey, body: String? = nil) async throws -> (status: Int, json: [String: Any]?) {
        let request = LinkRequest(method: body == nil ? "GET" : "POST", path: path, headers: ["content-type": "application/json"], body: Data((body ?? "").utf8))
        var status = 0
        var data = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil, asking: phone.publicBytes) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): data += chunk
            }
        }
        return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func deleting(_ link: PhoneLink, _ path: String, as phone: LinkKey) async throws -> Int {
        let request = LinkRequest(method: "DELETE", path: path, headers: [:], body: Data())
        var status = 0
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil, asking: phone.publicBytes) {
            if case .head(let code, _) = part { status = code }
        }
        return status
    }

    private func removal(_ key: LinkKey, pairing: String? = nil) -> String {
        #"{"phones":[{"key":"\#(key.publicBytes.base64URL)"\#(pairing.map { #","pairing":"\#($0)""# } ?? "")}]}"#
    }

    /// A phone asks for a link for another phone, only while the link is on: one of its own, apart
    /// from the one Settings › Phone shows, so opening and closing that page doesn't end it; good
    /// once, and ended when the phone's sheet closes.
    @Test func aPhoneGetsALinkForAnotherPhone() async throws {
        defer {
            try? FileManager.default.removeItem(at: folder)
            UserDefaults.standard.removeObject(forKey: "phoneLink")
        }
        let link = link()
        UserDefaults.standard.removeObject(forKey: "phoneLink")
        #expect(try await ask(link, "kuvo/phones/pair", as: mine, body: "{}").status == 409, "not while the link is off")
        UserDefaults.standard.set(true, forKey: "phoneLink")
        let address = try #require(LinkAddress(bytes: Data(repeating: 7, count: LinkAddress.length)))
        // Asked for, then its sheet closed: it lets nobody in.
        let closed = try await ask(link, "kuvo/phones/pair", as: mine, body: "{}")
        let ended = try #require((closed.json?["link"] as? String).flatMap(URL.init(string:)).flatMap(PairingLink.init))
        #expect(try await deleting(link, "kuvo/phones/pair", as: mine) == 200)
        #expect(!link.authorize(LinkKey().publicBytes, address, PhoneHello(name: "Too Late", app: "1", pair: ended.token.base64URL)))
        #expect(try await deleting(link, "kuvo/phones/pair", as: mine) == 200, "with none showing too")

        let answer = try await ask(link, "kuvo/phones/pair", as: mine, body: "{}")
        #expect(answer.status == 200)
        let given = try #require((answer.json?["link"] as? String).flatMap(URL.init(string:)).flatMap(PairingLink.init))
        #expect(given.key == mac.publicBytes, "this Mac's")
        #expect(answer.json?["ends"] is Double)
        link.beginPairing()
        link.endPairing()
        let hello = PhoneHello(name: "New iPhone", app: "1", pair: given.token.base64URL)
        #expect(link.authorize(LinkKey().publicBytes, address, hello), "in, with Settings › Phone opened and closed meanwhile")
        #expect(link.phones.contains { $0.name == "New iPhone" })
        #expect(!link.authorize(LinkKey().publicBytes, address, hello), "once")
    }

    @Test func aPhoneRemovesALostOneForGood() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let link = link()
        #expect(link.phones.count == 2 && link.phones.allSatisfy { $0.pairing.isEmpty }, "as your machines have them")

        let listed = try #require(try await ask(link, "kuvo/phones", as: mine).json?["phones"] as? [[String: Any]])
        #expect(listed.map { $0["name"] as? String } == ["Mine", "Lost"])
        #expect(listed.map { $0["you"] as? Bool } == [true, false], "it knows itself")
        let pairing = try #require(listed[1]["pairing"] as? String)
        #expect(try await ask(link, "kuvo/phones/remove", as: mine, body: #"{"phones":[{"key":"not a phone"}]}"#).status == 400)

        #expect(try await ask(link, "kuvo/phones/remove", as: mine, body: removal(mac)).status == 400, "never the Mac")
        #expect(try await ask(link, "kuvo/phones/remove", as: mine, body: removal(lost, pairing: pairing)).status == 200)
        #expect(link.phones.map(\.name) == ["Mine"])
        #expect(try await ask(link, "kuvo/phones/remove", as: lost, body: removal(mine)).status == 400, "a removed phone changes nothing")
        #expect(link.phones.map(\.name) == ["Mine"])

        // Kept, for a restart and for your machines, which keep it out too.
        let again = self.link()
        #expect(again.phones.map(\.name) == ["Mine"])
        #expect(again.paired.removed == [.init(key: lost.publicBytes.base64URL, pairing: pairing)])
    }

    @Test func aPhoneRemovesItself() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let link = link()
        #expect(try await ask(link, "kuvo/phones/remove", as: mine, body: removal(mine)).status == 200)
        #expect(link.phones.map(\.name) == ["Lost"])
    }
}
