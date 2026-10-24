import AppKit

/// The app's identity, read from the bundle so renaming the app only touches
/// `Config/App.xcconfig`.
nonisolated enum AppInfo {
    /// A copy launched with KUVO_DEMO_BACKGROUND, which never takes the keyboard (DEBUG builds).
    static var staysInBackground: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["KUVO_DEMO_BACKGROUND"] != nil
        #else
        false
        #endif
    }

    /// Started by Xcode to host the app's tests (KuvoCodeTests), which never touch the real data.
    static let isHostingTests = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        || ProcessInfo.processInfo.environment["XCTestBundlePath"] != nil

    /// For what shows you a macOS prompt (Touch ID, a login item, the usage panel's Keychain reads):
    /// a test reaching it stops the run at once, saying what and from where, rather than waiting
    /// on you to answer. The tests use stand-ins for these (see `Keychain`, `Notifier`).
    static func neverInTests(_ what: String, file: StaticString = #fileID, line: UInt = #line) {
        guard isHostingTests else { return }
        fatalError("A test reached \(what), which would show a macOS prompt and wait on it. Give it a stand-in in the tests.", file: file, line: line)
    }

    /// The tests' own folder, in the temporary folder: their data, Trash and repositories.
    static var testRoot: URL { FileManager.default.temporaryDirectory.appending(path: "KuvoCodeTests") }
    /// Where the tests' Trash is (see `FileManager.moveToTrash`).
    static var testTrash: URL { testRoot.appending(path: "Trash") }

    static var name: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? ProcessInfo.processInfo.processName
    }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    }

    /// A beta: a release being tried out before everyone gets it ("0.7.0-beta.1").
    static var isBeta: Bool { version.contains("-beta") }

    static var bundleID: String {
        Bundle.main.bundleIdentifier ?? "run.kuvo.code"
    }

    /// `~/Library/Application Support/<bundle id>`: the engine binary and its data live here.
    /// Hosting tests, a folder of the tests' own in the temporary folder.
    static var supportDirectory: URL {
        if isHostingTests { return testRoot.appending(path: "Support") }
        return URL.applicationSupportDirectory.appending(path: Bundle.main.bundleIdentifier ?? "run.kuvo.code")
    }

    /// Where Help points: the docs, what's new in each release, and reporting a problem.
    static let docs = URL(string: "https://kuvo.run/code/docs/")!
    static let releases = URL(string: "https://github.com/serhatandic/kuvo-code/releases")!
    static let newIssue = URL(string: "https://github.com/serhatandic/kuvo-code/issues/new/choose")!
    /// Where to write to the people who make Kuvo Code.
    static let contact = URL(string: "mailto:info@kuvo.run")!
}

extension FileManager {
    /// To the Trash. Hosting tests, to a Trash of the tests' own (`AppInfo.testTrash`), so
    /// what they throw away never lands in the real one.
    nonisolated func moveToTrash(_ url: URL) throws {
        guard AppInfo.isHostingTests else { return try trashItem(at: url, resultingItemURL: nil) }
        let folder = AppInfo.testTrash.appending(path: UUID().uuidString)
        try createDirectory(at: folder, withIntermediateDirectories: true)
        try moveItem(at: url, to: folder.appending(path: url.lastPathComponent))
    }
}

/// System, light or dark, for the whole app (AppKit menus and sheets included).
enum Appearance: String, CaseIterable {
    case system, light, dark
    static let key = "appearance"

    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    @MainActor func apply() {
        NSApp.appearance = switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}
