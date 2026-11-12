import Foundation
@testable import KuvoCode

/// A git repository of a test's own, in the tests' temporary folder, removed when the test ends.
/// git runs with no settings of yours (no global or system config), so hooks, signing and
/// default branches on this Mac can't change what a test sees; the app's own git calls get the
/// same through `TestEnvironment`.
final class TestRepository {
    let url: URL
    var path: String { url.path(percentEncoded: false) }

    init() throws {
        TestEnvironment.prepare()
        url = AppInfo.testRoot.appending(path: "Repositories/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try git("init", "-q", "-b", "main")
    }

    deinit {
        try? FileManager.default.removeItem(at: url)
    }

    /// Runs git here; its output, or a thrown error with what git said.
    @discardableResult
    func git(_ arguments: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/git")
        process.arguments = arguments
        process.currentDirectoryURL = url
        let output = Pipe(), errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let complaint = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw TestFailure("git \(arguments.joined(separator: " ")): \(String(decoding: complaint, as: UTF8.self))")
        }
        return String(decoding: data, as: UTF8.self)
    }

    func write(_ path: String, _ text: String) throws {
        let file = url.appending(path: path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
    }

    func read(_ path: String) -> String? {
        (try? Data(contentsOf: url.appending(path: path))).map { String(decoding: $0, as: UTF8.self) }
    }

    func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: url.appending(path: path).path(percentEncoded: false))
    }

    func isLink(_ path: String) -> Bool {
        (try? FileManager.default.destinationOfSymbolicLink(atPath: url.appending(path: path).path(percentEncoded: false))) != nil
    }

    func commitAll(_ message: String = "Commit") throws {
        try git("add", "-A")
        try git("commit", "-q", "-m", message)
    }

    /// `git status --porcelain`, one line a file: empty when the working tree matches the last commit.
    func status() throws -> [String] {
        try git("status", "--porcelain", "--untracked-files=all").split(separator: "\n").map(String.init)
    }
}

/// What every test runs with, set once: git without your settings, in the app's process too.
enum TestEnvironment {
    private static let once: Void = {
        // A run starts clean: what an earlier one left goes (scripts/test-app.sh removes it after).
        try? FileManager.default.removeItem(at: AppInfo.testRoot)
        for (key, value) in ["GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
                             "GIT_AUTHOR_NAME": "Tests", "GIT_AUTHOR_EMAIL": "tests@example.com",
                             "GIT_COMMITTER_NAME": "Tests", "GIT_COMMITTER_EMAIL": "tests@example.com"] {
            setenv(key, value, 1)
        }
        // A machine's engine and bridge wait through its tunnel on a session of their own
        // (`MachineEngine.patient`), which `URLProtocol.registerClass` doesn't reach: `StubWeb`
        // answers it too, as it answers the shared session, while a test has it started.
        MachineEngine.patient = MachineEngine.waitingSession(answeredBy: [StubWeb.self])
        // Motion as most Macs have it, whatever this one's setting (`ReduceMotion`): before any
        // window, on the main thread, where what it changes is told.
        if Thread.isMainThread {
            MainActor.assumeIsolated { ReduceMotion.offUnlessChosen() }
        } else {
            DispatchQueue.main.async { ReduceMotion.offUnlessChosen() }
        }
    }()

    static func prepare() { once }
}

struct TestFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
