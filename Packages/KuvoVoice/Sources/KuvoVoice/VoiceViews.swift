import SwiftUI

// What voice input looks like in both apps, one copy: the words as they come, how loud you've
// been, the line that moves with your voice, and the choice of how it shows.

/// How voice input shows itself (the Mac's Settings › General, the phone's About): in the
/// composer, which listens where you type (the default), or the voice field, which takes the
/// window's or screen's place while you speak.
public enum VoiceStyle: String, CaseIterable, Identifiable, Sendable {
    case composer, field

    public static let key = "voiceStyle"
    public var id: String { rawValue }

    public static var current: VoiceStyle {
        UserDefaults.standard.string(forKey: key).flatMap(VoiceStyle.init(rawValue:)) ?? .composer
    }

    public var title: String {
        switch self {
        case .composer: "In the Composer"
        case .field: "Voice Field"
        }
    }

    /// What it's for, beside its name.
    public var purpose: String {
        switch self {
        case .composer: "for quick notes"
        case .field: "for longer thoughts"
        }
    }

    /// What's written, with what was said after it, a space between unless one's there.
    public static func adding(_ words: String, to text: String) -> String {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return words }
        let separator = text.hasSuffix("\n") || text.hasSuffix(" ") ? "" : " "
        return text + separator + words
    }
}

/// What's been said so far: the words it's sure of, then its newest guess, lighter; after what's
/// written already, in the composer.
public struct VoiceWords: View {
    let transcript: VoiceTranscript
    var font: Font
    var placeholder: String
    var alignment: TextAlignment
    var before: String

    public init(transcript: VoiceTranscript, font: Font = .body, placeholder: String = "Listening…", alignment: TextAlignment = .leading, before: String = "") {
        self.transcript = transcript
        self.font = font
        self.placeholder = placeholder
        self.alignment = alignment
        self.before = before
    }

    public var body: some View {
        Group {
            if transcript.isEmpty, before.isEmpty {
                Text(placeholder).foregroundStyle(.secondary)
            } else {
                let lead = before.isEmpty ? "" : before + (transcript.isEmpty ? "" : " ")
                Text("\(Text(lead))\(Text(transcript.confirmed))\(Text(transcript.confirmed.isEmpty || transcript.guess.isEmpty ? "" : " "))\(Text(transcript.guess).foregroundStyle(.secondary))")
            }
        }
        .font(font)
        .multilineTextAlignment(alignment)
        .accessibilityLabel(transcript.isEmpty ? "Listening" : "Heard: \(transcript.text)")
    }
}

/// How loud you've been, as bars across, the newest at the end.
public struct VoiceTrace: View {
    let levels: [Double]
    var bars: Int

    public init(levels: [Double], bars: Int = VoiceInput.recentCount) {
        self.levels = levels
        self.bars = bars
    }

    public var body: some View {
        Canvas { context, size in
            let gap: CGFloat = 2
            let width = max(1, (size.width - gap * CGFloat(bars - 1)) / CGFloat(bars))
            let shown = Array(levels.suffix(bars))
            let start = bars - shown.count
            for index in 0..<bars {
                let level = index >= start ? shown[index - start] : 0
                let height = max(2, CGFloat(level) * size.height)
                let rect = CGRect(x: CGFloat(index) * (width + gap), y: (size.height - height) / 2, width: width, height: height)
                context.fill(Path(roundedRect: rect, cornerRadius: width / 2), with: .style(.tint.opacity(index >= start ? 1 : 0.25)))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Lines across moving with your voice: still when you're quiet, soft waves as you speak, a
/// fainter two behind the first.
public struct VoiceWave: View {
    let level: Double

    public init(level: Double) {
        self.level = level
    }

    public var body: some View {
        Canvas { context, size in
            for (amplitude, phase, opacity, width) in [(0.42, 0.0, 1.0, 2.4), (0.28, 1.7, 0.35, 1.6), (0.18, 3.1, 0.2, 1.4)] {
                var path = Path()
                let middle = size.height / 2
                let height = CGFloat(max(0.04, level)) * size.height * amplitude
                let steps = 160
                for step in 0...steps {
                    let t = Double(step) / Double(steps)
                    let x = size.width * t
                    // Fades at the ends, so the lines rest on them.
                    let envelope = sin(t * .pi)
                    let y = middle + height * CGFloat(envelope * (sin(t * 9 + phase) * 0.6 + sin(t * 23 + phase * 2) * 0.4))
                    if step == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                }
                context.stroke(path, with: .style(.tint.opacity(opacity)), style: StrokeStyle(lineWidth: width, lineCap: .round))
            }
        }
        .animation(.easeOut(duration: 0.1), value: level)
        .accessibilityHidden(true)
    }
}

/// The one word, after someone's first dictation and never before it, that voice input can be
/// more accurate: shown once, from the mic, while that's off on a device that can run it.
public enum VoiceTip {
    static let key = "voice.tip.shown"

    public static let title = "More accurate voice input"

    /// What it is, in plain words: `device` is "Mac" or "iPhone".
    public static func line(device: String) -> String { "Uses a more capable model that runs on this \(device)." }

    /// After Not Now, where it is: `settings` is the page's path.
    public static func later(settings: String) -> String { "You can turn it on anytime in \(settings)." }

    /// A dictation just wrote something: whether to show the tip now. Its turn is taken as it's
    /// shown, so it never shows again, however it's closed.
    @MainActor
    public static func takeTurn(model: SpeechModel = .shared, defaults: UserDefaults = .standard) -> Bool {
        guard !defaults.bool(forKey: key), !model.isOn, model.state != .unsupported else { return false }
        defaults.set(true, forKey: key)
        return true
    }
}
