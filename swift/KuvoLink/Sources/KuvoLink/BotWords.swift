import Foundation

/// What a box makes its bots with and tells them, as Kuvo Code words it (`Resources/bot-words.json`):
/// New Bot's templates, Kuvo Code's own personalities, the looks a bot can have, and what a bot is
/// told (which only a box fills in: `readKit` in kuvo-link.js). A client puts the file beside each
/// box's bridge (`bin/bot-words.json`), a release brings it, and the Mac app shows its templates and
/// personalities from the same file.
public struct BotWords: Decodable, Sendable {
    public struct Look: Decodable, Sendable, Equatable {
        public var color: String, shape: String, face: String
    }

    public struct Template: Decodable, Sendable {
        public var id: String, name: String, job: String, instructions: String
        public var look: Look
        /// One of `personalities`.
        public var personality: String?
        /// It works on a project's code, so it's best made in one.
        public var wantsProject: Bool
    }

    public struct Personality: Decodable, Sendable {
        public var id: String, name: String, description: String
        /// An SF Symbol for its tile.
        public var symbol: String
    }

    public struct Looks: Decodable, Sendable, Equatable {
        public var colors: [String], shapes: [String], faces: [String]
    }

    public var templates: [Template]
    public var personalities: [Personality]
    /// What a bot is told of its personality, with ⟦name⟧ and ⟦description⟧ for that one's.
    public var personalityWords: String
    public var looks: Looks
    /// Who sets what about a bot, so it doesn't claim to have changed them.
    public var identityNote: String

    public static let fileName = "bot-words.json"

    /// The file, as a box reads it.
    public static var data: Data {
        get throws { try Data(contentsOf: Bundle.module.url(forResource: "bot-words", withExtension: "json")!) }
    }

    /// This version's.
    public static let shipped: BotWords = {
        do {
            return try JSONDecoder().decode(BotWords.self, from: data)
        } catch {
            fatalError("KuvoLink's bot-words.json can't be read: \(error)")
        }
    }()
}
