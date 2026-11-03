import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a new conversation is allowed with Settings › Permissions' rules beside its approval, in
/// the moment before its box makes its rules (`provisionalRules`), as the engine reads them: the
/// last one that matches wins. Asking first (Ask First, Accept Edits), what Settings allows in
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
        let rules = ToolApproval.askFirst.provisionalRules(settings: settings)
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
        #expect(ToolApproval.asksBeforeCommands(rules))
        // Accept Edits asks for the same until its box lets its edits go ahead.
        #expect(ToolApproval.acceptEdits.provisionalRules(settings: settings) == rules)
    }

    /// A rule a newer engine set in Settings, of a kind this app doesn't know ("deny-forever"), is
    /// never let through by the approval: in Auto (which lets through what Settings asks about)
    /// and Ask First alike, it goes to the session as it is, for the engine to apply.
    @Test func aRuleOfANewerEnginesKindIsNeverLetThrough() throws {
        let newer = try JSONDecoder().decode(PermissionRule.self, from: Data(#"{"action":"shell","resource":"rm *","effect":"deny-forever"}"#.utf8))
        let settings = [PermissionRule(action: "shell", effect: .ask), newer]
        for approval in ToolApproval.allCases {
            let rules = approval.provisionalRules(settings: settings)
            #expect(effect(rules, "shell", "rm -rf build", settings: settings) == .unknown("deny-forever"), "\(approval)")
            #expect(!rules.contains { $0.resource == "rm *" && $0.effect == .allow })
            let sent = String(decoding: try JSONEncoder().encode(rules), as: UTF8.self)
            #expect(sent.contains(#""effect":"deny-forever""#))
        }
    }

    @Test func askFirstAsksAboutFoldersWhenSettingsAllowsThemAll() {
        let settings = [PermissionRule(action: "external_directory", effect: .allow)]
        let rules = ToolApproval.askFirst.provisionalRules(settings: settings)
        #expect(effect(rules, "external_directory", "/Users/me/Downloads/x", settings: settings) == .ask)
        #expect(effect(ToolApproval.auto.provisionalRules(settings: settings), "external_directory", "/Users/me/Downloads/x", settings: settings) == .allow)
    }
}
