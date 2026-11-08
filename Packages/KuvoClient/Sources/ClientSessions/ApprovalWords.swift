/// What a conversation's modes are called and do, as the composer's Mode menu shows them on the
/// Mac and the phone. Each one says what it does in a few words, short enough for one line of a
/// phone's menu, which is narrow: a longer one made each row three or four lines tall (#229).
public enum ApprovalWords {
    /// A mode by the name its box keeps it under (`metadata.kuvo.approval`).
    public static func title(_ approval: String) -> String {
        switch approval {
        case "askFirst": "Ask First"
        case "acceptEdits": "Accept Edits"
        case "fullAccess": "Full Access"
        default: "Auto"
        }
    }

    public static func detail(_ approval: String) -> String {
        switch approval {
        case "askFirst": "Asks before it acts"
        case "acceptEdits": "Asks before commands"
        case "fullAccess": "No sandbox, no asks"
        default: "Sandbox, then review"
        }
    }

    public static func symbol(_ approval: String) -> String {
        switch approval {
        case "askFirst": "hand.raised"
        case "acceptEdits": "pencil.line"
        case "fullAccess": "bolt"
        default: "checkmark.shield"
        }
    }

    /// Autopilot, beside the modes: it decides for itself and leaves what needs you for the end.
    public static let autopilot = "Decides, asks later"
    /// Auto's Decisions…, under the modes once it has some.
    public static let decisions = "Allowed and held back"
}
