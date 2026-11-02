import ClientDesign
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

    @Test func howFarItIsIsSaidAsOtherProgressIs() {
        // The most a move takes, the box's cap, in the unit the cap is said in.
        #expect(MoveWords.progress(sent: 400_000_000, size: 1_000_000_000) == "0.4 of 1.0 GB")
        #expect(MoveWords.progress(sent: 50_000_000, size: 30_000_000) == "30 of 30 MB", "never more than all of it")
        #expect(MoveWords.progress(sent: nil, size: 0) == nil)
    }

    /// The connection gone before the box answered: whether it moved is said only as its box says
    /// it now, never "nothing moved" when it may have.
    @Test func cutOffItSaysOnlyWhatItsBoxSaysNow() {
        #expect(MoveWords.lost(from: "lab", moving: nil).hasPrefix("Kuvo Code lost touch with lab before it said whether it moved."))
        #expect(MoveWords.lost(from: "lab", moving: true).hasPrefix("Kuvo Code lost touch with lab while it moved. It goes on there"))
        let none = MoveWords.lost(from: "lab", moving: false)
        #expect(none == "Kuvo Code lost touch with lab before it answered, and nothing is moving there now. If it isn’t where you moved it, move it again.")
    }

    @Test func askedFirstItSaysWhatGoesAndWhatsLeftWhere() {
        let chat = MoveWords.question(kind: "chat", name: "“Trip plans”", place: "lab", placeIsMac: false, from: nil, fromMachine: false)
        #expect(chat.title == "Move “Trip plans” to lab?")
        #expect(chat.message == "Its conversation and wake-ups go there, and it carries on there. Nothing goes to it while it moves. Its folder here goes to the Trash, with a copy of its conversation in it.")
        // From a machine, asked from elsewhere (a phone): what's left goes to Kuvo Code's trash there.
        let bot = MoveWords.question(kind: "bot", name: "Ada", place: "Studio Mac", placeIsMac: true, from: "lab", fromMachine: true)
        #expect(bot.message.hasSuffix("Its folder on lab goes to Kuvo Code’s trash folder there, with a copy of its conversation in it."))
        #expect(MoveWords.question(kind: "group", name: "“Standup”", place: "this Mac", placeIsMac: true, toHere: true, from: "lab", fromMachine: true).message
            .hasPrefix("Its messages and meeting come here, and it carries on here while this Mac is on"))
        #expect(MoveWords.question(kind: "group", name: "“Standup”", place: "lab", placeIsMac: false, from: nil, fromMachine: false).message
            .hasPrefix("Its messages and meeting go there, and it carries on there, also while your Macs are off."))
    }
}
