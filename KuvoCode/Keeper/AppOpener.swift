import Darwin
import Foundation
import OpenCodeKit
import os

nonisolated private let log = Logger(subsystem: "run.kuvo.code", category: "keeper")

/// Kuvo Code itself, opened in the background for an agent on this Mac that needs its browser while
/// it's closed (#211): the keeper opens the app it was installed from, with no window, out of the
/// Dock and without taking focus (`InBackground`), and the call goes on once the app has said where
/// its tools answer (`KeeperTools.use`). One opening at a time: calls that come meanwhile wait on
/// the same one. Within `wait` seconds, or the agent hears why not.
@MainActor
final class AppOpener {
    /// Opens the app at a place, quietly, or throws what went wrong (`openQuietly`; a test's stand-in).
    typealias Launch = @MainActor (URL) async throws -> Void

    /// How long a call waits for the app it opened to say where its tools answer.
    static let wait = 30

    /// The app the keeper runs from: never another copy, nor one found by its name.
    private let app: URL
    private let launch: Launch
    /// Comes back once the call has waited long enough (a test's ends when it says).
    private let deadline: @MainActor () async -> Void
    /// The opening under way: what it ends with (nil once the app's tools answer), for every call
    /// waiting on it.
    private var opening: Task<String?, Never>?
    /// The opening's wait for the app, and its deadline.
    private var waiting: CheckedContinuation<Bool, Never>?
    private var timer: Task<Void, Never>?
    /// Whether the open app has said where its tools answer (set by `KeeperTools`).
    var isReady: @MainActor () -> Bool = { false }
    #if DEBUG
    /// A call starting to wait on the opening (tests count them).
    var onWait: (() -> Void)?
    #endif

    init(app: URL = Bundle.main.bundleURL, launch: @escaping Launch = { try await AppOpener.openQuietly($0) },
         deadline: @escaping @MainActor () async -> Void = { try? await Task.sleep(for: .seconds(AppOpener.wait)) }) {
        self.app = app
        self.launch = launch
        self.deadline = deadline
    }

    /// The app, opened if it isn't and waited for: nil once its tools answer, or what the agent is
    /// told instead.
    func open() async -> String? {
        if isReady() { return nil }
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
        finishWaiting(true)
    }

    private func openAndWait() async -> String? {
        defer { opening = nil }
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
        // Its tools may have answered while it opened.
        if isReady() { return nil }
        guard await waitForApp() else {
            log.error("The app opened for its browser didn't say where its tools answer in \(Self.wait) s")
            return Self.notReady
        }
        return nil
    }

    private func waitForApp() async -> Bool {
        await withCheckedContinuation { continuation in
            waiting = continuation
            timer = Task { [deadline] in
                await deadline()
                guard !Task.isCancelled else { return }
                self.finishWaiting(false)
            }
        }
    }

    private func finishWaiting(_ ready: Bool) {
        timer?.cancel()
        timer = nil
        waiting?.resume(returning: ready)
        waiting = nil
    }

    // MARK: What the agent is told

    static let gone = "Kuvo Code isn't where it was installed on this Mac any more (it was moved or deleted), so its browser can't be opened. Ask the user to open Kuvo Code, then try again."
    static func couldntOpen(_ why: String) -> String {
        "Kuvo Code couldn't be opened in the background on this Mac for its browser (\(why.trimmingCharacters(in: .whitespacesAndNewlines))). Ask the user to open Kuvo Code, then try again."
    }
    static let notReady = "Kuvo Code was opened in the background on this Mac, but its browser wasn't ready within \(wait) seconds. Try again in a moment; if it still isn't ready, ask the user to open Kuvo Code."

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
    /// keeper and a command to it (`--box`, `--box-control`). Asked of the kernel, not Launch
    /// Services, so the keeper never checks in as an app.
    nonisolated static func runs(_ executable: URL) -> Bool {
        let wanted = executable.resolvingSymlinksInPath().path(percentEncoded: false)
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return false }
        var pids = [pid_t](repeating: 0, count: Int(count) + 32)
        let found = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        for pid in pids.prefix(max(0, found)) where pid > 0 && pid != getpid() {
            guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
                  URL(filePath: String(cString: path)).resolvingSymlinksInPath().path(percentEncoded: false) == wanted else { continue }
            // One whose arguments can't be read is taken as the app: opening it again would only
            // bring its window.
            guard let arguments = arguments(of: pid) else { return true }
            if !arguments.contains("--box"), !arguments.contains("--box-control") { return true }
        }
        return false
    }

    /// A process's arguments, as the kernel keeps them (`KERN_PROCARGS2`: its argument count, its
    /// executable's path, then each argument, all NUL-ended).
    private nonisolated static func arguments(of pid: pid_t) -> [String]? {
        var name = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&name, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&name, 3, &buffer, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        let argc = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        var index = MemoryLayout<Int32>.size
        // Past the executable's path and the NULs after it.
        while index < size, buffer[index] != 0 { index += 1 }
        while index < size, buffer[index] == 0 { index += 1 }
        var arguments: [String] = []
        while arguments.count < Int(argc), index < size {
            let start = index
            while index < size, buffer[index] != 0 { index += 1 }
            arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
            index += 1
        }
        return arguments
    }
}
