import AppKit
import os

/// The app's identity, read from the bundle so renaming the app only touches
/// `swift/Config/App.xcconfig`.
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

    /// A copy that never shows a macOS prompt, as nobody is there to answer one: the test copy, and
    /// in a debug build a demo copy launched in the background (`KUVO_DEMO_BACKGROUND`) or with
    /// `KUVO_DEMO_NO_PROMPTS=1`. `KUVO_DEMO_NO_PROMPTS=0` lets a background copy ask after all.
    static let neverPrompts = isHostingTests || demoNeverPrompts(ProcessInfo.processInfo.environment)

    /// Whether a demo copy launched with `environment` never prompts (always false in a release).
    static func demoNeverPrompts(_ environment: [String: String]) -> Bool {
        #if DEBUG
        if let value = environment["KUVO_DEMO_NO_PROMPTS"] { return value != "0" }
        return environment["KUVO_DEMO_BACKGROUND"] != nil
        #else
        return false
        #endif
    }

    /// The usage panel's screen a demo copy opens for screenshots (`KUVO_DEMO_USAGE`, any value but
    /// `off`), or nil. Asked for by name, the panel starts in a copy that never prompts
    /// too: its Keychain reads fail at once there rather than ask.
    static func demoUsageScreen(_ environment: [String: String]) -> String? {
        #if DEBUG
        guard let screen = environment["KUVO_DEMO_USAGE"], screen != "off" else { return nil }
        return screen
        #else
        return nil
        #endif
    }

    /// For what shows you a macOS prompt (Touch ID, a login item, the usage panel's Keychain reads):
    /// whether it may go ahead. A test reaching it stops the run at once, saying what and from
    /// where (the tests use stand-ins for these: see `Keychain`, `Notifier`); a demo copy that
    /// never prompts skips it, and says so in the log with where it was asked from.
    static func mayPrompt(_ what: String, file: StaticString = #fileID, line: UInt = #line) -> Bool {
        if isHostingTests {
            fatalError("A test reached \(what), which would show a macOS prompt and wait on it. Give it a stand-in in the tests.", file: file, line: line)
        }
        guard neverPrompts else { return true }
        Logger(subsystem: realBundleID, category: "prompts")
            .notice("Skipped \(what, privacy: .public) (\(String(describing: file), privacy: .public):\(Int(line))): this copy never shows a macOS prompt (KUVO_DEMO_NO_PROMPTS)")
        return false
    }

    /// The real Kuvo Code's bundle ID: its settings, Keychain items and folders.
    static let realBundleID = "run.kuvo.code"

    /// Why a debug launch for a demo, a test or a measurement (any `KUVO_DEMO_*`, `KUVO_PERF_*` or
    /// `KUVO_E2E` variable) mustn't start, or nil when it may: run as the real Kuvo Code, it would
    /// use your settings, sessions and sign-ins, and send what it does to your models on your
    /// accounts; with the real app's engine (`KUVO_OPENCODE_BINARY` in its folder), the same.
    /// `scripts/real-app-guard.sh` holds the scripts that start copies to the same rule.
    static func realAppRefusal(bundleID: String, environment: [String: String],
                               realSupport: URL = URL.applicationSupportDirectory.appending(path: realBundleID)) -> String? {
        let asked = environment.keys.filter { $0.hasPrefix("KUVO_DEMO_") || $0.hasPrefix("KUVO_PERF_") || $0 == "KUVO_E2E" }.sorted()
        guard !asked.isEmpty else { return nil }
        let because = "launched for a demo, test or measurement (\(asked.joined(separator: ", ")))"
        if bundleID.lowercased() == realBundleID {
            return "Refusing to start: \(because) as the real Kuvo Code (\(realBundleID)). Build a copy of its own, with APP_BUNDLE_ID=run.kuvo.code.demo (or .perf, .e2e, .shots)."
        }
        // Its folder on machines, where your own copy's engine, sessions and keys are there.
        if let root = environment["KUVO_DEMO_MACHINE_ROOT"],
           [".kuvo-code", "./.kuvo-code", "~/.kuvo-code"].contains(root.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased())
            || root.lowercased().hasSuffix("/.kuvo-code") || root.lowercased().hasSuffix("/.kuvo-code/") {
            return "Refusing to start: \(because) in the real Kuvo Code's folder on machines (KUVO_DEMO_MACHINE_ROOT=\(root)). Give it one of its own, like .kuvo-code-demo."
        }
        if let engine = environment["KUVO_OPENCODE_BINARY"] {
            let real = realSupport.standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false).lowercased()
            let given = URL(filePath: engine).standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false).lowercased()
            if given == real || given.hasPrefix(real.hasSuffix("/") ? real : real + "/") {
                return "Refusing to start: \(because) with the real Kuvo Code's engine (\(engine)). Leave KUVO_OPENCODE_BINARY out, so this copy runs its own."
            }
        }
        return nil
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
