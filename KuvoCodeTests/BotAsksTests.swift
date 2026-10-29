import ClientSessions
import Foundation
import KuvoLink
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a bot asks you before it does it, as this Mac shows it (PROTOCOL.md, "Work", Projects): its
/// conversation shows the asking card and the bot waits on you in the sidebar; Allow makes the
/// project on the bot's box, in the folder picked the first time there, marked as the bot's;
/// Always lets it go ahead from then on, and Edit Bot's Ask First takes that back. The machine's
/// box is the real one (`kuvo-link.js serve`), reached over HTTP where a Mac reaches it over SSH.
@MainActor
@Suite(.serialized) struct BotAsksTests {
    let app = AppModel()

    init() {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: Bots.file)
        app.bots.app = app
        app.botWork.app = app
        app.botAsks.app = app
        app.botAsks.onChange = { [app] sessions in app.workspace.askingForWork = sessions }
    }

    /// Pixel, a bot on the machine, asking to make Tidepool there, with no projects folder picked
    /// yet; and a folder to pick.
    private func lab() async throws -> (machine: MachineTestBox, projects: URL) {
        let machine = try await MachineTestBox(name: "lab")
        let folder = machine.folder.appending(path: "bots/bot_pixel00001")
        try FileManager.default.createDirectory(at: folder.appending(path: "workspace"), withIntermediateDirectories: true)
        try Data(#"{"kuvo": 1, "id": "bot_pixel00001", "name": "Pixel", "job": "Builds apps", "look": {"color": "sky", "shape": "round", "face": "calm"}, "created": "2026-10-01T09:00:00Z", "updated": "2026-10-01T09:00:00Z"}"#.utf8)
            .write(to: folder.appending(path: "bot.json"))
        try Data("ses_pixel".utf8).write(to: folder.appending(path: "session"))
        try JSONEncoder().encode(app.bots.kit(for: "lab")).write(to: machine.folder.appending(path: "bots/kit.json"))
        let ask: [String: Any] = ["id": "wak_1", "action": "makeProject", "session": "ses_pixel", "name": "Pixel", "bot": "bot_pixel00001", "project": "Tidepool", "folderName": "tidepool", "folder": NSNull(),
                                  "at": Date.now.timeIntervalSince1970 * 1000, "given": ["name": "Tidepool"]]
        try FileManager.default.createDirectory(at: machine.folder.appending(path: "run/work"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["asks": [ask]]).write(to: machine.folder.appending(path: "run/work/asks.json"))
        let projects = machine.folder.appending(path: "Developer")
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        let box: (String) -> BoxClient = { box in box == "lab" ? machine.client : BoxClient(box: box, transport: LocalBox { _ in AsyncThrowingStream { $0.finish() } }) }
        app.bots.boxes = box
        app.bots.reachable = { $0 == "lab" }
        app.botWork.boxes = box
        app.botAsks.boxes = box
        app.botAsks.connected = { $0 == "lab" }
        await app.bots.refresh("lab")
        return (machine, projects)
    }

    private func done(_ machine: MachineTestBox) {
        machine.stop()
        try? FileManager.default.removeItem(at: Bots.file)
    }

    @Test func aBotsAskShowsOnItsConversationAndAllowMakesTheProjectWhereYouPicked() async throws {
        let (machine, projects) = try await lab()
        defer { done(machine) }
        await app.botAsks.read("lab")
        let (box, ask) = try #require(app.botAsks.asks(for: "ses_pixel").first)
        #expect(box == "lab")
        #expect(ask.needsFolder, "no projects folder is picked on the machine yet: the card asks for one")
        #expect(WorkWords.askLine(ask) == "Pixel wants to make Tidepool.")
        #expect(app.workspace.needsAttention("ses_pixel"), "the bot waits on you in the sidebar")

        let said = try #require(try await app.botAsks.answer(ask, on: box, .allow, folder: projects.path))
        #expect(!said.isError && said.text.hasPrefix("Made Tidepool at"), "\(said.text)")
        #expect(FileManager.default.fileExists(atPath: projects.appending(path: "tidepool/.git").path))
        #expect(app.botAsks.asks(for: "ses_pixel").isEmpty)
        #expect(!app.workspace.needsAttention("ses_pixel"))
        let kept = try JSONSerialization.jsonObject(with: Data(contentsOf: machine.folder.appending(path: "box/projects.json"))) as? [String: Any]
        let project = try #require((kept?["projects"] as? [[String: Any]])?.first)
        #expect((project["madeBy"] as? [String: Any])?["name"] as? String == "Pixel")
        #expect(try await machine.client.workSettings().projectsFolder == projects.path, "the folder you picked is where its projects go from now on")
    }

    @Test func alwaysLetsTheBotGoAheadUntilEditBotTakesItBack() async throws {
        let (machine, projects) = try await lab()
        defer { done(machine) }
        await app.botAsks.read("lab")
        let (box, ask) = try #require(app.botAsks.asks(for: "ses_pixel").first)
        try await app.botAsks.answer(ask, on: box, .always, folder: projects.path)
        let pixel = try #require(app.bots.bot("bot_pixel00001"))
        #expect(pixel.allowed?.actions == [.makeProject], "Edit Bot › Work lists it")
        try await app.botWork.setAllowed([], for: pixel)
        #expect(app.bots.bot("bot_pixel00001")?.allowed == nil, "Ask First: it asks again")
    }

    @Test func noLeavesNothingMade() async throws {
        let (machine, projects) = try await lab()
        defer { done(machine) }
        await app.botAsks.read("lab")
        let (box, ask) = try #require(app.botAsks.asks(for: "ses_pixel").first)
        try await app.botAsks.answer(ask, on: box, .deny)
        #expect(!FileManager.default.fileExists(atPath: projects.appending(path: "tidepool").path))
        #expect(try await machine.client.workSettings().projectsFolder == nil, "a no picks no folder")
    }

    @Test func oneAnsweredOnAnotherClientFirstJustGoes() async throws {
        let (machine, projects) = try await lab()
        defer { done(machine) }
        await app.botAsks.read("lab")
        let (box, ask) = try #require(app.botAsks.asks(for: "ses_pixel").first)
        // Your phone answers it first.
        let (status, _) = try await machine.client.send("POST", "kuvo/work/asks/wak_1", body: Data(#"{"answer": "allow", "folder": "\#(projects.path)"}"#.utf8))
        #expect(status == 200)
        let late = try await app.botAsks.answer(ask, on: box, .deny)
        #expect(late == nil, "no failure to show: it's done")
        #expect(app.botAsks.asks(for: "ses_pixel").isEmpty)
        #expect(!app.workspace.needsAttention("ses_pixel"))
        #expect(FileManager.default.fileExists(atPath: projects.appending(path: "tidepool").path), "what the phone allowed stands")
    }
}
