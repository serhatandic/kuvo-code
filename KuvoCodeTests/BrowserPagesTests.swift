import Foundation
import Testing
import WebKit
@testable import KuvoCode

/// Pages that don't sit still for the agent's browser (L32, L35, L48): a window the page opens is
/// a tab of its own, which the agent can switch to and read, and a sign-in window that closes
/// itself gives way to the page that opened it, which hears from it; a long table is read whole,
/// rows the page adds as it's scrolled too; a site where nothing answers is said to be down, with
/// the page it was on kept. Real WebKit, on local pages.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct BrowserPagesTests {
    let folder = AppInfo.testRoot.appending(path: "Pages-\(UUID().uuidString.prefix(6))")
    let utilities = Utilities()

    private func write(_ name: String, _ html: String) throws -> String {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: name)
        try html.write(to: file, atomically: true, encoding: .utf8)
        return file.path(percentEncoded: false)
    }

    /// The number the snapshot gives the element on a line with `words`.
    private func number(of words: String, in snapshot: String) -> Int? {
        for line in snapshot.split(separator: "\n") where line.localizedCaseInsensitiveContains(words) {
            if let match = line.firstMatch(of: /\[(\d+)\]/) { return Int(match.1) }
        }
        return nil
    }

    private var tabCount: Int { utilities.browserTabs(of: utilities.panelKey).count }

    @Test func aWindowThePageOpensIsATabOfItsOwn() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let start = try write("start.html", """
            <html><head><title>Shop</title></head><body>
            <a href="report.html" target="_blank">Open the report</a>
            <button onclick="window.open('signin.html', 'signin', 'width=400,height=500')">Sign in with Lighthouse</button>
            <script>addEventListener('message', (event) => { document.title = 'Signed in as ' + event.data })</script>
            </body></html>
            """)
        _ = try write("report.html", "<html><head><title>Report</title></head><body><h1>Quarterly report</h1></body></html>")
        _ = try write("signin.html", """
            <html><head><title>Sign in</title></head><body>
            <button onclick="window.opener.postMessage('Ada', '*'); window.close()">Continue as Ada</button>
            </body></html>
            """)
        let agent = BrowserAgent(utilities: utilities, asks: BrowserAsks())
        let page = await agent.navigate(start)
        #expect(tabCount == 1)

        // A link to a new window: a tab of its own, listed, switched to, read.
        _ = await agent.click(try #require(number(of: "Open the report", in: page), "\(page)"))
        try await until { tabCount == 2 }
        #expect(tabCount == 2)
        let listed = await agent.tabs("list", tab: nil)
        #expect(listed.contains("Report"), "\(listed)")
        let report = await agent.tabs("switch", tab: try #require(number(of: "Report —", in: listed)))
        #expect(report.contains("Quarterly report"), "\(report)")

        // A sign-in window: it reports to the page that opened it, closes, and that page is back.
        let shop = await agent.tabs("switch", tab: try #require(number(of: "Shop —", in: listed)))
        _ = await agent.click(try #require(number(of: "Sign in with Lighthouse", in: shop), "\(shop)"))
        try await until { tabCount == 3 }
        #expect(tabCount == 3)
        let three = await agent.tabs("list", tab: nil)
        let signIn = await agent.tabs("switch", tab: try #require(number(of: "Sign in —", in: three), "\(three)"))
        _ = await agent.click(try #require(number(of: "Continue as Ada", in: signIn), "\(signIn)"))
        try await until { tabCount == 2 }
        #expect(tabCount == 2, "it closed itself")
        // The page that opened it heard from it.
        let titles = { utilities.browserTabs(of: utilities.panelKey).map(\.browser.title) }
        try await until { titles().contains("Signed in as Ada") }
        #expect(titles().contains("Signed in as Ada"), "\(titles())")
        let opener = try #require(utilities.browserTabs(of: utilities.panelKey).first { $0.browser.url?.lastPathComponent == "start.html" })
        let said = try? await opener.browser.webView.callAsyncJavaScript("return document.title", contentWorld: .page) as? String
        #expect(said == "Signed in as Ada", "the page itself: \(said ?? "nil")")
    }

    @Test func aLongTableIsReadWhole() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let rows = (1...400).map { "<tr><td>Ship \($0)</td><td>\($0 * 3) t</td></tr>" }.joined()
        let table = try write("table.html", "<html><body><h1>Harbor log</h1><table>\(rows)</table></body></html>")
        let agent = BrowserAgent(utilities: utilities, asks: BrowserAsks())
        _ = await agent.navigate(table)
        let words = await agent.text()
        #expect(words.contains("Ship 1\t3 t"), "\(words.prefix(200))")
        #expect(words.contains("Ship 400\t1200 t"), "rows far below what's in view too")

        // Rows the page adds as it's scrolled: there once the agent scrolls down.
        let feed = try write("feed.html", """
            <html><body style="margin:0">
            <div id="list"></div>
            <script>
              let next = 1
              const more = () => { for (let i = 0; i < 30; i++) { const row = document.createElement('div'); row.style.height = '40px'; row.textContent = 'Post ' + next++; list.appendChild(row) } }
              more()
              window.addEventListener('scroll', () => { if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 200) more() })
            </script>
            </body></html>
            """)
        _ = await agent.navigate(feed)
        #expect(!(await agent.text()).contains("Post 31"))
        for _ in 0..<3 { _ = await agent.scroll(down: true, pages: 3) }
        let scrolled = await agent.text()
        #expect(scrolled.contains("Post 31"), "\(scrolled.suffix(200))")
    }

    @Test func aSiteThatsDownSaysSo() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let agent = BrowserAgent(utilities: utilities, asks: BrowserAsks())
        let start = try write("start.html", "<html><head><title>Status board</title></head><body><h1>Status board</h1></body></html>")
        _ = await agent.navigate(start)
        // Nothing listens on port 1.
        let said = await agent.navigate("http://127.0.0.1:1/orders")
        #expect(said.hasPrefix("Couldn't open http://127.0.0.1:1/orders: "), "\(said)")
        #expect(said.contains("still on the page before"), "\(said)")
        #expect(said.contains("Status board"), "with that page: \(said)")
    }
}
