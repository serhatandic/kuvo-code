import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// A goal's card asks once which model does the work: while the box picked Power itself and
/// hasn't asked yet, and never once it's yours; what you pick there goes back to the box as yours.
struct ModelRolesTests {
    private func roles(_ power: String) throws -> ModelRoles {
        try JSONDecoder().decode(ModelRoles.self, from: Data(#"{"roles":[{"id":"chore","entries":[],"setBy":"box","then":[]},\#(power)]}"#.utf8))
    }

    @Test func theCardAsksOnlyWhileTheBoxPickedItAndHasntAsked() throws {
        let picked = try roles(#"{"id":"power","entries":[{"providerID":"anthropic","modelID":"claude-opus-5-5","name":"Opus 5.5","variant":"high","held":false}],"setBy":"box","why":"The ablest model on your plan here","then":[]}"#)
        #expect(picked.asksOnGoalCard)
        #expect(picked.power?.model == ModelRef(id: "claude-opus-5-5", providerID: "anthropic", variant: "high"))
        #expect(picked.power?.why == "The ablest model on your plan here")
        #expect(try !roles(#"{"id":"power","entries":[],"setBy":"box","asked":true,"then":[]}"#).asksOnGoalCard, "asked once already")
        #expect(try !roles(#"{"id":"power","entries":[{"providerID":"openai","modelID":"gpt-6","name":"GPT-6","held":false}],"setBy":"you","then":[]}"#).asksOnGoalCard, "yours")
        #expect(try !JSONDecoder().decode(ModelRoles.self, from: Data(#"{"roles":[]}"#.utf8)).asksOnGoalCard, "a box with no Power says nothing")
    }

    @Test func aModelPickedThereIsPowerAsYours() throws {
        let sent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ModelRoles.Set(ModelRef(id: "gpt-6", providerID: "openai", variant: "max")))) as? [String: Any]
        #expect(sent?["id"] as? String == "power")
        #expect((sent?["entries"] as? [[String: String]]) == [["providerID": "openai", "modelID": "gpt-6", "variant": "max"]])
    }
}
