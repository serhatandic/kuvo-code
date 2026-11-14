import Foundation
import Testing
@testable import KuvoLink

/// A phone paired with a Mac before its box held the relay connection keeps reaching it after,
/// without pairing again (PROTOCOL.md, "The relay, on this Mac's box"): this test as the phone,
/// a real relay, and Kuvo Code itself, an older one and then one whose box holds the link, with
/// the same keys in the same Keychain. Skipped unless KUVO_TEST_MAC_MOVE names a file to keep the
/// phone in between; `pair` (with KUVO_TEST_PAIRING_LINK, the older Kuvo Code's pairing link) pairs
/// and keeps it, `after` comes back to the newer one.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_MAC_MOVE"] != nil), .serialized)
struct LiveMacMoveTests {
    static let environment = ProcessInfo.processInfo.environment
    static let file = URL(filePath: environment["KUVO_TEST_MAC_MOVE"] ?? "/dev/null")

    /// The phone, as it's kept between the two: its keys, the relay, and the Mac it paired with.
    struct Phone: Codable {
        var key: Data
        var secret: Data
        var relay: URL
        var host: PairedHost
    }

    private static func client(_ phone: Phone) throws -> LinkClient {
        LinkClient(relay: phone.relay, key: try LinkKey(rawRepresentation: phone.key), secret: try #require(RelaySecret(bytes: phone.secret)), name: "Live test", app: "0")
    }

    private static func get(_ path: String, client: LinkClient, host: PairedHost) async throws -> (status: Int, json: [String: Any]?) {
        let session = URLSession(configuration: LinkURLProtocol.configuration(client: client) { [host] })
        let (data, response) = try await session.data(from: URL(string: path, relativeTo: LinkURLProtocol.baseURL(for: host))!)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test(.enabled(if: environment["KUVO_TEST_MAC_STAGE"] == "pair")) func pairsWithTheOlderMac() async throws {
        let link = try #require(PairingLink(URL(string: Self.environment["KUVO_TEST_PAIRING_LINK"] ?? "")!))
        let key = LinkKey(), secret = RelaySecret()
        let client = LinkClient(relay: link.relay, key: key, secret: secret, name: "Live test", app: "0")
        let host = try await client.pair(link)
        #expect(host.kind == .mac)
        let phone = Phone(key: key.rawRepresentation, secret: secret.bytes, relay: link.relay, host: host)
        try JSONEncoder().encode(phone).write(to: Self.file)
        let phones = try await Self.get("kuvo/phones", client: client, host: host)
        #expect(phones.status == 200)
        #expect((phones.json?["phones"] as? [[String: Any]])?.contains { $0["you"] as? Bool == true } == true)
    }

    @Test(.enabled(if: environment["KUVO_TEST_MAC_STAGE"] == "after")) func reachesTheMacWhoseBoxHoldsTheLink() async throws {
        let phone = try JSONDecoder().decode(Phone.self, from: Data(contentsOf: Self.file))
        let client = try Self.client(phone)
        let hello = try await client.hostHello(phone.host)
        #expect(hello.kind == .mac, "the same Mac, without pairing again")
        // Its phones, now the box's: this one among them.
        let phones = try await Self.get("kuvo/phones", client: client, host: phone.host)
        #expect(phones.status == 200)
        #expect((phones.json?["phones"] as? [[String: Any]])?.contains { $0["you"] as? Bool == true } == true)
        // One of the box's own areas, and one of the Mac's own routes, through the app.
        #expect(try await Self.get("kuvo/personalities", client: client, host: phone.host).status == 200)
        let info = try await Self.get("kuvo/info", client: client, host: phone.host)
        #expect(info.status == 200)
        #expect(info.json?["kind"] as? String == "mac")
        // The engine, through the app as before.
        #expect(try await Self.get("api/session?limit=1", client: client, host: phone.host).status == 200)
    }
}
