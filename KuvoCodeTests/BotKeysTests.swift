import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot's own key for an integration (its own GitHub token, say) stays that bot's: only its
/// folder's settings name it, readable by you alone, with what else that file says kept; no other
/// bot's folder, nor what a machine's engine is given, names it; taken away, it goes and the
/// folder's own settings stay. A bot working in a project uses the keys your sessions there use.
/// The keys are in the test copy's own Keychain items.
@MainActor
@Suite(.serialized) struct BotKeysTests {
    let root = AppInfo.testRoot.appending(path: "BotKeys-\(UUID().uuidString.prefix(6))")
    let app = AppModel()

    private func bot(_ id: String, project: String? = nil) throws -> Bot {
        let folder = root.appending(path: id).path(percentEncoded: false)
        try FileManager.default.createDirectory(atPath: folder + "/workspace", withIntermediateDirectories: true)
        var json: [String: Any] = ["id": id, "name": id, "job": "", "instructions": "", "jobInMemory": true,
                                   "look": ["color": "mint", "shape": "round", "face": "calm"], "folder": folder,
                                   "sessionID": "ses_" + id, "created": "2026-10-21T09:00:00Z"]
        if let project { json["project"] = project }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(Bot.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func settings(of bot: Bot) -> [String: Any]? {
        let file = URL(filePath: bot.directory).appending(path: ".opencode/opencode.json")
        return (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    @Test func aBotsOwnKeyIsNamedOnlyWhereItWorks() async throws {
        TestEnvironment.prepare()
        let service = try #require(BotKeys.services.first { !Integrations.keys(of: $0.way).isEmpty })
        let names = Integrations.keys(of: service.way).map(\.name)
        let ada = try bot("bot_ada"), ben = try bot("bot_ben")
        defer {
            for name in names { _ = IntegrationKeys.set(nil, for: IntegrationKeys.variable(service.id, name, bot: ada.id)) }
            try? FileManager.default.removeItem(at: root)
        }
        // Ada's folder already has settings of its own.
        let own = URL(filePath: ada.directory).appending(path: ".opencode")
        try FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
        try #"{"instructions": ["notes.md"]}"#.write(to: own.appending(path: "opencode.json"), atomically: true, encoding: .utf8)

        let token = "ada-secret-" + UUID().uuidString
        #expect(await BotKeys.save(Dictionary(uniqueKeysWithValues: names.map { ($0, token) }), for: service, bot: ada, app: app) == nil)

        let written = try #require(settings(of: ada))
        let server = try #require((written["mcp"] as? [String: Any])?["servers"] as? [String: Any])[service.id]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: try #require(server)), as: UTF8.self)
        #expect(names.allSatisfy { text.contains(IntegrationKeys.variable(service.id, $0, bot: ada.id)) }, "her server reads her own key: \(text)")
        #expect(!text.contains(token), "named by its file, never written out")
        #expect(written["instructions"] as? [String] == ["notes.md"], "what else her folder's settings say stays")
        let attributes = try FileManager.default.attributesOfItem(atPath: own.appending(path: "opencode.json").path(percentEncoded: false))
        #expect((attributes[.posixPermissions] as? Int) == 0o600, "readable by you alone")

        // Nobody else's.
        #expect(settings(of: ben) == nil, "another bot's folder doesn't name it")
        let seed = await app.machineSeed()
        #expect(!seed.keys.keys.contains(where: IntegrationKeys.isBots), "no bot's own key")
        #expect(!seed.keys.values.contains { $0.contains(token) }, "what a new machine starts with doesn't carry it")

        // Taken away: her server goes, her folder's own settings stay.
        await BotKeys.remove(service, bot: ada, app: app)
        let after = try #require(settings(of: ada))
        #expect(after["mcp"] == nil)
        #expect(after["instructions"] as? [String] == ["notes.md"])
    }

    /// Keys this Mac kept for a machine's bots (as an earlier Kuvo Code did, for every bot) go to
    /// the machine as it connects, then from your Keychain; one the machine didn't take stays here
    /// for next time. The machine is a stand-in (its own side has the bridge's tests).
    @Test func keysThisMacKeptForAMachinesBotGoToIt() async throws {
        TestEnvironment.prepare()
        app.bots.app = app
        defer { try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "bots.json")) }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let made = Date(timeIntervalSince1970: 1_792_000_000)
        func descriptor(_ id: String) throws -> Data {
            try encoder.encode(Bot.Descriptor(id: id, name: id, job: "", look: BotLook(color: .sky, shape: .round, face: .happy), personality: nil,
                                              model: nil, project: nil, created: made, updated: made))
        }
        _ = app.bots.adopt([
            Bots.Found(folder: "/home/me/.kuvo-code/bots/bot_scout00001", descriptor: try descriptor("bot_scout00001"), session: "ses_scout", via: ""),
            Bots.Found(folder: "/home/me/.kuvo-code/bots/bot_herald0001", descriptor: try descriptor("bot_herald0001"), session: "ses_herald", via: ""),
        ], on: "box")
        let service = try #require(BotKeys.services.first { Integrations.keys(of: $0.way).count == 1 })
        let name = try #require(Integrations.keys(of: service.way).first?.name)
        let scout = IntegrationKeys.variable(service.id, name, bot: "bot_scout00001")
        let herald = IntegrationKeys.variable(service.id, name, bot: "bot_herald0001")
        defer { for variable in [scout, herald] { _ = IntegrationKeys.set(nil, for: variable) } }
        #expect(IntegrationKeys.set("tok_scout", for: scout) && IntegrationKeys.set("tok_herald", for: herald))

        // The machine takes Scout's, and turns Herald's away (its folder's settings by hand, say).
        nonisolated final class Asked: @unchecked Sendable { var puts: [(path: String, body: [String: Any]?)] = [] }
        let asked = Asked()
        await BotKeys.handOver(on: "box", app: app) { method, path, body in
            #expect(method == "PUT")
            asked.puts.append((path, body))
            return (path.contains("bot_scout00001") ? 200 : 409, Data("{}".utf8))
        }
        #expect(asked.puts.map(\.path).sorted() == ["kuvo/bots/bot_herald0001/keys/\(service.id)", "kuvo/bots/bot_scout00001/keys/\(service.id)"])
        #expect((asked.puts.first { $0.path.contains("scout") }?.body?["keys"] as? [String: String]) == [name: "tok_scout"])
        #expect(IntegrationKeys.value(scout) == nil, "the machine has it: gone from your Keychain")
        #expect(IntegrationKeys.value(herald) == "tok_herald", "not taken: kept for next time")
    }

    /// A bot that works in a project shares its folder with your sessions there: its keys are
    /// theirs, and nothing is written into the project for it.
    @Test func aBotInAProjectUsesTheProjectsKeys() async throws {
        TestEnvironment.prepare()
        let service = try #require(BotKeys.services.first { !Integrations.keys(of: $0.way).isEmpty })
        let names = Integrations.keys(of: service.way).map(\.name)
        let project = root.appending(path: "project").path(percentEncoded: false)
        try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
        let helper = try bot("bot_helper", project: project)
        defer {
            for name in names { _ = IntegrationKeys.set(nil, for: IntegrationKeys.variable(service.id, name, bot: helper.id)) }
            try? FileManager.default.removeItem(at: root)
        }
        _ = await BotKeys.save(Dictionary(uniqueKeysWithValues: names.map { ($0, "helper-secret") }), for: service, bot: helper, app: app)
        #expect(!FileManager.default.fileExists(atPath: project + "/.opencode"), "nothing written into your project")
    }
}
