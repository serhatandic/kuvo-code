import Foundation
import KuvoLink
import OpenCodeKit
import Testing
import WebKit
@testable import KuvoCode

/// Settings › Integrations on this Mac, as the page does it, through this Mac's box (the real
/// `kuvo-link.js serve`): Add Key… adds it with its key, listed as added with how it's doing;
/// Change Key… shows the key it keeps; Remove… takes it out with its key. The key stays in your
/// Keychain (the test copy's own, in memory) and the file the engine reads, which the box reaches
/// through the app; never in the box's folder. With the box stopped, the page says so, and once
/// it's back, it works again.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct IntegrationsOnBoxTests {
    let app = AppModel()
    let key = IntegrationKeys.variable("todoist", "TODOIST_API_KEY")

    init() {
        TestEnvironment.prepare()
    }

    @Test func addedWithItsKeyShownAndRemovedThroughThisMacsBox() async throws {
        let box = try await SettingsBox(port: 47_931)
        defer {
            box.stop()
            IntegrationKeys.set(nil, for: key)
        }
        // Its engine, answering how its servers are doing.
        box.engine.on("GET", "/api/mcp", json: ["data": []])
        await app.engineConfig.refresh()
        let listed = try await app.integrations(on: .mac)
        #expect(listed.engineDown == nil)
        let todoist = try #require(listed.integrations.first { $0.id == "todoist" })
        #expect(!todoist.added && todoist.takesKeys && todoist.keysSaved == false, "Add Key…")
        #expect(listed.integrations.contains { $0.id == "apple-calendar" }, "this Mac's own apps' too")

        let added = try await app.addIntegration(todoist, keys: ["TODOIST_API_KEY": "tok_page"], on: .mac)
        #expect(added.added && added.keysSaved == true && added.health == .starting)
        #expect(IntegrationKeys.value(key) == "tok_page", "in your Keychain")
        #expect((try? String(contentsOf: IntegrationKeys.folder.appending(path: key), encoding: .utf8)) == "tok_page", "where the engine reads it")
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.home.appending(path: "box/keys").path), "never in the box's folder")
        // The page's other pages see it too (MCP Servers, Also Apply).
        try await until { app.engineConfig.value(at: MCPSettings.path + ["todoist"]) != nil }
        #expect(try await app.integrations(on: .mac).integrations.first { $0.id == "todoist" }?.added == true)

        #expect(await app.integrationKeys(added, on: .mac) == ["TODOIST_API_KEY": "tok_page"], "Change Key… shows the one it keeps")

        // Without its key, Connect is turned away as the box says.
        IntegrationKeys.set(nil, for: key)
        await #expect(throws: BoxRefusal.self) { try await app.addIntegration(todoist, on: .mac) }

        #expect(await app.removeIntegration("todoist", on: .mac) == nil)
        #expect(try await app.integrations(on: .mac).integrations.first { $0.id == "todoist" }?.added == false)
        try await until { app.engineConfig.value(at: MCPSettings.path + ["todoist"]) == nil }
        #expect(await app.removeIntegration("todoist", on: .mac) == nil, "one gone already: nothing to take away")
    }

    /// With its engine not running, what's added isn't called starting: the box says the engine is
    /// down, and only one turned off says so still.
    @Test func withItsEngineDownNothingIsCalledStarting() async throws {
        let box = try await SettingsBox(port: 47_934)
        defer {
            box.stop()
            IntegrationKeys.set(nil, for: key)
        }
        await app.engineConfig.refresh()
        let todoist = try #require(try await app.integrations(on: .mac).integrations.first { $0.id == "todoist" })
        try await app.addIntegration(todoist, keys: ["TODOIST_API_KEY": "tok_down"], on: .mac)
        let listed = try await app.integrations(on: .mac)
        #expect(listed.engineDown == true)
        #expect(listed.integrations.first { $0.id == "todoist" }?.health == nil)
        #expect(await app.removeIntegration("todoist", on: .mac) == nil)
    }

    /// Whether this Mac's browser is signed in to a site the agent uses there, as this Mac's box
    /// says it for every client: a sign-in there shows at once, without reading every cookie each
    /// time it's asked.
    @Test func aSiteSignedInToInThisMacsBrowserShows() async throws {
        let box = try await SettingsBox(port: 47_935)
        defer { box.stop() }
        func linkedIn() async throws -> Bool? { try await app.integrations(on: .mac).integrations.first { $0.id == "linkedin" }?.siteSignedIn }
        #expect(try await linkedIn() == false)
        let store = WKWebsiteDataStore.default().httpCookieStore
        let cookie = try #require(HTTPCookie(properties: [.domain: ".linkedin.com", .path: "/", .name: "li_at", .value: "test", .expires: Date.now.addingTimeInterval(3600)]))
        let before = SiteSignIns.shared.macChanges
        await store.setCookie(cookie)
        try await until { SiteSignIns.shared.macChanges > before }
        #expect(try await linkedIn() == true)
        await store.deleteCookie(cookie)
    }

    @Test func withThisMacsBoxStoppedThePageSaysSoAndWorksOnceItsBack() async throws {
        let box = try await SettingsBox(port: 47_932)
        defer { box.stop() }
        await app.engineConfig.refresh()
        box.box.process.stop()
        do {
            _ = try await app.integrations(on: .mac)
            Issue.record("read with no box")
        } catch {
            #expect(error.localizedDescription.contains("background service on this Mac isn’t running"), "\(error.localizedDescription)")
        }
        let refused = await app.removeIntegration("todoist", on: .mac)
        #expect(refused?.contains("isn’t running") == true)

        await box.box.startAgain()
        #expect(try await app.integrations(on: .mac).integrations.contains { $0.id == "todoist" })
    }
}
