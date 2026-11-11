import ClientSessions
import Testing

/// A conversation whose model can't be chosen now (gone from its account, or nothing picked and no
/// default): the composer's chip says "Choose a Model", and Send can't go (#338: it used to send,
/// and an error came back). Send is off and Return opens the model picker, all of it kept; once a
/// model is chosen, it goes. What needs no model goes without one.
struct ComposerSendTests {
    @Test func noModelChosenAsksForOneInsteadOfSending() {
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: false) == .chooseModel)
        #expect(!ComposerSend(ready: true, text: "Fix the build", hasModel: false).sends, "Send is off")
        #expect(ComposerSend(ready: true, text: "/review", hasModel: false) == .chooseModel, "a command runs on the model too")
        #expect(ComposerSend(ready: true, text: "/goal all tests pass", hasModel: false) == .chooseModel, "setting a goal starts the agent")
        #expect(ComposerSend(ready: true, text: "Fix the build", hasModel: true) == .send)
    }

    @Test func whatNeedsNoModelGoesWithoutOne() {
        #expect(ComposerSend(ready: true, text: "!git status", hasModel: false) == .send)
        for goal in ["/goal", "/goal pause", "/goal resume", "/goal clear"] {
            #expect(ComposerSend(ready: true, text: goal, hasModel: false) == .send, "\(goal)")
        }
        // With a coding agent on the phone, "!" is words for the agent.
        #expect(ComposerSend(ready: true, text: "!git status", hasModel: false, runsShell: false) == .chooseModel)
    }

    /// Nothing to send (an empty field, its computer away): Send is off, and Return asks for nothing.
    @Test func nothingToSendWaitsWithOrWithoutAModel() {
        #expect(ComposerSend(ready: false, text: "", hasModel: false) == .wait)
        #expect(ComposerSend(ready: false, text: "Fix the build", hasModel: true) == .wait)
    }
}
