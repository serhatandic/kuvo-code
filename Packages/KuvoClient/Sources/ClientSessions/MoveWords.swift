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

    /// "12 of 30 MB", in the unit that suits its size; nil while its size isn't known.
    public static func progress(sent: Int?, size: Int?) -> String? {
        guard let size, size > 0 else { return nil }
        let sent = min(max(sent ?? 0, 0), size)
        let (unit, name): (Double, String) = size >= 1_000_000_000 ? (1e9, "GB") : size >= 1_000_000 ? (1e6, "MB") : (1e3, "KB")
        return "\(amount(Double(sent) / unit)) of \(amount(Double(size) / unit)) \(name)"
    }

    /// Whole above 10 ("12"), one place below it ("1.5"), as Finder rounds sizes.
    private static func amount(_ value: Double) -> String {
        if value >= 10 { return String(Int(value.rounded())) }
        let tenths = (value * 10).rounded() / 10
        return tenths == tenths.rounded() ? String(Int(tenths)) : String(format: "%.1f", tenths)
    }
}
