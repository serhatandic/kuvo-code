/// What went wrong with a turn, said the same way in both apps: a headline from the kind of error
/// the engine names (its `type`: "provider.rate-limit", "provider.auth"…), and the one way out that
/// kind needs beside Try Again. The engine's own words stay as the detail under the headline.
/// An error without a type (a coding agent's, run in the agents bridge) is told by its words.
public enum FailureWords {
    public enum Kind: Sendable, Equatable {
        case rateLimit, freeLimit, usageLimit
        /// The model's account isn't signed in; `ended`: its sign-in ran out and couldn't be renewed.
        case signIn(ended: Bool)
        /// A coding agent to sign in to (the bridge's "signin").
        case agentSignIn
        case network, providerTrouble, tooLong, declined, refused, unavailable, permission, tool, other
    }

    /// What the card offers besides Try Again.
    public enum Way: Sendable, Equatable {
        case switchModel, signIn, none
    }

    public static func kind(type: String?, message: String) -> Kind {
        switch type {
        case "provider.rate-limit": return .rateLimit
        case "provider.free-limit": return .freeLimit
        case "provider.quota", "provider.budget-limit", "provider.model-budget-limit": return .usageLimit
        // The engine says only "Request failed: 400" when a sign-in couldn't be renewed.
        case "provider.auth": return .signIn(ended: message.hasPrefix("Request failed"))
        case "signin": return .agentSignIn
        case "provider.transport", "provider.timeout": return .network
        case "provider.internal", "provider.invalid-output": return .providerTrouble
        case "provider.content-filter": return .declined
        case "provider.no-route", "provider.unsupported-operation": return .unavailable
        // Also every error a provider sends partway through a reply: by what it says.
        case "provider.unknown":
            let said = kind(of: message)
            return said == .other ? .unavailable : said
        case "permission.rejected": return .permission
        case "tool.execution": return .tool
        case "provider.invalid-request": return isTooLong(message) ? .tooLong : .refused
        default: return kind(of: message)
        }
    }

    /// One the engine has no type for, by what it says.
    private static func kind(of message: String) -> Kind {
        func says(_ pattern: String) -> Bool { message.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
        if isTooLong(message) { return .tooLong }
        // A quota spent often comes as a 429 too: it's the limit, not the rate.
        if says(#"usage limit|quota|insufficient (credit|balance|funds)|billing|payment required|\b402\b"#) { return .usageLimit }
        if says(#"\b429\b|rate.?limit|too many requests"#) { return .rateLimit }
        if says(#"overloaded|internal server error"#) { return .providerTrouble }
        if says(#"authorization header|unauthori[sz]ed|\b401\b|invalid api key|not (signed|logged) in"#) { return .signIn(ended: false) }
        if says(#"ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|failed to fetch|timed out|network|offline"#) { return .network }
        return .other
    }

    private static func isTooLong(_ message: String) -> Bool {
        message.range(of: #"context.?(length|window)|too many tokens|prompt is too long|maximum context|input is too long"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The engine's words under the headline, without the headline again when they start with
    /// it ("Free usage limit reached. Connect a provider…"); nil when nothing's left.
    public static func detail(_ message: String?, under headline: String) -> String? {
        guard var said = message?.trimmingCharacters(in: .whitespacesAndNewlines), !said.isEmpty else { return nil }
        if said.lowercased().hasPrefix(headline.lowercased()) {
            said = String(said.dropFirst(headline.count).drop { $0.isWhitespace || $0.isPunctuation })
        }
        return said.isEmpty ? nil : said
    }

    public static func headline(_ kind: Kind) -> String {
        switch kind {
        case .rateLimit: "The provider is rate limiting you"
        case .freeLimit: "Free usage limit reached"
        case .usageLimit: "Usage limit reached"
        case .signIn(ended: true): "This model’s sign-in has ended"
        case .signIn(ended: false): "This model’s account isn’t signed in"
        case .agentSignIn: "The coding agent isn’t signed in"
        case .network: "Couldn’t reach the provider"
        case .providerTrouble: "The provider had a problem"
        case .tooLong: "The conversation is too long for this model"
        case .declined: "The model declined this request"
        case .refused: "The provider turned the request down"
        case .unavailable: "This model can’t be used now"
        case .permission: "Stopped at a permission you turned down"
        case .tool: "A tool failed"
        case .other: "The run failed"
        }
    }

    public static func way(_ kind: Kind) -> Way {
        switch kind {
        case .rateLimit, .freeLimit, .usageLimit, .tooLong, .declined, .refused, .unavailable: .switchModel
        case .signIn, .agentSignIn: .signIn
        case .network, .providerTrouble, .permission, .tool, .other: .none
        }
    }
}
