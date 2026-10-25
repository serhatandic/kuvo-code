import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Making a bot from scratch (F1) on this Mac, whose box makes and keeps it: a folder of its own
/// with a memory that names it, and a conversation of its own in that folder, told who it is and
/// where it runs; it's listed, and still there when Kuvo Code opens again; it writes first, asking
/// what it's for. The job it then keeps with its set_job tool is what shows under its name, and a
/// job changed in Edit Bot reaches it. One the engine couldn't make leaves nothing behind. The
/// engine is stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized) struct BotCreationTests {
    let engine = StubEngine(port: 47997)
    let app = AppModel()
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")

    init() {
        app.bots.app = app
        app.wakeUps.app = app
        app.workspace.api = engine.api
        engine.list([])
        engine.on("PATCH", "/api/session/*", json: ["data": [:]])
        engine.on("PUT", "/api/experimental/session/*", json: [:])
        engine.on("POST", "/api/session/ses_inbox/*", json: [:])
        engine.on("GET", "/api/session/ses_inbox") { _ in StubWeb.json(["data": StubEngine.session("ses_inbox", title: "Inbox Helper", directory: "/")]) }
    }

    private func done(_ box: TestBox) {
        box.stop()
        engine.stop()
        try? FileManager.default.removeItem(at: Bots.root)
        try? FileManager.default.removeItem(at: botsFile)
    }

    private func told(_ session: String) -> [String] {
        engine.requests("PUT", "/api/experimental/session/\(session)/instructions/entries/\(Bots.instructionKey)").compactMap { $0.body["value"] as? String }
    }

    @Test func aBotFromScratch() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { done(box) }
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        engine.on("POST", "/api/session") { request in
            StubWeb.json(["data": StubEngine.session("ses_inbox", title: request.body["title"] as? String ?? "", directory: (request.body["location"] as? [String: Any])?["directory"] as? String ?? "")])
        }
        await app.workspace.refresh()
        let made = try await app.bots.make(name: "Inbox Helper", look: BotLook(color: .mint, shape: .round, face: .calm), model: ModelRef(id: "big-pickle", providerID: "opencode"), machine: nil, project: nil)
        let bot = made.bot
        #expect(made.firstMessage == nil, "it writes first: nothing for your composer")

        // Its own folder on this Mac, with a memory that names it, and its conversation there.
        #expect(bot.folder.hasPrefix(Bots.root.path))
        let memory = try String(contentsOfFile: bot.memoryFile, encoding: .utf8)
        #expect(memory.contains("Inbox Helper"))
        let session = try #require(engine.requests("POST", "/api/session").first)
        #expect((session.body["location"] as? [String: Any])?["directory"] as? String == bot.directory)
        #expect(bot.sessionID == "ses_inbox")
        #expect(app.workspace.session("ses_inbox") != nil)
        let first = try #require(told("ses_inbox").first)
        #expect(first.contains("You are Inbox Helper") && first.contains("You run on this Mac."), "it's told who it is and where it runs")
        // Listed, and still there when Kuvo Code opens again (what its box last said, kept).
        #expect(app.bots.list.map(\.name) == ["Inbox Helper"])
        #expect(Bots().list.map(\.id) == [bot.id])
        #expect(bot.job.isEmpty, "no job until you've told it")
        // It writes first.
        #expect(engine.requests("POST", "/api/session/ses_inbox/synthetic").count == 1)

        // You tell it; it keeps its job with set_job, and that's what shows under its name.
        // (As its set_job tool on this Mac carries it out: `BrowserTools.job`.)
        let kept = await app.bots.setJob(["summary": "Sorts my inbox every morning.", "details": "Archive newsletters; flag anything from my bank."], caller: "ses_inbox")
        #expect(kept.isError == false, "\(kept.text)")
        #expect(app.bots.bot(bot.id)?.job == "Sorts my inbox every morning")
        #expect(app.bots.bot(bot.id)?.instructions == "Archive newsletters; flag anything from my bank.")
        #expect(told("ses_inbox").last?.contains("Archive newsletters; flag anything from my bank.") == true, "it hears its job as kept")
        #expect(try String(contentsOfFile: bot.memoryFile, encoding: .utf8) == memory, "its memory is its own")

        // Changed in Edit Bot: kept by its box, and it hears it.
        var edited = try #require(app.bots.bot(bot.id))
        edited.job = "Sorts my inbox twice a day"
        edited.instructions = "Morning and evening. Archive newsletters."
        try await app.bots.update(edited, job: true)
        #expect(app.bots.bot(bot.id)?.job == "Sorts my inbox twice a day")
        #expect(told("ses_inbox").last?.contains("Morning and evening. Archive newsletters.") == true)
        #expect(Bots().list.first?.job == "Sorts my inbox twice a day", "kept")
    }

    /// The engine couldn't make its conversation: no bot, and no folder left of it.
    @Test func oneThatCouldntBeMadeLeavesNothing() async throws {
        let box = try await TestBox(engine: engine.url)
        defer { done(box) }
        app.bots.boxes = { _ in box.client(engine: engine.url) }
        engine.on("POST", "/api/session", json: ["message": "Engine busy"], status: 500)
        await app.workspace.refresh()
        let before = (try? FileManager.default.contentsOfDirectory(atPath: Bots.root.path(percentEncoded: false))) ?? []
        await #expect(throws: (any Error).self) {
            try await app.bots.make(name: "Inbox Helper", look: BotLook(color: .mint, shape: .round, face: .calm), model: ModelRef(id: "big-pickle", providerID: "opencode"), machine: nil, project: nil)
        }
        #expect(app.bots.list.isEmpty)
        let after = (try? FileManager.default.contentsOfDirectory(atPath: Bots.root.path(percentEncoded: false))) ?? []
        #expect(Set(after).subtracting(before).subtracting(["kit.json"]).isEmpty, "a folder was left: \(Set(after).subtracting(before))")
    }
}
