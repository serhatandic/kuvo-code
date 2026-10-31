import Foundation
import PDFKit
import Testing
@testable import KuvoCode

/// The agent saving the page in its browser as a PDF (L25, browser_save_pdf): a file of pages
/// with the page's words, at the full path it gave, replacing one there only once the new one is
/// saved; what was typed in from your sign-ins (a code, a password) stays out of it, and the page
/// shows it again after. A path that isn't a full one ending in .pdf, a folder's, or an empty
/// browser is turned down, saying why. Real WebKit, on a local page.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct PagePDFTests {
    let folder = AppInfo.testRoot.appending(path: "PDF-\(UUID().uuidString.prefix(6))")
    let utilities = Utilities()
    var agent: BrowserAgent { BrowserAgent(utilities: utilities, asks: BrowserAsks()) }

    private func page() throws -> String {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: "report.html")
        try """
            <html><body>
            <h1>Lighthouse report</h1>
            <p>The keeper logged three ships before dawn.</p>
            <label>Code <input type="text" data-kuvo-secret value="482913"></label>
            <label>Ship <input type="text" value="Northwind"></label>
            </body></html>
            """.write(to: file, atomically: true, encoding: .utf8)
        return file.path(percentEncoded: false)
    }

    private func words(_ url: URL) -> String {
        PDFDocument(url: url)?.string ?? ""
    }

    @Test func thePageAsAPDFWithoutWhatYouFilledIn() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        let agent = agent
        _ = await agent.navigate(try page())
        let target = folder.appending(path: "out/report.pdf")
        let said = await agent.savePDF(to: target.path(percentEncoded: false))
        #expect(said.hasPrefix("Saved the page as a"), "\(said)")
        let pdf = try #require(PDFDocument(url: target))
        #expect(pdf.pageCount >= 1)
        #expect(words(target).contains("Lighthouse report"))
        #expect(words(target).contains("three ships before dawn"))
        #expect(!words(target).contains("482913"), "what you filled in stays out of it")
        #expect(words(target).contains("Northwind"), "the page's other fields print as they are")

        // Saved again over another file: replaced with the new one.
        try Data("not a pdf".utf8).write(to: target)
        #expect(await agent.savePDF(to: target.path(percentEncoded: false)).hasPrefix("Saved"))
        #expect(words(target).contains("Lighthouse report"))
    }

    /// In a session that asks before reading or writing files outside its folder: saved in the
    /// folder (a new one in it too), not over a file elsewhere.
    @Test func savedInTheFolderNotOverAFileElsewhere() async throws {
        let elsewhere = try #require(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
            .appending(path: "\(AppInfo.bundleID)/PDF-elsewhere-\(UUID().uuidString.prefix(6))")
        let given = folder.path(percentEncoded: false)
        BrowserTools.sessionFolder = { _ in given }
        BrowserTools.readsAnywhere = { _ in false }
        defer {
            BrowserTools.sessionFolder = { _ in nil }
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.removeItem(at: elsewhere)
        }
        let agent = agent
        _ = await agent.navigate(try page())
        func save(_ path: String) async -> (text: String, isError: Bool) {
            let value = await BrowserTools.call("browser_save_pdf", arguments: ["path": path], agent: agent, caller: "ses_pdf")
            return (((value["content"] as? [[String: Any]])?.first?["text"] as? String) ?? "", value["isError"] as? Bool ?? false)
        }

        let outside = elsewhere.appending(path: "notes.pdf")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try Data("your notes".utf8).write(to: outside)
        let refused = await save(outside.path(percentEncoded: false))
        #expect(refused.isError)
        #expect(refused.text.hasPrefix("Not saved:"), "\(refused.text)")
        #expect(try String(contentsOf: outside, encoding: .utf8) == "your notes", "the file there stays as it was")

        let inside = folder.appending(path: "out/report.pdf")
        #expect(await save(inside.path(percentEncoded: false)).text.hasPrefix("Saved the page as a"))
        #expect(words(inside).contains("Lighthouse report"))
        // Named through a folder that isn't there yet: still outside, and told at once.
        let around = await save(elsewhere.path(percentEncoded: false) + "/new/../notes.pdf")
        #expect(around.text.hasPrefix("Not saved:"), "\(around.text)")
        #expect(try String(contentsOf: outside, encoding: .utf8) == "your notes")
        // In the folder the same way: saved where it says, with no folder made on the way.
        #expect(await save(folder.path(percentEncoded: false) + "/made/../through.pdf").text.hasPrefix("Saved the page as a"))
        #expect(FileManager.default.fileExists(atPath: folder.appending(path: "through.pdf").path(percentEncoded: false)))
        #expect(!FileManager.default.fileExists(atPath: folder.appending(path: "made").path(percentEncoded: false)))
    }

    @Test func whatItTurnsDown() async throws {
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(await agent.savePDF(to: folder.appending(path: "x.pdf").path(percentEncoded: false)).hasPrefix("The browser is empty"))
        let agent = agent
        _ = await agent.navigate(try page())
        #expect(await agent.savePDF(to: "report.pdf") == "Give a full path ending in .pdf.")
        #expect(await agent.savePDF(to: folder.appending(path: "report.txt").path(percentEncoded: false)) == "Give a full path ending in .pdf.")
        let named = folder.appending(path: "taken.pdf")
        try FileManager.default.createDirectory(at: named, withIntermediateDirectories: true)
        #expect(await agent.savePDF(to: named.path(percentEncoded: false)).hasPrefix("There's a folder at"))
    }
}
