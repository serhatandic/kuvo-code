import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Integrations on this Mac, as its box answers it for every client (a phone through
/// the link, Settings through `BoxClient`): each listed by kind, with how it's added and what keys
/// it takes; one added with its keys, as Add Key… and Connect do, and removed with them; one used
/// on its site, or without the keys it needs, turned away. Its keys stay in your Keychain (here the
/// test copy's own, in memory), which the box reaches through the app, and in the files the engine
/// reads, never in the box's folder. And the catalog a machine gets, for a phone to do the same
/// there with this Mac closed.
@MainActor
@Suite(.serialized) struct PhoneIntegrationsTests {
    let app = AppModel()
    let link = PhoneLink()
    let todoist = IntegrationKeys.variable("todoist", "TODOIST_API_KEY")

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
        for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: "http://127.0.0.1:47998/")!, password: "test", agents: nil) {
            switch part {
            case .head(let code, _): status = code
            case .body(let chunk): answer += chunk
            }
        }
        return (status, (try? JSONSerialization.jsonObject(with: answer) as? [String: Any]) ?? [:])
    }

    @Test func aPhoneAddsAndRemovesOneOfThisMacs() async throws {
        let box = try await SettingsBox(port: 47_926)
        defer { box.stop() }
        let config = app.config(for: .mac)
        await config.refresh()
        let file = try #require(config.file)
        defer { IntegrationKeys.set(nil, for: todoist) }
        let listed = try #require(try await ask("kuvo/integrations").json["integrations"] as? [[String: Any]])
        #expect(listed.map { $0["id"] as? String } == Integrations.all.map(\.id), "every one, this Mac's own apps' too, in the page's order")
        #expect(listed.first?["kind"] as? String == Integrations.Kind.allCases.first?.rawValue, "by kind")
        #expect(listed.first { $0["id"] as? String == "apple-calendar" }?["macOnly"] as? Bool == true)
        let entry = try #require(listed.first { $0["id"] as? String == "todoist" })
        #expect(entry["way"] as? String == "package")
        #expect((entry["keys"] as? [[String: String]])?.map { $0["name"] } == ["TODOIST_API_KEY"])
        #expect(entry["added"] as? Bool == false)

        let missing = try await ask("kuvo/integrations/todoist", method: "POST", body: [:])
        #expect(missing.status == 400, "it needs its key")
        let added = try await ask("kuvo/integrations/todoist", method: "POST", body: ["keys": ["TODOIST_API_KEY": "tok_123"]])
        #expect(added.status == 200)
        #expect((added.json["integration"] as? [String: Any])?["added"] as? Bool == true)
        #expect(IntegrationKeys.value(todoist) == "tok_123", "in your Keychain")
        #expect((try? String(contentsOf: IntegrationKeys.folder.appending(path: todoist), encoding: .utf8)) == "tok_123", "and in the file the engine reads it from")
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.appending(path: "box/keys").path), "never in the box's folder")
        await config.refresh()
        let environment = config.value(at: MCPSettings.path + ["todoist", "environment"])?.object
        #expect(environment?["TODOIST_API_KEY"]?.string == IntegrationKeys.reference(todoist), "named where this Mac's engine reads it")

        let browser = try #require(Integrations.all.first { if case .browser = $0.way { true } else { false } })
        #expect(try await ask("kuvo/integrations/\(browser.id)", method: "POST", body: [:]).status == 409)
        #expect(try await ask("kuvo/integrations/nothing", method: "POST", body: [:]).status == 404)

        // A settings file changed by hand so it can't be changed here: nothing's removed, and it says so.
        let written = try String(contentsOf: file, encoding: .utf8)
        try ("// mine\n" + written).write(to: file, atomically: true, encoding: .utf8)
        #expect(try await ask("kuvo/integrations/todoist", method: "DELETE").status == 409)
        try written.write(to: file, atomically: true, encoding: .utf8)
        #expect(IntegrationKeys.value(todoist) == "tok_123")

        #expect(try await ask("kuvo/integrations/todoist", method: "DELETE").status == 200)
        await config.refresh()
        #expect(config.value(at: MCPSettings.path + ["todoist"]) == nil)
        #expect(IntegrationKeys.value(todoist) == nil, "its key goes with it")
        #expect(!FileManager.default.fileExists(atPath: IntegrationKeys.folder.appending(path: todoist).path), "and the engine's file")
    }

    /// This Mac's integrations' keys, from a phone: set, read, listed and removed in the Keychain
    /// through its box, and a bot's own or anything that isn't a key's name never touched.
    @Test func integrationsKeysFromAPhone() async throws {
        let box = try await SettingsBox(port: 47_933)
        defer { box.stop() }
        let name = "KUVO_KEY_PHONETEST_TOKEN"
        let bots = name + "__BOT_A"
        IntegrationKeys.set("theirs", for: bots)
        defer {
            IntegrationKeys.set(nil, for: name)
            IntegrationKeys.set(nil, for: bots)
        }
        #expect(try await ask("kuvo/keys/\(name)").status == 404)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: ["value": "ghp_phone"]).status == 200)
        #expect(IntegrationKeys.value(name) == "ghp_phone")
        #expect(try await ask("kuvo/keys/\(name)").json["value"] as? String == "ghp_phone")
        let listed = try #require(try await ask("kuvo/keys").json["keys"] as? [String])
        #expect(listed.contains(name) && !listed.contains(bots), "a bot's own isn't among them")
        #expect(try await ask("kuvo/keys/\(bots)", method: "PUT", body: ["value": "x"]).status == 400)
        #expect(try await ask("kuvo/keys/HOME", method: "PUT", body: ["value": "x"]).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "PUT", body: ["value": ""]).status == 400)
        #expect(try await ask("kuvo/keys/\(name)", method: "DELETE").status == 200)
        #expect(IntegrationKeys.value(name) == nil)
        #expect(IntegrationKeys.value(bots) == "theirs", "untouched")
    }

    /// One turned off in MCP Servers says so (`disabled`, "Off" in Settings), not that it's
    /// starting, so a phone doesn't wait for a server that won't start; turned on again while the
    /// engine still says it's off, it's starting.
    @Test func oneTurnedOffSaysSoAndTurnedOnIsStarting() async throws {
        let box = try await SettingsBox(port: 47_927)
        defer { box.stop() }
        let config = app.config(for: .mac)
        await config.refresh()
        let service = try #require(Integrations.all.first { if case .official = $0.way { true } else { false } })
        box.engine.on("GET", "/api/mcp", json: ["data": [["name": service.id, "status": ["status": "disabled"]]]])
        config.set(.object(["type": .string("remote"), "url": .string("https://example.invalid/mcp"), "disabled": .bool(true)]), at: MCPSettings.path + [service.id])
        #expect(await config.settled() == nil)
        func health() async throws -> String? {
            let listed = try #require(try await ask("kuvo/integrations").json["integrations"] as? [[String: Any]])
            return listed.first { $0["id"] as? String == service.id }?["health"] as? String
        }
        #expect(try await health() == "disabled")
        Integrations.turnOn(service.id, in: config)
        #expect(await config.settled() == nil)
        #expect(try await health() == "starting", "the engine hasn't read it yet")
    }

    /// What a machine gets: those it can run (not this Mac's own apps'), each with its settings
    /// there, its keys named in the machine's keys folder; and this Mac's own box, all of them with
    /// this Mac's paths.
    @Test func eachBoxsCatalog() throws {
        let catalog = try #require(try JSONSerialization.jsonObject(with: MachineBox.integrationsJSON()) as? [String: Any])
        let entries = try #require(catalog["integrations"] as? [[String: Any]])
        #expect(!entries.contains { Integrations.macOnly.contains($0["id"] as? String ?? "") })
        let entry = try #require(entries.first { $0["id"] as? String == "todoist" })
        #expect((entry["variables"] as? [String: String])?["TODOIST_API_KEY"] == todoist)
        let environment = (entry["settings"] as? [String: Any])?["environment"] as? [String: String]
        #expect(environment?["TODOIST_API_KEY"] == "{file:~/\(RemoteEngineInstaller.root)/box/keys/\(todoist)}")
        #expect(entries.first { $0["id"] as? String == "microsoft-365" }?["signInFile"] as? String == "token-cache.json", "where its sign-in is, once it's made")

        let mac = try #require(try JSONSerialization.jsonObject(with: MachineBox.integrationsJSON(forMac: true)) as? [String: Any])
        let here = try #require(mac["integrations"] as? [[String: Any]])
        #expect(here.map { $0["id"] as? String } == Integrations.all.map(\.id))
        let mine = try #require(here.first { $0["id"] as? String == "todoist" })
        #expect(((mine["settings"] as? [String: Any])?["environment"] as? [String: String])?["TODOIST_API_KEY"] == IntegrationKeys.reference(todoist))
    }
}
