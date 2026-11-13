import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// What a picker offers and the model a new conversation starts on, from what its box says
/// (`kuvo/models/offered`), as the box answers it: the Mac and the phone draw the same (#341 item
/// 13: each kept its own rule before).
struct OfferedModelsTests {
    private func offered(_ json: String) throws -> OfferedModels {
        try JSONDecoder().decode(OfferedModels.self, from: Data(json.utf8))
    }

    private let isAgent: (String) -> Bool = { $0.hasPrefix("claude-code") || $0 == "auto" }

    @Test func whatRunsIsOfferedAndTheStartingModelSaid() throws {
        let said = try offered(#"{"models":[{"providerID":"anthropic","id":"claude-opus-5-5","name":"Claude Opus 5.5"},{"providerID":"anthropic","id":"claude-sonnet-5","name":"Claude Sonnet 5","retiring":true},{"providerID":"claude-code","id":"claude-opus-5-5","name":"Opus 5.5"}],"known":{"engine":true,"agents":true},"starting":{"providerID":"claude-code","id":"claude-opus-5-5","variant":"high"}}"#)
        #expect(said.runs(ModelRef(id: "claude-opus-5-5", providerID: "anthropic"), isAgent: isAgent) == true)
        #expect(said.runs(ModelRef(id: "gpt-5.5", providerID: "github-copilot"), isAgent: isAgent) == false, "signed out of: not offered")
        #expect(said.models[1].retiring)
        #expect(said.starting == .some(ModelRef(id: "claude-opus-5-5", providerID: "claude-code", variant: "high")))
    }

    /// None that runs is said (`null`); the engine that can't say yet leaves it out, and its models
    /// aren't taken as none.
    @Test func noneAndNotSaidAreApart() throws {
        let none = try offered(#"{"models":[],"known":{"engine":true,"agents":true},"starting":null}"#)
        #expect(none.starting == .some(nil))
        let loading = try offered(#"{"models":[{"providerID":"claude-code","id":"claude-opus-5-5","name":"Opus 5.5"}],"known":{"engine":false,"agents":true}}"#)
        #expect(loading.starting == nil)
        #expect(loading.runs(ModelRef(id: "claude-opus-5-5", providerID: "anthropic"), isAgent: isAgent) == nil)
    }

    /// A side the box couldn't say just now keeps what it said before, rather than offering nothing.
    @Test func aSideNotSaidKeepsWhatWasSaid() throws {
        let before = try offered(#"{"models":[{"providerID":"anthropic","id":"claude-opus-5-5","name":"Claude Opus 5.5"},{"providerID":"claude-code","id":"default","name":"Opus"}],"known":{"engine":true,"agents":true}}"#)
        let now = try offered(#"{"models":[{"providerID":"anthropic","id":"claude-opus-5-5","name":"Claude Opus 5.5"}],"known":{"engine":true,"agents":false}}"#)
        let kept = now.keeping(before, isAgent: isAgent)
        #expect(kept.known == .init(engine: true, agents: true))
        #expect(kept.runs(ModelRef(id: "default", providerID: "claude-code"), isAgent: isAgent) == true)
    }

    /// The model wanted goes as its parts, each read back whole by the box (a "+" in an id, a "/").
    @Test func theWantedModelGoesWhole() throws {
        #expect(OfferedModels.path() == "kuvo/models/offered")
        let path = OfferedModels.path(wanted: ModelRef(id: "anthropic/claude+1:8b", providerID: "openrouter", variant: "high"), folder: "/Users/me/a b")
        let query = try #require(URLComponents(string: "x://y/" + path)?.queryItems)
        #expect(query.map(\.name) == ["provider", "model", "variant", "folder"])
        #expect(query.map(\.value) == ["openrouter", "anthropic/claude+1:8b", "high", "/Users/me/a b"])
        #expect(path.contains("%2B"))
    }
}
