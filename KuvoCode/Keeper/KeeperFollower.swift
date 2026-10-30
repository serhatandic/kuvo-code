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

    private var watch: DispatchSourceFileSystemObject?
    private var tick: Task<Void, Never>?
    /// When the app last asked launchd to start the keeper, for how long it's given to come up.
    private var askedToStart: Date?
    /// When the engine was last asked to start over: a reason it stopped from before then is the
    /// last engine's.
    private var restartAsked: Date?

    /// The engine started over by the keeper: starting, until its records say otherwise.
    func restartEngine() async throws {
        restartAsked = .now
        engine = .starting
        try await KeeperControl.send(.restartEngine)
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
    /// or asked to make way for this app's own if it came with another version.
    func start() async {
        if let keeper = KeeperRecord.read() {
            if keeper.version != AppInfo.version || keeper.build != AppInfo.build {
                log.info("The keeper is \(keeper.version, privacy: .public) (\(keeper.build, privacy: .public)): asked to make way")
                _ = try? await KeeperControl.send(.update, ["within": Keeper.updateWait], to: keeper)
            }
        } else {
            askedToStart = .now
            BackgroundWork.shared.start()
        }
        follow()
        await read()
    }

    func stop() {
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

    /// What the records say now.
    func read() async {
        let running = KeeperRecord.read()?.pid
        if running != keeper {
            keeper = running
            if running != nil { onKeeper() }
        }
        let engineRecord = Self.record("engine.json")
        let serve = Self.record("serve.json")
        let bridge = Self.record("bridge.json")
        // Why one isn't there, when the keeper can say (asked only then).
        var status: [String: Any] = [:]
        if serve == nil || bridge == nil || engineRecord == nil { status = (try? await KeeperControl.send(.status)) ?? [:] }
        box.follow(serve, failure: (status["box"] as? [String: Any])?["failure"] as? String)
        agents.follow(bridge, failure: (status["agents"] as? [String: Any])?["failure"] as? String)
        if let engineRecord {
            askedToStart = nil
            engine = .ready(engineRecord)
        } else if let reason = stoppedReason() {
            engine = .failed(reason)
        } else if KeeperRecord.read() == nil, let askedToStart, -askedToStart.timeIntervalSinceNow > Self.startWait {
            engine = .failed("Kuvo Code’s background work didn’t start. Check that Kuvo Code is allowed in System Settings › General › Login Items & Extensions.")
        } else if let engineState = status["engine"] as? [String: Any], engineState["state"] as? String == "downloading" {
            engine = .downloading(progress: engineState["progress"] as? Double ?? 0)
        } else {
            if KeeperRecord.read() == nil, askedToStart == nil {
                // Gone (stopped from elsewhere, or it crashed and launchd hasn't started it yet):
                // asked to start, and given the time to.
                askedToStart = .now
                BackgroundWork.shared.start()
            }
            engine = .starting
        }
    }

    /// Why the engine stopped and isn't started again (`run/engine-stopped`): one from before the
    /// last restart was asked for is the last engine's.
    private func stoppedReason() -> String? {
        let file = KeeperRecord.run.appending(path: "engine-stopped")
        guard let reason = try? String(contentsOf: file, encoding: .utf8), !reason.isEmpty else { return nil }
        if let restartAsked, let written = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, written < restartAsked { return nil }
        return reason
    }

    /// One of the box's records, while its process runs: where it answers.
    static func record(_ name: String) -> ServerEndpoint? {
        struct Record: Decodable { var pid: Int32?; var port: Int?; var password: String? }
        guard let data = try? Data(contentsOf: KeeperRecord.run.appending(path: name)),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              let port = record.port, let url = URL(string: "http://127.0.0.1:\(port)") else { return nil }
        if let pid = record.pid, kill(pid, 0) != 0, errno != EPERM { return nil }
        return ServerEndpoint(url: url, password: record.password)
    }
}
