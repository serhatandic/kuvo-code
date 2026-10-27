import ClientDesign
import KuvoVoice
import SwiftUI

/// What's been said so far: the words it's sure of, then its newest guess, lighter.
struct VoiceWords: View {
    let transcript: VoiceTranscript
    var font: Font = .body
    var placeholder = "Listening…"
    var alignment: TextAlignment = .leading
    /// What's written already, before what's said (in the composer).
    var before = ""

    var body: some View {
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
struct VoiceTrace: View {
    let levels: [Double]
    var bars = VoiceInput.recentCount

    var body: some View {
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

/// A key's name, beside the button it presses.
struct KeyHint: View {
    let key: String
    init(_ key: String) { self.key = key }

    var body: some View {
        Text(key)
            .font(.system(size: 11))
            .opacity(0.7)
            .accessibilityHidden(true)
    }
}

/// In the composer's chips' place while it listens ("In the Composer"): a red dot, how long it's
/// been, how loud you are, Cancel (Escape) and Done (Return). Getting ready, or failed, it says so.
struct VoiceComposerRow: View {
    let voice: VoiceInput
    let cancel: () -> Void
    let done: () -> Void
    let openSettings: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            switch voice.phase {
            case .preparing(let progress):
                Spinner(size: 13)
                Text(progress.map { "Getting voice ready… \(Int(($0 * 100).rounded()))%" } ?? "Getting voice ready…")
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
            case .failed(let failure):
                Image(systemName: "mic.slash")
                    .foregroundStyle(.secondary)
                Text(failure.message)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if failure.opensSettings {
                    Button("Open Settings", action: openSettings)
                        .buttonStyle(TextButtonStyle())
                }
            default:
                Circle()
                    .fill(.red)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                if let since = voice.listeningSince {
                    Text(since, style: .timer)
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Listening")
                }
                VoiceTrace(levels: voice.recentLevels)
                    .frame(height: 22)
                    .frame(maxWidth: .infinity)
            }
            Button(action: cancel) {
                HStack(spacing: 5) {
                    Text("Cancel")
                    KeyHint("esc")
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .help("Stop listening, without keeping what you said (Escape)")
            if voice.phase == .listening || voice.phase == .finishing {
                Button(action: done) {
                    HStack(spacing: 5) {
                        Text("Done")
                        KeyHint("⏎")
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .disabled(voice.phase == .finishing)
                .help("Put what you said in the message (Return). A pause does this too.")
            }
        }
        .font(.system(size: 13))
        .controlSize(.regular)
        .frame(minHeight: 32)
    }
}

/// The voice field ("Voice Field"): the whole window steps back while you speak. How long it's
/// been, what you say, large, a line moving with your voice, and Cancel and Done. A pause
/// finishes it, and the words go into the composer.
struct VoiceField: View {
    let voice: VoiceInput
    let cancel: () -> Void
    let done: () -> Void
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(status)
                if let since = voice.listeningSince, voice.phase == .listening {
                    Text("·").foregroundStyle(.tertiary)
                    Text(since, style: .timer).monospacedDigit()
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .padding(.top, 52)
            Spacer(minLength: 24)
            Group {
                if case .failed(let failure) = voice.phase {
                    Text(failure.message)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                } else {
                    VoiceWords(transcript: voice.transcript, font: .system(size: 30, weight: .medium), placeholder: "Say what you’d like to ask", alignment: .center)
                }
            }
            .frame(maxWidth: 760)
            .padding(.horizontal, 48)
            Spacer(minLength: 24)
            VoiceWave(level: voice.level)
                .frame(height: 56)
                .padding(.bottom, 28)
            HStack(spacing: 14) {
                Button(action: cancel) {
                    HStack(spacing: 6) {
                        Text("Cancel")
                        KeyHint("esc")
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .keyboardShortcut(.cancelAction)
                .help("Stop listening, without keeping what you said (Escape)")
                if case .failed(let failure) = voice.phase {
                    if failure.opensSettings {
                        Button("Open Settings", action: openSettings)
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                    }
                } else {
                    Text("A pause finishes it")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                    Button(action: done) {
                        HStack(spacing: 6) {
                            Text("Done")
                            KeyHint("⏎")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .keyboardShortcut(.defaultAction)
                    .disabled(voice.phase != .listening)
                    .help("Put what you said in the message (Return)")
                }
            }
            .controlSize(.large)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voice input")
    }

    private var status: String {
        switch voice.phase {
        case .preparing(let progress): progress.map { "Getting voice ready… \(Int(($0 * 100).rounded()))%" } ?? "Getting voice ready…"
        case .finishing: "Finishing…"
        case .failed: "Voice input stopped"
        default: "Listening"
        }
    }
}

/// Lines across the window moving with your voice: still when you're quiet, soft waves as you
/// speak, a fainter two behind the first.
struct VoiceWave: View {
    let level: Double

    var body: some View {
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

/// The voice field over the whole window while it listens ("Voice Field"): the window steps
/// back, blurred and dimmed, behind what you say.
struct VoiceFieldCover: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let voice = app.dictation.voice, app.dictation.style == .field {
            VoiceField(voice: voice, cancel: { app.dictation.cancel() }, done: { app.dictation.finish() }, openSettings: { Composer.openPrivacySettings(for: voice.phase) })
                .background {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .overlay(Color(nsColor: .windowBackgroundColor).opacity(scheme == .dark ? 0.82 : 0.78))
                }
                .ignoresSafeArea()
                .transition(.opacity)
        }
    }
}
