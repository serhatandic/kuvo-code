import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a box makes its bots with and tells them (its kit): a machine's as the Mac gives it, or its
/// own release's; this Mac's from its app. Filled in there, its words are what this Mac's words say
/// to a bot there.
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
        try? FileManager.default.removeItem(at: AppInfo.supportDirectory.appending(path: "machine-bots.json"))
        // What waited for a machine that never connected.
        UserDefaults.standard.removeObject(forKey: "botEditsWaiting")
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

    /// The kit a release brings boxes (for one that updated itself, or that no Mac gave a kit):
    /// filled in for a machine, it tells a bot what this Mac's kit tells one there; none of what's
    /// a machine's own comes with it.
    @Test func aBoxsOwnReleaseTellsANewBotWhatThisMacWould() {
        defer { done() }
        let release = Bots.releaseKit(), mac = app.bots.kit(for: "box")
        func filled(_ text: String) -> String {
            text.replacingOccurrences(of: "⟦machine⟧", with: "box").replacingOccurrences(of: "⟦timeZone⟧", with: TimeZone.current.identifier)
        }
        #expect(filled(release.instructions) == mac.instructions)
        #expect(filled(release.jobInstructions) == mac.jobInstructions)
        #expect(release.templates.map(\.id) == mac.templates.map(\.id))
        #expect(release.version == AppInfo.version)
        #expect(release.startingModel == nil && release.projects.isEmpty && release.rules.isEmpty && release.zoneinfo == nil)
        #expect(release.personalities.allSatisfy { !$0.custom })
    }
}
