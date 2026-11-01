import Foundation
import Testing
@testable import KuvoCode

/// What a goal's card says over its plan: how many things are yours first counts only what you
/// can do something about, so it never points you at a row with nothing to press, and nothing
/// reads as ready over a row saying it can't work alone yet.
@MainActor
struct GoalCardWordsTests {
    private let fix = GoalSandbox.Row(title: "Turn on the sandbox", text: "", buttons: [.init(label: "Restart Agents", action: .restartAgents)])
    private let heldBack = GoalSandbox.Row(title: "It can’t work on its own yet", text: "This Mac’s Kuvo Code needs an update.", buttons: [])

    @Test func aSandboxRowWithAButtonIsYoursFirst() {
        #expect(GoalCard.subtitle(name: "Pixel", yours: 1, sandbox: fix, hasReady: true) == "Pixel’s plan. Two things are yours first; the rest is ready.")
        #expect(GoalCard.subtitle(name: "Pixel", yours: 0, sandbox: fix, hasReady: false) == "Pixel’s plan. One thing is yours first.")
    }

    @Test func aRowThatOnlySaysWhyItHoldsBackIsntCounted() {
        #expect(GoalCard.subtitle(name: "Pixel", yours: 0, sandbox: heldBack, hasReady: true) == "Pixel’s plan.")
        #expect(GoalCard.subtitle(name: "Pixel", yours: 2, sandbox: heldBack, hasReady: true) == "Pixel’s plan. Two things are yours first.")
        #expect(GoalCard.subtitle(name: "Pixel", yours: 0, sandbox: nil, hasReady: true) == "Pixel’s plan. Everything’s ready.")
    }

    @Test func aRowBeingCheckedIsntCountedYet() {
        var checking = fix
        checking.checking = true
        #expect(GoalCard.subtitle(name: "Pixel", yours: 0, sandbox: checking, hasReady: true) == "Pixel’s plan.")
    }
}
