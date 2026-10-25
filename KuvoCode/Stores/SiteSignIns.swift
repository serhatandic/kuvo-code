import WebKit

/// Whether this Mac's browser and each machine's are signed in to the sites the agent uses
/// (X, LinkedIn, Reddit: see `Integrations.signInCookies`), as their cookies last said. This Mac's
/// is what its box tells every client (`HostInterface`, `sites/signed-in`), read again only once its
/// cookies change; a machine's browser is read while it's connected, and what it said stays known
/// after (a machine's box can't tell yet).
@MainActor
@Observable
final class SiteSignIns {
    static let shared = SiteSignIns()

    /// By place ("" for this Mac, else a machine's ID), then by service.
    private(set) var known: [String: [String: Bool]] = [:]
    /// Goes up each time this Mac's browser's cookies change, once they're watched.
    private(set) var macChanges = 0

    @ObservationIgnored private var watch: CookieWatch?
    /// When this Mac's were read, and at which change.
    @ObservationIgnored private var macRead: (at: ContinuousClock.Instant, change: Int)?

    /// `service` on `machine` (nil: this Mac): signed in, not, or nil when it can't be told yet.
    func isSignedIn(_ service: String, on machine: String?) -> Bool? {
        known[machine ?? ""]?[service]
    }

    /// This Mac's, as its cookies say: read again only once they've changed (or after 30 seconds),
    /// so a box asking with every list doesn't read every cookie each time.
    func mac() async -> [String: Bool] {
        watchMac()
        if let macRead, macRead.change == macChanges, ContinuousClock.now - macRead.at < .seconds(30), let states = known[""] { return states }
        let change = macChanges
        await refreshMac()
        macRead = (.now, change)
        return known[""] ?? [:]
    }

    /// A machine's browser, while it's connected and live.
    func refresh(_ machine: String, app: AppModel) async {
        guard let engine = app.machines.engine(machine), engine.isReady, let cookies = await engine.browser.cookies() else { return }
        record(machine, cookies)
    }

    /// This Mac's alone, read now.
    func refreshMac() async {
        let mac = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        record("", mac.map { (domain: $0.domain, name: $0.name, expires: $0.expiresDate) })
    }

    private func record(_ place: String, _ cookies: [(domain: String, name: String, expires: Date?)]) {
        var states: [String: Bool] = [:]
        for service in Integrations.signInCookies.keys {
            states[service] = Integrations.isSignedIn(service, cookies: cookies)
        }
        if known[place] != states { known[place] = states }
    }

    /// Follows this Mac's browser's cookies, once.
    private func watchMac() {
        guard watch == nil else { return }
        let watch = CookieWatch { [weak self] in self?.macChanges += 1 }
        self.watch = watch
        WKWebsiteDataStore.default().httpCookieStore.add(watch)
    }
}

/// Says when the panel browser's cookies change (a sign-in, a sign-out).
private final class CookieWatch: NSObject, WKHTTPCookieStoreObserver {
    let changed: @MainActor () -> Void

    init(changed: @escaping @MainActor () -> Void) {
        self.changed = changed
    }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in changed() }
    }
}
