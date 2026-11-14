import Foundation
import Testing
@testable import KuvoLink

/// The whole way: this test as the phone, then a real relay, a machine's bridge
/// (`Resources/kuvo-link.js`) and a real engine. Skipped unless KUVO_TEST_PAIRING_LINK holds the
/// bridge's pairing link; kuvo-code-ios's `scripts/link-local.sh --test` sets everything up and
/// runs it.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["KUVO_TEST_PAIRING_LINK"] != nil), .serialized)
struct LiveLinkTests {
    static let environment = ProcessInfo.processInfo.environment
    static let pairing = PairingLink(URL(string: environment["KUVO_TEST_PAIRING_LINK"] ?? "")!)!
    static let project = environment["KUVO_TEST_PROJECT"] ?? FileManager.default.temporaryDirectory.path
    static let client = LinkClient(relay: pairing.relay, key: LinkKey(), secret: RelaySecret(), name: "Live test", app: "0")
    nonisolated(unsafe) static var host: PairedHost?

    private func paired() async throws -> PairedHost {
        if let host = Self.host { return host }
        let host = try await Self.client.pair(Self.pairing)
        Self.host = host
        return host
    }

    private func session() async throws -> URLSession {
        let host = try await paired()
        return URLSession(configuration: LinkURLProtocol.configuration(client: Self.client) { [host] })
    }

    private func url(_ path: String) async throws -> URL {
        URL(string: path, relativeTo: try LinkURLProtocol.baseURL(for: await paired()))!
    }

    @Test func pairsWithTheMachine() async throws {
        let host = try await paired()
        #expect(host.kind == .machine)
        let hello = try await Self.client.hostHello(host)
        #expect(hello.engine != nil)
    }

    @Test func makesAndListsSessions() async throws {
        let session = try await session()
        var create = URLRequest(url: try await url("api/session"))
        create.httpMethod = "POST"
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        create.httpBody = try JSONSerialization.data(withJSONObject: ["title": "From the link", "location": ["directory": Self.project]])
        let (created, response) = try await session.data(for: create)
        #expect((response as? HTTPURLResponse)?.statusCode == 200, "\(String(decoding: created, as: UTF8.self))")
        let id = try #require(((try JSONSerialization.jsonObject(with: created) as? [String: Any])?["data"] as? [String: Any])?["id"] as? String)

        let (listed, _) = try await session.data(from: try await url("api/session?limit=20&order=desc"))
        #expect(String(decoding: listed, as: UTF8.self).contains(id))
    }

    @Test func streamsEvents() async throws {
        let session = try await session()
        var request = URLRequest(url: try await url("api/event"))
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        #expect((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type")?.hasPrefix("text/event-stream") == true)
        var connected = false
        for try await line in bytes.lines where line.contains("server.connected") {
            connected = true
            break
        }
        #expect(connected)
    }

    @Test func opensATerminal() async throws {
        let session = try await session()
        var create = URLRequest(url: try await url("api/pty"))
        create.httpMethod = "POST"
        create.setValue("application/json", forHTTPHeaderField: "Content-Type")
        create.setValue(Self.project, forHTTPHeaderField: "x-opencode-directory")
        create.httpBody = try JSONSerialization.data(withJSONObject: ["title": "Live test"])
        let (created, _) = try await session.data(for: create)
        let id = try #require(((try JSONSerialization.jsonObject(with: created) as? [String: Any])?["data"] as? [String: Any])?["id"] as? String)
        var failure: Error?
        do {
            try await Self.answers(Self.client.socket(.socket("api/pty/\(id)/connect?cursor=0", headers: ["x-opencode-directory": Self.project]), to: try await paired()))
        } catch {
            failure = error
        }
        var remove = URLRequest(url: try await url("api/pty/\(id)"))
        remove.httpMethod = "DELETE"
        remove.setValue(Self.project, forHTTPHeaderField: "x-opencode-directory")
        _ = try await session.data(for: remove)
        if let failure { throw failure }
    }

    /// The Mac's side of a socket (`EngineRoutes.connect`), straight to the engine's terminal.
    @Test(.enabled(if: environment["KUVO_TEST_ENGINE_FILE"] != nil))
    func theMacReachesATerminal() async throws {
        struct Engine: Decodable { var port: Int; var password: String }
        let engine = try JSONDecoder().decode(Engine.self, from: Data(contentsOf: URL(filePath: Self.environment["KUVO_TEST_ENGINE_FILE"]!)))
        let base = URL(string: "http://127.0.0.1:\(engine.port)/")!
        let headers = ["x-opencode-directory": Self.project, "content-type": "application/json"]
        var created = Data()
        for try await part in EngineRoutes.forward(LinkRequest(method: "POST", path: "api/pty", headers: headers, body: Data(#"{"title":"Live test"}"#.utf8)), to: base, password: engine.password) {
            if case .body(let data) = part { created += data }
        }
        let id = try #require(((try JSONSerialization.jsonObject(with: created) as? [String: Any])?["data"] as? [String: Any])?["id"] as? String)
        let (input, feed) = AsyncStream<Data>.makeStream()
        let events = EngineRoutes.connect(.socket("api/pty/\(id)/connect?cursor=0", headers: headers), to: base, password: engine.password, input: input)
        var failure: Error?
        do {
            try await Self.answers(LinkSocket(events: events, write: { feed.yield($0) }, stop: { feed.finish() }))
        } catch {
            failure = error
        }
        for try await _ in EngineRoutes.forward(LinkRequest(method: "DELETE", path: "api/pty/\(id)", headers: headers), to: base, password: engine.password) {}
        if let failure { throw failure }
    }

    /// A terminal's socket opens, and a command typed into it answers.
    static func answers(_ socket: LinkSocket) async throws {
        var output = ""
        var typed = false
        for try await event in socket.events {
            switch event {
            case .open:
                continue
            case .binary:
                // Its note of where the output starts, then the shell's first prompt.
                guard !typed else { continue }
                typed = true
                try await socket.send(Data("echo kuvo-$((40+2))\r".utf8))
            case .text(let data):
                output += String(decoding: data, as: UTF8.self)
                if output.contains("kuvo-42\r\n") { return socket.close() }
            }
        }
        Issue.record("The terminal ended without answering: \(output.suffix(300))")
    }

    @Test func keepsAccountsAndSettingsOff() async throws {
        let session = try await session()
        for path in ["api/credential", "api/config", "api/integration"] {
            let (_, response) = try await session.data(from: try await url(path))
            #expect((response as? HTTPURLResponse)?.statusCode == 403, "\(path)")
        }
        // The provider list is allowed (the phone picks models from it), so it must not carry keys.
        let (providers, _) = try await session.data(from: try await url("api/provider"))
        let text = String(decoding: providers, as: UTF8.self)
        #expect(!text.contains("\"key\":\""), "\(text.prefix(500))")
        #expect(!text.lowercased().contains("apikey\":\""))
    }
}
