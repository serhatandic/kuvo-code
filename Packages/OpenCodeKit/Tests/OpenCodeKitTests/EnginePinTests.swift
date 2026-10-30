import CryptoKit
import Foundation
import Testing
@testable import OpenCodeKit

/// The engine the Mac runs is the pinned build: npm's checksum for its download, and its binary's
/// own hash, which each start checks. An update that moves the version without the hash would leave
/// the app refusing its own engine: caught here, before it ships.
struct EnginePinTests {
    @Test func thePinnedMacBuildNamesItsBinarysHash() throws {
        let release = EngineRelease.pinned
        #expect(release.tarball.absoluteString.contains("-\(OpenCodeEngine.version).tgz"), "the tarball is the pinned version's")
        let hash = try #require(release.binarySHA256)
        #expect(hash.count == 64 && hash.allSatisfy(\.isHexDigit), "the binary's SHA-256, in hex")
    }

    @Test func aBinaryThatIsntThePinnedBuildIsntInstalled() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "engine-pin-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let installer = EngineInstaller(root: folder)
        try FileManager.default.createDirectory(at: installer.executable.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Something else in its place, executable, unsigned.
        try Data("#!/bin/sh\necho not opencode\n".utf8).write(to: installer.executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installer.executable.path)
        #expect(installer.installed() == nil)
        #expect(!FileManager.default.fileExists(atPath: installer.executable.path), "moved aside, so it's downloaded again")
    }
}

/// What the engine's check holds in memory, on its own: the process's footprint is measured around
/// it, so nothing else in this suite runs meanwhile.
@Suite(.serialized) struct EngineHashMemoryTests {
    /// Each start hashes the 200 MB binary. It's read a megabyte at a time, and only a megabyte at
    /// a time stays in memory: holding every chunk read made the app's memory jump by the binary's
    /// size at launch.
    @Test func checkingTheBinarysHashDoesntHoldTheWholeFile() throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "engine-hash-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }
        let size = 128 << 20
        let handle = try FileHandle(forWritingTo: { FileManager.default.createFile(atPath: file.path, contents: nil); return file }())
        for _ in 0..<(size >> 20) { try handle.write(contentsOf: Data(repeating: 7, count: 1 << 20)) }
        try handle.close()

        var expected = SHA256()
        for _ in 0..<(size >> 20) { expected.update(data: Data(repeating: 7, count: 1 << 20)) }

        let before = try #require(footprint())
        let hash = try EngineInstaller.sha256(of: file)
        let grew = try #require(footprint()) - before
        #expect(hash == expected.finalize().map { String(format: "%02x", $0) }.joined())
        // Holding every chunk grows it by the whole file; a chunk at a time, by about a megabyte.
        #expect(grew < size / 2, "memory grew \(grew >> 20) MB hashing a \(size >> 20) MB file")
    }

    private func footprint() -> Int? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let status = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) }
        }
        return status == KERN_SUCCESS ? Int(info.phys_footprint) : nil
    }
}
