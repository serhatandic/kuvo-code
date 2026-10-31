import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The app following this Mac's keeper (`KeeperFollower`), as `AppModel` does, until it quits.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct KeeperFollowerTests {
    /// The app quits (`stopBox`) while a look at the keeper's records is still on its way (one its
    /// `run` folder's change set going, or one waiting on the keeper), and the keeper is gone by the
    /// time it reads. It says nothing: told the keeper is gone, the app would start a box of its own
    /// as it quits, which runs on with nothing to stop it.
    @Test func aLookUnderWayAsTheAppQuitsSaysNothing() async throws {
        try #require(KeeperRecord.read() == nil, "no keeper runs for the tests")
        BackgroundWork.shared.refresh()
        try #require(BackgroundWork.shared.state != .on, "this copy's background work isn't on, so no keeper is coming")
        let follower = KeeperFollower(box: BoxProcess(), agents: OutsideAgents())
        await follower.start()
        var heard: [String] = []
        follower.onGone = { heard.append("the keeper is gone") }
        follower.onEngine = { heard.append("the engine is \($0)") }
        follower.onKeeper = { heard.append("a keeper started") }
        follower.stop()

        await follower.read()
        #expect(heard.isEmpty)
    }

    /// After a restart, the box's records from before it are still there, and a process of
    /// another user's (macOS's own) has the process ID the keeper and its engine had: the app
    /// doesn't take them for a keeper and an engine running, and connect where nothing answers.
    @Test func recordsWhoseProcessIDIsAnotherUsersNowAreFromBefore() async throws {
        try #require(KeeperRecord.read() == nil, "no keeper runs for the tests")
        setenv("KUVO_KEEPER", "follow", 1)
        // launchd's process ID, which is root's.
        try KeeperRecord(pid: 1, version: AppInfo.version, build: AppInfo.build, url: "http://127.0.0.1:9", password: "x", started: 0).write()
        BoxProcess.engineChanged(ServerEndpoint(url: URL(string: "http://127.0.0.1:9")!, password: "x"), version: "1", pid: 1)
        let follower = KeeperFollower(box: BoxProcess(), agents: OutsideAgents())
        defer {
            follower.stop()
            KeeperRecord.forget(pid: 1)
            BoxProcess.engineChanged(nil, version: nil, pid: nil)
            unsetenv("KUVO_KEEPER")
        }

        await follower.start()
        #expect(KeeperRecord.read() == nil, "no keeper runs")
        #expect(follower.engine == .starting, "it waits for the keeper's engine rather than connect to the old one")
    }
}
