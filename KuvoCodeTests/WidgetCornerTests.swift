import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// A widget narrower than the reply it's in: its page says where the widget ends, so Open Larger
/// and Copy sit in the widget's own corner, never over the reply's words beside or above it.
@MainActor
@Suite(.timeLimit(.minutes(1))) struct WidgetCornerTests {
    /// Where the widget's content ends, from its left edge, as its page reports it when drawn
    /// `width` points wide.
    private func right(of html: String, width: CGFloat) async throws -> Double {
        let reports = Reports()
        let page = try await load(html, reports: reports, width: width)
        try await until { reports.right != nil }
        return try withExtendedLifetime(page) { try #require(reports.right) }
    }

    /// The widget's page, as the conversation draws it, its reports to `reports`.
    private func load(_ html: String, reports: Reports, width: CGFloat = 640) async throws -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(reports, contentWorld: .defaultClient, name: "kuvo")
        configuration.userContentController.addUserScript(WKUserScript(source: WidgetPage.measure, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        let page = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 300), configuration: configuration)
        page.loadHTMLString(WidgetPage.page(html, accent: .systemBlue), baseURL: nil)
        return page
    }

    @Test func aNarrowWidgetSaysWhereItEnds() async throws {
        let card = #"<div style="width: 240px; box-sizing: border-box; padding: 12px; background: #eee">3 agents · 1,284 files</div>"#
        let right = try await right(of: card, width: 640)
        // Its own edge (the page's padding before it), not the reply's.
        #expect(abs(right - 242) <= 2)
    }

    @Test func aWidgetAsWideAsTheReplyEndsAtItsEdge() async throws {
        let chart = #"<div style="height: 120px; background: #eee">A chart</div>"#
        #expect(abs(try await right(of: chart, width: 640) - 640) <= 4)
        // Words straight in the page run the whole width too.
        #expect(abs(try await right(of: "Done: 12 files changed.", width: 640) - 640) <= 4)
    }

    @Test func thePillSitsBesideANarrowWidgetAndInsideTheCornerOfAWideOne() {
        // Beside a card 242 points in, in a reply 640 wide, level with its top: over neither the
        // reply's words nor the card's own controls.
        #expect(WidgetCard.pillX(widgetRight: 242, width: 640, pill: 56) == 248)
        // As wide as the reply: inside its corner, all of it on the page.
        #expect(WidgetCard.pillX(widgetRight: 640, width: 640, pill: 56) == 578)
        // Not measured yet, or measured as nothing: the reply's corner, never past its left edge.
        #expect(WidgetCard.pillX(widgetRight: nil, width: 640, pill: 56) == 578)
        #expect(WidgetCard.pillX(widgetRight: 0, width: 640, pill: 56) == 578)
        #expect(WidgetCard.pillX(widgetRight: 640, width: 40, pill: 56) == 0)
    }

    // The user's report (2026-10-31): a widget as wide as the reply had Open Larger and Copy over
    // its first line ("does not mean" hidden). Whatever its width, the controls cover none of it.
    @Test func theControlsCoverNoneOfTheWidgetAtAnyWidth() {
        let pill = CGSize(width: 56, height: 24), reply: CGFloat = 640, height: CGFloat = 220
        for widgetRight: CGFloat in [242, 560, 600, 640] {
            let widget = CGRect(x: 0, y: 0, width: widgetRight, height: height)
            let controls = CGRect(x: WidgetCard.pillX(widgetRight: widgetRight, width: reply, pill: pill.width), y: 6, width: pill.width, height: pill.height)
            #expect(!controls.intersects(widget), "a widget ending at \(widgetRight) of \(reply): its controls at \(controls)")
        }
    }

    @Test func aWidgetThatGrowsWiderWithoutGrowingTallerSaysWhereItEndsNow() async throws {
        let reports = Reports()
        let page = try await load(#"<div id="card" style="display: inline-block; height: 40px; background: #eee">9</div>"#, reports: reports)
        try await until { reports.right.map { $0 < 100 } == true }
        _ = try await page.evaluateJavaScript(#"document.getElementById("card").style.width = "300px""#)
        try await until { (reports.right ?? 0) > 200 }
        #expect(abs(try #require(reports.right) - 302) <= 2)
    }
}

@MainActor
private final class Reports: NSObject, WKScriptMessageHandler {
    var right: Double?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let right = body["right"] as? Double else { return }
        self.right = right
        TestPulse.beat()
    }
}
