import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A message sent with files (C1–C3): the engine gets what the model can read with its contents and
/// the rest as paths the agent can open, and once the agent has the message, it still shows its
/// files, each once, under the words you wrote. The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct SentFilesTests {
    let engine = StubEngine(port: 47991)
    let workspace = Workspace()
    let id = "ses_files"
    let folder = AppInfo.testRoot.appending(path: "Sent files \(UUID().uuidString.prefix(8))")

    init() throws {
        workspace.api = engine.api
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    private func file(_ name: String, _ contents: Data) throws -> URL {
        let url = folder.appending(path: name)
        try contents.write(to: url)
        return url
    }

    /// What the conversation shows of a sent message: its words, and its files by name, those it
    /// carries and those its note names besides them (as its bubble lists them).
    private func shown(_ message: Message.User) -> (words: String, files: [String]) {
        let (words, _, paths, _) = SentMessage.split(CommandMessages.shared.text(of: message))
        let own = (message.files ?? []).compactMap(\.name)
        let named = Attachments.paths(paths, besides: (message.files ?? []).compactMap(\.fileURL)).map { ($0 as NSString).lastPathComponent }
        return (words, own + named)
    }

    @Test func aSentMessageKeepsItsFiles() async throws {
        defer {
            engine.stop()
            try? FileManager.default.removeItem(at: folder)
        }
        let report = try file("Q3 report.md", Data("# Q3\nRevenue went up.".utf8))
        // A zip's first bytes: binary, as an archive is.
        let archive = try file("logs.zip", Data([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x9C, 0xFE, 0x00, 0x00, 0xE3, 0x02]))
        engine.list([StubEngine.session(id, title: "Files", directory: folder.path)])
        engine.conversation(id, [])
        engine.on("POST", "/api/session/\(id)/prompt", json: [:])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()

        model.send("Summarize the report", files: [report, archive], for: nil)
        try await until { !engine.requests("POST", "/prompt").isEmpty }
        let sent = try #require(engine.requests("POST", "/prompt").first)
        let messageID = try #require(sent.body["id"] as? String)
        let text = try #require(sent.body["text"] as? String)
        // The report with what's in it; the archive, which no model reads, by its path.
        let files = sent.body["files"] as? [[String: Any]] ?? []
        #expect(files.compactMap { $0["name"] as? String } == ["Q3 report.md"])
        #expect(text.contains(archive.path), "the agent should be told where the archive is")
        #expect(text.contains(report.path), "the agent should be told where the report is too")

        // The engine has it, and gives it to the agent: its own copy names the file it carries.
        model.apply(try engine.event("session.inbox.enqueued", session: id, [
            "inboxID": messageID,
            "item": ["type": "user", "delivery": "steer", "payload": [
                "text": text,
                "files": [["mime": "text/markdown", "name": "Q3 report.md", "data": "IyBRMw==", "source": ["type": "uri", "uri": report.absoluteString]]],
            ]],
        ]))
        model.apply(try engine.event("session.inbox.delivered", session: id, ["inboxID": messageID]))

        guard case .user(let message)? = model.transcript.messages.last else {
            Issue.record("the message isn't in the conversation: \(model.transcript.messages)")
            return
        }
        let bubble = shown(message)
        #expect(bubble.words == "Summarize the report")
        #expect(bubble.files.sorted() == ["Q3 report.md", "logs.zip"], "each file once: \(bubble.files)")
        #expect(model.waiting.isEmpty)
    }
}
