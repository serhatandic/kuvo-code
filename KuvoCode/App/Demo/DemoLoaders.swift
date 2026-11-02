#if DEBUG
import AppKit
import ClientDesign
import SwiftUI

/// KUVO_DEMO_LOADERS: a window with every state mark and loader, in light and dark, moving and
/// with Reduce Motion, for checking them side by side without making each happen. Debug builds only.
@MainActor
enum DemoLoaders {
    private static var window: NSWindow?

    static func showIfAsked(_ environment: [String: String]) {
        guard environment["KUVO_DEMO_LOADERS"] != nil, window == nil else { return }
        let content = HStack(alignment: .top, spacing: 0) {
            Column(scheme: .light, still: false)
            Column(scheme: .dark, still: false)
            Column(scheme: .light, still: true)
            Column(scheme: .dark, still: true)
        }
        // A panel, which never becomes main, so the demo variables that look for the main window
        // don't take it for that.
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 860), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.hidesOnDeactivate = false
        window.title = "Loaders"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: content)
        window.setFrameOrigin(NSPoint(x: 40, y: 40))
        window.orderBack(nil)
        self.window = window
    }

    private struct Column: View {
        let scheme: ColorScheme
        let still: Bool
        private let started = Date().addingTimeInterval(-14)

        var body: some View {
            VStack(alignment: .leading, spacing: 14) {
                Text((scheme == .dark ? "Dark" : "Light") + (still ? ", Reduce Motion" : ""))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                let kinds: [StatusMark.Kind] = [.working, .subagents, .needsYou, .new, .failed, .wake, .watching, .paused, .waitingForComputer, .offline]
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(kinds, id: \.self) { kind in
                        HStack(spacing: 8) {
                            StatusMark(kind)
                            StatusMark(kind, size: 11)
                            Text(kind.words).font(.system(size: 13))
                        }
                    }
                }
                Divider()
                HStack(spacing: 6) {
                    StepActivity(symbol: "terminal", running: true)
                    Text("Running tests").font(.system(size: 13))
                    StepActivity.Elapsed(since: started).font(.system(size: 13))
                }
                // A subagent open on its steps: its own ring holds, the step inside moves.
                HStack(spacing: 6) {
                    StepActivity(symbol: "person.2", running: true, holds: true)
                    Text("Waiter 1").font(.system(size: 13))
                    StepActivity.Elapsed(since: started).font(.system(size: 13))
                    Text("Sleeping").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    StepActivity(symbol: "moon.zzz", running: true)
                    Text("Sleep").font(.system(size: 13))
                    StepActivity.Elapsed(since: started).font(.system(size: 13))
                }
                .padding(.leading, 22)
                HStack(spacing: 6) {
                    StepActivity(symbol: "terminal", running: false)
                    Text("Ran tests").font(.system(size: 13))
                    StepActivity.Elapsed(since: started, running: false, until: Date()).font(.system(size: 13))
                }
                ProgressLine("Downloading the engine", bytes: 41_000_000, of: 96_000_000)
                ProgressLine("Getting ready", fraction: nil)
                ProgressLine("Installing", fraction: 0.62, layout: .inline)
                Placeholder(.lines(count: 3))
                Placeholder(.rows(count: 2))
                HandoffWait("Waiting for you to finish in your browser…", to: .browser)
                HandoffWait("Waiting for your phone…", to: .phone)
                ConnectingLink("Connecting to devbox…")
                ConnectingLink("Connected", isConnected: true)
                HStack(spacing: 8) {
                    Text("Searching devbox").font(.system(size: 13))
                    AskingDots()
                }
                // The ring in a button takes its label's colour: white on a filled one, grey once
                // it's disabled; the app's own icon buttons dim it whole; a disabled row keeps it.
                HStack(spacing: 10) {
                    Spinner(size: 14)
                    Button {} label: { Spinner(size: 11).frame(width: 44) }
                        .keyboardShortcut(.defaultAction).controlSize(.small).markInk(.onFill)
                    Button {} label: { Spinner(size: 11).frame(width: 44) }
                        .keyboardShortcut(.defaultAction).controlSize(.small).markInk(.onFill).disabled(true)
                    Button {} label: { Spinner(size: 13) }
                        .buttonStyle(IconButtonStyle(width: 28, height: 26)).disabled(true)
                    HStack(spacing: 4) { Spinner(size: 10); Text("Sending…").font(.system(size: 11)) }.disabled(true)
                }
                ForEach([false, true], id: \.self) { disabled in
                    Button {} label: { HStack(spacing: 8) { Spinner(size: 14); Text("Sign In with ChatGPT") }.frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent).controlSize(.extraLarge).markInk(.onFill).disabled(disabled)
                }
            }
            .padding(16)
            .frame(width: 310, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(scheme == .dark ? Color(white: 0.12) : Color.white)
            .environment(\.colorScheme, scheme)
            .environment(\._accessibilityReduceMotion, still)
            // Drawn as in the window in front, though it's behind.
            .environment(\.appearsActive, true)
        }
    }
}
#endif
