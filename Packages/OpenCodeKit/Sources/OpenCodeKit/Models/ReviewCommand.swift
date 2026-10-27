import Foundation

/// What follows "/review": who reads the changes ("with DeepSeek V4.1 Flash": one of the
/// conversation's models by its name; its own model without it) and what to look at, written
/// after. The composer's "Who reads it" writes the first part, and draws it with the keyword.
public struct ReviewCommand: Equatable, Sendable {
    /// A model it can be read by: its name as the lists show it.
    public struct Reader: Equatable, Sendable {
        public var name: String
        public var ref: ModelRef
        /// Who serves it ("GitHub Copilot"), which a search finds it by too.
        public var provider: String

        public init(name: String, ref: ModelRef, provider: String = "") {
            self.name = name
            self.ref = ref
            self.provider = provider
        }
    }

    /// Who reads it, when "with" names one; nil for the conversation's own model.
    public var reader: Reader?
    /// What to look at, as written after who reads it.
    public var focus: String
    /// How much of what follows "/review" names who reads it, in UTF-16, spaces before it
    /// included (0 without): the composer draws it as part of the keyword.
    public var readerLength = 0
    /// "with" and words that name none of them yet, but could: those words, which "Who reads it"
    /// looks for. Words that can be no model's are what to look at ("with an eye on the tests").
    public var searching: String?

    /// What follows "/review", read against `readers`; of two with the same name, `preferred`.
    public init(_ rest: String, readers: [Reader], preferring preferred: ModelRef? = nil) {
        let start = rest.firstIndex { !$0.isWhitespace } ?? rest.endIndex
        let words = rest[start...]
        guard words.lowercased().hasPrefix("with"), words.dropFirst(4).first?.isWhitespace != false else {
            focus = rest.trimmingCharacters(in: .whitespacesAndNewlines)
            return
        }
        let afterWith = words.dropFirst(4)
        let name = afterWith.drop { $0.isWhitespace }
        // The longest name it starts with, as a whole word: "Claude Sonnet 4.5", not "Claude".
        let named = readers.filter { reader in
            let length = reader.name.count
            guard length > 0, name.count >= length, name.prefix(length).lowercased() == reader.name.lowercased() else { return false }
            return name.dropFirst(length).first?.isWhitespace != false
        }
        guard let longest = named.map(\.name.count).max() else {
            let query = String(name).trimmingCharacters(in: .whitespacesAndNewlines)
            if query.isEmpty || !Self.search(query, in: readers).isEmpty {
                focus = ""
                searching = query
            } else {
                focus = rest.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return
        }
        let candidates = named.filter { $0.name.count == longest }
        let reader = candidates.first { $0.ref == preferred } ?? candidates[0]
        self.reader = reader
        let end = name.index(name.startIndex, offsetBy: longest)
        readerLength = rest[..<end].utf16.count
        focus = name[end...].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Those whose name, or who serves them, has each of the words of `query`.
    public static func search(_ query: String, in readers: [Reader]) -> [Reader] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return readers.filter { reader in
            let said = (reader.name + " " + reader.provider).lowercased()
            return words.allSatisfy { said.contains($0) }
        }
    }

    /// While a name is still being typed after "/review with " (nothing after it yet): the
    /// longer names it's the start of ("Claude" of "Claude Sonnet 4.5"), still to be offered.
    public static func longer(than rest: String, readers: [Reader]) -> [Reader] {
        guard rest.last?.isWhitespace == false else { return [] }
        let words = rest.drop { $0.isWhitespace }
        guard words.lowercased().hasPrefix("with"), words.dropFirst(4).first?.isWhitespace == true else { return [] }
        let typed = words.dropFirst(4).drop { $0.isWhitespace }.lowercased()
        return readers.filter { $0.name.count > typed.count && $0.name.lowercased().hasPrefix(typed) }
    }

    /// What "Who reads it" writes after "/review ", for `reader`.
    public static func phrase(_ reader: Reader) -> String {
        "with " + reader.name
    }
}
