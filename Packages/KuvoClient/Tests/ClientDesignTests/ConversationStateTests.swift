import ClientDesign
import Testing

/// What a conversation's row shows, the same on the Mac and the phone: what needs you is never
/// hidden behind work, work never behind news, and a computer that's away says so before what
/// happened there earlier.
@Suite struct ConversationStateTests {
    @Test func needsYouWinsOverWork() {
        #expect(ConversationState.kind(needsYou: true, working: true, failed: false, isNew: true) == .needsYou)
    }

    @Test func workWinsOverNewsAndAFailure() {
        #expect(ConversationState.kind(needsYou: false, working: true, failed: true, isNew: true) == .working)
        // Its own turn is over and its subagents are still at it.
        #expect(ConversationState.kind(needsYou: false, working: true, subagentsOnly: true, failed: false, isNew: false) == .subagents)
    }

    @Test func aComputerAwaySaysSoFirst() {
        #expect(ConversationState.kind(needsYou: false, working: false, failed: true, isNew: true, offline: true) == .offline)
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: true, waitingForComputer: true) == .waitingForComputer)
    }

    @Test func aFailureShowsUntilSomethingNewerNeedsSaying() {
        #expect(ConversationState.kind(needsYou: false, working: false, failed: true, isNew: true) == .failed)
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: true, wakes: true) == .new)
    }

    @Test func whatYouSetShowsWhenNothingElseDoes() {
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: false, paused: true, wakes: true) == .paused)
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: false, wakes: true, watching: true) == .wake)
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: false, watching: true) == .watching)
        #expect(ConversationState.kind(needsYou: false, working: false, failed: false, isNew: false) == nil)
    }
}
