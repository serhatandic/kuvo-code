import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The engine or the coding agents' bridge couldn't start: this Mac's box tries again by itself,
/// waiting longer each time, says so meanwhile with Try Again still there, and stops trying after a
/// while, for you to see why. What can't change (a program that isn't there) isn't tried again; what
/// you ask for happens at once, and what you stopped stays stopped. The servers are stand-ins (a
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
        app.ownBox.retryClock = clock.wait
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

    /// It never starts: tried a bounded number of times, then the failure says only why, and nothing
    /// more is tried. Try Again starts it at once with its tries back.
    @Test func anEngineThatNeverStartsIsGivenUpOnAndTryAgainStillWorks() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retryClock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        for tries in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tries && clock.isWaiting }
            #expect(engineReason(keeper.engine)?.contains(StartRetries.note) == true)
            clock.goOn()
            try await until { starts == tries + 1 }
        }
        try await until { engineReason(keeper.engine)?.contains("the database is locked") == true && engineReason(keeper.engine)?.contains(StartRetries.note) == false }
        #expect(clock.asked == StartRetries.waits)
        #expect(!clock.isWaiting, "no more tries")
        #expect(starts == StartRetries.waits.count + 1)
        #expect(!FileManager.default.fileExists(atPath: BoxProcess.run.appending(path: "engine.retry").path(percentEncoded: false)))

        let after = starts
        letItStart()
        keeper.restartEngine()
        try await until { if case .ready = keeper.engine { true } else { false } }
        #expect(starts == after + 1)
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
        keeper.retryClock = clock.wait
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

    /// The box's watch for hung servers holds off while macOS asks you something, as only this side
    /// can see, and nothing's left saying so.
    @Test func theBoxsWatchIsToldWhileMacOSAsks() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.systemAsking = { true }
        let clock = TestClock()
        keeper.retryClock = clock.wait
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
        keeper.retryClock = clock.wait
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
        keeper.retryClock = clock.wait
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
        app.ownBox.retryClock = clock.wait
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
        keeper.retryClock = clock.wait
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
        keeper.retryClock = clock.wait
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
        keeper.retryClock = clock.wait
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

    /// A phone asking this Mac's box hears why, and that it's being tried again; once that's over,
    /// that Try Again on the Mac starts it.
    @Test func aPhoneHearsThisMacsEngineIsBeingTriedAgain() async throws {
        let binary = try standIn(box: try #require(TestBox.node, "Node runs this Mac's box in the tests"))
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retryClock = clock.wait
        defer {
            clock.goOn()
            keeper.stop()
            cleanUp()
        }
        await keeper.start()
        try await until { clock.isWaiting }
        let box = try #require(keeper.box.endpoint, "this Mac's box runs on")
        let ask = { () async throws -> String in
            var request = URLRequest(url: try #require(URL(string: "api/session", relativeTo: box.url)))
            if let password = box.password { request.setValue("Basic " + Data("opencode:\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
            let (body, _) = try await URLSession(configuration: .ephemeral).data(for: request)
            return String(decoding: body, as: UTF8.self)
        }
        let said = try await ask()
        #expect(said.contains("This Mac's engine isn't running. The engine stopped (exit code 3). \(StartRetries.note)"), "\(said)")
        #expect(!said.contains("Try Again in Kuvo Code"), "\(said)")

        // Its tries run out: only why, and what starts it.
        clock.goOn()
        for tries in 2...StartRetries.waits.count {
            try await until { clock.asked.count == tries && clock.isWaiting }
            clock.goOn()
        }
        try await until { engineReason(keeper.engine)?.contains(StartRetries.note) == false }
        let after = try await ask()
        #expect(after.contains("This Mac's engine isn't running. The engine stopped (exit code 3). Try Again in Kuvo Code on the Mac starts it."), "\(after)")
        #expect(!after.contains(StartRetries.note), "\(after)")
    }

    /// You stop the engine while a try waits: a phone isn't told it's being tried.
    @Test func aPhoneIsntToldItsTriedOnceItsStopped() async throws {
        let binary = try standIn()
        setenv("KUVO_OPENCODE_BINARY", binary.path(percentEncoded: false), 1)
        let keeper = MacBoxRunner(box: BoxProcess(), agents: OutsideAgents(), host: HostInterface())
        keeper.onEngine = { _ in TestPulse.beat() }
        let clock = TestClock()
        keeper.retryClock = clock.wait
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
    }

    /// Its note is a sentence of its own, before what the server wrote.
    @Test func whatItSaysWhileTrying() {
        #expect(StartRetries.noted("It stopped.\n\nwhat it wrote") == "It stopped. \(StartRetries.note)\n\nwhat it wrote")
        #expect(StartRetries.noted("service unavailable") == "service unavailable. \(StartRetries.note)")
    }

    // MARK: The bridge

    private func bridge(clock: TestClock) -> OutsideAgents {
        let agents = OutsideAgents()
        agents.home = folder.appending(path: "agents")
        agents.retryClock = clock.wait
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

    /// It never starts: tried a bounded number of times, then it says only why. Restart still starts
    /// it, and it has its tries back.
    @Test func aBridgeThatNeverStartsIsGivenUpOnAndRestartStillWorks() async throws {
        let binary = try standIn(bridge: true)
        let clock = TestClock()
        let agents = bridge(clock: clock)
        defer {
            clock.goOn()
            agents.stop()
            cleanUp()
        }
        await agents.start(engine: binary, environment: bridgeArguments)
        for tries in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tries && clock.isWaiting }
            clock.goOn()
            try await until { starts == tries + 1 }
        }
        try await until { agents.failure?.contains(StartRetries.note) == false }
        #expect(agents.failure?.contains("exit code 3") == true, "\(agents.failure ?? "")")
        #expect(!clock.isWaiting, "no more tries")

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

    /// The window's Try Again and Settings' Restart bring back a bridge given up on too, not only
    /// the engine: many have no other Restart for it.
    @Test func restartingTheEngineBringsBackABridgeGivenUpOn() async throws {
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
        for tries in 1...StartRetries.waits.count {
            try await until { clock.asked.count == tries && clock.isWaiting }
            clock.goOn()
            try await until { starts == tries + 1 }
        }
        try await until { agents.failure?.contains(StartRetries.note) == false }
        letItStart()
        keeper.restartEngine()
        try await until { agents.api != nil }
        #expect(agents.failure == nil)
    }

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
