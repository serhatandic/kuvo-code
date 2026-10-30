import ClientSandbox
import Foundation
import Testing

/// What both apps read of a computer's sandbox, from what its box answers: its state, with the
/// words a newer box adds read as none rather than failing the page; an agent's ask and what Always
/// for This would keep; and a project's Also Allowed, asked for by its folder.
@Suite struct SandboxTests {
    @Test func aStateThatIsntOnSaysWhyAndWhatToDo() throws {
        let state = try JSONDecoder().decode(SandboxState.self, from: Data("""
        {"on":false,"why":"Its check failed: a command could write outside its folder.","able":true,"agents":false,
         "reason":"checkFailed","action":"retry","route":"POST kuvo/sandbox/check","check":"writesOwn","failures":3}
        """.utf8))
        #expect(!state.on && state.able)
        #expect(state.reason == .checkFailed && state.action == .retry && state.check == .writesOwn)
        #expect(state.route == "POST kuvo/sandbox/check" && state.failures == 3)
    }

    @Test func aNewerBoxsWordsStillLeaveItsState() throws {
        let state = try JSONDecoder().decode(SandboxState.self, from: Data("""
        {"on":false,"why":"Something new.","able":true,"agents":true,"reason":"somethingNew","action":"somethingElse","check":"another"}
        """.utf8))
        #expect(state.why == "Something new." && state.agents)
        #expect(state.reason == nil && state.action == nil && state.check == nil)
        // A box from before `sandbox.check` gives only these.
        let older = try JSONDecoder().decode(SandboxState.self, from: Data(#"{"on":true}"#.utf8))
        #expect(older.on && older.able && !older.agents)
    }

    @Test func anAskSaysWhatWasStoppedAndWhatAlwaysWouldKeep() throws {
        let asks = try JSONDecoder().decode(SandboxAsks.self, from: Data("""
        {"asks":[
          {"id":"sa_1","at":1793200000000,"session":"ses_1","sessionName":"Fix the build","bot":"bot_ship","botName":"Ship",
           "project":"/home/me/app","command":"npm install -g pnpm","why":"The build needs pnpm.",
           "stopped":[{"kind":"write","path":"/home/me/.npm-global"},{"kind":"somethingNew"}],
           "always":{"kind":"write","path":"/home/me/.npm-global"},"machine":"lokum"},
          {"id":"sa_2","at":1793200001000,"project":"/home/me/app","command":"open -a Simulator","why":"To see the app.","error":"Operation not permitted"}]}
        """.utf8))
        let first = asks.asks[0], second = asks.asks[1]
        #expect(first.asker == "Ship" && first.canAlways && first.always?.path == "/home/me/.npm-global")
        #expect(first.stopped?.map(\.kind) == [.write, .other], "a kind a newer box adds reads as other")
        #expect(second.asker == "An agent" && !second.canAlways && second.error == "Operation not permitted")
    }

    @Test func aProjectsAlsoAllowedIsAskedForByItsFolder() throws {
        #expect(SandboxRoutes.allowed(project: "/Users/me/My App & Co") == "kuvo/sandbox/allowed?project=/Users/me/My%20App%20%26%20Co")
        let allowed = try JSONDecoder().decode(SandboxAllowed.self, from: Data("""
        {"allowed":[{"id":"r_1","project":"/Users/me/app","kind":"write","path":"/Users/me/.cache/thing","at":1793200000000,"by":"Ship"}]}
        """.utf8))
        #expect(allowed.allowed.map(\.path) == ["/Users/me/.cache/thing"])
    }
}
