import ClientSessions
import Foundation
import OpenCodeKit
import Testing

/// The steps line's "Worked for": the time from the first step's start to the last one's end, as
/// both apps show it, and the steps' own words when they don't say when they ran.
struct StepTimeTests {
    private func tool(_ time: String?) throws -> Message.Content {
        let when = try time.map { try JSONDecoder().decode(Message.ToolCall.Time.self, from: Data($0.utf8)) }
        return .tool(Message.ToolCall(id: "call", name: "bash", state: .running(input: .null, metadata: nil), time: when))
    }

    @Test func stepsTakeFromTheFirstStartToTheLastEnd() throws {
        let thinking = Message.Content.reasoning(.init(text: "Looking", time: .init(created: 1_000, completed: 3_000)))
        let steps = [thinking, try tool(#"{"created": 3500, "ran": 3600, "completed": 6200}"#), try tool(#"{"ran": 7000, "completed": 12900}"#)]
        // The wait between them counts: it's how long you waited.
        #expect(StepTime.seconds(of: steps) == 11)
        // Under a second still says one.
        #expect(StepTime.seconds(of: [.reasoning(.init(text: "Quick", time: .init(created: 1_000, completed: 1_200)))]) == 1)
    }

    @Test func stepsThatDontSayWhenTheyRanHaveNoTime() throws {
        #expect(StepTime.seconds(of: [try tool(nil)]) == nil)
        // Started, but not finished.
        #expect(StepTime.seconds(of: [.reasoning(.init(text: "Still thinking", time: .init(created: 1_000)))]) == nil)
    }
}
