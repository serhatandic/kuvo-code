import AppKit
import OpenCodeKit
import SwiftUI
import Testing
import WebKit
@testable import KuvoCode

/// A widget made while the Mac was light still reads once it's dark, and the other way round: a
/// chart drawn by script (its labels, its legend) reads its colors once, as it draws, so it draws
/// again in the new look. One that follows light and dark itself keeps what you did in it. Each
/// switch goes through the window, as the Mac's appearance setting does.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct WidgetSchemeTests {
    /// A chart whose canvas text takes the scheme it's drawn in, and says which on the page.
    private static let chart = """
    <canvas id="chart" width="160" height="40"></canvas>
    <script>
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const context = document.getElementById("chart").getContext("2d");
    context.fillStyle = dark ? "#eee" : "#333";
    context.fillText("Times an M2", 4, 20);
    document.title = "drawn " + (dark ? "dark" : "light");
    </script>
    """

    /// A chart drawn with the page's own colors, read from it as it draws (as agents are told to),
    /// and read again all the while: a tooltip following the pointer, an animation.
    private static let chartOfColors = """
    <canvas id="chart" width="160" height="40"></canvas>
    <script>
    const text = getComputedStyle(document.documentElement).getPropertyValue("--kuvo-text").trim();
    const context = document.getElementById("chart").getContext("2d");
    context.fillStyle = text;
    context.fillText("Times an M2", 4, 20);
    document.title = "drawn " + (text === "#fff" ? "dark" : "light");
    setInterval(() => getComputedStyle(document.documentElement).getPropertyValue("--kuvo-text"), 1);
    </script>
    """

    /// Widgets in a conversation's window, one under another, as the conversation shows them.
    private final class Shown {
        let window: NSWindow
        let host: NSHostingView<AnyView>
        private var watches: [NSKeyValueObservation] = []

        convenience init(_ html: String, appearance: NSAppearance.Name?) { self.init([html], appearance: appearance) }

        init(_ pages: [String], appearance: NSAppearance.Name?) {
            window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 640, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = appearance.flatMap(NSAppearance.init(named:))
            let calls = pages.map { html in
                Message.ToolCall(id: "call_\(UUID().uuidString)", name: "kuvo-browser_show_widget",
                                 state: .completed(input: .object(["title": .string("Benchmarks"), "html": .string(html)]), output: [], metadata: nil))
            }
            // In the rows a conversation shows its replies in, which hand each row what's around
            // them, each drawn again only when what it shows changes, as the transcript's are.
            host = NSHostingView(rootView: AnyView(ScrollView {
                RowStack(items: calls, id: \.id, same: { $0.id == $1.id }, estimate: { _ in 120 }) { call, _ in
                    Reply(call: call).equatable()
                }
            }.frame(width: 640, height: 400)))
            window.contentView = host
            window.orderBack(nil)
            host.layoutSubtreeIfNeeded()
        }

        /// The widget's page (the first, or the one at `index`), what it says of itself (its title
        /// and whether it's loading) watched so a wait sees it change.
        func page(_ index: Int = 0) throws -> WidgetWebView {
            let found = Self.pages(in: host)
            try #require(found.count > index)
            let page = found[index]
            watches.append(page.observe(\.title) { _, _ in TestPulse.beat() })
            watches.append(page.observe(\.isLoading) { _, _ in TestPulse.beat() })
            return page
        }

        private static func pages(in view: NSView) -> [WidgetWebView] {
            if let page = view as? WidgetWebView { return [page] }
            return view.subviews.flatMap(pages(in:))
        }

        func close() { window.close() }

        /// A reply's row, as the transcript's `RowView`: equal while it shows the same call.
        private struct Reply: View, Equatable {
            let call: Message.ToolCall
            static func == (lhs: Reply, rhs: Reply) -> Bool { lhs.call.id == rhs.call.id }
            var body: some View { WidgetCard(call: call, send: { _, _ in }) }
        }
    }

    @Test(arguments: [(NSAppearance.Name.aqua, NSAppearance.Name.darkAqua, "dark"), (.darkAqua, .aqua, "light")])
    func aChartDrawnInOneLookDrawsAgainInTheOther(from: NSAppearance.Name, to: NSAppearance.Name, then: String) async throws {
        let shown = Shown(Self.chart, appearance: from)
        defer { shown.close() }
        let page = try shown.page()
        try await until { page.title?.hasPrefix("drawn") == true }
        #expect(page.title != "drawn \(then)")

        shown.window.appearance = NSAppearance(named: to)
        try await until { page.title == "drawn \(then)" }
    }

    /// A chart drawn with the page's colors, as agents are told to, that reads them again all the
    /// while without drawing itself again for the new look: what it reads once the look has
    /// changed doesn't make it look right.
    @Test func aChartOfThePagesColorsDrawsAgainInTheNewLook() async throws {
        let shown = Shown(Self.chartOfColors, appearance: .aqua)
        defer { shown.close() }
        let page = try shown.page()
        try await until { page.title == "drawn light" }

        shown.window.appearance = NSAppearance(named: .darkAqua)
        try await until { page.title == "drawn dark" }
    }

    /// The look changing while the widget is still loading: whichever look its script drew in,
    /// it ends up drawn in the one around it.
    @Test func aChartLoadingWhenTheLookChangesIsDrawnInTheNewOne() async throws {
        let shown = Shown(Self.chart, appearance: .aqua)
        defer { shown.close() }
        let page = try shown.page()
        shown.window.appearance = NSAppearance(named: .darkAqua)
        try await until { page.title == "drawn dark" && !page.isLoading }
        // And it stays so: nothing about the switch is left to load it again.
        _ = try await page.callAsyncJavaScript("0", contentWorld: .defaultClient)
        #expect(page.title == "drawn dark")
    }

    /// A widget scrolled out of the conversation when the look changed, back in view.
    @Test func aChartAwayWhenTheLookChangedDrawsAgainWhenItsBack() async throws {
        let shown = Shown(Self.chart, appearance: .aqua)
        defer { shown.close() }
        let page = try shown.page()
        try await until { page.title == "drawn light" }

        shown.window.contentView = nil
        shown.window.appearance = NSAppearance(named: .darkAqua)
        shown.window.contentView = shown.host
        shown.host.layoutSubtreeIfNeeded()
        try await until { page.title == "drawn dark" }
    }

    /// One that listens for the look to change draws again itself: it isn't loaded again, so what
    /// you set in it stays.
    @Test func aWidgetThatFollowsTheLookItselfKeepsWhatYouDid() async throws {
        let shown = Shown("""
        <script>
        document.title = "set by you";
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
          document.title = (document.title === "set by you" ? "kept, " : "") + (event.matches ? "dark" : "light");
        });
        </script>
        """, appearance: .aqua)
        defer { shown.close() }
        let page = try shown.page()
        try await until { page.title == "set by you" }

        shown.window.appearance = NSAppearance(named: .darkAqua)
        try await until { page.title == "kept, dark" }
    }

    /// The whole Mac changing look, as System Settings' Appearance does (the window has none of its
    /// own): the page isn't loaded again just because the accent color has another shade in dark.
    /// It changes the look of the whole test app for a moment: a test of a window with no look of
    /// its own goes in a suite run one test at a time with it.
    @Test func aWidgetKeepsWhatYouDidWhenTheWholeMacChangesLook() async throws {
        let before = NSApp.appearance
        NSApp.appearance = NSAppearance(named: .aqua)
        defer { NSApp.appearance = before }
        let shown = Shown("""
        <script>
        document.title = "set by you";
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", event => {
          document.title = (document.title === "set by you" ? "kept, " : "") + (event.matches ? "dark" : "light");
        });
        </script>
        """, appearance: nil)
        defer { shown.close() }
        let page = try shown.page()
        try await until { page.title == "set by you" }

        NSApp.appearance = NSAppearance(named: .darkAqua)
        try await until { page.title == "kept, dark" }
    }

    /// One that only reacts to you (a value you typed, a slider) and draws nothing in either look
    /// isn't loaded again either: its CSS follows by itself. Beside it, a chart that does need
    /// loading again says the switch has been dealt with.
    @Test func aWidgetThatDrawsNothingInEitherLookKeepsWhatYouDid() async throws {
        let shown = Shown([#"<input id="value"><script>document.getElementById("value").addEventListener("input", event => { document.title = event.target.value; }); document.title = "ready";</script>"#, Self.chart], appearance: .aqua)
        defer { shown.close() }
        let typed = try shown.page(0), chart = try shown.page(1)
        try await until { typed.title == "ready" && chart.title == "drawn light" }
        // What you typed, as typing it does.
        _ = try await typed.evaluateJavaScript(#"const field = document.getElementById("value"); field.value = "kept"; field.dispatchEvent(new Event("input")); 0"#)
        try await until { typed.title == "kept" }

        shown.window.appearance = NSAppearance(named: .darkAqua)
        try await until { chart.title == "drawn dark" }
        // Whatever it was told to do about the switch has been told by now (a page's scripts run
        // in order): it's still the page you typed in.
        _ = try await typed.callAsyncJavaScript("0", contentWorld: .defaultClient)
        #expect(!typed.isLoading)
        #expect(typed.title == "kept")
    }
}
