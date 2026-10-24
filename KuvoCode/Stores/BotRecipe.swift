import AppKit
import UniformTypeIdentifiers

/// A bot to share: what makes it itself (its name, look, personality, and its job as its memory
/// has it), in a file a teammate opens with File › Import Bot…, where it starts a new bot as a
/// template does: the job typed in its conversation. Not the rest of its memory, its wake-ups,
/// model or where it lives: those are the new bot's own.
struct BotRecipe: Codable, Equatable {
    var kind = "kuvo-bot"
    var version = 1
    var name: String
    /// Its job in a few words, and in full.
    var job: String
    var instructions: String
    var look: BotLook
    var personality: SharedPersonality?

    /// A preset's ID, or one of your own, with its words, for a Mac that doesn't have it.
    struct SharedPersonality: Codable, Equatable {
        var id: String
        var name: String
        var description: String
    }

    /// Declared in the app's Info.plist, so a .kuvobot file opens in Kuvo Code.
    static let type = UTType("run.kuvo.code.bot") ?? UTType(filenameExtension: "kuvobot", conformingTo: .json) ?? .json

    /// The recipe in a file.
    static func read(_ url: URL) throws -> BotRecipe {
        // A file of its own, and a small one: not a pipe or a device, which would never finish.
        let file = url.resolvingSymlinksInPath()
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, values.fileSize ?? 0 <= 1 << 20 else { throw CocoaError(.fileReadCorruptFile) }
        var recipe = try JSONDecoder().decode(BotRecipe.self, from: Data(contentsOf: file))
        guard recipe.kind == "kuvo-bot" else { throw CocoaError(.fileReadCorruptFile) }
        // Names on one line, as you see them: one with line breaks could write a job of its own
        // into the new bot's memory, which you'd never read.
        recipe.name = Bots.oneLine(recipe.name)
        if let shared = recipe.personality {
            recipe.personality?.name = Bots.oneLine(shared.name)
            recipe.personality?.description = String(shared.description.prefix(1000))
        }
        return recipe
    }

    /// Tells you a file isn't a bot.
    static func cantOpen() {
        let alert = NSAlert()
        alert.messageText = "This isn’t a bot Kuvo Code can open"
        alert.informativeText = "Choose a file exported from Edit Bot."
        alert.runModal()
    }

    init(bot: Bot) {
        name = bot.name
        job = bot.job
        instructions = bot.instructions
        look = bot.look
        personality = Personalities.shared.personality(bot.personality).map { SharedPersonality(id: $0.id, name: $0.name, description: $0.description) }
    }

    /// Its personality on this Mac: a preset by its ID; one of someone's own by its name and
    /// words, added to yours if you don't have it (`added`).
    func personalityHere() -> (id: String, added: Bool)? {
        guard let shared = personality else { return nil }
        let personalities = Personalities.shared
        if let known = personalities.all.first(where: { $0.id == shared.id && !$0.isCustom }) { return (known.id, false) }
        if let same = personalities.all.first(where: { $0.name == shared.name && $0.description == shared.description }) { return (same.id, false) }
        // With no room for more, the bot has none of its own.
        guard let added = try? personalities.add(name: shared.name, description: shared.description) else { return nil }
        return (added.id, true)
    }

    /// Saves a bot's recipe where you choose.
    static func export(_ bot: Bot) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [type]
        panel.nameFieldStringValue = bot.name + ".kuvobot"
        panel.message = "A file to share \(bot.name): its look, personality and job. The rest of its memory and its wake-ups stay here."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try encoder.encode(BotRecipe(bot: bot)).write(to: url, options: .atomic)
            Analytics.shared.track("bot_exported")
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// A recipe from a file you pick, or nil.
    static func pick() -> BotRecipe? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [type, .json]
        panel.message = "Choose a bot to start a new one from."
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        do {
            let recipe = try read(url)
            Analytics.shared.track("bot_imported")
            return recipe
        } catch {
            cantOpen()
            return nil
        }
    }
}
