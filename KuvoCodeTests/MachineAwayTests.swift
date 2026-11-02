import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A conversation on a machine that isn't connected waits for it, as the machine's (its tab and
/// card say so, with Connect Now), never as a conversation that isn't there: a bot's too, before
/// any of its machine's sessions were ever listed here. One on this Mac, or on a machine that's
/// connected, or one you removed, doesn't wait.
@MainActor
@Suite struct MachineAwayTests {
    let workspace = Workspace()

    init() {
        TestEnvironment.prepare()
        // As the app tells it of its bots (see AppModel.startMachines).
        let names = ["ses_beril": "Beril", "ses_finance": "Finance"]
        let machines = ["ses_beril": "devbox"]
        workspace.botName = { names[$0] }
        workspace.botMachine = { machines[$0] }
    }

    @Test func aBotOnAMachineThatIsAwayWaitsForIt() {
        #expect(workspace.waitingMachine(for: "ses_beril") == "devbox")
        #expect(workspace.remoteTitle("ses_beril") == "Beril", "its card and tab are named after the bot")
    }

    /// Its machine removed, nothing waits for it: its tab closes.
    @Test func aBotOnARemovedMachineDoesntWait() {
        workspace.forget("devbox", forGood: true)
        #expect(workspace.waitingMachine(for: "ses_beril") == nil)
        // Added again: it waits for it again.
        workspace.machines = ["devbox"]
        #expect(workspace.waitingMachine(for: "ses_beril") == "devbox")
    }

    @Test func aBotOnThisMacDoesntWait() {
        #expect(workspace.waitingMachine(for: "ses_finance") == nil)
        #expect(workspace.waitingMachine(for: "ses_unknown") == nil)
    }
}
