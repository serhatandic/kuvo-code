import ClientDesign
import KuvoVoice
import SwiftUI

/// Around the mic while Whisper comes: a thin ring that fills as it downloads (quiet while it
/// waits or is paused, whole while it's made ready). Nothing once it's in.
struct MicRing: View {
    let model: SpeechModel

    var body: some View {
        if model.isUnderway {
            ZStack {
                Circle().stroke(.quaternary, lineWidth: 1.5)
                Circle()
                    .trim(from: 0, to: model.state == .preparing ? 1 : max(0.02, model.fraction))
                    .stroke(model.state == .downloading || model.state == .preparing ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary),
                            style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.4), value: model.fraction)
            }
            .frame(width: 24, height: 24)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }

    /// For the mic's help and VoiceOver: what's coming, while it is.
    static func words(_ model: SpeechModel) -> String? {
        model.isUnderway ? "Whisper: \(model.status(device: "Mac"))" : nil
    }
}

/// Beside the trace while you talk: Whisper on its way ("Whisper · 42%"), or listening now,
/// the first time ("Whisper, on this Mac").
struct SpeechModelNote: View {
    let voice: VoiceInput

    var body: some View {
        if let note = voice.model.note(usesWhisper: voice.usesWhisper, device: "Mac") {
            Text(note)
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize()
                .help(voice.usesWhisper ? "Whisper writes what you say, on this Mac." : "Apple’s dictation listens until Whisper is downloaded. " + sentence(voice.model.status(device: "Mac")))
                // Said once: it's Whisper from now on.
                .onDisappear { if voice.usesWhisper { voice.model.sawReady() } }
        }
    }
}

/// `words` ending in one full stop.
private func sentence(_ words: String) -> String { words.hasSuffix(".") ? words : words + "." }

/// Settings › Voice Input › Speech model: Whisper's download, and taking it away.
struct SpeechModelRow: View {
    let model: SpeechModel
    @State private var confirmsRemoving = false

    /// Stopped with part of it here.
    private var canRemovePart: Bool {
        guard model.received > 0 else { return false }
        switch model.state {
        case .paused, .failed, .lowSpace: return true
        default: return false
        }
    }

    /// On its way: a bar with how much has come.
    private var showsBar: Bool { [.downloading, .paused, .waiting(.network), .waiting(.wifi), .askingCellular].contains(model.state) }

    var body: some View {
        LabeledContent {
            HStack(spacing: 8) {
                switch model.state {
                case .absent:
                    Button("Download") { model.download() }
                case .downloading, .waiting, .askingCellular:
                    Button("Pause") { model.pause() }
                case .paused:
                    Button("Resume") { model.download() }
                case .failed:
                    Button("Try Again") { model.download() }
                case .lowSpace:
                    Button("Manage Storage…") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.settings.Storage")!) }
                case .ready:
                    Button("Remove Download…") { confirmsRemoving = true }
                case .preparing:
                    Spinner(size: 13)
                case .unsupported:
                    EmptyView()
                }
                // Part of it here, stopped: that can go too.
                if canRemovePart {
                    Button("Remove") { model.remove() }
                }
            }
        } label: {
            Text("Whisper")
            VStack(alignment: .leading, spacing: 6) {
                Text(model.status(device: "Mac", amount: !showsBar))
                if showsBar {
                    ProgressLine("Downloading Whisper", bytes: model.received, of: model.size)
                        .frame(maxWidth: 360)
                }
            }
        }
        // Back from freeing space: it goes on.
        .onAppear { if case .lowSpace = model.state { model.download() } }
        .confirmationDialog("Remove Whisper from this Mac?", isPresented: $confirmsRemoving) {
            Button("Remove Download", role: .destructive) { model.remove() }
        } message: {
            Text("Voice input goes back to Apple’s dictation. You can download Whisper again here.")
        }
    }
}
