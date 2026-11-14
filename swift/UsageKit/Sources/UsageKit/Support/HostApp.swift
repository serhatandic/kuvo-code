import Foundation

/// The app UsageKit runs inside. Names, folders and the user agent follow the host's bundle, so this
/// fork never presents itself as OpenUsage or shares OpenUsage's files. (Fork addition; see README.md.)
enum HostApp {
    /// The host's display name, for wording like "Quit Kuvo Code".
    static var name: String {
        let info = Bundle.main.infoDictionary
        return (info?["CFBundleDisplayName"] as? String) ?? (info?["CFBundleName"] as? String) ?? "Kuvo Code"
    }

    static var bundleIdentifier: String {
        Bundle.main.bundleIdentifier ?? "run.kuvo.code"
    }

    /// `~/Library/Application Support/<bundle id>/Usage`: scan caches, pricing, the proxy config.
    static var supportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent("Usage", isDirectory: true)
    }

    /// `~/Library/Logs/<name>`.
    static var logsDirectory: URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return library.appendingPathComponent("Logs/\(name)", isDirectory: true)
    }

    /// The `User-Agent` for provider requests: the name without spaces.
    static var userAgent: String {
        name.replacingOccurrences(of: " ", with: "")
    }
}
