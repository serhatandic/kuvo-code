import AppKit
import OpenCodeKit
import SwiftUI
import Testing
import WebKit
@testable import KuvoCode

/// A link in a widget to a place on it (`#details`, a tab) goes there, as on any page: only links
/// to somewhere else are kept from the widget (they open in your browser).
@MainActor
@Suite(.timeLimit(.minutes(1))) struct WidgetLinkTests {
    @Test func aLinkToAPlaceOnTheWidgetGoesThere() async throws {
        let html = """
        <a id="link" href="#details">Details</a>
        <p id="details">Times an M2</p>
        <script>
        addEventListener("hashchange", () => { document.title = location.hash; });
        document.title = "ready";
        </script>
        """
        let call = Message.ToolCall(id: "call_\(UUID().uuidString)", name: "kuvo-browser_show_widget",
                                    state: .completed(input: .object(["title": .string("Benchmarks"), "html": .string(html)]), output: [], metadata: nil))
        let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: WidgetCard(call: call, send: { _, _ in }))
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()

        let page = try #require(Self.page(in: host))
        let watches = [page.observe(\.title) { _, _ in TestPulse.beat() }]
        defer { watches.forEach { $0.invalidate() } }
        try await until { page.title == "ready" }

        _ = try await page.evaluateJavaScript(#"document.getElementById("link").click(); 0"#)
        try await until { page.title == "#details" }
    }

    private static func page(in view: NSView) -> WidgetWebView? {
        view as? WidgetWebView ?? view.subviews.lazy.compactMap(page(in:)).first
    }
}
