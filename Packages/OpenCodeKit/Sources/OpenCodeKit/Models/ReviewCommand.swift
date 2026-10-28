import Foundation

/// What follows "/review": what it reads ("this branch", "since abc1234", "folder src/auth", "the
/// whole project", "about \"the auth module and its tests\""; the changes not committed yet without), what to look for ("for security"), who
/// reads it ("with DeepSeek V4.1 Flash": one of the conversation's models by its name; its own
/// model without it), in any order, then anything else to look at, in your words. The composer's
/// "What to review" and "Look for" write the first two, "with" looks for the third, and the
/// keyword is drawn with all three.
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

    /// What "Look for" offers besides anything wrong, as the box knows them.
    public enum Preset: String, CaseIterable, Sendable {
        case security, performance, accessibility
    }

    /// Which of the composer's lists what's typed is answering, and what's typed in it so far.
    public enum Asking: Equatable, Sendable {
        /// "What to review".
        case what(String)
        /// A commit after "since ", to start with.
        case commit(String)
        /// A folder after "folder ".
        case folder(String)
        /// What to review in your words, after "about " (its quotes not closed yet).
        case described(String)
        /// "Look for".
        case lookFor(String)
    }

    /// What it reads; nil for the changes not committed yet.
    public var scope: ReviewScope?
    /// What it looks for, picked from "Look for".
    public var preset: Preset?
    /// Who reads it, when "with" names one; nil for the conversation's own model.
    public var reader: Reader?
    /// What to look at, in your words: what's written after the rest ("for " left off).
    public var focus: String
    /// How much of what follows "/review" names what it reads, what it looks for and who reads
    /// it, in UTF-16, spaces before it included (0 without): the composer draws it as part of
    /// the keyword.
    public var readerLength = 0
    /// "with" and words that name none of them yet, but could: those words, which the model list
    /// looks for. Words that can be no model's are what to look at ("with an eye on the tests").
    public var searching: String?
    /// The list what's typed last is answering; nil once it's words of your own.
    public var asking: Asking?
    /// What follows "/review" before what `asking` answers: a pick is written after it.
    public var head: String
    /// A model's name that ends what's typed, as typed: longer names it starts may be meant.
    var readerTyped: String?

    /// What the box is asked to look at: the preset, your words, or both.
    public var focusAsked: String? {
        switch (preset, focus.isEmpty) {
        case (nil, true): nil
        case (nil, false): focus
        case (let preset?, true): preset.rawValue
        case (let preset?, false): preset.rawValue + ": " + focus
        }
    }

    /// The scope's words as the composer writes them.
    public static func phrase(_ scope: ReviewScope) -> String {
        switch scope {
        case .uncommitted: return uncommittedPhrase
        case .branch: return branchPhrase
        case .commits(let from, _): return "since " + (from.hasSuffix("^") ? String(from.dropLast()) : from)
        case .folder(let path): return "folder " + (path.contains(where: \.isWhitespace) ? "\"\(path)\"" : path)
        case .project: return projectPhrase
        // In quotes, which end it (one inside would end it early).
        case .described(let words, _): return "about \"" + String(words.map { isQuote($0) ? "'" : $0 }) + "\""
        }
    }

    public static func phrase(_ preset: Preset) -> String { "for " + preset.rawValue }

    static let uncommittedPhrase = "changes not committed yet"
    static let branchPhrase = "this branch"
    static let projectPhrase = "the whole project"

    /// What follows "/review", read against `readers`; of two with the same name, `preferred`.
    public init(_ rest: String, readers: [Reader], preferring preferred: ModelRef? = nil) {
        focus = ""
        head = ""
        var at = rest.startIndex
        // What's drawn with the keyword ends where the last thing it reads ends.
        var drawn = rest.startIndex
        // Where the thing a list is answering starts, when what's typed ends inside it.
        var open: String.Index?
        var scopeRead = false
        reading: while true {
            let start = rest[at...].firstIndex { !$0.isWhitespace } ?? rest.endIndex
            guard start < rest.endIndex else { break }
            let words = rest[start...]
            if !scopeRead, let (scope, end, asking) = Self.scope(in: words) {
                scopeRead = true
                self.scope = scope
                at = end
                drawn = end
                if let asking {
                    self.asking = asking
                    open = start
                }
                continue
            }
            if preset == nil, let (preset, end) = Self.preset(in: words) {
                self.preset = preset
                at = end
                drawn = end
                continue
            }
            if reader == nil, searching == nil, Self.isWord("with", at: words) {
                let name = words.dropFirst(4).drop { $0.isWhitespace }
                // The longest name it starts with, as a whole word: "Claude Sonnet 4.5", not "Claude".
                let named = readers.filter { reader in
                    let length = reader.name.count
                    guard length > 0, name.count >= length, name.prefix(length).lowercased() == reader.name.lowercased() else { return false }
                    return name.dropFirst(length).first?.isWhitespace != false
                }
                if let longest = named.map(\.name.count).max() {
                    let candidates = named.filter { $0.name.count == longest }
                    reader = candidates.first { $0.ref == preferred } ?? candidates[0]
                    let end = name.index(name.startIndex, offsetBy: longest)
                    if end == rest.endIndex { readerTyped = String(name[..<end]) }
                    at = end
                    drawn = end
                    continue
                }
                let query = String(name).trimmingCharacters(in: .whitespacesAndNewlines)
                // (A coding agent's conversation has none to look for: its own agent reads it.)
                if !readers.isEmpty, query.isEmpty || !Self.search(query, in: readers).isEmpty {
                    searching = query
                    readerLength = rest[..<drawn].utf16.count
                    head = String(rest[..<start])
                    asking = nil
                    return
                }
            }
            break
        }
        readerLength = rest[..<drawn].utf16.count
        if let open {
            head = String(rest[..<open])
            return
        }
        let tail = rest[at...].drop { $0.isWhitespace }
        let typed = String(tail)
        head = String(rest[..<tail.startIndex])
        // A pick goes after a space: "/review for security" + "this branch".
        if !head.isEmpty, head.last?.isWhitespace == false { head += " " }
        var written = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        // Who reads it, named after your own words: "for the sign-in with Claude Sonnet 4.5".
        if reader == nil, let (named, before) = Self.readerAtEnd(of: written, readers: readers, preferring: preferred) {
            reader = named
            written = before
        }
        focus = Self.isWord("for", at: Substring(written)) ? written.dropFirst(3).trimmingCharacters(in: .whitespaces) : written
        // Nothing of your own yet, or the start of what a list offers: that list, for it.
        let lower = typed.lowercased()
        // (Something else… writes "for ", for words of your own after it.)
        let ownWords = lower.hasPrefix("for ") && lower.dropFirst(4).allSatisfy(\.isWhitespace)
        if scope == nil, Self.whatWords.contains(where: { $0.hasPrefix(lower) }) {
            asking = .what(typed)
        } else if preset == nil, !ownWords, lower.isEmpty || Self.lookForWords.contains(where: { $0.hasPrefix(lower) }) {
            asking = .lookFor(typed)
        }
    }

    /// The words "What to review"'s rows are written and found by.
    static let whatWords = [uncommittedPhrase, "uncommitted", branchPhrase, "branch", "since ", "commits", "folder ", "a folder", projectPhrase, "whole project", "project", "about ", "something else"]
    /// "Look for"'s, past the first "for " (Something else… writes that, to type after).
    static let lookForWords = Preset.allCases.flatMap { [phrase($0), $0.rawValue] } + ["anything wrong", "something else"]

    /// A scope `words` start with, where it ends, and the list it's still being typed in when
    /// it ends what's typed (a commit or a folder, with what's typed of it; no scope yet while
    /// nothing is).
    static func scope(in words: Substring) -> (ReviewScope?, String.Index, Asking?)? {
        // The words the lists write, and the short ones they're found by.
        let phrases: [(String, ReviewScope)] = [(uncommittedPhrase, .uncommitted), ("uncommitted", .uncommitted), (branchPhrase, .branch(base: nil)), ("branch", .branch(base: nil)),
                                                (projectPhrase, .project), ("whole project", .project), ("project", .project)]
        for (phrase, scope) in phrases where isWord(phrase, at: words) {
            return (scope, words.index(words.startIndex, offsetBy: phrase.count), nil)
        }
        if isWord("since", at: words) {
            let after = words.dropFirst(5)
            // "since" alone, sent or still typed: the commit is still to come.
            if after.allSatisfy(\.isWhitespace) { return (nil, words.endIndex, .commit("")) }
            let ref = after.drop { $0.isWhitespace }.prefix { !$0.isWhitespace }
            if ref.isEmpty { return (nil, words.endIndex, .commit("")) }
            guard isRef(ref) else { return nil }
            return (.commits(from: ref + "^", to: nil), ref.endIndex, ref.endIndex == words.endIndex ? .commit(String(ref)) : nil)
        }
        if isWord("folder", at: words) {
            let after = words.dropFirst(6)
            if after.allSatisfy(\.isWhitespace) { return (nil, words.endIndex, .folder("")) }
            let path = after.drop { $0.isWhitespace }
            if let first = path.first, isQuote(first) {
                let inside = path.dropFirst()
                guard let close = inside.firstIndex(where: isQuote) else { return (inside.isEmpty ? nil : .folder(String(inside)), words.endIndex, .folder(String(inside))) }
                return (.folder(String(inside[..<close])), inside.index(after: close), nil)
            }
            let word = path.prefix { !$0.isWhitespace }
            if word.isEmpty { return (nil, words.endIndex, .folder("")) }
            return (.folder(String(word)), word.endIndex, word.endIndex == words.endIndex ? .folder(String(word)) : nil)
        }
        if isWord("about", at: words) {
            let after = words.dropFirst(5)
            if after.allSatisfy(\.isWhitespace) { return (nil, words.endIndex, .described("")) }
            let said = after.drop { $0.isWhitespace }
            let trimmed = { (text: Substring) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let first = said.first, isQuote(first) {
                let inside = said.dropFirst()
                guard let close = inside.firstIndex(where: isQuote) else {
                    return (trimmed(inside).isEmpty ? nil : .described(trimmed(inside)), words.endIndex, .described(String(inside)))
                }
                let text = trimmed(inside[..<close])
                return (text.isEmpty ? nil : .described(text), inside.index(after: close), nil)
            }
            // Still being written, without its quotes yet: what follows, up to what to look for or
            // who reads it ("about the sign-in for security").
            var end = said.endIndex
            var at = said.startIndex
            while at < said.endIndex {
                if said[at].isWhitespace {
                    let next = said[at...].drop { $0.isWhitespace }
                    if isWord("with", at: next) || preset(in: next) != nil {
                        end = at
                        break
                    }
                }
                at = said.index(after: at)
            }
            if end < said.endIndex { return (trimmed(said[..<end]).isEmpty ? nil : .described(trimmed(said[..<end])), end, nil) }
            return (.described(trimmed(said)), words.endIndex, .described(String(said)))
        }
        return nil
    }

    /// A straight quote, or a curly one, as a field that types them makes.
    static func isQuote(_ character: Character) -> Bool {
        character == "\"" || character == "“" || character == "”"
    }

    static func preset(in words: Substring) -> (Preset, String.Index)? {
        guard isWord("for", at: words) else { return nil }
        let after = words.dropFirst(3).drop { $0.isWhitespace }
        for preset in Preset.allCases where isWord(preset.rawValue, at: after) {
            return (preset, after.index(after.startIndex, offsetBy: preset.rawValue.count))
        }
        return nil
    }

    /// A model named at the end of `words` after "with" ("the sign-in with Claude Sonnet 4.5"), and
    /// the words before it; the longest name, and of two alike `preferred`.
    static func readerAtEnd(of words: String, readers: [Reader], preferring preferred: ModelRef?) -> (Reader, String)? {
        let lower = words.lowercased()
        let named = readers.filter { lower.hasSuffix(" with " + $0.name.lowercased()) }
        guard let longest = named.map(\.name.count).max() else { return nil }
        let candidates = named.filter { $0.name.count == longest }
        let reader = candidates.first { $0.ref == preferred } ?? candidates[0]
        let before = words.dropLast(longest + " with ".count).trimmingCharacters(in: .whitespaces)
        return (reader, before)
    }

    /// `words` start with `word`, in any case, as a whole word.
    static func isWord(_ word: String, at words: Substring) -> Bool {
        guard words.count >= word.count, words.prefix(word.count).lowercased() == word else { return false }
        return words.dropFirst(word.count).first?.isWhitespace != false
    }

    /// A commit, branch or tag as git names them (never an option, never a range), as the box
    /// takes them.
    static func isRef(_ ref: Substring) -> Bool {
        guard (1...200).contains(ref.count), ref.first != "-", !ref.contains("..") else { return false }
        return ref.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._/~^@{}+-".contains($0)) }
    }

    /// Those whose name, or who serves them, has each of the words of `query`.
    public static func search(_ query: String, in readers: [Reader]) -> [Reader] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return readers.filter { reader in
            let said = (reader.name + " " + reader.provider).lowercased()
            return words.allSatisfy { said.contains($0) }
        }
    }

    /// While a name is still being typed after "with " (nothing after it yet): the longer names
    /// it's the start of ("Claude" of "Claude Sonnet 4.5"), still to be offered.
    public static func longer(than rest: String, readers: [Reader]) -> [Reader] {
        guard let typed = ReviewCommand(rest, readers: readers).readerTyped?.lowercased() else { return [] }
        return readers.filter { $0.name.count > typed.count && $0.name.lowercased().hasPrefix(typed) }
    }

    /// What the model list writes after "/review ", for `reader`.
    public static func phrase(_ reader: Reader) -> String {
        "with " + reader.name
    }
}
