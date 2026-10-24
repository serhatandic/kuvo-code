import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The engine's settings file, which you can also edit by hand: one Kuvo Code can't read is left
/// alone; a link to it (from a dotfiles folder) stays a link; the defaults (web search, bots'
/// memory rule) go in once, as lines at its end in the file's own layout, and stay out once you
/// take them out.
@MainActor
@Suite(.serialized) struct EngineSettingsFileTests {
    let folder: URL
    var file: URL { folder.appending(path: "opencode.json") }

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "EngineSettings/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for key in ["engine.defaultsAdded", "engine.searchMovedToExa", "engine.botMemoryRuleAdded"] { UserDefaults.standard.removeObject(forKey: key) }
    }

    private func text() -> String { (try? String(contentsOf: file, encoding: .utf8)) ?? "" }

    /// With comments (not plain JSON): said, and never written over.
    @Test func aFileItCantReadIsLeftAlone() throws {
        let original = "{\n  // my model\n  \"model\": \"anthropic/sonnet\"\n}\n"
        try Data(original.utf8).write(to: file)
        let config = EngineConfig(file: file)
        #expect(config.problem != nil)
        config.set(.string("openai/luna"), at: ["model"])
        config.addDefaults()
        #expect(text() == original)
    }

    /// A link to the file (a dotfiles folder): saved through it, and still a link.
    @Test func aLinkStaysALink() throws {
        let real = folder.appending(path: "dotfiles/opencode.json")
        try FileManager.default.createDirectory(at: real.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: real)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: real)
        let config = EngineConfig(file: file)
        config.set(.string("openai/luna"), at: ["model"])
        #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: file.path)) != nil)
        #expect(String(decoding: try Data(contentsOf: real), as: UTF8.self).contains("openai/luna"))
    }

    /// Web search and bots' memory rule go in once, as lines at the end, the rest of the file as
    /// you wrote it.
    @Test func theDefaultsGoInOnceInYourLayout() throws {
        let original = "{\r\n    \"model\": \"anthropic/sonnet\",\r\n    \"zzz\": 1\r\n}\r\n"
        try Data(original.utf8).write(to: file)
        let config = EngineConfig(file: file)
        config.addDefaults()
        let added = text()
        #expect(added.hasPrefix("{\r\n    \"model\": \"anthropic/sonnet\",\r\n    \"zzz\": 1,\r\n    \"websearch\": {\"provider\": \"exa\"},\r\n    \"permissions\": "))
        #expect(config.permissionRules == [EngineConfig.botMemory])
        // Taken out: they stay out.
        config.set(nil, at: ["websearch"])
        config.set(nil, at: ["permissions"])
        config.addDefaults()
        #expect(config.value(at: ["websearch"]) == nil)
        #expect(config.permissionRules.isEmpty)
    }

    /// Bots' memory rule joins the rules you have, once, as a rule of Settings › Permissions.
    @Test func botsMemoryRuleJoinsYourRules() throws {
        try Data(#"{"permissions": [{"action": "shell", "resource": "npm test *", "effect": "allow"}]}"#.utf8).write(to: file)
        let config = EngineConfig(file: file)
        config.addDefaults()
        #expect(config.permissionRules == [PermissionRule(action: "shell", resource: "npm test *", effect: .allow), EngineConfig.botMemory])
    }

    /// Taking out a setting takes out what it leaves empty.
    @Test func anEmptiedSectionGoes() throws {
        let config = EngineConfig(file: file)
        config.set(.bool(false), at: ["compaction", "auto"])
        #expect(config.value(at: ["compaction", "auto"]) == .bool(false))
        config.set(nil, at: ["compaction", "auto"])
        #expect(config.value(at: ["compaction"]) == nil)
        #expect(!text().contains("compaction"))
    }
}
