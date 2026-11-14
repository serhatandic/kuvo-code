import Foundation
import Testing
@testable import OpenCodeKit

/// Claude Code's `default` isn't listed: the model it stands for is, known by that name too, so a
/// star or a conversation from before still finds it, on its own account.
struct ModelAliasTests {
    private func model(_ id: String, provider: String, aliases: [String]? = nil) throws -> Model {
        let alias = aliases.map { #","aliases":[\#($0.map { "\"\($0)\"" }.joined(separator: ","))]"# } ?? ""
        let json = #"{"id":"\#(id)","providerID":"\#(provider)","name":"\#(id)"\#(alias),"capabilities":{"tools":true,"input":["text"],"output":["text"]},"variants":[],"time":{"released":0},"cost":[],"status":"active","enabled":true,"limit":{"context":1,"output":1}}"#
        return try JSONDecoder().decode(Model.self, from: Data(json.utf8))
    }

    @Test func aStarOnTheDefaultAndOneOnItsModelAreOne() throws {
        let models = [
            try model("opus", provider: "claude-code", aliases: ["default"]),
            try model("sonnet", provider: "claude-code"),
            try model("sonnet", provider: "claude-code@work", aliases: ["default"]),
        ]
        // (Another account's default is its own: Sonnet there, not Opus.)
        let saved = ["claude-code/opus", "claude-code/default", "claude-code@work/default", "gone/model", "claude-code@work/sonnet"]
        #expect(models.canonicalKeys(saved) == ["claude-code/opus", "claude-code@work/sonnet", "gone/model"])
    }

    @Test func aRefNamingTheDefaultNamesTheModelOnThatAccountOnly() throws {
        let opus = try model("opus", provider: "claude-code", aliases: ["default"])
        #expect(opus.isNamed(by: ModelRef(id: "default", providerID: "claude-code")))
        #expect(opus.isNamed(by: ModelRef(id: "opus", providerID: "claude-code")))
        #expect(!opus.isNamed(by: ModelRef(id: "default", providerID: "claude-code@work")))
        #expect(!opus.isNamed(by: ModelRef(id: "sonnet", providerID: "claude-code")))
    }
}
