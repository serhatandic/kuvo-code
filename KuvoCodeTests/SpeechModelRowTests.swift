import AppKit
import KuvoVoice
import SwiftUI
import Testing
@testable import KuvoCode

/// Settings › General › Voice Input's row for more accurate voice input: a row under it only for
/// what's worth one, a download's bar or a button (#295: getting ready, a whole row held a lone
/// spinner, under a status line that already says it's getting ready). The real row, in a
/// grouped form as Settings draws it, in a window of the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SpeechModelRowTests {
    init() { TestEnvironment.prepare() }

    /// How tall the row is as Whisper is `state` (`SpeechModel.showSample`'s names).
    private func height(_ state: String, look: String? = nil, out: String? = nil) async throws -> CGFloat {
        SpeechModel.shared.showSample(state)
        defer { SpeechModel.shared.showSample("absent") }
        return try await height(of: SpeechModelRow(model: .shared), named: state, look: look, out: out)
    }

    /// How tall `row` is, in Settings' grouped form.
    private func height(of row: some View, named name: String, look: String? = nil, out: String? = nil) async throws -> CGFloat {
        let form = Form { Section("Voice Input") { row } }
            .formStyle(.grouped)
            .scrollDisabled(true)
            .environment(\.colorScheme, look == "aqua" ? .light : .dark)
            .frame(width: 620)
            .fixedSize(horizontal: false, vertical: true)
        let host = NSHostingView(rootView: form)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 620, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        if let look { window.appearance = NSAppearance(named: NSAppearance.Name(look)) }
        window.contentView = host
        window.orderBack(nil)
        defer {
            window.orderOut(nil)
            window.close()
        }
        host.layoutSubtreeIfNeeded()
        let height = host.fittingSize.height
        if let out, let look {
            window.setContentSize(NSSize(width: 620, height: height))
            host.layoutSubtreeIfNeeded()
            if let picture = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: picture)
                try picture.representation(using: .png, properties: [:])?.write(to: URL(filePath: out).appending(path: "voice-\(name)-\(look == "aqua" ? "light" : "dark").png"))
            }
        }
        return height
    }

    @Test func gettingReadyHasNoRowOfItsOwn() async throws {
        // KUVO_SHOTS_OUT (passed as TEST_RUNNER_KUVO_SHOTS_OUT): pictures of the row, before and after.
        if let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"] {
            for state in ["preparing", "downloading"] {
                for look in ["darkAqua", "aqua"] { _ = try await height(state, look: look, out: out) }
            }
        }
        // The toggle's row alone, with the same words.
        SpeechModel.shared.showSample("preparing")
        let status = SpeechModel.shared.status(device: "Mac", amount: true)
        SpeechModel.shared.showSample("absent")
        let alone = try await height(of: Toggle(isOn: .constant(true)) {
            Text("More accurate voice input")
            Text(status)
        }, named: "alone")
        let preparing = try await height("preparing")
        let downloading = try await height("downloading")
        #expect(preparing == alone, "getting ready, the toggle's row alone")
        #expect(downloading > alone, "a download has its bar and Pause under it")
    }
}
