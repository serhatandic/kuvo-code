import ClientText
import Testing

/// A failed turn's card: the headline says what happened, from the engine's kind of error, and
/// offers the way out that kind needs; one with no kind (a coding agent's) is told by its words.
struct FailureWordsTests {
    private func says(_ type: String?, _ message: String) -> (String, FailureWords.Way) {
        let kind = FailureWords.kind(type: type, message: message)
        return (FailureWords.headline(kind), FailureWords.way(kind))
    }

    @Test func theEnginesKindsSayWhatHappened() {
        #expect(says("provider.rate-limit", "Provider request failed with HTTP 429") == ("The provider is rate limiting you", .switchModel))
        #expect(says("provider.free-limit", "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.") == ("Free usage limit reached", .switchModel))
        #expect(says("provider.budget-limit", "Workspace usage limit reached.") == ("Usage limit reached", .switchModel))
        #expect(says("provider.transport", "fetch failed") == ("Couldn’t reach the provider", .none))
        #expect(says("provider.content-filter", "Blocked (violence)") == ("The model declined this request", .switchModel))
        #expect(says("provider.no-route", "Model unavailable: zen/flint-40b") == ("This model can’t be used now", .switchModel))
    }

    @Test func aSignInSaysWhetherItEnded() {
        #expect(says("provider.auth", "Request failed: 400") == ("This model’s sign-in has ended", .signIn))
        #expect(says("provider.auth", "Invalid API key") == ("This model’s account isn’t signed in", .signIn))
        #expect(says("signin", "Claude Code isn't signed in") == ("The coding agent isn’t signed in", .signIn))
    }

    @Test func aRefusedRequestThatsTooLongSaysSo() {
        #expect(says("provider.invalid-request", "Provider request failed with HTTP 400") == ("The provider turned the request down", .switchModel))
        #expect(says("provider.invalid-request", "prompt is too long: 210000 tokens > 200000 maximum") == ("The conversation is too long for this model", .switchModel))
    }

    @Test func oneWithNoKindIsToldByItsWords() {
        #expect(says(nil, "429 Too Many Requests") == ("The provider is rate limiting you", .switchModel))
        #expect(says("unknown", "Error: 401 Unauthorized") == ("This model’s account isn’t signed in", .signIn))
        #expect(says(nil, "connect ECONNREFUSED 127.0.0.1:443") == ("Couldn’t reach the provider", .none))
        #expect(says(nil, "Codex couldn't answer.") == ("The run failed", .none))
    }
}
