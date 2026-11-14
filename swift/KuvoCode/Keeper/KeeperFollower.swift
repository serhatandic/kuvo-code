import Darwin
import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// This Mac's box as the keeper runs it (`Keeper`), followed by the app as a client: where the
/// engine, the box and the coding agents' bridge answer, by their records in the box's `run` folder
/// (`run/engine.json`, `run/serve.json`, `run/bridge.json`), read again as that folder changes. The
/// box and the bridge are told to the app's own `BoxProcess` and `OutsideAgents`, which follow them
/// rather than start them; the engine, to `onEngine`.
@MainActor
final class KeeperFollower {
    let box: BoxProcess
    let agents: OutsideAgents

    /// The engine, as its records say: told to `onEngine` as it changes.
    private(set) var engine: MacBoxRunner.Engine = .starting {
        didSet {
            guard engine != oldValue else { return }
            waiting.settle(engine)
            onEngine(engine)
        }
    }
    var onEngine: (MacBoxRunner.Engine) -> Void = { _ in }
    private let waiting = EngineWaiters()
    /// A keeper started (the first one found, or a new one after an update or a crash): it's told
    /// of the open app.
    var onKeeper: () -> Void = {}
    private var keeper: Int32?
    /// Whether the keeper running now is an older app's, making way for this one's once nothing is
    /// under way (it's asked to as it's found): told to `onMakingWay` as it changes.
    private(set) var makingWay = false {
        didSet { if makingWay != oldValue { onMakingWay(makingWay) } }
    }
    var onMakingWay: (Bool) -> Void = { _ in }
    /// Whether the keeper running now is another version's (an older app's, after an update),
    /// whatever it answered when asked to make way: the update gate holds its box while it is (#679).
    private(set) var runsOtherVersion = false {
        didSet { if runsOtherVersion != oldValue { onOtherVersion(runsOtherVersion) } }
    }
    var onOtherVersion: (Bool) -> Void = { _ in }
    /// Where its box answers changed (`serve.json`): a new keeper's box, say, to look at at once.
    var onServe: () -> Void = {}
    private var servedAt: ServerEndpoint?

    private var watch: DispatchSourceFileSystemObject?
    private var tick: Task<Void, Never>?
    /// Followed, from `start` until `stop`: a read still under way as it stops (one waiting on the
    /// keeper, or one its folder's change set going) says nothing after, so an app that quit never
    /// hears the keeper is gone and starts a box of its own.
    private var following = false
    /// When the app last asked launchd to start the keeper, for how long it's given to come up.
    private var askedToStart: Date?
    /// When the engine was last asked to start over: a reason it stopped from before then is the
    /// last engine's.
    private var restartAsked: Date?
    /// Since when the running keeper hasn't answered.
    private var silentSince: Date?

    /// The engine started over by the keeper: starting, until its records say otherwise.
    func restartEngine() async throws {
        restartAsked = .now
        silentSince = nil
        engine = .starting
        do {
            try await KeeperControl.send(.restartEngine)
        } catch {
            // One that doesn't answer is started over itself, by launchd.
            guard KeeperRecord.read() != nil else { throw error }
            await BackgroundWork.shared.start(over: true)
        }
    }
    /// How long a keeper asked to start has to record itself before the window says it didn't.
    static let startWait: TimeInterval = 30

    init(box: BoxProcess, agents: OutsideAgents) {
        self.box = box
        self.agents = agents
    }

    /// Where the engine answers once it's up (now, if it is), or why it isn't.
    func ready() async throws -> ServerEndpoint {
        try await waiting.wait(for: engine)
    }

    /// Followed from now on: the keeper started if it isn't running (after Stop Background Work),
    /// or asked to make way for this app's own if it came with another version (as it's read).
    /// Whether it's followed: not when launchd has no keeper to start (the app it was registered
    /// from is gone, say), and the app runs the box itself, never waiting on one.
    @discardableResult
    func start() async -> Bool {
        following = true
        if KeeperRecord.read() == nil {
            askedToStart = .now
            let started = await startKeeper()
            // (Stopped while launchd was asked, as the app quits: nothing more, and the app doesn't
            // take it for a keeper that isn't coming, which would start its own box.)
            guard following else { return true }
            guard started else {
                following = false
                log.error("launchd has no keeper to start: this Mac's box runs in the app")
                BackgroundWork.shared.didntStart = true
                return false
            }
        }
        follow()
        await read()
        return true
    }

