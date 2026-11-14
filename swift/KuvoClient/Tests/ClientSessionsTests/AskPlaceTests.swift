import ClientSessions
import Testing

/// Which ask shows in the composer's place as asks come and go.
struct AskPlaceTests {
    @Test func theFirstShowsAndThePagerCountsOnlyWhenMoreWait() {
        var place = AskPlace()
        place.update(["a"])
        #expect(place.shown == "a")
        #expect(place.words == nil)
        place.update(["a", "b"])
        #expect(place.words == "1 of 2")
    }

    // You're writing what to do instead to the second ask, and another one comes in ahead of it:
    // yours stays, and the count says there's one more.
    @Test func aNewAskNeverTakesThePlaceOfTheOneShown() {
        var place = AskPlace()
        place.update(["a", "b"])
        place.show(1)
        place.update(["new", "a", "b"])
        #expect(place.shown == "b")
        #expect(place.words == "3 of 3")
    }

    @Test func onceTheOneShownIsAnsweredTheNextAfterItShows() {
        var place = AskPlace()
        place.update(["a", "b", "c"])
        place.show(1)
        place.update(["a", "c"])
        #expect(place.shown == "c")
        // The last one answered: the one before it.
        place.update(["a"])
        #expect(place.shown == "a")
        place.update([])
        #expect(place.shown == nil)
        #expect(place.words == nil)
    }

    @Test func thePagersArrowsGoNoFurtherThanTheEnds() {
        var place = AskPlace()
        place.update(["a", "b"])
        place.show(5)
        #expect(place.shown == "a")
        place.show(1)
        #expect(place.index == 1)
    }
}
