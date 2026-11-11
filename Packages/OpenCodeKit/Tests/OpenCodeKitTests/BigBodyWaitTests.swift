import Foundation
import Testing
@testable import OpenCodeKit

/// A request with a big body (a video shared from the phone) waits for its answer as long again as
/// its body takes to go on a slow connection: nothing comes back until it's all there (#358).
@Suite struct BigBodyWaitTests {
    @Test func aBigBodyWaitsLongerForItsAnswer() async throws {
        // Three times what a slow connection sends in a second: three seconds more than the minute.
        let waited = try await WaitSeen.waited(body: Data(count: 3 * HTTPClient.slowUpload))
        #expect(waited == 63)
    }

    @Test func aSmallBodyWaitsAsLongAsEver() async throws {
        #expect(try await WaitSeen.waited(body: Data(count: 1_000)) == 60)
    }

    @Test func aLongerWaitAskedForIsKept() throws {
        var request = URLRequest(url: URL(string: "http://engine.invalid/api/x")!)
        request.timeoutInterval = 15 * 60
        request.httpBody = Data(count: 10 * HTTPClient.slowUpload)
        #expect(HTTPClient.waitingForBody(request, idle: 60).timeoutInterval == 15 * 60 + 10)
    }
}

/// Answers every request at once, with `{}`, keeping how long each would have waited for it.
private final class WaitSeen: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var seen: [String: TimeInterval] = [:]
    private static let lock = NSLock()

    /// How long a prompt with `body` waits for its answer, sent as the link's sessions send it
    /// (waiting a minute with nothing coming).
    static func waited(body: Data) async throws -> TimeInterval? {
        let host = "engine-\(UUID().uuidString.lowercased()).invalid"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WaitSeen.self]
        configuration.timeoutIntervalForRequest = 60
        let client = HTTPClient(endpoint: ServerEndpoint(url: URL(string: "http://\(host)")!, password: nil), session: URLSession(configuration: configuration))
        var request = try client.request("POST", "api/session/ses_1/prompt", body: Empty?.none)
        request.httpBody = body
        _ = try await client.send(request, as: Empty.self)
        return lock.withLock { seen.removeValue(forKey: host) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host() else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        Self.lock.withLock { Self.seen[host] = request.timeoutInterval }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}