    /// No keeper came after all: the app runs this Mac's box itself, and Settings says background
    /// work didn't start this time.
    private func didntStart() {
        log.error("The keeper didn't start: this Mac's box runs in the app")
        BackgroundWork.shared.didntStart = true
        onGone()
    }

    func stop() {
        following = false
        watch?.cancel()
        watch = nil
        tick?.cancel()
        tick = nil
    }

    /// Read again as the `run` folder changes (a record written or taken away), and every few
    /// seconds besides: a process that went leaves its record behind, which changes nothing there.
    private func follow() {
        guard watch == nil else { return }
        try? FileManager.default.createDirectory(at: KeeperRecord.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let folder = open(KeeperRecord.run.path, O_EVTONLY)
        if folder >= 0 {
            let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: folder, eventMask: [.write, .delete, .rename], queue: .main)
            source.setEventHandler { [weak self] in Task { await self?.read() } }
            source.setCancelHandler { close(folder) }
            source.resume()
            watch = source
        }
        tick = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await self?.read()
            }
        }
    }

    /// Not followed any more: a start waiting on it hears `reason`, and the app nothing else.
    func giveUp(_ reason: String) {
        stop()
        onEngine = { _ in }
        engine = .failed(reason)
    }

    /// The keeper isn't coming (switched off in Login Items & Extensions, or macOS doesn't let it
    /// run): the app runs this Mac's box itself instead.
    var onGone: () -> Void = {}
    /// The keeper moving this Mac's box into its home of its own (`status.moving`): why it holds on,
    /// "" while it just moves, nil otherwise.
    var onMoving: (String?) -> Void = { _ in }
    /// A read under way, and whether the records changed while it was: one at a time, so an older
    /// one that waited on the keeper never says what a newer one already said otherwise.
    private var reading = false
    /// Whether the keeper followed now said it makes way for this app's (it doesn't when the app
    /// at its place is its own version: this app is another copy).
    private var keeperUpdates = false
    private var readAgain = false

    /// What the records say now.
    func read() async {
        guard following else { return }
        if reading {
            readAgain = true
            return
        }
        reading = true
        repeat {
            readAgain = false
            await readOnce()
        } while readAgain && following
        reading = false
    }

    private func readOnce() async {
        let record = KeeperRecord.read()
        if record?.pid != keeper {
            keeper = record?.pid
            if let record {
                BackgroundWork.shared.didntStart = false
                onKeeper()
                // One of another version (the app was updated since it started): asked to make way
                // for this app's own. It goes the first moment nothing is under way, and is
                // followed until then.
                if record.isOtherVersion {
                    log.info("The keeper is \(record.version, privacy: .public) (\(record.build, privacy: .public)): asked to make way")
                    keeperUpdates = (try? await KeeperControl.send(.update, to: record))?["updating"] as? Bool ?? false
                } else {
                    keeperUpdates = false
                }
            }
        }
        guard following else { return }
        runsOtherVersion = record?.isOtherVersion == true
        makingWay = record != nil && keeperUpdates
        let engineRecord = Self.record("engine.json")
        let serve = Self.record("serve.json")
        let bridge = Self.record("bridge.json")
        // Why one isn't there, when the keeper can say (asked only then), and whether one making way
        // still has work under way.
        var status: [String: Any] = [:]
        var answered = true
        if serve == nil || bridge == nil || engineRecord == nil || makingWay {
            let said = try? await KeeperControl.send(.status)
            answered = said != nil
            status = said ?? [:]
        }
        // Stopped while the keeper was asked (above too).
        guard following else { return }
        // A keeper that runs but doesn't answer (hung): since when, for how long the window waits.
        // One making way that's hung is waited for too, though its engine's record is still there:
        // the window waits on it, not on that engine.
        if (engineRecord != nil && !makingWay) || answered || KeeperRecord.read() == nil {
            silentSince = nil
        } else if silentSince == nil {
            silentSince = .now
        }
        onMoving(status["moving"] as? Bool == true ? status["movingWhy"] as? String ?? "" : nil)
        box.follow(serve, failure: (status["box"] as? [String: Any])?["failure"] as? String)
        if serve != servedAt {
            servedAt = serve
            if serve != nil { onServe() }
        }
        agents.follow(bridge, failure: (status["agents"] as? [String: Any])?["failure"] as? String)
        // One making way with nothing under way (or already going, and not answering) goes this
        // moment: its engine isn't connected to, only to start over on the new keeper's a moment
        // later. The app waits for that one; one still at work is followed until it's done.
        let goesNow = makingWay && status["busy"] as? Bool != true
        if let engineRecord, !goesNow {
            askedToStart = nil
            engine = .ready(engineRecord)
        } else if let reason = stoppedReason(), KeeperRecord.read() != nil || !retryAwaited {
            // (With no keeper left to make it, a next try isn't coming, whatever its reason says.)
            engine = .failed(reason)
        } else if KeeperRecord.read() == nil, isGone() {
            onGone()
        } else if KeeperRecord.read() == nil, let askedToStart, -askedToStart.timeIntervalSinceNow > Self.startWait {
            didntStart()
        } else if let silentSince, -silentSince.timeIntervalSinceNow > Self.startWait {
            engine = .failed("Kuvo Code’s background work isn’t answering. Try again, or restart your Mac if it still doesn’t.")
        } else if let engineState = status["engine"] as? [String: Any], engineState["state"] as? String == "downloading" {
            engine = .downloading(progress: engineState["progress"] as? Double ?? 0)
        } else {
            if KeeperRecord.read() == nil, askedToStart == nil {
                // Gone (stopped from elsewhere, or it crashed and launchd hasn't started it yet):
                // asked to start, and given the time to.
                askedToStart = .now
                let started = await startKeeper()
                guard following else { return }
                guard started else {
                    didntStart()
                    return
                }
            }
            engine = .starting
        }
    }

    /// launchd asked to start the keeper: whether it took it (it has none to start when the app it
    /// was registered from is gone, say).
    private func startKeeper() async -> Bool {
        #if DEBUG
        // A test's keeper, which the test starts, never launchd.
        if ProcessInfo.processInfo.environment["KUVO_KEEPER"] == "follow" { return true }
        #endif
        return await BackgroundWork.shared.start()
    }

    /// No keeper, and none will come: macOS has it switched off (or never registered it).
    private func isGone() -> Bool {
        #if DEBUG
        // A test's keeper, followed without asking macOS.
        if ProcessInfo.processInfo.environment["KUVO_KEEPER"] == "follow" { return false }
        #endif
        BackgroundWork.shared.refresh()
        return BackgroundWork.shared.state != .on
    }

    private var retryAwaited: Bool {
        FileManager.default.fileExists(atPath: KeeperRecord.run.appending(path: "engine.retry").path(percentEncoded: false))
    }

    /// Why the engine stopped and isn't started again (`run/engine-stopped`), with what it wrote
    /// last under it (`run/engine-output`), as the window shows its own engine's: one from before
    /// the last restart was asked for is the last engine's.
    private func stoppedReason() -> String? {
        let file = KeeperRecord.run.appending(path: "engine-stopped")
        guard let reason = try? String(contentsOf: file, encoding: .utf8), !reason.isEmpty else { return nil }
        if let restartAsked, let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, written < restartAsked { return nil }
        let output = (try? String(contentsOf: KeeperRecord.run.appending(path: "engine-output"), encoding: .utf8)) ?? ""
        return output.isEmpty ? reason : reason + "\n\n" + output
    }

    /// One of the box's records, while its process runs: where it answers.
    static func record(_ name: String) -> ServerEndpoint? {
        struct Record: Decodable { var pid: Int32?; var port: Int?; var password: String? }
        guard let data = try? Data(contentsOf: KeeperRecord.run.appending(path: name)),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              let port = record.port, let url = URL(string: "http://127.0.0.1:\(port)") else { return nil }
        // Gone, or its process ID another user's now (reused after a restart): the box's are yours.
        if let pid = record.pid, kill(pid, 0) != 0 { return nil }
        return ServerEndpoint(url: url, password: record.password)
    }
}
