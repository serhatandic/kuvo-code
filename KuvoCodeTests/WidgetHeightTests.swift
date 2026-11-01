import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// A widget is shown as the agent made it, nothing over it: the conversation gives it the room its
/// page says it needs, more as it grows and less again as it shrinks, so none of it is cut off or
/// covered by what follows, and no empty space is left under it. Each test gives the page the room
/// it asked for, as the conversation does. The same as the phone's.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct WidgetHeightTests {
    /// The widget's page, as the conversation starts it (60 points tall, the least it's given),
    /// its reports to `reports`.
    private func load(_ html: String, reports: Reports) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(reports, contentWorld: .defaultClient, name: "kuvo")
        configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        let page = WKWebView(frame: CGRect(x: 0, y: 0, width: 640, height: 60), configuration: configuration)
        page.loadHTMLString(WidgetPage.page(html, accent: .systemBlue), baseURL: nil)
        return page
    }

    /// The page's first two reports, as it starts (one as it's read, one as its observer starts):
    /// whatever comes after is from what the test changed.
    private func started(_ reports: Reports) async throws {
        try await until { reports.count >= 2 }
    }

    @Test func aWidgetSaysHowTallItIsAndAgainWhenItGrows() async throws {
        let reports = Reports()
        let page = load(#"<div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        try await until { reports.height.map { $0 >= 120 } == true }
        // Its content and the page's own padding, no more.
        #expect(abs(try #require(reports.height) - 128) <= 4)
        _ = try await page.evaluateJavaScript(#"document.getElementById("chart").style.height = "420px""#)
        try await until { (reports.height ?? 0) >= 420 }
        #expect(abs(try #require(reports.height) - 428) <= 4)
    }

    /// Details shown and hidden again: the widget gets its height back.
    @Test func aWidgetGetsShorterAgainWhenItsContentDoes() async throws {
        let reports = Reports()
        let page = load(#"<div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        try await until { (reports.height ?? 0) >= 120 }
        page.frame.size.height = try #require(reports.height)
        _ = try await page.evaluateJavaScript(#"document.getElementById("chart").style.height = "420px""#)
        try await until { (reports.height ?? 0) >= 420 }
        page.frame.size.height = try #require(reports.height)
        _ = try await page.evaluateJavaScript(#"document.getElementById("chart").style.height = "120px""#)
        try await until { (reports.height ?? 0) < 420 }
        #expect(abs(try #require(reports.height) - 128) <= 4)
    }

    /// A drawing placed where it likes (a game's canvas), measured again once the widget has its
    /// room, here as the window changes width: it stays whole.
    @Test func aPlacedDrawingStaysWholeWhenMeasuredAgain() async throws {
        let reports = Reports()
        let page = load(#"<canvas style="position: absolute; top: 0; left: 0; width: 200px; height: 300px"></canvas>"#, reports: reports)
        try await started(reports)
        #expect(try #require(reports.height) >= 300)
        page.frame.size.height = try #require(reports.height)
        let before = reports.count
        page.frame.size.width = 520
        try await until { reports.count > before }
        #expect(try #require(reports.height) >= 300)
    }

    /// Placed words (a timeline) made wider: the widget gets as short as they are, and no shorter.
    @Test func placedWordsStayWholeAsTheWindowGetsWider() async throws {
        let reports = Reports()
        let words = String(repeating: "A step on the timeline. ", count: 60)
        let page = load(#"<div style="position: absolute; top: 10px; left: 0; width: 50%">\#(words)</div>"#, reports: reports)
        page.frame.size.width = 400
        try await until { (reports.height ?? 0) > 200 }
        let narrow = try #require(reports.height)
        page.frame.size.height = narrow
        // Wider: its words take fewer lines.
        page.frame.size.width = 800
        try await until { reports.height != narrow }
        let wide = try #require(reports.height)
        #expect(wide < narrow)
        #expect(wide > narrow / 3, "\(wide) cuts the timeline off")
    }

    /// A box of fixed height whose table runs out of it (as boxes in pages often do): all of the
    /// table shows.
    @Test func whatSpillsOutOfABoxOfFixedHeightShowsWhole() async throws {
        let reports = Reports()
        let page = load(#"<div style="height: 100px"><div style="height: 600px; background: #eee">A long table</div></div>"#, reports: reports)
        try await until { (reports.height ?? 0) >= 600 }
        withExtendedLifetime(page) {}
    }

    /// A page made to fill its window (`height: 100%`) whose chart is drawn in once it has its
    /// room: the widget grows with it, none of it cut off.
    @Test func aFullHeightPageSaysWhenItsContentGrows() async throws {
        let reports = Reports()
        let page = load(#"<style>html, body { height: 100%; }</style><div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        try await started(reports)
        let before = reports.count
        page.frame.size.height = try #require(reports.height)
        // The page's box follows the room it's given: it reports that first.
        try await until { reports.count > before }
        _ = try await page.evaluateJavaScript(#"document.getElementById("chart").style.height = "420px""#)
        try await until { (reports.height ?? 0) >= 420 }
        #expect(abs(try #require(reports.height) - 424) <= 8)
    }
}

@MainActor
private final class Reports: NSObject, WKScriptMessageHandler {
    var height: Double?
    private(set) var count = 0
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["type"] as? String == "height", let height = body["value"] as? Double else { return }
        self.height = height
        count += 1
        TestPulse.beat()
    }
}
