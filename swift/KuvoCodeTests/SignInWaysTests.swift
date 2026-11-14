import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What Settings › Accounts offers for each account, as its computer's box says it
/// (`kuvo/sign-in/accounts`): whether it has a Sign In, and the way in its card names under its
/// name. The engine is stubbed; this Mac's box is real.
@MainActor
@Suite(.serialized) struct SignInWaysTests {
    let engine = StubEngine(port: 47918)

    @Test func eachCardNamesItsBoxsWayInAndOffersSignInOnlyWhereThereIsOne() async throws {
        let box = try await TestBox(engine: engine.url)
        defer {
            box.stop()
            engine.stop()
        }
        engine.on("GET", "/api/integration", json: ["location": ["directory": "/"], "data": [
            // Its sign-in says "Login with": named in one wording.
            ["id": "gitlab", "name": "GitLab Duo", "methods": [["type": "oauth", "id": "browser", "label": "Login with GitLab"]], "connections": [Any]()],
            // A ChatGPT plan goes through Codex: the engine's OpenAI offers its key, and its
            // legacy ways aren't named.
            ["id": "openai", "name": "OpenAI", "connections": [Any](), "methods": [
                ["type": "oauth", "id": "chatgpt-browser", "label": "Codex browser (legacy)"], ["type": "key"], ["type": "env", "names": ["OPENAI_API_KEY"]],
            ]],
            // Only its environment variable: nothing to sign in with here.
            ["id": "groq", "name": "Groq", "methods": [["type": "env", "names": ["GROQ_API_KEY"]]], "connections": [Any]()],
        ]])

        let catalog = Catalog()
        catalog.api = engine.api
        catalog.box = box.client(engine: engine.url)
        await catalog.refresh()
        #expect(catalog.signInHint("gitlab") == "Sign in with GitLab")
        #expect(catalog.signInHint("openai") == "API key")
        #expect(catalog.offersSignIn("gitlab"))
        #expect(catalog.offersSignIn("openai"))
        #expect(!catalog.offersSignIn("groq"))
        // One its box doesn't list: no Sign In, and nothing named.
        #expect(!catalog.offersSignIn("mistral"))
        #expect(catalog.signInHint("mistral") == nil)
    }
}
