import CryptoKit
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
    /// (its keeper and both of the keeper's own copies, how it launches, its keys), and leaves its
    /// sessions. Run on a home of its own, with a crontab and launchd standing in for the account's,
    /// which that home doesn't keep it from, so this Mac's aren't touched.
    @Test func removingAMachineLeavesNothingThatStartsItAgain() throws {
        let home = AppInfo.testRoot.appending(path: "MachineHome/\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
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
        let tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try Data("#!/bin/sh\nexit 1\n".utf8).write(to: tools.appending(path: "crontab"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.appending(path: "crontab").path)
        try Data("#!/bin/sh\necho \"$*\" >>\"$HOME/launchctl\"\n".utf8).write(to: tools.appending(path: "launchctl"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.appending(path: "launchctl").path)
        try Data("#!/bin/sh\necho \"$*\" >>\"$HOME/defaults\"\n".utf8).write(to: tools.appending(path: "defaults"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.appending(path: "defaults").path)
        try FileManager.default.createDirectory(at: root.appending(path: "browser"), withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", Machines.leftoversScript]
        process.environment = ["HOME": home.path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        for path in gone { #expect(!FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) stayed") }
        for path in kept { #expect(FileManager.default.fileExists(atPath: root.appending(path: path).path), "\(path) went") }
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "launchctl").path), "no login agent in this home, so launchd isn't asked")
        #expect(try String(contentsOf: home.appending(path: "defaults"), encoding: .utf8) == "delete com.google.chrome.for.testing LastRunAppBundlePath\n", "what macOS keeps of its browser")
    }

    /// Signing a Mac machine's agents out takes Claude Code's Anthropic Console sign-ins from that
    /// Mac's Keychain, each by its folder's name, and no others. `security` stands in, as a home of
    /// the test's own doesn't keep it from the account's real Keychain.
    @Test func signingAMacMachineOutTakesClaudesKeychainItems() throws {
        let home = AppInfo.testRoot.appending(path: "MachineHome/\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        let agents = home.appending(path: "machine/agents/claude")
        for folder in ["home", "accounts/work"] {
            try FileManager.default.createDirectory(at: agents.appending(path: folder), withIntermediateDirectories: true)
        }
        let tools = home.appending(path: "tools")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try Data("#!/bin/sh\necho \"$*\" >>\"$HOME/security\"\n".utf8).write(to: tools.appending(path: "security"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.appending(path: "security").path)

        let process = Process()
        process.executableURL = URL(filePath: "/bin/sh")
        process.arguments = ["-c", Machines.agentsSignOut]
        process.environment = ["HOME": home.path, "K": home.appending(path: "machine").path, "PATH": "\(tools.path):/usr/bin:/bin"]
        try process.run()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)

        func item(_ folder: URL) -> String {
            let hash = SHA256.hash(data: Data(folder.path.utf8)).prefix(4).map { String(format: "%02x", $0) }.joined()
            return "delete-generic-password -s Claude Code-credentials-\(hash)"
        }
        let asked = try String(contentsOf: home.appending(path: "security"), encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(Set(asked) == [item(agents.appending(path: "home")), item(agents.appending(path: "accounts/work"))])
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
