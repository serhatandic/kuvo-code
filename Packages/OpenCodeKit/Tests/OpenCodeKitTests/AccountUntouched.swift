import Foundation
import Testing
@testable import OpenCodeKit

/// What belongs to the account whatever `$HOME` says: its crontab, the machine's login agent in
/// launchd, and its keychains' search list and default (a test's keychain is never left in either). A script run in a home of a test's own still reaches them, unless stand-ins come first
/// on its PATH.
struct AccountState: Equatable {
    var crontab: String
    var agentLoaded: Bool
    var agentFile: Bool
    var keychains: String

    static func now(crontab: String = "/usr/bin/crontab", launchctl: String = "/bin/launchctl", security: String = "/usr/bin/security", home: String = NSHomeDirectory()) -> AccountState {
        func run(_ program: String, _ arguments: [String]) -> (output: String, status: Int32) {
            guard FileManager.default.isExecutableFile(atPath: program) else { return ("", -1) }
            let process = Process()
            process.executableURL = URL(filePath: program)
            process.arguments = arguments
            let output = Pipe()
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            guard (try? process.run()) != nil else { return ("", -1) }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return (String(decoding: data, as: UTF8.self), process.terminationStatus)
        }
        return AccountState(
            crontab: run(crontab, ["-l"]).output,
            agentLoaded: run(launchctl, ["print", "gui/\(getuid())/\(RemoteServer.launchAgent)"]).status == 0,
            agentFile: FileManager.default.fileExists(atPath: home + "/Library/LaunchAgents/\(RemoteServer.launchAgent).plist"),
            // (Which keychains are searched, and which is the default: their names, nothing in them.)
            keychains: run(security, ["list-keychains", "-d", "user"]).output + run(security, ["default-keychain", "-d", "user"]).output
        )
    }
}

/// Fails a suite whose run changed the account's real crontab or login agent.
struct AccountUntouched: SuiteTrait, TestScoping {
    func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
        let before = AccountState.now()
        try await function()
        let after = AccountState.now()
        if after != before { Issue.record("This run changed the account's real crontab, login agent or keychain list: \(before) became \(after)") }
    }
}

@Suite struct AccountStateTests {
    /// The check notices each thing it's there for, in stand-ins of its own.
    @Test func itSeesAChangedCrontabAndALoginAgent() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "account-state-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let tab = folder.appending(path: "tab"), loaded = folder.appending(path: "loaded")
        func tool(_ name: String, _ body: String) throws -> String {
            let file = folder.appending(path: name)
            try Data("#!/bin/sh\n\(body)\n".utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            return file.path
        }
        let crontab = try tool("crontab", "cat \(SSHConnection.quoted(tab.path)) 2>/dev/null")
        let launchctl = try tool("launchctl", "[ -f \(SSHConnection.quoted(loaded.path)) ]")
        func state() -> AccountState { .now(crontab: crontab, launchctl: launchctl, home: folder.path) }

        let before = state()
        #expect(state() == before, "nothing changed, nothing to see")
        try Data("@reboot something\n".utf8).write(to: tab)
        #expect(state().crontab == "@reboot something\n")
        #expect(state() != before)
        try FileManager.default.removeItem(at: tab)
        try Data().write(to: loaded)
        #expect(state().agentLoaded && state() != before)
        try FileManager.default.removeItem(at: loaded)
        let agents = folder.appending(path: "Library/LaunchAgents")
        try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
        try Data().write(to: agents.appending(path: "\(RemoteServer.launchAgent).plist"))
        #expect(state().agentFile && state() != before)
    }
}
