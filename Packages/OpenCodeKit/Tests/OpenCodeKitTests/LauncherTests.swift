import Foundation
import Testing
@testable import OpenCodeKit

/// `kuvo-npx`, run with this Mac's sh as the engine runs an integration's server.
struct LauncherTests {
    /// Runs `kuvo-npx` with `arguments` and only `path` to find commands in.
    private func run(_ launcher: URL, _ arguments: [String], path: String, cache: URL? = nil, more: [String: String] = [:]) throws -> String {
        let process = Process()
        process.executableURL = launcher
        process.arguments = arguments
        process.environment = ["PATH": path, "KUVO_KEY_OTHER_TOKEN": "secret", "FIGMA_API_KEY": "mine"]
            .merging(cache.map { ["XDG_CACHE_HOME": $0.path] } ?? [:]) { $1 }
            .merging(more) { $1 }
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// A command at `file` that prints how it was run.
    private func fake(_ file: URL, says word: String) throws {
        try "#!/bin/sh\necho \(word) \"BUN_BE_BUN=$BUN_BE_BUN\" \"$@\" \"$KUVO_KEY_OTHER_TOKEN$FIGMA_API_KEY\"\n".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    }

    @Test func runsTheEnginesBunWithoutNodeAndNpxWithIt() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "launcher-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let bin = folder.appending(path: "bin"), node = folder.appending(path: "node")
        try FileManager.default.createDirectory(at: node, withIntermediateDirectories: true)
        let engine = folder.appending(path: "engine with space")
        try fake(engine, says: "engine")
        try Launcher.install(in: bin, engine: engine)
        let launcher = bin.appending(path: Launcher.name)

        // Its own key stays; the other integrations' go.
        #expect(try run(launcher, ["some-mcp@1.0.0", "--stdio"], path: "/bin:/usr/bin") == "engine BUN_BE_BUN=1 x some-mcp@1.0.0 --stdio mine")
        // A package's `node` is the engine's Bun, found beside it, so Bun makes none in /tmp
        // (run here as kuvo-npx would, but with the keys it would have taken away).
        let bunNode = bin.appending(path: Launcher.runtime).appending(path: "node")
        #expect(try run(bunNode, ["server.js"], path: "/bin:/usr/bin") == "engine BUN_BE_BUN=1 server.js secretmine")
        try fake(node.appending(path: "npx"), says: "npx")
        #expect(try run(launcher, ["some-mcp@1.0.0"], path: node.path + ":/bin:/usr/bin") == "npx BUN_BE_BUN= -y some-mcp@1.0.0 mine")
    }

