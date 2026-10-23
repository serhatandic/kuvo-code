import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Bots a machine makes itself, with this Mac closed (New Bot there, from a phone): the Mac gives
/// the machine what New Bot needs as it connects, and takes in what the machine made the next time
/// it does: each bot once, as its folder there describes it, the rest left as they are. What the
/// machine tells a new bot, from the kit's words, is what this Mac tells one.
@MainActor
@Suite(.serialized) struct MachineBotsTests {
    let app = AppModel()
    let botsFile = AppInfo.supportDirectory.appending(path: "bots.json")

    init() {
        TestEnvironment.prepare()
        try? FileManager.default.removeItem(at: botsFile)
        app.bots.app = app
    }

    private func done() {
        try? FileManager.default.removeItem(at: botsFile)
        // What waited for a machine that never connected.
        UserDefaults.standard.removeObject(forKey: "botEditsWaiting")
    }

    private func descriptor(_ id: String, name: String = "Herald", model: ModelRef? = ModelRef(id: "gpt-6.1-sol", providerID: "codex-cli"),
                            personality: String? = "preset.straight", project: String? = nil, look: BotLook = BotLook(color: .sky, shape: .round, face: .happy),
                            updated: Date = Date(timeIntervalSince1970: 1_792_000_000)) throws -> Data {
        let descriptor = Bot.Descriptor(id: id, name: name, job: "", look: look, personality: personality,
                                        model: model, project: project, created: Date(timeIntervalSince1970: 1_792_000_000), updated: updated)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(descriptor)
    }

    @Test func whatAMachineMadeIsTakenInOnce() throws {
        defer { done() }
        let folder = "/home/me/.kuvo-code/bots/bot_herald0001"
        let found = [
            Bots.Found(folder: folder, descriptor: try descriptor("bot_herald0001", project: "/home/me/app"), session: "ses_herald", via: "bridge"),
            // Not a bot's description, one in another's folder, one with no conversation: left out.
            Bots.Found(folder: "/home/me/.kuvo-code/bots/bot_broken0001", descriptor: Data("{}".utf8), session: "ses_x", via: ""),
            Bots.Found(folder: "/home/me/.kuvo-code/bots/bot_other00001", descriptor: try descriptor("bot_moved00001"), session: "ses_y", via: ""),
            Bots.Found(folder: "/home/me/.kuvo-code/bots/bot_nosession1", descriptor: try descriptor("bot_nosession1"), session: "", via: ""),
        ]
        let adopted = app.bots.adopt(found, on: "box")
        #expect(adopted.map(\.id) == ["bot_herald0001"])
        let bot = try #require(app.bots.bot("bot_herald0001"))
        #expect(bot.name == "Herald" && bot.machine == "box" && bot.folder == folder && bot.sessionID == "ses_herald")
        #expect(bot.model == ModelRef(id: "gpt-6.1-sol", providerID: "codex-cli") && bot.personality == "preset.straight")
        #expect(bot.agents == true, "it runs with the coding agents there")
        #expect(bot.project == RemoteFolder.folder("/home/me/app", on: "box"))
        #expect(app.workspace.botSessions.contains("ses_herald"))
        // Kept, and taken in only once.
        #expect(Bots().list.map(\.id) == ["bot_herald0001"])
        #expect(app.bots.adopt(found, on: "box").isEmpty)
        #expect(app.bots.list.count == 1)
    }

    /// The kit's words for a bot, filled in as the machine's bridge fills them in
    /// (`botInstructions` in kuvo-link.js), are this Mac's words for that bot.
    @Test func aMachinesBotIsToldWhatThisMacTellsOne() throws {
        defer { done() }
        let kit = app.bots.kit(for: "box")
        func filled(name: String, folder: String, personality: String?, project: Bool) -> String {
            var text = kit.instructions.replacingOccurrences(of: "⟦name⟧", with: name).replacingOccurrences(of: "⟦folder⟧", with: folder)
            text = personality.map { text.replacingOccurrences(of: "⟦personality⟧", with: $0) } ?? text.replacingOccurrences(of: "\n⟦personality⟧\n", with: "")
            if project { text = text.replacingOccurrences(of: "\n\n" + kit.identityNote, with: "\n\n" + kit.projectNote + "\n\n" + kit.identityNote) }
            return text
        }
        let straight = try #require(Personalities.shared.personality("preset.straight"))
        for (personality, project) in [(nil, false), ("preset.straight", false), (nil, true), ("preset.straight", true)] as [(String?, Bool)] {
            var bot = Bot(id: "bot_herald0001", name: "Herald", job: "", instructions: "", look: .random(), machine: "box",
                          project: project ? RemoteFolder.folder("/home/me/app", on: "box") : nil, folder: "/home/me/.kuvo-code/bots/bot_herald0001", sessionID: "s", created: .now)
            bot.personality = personality
            #expect(filled(name: "Herald", folder: bot.folder, personality: personality.map { _ in straight.instruction }, project: project) == Bots.instructions(for: bot),
                    "\(personality ?? "no personality"), \(project ? "a project" : "its own folder")")
        }
        #expect(kit.memory.replacingOccurrences(of: "⟦name⟧", with: "Herald") == Bots.blankMemory("Herald"))
        #expect(kit.templates.map(\.id) == BotTemplate.all.map(\.id))

