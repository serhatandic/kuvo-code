import Foundation
import Testing
@testable import OpenCodeKit

/// The engine reads a query the way a web form is read, where `+` is a space. Values with `+`
/// in them (a folder called "C++", a page cursor in base64) must reach it as they were sent.
@Suite struct QueryEncodingTests {
    @Test func listsTheSessionsOfAFolderWithAPlusInItsName() async throws {
        let folder = "/Users/me/C++ & Rust/kit=1;2"
        let query = try await EngineQuery.sent { try await $0.sessions(directory: folder) }
        #expect(query["directory"] == folder)
        #expect(query["order"] == "desc")
    }

    @Test func pagesOnWithACursorThatHasAPlusInIt() async throws {
        let cursor = "eyJ0IjoxfQ+a/b=="
        let query = try await EngineQuery.sent { try await $0.sessions(after: cursor) }
        #expect(query["cursor"] == cursor)
    }
}

/// Answers every request with an empty page, and keeps the query of the last one, read as the
/// engine reads it (`URLSearchParams`: `+` is a space, then percent-escapes are undone).
private final class EngineQuery: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var queries: [String: [String: String]] = [:]
    private static let lock = NSLock()

    static func sent(_ call: (OpenCodeAPI) async throws -> some Any) async throws -> [String: String] {
        let host = "engine-\(UUID().uuidString.lowercased()).invalid"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [EngineQuery.self]
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://\(host)")!, password: nil), session: URLSession(configuration: configuration))
        _ = try await call(api)
        return lock.withLock { queries.removeValue(forKey: host) } ?? [:]
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host() else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        var query: [String: String] = [:]
        for pair in (url.query(percentEncoded: true) ?? "").split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map {
                $0.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String($0)
            }
            query[parts[0]] = parts.count > 1 ? parts[1] : ""
        }
        Self.lock.withLock { Self.queries[host] = query }
        let body = Data(#"{"data":[]}"#.utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
