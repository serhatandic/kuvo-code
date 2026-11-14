import Foundation

/// A reply in one line, for the sidebar or a notification: Markdown's marks taken off (headings
/// and quotes at a line's start, emphasis around words, code ticks, a link's address), not the
/// words, so `snake_case`, a path, "C#" and "2 * 3" stay as written. The machines' bridge does
/// the same (`plain` in kuvo-link.js), and the phone uses this one.
public enum ReplyPreview {
    public static func line(_ markdown: String, limit: Int = 220) -> String {
        let plain = markdown
            .replacingOccurrences(of: #"(?m)^[ \t]{0,3}(#{1,6}|>+)[ \t]+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)\s]*\)"#, with: "$1", options: .regularExpression)
            .replacingOccurrences(of: #"(?<![\w*_])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\w*_])"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return plain.count > limit ? String(plain.prefix(limit - 1)) + "…" : plain
    }
}
