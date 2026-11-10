import Foundation
import KuvoLink
import OpenCodeKit
import os
import Testing
@testable import KuvoCode

// COMPAT(0.8 keeper handover): goes with PhoneLink+KeeperHandover, 3 months after 0.8.0.
/// While an older app's keeper makes way for this one's, this app's box is that keeper's, from
/// before boxes answered `kuvo/info` for their Mac: a phone asking still hears this Mac, its chats
/// folder and its features, never a machine's. A box that answers it for its Mac is passed on as it
/// is. The older keeper's box is a stand-in.
@MainActor
@Suite(.serialized) struct KeeperHandoverTests {
    /// What a phone hears of `kuvo/info` through this app, with `box` its box's answer.
    private func info(_ box: [String: Any]) async throws -> [String: Any] {
        let answer = try JSONSerialization.data(withJSONObject: box)
        let listener = try await StubListener { request, _ in
            request.url?.path == "/kuvo/info" ? StubWeb.Answer(status: 200, body: answer) : StubWeb.Answer(status: 404)
        }
        defer { listener.stop() }
        let before = PhoneLink.box.withLock { $0 }
        PhoneLink.box.withLock { $0 = listener.endpoint }
        defer { PhoneLink.box.withLock { $0 = before } }
        var status = 0
        var body = Data()
        for try await part in PhoneLink.respond(to: LinkRequest(path: "kuvo/info"), link: nil, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil,
                                                asking: Data(repeating: 7, count: 32)) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): body += chunk
            }
        }
        #expect(status == 200)
        return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    }

    @Test func anOlderKeepersBoxIsSaidAsThisMac() async throws {
        let said = try await info([
            "kind": "machine", "name": "Studio.local", "bridge": "0.9.209", "engine": "1.2.3", "started": 1_790_000_000.5, "running": false, "stopped": false,
            "agents": true, "chats": "/Users/me/Library/Application Support/run.kuvo.code/box/chats", "macs": [], "phones": 1,
            "features": ["agents", "autopilot", "engine.start", "update", "work.elsewhere"],
        ])
        #expect(said["kind"] as? String == "mac")
        #expect(said["name"] as? String == PhoneLink.computerName)
        #expect(said["app"] as? String == AppInfo.version)
        #expect(said["chats"] as? String == Workspace.chatsFolder, "this Mac's chats, not its box's folder")
        #expect(said["engine"] as? String == "1.2.3")
        #expect(said["started"] as? Double == 1_790_000_000.5)
        #expect(said["agents"] as? Bool == true)
        #expect(said["running"] == nil && said["stopped"] == nil && said["bridge"] == nil, "a machine's alone: a phone would take the Mac's engine as down")
        #expect((said["integrations"] as? [String: String])?.isEmpty == false)
        let features = try #require(said["features"] as? [String])
        #expect(features == ["agents", "autopilot", "work.elsewhere", "accounts.ended", "claude-code", "hosts", "mac", "machines", "usage"])

        // No engine running: none came up, and the one it brings.
        let stopped = try await info(["kind": "machine", "engine": NSNull(), "started": NSNull(), "running": false, "features": []])
        #expect(stopped["started"] is NSNull)
        #expect(stopped["engine"] as? String == OpenCodeEngine.version)
    }

    @Test func aBoxThatSaysItsThisMacsIsPassedOnAsItIs() async throws {
        let box: [String: Any] = ["kind": "mac", "name": "Studio", "app": "0.8.0", "engine": "1.2.3", "chats": "/chats", "agents": false, "started": NSNull(),
                                  "integrations": ["x": "X"], "features": ["agents", "machines"]]
        let said = try await info(box)
        #expect(NSDictionary(dictionary: said).isEqual(to: box))
    }
}
