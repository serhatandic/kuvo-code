#if os(macOS)
import Foundation

/// The files this version puts in a machine's `~/.kuvo-code` that are the same on every machine:
/// its keeper and launcher, `kuvo-wake`, `kuvo-npx` and the runtime it runs, and the engine's
/// plugin. For a box to update itself with, as a release (the app's `--write-box-files`): made
/// by the same scripts a Mac runs there, so they're the very bytes it would write.
public enum BoxFiles {
    /// Writes them into `folder`, laid out as `~/.kuvo-code` is.
    public static func write(into folder: URL) throws {
        let bin = folder.appending(path: "bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let (files, hash) = RemoteServer.bootFiles
        for (name, text) in files {
            let file = bin.appending(path: name)
            try Data(text.utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        }
        try Data(hash.utf8).write(to: bin.appending(path: ".kuvo-boot"))
        // Writing a few files: a minute is more than enough.
        let script = ["set -e", Wakes.installScript, Launcher.installScript, CommandEnvironment.installScript].joined(separator: "\n")
        let result = try ChildProcess.runBlocking("/bin/sh", ["-c", script], environment: ["K": folder.path, "PATH": "/usr/bin:/bin"],
                                                  output: .discard, limit: .seconds(60))
        guard result.succeeded else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: result.timedOut ? "Its install scripts didn’t finish in a minute." : "Its install scripts failed: " + result.errorText])
        }
    }
}
#endif
