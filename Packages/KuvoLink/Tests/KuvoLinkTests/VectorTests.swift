import Foundation
import Testing
@testable import KuvoLink

/// `Vectors/link.json`, which the JavaScript bridge checks against too.
@Suite struct VectorTests {
    let vectors = try! Vectors.load("link.json")

    private func list(_ key: String) -> [[String: Any]] { vectors[key] as! [[String: Any]] }
    private func bytes(_ item: [String: Any], _ key: String) -> Data { Data(hex: item[key] as! String)! }

    @Test func addresses() {
        for item in list("addresses") {
            #expect(RelaySecret(bytes: bytes(item, "secret"))!.address.bytes == bytes(item, "address"))
        }
    }

    @Test func relayMessages() throws {
        for item in list("relay") {
            let data = bytes(item, "bytes")
            switch item["name"] as! String {
            case "hello":
                #expect(RelayMessage.hello(RelaySecret(bytes: data.dropFirst())!).data == data)
            case "send":
                let to = LinkAddress(bytes: bytes(item, "to"))!
                #expect(RelayMessage.send(to: to, payload: bytes(item, "payload")).data == data)
            case "welcome":
                #expect(try RelayMessage(fromRelay: data) == .welcome(LinkAddress(bytes: bytes(item, "address"))!))
            case "deliver":
                #expect(try RelayMessage(fromRelay: data) == .deliver(from: LinkAddress(bytes: bytes(item, "address"))!, payload: bytes(item, "payload")))
            case "unreachable":
                #expect(try RelayMessage(fromRelay: data) == .unreachable(LinkAddress(bytes: bytes(item, "address"))!))
            case "pushed":
                #expect(try RelayMessage(fromRelay: data) == .pushed(to: LinkAddress(bytes: bytes(item, "address"))!, status: .notAllowed))
            case "gone":
                let reads: RelayMessage.Gone = item["reads"] as! String == "replaced" ? .replaced : .left
                let gone = RelayMessage.gone(LinkAddress(bytes: bytes(item, "address"))!, reads)
                #expect(try RelayMessage(fromRelay: data) == gone)
                if Int(reads.rawValue) == item["reason"] as! Int { #expect(gone.data == data) }
            default:
                Issue.record("Unknown vector \(item["name"]!)")
            }
        }
    }

    @Test func frames() throws {
        for item in list("frames") {
            let frame = LinkFrame(LinkFrame.Kind(rawValue: UInt8(item["kind"] as! Int))!, session: UInt32(item["session"] as! Int), body: bytes(item, "body"))
            #expect(frame.data == bytes(item, "bytes"))
            #expect(try LinkFrame(bytes(item, "bytes")) == frame)
        }
    }

    /// What may be sent, and what's sent for it (`forwarded`): the path written one way only.
    @Test func routes() {
        for item in list("routes") {
            let path = item["path"] as! String
            #expect(EngineRoutes.allows(path, method: item["method"] as? String ?? "GET") == item["allowed"] as! Bool, "\(path) \(item["method"] ?? "GET")")
            if let forwarded = item["forwarded"] as? String { #expect(EngineRoutes.canonical(path) == forwarded, "\(path)") }
        }
    }

    @Test func agentRoutes() {
        for item in list("agentRoutes") {
            let path = item["path"] as! String
            #expect(EngineRoutes.allowsAgents(path, method: item["method"] as? String ?? "GET") == item["allowed"] as! Bool, "\(path) \(item["method"] ?? "GET")")
            if let forwarded = item["forwarded"] as? String { #expect(EngineRoutes.canonical(path) == forwarded, "\(path)") }
        }
    }

    @Test func signInReturns() {
        for item in list("signInReturns") {
            #expect(EngineRoutes.signInReturn(item["url"] as! String)?.absoluteString == item["loads"] as? String, "\(item["url"]!)")
        }
    }

    /// The Mac's side of the rules: pairing here and removing, up to the first step that's a
    /// machine's alone (taking a Mac's phones document).
    @Test func pairedPhones() {
        for book in list("phoneBooks") {
            let name = book["name"] as! String
            let macs = Set(book["macs"] as! [String])
            var phones = PairedPhones(phones: (book["phones"] as! [[String: Any]]).map {
                .init(key: $0["key"] as! String, name: "", added: .now, pairing: $0["pairing"] as! String)
            })
            for step in book["steps"] as! [[String: Any]] {
                var ok = true
                switch step["op"] as! String {
                case "pair": phones.pair(.init(key: step["key"] as! String, name: "", added: .now, pairing: step["pairing"] as! String))
                case "remove":
                    let entries = (step["phones"] as! [[String: Any]]).map { PairedPhones.Entry(key: $0["key"] as! String, pairing: $0["pairing"] as? String) }
                    ok = phones.remove(entries, by: step["by"] as! String, macs: macs)
                default: break
                }
                guard step["op"] as! String != "macDoc" else { break }
                #expect(ok == step["ok"] as! Bool, "\(name): \(step["op"]!)")
                let after = step["after"] as! [String: Any]
                let expected = (after["phones"] as! [[String: Any]]).map { "\($0["key"]!)/\($0["pairing"]!)" }
                #expect(phones.phones.map { "\($0.key)/\($0.pairing)" }.sorted() == expected, "\(name): \(step["op"]!)")
                let removed = (after["removed"] as! [[String: Any]]).map { "\($0["key"]!)/\($0["pairing"]!)" }
                #expect(phones.removed.map { "\($0.key)/\($0.pairing)" }.sorted() == removed, "\(name): \(step["op"]!)")
            }
        }
    }

    @Test func sockets() {
        for item in list("sockets") {
            #expect(EngineRoutes.allowsSocket(item["path"] as! String) == item["allowed"] as! Bool, "\(item["path"]!)")
            if let forwarded = item["forwarded"] as? String { #expect(EngineRoutes.canonical(item["path"] as! String) == forwarded, "\(item["path"]!)") }
        }
    }

    @Test func messages() throws {
        for item in list("messages") {
            let head = try JSONDecoder().decode(LinkMessage.Head.self, from: JSONSerialization.data(withJSONObject: item["head"]!))
            let message = LinkMessage(head, body: bytes(item, "body"))
            #expect(message.data == bytes(item, "bytes"))
            #expect(try LinkMessage(bytes(item, "bytes")) == message)
        }
    }
}
