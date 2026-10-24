import Foundation
import os

/// Brings what Kuvo Code keeps on this Mac up to date with this version, once: on the first
/// launch after an update that needs it, before the engine starts, while the window says
/// "Updating" (`EngineSetupView`). What the steps could touch is backed up first (`Backups`), once
/// for each update. Each step only adds what this version needs beside what's there, so an older
/// version still reads everything as it did, and a step can run again safely: one that fails is
/// tried again at the next launch, with the ones after it. The stores have read their files by
/// then, so a step changes what they keep through them, never the files under them. What lives
/// on a machine is brought up to date as it connects (`AppModel.start(_:)`), as a machine can be
/// away for a while.
@MainActor @Observable
final class Calibration {
    struct Step {
        /// One more than the step before; the last one done is kept, under `key`.
        let version: Int
        let name: String
        let run: @MainActor (AppModel) async throws -> Void
    }

    /// The steps, in order.
    static let steps: [Step] = [
        // Each bot's description beside its memory, where what runs there reads it (a
        // machine's link, for your phone, with this Mac closed). A machine's bots get theirs as
        // it connects.
        Step(version: 1, name: "bots' descriptions") { app in await app.bots.describeAll(on: nil) },
    ]

    /// The last step done, in the app's settings.
    static let key = "calibration"
    /// The steps a backup was last made for: one update's steps tried again at a later launch
    /// don't make another, which could push the one from before the update out.
    static let backedUpKey = "calibration.backedUp"
    static var current: Int { steps.map(\.version).max() ?? 0 }

    /// Updating now, with something of yours to update: the window says so.
    private(set) var isRunning: Bool
    /// This launch's run, which a start of the engine while it's under way waits for (`run` is
    /// called with each start).
    @ObservationIgnored private var running: Task<Void, Never>?
    private let log = Logger(subsystem: "run.kuvo.code", category: "calibration")

    init() {
        // Known as the window opens, so it says so from its first moment.
        isRunning = Self.due.isEmpty == false && Backups.hasData
    }

    /// The steps not done yet.
    private static var due: [Step] {
        let done = UserDefaults.standard.integer(forKey: key)
        return steps.filter { $0.version > done }.sorted { $0.version < $1.version }
    }

    /// Runs the steps not done yet, after a backup of what they could touch, once a launch. A new
    /// install has nothing to back up, and nothing to say.
    func run(_ app: AppModel) async {
        if let running { return await running.value }
        let run = Task { await perform(app) }
        running = run
        await run.value
    }

    private func perform(_ app: AppModel) async {
        defer { isRunning = false }
        let due = Self.due
        guard !due.isEmpty else { return }
        if Backups.hasData, UserDefaults.standard.integer(forKey: Self.backedUpKey) < Self.current {
            // Not a step without one: it's what makes going back possible.
            guard Backups.make() != nil else {
                log.error("Couldn't back up before updating; the update waits for the next launch")
                return
            }
            UserDefaults.standard.set(Self.current, forKey: Self.backedUpKey)
        }
        for step in due {
            do {
                try await step.run(app)
                UserDefaults.standard.set(step.version, forKey: Self.key)
                log.info("Updated: \(step.name, privacy: .public)")
            } catch {
                // The rest wait for this one, at the next launch.
                log.error("Couldn't update \(step.name, privacy: .public): \(error.localizedDescription, privacy: .public)")
                return
            }
        }
    }
}

/// Copies of what Kuvo Code keeps on this Mac, made before it's updated (`Calibration`): its lists
/// (bots, group chats and what was said in them, personalities, messages between agents, phones)
/// and its settings, in `Backups/<when, in UTC> <version>` in its folder. The last few are kept.
/// To go back to one, quit Kuvo Code and copy its files back into the folder above it (the
/// settings with `defaults import`).
nonisolated enum Backups {
    static var folder: URL { AppInfo.supportDirectory.appending(path: "Backups") }
    /// How many are kept: older ones go as a new one is made.
    static let kept = 3
    /// What's copied from Kuvo Code's folder, where there.
    static let files = ["bots.json", "groups.json", "groups", "personalities.json", "agent-messages.json", "phone-link.json"]
    /// The settings that hold your things (machines, projects, worktrees): one of them means
    /// there's something to keep.
    static let settings = ["machines", "projectFolders", "worktrees", "projectSettings"]
    /// The start of a backup's name while it's being made.
    private static let partialPrefix = ".partial-"

    /// Whether there's anything of yours to back up: a new install has nothing.
    static var hasData: Bool {
        files.contains { FileManager.default.fileExists(atPath: AppInfo.supportDirectory.appending(path: $0).path) }
            || settings.contains { UserDefaults.standard.object(forKey: $0) != nil }
    }

    /// Makes one: the files there are and the app's settings, as they are now. Nil when it
    /// couldn't (nothing is changed without one).
    @discardableResult
    static func make(now: Date = .now) -> URL? {
        let manager = FileManager.default
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HHmmss"
        // In time order by name, whatever time zone the Mac is in; one made the same second gets
        // a number.
        let name = "\(formatter.string(from: now)) \(AppInfo.version)"
        var target = folder.appending(path: name)
        var number = 2
        while manager.fileExists(atPath: target.path) {
            target = folder.appending(path: "\(name) \(number)")
            number += 1
        }
        // Made under a name of its own, and given its real one only once it's whole: one cut
        // short (the app quit, the disk full) never counts as a backup.
        let partial = folder.appending(path: "\(partialPrefix)\(UUID().uuidString)")
        do {
            try manager.createDirectory(at: partial, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            for name in files {
                let source = AppInfo.supportDirectory.appending(path: name)
                guard manager.fileExists(atPath: source.path) else { continue }
                try manager.copyItem(at: source, to: partial.appending(path: name))
            }
            if let domain = UserDefaults.standard.persistentDomain(forName: AppInfo.bundleID) {
                let data = try PropertyListSerialization.data(fromPropertyList: domain, format: .binary, options: 0)
                try data.write(to: partial.appending(path: "settings.plist"), options: .atomic)
            }
            try manager.moveItem(at: partial, to: target)
        } catch {
            try? manager.removeItem(at: partial)
            log.error("Couldn't back up: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        prune()
        return target
    }

    /// The newest `kept` stay; older ones go, as do any left half made.
    private static func prune() {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: folder.path)) ?? []
        for name in names where name.hasPrefix(partialPrefix) {
            try? manager.removeItem(at: folder.appending(path: name))
        }
        // Those made before an update, named by when (not the old group chat files, `GroupMigration`).
        for name in names.filter({ $0.first?.isNumber == true }).sorted().dropLast(kept) {
            try? manager.removeItem(at: folder.appending(path: name))
        }
    }

    private static let log = Logger(subsystem: "run.kuvo.code", category: "calibration")
}
