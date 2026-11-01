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
    private func load(_ html: String, reports: Reports, width: CGFloat = 640) async throws -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(reports, contentWorld: .defaultClient, name: "kuvo")
        configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        let page = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 60), configuration: configuration)
        page.loadHTMLString(WidgetPage.page(html, accent: .systemBlue), baseURL: nil)
        // Its first report comes as it's read: from then on it's this page that's asked.
        try await until { reports.height != nil }
        try await settled(page)
        return page
    }

    /// Once what the page has to say about what just changed has come: it's loaded, and has laid
    /// itself out since (a fresh observer's first call comes after the page's own, which says
    /// first). No clock.
    private func settled(_ page: WKWebView) async throws {
        _ = try await page.callAsyncJavaScript("""
        if (document.readyState !== "complete") await new Promise(done => addEventListener("load", done, { once: true }));
        await new Promise(done => { const watch = new ResizeObserver(() => { watch.disconnect(); done(); }); watch.observe(document.documentElement); });
        """, contentWorld: .defaultClient)
    }

    /// Gives the page the room it asked for, as the conversation does.
    private func fit(_ page: WKWebView, _ reports: Reports) async throws {
        page.frame.size.height = try #require(reports.height)
        try await settled(page)
    }

    private func change(_ page: WKWebView, _ script: String) async throws {
        _ = try await page.evaluateJavaScript(script)
        try await settled(page)
    }

    @Test func aWidgetSaysHowTallItIsAndAgainWhenItGrows() async throws {
        let reports = Reports()
        let page = try await load(#"<div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        // Its content and the page's own padding, no more.
        #expect(abs(try #require(reports.height) - 128) <= 4)
        try await change(page, #"document.getElementById("chart").style.height = "420px""#)
        #expect(abs(try #require(reports.height) - 428) <= 4)
    }

    /// Details shown and hidden again: the widget gets its height back.
    @Test func aWidgetGetsShorterAgainWhenItsContentDoes() async throws {
        let reports = Reports()
        let page = try await load(#"<div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("chart").style.height = "420px""#)
        #expect(abs(try #require(reports.height) - 428) <= 4)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("chart").style.height = "120px""#)
        #expect(abs(try #require(reports.height) - 128) <= 4)
    }

    /// Drawings placed where they like (a game's canvas, a layer inside a card), measured again
    /// once the widget has its room, here as the window changes width: they stay whole.
    @Test(arguments: [
        #"<canvas style="position: absolute; top: 0; left: 0; width: 200px; height: 300px"></canvas>"#,
        #"<div style="position: relative; height: 50px"><canvas style="position: absolute; top: 0; width: 200px; height: 300px"></canvas></div>"#,
        #"<div id="game"><canvas style="position: absolute; top: 0; width: 200px; height: 300px"></canvas></div>"#,
    ])
    func aPlacedDrawingStaysWholeWhenMeasuredAgain(html: String) async throws {
        let reports = Reports()
        let page = try await load(html, reports: reports)
        #expect(try #require(reports.height) >= 300)
        try await fit(page, reports)
        page.frame.size.width = 520
        try await settled(page)
        #expect(try #require(reports.height) >= 300)
    }

    /// Placed words (a timeline) made wider: the widget gets as short as they are, and no shorter.
    @Test func placedWordsStayWholeAsTheWindowGetsWider() async throws {
        let reports = Reports()
        let words = String(repeating: "A step on the timeline. ", count: 60)
        let page = try await load(#"<div style="position: absolute; top: 10px; left: 0; width: 50%">\#(words)</div>"#, reports: reports, width: 400)
        let narrow = try #require(reports.height)
        #expect(narrow > 200)
        try await fit(page, reports)
        // Wider: its words take fewer lines.
        page.frame.size.width = 800
        try await settled(page)
        let wide = try #require(reports.height)
        #expect(wide < narrow)
        #expect(wide > narrow / 3, "\(wide) cuts the timeline off")
    }

    /// A long table in a box of fixed height, spilling out of it, on a page with a doctype or
    /// without: it shows whole, and stays whole as the window changes width.
    @Test(arguments: [
        #"<div style="height: 100px"><div style="height: 600px; background: #eee">A long table</div></div>"#,
        #"<html><body><div style="height: 100px"><div style="height: 600px">A long table</div></div></body></html>"#,
    ])
    func whatSpillsOutOfABoxOfFixedHeightShowsWhole(html: String) async throws {
        let reports = Reports()
        let page = try await load(html, reports: reports)
        #expect(try #require(reports.height) >= 600)
        try await fit(page, reports)
        page.frame.size.width = 520
        try await settled(page)
        #expect(try #require(reports.height) >= 600)
    }

    /// A toast fixed to the window, waiting below it until it's shown: it isn't measured, so the
    /// widget doesn't grow each time something on it changes.
    @Test func whatsFixedToTheWindowDoesntGrowIt() async throws {
        let reports = Reports()
        let page = try await load(#"<div id="count" style="height: 120px">0</div><div style="position: fixed; bottom: 20px; transform: translateY(150%); height: 40px">Saved</div>"#, reports: reports)
        #expect(abs(try #require(reports.height) - 128) <= 4)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("count").textContent = "1""#)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("count").textContent = "2""#)
        #expect(abs(try #require(reports.height) - 128) <= 4)
    }

    /// What follows the window: a sheet placed against its bottom, partly below it, or a wrapper
    /// as tall as the window. Given more room, it asks for as much more again: the widget stops
    /// growing rather than growing each time something on it changes.
    @Test(arguments: [
        #"<div><div id="count" style="height: 120px">0</div><div style="position: absolute; bottom: -12px; height: 40px">Sheet</div></div>"#,
        #"<div id="count" style="height: 120px">0</div><div style="position: absolute; bottom: -12px; height: 40px">Sheet</div>"#,
        #"<div style="min-height: 100vh"><div id="count">0</div></div>"#,
    ])
    func whatFollowsTheWindowDoesntGrowIt(html: String) async throws {
        let reports = Reports()
        let page = try await load(html, reports: reports)
        let first = try #require(reports.height)
        var heights: [Double] = []
        for count in 1...4 {
            try await fit(page, reports)
            try await change(page, #"document.getElementById("count").textContent = "\#(count)""#)
            heights.append(try #require(reports.height))
        }
        #expect(heights[2] == heights[3])
        #expect(heights[3] <= first + 24)
    }

    /// A feed that loads another row once it's given room, as tall as the room it was just
    /// given: it isn't taken for what follows the window, and the row shows.
    @Test func aRowThatComesWithTheRoomShows() async throws {
        let reports = Reports()
        let addRow = #"{ const row = document.createElement("div"); row.style.height = "40px"; document.getElementById("rows").append(row) }"#
        let page = try await load(#"<div id="rows"><div style="height: 40px"></div></div><script>addEventListener("resize", () => { if (window.armed) { window.armed = false; "# + addRow + "} })</script>", reports: reports)
        try await fit(page, reports)
        try await change(page, addRow + "; window.armed = true")
        let two = try #require(reports.height)
        try await fit(page, reports)
        #expect(try #require(reports.height) >= two + 40)
    }

    /// A menu kept closed below the last row, hidden until it's opened: it leaves no space.
    @Test func aClosedMenuLeavesNoSpace() async throws {
        let reports = Reports()
        _ = try await load(#"<div><div style="height: 120px">Rows</div><ul style="position: absolute; visibility: hidden; height: 200px">Menu</ul></div>"#, reports: reports)
        #expect(abs(try #require(reports.height) - 128) <= 4)
    }

    /// An <html> or <head> written in a comment or a script before the page's own: the policy
    /// (no fetching, no sending) and the app's look still come with the page, not inside them.
    @Test(arguments: [
        #"<!-- an <html> template --><!doctype html><html><body><div style="height: 120px">A chart</div></body></html>"#,
        #"<script>const template = "<html><head></head></html>";</script><div style="height: 120px">A chart</div>"#,
        #"<!doctype html><script>const template = "<head>";</script><div style="height: 120px">A chart</div>"#,
    ])
    func thePolicyComesWithThePageWhateverItsScriptsSay(html: String) async throws {
        let reports = Reports()
        let page = try await load(html, reports: reports)
        #expect(try await page.evaluateJavaScript(#"document.head.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null"#) as? Bool == true)
        #expect(try await page.evaluateJavaScript("getComputedStyle(document.body).fontSize") as? String == "13px")
        #expect(try await page.evaluateJavaScript("document.compatMode") as? String == "CSS1Compat")
    }

    /// A whole page without a doctype: the policy and the app's look come before it, and its own
    /// <html> keeps what it says (its language) and its own <head> what's in it.
    @Test func aWholePageWithoutADoctypeKeepsItsOwnHead() async throws {
        let reports = Reports()
        let page = try await load(#"<html lang="en"><head><title>Scores</title></head><body><div style="height: 120px">A chart</div></body></html>"#, reports: reports)
        #expect(try await page.evaluateJavaScript(#"document.head.querySelector('meta[http-equiv="Content-Security-Policy"]') !== null"#) as? Bool == true)
        #expect(try await page.evaluateJavaScript("document.documentElement.lang") as? String == "en")
        #expect(try await page.evaluateJavaScript("document.title") as? String == "Scores")
        #expect(try await page.evaluateJavaScript("getComputedStyle(document.body).fontSize") as? String == "13px")
    }

    /// A whole page with its own doctype stays a standard page: the app's look goes in after it,
    /// not before (which would lay it out the old way, as pages without one are).
    @Test func aWholePageKeepsItsOwnDoctype() async throws {
        let reports = Reports()
        let page = try await load(#"<!doctype html><html lang="en"><body><div style="height: 120px">A chart</div></body></html>"#, reports: reports)
        #expect(try await page.evaluateJavaScript("document.compatMode") as? String == "CSS1Compat")
        #expect(abs(try #require(reports.height) - 128) <= 4)
    }

    /// A page without a doctype, laid out the old way, whose body has margins of its own: given
    /// the room it asked for, again and again, it asks for the same.
    @Test func aPageWithoutADoctypeDoesntGrowEachTimeItsMeasured() async throws {
        let reports = Reports()
        let page = try await load(#"<html><style>body { margin: 16px; }</style><body><div style="height: 120px">A chart</div></body></html>"#, reports: reports)
        let first = try #require(reports.height)
        for _ in 0..<3 { try await fit(page, reports) }
        #expect(reports.height == first)
        #expect(abs(first - 160) <= 8)
    }

    /// A page without a doctype, which fills its view however little is on it: details shown
    /// and hidden again, the widget gets its height back.
    @Test func aPageWithoutADoctypeGetsShorterAgain() async throws {
        let reports = Reports()
        let page = try await load(#"<html><body><div id="chart" style="height: 120px">A chart</div></body></html>"#, reports: reports)
        let first = try #require(reports.height)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("chart").style.height = "420px""#)
        #expect(try #require(reports.height) >= first + 290)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("chart").style.height = "120px""#)
        #expect(reports.height == first)
    }

    /// A page made to fill its window (`height: 100%`) whose chart is drawn in once it has its
    /// room: the widget grows with it, none of it cut off.
    @Test func aFullHeightPageSaysWhenItsContentGrows() async throws {
        let reports = Reports()
        let page = try await load(#"<style>html, body { height: 100%; }</style><div id="chart" style="height: 120px; background: #eee">A chart</div>"#, reports: reports)
        try await fit(page, reports)
        try await change(page, #"document.getElementById("chart").style.height = "420px""#)
        #expect(abs(try #require(reports.height) - 424) <= 8)
    }
}

@MainActor
private final class Reports: NSObject, WKScriptMessageHandler {
    var height: Double?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["type"] as? String == "height", let height = body["value"] as? Double else { return }
        self.height = height
        TestPulse.beat()
    }
}