        // One with a job, changed there from a phone: the kit's words for that, with its job as
        // its memory has it.
        var working = Bot(id: "bot_herald0001", name: "Herald", job: "Sends the news", instructions: "Sends the news.\nEvery morning at 8.", look: .random(),
                          machine: "box", project: nil, folder: "/home/me/.kuvo-code/bots/bot_herald0001", sessionID: "s", created: .now)
        working.personality = "preset.straight"
        let told = kit.jobInstructions.replacingOccurrences(of: "⟦name⟧", with: "Herald").replacingOccurrences(of: "⟦folder⟧", with: working.folder)
            .replacingOccurrences(of: "⟦personality⟧", with: straight.instruction)
            .replacingOccurrences(of: ": ⟦job⟧", with: ": Sends the news").replacingOccurrences(of: "⟦jobDetails⟧", with: working.instructions)
        #expect(told == Bots.instructions(for: working))
    }

    /// What a machine's bridge changed or deleted while this Mac was away, taken in as it
    /// connects: a description there newer than this Mac's gives the bot its name, look,
    /// personality and model; an older one, or one on its way to another computer, is left; a bot
    /// deleted there goes here too, unless its folder is there after all.
    @Test func whatAMachineChangedOrDeletedIsTakenIn() async throws {
        defer { done() }
        let made = Date(timeIntervalSince1970: 1_792_000_000)
        func found(_ id: String, _ descriptor: Data) -> Bots.Found {
            Bots.Found(folder: "/home/me/.kuvo-code/bots/\(id)", descriptor: descriptor, session: "ses_\(id)", via: "")
        }
        app.bots.adopt([found("bot_herald0001", try descriptor("bot_herald0001")), found("bot_scout00001", try descriptor("bot_scout00001", name: "Scout")),
                        found("bot_gone000001", try descriptor("bot_gone000001", name: "Gone")), found("bot_stays00001", try descriptor("bot_stays00001", name: "Stays"))], on: "box")
        #expect(app.bots.list.count == 4)

        let later = made.addingTimeInterval(3600)
        let sol = ModelRef(id: "sol", providerID: "anthropic")
        let changed = try descriptor("bot_herald0001", name: "Herald Prime", model: sol, personality: nil, look: BotLook(color: .mint, shape: .gem, face: .wink), updated: later)
        let older = try descriptor("bot_scout00001", name: "Scout Old", updated: made.addingTimeInterval(-60))
        await app.bots.takeIn([found("bot_herald0001", changed), found("bot_scout00001", older), found("bot_stays00001", try descriptor("bot_stays00001", name: "Stays"))],
                              deleted: ["bot_gone000001", "bot_stays00001", "bot_never00001"], on: "box")

        let herald = try #require(app.bots.bot("bot_herald0001"))
        #expect(herald.name == "Herald Prime" && herald.look == BotLook(color: .mint, shape: .gem, face: .wink))
        #expect(herald.personality == nil && herald.model == sol && herald.updated == later)
        #expect(app.bots.bot("bot_scout00001")?.name == "Scout", "this Mac's is the newer")
        #expect(app.bots.bot("bot_gone000001") == nil, "deleted there")
        #expect(app.bots.bot("bot_stays00001") != nil, "its folder is there")
        #expect(Bots().list.map(\.id).sorted() == ["bot_herald0001", "bot_scout00001", "bot_stays00001"])
        #expect(!app.workspace.botSessions.contains("ses_bot_gone000001"))

        // Taken in once: the same again changes nothing.
        await app.bots.takeIn([found("bot_herald0001", changed)], deleted: [], on: "box")
        #expect(app.bots.bot("bot_herald0001") == herald)
        // Another machine's word about it counts for nothing.
        await app.bots.takeIn([], deleted: ["bot_herald0001"], on: "other")
        #expect(app.bots.bot("bot_herald0001") != nil)
    }
}
