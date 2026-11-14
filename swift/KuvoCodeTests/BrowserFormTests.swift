import Foundation
import Testing
@testable import KuvoCode

/// The agent filling in a form in its browser (E2, L31): it reads the page as numbered elements,
/// types into a field by its number, picks an option, ticks a box and clicks the button, and the
/// page gets each value; it reads the page's words after; Back goes to the page before. Real
/// WebKit, on local pages.
@MainActor
@Suite(.serialized) struct BrowserFormTests {
    let folder = AppInfo.testRoot.appending(path: "Form-\(UUID().uuidString.prefix(6))")
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

    @Test func itFillsInAFormAndTheFormGetsIt() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let start = try write("start.html", "<html><body><h1>Pizza shop</h1><a href=\"order.html\">Order a pizza</a></body></html>")
        _ = try write("order.html", """
            <html><body>
            <h1>Order</h1>
            <form id="f">
              <input name="name" placeholder="Your name">
              <select name="size" aria-label="Size"><option>Small</option><option>Medium</option><option>Large</option></select>
              <label><input type="checkbox" name="cheese"> Extra cheese</label>
              <button type="submit">Place order</button>
            </form>
            <p id="out"></p>
            <script>
              document.getElementById('f').addEventListener('submit', e => {
                e.preventDefault();
                const f = e.target;
                document.getElementById('out').textContent = 'Ordered: ' + f.name.value + ', ' + f.size.value + (f.cheese.checked ? ', extra cheese' : '');
              });
            </script>
            </body></html>
            """)
        let agent = BrowserAgent(utilities: utilities, asks: BrowserAsks())
        let first = await agent.navigate(start)
        let link = try #require(number(of: "Order a pizza", in: first), "no link in: \(first)")
        let form = await agent.click(link)
        #expect(form.contains("Order"), "\(form)")

        let snapshot = await agent.snapshot()
        let name = try #require(number(of: "Your name", in: snapshot), "\(snapshot)")
        let size = try #require(number(of: "Small", in: snapshot) ?? number(of: "Size", in: snapshot), "\(snapshot)")
        let cheese = try #require(number(of: "checkbox", in: snapshot) ?? number(of: "Extra cheese", in: snapshot), "\(snapshot)")
        let order = try #require(number(of: "Place order", in: snapshot), "\(snapshot)")

        #expect(await agent.type(name, text: "Ada Lovelace", submit: false, clear: true).hasPrefix("Typed into"))
        #expect(await agent.select(size, option: "Large").hasPrefix("Selected"))
        #expect(await agent.click(cheese).hasPrefix("Clicked"))
        #expect(await agent.click(order).hasPrefix("Clicked"))
        let words = await agent.text()
        #expect(words.contains("Ordered: Ada Lovelace, Large, extra cheese"), "\(words)")

        // Back to the page before.
        let back = await agent.back()
        #expect(back.contains("Pizza shop"), "\(back)")
    }
}
