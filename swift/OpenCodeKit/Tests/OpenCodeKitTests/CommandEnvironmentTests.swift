import Foundation
import Testing
@testable import OpenCodeKit

struct CommandEnvironmentTests {
    @Test func keepsEachOwnValueOrNone() {
        let variables = CommandEnvironment.variables(from: ["XDG_CONFIG_HOME": "/Users/me/.config", "PATH": "/usr/bin"])
        #expect(variables["KUVO_OWN_XDG_CONFIG_HOME"] == "/Users/me/.config")
        #expect(variables["KUVO_OWN_XDG_DATA_HOME"] == "")
        #expect(variables["KUVO_OWN_npm_config_cache"] == "")
        #expect(variables["KUVO_OWN_PATH"] == nil)
        #expect(variables.count == CommandEnvironment.names.count)
    }

    @Test func writesThePluginOnce() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "opencodekit-commands-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        try CommandEnvironment.install(in: folder)
        let file = folder.appending(path: "plugins/kuvo-code.js")
        #expect(try String(contentsOf: file, encoding: .utf8) == CommandEnvironment.plugin)
        let written = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        try CommandEnvironment.install(in: folder)
        #expect(try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date == written)
    }

    /// On a machine: the values from before `$K`'s folders, kept once, and the plugin written.
    @Test func machineScriptKeepsTheOwnValuesAndWritesThePlugin() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "opencodekit-commands-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let script = """
            K="\(root.path)"
            export XDG_CONFIG_HOME=/home/me/.config; unset XDG_DATA_HOME
            \(CommandEnvironment.keepScript)
            export XDG_CONFIG_HOME="$K/config" XDG_DATA_HOME="$K/data"
            \(CommandEnvironment.keepScript)
            \(CommandEnvironment.installScript)
            printf '%s|%s|%s' "$KUVO_OWN_XDG_CONFIG_HOME" "${KUVO_OWN_XDG_DATA_HOME-unset}" "$XDG_CONFIG_HOME"
            """
        let shell = Process()
        shell.executableURL = URL(filePath: "/bin/sh")
        shell.arguments = ["-c", script]
        let output = Pipe()
        shell.standardOutput = output
        try shell.run()
        shell.waitUntilExit()
        let printed = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(printed == "/home/me/.config||\(root.path)/config")
        let plugin = try String(contentsOf: root.appending(path: "config/opencode/plugins/kuvo-code.js"), encoding: .utf8)
        #expect(plugin == CommandEnvironment.plugin)
    }
}
