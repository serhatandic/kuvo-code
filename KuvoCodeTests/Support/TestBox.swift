import Foundation
import KuvoLink
import OpenCodeKit
@testable import KuvoCode

/// This Mac's box for a test: the real `kuvo-link.js serve`, run with Node, as the app runs it
/// with the engine's Bun. It reaches the test's stand-in engine at its address, which listens on
/// its port for it (StubWeb answers there as it answers this process), and keeps what it has in
/// the tests' folder. `stop()` stops it and leaves nothing behind.
@MainActor
final class TestBox {
    let process = BoxProcess()
    private let enginePort: UInt16

    /// Node, where it usually is (CI's, Homebrew's, nvm's).
    static var node: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvm = home.appending(path: ".nvm/versions/node")
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"] + versions.map { nvm.appending(path: "\($0)/bin/node").path }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }.map { URL(filePath: $0) }
    }

    /// Started, finding the engine at `engine` (StubWeb's, started already).
    init(engine: String, password: String = "test") async throws {
        guard let node = Self.node else { throw TestFailure("Node runs this Mac's box in the tests, and there's none.") }
        let url = try URL(string: engine).orThrow("Not an engine's address: \(engine)")
        enginePort = UInt16(url.port ?? 0)
        try? FileManager.default.removeItem(at: BoxProcess.home)
        try StubWeb.listen(port: enginePort)
        await process.start(node: node)
        guard let endpoint = process.endpoint else { throw TestFailure("This Mac's box didn't start: \(process.failure ?? "")") }
        StubWeb.letThrough(port: endpoint.url.port ?? 0)
        BoxProcess.engineChanged(ServerEndpoint(url: url, password: password), version: "2.0.32", pid: getpid())
    }

    /// Its routes as the app's stores reach them (`AppModel.box`): through PhoneLink's answer,
    /// which hands what's moved onto the box to it.
    func client(engine: String, password: String = "test") -> BoxClient {
        let base = URL(string: engine.hasSuffix("/") ? engine : engine + "/")!
        return BoxClient(box: BoxClient.mac, transport: LocalBox { PhoneLink.respond(to: $0, link: nil, engine: base, password: password, agents: nil) })
    }

    /// Started again after it stopped (`BoxProcess.startAgain`), at a port of its own.
    func startAgain() async {
        await process.startAgain()
        if let port = process.endpoint?.url.port { StubWeb.letThrough(port: port) }
    }

    func stop() {
        process.stop()
        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        StubWeb.stopListening(port: enginePort)
        try? FileManager.default.removeItem(at: BoxProcess.home)
    }
}

private extension Optional {
    func orThrow(_ why: String) throws -> Wrapped {
        guard let self else { throw TestFailure(why) }
        return self
    }
}
