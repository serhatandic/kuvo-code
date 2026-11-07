import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The engine, the coding agents' bridge or the box itself couldn't start, or keeps stopping: this
/// Mac's box goes on trying by itself for good, waiting longer each time up to ten minutes, and says
/// so meanwhile with Try Again still there. What can't change (a program that isn't there) isn't tried
/// again; what you ask for happens at once, and what you stopped stays stopped. The servers are stand-ins (a
/// script, run as the real ones are) that really fail, stop and hang; waits move on as a test says.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct FailedStartRetryTests {
    let engine = StubEngine(port: 47931)
    let folder = AppInfo.testRoot.appending(path: "Retry-\(UUID().uuidString.prefix(6))")
    var folderPath: String { folder.path(percentEncoded: false) }
    var startsFolder: String { folder.appending(path: "starts").path(percentEncoded: false) }
    /// While it's there, the stand-in fails as it starts (with `failure`'s words).
    var failsFile: String { folder.appending(path: "fails").path(percentEncoded: false) }
    /// How many times it was started.
    var starts: Int { ((try? FileManager.default.contentsOfDirectory(atPath: startsFolder)) ?? []).count }
    /// Each start told to `until`, by the file it leaves.
    let watch = FolderBeat()

    nonisolated final class FolderBeat: @unchecked Sendable {
        private var source: DispatchSourceFileSystemObject?

        func start(_ path: String) {
            let folder = open(path, O_EVTONLY)
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: folder, eventMask: .write, queue: .main)
            source.setEventHandler { TestPulse.beat() }
            source.setCancelHandler { close(folder) }
            source.resume()
            self.source = source
        }

        deinit { source?.cancel() }
    }

    enum Failure {
        /// Stops as it starts, saying why.
        case exits
        /// Never says where it listens, and takes no notice of being told to stop.
        case hangs
        /// Never says where it listens, and goes as soon as it's told.
        case holds
        /// Never says where it listens, and when it's told to stop, goes only once `letGoFile` is there.
        case slowToStop
    }

    /// Run as the engine is, or as the bridge is (`bridge`: otherwise it's the engine, and what's
    /// run as the bridge and the box stops at once): `failure` for as long as `failsFile` is there,
    /// then it says where it answers (the stub) and runs on.
    private func standIn(_ failure: Failure = .exits, bridge: Bool = false, box node: URL? = nil) throws -> URL {
        try FileManager.default.createDirectory(atPath: startsFolder, withIntermediateDirectories: true)
        watch.start(startsFolder)
        FileManager.default.createFile(atPath: failsFile, contents: nil)
        let fail = switch failure {
        case .exits: "echo 'Error: the database is locked' >&2; exit 3"
        case .hangs: "trap '' TERM; while [ -d '\(folderPath)' ]; do sleep 0.05; done; exit 0"
        case .holds: "while [ -d '\(folderPath)' ]; do sleep 0.05; done; exit 0"
        case .slowToStop: "trap '' TERM; while [ ! -e '\(letGoFile)' ]; do sleep 0.05; done; exit 0"
        }
        let script = """
            #!/bin/sh
            \(node.map { "case \"$4\" in *kuvo-link.js) shift 3; exec '\($0.path(percentEncoded: false))' \"$@\";; esac" } ?? "")
            \(bridge ? "" : "[ \"$1\" = \"run\" ] && exit 1")
            : > '\(startsFolder)/'$$
            if [ -e '\(failsFile)' ]; then \(fail); fi
            echo '{"url":"\(engine.url)"}'
            while [ -d '\(folderPath)' ]; do sleep 0.05; done
            """
        let file = folder.appending(path: "opencode")
        try script.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path(percentEncoded: false))
        engine.on("GET", "/api/info", json: ["version": OpenCodeEngine.version, "pid": 1])
        return file
    }

    private func letItStart() { try? FileManager.default.removeItem(atPath: failsFile) }

    var letGoFile: String { folder.appending(path: "let-go").path(percentEncoded: false) }

    /// The stand-ins started so far, by their process numbers.
    private var started: [Int32] { ((try? FileManager.default.contentsOfDirectory(atPath: startsFolder)) ?? []).compactMap { Int32($0) } }

    private func isGone(_ process: Int32) async throws {
        while kill(process, 0) == 0 { try await Task.sleep(for: .milliseconds(20)) }
    }

    /// Waits as a test says: each wait asked for is told to `asked`, and goes on once the test lets it.
    @MainActor final class TestClock {
        private(set) var asked: [Int] = []
        /// Waits that are over, and what comes straight after them done: nothing of that is still to come.
        private(set) var passed = 0
        private var waiting: [CheckedContinuation<Void, Never>] = []

        var wait: (Int) async -> Void {
            { [self] seconds in
                await withCheckedContinuation { continuation in
                    asked.append(seconds)
                    waiting.append(continuation)
                    TestPulse.beat()
                }
                Task { @MainActor in
                    self.passed += 1
                    TestPulse.beat()
                }
            }
        }

        var isWaiting: Bool { !waiting.isEmpty }

        func goOn() {
            let them = waiting
            waiting = []
            for continuation in them { continuation.resume() }
        }
    }

    private var bridgeArguments: [String: String] { ["PATH": "/usr/bin:/bin", "HOME": folderPath] }

    private func cleanUp() {
        unsetenv("KUVO_OPENCODE_BINARY")
        try? FileManager.default.removeItem(at: folder)
        BoxProcess.forgetEngineStopped()
        engine.stop()
    }

    private func engineReason(_ state: MacBoxRunner.Engine) -> String? {
        if case .failed(let reason) = state { reason } else { nil }
    }

    // MARK: The engine

    /// It fails as it starts, a few times: the window says why and that it's trying again, with Try
    /// Again there; then it's up, and the window connects by itself.
    @Test func anEngineThatFailsToStartIsTriedAgainAndTheWindowComesBackByItself() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        let clock = TestClock()
        app.ownBox.retries.clock = clock.wait
        defer {
            clock.goOn()
            app.stop()
            app.stopBox()
            cleanUp()
        }
        engine.list([StubEngine.session("ses_back", title: "Back by itself", directory: "/tmp/kuvo-tests-retry")])
        await app.start()
        guard case .failed(let reason) = app.engine else {
            Issue.record("the window says \(app.engine)")
            return
        }
        #expect(reason.contains(StartRetries.note), "it says it's trying again: \(reason)")
        #expect(reason.contains("the database is locked"), "with what the engine wrote: \(reason)")
        #expect(FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "engine.retry").path(percentEncoded: false)), "and a phone hears the same")

        // Tried again, still failing: a longer wait.
        try await until { clock.isWaiting }
        clock.goOn()
        try await until { clock.asked.count == 2 }
        #expect(clock.asked == [15, 30])
        #expect(starts == 2)

        // It can start now: up, the window connected, with nothing asked of you.
        letItStart()
        clock.goOn()
        try await until { app.engine == .ready && app.workspace.session("ses_back") != nil }
        #expect(starts == 3)
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "engine.retry").path(percentEncoded: false)))
    }

    /// It never starts: tried with longer and longer waits, then every ten minutes for good, saying
    /// so each time, as a machine's keeper goes on. Try Again still starts it at once.
    @Test func anEngineThatNeverStartsGoesOnTryingAndTryAgainStillWorks() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        let tries = StartRetries.waits.count + 3
        for tried in 1...tries {
            try await until { clock.asked.count == tried && clock.isWaiting && engineReason(keeper.engine) != nil }
            #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == true)
            #expect(FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "engine.retry").path(percentEncoded: false)))
            clock.goOn()
            try await until { starts == tried + 1 }
        }
        try await until { clock.asked.count == tries + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [600, 600, 600, 600])

        let after = starts
        letItStart()
        keeper.restartEngine()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == after + 1)
    }

    /// It starts and stops again and again: at once a few times, then with the waits of one that
    /// won't start, which don't begin again just because it came up for a moment; never left down.
    @Test func anEngineThatKeepsStoppingGoesOnTrying() async throws {
        let binary = try standIn()
        letItStart()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        let isUp = { if case .ready = keeper.engine { true } else { false } }
        await keeper.start()
        for restarted in 1...3 {
            try await until { isUp() && starts == restarted }
            for process in started { kill(process, SIGKILL) }
            try await until { starts == restarted + 1 }
        }
        // (It's among the waits now: no more at once until it has run as it should, however long
        // those waits make its stops apart.)
        for tried in 1...3 {
            try await until { isUp() }
            for process in started { kill(process, SIGKILL) }
            try await until { clock.asked.count == tried && clock.isWaiting }
            #expect(engineReason(keeper.engine)?.contains("again after starting over") == true)
            #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == true)
            clock.goOn()
        }
        try await until { isUp() }
        #expect(clock.asked == [15, 30, 60])
    }

    /// One held up as it starts, taking no notice of being stopped: given up on when its time is up,
    /// and tried again like any other.
    @Test func anEngineHeldUpAsItStartsIsTriedAgain() async throws {
        let binary = try standIn(.hangs)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.startTimeout = .milliseconds(300)
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == true, "\(keeper.engine)")
        keeper.startTimeout = .seconds(60)
        letItStart()
        clock.goOn()
        try await until { if case .ready = keeper.engine { true } else { false } }
    }

    /// A try that took too long while macOS asked: past the usual waits it comes back only every
    /// hour, so a question nobody's there to answer doesn't keep coming back all night.
    @Test func aTryHeldUpWhileMacOSAsksSlowsDown() async throws {
        let binary = try standIn(.holds)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.startTimeout = .milliseconds(200)
        keeper.asking.isOpen = { true }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        for tried in 1...StartRetries.waits.count + 1 {
            try await until { clock.asked.count == tried && clock.isWaiting }
            clock.goOn()
        }
        try await until { clock.asked.count == StartRetries.waits.count + 2 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [StartRetries.askedWait, StartRetries.askedWait])
        #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == true, "never no more tries")
        #expect(engineReason(keeper.engine)?.contains(StartRetries.askedNote) == true, "and what someone coming back can do")
    }

    /// A question left open is answered during the wait: the next try is now, not when the wait's
    /// over, and it gets through (macOS remembers an answer, which is what `letItStart` stands for).
    @Test func answeringWhatMacOSAsksBringsItBackAtOnce() async throws {
        let binary = try standIn(.holds)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.startTimeout = .milliseconds(200)
        var open = true
        keeper.asking.isOpen = { open }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        let tried = clock.asked.count
        keeper.startTimeout = .seconds(60)
        keeper.asking.look()
        keeper.asking.look()
        letItStart()
        open = false
        keeper.asking.look()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == 2)
        #expect(clock.asked.count == tried, "without its wait running out")
    }

    /// A question that went with the server told to go isn't an answer: no try for that, so it isn't
    /// raised again at once. The next try, when its wait is over, is what can bring it back, and an
    /// answer to that one lets it through.
    @Test func aQuestionGoneWithItsServerIsNoAnswerAndTheNextTryStillRecovers() async throws {
        let binary = try standIn(.holds)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.startTimeout = .milliseconds(200)
        var open = true
        keeper.asking.isOpen = { open }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        open = false
        keeper.asking.look()
        #expect(keeper.retries.isWaiting, "still waiting its turn")
        #expect(starts == 1)
        keeper.startTimeout = .seconds(60)
        letItStart()
        clock.goOn()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == 2)
    }

    /// A start that fails by itself isn't held up by whatever macOS is asking: the usual waits.
    @Test func aStartThatFailsWhileMacOSAsksKeepsTheUsualWaits() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.asking.isOpen = { true }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        for tried in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tried && clock.isWaiting }
            clock.goOn()
        }
        try await until { clock.asked.count == StartRetries.waits.count + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [600])
    }

    /// The box's watch for hung servers holds off while macOS asks you something, as only this side
    /// can see, and nothing's left saying so.
    @Test func theBoxsWatchIsToldWhileMacOSAsks() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.asking.isOpen = { true }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        keeper.onEngine = { _ in TestPulse.beat() }
        let asking = BoxProcess.run.appending(path: ".system-asking").path(percentEncoded: false)
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        #expect(FileManager.default.fileExists(atPath: asking))
        keeper.stop()
        #expect(!FileManager.default.fileExists(atPath: asking))
    }

    /// Restart while a start is held up: it starts now, and the one held up is gone.
    @Test func aRestartDuringAHeldUpEngineStartStartsItAtOnce() async throws {
        let binary = try standIn(.holds)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        defer {
            keeper.stop()
            cleanUp()
        }
        let first = Task { await keeper.start() }
        try await until { starts == 1 }
        let heldUp = try #require(started.first)
        letItStart()
        keeper.restartEngine()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == 2)
        try await isGone(heldUp)
        await first.value
        if case .ready = keeper.engine {} else { Issue.record("it took it with it: \(keeper.engine)") }
    }

    /// Stopped while a start is held up: it's gone at once, and nothing starts later.
    @Test func aStopDuringAHeldUpEngineStartStaysStopped() async throws {
        let binary = try standIn(.holds)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            keeper.stop()
            cleanUp()
        }
        let first = Task { await keeper.start() }
        try await until { starts == 1 }
        let heldUp = try #require(started.first)
        keeper.stopEngine()
        try await isGone(heldUp)
        await first.value
        #expect(clock.asked.isEmpty, "nor is it tried again")
        #expect(keeper.server == nil)
        #expect(starts == 1)
    }

    /// As on a real Mac, where the keeper runs the box and the app follows it: the window says why and
    /// that it's trying again, and connects by itself once the keeper has it up.
    @Test func theWindowFollowingTheKeeperSaysItsTryingAndComesBackByItself() async throws {
        let binary = try standIn(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        setenv("KUVO_KEEPER", "follow", 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        let app = AppModel()
        defer {
            clock.goOn()
            app.stop()
            app.stopBox()
            keeper.stop()
            KeeperRecord.forget(pid: getpid())
            unsetenv("KUVO_KEEPER")
            cleanUp()
        }
        engine.list([StubEngine.session("ses_follow", title: "Followed", directory: "/tmp/kuvo-tests-retry")])
        try KeeperRecord(pid: getpid(), version: AppInfo.version, build: AppInfo.build, url: "http://127.0.0.1:9", password: "x", started: 0).write()
        await keeper.start()
        try await until { clock.isWaiting }
        await app.start()
        guard case .failed(let shown) = app.engine else {
            Issue.record("the window says \(app.engine)")
            return
        }
        #expect(shown.contains(StartRetries.note), "\(shown)")
        letItStart()
        clock.goOn()
        try await until { app.engine == .ready && app.workspace.session("ses_follow") != nil }
    }

    /// Tried again by itself and downloading the engine: the window shows that, not the failure
    /// before it with a Try Again that would download beside it. Failing again, it says so.
    @Test func aRetryThatDownloadsShowsItsProgress() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let app = AppModel()
        let clock = TestClock()
        app.ownBox.retries.clock = clock.wait
        defer {
            clock.goOn()
            app.stop()
            app.stopBox()
            cleanUp()
        }
        await app.start()
        app.ownBox.onEngine(.downloading(progress: 0.5))
        #expect(app.engine == .downloading(progress: 0.5))
        app.ownBox.onEngine(.starting)
        #expect(app.engine == .starting)
        app.ownBox.onEngine(.failed("It still can't."))
        #expect(app.engine == .failed("It still can't."))
    }

    /// A program that isn't there fails the same way each time: said at once, never tried again.
    @Test func anEngineThatIsntThereIsNotTriedAgain() async throws {
        setenv("KUVO_OPENCODE_BINARY", folder.appending(path: "gone").path(percentEncoded: false), 1)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        #expect(engineReason(keeper.engine) != nil, "\(keeper.engine)")
        #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == false)
        #expect(clock.asked.isEmpty)
    }

    /// Try Again while a try waits its turn starts it now, once: the try that was waiting never
    /// starts another beside it.
    @Test func tryAgainDuringAWaitStartsItOnce() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        letItStart()
        keeper.restartEngine()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == 2)
        let endpoint = keeper.server?.endpoint
        // Its wait over, the try that was waiting finds it was called off.
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(starts == 2, "no second engine")
        #expect(keeper.engine == endpoint.map { .ready($0) }, "\(keeper.engine)")
    }

    /// You stop it while a try waits its turn: it stays stopped.
    @Test func aStopDuringAWaitStaysStopped() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        keeper.stop()
        letItStart()
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(starts == 1, "never started again")
        #expect(engineReason(keeper.engine) != nil, "nor starting: \(keeper.engine)")
        #expect(keeper.server == nil)
    }

    /// A phone asking this Mac's box hears why, and that it's being tried again, for as long as it is;
    /// and of one no try can help, what starts it.
    @Test func aPhoneHearsThisMacsEngineIsBeingTriedAgain() async throws {
        let binary = try standIn(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        let box = try #require(keeper.box.endpoint, "this Mac's box runs on")
        let said = try await asked("api/session", of: box)
        #expect(said.contains("This Mac's engine isn't running. The engine stopped (exit code 3). \(StartRetries.note)"), "\(said)")
        #expect(!said.contains("Try Again in Kuvo Code"), "\(said)")

        // Past the waits, the same.
        clock.goOn()
        for tried in 2...StartRetries.waits.count + 1 {
            try await until { clock.asked.count == tried && clock.isWaiting }
            clock.goOn()
        }
        try await until { clock.asked.count == StartRetries.waits.count + 2 && clock.isWaiting }
        let later = try await asked("api/session", of: box)
        #expect(later.contains("isn't running. The engine stopped (exit code 3). \(StartRetries.note)"), "\(later)")

        // No try can help it (what the app says of a download refused): only why, and what starts it.
        keeper.stopEngine()
        BoxProcess.engineGaveUp("It can't be run.")
        let after = try await asked("api/session", of: box)
        #expect(after.contains("This Mac's engine isn't running. It can't be run. Try Again in Kuvo Code on the Mac starts it."), "\(after)")
        #expect(!after.contains(StartRetries.note), "\(after)")
    }

    /// What this Mac's box answers, as a phone reads it.
    private func asked(_ route: String, of box: ServerEndpoint) async throws -> String {
        var request = URLRequest(url: try #require(URL(string: route, relativeTo: box.url)))
        if let password = box.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        let (body, _) = try await URLSession(configuration: .ephemeral).data(for: request)
        return String(decoding: body, as: UTF8.self)
    }

    /// You stop the engine while a try waits: a phone isn't told it's being tried.
    @Test func aPhoneIsntToldItsTriedOnceItsStopped() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retries.clock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        keeper.stopEngine()
        for name in ["engine.retry", "engine-stopped"] {
            #expect(!FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: name).path(percentEncoded: false)), "\(name)")
        }
    }

    /// What another try can change, and what it can't.
    @Test func whatATryCanHelp() {
        #expect(StartRetries.canHelp(ServerProcessError.exited(status: 1, output: "")))
        #expect(StartRetries.canHelp(ServerProcessError.timedOut))
        #expect(StartRetries.canHelp(URLError(.notConnectedToInternet)))
        #expect(!StartRetries.canHelp(URLError(.cancelled)))
        #expect(!StartRetries.canHelp(URLError(.secureConnectionFailed)))
        #expect(StartRetries.canHelp(EngineInstallError.serverAnswered(503)))
        #expect(!StartRetries.canHelp(EngineInstallError.serverAnswered(404)))
        #expect(!StartRetries.canHelp(CocoaError(.fileNoSuchFile)))
        #expect(!StartRetries.canHelp(POSIXError(.EACCES)))
        #expect(StartRetries.canHelp(POSIXError(.EAGAIN)), "the Mac is short of something for now")
        #expect(!StartRetries.canHelp(POSIXError(.EBADARCH)))
    }

    /// When a question counts as answered, which brings a try on at once: seen open on looks of its
    /// own since the last held try ended, whichever server's that was. One that goes with the server
    /// told to go is no answer, or the servers' questions would chain all night.
    @Test func whenAQuestionCountsAsAnswered() async throws {
        let asking = SystemAsking()
        var open = true
        asking.isOpen = { open }
        let clock = TestClock()
        let waiting = StartRetries(), held = StartRetries()
        waiting.asking = asking
        waiting.clock = clock.wait
        held.asking = asking
        var went = 0
        waiting.schedule(after: StartRetries.askedWait, orAnswered: true) { went += 1 }
        defer { clock.goOn() }

        // Seen once, and gone.
        asking.look()
        open = false
        asking.look()
        #expect(waiting.isWaiting)

        // Another server's try held by it for a while, ended, and it goes with that server.
        open = true
        let began = ContinuousClock.now
        for _ in 1...4 { asking.look() }
        #expect(held.wasAsked(ServerProcessError.timedOut, since: began))
        open = false
        asking.look()
        #expect(waiting.isWaiting)

        // The same, gone before anyone hears that try ended.
        open = true
        let beganAgain = ContinuousClock.now
        for _ in 1...4 { asking.look() }
        open = false
        #expect(held.wasAsked(ServerProcessError.timedOut, since: beganAgain))
        #expect(waiting.isWaiting)

        // It's still there after that, and it closes: someone answered.
        open = true
        asking.look()
        asking.look()
        open = false
        asking.look()
        try await until { went == 1 }
        #expect(!waiting.isWaiting)
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(went == 1, "once")
    }

    /// Answered quickly, between looks, it's never seen closing: the server it held coming up is
    /// what says so, and brings on the others waiting.
    @Test func aServerComingUpAfterAQuestionBringsTheOthersOn() async throws {
        let asking = SystemAsking()
        asking.isOpen = { true }
        let clock = TestClock()
        let waiting = StartRetries(), held = StartRetries()
        waiting.asking = asking
        waiting.clock = clock.wait
        held.asking = asking
        var went = false
        waiting.schedule(after: StartRetries.askedWait, orAnswered: true) { went = true; TestPulse.beat() }
        defer { clock.goOn() }
        let beforeAsked = ContinuousClock.now
        held.cameUp(since: beforeAsked)
        #expect(waiting.isWaiting, "nothing was seen open")
        asking.look()
        held.cameUp(since: beforeAsked)
        try await until { went }
    }

    /// Its last try was held up, and this one came up with no question seen: answered between looks.
    @Test func aQuestionAnsweredBetweenLooksStillBringsTheOthersOn() async throws {
        let asking = SystemAsking()
        var open = true
        asking.isOpen = { open }
        let clock = TestClock()
        let waiting = StartRetries(), held = StartRetries()
        waiting.asking = asking
        waiting.clock = clock.wait
        held.asking = asking
        defer { clock.goOn() }
        #expect(held.wasAsked(ServerProcessError.timedOut, since: .now))
        var went = false
        waiting.schedule(after: StartRetries.askedWait, orAnswered: true) { went = true; TestPulse.beat() }
        open = false
        held.cameUp(since: .now)
        try await until { went }
    }

    /// Whether a try was held by a question: it took too long, with one open while it tried, even if
    /// that went with it before anyone could look again.
    @Test func whatCountsAsHeldByAQuestion() {
        let asking = SystemAsking()
        var open = false
        asking.isOpen = { open }
        let retries = StartRetries()
        retries.asking = asking
        let began = ContinuousClock.now
        #expect(!retries.wasAsked(ServerProcessError.timedOut, since: began), "none open")
        open = true
        asking.look()
        open = false
        #expect(retries.wasAsked(ServerProcessError.timedOut, since: began))
        #expect(retries.wasAsked(URLError(.timedOut), since: began))
        #expect(!retries.wasAsked(ServerProcessError.exited(status: 1, output: ""), since: began), "failed by itself")
        #expect(!retries.wasAsked(ServerProcessError.timedOut, since: .now), "open before this try")
    }

    /// How long each try waits: the longest for good; an hour instead, past the usual waits, for one
    /// held up by macOS asking; and from the start again only after it ran as it should, or you asked.
    @Test func howLongATryWaits() {
        let retries = StartRetries()
        #expect(StartRetries.waits.map { _ in retries.next(asked: true) } == StartRetries.waits, "as ever, while someone may be there")
        #expect(retries.next() == 600)
        #expect(retries.next() == 600)
        #expect(retries.next(asked: true) == StartRetries.askedWait)
        #expect(retries.next() == 600, "one that isn't asked goes back")
        retries.stopped(ranFor: 60)
        #expect(retries.next() == 600, "up for a moment isn't running")
        retries.stopped(ranFor: StartRetries.steadyAfter)
        #expect(retries.next() == 15)
        #expect(retries.next() == 30)
        retries.reset()
        #expect(retries.next() == 15)
    }

    /// Its note is a sentence of its own, before what the server wrote.
    @Test func whatItSaysWhileTrying() {
        #expect(StartRetries.noted("It stopped.\n\nwhat it wrote") == "It stopped. \(StartRetries.note)\n\nwhat it wrote")
        #expect(StartRetries.noted("service unavailable") == "service unavailable. \(StartRetries.note)")
        #expect(StartRetries.noted("It took too long.", asked: true) == "It took too long. \(StartRetries.askedNote) \(StartRetries.note)")
    }

    // MARK: The bridge

    private func bridge(clock: TestClock) -> OutsideAgents {
        let agents = OutsideAgents()
        agents.home = folder.appending(path: "agents")
        agents.retries.clock = clock.wait
        return agents
    }

    /// It fails as it starts: it says why and that it's trying again, and comes up by itself. What
    /// it said goes.
    @Test func aBridgeThatFailsToStartIsTriedAgain() async throws {
        let binary = try standIn(bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        #expect(agents.failure?.contains(StartRetries.note) == true, "\(agents.failure ?? "")")
        #expect(agents.failure?.contains("engine") == false, "the engine may be fine: \(agents.failure ?? "")")
        try await until { clock.isWaiting }
        clock.goOn()
        try await until { clock.asked.count == 2 }
        #expect(clock.asked == [15, 30])
        letItStart()
        clock.goOn()
        try await until { agents.api != nil }
        #expect(agents.failure == nil)
        #expect(starts == 3)
    }

    /// It never starts: tried for good, saying so. Restart still starts it at once.
    @Test func aBridgeThatNeverStartsGoesOnTryingAndRestartStillWorks() async throws {
        let binary = try standIn(bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        let tries = StartRetries.waits.count + 2
        for tried in 1...tries {
            try await until { clock.asked.count == tried && clock.isWaiting }
            #expect(agents.failure?.contains(StartRetries.note) == true, "\(agents.failure ?? "")")
            clock.goOn()
            try await until { starts == tried + 1 }
        }
        try await until { clock.asked.count == tries + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [600, 600, 600])
        #expect(agents.failure?.contains("exit code 3") == true, "\(agents.failure ?? "")")

        letItStart()
        await agents.startAgain()
        #expect(agents.api != nil)
        #expect(agents.failure == nil)
    }

    /// Restart during a start that's held up, or a wait: it starts now and once. Stopped during a
    /// wait or a held-up start, nothing starts later.
    @Test func restartAndStopTakeEffectWhateverTheBridgeIsDoingByItself() async throws {
        let binary = try standIn(.hangs, bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        // Held up: Restart doesn't wait for its minute to pass.
        let heldUp = Task { await agents.start(engine: binary, environment: bridgeArguments) }
        try await until { starts == 1 }
        letItStart()
        await agents.startAgain()
        #expect(agents.api != nil, "started at once: \(agents.failure ?? "")")
        #expect(starts == 2)
        await heldUp.value
        #expect(agents.api != nil, "the one held up took nothing with it")

        // Stopped while a start's held up: it stays stopped.
        agents.stop()
        FileManager.default.createFile(atPath: failsFile, contents: nil)
        let again = Task { await agents.start(engine: binary, environment: bridgeArguments) }
        try await until { starts == 3 }
        agents.stop()
        letItStart()
        await again.value
        #expect(agents.api == nil, "nothing came up after the stop")
        #expect(clock.asked.isEmpty, "nor is it tried again")
    }

    /// One held up as it starts is slow to go after a Restart: its going, long after the new one came
    /// up, says nothing of that one, which carries on untouched.
    @Test func aHeldUpBridgeGoingLaterLeavesTheNewOneAlone() async throws {
        let binary = try standIn(.slowToStop, bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        let heldUp = Task { await agents.start(engine: binary, environment: bridgeArguments) }
        try await until { starts == 1 }
        let old = try #require(started.first)
        var heard = false
        agents.onExitHeard = {
            heard = true
            TestPulse.beat()
        }
        letItStart()
        await agents.startAgain()
        let running = agents.processID
        #expect(running != nil)
        await heldUp.value

        FileManager.default.createFile(atPath: letGoFile, contents: nil)
        try await isGone(old)
        try await until { heard }
        #expect(agents.processID == running, "the new one was stopped for it")
        #expect(starts == 2)
    }

    /// The window's Try Again and Settings' Restart bring back a bridge that's down too, not only
    /// the engine: many have no other Restart for it.
    @Test func restartingTheEngineBringsBackABridgeThatsDown() async throws {
        let binary = try standIn(bridge: true)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: agents, host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        try await until { clock.isWaiting }
        letItStart()
        keeper.restartEngine()
        try await until { agents.api != nil }
        #expect(agents.failure == nil)
    }

    /// It starts and stops again and again: at once a few times, then with the waits; never left down.
    @Test func aBridgeThatKeepsStoppingGoesOnTrying() async throws {
        let binary = try standIn(bridge: true)
        letItStart()
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        var heard = 0
        agents.onExitHeard = { heard += 1; TestPulse.beat() }
        for restarted in 1...3 {
            try await until { agents.api != nil && starts == restarted }
            for process in started { kill(process, SIGKILL) }
            try await until { heard == restarted && starts == restarted + 1 }
        }
        for tried in 1...2 {
            try await until { agents.api != nil }
            for process in started { kill(process, SIGKILL) }
            try await until { clock.asked.count == tried && clock.isWaiting }
            #expect(agents.failure?.contains(StartRetries.note) == true, "\(agents.failure ?? "")")
            clock.goOn()
        }
        try await until { agents.api != nil }
        #expect(clock.asked == [15, 30])
        #expect(agents.failure == nil)
    }

    /// A try held up while macOS asks slows down past the usual waits, as the engine's does, and an
    /// answer brings it back at once.
    @Test func aBridgeHeldUpWhileMacOSAsksSlowsDownAndAnAnswerBringsItBack() async throws {
        let binary = try standIn(.holds, bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        let asking = SystemAsking()
        var open = true
        asking.isOpen = { open }
        agents.retries.asking = asking
        agents.startTimeout = .milliseconds(200)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        for tried in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tried && clock.isWaiting }
            clock.goOn()
        }
        try await until { clock.asked.count == StartRetries.waits.count + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [StartRetries.askedWait])
        agents.startTimeout = .seconds(60)
        letItStart()
        asking.look()
        asking.look()
        open = false
        asking.look()
        try await until { agents.api != nil }
        #expect(clock.asked.count == StartRetries.waits.count + 1)
    }

    /// What a phone asking this Mac's box hears of a bridge that's down: why, and that it's being
    /// tried; of one no try can help, what starts it, never that it's starting.
    @Test func aPhoneHearsWhyThisMacsAgentsArentRunning() async throws {
        let binary = try standIn(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        letItStart()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: agents, host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        // (What's run as the bridge stops at once, for this stand-in.)
        try await until { clock.isWaiting && keeper.box.endpoint != nil }
        let box = try #require(keeper.box.endpoint)
        for route in ["kuvo/groups", "kuvo/artifacts", "kuvo/agents/api/session"] {
            let said = try await asked(route, of: box)
            #expect(said.contains("This Mac's coding agents aren't running. It stopped (exit code 1). \(StartRetries.note)"), "\(route): \(said)")
        }
        agents.stop()
        await agents.start(engine: folder.appending(path: "gone"), environment: [:])
        #expect(agents.failure?.contains(StartRetries.note) == false, "\(agents.failure ?? "")")
        for route in ["kuvo/groups", "kuvo/artifacts", "kuvo/agents/api/session"] {
            let said = try await asked(route, of: box)
            #expect(said.contains("This Mac's coding agents aren't running."), "\(route): \(said)")
            #expect(said.contains("Restart them in Kuvo Code on the Mac."), "\(route): \(said)")
            #expect(!said.contains("starting") && !said.contains(StartRetries.note), "\(route): \(said)")
        }
        agents.stop()
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "agents-stopped").path(percentEncoded: false)), "nothing left saying so")
    }

    // MARK: The box

    private func boxStandIn(clock: TestClock, _ failure: Failure = .exits) throws -> (BoxProcess, URL) {
        let binary = try standIn(failure, bridge: true)
        let box = BoxProcess()
        box.retries.clock = clock.wait
        return (box, binary)
    }

    /// It fails as it starts: it says why and that it's trying again, for good, and comes up by itself.
    @Test func aBoxThatFailsToStartGoesOnTryingAndComesUpByItself() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        let tries = StartRetries.waits.count + 2
        for tried in 1...tries {
            try await until { clock.asked.count == tried && clock.isWaiting }
            #expect(box.failure?.contains(StartRetries.note) == true, "\(box.failure ?? "")")
            #expect(box.failure?.contains("engine") == false, "the engine may be fine: \(box.failure ?? "")")
            clock.goOn()
            try await until { starts == tried + 1 }
        }
        try await until { clock.asked.count == tries + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [600, 600, 600])
        letItStart()
        clock.goOn()
        try await until { box.endpoint != nil }
        #expect(box.failure == nil)
    }

    /// Try Again while a try waits starts it now, once: the try that was waiting never starts another.
    @Test func tryAgainStartsABoxAtOnce() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        try await until { clock.isWaiting }
        letItStart()
        await box.startAgain()
        #expect(box.endpoint != nil)
        #expect(box.failure == nil)
        #expect(starts == 2)
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(starts == 2)
    }

    /// Try Again while a start is held up: it starts now, and the one held up is gone.
    @Test func tryAgainDuringAHeldUpBoxStartStartsItAtOnce() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock, .holds)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        let first = Task { await box.start(engine: binary, environment: bridgeArguments, checked: false) }
        try await until { starts == 1 }
        let heldUp = try #require(started.first)
        letItStart()
        await box.startAgain()
        #expect(box.endpoint != nil)
        await first.value
        try await isGone(heldUp)
        #expect(box.endpoint != nil, "the new one stays")
        #expect(clock.asked.isEmpty)
    }

    /// Stopped while a try waits its turn: it stays stopped, and nothing says it's being tried.
    @Test func aStoppedBoxIsNotTriedAgain() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        try await until { clock.isWaiting }
        box.stop()
        #expect(box.failure == nil)
        letItStart()
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(starts == 1)
        #expect(box.endpoint == nil)
    }

    /// One that can't be run fails the same way each time: said at once, never tried again.
    @Test func aBoxThatCantBeRunIsNotTriedAgain() async throws {
        let clock = TestClock()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let box = BoxProcess()
        box.retries.clock = clock.wait
        defer {
            box.stop()
            cleanUp()
        }
        await box.start(engine: folder.appending(path: "gone"), environment: bridgeArguments, checked: false)
        #expect(box.failure != nil)
        #expect(box.failure?.contains(StartRetries.note) == false, "\(box.failure ?? "")")
        #expect(clock.asked.isEmpty)
    }

    /// The engine's tries don't hurry the box's: each would bring back what macOS is asking about it.
    @Test func anEngineTryLeavesTheBoxsWaitAlone() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        try await until { clock.isWaiting }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        #expect(starts == 1)
    }

    /// It starts and stops again and again: at once a few times, then with the waits; never left down.
    @Test func aBoxThatKeepsStoppingGoesOnTrying() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock)
        letItStart()
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        for restarted in 1...3 {
            try await until { box.endpoint != nil && starts == restarted }
            for process in started { kill(process, SIGKILL) }
            try await until { starts == restarted + 1 }
        }
        try await until { box.endpoint != nil }
        for process in started { kill(process, SIGKILL) }
        try await until { clock.isWaiting }
        #expect(box.failure?.contains("stopped unexpectedly") == true, "\(box.failure ?? "")")
        #expect(box.failure?.contains(StartRetries.note) == true, "\(box.failure ?? "")")
        clock.goOn()
        try await until { box.endpoint != nil }
        #expect(clock.asked == [15])
        #expect(box.failure == nil)
    }

    /// A try held up while macOS asks slows down past the usual waits, and an answer brings it back.
    @Test func aBoxHeldUpWhileMacOSAsksSlowsDownAndAnAnswerBringsItBack() async throws {
        let clock = TestClock()
        let (box, binary) = try boxStandIn(clock: clock, .holds)
        let asking = SystemAsking()
        var open = true
        asking.isOpen = { open }
        box.retries.asking = asking
        box.startTimeout = .milliseconds(200)
        defer {
            clock.goOn()
            box.stop()
            cleanUp()
        }
        await box.start(engine: binary, environment: bridgeArguments, checked: false)
        for tried in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tried && clock.isWaiting }
            clock.goOn()
        }
        try await until { clock.asked.count == StartRetries.waits.count + 1 && clock.isWaiting }
        #expect(clock.asked == StartRetries.waits + [StartRetries.askedWait])
        box.startTimeout = .seconds(60)
        letItStart()
        asking.look()
        asking.look()
        open = false
        asking.look()
        try await until { box.endpoint != nil }
        #expect(clock.asked.count == StartRetries.waits.count + 1)
    }

    /// Restart brings back a box that's down, as it does a bridge.
    @Test func restartingTheEngineBringsBackABoxThatsDown() async throws {
        let binary = try standIn(bridge: true)
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let boxClock = TestClock(), engineClock = TestClock()
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        keeper.box.retries.clock = boxClock.wait
        keeper.retries.clock = engineClock.wait
        defer {
            boxClock.goOn()
            engineClock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { boxClock.isWaiting && engineClock.isWaiting }
        letItStart()
        keeper.restartEngine()
        try await until { if case .ready = keeper.engine { keeper.box.endpoint != nil } else { false } }
        #expect(keeper.box.failure == nil)
    }

    // MARK: The bridge, again

    /// Stopped while a try waits its turn: it stays stopped.
    @Test func aStoppedBridgeIsNotTriedAgain() async throws {
        let binary = try standIn(bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        try await until { clock.isWaiting }
        agents.stop()
        letItStart()
        clock.goOn()
        try await until { clock.passed == 1 }
        #expect(starts == 1)
        #expect(agents.api == nil)
    }
}
