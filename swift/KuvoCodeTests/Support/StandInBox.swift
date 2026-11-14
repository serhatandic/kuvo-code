import Foundation
import OpenCodeKit
@testable import KuvoCode

/// A box's own server, as the app reaches the box attached in place over it (#333): on this Mac,
/// where `run/serve.json` says, to its password. What it was asked, and as whom (`x-kuvo-from`:
/// `app`, this Mac's own app; `mac`, Kuvo Code on its computer).
@MainActor
final class StandInBox {
    struct Asked {
        var method: String
        var path: String
        var body: Data
        var from: String?
        var fromApp: Bool { from == "app" }
    }
    private(set) var asked: [Asked] = []
    private var server: LoopbackServer?
    /// What its record names as the box's server: a process of the test's own, named as one.
    private var named: pid_t = 0

    static func start(at box: URL, answer: @escaping (HTTPRequest) -> HTTPResponse) async throws -> StandInBox {
        let stand = StandInBox()
        let password = "serve-password-\(UUID().uuidString)"
        let expected = "Basic " + Data("opencode:\(password)".utf8).base64EncodedString()
        let server = LoopbackServer { [weak stand] request in
            guard request.headers["authorization"] == expected else { return HTTPResponse(status: 401) }
            stand?.asked.append(Asked(method: request.method, path: request.path, body: request.body, from: request.headers["x-kuvo-from"]))
            TestPulse.beat()
            return answer(request)
        }
        stand.server = server
        let port = try await server.start()
        let record = box.appending(path: "run/serve.json")
        try FileManager.default.createDirectory(at: record.deletingLastPathComponent(), withIntermediateDirectories: true)
        // (`/bin/sleep`, its first argument the server's name: started whole before this goes on.)
        var pid: pid_t = 0
        let argv: [UnsafeMutablePointer<CChar>?] = [strdup("kuvo-link.js serve"), strdup("3600"), nil]
        defer { argv.forEach { free($0) } }
        guard posix_spawn(&pid, "/bin/sleep", nil, nil, argv, nil) == 0 else { throw TestFailure("the stand-in server's process didn't start") }
        stand.named = pid
        try JSONSerialization.data(withJSONObject: ["pid": Int(pid), "port": Int(port), "password": password, "kept": false]).write(to: record)
        return stand
    }

    /// How many times it was asked `method` `path` (its path with a leading slash, as asked).
    func count(_ method: String, _ path: String) -> Int {
        asked.filter { $0.method == method && $0.path == path }.count
    }

    func stop() {
        server?.stop()
        // (Its own process, by its PID.)
        guard named > 0 else { return }
        kill(named, SIGTERM)
        waitpid(named, nil, 0)
        named = 0
    }
}
