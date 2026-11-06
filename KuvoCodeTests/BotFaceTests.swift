import ClientDesign
import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A bot's face in the sidebar says what it is doing: a bot whose sessions work doesn't look
/// asleep or idle, though its own conversation has nothing running; it sleeps only when a wake-up
/// is all it has. The engine is stubbed; this Mac's box, which keeps the bot and its wake-ups, is
/// real.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2))) struct BotFaceTests {
    let engine = StubEngine(port: 47_961)
    static let id = "bot_face\(UUID().uuidString.prefix(6))"
    let folder = Bots.root.appending(path: BotFaceTests.id)
    let file = AppInfo.supportDirectory.appending(path: "bots.json")

    init() throws {
        TestEnvironment.prepare()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Pixel's memory\n".utf8).write(to: folder.appending(path: "MEMORY.md"))
        try Data("ses_pixel".utf8).write(to: folder.appending(path: "session"))
        try Data(#"{"kuvo": 1, "id": "\#(Self.id)", "name": "Pixel", "job": "Builds apps", "look": {"color": "sky", "shape": "round", "face": "calm"}, "created": "2026-10-21T09:00:00Z", "updated": "2026-10-21T09:00:00Z"}"#.utf8)
            .write(to: folder.appending(path: "bot.json"))
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: [[
            "id": Self.id, "name": "Pixel", "job": "Builds apps", "instructions": "Builds apps.", "jobInMemory": true,
            "look": ["color": "sky", "shape": "round", "face": "calm"], "folder": folder.path(percentEncoded: false),
            "sessionID": "ses_pixel", "created": "2026-10-21T09:00:00Z",
        ]]).write(to: file)
    }

    private func done() {
        engine.stop()
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The bot's own conversation, and a session it started, with that one at work or not.
    private func sessions(running: Set<String>) {
        let signIn = StubEngine.session("ses_signin", title: "Sign-in", directory: "/tmp/kuvo-tests-bot-face", extra: [
            "metadata": ["kuvo": ["startedBy": "ses_pixel", "by": ["bot": Self.id, "name": "Pixel"], "depth": 1]],
        ])
        engine.list([StubEngine.session("ses_pixel", title: "Pixel", directory: folder.path(percentEncoded: false)), signIn], running: running)
        engine.on("GET", "/api/session/ses_signin", json: ["data": signIn])
        engine.on("GET", "/api/session/ses_signin/permission", json: ["data": []])
        engine.on("GET", "/api/session/ses_signin/form", json: ["data": []])
    }

    @Test func aBotWhoseSessionsWorkLooksAtWorkAndOneWithOnlyAWakeUpSleeps() async throws {
        defer { done() }
        let box = try await TestBox(engine: engine.url)
        defer { box.stop() }
        let app = AppModel()
        // As the app sets them up when it starts.
        app.bots.app = app
        app.wakeUps.app = app
        app.boxGroups.app = app
        app.workspace.api = engine.api
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        sessions(running: [])
        await app.workspace.refresh()
        await app.bots.refresh(BoxClient.mac)
        let bot = try #require(app.bots.list.first { $0.id == Self.id }, "bots: \(app.bots.list.map(\.id))")
        #expect(app.bots.mood(of: bot, in: app.workspace) == .idle, "nothing to do: it rests")

        // A wake-up is all it has: asleep.
        try await app.wakeUps.add(to: bot.wakeOwner, at: .now.addingTimeInterval(86_400), every: nil, note: "Check CI")
        #expect(app.bots.mood(of: bot, in: app.workspace) == .sleeping)

        // The session it started works, the wake-up still waiting: at work, not asleep.
        sessions(running: ["ses_signin"])
        await app.workspace.refresh()
        try await until { app.workspace.isWorking("ses_signin") }
        #expect(app.bots.mood(of: bot, in: app.workspace) == .working, "its session runs: it looks at work, not asleep")
        #expect(app.bots.isOverseeingWork(bot, in: app.workspace), "and its row says so")

        // Its wake-ups paused, the session still running: not at work, as its row says.
        try await app.wakeUps.setPaused(true, bot.wakeOwner, stops: false)
        #expect(app.wakeUps.paused.contains(bot.id))
        #expect(!app.bots.isOverseeingWork(bot, in: app.workspace))
        #expect(app.bots.mood(of: bot, in: app.workspace) == .sleeping)
        try await app.wakeUps.setPaused(false, bot.wakeOwner, stops: false)

        // The session ends: it sleeps again.
        sessions(running: [])
        await app.workspace.refresh()
        try await until { !app.workspace.isWorking("ses_signin") }
        #expect(app.bots.mood(of: bot, in: app.workspace) == .sleeping)
    }
}
