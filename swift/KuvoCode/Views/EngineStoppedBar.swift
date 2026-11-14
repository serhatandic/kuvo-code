import ClientDesign
import SwiftUI

/// Over a list of accounts while this Mac's engine is down (`AppModel.engineIsDown`): why its
/// buttons are dimmed, in one line, and Try Again, which starts it over as the window's does. While
/// it starts again (by itself, or from Try Again), a spinner in the button's place. What the engine
/// said stays in the log; the window's own failure page shows it.
struct EngineStoppedBar: View {
    @Environment(AppModel.self) private var app

    static let title = "The engine stopped, so signing in won’t work yet."

    private var isFailed: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KUVO_DEMO_ENGINE_STOPPED"] == "starting" { return false }
        if ProcessInfo.processInfo.environment["KUVO_DEMO_ENGINE_STOPPED"] != nil { return true }
        #endif
        if case .failed = app.engine { return true }
        return false
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.orange)
                .symbolRenderingMode(.hierarchical)
                .accessibilityHidden(true)
            Text(Self.title)
                .font(.system(size: 13, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if isFailed {
                Button("Try Again") { Task { await app.restart() } }
                    .buttonStyle(.glass)
                    .help("Start the engine again")
            } else {
                Spinner(size: 13)
                    .accessibilityLabel("Starting the engine")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
        // It comes in over a list someone may be reading: heard as it does.
        .onAppear { AccessibilityNotification.Announcement(Self.title).post() }
    }
}

extension View {
    /// What needs this Mac's engine, while it's down (`waits`): in view, dimmed and still, and saying
    /// why to VoiceOver. Rows draw their own hover and colors, so being disabled alone doesn't show.
    func waitsForEngine(_ waits: Bool) -> some View {
        disabled(waits)
            .opacity(waits ? 0.55 : 1)
            .accessibilityHint(waits ? "Waits for the engine to start again" : "")
    }
}
