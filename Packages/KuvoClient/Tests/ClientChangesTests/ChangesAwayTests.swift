import ClientChanges
import Foundation
import Testing

/// Changes on a computer that can't be reached, as both apps show it: the list as last seen, and
/// when, or never read, its connection in the list's place.
struct ChangesAwayTests {
    @Test func whatShowsWhileAway() {
        let read = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(ChangesAway.shown(isAway: false, read: nil) == .list)
        #expect(ChangesAway.shown(isAway: false, read: read) == .list)
        #expect(ChangesAway.shown(isAway: true, read: read) == .asLastSeen)
        #expect(ChangesAway.shown(isAway: true, read: nil) == .waiting)
    }

    @Test func asLastSeenSaysWhenAndWhatWaits() {
        let read = Date(timeIntervalSince1970: 1_800_000_000)
        let english = Locale(identifier: "en_US")
        #expect(ChangesAway.asLastSeen(read, now: read.addingTimeInterval(180), locale: english)
                == "These are its changes as last seen, 3 minutes ago. They can’t be staged or committed until it’s back.")
        #expect(ChangesAway.asLastSeen(read, now: read.addingTimeInterval(20), locale: english)
                == "These are its changes as last seen, a moment ago. They can’t be staged or committed until it’s back.")
        #expect(ChangesAway.waits("Stage", for: "build-box") == "Stage once build-box is back")
        #expect(ChangesAway.waits(for: "build-box") == "Once build-box is back")
        #expect(ChangesAway.notBack("build-box") == "build-box isn’t connected. Try again once it’s back.")
    }
}
