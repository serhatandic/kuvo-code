import Foundation
import os

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// The environment a terminal would have. Apps opened from the Finder or Dock
/// inherit launchd's bare environment (PATH is `/usr/bin:/bin:/usr/sbin:/sbin`),
/// so the agent's shell commands wouldn't find Homebrew, nvm, bun, etc.
/// opencode's own desktop app does the same thing.
public enum ShellEnvironment {
    private static let log = Logger(subsystem: "run.kuvo.code", category: "engine")

    /// Runs the user's login shell once and returns its environment, or the
    /// app's own if the shell doesn't answer in time.
    public static func load() async -> [String: String] {
        let fallback = ProcessInfo.processInfo.environment
        let shell = fallback["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        // nushell doesn't take POSIX flags.
        guard !shell.hasSuffix("/nu") else { return fallback }
        return await load(shell: shell, fallback: fallback)
    }

    /// `shell`'s environment: as an interactive login shell first (what .zshrc sets, like nvm's
    /// or bun's PATH, which can take a while to load), then as a login shell only, then `fallback`.
    static func load(shell: String, fallback: [String: String], interactive: Duration = .seconds(15),
                     login: Duration = .seconds(5)) async -> [String: String] {
        for (flags, timeout) in [("-ilc", interactive), ("-lc", login)] {
            if let environment = await run(shell: shell, flags: flags, timeout: timeout), environment["PATH"] != nil {
                return environment
            }
            log.error("Your shell (\(shell, privacy: .public) \(flags, privacy: .public)) didn't give its environment in time")
        }
        log.error("Using Kuvo Code's own environment: your shell's PATH and settings aren't there")
        return fallback
    }

    /// What `shell` run with `flags` gives `env -0`, or nil when it fails or hasn't finished in
    /// `timeout` (then it's stopped, for good). Waited for without holding a thread:
    /// `Process.waitUntilExit()` on one of Swift's threads could miss the exit and wait for ever
    /// (the shell long gone), and a read to the end of its output that something it started in
    /// the background kept open could too.
    static func run(shell: String, flags: String, timeout: Duration) async -> [String: String]? {
        let process = Process()
        process.executableURL = URL(filePath: shell)
        process.arguments = [flags, "/usr/bin/env -0"]
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        // Its own, so a terminal's shell started meanwhile doesn't keep it open (see `unshared`).
        let output = Pipe.unshared()
        process.standardOutput = output
        // Keeps interactive shells from asking about things like oh-my-zsh updates.
        var environment = ProcessInfo.processInfo.environment
        environment["DISABLE_AUTO_UPDATE"] = "true"
        process.environment = environment
        let exited = Arrival<Int32>()
        process.terminationHandler = { exited.deliver($0.terminationStatus) }
        let read = Arrival<Data>()
        let buffer = LockedData()
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                read.deliver(buffer.data)
            } else {
                buffer.append(data)
            }
        }

        do { try process.run() } catch { return nil }
        let data = await withTaskGroup(of: Data?.self) { group in
            group.addTask {
                // Once it has stopped, all it said: to the end of its output, or, if something it
                // left running in the background keeps that open, what came in a moment after.
                guard let status = await exited.wait(), status == 0 else { return nil }
                return await first(of: { await read.wait() }, orAfter: .milliseconds(500)) ?? buffer.data
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let winner = await group.next() ?? nil
            group.cancelAll()
            return winner
        }
        if data == nil, process.isRunning {
            // An interactive shell takes no notice of SIGTERM: given a moment, then SIGKILL.
            process.terminate()
            if await first(of: { await exited.wait() }, orAfter: .seconds(1)) == nil {
                kill(process.processIdentifier, SIGKILL)
                _ = await first(of: { await exited.wait() }, orAfter: .seconds(1))
            }
        }
        // What it started in the background no longer holds the pipe's reading end here either.
        output.fileHandleForReading.readabilityHandler = nil
        return data.map(parse)
    }

    /// What `work` gives, or nil if it hasn't within `limit`.
    private static func first<Value: Sendable>(of work: @escaping @Sendable () async -> Value?, orAfter limit: Duration) async -> Value? {
        await withTaskGroup(of: Value?.self) { group in
            group.addTask { await work() }
            group.addTask {
                try? await Task.sleep(for: limit)
                return nil
            }
            let winner = await group.next() ?? nil
            group.cancelAll()
            return winner
        }
    }

    private final class LockedData: @unchecked Sendable {
        private let lock = NSLock()
        private var stored = Data()
        func append(_ more: Data) { lock.withLock { stored.append(more) } }
        var data: Data { lock.withLock { stored } }
    }

    static func parse(_ data: Data) -> [String: String] {
        var result: [String: String] = [:]
        for entry in data.split(separator: 0) {
            guard let line = String(data: entry, encoding: .utf8), let equals = line.firstIndex(of: "=") else { continue }
            result[String(line[..<equals])] = String(line[line.index(after: equals)...])
        }
        return result
    }
}

#endif
