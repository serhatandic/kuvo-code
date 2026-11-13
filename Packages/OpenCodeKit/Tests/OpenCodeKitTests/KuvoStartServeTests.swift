import Foundation
import Testing
@testable import OpenCodeKit

/// `kuvo-start serve` (#333 piece 4): a Mac's own box's server, which its helper (Kuvo Code Box)
/// starts and keeps: run in the foreground with the engine's Bun, its stdin (the password and the
/// vault's secrets) passed through untouched; never on a machine's box, nor one turned off. The real
/// script, in a home of the test's own, with a stand-in engine that notes how it was started.
@Suite(.serialized, AccountUntouched()) struct KuvoStartServeTests {
    let home: URL
    var root: URL { home.appending(path: RemoteEngineInstaller.root) }

    init() throws {
        home = FileManager.default.temporaryDirectory.appending(path: "opencodekit-start-serve-\(UUID().uuidString)").resolvingSymlinksInPath()
        let bin = root.appending(path: "bin")
        for (name, text) in RemoteServer.bootFiles.files { try write(bin.appending(path: name), text, executable: true) }
        try write(bin.appending(path: "kuvo-link.js"), "// the box\n")
        try write(root.appending(path: "engine/\(OpenCodeEngine.version)/opencode"), """
        #!/bin/sh
        printf '%s\\n' "$@" >"$HOME/engine.args"
        IFS= read -r line; printf '%s\\n' "$line" >"$HOME/engine.stdin"
        env | sort >"$HOME/engine.env"
        echo "listening" ; echo "said" >&2
        exit 7
        """, executable: true)
    }

    private func write(_ file: URL, _ text: String, executable: Bool = false) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: file)
        if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path) }
    }

    private func text(_ name: String) -> String { (try? String(contentsOf: home.appending(path: name), encoding: .utf8)) ?? "" }

    /// `kuvo-start serve`, given `input` on stdin, to its end.
    private func serve(_ input: String) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = [root.appending(path: "bin/kuvo-start").path, "serve"]
        process.environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        let stdin = Pipe()
        process.standardInput = stdin
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        stdin.fileHandleForWriting.write(Data(input.utf8))
        try stdin.fileHandleForWriting.close()
        process.waitUntilExit()
        return process.terminationStatus
    }

    @Test func aMacsOwnBoxsServerRunsAsItsHelpersChildWithItsStdin() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        try write(root.appending(path: "box/kind"), "mac\n")
        let secrets = #"{"password":"pw","hostVaultSecret":"vs"}"#
        // The engine's own end, as the helper sees it (it's `exec`ed, not waited for).
        #expect(try serve(secrets + "\n") == 7)
        #expect(text("engine.args").split(separator: "\n") == ["--config=/dev/null", "--no-env-file", Substring(root.appending(path: "bin/kuvo-link.js").path), "serve"])
        #expect(text("engine.stdin") == secrets + "\n")
        let environment = text("engine.env")
        #expect(environment.contains("KUVO_HOME=\(root.path)\n"))
        #expect(environment.contains("BUN_BE_BUN=1\n"))
        // What it says goes to its log, beside its other records.
        #expect((try? String(contentsOf: root.appending(path: "run/serve.log"), encoding: .utf8)) == "listening\nsaid\n")
    }

    @Test func itsKeeperNamesItsOwnBoxAsTheHelperChecks() {
        defer { try? FileManager.default.removeItem(at: home) }
        #expect(BoxHelper.ownKeeper(of: root))
        #expect(!BoxHelper.ownKeeper(of: home.appending(path: ".kuvo-code-other")))
    }

    @Test func notOnAMachinesBoxNorOneTurnedOff() throws {
        defer { try? FileManager.default.removeItem(at: home) }
        try write(root.appending(path: "box/kind"), "machine\n")
        #expect(try serve("{}\n") == 3)
        #expect(text("engine.args").isEmpty)
        try write(root.appending(path: "box/kind"), "mac\n")
        try write(root.appending(path: "run/off"), "")
        #expect(try serve("{}\n") == 0)
        #expect(text("engine.args").isEmpty)
    }
}
