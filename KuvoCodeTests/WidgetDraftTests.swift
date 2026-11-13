import AppKit
import OpenCodeKit
import SwiftUI
import Testing
import WebKit
@testable import KuvoCode

/// A widget shows while it's written, as a draft with its scripts off, and comes alive once it's
/// done: its chart draws, its buttons work.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct WidgetDraftTests {
    /// The agent writes `html` last, so its last draft can hold the whole page: done, the same page
    /// runs its scripts.
    @Test func aWidgetWhoseLastDraftWasAllOfItComesAliveWhenItsDone() async throws {
        let html = """
        <canvas id="chart" width="160" height="40"></canvas>
        <script>
        document.getElementById("chart").getContext("2d").fillText("Times an M2", 4, 20);
        document.title = "drawn";
        </script>
        """
        let id = "call_\(UUID().uuidString)"
        let arguments = try String(decoding: JSONEncoder().encode(["title": "Benchmarks", "html": html]), as: UTF8.self)
        // All of it but the closing brace, as it streams.
        let written = Message.ToolCall(id: id, name: "kuvo-browser_show_widget", state: .streaming(input: String(arguments.dropLast())))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: WidgetCard(call: written, send: { _, _ in }))
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()

        let page = try #require(Self.page(in: host))
        let watches = [page.observe(\.title) { _, _ in TestPulse.beat() }, page.observe(\.isLoading) { _, _ in TestPulse.beat() }]
        defer { watches.forEach { $0.invalidate() } }
        // The draft is up: its canvas is there, and its script hasn't run.
        try await until { !page.isLoading }
        let drafted = try await page.callAsyncJavaScript("return document.getElementById('chart') !== null", contentWorld: .defaultClient)
        #expect(drafted as? Bool == true)
        #expect(page.title != "drawn")

        host.rootView = WidgetCard(call: Message.ToolCall(id: id, name: "kuvo-browser_show_widget",
                                                          state: .completed(input: .object(["title": .string("Benchmarks"), "html": .string(html)]), output: [], metadata: nil)),
                                   send: { _, _ in })
        host.layoutSubtreeIfNeeded()
        try await until { page.title == "drawn" }
    }

    private static func page(in view: NSView) -> WidgetWebView? {
        view as? WidgetWebView ?? view.subviews.lazy.compactMap(page(in:)).first
    }
}
