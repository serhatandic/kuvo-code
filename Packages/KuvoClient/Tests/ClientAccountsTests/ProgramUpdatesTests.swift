import ClientAccounts
import Foundation
import OpenCodeKit
import Testing

/// How a coding agent's program's update stands, as its box says it on every account with it
/// (`metadata.programUpdate`), read the same on the Mac and the phone.
@Suite struct ProgramUpdatesTests {
    private func account(_ metadata: [String: Any]) throws -> Integration {
        let json: [String: Any] = ["id": "codex-cli@9a8b", "name": "Codex · Work", "methods": [], "connections": [], "metadata": metadata]
        return try JSONDecoder().decode(Integration.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func eachOutcomeIsToldFromTheNextByItsProgramAndWhen() throws {
        let failed = try account(["agent": "codex", "programUpdate": ["state": "failed", "message": "npm: permission denied", "version": "0.163.0", "at": 1_700_000_000_123]])
        #expect(failed.programUpdate == ProgramUpdate(state: .failed("npm: permission denied"), at: 1_700_000_000_123, program: "codex"))
        #expect(failed.programUpdate?.id == "codex@1700000000123")
        let again = try account(["agent": "codex", "programUpdate": ["state": "failed", "message": "npm: permission denied", "at": 1_700_000_000_456]])
        #expect(again.programUpdate?.id != failed.programUpdate?.id, "a second failure is said too")

        #expect(try account(["agent": "codex", "programUpdate": ["state": "updating", "at": 5]]).isUpdatingProgram)
        #expect(try account(["agent": "codex", "programUpdate": ["state": "updated", "version": "0.164.0", "at": 6]]).programUpdate?.state == .updated("0.164.0"))
        #expect(try account(["agent": "codex", "programUpdate": ["state": "current", "version": "0.164.0", "at": 7]]).programUpdate?.state == .current("0.164.0"))
    }

    @Test func aStateItDoesntKnowOrNoneReadsAsNone() throws {
        #expect(try account(["agent": "codex"]).programUpdate == nil)
        #expect(try account(["agent": "codex", "programUpdate": ["state": "verifying", "at": 8]]).programUpdate == nil, "one a newer box adds")
        #expect(try account(["agent": "codex", "updateAll": true]).isInUpdateAll)
        #expect(try !account(["agent": "codex", "updateAll": false, "outdated": true, "updates": true]).isInUpdateAll, "the box picks what Update All updates")
        // A box from before it picked them: its own sign-in, by what it says of its version.
        #expect(try account(["agent": "codex", "accountID": "default", "outdated": true, "updates": true]).isInUpdateAll)
        #expect(try !account(["agent": "codex", "accountID": "9a8b", "outdated": true, "updates": true]).isInUpdateAll)
    }

    /// Update All on a box from before `kuvo/updates` (0.7's, 0.8.0-beta.1's), which answers 404
    /// there: each own sign-in behind that its installer can update is asked the old way, once a
    /// program, and why one didn't update is said in its installer's words.
    @Test func updateAllOnABoxFromBeforeItAsksEachOwnSignInBehindTheOldWay() async throws {
        func agent(_ id: String, updates: Bool = true) -> [String: Any] {
            let parts = id.split(separator: "@").map(String.init)
            let metadata: [String: Any] = ["agent": parts[0], "accountID": parts.count == 2 ? parts[1] : "default", "outdated": true, "updates": updates]
            return ["id": id, "name": parts[0], "methods": [], "connections": [], "metadata": metadata]
        }
        let accounts = try JSONDecoder().decode([Integration].self, from: JSONSerialization.data(withJSONObject: [
            agent("codex-cli@9a8b"), agent("codex-cli"), agent("claude-code"), agent("grok-cli", updates: false),
        ]))
        let box = OldBox.start(answers: [
            "POST /api/integration/codex-cli/update": #"{"data":{"updated":false,"version":"0.163.0","message":"npm: permission denied"}}"#,
            "POST /api/integration/claude-code/update": #"{"data":{"updated":true,"version":"2.1.309"}}"#,
        ])

        let failure = await #expect(throws: ProgramUpdateFailure.self) { try await box.api.updateAllPrograms(accounts) }
        #expect(failure?.message == "npm: permission denied")
        #expect(Set(box.asked) == ["POST /api/kuvo/updates", "POST /api/integration/codex-cli/update", "POST /api/integration/claude-code/update"])
        #expect(box.asked.count == 3, "once a program; never Grok, which its installer can't update")
    }
}

/// A box from before `kuvo/updates`: it answers what it's given, and 404 to the rest, and keeps
/// what it was asked.
private final class OldBox: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) private static var boxes: [String: (answers: [String: String], asked: [String])] = [:]
    private static let lock = NSLock()

    struct Handle {
        let api: OpenCodeAPI
        let host: String
        var asked: [String] { OldBox.lock.withLock { OldBox.boxes[host]?.asked ?? [] } }
    }

    static func start(answers: [String: String]) -> Handle {
        let host = "box-\(UUID().uuidString.lowercased()).invalid"
        lock.withLock { boxes[host] = (answers, []) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OldBox.self]
        let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://\(host)")!, password: nil), session: URLSession(configuration: configuration))
        return Handle(api: api, host: host)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let host = url.host() else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let ask = "\(request.httpMethod ?? "GET") \(url.path())"
        let answer = Self.lock.withLock { () -> String? in
            Self.boxes[host]?.asked.append(ask)
            return Self.boxes[host]?.answers[ask]
        }
        let body = Data((answer ?? "{}").utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: answer == nil ? 404 : 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
