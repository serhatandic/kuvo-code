import ClientDesign
import KuvoVoice
import SwiftUI

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
                // Downloading Apple's speech model for your language, when it says how far;
                // asking for the microphone, or loading Whisper, not.
                if let progress {
                    Text("Getting voice ready…")
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    ProgressLine("Downloading the speech model", fraction: progress, layout: .inline)
                        .frame(maxWidth: 260)
                } else {
                    Spinner(size: 13)
                    Text("Getting voice ready…")
                        .foregroundStyle(.secondary)
                }
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
            // Escape anywhere in the window (the composer's field handles it first).
            .keyboardShortcut(.cancelAction)
            .help("Stop listening, without keeping what you said (Escape)")
            if voice.phase == .listening || voice.phase == .finishing || voice.keepsWords {
                Button(action: done) {
                    HStack(spacing: 5) {
                        Text("Done")
                        KeyHint("⏎")
                    }
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .disabled(voice.phase == .finishing)
                .help("Put what you said in the message (Return)")
            }
        }
        .font(.system(size: 13))
        .controlSize(.regular)
        .frame(minHeight: 32)
    }

}

/// The voice field ("Voice Field"): the whole window steps back while you speak. How long it's
/// been, what you say, large, a line moving with your voice, and Cancel and Done, which puts the
/// words in the composer. Silence never ends it: you may think between words.
struct VoiceField: View {
    let voice: VoiceInput
    let cancel: () -> Void
    let done: () -> Void
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text(voice.status)
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
                    VStack(spacing: 16) {
                        // What was written before it stopped, for Done to take.
                        if voice.keepsWords {
                            VoiceWords(transcript: voice.transcript, font: .system(size: 30, weight: .medium), alignment: .center)
                        }
                        Text(failure.message)
                            .font(voice.keepsWords ? .body : .title3)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                } else {
                    VoiceWords(transcript: voice.transcript, font: .system(size: 30, weight: .medium), placeholder: "Say what you’d like to ask", alignment: .center)
                }
            }
            .frame(maxWidth: 760)
            .padding(.horizontal, 48)
            Spacer(minLength: 24)
            VoiceWave(level: voice.level)
                .frame(height: 56)
                .padding(.bottom, 44)
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
                if case .failed(let failure) = voice.phase, failure.opensSettings || voice.transcript.isEmpty {
                    if failure.opensSettings {
                        Button("Open Settings", action: openSettings)
                            .buttonStyle(.borderedProminent)
                            .buttonBorderShape(.capsule)
                    }
                } else {
                    Button(action: done) {
                        HStack(spacing: 6) {
                            Text("Done")
                            KeyHint("⏎")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .keyboardShortcut(.defaultAction)
                    // Stopped by a failure, it still takes what was written.
                    .disabled(voice.phase != .listening && !voice.keepsWords)
                    .help("Put what you said in the message (Return)")
                }
            }
            .controlSize(.large)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Voice input")
        // Over everything: VoiceOver stays in it, as it would in a sheet.
        .accessibilityAddTraits(.isModal)
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
