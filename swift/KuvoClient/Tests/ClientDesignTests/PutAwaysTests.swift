import ClientDesign
import Testing

/// What a bar's ✕ put away: Undo brings it back for a moment, then it goes for good.
@MainActor
struct PutAwaysTests {
    private enum Item: Hashable { case goal, message(String) }

    /// The moment never passes by itself here: each test says when it does.
    private let putAways = PutAways<Item>(wait: { _ in await withUnsafeContinuation { (_: UnsafeContinuation<Void, Never>) in } })

    @Test func aGoalPutAwayIsOnlyClearedOnceTheMomentPasses() {
        var cleared = 0
        putAways.put(.goal, text: "Goal put away", done: { cleared += 1 })
        #expect(putAways.isPutAway(.goal))
        #expect(putAways.text(.goal) == "Goal put away")
        #expect(cleared == 0)
        putAways.expire(.goal)
        #expect(cleared == 1)
        #expect(!putAways.isPutAway(.goal))
        // Gone is gone: nothing happens twice.
        putAways.expire(.goal)
        putAways.undo(.goal)
        #expect(cleared == 1)
    }

    @Test func undoKeepsWhatWasPutAway() {
        var cleared = 0, kept = 0
        putAways.put(.goal, text: "Goal put away", undo: { kept += 1 }, done: { cleared += 1 })
        putAways.undo(.goal)
        #expect(kept == 1)
        #expect(!putAways.isPutAway(.goal))
        // The moment passing after Undo doesn't clear it.
        putAways.expire(.goal)
        #expect(cleared == 0)
    }

    @Test func aGoalBeingClearedKeepsItsLineUntilItsGone() {
        var cleared = 0
        putAways.put(.goal, text: "Goal put away", lingers: true, done: { cleared += 1 })
        #expect(putAways.canUndo(.goal))
        putAways.expire(.goal)
        // Asked to clear, not cleared yet: the line stays, without Undo, so the bar doesn't come back meanwhile.
        #expect(cleared == 1)
        #expect(putAways.isPutAway(.goal))
        #expect(!putAways.canUndo(.goal))
        #expect(putAways.text(.goal) == "Goal put away")
        putAways.undo(.goal)
        #expect(putAways.isPutAway(.goal))
        putAways.gone(.goal)
        #expect(!putAways.isPutAway(.goal))
    }

    @Test func eachThingPutAwayHasItsOwnUndo() {
        var back: [String] = []
        putAways.put(.message("a"), text: "Message removed", undo: { back.append("a") })
        putAways.put(.message("b"), text: "Message removed", undo: { back.append("b") })
        putAways.undo(.message("b"))
        #expect(back == ["b"])
        #expect(putAways.isPutAway(.message("a")))
    }

    @Test func theMomentPassingClearsItByItself() async {
        let passes = AsyncStream<Void>.makeStream()
        let timed = PutAways<Item>(wait: { _ in for await _ in passes.stream { return } })
        var cleared = false
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            timed.put(.goal, text: "Goal put away", done: {
                cleared = true
                finished.resume()
            })
            passes.continuation.yield()
        }
        #expect(cleared)
        #expect(!timed.isPutAway(.goal))
    }
}
