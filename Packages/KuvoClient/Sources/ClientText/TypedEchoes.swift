/// A message field's own typing coming back to it late. A busy app hands the field its draft as it
/// was a key or two ago, in order, after the field has gone on, and putting that back would lose
/// the keys since. A field redrawn before what holds it (a quote's answer) is also handed the words
/// from before its first key, and the same older words again in the next pass. Those are echoes;
/// anything else handed to the field is a change from the app (a message sent, a draft brought
/// back), and applies.
///
/// When the app puts words in the field itself on a key (Return sends and empties it, ↑ brings an
/// earlier message back), the field says so with `changing(to:)`: those words may be ones it had a
/// moment ago, but handed now they're the app's.
public struct TypedEchoes: Sendable {
    /// What the field has told its draft that hasn't been handed back yet, oldest first, after the
    /// words it had when the typing started.
    private var typed: [String] = []
    /// What the field was last handed.
    private var handed = ""

    public init() {}

    /// The field told its draft `text` (a key typed, a word deleted).
    public mutating func told(_ text: String) {
        if typed.isEmpty { typed.append(handed) }
        typed.append(text)
        if typed.count > 64 { typed.removeFirst() }
    }

    /// The app is putting `text` in the field (on a key the field passed it): when it's handed,
    /// it applies, even if the field had those words before.
    public mutating func changing(to text: String) {
        typed.removeAll { $0 == text }
    }

    /// Whether `text`, handed to the field, is its own typing coming back. What it told the draft
    /// before it is let go; `text` stays, as it can come back again. Anything else lets all of it go.
    public mutating func isEcho(_ text: String) -> Bool {
        defer { handed = text }
        guard let index = typed.firstIndex(of: text) else {
            typed.removeAll()
            return false
        }
        typed.removeFirst(index)
        return true
    }
}
