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

    /// Opens the folder shown as `name`, as clicking it does.
    private func open(_ name: String, in tree: FileTree) throws -> URL {
        let row = tree.rows.first { if case .entry(let entry, _) = $0 { entry.name == name } else { false } }
        guard case .entry(let entry, _) = try #require(row) else { throw CancellationError() }
        tree.toggle(entry.url)
        return entry.url
    }

    @Test func anOpenFolderThisMacCantReadSaysWhyAndAnEmptyOneSaysEmpty() throws {
        defer { done() }
        try lock(folder.appending(path: "secrets").path)
        let tree = FileTree(roots: [folder])
        let secrets = try open("secrets", in: tree)
        _ = try open("fixtures", in: tree)
        #expect(shown(tree) == ["fixtures", "  Empty", "secrets", "  Couldn’t read this folder · Permission denied", "README.md"])
        #expect(tree.rootFailure == nil)

        // Let in, Try Again reads it.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.appending(path: "secrets").path)
        tree.retry(secrets)
        #expect(shown(tree) == ["fixtures", "  Empty", "secrets", "  key.pem", "README.md"])
    }

    /// The tree read here; the files a filter searches, listed by this Mac's box (the real one, as
    /// ProjectFilesTests has it), which says why it can't.
    @Test func aProjectThisMacCantReadSaysWhyInTheTreesPlace() async throws {
        defer { done() }
        let box = try await GitTestBox()
        let client = box.client
        try lock(folder.path)
        let tree = FileTree(roots: [folder]) { _ in client }
        let failure = try #require(tree.rootFailure)
        #expect(failure.detail(on: nil) == "Permission denied.")
        // Filtering doesn't say "No matching files" either.
        await tree.loadAllFiles()
        #expect(tree.allFiles == [])
        #expect(tree.allFilesFailure == .denied)
        withExtendedLifetime(box) {}
    }

    /// A machine's folder and every file under it, listed by the same script on Linux's tools and,
    /// here, a Mac's: a link by what it leads to, names as they are, the heavy folders left out, and
    /// only whole names when there are too many.
    @Test func aMachinesFilesAreListedOnAMacAsOnLinux() async throws {
        defer { done() }
        SSHConnection.standIn = { _, script in Self.runHere(script) }
        try FileManager.default.createDirectory(at: folder.appending(path: "node_modules/pkg"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: folder.appending(path: "node_modules/pkg/index.js"))
        try Data("x".utf8).write(to: folder.appending(path: "with a space.txt"))
        try Data("x".utf8).write(to: folder.appending(path: "tab\there.txt"))
        try FileManager.default.createSymbolicLink(at: folder.appending(path: "to-fixtures"), withDestinationURL: folder.appending(path: "fixtures"))
        try FileManager.default.createSymbolicLink(at: folder.appending(path: "broken"), withDestinationURL: folder.appending(path: "nothing-there"))
        let root = RemoteFolder.url(RemoteFolder.folder(folder.path, on: "devbox"))

        let entries = try RemoteShell.list(root).get()
        #expect(Dictionary(uniqueKeysWithValues: entries.map { ($0.name, $0.isDirectory) }) == [
            "README.md": false, "secrets": true, "fixtures": true, "node_modules": true, "with a space.txt": false,
            "tab\there.txt": false, "to-fixtures": true, "broken": false,
        ])

    }

    /// A machine's folder that couldn't be read (asleep, or not let in) is read again with the rest
    /// every few seconds, and shows its files once it can be, without Try Again: as the phone's does
    /// as its computer comes back.
    @Test func aMachinesFolderThatCouldntBeReadShowsOnceItCanBe() async throws {
        defer { done() }
        SSHConnection.standIn = { _, script in Self.runHere(script) }
        try lock(folder.path)
        let tree = FileTree(roots: [RemoteFolder.url(RemoteFolder.folder(folder.path, on: "devbox"))])
        try await until { tree.rootFailure != nil }

        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        await tree.refresh()
        #expect(tree.rootFailure == nil)
        #expect(!shown(tree).contains { $0.hasPrefix("Couldn’t read") })
    }

    /// On a machine: the machine's own reason, said as its; one that isn't there, or a machine
    /// that can't be reached, said as such.
    @Test func onAMachineItsOwnReasonIsKept() async throws {
        defer { done() }
        SSHConnection.standIn = { _, script in Self.runHere(script) }
        let root = RemoteFolder.url(RemoteFolder.folder(folder.path, on: "devbox"))
        // Let in: read, with nothing said against it.
        let tree = FileTree(roots: [root])
        #expect(tree.isLoadingRoot)
        try await until { !tree.isLoadingRoot }
        #expect(tree.rootFailure == nil)

        try lock(folder.path)
        let locked = FileTree(roots: [root])
        try await until { locked.rootFailure != nil }
        #expect(locked.rootFailure?.detail(on: "devbox") == "devbox said: Permission denied.")
        // One inside it: not let in to look, never said not to be there.
        let inside = FileTree(roots: [root.appending(path: "secrets")])
        try await until { inside.rootFailure != nil }
        #expect(inside.rootFailure == .denied)
        let deeper = FileTree(roots: [root.appending(path: "secrets/keys")])
        try await until { deeper.rootFailure != nil }
        #expect(deeper.rootFailure == .denied)

        // Let in again, one that isn't there is said not to be.
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
        let gone = FileTree(roots: [root.appending(path: "gone")])
        try await until { gone.rootFailure != nil }
        #expect(gone.rootFailure?.detail(on: "devbox") == "devbox said: No such folder.")
        // Its folder gone too (a project moved away): not there, never said to be locked.
        let goneWithIt = FileTree(roots: [root.appending(path: "old/app")])
        try await until { goneWithIt.rootFailure != nil }
        #expect(goneWithIt.rootFailure == .missing)

        SSHConnection.standIn = { _, _ in nil }
        let away = FileTree(roots: [root])
        try await until { away.rootFailure != nil }
        #expect(away.rootFailure?.detail(on: "devbox") == "Couldn't reach devbox.")
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
