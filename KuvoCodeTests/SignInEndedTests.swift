import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A plan's sign-in that ran out and couldn't be renewed, as Settings › Accounts and the sidebar
/// mark it: the computer's box keeps it, so it's marked when the app opens, and for one noted while
/// no Mac watched (a bot's run overnight with the Mac closed), not only for one this Mac saw end.
/// The engine is stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized) struct SignInEndedTests {
    let engine = StubEngine(port: 47931)

    /// The engine's plans: GitHub Copilot signed in with `credential`, OpenAI with a key.
    private func plans(copilot credential: String) {
        engine.on("GET", "/api/integration", json: ["location": ["directory": "/"], "data": [
            ["id": "github-copilot", "name": "GitHub Copilot", "methods": [["type": "oauth", "id": "github", "label": "Sign in with GitHub"]],
             "connections": [["type": "credential", "id": credential, "label": "GitHub", "method": "oauth"]]],
            ["id": "openai", "name": "OpenAI", "methods": [["type": "key"]],
             "connections": [["type": "credential", "id": "crd_key", "label": "API key", "method": "key"]]],
        ]])
    }

    @Test func aSignInThatEndedWhileTheAppWasClosedIsMarkedWhenItOpens() async throws {
        let box = try await TestBox(engine: engine.url)
        defer {
            box.stop()
            engine.stop()
        }
        plans(copilot: "crd_old")
        // As the box noted it, from a run refused while no app watched.
        try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
        try Data(#"{"github-copilot":"crd_old"}"#.utf8).write(to: BoxProcess.run.appending(path: "ended-sign-ins.json"))

        let catalog = Catalog()
        catalog.api = engine.api
        catalog.box = box.client(engine: engine.url)
        await catalog.refresh()
        #expect(catalog.hasEndedSignIn("github-copilot"))
        #expect(catalog.endedProviders == ["github-copilot"])
        #expect(!catalog.hasEndedSignIn("openai"))

        // Signed in again elsewhere (the phone): the one in use is another, and nothing's marked.
        plans(copilot: "crd_new")
        await catalog.refresh()
        #expect(!catalog.hasEndedSignIn("github-copilot"))
        #expect(catalog.endedProviders.isEmpty)
    }
}
