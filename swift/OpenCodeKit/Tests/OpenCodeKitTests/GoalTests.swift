import Foundation
import Testing
@testable import OpenCodeKit

// Goals as a box sends them (Packages/Box/src/agents/goals.ts), and "/goal" as you type it.

/// A goal met, and one paused, as a box's `api/kuvo/goals` lists them.
@Test func readsGoalsAsABoxSendsThem() throws {
    let json = #"""
    {"data":[
      {"session":"ses_a","condition":"tests pass","state":"met","started":1792993149067,"turns":1,"checking":false,
       "last":{"verdict":"met","reason":"npm test exits 0.","at":1792993164862},"ended":1792993164862},
      {"session":"ses_b","condition":"the build is green","state":"paused","pausedBy":"error","note":"The turn failed: Rate limited.",
       "started":1792993149067,"turns":4,"checking":false,"last":{"verdict":"not_met","reason":"2 tests fail.","at":1792993164862}}
    ]}
    """#
    let goals = try HTTPClient.decoder.decode(DataEnvelope<[Goal]>.self, from: Data(json.utf8)).data
    #expect(goals[0].state == .met)
    #expect(goals[0].isOver)
    #expect(goals[0].last?.reason == "npm test exits 0.")
    #expect(goals[0].endedDate == Date(timeIntervalSince1970: 1_792_993_164.862))
    #expect(goals[1].state == .paused)
    #expect(goals[1].pausedBy == .error)
    #expect(goals[1].last?.verdict == .notMet)
    #expect(!goals[1].isOver)
}

/// What you type after "/goal": a goal, or a word that pauses, resumes or takes it away.
@Test func readsWhatYouTypeAfterSlashGoal() {
    #expect(GoalCommand("/goal all tests in test/auth pass") == .set("all tests in test/auth pass"))
    #expect(GoalCommand("  /goal   the build is green\nand lint is clean ") == .set("the build is green\nand lint is clean"))
    #expect(GoalCommand("/goal") == .show)
    #expect(GoalCommand("/goal pause") == .pause)
    #expect(GoalCommand("/goal Resume") == .resume)
    for word in ["clear", "stop", "off", "reset", "none", "cancel"] { #expect(GoalCommand("/goal \(word)") == .clear) }
    // A goal that only starts with one of those words is a goal.
    #expect(GoalCommand("/goal stop the flaky test from failing") == .set("stop the flaky test from failing"))
    #expect(GoalCommand("/goal\tthe build is green") == .set("the build is green"))
    // Only setting one needs the conversation's model.
    #expect(GoalCommand("/goal tests pass")?.needsModel == true)
    #expect(GoalCommand("/goal clear")?.needsModel == false)
    #expect(GoalCommand("/goals") == nil)
    #expect(GoalCommand("set a /goal") == nil)
}
