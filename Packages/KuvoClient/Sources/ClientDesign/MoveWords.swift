import Foundation

/// What a row says of a bot, a chat or a group chat moving to another computer (PROTOCOL.md,
/// `kuvo/moves`), the same in both apps: how far it is, from what its box says of the move.
public enum MoveWords {
    /// "Moving to lab… 12 of 30 MB". `stage`: the move's (`holding`, `copying`, `switching`,
    /// `finishing`); `place`: the computer it's going to, by name; `sent` and `size`: bytes of its
    /// copy, while it's on its way.
    public static func status(stage: String, place: String, sent: Int? = nil, size: Int? = nil) -> String {
        switch stage {
        case "holding": "Getting ready to move to \(place)…"
        case "copying": "Moving to \(place)…" + (progress(sent: sent, size: size).map { " " + $0 } ?? "")
        case "switching", "finishing": "Finishing the move to \(place)…"
        default: "Moving to \(place)…"
        }
    }

    /// Move to Computer's question before a move: "Move “Trip plans” to lab?", with what goes and
    /// what's left. `kind`: "bot", "chat" or "group"; `name`: as a title says it (quoted, or "this
    /// chat"); `place`: where to, by name, `placeIsMac` whether that's a Mac, `toHere` whether it's
    /// the computer asking; `from`: the computer it leaves, by name (nil: the one asking), and
    /// whether that's a machine (its trash is Kuvo Code's own there).
    public static func question(kind: String, name: String, place: String, placeIsMac: Bool, toHere: Bool = false, from: String?, fromMachine: Bool) -> (title: String, message: String) {
        let what = switch kind {
        case "bot": "Its memory, files, wake-ups and conversation go there, and it carries on there; its seats in group chats start afresh there."
        case "group" where toHere: "Its messages and meeting come here, and it carries on here while this Mac is on; its bots stay where they are."
        case "group" where placeIsMac: "Its messages and meeting go there, and it carries on there while that Mac is on; its bots stay where they are."
        case "group": "Its messages and meeting go there, and it carries on there, also while your Macs are off."
        default: "Its conversation and wake-ups go there, and it carries on there."
        }
        let left = from.map { " on \($0)" } ?? " here"
        let trash = fromMachine ? "Kuvo Code’s trash folder " + (from == nil ? "here" : "there") : "the Trash"
        let leaves = kind == "group"
            ? "Nothing goes to it while it moves. What it leaves\(left) goes to \(trash)."
            : "Nothing goes to it while it moves. Its folder\(left) goes to \(trash), with a copy of its conversation in it."
        return ("Move \(name) to \(place)?", "\(what) \(leaves)")
    }

    /// "12 of 30 MB", as other progress is said (`ProgressLine.Words`); nil while its size isn't known.
    public static func progress(sent: Int?, size: Int?) -> String? {
        guard let size, size > 0 else { return nil }
        return ProgressLine.Words.amount(done: Int64(min(max(sent ?? 0, 0), size)), of: Int64(size))
    }
}
