/// The answers to a permission, numbered as both apps list them in the composer's place, in
/// Claude Code's and Codex's order: 1 Allow Once, 2 Always Allow…, 3 Don't Allow, 4 Tell It What
/// to Do Instead…. On the Mac, the number keys pick them.
public enum PermissionAnswer: Int, CaseIterable, Sendable {
    case once = 1
    case always
    case reject
    /// Don't Allow, with your words: the agent hears them as your message.
    case instead

    /// Its words; Always's are what it saves (`AlwaysWords`), whose `named` part shows as code.
    public func title(_ always: AlwaysWords) -> String {
        switch self {
        case .once: "Allow Once"
        case .always: always.title
        case .reject: "Don’t Allow"
        case .instead: "Tell It What to Do Instead…"
        }
    }

    /// What Always names, shown as code after its title (`git push`); nothing for the others.
    public func named(_ always: AlwaysWords) -> String? {
        self == .always ? always.named : nil
    }

    /// As VoiceOver reads it.
    public func spoken(_ always: AlwaysWords) -> String {
        self == .always ? always.spoken : title(always)
    }

    /// The line it opens, before anything's written in it.
    public static let insteadPlaceholder = "Tell it what to do instead…"
}
