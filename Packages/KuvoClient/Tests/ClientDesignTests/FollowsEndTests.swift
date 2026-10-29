import ClientDesign
import Testing

/// A side thread follows its newest answer as it comes, as the conversation does: until you scroll
/// up to read something earlier, and again once you're back at the end or ask a follow-up.
struct FollowsEndTests {
    @Test func itFollowsUntilYouScrollUpAndAgainOnceYoureBack() {
        var follows = FollowsEnd()
        #expect(follows.isFollowing)
        // Reading an earlier answer: what comes doesn't pull you away from it.
        follows.scrolled(visibleBottom: 300, contentHeight: 900)
        #expect(!follows.isFollowing)
        // Back at the end, give or take a little.
        follows.scrolled(visibleBottom: 892, contentHeight: 900)
        #expect(follows.isFollowing)
    }

    @Test func askingSomethingFollowsItsAnswer() {
        var follows = FollowsEnd()
        follows.scrolled(visibleBottom: 120, contentHeight: 900)
        follows.asked()
        #expect(follows.isFollowing)
    }
}
