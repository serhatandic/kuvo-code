import Foundation

/// A wake-up's note as its line shows it, in both apps: what to do, first. An agent often starts
/// one with the conversation's folder ("In /Users/…/salary-demo, check whether…"), which the
/// conversation already has: that goes, and what follows starts with a capital. A note that starts
/// otherwise stays as written.
public enum WakeNote {
    public static func shown(_ note: String) -> String {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        // "In /path, …", "in `~/path`: …", or "/path: …", the path absolute or from home.
        let pattern = #"^(?:[Ii]n\s+)?`?(?:/|~/)[^,:`\n]*`?\s*[,:]\s+(.+)$"#
        guard let match = text.range(of: pattern, options: .regularExpression),
              let regex = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]),
              let found = regex.firstMatch(in: text, range: NSRange(match, in: text)),
              let rest = Range(found.range(at: 1), in: text) else { return text }
        let words = String(text[rest])
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
