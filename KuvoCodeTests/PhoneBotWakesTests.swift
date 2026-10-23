import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot's wake-ups from a phone, through this Mac: added and paused in the bot's own folder,
/// where Edit Bot shows them and its Pause holds them, never in a folder of the conversation's
/// own. The engine is stubbed; the folders and kuvo-wake are real.
@MainActor
@Suite(.serialized) struct PhoneBotWakesTests {
    let engine = StubEngine(port: 47973)
    let folder = AppInfo.testRoot.appending(path: "Bots/bot_waker_\(UUID().uuidString.prefix(6))")
    let file = AppInfo.supportDirectory.appending(path: "bots.json")

    init() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Waker's memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        let bot: [String: Any] = [
            "id": "bot_waker", "name": "Waker", "job": "", "instructions": "", "jobInMemory": true,
            "look": ["color": "mint", "shape": "round", "face": "calm"], "folder": folder.path(percentEncoded: false),
            "sessionID": "ses_bot_waker", "created": "2026-10-21T09:00:00Z",
        ]
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [bot]).write(to: file)
    }

    private func done() {
        engine.stop()
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.removeItem(at: WakeUps.root.appending(path: "ses_bot_waker"))
    }

    @Test func aPhoneAddsAndPausesABotsWakeUpsWhereEditBotShowsThem() async throws {
        defer { done() }
        let app = AppModel()
        app.bots.app = app
        app.wakeUps.app = app
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_bot_waker", title: "Waker", directory: folder.path(percentEncoded: false))])
        await app.workspace.refresh()
        let bot = try #require(app.bots.bot("bot_waker"))
        let link = PhoneLink()
        link.wakeUps = app.wakeUps
        let before = AgentMail.shared.app
        AgentMail.shared.app = app
        defer { AgentMail.shared.app = before }
        func ask(_ path: String, _ body: [String: Any]) async throws -> Int {
            let request = LinkRequest(method: "POST", path: path, headers: ["content-type": "application/json"], body: try JSONSerialization.data(withJSONObject: body))
            var status = 0
            for try await part in PhoneLink.respond(to: request, link: link, engine: URL(string: engine.url + "/")!, password: nil, agents: nil) {
                if case .head(let code, _) = part { status = code }
            }
            return status
        }
        #expect(try await ask("kuvo/wakes/ses_bot_waker", ["due": Date.now.addingTimeInterval(3600).timeIntervalSince1970, "note": "Morning digest"]) == 200)
        #expect(app.wakeUps.wakes[bot.wakeOwner.key]?.map(\.note) == ["Morning digest"], "the bot's own")
        #expect(!FileManager.default.fileExists(atPath: WakeUps.root.appending(path: "ses_bot_waker").path(percentEncoded: false)), "no folder of the conversation's")
        #expect(try await ask("kuvo/wakes/ses_bot_waker/pause", ["paused": true]) == 200)
        #expect(app.wakeUps.paused.contains(bot.wakeOwner.key), "held as the bot's Pause holds them")
    }
}
