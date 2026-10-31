import Foundation
import Testing
@testable import KuvoCode

/// The agent attaching a file to a page's upload field (E3, L22): one in the conversation's folder
/// goes into the field, and the page has it, name and size; one outside the folder, in a session
/// that asks before reading files elsewhere, isn't attached (it would go to the site unasked), and
/// the agent is told how to ask. Real WebKit, on a local page.
@MainActor
@Suite(.serialized) struct BrowserUploadTests {
    let folder = AppInfo.testRoot.appending(path: "Upload-\(UUID().uuidString.prefix(6))")
    let agent = BrowserAgent(utilities: Utilities(), asks: BrowserAsks())

    init() {
        TestEnvironment.prepare()
        let folder = folder.path(percentEncoded: false)
        BrowserTools.sessionFolder = { _ in folder }
        BrowserTools.readsAnywhere = { _ in false }
    }

    private func done() {
        BrowserTools.sessionFolder = { _ in nil }
        BrowserTools.readsAnywhere = { _ in false }
        try? FileManager.default.removeItem(at: folder)
    }

    private func result(_ value: [String: Any]) -> (text: String, isError: Bool) {
        (((value["content"] as? [[String: Any]])?.first?["text"] as? String) ?? "", value["isError"] as? Bool ?? false)
    }

    @Test func aFileInTheFolderGoesOneOutsideDoesnt() async throws {
        defer { done() }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try "Weekly numbers: 12, 15, 9\n".write(to: folder.appending(path: "report.txt"), atomically: true, encoding: .utf8)
        let page = folder.appending(path: "upload.html")
        try """
            <html><body><h1>Upload</h1>
            <input type="file" id="f" aria-label="Your file">
            <p id="out"></p>
            <script>document.getElementById('f').addEventListener('change', e => {
              const file = e.target.files[0];
              document.getElementById('out').textContent = 'Got ' + file.name + ', ' + file.size + ' bytes';
            });</script>
            </body></html>
            """.write(to: page, atomically: true, encoding: .utf8)
        let opened = result(await BrowserTools.call("browser_navigate", arguments: ["url": page.path(percentEncoded: false)], agent: agent, caller: "ses_upload"))
        #expect(!opened.isError, "\(opened.text)")
        let field = try #require(opened.text.split(separator: "\n").first { $0.contains("type=\"file\"") }?.firstMatch(of: /\[(\d+)\]/).map { Int($0.1)! }, "\(opened.text)")

        // Outside the folder: not attached.
        let outside = result(await BrowserTools.call("browser_upload", arguments: ["index": field, "files": ["/etc/hosts"]], agent: agent, caller: "ses_upload"))
        #expect(outside.isError)
        #expect(outside.text.hasPrefix("Not attached: /etc/hosts is outside this conversation's folder"), "\(outside.text)")
        #expect(!(await agent.text()).contains("Got hosts"))
        // Nor named without its leading slash (the app reads from /): not attached either.
        let relative = result(await BrowserTools.call("browser_upload", arguments: ["index": field, "files": ["etc/hosts"]], agent: agent, caller: "ses_upload"))
        #expect(relative.isError)
        #expect(!relative.text.hasPrefix("Attached"), "\(relative.text)")
        #expect(!(await agent.text()).contains("Got hosts"))

        // In it: the page has it.
        let inside = result(await BrowserTools.call("browser_upload", arguments: ["index": field, "files": [folder.appending(path: "report.txt").path(percentEncoded: false)]], agent: agent, caller: "ses_upload"))
        #expect(inside.text.hasPrefix("Attached the file"), "\(inside.text)")
        #expect((await agent.text()).contains("Got report.txt, 26 bytes"))
    }
}
