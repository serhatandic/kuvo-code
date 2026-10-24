import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a conversation is allowed with Settings › Permissions' rules beside its approval, as the
/// engine reads its rules: the last one that matches wins. In Ask First, what Settings allows in
/// particular (a command like "npm test *", bots' memory) goes without asking and the rest asks;
/// what Settings doesn't allow, nothing allows.
@Suite struct ApprovalRulesTests {
    /// The effect for `action` on `resource`, as the engine takes it: Settings' rules, then the
    /// session's, and the last one that matches wins.
    private func effect(_ rules: [PermissionRule], _ action: String, _ resource: String, settings: [PermissionRule]) -> PermissionRule.Effect? {
        (settings + rules).last { $0.action == action && Self.matches($0.resource, resource) }?.effect
    }

    /// The engine's wildcard: `*` stands for anything, `/` too.
    private static func matches(_ pattern: String, _ text: String) -> Bool {
        let regex = "^" + NSRegularExpression.escapedPattern(for: pattern).replacingOccurrences(of: "\\*", with: ".*") + "$"
        return text.range(of: regex, options: .regularExpression) != nil
    }

    @Test func askFirstLetsThroughWhatSettingsAllows() {
        let settings = [EngineConfig.botMemory,
                        PermissionRule(action: "shell", resource: "npm test *", effect: .allow),
                        PermissionRule(action: "shell", resource: "git *", effect: .allow),
                        PermissionRule(action: "shell", resource: "git push *", effect: .ask),
                        PermissionRule(action: "edit", effect: .allow),
                        PermissionRule(action: "external_directory", resource: "/Users/me/data/*", effect: .allow),
                        PermissionRule(action: "shell", resource: "rm *", effect: .deny)]
        let rules = ToolApproval.askFirst.rules(settings: settings)
        let effect = { self.effect(rules, $0, $1, settings: settings) }
        #expect(effect("edit", "/Users/me/Library/Application Support/run.kuvo.code/bots/bot_ada/MEMORY.md") == .allow)
        #expect(effect("edit", "/home/me/.kuvo-code/bots/bot_ada/MEMORY.md") == .allow)
        #expect(effect("shell", "npm test --watch") == .allow)
        // Settings' everything-allowed for an action is the mode's to decide: it asks.
        #expect(effect("edit", "src/memory.ts") == .ask)
        #expect(effect("shell", "make") == .ask)
        #expect(effect("shell", "rm -rf build") == .deny)
        // An Ask under a broader Allow still asks.
        #expect(effect("shell", "git status") == .allow)
        #expect(effect("shell", "git push origin main") == .ask)
        // A folder Settings allows needs no asking; others ask, as Settings does by default.
        #expect(effect("external_directory", "/Users/me/data/notes.md") == .allow)
        #expect(effect("external_directory", "/Users/me/Downloads/x") != .allow)
        // Made again, a session's rules don't pile up.
        #expect(ToolApproval.refreshed(rules, settings: settings) == ToolApproval.refreshed(ToolApproval.refreshed(rules, settings: settings), settings: settings))
        #expect(ToolApproval(rules: rules) == .askFirst)
    }

    @Test func askFirstAsksAboutFoldersWhenSettingsAllowsThemAll() {
        let settings = [PermissionRule(action: "external_directory", effect: .allow)]
        let rules = ToolApproval.askFirst.rules(settings: settings)
        #expect(effect(rules, "external_directory", "/Users/me/Downloads/x", settings: settings) == .ask)
        #expect(effect(ToolApproval.approveAll.rules(settings: settings), "external_directory", "/Users/me/Downloads/x", settings: settings) == .allow)
    }

    @Test func aFolderTakenOutOfSettingsGoesFromSessions() {
        let folder = PermissionRule(action: "external_directory", resource: "/Users/me/data/*", effect: .allow)
        let project = PermissionRule(action: "external_directory", resource: "/Users/me/site/*", effect: .allow)
        let session = ToolApproval.askFirst.rules(settings: [folder]) + [project]
        let now = ToolApproval.refreshed(session, settings: [])
        #expect(effect(now, "external_directory", "/Users/me/data/notes.md", settings: []) != .allow)
        // The session's own folder stays.
        #expect(effect(now, "external_directory", "/Users/me/site/index.html", settings: []) == .allow)
    }
}
