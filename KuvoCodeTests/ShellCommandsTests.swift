import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// "!" in the composer (B20): the rest runs as a command in the session's folder, as typed,
/// without a message to the agent; files and what you were replying to wait in the composer for
/// your next message; a command the engine doesn't take comes back to the composer, saying why.
/// The engine is stubbed.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct ShellCommandsTests {
    let engine = StubEngine(port: 47999)
    let workspace = Workspace()
    let id = "ses_shell"

    init() {
        workspace.api = engine.api
    }

    private func open() async throws -> SessionModel {
        engine.list([StubEngine.session(id, title: "Shell", directory: "/tmp/kuvo-tests-shell")])
        engine.conversation(id, [])
        await workspace.refresh()
        let model = try #require(workspace.model(for: id))
        await model.load()
        return model
    }

    @Test func aCommandRunsAsTypedAndTheRestWaits() async throws {
        defer {
            engine.stop()
            Drafts.shared.remove(id)
        }
        engine.on("POST", "/api/session/\(id)/shell", json: [:])
        let model = try await open()
        let file = URL(filePath: "/tmp/kuvo-tests-shell/screenshot.png")
        model.draftText = "!npm test -- --watch=false"
        model.draftFiles = [file]
        model.draftQuotes = [Drafts.Quote(text: "The build fails on CI")]
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { !engine.requests("POST", "/api/session/\(id)/shell").isEmpty }
        #expect(engine.requests("POST", "/api/session/\(id)/shell").first?.body["command"] as? String == "npm test -- --watch=false")
        #expect(engine.requests("POST", "/api/session/\(id)/prompt").isEmpty, "no message to the agent")
        #expect(model.draftText.isEmpty)
        #expect(model.draftFiles == [file], "files wait for a message")
        #expect(model.draftQuotes.map(\.text) == ["The build fails on CI"], "so does what you were replying to")
    }

    @Test func aCommandNotTakenComesBack() async throws {
        defer {
            engine.stop()
            Drafts.shared.remove(id)
        }
        engine.on("POST", "/api/session/\(id)/shell", json: ["message": "Session is busy"], status: 409)
        let model = try await open()
        model.draftText = "!git status"
        model.submitDraft(for: nil, queue: false, commands: [])
        try await until { model.failure != nil }
        #expect(model.draftText == "!git status", "back as you typed it")
        #expect(model.failure != nil)
    }
}
