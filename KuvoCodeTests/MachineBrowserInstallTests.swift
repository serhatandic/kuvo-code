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
        // (Started by a path in the build, as the browser is: a process of its own, stopped below.)
        let running = Process()
        running.executableURL = URL(filePath: "/usr/bin/tail")
        running.arguments = ["-f", browser.appending(path: "\(build)/chrome").path]
        running.standardOutput = FileHandle.nullDevice
        running.standardError = FileHandle.nullDevice
        try running.run()
        defer { running.terminate(); running.waitUntilExit() }

        #expect(try run("/bin/sh", ["-c", MachineBrowserInstaller.sending(build)], input: bundle(saying: "new")) == 0)

        #expect(launcher(of: build) == "#!/bin/sh\n# running\n", "the running build isn't replaced under it")
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: browser.appending(path: "current").path) == build)
        #expect(!FileManager.default.fileExists(atPath: browser.appending(path: ".staging").path))
    }
}
