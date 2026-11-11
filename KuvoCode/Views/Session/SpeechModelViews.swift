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

/// The composer's mic, with Whisper's ring while it comes (Apple's dictation listens meanwhile),
/// and, once after the first dictation, the tip that voice input can be more accurate. Its own
/// view, so the composer isn't drawn again with each piece of the download.
struct MicButton: View {
    @Environment(AppModel.self) private var app
    /// The composer it's for.
    let owner: String
    let start: () -> Void
    private var model: SpeechModel { .shared }

    var body: some View {
        let progress = model.progressWords
        let tip = app.dictation.tipFor == owner
        Button(action: start) {
            Image(systemName: "mic")
                .font(ComposerRow.icon)
                .frame(width: 30, height: 28)
                .overlay { MicRing(model: model) }
                .hoverHighlight(in: Capsule(), mutesInk: true)
        }
        .buttonStyle(.plain)
        .clickablePointer()
        .help(["Talk Instead of Typing (⇧⌘Space)", progress].compactMap(\.self).joined(separator: "\n"))
        .accessibilityLabel("Voice Input")
        .accessibilityValue(progress ?? "")
        .accessibilityHint("Talk instead of typing")
        .closesWhenKept(Binding { tip } set: { if !$0 { closeTip() } })
        .popover(isPresented: Binding { tip } set: { if !$0 { closeTip() } }, arrowEdge: .bottom) {
            VoiceTipPopover(turnOn: {
                closeTip()
                app.openSettings(.general)
            }, close: closeTip)
            .popoverContent()
        }
        // VoiceOver doesn't go into a popover by itself: it hears the tip.
        .onChange(of: tip) { _, tip in
            if tip { AccessibilityNotification.Announcement("\(VoiceTip.title). \(VoiceTip.line(device: "Mac"))").post() }
        }
        .onDisappear(perform: closeTip)
    }

    private func closeTip() {
        if app.dictation.tipFor == owner { app.dictation.tipFor = nil }
    }
}

/// The tip, once, after the first dictation: more accurate voice input, with Turn On… (its
/// setting) and Not Now, which says where it is and then closes.
struct VoiceTipPopover: View {
    let turnOn: () -> Void
    let close: () -> Void
    @State private var later = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if later {
                Text(VoiceTip.later(settings: "Settings › General"))
                    .font(.system(size: 13))
                    .fixedSize(horizontal: false, vertical: true)
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        close()
                    }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text(VoiceTip.title)
                        .font(.system(size: 13, weight: .semibold))
                    Text(VoiceTip.line(device: "Mac"))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Spacer()
                    Button("Not Now") { withAnimation(.ui) { later = true } }
                    Button("Turn On…", action: turnOn)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(14)
        .frame(width: 280, alignment: .leading)
    }
}

/// Settings › General › Voice Input: more accurate voice input (Whisper), turned on or off; its
/// download while it comes, and taking it away.
struct SpeechModelRow: View {
    let model: SpeechModel
    @State private var confirmsRemoving = false

    /// On its way: a bar with how much has come.
    private var showsBar: Bool { model.isOn && [.downloading, .paused, .waiting(.network), .waiting(.wifi), .askingCellular].contains(model.state) }

    var body: some View {
        Toggle(isOn: Binding { model.isOn } set: { model.isOn = $0 }) {
            Text("More accurate voice input")
            Text(model.status(device: "Mac", amount: !showsBar))
        }
        .disabled(model.state == .unsupported)
        // Back from freeing space: it goes on.
        .onAppear { if model.isOn, case .lowSpace = model.state { model.download() } }
        .confirmationDialog("Remove Whisper from this Mac?", isPresented: $confirmsRemoving) {
            Button("Remove Download", role: .destructive) { model.remove() }
        } message: {
            Text("Voice input goes back to Apple’s dictation. You can download Whisper again here.")
        }
        if showsBar || hasActions {
            HStack(spacing: 8) {
                if showsBar {
                    ProgressLine("Downloading Whisper", bytes: model.received, of: model.size)
                        .frame(maxWidth: 360)
                }
                Spacer(minLength: 8)
                actions
            }
        }
    }

    /// A row under it only for a bar or a button: getting ready, its status line says so, and
    /// the mic's ring shows it.
    private var hasActions: Bool {
        canRemove || (model.isOn && ![.absent, .preparing, .ready, .unsupported].contains(model.state))
    }

    /// What's here of it can go once it isn't coming or being made ready.
    private var canRemove: Bool { model.received > 0 && !model.isUnderway && model.state != .preparing }

    @ViewBuilder private var actions: some View {
        if model.isOn {
            switch model.state {
            case .downloading, .waiting, .askingCellular: Button("Pause") { model.pause() }
            case .paused: Button("Resume") { model.download() }
            case .failed: Button("Try Again") { model.download() }
            case .lowSpace: Button("Manage Storage…") { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.settings.Storage")!) }
            case .absent, .preparing, .ready, .unsupported: EmptyView()
            }
        }
        if canRemove {
            Button("Remove Download…") { confirmsRemoving = true }
        }
    }
}
