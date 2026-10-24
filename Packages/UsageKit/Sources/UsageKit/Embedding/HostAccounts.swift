import Foundation
import Synchronization

/// An account the host app already has: one connected in Kuvo Code's own Accounts screen, which its
/// opencode engine stores. (Fork addition.)
public struct HostCredential: Sendable, Hashable {
    /// The opencode integration ID: `github-copilot`, `openrouter`, `zai-coding-plan`, …
    public var integrationID: String
    /// The OAuth access token or API key.
    public var secret: String
    /// Whether it's a sign-in rather than an API key.
    public var signedIn: Bool
    /// The account a sign-in is for, where the provider names one: ChatGPT's account ID.
    public var accountID: String?

    /// The integration ID of a coding agent's Cursor API key, which the Cursor provider reads
    /// usage with when the Cursor app isn't signed in.
    public static let cursorAgent = "cursor-agent"

    public init(integrationID: String, secret: String, signedIn: Bool = false, accountID: String? = nil) {
        self.integrationID = integrationID
        self.secret = secret
        self.signedIn = signedIn
        self.accountID = accountID
    }
}

/// What the host app shares with the providers: its own accounts, which come before the logins other
/// tools leave on the Mac, and the folders where its private opencode engine keeps data, so the host's
/// own agent runs count toward spend. (Fork addition.)
public enum HostAccounts {
    private static let credentials = Mutex<[HostCredential]>([])
    private static let openCodeDirectories = Mutex<[String]>([])
    private static let reader = Mutex<(@Sendable () async -> Void)?>(nil)
    private static let said = Mutex(false)

    /// Replaces the host's accounts, then refreshes the providers that read them.
    @MainActor
    public static func update(_ newCredentials: [HostCredential]) {
        let changed = credentials.withLock { current in
            defer { current = newCredentials }
            return current != newCredentials
        }
        said.withLock { $0 = true }
        UsageMenuBar.shared.hostAccountsArrived()
        if changed { UsageMenuBar.shared.refresh(providerIDs: ["copilot", "openrouter", "zai", "opencode", "grok", "codex"]) }
    }

    /// Whether the host has handed over its accounts yet. Until it has, a provider can't tell its
    /// sign-in from none, and would read (and could renew) another app's login in its place.
    static var haveArrived: Bool { said.withLock { $0 } }

    /// How to read the host's accounts again. Its engine renews a sign-in's token when it uses it,
    /// without saying so, so a provider whose copy has lapsed asks for the current one first.
    public static func setReader(_ read: @escaping @Sendable () async -> Void) {
        reader.withLock { $0 = read }
    }

    /// Reads the host's accounts again, when it said how.
    static func reread() async {
        let read = reader.withLock { $0 }
        await read?()
    }

    /// The panel's providers (`codex`, `copilot`, …) whose accounts are connected in the host: the
    /// only ones it follows. A newly connected one is turned on.
    @MainActor
    public static func setConnectedProviders(_ providers: Set<String>) {
        UsageMenuBar.shared.connectedProvidersDidChange(providers)
    }

    /// Adds opencode data folders (each holding `opencode*.db`) to read alongside the user's own.
    public static func setOpenCodeDataDirectories(_ paths: [String]) {
        openCodeDirectories.withLock { $0 = paths }
    }

    /// The first account for any of `integrationIDs`, in that order.
    static func secret(for integrationIDs: [String]) -> String? {
        credentials.withLock { all in
            for id in integrationIDs {
                if let match = all.first(where: { $0.integrationID == id }),
                   let secret = match.secret.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
                    return secret
                }
            }
            return nil
        }
    }

    /// The host's sign-in (not an API key) for `integrationID`, if it has one.
    static func signIn(for integrationID: String) -> HostCredential? {
        credentials.withLock { signIn(for: integrationID, in: $0) }
    }

    static func signIn(for integrationID: String, in all: [HostCredential]) -> HostCredential? {
        all.first { $0.integrationID == integrationID && $0.signedIn
            && $0.secret.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty != nil }
    }

    static var openCodeDataDirectories: [String] {
        openCodeDirectories.withLock { $0 }
    }
}
