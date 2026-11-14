import Foundation
import os

/// Resolves the log file URL and owns a serial, lock-guarded `FileHandle` appender with single-archive
/// rotation. `@unchecked Sendable` because all mutable state is guarded by an internal `NSLock`, so it
/// can be written to from any isolation (the `Sendable` provider structs, the `@MainActor` UI, etc.) —
/// the `nonisolated`-static-`Logger` precedent in `LocalUsageServer`, plus the lock for the handle.
///
/// Rotation matches the Tauri cap (`.max_file_size(10_000_000)`): when a write would exceed 10 MB the
/// current file becomes `OpenUsage.1.log` and a fresh `OpenUsage.log` opens — bounding disk to ~20 MB
/// while keeping one archive of recent history for user-submitted reports (a deliberate, minor
/// improvement over Tauri's KeepOne, which discards all history). On launch an already-oversize file is
/// rotated once before the first write. If opening/rotating fails the sink fails loudly to `os.Logger`
/// at error and disables itself for the session — never crashes, never silently spins.
final class LogFile: @unchecked Sendable {
    /// The shared production sink. Other code logs through `AppLog`, which writes here. Resolves
    /// `~/Library/Logs/<host app>/Usage.log` via `FileManager`, never hardcoded from `$HOME`; the
    /// `Logs/OpenUsage` subfolder is a literal (not bundle-id-keyed), so the dev and release builds
    /// agree on the same file — acceptable since they are separate builds.
    static let shared = LogFile(directory: defaultDirectory(), fileName: "Usage.log")

    /// The advertised log path (logged at startup, copied/revealed from Settings). Derived from the
    /// shared sink so the path shown to the user always equals where logs are actually written.
    static let url: URL = shared.fileURL

    static let defaultMaxBytes = 10_000_000

    /// Where this sink actually writes. Exposed (read-only) so `url` can derive the advertised path
    /// from the single source of truth rather than recomputing it.
    let fileURL: URL
    private let archiveURL: URL
    private let directory: URL
    private let maxBytes: Int
    private let fallbackLogger = Logger(subsystem: HostApp.bundleIdentifier, category: "logfile")

    private let lock = NSLock()
    private var handle: FileHandle?
    private var size = 0
    private var disabled = false
    private var opened = false

    /// - Parameters:
    ///   - directory: the folder the log file lives in (created on open if missing).
    ///   - fileName: the log file name (the archive appends `.1` before the extension).
    ///   - maxBytes: rotation cap; defaults to the 10 MB Tauri cap.
    init(directory: URL, fileName: String, maxBytes: Int = defaultMaxBytes) {
        self.directory = directory
        self.fileURL = directory.appendingPathComponent(fileName)
        self.maxBytes = maxBytes
        let base = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension
        let archiveName = ext.isEmpty ? "\(base).1" : "\(base).1.\(ext)"
        self.archiveURL = directory.appendingPathComponent(archiveName)
    }

    static func defaultDirectory() -> URL {
        // `.first` with a fallback rather than `[0]`: the lookup effectively always resolves on stock
        // macOS, but a force-index would crash the app at launch (this runs during `bootstrap()`) if it
        // ever returned empty in an unusual container. A non-ideal-but-valid directory keeps the app alive.
        HostApp.logsDirectory
    }

    /// Create the directory and file, seed the in-memory size from disk, and perform the launch-time
    /// trim (rotate once if an already-oversize file is left over from a long-dead session). Idempotent.
    func open() {
        lock.lock()
        defer { lock.unlock() }
        guard !opened else { return }
        opened = true
        do {
            try openLocked()
        } catch {
            failLocked("open failed: \(error.localizedDescription)")
        }
    }

    /// Append one already-formatted line (a newline is added). Rotates first if the line would push the
    /// file past the cap. No-op once the sink is disabled.
    func append(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !disabled else { return }
        if !opened {
            opened = true
            do {
                try openLocked()
            } catch {
                failLocked("open failed: \(error.localizedDescription)")
                return
            }
        }
        guard handle != nil else { return }

        let data = Data("\(line)\n".utf8)
        if size + data.count > maxBytes {
            do {
                try rotateLocked()
            } catch {
                failLocked("rotate failed: \(error.localizedDescription)")
                return
            }
        }
        // Re-fetch after a possible rotation, which swaps the handle out.
        guard let liveHandle = handle else { return }
        do {
            try liveHandle.write(contentsOf: data)
            size += data.count
        } catch {
            failLocked("write failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Locked internals (caller holds `lock`)

    private func openLocked() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: fileURL)
        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        self.handle = handle
        self.size = (attributes?[.size] as? Int) ?? 0
        // Launch-time trim: a leftover oversize file is rotated once before the first write.
        if self.size > maxBytes {
            try rotateLocked()
        } else {
            try handle.seekToEnd()
        }
    }

    private func rotateLocked() throws {
        try handle?.close()
        handle = nil
        if FileManager.default.fileExists(atPath: archiveURL.path) {
            try FileManager.default.removeItem(at: archiveURL)
        }
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.moveItem(at: fileURL, to: archiveURL)
        }
        FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        handle = try FileHandle(forWritingTo: fileURL)
        size = 0
    }

    private func failLocked(_ message: String) {
        fallbackLogger.error("File log sink disabled: \(message, privacy: .public)")
        try? handle?.close()
        handle = nil
        disabled = true
    }
}
