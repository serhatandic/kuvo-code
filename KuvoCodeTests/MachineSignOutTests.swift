import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// Removing a machine signs its coding agents out: their sign-ins' files go (Claude Code's,
/// Codex's, Grok's, Cursor's, Antigravity's), their conversations and runtime stay. Run here on a
/// folder laid out as a machine's `~/.kuvo-code`, with this Mac's shell, as the machine runs it.
/// And the sign-in card saves a changed password, and asks your Touch ID only for one it filled in.
@MainActor
@Suite struct MachineSignOutTests {
    @Test func theAgentsSignInsGoTheirConversationsStay() throws {
        let root = AppInfo.testRoot.appending(path: "MachineHome/\(UUID().uuidString)")
        let gone = ["agents/claude/.credentials.json", "agents/codex/auth.json", "agents/codex/auth.json.bak",
                    "agents/grok/oauth-token.json", "agents/cursor/acp_token.json", "agents/antigravity/acp_token.json.1"]
        let kept = ["agents/claude/projects/p/session.jsonl", "agents/codex/sessions/rollout.jsonl", "agents/runtime/auth.json", "data/opencode/opencode.db"]
        for path in gone + kept {
            let file = root.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: file)
        }
        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", "K='\(root.path)'\n" + Machines.agentsSignOut]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        for path in gone { #expect(!FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) stayed") }
        for path in kept { #expect(FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) went") }
    }

    /// Removing a machine takes away everything that would start its engine again or sign in there
    /// (its keeper and both of the keeper's own copies, how it launches, its keys), and the short
    /// folder in /tmp its box kept commands' temporary folders in, and leaves its sessions. Run on a
    /// home of its own, with a crontab that answers nothing, so this Mac's isn't touched.
    @Test func removingAMachineLeavesNothingThatStartsItAgain() throws {
        let home = AppInfo.testRoot.appending(path: "MachineHome/\(UUID().uuidString)")
        let short = "/tmp/kuvo-code-\(getuid())-\(UUID().uuidString.lowercased().filter(\.isHexDigit).prefix(6))"
        defer {
            try? FileManager.default.removeItem(at: home)
            try? FileManager.default.removeItem(atPath: short)
        }
        let root = home.appending(path: RemoteEngineInstaller.root)
        let gone = ["bin/kuvo-start", "bin/.kuvo-start-keeper", "bin/kuvo-launch", "bin/.kuvo-launch-keeper", "bin/.kuvo-boot",
                    "run/launch.env", "run/launch.notes", "keys/settings.json", "box/keys/KUVO_KEY_LINEAR_TOKEN",
                    "box/bot-keys/KUVO_KEY_LINEAR_TOKEN__BOT"]
        let kept = ["data/opencode/opencode.db", "box/projects.json"]
        for path in gone + kept {
            let file = root.appending(path: path)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: file)
        }
        try FileManager.default.createDirectory(at: root.appending(path: "run/fence"), withIntermediateDirectories: true)
        try Data("\(short)\n\(String(repeating: "0", count: 64))\n".utf8).write(to: root.appending(path: "run/fence/temporary"))
        try FileManager.default.createDirectory(atPath: "\(short)/12345678", withIntermediateDirectories: true)
        let tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 1\n".utf8).write(to: tools.appending(path: "crontab"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.appending(path: "crontab").path)

        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", Machines.leftoversScript]
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        for path in gone { #expect(!FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) stayed") }
        for path in kept { #expect(FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) went") }
        #expect(!FileManager.default.fileExists(atPath: short), "the box's short folder stayed")
    }

    /// The removal scripts, connected or not, both sign the agents out.
    @Test func bothWaysOfRemovingSignThemOut() {
        #expect(Machines.removalScript.contains(Machines.agentsSignOut))
    }

    /// A saved account's password typed anew is saved (agents allowed to sign in on their own use
    /// it then); a new one only when you ask; one filled in from Passwords isn't "typed".
    @Test(arguments: [
        // password, saving, savedPassword → saves, typedNow
        ("new-secret", false, "old-secret", true, true),
        ("old-secret", true, "old-secret", false, false),
        ("first", true, nil, true, true),
        ("first", false, nil, false, true),
        ("", true, nil, false, false),
    ] as [(String, Bool, String?, Bool, Bool)])
    func whatASignInsPasswordDoes(password: String, saving: Bool, savedPassword: String?, saves: Bool, typedNow: Bool) {
        let handling = BrowserAsks.handling(password: password, saving: saving, secure: true, savedPassword: savedPassword)
        #expect(handling.saves == saves)
        #expect(handling.typedNow == typedNow)
        #expect(!BrowserAsks.handling(password: password, saving: saving, secure: false, savedPassword: savedPassword).saves)
    }
}
