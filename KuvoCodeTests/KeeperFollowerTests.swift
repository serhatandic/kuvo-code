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
        // With no keeper to start, the follower says background work didn't start, which Settings
        // (and a phone's kuvo/mac) would show for every test after this one.
        let didntStart = BackgroundWork.shared.didntStart
        defer { BackgroundWork.shared.didntStart = didntStart }
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

    /// The app quits while launchd is still being asked to start the keeper (as the app opens after
    /// Stop Background Work): it's still the keeper's to follow, and the app doesn't take it for
    /// one that isn't coming, which would start a box of its own as it quits.
    @Test func quittingWhileLaunchdIsAskedIsNoKeeperGone() async throws {
        try #require(KeeperRecord.read() == nil, "no keeper runs for the tests")
        let folder = AppInfo.testRoot.appending(path: "Launchd-\(UUID().uuidString.prefix(6))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let launchctl = folder.appending(path: "launchctl")
        try "#!/bin/sh\nsleep 2\nexit 0\n".write(to: launchctl, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchctl.path(percentEncoded: false))
        BackgroundWork.status = { .enabled }
        BackgroundWork.asUsersCopy = true
        BackgroundWork.launchctlForTests = launchctl.path(percentEncoded: false)
        BackgroundWork.shared.refresh()
        let didntStart = BackgroundWork.shared.didntStart
        let follower = KeeperFollower(box: BoxProcess(), agents: OutsideAgents())
        defer {
            follower.stop()
            BackgroundWork.status = nil
            BackgroundWork.asUsersCopy = false
            BackgroundWork.launchctlForTests = nil
            BackgroundWork.shared.refresh()
            BackgroundWork.shared.didntStart = didntStart
            try? FileManager.default.removeItem(at: folder)
        }
        var gone = false
        follower.onGone = { gone = true }
        let starting = Task { await follower.start() }
        try await Task.sleep(for: .milliseconds(200))
        follower.stop()
        #expect(await starting.value, "still the keeper's")
        #expect(!gone)
        #expect(BackgroundWork.shared.didntStart == didntStart, "Settings doesn't say background work didn't start")
    }
}
