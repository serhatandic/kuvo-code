import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A conversation on a machine you read while the machine is away (asleep, out of reach) stays
/// read: after a quit, it isn't bold again (nor on the Dock) before the machine connects, and the
/// machine is told once it does. Nothing is driven but the lists as Kuvo Code keeps them.
@MainActor
@Suite(.serialized) struct MachineReadsTests {
    let machine = "devbox-reads"
    let id = "ses_readaway"

    @Test func aMachinesConversationReadWhileItsAwayStaysReadAfterAQuit() async throws {
        TestEnvironment.prepare()
        defer { SessionCopies.removeSessions(of: machine) }
        // It finished while you were away from it, as last seen.
        let finished = StubEngine.session(id, title: "Nightly build", directory: RemoteFolder.folder("/home/me/app", on: machine),
                                          extra: ["time": ["created": 1, "updated": 5, "idle": 5]])
        let session = try JSONDecoder().decode(Session.self, from: JSONSerialization.data(withJSONObject: finished))
        SessionCopies.saveSessions([session], of: machine)
        await SessionCopies.written()

        let workspace = Workspace()
        workspace.machines = [machine]
        #expect(workspace.session(id)?.isUnread == true)
        workspace.markViewed(id)
        #expect(workspace.session(id)?.isUnread == false)

        // Quit, opened again; the machine still away.
        let again = Workspace()
        again.machines = [machine]
        #expect(again.session(id)?.isUnread == false, "still read")
        // Removed, what waited to tell it goes too.
        again.forget(machine, forGood: true)
    }
}
