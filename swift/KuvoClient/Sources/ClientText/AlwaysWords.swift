import Foundation

/// What a permission's Always saves, as its button names it: "Always Allow Edits", "Always Allow
/// `git push`", "Always Allow `~/notes`"; whole in its hover text and for VoiceOver. The same on
/// the Mac's card and notifications and the phone's.
public struct AlwaysWords: Equatable, Sendable {
    /// The button's words before what it names (`named`), or all of them where it names nothing.
    public let title: String
    /// What it names, short, shown as code: a command's kind, a folder.
    public let named: String?
    /// What Always does, whole: the hover text.
    public let help: String
    /// The button as VoiceOver reads it.
    public let spoken: String

    /// The button's words as plain text (a notification's button): "Always Allow git push".
    public var plain: String { named.map { "\(title) \($0)" } ?? title }

    /// Longer than this, what the button names is cut, and whole in the hover text.
    public static let longest = 24

    /// The words for an ask: its action, what Always would save (`save`, else what it asks for),
    /// whose home folders are `~` (`home`, nil for a machine's), and whether Always lasts for this
    /// conversation (a coding agent's: Claude Code, Codex) or this project (the engine's).
    public static func of(action: String, save: [String]?, resources: [String], home: String?, forConversation: Bool = false) -> AlwaysWords {
        // The line asked about, saved beside its kind (`git --no-pager diff` with `git diff *`): the
        // kind says what it lets through.
        let saved = save ?? resources
        let kinds = saved.filter { !resources.contains($0) }
        let patterns = kinds.isEmpty ? saved : kinds
        let here = forConversation ? "in this conversation" : "in this project"
        switch action {
        case "edit", "patch", "write":
            return AlwaysWords(title: "Always Allow Edits", named: nil, help: "Don’t ask again before changing files \(here)", spoken: "Always allow edits \(here)")
        case "shell", "bash":
            guard patterns != ["*"], !patterns.isEmpty else {
                return AlwaysWords(title: "Always Allow Commands", named: nil, help: "Don’t ask again before running commands \(here)", spoken: "Always allow commands \(here)")
            }
            let kinds = patterns.map(kind)
            guard kinds.count == 1, let only = kinds.first else {
                return AlwaysWords(title: "Always Allow These Commands", named: nil, help: "Don’t ask again \(here) before running: " + kinds.joined(separator: ", "),
                                   spoken: "Always allow these commands: " + kinds.joined(separator: ", "))
            }
            let whole = patterns[0].hasSuffix(" *") ? "\(only) commands" : only
            return AlwaysWords(title: "Always Allow", named: short(only), help: "Don’t ask again before running \(whole) \(here)", spoken: "Always allow \(whole)")
        case "external_directory":
            let shown = patterns.map { OutsideFolders.shown($0, home: home) }
            guard shown.count == 1, let only = shown.first else {
                return AlwaysWords(title: "Always Allow These Folders", named: nil, help: "Don’t ask again before working in " + shown.joined(separator: ", "),
                                   spoken: "Always allow working in " + patterns.map { OutsideFolders.spoken($0, home: home) }.joined(separator: "; "))
            }
            let named = only.count > longest ? "…/" + ((only as NSString).lastPathComponent) : only
            return AlwaysWords(title: "Always Allow", named: short(named), help: "Don’t ask again before working in \(only)",
                               spoken: "Always allow working in " + OutsideFolders.spoken(patterns[0], home: home))
        default:
            guard patterns != ["*"], patterns.count == 1, let only = patterns.first.map(kind) else {
                return AlwaysWords(title: "Always Allow", named: nil, help: "Don’t ask again for this kind of request \(here)", spoken: "Always allow this kind of request \(here)")
            }
            return AlwaysWords(title: "Always Allow", named: short(only), help: "Don’t ask again for \(only) \(here)", spoken: "Always allow \(only)")
        }
    }

    /// A saved pattern as people say it: "git push *" is git push.
    private static func kind(_ pattern: String) -> String {
        pattern.hasSuffix(" *") ? String(pattern.dropLast(2)) : pattern.hasSuffix("/*") ? String(pattern.dropLast(2)) : pattern
    }

    private static func short(_ text: String) -> String {
        text.count > longest ? String(text.prefix(longest - 1)) + "…" : text
    }
}
