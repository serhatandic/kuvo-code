import Darwin
import Foundation

/// This Mac's keeper, as it records itself in its box's `run` folder (`run/keeper.json`): the
/// process that keeps this Mac's box running whether or not the app is open, as a machine's keeper
/// (`bin/kuvo-start keep`) keeps one there. It's Kuvo Code's own executable started by launchd with
/// `--box` (`Keeper`); a client (this Mac's app) finds it here, and tells it what to do on the
/// loopback address and password it gives (`KeeperControl`).
nonisolated struct KeeperRecord: Codable, Equatable, Sendable {
    var pid: Int32
    /// The app it was started from (`AppInfo.version`, `AppInfo.build`): an app updated since
    /// asks an older keeper to make way for its own (`KeeperControl.Command.update`).
    var version: String
    var build: String
    /// Where it answers, and to what password (`Authorization: Bearer …`).
    var url: String
    var password: String
    /// When it started, in milliseconds since 1970.
    var started: Double

    static var run: URL { AppInfo.supportDirectory.appending(path: "box/run") }
    static var file: URL { run.appending(path: "keeper.json") }
    /// Held (flock) by the keeper while it runs: one at a time, whoever starts it.
    static var lock: URL { run.appending(path: "keeper.lock") }

    /// The keeper running now, as it recorded itself: nil when there's no record, or its process
    /// is gone (it stopped without taking its record away).
    static func read() -> KeeperRecord? {
        guard let data = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(KeeperRecord.self, from: data) else { return nil }
        return record.isAlive ? record : nil
    }

    /// One of another user's has its process ID now (it was reused after a restart): the keeper
    /// is always yours.
    var isAlive: Bool { kill(pid, 0) == 0 }

    /// Started from another version of the app than this one (it was updated since): it makes way
    /// for this one's once nothing is under way.
    var isOtherVersion: Bool { version != AppInfo.version || build != AppInfo.build }

    /// Written whole, readable by you only.
    func write() throws {
        try FileManager.default.createDirectory(at: Self.run, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let staged = Self.run.appending(path: "keeper.json.new")
        FileManager.default.createFile(atPath: staged.path, contents: try JSONEncoder().encode(self), attributes: [.posixPermissions: 0o600])
        _ = try FileManager.default.replaceItemAt(Self.file, withItemAt: staged)
    }

    /// Taken away by the keeper that wrote it, as it stops: one another keeper wrote since stays.
    static func forget(pid: Int32) {
        guard let data = try? Data(contentsOf: file), let record = try? JSONDecoder().decode(KeeperRecord.self, from: data), record.pid == pid else { return }
        try? FileManager.default.removeItem(at: file)
    }
}

/// What a client asks this Mac's keeper (`KeeperRecord`), on its loopback address.
nonisolated enum KeeperControl {
    enum Command: String, CaseIterable, Sendable {
        /// What runs, and how it's doing.
        case status
        /// The engine, started again (the box and the bridge stay up).
        case restartEngine = "restart-engine"
        /// The coding agents' bridge, started again.
        case restartAgents = "restart-agents"
        /// The box (`kuvo-link.js serve`), started again after it stopped for good.
        case restartBox = "restart-box"
        /// The open app (`{tools: {url, token}, host: {url, password}}`), or that it has quit (`{}`):
        /// the engine's and the agents' browser calls go to its tools, and what only the app answers
        /// for the box (the panel's sign-ins, the Mac's own routes for a phone) to its host interface.
        case app
        /// Stop Background Work: everything stops, and the keeper with it, until the app opens or
        /// you log in again.
        case stop
        /// An app newer than the keeper opened: the keeper makes way for the app's own the first
        /// moment nothing is under way, however long that takes (a running session is never stopped
        /// for an update), and launchd starts that one.
        case update
    }

    enum Failure: LocalizedError {
        case notRunning
        case refused(Int, String?)

        var errorDescription: String? {
            switch self {
            case .notRunning: "Kuvo Code’s background work isn’t running."
            case .refused(_, let message): message ?? "Kuvo Code’s background work didn’t do it."
            }
        }
    }

    /// Sends `command` to the keeper running now, and gives back what it answered.
    @discardableResult
    static func send(_ command: Command, _ body: [String: Any] = [:], to record: KeeperRecord? = KeeperRecord.read()) async throws -> [String: Any] {
        guard let record, let url = URL(string: record.url + "/" + command.rawValue) else { throw Failure.notRunning }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = command == .status ? "GET" : "POST"
        request.setValue("Bearer \(record.password)", forHTTPHeaderField: "Authorization")
        if command != .status {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let answer = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure.refused(status, answer["message"] as? String) }
        return answer
    }
}
