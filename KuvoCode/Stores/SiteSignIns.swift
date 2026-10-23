import WebKit

/// Whether this Mac's browser and each machine's are signed in to the sites the agent uses
/// (X, LinkedIn, Reddit: see `Integrations.signInCookies`), as their cookies last said. A
/// machine's browser is read while it's connected; what it said stays known after.
@MainActor
@Observable
final class SiteSignIns {
    static let shared = SiteSignIns()

    /// By place ("" for this Mac, else a machine's ID), then by service.
    private(set) var known: [String: [String: Bool]] = [:]

    /// `service` on `machine` (nil: this Mac): signed in, not, or nil when it can't be told yet.
    func isSignedIn(_ service: String, on machine: String?) -> Bool? {
        known[machine ?? ""]?[service]
    }

    /// Reads the cookies again: this Mac's, and each connected machine's browser that's live.
    func refresh(_ app: AppModel) async {
        await refreshMac()
        for engine in app.machines.engines.values where engine.isReady {
            if let cookies = await engine.browser.cookies() { record(engine.machine.id, cookies) }
        }
    }

    /// This Mac's alone.
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
}
