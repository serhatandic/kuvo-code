import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a phone changes on this Mac, as Settings would: the engine's settings (open sessions
/// follow a change to the rules; a change that says what it read, changed since, isn't made),
/// the popular MCP servers and adding one, starting the engine over, and finishing a sign-in
/// whose page sends the browser back to this Mac, which a phone can't load.
@MainActor
@Suite(.serialized) struct PhoneSettingsTests {
    let folder: URL
    let config: EngineConfig
    let link = PhoneLink()
    var file: URL { folder.appending(path: "opencode.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "PhoneSettings/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(#"{"model": "anthropic/sonnet"}"#.utf8).write(to: folder.appending(path: "opencode.json"))
        config = EngineConfig(file: folder.appending(path: "opencode.json"))
        link.engineConfig = config
    }

    private func ask(_ path: String, method: String = "GET", body: String = "") async throws -> (status: Int, json: [String: Any]?) {
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: Data(body.utf8))
        var status = 0
        var data = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:9/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): data += chunk
            }
        }
        return (status, try? JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func onDisk() throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    @Test func settingsChangeAsSettingsChangesThem() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        var rulesChanged = 0
        config.onRulesChanged = { rulesChanged += 1 }

        let read = try await ask("kuvo/config")
        #expect(read.status == 200 && read.json?["model"] as? String == "anthropic/sonnet")

        // Several at once, a level that isn't there yet made; answered with them all, and saved.
        let changed = try await ask("kuvo/config", method: "PATCH", body: """
            {"changes": [{"path": ["model"], "value": "openai/luna"}, {"path": ["mcp", "servers", "linear", "disabled"], "value": true}]}
            """)
        #expect(changed.status == 200)
        #expect(changed.json?["model"] as? String == "openai/luna")
        #expect(((changed.json?["mcp"] as? [String: Any])?["servers"] as? [String: Any])?["linear"] as? [String: Bool] == ["disabled": true])
        #expect(try onDisk()["model"] as? String == "openai/luna")
        #expect(rulesChanged == 0)

        // The rules: open sessions follow, from wherever they changed.
        let rule = #"{"changes": [{"path": ["permissions"], "value": [{"action": "shell", "resource": "git push *", "effect": "deny"}]}]}"#
        #expect(try await ask("kuvo/config", method: "PATCH", body: rule).status == 200)
        #expect(rulesChanged == 1)
        #expect(config.permissionRules.count == 1)

        // A server applied from another computer (a phone's Also Apply), its key named where that
        // one keeps its keys: named where this Mac keeps them.
        let server = #"{"changes": [{"path": ["mcp", "servers", "todoist"], "value": {"type": "local", "environment": {"API_KEY": "{file:~/.kuvo-code/box/keys/KUVO_KEY_TODOIST_API_KEY}"}}}]}"#
        #expect(try await ask("kuvo/config", method: "PATCH", body: server).status == 200)
        #expect(config.value(at: ["mcp", "servers", "todoist", "environment", "API_KEY"])?.string == IntegrationKeys.reference("KUVO_KEY_TODOIST_API_KEY"))
        #expect(try await ask("kuvo/config", method: "PATCH", body: #"{"changes": [{"path": ["mcp", "servers", "todoist"], "value": null}]}"#).status == 200)

        // Read, then changed elsewhere: not made, and said.
        let stale = #"{"changes": [{"path": ["model"], "value": "x/y", "was": "anthropic/sonnet"}]}"#
        #expect(try await ask("kuvo/config", method: "PATCH", body: stale).status == 409)
        #expect(try onDisk()["model"] as? String == "openai/luna")
        // Null removes; "was": null is nothing there.
        #expect(try await ask("kuvo/config", method: "PATCH", body: #"{"changes": [{"path": ["model"], "value": null, "was": "openai/luna"}]}"#).status == 200)
        #expect(try onDisk()["model"] == nil)
        #expect(try await ask("kuvo/config", method: "PATCH", body: #"{"changes": [{"path": ["model"], "value": "a/b", "was": null}]}"#).status == 200)
        #expect(try onDisk()["model"] as? String == "a/b")

        // Through a list or a value: refused, the rules kept (a list is sent whole).
        for through in [#"["permissions", "0"]"#, #"["permissions", "0", "effect"]"#, #"["model", "x"]"#] {
            #expect(try await ask("kuvo/config", method: "PATCH", body: #"{"changes": [{"path": \#(through), "value": null}]}"#).status == 400, "\(through)")
        }
        #expect(config.permissionRules.count == 1)
        for bad in [#"{"changes": []}"#, #"{"changes": [{"path": [], "value": 1}]}"#, #"{"changes": [{"path": ["model"]}]}"#, "nope"] {
            #expect(try await ask("kuvo/config", method: "PATCH", body: bad).status == 400, "\(bad)")
        }
        // A file Kuvo Code can't read (comments in it) is left as it is.
        let commented = "{\n  // mine\n  \"model\": \"a/b\"\n}\n"
        try Data(commented.utf8).write(to: file)
        #expect(try await ask("kuvo/config").status == 409)
        #expect(try await ask("kuvo/config", method: "PATCH", body: #"{"changes": [{"path": ["model"], "value": "c/d"}]}"#).status == 409)
        #expect(try String(contentsOf: file, encoding: .utf8) == commented)
    }

    /// This Mac's integrations' keys, from a phone: set, read, listed and removed in the Keychain,
    /// and a bot's own or anything that isn't a key's name never touched.
    @Test func integrationsKeysFromAPhone() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let name = "KUVO_KEY_PHONETEST_TOKEN"
        defer { IntegrationKeys.set(nil, for: name) }
        #expect(try await ask("kuvo/keys/\(name)").status == 404)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: #"{"value": "ghp_phone"}"#).status == 200)
        #expect(IntegrationKeys.value(name) == "ghp_phone")
        #expect(try await ask("kuvo/keys/\(name)").json?["value"] as? String == "ghp_phone")
        #expect((try await ask("kuvo/keys").json?["keys"] as? [String])?.contains(name) == true)
        #expect(try await ask("kuvo/keys/\(name)__BOT_A", method: "PUT", body: #"{"value": "x"}"#).status == 400)
        #expect(try await ask("kuvo/keys/HOME", method: "PUT", body: #"{"value": "x"}"#).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: #"{"value": ""}"#).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "DELETE").status == 200)
        #expect(IntegrationKeys.value(name) == nil)
    }

    @Test func popularServersAreAddedAsTheirAddButtonDoes() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let listed = try #require(try await ask("kuvo/mcp/catalog").json?["servers"] as? [[String: Any]])
        #expect(listed.count == MCPCatalog.servers.count)
        let byID = Dictionary(uniqueKeysWithValues: listed.map { ($0["id"] as! String, $0) })
        #expect(byID["context7"]?["added"] as? Bool == false && byID["context7"]?["access"] as? String == "open")
        #expect(byID["linear"]?["access"] as? String == "signIn")
        #expect(byID["chrome-devtools"]?["macOnly"] as? Bool == true && byID["linear"]?["macOnly"] as? Bool == false)

        let added = try await ask("kuvo/mcp/catalog/context7", method: "POST")
        #expect(added.status == 200)
        let server = (((try onDisk()["mcp"]) as? [String: Any])?["servers"] as? [String: Any])?["context7"] as? [String: Any]
        #expect(server?["url"] as? String == "https://mcp.context7.com/mcp")
        #expect(server?["codemode"] as? Bool == false, "its tools as they are, as Add does")
        #expect(try await ask("kuvo/mcp/catalog/nothing", method: "POST").status == 404)

        // One Integrations added says so, and stays theirs.
        config.set(.object(["type": .string("remote"), "url": .string("https://mcp.linear.app/mcp")]), at: MCPSettings.path + ["linear"])
        let again = try #require(try await ask("kuvo/mcp/catalog").json?["servers"] as? [[String: Any]])
        let now = Dictionary(uniqueKeysWithValues: again.map { ($0["id"] as! String, $0) })
        #expect(now["context7"]?["added"] as? Bool == true && now["context7"]?["integration"] as? Bool == false)
        #expect(now["linear"]?["added"] as? Bool == true && now["linear"]?["integration"] as? Bool == true)
    }

    @Test func theEngineStartsOverOnceTheAnswerIsOut() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        // When the engine running now came up, which the phone watches change.
        let up = Date(timeIntervalSince1970: 1_792_660_000)
        link.engineStarted = { up }
        #expect(try await ask("kuvo/info").json?["started"] as? Double == up.timeIntervalSince1970)
        var restarted = false
        link.restartEngine = { restarted = true }
        #expect(try await ask("kuvo/engine/restart", method: "POST").status == 202)
        #expect(!restarted)
        try await eventually { restarted }
        #expect(restarted)
    }

    @Test func aSignInThatReturnsHereIsLoadedHere() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        StubWeb.start(hosts: ["127.0.0.1", "example.com"])
        defer { StubWeb.stop() }
        StubWeb.handle("http://127.0.0.1:19876/") { _, _ in StubWeb.Answer(status: 302) }

        let loaded = try await ask("kuvo/sign-in/return", method: "POST", body: #"{"url": "http://127.0.0.1:19876/mcp/oauth/callback?code=c&state=s#_=_"}"#)
        #expect(loaded.status == 200 && loaded.json?["status"] as? Int == 302)
        #expect(StubWeb.asked.contains("http://127.0.0.1:19876/mcp/oauth/callback?code=c&state=s"))

        // Only this Mac's own address, with what the page sent back.
        for url in ["http://example.com:19876/cb?code=c", "http://127.0.0.1:19876/cb", "https://127.0.0.1:19876/cb?code=c"] {
            #expect(try await ask("kuvo/sign-in/return", method: "POST", body: #"{"url": "\#(url)"}"#).status == 400, "\(url)")
        }
        #expect(!StubWeb.asked.contains { $0.contains("example.com") || $0.hasSuffix("/cb") })
        #expect(try await ask("kuvo/sign-in/return").status == 405)
    }
}
