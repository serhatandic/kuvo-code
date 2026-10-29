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
