import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Keeping this Mac awake while agents work (Settings › General, on unless turned off): while a
/// session on this Mac works, it doesn't fall asleep on its own; once nothing works here, it may.
/// A session on one of your machines runs there whatever this Mac does, so it doesn't count.
@MainActor
@Suite(.serialized) struct KeepAwakeTests {
    let workspace = Workspace()

    init() {
        TestEnvironment.prepare()
        UserDefaults.standard.removeObject(forKey: Awake.key)
    }

    private func event(_ type: String, _ session: String) throws -> ServerEvent {
        try ServerEvent(json: JSONSerialization.data(withJSONObject: ["id": "evt_" + UUID().uuidString.prefix(8), "type": type, "created": 1, "data": ["sessionID": session]]))
    }

    @Test func awakeWhileThisMacsAgentsWork() throws {
        defer { Awake.shared.agentsWork(false) }
        workspace.handle(try event("session.execution.started", "ses_local"))
        #expect(Awake.shared.isHolding)
        workspace.handle(try event("session.execution.succeeded", "ses_local"))
        #expect(!Awake.shared.isHolding, "nothing works here: it may sleep")
    }

    @Test func aMachinesSessionDoesntKeepItAwake() throws {
        defer { Awake.shared.agentsWork(false) }
        workspace.handle(try event("session.execution.started", "ses_remote"), machine: "box")
        #expect(!Awake.shared.isHolding)
    }

    @Test func turnedOffItDoesnt() throws {
        defer {
            UserDefaults.standard.removeObject(forKey: Awake.key)
            Awake.shared.agentsWork(false)
        }
        UserDefaults.standard.set(false, forKey: Awake.key)
        workspace.handle(try event("session.execution.started", "ses_local"))
        #expect(!Awake.shared.isHolding)
        UserDefaults.standard.set(true, forKey: Awake.key)
        Awake.shared.update()
        #expect(Awake.shared.isHolding, "turned on while one works: it holds")
    }
}
