import Foundation
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

/// This Mac's box: the same box a machine runs (`kuvo-link.js serve`), started beside the engine.
/// It finds the engine and the coding agents' bridge as a machine's box does, by the records the
/// app writes as they start and stop, and keeps what it has in the app's own folder. Run with
/// Node, which runs the same script as the engine's Bun.
@MainActor
@Suite(.serialized) struct MacBoxTests {
    /// Node, where it usually is (CI's, Homebrew's, nvm's).
    static var node: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let nvm = home.appending(path: ".nvm/versions/node")
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []).sorted { $0.compare($1, options: .numeric) == .orderedDescending }
        let candidates = ["/usr/local/bin/node", "/opt/homebrew/bin/node"] + versions.map { nvm.appending(path: "\($0)/bin/node").path }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }.map { URL(filePath: $0) }
    }

    private func info(_ endpoint: ServerEndpoint) async throws -> [String: Any] {
        var request = URLRequest(url: endpoint.url.appending(path: "kuvo/info"))
        request.setValue("Basic " + Data("opencode:\(endpoint.password ?? "")".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func theBoxFindsTheEngineTheAppStarted() async throws {
        let node = try #require(Self.node, "Node runs this Mac's box in the tests")
        let box = BoxProcess()
        defer {
            box.stop()
            BoxProcess.engineChanged(nil, version: nil, pid: nil)
            try? FileManager.default.removeItem(at: BoxProcess.home)
        }
        await box.start(node: node)
        let endpoint = try #require(box.endpoint, "it started: \(box.failure ?? "")")
        #expect(PhoneLink.box.withLock { $0 } == endpoint, "the phone link hands moved areas to it")

        BoxProcess.engineChanged(ServerEndpoint(url: URL(string: "http://127.0.0.1:47970")!, password: "pw"), version: "2.0.32", pid: getpid())
        let running = try await info(endpoint)
        #expect(running["engine"] as? String == "2.0.32")
        #expect(running["chats"] as? String == BoxProcess.home.appending(path: "chats").path, "its folders are in the app's own")
        // Its record is yours alone.
        let record = BoxProcess.run.appending(path: "engine.json").path
        #expect((try FileManager.default.attributesOfItem(atPath: record)[.posixPermissions] as? Int) == 0o600)

        BoxProcess.engineChanged(nil, version: nil, pid: nil)
        #expect(try await info(endpoint)["engine"] is NSNull, "stopped, it's gone")

        box.stop()
        #expect(PhoneLink.box.withLock { $0 } == nil)
    }
}
