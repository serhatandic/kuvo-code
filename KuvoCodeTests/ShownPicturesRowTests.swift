import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Pictures an agent shows one after another are one row of the conversation, to look through
/// together (#373), though each came in a step of its own; words between them start another. The
/// engine is stubbed.
@MainActor
@Suite(.serialized) struct ShownPicturesRowTests {
    let engine = StubEngine(port: 47917)
    let workspace = Workspace()
    let id = "ses_shownpictures"

    init() {
        workspace.api = engine.api
    }

    private static func shown(_ id: String, _ path: String) -> [String: Any] {
        ["type": "tool", "id": id, "name": "kuvo-browser_show_file", "state": ["status": "completed", "input": ["path": path], "content": [["type": "text", "text": "Shown."]]]]
    }

    private static func step(_ id: String, at time: Int, _ content: [[String: Any]]) -> [String: Any] {
        ["id": id, "type": "assistant", "agent": "build", "time": ["created": time, "completed": time + 500], "model": ["id": "m", "providerID": "p"], "content": content]
    }

    @Test func picturesInStepsOneAfterAnotherAreOneRow() async throws {
        defer { engine.stop() }
        let conversation: [[String: Any]] = [
            ["id": "msg_01", "type": "user", "time": ["created": 1_000], "text": "Show me the screenshots."],
            Self.step("msg_02", at: 2_000, [Self.shown("call_1", "/tmp/kuvo-tests/light.png")]),
            Self.step("msg_03", at: 3_000, [Self.shown("call_2", "/tmp/kuvo-tests/dark.png"), Self.shown("call_3", "/tmp/kuvo-tests/menu.png")]),
            Self.step("msg_04", at: 4_000, [["type": "text", "text": "And the old one:"], Self.shown("call_4", "/tmp/kuvo-tests/old.png")]),
            ["id": "msg_05", "type": "idle", "time": ["created": 5_000], "outcome": "succeeded"],
        ]
        engine.list([StubEngine.session(id, title: "Shots", directory: "/tmp/kuvo-tests-shownpictures")])
        engine.conversation(id, conversation)
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        let rows = TranscriptView.rows(of: model, catalog: Catalog(), detail: .summary)
        let pictures = rows.compactMap { if case .pictures(let calls) = $0 { calls.map(\.id) } else { nil } }
        #expect(pictures == [["call_1", "call_2", "call_3"], ["call_4"]])
    }
}
