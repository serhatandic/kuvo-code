import Foundation
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
}
