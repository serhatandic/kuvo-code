import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// The browser goes onto a machine as Kuvo Code sends it (`MachineBrowserInstaller.sending`), run
/// here with this Mac's shell in a home of the test's own, as a Mac used as a machine runs it. A
/// Mac's `ps` lists the `grep` that looks through it, with the build's path it looks for, so every
/// build looked "running": the one sent was thrown away and the browser pointed at nothing, and
/// every bot there was told the browser "isn't on this machine yet".
@Suite struct MachineBrowserInstallTests {
    let home = AppInfo.testRoot.appending(path: "MachineHome/\(UUID().uuidString)")
    var browser: URL { home.appending(path: "\(RemoteEngineInstaller.root)/browser") }
    let build = "155.0.8059.79-mac-test"

    /// A build as `bundle(for:)` makes one, its launcher at the top, saying `text`.
    private func bundle(saying text: String) throws -> URL {
        let made = home.appending(path: "bundle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        try Data("#!/bin/sh\n# \(text)\n".utf8).write(to: made.appending(path: "chrome"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: made.appending(path: "chrome").path)
        let archive = home.appending(path: "bundle-\(UUID().uuidString).tar.gz")
        #expect(try run("/usr/bin/tar", ["czf", archive.path, "-C", made.path, "."]) == 0)
        return archive
    }

    @discardableResult
    private func run(_ program: String, _ arguments: [String], input: URL? = nil) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(filePath: program)
        process.arguments = arguments
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        process.currentDirectoryURL = home
        process.standardInput = try input.map { try FileHandle(forReadingFrom: $0) } ?? FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    private func launcher(of build: String) -> String? {
        try? String(contentsOf: browser.appending(path: "\(build)/chrome"), encoding: .utf8)
    }

    @Test func aMacMachineGetsTheBrowserItIsSentInPlaceOfAnOlderOne() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        // An older build nothing runs from any more, left by an earlier copy of the app.
        try FileManager.default.createDirectory(at: browser.appending(path: "154.0.1-mac-old"), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: browser.appending(path: "154.0.1-mac-old/chrome"))

        #expect(try run("/bin/sh", ["-c", MachineBrowserInstaller.sending(build)], input: bundle(saying: "new")) == 0)

        #expect(launcher(of: build) == "#!/bin/sh\n# new\n", "the build sent is there")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: browser.appending(path: "current").path) == build)
        #expect(FileManager.default.isExecutableFile(atPath: browser.appending(path: "current/chrome").path), "the browser in use is there")
        #expect(!FileManager.default.fileExists(atPath: browser.appending(path: "154.0.1-mac-old").path), "the older build goes")
        #expect(!FileManager.default.fileExists(atPath: browser.appending(path: ".staging").path))
    }

    @Test func aBuildABrowserStillRunsFromStaysAsItIs() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        // The same build, sent meanwhile by another Mac, and a browser running from it.
        try FileManager.default.createDirectory(at: browser.appending(path: build), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n# running\n".utf8).write(to: browser.appending(path: "\(build)/chrome"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: browser.appending(path: "\(build)/chrome").path)
        // (Started by the build's real path, as the browser is, through any link on the way (macOS's
        // /var is /private/var): a process of its own, stopped below.)
        let running = try follow(browser.appending(path: "\(build)/chrome"))
        defer { running.terminate(); running.waitUntilExit() }

        #expect(try run("/bin/sh", ["-c", MachineBrowserInstaller.sending(build)], input: bundle(saying: "new")) == 0)

        #expect(launcher(of: build) == "#!/bin/sh\n# running\n", "the running build isn't replaced under it")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: browser.appending(path: "current").path) == build)
        #expect(!FileManager.default.fileExists(atPath: browser.appending(path: ".staging").path))
    }

    /// Something runs with the build's folder in its command line, but the browser isn't in it (its
    /// folder went from under it): the build sent is put there, never thrown away for it.
    @Test func aBuildWithNoBrowserInItIsReplacedWhateverRunsFromIt() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        try FileManager.default.createDirectory(at: browser.appending(path: build), withIntermediateDirectories: true)
        try Data("left".utf8).write(to: browser.appending(path: "\(build)/notes"))
        let running = try follow(browser.appending(path: "\(build)/notes"))
        defer { running.terminate(); running.waitUntilExit() }

        #expect(try run("/bin/sh", ["-c", MachineBrowserInstaller.sending(build)], input: bundle(saying: "new")) == 0)

        #expect(launcher(of: build) == "#!/bin/sh\n# new\n")
        #expect(FileManager.default.isExecutableFile(atPath: browser.appending(path: "current/chrome").path))
    }

    /// What's sent has no browser in it: it fails, saying so, and the browser in use stays in use.
    @Test func aBundleWithNoBrowserFailsAndLeavesTheOneInUse() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        let earlier = "154.0.1-mac-old"
        try FileManager.default.createDirectory(at: browser.appending(path: earlier), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: browser.appending(path: "\(earlier)/chrome"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: browser.appending(path: "\(earlier)/chrome").path)
        try FileManager.default.createSymbolicLink(atPath: browser.appending(path: "current").path, withDestinationPath: earlier)
        let empty = home.appending(path: "empty")
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        try Data("notes".utf8).write(to: empty.appending(path: "README"))
        let archive = home.appending(path: "empty.tar.gz")
        #expect(try run("/usr/bin/tar", ["czf", archive.path, "-C", empty.path, "."]) == 0)

        #expect(try run("/bin/sh", ["-c", MachineBrowserInstaller.sending(build)], input: archive) != 0)

        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: browser.appending(path: "current").path) == earlier)
        #expect(FileManager.default.isExecutableFile(atPath: browser.appending(path: "current/chrome").path))
    }

    /// `tail -f` on `file` by its real path: a process whose command line names the build.
    private func follow(_ file: URL) throws -> Process {
        let real = try #require(realpath(file.path, nil))
        defer { free(real) }
        let process = Process()
        process.executableURL = URL(filePath: "/usr/bin/tail")
        process.arguments = ["-f", String(cString: real)]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }
}
