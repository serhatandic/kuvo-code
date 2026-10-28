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
        model.isUnderway ? model.micWords.title : nil
    }
}

/// From the mic, pressed while the voice model is still coming: how far it's come, plainly, and
/// Cancel; the first time it's made ready, that it takes a while. It closes once voice input can listen.
struct VoiceModelPopover: View {
    let model: SpeechModel
    let close: () -> Void

    var body: some View {
        let words = model.micWords
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(words.title)
                    .font(.system(size: 13, weight: .semibold))
                    .monospacedDigit()
                if let detail = words.detail {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if let action {
                HStack {
                    Spacer()
                    action
                }
            }
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// Cancel while it comes (what's come is kept, for the next press); Try Again once it stopped.
    private var action: AnyView? {
        switch model.state {
        case .downloading, .waiting, .askingCellular:
            AnyView(Button("Cancel") {
                model.pause()
                close()
            })
        case .failed, .lowSpace, .paused:
            AnyView(Button(model.state == .paused ? "Resume" : "Try Again") { model.download() }
                .keyboardShortcut(.defaultAction))
        default:
            nil
        }
    }
}

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
            Text("Voice input needs it: it’s downloaded again the next time you press the mic, or here.")
        }
    }
}
