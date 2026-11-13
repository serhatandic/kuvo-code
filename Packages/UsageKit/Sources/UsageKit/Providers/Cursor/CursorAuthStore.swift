import Foundation

/// Kuvo Code's own Cursor sign-in (fork addition): the coding agent's API key, which the host
/// hands over (`HostAccounts`), exchanged for an access token as it's needed and never written
/// anywhere. The Cursor app's own login (its state database, its Keychain items) is an outside
/// login, and isn't read (#631 piece D1). COMPAT(0.8 cursor-box): only for a host whose box doesn't
/// state Cursor's usage yet (`HostLimits.covers("cursor")`); goes with the panel's own Cursor reads
/// (#631 piece H1), 3 months after 0.8.0.
struct CursorAuthState: Hashable, Sendable {
    enum Source: Hashable, Sendable {
        /// The host's: a coding agent's sign-in to Cursor (`HostAccounts`).
        case host
    }

    var accessToken: String?
    var refreshToken: String?
    /// The editor's billing membership, which only its own login had: none now.
    var membershipType: String?
    var source: Source
    /// The host's Cursor API key.
    var apiKey: String? = nil
}

enum CursorAuthError: Error, LocalizedError, Equatable {
    case notLoggedIn
    case sessionExpired
    case tokenExpired
    /// The host's coding agent's sign-in to Cursor no longer works.
    case agentSignInEnded

    var errorDescription: String? {
        switch self {
        case .notLoggedIn:
            return "Sign in to Cursor in Kuvo Code’s Accounts."
        case .sessionExpired, .tokenExpired, .agentSignInEnded:
            return "Sign in to Cursor again in Kuvo Code’s Accounts."
        }
    }
}

struct CursorAuthStore: Sendable {
    static let refreshBufferSeconds: TimeInterval = 5 * 60

    var now: @Sendable () -> Date
    /// The host's Cursor key, as it hands it over.
    var hostSecret: @Sendable () -> String?

    init(
        now: @escaping @Sendable () -> Date = Date.init,
        hostSecret: @escaping @Sendable () -> String? = { HostAccounts.secret(for: [HostCredential.cursorAgent]) }
    ) {
        self.now = now
        self.hostSecret = hostSecret
    }

    func loadAuthState() -> CursorAuthState? {
        guard let apiKey = hostSecret()?.trimmingCharacters(in: .whitespacesAndNewlines), !apiKey.isEmpty else { return nil }
        return CursorAuthState(accessToken: nil, refreshToken: nil, membershipType: nil, source: .host, apiKey: apiKey)
    }

    func needsRefresh(_ accessToken: String?) -> Bool {
        guard let accessToken,
              let expiresAt = Self.tokenExpiration(accessToken)
        else {
            return true
        }
        return expiresAt.timeIntervalSince(now()) <= Self.refreshBufferSeconds
    }

    private static func tokenExpiration(_ token: String) -> Date? {
        guard let exp = ProviderParse.jwtPayload(token)?["exp"].flatMap(ProviderParse.number) else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    static func tokenSubject(_ token: String?) -> String? {
        guard let token,
              let subject = ProviderParse.jwtPayload(token)?["sub"] as? String
        else {
            return nil
        }
        let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
