#if os(macOS)
import AppKit
#endif
import SwiftUI
import Testing
@testable import ClientDesign

/// The card's fold-all control (#442): over the card's top edge at its right, in no row of the
/// card. The room it keeps is over the card, for what of it stands above the edge, so the
/// conversation's last line stays clear of it; the card itself is as tall as without it.
@MainActor
struct BarTuckControlTests {
    /// A card of two bars' lines, as tall as they are.
    private struct Card: View {
        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(["14 sessions at work", "Wakes in 10 minutes"], id: \.self) { line in
                    HStack {
                        Text(line).font(.headline)
                        Spacer()
                        Image(systemName: "chevron.up").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
                            .frame(width: 44)
                    }
                    .frame(height: 44)
                    .padding(.horizontal, 12)
                }
            }
            .frame(width: 360)
            .background(RoundedRectangle(cornerRadius: 18).fill(Color.gray.opacity(0.2)))
        }
    }

    private func height(_ view: some View) -> CGFloat {
        let renderer = ImageRenderer(content: view.fixedSize())
        renderer.scale = 1
        return CGFloat(renderer.cgImage?.height ?? 0)
    }

    @Test func itTakesNoRowOfTheCardOnlyRoomOverIt() {
        let card = height(Card())
        #expect(card == 88)
        // Shown: the card and the room over it for the control's top, nothing more.
        #expect(height(Card().barTuckControl(isShown: true) {}) == card + BarTuckButton.above)
        // Not shown (one bar, or tucked): just the card.
        #expect(height(Card().barTuckControl(isShown: false) {}) == card)
    }

    #if os(macOS)
    /// The card in a window, light and dark, into KUVO_SHOTS_OUT (with KUVO_SHOTS_TAG before each
    /// name): not a test of behavior, it runs only when that's set.
    @Test func renders() async throws {
        guard let out = ProcessInfo.processInfo.environment["KUVO_SHOTS_OUT"].map({ URL(fileURLWithPath: $0) }) else { return }
        let tag = ProcessInfo.processInfo.environment["KUVO_SHOTS_TAG"] ?? "now"
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let size = NSSize(width: 420, height: 220)
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        for scheme in ["light", "dark"] {
            window.appearance = NSAppearance(named: scheme == "dark" ? .darkAqua : .aqua)
            let view = VStack(alignment: .leading, spacing: 0) {
                Spacer()
                Text("The last line of the conversation, over the card.")
                    .padding(.horizontal, 30)
                    .padding(.bottom, 20)
                Card().barTuckControl(isShown: true) {}
                    .padding(.horizontal, 30)
                    .padding(.bottom, 20)
            }
            .frame(width: size.width, height: size.height)
            .background(scheme == "dark" ? Color(white: 0.12) : Color(white: 0.97))
            window.contentView = NSHostingView(rootView: view)
            window.orderBack(nil)
            for _ in 0..<10 {
                window.contentView?.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(50))
            }
            let host = try #require(window.contentView)
            host.display()
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = try #require(rep.representation(using: .png, properties: [:]))
            try png.write(to: out.appending(path: "\(tag)-mac-fold-render-\(scheme).png"))
            window.orderOut(nil)
        }
    }
    #endif
}
