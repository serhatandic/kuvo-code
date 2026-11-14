import Foundation
import Observation

/// Fork addition: which providers the panel follows. Only those whose account is connected in the
/// host app (Kuvo Code's Accounts), so it never shows a tool the user didn't connect there, like
/// Claude Code signed in on the Mac. And of those, only ones with something to show, learned from
/// their refreshes: a login was found, and the account has usage to read (not an API-key login or
/// one without a subscription). The dashboard, the menu bar and Total Spend leave the rest out;
/// Customize says why. A provider comes back on its own once it's connected and a refresh succeeds.
@MainActor
@Observable
final class ProviderAvailability {
    private static let storageKey = "kuvo.usage.unavailableProviders.v1"
    private static let connectedKey = "kuvo.usage.connectedProviders.v1"

    /// Why each unavailable provider is: `.notLoggedIn` or `.notAvailable`.
    private(set) var reasons: [String: ErrorCategory]
    /// The providers (`codex`, `copilot`, …) whose accounts are connected in the host, as it last
    /// said; nil until it has, which leaves every provider in.
    private(set) var connected: Set<String>?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.dictionary(forKey: Self.storageKey) as? [String: String] ?? [:]
        reasons = stored.compactMapValues(ErrorCategory.init(rawValue:))
        connected = defaults.stringArray(forKey: Self.connectedKey).map(Set.init)
    }

    /// Connected in the host: the provider's family (`claude` for every Claude account).
    func isConnected(_ providerID: String) -> Bool {
        connected?.contains(ProviderAccountID.family(of: providerID)) ?? true
    }

    /// Connected in the host, as it has said, before nil means "every provider": a refresh reads
    /// a provider's login on this Mac and may renew it, and one whose account isn't connected here
    /// belongs to another app (Claude Code's, the Codex CLI's), whose sign-in it could break.
    func isKnownConnected(_ providerID: String) -> Bool {
        connected?.contains(ProviderAccountID.family(of: providerID)) == true
    }

    func isAvailable(_ providerID: String) -> Bool {
        isConnected(providerID) && reasons[providerID] == nil
    }

    /// The host's connected providers changed. Returns the ones newly connected, to turn on.
    @discardableResult
    func setConnected(_ providers: Set<String>) -> Set<String> {
        let added = providers.subtracting(connected ?? [])
        guard providers != connected else { return [] }
        connected = providers
        defaults.set(Array(providers).sorted(), forKey: Self.connectedKey)
        return added
    }

    /// Why Customize's row for a turned-on provider isn't on the dashboard; nil when it is.
    func note(for providerID: String) -> String? {
        if !isConnected(providerID) { return "Not connected in \(HostApp.name)" }
        return switch reasons[providerID] {
        case .notLoggedIn: "Not signed in on this Mac"
        case .notAvailable: "No usage to show for this account"
        default: nil
        }
    }

    /// A refresh's outcome: a success makes the provider available; a failure because there's no
    /// login or no usage to read makes it unavailable. Other failures (the network, an expired
    /// login) leave it as it was: those are worth seeing.
    func record(_ providerID: String, succeeded: Bool, category: ErrorCategory?) {
        var next = reasons
        if succeeded {
            next[providerID] = nil
        } else if let category, category == .notLoggedIn || category == .notAvailable {
            next[providerID] = category
        }
        guard next != reasons else { return }
        reasons = next
        defaults.set(next.mapValues(\.rawValue), forKey: Self.storageKey)
    }
}
