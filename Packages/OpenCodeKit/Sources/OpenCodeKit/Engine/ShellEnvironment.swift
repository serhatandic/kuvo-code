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
    /// `timeout`, when it's stopped for good (an interactive shell takes no notice of SIGTERM).
    /// What it started in the background, holding its output, doesn't hold this up (`ChildProcess`).
    static func run(shell: String, flags: String, timeout: Duration) async -> [String: String]? {
        // Keeps interactive shells from asking about things like oh-my-zsh updates.
        var environment = ProcessInfo.processInfo.environment
        environment["DISABLE_AUTO_UPDATE"] = "true"
        // What the profile says as it starts (a greeting) comes before the marker, not in the first setting.
        guard let result = try? await ChildProcess.run(shell, [flags, "printf '%s\\0' \(marker); /usr/bin/env -0"], environment: environment,
                                                       errors: .discard, limit: timeout),
              result.succeeded else { return nil }
        return parse(result.output)
    }

    static let marker = "__KUVO_ENVIRONMENT__"

    /// `env -0`'s settings, after the marker when there is one.
    static func parse(_ data: Data) -> [String: String] {
        var result: [String: String] = [:]
        var entries = data.split(separator: 0)
        if let at = entries.firstIndex(where: { $0.suffix(marker.utf8.count).elementsEqual(marker.utf8) }) {
            entries = Array(entries[(at + 1)...])
        }
        for entry in entries {
            guard let line = String(data: entry, encoding: .utf8), let equals = line.firstIndex(of: "=") else { continue }
            result[String(line[..<equals])] = String(line[line.index(after: equals)...])
        }
        return result
    }
}

#endif