    /// Node on this Mac, for the tests that run a package with it.
    static let node: String? = ((ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"])
        .map { $0 + "/node" }.first(where: FileManager.default.isExecutableFile(atPath:))

    /// With Node, a package is installed once in the engine's cache and its command run by Node
    /// itself, with no npx left running beside it; a new version replaces the one before.
    @Test(.enabled(if: node != nil, "Needs Node on this Mac")) func installsOnceAndRunsWithNode() throws {
        let node = try #require(Self.node)
        let folder = FileManager.default.temporaryDirectory.appending(path: "launcher-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let bin = folder.appending(path: "bin"), tools = folder.appending(path: "tools"), cache = folder.appending(path: "cache")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: tools.appending(path: "node"), withDestinationURL: URL(filePath: node))
        try fake(tools.appending(path: "npx"), says: "npx")
        // npm "installs" the package: a command that says how it was run.
        let npm = tools.appending(path: "npm")
        try #"""
        #!/bin/sh
        echo "added 1 package"
        while [ $# -gt 1 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
        name=${1%@*}; mkdir -p "$prefix/node_modules/$name"
        echo installed >>"$(dirname "$0")/installs"
        printf '{"name":"%s","bin":{"other":"other.js","%s":"cli.js"}}' "$name" "${name##*/}" >"$prefix/node_modules/$name/package.json"
        echo 'console.log("node", process.argv.slice(2).join(" "), process.env.KUVO_KEY_OTHER_TOKEN || "", process.env.FIGMA_API_KEY)' >"$prefix/node_modules/$name/cli.js"
        """#.write(to: npm, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: npm.path)
        try Launcher.install(in: bin, engine: folder.appending(path: "engine"))
        let launcher = bin.appending(path: Launcher.name)
        let tried = tools.path + ":/bin:/usr/bin"

        // Installing (npm's words go to stderr, here with the rest), then from the install.
        #expect(try run(launcher, ["@kuvo/some-mcp@1.0.0", "--stdio"], path: tried, cache: cache) == "added 1 package\nnode --stdio  mine")
        #expect(try run(launcher, ["@kuvo/some-mcp@1.0.0", "--stdio"], path: tried, cache: cache) == "node --stdio  mine")
        let installs = { (try? String(contentsOf: tools.appending(path: "installs"), encoding: .utf8))?.split(separator: "\n").count ?? 0 }
        #expect(installs() == 1)
        let packages = cache.appending(path: "kuvo-npx")
        #expect(try run(launcher, ["@kuvo/some-mcp@1.1.0"], path: tried, cache: cache).hasSuffix("\nnode   mine"))
        #expect(try FileManager.default.contentsOfDirectory(atPath: packages.path) == ["@kuvo+some-mcp@1.1.0"])
        // Without the engine's cache, npx as before.
        #expect(try run(launcher, ["some-mcp@1.0.0"], path: tried) == "npx BUN_BE_BUN= -y some-mcp@1.0.0 mine")
    }

    /// A start that waits for another one's install and gives up waiting leaves that install
    /// alone (it may still be under way, on a slow network) and runs the server with npx.
    @Test(.enabled(if: node != nil, "Needs Node on this Mac")) func aStartThatGivesUpWaitingLeavesAnotherInstallAlone() throws {
        let node = try #require(Self.node)
        let folder = FileManager.default.temporaryDirectory.appending(path: "launcher-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let bin = folder.appending(path: "bin"), tools = folder.appending(path: "tools"), cache = folder.appending(path: "cache")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: tools.appending(path: "node"), withDestinationURL: URL(filePath: node))
        try fake(tools.appending(path: "npx"), says: "npx")
        try fake(tools.appending(path: "npm"), says: "npm")
        try Launcher.install(in: bin, engine: folder.appending(path: "engine"))
        // Another start's install, under way: its lock with its process (this test's own, which
        // runs), and what it has put there so far.
        let installing = cache.appending(path: "kuvo-npx/some-mcp@1.0.0")
        try FileManager.default.createDirectory(at: installing.appending(path: "node_modules"), withIntermediateDirectories: true)
        let lock = cache.appending(path: "kuvo-npx/some-mcp@1.0.0.lock")
        try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
        try "\(getpid())\n".write(to: lock.appending(path: "pid"), atomically: true, encoding: .utf8)

        let said = try run(bin.appending(path: Launcher.name), ["some-mcp@1.0.0"], path: tools.path + ":/bin:/usr/bin", cache: cache, more: ["KUVO_NPX_WAITS": "1"])
        #expect(said == "npx BUN_BE_BUN= -y some-mcp@1.0.0 mine")
        #expect(FileManager.default.fileExists(atPath: installing.appending(path: "node_modules").path), "its install is left as it is")
        #expect(FileManager.default.fileExists(atPath: installing.path + ".lock"), "and its lock")
    }

    /// An install whose start is gone (it crashed) is taken over: installed again, and run.
    @Test(.enabled(if: node != nil, "Needs Node on this Mac")) func anInstallWhoseStartIsGoneIsTakenOver() throws {
        let node = try #require(Self.node)
        let folder = FileManager.default.temporaryDirectory.appending(path: "launcher-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let bin = folder.appending(path: "bin"), tools = folder.appending(path: "tools"), cache = folder.appending(path: "cache")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: tools.appending(path: "node"), withDestinationURL: URL(filePath: node))
        try fake(tools.appending(path: "npx"), says: "npx")
        let npm = tools.appending(path: "npm")
        try #"""
        #!/bin/sh
        while [ $# -gt 1 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done
        name=${1%@*}; mkdir -p "$prefix/node_modules/$name"
        printf '{"name":"%s","bin":"cli.js"}' "$name" >"$prefix/node_modules/$name/package.json"
        echo 'console.log("node", process.argv.slice(2).join(" "))' >"$prefix/node_modules/$name/cli.js"
        """#.write(to: npm, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: npm.path)
        try Launcher.install(in: bin, engine: folder.appending(path: "engine"))
        let lock = cache.appending(path: "kuvo-npx/some-mcp@1.0.0.lock")
        let breaking = cache.appending(path: "kuvo-npx/some-mcp@1.0.0.lock.breaking")
        let old = Date(timeIntervalSinceNow: -10 * 60)
        let cases: [(String, () throws -> Void)] = [
            // Its start is gone: a process number nothing runs as.
            ("a start that's gone", { try "99999999\n".write(to: lock.appending(path: "pid"), atomically: true, encoding: .utf8) }),
            // An older kuvo-npx's, which names none, from minutes ago.
            ("an older kuvo-npx's", { try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: lock.path) }),
            // A start that's gone, and a taking over that crashed half way, minutes ago.
            ("a taking over that crashed", {
                try "99999999\n".write(to: lock.appending(path: "pid"), atomically: true, encoding: .utf8)
                try FileManager.default.createDirectory(at: breaking, withIntermediateDirectories: true)
                try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: breaking.path)
            }),
        ]
        for (name, leave) in cases {
            try? FileManager.default.removeItem(at: cache)
            try FileManager.default.createDirectory(at: lock, withIntermediateDirectories: true)
            try leave()
            let said = try run(bin.appending(path: Launcher.name), ["some-mcp@1.0.0", "--stdio"], path: tools.path + ":/bin:/usr/bin", cache: cache, more: ["KUVO_NPX_WAITS": "1"])
            #expect(said == "node --stdio", "\(name)")
            #expect(!FileManager.default.fileExists(atPath: lock.path), "\(name): its lock let go of once it's done")
            #expect(!FileManager.default.fileExists(atPath: breaking.path), "\(name)")
        }
    }
}
