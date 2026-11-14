import ClientText
import Testing

/// What a wake-up's line shows of its note: what to do, first. The conversation's own folder an
/// agent put at its start ("In /Users/…/salary-demo, check…") goes; other words and paths stay.
struct WakeNoteTests {
    private let folder = "/Users/alice/Desktop/test project/salary-demo"

    @Test func theConversationsFolderAtTheStartGoes() {
        #expect(WakeNote.shown("In /Users/alice/Desktop/test project/salary-demo, check whether the salary demo tests still pass.", folder: folder) == "Check whether the salary demo tests still pass.")
        #expect(WakeNote.shown("In `/Users/alice/Desktop/test project/salary-demo/`: run the tests", folder: folder) == "Run the tests")
        #expect(WakeNote.shown("in ~/Desktop/test project/salary-demo, see if CI passed", folder: folder) == "See if CI passed")
        // Over several lines too; and a command stays as written.
        #expect(WakeNote.shown("In /Users/alice/Desktop/test project/salary-demo:\nnpm test, then report", folder: folder) == "npm test, then report")
    }

    @Test func otherNotesAndPathsStayAsWritten() {
        #expect(WakeNote.shown("Check the deploy", folder: folder) == "Check the deploy")
        #expect(WakeNote.shown("In 20 minutes, look at the build", folder: folder) == "In 20 minutes, look at the build")
        #expect(WakeNote.shown("/review the branch, then post it", folder: folder) == "/review the branch, then post it")
        #expect(WakeNote.shown("In /api/users, the 500 is back: check logs", folder: folder) == "In /api/users, the 500 is back: check logs")
        #expect(WakeNote.shown("/tmp/build.log: see if it finished", folder: folder) == "/tmp/build.log: see if it finished")
        #expect(WakeNote.shown("In /Users/x/app, check it", folder: nil) == "In /Users/x/app, check it")
    }
}
