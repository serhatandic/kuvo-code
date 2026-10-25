import Foundation
import KuvoLink
import OpenCodeKit
import SwiftUI
import Testing
@testable import KuvoCode

/// This Mac's engine settings kept by its box (PROTOCOL.md, "This Mac's box", `kuvo/config`): what
/// Settings shows is what the box reads from the engine's settings file, where it's always been,
/// and what Settings changes is written there; a phone's change shows here too, and open sessions
/// follow a change to the rules. A file with comments is left alone and said to be; the defaults
/// go in once; and while the box is stopped, Settings says so and comes back with it. The box is
/// the real `kuvo-link.js serve`; only the engine is a stand-in.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2))) struct SettingsOnBoxTests {
    init() { TestEnvironment.prepare() }

    static func rule(_ resource: String, _ effect: String = "deny") -> JSONValue {
        .object(["action": .string("shell"), "resource": .string(resource), "effect": .string(effect)])
    }

    @Test func whatSettingsChangesIsWrittenInTheMacsOwnFileAndEveryClientSeesIt() async throws {
        let box = try await SettingsBox(port: 47_920)
        defer { box.stop() }
        // As you left it, before boxes kept it: it stays where it is.
        try FileManager.default.createDirectory(at: SettingsBox.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"model": "anthropic/sonnet", "theme": "dark"}"#.utf8).write(to: SettingsBox.file)
        let app = AppModel()
        let config = app.engineConfig
        await config.refresh()
        #expect(config.isLoaded && config.problem == nil)
        #expect(config.string(["model"]).wrappedValue == "anthropic/sonnet", "Settings › General's model, as the file has it")

        // Changed as Settings' pages change them: a toggle, a new agent, a rule, a popular MCP
        // server's Add, a command.
        var rulesChanged = 0
        config.onRulesChanged = { rulesChanged += 1 }
        config.bool(["compaction", "auto"], default: true).wrappedValue = false
        config.set(.object(["mode": .string("subagent"), "description": .string("Reviews code")]), at: ["agents", "review"])
        config.setItems([Self.rule("git push *")], at: ["permissions"])
        MCPCatalog.add(try #require(MCPCatalog.servers.first { $0.id == "context7" }), to: config)
        config.set(.object(["template": .string("Ship it"), "description": .string("Ships")]), at: ["commands", "ship"])
        #expect(await config.settled() == nil)
        #expect(rulesChanged == 1)

        let disk = try SettingsBox.onDisk()
        #expect(disk["model"] as? String == "anthropic/sonnet" && disk["theme"] as? String == "dark", "what Settings doesn't show stays")
        #expect((disk["compaction"] as? [String: Bool]) == ["auto": false])
        #expect((disk["agents"] as? [String: Any])?["review"] as? [String: String] == ["mode": "subagent", "description": "Reviews code"])
        #expect((disk["permissions"] as? [[String: String]])?.map { $0["resource"] } == ["git push *"])
        let context7 = ((disk["mcp"] as? [String: Any])?["servers"] as? [String: Any])?["context7"] as? [String: Any]
        #expect(context7?["url"] as? String == "https://mcp.context7.com/mcp" && context7?["codemode"] as? Bool == false)
        #expect((disk["commands"] as? [String: Any])?["ship"] as? [String: String] == ["template": "Ship it", "description": "Ships"])

        // A phone reads the same, and changes the rules: here once the box says so (the engine's
        // `config.updated`), and open sessions follow.
        let phone = box.client
        let read = try await phone.value([String: JSONValue].self, "GET", "kuvo/config")
        #expect(read == config.settings)
        var changed = 0
        config.onChanged = { changed += 1 }
        let body = Data(#"{"changes": [{"path": ["permissions"], "value": [{"action": "shell", "resource": "docker *", "effect": "deny"}]}]}"#.utf8)
        #expect(try await phone.send("PATCH", "kuvo/config", body: body).status == 200)
        await config.refresh()
        #expect(config.permissionRules.map(\.resource) == ["docker *"])
        #expect(rulesChanged == 2)
        #expect(changed == 1)
        // And its popular servers, Chrome DevTools among them on a Mac, Context7 added.
        struct Listed: Decodable { struct Server: Decodable { var id: String; var added: Bool; var macOnly: Bool }; var servers: [Server] }
        let servers = try await phone.value(Listed.self, "GET", "kuvo/mcp/catalog").servers
        #expect(servers.count == MCPCatalog.servers.count)
        #expect(servers.first { $0.id == "context7" }?.added == true)
        #expect(servers.first { $0.id == "chrome-devtools" }?.macOnly == true)
    }

    @Test func aFileWithCommentsIsLeftAloneAndSaidToBe() async throws {
        let box = try await SettingsBox(port: 47_921)
        defer { box.stop() }
        let original = "{\n  // my model\n  \"model\": \"anthropic/sonnet\"\n}\n"
        try FileManager.default.createDirectory(at: SettingsBox.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(original.utf8).write(to: SettingsBox.file)
        let config = AppModel().engineConfig
        await config.refresh()
        // The file's problem alone, under Settings' own words for it, on its pages (read, as it is).
        #expect(config.problem == "It isn't plain JSON, so Kuvo Code leaves it alone. (Comments aren't supported here.)")
        #expect(config.isLoaded, "its pages show, with why it can't be changed")
        config.set(.string("openai/luna"), at: ["model"])
        #expect(await config.settled() != nil)
        #expect(try String(contentsOf: SettingsBox.file, encoding: .utf8) == original)

        // Fixed by hand: read again (Try Again), and yours to change.
        try Data(#"{"model": "anthropic/sonnet"}"#.utf8).write(to: SettingsBox.file)
        await config.refresh()
        #expect(config.problem == nil && config.value(at: ["model"]) == .string("anthropic/sonnet"))
    }

    /// Web search and bots' memory rule go in once, and stay out once you take them out.
    @Test func theDefaultsGoInOnceAndStayOut() async throws {
        let keys = ["engine.defaultsAdded", "engine.searchMovedToExa", "engine.botMemoryRuleAdded"]
        for key in keys { UserDefaults.standard.removeObject(forKey: key) }
        defer { for key in keys { UserDefaults.standard.removeObject(forKey: key) } }
        let box = try await SettingsBox(port: 47_922)
        defer { box.stop() }
        try FileManager.default.createDirectory(at: SettingsBox.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"model": "anthropic/sonnet", "permissions": [{"action": "shell", "resource": "npm test *", "effect": "allow"}]}"#.utf8).write(to: SettingsBox.file)
        let config = AppModel().engineConfig
        await config.addDefaults()
        let disk = try SettingsBox.onDisk()
        #expect(disk["websearch"] as? [String: String] == ["provider": "exa"])
        #expect(config.permissionRules == [PermissionRule(action: "shell", resource: "npm test *", effect: .allow), EngineConfig.botMemory], "joins your rules, at their end")
        #expect(config.changes.isEmpty, "Kuvo Code's own, not yours to apply elsewhere")

        // Taken out: they stay out.
        config.set(nil, at: ["websearch"])
        config.setItems([], at: ["permissions"])
        _ = await config.settled()
        await config.addDefaults()
        _ = await config.settled()
        #expect(try SettingsBox.onDisk()["websearch"] == nil)
        #expect(config.permissionRules.isEmpty)
    }

    /// The box stopped: Settings can't read this Mac's settings and says why, changes nothing,
    /// and reads them once it's started again (Try Again).
    @Test func whileTheBoxIsStoppedSettingsSaySoAndComeBackWithIt() async throws {
        let box = try await SettingsBox(port: 47_923)
        defer { box.stop() }
        try FileManager.default.createDirectory(at: SettingsBox.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"model": "anthropic/sonnet"}"#.utf8).write(to: SettingsBox.file)
        box.box.process.stop()
        let config = AppModel().engineConfig
        await config.refresh()
        #expect(!config.isLoaded)
        #expect(config.problem == "Its settings couldn't be read: Kuvo Code’s background service on this Mac isn’t running. Try again in a moment.")
        #expect(EngineConfig.knowsRules(on: nil) == false, "sessions wait for its rules")
        config.set(.string("openai/luna"), at: ["model"])
        #expect(try SettingsBox.onDisk()["model"] as? String == "anthropic/sonnet")

        await box.box.startAgain()
        await config.refresh()
        #expect(config.isLoaded && config.problem == nil)
        #expect(config.value(at: ["model"]) == .string("anthropic/sonnet"))
        // Running, then gone a moment: what was read stays shown, and a change says it didn't get there.
        box.box.process.stop()
        config.set(.string("openai/luna"), at: ["model"])
        #expect(await config.settled() != nil)
        #expect(config.value(at: ["model"]) == .string("anthropic/sonnet"))
        #expect(config.problem == nil, "still yours to change once it's back")
    }
}

/// "Also Apply to…": a change made on one computer's settings, made on another's too, and only
/// when you ask: the same changes go to the other box, which makes them as its own settings have
/// room for. A list of rules gets what was added and loses what was taken out, keeping the other's
/// own; an integration's key goes first, named where the other keeps its keys, unless it has its
/// own; what each computer keeps its own, what only a Mac runs and what the other doesn't have stay
/// here, and are said. Both boxes are the real `kuvo-link.js serve`: this Mac's and a machine's.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2))) struct AlsoApplyTests {
    init() { TestEnvironment.prepare() }

    static func rule(_ resource: String, _ effect: String = "deny") -> JSONValue {
        .object(["action": .string("shell"), "resource": .string(resource), "effect": .string(effect)])
    }

    @Test func changesHereAreMadeOnAMachineAsItHasRoomForThem() async throws {
        let mac = try await SettingsBox(port: 47_924)
        defer { mac.stop() }
        let machine = try await MachineTestBox(settings: ["permissions": [["action": "shell", "resource": "docker *", "effect": "deny"]], "shell": "/bin/bash"])
        defer { machine.stop() }
        let service = try #require(Integrations.all.first { $0.id == "todoist" })
        let key = IntegrationKeys.variable("todoist", "TODOIST_API_KEY")
        IntegrationKeys.set("tok_mac", for: key)
        defer { IntegrationKeys.set(nil, for: key) }

        try FileManager.default.createDirectory(at: SettingsBox.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"agents": {"review": {"mode": "subagent", "model": "a/b"}}}"#.utf8).write(to: SettingsBox.file)
        let config = AppModel().engineConfig
        await config.refresh()
        // Made on this Mac in Settings: a rule, an integration with its key, this Mac's shell, a
        // field of an agent the machine hasn't got, Chrome DevTools (this Mac's own Chrome).
        config.setItems([Self.rule("git push *")], at: ["permissions"])
        config.set(Integrations.settings(for: service), at: MCPSettings.path + ["todoist"])
        config.set(.string("/bin/zsh"), at: ["shell"])
        config.set(.string("c/d"), at: ["agents", "review", "model"])
        MCPCatalog.add(try #require(MCPCatalog.servers.first { $0.id == "chrome-devtools" }), to: config)
        #expect(await config.settled() == nil)

        let (outcome, settings) = try await AlsoApply.apply(config.changes, from: mac.client, to: machine.client)
        #expect(outcome.applied)
        #expect(outcome.leftOut == ["the agent review"])
        #expect(outcome.kept == ["shell"])
        #expect(outcome.macOnly == ["Chrome DevTools"])
        let there = try machine.onDisk()
        #expect((there["permissions"] as? [[String: String]])?.map { $0["resource"] } == ["docker *", "git push *"], "joins the machine's own")
        #expect(there["shell"] as? String == "/bin/bash", "its own shell stays")
        #expect(there["agents"] == nil)
        let servers = (there["mcp"] as? [String: Any])?["servers"] as? [String: Any]
        #expect(servers?["chrome-devtools"] == nil)
        let environment = (servers?["todoist"] as? [String: Any])?["environment"] as? [String: String]
        #expect(environment?.values.contains { $0.hasSuffix("/box/keys/\(key)}") } == true, "its key named where the machine keeps its keys")
        #expect(machine.key(key) == "tok_mac", "and the key with it")
        #expect(settings["permissions"]?.array?.count == 2, "what the machine's page shows at once")

        // Applied again with a key of the machine's own (another account's): that stays.
        try Data("tok_lab".utf8).write(to: machine.folder.appending(path: "box/keys/\(key)"))
        _ = try await AlsoApply.apply(config.changes, from: mac.client, to: machine.client)
        #expect(machine.key(key) == "tok_lab")

        // Only what each keeps its own: not applied there, and nothing changed.
        let own = EngineConfig.Change(id: 1, path: ["shell"], before: nil, after: .string("/bin/fish"))
        let (stayed, _) = try await AlsoApply.apply([own], from: mac.client, to: machine.client)
        #expect(!stayed.applied && stayed.kept == ["shell"])
    }

    @Test func changesOnAMachineAreMadeHereWithTheirKeys() async throws {
        let mac = try await SettingsBox(port: 47_925)
        defer { mac.stop() }
        let machine = try await MachineTestBox()
        defer { machine.stop() }
        let key = IntegrationKeys.variable("todoist", "TODOIST_API_KEY")
        defer { IntegrationKeys.set(nil, for: key) }
        let config = AppModel().engineConfig
        await config.refresh()
        config.setItems([Self.rule("rm *")], at: ["permissions"])
        #expect(await config.settled() == nil)

        // Made in the machine's own Settings tab.
        let theirs = EngineConfig(remote: BoxSettings(client: machine.client))
        await theirs.refresh()
        theirs.set(.object(["template": .string("Ship it")]), at: ["commands", "ship"])
        theirs.setItems([Self.rule("git push *")], at: ["permissions"])
        let server: JSONValue = .object(["type": .string("local"), "environment": .object(["TOKEN": .string("{file:~/.kuvo-code/box/keys/\(key)}")])])
        theirs.set(server, at: MCPSettings.path + ["todoist"])
        #expect(await theirs.settled() == nil)
        try Data("tok_lab".utf8).write(to: machine.folder.appending(path: "box/keys/\(key)"))

        _ = try await AlsoApply.apply(theirs.changes, from: machine.client, to: mac.client)
        let here = try SettingsBox.onDisk()
        #expect((here["commands"] as? [String: Any])?["ship"] as? [String: String] == ["template": "Ship it"])
        #expect((here["permissions"] as? [[String: String]])?.map { $0["resource"] } == ["rm *", "git push *"])
        let token = ((((here["mcp"] as? [String: Any])?["servers"] as? [String: Any])?["todoist"] as? [String: Any])?["environment"] as? [String: String])?["TOKEN"]
        #expect(token == IntegrationKeys.reference(key), "named where this Mac's engine reads its keys")
        #expect(IntegrationKeys.value(key) == "tok_lab", "in this Mac's Keychain")
    }

    @Test func aChangeUndoneIsNothingToApply() async throws {
        let config = EngineConfig.inMemory(["snapshots": .bool(true)])
        config.set(.bool(false), at: ["snapshots"])
        config.set(.bool(true), at: ["snapshots"])
        #expect(config.changes.count == 2)
        #expect(AlsoApply.net(config.changes).isEmpty)
        config.set(.string("anthropic/sonnet"), at: ["model"])
        #expect(AlsoApply.net(config.changes).map(\.path) == [["model"]])
        // What's applied there isn't a change of its own, to offer back.
        let there = EngineConfig.inMemory()
        there.set([(["model"], .string("anthropic/sonnet"))], noted: false)
        #expect(there.changes.isEmpty)
    }

    /// Where a change couldn't be made, said once per reason, with the computers it's the reason
    /// for; only why when the title says where already.
    @Test func whereItWasntMadeIsSaidOncePerReason() {
        let away = AlsoApply.Failure.unread(connected: false)
        let missed: [(name: String, error: any Error)] = [("lab", away), ("box", away), ("pi", AlsoApply.Failure.unread(connected: true))]
        #expect(AlsoApply.failures(missed, titled: false) == "Not applied on lab and box: they aren’t connected. Not applied on pi: its settings couldn’t be read.")
        #expect(AlsoApply.failures(missed, titled: true) == "lab and box aren’t connected. pi’s settings couldn’t be read.")
        #expect(AlsoApply.failures([("lab", away)], titled: false) == "Not applied on lab: it isn’t connected.")
    }
}
