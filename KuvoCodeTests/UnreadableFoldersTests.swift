import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// A folder the Files panel can't read (C5, I2): an open one says so in its files' place, with
/// the computer's own reason and Try Again, and a project that can't be read says so in the whole
/// tree's place, never looking empty; a folder that really is empty says Empty. On this Mac and on
/// a machine, where the reason is the machine's (its scripts run here by `sh`, as SSH would run
/// them there), and a machine that can't be reached says that instead. Filtering says it too.
@MainActor
@Suite(.serialized, .timeLimit(.minutes(1))) struct UnreadableFoldersTests {
    let folder = AppInfo.testRoot.appending(path: "Folders/unreadable-\(UUID().uuidString)")

    init() throws {
        TestEnvironment.prepare()
        for path in ["README.md", "secrets/key.pem"] {
            let file = folder.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: file)
        }
        try FileManager.default.createDirectory(at: folder.appending(path: "fixtures"), withIntermediateDirectories: true)
    }

    private func done() {
        SSHConnection.standIn = nil
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.appending(path: "secrets").path)
        try? FileManager.default.removeItem(at: folder)
    }

    private func lock(_ path: String) throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)
    }

    /// What the tree shows, in words: a file or folder by name, why an open folder shows nothing.
    private func shown(_ tree: FileTree) -> [String] {
        tree.rows.map { row in
            switch row {
            case .entry(let entry, let depth): String(repeating: "  ", count: depth) + entry.name
            case .unreadable(_, let failure, let depth): String(repeating: "  ", count: depth) + "Couldn’t read this folder · \(failure.reason)"
            case .empty(_, let depth): String(repeating: "  ", count: depth) + "Empty"
            }
        }
    }

    @Test func anOpenFolderThisMacCantReadSaysWhyAndAnEmptyOneSaysEmpty() throws {
        defer { done() }
        let secrets = folder.appending(path: "secrets")
        try lock(secrets.path)
        let tree = FileTree(roots: [folder])
        tree.expanded = [secrets, folder.appending(path: "fixtures")]
        #expect(shown(tree) == ["fixtures", "  Empty", "secrets", "  Couldn’t read this folder · Permission denied", "README.md"])
        #expect(tree.rootFailure == nil)

        // Let in, Try Again reads it.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: secrets.path)
        tree.retry(secrets)
        #expect(shown(tree) == ["fixtures", "  Empty", "secrets", "  key.pem", "README.md"])
    }

    @Test func aProjectThisMacCantReadSaysWhyInTheTreesPlace() async throws {
        defer { done() }
        try lock(folder.path)
        let tree = FileTree(roots: [folder])
        let failure = try #require(tree.rootFailure)
        #expect(failure.detail(on: nil) == "Permission denied.")
        // Filtering doesn't say "No matching files" either.
        await tree.loadAllFiles()
        #expect(tree.allFiles == [])
        #expect(tree.allFilesFailure == .denied)
    }

    /// On a machine: the machine's own reason, said as its; one that isn't there, or a machine
    /// that can't be reached, said as such.
    @Test func onAMachineItsOwnReasonIsKept() async throws {
        defer { done() }
        SSHConnection.standIn = { _, script in Self.runHere(script) }
        let root = RemoteFolder.url(RemoteFolder.folder(folder.path, on: "lokum"))
        // Let in: read, with nothing said against it.
        let tree = FileTree(roots: [root])
        #expect(tree.isLoadingRoot)
        try await until { !tree.isLoadingRoot }
        #expect(tree.rootFailure == nil)

        try lock(folder.path)
        let locked = FileTree(roots: [root])
        try await until { locked.rootFailure != nil }
        #expect(locked.rootFailure?.detail(on: "lokum") == "lokum said: Permission denied.")
        // One inside it: not let in to look, never said not to be there.
        let inside = FileTree(roots: [root.appending(path: "secrets")])
        try await until { inside.rootFailure != nil }
        #expect(inside.rootFailure == .denied)
        await locked.loadAllFiles()
        #expect(locked.allFilesFailure == .denied)

        let gone = FileTree(roots: [root.appending(path: "gone")])
        try await until { gone.rootFailure != nil }
        #expect(gone.rootFailure?.detail(on: "lokum") == "lokum said: No such folder.")

        SSHConnection.standIn = { _, _ in nil }
        let away = FileTree(roots: [root])
        try await until { away.rootFailure != nil }
        #expect(away.rootFailure?.detail(on: "lokum") == "Couldn't reach lokum.")
    }

    /// A machine's script, run by this Mac's `sh` in its place.
    nonisolated private static func runHere(_ script: String) -> String? {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", script]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
    }
}
