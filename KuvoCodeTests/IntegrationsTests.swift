import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › Integrations: a key you bring never goes into the engine's settings file, only the
/// file the engine reads it from (a bot's own key, its own file; on a machine, a file in its
/// folder there); and the agent, going to an integration's site in the browser, is pointed to its
/// tools.
@MainActor
@Suite struct IntegrationsTests {
    let config: EngineConfig

    init() throws {
        TestEnvironment.prepare()
        config = EngineConfig.inMemory()
    }

    private var withKeys: [Integrations.Service] { Integrations.all.filter { !Integrations.keys(of: $0.way).isEmpty } }

    /// The keys a server's settings name (`KUVO_KEY_…`).
    private func keyNames(in value: JSONValue) -> [String] {
        let text = text(value)
        return text.matches(of: /KUVO_KEY_[A-Z0-9_]+/).map { String($0.output) }
    }

    private func text(_ value: JSONValue?) -> String {
        value.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    /// Every integration that takes a key names it by its file, never by value or variable.
    @Test func keysAreNamedByTheirFiles() throws {
        #expect(!withKeys.isEmpty)
        for service in withKeys {
            let settings = text(Integrations.settings(for: service))
            let names = keyNames(in: try #require(Integrations.settings(for: service)))
            #expect(!names.isEmpty, "\(service.id) names no key")
            for name in names {
                #expect(settings.contains(IntegrationKeys.reference(name).replacingOccurrences(of: "/", with: "\\/")) || settings.contains(IntegrationKeys.reference(name)))
            }
            #expect(!settings.contains("{env:"))
            #expect(Integrations.settings(for: service)?["codemode"] == .bool(false))
        }
    }

    /// A bot's own key is its own file, apart from the shared one.
    @Test func aBotsOwnKey() throws {
        let service = try #require(withKeys.first)
        let shared = Set(keyNames(in: try #require(Integrations.settings(for: service))))
        let bots = Set(keyNames(in: try #require(Integrations.settings(for: service, bot: "bot_abc"))))
        #expect(shared.isDisjoint(with: bots))
        #expect(bots.allSatisfy { IntegrationKeys.isBots($0) && IntegrationKeys.variables(ofBot: "bot_abc", in: [$0]) == [$0] })
    }

    /// On a machine, the keys are read from its own folder there.
    @Test func onAMachineTheKeysAreItsFiles() throws {
        let service = try #require(withKeys.first)
        let settings = try #require(Integrations.settings(for: service))
        let machine = text(try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: Integrations.keyVariables(in: JSONSerialization.jsonObject(with: JSONEncoder().encode(settings))))))
        #expect(machine.contains("~\\/.kuvo-code\\/keys\\/") || machine.contains("~/.kuvo-code/keys/"))
        #expect(!machine.contains(IntegrationKeys.folder.path))
    }

    /// Added on a machine's own page: its keys are read from that machine's own keys' folder, which
    /// its settings name, never this Mac's; and integrations that use a Mac's own apps aren't
    /// offered there.
    @Test func addedOnAMachineItReadsItsKeysThere() throws {
        for service in withKeys where !Integrations.macOnly.contains(service.id) {
            let settings = text(Integrations.settings(for: service, on: "lab"))
            #expect(!settings.contains(IntegrationKeys.folder.path), "\(service.id) names this Mac's folder")
            for name in keyNames(in: try #require(Integrations.settings(for: service, on: "lab"))) {
                let reference = IntegrationKeys.reference(name, on: "lab")
                #expect(reference == "{file:~/.kuvo-code/box/keys/\(name)}" || reference.contains("/box/keys/\(name)}"))
                #expect(settings.contains(reference) || settings.contains(reference.replacingOccurrences(of: "/", with: "\\/")))
            }
        }
        #expect(!Integrations.macOnly.isEmpty)
    }

    /// The agent asking the browser for an integration's site is pointed to its tools; another
    /// site, or one that only looks like it, isn't.
    @Test func anIntegrationsSiteIsPointedToItsTools() throws {
        let ids = withKeys.map(\.id) + Integrations.all.filter { if case .official = $0.way { true } else { false } }.map(\.id)
        let sites = Integrations.sites(ids)
        let site = try #require(sites.first)
        let host = try #require(site.hosts.first)
        #expect(Integrations.site(of: host + (site.path ?? "") + "/anything", in: sites)?.id == site.id)
        #expect(Integrations.site(of: "https://sub." + host + (site.path ?? ""), in: sites)?.id == site.id)
        #expect(Integrations.site(of: "https://not" + host, in: sites) == nil)
        #expect(Integrations.site(of: "file:///" + host, in: sites) == nil)
        #expect(Integrations.site(of: "https://example.org", in: sites) == nil)
    }

    /// Signed in to a site by its cookie, while it lasts.
    @Test func signedInWhileTheCookieLasts() {
        let soon = Date.now.addingTimeInterval(3600), gone = Date.now.addingTimeInterval(-60)
        #expect(Integrations.isSignedIn("linkedin", cookies: [(".www.linkedin.com", "li_at", soon)]) == true)
        #expect(Integrations.isSignedIn("linkedin", cookies: [("linkedin.com", "li_at", gone)]) == false)
        #expect(Integrations.isSignedIn("linkedin", cookies: [("notlinkedin.com", "li_at", soon)]) == false)
        #expect(Integrations.isSignedIn("unknown-service", cookies: []) == nil)
    }
}
