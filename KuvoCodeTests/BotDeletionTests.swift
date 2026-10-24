import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Deleting a bot (F8): the bot, its conversation, its wake-ups and what you'd written to it go,
/// and its folder (its memory, what it made) goes to the Trash rather than for good; after a
/// relaunch it's still gone. The engine is stubbed.
@MainActor
@Suite(.serialized) struct BotDeletionTests {
    let engine = StubEngine(port: 47986)
    let folder = AppInfo.testRoot.appending(path: "Bots/bot_gone_\(UUID().uuidString.prefix(6))")
    let file = AppInfo.supportDirectory.appending(path: "bots.json")

    init() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Ci's memory\n\n## Job\nKeeps CI green.\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        let bot: [String: Any] = [
            "id": "bot_gone", "name": "Ci", "job": "Keeps CI green", "instructions": "Keeps CI green.", "jobInMemory": true,
            "look": ["color": "mint", "shape": "round", "face": "calm"], "folder": folder.path(percentEncoded: false),
            "sessionID": "ses_bot_gone", "created": "2026-10-21T09:00:00Z",
        ]
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [bot]).write(to: file)
    }

    private func done() {
        engine.stop()
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: folder)
        Drafts.shared.remove("ses_bot_gone")
    }

    /// The tests' Trash, as file paths under it.
    private var trashed: [String] {
        FileManager.default.enumerator(atPath: AppInfo.testTrash.path(percentEncoded: false))?.compactMap { $0 as? String } ?? []
    }

    @Test func deletingABotLeavesNothingButTheTrash() async throws {
        defer { done() }
        let app = AppModel()
        // As the app sets them up when it starts.
        app.bots.app = app
        app.wakeUps.app = app
        app.boxGroups.app = app
        app.workspace.api = engine.api
        engine.list([StubEngine.session("ses_bot_gone", title: "Ci", directory: folder.path(percentEncoded: false))])
        engine.on("DELETE", "/api/session/ses_bot_gone", json: [:])
        await app.workspace.refresh()
        let bot = try #require(app.bots.list.first { $0.id == "bot_gone" }, "bots: \(app.bots.list.map(\.id))")
        try await app.wakeUps.add(to: bot.wakeOwner, at: .now.addingTimeInterval(86_400), every: .days(1), note: "Check CI")
        #expect(app.wakeUps.wakes[bot.id]?.count == 1)
        Drafts.shared["ses_bot_gone"].text = "Also watch the nightly job"

        try await app.bots.delete(bot)
        #expect(app.bots.list.isEmpty)
        #expect(Bots().list.isEmpty, "gone after a relaunch too")
        #expect(engine.requests("DELETE", "/api/session/ses_bot_gone").count == 1, "its conversation is deleted")
        #expect(app.workspace.session("ses_bot_gone") == nil)
        #expect(app.wakeUps.wakes[bot.id] == nil)
        #expect(Drafts.shared["ses_bot_gone"].text.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: folder.path(percentEncoded: false)))
        #expect(trashed.contains { $0.hasSuffix(folder.lastPathComponent + "/MEMORY.md") }, "its folder is in the Trash, its memory with it")
    }
}
