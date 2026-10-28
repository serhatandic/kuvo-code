import ClientText
import Testing

/// What a wake-up's line shows of its note: what to do, first. The folder an agent put at its start
/// ("In /Users/…/salary-demo, check…") is the conversation's own, so it goes; other words stay.
struct WakeNoteTests {
    @Test func aFolderAtTheStartGoes() {
        #expect(WakeNote.shown("In /Users/serhat/Desktop/test project/salary-demo, check whether the salary demo tests still pass.") == "Check whether the salary demo tests still pass.")
        #expect(WakeNote.shown("In `/tmp/demo`: run the tests") == "Run the tests")
        #expect(WakeNote.shown("in ~/code/app, see if CI passed") == "See if CI passed")
        #expect(WakeNote.shown("/Users/serhat/app: rerun the build") == "Rerun the build")
    }

    @Test func otherNotesStayAsWritten() {
        #expect(WakeNote.shown("Check the deploy") == "Check the deploy")
        #expect(WakeNote.shown("In 20 minutes, look at the build") == "In 20 minutes, look at the build")
        #expect(WakeNote.shown("In src/auth, the login test failed: look again") == "In src/auth, the login test failed: look again")
    }
}
