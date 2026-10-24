import Foundation
import OpenCodeKit
import Testing
@testable import KuvoCode

/// What a conversation is allowed with Settings › Permissions' rules beside its approval, as the
/// engine reads its rules: the last one that matches wins. In Ask First, what Settings allows in
/// particular (a command like "npm test *", bots' memory) goes without asking and the rest asks;
/// what Settings doesn't allow, nothing allows.
@Suite struct ApprovalRulesTests {
    /// The effect for `action` on `resource`, as the engine takes it: the last rule that matches.
    private func effect(_ rules: [PermissionRule], _ action: String, _ resource: String) -> PermissionRule.Effect? {
        rules.last { $0.action == action && Self.matches($0.resource, resource) }?.effect
    }

    /// The engine's wildcard: `*` stands for anything, `/` too.
    private static func matches(_ pattern: String, _ text: String) -> Bool {
        let regex = "^" + NSRegularExpression.escapedPattern(for: pattern).replacingOccurrences(of: "\\*", with: ".*") + "$"
        return text.range(of: regex, options: .regularExpression) != nil
    }

    @Test func askFirstLetsThroughWhatSettingsAllows() {
        let settings = [EngineConfig.botMemory,
                        PermissionRule(action: "shell", resource: "npm test *", effect: .allow),
                        PermissionRule(action: "edit", effect: .allow),
                        PermissionRule(action: "shell", resource: "rm *", effect: .deny)]
        let rules = ToolApproval.askFirst.rules(settings: settings)
        #expect(effect(rules, "edit", "/Users/me/Library/Application Support/run.kuvo.code/bots/bot_ada/MEMORY.md") == .allow)
        #expect(effect(rules, "edit", "/home/me/.kuvo-code/bots/bot_ada/MEMORY.md") == .allow)
        #expect(effect(rules, "shell", "npm test --watch") == .allow)
        // Settings' everything-allowed for an action is the mode's to decide: it asks.
        #expect(effect(rules, "edit", "src/memory.ts") == .ask)
        #expect(effect(rules, "shell", "make") == .ask)
        #expect(effect(rules, "shell", "rm -rf build") == .deny)
        #expect(ToolApproval(rules: rules) == .askFirst)
    }
}
