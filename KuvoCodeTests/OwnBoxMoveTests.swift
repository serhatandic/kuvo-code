import Foundation
import KuvoLink
import OpenCodeKit
import ServiceManagement
import Testing
@testable import KuvoCode

/// This Mac's box moving out of the app's folder into a home of its own (#333 piece 5): the keeper
/// runs the move, finishes what it owes, then retires; after a crash at any step the next keeper
/// finishes it; a new Mac's box is made in its home from the start; and with `movesOwnBox` off
/// nothing of it happens. The box is the real one (`kuvo-link.js rehome` and `helper`, this app's own,
/// run by Bun as the keeper runs them), in a home folder of the test's own with an app folder laid out
/// as the app lays it out. What only the app's own program does (your Keychain, its launch agent),
/// the helper's short runs and launchd are stand-ins: never your Keychain, launchd or Login Items.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(2))) struct OwnBoxMoveTests {
    let world = AppInfo.testRoot.appending(path: "own-box-move-\(UUID().uuidString.prefix(8))", directoryHint: .isDirectory)
    var home: URL { world.appending(path: "home", directoryHint: .isDirectory) }
    /// The app's folder (as the real one, with a space in its name), and the box's home.
    var appFolder: URL { home.appending(path: "App Support", directoryHint: .isDirectory) }
    var K: URL { home.appending(path: ".kuvo-code", directoryHint: .isDirectory) }
    var tools: URL { world.appending(path: "tools", directoryHint: .isDirectory) }

    init() {
        TestEnvironment.prepare()
    }

    // MARK: The world

    /// What the app's program did, in order: its Keychain and launch agent, and the helper's runs.
    @MainActor final class Identity {
        var did: [String] = []
        /// The app's own items, and the helper's copies of them.
        var originals = true
        var copies = false
        /// What the helper's check says (nil: it reads every copy).
        var checkFails: String?

        var stands: OwnBoxMove.Identity {
            OwnBoxMove.Identity(
                copyKeys: { [self] in did.append("copy"); copies = true },
                copiesLeft: { [self] in copies && originals },
                helper: { [self] keys in
                    did.append("helper \(keys)")
                    if keys == "uncopy" { copies = false }
                    return keys == "check" ? checkFails : nil
                },
                // (As the real one: gone already, it's done.)
                deleteOriginals: { [self] in
                    guard originals else { return }
                    did.append("delete originals")
                    originals = false
                },
                unregister: { [self] in did.append("unregister"); return nil })
        }
    }

    private func put(_ text: String, _ file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    private func executable(_ text: String, _ file: URL) throws {
        try put(text, file)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
    }

    /// The link's version, as this app's box script says it (its served record must name it).
    private var bridgeVersion: String {
        get throws {
            let script = try String(contentsOf: try #require(BoxProcess.script), encoding: .utf8)
            return try #require(script.firstMatch(of: /BRIDGE_VERSION = "([^"]+)"/)).1.description
        }
    }

    /// A Mac whose app's box ran in its folder (it started since the app updated, and stopped: the
    /// keeper stops it before the move), with a chat and a bot; nothing in `~/.kuvo-code` yet.
    private func ranInItsFolder() throws {
        try put(#"{"app":"9.9.9","bridge":"\#(try bridgeVersion)","at":1}"#, appFolder.appending(path: "box/run/served.json"))
        try put(#"{"self":{"key":"k","name":"Mac","kind":"mac"},"app":true}"#, appFolder.appending(path: "box/run/setup-card.json"))
        try put(#"{"name":"Mac"}"#, appFolder.appending(path: "box/run/link.json"))
        try put("{}", appFolder.appending(path: "box/box/projects.json"))
        try put("[]", appFolder.appending(path: "box/machines.json"))
        try FileManager.default.createDirectory(at: appFolder.appending(path: "opencode/data/opencode"), withIntermediateDirectories: true)
        try put("notes", appFolder.appending(path: "Chats/c1/notes.md"))
        try put(appFolder.appending(path: "bots/b1/workspace").path(percentEncoded: false), appFolder.appending(path: "bots/b1/directory"))
        try executable("#!/bin/sh\n", appFolder.appending(path: "engine/\(OpenCodeEngine.version)/opencode"))
        // The app's own, which stays.
        try put("browser", appFolder.appending(path: "Browser/x"))
    }

    /// A new Mac: the engine downloaded into the app's folder, and its machines' list there, which
    /// the app writes with no box; no box of its own ever ran.
    private func newMac() throws {
        try executable("#!/bin/sh\n", appFolder.appending(path: "engine/\(OpenCodeEngine.version)/opencode"))
        try put("[]", appFolder.appending(path: "box/machines.json"))
    }

    /// launchctl's stand-in: what it's asked, and a launch agent loaded once it's bootstrapped.
    private func standIns() throws {
        try executable("""
            #!/bin/sh
            echo "$*" >> '\(tools.path(percentEncoded: false))/asked'
            case "$1" in
              bootstrap) touch '\(tools.path(percentEncoded: false))/loaded' ;;
              bootout) [ -f '\(tools.path(percentEncoded: false))/loaded' ] || exit 3; rm '\(tools.path(percentEncoded: false))/loaded' ;;
              print) [ -f '\(tools.path(percentEncoded: false))/loaded' ] || exit 113 ;;
            esac
            """, tools.appending(path: "launchctl"))
        try executable("#!/bin/sh\nexit 1\n", tools.appending(path: "crontab"))
    }

    private var launchctlAsked: [String] {
        ((try? String(contentsOf: tools.appending(path: "asked"), encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    /// The keeper's part, as the keeper has it here: this app's box script, run by Bun.
    private func keeper(_ identity: Identity, releaseHasHelper: Bool = true, environment: [String: String] = [:]) throws -> OwnBoxMove {
        let bun = try #require(ProcessInfo.processInfo.environment["KUVO_TEST_BUN"].flatMap { $0.isEmpty ? nil : URL(filePath: $0) },
                               "No Bun for the box's CLI: run the app's tests with scripts/test-app.sh, which gives it")
        try standIns()
        let releases = world.appending(path: "releases", directoryHint: .isDirectory)
        let move = OwnBoxMove(
            root: ".kuvo-code", home: home, appBox: appFolder.appending(path: "box"), engineData: appFolder.appending(path: "opencode/data/opencode"),
            engine: { bun }, script: BoxProcess.script, appID: "run.kuvo.code.tests", appVersion: "9.9.9", keepsAwakeOff: { false },
            identity: identity.stands,
            release: {
                // The box's own files, as a release brings them, with the helper (a stand-in).
                let release = releases.appending(path: UUID().uuidString, directoryHint: .isDirectory)
                try executable("#!/bin/sh\n", release.appending(path: "bin/kuvo-start"))
                try FileManager.default.copyItem(at: try #require(BoxProcess.script), to: release.appending(path: "bin/kuvo-link.js"))
                if releaseHasHelper { try executable("#!/bin/sh\n", BoxHelperBundle.executable(of: BoxHelperBundle.installed(in: release))) }
                return release
            })
        move.environment = ["KUVO_TEST_UNINSTALL_TOOLS": tools.path(percentEncoded: false)].merging(environment) { $1 }
        return move
    }

    private func done() {
        OwnBoxMove.stopsAt = nil
        try? FileManager.default.removeItem(at: world)
    }

    /// The move's state, as the box keeps it.
    private var state: [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(contentsOf: K.appending(path: "updates/rehome/state.json")))) as? [String: Any] ?? [:]
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) }

    /// Moved: this Mac's box in its home, laid out as a machine's, its helper loaded by launchd, and
    /// nothing left in the app's folder that says a box ran there (but what's the app's own).
    private func expectMoved(_ identity: Identity, sourceLocation: SourceLocation = #_sourceLocation) throws {
        #expect((try? String(contentsOf: K.appending(path: "box/kind"), encoding: .utf8)) == "mac\n", sourceLocation: sourceLocation)
        #expect(exists(K.appending(path: "chats/c1/notes.md")), sourceLocation: sourceLocation)
        #expect((try? String(contentsOf: K.appending(path: "bots/b1/directory"), encoding: .utf8)) == K.appending(path: "bots/b1/workspace").path(percentEncoded: false),
                "its paths rewritten", sourceLocation: sourceLocation)
        #expect(!exists(appFolder.appending(path: "box")) && !exists(appFolder.appending(path: "Chats")), sourceLocation: sourceLocation)
        #expect(exists(appFolder.appending(path: "Browser/x")), "the app's own stays", sourceLocation: sourceLocation)
        let plist = try String(contentsOf: home.appending(path: "Library/LaunchAgents/run.kuvo.code.machine.plist"), encoding: .utf8)
        #expect(plist.contains("Kuvo Code Box.app/Contents/MacOS/Kuvo Code Box") && plist.contains("<string>run.kuvo.code.tests</string>"), sourceLocation: sourceLocation)
        #expect(launchctlAsked.contains { $0.hasPrefix("bootstrap gui/") }, "launchd starts the helper now", sourceLocation: sourceLocation)
        #expect(!identity.originals, "the app's own Keychain items are gone", sourceLocation: sourceLocation)
        #expect(identity.did.last == "unregister", "the keeper's launch agent goes last", sourceLocation: sourceLocation)
        #expect(state["state"] as? String == "done" && (state["owed"] as? [String]) == [], "nothing owed", sourceLocation: sourceLocation)
    }

    /// Not moved: the app's folder as it was, nothing of a box in its home, the app's Keychain items
    /// kept and the helper's copies taken away; the old box starts.
    private func expectWhereItWas(_ identity: Identity, sourceLocation: SourceLocation = #_sourceLocation) {
        #expect(exists(appFolder.appending(path: "box/run/served.json")) && exists(appFolder.appending(path: "Chats/c1/notes.md")), sourceLocation: sourceLocation)
        #expect(!exists(K.appending(path: "box/kind")) && !exists(K.appending(path: "chats")) && !exists(K.appending(path: "bin")), sourceLocation: sourceLocation)
        #expect(identity.originals && !identity.copies, sourceLocation: sourceLocation)
        #expect(!identity.did.contains("unregister") && !identity.did.contains("delete originals"), sourceLocation: sourceLocation)
        #expect(!exists(home.appending(path: "Library/LaunchAgents/run.kuvo.code.machine.plist")), sourceLocation: sourceLocation)
    }

    // MARK: The move

    @Test func atAQuietMomentTheKeeperMovesThisMacsBoxFinishesWhatItOwesAndRetires() async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        let move = try keeper(identity)
        // The box, running in the app's folder with nothing under way, says it's time, and its
        // files for its home are what it takes.
        let release = try #require(await move.due())
        #expect(await move.move(release) == .retire)
        #expect(!exists(release), "its files for its home, gone once moved")
        // Copied and checked by the helper before the box moved, its originals deleted after.
        #expect(identity.did == ["copy", "helper check", "delete originals", "unregister"])
        try expectMoved(identity)
        // A keeper launchd starts again anyway (before it was unregistered) only retires again,
        // starting nothing there and writing nothing in the app's folder.
        #expect(await move.settle() == .retire)
        #expect(!exists(appFolder.appending(path: "box")))
        #expect(launchctlAsked.filter { $0.hasPrefix("bootstrap") }.count == 1, "the helper running is left running")
        // (Started if it isn't, as one that found the box moving went: never loaded and idle.)
        #expect(launchctlAsked.last == "kickstart gui/\(getuid())/run.kuvo.code.machine")
    }

    @Test func aMoveThatCantGoAheadLeavesTheBoxWhereItWasWithItsKeysAsTheyWere() async throws {
        defer { done() }
        try ranInItsFolder()
        // The helper can't read its copies: they're taken away, and nothing moves.
        let unreadable = Identity()
        unreadable.checkFails = "unreadable: phone-link/key"
        #expect(try await keeper(unreadable).moveNow() == .startOld)
        #expect(unreadable.did == ["copy", "helper check", "helper uncopy"])
        expectWhereItWas(unreadable)
        // Counted by the box as a try of its own: the next waits (never a stop every ten minutes).
        #expect(state["state"] as? String == "failed" && state["tries"] as? Int == 1)
        #expect((state["failed"] as? [String: Any])?["message"] as? String == "Kuvo Code Box couldn't read its copies of this Mac's keys: unreadable: phone-link/key")
        #expect(try await keeper(Identity()).isDue() == false)
        try FileManager.default.removeItem(at: K.appending(path: "updates/rehome/state.json"))

        // The box refuses (something written where it moves from as it moved): gone back, and the
        // copies taken away.
        let refused = Identity()
        let move = try keeper(refused, environment: ["KUVO_TEST_REHOME_WRITE_AT": "after-fix",
                                                    "KUVO_TEST_REHOME_WRITE_FILE": appFolder.appending(path: "Chats/c1/new.md").path(percentEncoded: false)])
        #expect(await move.moveNow() == .startOld)
        #expect(refused.did == ["copy", "helper check", "helper uncopy"])
        #expect(state["state"] as? String == "failed")
        expectWhereItWas(refused)

        // No helper in this copy of Kuvo Code: never moved where nothing would start it, and the
        // box says so with the old box running, before anything's stopped or copied.
        try FileManager.default.removeItem(at: K.appending(path: "updates/rehome/state.json"))
        let noHelper = Identity()
        #expect(try await keeper(noHelper, releaseHasHelper: false).due() == nil)
        #expect(noHelper.did.isEmpty)
        #expect(state["state"] as? String != "failed", "nothing tried")
        expectWhereItWas(noHelper)
    }

    /// Kuvo Code opened while the keeper moves its box, past the point the box's kind is in place
    /// (or stopped there): the app makes nothing and starts no helper, and the keeper finishes the
    /// move, back or on, its helper started only then.
    @Test(arguments: ["after-place", "in-clear"])
    func theAppOpeningDuringAMoveMakesNothingAndTheKeeperFinishesIt(_ point: String) async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        OwnBoxMove.stopsAt = .moved
        #expect(try await keeper(identity, environment: ["KUVO_TEST_REHOME_STOP": point]).moveNow() == .wait)
        OwnBoxMove.stopsAt = nil
        #expect((try? String(contentsOf: K.appending(path: "box/kind"), encoding: .utf8)) == "mac\n")
        // The app opens.
        #expect(try await keeper(Identity()).makeNew() == false)
        #expect(!exists(home.appending(path: "Library/LaunchAgents/run.kuvo.code.machine.plist")))
        #expect(launchctlAsked.isEmpty)
        // The keeper's next start.
        let next = try await keeper(identity).settle()
        if point == "in-clear" {
            #expect(next == .retire)
            try expectMoved(identity)
        } else {
            #expect(next == .startOld)
            expectWhereItWas(identity)
        }
    }

    /// The keeper killed at each of its own steps, then launchd starting it again: before the box
    /// moved, the box starts where it was (copies taken away); after, the move's finished off.
    @Test(arguments: [OwnBoxMove.Step.stopped, .copied, .checked, .moved, .helperLoaded, .originalsDeleted])
    func aKeeperStoppedAtEachOfItsStepsFinishesTheMoveAsItStartsAgain(_ step: OwnBoxMove.Step) async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        OwnBoxMove.stopsAt = step
        #expect(try await keeper(identity).moveNow() == .wait)
        OwnBoxMove.stopsAt = nil
        let next = try await keeper(identity).settle()
        switch step {
        case .stopped, .copied, .checked:
            #expect(next == .startOld)
            expectWhereItWas(identity)
        case .moved, .helperLoaded, .originalsDeleted:
            #expect(next == .retire)
            try expectMoved(identity)
            #expect(identity.did.filter { $0 == "delete originals" }.count == 1)
        }
    }

    /// The box's move cut short at each of its steps (killed, as a power cut would), then the next
    /// keeper's start: before it cleared the app's folder it goes back, exactly; from then on, on.
    @Test(arguments: ["after-plan", "after-install", "after-clone", "after-rewrite", "after-check", "in-place", "after-place", "after-fix", "in-clear", "after-clear"])
    func aMoveCutShortAtEachStepIsFinishedBackOrOnByTheNextKeeper(_ point: String) async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        // (The keeper itself stopped with it: what it does after a move that didn't say how it went
        // is what the next keeper does.)
        OwnBoxMove.stopsAt = .moved
        #expect(try await keeper(identity, environment: ["KUVO_TEST_REHOME_STOP": point]).moveNow() == .wait)
        OwnBoxMove.stopsAt = nil
        #expect(exists(K.appending(path: "updates/rehome/journal.json")), "a move under way")
        let next = try await keeper(identity).settle()
        if ["in-clear", "after-clear"].contains(point) {
            #expect(next == .retire)
            try expectMoved(identity)
        } else {
            #expect(next == .startOld)
            expectWhereItWas(identity)
        }
    }

    @Test func whatTheKeeperOwesWaitsWhileTheKeychainCantBeChangedAndTheBoxRunsMeanwhile() async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        var stands = identity.stands
        stands.deleteOriginals = { throw KeychainMove.Failure.refused("run.kuvo.code.tests.phone-link", -25308) }
        let move = try keeper(identity)
        let locked = OwnBoxMove(root: move.root, home: move.home, appBox: move.appBox, engineData: move.engineData, engine: move.engine, script: move.script,
                                appID: move.appID, appVersion: move.appVersion, keepsAwakeOff: move.keepsAwakeOff, identity: stands, release: move.release)
        locked.environment = move.environment
        #expect(await locked.moveNow() == .wait)
        // The box runs from its home already (its helper loaded), and the keeper stays registered,
        // owing the Keychain.
        #expect(launchctlAsked.contains { $0.hasPrefix("bootstrap") })
        #expect(!identity.did.contains("unregister"))
        #expect((state["owed"] as? [String])?.contains("keychain") == true)
        // Unlocked: finished off.
        #expect(await move.settle() == .retire)
        try expectMoved(identity)
    }

    // MARK: The keeper

    /// The keeper, as launchd runs it: its box running in the app's folder (the real `serve`, run
    /// with Node; the engine and bridge stand-ins), the move asked at its first look. Moved, it stops
    /// everything it ran and goes for good; not moved, it starts the box again as it was.
    enum Ends: String, CaseIterable, Sendable { case moved, wentBack, stoppedPartWay }

    /// The keeper, as launchd runs it: its box running in the app's folder (the real `serve`, run
    /// with Node; the engine and bridge stand-ins), the move asked at its first look. Meanwhile it
    /// says it's moving, and refuses what would start or stop anything, saying why. Moved, it stops
    /// everything it ran and goes for good; not moved, it starts the box again as it was; stopped
    /// part way (SIGTERM, as you log out), it starts nothing again and the next keeper finishes it.
    @Test(arguments: Ends.allCases)
    func theKeeperStopsItsBoxForTheMoveThenRetiresOrStartsItAgain(_ ends: Ends) async throws {
        let moves = ends == .moved
        let node = try #require(TestBox.node, "Node runs this Mac's box in the tests")
        let engine = StubEngine(port: 47951)
        let bridge = StubEngine(port: 47952, alongside: true)
        let starts = world.appending(path: "starts")
        try FileManager.default.createDirectory(at: world, withIntermediateDirectories: true)
        try executable("""
            #!/bin/sh
            for a in "$@"; do
              case "$a" in
                *kuvo-link.js) while [ "$1" != "$a" ]; do shift; done; exec '\(node.path(percentEncoded: false))' "$@";;
                *kuvo-agents.js) echo '{"url":"\(bridge.url)"}'; while [ -d '\(world.path(percentEncoded: false))' ]; do sleep 0.05; done; exit 0;;
              esac
            done
            echo >> '\(starts.path(percentEncoded: false))'
            echo '{"url":"\(engine.url)"}'
            while [ -d '\(world.path(percentEncoded: false))' ]; do sleep 0.05; done
            """, world.appending(path: "opencode"))
        setenv("KUVO_OPENCODE_BINARY", world.appending(path: "opencode").path(percentEncoded: false), 1)
        try await StubWeb.listen(port: 47951)
        let clock = TestClock()
        let realClock = Keeper.clock
        Keeper.clock = { [clock] seconds in await clock.wait(seconds) }
        final class Gone {
            var how: Keeper.Exit?
        }
        let gone = Gone()
        try ranInItsFolder()
        let identity = Identity()
        // (Stopped part way, it goes back too: the keeper of before started its box again then.)
        if ends != .moved { identity.checkFails = "unreadable: vault/files" }
        final class Holder { var keeper: Keeper? }
        let holder = Holder()
        var saidMeanwhile: (moving: Bool?, restart: String?)?
        // What the move finds as it starts, once the keeper stopped its box for it: nothing of its
        // box running (its records gone, its processes too), and its lock still held, so the app
        // starts none meanwhile. (The box moved here is the test's own folder, not the one the
        // keeper ran its box in, which the app's other tests share.)
        var atTheMove: (records: [String], claimed: Bool)?
        let stands = try self.keeper(identity)
        var seen = stands.identity
        seen.helper = { keys in
            if keys == "check" {
                // What the app hears meanwhile: moving, and Restart refused, saying why.
                let status = try? await KeeperControl.send(.status)
                var refused: String?
                do { try await KeeperControl.send(.restartEngine) } catch { refused = error.localizedDescription }
                saidMeanwhile = (status?["moving"] as? Bool, refused)
                if ends == .stoppedPartWay {
                    // Logging out: launchd's SIGTERM as the move goes on.
                    holder.keeper?.finish(.stopped)
                }
            }
            return await stands.identity.helper(keys)
        }
        seen.copyKeys = {
            let records = ["engine.json", "bridge.json", "serve.json"].filter { KeeperFollower.record($0) != nil }
            let lock = open(KeeperRecord.run.appending(path: "box.lock").path(percentEncoded: false), O_RDWR | O_CLOEXEC)
            defer { if lock >= 0 { close(lock) } }
            atTheMove = (records, lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) != 0)
            try stands.identity.copyKeys()
        }
        let move = OwnBoxMove(root: stands.root, home: stands.home, appBox: stands.appBox, engineData: stands.engineData, engine: stands.engine,
                              script: stands.script, appID: stands.appID, appVersion: stands.appVersion, keepsAwakeOff: stands.keepsAwakeOff,
                              identity: seen, release: stands.release)
        move.environment = stands.environment
        let keeper = Keeper(exits: { how in
            gone.how = how
            TestPulse.beat()
        }, move: move)
        holder.keeper = keeper
        defer {
            OwnBoxMove.stopsAt = nil
            keeper.finish(.stopped)
            Keeper.clock = realClock
            unsetenv("KUVO_OPENCODE_BINARY")
            done()
            StubWeb.stopListening(port: 47951)
            engine.stop()
        }
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        engine.list([])
        bridge.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 2])
        bridge.on("GET", "/api/session/active", json: ["data": [:] as [String: Any]])
        var engineStarts: Int { ((try? String(contentsOf: starts, encoding: .utf8)) ?? "").filter { $0 == "\n" }.count }

        await keeper.start()
        try Self.reach(keeper: KeeperRecord.read())
        if ends == .wentBack { try await until { engineStarts == 2 } } else { try await until { gone.how != nil } }
        #expect(atTheMove?.records == [], "nothing of the keeper's box ran as it moved")
        #expect(atTheMove?.claimed == true, "its lock held as it moved")
        #expect(saidMeanwhile?.moving == true)
        #expect(saidMeanwhile?.restart == "This Mac’s box is moving into its own home: try again once that’s done.")
        if ends == .stoppedPartWay {
            #expect(gone.how == .stopped)
            #expect(engineStarts == 1, "nothing started again as it went")
            OwnBoxMove.stopsAt = nil
            // The next keeper: the copies taken away, the box where it was.
            #expect(try await self.keeper(identity).settle() == .startOld)
            expectWhereItWas(identity)
        } else if moves {
            try await until { gone.how != nil }
            #expect(gone.how == .stopped, "gone for good, as launchd leaves it")
            try expectMoved(identity)
            #expect(KeeperFollower.record("serve.json") == nil && KeeperFollower.record("engine.json") == nil, "everything it ran stopped")
            #expect(engineStarts == 1)
        } else {
            // Its box stopped for the move and started again as it was, with nothing moved.
            try await until { engineStarts == 2 && KeeperFollower.record("engine.json") != nil }
            #expect(gone.how == nil)
            expectWhereItWas(identity)
            #expect(identity.did == ["copy", "helper check", "helper uncopy"])
        }
    }

    // MARK: A new Mac

    @Test func aNewMacsBoxIsMadeInItsOwnHomeWithNothingMovedAndItsHelperStartsIt() async throws {
        defer { done() }
        try newMac()
        let identity = Identity()
        let move = try keeper(identity)
        #expect(await move.makeNew())
        #expect((try? String(contentsOf: K.appending(path: "box/kind"), encoding: .utf8)) == "mac\n")
        #expect(exists(K.appending(path: "bin/kuvo-link.js")) && exists(K.appending(path: "engine/\(OpenCodeEngine.version)/opencode")))
        #expect(exists(BoxHelperBundle.executable(of: BoxHelperBundle.installed(in: K))))
        #expect(exists(home.appending(path: "Library/LaunchAgents/run.kuvo.code.machine.plist")))
        #expect(launchctlAsked.filter { $0.hasPrefix("bootstrap") }.count == 1)
        // Nothing moved, nor anything of the app's Keychain or launch agent touched.
        #expect(exists(appFolder.appending(path: "engine")) && exists(appFolder.appending(path: "box/machines.json")))
        #expect(identity.did.isEmpty)
        #expect(state.isEmpty, "no move")
        // Opened again: there already, and its helper's launch agent left as it is (switched off in
        // Login Items, it stays off).
        try FileManager.default.removeItem(at: tools.appending(path: "loaded"))
        #expect(await move.makeNew())
        #expect(launchctlAsked.filter { $0.hasPrefix("bootstrap") }.count == 1)
        // A keeper registered before (it never is for a box made there) finds it: it starts no box in
        // the app's folder, leaves the helper as it is, and retires.
        #expect(await move.settle() == .retire)
        #expect(launchctlAsked.filter { $0.hasPrefix("bootstrap") || $0.hasPrefix("kickstart") }.count == 1, "the helper switched off stays off")
        #expect(identity.did == ["unregister"])
        #expect(!exists(appFolder.appending(path: "box/run")))
    }

    @Test func aMacWhoseAppsBoxRanInItsFolderGetsNoNewBoxItMovesInstead() async throws {
        defer { done() }
        try ranInItsFolder()
        let move = try keeper(Identity())
        #expect(await move.makeNew() == false)
        #expect(!exists(K))
        // A 0.7 Mac, whose engine kept your sessions with no box of its own yet: the box says so.
        try FileManager.default.removeItem(at: appFolder.appending(path: "box/run"))
        try put("", appFolder.appending(path: "opencode/data/opencode/opencode.db"))
        #expect(await move.makeNew() == false)
        #expect(!exists(K.appending(path: "box/kind")))
    }

    // MARK: Flag off

    /// With `movesOwnBox` off (as it ships), none of it happens: the keeper has no move to run
    /// whatever the box's home says (Move Now asked, even a box there that says it's this Mac's),
    /// and the app registers its keeper as always.
    /// The app finding this Mac's box in its home stopped (Login Items let it be, but it ended): it's
    /// started again through its helper's launch agent, never by the app running its `kuvo-start`,
    /// which would make the app what macOS asks about, with no keys.
    @Test func theAppStartsAStoppedMacsBoxInItsHomeThroughItsHelper() async throws {
        let saved = (AppModel.hereHome, Here.environmentForTests)
        defer {
            (AppModel.hereHome, Here.environmentForTests) = saved
            Here.startTrouble = nil
            done()
        }
        try newMac()
        let move = try keeper(Identity())
        #expect(await move.makeNew())
        try FileManager.default.removeItem(at: tools.appending(path: "loaded"))
        // Its keeper, which only its helper runs: here it notes it ran.
        let ran = world.appending(path: "kuvo-start-ran")
        try executable("#!/bin/sh\ntouch '\(ran.path(percentEncoded: false))'\n", K.appending(path: "bin/kuvo-start"))
        AppModel.hereHome = home
        Here.environmentForTests = ["KUVO_TEST_UNINSTALL_TOOLS": tools.path(percentEncoded: false)]
        let bun = try #require(await move.engine())
        _ = await Here.started(engine: bun, script: try #require(BoxProcess.script), appBox: move.appBox, engineData: move.engineData, home: home)
        #expect(launchctlAsked.last?.hasPrefix("kickstart gui/") == true, "launchd asked to start its helper")
        #expect(!exists(ran), "never its keeper from the app")
        #expect(Here.startTrouble == nil)
        // Its helper gone from its bin: nothing started, and the app can say why, as the box does.
        try FileManager.default.moveItem(at: BoxHelperBundle.installed(in: K), to: world.appending(path: "helper-aside.app"))
        _ = await Here.started(engine: bun, script: try #require(BoxProcess.script), appBox: move.appBox, engineData: move.engineData, home: home)
        #expect(Here.startTrouble?.contains("isn't in this box's bin") == true)
        #expect(!exists(ran))
        try FileManager.default.moveItem(at: world.appending(path: "helper-aside.app"), to: BoxHelperBundle.installed(in: K))
        // A machine's box there (one you set up): as before, its own start.
        try put("machine\n", K.appending(path: "box/kind"))
        _ = await Here.started(engine: bun, script: try #require(BoxProcess.script), appBox: move.appBox, engineData: move.engineData, home: home)
        #expect(exists(ran))
    }

    /// A keeper finding a new Mac's box in its home, whose box doesn't answer once (busy, say): asked
    /// again a moment later, it retires rather than waiting ten minutes with no box running.
    @Test func aKeeperAsksAgainSoonWhenTheBoxDoesntSayItsMade() async throws {
        let realPause = OwnBoxMove.pause
        var paused = 0
        OwnBoxMove.pause = { _ in paused += 1 }
        defer {
            OwnBoxMove.pause = realPause
            done()
        }
        try newMac()
        let identity = Identity()
        let move = try keeper(identity)
        #expect(await move.makeNew())
        // Its engine fails the first time it's asked whether the box is made.
        var asked = 0
        let flaky = OwnBoxMove(root: move.root, home: move.home, appBox: move.appBox, engineData: move.engineData, engine: {
            asked += 1
            return asked == 2 ? URL(filePath: "/usr/bin/false") : await move.engine()
        }, script: move.script, appID: move.appID, appVersion: move.appVersion, keepsAwakeOff: move.keepsAwakeOff, identity: identity.stands, release: move.release)
        flaky.environment = move.environment
        #expect(await flaky.settle() == .retire)
        #expect(paused == 1)
        #expect(identity.did == ["unregister"])
    }

    /// A move stopped part way: the app, with no keeper to say so, hears it from the box.
    @Test func aMoveStoppedPartWayIsSaidAsMovingNotFailing() async throws {
        defer { done() }
        try ranInItsFolder()
        let identity = Identity()
        #expect(try await keeper(identity).movingNow() == nil)
        OwnBoxMove.stopsAt = .moved
        #expect(try await keeper(identity, environment: ["KUVO_TEST_REHOME_STOP": "in-clear"]).moveNow() == .wait)
        OwnBoxMove.stopsAt = nil
        #expect(try await keeper(identity).movingNow() == "")
    }

    private static func reach(keeper record: KeeperRecord?) throws {
        let record = try #require(record, "the keeper recorded itself")
        StubWeb.letThrough(port: URL(string: record.url)?.port ?? 0)
    }

    @Test func withTheFlagOffNothingChanges() async throws {
        let saved = (AppModel.movesOwnBox, AppModel.hereHome, BackgroundWork.status, BackgroundWork.asUsersCopy, BackgroundWork.registering)
        defer {
            (AppModel.movesOwnBox, AppModel.hereHome, BackgroundWork.status, BackgroundWork.asUsersCopy, BackgroundWork.registering) = saved
            BackgroundWork.heldBack = nil
            BackgroundWork.boxStartsOnItsOwn = false
            OwnBoxHome.recheck()
            done()
        }
        AppModel.hereHome = home
        try newMac()
        try put(#"{"state":"waiting","asked":"now"}"#, K.appending(path: "updates/rehome/state.json"))
        try put("mac\n", K.appending(path: "box/kind"))
        BackgroundWork.boxStartsOnItsOwn = false
        var registered = 0
        BackgroundWork.status = { .notRegistered }
        BackgroundWork.asUsersCopy = true
        BackgroundWork.registering = { registered += 1 }
        BackgroundWork.heldBack = nil

        AppModel.movesOwnBox = false
        OwnBoxHome.recheck()
        #expect(OwnBoxMove.forThisMac() == nil, "no keeper has a move to run")
        #expect(!OwnBoxHome.hasMoved && !BackgroundWork.boxStartsOnItsOwn)
        BackgroundWork().register()
        #expect(registered == 1, "the keeper's registered as always")

        // On, the box in its home says it's this Mac's as the app opens: no keeper is registered
        // beside its helper.
        AppModel.movesOwnBox = true
        OwnBoxHome.recheck()
        #expect(OwnBoxMove.forThisMac() != nil)
        // (Made by the box as the app opens: the flag-off half's stand-in for one taken away first.)
        try FileManager.default.removeItem(at: K.appending(path: "updates/rehome/state.json"))
        try FileManager.default.removeItem(at: K.appending(path: "box/kind"))
        #expect(try await keeper(Identity()).makeNew())
        #expect(BackgroundWork.boxStartsOnItsOwn)
        let work = BackgroundWork()
        #expect(!work.register())
        #expect(registered == 1, "nothing registered once moved")
        #expect(work.failure == "This Mac’s box starts on its own, with Kuvo Code Box.")
    }
}

extension OwnBoxMove {
    /// The move as the keeper runs it: its files made once the box says it's time, then the move
    /// (the box stopped first, by the keeper; here none runs). `startOld` when it isn't time.
    func moveNow() async -> Next {
        guard let release = await due() else { return .startOld }
        return await move(release)
    }
}
