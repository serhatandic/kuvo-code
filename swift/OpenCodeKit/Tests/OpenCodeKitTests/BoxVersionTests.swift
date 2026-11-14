import Foundation
import Testing
@testable import OpenCodeKit

/// A box a newer Kuvo Code set up (one that updated itself, or another Mac's newer app) is left as
/// it is: what this app would put there isn't written over it. Run here, in a home folder of the
/// test's own, with the script a machine runs.
@Suite(.serialized) struct BoxVersionTests {
    let home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-box-\(UUID().uuidString)")
    var bin: URL { home.appending(path: RemoteEngineInstaller.root).appending(path: "bin") }

    /// Runs a script that writes this app's file, as an install does: true when it wrote it.
    private func installs(over box: String?, mine: String) throws -> Bool {
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let marker = bin.appending(path: "box-version")
        try? FileManager.default.removeItem(at: marker)
        if let box { try Data(box.utf8).write(to: marker) }
        let file = bin.appending(path: "kuvo-link.js")
        try? FileManager.default.removeItem(at: file)
        let before = BoxVersion.mine
        BoxVersion.mine = mine
        defer { BoxVersion.mine = before }
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", BoxVersion.guardScript + "\n" + #"cat >"$HOME/\#(RemoteEngineInstaller.root)/bin/kuvo-link.js""#]
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        let input = Pipe()
        process.standardInput = input
        try process.run()
        input.fileHandleForWriting.write(Data("// this app's\n".utf8))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        return FileManager.default.fileExists(atPath: file.path)
    }

