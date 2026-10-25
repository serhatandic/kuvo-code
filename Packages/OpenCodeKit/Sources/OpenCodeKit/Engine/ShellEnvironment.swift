import Foundation

// Starts processes, so only on the Mac; the phone reaches engines through Kuvo Link.
#if os(macOS)

/// The environment a terminal would have. Apps opened from the Finder or Dock
/// inherit launchd's bare environment (PATH is `/usr/bin:/bin:/usr/sbin:/sbin`),
/// so the agent's shell commands wouldn't find Homebrew, nvm, bun, etc.
/// opencode's own desktop app does the same thing.
public enum ShellEnvironment {
    /// Runs the user's login shell once and returns its environment, or the
    /// app's own if the shell doesn't answer in time.
    public static func load(timeout: Duration = .seconds(5)) async -> [String: String] {
        let fallback = ProcessInfo.processInfo.environment
        let shell = fallback["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        // nushell doesn't take POSIX flags.
        guard !shell.hasSuffix("/nu") else { return fallback }

        for flags in ["-ilc", "-lc"] {
            if let environment = await run(shell: shell, flags: flags, timeout: timeout), environment["PATH"] != nil {
                return environment
            }
        }
        return fallback
    }

    /// What `shell` run with `flags` gives `env -0`, or nil when it fails or hasn't finished in
    /// `timeout`. Waited for without holding a thread: `Process.waitUntilExit()` on one of Swift's
    /// threads could miss the exit and wait for ever (the shell long gone), and so could a read to
    /// the end of its output that something it started in the background kept open.
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
                // All it said, once it has stopped (cancelled: nothing).
                guard let data = await read.wait(), let status = await exited.wait() else { return nil }
                return status == 0 ? data : Data?.none
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        if process.isRunning { process.terminate() }
        // What it started in the background no longer holds the pipe's reading end here either.
        output.fileHandleForReading.readabilityHandler = nil
        return data.map(parse)
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
