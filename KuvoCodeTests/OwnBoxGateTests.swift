import ClientSessions
import Foundation
import Testing
@testable import KuvoCode

/// This Mac's own box held by the update gate (#679) while another version's keeper runs it: looked
/// at again at once when its box answers anew (a new keeper's, its engine up again), never left
/// held until the look that waits its ten seconds comes round. This Mac's box is the real one
/// (`SettingsBox`), and the ten seconds are the test's own.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct OwnBoxGateTests {
    /// The gate's looks at this Mac's box, each one the test lets go of; and whether one was reached.
    private actor Looks {
        private var waiting: [CheckedContinuation<Void, Never>] = []
        private var reachedWaiters: [CheckedContinuation<Void, Never>] = []
        private var passes = 0
        func pass() async {
            passes += 1
            for waiter in reachedWaiters { waiter.resume() }
            reachedWaiters = []
            await withCheckedContinuation { waiting.append($0) }
        }
        /// Once a look waits its turn.
        func reached() async {
            if passes > 0 { return }
            await withCheckedContinuation { reachedWaiters.append($0) }
        }
        func releaseAll() {
            for waiter in waiting { waiter.resume() }
            waiting = []
        }
    }

    @Test func aHeldBoxIsLookedAtAgainAtOnceWhenItsBoxAnswersAnew() async throws {
        TestEnvironment.prepare()
        let lookAgain = AppModel.ownBoxLookAgain
        let looks = Looks()
        AppModel.ownBoxLookAgain = { await looks.pass() }
        let app = AppModel()
        var box: SettingsBox?
        defer {
            box?.stop()
            AppModel.ownBoxLookAgain = lookAgain
            app.machines.gates.letGo(BoxClient.mac)
        }
        // Held (an older app's keeper ran it), its box not answering yet: it can't say, and waits
        // for its next look.
        app.machines.gates.updating(BoxClient.mac, detail: BoxGate.Words.thisMacFinishing)
        app.followOwnBoxGate()
        await looks.reached()
        #expect(app.machines.gates.state(of: BoxClient.mac) != nil)

        // Its box answers now (a keeper of this version's): looked at again at once, and let go.
        box = try await SettingsBox(port: 47_955, alongside: true)
        app.followOwnBoxGate()
        #expect(app.machines.gates.state(of: BoxClient.mac) != nil, "a look waiting its turn isn't one taken now")
        app.followOwnBoxGate(again: true)
        try await until { app.machines.gates.state(of: BoxClient.mac) == nil }
        await looks.releaseAll()
    }
}
