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

}

/// The composer's mic: it listens once the voice model can; until then a press brings the model
/// in, and its popover says how far it's come. Its own view, so the composer isn't drawn again
/// with each piece of the download.
struct MicButton: View {
    @Environment(AppModel.self) private var app
    /// The composer it's for.
    let owner: String
    let start: () -> Void
    private var model: SpeechModel { .shared }

    var body: some View {
        // Where the model is, once there's something to say: while it comes, or stopped.
        let words = model.canListen || model.state == .absent ? nil : model.micWords.title
        let shown = app.dictation.waitsForModel == owner && !model.canListen
        Button(action: start) {
            Image(systemName: "mic")
                .font(.system(size: 14, weight: .medium))
                .frame(width: 30, height: 28)
                .overlay { MicRing(model: model) }
                .hoverHighlight(in: Capsule(), selected: shown, mutesInk: true)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(words ?? "Talk Instead of Typing (⇧⌘Space)")
        .accessibilityLabel("Voice Input")
        .accessibilityValue(words ?? "")
        .accessibilityHint(model.canListen ? "Talk instead of typing" : model.state == .absent ? "Downloads the voice model first" : "Says how far the voice model has come")
        // Pressed while the voice model comes (or by the shortcut): how far it's come.
        .popover(isPresented: Binding { shown } set: { if !$0 { app.dictation.stopWaiting(for: owner) } }, arrowEdge: .bottom) {
            VoiceModelPopover(model: model) { app.dictation.stopWaiting(for: owner) }
                .popoverContent()
        }
        // VoiceOver doesn't go into a popover by itself: it hears where the model is, and when it's ready.
        .onChange(of: shown) { _, shown in
            if shown { AccessibilityNotification.Announcement(model.micWords.title).post() }
        }
        .onChange(of: model.canListen) { _, canListen in
            guard canListen, app.dictation.waitsForModel == owner else { return }
            app.dictation.stopWaiting(for: owner)
            AccessibilityNotification.Announcement("Voice input is ready").post()
        }
        // Another conversation in this composer, or none: the popover was that one's.
        .onChange(of: owner) { old, _ in app.dictation.stopWaiting(for: old) }
        .onDisappear { app.dictation.stopWaiting(for: owner) }
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
        case .lowSpace:
            AnyView(Button("Manage Storage…") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.settings.Storage")!) })
        case .failed, .paused:
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
            Text("Voice input needs it: it’s downloaded again the next time you click the microphone, or here.")
        }
    }
}
