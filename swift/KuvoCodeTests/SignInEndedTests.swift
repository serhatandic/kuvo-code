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
        // (Its plugins set up: the box asks before it trusts its list.)
        engine.on("GET", "/api/provider", json: ["data": []])
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

        // One this Mac saw end, before the box notes it: still marked after the box is read.
        catalog.signInEnded("github-copilot")
        await catalog.refresh()
        #expect(catalog.hasEndedSignIn("github-copilot"))
    }

    @Test func aSignInThisMacSawWorkIsntMarkedAgainBeforeTheBoxHearsSo() async throws {
        let box = try await TestBox(engine: engine.url)
        defer {
            box.stop()
            engine.stop()
        }
        plans(copilot: "crd_old")
        let ended = BoxProcess.run.appending(path: "ended-sign-ins.json")
        try FileManager.default.createDirectory(at: BoxProcess.run, withIntermediateDirectories: true)
        try Data(#"{"github-copilot":"crd_old"}"#.utf8).write(to: ended)
        let catalog = Catalog()
        catalog.api = engine.api
        catalog.box = box.client(engine: engine.url)
        await catalog.refresh()
        #expect(catalog.hasEndedSignIn("github-copilot"))

        // A step on it ended well here (renewed after all), and the box, a moment behind, still
        // lists it: it works.
        catalog.signInWorks("github-copilot")
        await catalog.refresh()
        #expect(!catalog.hasEndedSignIn("github-copilot"))

        // The box caught up; then a run on it is refused again, while no app watched: marked.
        try FileManager.default.removeItem(at: ended)
        await catalog.refresh()
        #expect(!catalog.hasEndedSignIn("github-copilot"))
        try Data(#"{"github-copilot":"crd_old"}"#.utf8).write(to: ended)
        await catalog.refresh()
        #expect(catalog.hasEndedSignIn("github-copilot"))

        // Worked here while the box listed nothing; then a run on it is refused while no app
        // watched (the Mac asleep): marked when the box is read.
        try FileManager.default.removeItem(at: ended)
        await catalog.refresh()
        catalog.signInWorks("github-copilot")
        try Data(#"{"github-copilot":"crd_old"}"#.utf8).write(to: ended)
        await catalog.refresh()
        #expect(catalog.hasEndedSignIn("github-copilot"))
    }

    /// A run a provider turned down for something other than a sign-in (your input flagged, a
    /// quota or a rate limit), though its words say 403 or forbidden: the failure says what the
    /// provider said, without telling you to sign in again. Refusals for want of one still do.
    @Test func aRefusalThatIsntAboutSigningInIsntSaidToBe() {
        // (The suite's engine answers for 127.0.0.1 until stopped, the next suite's servers too.)
        defer { engine.stop() }
        #expect(!Catalog.isSignInRefusal(type: "provider.content-filter", message: "403 Forbidden: your input was flagged by moderation"))
        #expect(!Catalog.isSignInRefusal(type: "provider.quota", message: "Forbidden: monthly quota exceeded"))
        #expect(!Catalog.isSignInRefusal(type: "provider.rate-limit", message: "403 rate limited"))
        #expect(Catalog.isSignInRefusal(type: "provider.auth", message: "Invalid credentials"))
        #expect(Catalog.isSignInRefusal(type: "provider.invalid-request", message: "bad request: missing required Authorization header"))
        #expect(Catalog.isSignInRefusal(type: nil, message: "401 Unauthorized"))
    }
}
