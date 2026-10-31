import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Settings › General › Bring Over from opencode: what you set up in opencode comes over once,
/// nothing of yours is replaced, and bringing it over again finds nothing new.
@MainActor
@Suite struct OpencodeImportTests {
    let folder: URL
    let config: EngineConfig
    /// Never called: these plans bring no API keys.
    let api = OpenCodeAPI(endpoint: ServerEndpoint(url: URL(string: "http://127.0.0.1:9")!, password: nil))

    init() throws {
        TestEnvironment.prepare()
        folder = AppInfo.testRoot.appending(path: "Import/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        config = EngineConfig.inMemory()
    }

    /// opencode's settings as the engine reads them, naming a file of instructions beside them.
    private func opencodeSettings() throws -> [String: JSONValue] {
        let prompt = folder.appending(path: "prompt.md")
        try Data("Be brief.\n".utf8).write(to: prompt)
        return [
            "model": .string("anthropic/claude-sonnet-5-5"),
            "agents": .object(["reviewer": .object(["prompt": .string("{file:\(prompt.path)}")])]),
            "commands": .object(["ship": .object(["template": .string("Ship it")])]),
            "mcp": .object(["servers": .object([
                "local-db": .object(["type": .string("local"), "command": .array([.string("db-mcp")])]),
                // Named as one of Kuvo Code's integrations: kept apart from it.
                "github": .object(["type": .string("remote"), "url": .string("https://example.com/mcp")]),
            ])]),
            "instructions": .array([.string("{file:\(prompt.path)}")]),
            "plugins": .array([.string("opencode-wakatime")]),
            "permissions": .array([.object(["permission": .string("bash"), "pattern": .string("rm *"), "action": .string("deny")])]),
        ]
    }

    @Test func bringingOverTwiceFindsNothingNew() async throws {
        let read = try opencodeSettings()
        var plan = OpencodeImport.Plan()
        plan.settings = OpencodeImport.missing(from: read, in: config.settings)
        #expect(!plan.isEmpty)
        let brought = await OpencodeImport.apply(plan, to: config, api: api)
        #expect(brought.count > 0)

        let again = OpencodeImport.missing(from: read, in: config.settings)
        #expect(again.isEmpty, "offered again: \(again.keys.sorted())")
        var second = OpencodeImport.Plan()
        second.settings = again
        let before = config.settings
        _ = await OpencodeImport.apply(second, to: config, api: api)
        #expect(config.settings == before)
    }

    /// A file opencode's settings name is copied into Kuvo Code's own folder and named there, so
    /// they don't depend on opencode's folder.
    @Test func namedFilesAreKuvoCodesOwnCopies() async throws {
        var plan = OpencodeImport.Plan()
        plan.settings = OpencodeImport.missing(from: try opencodeSettings(), in: config.settings)
        _ = await OpencodeImport.apply(plan, to: config, api: api)
        let instruction = try #require(config.value(at: ["instructions"])?.array?.first?.string)
        let copy = OpencodeImport.filesFolder.path
        #expect(instruction.hasPrefix("{file:\(copy)/"))
        let path = String(instruction.dropFirst("{file:".count).dropLast())
        #expect(FileManager.default.contents(atPath: path).map { String(decoding: $0, as: UTF8.self) } == "Be brief.\n")
    }

    /// What you set here stays: your model, your agent of the same name, your MCP server.
    @Test func nothingOfYoursIsReplaced() async throws {
        config.set([
            (["model"], .string("openai/gpt-6-luna")),
            (["agents", "reviewer"], .object(["prompt": .string("Mine")])),
            (MCPSettings.path + ["local-db"], .object(["type": .string("local"), "command": .array([.string("mine")])])),
        ])
        var plan = OpencodeImport.Plan()
        plan.settings = OpencodeImport.missing(from: try opencodeSettings(), in: config.settings)
        _ = await OpencodeImport.apply(plan, to: config, api: api)
        #expect(config.value(at: ["model"])?.string == "openai/gpt-6-luna")
        #expect(config.value(at: ["agents", "reviewer", "prompt"])?.string == "Mine")
        #expect(config.value(at: MCPSettings.path + ["local-db", "command"])?.array?.first?.string == "mine")
        // opencode's "github" server comes over by a name of its own, not as the integration.
        #expect(config.value(at: MCPSettings.path + ["github-opencode"]) != nil)
        #expect(config.value(at: MCPSettings.path + ["github"]) == nil)
    }

    /// Your permission rules stay last, so they still win over the ones brought over.
    @Test func yourPermissionRulesStillWin() async throws {
        let mine = JSONValue.object(["permission": .string("bash"), "pattern": .string("*"), "action": .string("ask")])
        config.set(.array([mine]), at: ["permissions"])
        var plan = OpencodeImport.Plan()
        plan.settings = OpencodeImport.missing(from: try opencodeSettings(), in: config.settings)
        _ = await OpencodeImport.apply(plan, to: config, api: api)
        #expect(config.value(at: ["permissions"])?.array?.last == mine)
        #expect(config.value(at: ["permissions"])?.array?.count == 2)
    }

    /// The box refuses the settings (its file can't be written): they aren't counted as brought
    /// over, you're told why, and the engine isn't started again for nothing.
    @Test func settingsTheBoxRefusesArentSaidToHaveComeOver() async throws {
        let refusing = EngineConfig(remote: RefusingSettings())
        refusing.took([:])
        var plan = OpencodeImport.Plan()
        plan.settings = OpencodeImport.missing(from: try opencodeSettings(), in: refusing.settings)
        #expect(!plan.isEmpty)

        let (note, renews) = await OpencodeImport.bringOver(plan, to: refusing, api: api, name: { $0 })
        #expect(note.hasPrefix("Nothing came over"), "said: \(note)")
        #expect(note.contains("didn’t come over") && note.contains("isn’t writable"), "said: \(note)")
        #expect(!renews)
    }
}

/// A box that reads its settings but can't write them.
private struct RefusingSettings: RemoteSettings {
    struct NotWritable: LocalizedError {
        var errorDescription: String? { "The settings file isn’t writable." }
    }

    func read() async throws -> [String: JSONValue] { [:] }
    func change(_ changes: [(path: [String], value: JSONValue?)], was: [JSONValue?]) async throws -> [String: JSONValue] { throw NotWritable() }
}
