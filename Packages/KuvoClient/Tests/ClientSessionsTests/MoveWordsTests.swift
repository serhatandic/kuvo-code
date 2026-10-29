import ClientSessions
import Testing

/// What a moving bot's, chat's or group chat's row says in both apps, from what its box says of the
/// move: where it's going, and how far its copy is.
struct MoveWordsTests {
    @Test func aRowSaysWhereItsGoingAndHowFarItIs() {
        #expect(MoveWords.status(stage: "holding", place: "lab") == "Getting ready to move to lab…")
        #expect(MoveWords.status(stage: "copying", place: "lab", sent: 12_400_000, size: 30_000_000) == "Moving to lab… 12 of 30 MB")
        #expect(MoveWords.status(stage: "copying", place: "lab") == "Moving to lab…", "its size not known yet")
        #expect(MoveWords.status(stage: "switching", place: "Studio Mac") == "Finishing the move to Studio Mac…")
        #expect(MoveWords.status(stage: "finishing", place: "lab") == "Finishing the move to lab…")
        #expect(MoveWords.status(stage: "something-newer", place: "lab") == "Moving to lab…")
    }

    @Test func howFarItIsIsInTheUnitThatSuitsItsSize() {
        #expect(MoveWords.progress(sent: 300_000, size: 840_000) == "300 of 840 KB")
        #expect(MoveWords.progress(sent: 1_520_000, size: 4_000_000) == "1.5 of 4 MB")
        #expect(MoveWords.progress(sent: 400_000_000, size: 1_000_000_000) == "0.4 of 1 GB")
        #expect(MoveWords.progress(sent: 0, size: 30_000_000) == "0 of 30 MB")
        #expect(MoveWords.progress(sent: 50_000_000, size: 30_000_000) == "30 of 30 MB", "never more than all of it")
        #expect(MoveWords.progress(sent: nil, size: 0) == nil)
    }
}