    @Test func aNewerBoxIsLeftAsItIs() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        #expect(try installs(over: nil, mine: "0.8.0"), "a box no Kuvo Code marked yet")
        #expect(try installs(over: "0.7.2", mine: "0.8.0"))
        #expect(try installs(over: "0.8.0", mine: "0.8.0"))
        #expect(try !installs(over: "0.8.1", mine: "0.8.0"))
        #expect(try !installs(over: "0.10.0", mine: "0.9.3"), "by number, not as text")
        #expect(try installs(over: "0.9.3", mine: "0.10.0"))
        #expect(try installs(over: "garbage", mine: "0.8.0"), "a marker that isn't a version marks nothing")
        // A beta comes before its release, and after the release before it.
        #expect(try !installs(over: "0.8.0", mine: "0.8.0-beta.1"))
        #expect(try installs(over: "0.8.0-beta.1", mine: "0.8.0"))
        #expect(try installs(over: "0.8.0-beta.1", mine: "0.8.0-beta.2"))
        #expect(try !installs(over: "0.8.0-beta.2", mine: "0.8.0-beta.1"))
        #expect(try installs(over: "0.7.2", mine: "0.8.0-beta.1"))
    }

    /// A Mac marks the box as its version once what it put there runs: its tools this version's
    /// (`kuvo-npx` only with this version's engine there, which it runs), and kept as the box's own
    /// (`bin/.own`, with their times), for the keeper to put back after an older Mac's visit. An
    /// older Mac's visit since the last mark is noted for the box. Not over a newer box.
    @Test func aMarkKeepsTheBoxsOwnTools() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        let run = home.appending(path: RemoteEngineInstaller.root).appending(path: "run")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
        try Data("// this app's agents\n".utf8).write(to: bin.appending(path: "kuvo-agents.js"))
        try Data("// kuvo-browser older\n".utf8).write(to: bin.appending(path: "kuvo-browser.js"))
        try Data("an older Mac's\n".utf8).write(to: bin.appending(path: "kuvo-wake"))
        try Data().write(to: run.appending(path: "mac-installing"))
        let engine = home.appending(path: RemoteEngineInstaller.root).appending(path: "engine/\(OpenCodeEngine.version)/opencode")
        try FileManager.default.createDirectory(at: engine.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("#!/bin/sh\n".utf8).write(to: engine)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        let mark = { (mine: String) throws -> Int32 in
            let before = BoxVersion.mine
            BoxVersion.mine = mine
            defer { BoxVersion.mine = before }
            let process = Process()
            process.executableURL = URL(filePath: "/bin/sh")
            process.arguments = ["-c", BoxVersion.markScript(marks: ["kuvo-agents.js": "// this app's agents", "kuvo-browser.js": "// kuvo-browser mine"])]
            process.environment = ["HOME": self.home.path, "PATH": "/usr/bin:/bin"]
            process.standardInput = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        }
        #expect(try mark("0.8.0") == 0)
        #expect(try String(contentsOf: bin.appending(path: "box-version"), encoding: .utf8) == "0.8.0")
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "mac-installing").path))
        let own = bin.appending(path: ".own")
        #expect(try String(contentsOf: own.appending(path: "kuvo-agents.js"), encoding: .utf8) == "// this app's agents\n")
        let wake = try String(contentsOf: own.appending(path: "kuvo-wake"), encoding: .utf8)
        #expect(wake == Wakes.script + "\n", "this version's, not what an older Mac left")
        #expect(try String(contentsOf: bin.appending(path: "kuvo-wake"), encoding: .utf8) == wake)
        #expect(FileManager.default.fileExists(atPath: own.appending(path: "kuvo-npx").path))
        #expect(!FileManager.default.fileExists(atPath: run.appending(path: "older-mac").path), "a box no Kuvo Code marked yet: no older Mac to note")
        // Without this version's engine there (one of another version kept at work), its kuvo-npx
        // isn't put there, and the box's stays its own.
        let npx = bin.appending(path: "kuvo-npx")
        try Data("# the box's npx\n".utf8).write(to: npx)
        try Data("# the box's npx\n".utf8).write(to: own.appending(path: "kuvo-npx"))
        try FileManager.default.removeItem(at: engine)
        #expect(try mark("0.8.0") == 0)
        #expect(try String(contentsOf: npx, encoding: .utf8) == "# the box's npx\n")
        #expect(try String(contentsOf: own.appending(path: "kuvo-npx"), encoding: .utf8) == "# the box's npx\n")
        // An older Mac here since: noted with its time, before the mark hides it.
        let attached = run.appending(path: "attached")
        try Data().write(to: attached)
        let visit = Date.now.addingTimeInterval(60)
        try FileManager.default.setAttributes([.modificationDate: visit], ofItemAtPath: attached.path)
        #expect(try mark("0.8.0") == 0)
        let noted = try FileManager.default.attributesOfItem(atPath: run.appending(path: "older-mac").path)[.modificationDate] as? Date
        #expect(noted.map { abs($0.timeIntervalSince(visit)) < 1 } == true)
        #expect(!FileManager.default.fileExists(atPath: own.appending(path: "kuvo-browser.js").path), "an older Mac's, put there meanwhile, isn't kept")
        let times = { (url: URL) in try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date }
        #expect(try times(own.appending(path: "kuvo-agents.js")) == times(bin.appending(path: "kuvo-agents.js")))
        // This app's kept from before: back in its place.
        try Data("// kuvo-browser mine\n".utf8).write(to: own.appending(path: "kuvo-browser.js"))
        #expect(try mark("0.8.0") == 0)
        #expect(try String(contentsOf: bin.appending(path: "kuvo-browser.js"), encoding: .utf8) == "// kuvo-browser mine\n")
        // None there: none kept.
        try FileManager.default.removeItem(at: bin.appending(path: "kuvo-agents.js"))
        #expect(try mark("0.8.0") == 0)
        #expect(!FileManager.default.fileExists(atPath: own.appending(path: "kuvo-agents.js").path))
        try Data("// this app's agents\n".utf8).write(to: bin.appending(path: "kuvo-agents.js"))
        #expect(try mark("0.8.0") == 0)
        // Over a newer box, nothing.
        try Data("0.9.0".utf8).write(to: bin.appending(path: "box-version"))
        try Data("// a newer box's agents\n".utf8).write(to: bin.appending(path: "kuvo-agents.js"))
        #expect(try mark("0.8.0") == 0)
        #expect(try String(contentsOf: bin.appending(path: "box-version"), encoding: .utf8) == "0.9.0")
        #expect(try String(contentsOf: own.appending(path: "kuvo-agents.js"), encoding: .utf8) == "// this app's agents\n")
    }

    @Test func versionsCompareByNumber() {
        let before = BoxVersion.mine
        defer { BoxVersion.mine = before }
        BoxVersion.mine = "0.9.3"
        #expect(BoxVersion.isNewer("0.10.0"))
        #expect(!BoxVersion.isNewer("0.9.3"))
        #expect(!BoxVersion.isNewer("0.9.2"))
        #expect(!BoxVersion.isNewer(nil))
        BoxVersion.mine = "0.8.0-beta.2"
        #expect(BoxVersion.isNewer("0.8.0"))
        #expect(BoxVersion.isNewer("0.8.0-beta.3"))
        #expect(!BoxVersion.isNewer("0.8.0-beta.1"))
        #expect(!BoxVersion.isNewer("0.7.9"))
        #expect(!BoxVersion.isNewer("not a version"))
        BoxVersion.mine = "0.8.0; rm -rf ~"
        #expect(BoxVersion.mine == "0", "only a version goes into a script")
    }
}
