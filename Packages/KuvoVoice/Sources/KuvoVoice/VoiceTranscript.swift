import Foundation

/// What's been said so far, as the recognizer hears it: words it's sure of (`confirmed`), then its
/// newest guess at what came after (`guess`), which it corrects as you go on ("time" becoming
/// "timer"). A guess is replaced by each newer one for the same stretch of speech, and by the
/// words it settles on.
public struct VoiceTranscript: Equatable, Sendable {
    /// Each stretch of speech it's settled on, in the order it was said, by where it starts (in seconds).
    private var settled: [(start: Double, text: String)] = []
    /// Its guess at what follows, and where that starts.
    private var pending: (start: Double, text: String)?

    public init() {}

    public static func == (a: VoiceTranscript, b: VoiceTranscript) -> Bool {
        a.confirmed == b.confirmed && a.guess == b.guess
    }

    /// A result from the recognizer: words for the stretch starting at `start`, final or a guess.
    public mutating func take(_ text: String, start: Double, isFinal: Bool) {
        if isFinal {
            settled.removeAll { abs($0.start - start) < 0.0005 }
            settled.append((start, text))
            settled.sort { $0.start < $1.start }
            // A guess about what it's now sure of goes.
            if let pending, pending.start <= start + 0.0005 { self.pending = nil }
        } else {
            pending = (start, text)
        }
    }

    /// The words it's sure of, joined as they were said.
    public var confirmed: String { Self.join(settled.map(\.text)) }
    /// Its newest guess at what came after them.
    public var guess: String { pending.map { Self.trimmed($0.text) } ?? "" }
    /// All of it: what goes into the composer.
    public var text: String { Self.join([confirmed, guess]) }
    public var isEmpty: Bool { text.isEmpty }

    private static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Pieces of speech as one text: a space between them, none before punctuation it begins with.
    static func join(_ pieces: [String]) -> String {
        pieces.map(trimmed).filter { !$0.isEmpty }.reduce("") { joined, piece in
            guard !joined.isEmpty else { return piece }
            return joined + (piece.first.map { ",.;:!?)".contains($0) } == true ? "" : " ") + piece
        }
    }
}
