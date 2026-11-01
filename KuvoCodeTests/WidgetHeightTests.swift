import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// A widget is shown as the agent made it, nothing over it: the conversation gives it the room its
/// page says it needs, and more as it grows, so none of it is cut off or covered by what follows.
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
