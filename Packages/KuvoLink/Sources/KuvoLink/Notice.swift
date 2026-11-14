import Foundation

/// What a host's push tells the phone, sealed in a mail (PROTOCOL.md, "Notifications"): the
/// notification the Mac shows, for the phone to show the same.
public struct Notice: Codable, Equatable, Sendable {
    /// What it's about, which the phone's buttons hang on. Any word decodes, so a phone takes
    /// one from a newer host and shows it plainly.
    public struct Category: RawRepresentable, Codable, Hashable, Sendable {
        public let rawValue: String

        public init(rawValue: String) { self.rawValue = rawValue }

        public init(from decoder: Decoder) throws {
            rawValue = try decoder.singleValueContainer().decode(String.self)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(rawValue)
        }

        /// An agent asks to do something (`request` is the permission).
        public static let permission = Category(rawValue: "permission")
        /// An agent asks a question or for a form filled in (`request` is the form).
        public static let question = Category(rawValue: "question")
        /// An agent browsing asks for a sign-in, a code or a step (`ask` is it).
        public static let ask = Category(rawValue: "ask")
        /// A run finished, or stopped with an error.
        public static let finished = Category(rawValue: "finished")
        public static let failed = Category(rawValue: "failed")
        /// A bot's news: a wake-up's or a watch's result, a goal's digest (quiet) or its report.
        public static let report = Category(rawValue: "report")
        /// A bot's goal needs you. Quiet (`data["quiet"]`), unless you asked to be woken (`data["wake"]`).
        public static let blocked = Category(rawValue: "blocked")
        /// A quota or pace notice decided by the account's reading box.
        public static let usage = Category(rawValue: "usage")
        /// A group chat's message.
        public static let message = Category(rawValue: "message")
    }

    public var t = "notify"
    /// Who's telling: a bot's name, a session's title, a group chat's name.
    public var title: String
    /// What it's in, or who in a group chat, when there's that.
    public var subtitle: String?
    public var body: String
    public var category: Category
    /// What the phone groups it under: the session, or the group chat.
    public var thread: String
    /// Where it opens: `session` or `group`, with `request` (a permission or a form, to answer it
    /// from the notification) or `ask`.
    public var data: [String: String]

    /// A mail's payload stays this small, so the push it goes in fits what Apple takes.
    public static let limit = 2500

    public init(title: String, subtitle: String? = nil, body: String, category: Category, thread: String, data: [String: String]) {
        self.title = title
        self.subtitle = subtitle
        self.body = body
        self.category = category
        self.thread = thread
        self.data = data
    }

    /// The JSON, under `limit`: what doesn't fit of the body ends in "…".
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var notice = self
        notice.title = Self.cut(title, to: 200)
        notice.subtitle = subtitle.map { Self.cut($0, to: 200) }
        while true {
            let data = try encoder.encode(notice)
            if data.count <= Self.limit || notice.body.isEmpty { return data }
            // As many bytes off as there are too many, and room for the "…".
            let room = notice.body.utf8.count - (data.count - Self.limit) - "…".utf8.count
            notice.body = room <= 0 ? "" : Self.prefix(notice.body, bytes: room).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        }
    }

    /// The characters of `text` that fit in `bytes` of UTF-8.
    private static func prefix(_ text: String, bytes: Int) -> String {
        var result = "", count = 0
        for character in text {
            count += character.utf8.count
            if count > bytes { break }
            result.append(character)
        }
        return result
    }

    private static func cut(_ text: String, to count: Int) -> String {
        text.count <= count ? text : String(text.prefix(count - 1)) + "…"
    }
}
