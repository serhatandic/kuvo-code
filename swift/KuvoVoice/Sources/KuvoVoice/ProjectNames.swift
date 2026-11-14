import Foundation

/// The project's names, put back the way they're written in what was heard: words said apart
/// that spell one ("fetch user" → `fetchUser`, "content view.swift" → `ContentView.swift`), one
/// written in the wrong case ("useeffect" → `useEffect`), or one run into the word before it
/// ("callsFetchUser" → "calls `fetchUser`"). Only ever to a name it was given, so other words are
/// left as they were said.
struct ProjectNames: Sendable {
    /// Each name by its letters and digits alone, lowercased.
    private let names: [String: String]
    /// The most words a name is said in.
    private static let longest = 4

    init(_ words: [String]) {
        var names: [String: String] = [:]
        for word in words {
            let key = Self.key(word)
            guard key.count >= 3, names[key] == nil else { continue }
            names[key] = word
        }
        self.names = names
    }

    var isEmpty: Bool { names.isEmpty }

    func fix(_ text: String) -> String {
        guard !names.isEmpty else { return text }
        let words = text.split(separator: " ", omittingEmptySubsequences: true).map(Word.init)
        var fixed: [Word] = []
        var index = 0
        while index < words.count {
            // The most words that spell one name, from here.
            var joined = false
            for count in stride(from: min(Self.longest, words.count - index), through: 2, by: -1) {
                let span = words[index..<index + count]
                guard let name = names[Self.key(span.map(\.core).joined())] else { continue }
                fixed.append(Word(lead: span.first!.lead, core: name, trail: span.last!.trail))
                index += count
                joined = true
                break
            }
            if joined { continue }
            fixed.append(fixWord(words[index]))
            index += 1
        }
        return fixed.map { $0.lead + $0.core + $0.trail }.joined(separator: " ")
    }

    private func fixWord(_ word: Word) -> Word {
        let key = Self.key(word.core)
        // In the wrong case: only names whose case says something (`useEffect`, `README`,
        // `src/timer.ts`), so "Test" opening a sentence stays.
        if let name = names[key], name != word.core, Self.isShaped(name) {
            return Word(lead: word.lead, core: name, trail: word.trail)
        }
        // Run into the word before it: "callsFetchUser".
        let letters = Array(word.core)
        for split in 2..<max(2, letters.count - 3) where letters[split].isUppercase && letters[split - 1].isLowercase {
            let rest = String(letters[split...])
            if let name = names[Self.key(rest)], Self.isShaped(name), name.lowercased() == rest.lowercased() {
                return Word(lead: word.lead, core: String(letters[..<split]) + " " + name, trail: word.trail)
            }
        }
        return word
    }

    /// A name written in a way of its own: capitals past its first letter, or a dot, slash, dash or underscore in it.
    private static func isShaped(_ name: String) -> Bool {
        name.dropFirst().contains { $0.isUppercase } || name.contains { ".-_/".contains($0) }
    }

    private static func key(_ text: String) -> String {
        String(text.lowercased().filter { $0.isLetter || $0.isNumber })
    }

    /// A word as heard, and the punctuation around it, which stays.
    private struct Word {
        let lead: String
        let core: String
        let trail: String

        init(lead: String, core: String, trail: String) {
            self.lead = lead
            self.core = core
            self.trail = trail
        }

        init(_ raw: Substring) {
            let marks: Set<Character> = [",", ".", ";", ":", "!", "?", "\"", "'", "(", ")", "“", "”", "‘", "’"]
            var core = Substring(raw)
            var lead = "", trail = ""
            while let first = core.first, marks.contains(first) { lead.append(first); core = core.dropFirst() }
            while let last = core.last, marks.contains(last) { trail.insert(last, at: trail.startIndex); core = core.dropLast() }
            self.lead = lead
            self.core = String(core)
            self.trail = trail
        }
    }
}
