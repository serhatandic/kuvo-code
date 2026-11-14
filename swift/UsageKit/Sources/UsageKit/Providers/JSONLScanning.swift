import Foundation

/// The `Item`-independent half of the incremental scan machinery: file discovery and the scan-window
/// lower bound. A non-generic namespace keeps file discovery independent of each provider's parsed
/// row type and lets call sites read `JSONLScanning.sinceDate(...)`.
enum JSONLScanning {
    /// A discovered log file plus the stat fields the parse cache is keyed on.
    struct DiscoveredFile: Sendable {
        var path: String
        var size: Int
        var mtime: Date
    }

    /// Start of the day `daysBack` days before `now` — the lower bound of the scan window.
    static func sinceDate(daysBack: Int, now: Date) -> Date {
        let shifted = Calendar.current.date(byAdding: .day, value: -daysBack, to: now) ?? now
        return Calendar.current.startOfDay(for: shifted)
    }

    /// Every `*.jsonl` regular file under `dir` (recursively), path-sorted so a keep-first dedup is
    /// deterministic. Empty when `dir` can't be enumerated.
    static func jsonlFiles(under dir: URL) -> [DiscoveredFile] {
        // `FileManager.enumerator` silently yields nothing when `dir` itself is a symlink.
        // Resolve first so the enumeration sees the real directory.
        let dir = dir.resolvingSymlinksInPath()
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        guard let enumerator = FileManager.default.enumerator(
            at: dir, includingPropertiesForKeys: keys, options: []
        ) else { return [] }
        var files: [DiscoveredFile] = []
        for case let url as URL in enumerator {
            guard url.pathExtension == "jsonl",
                  let values = try? url.resourceValues(forKeys: Set(keys)),
                  values.isRegularFile == true
            else { continue }
            files.append(DiscoveredFile(
                path: url.path,
                size: values.fileSize ?? 0,
                mtime: values.contentModificationDate ?? .distantPast
            ))
        }
        return files.sorted { $0.path < $1.path }
    }
}
