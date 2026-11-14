import Darwin
import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code itself, opened in the background for an agent on this Mac that needs its browser while
/// it's closed (#211, the user's decision; the keeper takes this one feature on because only the
/// installed app's own process can open it): the keeper opens the app it was installed from, with
/// no window, out of the Dock and without taking focus (`InBackground`), and the call goes on once
/// the app has said where its tools answer (`KeeperTools.use`). One opening at a time: calls that
/// come meanwhile wait on the same one. Within `wait` seconds, or the agent hears why not; after
/// one that failed, it isn't opened again for `rest` seconds (an app that crashes as it opens isn't
/// opened over and over through the night). Not while an update installs: Sparkle opens it then.
///
/// #333 piece 3 carried this over for a Mac's box in a home of its own: there the box decides
/// (`box/src/link/mac/app.ts`, the same rules and words), the app's place comes with its
/// registration (`kuvo/box/app`), and only the opening itself is the keeper's (the host interface's
/// `app/open`; the helper's after #333 piece 4). This copy serves the box in the app's folder
/// (`KeeperTools`) alone, and goes with it once this Mac's box has moved (#333 pieces 5–6); a
/// change to the rules goes in both until then.
@MainActor
final class AppOpener {
    /// Opens the app at a place, quietly, or throws what went wrong (`openQuietly`; a test's stand-in).
    typealias Launch = @MainActor (URL) async throws -> Void

    /// How long a call waits for the app it opened to say where its tools answer.
    static let wait = 30
    /// How long after an opening that failed it isn't tried again.
    static let rest: TimeInterval = 5 * 60

    /// The app the keeper runs from: never another copy, nor one found by its name.
    private let app: URL
    private let launch: Launch
    /// Comes back once the opening has taken long enough (a test's ends when it says).
    private let deadline: @MainActor () async -> Void
    /// Whether an update of the app is installing now (`updateInstalling`; a test's own).
    private let updating: () -> Bool
    private let now: () -> Date
    /// The opening under way: what it ends with (nil once the app's tools answer), for every call
    /// waiting on it.
    private var opening: Task<String?, Never>?
    /// The opening's wait for the app, and whether its time ran out.
    private var waiting: CheckedContinuation<Bool, Never>?
    private var expired = false
    /// The last opening that failed: when, and what it said.
    private var failed: (at: Date, said: String)?
    /// Whether the open app has said where its tools answer (set by `KeeperTools`).
    var isReady: @MainActor () -> Bool = { false }
    #if DEBUG
    /// A call starting to wait on the opening (tests count them).
    var onWait: (() -> Void)?
    #endif

    init(app: URL = Bundle.main.bundleURL, launch: @escaping Launch = { try await AppOpener.openQuietly($0) },
         deadline: @escaping @MainActor () async -> Void = { try? await Task.sleep(for: .seconds(AppOpener.wait)) },
         updating: @escaping () -> Bool = { AppOpener.updateInstalling() }, now: @escaping () -> Date = { .now }) {
        self.app = app
        self.launch = launch
        self.deadline = deadline
        self.updating = updating
        self.now = now
    }

    /// The app, opened if it isn't and waited for: nil once its tools answer, or what the agent is
    /// told instead.
    func open() async -> String? {
        if isReady() { return nil }
        if opening == nil, let failed, now().timeIntervalSince(failed.at) < Self.rest { return failed.said }
        let opening = opening ?? {
            let task = Task { await self.openAndWait() }
            self.opening = task
            return task
        }()
        #if DEBUG
        onWait?()
        #endif
        return await opening.value
    }

    /// The open app said where its tools answer: the opening waiting for it is done.
    func ready() {
        failed = nil
        finishWaiting(true)
    }

    private func openAndWait() async -> String? {
        defer { opening = nil }
        expired = false
        // The whole opening, launch and all, within `wait`.
        let timer = Task {
            await deadline()
            guard !Task.isCancelled else { return }
            self.expired = true
            self.finishWaiting(false)
        }
        defer { timer.cancel() }
        let said = await openedOrWhyNot()
        if let said { failed = (now(), said) }
        return said
    }

