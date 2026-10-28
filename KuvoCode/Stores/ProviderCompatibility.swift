import Foundation
import OpenCodeKit

/// Settings some providers need from the engine until opencode handles them itself. They go to
/// every engine, this Mac's and the machines', on top of the user's own settings.
///
/// GitHub Copilot's Claude models reject the `thinking.block_binding` the engine adds to requests
/// for Claude 5.1 and later ("thinking.adaptive.block_binding: Extra inputs are not permitted").
/// opencode (2.2.0 still) leaves it out only for models named in its settings, one by one
/// (anomalyco/opencode#55160). A model named there that the provider doesn't have shows up in its
/// list as a model of its own, so the names come from Copilot's list as the engine last gave it.
enum ProviderCompatibility {
    private static let key = "copilotClaudeModels"
    /// Copilot's Claude models from 5.1 on as of October 2026, until an engine has listed them.
    private static let known = ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-5.5", "claude-fable-5.1"]

    static var config: [String: Any] {
        let models = UserDefaults.standard.stringArray(forKey: key) ?? known
        guard !models.isEmpty else { return [:] }
        let settings = Dictionary(uniqueKeysWithValues: models.map { ($0, ["compatibility": ["supportsThinkingBlockBinding": false]]) })
        return ["providers": ["github-copilot": ["models": settings]]]
    }

    /// Notes Copilot's Claude models from an engine's list. One that only these settings put there
    /// has no family, so it's left out, and the next engine started leaves it out of its settings.
    static func learn(from models: [Model]) {
        let copilot = models.filter { $0.providerID == "github-copilot" }
        // No Copilot account there: nothing to learn.
        guard !copilot.isEmpty else { return }
        let claude = copilot.filter { $0.id.hasPrefix("claude-") && $0.family != nil }.map(\.id).sorted()
        UserDefaults.standard.set(claude, forKey: key)
    }
}
