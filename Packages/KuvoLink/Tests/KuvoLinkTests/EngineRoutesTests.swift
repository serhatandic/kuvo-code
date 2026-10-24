import Foundation
import Testing
@testable import KuvoLink

/// An engine in memory, through URLProtocol: answers with what it was asked, or an event stream.
final class FakeEngine: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var asked: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host() == "engine.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.asked.append(request)
        let stream = request.url?.path() == "/api/event"
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": stream ? "text/event-stream" : "application/json", "Set-Cookie": "no=thanks",
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if stream {
            client?.urlProtocol(self, didLoad: Data("data: {\"type\":\"server.connected\"}\n\ndata: {\"type\":\"server.heartbeat\"}\n\n".utf8))
        } else {
            client?.urlProtocol(self, didLoad: Data(#"{"path":"\#(request.url!.absoluteString)"}"#.utf8))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) struct EngineRoutesTests {
    let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeEngine.self]
        return URLSession(configuration: configuration)
    }()
    let base = URL(string: "http://engine.test:4096/")!

    private func collect(_ stream: AsyncThrowingStream<LinkResponsePart, Error>) async throws -> (Int, [String: String], [Data]) {
        var status = 0, headers: [String: String] = [:], pieces: [Data] = []
        for try await part in stream {
            switch part {
            case .head(let s, let h): (status, headers) = (s, h)
            case .body(let data): pieces.append(data)
            }
        }
        return (status, headers, pieces)
    }

    /// A paired phone is yours: the engine's whole API, accounts and keys, settings and commands
    /// included, and the agents' bridge's but for the routes only the app wires things with.
    @Test func aPhoneHasTheWholeAPI() {
        for path in ["api/session/ses_1/prompt", "api/credential", "api/credential/cred_1", "api/config", "api/mcp", "api/shell",
                     "api/integration/anthropic/connect/key", "api/integration/anthropic/update", "api/fs/read/a.txt"] {
            #expect(EngineRoutes.allows(path, method: "POST"), "\(path)")
        }
        #expect(EngineRoutes.allowsAgents("api/integration/claude-code/update", method: "POST"))
        #expect(EngineRoutes.allowsAgents("api/kuvo/auto", method: "PUT"))
        // Where the engine is, and the group chats' own steps: not however it's written, as the
        // bridge decodes it and drops empty and "." parts.
        for path in ["api/kuvo/engine", "api/kuvo/%65ngine", "api/kuvo//engine", "api/kuvo/./engine", "api/kuvo/engine?x=1", "api/kuvo/groups/grp_x/release"] {
            #expect(!EngineRoutes.allowsAgents(path, method: "PUT"), "\(path)")
        }
        #expect(EngineRoutes.canonical("api//integration/x/%75pdate?y=1") == "api/integration/x/update?y=1")
        // Nothing but the API, and no path that isn't what it seems.
        for path in ["kuvo/info", "", "api/fs/read/../../etc/passwd", "api/session/%2e%2e/credential", "api/kuvo/engine#", "api/session/x\u{7f}"] {
            #expect(!EngineRoutes.allows(path) && !EngineRoutes.allowsAgents(path), "\(path)")
        }
    }

    @Test func passesRequestsWithTheEnginesPassword() async throws {
        FakeEngine.asked = []
        let request = LinkRequest(method: "POST", path: "api/session/ses_1/prompt?x=1", headers: ["X-Opencode-Directory": "/p", "Authorization": "Basic forged", "Cookie": "c"], body: Data("{}".utf8))
        let (status, headers, pieces) = try await collect(EngineRoutes.forward(request, to: base, password: "s3cret", session: session))
        #expect(status == 200)
        #expect(headers == ["content-type": "application/json"])
        #expect(String(decoding: pieces.reduce(Data(), +), as: UTF8.self).contains("api/session/ses_1/prompt?x=1"))
        let asked = try #require(FakeEngine.asked.last)
        #expect(asked.httpMethod == "POST")
        #expect(asked.value(forHTTPHeaderField: "Authorization") == "Basic " + Data("opencode:s3cret".utf8).base64EncodedString())
        #expect(asked.value(forHTTPHeaderField: "x-opencode-directory") == "/p")
        #expect(asked.value(forHTTPHeaderField: "Cookie") == nil)
    }

    /// What reaches the engine, or the agents' bridge, is the path as it was checked: each path the
    /// vectors allow arrives as their `forwarded`, however the phone wrote it ("%75pdate",
    /// "a+b", "Re\u{301}sume\u{301}.txt", twice-encoded dots, empty parts).
    @Test func whatIsCheckedIsWhatIsSent() async throws {
        let vectors = try Vectors.load("link.json")
        let lists: [(String, @Sendable (String, String) -> Bool)] = [
            ("routes", { EngineRoutes.allows($0, method: $1) }), ("agentRoutes", { EngineRoutes.allowsAgents($0, method: $1) }),
        ]
        for (key, allowing) in lists {
            for item in vectors[key] as! [[String: Any]] {
                guard let forwarded = item["forwarded"] as? String else { continue }
                FakeEngine.asked = []
                let request = LinkRequest(method: item["method"] as? String ?? "GET", path: item["path"] as! String)
                let (status, _, _) = try await collect(EngineRoutes.forward(request, to: base, password: nil, session: session, allowing: allowing))
                #expect(status == 200, "\(request.path)")
                #expect(FakeEngine.asked.map { $0.url?.absoluteString } == [base.absoluteString + forwarded], "\(request.path)")
            }
        }
    }

    @Test func refusesWhatIsNotOnTheList() async throws {
        FakeEngine.asked = []
        let (status, _, _) = try await collect(EngineRoutes.forward(LinkRequest(path: "api/session/../credential"), to: base, password: "s", session: session))
        #expect(status == 403)
        #expect(FakeEngine.asked.isEmpty)
    }

    @Test func eventsGoOneByOne() async throws {
        let (_, headers, pieces) = try await collect(EngineRoutes.forward(LinkRequest(path: "api/event"), to: base, password: nil, session: session))
        #expect(headers["content-type"] == "text/event-stream")
        #expect(pieces.count == 2)
        #expect(String(decoding: pieces[0], as: UTF8.self) == "data: {\"type\":\"server.connected\"}\n\n")
    }
}