    private func openedOrWhyNot() async -> String? {
        if updating() {
            // Sparkle opens it again once it's installed: waited for, never opened over it.
            log.info("An update of the app is installing: waiting for it to open")
        } else {
            guard FileManager.default.fileExists(atPath: app.path(percentEncoded: false)) else {
                log.error("The app isn't at \(self.app.path(percentEncoded: false), privacy: .public) any more")
                return Self.gone
            }
            do {
                try await launch(app)
            } catch {
                log.error("Couldn't open the app for its browser: \(error.localizedDescription, privacy: .public)")
                return Self.couldntOpen(error.localizedDescription)
            }
        }
        // Its tools may have answered while it opened.
        if isReady() { return nil }
        if !expired, await waitForApp() { return nil }
        if isReady() { return nil }
        log.error("The app opened for its browser didn't say where its tools answer in \(Self.wait) s")
        return Self.notReady
    }

    private func waitForApp() async -> Bool {
        await withCheckedContinuation { continuation in
            waiting = continuation
        }
    }

    private func finishWaiting(_ ready: Bool) {
        waiting?.resume(returning: ready)
        waiting = nil
    }

    /// Where the app notes that it's quitting to install an update (`noteUpdateInstalling`), which
    /// it takes away as it opens again.
    nonisolated static var updateFile: URL { KeeperRecord.run.appending(path: "app-updating") }

    /// Whether an update of the app is installing now: noted in the last few minutes (one that
    /// never opened again, quit for real, leaves the note behind).
    nonisolated static func updateInstalling() -> Bool {
        guard let noted = (try? FileManager.default.attributesOfItem(atPath: updateFile.path))?[.modificationDate] as? Date else { return false }
        return abs(noted.timeIntervalSinceNow) < 2 * 60
    }

    // MARK: What the agent is told

    static let gone = "Kuvo Code isn't where it was installed on this Mac any more (it was moved or deleted), so its browser can't be opened. Ask the user to open Kuvo Code, then try again."
    static func couldntOpen(_ why: String) -> String {
        "Kuvo Code couldn't be opened in the background on this Mac for its browser (\(why.trimmingCharacters(in: .whitespacesAndNewlines))). Ask the user to open Kuvo Code, then try again."
    }
    static let notReady = "Kuvo Code was opened in the background on this Mac, but its browser wasn't ready within \(wait) seconds. Try again in a few minutes; if it still isn't ready, ask the user to open Kuvo Code."

    // MARK: Opening it

    /// Opens Kuvo Code at `app` in the background (`open -g -j`, with `InBackground.launchArgument`):
    /// not activated, hidden, and windowless once it starts. One already running from there (still
    /// starting, say) is left alone: opening it again would bring its window. Never from the app's
    /// tests.
    nonisolated static func openQuietly(_ app: URL) async throws {
        guard !AppInfo.isHostingTests else { throw Refused("the app's tests never open an app") }
        let executable = app.appending(path: "Contents/MacOS").appending(path: Bundle.main.executableURL?.lastPathComponent ?? AppInfo.name)
        if runs(executable) {
            log.info("The app is running already: waiting for its tools")
            return
        }
        // `open` rather than AppKit: the keeper stays a process with no place in the Dock.
        let result = try await ChildProcess.run("/usr/bin/open", ["-g", "-j", "-a", app.path(percentEncoded: false), "--args", InBackground.launchArgument],
                                                output: .discard, errors: .collect, limit: .seconds(20), cancellable: false)
        guard result.succeeded else {
            let said = result.errorText.trimmingCharacters(in: .whitespacesAndNewlines)
            throw Refused(result.timedOut ? "macOS didn't open it in time" : said.isEmpty ? "macOS refused" : said)
        }
    }

    struct Refused: LocalizedError {
        let why: String
        init(_ why: String) { self.why = why }
        var errorDescription: String? { why }
    }

    /// Whether Kuvo Code runs from `executable` now as the app: a process of it other than this
    /// keeper and a command to it (`--box`, `--box-control`), as `RunningApp` finds it (the box's
    /// helper asks the same).
    nonisolated static func runs(_ executable: URL) -> Bool {
        RunningApp.runs(executable)
    }

    /// A process's arguments, as the kernel keeps them (`RunningApp.arguments`).
    nonisolated static func arguments(of pid: pid_t) -> [String]? {
        RunningApp.arguments(of: pid)
    }
}
