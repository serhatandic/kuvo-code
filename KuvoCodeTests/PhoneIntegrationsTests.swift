import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Integrations from a phone, as this Mac answers it: each listed by kind, with how
/// it's added and what keys it takes; one added with its keys, as Add Key… and Connect do, and
/// removed with them; one used on its site, or without the keys it needs, turned away. And the
/// catalog a machine gets, for a phone to do the same there with this Mac closed.
@MainActor
@Suite(.serialized) struct PhoneIntegrationsTests {
    let app = AppModel()
    let link = PhoneLink()

    init() {
        TestEnvironment.prepare()
        app.bots.app = app
        link.bots = app.bots
    }

    private func ask(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> (status: Int, json: [String: Any]) {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
        let request = LinkRequest(method: method, path: path, headers: ["content-type": "application/json"], body: data)
        var status = 0
        var answer = Data()
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47998/")!, password: nil, agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    @Test func aPhoneAddsAndRemovesOneOfThisMacs() async throws {
        let config = app.config(for: .mac)
        defer {
            config.set(nil, at: MCPSettings.path + ["todoist"])
            IntegrationKeys.set(nil, for: IntegrationKeys.variable("todoist", "TODOIST_API_KEY"))
        }
        let listed = try #require(try await ask("kuvo/integrations").json["integrations"] as? [[String: Any]])
        #expect(listed.count == Integrations.all.count)
        #expect(listed.map { $0["kind"] as? String }.first == Integrations.Kind.allCases.first?.rawValue, "by kind, in the page's order")
        let todoist = try #require(listed.first { $0["id"] as? String == "todoist" })
        #expect(todoist["way"] as? String == "package")
        #expect((todoist["keys"] as? [[String: String]])?.map { $0["name"] } == ["TODOIST_API_KEY"])
        #expect(todoist["added"] as? Bool == false)

        let missing = try await ask("kuvo/integrations/todoist", method: "POST", body: [:])
        #expect(missing.status == 400, "it needs its key")
        let added = try await ask("kuvo/integrations/todoist", method: "POST", body: ["keys": ["TODOIST_API_KEY": "tok_123"]])
        #expect(added.status == 200)
        #expect((added.json["integration"] as? [String: Any])?["added"] as? Bool == true)
        #expect(IntegrationKeys.value(IntegrationKeys.variable("todoist", "TODOIST_API_KEY")) == "tok_123")
        #expect(config.value(at: MCPSettings.path + ["todoist"]) != nil)

        let browser = try #require(Integrations.all.first { if case .browser = $0.way { true } else { false } })
        #expect(try await ask("kuvo/integrations/\(browser.id)", method: "POST", body: [:]).status == 409)
        #expect(try await ask("kuvo/integrations/nothing", method: "POST", body: [:]).status == 404)

        // A settings file changed by hand so it can't be changed here: nothing's removed, and it says so.
        let written = try String(contentsOf: config.file, encoding: .utf8)
        try ("// mine\n" + written).write(to: config.file, atomically: true, encoding: .utf8)
        let refused = try await ask("kuvo/integrations/todoist", method: "DELETE")
        #expect(refused.status == 409)
        try written.write(to: config.file, atomically: true, encoding: .utf8)
        config.reload()
        #expect(IntegrationKeys.value(IntegrationKeys.variable("todoist", "TODOIST_API_KEY")) == "tok_123")

        #expect(try await ask("kuvo/integrations/todoist", method: "DELETE").status == 200)
        #expect(config.value(at: MCPSettings.path + ["todoist"]) == nil)
        #expect(IntegrationKeys.value(IntegrationKeys.variable("todoist", "TODOIST_API_KEY")) == nil, "its key goes with it")
    }

    /// What a machine gets: those it can run (not this Mac's own apps'), each with its settings
    /// there, its keys named in the machine's keys folder.
    @Test func aMachinesCatalog() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: MachineBox.integrationsJSON()) as? [String: Any])
        let entries = try #require(catalog["integrations"] as? [[String: Any]])
        #expect(!entries.contains { Integrations.macOnly.contains($0["id"] as? String ?? "") })
        let todoist = try #require(entries.first { $0["id"] as? String == "todoist" })
        #expect((todoist["variables"] as? [String: String])?["TODOIST_API_KEY"] == IntegrationKeys.variable("todoist", "TODOIST_API_KEY"))
        let environment = (todoist["settings"] as? [String: Any])?["environment"] as? [String: String]
        #expect(environment?["TODOIST_API_KEY"] == "{file:~/\(RemoteEngineInstaller.root)/box/keys/\(IntegrationKeys.variable("todoist", "TODOIST_API_KEY"))}")
    }
}
